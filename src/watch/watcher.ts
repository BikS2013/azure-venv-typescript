import * as path from 'node:path';

import type { AzureVenvConfig, AzureVenvOptions } from '../config/types.js';
import { AzureVenvBlobClient } from '../azure/client.js';
import type {
  SyncResult,
  WatchChangeEvent,
  WatchOptions,
  WatchResult,
  WatchChangeType,
  EnvRecord,
} from '../types/index.js';
import { NO_OP_SYNC_RESULT } from '../types/index.js';
import type { Logger } from '../logging/logger.js';
import type { BlobInfo } from '../azure/types.js';
import { SyncEngine } from '../sync/engine.js';
import { ManifestManager } from '../sync/manifest.js';
import { BlobDownloader } from '../sync/downloader.js';
import { validateAndResolvePath, stripPrefix } from '../sync/path-validator.js';
import { parseEnvBuffer } from '../env/loader.js';
import { applyPrecedence } from '../env/precedence.js';
import { validateConfig } from '../config/validator.js';
import { createLogger } from '../logging/logger.js';
import { parseEnvFile } from '../env/loader.js';
import {
  AzureVenvError,
  ConfigurationError,
  AuthenticationError,
  AzureConnectionError,
} from '../errors/index.js';

/**
 * Watches Azure Blob Storage for changes and re-syncs files on a polling interval.
 *
 * The watcher compares blob ETags against the local manifest to detect
 * added or modified blobs, then downloads only the changed ones.
 * If a remote .env file changes, it is re-downloaded, re-parsed,
 * and the three-tier precedence model is re-applied.
 */
export class BlobWatcher {
  private readonly config: AzureVenvConfig;
  private readonly client: AzureVenvBlobClient;
  private readonly logger: Logger;
  private readonly osEnvSnapshot: ReadonlySet<string>;
  private readonly localEnv: Readonly<EnvRecord>;
  private intervalId: NodeJS.Timeout | null = null;
  private abortController: AbortController;

  /**
   * @param config - Validated Azure VENV configuration.
   * @param client - Azure Blob client for listing and downloading.
   * @param logger - Logger instance.
   * @param osEnvSnapshot - Snapshot of OS environment variable keys taken before .env loading.
   * @param localEnv - Parsed key-value pairs from the local .env file.
   */
  constructor(
    config: AzureVenvConfig,
    client: AzureVenvBlobClient,
    logger: Logger,
    osEnvSnapshot: ReadonlySet<string>,
    localEnv: Readonly<EnvRecord>,
  ) {
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.osEnvSnapshot = osEnvSnapshot;
    this.localEnv = localEnv;
    this.abortController = new AbortController();
  }

  /**
   * Start the polling watcher. Runs the first poll immediately, then at each pollInterval.
   *
   * @param options - Optional watch configuration overrides.
   * @returns WatchResult containing the stop function (initial sync is handled externally).
   */
  start(options?: WatchOptions): { stop: () => void } {
    const pollInterval = options?.pollInterval ?? this.config.pollInterval;

    // Hook external abort signal if provided
    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        this.stop();
      });
    }

    // Register process signal handlers for graceful shutdown
    const signalHandler = (): void => {
      this.stop();
    };

    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);

    this.logger.info(
      `Watch mode started, polling every ${pollInterval}ms`,
    );

    // Start polling on interval (first poll after one interval, not immediately)
    this.intervalId = setInterval(() => {
      // Do not await here -- poll runs in background and logs its own errors
      void this.poll();
    }, pollInterval);

    // Ensure the interval does not prevent Node from exiting
    if (this.intervalId.unref) {
      this.intervalId.unref();
    }

    return {
      stop: (): void => {
        process.removeListener('SIGINT', signalHandler);
        process.removeListener('SIGTERM', signalHandler);
        this.stop();
      },
    };
  }

  /**
   * Stop the watcher, clear the polling interval, and abort any in-progress operations.
   */
  private stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.abortController.abort();
    this.logger.info('Watch mode stopped');
  }

  /**
   * Execute a single poll cycle:
   * 1. List all blobs with prefix
   * 2. Load current manifest
   * 3. Compare ETags to find added/modified blobs
   * 4. Download changed blobs
   * 5. If remote .env changed, re-download and re-apply precedence
   * 6. Update manifest
   * 7. Log summary of changes
   */
  private async poll(): Promise<void> {
    if (this.abortController.signal.aborted) {
      return;
    }

    this.logger.debug('Watch poll cycle starting');

    try {
      const prefix = this.config.blobUrl.prefix;
      const rootDir = this.config.rootDir;

      // Create sync infrastructure for this poll cycle
      const manifestPath = path.resolve(rootDir, '.azure-venv-manifest.json');
      const manifestManager = new ManifestManager(manifestPath, this.logger);
      const downloader = new BlobDownloader(
        this.client,
        { validateAndResolvePath },
        this.logger,
        this.config.concurrency,
        this.config.maxBlobSize,
      );

      // Step 1: List all blobs
      const allBlobs = await this.client.listBlobs(prefix);

      if (this.abortController.signal.aborted) {
        return;
      }

      // Step 2: Load current manifest
      const manifest = await manifestManager.load();

      // Step 3: Compare ETags - find added/modified blobs
      const envBlobName = prefix ? `${prefix}.env` : '.env';
      const changes: WatchChangeEvent[] = [];
      const changedFileBlobs: BlobInfo[] = [];
      let envChanged = false;

      for (const blob of allBlobs) {
        const existingEntry = manifest.entries[blob.name];
        let changeType: WatchChangeType | null = null;

        if (!existingEntry) {
          changeType = 'added';
        } else if (existingEntry.etag !== blob.etag) {
          changeType = 'modified';
        }

        if (changeType !== null) {
          if (blob.name === envBlobName) {
            envChanged = true;
          } else {
            changedFileBlobs.push(blob);
          }

          let localPath: string;
          try {
            const relativePath = stripPrefix(blob.name, prefix);
            localPath = path.resolve(rootDir, relativePath);
          } catch {
            localPath = blob.name;
          }

          changes.push({
            type: changeType,
            blobName: blob.name,
            localPath,
            timestamp: new Date(),
          });
        }
      }

      if (changes.length === 0) {
        this.logger.debug('Watch poll: no changes detected');
        return;
      }

      this.logger.info(`Watch poll: detected ${changes.length} change(s)`);

      if (this.abortController.signal.aborted) {
        return;
      }

      // Step 4: Download changed file blobs
      if (changedFileBlobs.length > 0) {
        const results = await downloader.downloadBatch(
          changedFileBlobs,
          rootDir,
          prefix,
        );

        this.logger.info(
          `Watch poll: downloaded ${results.length}/${changedFileBlobs.length} changed blob(s)`,
        );

        // Update manifest entries for successfully downloaded blobs
        const updatedEntries = { ...manifest.entries };

        for (const result of results) {
          const matchingBlob = changedFileBlobs.find((b) => b.name === result.blobName);
          if (matchingBlob) {
            let relativePath: string;
            try {
              relativePath = stripPrefix(matchingBlob.name, prefix);
            } catch {
              relativePath = result.localPath;
            }

            const entry = manifestManager.createEntry(matchingBlob, relativePath);
            updatedEntries[matchingBlob.name] = entry;
          }
        }

        // Save updated manifest
        await manifestManager.save({
          ...manifest,
          entries: updatedEntries,
        });
      }

      // Step 5: If remote .env changed, re-download and re-apply precedence
      if (envChanged) {
        this.logger.info('Watch poll: remote .env changed, re-applying environment variables');

        try {
          const envBuffer = await this.client.downloadToBuffer(envBlobName);
          const remoteEnv = parseEnvBuffer(envBuffer);

          this.logger.info(
            `Watch poll: parsed ${Object.keys(remoteEnv).length} variable(s) from remote .env`,
          );

          applyPrecedence(this.osEnvSnapshot, this.localEnv, remoteEnv, this.logger);

          // Update manifest entry for .env blob
          const envBlob = allBlobs.find((b) => b.name === envBlobName);
          if (envBlob) {
            const currentManifest = await manifestManager.load();
            const updatedEntries = { ...currentManifest.entries };
            updatedEntries[envBlobName] = manifestManager.createEntry(envBlob, '.env');
            await manifestManager.save({
              ...currentManifest,
              entries: updatedEntries,
            });
          }
        } catch (error: unknown) {
          this.logger.error(
            `Watch poll: failed to re-apply remote .env: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Step 7: Log summary
      const addedCount = changes.filter((c) => c.type === 'added').length;
      const modifiedCount = changes.filter((c) => c.type === 'modified').length;
      this.logger.info(
        `Watch poll complete: ${addedCount} added, ${modifiedCount} modified`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Watch poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Initialize azure-venv with watch mode support.
 *
 * This function performs the same initialization flow as initAzureVenv
 * (load local .env, validate config, create client, initial sync),
 * and then optionally starts a BlobWatcher for continuous polling.
 *
 * @param options - Optional configuration and watch overrides.
 * @returns Promise resolving to WatchResult with initial sync stats and a stop function.
 *
 * @throws ConfigurationError if required config is partially present or invalid.
 * @throws AuthenticationError if SAS token is expired or authentication fails (when failOnError: true).
 * @throws AzureConnectionError if Azure is unreachable (when failOnError: true).
 * @throws SyncError if filesystem operations fail critically.
 */
export async function watchAzureVenv(
  options?: AzureVenvOptions & WatchOptions,
): Promise<WatchResult> {
  const startTime = Date.now();

  // STEP 0: Capture OS environment snapshot BEFORE any .env loading
  const osEnvSnapshot = new Set(Object.keys(process.env));

  // Create a bootstrap logger (before config is validated, no SAS to sanitize yet)
  const bootstrapLogger = createLogger(options?.logLevel ?? 'info', '');

  // STEP 1: Load local .env file
  const rootDir = options?.rootDir ?? process.cwd();
  const envPath = options?.envPath ?? '.env';
  const localEnvFilePath = path.resolve(rootDir, envPath);

  bootstrapLogger.info('Initializing azure-venv (watch mode)');

  const localEnv = await parseEnvFile(localEnvFilePath, bootstrapLogger);

  // Apply local .env to process.env without overriding OS vars
  for (const key of Object.keys(localEnv)) {
    if (!osEnvSnapshot.has(key)) {
      process.env[key] = localEnv[key];
    }
  }

  // STEP 2 & 3: Validate configuration
  const config = validateConfig(
    process.env as Record<string, string | undefined>,
    options,
  );

  if (config === null) {
    bootstrapLogger.info('AZURE_VENV not configured, skipping Azure sync and watch');
    return {
      initialSync: NO_OP_SYNC_RESULT,
      stop: () => {
        /* no-op */
      },
    };
  }

  // Now we have a validated config with SAS token - create the real logger
  const logger = createLogger(config.logLevel, config.sasToken);

  logger.info('Azure VENV configured, starting initial sync');
  logger.debug(`Blob URL: ${config.blobUrl.accountUrl}/${config.blobUrl.containerName}`);
  logger.debug(`Prefix: "${config.blobUrl.prefix}"`);
  logger.debug(`Sync mode: ${config.syncMode}, Concurrency: ${config.concurrency}`);

  try {
    // STEP 5: Create Azure Blob client
    const blobClient = new AzureVenvBlobClient(
      {
        accountUrl: config.blobUrl.accountUrl,
        containerName: config.blobUrl.containerName,
        sasToken: config.sasToken,
        maxRetries: 3,
        timeout: config.timeout,
      },
      logger,
    );

    // Create sync infrastructure
    const manifestPath = path.resolve(config.rootDir, '.azure-venv-manifest.json');
    const manifestManager = new ManifestManager(manifestPath, logger);
    const downloader = new BlobDownloader(
      blobClient,
      { validateAndResolvePath },
      logger,
      config.concurrency,
      config.maxBlobSize,
    );
    const syncEngine = new SyncEngine(blobClient, manifestManager, downloader, logger);

    // STEP 6 & 7: Fetch and load remote .env (if exists)
    let remoteEnvLoaded = false;
    let remoteEnv: EnvRecord = {};

    const remoteEnvBuffer = await syncEngine.fetchRemoteEnv(
      config.blobUrl.prefix,
      config.rootDir,
    );

    if (remoteEnvBuffer !== null) {
      remoteEnv = parseEnvBuffer(remoteEnvBuffer);
      logger.info(`Parsed ${Object.keys(remoteEnv).length} variable(s) from remote .env`);
      remoteEnvLoaded = true;
    }

    // Apply three-tier precedence: OS > remote .env > local .env
    const envResult = applyPrecedence(osEnvSnapshot, localEnv, remoteEnv, logger);

    // STEP 8: Sync remaining files
    const syncStats = await syncEngine.syncFiles(config);

    // Build the initial SyncResult
    const duration = Date.now() - startTime;
    const initialSync: SyncResult = {
      attempted: true,
      totalBlobs: syncStats.totalBlobs,
      downloaded: syncStats.downloaded,
      skipped: syncStats.skipped,
      failed: syncStats.failed,
      failedBlobs: syncStats.failedBlobs,
      duration,
      remoteEnvLoaded,
      envSources: envResult.sources,
    };

    logger.info(
      `Initial sync complete: ${initialSync.downloaded} downloaded, ${initialSync.skipped} skipped, ${initialSync.failed} failed in ${initialSync.duration}ms`,
    );

    // STEP 9: Start watch mode if enabled
    let stopFn: () => void = () => {
      /* no-op */
    };

    if (config.watchEnabled || options?.pollInterval !== undefined) {
      const watcher = new BlobWatcher(
        config,
        blobClient,
        logger,
        osEnvSnapshot,
        localEnv,
      );

      const watchHandle = watcher.start(options);
      stopFn = watchHandle.stop;
    } else {
      logger.debug('Watch mode not enabled');
    }

    return {
      initialSync,
      stop: stopFn,
    };
  } catch (error: unknown) {
    // Configuration and authentication errors always propagate
    if (error instanceof ConfigurationError || error instanceof AuthenticationError) {
      throw error;
    }

    // Azure connection and sync errors depend on failOnError
    if (error instanceof AzureVenvError) {
      if (config.failOnError) {
        throw error;
      }

      logger.warn(`Azure sync failed (failOnError=false): ${error.message}`);

      return {
        initialSync: {
          attempted: true,
          totalBlobs: 0,
          downloaded: 0,
          skipped: 0,
          failed: 0,
          failedBlobs: [],
          duration: Date.now() - startTime,
          remoteEnvLoaded: false,
          envSources: {},
        },
        stop: () => {
          /* no-op */
        },
      };
    }

    // Unknown errors - wrap and handle based on failOnError
    if (config.failOnError) {
      throw new AzureConnectionError(
        `Unexpected error during Azure sync: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    logger.warn(
      `Azure sync failed with unexpected error (failOnError=false): ${error instanceof Error ? error.message : String(error)}`,
    );

    return {
      initialSync: {
        attempted: true,
        totalBlobs: 0,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        failedBlobs: [],
        duration: Date.now() - startTime,
        remoteEnvLoaded: false,
        envSources: {},
      },
      stop: () => {
        /* no-op */
      },
    };
  }
}
