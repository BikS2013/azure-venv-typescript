// Re-export configuration types
export type {
  ParsedBlobUrl,
  LogLevel,
  SyncMode,
  AzureVenvConfig,
  AzureVenvOptions,
  RawEnvConfig,
} from '../config/types.js';

// Re-export Azure types
export type {
  BlobInfo,
  BlobClientConfig,
  BlobDownloadResult,
} from '../azure/types.js';

// Re-export Logger
export type { Logger } from '../logging/logger.js';

/**
 * Source tier from which an environment variable was loaded.
 */
export type EnvSource = 'os' | 'remote' | 'local';

/**
 * Parsed key-value pairs from a .env file.
 */
export type EnvRecord = Record<string, string>;

/**
 * Result of loading environment variables with source tracking.
 */
export interface EnvLoadResult {
  /** Merged environment variables (does not include full process.env, only tracked variables). */
  readonly variables: Readonly<EnvRecord>;

  /** Source tier for each variable. */
  readonly sources: Readonly<Record<string, EnvSource>>;

  /** Keys loaded from local .env. */
  readonly localKeys: readonly string[];

  /** Keys loaded from remote .env. */
  readonly remoteKeys: readonly string[];

  /** Keys from OS environment that were preserved (not overridden). */
  readonly osKeys: readonly string[];
}

/**
 * Result of a complete sync operation. Returned by initAzureVenv().
 */
export interface SyncResult {
  /** Whether Azure sync was attempted. False if AZURE_VENV was not configured. */
  readonly attempted: boolean;

  /** Total number of blobs found in Azure Blob Storage. */
  readonly totalBlobs: number;

  /** Number of blobs successfully downloaded. */
  readonly downloaded: number;

  /** Number of blobs skipped (ETag matched, no change). */
  readonly skipped: number;

  /** Number of blobs that failed to download. */
  readonly failed: number;

  /** Names of blobs that failed to download. */
  readonly failedBlobs: readonly string[];

  /** Total sync duration in milliseconds. */
  readonly duration: number;

  /** Whether a remote .env file was found and loaded. */
  readonly remoteEnvLoaded: boolean;

  /** Map of environment variable names to their source tier. */
  readonly envSources: Readonly<Record<string, EnvSource>>;
}

/**
 * A no-op SyncResult returned when Azure VENV is not configured.
 */
export const NO_OP_SYNC_RESULT: SyncResult = {
  attempted: false,
  totalBlobs: 0,
  downloaded: 0,
  skipped: 0,
  failed: 0,
  failedBlobs: [],
  duration: 0,
  remoteEnvLoaded: false,
  envSources: {},
} as const;

/**
 * Manifest entry for a single synced blob.
 */
export interface ManifestEntry {
  /** Full blob name in Azure. */
  readonly blobName: string;

  /** ETag at the time of last successful sync. */
  readonly etag: string;

  /** Last modified date at time of last sync (ISO 8601). */
  readonly lastModified: string;

  /** Content length in bytes at time of last sync. */
  readonly contentLength: number;

  /** Local file path where the blob was written (relative to rootDir). */
  readonly localPath: string;

  /** Timestamp when this entry was last synced (ISO 8601). */
  readonly syncedAt: string;
}

/**
 * The full sync manifest stored as .azure-venv-manifest.json.
 */
export interface SyncManifest {
  /** Schema version for forward compatibility. Current: 1. */
  readonly version: number;

  /** Timestamp of the last full sync run (ISO 8601). */
  readonly lastSyncAt: string;

  /** Map of blob names to their manifest entries. */
  readonly entries: Record<string, ManifestEntry>;
}

// ---- Watch Mode Types ----

/**
 * Type of change detected during watch polling.
 */
export type WatchChangeType = 'added' | 'modified';

/**
 * A single change event detected during a watch poll cycle.
 */
export interface WatchChangeEvent {
  /** Type of change. */
  readonly type: WatchChangeType;

  /** Full blob name in Azure. */
  readonly blobName: string;

  /** Local path where the blob was synced. */
  readonly localPath: string;

  /** Timestamp when the change was detected. */
  readonly timestamp: Date;
}

/**
 * Options for the watch mode.
 */
export interface WatchOptions {
  /** Override polling interval in ms. */
  pollInterval?: number;

  /** External AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Result returned by watchAzureVenv().
 */
export interface WatchResult {
  /** Result of the initial sync. */
  readonly initialSync: SyncResult;

  /** Call to gracefully stop watching. */
  readonly stop: () => void;
}
