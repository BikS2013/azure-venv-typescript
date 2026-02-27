import {
  ContainerClient,
  AnonymousCredential,
  RestError,
  BlockBlobClient,
} from '@azure/storage-blob';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import type { BlobClientConfig, BlobInfo, BlobDownloadResult } from './types.js';
import type { Logger } from '../logging/logger.js';
import { sanitize } from '../logging/logger.js';
import { AuthenticationError, AzureConnectionError, SyncError } from '../errors/index.js';

/**
 * Wrapper around @azure/storage-blob SDK providing the operations needed by azure-venv.
 *
 * All methods sanitize SAS tokens from error messages before propagation.
 * The constructor does NOT validate the connection -- validation happens on first operation.
 */
export class AzureVenvBlobClient {
  private readonly containerClient: ContainerClient;
  private readonly logger: Logger;
  private readonly sasToken: string;

  /**
   * @param config - Connection configuration.
   * @param logger - Logger instance for diagnostic output.
   */
  constructor(config: BlobClientConfig, logger: Logger) {
    this.logger = logger;
    this.sasToken = config.sasToken;

    const containerUrl = `${config.accountUrl}/${config.containerName}?${config.sasToken}`;
    this.containerClient = new ContainerClient(
      containerUrl,
      new AnonymousCredential(),
    );

    this.logger.debug(
      `AzureVenvBlobClient initialized for container "${config.containerName}"`,
    );
  }

  /**
   * List all blobs under the given prefix using flat listing.
   *
   * @param prefix - Virtual directory prefix (with trailing '/' or empty for container root).
   * @returns Array of BlobInfo for each blob found.
   *
   * @throws AzureConnectionError on network/timeout errors.
   * @throws AuthenticationError on 403 responses.
   */
  async listBlobs(prefix: string): Promise<BlobInfo[]> {
    this.logger.debug(`Listing blobs with prefix: "${prefix}"`);

    try {
      const blobs: BlobInfo[] = [];

      for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
        const blobInfo: BlobInfo = {
          name: blob.name,
          etag: blob.properties.etag ?? '',
          lastModified: blob.properties.lastModified ?? new Date(0),
          contentLength: blob.properties.contentLength ?? 0,
          contentMD5: blob.properties.contentMD5
            ? Buffer.from(blob.properties.contentMD5).toString('base64')
            : undefined,
        };
        blobs.push(blobInfo);
      }

      this.logger.debug(`Listed ${blobs.length} blob(s) under prefix "${prefix}"`);
      return blobs;
    } catch (error: unknown) {
      throw this.translateError(error, `Failed to list blobs with prefix "${prefix}"`);
    }
  }

  /**
   * Download a blob directly to a local file path.
   *
   * @param blobName - Full blob name in the container.
   * @param localPath - Absolute local file path to write to.
   * @returns BlobDownloadResult with metadata.
   *
   * @throws AzureConnectionError on network/timeout errors.
   * @throws AuthenticationError on 403 responses.
   * @throws SyncError if the local file cannot be written.
   */
  async downloadToFile(blobName: string, localPath: string): Promise<BlobDownloadResult> {
    this.logger.debug(`Downloading blob "${blobName}" to "${localPath}"`);

    try {
      const blockBlobClient: BlockBlobClient =
        this.containerClient.getBlockBlobClient(blobName);

      const response = await blockBlobClient.downloadToFile(localPath);

      const result: BlobDownloadResult = {
        blobName,
        localPath,
        etag: response.etag ?? '',
        lastModified: response.lastModified ?? new Date(0),
        contentLength: response.contentLength ?? 0,
      };

      this.logger.debug(
        `Downloaded blob "${blobName}" (${result.contentLength} bytes)`,
      );

      return result;
    } catch (error: unknown) {
      if (error instanceof AuthenticationError || error instanceof AzureConnectionError || error instanceof SyncError) {
        throw error;
      }
      throw this.translateError(error, `Failed to download blob "${blobName}" to "${localPath}"`);
    }
  }

  /**
   * Download a blob to a local file using streaming.
   * Preferred for large blobs to avoid buffering entire content in memory.
   *
   * @param blobName - Full blob name in the container.
   * @param localPath - Absolute local file path to write to.
   * @returns BlobDownloadResult with metadata.
   *
   * @throws AzureConnectionError on network/timeout errors.
   * @throws AuthenticationError on 403 responses.
   * @throws SyncError if the local file cannot be written.
   */
  async downloadToFileStreaming(blobName: string, localPath: string): Promise<BlobDownloadResult> {
    this.logger.debug(`Streaming download blob "${blobName}" to "${localPath}"`);

    try {
      const blockBlobClient: BlockBlobClient =
        this.containerClient.getBlockBlobClient(blobName);

      const response = await blockBlobClient.download(0);

      if (!response.readableStreamBody) {
        throw new SyncError(
          `No readable stream body returned for blob "${blobName}"`,
        );
      }

      await pipeline(
        response.readableStreamBody,
        createWriteStream(localPath),
      );

      const result: BlobDownloadResult = {
        blobName,
        localPath,
        etag: response.etag ?? '',
        lastModified: response.lastModified ?? new Date(0),
        contentLength: response.contentLength ?? 0,
      };

      this.logger.debug(
        `Streaming downloaded blob "${blobName}" (${result.contentLength} bytes)`,
      );

      return result;
    } catch (error: unknown) {
      // Clean up partial file left by failed streaming download
      try {
        await fs.unlink(localPath);
        this.logger.debug(`Cleaned up partial file "${localPath}" after streaming failure`);
      } catch {
        // File may not exist if the failure happened before writing started
      }

      if (error instanceof AuthenticationError || error instanceof AzureConnectionError || error instanceof SyncError) {
        throw error;
      }
      throw this.translateError(error, `Failed to stream download blob "${blobName}" to "${localPath}"`);
    }
  }

  /**
   * Download a blob's content into memory as a Buffer.
   * Use for small files like .env that need to be parsed before writing.
   *
   * @param blobName - Full blob name in the container.
   * @returns Buffer containing the blob content.
   *
   * @throws AzureConnectionError on network/timeout errors.
   * @throws AuthenticationError on 403 responses.
   */
  async downloadToBuffer(blobName: string): Promise<Buffer> {
    this.logger.debug(`Downloading blob "${blobName}" to buffer`);

    try {
      const blockBlobClient: BlockBlobClient =
        this.containerClient.getBlockBlobClient(blobName);

      const buffer = await blockBlobClient.downloadToBuffer();

      this.logger.debug(
        `Downloaded blob "${blobName}" to buffer (${buffer.length} bytes)`,
      );

      return buffer;
    } catch (error: unknown) {
      throw this.translateError(error, `Failed to download blob "${blobName}" to buffer`);
    }
  }

  /**
   * Translate an SDK or filesystem error into the appropriate library error type.
   * Always sanitizes SAS tokens from error messages.
   */
  private translateError(error: unknown, context: string): Error {
    // Handle Azure RestError
    if (error instanceof RestError) {
      const sanitizedMessage = sanitize(
        `${context}: ${error.message}`,
        this.sasToken,
      );

      if (error.statusCode === 403) {
        this.logger.error(`Authentication failed: ${sanitizedMessage}`);
        return new AuthenticationError(sanitizedMessage);
      }

      if (error.statusCode === 404) {
        this.logger.error(`Blob not found: ${sanitizedMessage}`);
        return new SyncError(sanitizedMessage);
      }

      // All other RestErrors are treated as connection errors
      this.logger.error(`Azure connection error: ${sanitizedMessage}`);
      return new AzureConnectionError(sanitizedMessage, error.statusCode);
    }

    // Handle network-level errors (no RestError, e.g., DNS failure, ETIMEDOUT)
    if (error instanceof Error) {
      const sanitizedMessage = sanitize(
        `${context}: ${error.message}`,
        this.sasToken,
      );
      this.logger.error(`Network error: ${sanitizedMessage}`);
      return new AzureConnectionError(sanitizedMessage);
    }

    // Unknown error type
    const sanitizedMessage = sanitize(
      `${context}: ${String(error)}`,
      this.sasToken,
    );
    this.logger.error(`Unknown error: ${sanitizedMessage}`);
    return new AzureConnectionError(sanitizedMessage);
  }
}
