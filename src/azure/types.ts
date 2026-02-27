/**
 * Metadata for a single blob returned from listing.
 */
export interface BlobInfo {
  /** Full blob name including virtual directory path. Example: "config/prod/settings.json" */
  readonly name: string;

  /** HTTP ETag for the blob. Used for incremental sync. Example: "0x8D..."  */
  readonly etag: string;

  /** Last modification timestamp of the blob. */
  readonly lastModified: Date;

  /** Content length in bytes. */
  readonly contentLength: number;

  /** Content MD5 hash if available from Azure. */
  readonly contentMD5: string | undefined;
}

/**
 * Options for the Azure blob client constructor.
 */
export interface BlobClientConfig {
  /** Full account URL. Example: "https://myaccount.blob.core.windows.net" */
  readonly accountUrl: string;

  /** Container name. */
  readonly containerName: string;

  /** SAS token string (without leading '?'). */
  readonly sasToken: string;

  /** Maximum retry count for SDK operations. Default: 3. */
  readonly maxRetries: number;

  /** Per-operation timeout in milliseconds. Default: 30000. */
  readonly timeout: number;
}

/**
 * Result of a single blob download operation.
 */
export interface BlobDownloadResult {
  /** Blob name that was downloaded. */
  readonly blobName: string;

  /** Local file path where the blob was written. */
  readonly localPath: string;

  /** ETag of the downloaded blob. */
  readonly etag: string;

  /** Last modified timestamp of the downloaded blob. */
  readonly lastModified: Date;

  /** Content length in bytes. */
  readonly contentLength: number;
}
