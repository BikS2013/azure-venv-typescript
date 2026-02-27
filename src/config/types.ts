/**
 * Parsed components of the AZURE_VENV URL.
 *
 * Given: https://myaccount.blob.core.windows.net/mycontainer/config/prod
 * Result:
 *   accountUrl: "https://myaccount.blob.core.windows.net"
 *   containerName: "mycontainer"
 *   prefix: "config/prod/"
 */
export interface ParsedBlobUrl {
  /** Full account URL including protocol and host. Example: "https://myaccount.blob.core.windows.net" */
  readonly accountUrl: string;

  /** Container name extracted from the URL path. Example: "mycontainer" */
  readonly containerName: string;

  /** Virtual directory prefix with trailing slash, or empty string for container root. Example: "config/prod/" */
  readonly prefix: string;
}

/**
 * Log level enumeration. Levels are ordered from most verbose (debug) to least verbose (error).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Sync mode determining whether to use the manifest for incremental sync or force full re-download.
 */
export type SyncMode = 'full' | 'incremental';

/**
 * Full validated configuration object produced by the config validator.
 * All required fields are guaranteed to be present and valid.
 * All optional fields have been resolved to their default values.
 */
export interface AzureVenvConfig {
  /** Parsed blob URL components */
  readonly blobUrl: ParsedBlobUrl;

  /** SAS token string (without leading '?'). Never log this value directly. */
  readonly sasToken: string;

  /** ISO 8601 expiry date of the SAS token, if determinable. Parsed from AZURE_VENV_SAS_EXPIRY or the token's 'se' parameter. */
  readonly sasExpiry: Date | null;

  /** Sync mode: 'full' re-downloads everything; 'incremental' uses ETag manifest. Default: 'full'. */
  readonly syncMode: SyncMode;

  /** If true, any Azure error throws and prevents application startup. If false, errors are logged and app continues. Default: false. */
  readonly failOnError: boolean;

  /** Maximum number of parallel blob downloads. Default: 5. */
  readonly concurrency: number;

  /** Per-blob download timeout in milliseconds. Default: 30000. */
  readonly timeout: number;

  /** Logging verbosity. Default: 'info'. */
  readonly logLevel: LogLevel;

  /** Application root directory. Files are synced here. Default: process.cwd(). */
  readonly rootDir: string;

  /** Path to local .env file, relative to rootDir. Default: '.env'. */
  readonly envPath: string;

  /** Maximum blob size in bytes before switching to streaming download. Default: 104857600 (100MB). */
  readonly maxBlobSize: number;

  /** Polling interval in milliseconds for watch mode. Default: 30000 (30s). */
  readonly pollInterval: number;

  /** Whether watch mode is enabled after initial sync. Default: false. */
  readonly watchEnabled: boolean;
}

/**
 * User-provided partial options for initAzureVenv().
 * All fields are optional. Required config (AZURE_VENV, AZURE_VENV_SAS_TOKEN)
 * is read from process.env, not from this object.
 */
export interface AzureVenvOptions {
  /** Application root directory. Default: process.cwd() */
  rootDir?: string;

  /** Path to local .env file relative to rootDir. Default: '.env' */
  envPath?: string;

  /** Override sync mode. Default: reads AZURE_VENV_SYNC_MODE or 'full' */
  syncMode?: SyncMode;

  /** Override fail-on-error behavior. Default: reads AZURE_VENV_FAIL_ON_ERROR or false */
  failOnError?: boolean;

  /** Override concurrency limit. Default: reads AZURE_VENV_CONCURRENCY or 5 */
  concurrency?: number;

  /** Override per-blob timeout in ms. Default: reads AZURE_VENV_TIMEOUT or 30000 */
  timeout?: number;

  /** Override log level. Default: reads AZURE_VENV_LOG_LEVEL or 'info' */
  logLevel?: LogLevel;

  /** Override max blob size for streaming threshold in bytes. Default: reads AZURE_VENV_MAX_BLOB_SIZE or 104857600 */
  maxBlobSize?: number;

  /** Override polling interval in ms for watch mode. Default: reads AZURE_VENV_POLL_INTERVAL or 30000 */
  pollInterval?: number;

  /** Override watch mode enabled flag. Default: reads AZURE_VENV_WATCH_ENABLED or false */
  watchEnabled?: boolean;
}

/**
 * Raw environment variable values before Zod validation.
 * Used internally by the validator.
 */
export interface RawEnvConfig {
  AZURE_VENV?: string;
  AZURE_VENV_SAS_TOKEN?: string;
  AZURE_VENV_SAS_EXPIRY?: string;
  AZURE_VENV_SYNC_MODE?: string;
  AZURE_VENV_FAIL_ON_ERROR?: string;
  AZURE_VENV_CONCURRENCY?: string;
  AZURE_VENV_TIMEOUT?: string;
  AZURE_VENV_LOG_LEVEL?: string;
  AZURE_VENV_MAX_BLOB_SIZE?: string;
  AZURE_VENV_POLL_INTERVAL?: string;
  AZURE_VENV_WATCH_ENABLED?: string;
}
