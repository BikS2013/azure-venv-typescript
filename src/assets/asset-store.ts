import type { SyncResult, BlobContent } from '../types/index.js';
import type { AssetStoreOptions, InitAssetStoreOptions } from './types.js';
import { findBlobBySource } from '../introspection/source-lookup.js';

/**
 * In-memory asset store built on top of azure-venv's blob sync.
 *
 * Wraps a SyncResult's blob list with registry-scoped lookups,
 * optional string caching, and typed retrieval methods.
 */
export class AssetStore {
  private blobs: readonly BlobContent[];
  private readonly registry: string;
  private readonly cacheTTL: number;
  private readonly cache: Map<string, { data: string; timestamp: number }> = new Map();

  /** Stored init config for refresh(), set internally by initAssetStore(). */
  private _refreshConfig?: InitAssetStoreOptions;

  constructor(syncResult: SyncResult, options: AssetStoreOptions) {
    this.blobs = syncResult.blobs;
    this.registry = options.registry;
    this.cacheTTL = options.cacheTTL ?? 0;
  }

  /** Whether the store has any blobs loaded. */
  isAvailable(): boolean {
    return this.blobs.length > 0;
  }

  /** Number of blobs in the store. */
  get blobCount(): number {
    return this.blobs.length;
  }

  /** The default registry used for short asset keys. */
  get defaultRegistry(): string {
    return this.registry;
  }

  /**
   * Retrieve an asset as a UTF-8 string.
   *
   * @param key - Asset key. If it contains `@`, used as a full source expression.
   *              Otherwise, the default registry is appended: `key@registry`.
   * @throws {Error} If the asset is not found.
   */
  getAsset(key: string): string {
    const expression = this.resolveExpression(key);

    // Check cache (only if caching is enabled)
    if (this.cacheTTL > 0) {
      const cached = this.cache.get(expression);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.data;
      }
    }

    const blob = findBlobBySource(this.blobs, expression);
    if (!blob) {
      throw new Error(`Asset not found: ${expression}`);
    }

    const data = blob.content.toString('utf-8');

    // Update cache if enabled
    if (this.cacheTTL > 0) {
      this.cache.set(expression, { data, timestamp: Date.now() });
    }

    return data;
  }

  /**
   * Retrieve an asset as a raw Buffer (for binary content).
   *
   * @param key - Asset key (same resolution rules as getAsset).
   * @throws {Error} If the asset is not found.
   */
  getRawAsset(key: string): Buffer {
    const expression = this.resolveExpression(key);
    const blob = findBlobBySource(this.blobs, expression);
    if (!blob) {
      throw new Error(`Asset not found: ${expression}`);
    }
    return blob.content;
  }

  /**
   * Retrieve and parse a JSON asset.
   *
   * @param key - Asset key (same resolution rules as getAsset).
   * @throws {Error} If the asset is not found or is not valid JSON.
   */
  getJsonAsset<T = unknown>(key: string): T {
    const data = this.getAsset(key);
    return JSON.parse(data) as T;
  }

  /**
   * Look up a blob by asset key without throwing.
   *
   * @param key - Asset key (same resolution rules as getAsset).
   * @returns The matching BlobContent, or undefined if not found.
   */
  findAsset(key: string): BlobContent | undefined {
    const expression = this.resolveExpression(key);
    return findBlobBySource(this.blobs, expression);
  }

  /**
   * Check whether an asset exists in the store.
   *
   * @param key - Asset key (same resolution rules as getAsset).
   */
  hasAsset(key: string): boolean {
    return this.findAsset(key) !== undefined;
  }

  /**
   * List all source expressions (`sourcePath@sourceRegistry`) for blobs
   * that have both metadata fields set.
   */
  listAssets(): string[] {
    const result: string[] = [];
    for (const blob of this.blobs) {
      if (blob.sourcePath && blob.sourceRegistry) {
        result.push(`${blob.sourcePath}@${blob.sourceRegistry}`);
      }
    }
    return result;
  }

  /** Clear the string cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Re-sync blobs from Azure and update the store.
   * Only available if the store was created via `initAssetStore()`.
   *
   * @throws {Error} If the store was not created via initAssetStore().
   */
  async refresh(): Promise<void> {
    if (!this._refreshConfig) {
      throw new Error(
        'refresh() is only available on stores created via initAssetStore(). ' +
        'For stores created from SyncResult, re-run initAzureVenv() and create a new AssetStore.',
      );
    }

    // Lazy import to avoid circular dependency
    const { doInitAssetStore } = await import('./init-asset-store.js');
    const newStore = await doInitAssetStore(this._refreshConfig);
    this.blobs = newStore.blobs;
    this.cache.clear();
  }

  /**
   * Resolve a short asset key to a full source expression.
   * If the key contains `@`, it's returned as-is.
   * Otherwise, `@registry` is appended.
   */
  private resolveExpression(key: string): string {
    return key.includes('@') ? key : `${key}@${this.registry}`;
  }

  /** @internal Set by initAssetStore() to enable refresh(). */
  _setRefreshConfig(config: InitAssetStoreOptions): void {
    this._refreshConfig = config;
  }
}
