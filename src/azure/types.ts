/**
 * Metadata for a single blob returned from listing.
 */
export interface BlobInfo {
  readonly name: string;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentLength: number;
  readonly contentMD5?: string;
  /** Raw blob metadata (key-value pairs from Azure Blob Storage). */
  readonly metadata?: Readonly<Record<string, string>>;
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
