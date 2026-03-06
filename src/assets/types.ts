import type { LogLevel } from '../config/types.js';

/**
 * Options for creating an AssetStore from an existing SyncResult.
 */
export interface AssetStoreOptions {
  /** Default source_registry for short asset keys (keys without @). */
  readonly registry: string;

  /**
   * Cache TTL in milliseconds for string-converted asset content.
   * Set to 0 to disable caching. Default: 0 (disabled).
   */
  readonly cacheTTL?: number;
}

/**
 * Options for the initAssetStore() convenience function.
 * These configure both the Azure sync and the resulting AssetStore.
 */
export interface InitAssetStoreOptions {
  /** Azure Blob Storage URL for the asset container (e.g., https://account.blob.core.windows.net/container/). */
  readonly url: string;

  /** SAS token for accessing the asset container. */
  readonly sasToken: string;

  /** Default source_registry for short asset keys. */
  readonly registry: string;

  /** Cache TTL in milliseconds. Default: 0 (disabled). */
  readonly cacheTTL?: number;

  /** Log level for the Azure sync. Default: 'info'. */
  readonly logLevel?: LogLevel;

  /** Max parallel blob downloads. Default: 5. */
  readonly concurrency?: number;

  /** Per-blob download timeout in ms. Default: 30000. */
  readonly timeout?: number;
}
