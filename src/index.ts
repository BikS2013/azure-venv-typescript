// Public API
export { initAzureVenv } from './initialize.js';

// Configuration types
export type { AzureVenvOptions, AzureVenvConfig, ParsedBlobUrl, LogLevel, SyncMode } from './config/types.js';

// Result types
export type { SyncResult, SyncManifest, ManifestEntry, EnvSource, EnvRecord, EnvLoadResult, SyncedFileInfo, FileTreeNode, EnvDetails } from './types/index.js';

// Watch mode
export { watchAzureVenv } from './watch/watcher.js';
export type { WatchOptions, WatchChangeEvent, WatchResult, WatchChangeType } from './types/index.js';

// Introspection utilities
export { buildFileTree } from './introspection/file-tree.js';
export { manifestToSyncedFiles } from './introspection/manifest-reader.js';

// Azure types
export type { BlobInfo, BlobDownloadResult } from './azure/types.js';

// Logger
export type { Logger } from './logging/logger.js';

// Error classes (exported as values, not just types)
export {
  AzureVenvError,
  ConfigurationError,
  AzureConnectionError,
  AuthenticationError,
  SyncError,
  PathTraversalError,
} from './errors/index.js';
