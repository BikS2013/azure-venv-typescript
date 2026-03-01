import * as path from 'node:path';

import type { AzureVenvOptions } from './config/types.js';
import type { SyncResult, EnvRecord, EnvDetails } from './types/index.js';
import { buildFileTree } from './introspection/file-tree.js';
import { NO_OP_SYNC_RESULT } from './types/index.js';
import { validateConfig } from './config/validator.js';
import { createLogger } from './logging/logger.js';
import { parseEnvFile, parseEnvBuffer } from './env/loader.js';
import { applyPrecedence } from './env/precedence.js';
import { AzureVenvBlobClient } from './azure/client.js';
import { SyncEngine } from './sync/engine.js';
import {
  AzureVenvError,
  ConfigurationError,
  AuthenticationError,
  AzureConnectionError,
} from './errors/index.js';

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
 * Initialize the azure-venv library. Call this at application startup, before any other
 * imports or initialization that depend on remote files or environment variables.
 *
 * This function:
 * 1. Loads the local .env file (does not override OS env vars)
 * 2. Checks for AZURE_VENV and AZURE_VENV_SAS_TOKEN in process.env
 * 3. If both are present, connects to Azure Blob Storage
 * 4. Downloads a remote .env (if it exists) and applies it with three-tier precedence
 * 5. Reads all remaining blob files into memory
 * 6. Returns a SyncResult with blob contents and statistics
 *
 * If AZURE_VENV and AZURE_VENV_SAS_TOKEN are both absent after local .env loading,
 * the function returns a no-op SyncResult (azure-venv is not configured).
 *
 * @param options - Optional configuration overrides. Required config is always from process.env.
 * @returns Promise resolving to SyncResult with in-memory blob contents.
 * @throws ConfigurationError if required config is partially present or invalid
 * @throws AuthenticationError if SAS token is expired or authentication fails (when failOnError: true)
 * @throws AzureConnectionError if Azure is unreachable (when failOnError: true)
 */
export async function initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult> {
  const startTime = Date.now();

  // STEP 0: Capture OS environment snapshot BEFORE any .env loading
  const osEnvSnapshot = new Set(Object.keys(process.env));

  // Create a bootstrap logger (before config is validated, no SAS to sanitize yet)
  const bootstrapLogger = createLogger(options?.logLevel ?? 'info', '');

  // STEP 1: Load local .env file
  const rootDir = options?.rootDir ?? process.cwd();
  const envPath = options?.envPath ?? '.env';
  const localEnvFilePath = path.resolve(rootDir, envPath);

  bootstrapLogger.info('Initializing azure-venv');

  const localEnv = await parseEnvFile(localEnvFilePath, bootstrapLogger);

  // Apply local .env to process.env without overriding OS vars
  for (const key of Object.keys(localEnv)) {
    if (!osEnvSnapshot.has(key)) {
      process.env[key] = localEnv[key];
    }
  }

  // STEP 2 & 3: Validate configuration
  const config = validateConfig(process.env as Record<string, string | undefined>, options);

  if (config === null) {
    bootstrapLogger.info('AZURE_VENV not configured, skipping Azure sync');
    return NO_OP_SYNC_RESULT;
  }

  // Now we have a validated config with SAS token - create the real logger
  const logger = createLogger(config.logLevel, config.sasToken);

  logger.info('Azure VENV configured, starting sync');
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

    // Create sync engine (in-memory only)
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

    // STEP 10: Build and return SyncResult
    const duration = Date.now() - startTime;

    const result: SyncResult = {
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
      `Azure VENV sync complete: ${result.downloaded} read, ${result.failed} failed in ${result.duration}ms`,
    );

    return result;
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
      return failedSyncResult(startTime);
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

    return failedSyncResult(startTime);
  }
}
