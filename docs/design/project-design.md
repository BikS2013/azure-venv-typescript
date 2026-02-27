# Technical Design: azure-venv TypeScript Library

**Date:** 2026-02-27
**Status:** Draft
**Version:** 1.0
**Plan Reference:** [plan-001-azure-venv-library.md](plan-001-azure-venv-library.md)
**Requirements Reference:** [project-functions.md](project-functions.md)
**Research Reference:** [../reference/investigation-azure-venv-library.md](../reference/investigation-azure-venv-library.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Module Structure and File Layout](#2-module-structure-and-file-layout)
3. [TypeScript Interfaces and Types](#3-typescript-interfaces-and-types)
4. [Error Class Hierarchy](#4-error-class-hierarchy)
5. [Public API Contract](#5-public-api-contract)
6. [Initialization Flow](#6-initialization-flow)
7. [Module Interface Contracts](#7-module-interface-contracts)
8. [Security Measures](#8-security-measures)
9. [Cross-Module Dependency Map](#9-cross-module-dependency-map)
10. [Implementation Notes for Parallel Agents](#10-implementation-notes-for-parallel-agents)

---

## 1. Overview

The `azure-venv` library is a TypeScript package that, on application startup, synchronizes files and environment variables from Azure Blob Storage to the local application root. It implements a three-tier environment variable precedence model (OS env > remote .env > local .env) and provides ETag-based incremental synchronization.

**Key Design Principles:**

- Required configuration (`AZURE_VENV`, `AZURE_VENV_SAS_TOKEN`) throws exceptions if missing -- no fallbacks, no defaults.
- Operational parameters (concurrency, retries, logLevel) have sensible defaults when not explicitly provided.
- TypeScript strict mode throughout; no `any` in public API surfaces.
- SAS tokens are never exposed in logs, error messages, or stack traces.
- All file paths use `path.join()` / `path.resolve()` for cross-platform compatibility.

---

## 2. Module Structure and File Layout

```
azure-venv/
  src/
    index.ts                    # Public API exports
    initialize.ts               # Main orchestrator (initAzureVenv implementation)
    config/
      parser.ts                 # AZURE_VENV URL parser
      validator.ts              # Config validation (Zod schemas)
      types.ts                  # Configuration types/interfaces
    azure/
      client.ts                 # Azure Blob Storage client wrapper
      types.ts                  # Azure-related types (BlobInfo, etc.)
    sync/
      engine.ts                 # Sync orchestrator
      downloader.ts             # File download logic with concurrency control
      manifest.ts               # ETag manifest management
      path-validator.ts         # Path traversal prevention
    env/
      loader.ts                 # .env file parser and loader
      precedence.ts             # Three-tier precedence resolver
    errors/
      index.ts                  # Error class exports (barrel)
      base.ts                   # AzureVenvError base class
      config.ts                 # ConfigurationError
      azure.ts                  # AzureConnectionError, AuthenticationError
      sync.ts                   # SyncError, PathTraversalError
    logging/
      logger.ts                 # Logger with SAS sanitization
    types/
      index.ts                  # Shared types (barrel)
  __tests__/
    unit/
      config/
        parser.test.ts
        validator.test.ts
      azure/
        client.test.ts
      sync/
        engine.test.ts
        downloader.test.ts
        manifest.test.ts
        path-validator.test.ts
      env/
        loader.test.ts
        precedence.test.ts
      errors/
        errors.test.ts
      logging/
        logger.test.ts
    integration/
      azure-venv.integration.test.ts
      fixtures/
        sample.env
        nested/
          config.json
  package.json
  tsconfig.json
  vitest.config.ts
  .eslintrc.json
  .gitignore
```

### Module Responsibilities

| Module | Files | Responsibility | Dependencies |
|---|---|---|---|
| **config** | `parser.ts`, `validator.ts`, `types.ts` | Parse AZURE_VENV URL, validate all config via Zod | `errors` |
| **azure** | `client.ts`, `types.ts` | Wrap @azure/storage-blob SDK, list blobs, download blobs | `errors`, `logging` |
| **sync** | `engine.ts`, `downloader.ts`, `manifest.ts`, `path-validator.ts` | Orchestrate file sync, manage ETag manifest, validate paths | `azure`, `errors`, `logging` |
| **env** | `loader.ts`, `precedence.ts` | Parse .env files, apply three-tier precedence to process.env | `errors`, `logging` |
| **errors** | `base.ts`, `config.ts`, `azure.ts`, `sync.ts`, `index.ts` | Custom error hierarchy | None |
| **logging** | `logger.ts` | Structured logging with SAS token sanitization | None |
| **types** | `index.ts` | Shared type re-exports | `config/types`, `azure/types` |

---

## 3. TypeScript Interfaces and Types

### 3.1 Configuration Types (`src/config/types.ts`)

```typescript
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

  /** Path to the sync manifest file, relative to rootDir. Default: '.azure-venv-manifest.json'. */
  readonly manifestPath: string;
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

  /** Path to manifest file relative to rootDir. Default: '.azure-venv-manifest.json' */
  manifestPath?: string;

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
}
```

### 3.2 Azure Types (`src/azure/types.ts`)

```typescript
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
```

### 3.3 Sync Types (`src/sync/engine.ts` and related)

```typescript
/**
 * Result of a complete sync operation. Returned by initAzureVenv().
 */
export interface SyncResult {
  /** Whether Azure sync was attempted. False if AZURE_VENV was not configured. */
  readonly attempted: boolean;

  /** Total number of blobs found in Azure Blob Storage. */
  readonly totalBlobs: number;

  /** Number of blobs successfully downloaded. */
  readonly downloaded: number;

  /** Number of blobs skipped (ETag matched, no change). */
  readonly skipped: number;

  /** Number of blobs that failed to download. */
  readonly failed: number;

  /** Names of blobs that failed to download. */
  readonly failedBlobs: readonly string[];

  /** Total sync duration in milliseconds. */
  readonly duration: number;

  /** Whether a remote .env file was found and loaded. */
  readonly remoteEnvLoaded: boolean;

  /** Map of environment variable names to their source tier. */
  readonly envSources: Readonly<Record<string, EnvSource>>;
}

/**
 * Source tier from which an environment variable was loaded.
 */
export type EnvSource = 'os' | 'remote' | 'local';

/**
 * A no-op SyncResult returned when Azure VENV is not configured.
 */
export const NO_OP_SYNC_RESULT: SyncResult = {
  attempted: false,
  totalBlobs: 0,
  downloaded: 0,
  skipped: 0,
  failed: 0,
  failedBlobs: [],
  duration: 0,
  remoteEnvLoaded: false,
  envSources: {},
} as const;

/**
 * Manifest entry for a single synced blob.
 */
export interface ManifestEntry {
  /** Full blob name in Azure. */
  readonly blobName: string;

  /** ETag at the time of last successful sync. */
  readonly etag: string;

  /** Last modified date at time of last sync (ISO 8601). */
  readonly lastModified: string;

  /** Content length in bytes at time of last sync. */
  readonly contentLength: number;

  /** Local file path where the blob was written (relative to rootDir). */
  readonly localPath: string;

  /** Timestamp when this entry was last synced (ISO 8601). */
  readonly syncedAt: string;
}

/**
 * The full sync manifest stored as .azure-venv-manifest.json.
 */
export interface SyncManifest {
  /** Schema version for forward compatibility. Current: 1. */
  readonly version: number;

  /** Timestamp of the last full sync run (ISO 8601). */
  readonly lastSyncAt: string;

  /** Map of blob names to their manifest entries. */
  readonly entries: Record<string, ManifestEntry>;
}
```

### 3.4 Environment Types (`src/env/loader.ts` and related)

```typescript
/**
 * Parsed key-value pairs from a .env file.
 */
export type EnvRecord = Record<string, string>;

/**
 * Result of loading environment variables with source tracking.
 */
export interface EnvLoadResult {
  /** Merged environment variables (does not include full process.env, only tracked variables). */
  readonly variables: Readonly<EnvRecord>;

  /** Source tier for each variable. */
  readonly sources: Readonly<Record<string, EnvSource>>;

  /** Keys loaded from local .env. */
  readonly localKeys: readonly string[];

  /** Keys loaded from remote .env. */
  readonly remoteKeys: readonly string[];

  /** Keys from OS environment that were preserved (not overridden). */
  readonly osKeys: readonly string[];
}
```

### 3.5 Logger Types (within `src/logging/logger.ts`)

```typescript
/**
 * Logger interface. All modules receive this via dependency injection.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

---

## 4. Error Class Hierarchy

All custom errors extend a single base class. Each error has a `code` property for programmatic handling.

```
Error
  |
  +-- AzureVenvError (base, code: "AZURE_VENV_ERROR")
        |
        +-- ConfigurationError (code: "CONFIGURATION_ERROR")
        |     Thrown when: AZURE_VENV or AZURE_VENV_SAS_TOKEN is missing,
        |     URL is malformed, HTTP scheme used, invalid option values.
        |
        +-- AzureConnectionError (code: "AZURE_CONNECTION_ERROR")
        |     Thrown when: Network unreachable, DNS failure, timeout on Azure calls.
        |
        +-- AuthenticationError (code: "AUTHENTICATION_ERROR")
        |     Thrown when: SAS token expired, 403 from Azure, insufficient permissions.
        |     Property: expiryDate?: Date
        |
        +-- SyncError (code: "SYNC_ERROR")
        |     Thrown when: Filesystem write failure, general sync orchestration failure.
        |
        +-- PathTraversalError (code: "PATH_TRAVERSAL_ERROR")
              Thrown when: Blob name contains '..', absolute path, or resolves
              outside the application root directory.
              Property: blobName: string
```

### 4.1 Error Class Definitions (`src/errors/`)

#### `src/errors/base.ts`

```typescript
/**
 * Base error class for all azure-venv errors.
 * All error messages are sanitized to remove SAS tokens before storage.
 */
export class AzureVenvError extends Error {
  /** Machine-readable error code for programmatic handling. */
  public readonly code: string;

  constructor(message: string, code: string = 'AZURE_VENV_ERROR') {
    super(message);
    this.name = 'AzureVenvError';
    this.code = code;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

#### `src/errors/config.ts`

```typescript
import { AzureVenvError } from './base.js';

/**
 * Thrown when required configuration is missing or invalid.
 *
 * Trigger conditions:
 * - AZURE_VENV is present but AZURE_VENV_SAS_TOKEN is missing (or vice versa)
 * - AZURE_VENV is not a valid HTTPS URL
 * - AZURE_VENV URL does not contain a container name
 * - AZURE_VENV_SYNC_MODE has an invalid value (not 'full' or 'incremental')
 * - AZURE_VENV_CONCURRENCY is not a positive integer
 * - AZURE_VENV_TIMEOUT is not a positive integer
 * - AZURE_VENV_LOG_LEVEL is not a valid log level
 */
export class ConfigurationError extends AzureVenvError {
  /** The configuration parameter name that caused the error. */
  public readonly parameter: string;

  constructor(message: string, parameter: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
    this.parameter = parameter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

#### `src/errors/azure.ts`

```typescript
import { AzureVenvError } from './base.js';

/**
 * Thrown when the Azure Blob Storage service cannot be reached.
 *
 * Trigger conditions:
 * - Network unreachable (REQUEST_SEND_ERROR)
 * - DNS resolution failure
 * - Connection timeout (ETIMEDOUT)
 * - Container not found (404)
 * - Any RestError not related to authentication
 */
export class AzureConnectionError extends AzureVenvError {
  /** HTTP status code from the Azure response, if available. */
  public readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message, 'AZURE_CONNECTION_ERROR');
    this.name = 'AzureConnectionError';
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when SAS token authentication fails.
 *
 * Trigger conditions:
 * - SAS token is expired (403 with AuthenticationFailed)
 * - SAS token has insufficient permissions (403 with AuthorizationFailure)
 * - SAS token is malformed
 * - Proactive expiry check detects the token has expired
 */
export class AuthenticationError extends AzureVenvError {
  /** The expiry date of the SAS token, if it could be parsed. */
  public readonly expiryDate: Date | undefined;

  constructor(message: string, expiryDate?: Date) {
    super(message, 'AUTHENTICATION_ERROR');
    this.name = 'AuthenticationError';
    this.expiryDate = expiryDate;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

#### `src/errors/sync.ts`

```typescript
import { AzureVenvError } from './base.js';

/**
 * Thrown when a filesystem sync operation fails.
 *
 * Trigger conditions:
 * - Cannot create local directory (permission denied, disk full)
 * - Cannot write downloaded file to disk
 * - Manifest file is corrupted and cannot be parsed
 * - General orchestration failure during sync
 */
export class SyncError extends AzureVenvError {
  constructor(message: string) {
    super(message, 'SYNC_ERROR');
    this.name = 'SyncError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a blob name would resolve to a path outside the application root.
 *
 * Trigger conditions:
 * - Blob name contains '..' path segments
 * - Blob name is an absolute path
 * - Blob name contains URL-encoded traversal sequences (%2e%2e)
 * - Resolved path does not start with the root directory
 *
 * The offending blob is skipped (not downloaded). The error is caught by the sync engine
 * and recorded in SyncResult.failedBlobs.
 */
export class PathTraversalError extends AzureVenvError {
  /** The blob name that triggered the path traversal detection. */
  public readonly blobName: string;

  constructor(message: string, blobName: string) {
    super(message, 'PATH_TRAVERSAL_ERROR');
    this.name = 'PathTraversalError';
    this.blobName = blobName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

#### `src/errors/index.ts`

```typescript
export { AzureVenvError } from './base.js';
export { ConfigurationError } from './config.js';
export { AzureConnectionError, AuthenticationError } from './azure.js';
export { SyncError, PathTraversalError } from './sync.js';
```

---

## 5. Public API Contract

### 5.1 Main Entry Point (`src/index.ts`)

```typescript
export { initAzureVenv } from './initialize.js';
export type { AzureVenvOptions, AzureVenvConfig, ParsedBlobUrl, LogLevel, SyncMode } from './config/types.js';
export type { SyncResult, SyncManifest, ManifestEntry, EnvSource } from './types/index.js';
export type { EnvLoadResult, EnvRecord } from './env/loader.js';
export type { BlobInfo, BlobDownloadResult } from './azure/types.js';
export type { Logger } from './logging/logger.js';
export {
  AzureVenvError,
  ConfigurationError,
  AzureConnectionError,
  AuthenticationError,
  SyncError,
  PathTraversalError,
} from './errors/index.js';
```

### 5.2 `initAzureVenv()` Function Signature

```typescript
/**
 * Initialize the azure-venv library. Call this at application startup, before any other
 * imports or initialization that depend on remote files or environment variables.
 *
 * This function:
 * 1. Loads the local .env file (does not override OS env vars)
 * 2. Checks for AZURE_VENV and AZURE_VENV_SAS_TOKEN in process.env
 * 3. If both are present, connects to Azure Blob Storage
 * 4. Downloads a remote .env (if it exists) and applies it with three-tier precedence
 * 5. Syncs all remaining blob files to the local application root
 * 6. Returns a SyncResult with statistics
 *
 * If AZURE_VENV and AZURE_VENV_SAS_TOKEN are both absent after local .env loading,
 * the function returns a no-op SyncResult (azure-venv is not configured).
 *
 * If only one of AZURE_VENV / AZURE_VENV_SAS_TOKEN is present, a ConfigurationError is thrown.
 *
 * @param options - Optional configuration overrides. Required config is always from process.env.
 * @returns Promise resolving to SyncResult with sync statistics.
 * @throws ConfigurationError if required config is partially present or invalid
 * @throws AuthenticationError if SAS token is expired or authentication fails (when failOnError: true)
 * @throws AzureConnectionError if Azure is unreachable (when failOnError: true)
 * @throws SyncError if filesystem operations fail critically
 *
 * @example
 * ```typescript
 * import { initAzureVenv } from 'azure-venv';
 *
 * // Minimal usage -- reads all config from .env and process.env
 * const result = await initAzureVenv();
 * console.log(`Synced ${result.downloaded} files in ${result.duration}ms`);
 *
 * // With options
 * const result = await initAzureVenv({
 *   rootDir: '/app',
 *   concurrency: 10,
 *   syncMode: 'incremental',
 *   failOnError: true,
 * });
 * ```
 */
export async function initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult>;
```

### 5.3 Behavior Summary

| Scenario | Behavior |
|---|---|
| Neither AZURE_VENV nor AZURE_VENV_SAS_TOKEN set | Return `NO_OP_SYNC_RESULT` (not an error) |
| AZURE_VENV set but AZURE_VENV_SAS_TOKEN missing | Throw `ConfigurationError` |
| AZURE_VENV_SAS_TOKEN set but AZURE_VENV missing | Throw `ConfigurationError` |
| Both set, token expired | Throw `AuthenticationError` |
| Both set, Azure unreachable, `failOnError: true` | Throw `AzureConnectionError` |
| Both set, Azure unreachable, `failOnError: false` | Log warning, return partial `SyncResult` |
| Both set, sync succeeds | Return `SyncResult` with statistics |
| Individual blob download fails | Record in `SyncResult.failedBlobs`, continue sync |
| Path traversal detected in blob name | Skip blob, record in `SyncResult.failedBlobs`, log error |

---

## 6. Initialization Flow

The following describes the exact execution sequence when `initAzureVenv()` is called. Each step references the module responsible.

```
initAzureVenv(options?)
  |
  |-- STEP 1: Load local .env [env/loader.ts]
  |     - Read local .env file from options.envPath (default: '<rootDir>/.env')
  |     - Parse key-value pairs using dotenv.parse()
  |     - Apply to process.env WITHOUT overriding existing values
  |     - If file not found: proceed silently (not an error)
  |     - Record: snapshot of OS env keys BEFORE local .env load
  |     - Record: which keys came from local .env
  |
  |-- STEP 2: Check AZURE_VENV presence [config/validator.ts]
  |     - Read process.env.AZURE_VENV and process.env.AZURE_VENV_SAS_TOKEN
  |     - If BOTH are absent/empty: return NO_OP_SYNC_RESULT (early exit, not an error)
  |     - If only ONE is present: throw ConfigurationError
  |     - If BOTH are present: continue
  |
  |-- STEP 3: Validate and parse configuration [config/validator.ts, config/parser.ts]
  |     - Validate AZURE_VENV via Zod schema:
  |         - Must be valid URL
  |         - Must use HTTPS scheme
  |         - Must contain at least a container name in path
  |     - Parse AZURE_VENV into ParsedBlobUrl { accountUrl, containerName, prefix }
  |     - Validate AZURE_VENV_SAS_TOKEN is non-empty
  |     - Parse optional params (AZURE_VENV_SYNC_MODE, AZURE_VENV_CONCURRENCY, etc.)
  |     - Merge with options overrides (options take priority over env vars for operational params)
  |     - Produce final AzureVenvConfig object
  |
  |-- STEP 4: Check SAS token expiry [config/validator.ts]
  |     - Parse 'se' parameter from SAS token
  |     - Also check AZURE_VENV_SAS_EXPIRY if set
  |     - If expired: throw AuthenticationError
  |     - If expires within 7 days: log warning
  |
  |-- STEP 5: Create Azure Blob client [azure/client.ts]
  |     - Construct ContainerClient with accountUrl + containerName + sasToken
  |     - Configure retry policy (maxRetries from config)
  |     - Configure timeout
  |
  |-- STEP 6: List all blobs [azure/client.ts]
  |     - Call listBlobsFlat() with prefix from ParsedBlobUrl
  |     - Collect all BlobInfo objects
  |     - Separate the .env blob (if present at prefix root) from other blobs
  |
  |-- STEP 7: Download and load remote .env (if exists) [sync/engine.ts, env/precedence.ts]
  |     - If .env blob found at prefix root:
  |         a. Download to buffer via downloadToBuffer() [azure/client.ts]
  |         b. Parse key-value pairs using dotenv.parse() [env/loader.ts]
  |         c. Apply three-tier precedence [env/precedence.ts]:
  |            - For each key in remote .env:
  |              - If key was in OS env snapshot (from Step 1): SKIP (OS wins)
  |              - Otherwise: set process.env[key] = remote value (overrides local .env)
  |         d. Record: which keys came from remote .env
  |         e. Log: "Loaded N variables from remote .env"
  |
  |-- STEP 8: Sync remaining files [sync/engine.ts, sync/downloader.ts]
  |     - Load manifest from disk (if exists) [sync/manifest.ts]
  |     - For each blob (excluding .env):
  |         a. Strip prefix from blob name to get relative path
  |         b. Validate path (no traversal) [sync/path-validator.ts]
  |         c. If syncMode == 'incremental' and manifest has matching ETag: SKIP
  |         d. Otherwise: queue for download
  |     - Download queued blobs with concurrency limit [sync/downloader.ts]:
  |         a. Create parent directories (fs.mkdir recursive)
  |         b. Download to file via downloadToFile() [azure/client.ts]
  |         c. On success: update manifest entry [sync/manifest.ts]
  |         d. On failure: record in failed list, log error, continue
  |     - Write updated manifest to disk [sync/manifest.ts]
  |
  |-- STEP 9: Build and return SyncResult [initialize.ts]
  |     - Aggregate statistics: totalBlobs, downloaded, skipped, failed, failedBlobs, duration
  |     - Include env source tracking from Step 1 and Step 7
  |     - Return SyncResult
  |
  |-- ERROR HANDLING (wraps Steps 5-8):
        - If failOnError == true: re-throw any AzureConnectionError or AuthenticationError
        - If failOnError == false: catch Azure/sync errors, log warning, return partial SyncResult
```

### 6.1 Sequence Diagram

```
Host App             initialize.ts        env/loader       config/validator     azure/client       sync/engine
   |                      |                   |                  |                    |                  |
   |--initAzureVenv()---->|                   |                  |                    |                  |
   |                      |--loadLocalEnv()-->|                  |                    |                  |
   |                      |<--EnvRecord-------|                  |                    |                  |
   |                      |                   |                  |                    |                  |
   |                      |--validateConfig()-------------------->|                    |                  |
   |                      |<--AzureVenvConfig--------------------|                    |                  |
   |                      |                   |                  |                    |                  |
   |                      |--createClient()------------------------------------------------>|                  |
   |                      |<--BlobClient-------------------------------------------------------|                  |
   |                      |                   |                  |                    |                  |
   |                      |--syncRemoteEnv()------------------------------------------------------------------>|
   |                      |                   |                  |                    |<--listBlobs()----|
   |                      |                   |                  |                    |--BlobInfo[]----->|
   |                      |                   |                  |                    |<--download()-----|
   |                      |                   |                  |                    |--Buffer--------->|
   |                      |<--remoteEnvContent-----------------------------------------------------------------|
   |                      |                   |                  |                    |                  |
   |                      |--applyPrecedence()>|                  |                    |                  |
   |                      |<--EnvLoadResult----|                  |                    |                  |
   |                      |                   |                  |                    |                  |
   |                      |--syncFiles()------------------------------------------------------------------>|
   |                      |                   |                  |                    |                  |
   |                      |                   |                  |          [for each blob: validate path,  |
   |                      |                   |                  |           check manifest, download,      |
   |                      |                   |                  |           update manifest]                |
   |                      |                   |                  |                    |                  |
   |                      |<--SyncResult-----------------------------------------------------------------------|
   |                      |                   |                  |                    |                  |
   |<--SyncResult---------|                   |                  |                    |                  |
```

---

## 7. Module Interface Contracts

Each subsection below defines the exact interface that a module must implement. Agents implementing a module must conform to these contracts. Internal implementation details are flexible as long as the contract is satisfied.

### 7.1 Config Parser (`src/config/parser.ts`)

```typescript
import { ParsedBlobUrl } from './types.js';

/**
 * Parse an AZURE_VENV URL string into its component parts.
 *
 * @param azureVenvUrl - The AZURE_VENV environment variable value.
 *   Format: https://<account>.blob.core.windows.net/<container>[/<prefix>]
 *
 * @returns ParsedBlobUrl with accountUrl, containerName, and prefix.
 *
 * @throws ConfigurationError with parameter='AZURE_VENV' if:
 *   - URL is not a valid URL (cannot be parsed by new URL())
 *   - URL scheme is not 'https:'
 *   - URL path does not contain at least one segment (container name)
 *
 * Contract:
 *   - accountUrl is always "https://<host>" with no trailing slash
 *   - containerName is always the first path segment
 *   - prefix is always empty string OR a path ending with '/'
 *   - prefix never starts with '/'
 */
export function parseBlobUrl(azureVenvUrl: string): ParsedBlobUrl;
```

### 7.2 Config Validator (`src/config/validator.ts`)

```typescript
import { AzureVenvConfig, AzureVenvOptions, RawEnvConfig } from './types.js';

/**
 * Describes whether AZURE_VENV is configured, and if so, the validated config.
 */
export type ConfigCheckResult =
  | { configured: false }
  | { configured: true; config: AzureVenvConfig };

/**
 * Check process.env for AZURE_VENV configuration and validate if present.
 *
 * @param options - User-provided options overrides (optional fields only).
 *
 * @returns ConfigCheckResult:
 *   - { configured: false } if neither AZURE_VENV nor AZURE_VENV_SAS_TOKEN is set
 *   - { configured: true, config: AzureVenvConfig } if both are set and valid
 *
 * @throws ConfigurationError if:
 *   - Only one of AZURE_VENV / AZURE_VENV_SAS_TOKEN is set (partial config)
 *   - AZURE_VENV fails URL validation (delegates to parseBlobUrl)
 *   - AZURE_VENV_SAS_TOKEN is empty string
 *   - Any optional parameter has an invalid value (e.g., AZURE_VENV_CONCURRENCY="abc")
 *
 * @throws AuthenticationError if:
 *   - SAS token is detected as expired (via 'se' param or AZURE_VENV_SAS_EXPIRY)
 *
 * Contract:
 *   - Reads raw values from process.env
 *   - Merges with options (options override env vars for operational params)
 *   - Validates all values via Zod schema
 *   - Returns a fully resolved AzureVenvConfig with all fields populated
 *   - Operational defaults applied: syncMode='full', failOnError=false,
 *     concurrency=5, timeout=30000, logLevel='info'
 *   - Logs warning if SAS token expires within 7 days
 */
export function validateConfig(options?: AzureVenvOptions): ConfigCheckResult;
```

### 7.3 Azure Blob Client (`src/azure/client.ts`)

```typescript
import { BlobClientConfig, BlobInfo, BlobDownloadResult } from './types.js';
import { Logger } from '../logging/logger.js';

/**
 * Wrapper around @azure/storage-blob SDK providing the operations needed by azure-venv.
 *
 * All methods sanitize SAS tokens from error messages before propagation.
 * The constructor does NOT validate the connection -- validation happens on first operation.
 */
export class AzureVenvBlobClient {
  /**
   * @param config - Connection configuration.
   * @param logger - Logger instance for diagnostic output.
   */
  constructor(config: BlobClientConfig, logger: Logger);

  /**
   * List all blobs under the given prefix using flat listing.
   *
   * @param prefix - Virtual directory prefix (with trailing '/' or empty for container root).
   * @returns Promise resolving to array of BlobInfo for all blobs under the prefix.
   *
   * @throws AzureConnectionError on network/timeout errors.
   * @throws AuthenticationError on 403 responses.
   *
   * Contract:
   *   - Collects all blobs into an array (suitable for moderate blob counts)
   *   - Handles pagination internally (SDK's listBlobsFlat returns async iterable)
   *   - Blob names in BlobInfo are the FULL blob names (including prefix)
   *   - Does not filter out any blob names (including .env)
   *   - Logs total count at debug level
   *
   * Note: Array-based approach chosen over AsyncGenerator for simplicity.
   * For containers with millions of blobs, this could be refactored to AsyncGenerator.
   */
  async listBlobs(prefix: string): Promise<BlobInfo[]>;

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
   *
   * Contract:
   *   - The caller is responsible for creating parent directories.
   *   - Uses BlobClient.downloadToFile() from the SDK.
   *   - Does NOT create parent directories (caller's responsibility).
   *   - Translates RestError into library error types.
   */
  async downloadToFile(blobName: string, localPath: string): Promise<BlobDownloadResult>;

  /**
   * Download a blob's content into memory as a Buffer.
   * Use for small files like .env that need to be parsed before writing.
   *
   * @param blobName - Full blob name in the container.
   * @returns Buffer containing the blob content.
   *
   * @throws AzureConnectionError on network/timeout errors.
   * @throws AuthenticationError on 403 responses.
   *
   * Contract:
   *   - Uses BlobClient.downloadToBuffer() from the SDK.
   *   - Intended for small files only (< 1MB). No size guard enforced.
   *   - Translates RestError into library error types.
   */
  async downloadToBuffer(blobName: string): Promise<Buffer>;
}
```

### 7.4 Sync Engine (`src/sync/engine.ts`)

```typescript
import { AzureVenvBlobClient } from '../azure/client.js';
import { AzureVenvConfig } from '../config/types.js';
import { SyncResult, SyncManifest } from './types.js'; // types defined locally or in types/index.ts
import { Logger } from '../logging/logger.js';

/**
 * Internal result from the remote .env detection step.
 */
export interface RemoteEnvResult {
  /** Whether a remote .env was found. */
  found: boolean;
  /** Parsed content of the remote .env (key-value pairs). Empty if not found. */
  content: Record<string, string>;
}

/**
 * Orchestrates the file synchronization process.
 */
export class SyncEngine {
  /**
   * @param client - Azure Blob client for listing and downloading.
   * @param config - Validated configuration.
   * @param logger - Logger instance.
   */
  constructor(client: AzureVenvBlobClient, config: AzureVenvConfig, logger: Logger);

  /**
   * Check for a .env file at the blob prefix root, download it if present,
   * and return its parsed content.
   *
   * This is called BEFORE syncFiles() so that remote env vars are available
   * during the rest of the initialization.
   *
   * @returns RemoteEnvResult with parsed .env content.
   *
   * Contract:
   *   - The .env blob name is: config.blobUrl.prefix + '.env'
   *     (or just '.env' if prefix is empty)
   *   - Downloads to buffer (not disk) using client.downloadToBuffer()
   *   - Parses using dotenv.parse()
   *   - Does NOT apply to process.env (that is the caller's responsibility)
   *   - On download error: returns { found: false, content: {} } and logs warning
   */
  async fetchRemoteEnv(): Promise<RemoteEnvResult>;

  /**
   * Synchronize all blobs (except .env) from Azure to the local filesystem.
   *
   * @returns SyncResult with statistics (totalBlobs, downloaded, skipped, failed, etc.)
   *
   * Contract:
   *   - Lists all blobs under the configured prefix
   *   - Excludes the .env file (already handled by fetchRemoteEnv)
   *   - For each blob:
   *     a. Strip prefix to get relative path
   *     b. Validate path via PathValidator (throws PathTraversalError on violation)
   *     c. If syncMode=='incremental', check manifest for matching ETag -> skip if match
   *     d. Create parent directories (fs.mkdir with recursive:true)
   *     e. Download to file
   *     f. Update manifest entry on success
   *   - Uses concurrency control (max parallel downloads = config.concurrency)
   *   - Individual failures do not abort the sync
   *   - Writes updated manifest to disk after all downloads complete
   *   - Returns aggregated SyncResult
   */
  async syncFiles(): Promise<SyncResult>;
}
```

### 7.5 Downloader (`src/sync/downloader.ts`)

```typescript
import { AzureVenvBlobClient } from '../azure/client.js';
import { BlobInfo } from '../azure/types.js';
import { Logger } from '../logging/logger.js';

/**
 * Result of a single download attempt.
 */
export interface DownloadAttemptResult {
  readonly blobName: string;
  readonly success: boolean;
  readonly localPath: string;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentLength: number;
  readonly error?: Error;
}

/**
 * Downloads blobs to local files with concurrency control.
 */
export class BlobDownloader {
  /**
   * @param client - Azure Blob client.
   * @param rootDir - Application root directory.
   * @param concurrency - Maximum parallel downloads.
   * @param logger - Logger instance.
   */
  constructor(
    client: AzureVenvBlobClient,
    rootDir: string,
    concurrency: number,
    logger: Logger
  );

  /**
   * Download a batch of blobs to local files with concurrency control.
   *
   * @param blobs - Array of BlobInfo objects to download.
   * @param localPathMap - Map from blob name to absolute local file path.
   * @returns Array of DownloadAttemptResult (one per blob, in any order).
   *
   * Contract:
   *   - Creates parent directories for each local path before download
   *   - Downloads at most `concurrency` blobs in parallel
   *   - Uses Promise.allSettled internally -- never short-circuits on failure
   *   - Each blob is attempted once (retries are handled by the SDK's built-in retry policy)
   *   - Logs each download at info level (blob name, size)
   *   - Logs failures at error level
   */
  async downloadBatch(
    blobs: readonly BlobInfo[],
    localPathMap: ReadonlyMap<string, string>
  ): Promise<DownloadAttemptResult[]>;
}
```

### 7.6 Manifest Manager (`src/sync/manifest.ts`)

```typescript
import { SyncManifest, ManifestEntry } from './types.js';
import { Logger } from '../logging/logger.js';

/**
 * Manages the .azure-venv-manifest.json file for incremental sync tracking.
 */
export class ManifestManager {
  /**
   * @param manifestPath - Absolute path to the manifest file.
   * @param logger - Logger instance.
   */
  constructor(manifestPath: string, logger: Logger);

  /**
   * Load the manifest from disk.
   *
   * @returns The loaded SyncManifest, or a fresh empty manifest if the file does not exist
   *          or is corrupted.
   *
   * Contract:
   *   - If file does not exist: return empty manifest (version: 1, no entries)
   *   - If file exists but is not valid JSON or wrong schema: log warning, return empty manifest
   *   - Never throws
   */
  async load(): Promise<SyncManifest>;

  /**
   * Save the manifest to disk.
   *
   * @param manifest - The manifest to persist.
   *
   * Contract:
   *   - Writes atomically (write to temp file, then rename) to prevent corruption
   *   - Updates lastSyncAt to current timestamp
   *   - Throws SyncError if write fails
   */
  async save(manifest: SyncManifest): Promise<void>;

  /**
   * Check if a blob needs to be downloaded based on its ETag.
   *
   * @param manifest - Current manifest state.
   * @param blobName - The blob name to check.
   * @param remoteEtag - The current ETag from Azure.
   * @returns true if the blob needs downloading (new or changed), false if unchanged.
   *
   * Contract:
   *   - Returns true if blobName is not in the manifest
   *   - Returns true if the stored ETag differs from remoteEtag
   *   - Returns false if ETags match
   */
  needsUpdate(manifest: SyncManifest, blobName: string, remoteEtag: string): boolean;

  /**
   * Create a manifest entry for a successfully synced blob.
   *
   * @param blobName - The blob name.
   * @param etag - The ETag of the downloaded blob.
   * @param lastModified - The lastModified date of the blob.
   * @param contentLength - The content length.
   * @param localPath - The relative local path (relative to rootDir).
   * @returns A new ManifestEntry.
   */
  createEntry(
    blobName: string,
    etag: string,
    lastModified: Date,
    contentLength: number,
    localPath: string
  ): ManifestEntry;
}
```

### 7.7 Path Validator (`src/sync/path-validator.ts`)

```typescript
/**
 * Validate and resolve a blob name to a safe local file path.
 *
 * Two-layer defense:
 * Layer 1: Reject blob names containing '..' segments or absolute paths.
 * Layer 2: After path.resolve(), verify the result is within rootDir.
 *
 * @param rootDir - Absolute path to the application root directory.
 * @param relativePath - The relative path derived from blob name (prefix already stripped).
 * @returns Absolute local file path that is guaranteed to be under rootDir.
 *
 * @throws PathTraversalError if:
 *   - relativePath contains '..' (literal or URL-encoded %2e%2e)
 *   - relativePath is an absolute path (starts with / or C:\)
 *   - The resolved path does not start with rootDir + path.sep
 *   - relativePath is empty or contains only whitespace
 *
 * Contract:
 *   - The returned path is always absolute
 *   - The returned path always starts with rootDir (with proper separator)
 *   - URL-decoded names are checked (decodeURIComponent applied first)
 *   - Works correctly on Windows (backslash) and Unix (forward slash)
 *   - This is a pure function (no side effects, no filesystem access)
 */
export function validateAndResolvePath(rootDir: string, relativePath: string): string;

/**
 * Strip a prefix from a blob name to produce a relative local path.
 *
 * @param blobName - Full blob name including prefix. Example: "config/prod/settings.json"
 * @param prefix - The prefix to strip. Example: "config/prod/"
 * @returns Relative path with prefix removed. Example: "settings.json"
 *
 * @throws PathTraversalError if:
 *   - The resulting relative path is empty after stripping
 *   - The blob name does not start with the prefix (should not happen if listing was correct)
 *
 * Contract:
 *   - If prefix is empty, returns blobName unchanged
 *   - The returned path never starts with '/'
 *   - The returned path never ends with '/' (blob names represent files, not directories)
 */
export function stripPrefix(blobName: string, prefix: string): string;
```

### 7.8 Environment Loader (`src/env/loader.ts`)

```typescript
import { EnvRecord } from './types.js';
import { Logger } from '../logging/logger.js';

/**
 * Load and parse a local .env file.
 *
 * @param envFilePath - Absolute path to the .env file.
 * @param logger - Logger instance.
 * @returns Parsed key-value pairs. Empty record if file does not exist.
 *
 * Contract:
 *   - Uses dotenv.parse() on the file contents (reads file manually, does NOT call dotenv.config())
 *   - If file does not exist: returns {} without error
 *   - If file exists but is empty: returns {}
 *   - Does NOT modify process.env (caller is responsible)
 *   - Malformed lines are ignored (dotenv behavior)
 *   - Logs file load at debug level
 */
export function parseEnvFile(envFilePath: string, logger: Logger): Promise<EnvRecord>;

/**
 * Parse .env content from a Buffer (for remote .env files).
 *
 * @param content - Buffer containing .env file content.
 * @returns Parsed key-value pairs.
 *
 * Contract:
 *   - Uses dotenv.parse() on the buffer
 *   - Does NOT modify process.env
 *   - Returns empty record if buffer is empty
 */
export function parseEnvBuffer(content: Buffer): EnvRecord;
```

### 7.9 Environment Precedence Resolver (`src/env/precedence.ts`)

```typescript
import { EnvRecord, EnvLoadResult, EnvSource } from './types.js';
import { Logger } from '../logging/logger.js';

/**
 * Apply the three-tier environment variable precedence model to process.env.
 *
 * Precedence (highest to lowest):
 *   1. OS environment variables (already in process.env before library init)
 *   2. Remote .env from Azure Blob Storage
 *   3. Local .env file
 *
 * @param osEnvSnapshot - Snapshot of process.env keys taken BEFORE any .env loading.
 *   These keys represent genuine OS-level environment variables.
 * @param localEnv - Parsed key-value pairs from local .env file.
 * @param remoteEnv - Parsed key-value pairs from remote .env file. Empty record if no remote .env.
 * @param logger - Logger instance.
 * @returns EnvLoadResult with the merged variables, source tracking, and per-tier key lists.
 *
 * Contract:
 *   - MUTATES process.env (this is the intended side effect)
 *   - For each key in localEnv:
 *     - If key is in osEnvSnapshot: do NOT override (OS wins)
 *     - Otherwise: set process.env[key] = localEnv[key], record source='local'
 *   - For each key in remoteEnv:
 *     - If key is in osEnvSnapshot: do NOT override (OS wins)
 *     - Otherwise: set process.env[key] = remoteEnv[key], record source='remote'
 *       (this overrides any local .env value for the same key)
 *   - Return EnvLoadResult with complete source tracking
 *   - Log summary at info level: "Applied N local vars, M remote vars, K OS-preserved vars"
 *   - Log each variable source at debug level (key name only, never values)
 */
export function applyPrecedence(
  osEnvSnapshot: ReadonlySet<string>,
  localEnv: Readonly<EnvRecord>,
  remoteEnv: Readonly<EnvRecord>,
  logger: Logger
): EnvLoadResult;
```

### 7.10 Logger (`src/logging/logger.ts`)

```typescript
import { LogLevel } from '../config/types.js';

/**
 * Logger interface used by all modules.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Create a Logger instance with SAS token sanitization.
 *
 * @param level - Minimum log level to emit. Messages below this level are suppressed.
 * @param sasToken - The SAS token string to sanitize from all output. Can be empty string
 *   if SAS token is not yet known (e.g., during bootstrap before config is validated).
 * @returns Logger instance.
 *
 * Contract:
 *   - All log output is formatted as: [azure-venv] [LEVEL] [ISO-timestamp] message
 *   - Before emitting ANY log line, the sanitizer replaces:
 *     a. The exact sasToken string with '[REDACTED]'
 *     b. Any URL query parameter named 'sig' with 'sig=[REDACTED]'
 *     c. Any URL query parameter named 'se' with 'se=[REDACTED]'
 *     d. Any string matching the pattern 'sig=...' up to the next '&' or end of string
 *   - Level ordering: debug < info < warn < error
 *   - Output goes to console.log (debug, info) and console.error (warn, error)
 *   - The ...args are JSON.stringified and appended to the message (also sanitized)
 */
export function createLogger(level: LogLevel, sasToken: string): Logger;

/**
 * Sanitize a string by removing SAS token signatures and sensitive URL parameters.
 *
 * @param input - The string to sanitize.
 * @param sasToken - The full SAS token to redact.
 * @returns Sanitized string with sensitive values replaced by '[REDACTED]'.
 *
 * Contract:
 *   - If sasToken is empty string, only regex-based sanitization is applied
 *   - Replaces exact sasToken substring with '[REDACTED]'
 *   - Replaces sig=<value> patterns with sig=[REDACTED]
 *   - Returns the input unchanged if no sensitive patterns are found
 *   - This is a pure function
 */
export function sanitize(input: string, sasToken: string): string;
```

### 7.11 Main Orchestrator (`src/initialize.ts`)

```typescript
import { AzureVenvOptions } from './config/types.js';
import { SyncResult, NO_OP_SYNC_RESULT } from './types/index.js';

/**
 * Main orchestrator function. See Section 5.2 for the full public API contract.
 *
 * Internal contract (for implementation agent):
 *
 * 1. Capture osEnvSnapshot = new Set(Object.keys(process.env)) FIRST
 * 2. Resolve rootDir from options or default to process.cwd()
 * 3. Create a bootstrap logger with level 'info' and empty sasToken
 *    (we don't have the SAS token yet)
 * 4. Call parseEnvFile() to load local .env -> localEnv record
 * 5. Apply localEnv to process.env (only keys NOT in osEnvSnapshot)
 * 6. Call validateConfig(options)
 *    - If { configured: false } -> return NO_OP_SYNC_RESULT
 *    - If { configured: true, config } -> continue
 * 7. Re-create logger with config.logLevel and config.sasToken for proper sanitization
 * 8. Create AzureVenvBlobClient with config
 * 9. Create SyncEngine with client, config, logger
 * 10. try {
 *       const remoteEnvResult = await syncEngine.fetchRemoteEnv()
 *       if (remoteEnvResult.found) {
 *         applyPrecedence(osEnvSnapshot, localEnv, remoteEnvResult.content, logger)
 *       }
 *       const syncResult = await syncEngine.syncFiles()
 *       // Augment syncResult with env source data
 *       return enrichedSyncResult
 *     } catch (error) {
 *       if (config.failOnError) throw error
 *       logger.warn('Azure sync failed, continuing with local files', error)
 *       return partialSyncResult
 *     }
 *
 * IMPORTANT: Steps 4-5 happen BEFORE validateConfig because validateConfig reads
 * from process.env, and the local .env may provide AZURE_VENV and AZURE_VENV_SAS_TOKEN.
 */
export async function initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult>;
```

---

## 8. Security Measures

### 8.1 SAS Token Sanitization

**Requirement:** SAS tokens must NEVER appear in any output channel -- logs, error messages, stack traces, or SyncResult.

**Implementation Points:**

| Location | Mechanism |
|---|---|
| Logger output | `sanitize()` applied to every log message and argument before console output |
| Error messages | Error constructors in `azure.ts` call `sanitize()` on the message parameter |
| RestError wrapping | When translating SDK RestError, the original message is sanitized before wrapping |
| URL display | `sanitizeSasUrl()` replaces the query string with `[SAS_REDACTED]` for display |
| SyncResult | SyncResult never contains URLs or tokens -- only blob names and statistics |

**Sanitization Rules:**

```
Rule 1: Replace exact SAS token string -> [REDACTED]
Rule 2: Replace sig=<any-non-ampersand-chars> -> sig=[REDACTED]
Rule 3: Replace se=<any-non-ampersand-chars> -> se=[REDACTED]
Rule 4: When displaying full URLs, replace everything after '?' with [SAS_REDACTED]
```

### 8.2 Path Traversal Prevention

**Requirement:** No blob download must ever write a file outside the application root directory.

**Two-Layer Defense:**

| Layer | Check | Implementation |
|---|---|---|
| Layer 1: Pattern Rejection | Reject known-malicious patterns before path resolution | Check for `..` in decoded name, absolute paths, empty names |
| Layer 2: Containment Verification | After `path.resolve()`, verify the result is under rootDir | `resolvedPath.startsWith(rootDir + path.sep)` |

**Attack Vectors Covered:**

| Attack | Example Blob Name | Defense |
|---|---|---|
| Relative traversal | `../../etc/passwd` | Layer 1: contains `..` |
| URL-encoded traversal | `%2e%2e/%2e%2e/etc/passwd` | Layer 1: decodeURIComponent then check `..` |
| Absolute path | `/etc/passwd` | Layer 1: path.isAbsolute check |
| Windows absolute | `C:\Windows\system32\config` | Layer 1: path.isAbsolute check |
| Unicode normalization | Unusual Unicode that normalizes to `..` | Layer 2: containment check catches any bypass |
| Null byte | `file%00.txt` | Layer 1: reject null bytes in decoded name |

### 8.3 HTTPS Enforcement

The config parser rejects any `AZURE_VENV` URL with a scheme other than `https:`. This prevents man-in-the-middle attacks on blob downloads and SAS token interception.

### 8.4 Manifest Integrity

The manifest file (`.azure-venv-manifest.json`) is written atomically (write to temp file, then rename) to prevent corruption from interrupted writes. If the manifest is corrupted on read, the library falls back to a full sync.

---

## 9. Cross-Module Dependency Map

This diagram shows which modules depend on which, guiding parallel implementation.

```
                   errors/
                  (no deps)
                 /    |    \
                /     |     \
               v      v      v
          config/   logging/  env/
          (needs    (no deps) (needs
           errors)            errors)
               \      |      /
                \     |     /
                 v    v    v
                  azure/
               (needs errors,
                logging)
                    |
                    v
                  sync/
              (needs azure,
               errors, logging)
                    |
                    v
               initialize.ts
            (needs ALL modules)
```

**Modules with zero internal dependencies (can be built first):**
- `errors/*` -- no imports from other `src/` modules
- `logging/logger.ts` -- no imports from other `src/` modules (uses LogLevel type but that can be inlined or imported from config/types)

**Modules requiring only `errors`:**
- `config/*`
- `env/*`

**Modules requiring `errors` + `logging`:**
- `azure/*`

**Modules requiring `azure` + `errors` + `logging`:**
- `sync/*`

**Module requiring everything:**
- `initialize.ts`

---

## 10. Implementation Notes for Parallel Agents

### 10.1 Agent Boundaries

Each agent must implement the exact interface contract from Section 7. Internal details (private methods, helper functions, variable names) are at the agent's discretion.

| Agent | Module(s) | Input Contracts | Output Contracts |
|---|---|---|---|
| Agent A | `errors/*` | None | Error classes per Section 4 |
| Agent B | `logging/logger.ts` | LogLevel type | `createLogger()`, `sanitize()` per Section 7.10 |
| Agent C | `config/parser.ts`, `config/validator.ts`, `config/types.ts` | Error classes from Agent A | `parseBlobUrl()`, `validateConfig()` per Sections 7.1, 7.2 |
| Agent D | `env/loader.ts`, `env/precedence.ts` | Error classes from Agent A, Logger from Agent B | `parseEnvFile()`, `parseEnvBuffer()`, `applyPrecedence()` per Sections 7.8, 7.9 |
| Agent E | `azure/client.ts`, `azure/types.ts` | Error classes from Agent A, Logger from Agent B | `AzureVenvBlobClient` class per Section 7.3 |
| Agent F | `sync/engine.ts`, `sync/downloader.ts`, `sync/manifest.ts`, `sync/path-validator.ts` | BlobClient from Agent E, Error classes from Agent A, Logger from Agent B | `SyncEngine`, `BlobDownloader`, `ManifestManager`, path functions per Sections 7.4-7.7 |
| Agent G | `initialize.ts`, `index.ts` | ALL modules | `initAzureVenv()` per Sections 5.2, 7.11 |

### 10.2 Shared Type Dependencies

All agents need access to the type definitions. The recommended approach:

1. Agent A creates `errors/*` first (all agents depend on error types).
2. Agent C creates `config/types.ts` first (several agents need `LogLevel`, `AzureVenvConfig`).
3. Agent E creates `azure/types.ts` (Agent F needs `BlobInfo`).
4. Other agents reference these types via imports.

If agents work in true parallel, they can use type stubs matching the contracts in Section 3 and replace with real imports when modules are complete.

### 10.3 Testing Strategy Per Module

Each agent must deliver unit tests alongside their implementation. Tests must:

- Mock all external dependencies (other modules, filesystem, Azure SDK)
- Cover the contract assertions listed in Section 7
- Cover error paths explicitly
- Use vitest as the test runner
- Follow naming convention: `__tests__/unit/<module>/<file>.test.ts`

### 10.4 Zod Schema for Configuration Validation

Agent C (config module) must implement the following Zod schema in `config/validator.ts`:

```typescript
import { z } from 'zod';

/**
 * Zod schema for validating raw environment variables.
 * Used internally by validateConfig().
 */
const azureVenvEnvSchema = z.object({
  AZURE_VENV: z.string().url().refine(
    (url) => url.startsWith('https://'),
    { message: 'AZURE_VENV must use HTTPS scheme' }
  ),
  AZURE_VENV_SAS_TOKEN: z.string().min(1, 'AZURE_VENV_SAS_TOKEN must not be empty'),
  AZURE_VENV_SAS_EXPIRY: z.string().datetime().optional(),
  AZURE_VENV_SYNC_MODE: z.enum(['full', 'incremental']).default('full'),
  AZURE_VENV_FAIL_ON_ERROR: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  AZURE_VENV_CONCURRENCY: z
    .string()
    .regex(/^\d+$/, 'AZURE_VENV_CONCURRENCY must be a positive integer')
    .transform(Number)
    .refine((n) => n > 0 && n <= 50, 'AZURE_VENV_CONCURRENCY must be between 1 and 50')
    .default('5'),
  AZURE_VENV_TIMEOUT: z
    .string()
    .regex(/^\d+$/, 'AZURE_VENV_TIMEOUT must be a positive integer')
    .transform(Number)
    .refine((n) => n >= 1000 && n <= 300000, 'AZURE_VENV_TIMEOUT must be between 1000 and 300000')
    .default('30000'),
  AZURE_VENV_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
```

Note: This schema validates the RAW string values from process.env. The `.default()` values apply only to optional operational parameters. Required fields (`AZURE_VENV`, `AZURE_VENV_SAS_TOKEN`) have no defaults -- their absence is detected BEFORE Zod validation in the `validateConfig()` function.

### 10.5 Concurrency Control Pattern

Agent F (sync module) must implement concurrency control in the `BlobDownloader`. The recommended pattern:

```typescript
/**
 * Simple semaphore for limiting concurrent async operations.
 * This is an internal utility, not exported.
 */
class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}
```

Usage in `downloadBatch()`:

```typescript
const semaphore = new Semaphore(this.concurrency);
const promises = blobs.map(async (blob) => {
  await semaphore.acquire();
  try {
    // download logic
  } finally {
    semaphore.release();
  }
});
const results = await Promise.allSettled(promises);
```

### 10.6 SDK Error Translation Pattern

Agent E (azure module) must translate `RestError` from the Azure SDK into library error types. The mapping:

| SDK Error | Condition | Library Error |
|---|---|---|
| `RestError` with `statusCode === 403` | `errorCode === 'AuthenticationFailed'` or `'AuthorizationFailure'` | `AuthenticationError` |
| `RestError` with `statusCode === 404` | Container or blob not found | `AzureConnectionError` (with statusCode) |
| `RestError` with `code === 'REQUEST_SEND_ERROR'` | Network unreachable | `AzureConnectionError` |
| `RestError` with `code === 'ETIMEDOUT'` or `'ESOCKETTIMEDOUT'` | Timeout | `AzureConnectionError` |
| `RestError` with `statusCode === 429` | Rate limited (after SDK retries exhausted) | `AzureConnectionError` |
| `RestError` (any other) | Unclassified | `AzureConnectionError` |
| Non-RestError | Unexpected | Re-throw as-is |

All error messages must be sanitized via `sanitize()` before being passed to the error constructor.

### 10.7 Dependencies (npm packages)

```json
{
  "dependencies": {
    "@azure/storage-blob": "^12.26.0",
    "dotenv": "^16.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0"
  }
}
```

### 10.8 TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

---

## Appendix A: Design Decisions Register

| ID | Decision | Rationale | Alternatives Rejected |
|---|---|---|---|
| DD-001 | Required config throws exceptions, no fallbacks | Security-critical params must be explicitly provided; silent defaults could lead to misconfiguration | Default values, graceful skip |
| DD-002 | Operational params have sensible defaults | These are tuning knobs, not security-critical; requiring explicit config would harm DX | All-or-nothing config |
| DD-003 | ETag-based manifest for incremental sync | Most precise change detection; timestamp comparison has clock skew issues | Timestamp-based, MD5-based, always-overwrite |
| DD-004 | Three-tier env precedence: OS > remote > local | Matches industry convention; OS vars from deployment platform should always win | Two-tier, single-source |
| DD-005 | Remote .env downloaded before other files | App may need remote config vars during startup initialization | Download all files first, lazy env loading |
| DD-006 | @azure/storage-blob v12.x with SAS token auth | Official SDK, TypeScript-native, SAS is most portable auth method | BlobFuse, rclone, AzCopy |
| DD-007 | Flat listing with prefix stripping | Simpler than hierarchical listing, single pass, fewer API calls | Hierarchical listing |
| DD-008 | Promise.allSettled for concurrent downloads | Individual failures must not abort the entire sync | Promise.all (fail-fast) |
| DD-009 | Atomic manifest writes (temp + rename) | Prevents corruption from interrupted writes | Direct write |
| DD-010 | dotenv.parse() instead of dotenv.config() | Need explicit control over when/how values are applied to process.env | dotenv.config() with override flag |

---

## Appendix B: Feature-to-Module Traceability

| Feature ID | Feature | Primary Module | Secondary Module |
|---|---|---|---|
| FR-001 | Local .env bootstrap | env/loader.ts | initialize.ts |
| FR-002 | Config detection | config/validator.ts | initialize.ts |
| FR-003 | URL parsing | config/parser.ts | -- |
| FR-004 | SAS token validation | config/validator.ts | -- |
| FR-005 | Blob storage connection | azure/client.ts | initialize.ts |
| FR-006 | Blob listing | azure/client.ts | sync/engine.ts |
| FR-007 | Remote .env priority | sync/engine.ts | env/precedence.ts, initialize.ts |
| FR-008 | Three-tier precedence | env/precedence.ts | initialize.ts |
| FR-009 | File synchronization | sync/engine.ts | sync/downloader.ts |
| FR-010 | Incremental sync | sync/manifest.ts | sync/engine.ts |
| FR-011 | Path traversal prevention | sync/path-validator.ts | sync/engine.ts |
| FR-012 | SAS sanitization | logging/logger.ts | errors/* |
| FR-013 | Error behavior config | initialize.ts | config/validator.ts |
| FR-014 | Concurrent downloads | sync/downloader.ts | sync/engine.ts |
| FR-015 | Sync result reporting | sync/engine.ts | initialize.ts |
| FR-016 | Structured logging | logging/logger.ts | -- |
| FR-017 | SAS expiry warning | config/validator.ts | azure/client.ts |

---

## 11. Design Addendum: v1.1 Enhancements

**Date:** 2026-02-27
**Status:** Draft
**Version:** 1.1
**Plan Reference:** [plan-002-design-decisions-enhancements.md](plan-002-design-decisions-enhancements.md)
**Research Reference:** [../reference/investigation-design-decisions-v2.md](../reference/investigation-design-decisions-v2.md)

This addendum specifies the exact code-level changes for five design decisions:
1. Watch Mode (polling-based blob change detection)
2. CLI Command (`azure-venv sync` and `azure-venv watch`)
3. Manifest Location Lock (remove `manifestPath` configurability)
4. Orphan Files (documented as NOT in scope)
5. Configurable Blob Size Threshold (streaming download for large blobs)

All interface definitions, method signatures, and behavioral contracts are specified with exact TypeScript code so that parallel coding agents can implement independently.

---

### 11.1 Config Type Changes (`src/config/types.ts`)

#### 11.1.1 Fields REMOVED from `AzureVenvConfig`

```typescript
// REMOVE this field:
readonly manifestPath: string;
```

**Reason:** The manifest path is always derived as `path.resolve(rootDir, '.azure-venv-manifest.json')`. Making it configurable creates inconsistency with watch mode, which requires a deterministic manifest location.

#### 11.1.2 Fields ADDED to `AzureVenvConfig`

```typescript
// ADD these three fields to the AzureVenvConfig interface:

/** Maximum blob size in bytes before switching to streaming download. Default: 104857600 (100 MB). Min: 1048576 (1 MB). Env: AZURE_VENV_MAX_BLOB_SIZE */
readonly maxBlobSize: number;

/** Polling interval in milliseconds for watch mode. Default: 30000 (30s). Min: 5000 (5s). Env: AZURE_VENV_POLL_INTERVAL */
readonly pollInterval: number;

/** Whether watch mode is enabled. Default: false. Env: AZURE_VENV_WATCH_ENABLED */
readonly watchEnabled: boolean;
```

#### 11.1.3 Complete NEW `AzureVenvConfig` Interface

```typescript
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

  /** ISO 8601 expiry date of the SAS token, if determinable. */
  readonly sasExpiry: Date | null;

  /** Sync mode: 'full' re-downloads everything; 'incremental' uses ETag manifest. Default: 'full'. */
  readonly syncMode: SyncMode;

  /** If true, any Azure error throws and prevents application startup. Default: false. */
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

  /** Maximum blob size in bytes before switching to streaming download. Default: 104857600 (100 MB). */
  readonly maxBlobSize: number;

  /** Polling interval in milliseconds for watch mode. Default: 30000 (30s). */
  readonly pollInterval: number;

  /** Whether watch mode is enabled. Default: false. */
  readonly watchEnabled: boolean;
}
```

#### 11.1.4 Fields REMOVED from `AzureVenvOptions`

```typescript
// REMOVE this field:
manifestPath?: string;
```

#### 11.1.5 Fields ADDED to `AzureVenvOptions`

```typescript
// ADD these three fields to the AzureVenvOptions interface:

/** Override maximum blob size threshold (bytes). Default: reads AZURE_VENV_MAX_BLOB_SIZE or 104857600 */
maxBlobSize?: number;

/** Override polling interval (ms). Default: reads AZURE_VENV_POLL_INTERVAL or 30000 */
pollInterval?: number;

/** Override watch enabled flag. Default: reads AZURE_VENV_WATCH_ENABLED or false */
watchEnabled?: boolean;
```

#### 11.1.6 Complete NEW `AzureVenvOptions` Interface

```typescript
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

  /** Override maximum blob size threshold (bytes). Default: reads AZURE_VENV_MAX_BLOB_SIZE or 104857600 */
  maxBlobSize?: number;

  /** Override polling interval (ms). Default: reads AZURE_VENV_POLL_INTERVAL or 30000 */
  pollInterval?: number;

  /** Override watch enabled flag. Default: reads AZURE_VENV_WATCH_ENABLED or false */
  watchEnabled?: boolean;
}
```

#### 11.1.7 Fields ADDED to `RawEnvConfig`

```typescript
/**
 * Raw environment variable values before Zod validation.
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
  // NEW:
  AZURE_VENV_MAX_BLOB_SIZE?: string;
  AZURE_VENV_POLL_INTERVAL?: string;
  AZURE_VENV_WATCH_ENABLED?: string;
}
```

#### 11.1.8 NEW Watch Types (added to `src/config/types.ts`)

```typescript
/**
 * Options for watch mode polling.
 */
export interface WatchOptions {
  /** Polling interval in ms. Overrides config.pollInterval. Default: 30000. Min: 5000. */
  pollInterval?: number;

  /** Callback invoked when blob changes are detected during a poll cycle. */
  onChange?: (changes: WatchChangeEvent) => void;

  /** Callback invoked on watch cycle errors. The watcher continues polling after errors. */
  onError?: (error: Error) => void;
}

/**
 * Describes changes detected during a single poll cycle.
 */
export interface WatchChangeEvent {
  /** New blob relative paths added since last poll. */
  readonly added: string[];

  /** Modified blob relative paths (ETag changed). */
  readonly modified: string[];

  /** Deleted blob relative paths (in manifest but not in remote). */
  readonly deleted: string[];

  /** Whether the remote .env file was updated in this cycle. */
  readonly envChanged: boolean;
}
```

---

### 11.2 New Watch Types (`src/types/index.ts`)

Add to `src/types/index.ts`:

```typescript
/**
 * Result returned by watchAzureVenv(), providing control over the watcher.
 */
export interface WatchResult {
  /** Stops the watcher gracefully. Returns a Promise that resolves when all cleanup is done. */
  stop(): Promise<void>;
}
```

Also add re-exports for the watch types defined in `src/config/types.ts`:

```typescript
// Re-export watch types
export type { WatchOptions, WatchChangeEvent } from '../config/types.js';
```

---

### 11.3 Zod Schema Changes (`src/config/validator.ts`)

#### 11.3.1 New Schema Fields

Add these three fields to the `azureVenvEnvSchema` Zod object:

```typescript
AZURE_VENV_MAX_BLOB_SIZE: z
  .string()
  .regex(/^\d+$/, 'AZURE_VENV_MAX_BLOB_SIZE must be a positive integer')
  .default('104857600')
  .transform(Number)
  .refine(
    (n) => n >= 1048576,
    'AZURE_VENV_MAX_BLOB_SIZE must be at least 1048576 (1 MB)',
  ),
AZURE_VENV_POLL_INTERVAL: z
  .string()
  .regex(/^\d+$/, 'AZURE_VENV_POLL_INTERVAL must be a positive integer')
  .default('30000')
  .transform(Number)
  .refine(
    (n) => n >= 5000,
    'AZURE_VENV_POLL_INTERVAL must be at least 5000 (5 seconds)',
  ),
AZURE_VENV_WATCH_ENABLED: z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true'),
```

#### 11.3.2 Optional Keys Array Update

Add the three new env var names to the `optionalKeys` array in `validateConfig()`:

```typescript
const optionalKeys = [
  'AZURE_VENV_SAS_EXPIRY',
  'AZURE_VENV_SYNC_MODE',
  'AZURE_VENV_FAIL_ON_ERROR',
  'AZURE_VENV_CONCURRENCY',
  'AZURE_VENV_TIMEOUT',
  'AZURE_VENV_LOG_LEVEL',
  // NEW:
  'AZURE_VENV_MAX_BLOB_SIZE',
  'AZURE_VENV_POLL_INTERVAL',
  'AZURE_VENV_WATCH_ENABLED',
] as const;
```

#### 11.3.3 Config Builder Update

Replace the config building block. Remove `manifestPath`, add three new fields:

```typescript
// Build the final config, applying options overrides over env vars over defaults
const config: AzureVenvConfig = {
  blobUrl,
  sasToken: cleanSasToken,
  sasExpiry,
  syncMode: options?.syncMode ?? validated.AZURE_VENV_SYNC_MODE,
  failOnError: options?.failOnError ?? validated.AZURE_VENV_FAIL_ON_ERROR,
  concurrency: options?.concurrency ?? validated.AZURE_VENV_CONCURRENCY,
  timeout: options?.timeout ?? validated.AZURE_VENV_TIMEOUT,
  logLevel: options?.logLevel ?? validated.AZURE_VENV_LOG_LEVEL,
  rootDir: options?.rootDir ?? process.cwd(),
  envPath: options?.envPath ?? '.env',
  // NEW fields (manifestPath removed):
  maxBlobSize: options?.maxBlobSize ?? validated.AZURE_VENV_MAX_BLOB_SIZE,
  pollInterval: options?.pollInterval ?? validated.AZURE_VENV_POLL_INTERVAL,
  watchEnabled: options?.watchEnabled ?? validated.AZURE_VENV_WATCH_ENABLED,
};
```

---

### 11.4 Streaming Download (`src/azure/client.ts`)

#### 11.4.1 New Method on `AzureVenvBlobClient`

Add this method to the `AzureVenvBlobClient` class. It must be placed after `downloadToFile()`.

**New imports required at file top:**

```typescript
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs';
// Note: 'node:fs/promises' is already imported as fsPromises. Keep both.
// Rename the existing import to avoid conflict:
import * as fsPromises from 'node:fs/promises';
// The fs (sync API) import is needed for createWriteStream only.
```

**New method:**

```typescript
/**
 * Download a blob to a local file using streaming (node:stream/promises pipeline).
 * Use for large blobs that exceed the maxBlobSize threshold.
 * Same return type as downloadToFile() for seamless switching.
 *
 * @param blobName - Full blob name in the container.
 * @param localPath - Absolute local file path to write to.
 * @returns BlobDownloadResult with metadata.
 *
 * @throws AzureConnectionError on network/timeout errors.
 * @throws AuthenticationError on 403 responses.
 * @throws SyncError if the readable stream body is unavailable or write fails.
 */
async downloadToFileStreaming(
  blobName: string,
  localPath: string,
): Promise<BlobDownloadResult> {
  this.logger.debug(
    `Streaming download blob "${blobName}" to "${localPath}"`,
  );

  try {
    // Create parent directories recursively
    const parentDir = path.dirname(localPath);
    await fsPromises.mkdir(parentDir, { recursive: true });

    const blockBlobClient: BlockBlobClient =
      this.containerClient.getBlockBlobClient(blobName);

    // Download with offset 0 to get ReadableStream
    const downloadResponse = await blockBlobClient.download(0);

    if (!downloadResponse.readableStreamBody) {
      throw new SyncError(
        `No readable stream body in download response for "${blobName}"`,
      );
    }

    // Stream to disk via pipeline (auto-cleans up on error)
    const writeStream = fs.createWriteStream(localPath);
    await pipeline(downloadResponse.readableStreamBody, writeStream);

    const result: BlobDownloadResult = {
      blobName,
      localPath,
      etag: downloadResponse.etag ?? '',
      lastModified: downloadResponse.lastModified ?? new Date(0),
      contentLength: downloadResponse.contentLength ?? 0,
    };

    this.logger.debug(
      `Streamed blob "${blobName}" (${result.contentLength} bytes)`,
    );

    return result;
  } catch (error: unknown) {
    if (
      error instanceof AuthenticationError ||
      error instanceof AzureConnectionError ||
      error instanceof SyncError
    ) {
      throw error;
    }
    throw this.translateError(
      error,
      `Failed to stream blob "${blobName}" to "${localPath}"`,
    );
  }
}
```

#### 11.4.2 Behavioral Contract

- Uses `blockBlobClient.download(0)` to obtain a `NodeJS.ReadableStream` via `readableStreamBody`.
- Pipes through `pipeline()` from `node:stream/promises` to `fs.createWriteStream()`.
- `pipeline()` auto-destroys all streams on error (no resource leak).
- On network interruption, a partial file may remain on disk. The next sync cycle will overwrite it because the ETag will not match the manifest.
- Returns the identical `BlobDownloadResult` shape as `downloadToFile()`, so the caller (BlobDownloader) can use either method interchangeably.
- SAS token sanitization follows the same pattern as `downloadToFile()` via `this.translateError()`.

---

### 11.5 Downloader Threshold Logic (`src/sync/downloader.ts`)

#### 11.5.1 Constructor Change

Add `maxBlobSize` as the fifth constructor parameter:

```typescript
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
   * @param maxBlobSize - Threshold in bytes. Blobs above this use streaming download.
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
  // ...
}
```

#### 11.5.2 Download Routing in `downloadOne()`

Replace the single download call with threshold-based routing. Inside the `downloadOne` closure, change the download block (currently at line 112 in `downloader.ts`):

**BEFORE:**

```typescript
const result = await this.client.downloadToFile(blob.name, localPath);
```

**AFTER:**

```typescript
const useStreaming = blob.contentLength > this.maxBlobSize;
if (useStreaming) {
  this.logger.debug(
    `Blob "${blob.name}" (${blob.contentLength} bytes) exceeds threshold (${this.maxBlobSize}), using streaming download`,
  );
}
const result = useStreaming
  ? await this.client.downloadToFileStreaming(blob.name, localPath)
  : await this.client.downloadToFile(blob.name, localPath);
```

#### 11.5.3 Behavioral Contract

- Blobs with `contentLength > maxBlobSize` route to `downloadToFileStreaming()`.
- Blobs with `contentLength <= maxBlobSize` route to `downloadToFile()` (existing behavior, unchanged).
- The threshold comparison uses strict greater-than (`>`), not greater-than-or-equal. A blob exactly equal to the threshold uses the non-streaming path.
- The default threshold is 104857600 bytes (100 MB), enforced via the Zod schema minimum of 1048576 (1 MB).

---

### 11.6 Manifest Location Fix

#### 11.6.1 Change in `src/initialize.ts` (line 102)

**BEFORE:**

```typescript
const manifestPath = path.resolve(config.rootDir, config.manifestPath);
```

**AFTER:**

```typescript
const manifestPath = path.resolve(config.rootDir, '.azure-venv-manifest.json');
```

#### 11.6.2 Change in `src/initialize.ts` -- BlobDownloader Constructor (line 104-109)

**BEFORE:**

```typescript
const downloader = new BlobDownloader(
  blobClient,
  { validateAndResolvePath },
  logger,
  config.concurrency,
);
```

**AFTER:**

```typescript
const downloader = new BlobDownloader(
  blobClient,
  { validateAndResolvePath },
  logger,
  config.concurrency,
  config.maxBlobSize,
);
```

#### 11.6.3 Behavioral Contract

- The manifest file is always at `<rootDir>/.azure-venv-manifest.json`.
- No code path reads `config.manifestPath` because the field no longer exists.
- If a JavaScript caller passes `{ manifestPath: '...' }` in options, it is silently ignored (the property does not exist in the TypeScript type, and the validator does not read it).

---

### 11.7 Watch Module

#### 11.7.1 New File: `src/watch/types.ts`

This file is NOT needed. All watch types are defined in `src/config/types.ts` (WatchOptions, WatchChangeEvent) and `src/types/index.ts` (WatchResult). This avoids circular dependencies and keeps types centralized.

#### 11.7.2 New File: `src/watch/watcher.ts`

```typescript
import type { AzureVenvConfig } from '../config/types.js';
import type { WatchOptions, WatchChangeEvent } from '../config/types.js';
import type { WatchResult } from '../types/index.js';
import type { Logger } from '../logging/logger.js';
import { AzureVenvBlobClient } from '../azure/client.js';
import { ManifestManager } from '../sync/manifest.js';
import { BlobDownloader } from '../sync/downloader.js';
import { SyncEngine } from '../sync/engine.js';
import { parseEnvBuffer } from '../env/loader.js';
import { applyPrecedence } from '../env/precedence.js';

/**
 * Polls Azure Blob Storage for changes and syncs them to the local filesystem.
 *
 * Lifecycle:
 *   1. Created by watchAzureVenv() AFTER initial sync completes.
 *   2. start() begins the polling loop via setInterval.
 *   3. Each poll cycle: list blobs, compare ETags to manifest, download changes.
 *   4. stop() clears interval, aborts in-flight requests, waits for current poll.
 *
 * Graceful shutdown:
 *   - SIGINT and SIGTERM trigger stop().
 *   - Double-shutdown is guarded (idempotent).
 *   - Safety timeout of 10s prevents indefinite hang.
 */
export class BlobWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private abortController = new AbortController();
  private isShuttingDown = false;
  private isPollRunning = false;
  private readonly shutdownTimeout = 10_000; // 10s safety net

  constructor(
    private readonly config: AzureVenvConfig,
    private readonly client: AzureVenvBlobClient,
    private readonly manifestManager: ManifestManager,
    private readonly downloader: BlobDownloader,
    private readonly syncEngine: SyncEngine,
    private readonly osEnvSnapshot: ReadonlySet<string>,
    private readonly logger: Logger,
    private readonly watchOptions: Required<
      Pick<WatchOptions, 'pollInterval'>
    > &
      Pick<WatchOptions, 'onChange' | 'onError'>,
  ) {}

  /**
   * Start the polling loop.
   * @returns WatchResult with stop() method for external control.
   */
  start(): WatchResult {
    this.logger.info(
      `Starting watch mode (poll interval: ${this.watchOptions.pollInterval}ms)`,
    );

    this.intervalId = setInterval(
      () => void this.poll(),
      this.watchOptions.pollInterval,
    );

    // Graceful shutdown on process signals
    const shutdown = (): void => {
      void this.stop();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return {
      stop: () => this.stop(),
    };
  }

  /**
   * Stop the polling loop gracefully.
   * - Clears the interval (no future polls).
   * - Aborts in-flight HTTP requests via AbortController.
   * - Waits for the current poll to finish (with 10s safety timeout).
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info('Stopping watch mode...');

    // Stop future polls
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Cancel in-flight HTTP requests
    this.abortController.abort();

    // Wait for current poll to finish (with safety timeout)
    if (this.isPollRunning) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (!this.isPollRunning) {
              clearInterval(check);
              resolve();
            }
          }, 100);
        }),
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.shutdownTimeout),
        ),
      ]);
    }

    this.logger.info('Watch mode stopped');
  }

  /**
   * Single poll cycle. Compares remote blobs against manifest, downloads changes.
   * Guarded against overlapping execution (isPollRunning flag).
   */
  private async poll(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    if (this.isPollRunning) return; // Skip if previous poll still running

    this.isPollRunning = true;
    this.logger.debug('Poll cycle starting...');

    try {
      // 1. List current remote blobs
      const prefix = this.config.blobUrl.prefix;
      const currentBlobs = await this.client.listBlobs(prefix);

      // 2. Load current manifest
      const manifest = await this.manifestManager.load();

      // 3. Compare ETags to detect changes
      const added: string[] = [];
      const modified: string[] = [];
      const currentBlobNames = new Set<string>();

      for (const blob of currentBlobs) {
        currentBlobNames.add(blob.name);
        const entry = manifest.entries[blob.name];

        if (!entry) {
          added.push(blob.name);
        } else if (entry.etag !== blob.etag) {
          modified.push(blob.name);
        }
      }

      // 4. Detect deletions (in manifest but not in remote)
      const deleted: string[] = [];
      for (const blobName of Object.keys(manifest.entries)) {
        if (!currentBlobNames.has(blobName)) {
          deleted.push(blobName);
        }
      }

      const hasChanges =
        added.length > 0 || modified.length > 0 || deleted.length > 0;

      if (!hasChanges) {
        this.logger.debug('No changes detected');
        return;
      }

      this.logger.info(
        `Changes detected: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`,
      );

      // 5. Download changed/new blobs
      const changedBlobs = currentBlobs.filter(
        (b) => added.includes(b.name) || modified.includes(b.name),
      );

      if (changedBlobs.length > 0) {
        await this.downloader.downloadBatch(
          changedBlobs,
          this.config.rootDir,
          prefix,
        );
      }

      // 6. Check if remote .env changed
      const envBlobName = prefix ? `${prefix}.env` : '.env';
      const envChanged =
        added.includes(envBlobName) || modified.includes(envBlobName);

      if (envChanged) {
        this.logger.info('Remote .env changed, re-applying precedence');
        const remoteEnvBuffer = await this.syncEngine.fetchRemoteEnv(
          prefix,
          this.config.rootDir,
        );
        if (remoteEnvBuffer) {
          const remoteEnv = parseEnvBuffer(remoteEnvBuffer);
          applyPrecedence(this.osEnvSnapshot, {}, remoteEnv, this.logger);
        }
      }

      // 7. Update manifest (remove deleted entries, save)
      const updatedEntries = { ...manifest.entries };
      for (const name of deleted) {
        delete updatedEntries[name];
      }
      await this.manifestManager.save({
        ...manifest,
        entries: updatedEntries,
      });

      // 8. Emit onChange callback
      const changeEvent: WatchChangeEvent = {
        added,
        modified,
        deleted,
        envChanged,
      };

      if (this.watchOptions.onChange) {
        this.watchOptions.onChange(changeEvent);
      }
    } catch (error: unknown) {
      const err =
        error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Poll cycle failed: ${err.message}`);

      if (this.watchOptions.onError) {
        this.watchOptions.onError(err);
      }
    } finally {
      this.isPollRunning = false;
    }
  }
}
```

#### 11.7.3 New File: `src/watch/index.ts`

```typescript
import * as path from 'node:path';
import type { AzureVenvOptions, WatchOptions } from '../config/types.js';
import type { WatchResult } from '../types/index.js';
import { initAzureVenv } from '../initialize.js';
import { validateConfig } from '../config/validator.js';
import { createLogger } from '../logging/logger.js';
import { AzureVenvBlobClient } from '../azure/client.js';
import { ManifestManager } from '../sync/manifest.js';
import { BlobDownloader } from '../sync/downloader.js';
import { SyncEngine } from '../sync/engine.js';
import { validateAndResolvePath } from '../sync/path-validator.js';
import { BlobWatcher } from './watcher.js';
import { ConfigurationError } from '../errors/index.js';

/**
 * Start watch mode: performs an initial sync then polls for changes.
 *
 * Flow:
 *   1. Capture OS env snapshot.
 *   2. Run initAzureVenv() for initial sync.
 *   3. If AZURE_VENV not configured, throw ConfigurationError.
 *   4. Re-validate config (to get watch-specific fields).
 *   5. Create watcher infrastructure (client, manifest, downloader, engine).
 *   6. Start BlobWatcher polling loop.
 *   7. Return WatchResult with stop() method.
 *
 * @param options - Standard AzureVenvOptions for initial sync config.
 * @param watchOptions - Watch-specific options (polling interval, callbacks).
 * @returns WatchResult with stop() method.
 *
 * @throws ConfigurationError if AZURE_VENV is not configured.
 */
export async function watchAzureVenv(
  options?: AzureVenvOptions,
  watchOptions?: WatchOptions,
): Promise<WatchResult> {
  // Capture OS env snapshot BEFORE any loading
  const osEnvSnapshot = new Set(Object.keys(process.env));

  // Step 1: Perform initial sync
  const syncResult = await initAzureVenv(options);

  if (!syncResult.attempted) {
    throw new ConfigurationError(
      'Cannot start watch mode: AZURE_VENV is not configured',
      'AZURE_VENV',
    );
  }

  // Step 2: Build config for watcher
  const config = validateConfig(
    process.env as Record<string, string | undefined>,
    options,
  );

  if (config === null) {
    throw new ConfigurationError(
      'Cannot start watch mode: AZURE_VENV is not configured',
      'AZURE_VENV',
    );
  }

  const logger = createLogger(config.logLevel, config.sasToken);

  // Step 3: Create watcher infrastructure
  const blobClient = new AzureVenvBlobClient(
    {
      accountUrl: config.blobUrl.accountUrl,
      containerName: config.blobUrl.containerName,
      sasToken: config.sasToken,
      maxRetries: 3,
      timeout: config.timeout,
    },
    logger,
  );

  const manifestPath = path.resolve(
    config.rootDir,
    '.azure-venv-manifest.json',
  );
  const manifestManager = new ManifestManager(manifestPath, logger);
  const downloader = new BlobDownloader(
    blobClient,
    { validateAndResolvePath },
    logger,
    config.concurrency,
    config.maxBlobSize,
  );
  const syncEngine = new SyncEngine(
    blobClient,
    manifestManager,
    downloader,
    logger,
  );

  const resolvedWatchOptions = {
    pollInterval: watchOptions?.pollInterval ?? config.pollInterval,
    onChange: watchOptions?.onChange,
    onError: watchOptions?.onError,
  };

  // Step 4: Create and start watcher
  const watcher = new BlobWatcher(
    config,
    blobClient,
    manifestManager,
    downloader,
    syncEngine,
    osEnvSnapshot,
    logger,
    resolvedWatchOptions,
  );

  return watcher.start();
}
```

#### 11.7.4 Behavioral Contracts for Watch Module

**Poll Cycle:**
1. Calls `client.listBlobs(prefix)` to get the current remote blob list.
2. Loads the local manifest via `manifestManager.load()`.
3. For each remote blob, compares its ETag against the manifest entry:
   - No entry in manifest -> `added`
   - Entry exists but ETag differs -> `modified`
4. For each manifest entry, checks if it exists in the remote list:
   - Not in remote -> `deleted`
5. Downloads all `added` and `modified` blobs via `downloader.downloadBatch()`.
6. If the remote `.env` blob was added or modified, re-applies three-tier precedence using the original `osEnvSnapshot` (captured once at `watchAzureVenv()` initialization).
7. Updates the manifest: removes deleted entries, saves.
8. Fires `onChange` callback with the `WatchChangeEvent`.
9. On any error, fires `onError` callback. The watcher continues polling.

**Graceful Shutdown:**
- `stop()` clears `setInterval`, aborts `AbortController`, waits for current poll.
- `isShuttingDown` flag prevents double-shutdown.
- Safety timeout of 10 seconds prevents indefinite hang if poll is stuck.
- SIGINT and SIGTERM handlers call `stop()`.

**Orphan Files (NOT IN SCOPE):**
- Deleted blobs are removed from the manifest only. Local files are NOT deleted.
- Rationale: Automatic file deletion is destructive and risks data loss if Azure returns an incomplete blob listing (outage, prefix misconfiguration).
- Users needing orphan cleanup should use the `onChange` callback and the `deleted` array.

---

### 11.8 CLI Module (`src/cli/index.ts`)

#### 11.8.1 New File: `src/cli/index.ts`

```typescript
#!/usr/bin/env node

import { Command } from 'commander';
import { initAzureVenv } from '../initialize.js';
import { watchAzureVenv } from '../watch/index.js';
import type { AzureVenvOptions } from '../config/types.js';
import type { LogLevel, SyncMode } from '../config/types.js';

const program = new Command();

program
  .name('azure-venv')
  .description('Azure Blob Storage virtual environment sync tool')
  .version('0.2.0');

/**
 * Add common CLI options shared between sync and watch commands.
 */
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--root-dir <path>', 'Application root directory', process.cwd())
    .option('--env-path <path>', 'Path to local .env file', '.env')
    .option('--sync-mode <mode>', 'Sync mode: full or incremental', 'full')
    .option('--concurrency <n>', 'Parallel downloads', '5')
    .option(
      '--log-level <level>',
      'Log level: debug, info, warn, error',
      'info',
    )
    .option('--fail-on-error', 'Exit with code 1 on sync errors')
    .option('--json', 'Output result as JSON');
}

// --- sync command ---
const syncCmd = new Command('sync').description(
  'One-time sync from Azure Blob Storage',
);

addCommonOptions(syncCmd);

syncCmd.action(
  async (opts: Record<string, string | boolean | undefined>) => {
    try {
      const options = buildOptions(opts);
      const result = await initAzureVenv(options);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printSyncResult(result);
      }

      process.exit(result.failed > 0 && opts.failOnError ? 1 : 0);
    } catch (error: unknown) {
      handleError(error, opts.json as boolean | undefined);
    }
  },
);

// --- watch command ---
const watchCmd = new Command('watch').description(
  'Start continuous polling for blob changes',
);

addCommonOptions(watchCmd);
watchCmd.option(
  '--poll-interval <ms>',
  'Polling interval in milliseconds',
  '30000',
);

watchCmd.action(
  async (opts: Record<string, string | boolean | undefined>) => {
    try {
      const options = buildOptions(opts);
      const pollInterval = parseInt(opts.pollInterval as string, 10);

      await watchAzureVenv(options, {
        pollInterval,
        onChange: (changes) => {
          if (opts.json) {
            console.log(JSON.stringify(changes));
          } else {
            console.log(
              `[azure-venv] Changes: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}` +
                (changes.envChanged ? ' (env updated)' : ''),
            );
          }
        },
        onError: (error) => {
          console.error(`[azure-venv] Watch error: ${error.message}`);
        },
      });

      // Keep process alive -- watcher interval keeps the event loop running.
      // SIGINT/SIGTERM are handled by BlobWatcher.
    } catch (error: unknown) {
      handleError(error, opts.json as boolean | undefined);
    }
  },
);

program.addCommand(syncCmd);
program.addCommand(watchCmd);

program.parse();

// --- Helper functions ---

function buildOptions(
  opts: Record<string, string | boolean | undefined>,
): AzureVenvOptions {
  const options: AzureVenvOptions = {};

  if (typeof opts.rootDir === 'string') options.rootDir = opts.rootDir;
  if (typeof opts.envPath === 'string') options.envPath = opts.envPath;
  if (typeof opts.syncMode === 'string')
    options.syncMode = opts.syncMode as SyncMode;
  if (typeof opts.concurrency === 'string')
    options.concurrency = parseInt(opts.concurrency, 10);
  if (typeof opts.logLevel === 'string')
    options.logLevel = opts.logLevel as LogLevel;
  if (opts.failOnError === true) options.failOnError = true;

  return options;
}

function printSyncResult(result: {
  attempted: boolean;
  downloaded: number;
  skipped: number;
  failed: number;
  duration: number;
  remoteEnvLoaded: boolean;
}): void {
  if (!result.attempted) {
    console.log('azure-venv: not configured (AZURE_VENV not set)');
    return;
  }

  console.log('azure-venv sync complete');
  console.log(`  Downloaded: ${result.downloaded} blobs`);
  console.log(`  Skipped:    ${result.skipped} blobs (unchanged)`);
  console.log(`  Failed:     ${result.failed} blobs`);
  console.log(`  Duration:   ${(result.duration / 1000).toFixed(1)}s`);
  console.log(
    `  Remote .env: ${result.remoteEnvLoaded ? 'loaded' : 'not found'}`,
  );
}

function handleError(
  error: unknown,
  json: boolean | undefined,
): void {
  const message =
    error instanceof Error ? error.message : String(error);
  if (json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`azure-venv error: ${message}`);
  }
  process.exit(1);
}
```

#### 11.8.2 Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error / sync failure (when `--fail-on-error`) |
| 2 | Invalid CLI arguments (Commander.js default) |
| 130 | Interrupted by SIGINT (standard Unix convention) |

#### 11.8.3 `package.json` Changes

```json
{
  "version": "0.2.0",
  "bin": {
    "azure-venv": "./dist/cli/index.js"
  },
  "dependencies": {
    "@azure/storage-blob": "^12.31.0",
    "commander": "^14.0.0",
    "dotenv": "^17.3.1",
    "zod": "^4.3.6"
  }
}
```

#### 11.8.4 Shebang Handling

TypeScript 5.5+ preserves shebangs. The `src/cli/index.ts` file starts with `#!/usr/bin/env node`. To ensure it survives compilation, add a `postbuild` script to `package.json`:

```json
{
  "scripts": {
    "build": "tsc",
    "postbuild": "chmod +x dist/cli/index.js",
    "test": "vitest run",
    "lint": "eslint src/",
    "clean": "rm -rf dist"
  }
}
```

---

### 11.9 Public API Additions (`src/index.ts`)

#### 11.9.1 New Exports

Add to `src/index.ts`:

```typescript
// Watch mode API
export { watchAzureVenv } from './watch/index.js';

// Watch types
export type { WatchOptions, WatchChangeEvent } from './config/types.js';
export type { WatchResult } from './types/index.js';
```

#### 11.9.2 Complete NEW `src/index.ts`

```typescript
// Public API
export { initAzureVenv } from './initialize.js';
export { watchAzureVenv } from './watch/index.js';

// Configuration types
export type {
  AzureVenvOptions,
  AzureVenvConfig,
  ParsedBlobUrl,
  LogLevel,
  SyncMode,
  WatchOptions,
  WatchChangeEvent,
} from './config/types.js';

// Result types
export type {
  SyncResult,
  SyncManifest,
  ManifestEntry,
  EnvSource,
  EnvRecord,
  EnvLoadResult,
  WatchResult,
} from './types/index.js';

// Azure types
export type { BlobInfo, BlobDownloadResult } from './azure/types.js';

// Logger
export type { Logger } from './logging/logger.js';

// Error classes (exported as values, not just types)
export {
  AzureVenvError,
  ConfigurationError,
  AzureConnectionError,
  AuthenticationError,
  SyncError,
  PathTraversalError,
} from './errors/index.js';
```

---

### 11.10 Complete File Change Summary

#### Files to CREATE (3 new files)

| File | Section | Purpose |
|------|---------|---------|
| `src/watch/watcher.ts` | 11.7.2 | BlobWatcher class with polling logic |
| `src/watch/index.ts` | 11.7.3 | Watch module barrel + `watchAzureVenv()` public function |
| `src/cli/index.ts` | 11.8.1 | CLI entry point with Commander.js |

#### Files to MODIFY (8 existing files)

| File | Section | Summary |
|------|---------|---------|
| `src/config/types.ts` | 11.1 | Remove `manifestPath`, add `maxBlobSize`, `pollInterval`, `watchEnabled`, add `WatchOptions`, `WatchChangeEvent` |
| `src/config/validator.ts` | 11.3 | Add 3 Zod fields, update optionalKeys, remove `manifestPath` from config builder |
| `src/initialize.ts` | 11.6 | Hardcode manifest path, pass `maxBlobSize` to BlobDownloader |
| `src/azure/client.ts` | 11.4 | Add `downloadToFileStreaming()` method |
| `src/sync/downloader.ts` | 11.5 | Add `maxBlobSize` constructor param, route large blobs to streaming |
| `src/types/index.ts` | 11.2 | Add `WatchResult` interface, re-export watch types |
| `src/index.ts` | 11.9 | Export `watchAzureVenv`, `WatchOptions`, `WatchChangeEvent`, `WatchResult` |
| `package.json` | 11.8.3 | Add `commander` dependency, add `bin` entry, bump version |

---

### 11.11 Cross-Module Dependency Map (v1.1 Additions)

```
src/config/types.ts (WatchOptions, WatchChangeEvent)
  ^
  |-- src/watch/watcher.ts (imports WatchOptions, WatchChangeEvent)
  |-- src/watch/index.ts (imports WatchOptions)
  |-- src/cli/index.ts (imports WatchOptions via watchAzureVenv)

src/types/index.ts (WatchResult)
  ^
  |-- src/watch/watcher.ts (imports WatchResult)
  |-- src/watch/index.ts (imports WatchResult)

src/azure/client.ts (downloadToFileStreaming)
  ^
  |-- src/sync/downloader.ts (calls downloadToFileStreaming for large blobs)

src/watch/watcher.ts (BlobWatcher)
  ^
  |-- src/watch/index.ts (creates and starts BlobWatcher)

src/watch/index.ts (watchAzureVenv)
  ^
  |-- src/index.ts (re-exports)
  |-- src/cli/index.ts (calls watchAzureVenv)
```

---

### 11.12 Parallel Implementation Guide

The following work streams can be executed independently by separate coding agents:

**Agent 1: Configuration + Manifest Fix (Sections 11.1, 11.2, 11.3, 11.6)**
- Modify `src/config/types.ts` (remove manifestPath, add new fields and types)
- Modify `src/config/validator.ts` (add Zod fields, update config builder)
- Modify `src/initialize.ts` (hardcode manifest path, add maxBlobSize param)
- Modify `src/types/index.ts` (add WatchResult, re-exports)
- **No dependencies on other agents.**

**Agent 2: Streaming Download (Sections 11.4, 11.5)**
- Modify `src/azure/client.ts` (add downloadToFileStreaming method)
- Modify `src/sync/downloader.ts` (add maxBlobSize, threshold routing)
- **Depends on Agent 1** for `maxBlobSize` in AzureVenvConfig. Can start the client.ts work immediately; downloader.ts constructor change needs Agent 1's type change.

**Agent 3: Watch Module (Section 11.7)**
- Create `src/watch/watcher.ts`
- Create `src/watch/index.ts`
- **Depends on Agent 1** for WatchOptions, WatchChangeEvent, WatchResult types and maxBlobSize/pollInterval in config.

**Agent 4: CLI + Public API (Sections 11.8, 11.9)**
- Create `src/cli/index.ts`
- Modify `src/index.ts`
- Modify `package.json`
- **Depends on Agent 1** (types) and **Agent 3** (watchAzureVenv function).

---

### 11.13 Backwards Compatibility Analysis

| Change | Breaking? | Impact |
|--------|-----------|--------|
| Remove `manifestPath` from `AzureVenvOptions` | **Yes (TypeScript only)** | TS callers explicitly passing `manifestPath` get compile error. JS callers unaffected. |
| Remove `manifestPath` from `AzureVenvConfig` | No | Internal only, not used by consumers. |
| Add `maxBlobSize` to `BlobDownloader` constructor | No | Internal only, not a public API. |
| Add `watchAzureVenv()` export | No | Additive -- new function. |
| Add `WatchOptions`, `WatchChangeEvent`, `WatchResult` types | No | Additive -- new types. |
| Add `commander` dependency | No | Increases install size, acceptable for CLI. |
| `initAzureVenv()` signature unchanged | No | `initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult>` -- no change. |
| New env vars have defaults | No | Existing deployments without new env vars work unchanged. |

**Verdict:** The only breaking change is `manifestPath` removal from `AzureVenvOptions`. This is intentional and documented.

---

### 11.14 Design Decision: Orphan File Cleanup -- NOT IN SCOPE

Orphan files are local files that exist in the sync manifest but no longer exist in Azure Blob Storage. Watch mode detects deletions by comparing the manifest against the current blob list but does **NOT** delete local files. Deleted blobs are removed from the manifest only.

**Rationale:** Automatic file deletion is a destructive operation that risks data loss if the blob listing is temporarily incomplete (e.g., Azure outage, prefix misconfiguration). Users who need orphan cleanup should implement it in their `onChange` callback using the `deleted` array from `WatchChangeEvent`.

---

### 11.15 New Module Structure (v1.1)

```
src/
  index.ts                    # Public API barrel (+ watchAzureVenv, watch types)
  initialize.ts               # initAzureVenv orchestrator (manifest path hardcoded)
  config/
    parser.ts                 # AZURE_VENV URL parser
    validator.ts              # Zod validation (+ 3 new env vars, - manifestPath)
    types.ts                  # Config types (+ WatchOptions, WatchChangeEvent, - manifestPath)
  azure/
    client.ts                 # AzureVenvBlobClient (+ downloadToFileStreaming)
    types.ts                  # BlobInfo, BlobClientConfig, BlobDownloadResult
  sync/
    engine.ts                 # SyncEngine (unchanged)
    downloader.ts             # BlobDownloader (+ maxBlobSize threshold routing)
    manifest.ts               # ManifestManager (unchanged)
    path-validator.ts         # validateAndResolvePath (unchanged)
  watch/                      # NEW MODULE
    watcher.ts                # BlobWatcher class (polling logic)
    index.ts                  # watchAzureVenv() public function
  cli/                        # NEW MODULE
    index.ts                  # Commander.js CLI entry point
  env/
    loader.ts                 # parseEnvFile, parseEnvBuffer (unchanged)
    precedence.ts             # applyPrecedence (unchanged)
  errors/
    index.ts                  # Error barrel (unchanged)
    base.ts                   # AzureVenvError (unchanged)
    config.ts                 # ConfigurationError (unchanged)
    azure.ts                  # AzureConnectionError, AuthenticationError (unchanged)
    sync.ts                   # SyncError, PathTraversalError (unchanged)
  logging/
    logger.ts                 # createLogger, sanitize, Logger (unchanged)
  types/
    index.ts                  # SyncResult, etc. (+ WatchResult, re-exports)
```
