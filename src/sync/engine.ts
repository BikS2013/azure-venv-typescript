import type { AzureVenvBlobClient } from '../azure/client.js';
import type { BlobInfo } from '../azure/types.js';
import type { AzureVenvConfig } from '../config/types.js';
import type { Logger } from '../logging/logger.js';
import { ManifestManager } from './manifest.js';
import { BlobDownloader } from './downloader.js';
import { stripPrefix } from './path-validator.js';

/**
 * Orchestrates the file synchronization process.
 */
export class SyncEngine {
  private readonly client: AzureVenvBlobClient;
  private readonly manifestManager: ManifestManager;
  private readonly downloader: BlobDownloader;
  private readonly logger: Logger;

  /**
   * @param client - Azure Blob client for listing and downloading.
   * @param manifestManager - Manifest manager for incremental sync tracking.
   * @param downloader - Blob downloader with concurrency control.
   * @param logger - Logger instance.
   */
  constructor(
    client: AzureVenvBlobClient,
    manifestManager: ManifestManager,
    downloader: BlobDownloader,
    logger: Logger,
  ) {
    this.client = client;
    this.manifestManager = manifestManager;
    this.downloader = downloader;
    this.logger = logger;
  }

  /**
   * Check for a .env file at the blob prefix root, download it if present,
   * and return its content as a Buffer.
   *
   * @param prefix - The blob prefix (virtual directory).
   * @param rootDir - Application root directory (unused but kept for interface consistency).
   * @returns Buffer containing the .env content, or null if not found.
   */
  async fetchRemoteEnv(prefix: string, _rootDir: string): Promise<Buffer | null> {
    const envBlobName = prefix ? `${prefix}.env` : '.env';

    this.logger.info(`Checking for remote .env at "${envBlobName}"`);

    try {
      const buffer = await this.client.downloadToBuffer(envBlobName);
      this.logger.info(`Remote .env found (${buffer.length} bytes)`);
      return buffer;
    } catch (error: unknown) {
      // If the blob is not found (404), return null
      this.logger.debug(
        `Remote .env not found or failed to download: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Synchronize all blobs (except .env) from Azure to the local filesystem.
   *
   * @param config - Validated configuration.
   * @returns Statistics about the sync operation.
   */
  async syncFiles(config: AzureVenvConfig): Promise<{
    downloaded: number;
    skipped: number;
    failed: number;
    failedBlobs: string[];
    totalBlobs: number;
  }> {
    const prefix = config.blobUrl.prefix;
    const rootDir = config.rootDir;

    this.logger.info(`Starting file sync with prefix "${prefix}" to "${rootDir}"`);

    // List all blobs under the prefix
    const allBlobs = await this.client.listBlobs(prefix);

    // Filter out the .env file (handled separately by fetchRemoteEnv)
    const envBlobName = prefix ? `${prefix}.env` : '.env';
    const fileBlobs = allBlobs.filter((blob) => blob.name !== envBlobName);

    this.logger.info(`Found ${fileBlobs.length} blob(s) to sync (excluding .env)`);

    const totalBlobs = fileBlobs.length;

    if (totalBlobs === 0) {
      return {
        downloaded: 0,
        skipped: 0,
        failed: 0,
        failedBlobs: [],
        totalBlobs: 0,
      };
    }

    // Load manifest for incremental mode
    const manifest = await this.manifestManager.load();
    let blobsToDownload: BlobInfo[];

    if (config.syncMode === 'incremental') {
      // Filter to only blobs that need updating
      blobsToDownload = fileBlobs.filter((blob) =>
        this.manifestManager.needsUpdate(blob, manifest),
      );
      const skippedCount = totalBlobs - blobsToDownload.length;

      this.logger.info(
        `Incremental mode: ${blobsToDownload.length} to download, ${skippedCount} unchanged`,
      );
    } else {
      blobsToDownload = fileBlobs;
      this.logger.info(`Full mode: downloading all ${blobsToDownload.length} blob(s)`);
    }

    // Download changed blobs
    const results = await this.downloader.downloadBatch(
      blobsToDownload,
      rootDir,
      prefix,
    );

    // Track failed blobs
    const downloadedBlobNames = new Set(results.map((r) => r.blobName));
    const failedBlobs: string[] = [];

    for (const blob of blobsToDownload) {
      if (!downloadedBlobNames.has(blob.name)) {
        failedBlobs.push(blob.name);
      }
    }

    // Update manifest entries for successfully downloaded blobs
    const updatedEntries = { ...manifest.entries };

    for (const result of results) {
      const matchingBlob = blobsToDownload.find((b) => b.name === result.blobName);
      if (matchingBlob) {
        let relativePath: string;
        try {
          relativePath = stripPrefix(matchingBlob.name, prefix);
        } catch {
          relativePath = result.localPath;
        }

        const entry = this.manifestManager.createEntry(matchingBlob, relativePath);
        updatedEntries[matchingBlob.name] = entry;
      }
    }

    // Save updated manifest
    const updatedManifest = {
      ...manifest,
      entries: updatedEntries,
    };

    await this.manifestManager.save(updatedManifest);

    const skipped = totalBlobs - blobsToDownload.length;
    const downloaded = results.length;
    const failed = failedBlobs.length;

    this.logger.info(
      `Sync complete: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed out of ${totalBlobs} total`,
    );

    return {
      downloaded,
      skipped,
      failed,
      failedBlobs,
      totalBlobs,
    };
  }
}
