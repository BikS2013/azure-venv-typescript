# Project Functions: azure-venv Library

**Date:** 2026-02-27
**Status:** Draft
**Plan Reference:** [plan-001-azure-venv-library.md](plan-001-azure-venv-library.md), [plan-002-design-decisions-enhancements.md](plan-002-design-decisions-enhancements.md)

---

## 1. Overview

The `azure-venv` library provides a TypeScript-based virtual environment layer that synchronizes files from Azure Blob Storage to a local application root at startup and manages environment variables with a three-tier precedence model.

---

## 2. Functional Requirements

### FR-001: Local Environment Variable Bootstrap

**Priority:** Critical
**Phase:** 5

The library must read a local `.env` file at application root on startup and populate `process.env` with its values. Values already present in `process.env` (OS-level environment variables) must NOT be overridden by local `.env` values.

**Inputs:** Local `.env` file path (defaults to `<appRoot>/.env`)
**Outputs:** `process.env` populated with local `.env` values (non-overriding)
**Error Behavior:** If the local `.env` file does not exist, proceed silently (this is not an error).

---

### FR-002: Azure VENV Configuration Detection

**Priority:** Critical
**Phase:** 2

After local `.env` loading, the library must check `process.env` for `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN`. If both are present, the library proceeds with Azure Blob Storage synchronization. If either is missing, the library returns early with a no-op result (no error).

**Inputs:** `process.env.AZURE_VENV`, `process.env.AZURE_VENV_SAS_TOKEN`
**Outputs:** Parsed configuration object or early return
**Error Behavior:** If `AZURE_VENV` is present but `AZURE_VENV_SAS_TOKEN` is missing (or vice versa), raise `ConfigurationError`.

---

### FR-003: AZURE_VENV URL Parsing

**Priority:** Critical
**Phase:** 2

The library must parse the `AZURE_VENV` environment variable to extract:
- Storage account URL (e.g., `https://myaccount.blob.core.windows.net`)
- Container name (e.g., `mycontainer`)
- Virtual directory prefix (e.g., `config/production/`), which may be empty

**URL Format:** `https://<account>.blob.core.windows.net/<container>[/<prefix>]`

**Inputs:** `AZURE_VENV` string value
**Outputs:** Account URL, container name, prefix
**Error Behavior:**
- Missing container name: raise `ConfigurationError`
- HTTP scheme (not HTTPS): raise `ConfigurationError`
- Malformed URL: raise `ConfigurationError`

---

### FR-004: SAS Token Validation

**Priority:** Critical
**Phase:** 2

The library must validate the SAS token is non-empty and optionally parse its expiry date (`se` parameter). If the token is expired at startup time, raise `SasTokenExpiredError`. If `AZURE_VENV_SAS_EXPIRY` is configured, use it for proactive expiry warnings.

**Inputs:** `AZURE_VENV_SAS_TOKEN`, optional `AZURE_VENV_SAS_EXPIRY`
**Outputs:** Validated SAS token, expiry date (if parseable)
**Error Behavior:**
- Empty SAS token: raise `ConfigurationError`
- Expired SAS token: raise `SasTokenExpiredError`
- Near-expiry SAS token (within 24 hours): log warning

---

### FR-005: Azure Blob Storage Connection

**Priority:** Critical
**Phase:** 4

The library must connect to Azure Blob Storage using the parsed account URL, container name, and SAS token. The connection must use HTTPS exclusively.

**Inputs:** Account URL, container name, SAS token
**Outputs:** Connected blob client
**Error Behavior:**
- Network unreachable: raise `BlobStorageError` (if `failOnError: true`) or log warning and return
- Authentication failure (403): raise `SasTokenExpiredError` or `BlobStorageError`
- Container not found (404): raise `BlobStorageError`

---

### FR-006: Blob Listing

**Priority:** Critical
**Phase:** 4

The library must list all blobs in the container (or under the specified prefix) using flat listing. For each blob, retrieve: name, ETag, lastModified timestamp, and content length.

**Inputs:** Container client, prefix filter
**Outputs:** Async iterable of blob metadata objects
**Error Behavior:** Propagate Azure SDK errors as `BlobStorageError`

---

### FR-007: Remote .env Priority Download

**Priority:** Critical
**Phase:** 6, 7

If a `.env` file exists in the blob storage path (at the root of the prefix), the library must download it FIRST, before any other files. The content must be parsed and applied to `process.env` following the three-tier precedence model.

**Inputs:** Blob storage `.env` file content
**Outputs:** `process.env` updated with remote `.env` values
**Precedence:** OS env vars (highest) > remote `.env` > local `.env` (lowest)
**Error Behavior:** If remote `.env` download fails and `failOnError: true`, throw. Otherwise, log warning and continue.

---

### FR-008: Three-Tier Environment Variable Precedence

**Priority:** Critical
**Phase:** 5

Environment variables must follow this deterministic precedence (highest to lowest):

1. **OS environment variables** -- already in `process.env` before library initialization
2. **Remote `.env`** -- downloaded from Azure Blob Storage
3. **Local `.env`** -- read from application root filesystem

A variable set at a higher tier must never be overridden by a lower tier.

**Inputs:** OS env snapshot, remote `.env` parsed values, local `.env` parsed values
**Outputs:** Merged `process.env`
**Traceability:** The library must track which source provided each variable (for debug logging)

---

### FR-009: File Synchronization

**Priority:** Critical
**Phase:** 6

The library must download all blobs from the Azure Blob Storage path to the local application root, creating necessary subdirectories. Blob name prefixes are stripped to create relative local paths.

**Example:** If `AZURE_VENV` points to `https://account.blob.core.windows.net/container/config/prod/`, and a blob named `config/prod/settings/db.json` exists, it must be downloaded to `<appRoot>/settings/db.json`.

**Inputs:** Blob list, app root directory, concurrency setting
**Outputs:** Files written to local filesystem; `SyncResult` statistics
**Error Behavior:** Individual blob download failures are recorded but do not abort the sync. Failed blobs are listed in `SyncResult.failedBlobs`.

---

### FR-010: Incremental Sync (ETag-Based)

**Priority:** High
**Phase:** 6

On subsequent startups, the library must compare blob ETags against a local manifest file (`.azure-venv-manifest.json`). Only blobs with changed ETags are downloaded. The manifest records: blob name, ETag, lastModified, contentLength, localPath, syncTimestamp.

**Sync Modes:**
- `full`: Download all blobs regardless of manifest
- `incremental`: Download only changed blobs (ETag mismatch)

**Inputs:** Manifest file, current blob ETags
**Outputs:** Updated manifest, only changed files downloaded
**Error Behavior:** If manifest is corrupted or missing, fall back to full sync.

---

### FR-011: Path Traversal Prevention

**Priority:** Critical
**Phase:** 6

The library must validate all blob names to prevent path traversal attacks. A malicious blob named `../../etc/passwd` must not result in writes outside the application root.

**Two-layer defense:**
1. Reject blob names containing `..` or absolute path components
2. After resolving the full path, verify it starts with the application root path

**Inputs:** Blob name, application root
**Outputs:** Validated absolute local file path
**Error Behavior:** Raise `PathTraversalError` for any traversal attempt. The offending blob is skipped (not downloaded).

---

### FR-012: SAS Token Sanitization

**Priority:** Critical
**Phase:** 3

SAS tokens and full SAS URLs must NEVER appear in log output, error messages, or exception stack traces. All URLs must be sanitized to replace SAS query parameters with `[SAS_REDACTED]` before any output.

**Applies to:** Logger output, error message construction, `RestError` wrapping, `SyncResult` output

---

### FR-013: Configurable Error Behavior

**Priority:** High
**Phase:** 7

The library must support two error modes via `AZURE_VENV_FAIL_ON_ERROR`:
- `true` (strict): Any Azure connectivity or sync error throws, preventing application startup
- `false` (resilient, default): Errors are logged as warnings; the application continues with local files only

**Inputs:** `AZURE_VENV_FAIL_ON_ERROR` environment variable
**Outputs:** Throw or log-and-continue behavior

---

### FR-014: Concurrent Downloads

**Priority:** High
**Phase:** 6

The library must support parallel blob downloads with a configurable concurrency limit (default: 5). Downloads must use a semaphore pattern to prevent resource exhaustion.

**Inputs:** `AZURE_VENV_CONCURRENCY` environment variable
**Outputs:** Blobs downloaded in parallel, up to concurrency limit

---

### FR-015: Sync Result Reporting

**Priority:** Medium
**Phase:** 6, 7

The library must return a `SyncResult` object containing:
- `totalBlobs`: Total number of blobs found in storage
- `downloaded`: Number of blobs downloaded
- `skipped`: Number of blobs skipped (unchanged per manifest)
- `failed`: Number of blobs that failed to download
- `failedBlobs`: List of failed blob names
- `duration`: Total sync duration in milliseconds
- `envSource`: Which tier provided each environment variable

---

### FR-016: Structured Logging

**Priority:** Medium
**Phase:** 3

The library must provide structured log output with configurable log levels (`debug`, `info`, `warn`, `error`). Log format: `[azure-venv] [LEVEL] [timestamp] message`. All log output must pass through the SAS token sanitizer.

**Inputs:** `AZURE_VENV_LOG_LEVEL` environment variable
**Outputs:** Console log output at or above the configured level

---

### FR-017: SAS Token Expiry Warning

**Priority:** Medium
**Phase:** 2, 4

The library must proactively detect SAS token expiry:
1. Parse the `se` (signed expiry) parameter from the SAS token
2. If `AZURE_VENV_SAS_EXPIRY` is set, use it as the expiry date
3. If the token expires within 24 hours, log a warning
4. If the token is already expired, raise `SasTokenExpiredError`

---

### FR-018: Polling-Based Blob Watch Mode

**Priority:** High
**Phase:** Plan 002 - Phase 3
**Plan Reference:** [plan-002-design-decisions-enhancements.md](plan-002-design-decisions-enhancements.md)

After initial sync, the library must support continuous polling-based blob change detection. On each poll cycle:
1. Call `listBlobsFlat(prefix)` to get the current blob list with ETags
2. Compare each blob's ETag against the local manifest
3. Download blobs where ETag differs (changed or new)
4. Detect deleted blobs (present in manifest but absent from remote)
5. Update the manifest
6. If the remote `.env` changed, re-apply the three-tier precedence logic using the original OS env snapshot
7. Invoke the `onChange` callback with a `WatchChangeEvent`

**Inputs:** `AzureVenvConfig` (from initial sync), `WatchOptions` (pollInterval, callbacks)
**Outputs:** `WatchResult` with `stop()` method
**Configuration:**
- `AZURE_VENV_POLL_INTERVAL`: Polling interval in ms (default: 30000, min: 5000)
- `AZURE_VENV_WATCH_ENABLED`: Enable watch mode (default: `'false'`)
**Error Behavior:** Individual poll cycle failures invoke the `onError` callback but do not stop the watcher. The next poll cycle proceeds normally.

---

### FR-019: Watch Mode Graceful Shutdown

**Priority:** High
**Phase:** Plan 002 - Phase 3

The watch mode must handle `SIGINT` (Ctrl+C) and `SIGTERM` (container stop) gracefully:
1. Stop scheduling future poll cycles (`clearInterval`)
2. Abort in-flight HTTP requests via `AbortController`
3. Wait for the currently running poll to finish (with a 10-second safety timeout)
4. The `stop()` method returns a Promise that resolves when cleanup is complete

**Inputs:** OS signals (SIGINT, SIGTERM) or explicit `stop()` call
**Outputs:** Clean shutdown, no leaked intervals or hanging HTTP requests

---

### FR-020: Watch Mode Environment Re-Application

**Priority:** High
**Phase:** Plan 002 - Phase 3

When watch mode detects that the remote `.env` blob has changed (ETag mismatch):
1. Download the new remote `.env` to a buffer
2. Parse it with the existing env parser
3. Re-apply three-tier precedence: OS env > remote .env > local .env
4. The OS environment snapshot taken at initialization must be reused (never overwritten)
5. Update `process.env` for variables that changed

**Inputs:** Changed remote `.env` buffer, OS env snapshot (from initial startup)
**Outputs:** Updated `process.env`
**Constraint:** OS environment variables captured in `osEnvSnapshot` must always remain dominant across all watch cycles.

---

### FR-021: CLI Sync Command

**Priority:** High
**Phase:** Plan 002 - Phase 4

The library must provide a CLI command `azure-venv sync` that performs a one-time synchronization by calling `initAzureVenv()` internally.

**CLI Options:**
- `--root-dir <path>`: Application root directory (default: cwd)
- `--env-path <path>`: Path to local .env file (default: .env)
- `--sync-mode <mode>`: full | incremental (default: full)
- `--concurrency <n>`: Parallel downloads (default: 5)
- `--log-level <level>`: debug | info | warn | error (default: info)
- `--fail-on-error`: Exit with code 1 on sync errors
- `--json`: Output result as JSON

**Outputs:** Human-readable sync summary (or JSON with `--json` flag)
**Exit Codes:** 0 (success), 1 (error with `--fail-on-error`), 2 (invalid arguments)

---

### FR-022: CLI Watch Command

**Priority:** High
**Phase:** Plan 002 - Phase 4

The library must provide a CLI command `azure-venv watch` that starts continuous polling by calling `watchAzureVenv()` internally.

**CLI Options:** Inherits all sync options plus:
- `--poll-interval <ms>`: Polling interval in milliseconds (default: 30000)

**Outputs:** Change events printed to stdout on each poll cycle (human-readable or JSON)
**Exit Codes:** 0 (clean shutdown via SIGINT/SIGTERM), 1 (fatal error), 130 (SIGINT convention)

---

### FR-023: Fixed Manifest Location

**Priority:** Medium
**Phase:** Plan 002 - Phase 1

The sync manifest file must always be located at `<rootDir>/.azure-venv-manifest.json`. The `manifestPath` option is removed from `AzureVenvOptions` and `AzureVenvConfig`. The manifest path is computed as `path.resolve(rootDir, '.azure-venv-manifest.json')` and is not configurable.

**Rationale:** A fixed, predictable location is required for watch mode to reliably find and update the manifest. Configurability introduced unnecessary complexity with no practical benefit.

**Backwards Compatibility:** TypeScript callers who explicitly passed `manifestPath` will get a compile-time error (the field no longer exists). JavaScript callers passing `manifestPath` will have it silently ignored.

---

### FR-024: Configurable Blob Size Threshold (Streaming Downloads)

**Priority:** Medium
**Phase:** Plan 002 - Phase 2

Blobs exceeding a configurable size threshold must be downloaded using streaming (`BlobClient.download()` with `stream.pipeline()`) instead of the standard `downloadToFile()` method. This prevents excessive memory usage for large files.

**Configuration:**
- `AZURE_VENV_MAX_BLOB_SIZE`: Threshold in bytes (default: 104857600 = 100 MB, min: 1048576 = 1 MB)
- Programmatic: `maxBlobSize` in `AzureVenvOptions`

**Behavior:**
- `blob.contentLength > maxBlobSize`: Use streaming download (`download()` + `pipeline()` + `createWriteStream()`)
- `blob.contentLength <= maxBlobSize`: Use existing `downloadToFile()` method

**Inputs:** Blob content length (from `BlobInfo`), `maxBlobSize` config
**Outputs:** File written to disk (same result regardless of download method)
**Error Behavior:** Streaming download errors are translated through the same error handling as `downloadToFile()`.

---

### FR-025: Orphan File Management (NOT IN SCOPE)

**Priority:** N/A (Decision documented)
**Phase:** Plan 002 - Phase 5

**Decision:** Orphan file cleanup is NOT in scope for this version.

Orphan files are local files that exist in the sync manifest but no longer exist in Azure Blob Storage. Watch mode detects deletions by comparing the manifest against the current blob list, but does NOT delete local files. Deleted blobs are removed from the manifest only.

**Rationale:** Automatic file deletion is a destructive operation that risks data loss if the blob listing is temporarily incomplete (e.g., Azure outage, prefix misconfiguration). Users who need orphan cleanup should implement it in their `onChange` callback using the `deleted` array from `WatchChangeEvent`.

---

## 3. Non-Functional Requirements

### NFR-001: Cross-Platform Compatibility

The library must work on Windows, macOS, and Linux. All file path operations must use `path.join()` and `path.resolve()`.

### NFR-002: Node.js Version

Minimum Node.js 18.x LTS (to match `@azure/storage-blob` SDK requirement).

### NFR-003: TypeScript Strict Mode

All code must compile under TypeScript strict mode with no `any` types in public APIs.

### NFR-004: No Fallback Configuration Values

Required configuration parameters (`AZURE_VENV`, `AZURE_VENV_SAS_TOKEN`) must never have fallback or default values. Missing required configuration must raise `ConfigurationError`.

### NFR-005: Test Coverage

Unit test coverage must exceed 80%. Integration tests must cover the core sync flow.

### NFR-006: Package Size

The library should have minimal dependencies. Core dependencies: `@azure/storage-blob`, `dotenv`, `zod`.

### NFR-007: Startup Performance

The sync process should support configurable timeouts and concurrency to avoid unbounded startup delays.

### NFR-008: CLI Dependency Minimalism

The CLI framework (`commander`) must have zero transitive dependencies to minimize the library's install footprint.

### NFR-009: Backwards Compatibility

The public API `initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult>` must remain backwards-compatible. New features are exposed through additive APIs (`watchAzureVenv`, CLI) and optional configuration fields.

---

## 4. Feature Traceability

| Feature ID | Description | Plan Phase | Module |
|---|---|---|---|
| FR-001 | Local .env bootstrap | Phase 5 | env-loader |
| FR-002 | Config detection | Phase 2 | config-parser |
| FR-003 | URL parsing | Phase 2 | config-parser |
| FR-004 | SAS token validation | Phase 2 | config-parser |
| FR-005 | Blob storage connection | Phase 4 | blob-client |
| FR-006 | Blob listing | Phase 4 | blob-client |
| FR-007 | Remote .env priority | Phase 6, 7 | sync-engine, orchestrator |
| FR-008 | Three-tier precedence | Phase 5 | env-loader |
| FR-009 | File synchronization | Phase 6 | sync-engine |
| FR-010 | Incremental sync | Phase 6 | manifest, sync-engine |
| FR-011 | Path traversal prevention | Phase 6 | path-validator |
| FR-012 | SAS token sanitization | Phase 3 | sanitizer, logger |
| FR-013 | Error behavior config | Phase 7 | orchestrator |
| FR-014 | Concurrent downloads | Phase 6 | sync-engine |
| FR-015 | Sync result reporting | Phase 6, 7 | sync-engine, orchestrator |
| FR-016 | Structured logging | Phase 3 | logger |
| FR-017 | SAS expiry warning | Phase 2, 4 | config-parser, blob-client |
| FR-018 | Polling-based watch mode | Plan 002 Phase 3 | watch/watcher |
| FR-019 | Watch graceful shutdown | Plan 002 Phase 3 | watch/watcher |
| FR-020 | Watch env re-application | Plan 002 Phase 3 | watch/watcher, env/precedence |
| FR-021 | CLI sync command | Plan 002 Phase 4 | cli/index |
| FR-022 | CLI watch command | Plan 002 Phase 4 | cli/index |
| FR-023 | Fixed manifest location | Plan 002 Phase 1 | config/types, config/validator, initialize |
| FR-024 | Streaming downloads (large blobs) | Plan 002 Phase 2 | azure/client, sync/downloader |
| FR-025 | Orphan files (NOT IN SCOPE) | Plan 002 Phase 5 | N/A (documentation only) |
