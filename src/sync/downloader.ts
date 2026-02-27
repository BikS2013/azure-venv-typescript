import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AzureVenvBlobClient } from '../azure/client.js';
import type { BlobInfo, BlobDownloadResult } from '../azure/types.js';
import type { Logger } from '../logging/logger.js';
import { PathTraversalError } from '../errors/index.js';
import { validateAndResolvePath, stripPrefix } from './path-validator.js';

/**
 * Downloads blobs to local files with concurrency control.
 */
export class BlobDownloader {
  private readonly client: AzureVenvBlobClient;
  private readonly pathValidator: {
    validateAndResolvePath: typeof validateAndResolvePath;
  };
  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly maxBlobSize: number;

  /**
   * @param client - Azure Blob client for downloading.
   * @param pathValidator - Path validation functions.
   * @param logger - Logger instance.
   * @param concurrency - Maximum parallel downloads.
   * @param maxBlobSize - Blob size threshold in bytes; blobs larger than this use streaming download.
   */
  constructor(
    client: AzureVenvBlobClient,
    pathValidator: { validateAndResolvePath: typeof validateAndResolvePath },
    logger: Logger,
    concurrency: number,
    maxBlobSize: number,
  ) {
    this.client = client;
    this.pathValidator = pathValidator;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maxBlobSize = maxBlobSize;
  }

  /**
   * Download a batch of blobs to local files with concurrency control.
   *
   * @param blobs - Array of BlobInfo objects to download.
   * @param rootDir - Application root directory.
   * @param prefix - The blob prefix to strip from blob names.
   * @returns Array of BlobDownloadResult (one per successfully downloaded blob).
   *
   * Contract:
   *   - Downloads at most `concurrency` blobs in parallel using a semaphore.
   *   - Skips blobs that fail path validation (logs warning, does not throw).
   *   - Continues on individual blob download failures (logs error, tracks in results).
   *   - Logs each download at info level.
   */
  async downloadBatch(
    blobs: BlobInfo[],
    rootDir: string,
    prefix: string,
  ): Promise<BlobDownloadResult[]> {
    const results: BlobDownloadResult[] = [];
    let activeCount = 0;
    const waitQueue: Array<() => void> = [];

    const acquireSemaphore = async (): Promise<void> => {
      while (activeCount >= this.concurrency) {
        await new Promise<void>((resolve) => {
          waitQueue.push(resolve);
        });
      }
      activeCount++;
    };

    const releaseSemaphore = (): void => {
      activeCount--;
      if (waitQueue.length > 0) {
        const next = waitQueue.shift()!;
        next();
      }
    };

    const downloadOne = async (blob: BlobInfo): Promise<BlobDownloadResult | null> => {
      // Strip prefix and validate path
      let relativePath: string;
      let localPath: string;
      try {
        relativePath = stripPrefix(blob.name, prefix);
        localPath = this.pathValidator.validateAndResolvePath(relativePath, rootDir);
      } catch (error: unknown) {
        if (error instanceof PathTraversalError) {
          this.logger.warn(
            `Skipping blob "${blob.name}": path validation failed - ${error.message}`,
          );
        } else {
          this.logger.warn(
            `Skipping blob "${blob.name}": unexpected path error - ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }

      // Create parent directories
      try {
        const parentDir = path.dirname(localPath);
        await fs.mkdir(parentDir, { recursive: true });
      } catch (error: unknown) {
        this.logger.error(
          `Failed to create directory for blob "${blob.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }

      // Download the blob - use streaming for large blobs
      try {
        let result: BlobDownloadResult;
        if (blob.contentLength > this.maxBlobSize) {
          this.logger.info(
            `Streaming download "${blob.name}" (${blob.contentLength} bytes > ${this.maxBlobSize} threshold)`,
          );
          result = await this.client.downloadToFileStreaming(blob.name, localPath);
        } else {
          result = await this.client.downloadToFile(blob.name, localPath);
        }
        this.logger.info(
          `Downloaded "${blob.name}" (${result.contentLength} bytes) -> "${localPath}"`,
        );
        return result;
      } catch (error: unknown) {
        this.logger.error(
          `Failed to download blob "${blob.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    };

    // Process all blobs with concurrency control
    const promises = blobs.map(async (blob) => {
      await acquireSemaphore();
      try {
        const result = await downloadOne(blob);
        if (result) {
          results.push(result);
        }
      } finally {
        releaseSemaphore();
      }
    });

    await Promise.allSettled(promises);

    this.logger.info(
      `Batch download complete: ${results.length}/${blobs.length} succeeded`,
    );

    return results;
  }
}
