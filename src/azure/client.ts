import {
  ContainerClient,
  AnonymousCredential,
  RestError,
  BlockBlobClient,
} from '@azure/storage-blob';

import type { BlobClientConfig, BlobInfo } from './types.js';
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
   * Download a blob's content into memory as a Buffer.
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
