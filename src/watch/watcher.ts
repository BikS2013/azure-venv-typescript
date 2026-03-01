import * as path from 'node:path';

import type { AzureVenvConfig, AzureVenvOptions } from '../config/types.js';
import { AzureVenvBlobClient } from '../azure/client.js';
import type {
  SyncResult,
  BlobContent,
  WatchChangeEvent,
  WatchOptions,
  WatchResult,
  WatchChangeType,
  EnvRecord,
  EnvDetails,
} from '../types/index.js';
import { buildFileTree } from '../introspection/file-tree.js';
import { NO_OP_SYNC_RESULT } from '../types/index.js';
import type { Logger } from '../logging/logger.js';
import type { BlobInfo } from '../azure/types.js';
import { SyncEngine } from '../sync/engine.js';
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
 * Helper to strip a prefix from a blob name.
 */
function stripPrefix(blobName: string, prefix: string): string {
  if (prefix === '' || !blobName.startsWith(prefix)) {
    return blobName;
  }
  const rel = blobName.slice(prefix.length);
  return rel === '' || rel === '/' ? blobName : rel;
}

/**
 * Helper to build a failed SyncResult for error recovery paths.
 */
function failedSyncResult(startTime: number): SyncResult {
  return {
    attempted: true,
    totalBlobs: 0,
    downloaded: 0,
    failed: 0,
    failedBlobs: [],
    duration: Date.now() - startTime,
    remoteEnvLoaded: false,
    envSources: {},
    blobs: [],
    fileTree: [],
    envDetails: {
      variables: {},
      sources: {},
      localKeys: [],
      remoteKeys: [],
      osKeys: [],
    },
  };
}

/**
 * Watches Azure Blob Storage for changes and re-reads blobs into memory on a polling interval.
 *
 * The watcher compares blob ETags against the last known state to detect
 * added or modified blobs, then downloads only the changed ones to memory.
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

  /** Track known blob ETags for change detection. */
  private knownEtags: Map<string, string> = new Map();

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
   * Initialize the known ETags from the initial sync blobs.
   */
  setInitialEtags(blobs: readonly BlobContent[]): void {
    this.knownEtags.clear();
    for (const blob of blobs) {
      this.knownEtags.set(blob.blobName, blob.etag);
    }
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
   * 2. Compare ETags to find added/modified blobs
   * 3. Download changed blobs to memory
   * 4. If remote .env changed, re-download and re-apply precedence
   * 5. Update known ETags
   * 6. Log summary of changes
   */
  private async poll(): Promise<void> {
    if (this.abortController.signal.aborted) {
      return;
    }

    this.logger.debug('Watch poll cycle starting');

    try {
      const prefix = this.config.blobUrl.prefix;

      // Step 1: List all blobs
      const allBlobs = await this.client.listBlobs(prefix);

      if (this.abortController.signal.aborted) {
        return;
      }

      // Step 2: Compare ETags - find added/modified blobs
      const envBlobName = prefix ? `${prefix}.env` : '.env';
      const changes: WatchChangeEvent[] = [];
      const changedFileBlobs: BlobInfo[] = [];
      let envChanged = false;

      for (const blob of allBlobs) {
        const knownEtag = this.knownEtags.get(blob.name);
        let changeType: WatchChangeType | null = null;

        if (knownEtag === undefined) {
          changeType = 'added';
        } else if (knownEtag !== blob.etag) {
          changeType = 'modified';
        }

        if (changeType !== null) {
          if (blob.name === envBlobName) {
            envChanged = true;
          } else {
            changedFileBlobs.push(blob);
          }

          const relativePath = stripPrefix(blob.name, prefix);

          changes.push({
            type: changeType,
            blobName: blob.name,
            relativePath,
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

      // Step 3: Download changed file blobs to memory
      if (changedFileBlobs.length > 0) {
        let readCount = 0;
        for (const blob of changedFileBlobs) {
          try {
            await this.client.downloadToBuffer(blob.name);
            // Update known ETag
            this.knownEtags.set(blob.name, blob.etag);
            readCount++;
          } catch (error: unknown) {
            this.logger.error(
              `Watch poll: failed to read blob "${blob.name}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        this.logger.info(
          `Watch poll: read ${readCount}/${changedFileBlobs.length} changed blob(s) to memory`,
        );
      }

      // Step 4: If remote .env changed, re-download and re-apply precedence
      if (envChanged) {
        this.logger.info('Watch poll: remote .env changed, re-applying environment variables');

        try {
          const envBuffer = await this.client.downloadToBuffer(envBlobName);
          const remoteEnv = parseEnvBuffer(envBuffer);

          this.logger.info(
            `Watch poll: parsed ${Object.keys(remoteEnv).length} variable(s) from remote .env`,
          );

          applyPrecedence(this.osEnvSnapshot, this.localEnv, remoteEnv, this.logger);

          // Update known ETag for .env
          const envBlob = allBlobs.find((b) => b.name === envBlobName);
          if (envBlob) {
            this.knownEtags.set(envBlobName, envBlob.etag);
          }
        } catch (error: unknown) {
          this.logger.error(
            `Watch poll: failed to re-apply remote .env: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Step 6: Log summary
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
 * (load local .env, validate config, create client, initial sync to memory),
 * and then optionally starts a BlobWatcher for continuous polling.
 *
 * @param options - Optional configuration and watch overrides.
 * @returns Promise resolving to WatchResult with initial sync stats and a stop function.
 *
 * @throws ConfigurationError if required config is partially present or invalid.
 * @throws AuthenticationError if SAS token is expired or authentication fails (when failOnError: true).
 * @throws AzureConnectionError if Azure is unreachable (when failOnError: true).
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
  logger.debug(`Concurrency: ${config.concurrency}`);

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

    // Create sync engine (in-memory)
    const syncEngine = new SyncEngine(blobClient, logger);

    // STEP 6 & 7: Fetch and load remote .env (if exists)
    let remoteEnvLoaded = false;
    let remoteEnv: EnvRecord = {};

    const remoteEnvBuffer = await syncEngine.fetchRemoteEnv(config.blobUrl.prefix);

    if (remoteEnvBuffer !== null) {
      remoteEnv = parseEnvBuffer(remoteEnvBuffer);
      logger.info(`Parsed ${Object.keys(remoteEnv).length} variable(s) from remote .env`);
      remoteEnvLoaded = true;
    }

    // Apply three-tier precedence: OS > remote .env > local .env
    const envResult = applyPrecedence(osEnvSnapshot, localEnv, remoteEnv, logger);

    // STEP 8: Read all blobs into memory
    const readResult = await syncEngine.readBlobs(config);

    // Build introspection data
    const fileTree = buildFileTree(readResult.blobs);

    const envDetails: EnvDetails = {
      variables: envResult.variables,
      sources: envResult.sources,
      localKeys: [...envResult.localKeys],
      remoteKeys: [...envResult.remoteKeys],
      osKeys: [...envResult.osKeys],
    };

    // Build the initial SyncResult
    const duration = Date.now() - startTime;
    const initialSync: SyncResult = {
      attempted: true,
      totalBlobs: readResult.totalBlobs,
      downloaded: readResult.blobs.length,
      failed: readResult.failed,
      failedBlobs: readResult.failedBlobs,
      duration,
      remoteEnvLoaded,
      envSources: envResult.sources,
      blobs: readResult.blobs,
      fileTree,
      envDetails,
    };

    logger.info(
      `Initial sync complete: ${initialSync.downloaded} read, ${initialSync.failed} failed in ${initialSync.duration}ms`,
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

      // Seed the watcher with known ETags from initial sync
      watcher.setInitialEtags(readResult.blobs);

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
        initialSync: failedSyncResult(startTime),
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
      initialSync: failedSyncResult(startTime),
      stop: () => {
        /* no-op */
      },
    };
  }
}
