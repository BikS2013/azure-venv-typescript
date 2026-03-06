import type { InitAssetStoreOptions } from './types.js';
import type { SyncResult } from '../types/index.js';
import { AssetStore } from './asset-store.js';
import { initAzureVenv } from '../initialize.js';
import { ConfigurationError } from '../errors/index.js';

/**
 * Internal: performs the Azure sync with temporary process.env overrides.
 * Returns the SyncResult (not a full AssetStore) so refresh() can use it.
 */
export async function doInitAssetStore(options: InitAssetStoreOptions): Promise<SyncResult> {
  // Capture current values
  const savedVenv = process.env.AZURE_VENV;
  const savedSas = process.env.AZURE_VENV_SAS_TOKEN;

  try {
    // Temporarily override process.env for initAzureVenv
    process.env.AZURE_VENV = options.url;
    process.env.AZURE_VENV_SAS_TOKEN = options.sasToken;

    const syncResult = await initAzureVenv({
      logLevel: options.logLevel,
      concurrency: options.concurrency,
      timeout: options.timeout,
    });

    return syncResult;
  } finally {
    // Restore original values (even on error)
    if (savedVenv !== undefined) {
      process.env.AZURE_VENV = savedVenv;
    } else {
      delete process.env.AZURE_VENV;
    }
    if (savedSas !== undefined) {
      process.env.AZURE_VENV_SAS_TOKEN = savedSas;
    } else {
      delete process.env.AZURE_VENV_SAS_TOKEN;
    }
  }
}

/**
 * Initialize an AssetStore by syncing blobs from an Azure Blob Storage container.
 *
 * This is a convenience function for the two-scope initialization pattern.
 * It temporarily overrides process.env to point to the asset container,
 * calls initAzureVenv(), then restores the original environment.
 *
 * @example
 * ```typescript
 * // Step 1: Load env vars (existing behavior)
 * const envResult = await initAzureVenv();
 *
 * // Step 2: Load asset blobs from a different container/prefix
 * const store = await initAssetStore({
 *   url: process.env.AZURE_ASSET_STORE!,
 *   sasToken: process.env.AZURE_ASSET_SAS_TOKEN!,
 *   registry: process.env.ASSET_REGISTRY!,
 * });
 *
 * const config = store.getAsset('config/agents.yaml');
 * ```
 *
 * @throws {ConfigurationError} If url, sasToken, or registry is missing.
 */
export async function initAssetStore(options: InitAssetStoreOptions): Promise<AssetStore> {
  if (!options.url) {
    throw new ConfigurationError(
      'initAssetStore requires a url (Azure Blob Storage URL for the asset container).',
      'url',
    );
  }
  if (!options.sasToken) {
    throw new ConfigurationError(
      'initAssetStore requires a sasToken for the asset container.',
      'sasToken',
    );
  }
  if (!options.registry) {
    throw new ConfigurationError(
      'initAssetStore requires a registry (default source_registry for asset lookups).',
      'registry',
    );
  }

  const syncResult = await doInitAssetStore(options);

  const store = new AssetStore(syncResult, {
    registry: options.registry,
    cacheTTL: options.cacheTTL,
  });

  // Enable refresh() by storing the init config
  store._setRefreshConfig(options);

  return store;
}
