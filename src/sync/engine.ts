import type { AzureVenvBlobClient } from '../azure/client.js';
import type { BlobInfo } from '../azure/types.js';
import type { AzureVenvConfig } from '../config/types.js';
import type { Logger } from '../logging/logger.js';
import type { BlobContent } from '../types/index.js';

/**
 * Strip a prefix from a blob name to produce a relative path.
 *
 * @param blobName - Full blob name including prefix.
 * @param prefix - The prefix to strip.
 * @returns Relative path with prefix removed.
 */
function stripPrefix(blobName: string, prefix: string): string {
  if (prefix === '' || !blobName.startsWith(prefix)) {
    return blobName;
  }
  const rel = blobName.slice(prefix.length);
  return rel === '' || rel === '/' ? blobName : rel;
}

/**
 * Orchestrates reading blob contents into memory with concurrency control.
 */
export class SyncEngine {
  private readonly client: AzureVenvBlobClient;
  private readonly logger: Logger;

  /**
   * @param client - Azure Blob client for listing and downloading.
   * @param logger - Logger instance.
   */
  constructor(
    client: AzureVenvBlobClient,
    logger: Logger,
  ) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * Check for a .env file at the blob prefix root, download it if present,
   * and return its content as a Buffer.
   *
   * @param prefix - The blob prefix (virtual directory).
   * @returns Buffer containing the .env content, or null if not found.
   */
  async fetchRemoteEnv(prefix: string): Promise<Buffer | null> {
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
   * Read all blobs (except .env) from Azure into memory with concurrency control.
   *
   * @param config - Validated configuration.
   * @returns Statistics and in-memory blob contents.
   */
  async readBlobs(config: AzureVenvConfig): Promise<{
    blobs: BlobContent[];
    failed: number;
    failedBlobs: string[];
    totalBlobs: number;
  }> {
    const prefix = config.blobUrl.prefix;

    this.logger.info(`Starting in-memory blob read with prefix "${prefix}"`);

    // List all blobs under the prefix
    const allBlobs = await this.client.listBlobs(prefix);

    // Filter out the .env file (handled separately by fetchRemoteEnv)
    const envBlobName = prefix ? `${prefix}.env` : '.env';
    const fileBlobs = allBlobs.filter((blob) => blob.name !== envBlobName);

    this.logger.info(`Found ${fileBlobs.length} blob(s) to read (excluding .env)`);

    const totalBlobs = fileBlobs.length;

    if (totalBlobs === 0) {
      return {
        blobs: [],
        failed: 0,
        failedBlobs: [],
        totalBlobs: 0,
      };
    }

    // Download all blobs to memory with concurrency control
    const blobs: BlobContent[] = [];
    const failedBlobs: string[] = [];
    const concurrency = config.concurrency;

    // Process in batches of `concurrency`
    for (let i = 0; i < fileBlobs.length; i += concurrency) {
      const batch = fileBlobs.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map((blob) => this.downloadBlobToMemory(blob, prefix)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          blobs.push(result.value);
        } else {
          const blobName = batch[j].name;
          failedBlobs.push(blobName);
          this.logger.error(
            `Failed to read blob "${blobName}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    }

    // Sort blobs by relativePath
    blobs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    this.logger.info(
      `Read complete: ${blobs.length} read, ${failedBlobs.length} failed out of ${totalBlobs} total`,
    );

    return {
      blobs,
      failed: failedBlobs.length,
      failedBlobs,
      totalBlobs,
    };
  }

  /**
   * Download a single blob into memory and produce a BlobContent object.
   */
  private async downloadBlobToMemory(blob: BlobInfo, prefix: string): Promise<BlobContent> {
    const buffer = await this.client.downloadToBuffer(blob.name);
    const relativePath = stripPrefix(blob.name, prefix);

    return {
      blobName: blob.name,
      relativePath,
      content: buffer,
      size: buffer.length,
      etag: blob.etag,
      lastModified: blob.lastModified.toISOString(),
    };
  }
}
