// Re-export configuration types
export type {
  ParsedBlobUrl,
  LogLevel,
  AzureVenvConfig,
  AzureVenvOptions,
  RawEnvConfig,
} from '../config/types.js';

// Re-export Azure types
export type {
  BlobInfo,
  BlobClientConfig,
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
 * A blob's content held in memory after download from Azure Blob Storage.
 */
export interface BlobContent {
  /** Full blob name in Azure Blob Storage. */
  readonly blobName: string;

  /** Path relative to prefix (e.g., "config/app.json"). Forward-slash normalized. */
  readonly relativePath: string;

  /** Raw blob content. */
  readonly content: Buffer;

  /** Content length in bytes. */
  readonly size: number;

  /** Blob ETag. */
  readonly etag: string;

  /** Last modified date (ISO 8601). */
  readonly lastModified: string;
}

/**
 * A node in the hierarchical file tree representation of blobs.
 * Directories contain children; files are leaf nodes.
 */
export interface FileTreeNode {
  /** File or directory name (segment only, not the full path). */
  readonly name: string;

  /** Whether this node represents a file or a directory. */
  readonly type: 'file' | 'directory';

  /** Relative path from the blob prefix (forward-slash separated). */
  readonly path: string;

  /** Child nodes. Present and non-empty only for directory nodes. */
  readonly children?: readonly FileTreeNode[];

  /** File size in bytes. Present only for file nodes. */
  readonly size?: number;

  /** Full blob name in Azure Blob Storage. Present only for file nodes. */
  readonly blobName?: string;
}

/**
 * Full environment variable introspection data.
 *
 * SECURITY WARNING: The `variables` map contains actual values, which may
 * include secrets (passwords, tokens, connection strings). The SyncResult
 * object containing this data should not be logged or serialized to external
 * systems without filtering sensitive keys.
 */
export interface EnvDetails {
  /** Key-value map of all tracked environment variables (from all three tiers). */
  readonly variables: Readonly<Record<string, string>>;

  /** Source tier for each variable ('os' | 'remote' | 'local'). */
  readonly sources: Readonly<Record<string, EnvSource>>;

  /** Keys that came from the local .env file. */
  readonly localKeys: readonly string[];

  /** Keys that came from the remote .env file(s) synced from Azure. */
  readonly remoteKeys: readonly string[];

  /** OS environment keys that were preserved (not overridden by .env files). */
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

  /** Number of blobs successfully downloaded to memory. */
  readonly downloaded: number;

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

  /** In-memory blob contents, sorted by relativePath. */
  readonly blobs: readonly BlobContent[];

  /** Hierarchical tree of all blobs. Built from blobs via buildFileTree(). */
  readonly fileTree: readonly FileTreeNode[];

  /** Full environment variable introspection data. */
  readonly envDetails: EnvDetails;
}

/**
 * A no-op SyncResult returned when Azure VENV is not configured.
 */
export const NO_OP_SYNC_RESULT: SyncResult = {
  attempted: false,
  totalBlobs: 0,
  downloaded: 0,
  failed: 0,
  failedBlobs: [],
  duration: 0,
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
} as const;

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

  /** Relative path from the blob prefix. */
  readonly relativePath: string;

  /** Timestamp when the change was detected. */
  readonly timestamp: Date;

  /** Updated blob content (available after download). */
  readonly blob?: BlobContent;
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
