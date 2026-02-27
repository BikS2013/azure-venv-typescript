# Plan 001: azure-venv Library Implementation

**Date:** 2026-02-27
**Status:** Draft
**Based on:** [Investigation: Azure Virtual Environment Library](../reference/investigation-azure-venv-library.md)

---

## 1. Objective

Build a TypeScript library (`azure-venv`) that, at application startup, synchronizes files from Azure Blob Storage to the local application root and loads remote environment variables into `process.env` with a deterministic three-tier precedence model.

---

## 2. High-Level Architecture

```
azure-venv/
  src/
    index.ts                  # Public API and orchestrator
    errors.ts                 # Custom error classes
    config/
      config-parser.ts        # AZURE_VENV URL parsing and validation
      config-types.ts         # Configuration interfaces and Zod schemas
    azure/
      blob-client.ts          # Azure Blob Storage client wrapper
      blob-types.ts           # Blob-related interfaces
    sync/
      sync-engine.ts          # Filesystem sync orchestration
      manifest.ts             # Sync manifest (ETags, timestamps)
      path-validator.ts       # Path traversal prevention
      sync-types.ts           # Sync-related interfaces
    env/
      env-loader.ts           # .env file parsing and precedence logic
      env-types.ts            # Env-related interfaces
    utils/
      logger.ts               # Logging with SAS token sanitization
      sanitizer.ts            # URL/token sanitization utilities
  __tests__/
    unit/
      config-parser.test.ts
      blob-client.test.ts
      sync-engine.test.ts
      manifest.test.ts
      path-validator.test.ts
      env-loader.test.ts
      logger.test.ts
      sanitizer.test.ts
    integration/
      azure-venv.integration.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
  .eslintrc.json
  .gitignore
```

---

## 3. Implementation Phases

### Phase 0: Project Scaffolding

**Description:** Initialize the TypeScript project with tooling and dependencies.

**Tasks:**
1. Initialize `package.json` with project metadata
2. Configure `tsconfig.json` (strict mode, ESM output, declaration files)
3. Install dependencies: `@azure/storage-blob`, `dotenv`, `zod`
4. Install dev dependencies: `vitest`, `typescript`, `eslint`, `@types/node`
5. Configure `vitest.config.ts`
6. Configure `.eslintrc.json`
7. Create `.gitignore` (node_modules, dist, .env, .azure-venv-manifest.json)

**Dependencies:** None
**Parallelizable:** No (must complete before all other phases)

**Files Created:**
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.eslintrc.json`
- `.gitignore`

**Acceptance Criteria:**
- `npm install` succeeds
- `npx tsc --noEmit` succeeds on an empty `src/index.ts`
- `npx vitest run` succeeds with zero tests

---

### Phase 1: Error Handling Module

**Description:** Define all custom error classes used across the library. This module has no internal dependencies and is consumed by every other module.

**Tasks:**
1. Create `AzureVenvError` base class extending `Error`
2. Create `ConfigurationError` for missing/invalid configuration
3. Create `BlobStorageError` for Azure connectivity and download failures
4. Create `PathTraversalError` for path security violations
5. Create `SyncError` for filesystem sync failures
6. Create `SasTokenExpiredError` for expired SAS tokens
7. Create `EnvLoadError` for environment variable loading failures
8. All error classes must include a `code` property for programmatic error handling
9. Write unit tests

**Dependencies:** Phase 0
**Parallelizable with:** Phases 2, 3, 4, 5 (after Phase 0)

**Files Created:**
- `src/errors.ts`
- `__tests__/unit/errors.test.ts`

**Acceptance Criteria:**
- All error classes extend `AzureVenvError`
- Each error has a unique `code` string property
- Error messages never contain raw SAS tokens
- All unit tests pass

---

### Phase 2: Configuration Parsing Module

**Description:** Parse and validate the `AZURE_VENV` URL format and `AZURE_VENV_SAS_TOKEN`. Extract account URL, container name, and blob prefix from the URL. Validate all configuration using Zod schemas. Raise exceptions for any missing required configuration -- no fallback values.

**Tasks:**
1. Define `AzureVenvConfig` interface and Zod schema in `config-types.ts`
2. Implement URL parser that extracts: account URL, container name, prefix
3. Validate HTTPS scheme (reject HTTP)
4. Validate SAS token is non-empty string
5. Parse SAS token expiry (`se` parameter) for proactive warning
6. Implement `AZURE_VENV_SAS_EXPIRY` parameter support for explicit expiry tracking
7. Raise `ConfigurationError` for any missing required parameter (AZURE_VENV, AZURE_VENV_SAS_TOKEN) -- never use fallback values
8. For optional parameters (AZURE_VENV_SYNC_MODE, AZURE_VENV_CONCURRENCY, etc.) raise `ConfigurationError` if provided but invalid; use documented defaults only when not provided at all
9. Write unit tests covering: valid URLs, missing container, HTTP rejection, empty SAS token, expired SAS detection

**Dependencies:** Phase 0, Phase 1 (for error classes)
**Parallelizable with:** Phase 3, Phase 4, Phase 5 (all independent modules)

**Files Created:**
- `src/config/config-types.ts`
- `src/config/config-parser.ts`
- `__tests__/unit/config-parser.test.ts`

**Configuration Parameters:**

| Variable | Required | Validation | Default |
|---|---|---|---|
| `AZURE_VENV` | Yes | Valid HTTPS URL with container name | Exception if missing |
| `AZURE_VENV_SAS_TOKEN` | Yes | Non-empty string | Exception if missing |
| `AZURE_VENV_SAS_EXPIRY` | Recommended | ISO 8601 datetime | None (warns if absent) |
| `AZURE_VENV_SYNC_MODE` | No | `"full"` or `"incremental"` | `"full"` |
| `AZURE_VENV_FAIL_ON_ERROR` | No | `"true"` or `"false"` | `"false"` |
| `AZURE_VENV_CONCURRENCY` | No | Positive integer string | `"5"` |
| `AZURE_VENV_TIMEOUT` | No | Positive integer string (ms) | `"30000"` |
| `AZURE_VENV_LOG_LEVEL` | No | `"debug"`, `"info"`, `"warn"`, `"error"` | `"info"` |

**Note on defaults:** Optional parameters have defaults because they are operational tuning knobs, not security-critical configuration. The two required parameters (`AZURE_VENV`, `AZURE_VENV_SAS_TOKEN`) must always be explicitly provided.

**Acceptance Criteria:**
- URL parser correctly extracts account, container, prefix from all documented formats
- HTTP URLs are rejected with `ConfigurationError`
- Missing `AZURE_VENV` or `AZURE_VENV_SAS_TOKEN` raises `ConfigurationError`
- SAS expiry is correctly parsed from the token's `se` parameter
- Zod schema validates all fields correctly
- All unit tests pass

---

### Phase 3: Utility Modules (Logger and Sanitizer)

**Description:** Implement logging infrastructure with SAS token sanitization. The logger must never output raw SAS tokens or sensitive credentials.

**Tasks:**
1. Implement `sanitizer.ts`: functions to redact SAS tokens from URLs and strings
2. Implement `logger.ts`: structured logger with configurable log levels
3. Logger must sanitize all output through the sanitizer before emitting
4. Support log levels: `debug`, `info`, `warn`, `error`
5. Log output format: `[azure-venv] [LEVEL] [timestamp] message`
6. Write unit tests: verify SAS tokens are redacted, log levels filter correctly

**Dependencies:** Phase 0
**Parallelizable with:** Phases 1, 2, 4, 5

**Files Created:**
- `src/utils/logger.ts`
- `src/utils/sanitizer.ts`
- `__tests__/unit/logger.test.ts`
- `__tests__/unit/sanitizer.test.ts`

**Acceptance Criteria:**
- `sanitizeSasUrl()` replaces SAS query parameters with `[SAS_REDACTED]`
- Logger never outputs strings containing SAS signatures
- Log level filtering works correctly (e.g., `warn` suppresses `debug` and `info`)
- All unit tests pass

---

### Phase 4: Azure Blob Client Module

**Description:** Wrap the `@azure/storage-blob` SDK into a focused client that supports listing blobs and downloading them. Handle authentication with SAS tokens, retry logic, and error translation.

**Tasks:**
1. Define `BlobInfo` and `BlobClientOptions` interfaces in `blob-types.ts`
2. Implement `AzureVenvBlobClient` class in `blob-client.ts`:
   - Constructor accepts account URL, container name, SAS token
   - `listBlobs(prefix: string): AsyncGenerator<BlobInfo>` - flat listing with prefix
   - `downloadToFile(blobName: string, localPath: string): Promise<void>` - download blob to disk
   - `downloadToBuffer(blobName: string): Promise<Buffer>` - download blob to memory (for .env files)
   - `getBlobProperties(blobName: string): Promise<BlobProperties>` - get metadata/ETag
3. Configure SDK retry policy via `StoragePipelineOptions`
4. Translate SDK `RestError` into library-specific errors (`BlobStorageError`, `SasTokenExpiredError`)
5. Validate SAS token is not expired before making requests (proactive check)
6. Write unit tests with mocked SDK

**Dependencies:** Phase 0, Phase 1 (errors), Phase 3 (logger/sanitizer)
**Parallelizable with:** Phase 2, Phase 5 (once Phase 1 and Phase 3 are done)

**Files Created:**
- `src/azure/blob-types.ts`
- `src/azure/blob-client.ts`
- `__tests__/unit/blob-client.test.ts`

**Acceptance Criteria:**
- `listBlobs()` returns all blobs with correct metadata (name, ETag, lastModified, contentLength)
- `downloadToFile()` writes blob content to specified local path
- `downloadToBuffer()` returns blob content as Buffer
- 403 errors are translated to `SasTokenExpiredError` when SAS is expired
- Network errors are translated to `BlobStorageError`
- SAS tokens never appear in error messages or logs
- All unit tests pass (with mocked SDK)

---

### Phase 5: Environment Loader Module

**Description:** Implement the three-tier environment variable loading system. This module handles parsing `.env` files and applying values to `process.env` with the correct precedence.

**Tasks:**
1. Define `EnvLoadResult` interface in `env-types.ts`
2. Implement `loadLocalEnv(envPath: string): Record<string, string>` - parse local `.env` without overriding existing env vars
3. Implement `loadRemoteEnv(content: Buffer): Record<string, string>` - parse remote `.env` content
4. Implement `applyEnvWithPrecedence(local: Record, remote: Record, osEnvKeys: string[]): void` - apply three-tier precedence to `process.env`
5. Precedence: OS env vars (highest) > remote .env > local .env (lowest)
6. Track which variables were loaded from which source (for logging/debugging)
7. Write unit tests covering: precedence logic, empty files, malformed entries, OS override behavior

**Dependencies:** Phase 0, Phase 1 (errors)
**Parallelizable with:** Phase 2, Phase 3, Phase 4

**Files Created:**
- `src/env/env-types.ts`
- `src/env/env-loader.ts`
- `__tests__/unit/env-loader.test.ts`

**Acceptance Criteria:**
- Local `.env` values do NOT override pre-existing `process.env` variables
- Remote `.env` values override local `.env` values but NOT OS-set variables
- OS environment variables always take highest priority
- Load result tracks source of each variable
- Missing `.env` file does not throw (returns empty record)
- Malformed lines are skipped with warning log
- All unit tests pass

---

### Phase 6: Filesystem Sync Module

**Description:** Implement the sync engine that downloads blobs to the local filesystem, manages the sync manifest, and validates paths.

**Tasks:**
1. Implement `path-validator.ts`:
   - `validateAndResolvePath(rootDir, blobName): string` - two-layer path traversal defense
   - Reject blob names containing `..`, absolute paths, or URL-encoded traversal sequences
2. Implement `manifest.ts`:
   - `SyncManifest` class that reads/writes `.azure-venv-manifest.json`
   - Track per-blob: name, ETag, lastModified, contentLength, localPath, syncTimestamp
   - `needsUpdate(blobName, remoteETag): boolean` - check if blob changed
   - `recordSync(blobName, metadata): void` - record successful download
3. Implement `sync-engine.ts`:
   - `SyncEngine` class that orchestrates the full sync process
   - Accept blob client, manifest, path validator, logger, and config
   - List all remote blobs
   - Compare against manifest (incremental mode) or skip comparison (full mode)
   - Download changed/new blobs with configurable concurrency (use `Promise.allSettled` + semaphore)
   - Special handling: download `.env` file first and separately (consumed by env-loader)
   - Return `SyncResult` with statistics
4. Define `SyncResult` interface in `sync-types.ts`
5. Write unit tests with mocked blob client

**Dependencies:** Phase 0, Phase 1 (errors), Phase 3 (logger), Phase 4 (blob client interface/types)
**Parallelizable with:** Phase 5 (partially, once shared types are defined)

**Files Created:**
- `src/sync/sync-types.ts`
- `src/sync/path-validator.ts`
- `src/sync/manifest.ts`
- `src/sync/sync-engine.ts`
- `__tests__/unit/path-validator.test.ts`
- `__tests__/unit/manifest.test.ts`
- `__tests__/unit/sync-engine.test.ts`

**Acceptance Criteria:**
- Path traversal attempts (`../`, absolute paths, encoded sequences) are rejected with `PathTraversalError`
- Manifest correctly persists and reads sync metadata
- Incremental sync skips blobs with matching ETags
- Full sync downloads all blobs regardless of manifest
- `.env` blob is downloaded first and its content is returned separately
- Concurrency limit is respected (no more than N parallel downloads)
- `SyncResult` accurately reports total, downloaded, skipped, and failed counts
- Failed individual blob downloads do not abort the entire sync
- All unit tests pass

---

### Phase 7: Main Orchestrator

**Description:** Implement the public API (`initAzureVenv()`) that ties all modules together in the correct execution order.

**Tasks:**
1. Implement `initAzureVenv(options?: InitOptions): Promise<SyncResult>` in `index.ts`
2. Execution sequence:
   ```
   Step 1: Load local .env (env-loader) -- populates AZURE_VENV, AZURE_VENV_SAS_TOKEN
   Step 2: Parse and validate configuration (config-parser)
   Step 3: Check SAS token expiry -- warn if near expiration
   Step 4: Create blob client (blob-client)
   Step 5: Run sync engine to get remote .env content (sync-engine -- .env first)
   Step 6: If remote .env found, apply with precedence (env-loader)
   Step 7: Continue sync for remaining files (sync-engine)
   Step 8: Return SyncResult
   ```
3. Handle `failOnError` configuration:
   - `true`: any Azure error aborts startup (throws)
   - `false`: Azure errors are logged, app continues with local files
4. Export all public types from `index.ts`
5. Write unit tests for orchestration logic with fully mocked dependencies
6. Export `InitOptions`, `SyncResult`, and error classes from package entry point

**Dependencies:** All previous phases (0-6)
**Parallelizable:** No (integration phase)

**Files Created/Modified:**
- `src/index.ts` (main implementation)
- `__tests__/unit/index.test.ts`

**Acceptance Criteria:**
- Full startup sequence executes in correct order
- Remote `.env` is loaded before other files are synced
- Environment precedence is correctly applied (OS > remote > local)
- `failOnError: true` throws on Azure errors
- `failOnError: false` logs and continues on Azure errors
- If `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` are not found after local .env load, the function returns early with a no-op result (no error -- azure-venv is simply not configured)
- `SyncResult` is returned with complete statistics
- All public types are exported
- All unit tests pass

---

### Phase 8: Integration Testing

**Description:** Write integration tests that exercise the full library against a real or emulated Azure Blob Storage.

**Tasks:**
1. Set up Azurite (Azure Storage Emulator) for local integration testing
2. Create test fixtures: sample blobs, .env files, nested directory structures
3. Write integration tests:
   - Full sync from empty state
   - Incremental sync (only changed files downloaded)
   - Remote .env loading with precedence
   - Path traversal rejection
   - SAS token expiry handling
   - Network failure recovery (failOnError modes)
   - Concurrent download behavior
4. Add npm script for integration tests (separate from unit tests)

**Dependencies:** Phase 7
**Parallelizable:** No

**Files Created:**
- `__tests__/integration/azure-venv.integration.test.ts`
- `__tests__/integration/fixtures/` (test data)
- `docker-compose.test.yml` (Azurite container)

**Acceptance Criteria:**
- All integration tests pass against Azurite
- Tests cover: first sync, incremental sync, .env precedence, error scenarios
- Tests are isolated (each test sets up and tears down its own state)
- CI-compatible (Azurite runs in Docker)

---

### Phase 9: Documentation and Packaging

**Description:** Prepare the library for consumption: documentation, package exports, and CLAUDE.md tool entry.

**Tasks:**
1. Write JSDoc comments on all public APIs
2. Configure `package.json` exports (ESM + CJS if needed)
3. Configure `tsconfig.json` to emit declaration files (`.d.ts`)
4. Add build script (`npm run build` -> `tsc`)
5. Update project `CLAUDE.md` with tool documentation in required XML format
6. Create/update `docs/design/project-design.md` with architectural overview
7. Create configuration guide at `docs/design/configuration-guide.md`

**Dependencies:** Phase 7
**Parallelizable with:** Phase 8

**Files Created/Modified:**
- `CLAUDE.md` (updated with tool documentation)
- `docs/design/project-design.md`
- `docs/design/configuration-guide.md`
- `package.json` (build scripts, exports)

**Acceptance Criteria:**
- `npm run build` produces `dist/` with `.js` and `.d.ts` files
- CLAUDE.md contains tool documentation in XML format
- Configuration guide documents all environment variables per global CLAUDE.md spec
- `project-design.md` reflects final architecture

---

## 4. Dependency Graph

```
Phase 0: Project Scaffolding
    |
    +----+----+----+----+
    |    |    |    |    |
    v    v    v    v    v
  Ph1  Ph2  Ph3  Ph4  Ph5
  Err  Cfg  Utl  Blob Env
    |    |    |    |    |
    |    |    +-+--+    |
    |    |      |       |
    |    v      v       |
    |   Ph2*  Ph4*      |
    |  (needs (needs    |
    |   Ph1)  Ph1+Ph3)  |
    |    |      |       |
    +----+------+-------+
         |
         v
       Phase 6: Filesystem Sync
         (needs Ph1, Ph3, Ph4)
         |
         v
       Phase 7: Main Orchestrator
         (needs ALL Ph1-Ph6)
         |
    +----+----+
    |         |
    v         v
  Phase 8   Phase 9
  IntTest   Docs
```

**Parallel execution opportunities:**
- After Phase 0: Phases 1, 3 can start immediately (no cross-dependencies)
- After Phase 1: Phases 2, 5 can start (they need error classes only)
- After Phases 1 + 3: Phase 4 can start
- After Phases 1 + 3 + 4: Phase 6 can start
- Phases 2 and 5 are fully independent of each other and of Phases 3/4/6
- Phase 8 and Phase 9 can run in parallel after Phase 7

---

## 5. Parallel Agent Assignment

The following independent work streams can be assigned to separate agents after Phase 0 completes:

| Agent | Phases | Description | Blocked By |
|---|---|---|---|
| Agent A | Ph1 -> Ph4 -> Ph6 | Error classes, Blob client, Sync engine | Ph0, then Ph3 (for Ph4) |
| Agent B | Ph3 | Logger and Sanitizer utilities | Ph0 |
| Agent C | Ph2 | Configuration parsing | Ph0, Ph1 |
| Agent D | Ph5 | Environment loader | Ph0, Ph1 |
| Agent E | Ph7 | Orchestrator (after all others) | Ph1-Ph6 |
| Agent F | Ph8 + Ph9 | Integration tests + Docs | Ph7 |

**Optimal parallel schedule (critical path in bold):**

```
Time ->  T0          T1           T2           T3            T4          T5
         **Phase 0**
                     **Phase 1**
                     Phase 3      **Phase 2**
                                  Phase 5
                                  **Phase 4**
                                               **Phase 6**
                                                             **Phase 7**
                                                                         Phase 8
                                                                         Phase 9
```

**Critical path:** Ph0 -> Ph1 -> Ph4 -> Ph6 -> Ph7

---

## 6. Files Summary

### New Files to Create

| File | Phase | Purpose |
|---|---|---|
| `package.json` | 0 | Project manifest |
| `tsconfig.json` | 0 | TypeScript configuration |
| `vitest.config.ts` | 0 | Test framework configuration |
| `.eslintrc.json` | 0 | Linting configuration |
| `.gitignore` | 0 | Git ignore rules |
| `src/errors.ts` | 1 | Custom error classes |
| `src/config/config-types.ts` | 2 | Configuration interfaces and Zod schemas |
| `src/config/config-parser.ts` | 2 | URL parsing and config validation |
| `src/utils/logger.ts` | 3 | Structured logger |
| `src/utils/sanitizer.ts` | 3 | SAS token sanitization |
| `src/azure/blob-types.ts` | 4 | Blob-related interfaces |
| `src/azure/blob-client.ts` | 4 | Azure Blob Storage client wrapper |
| `src/env/env-types.ts` | 5 | Env loading interfaces |
| `src/env/env-loader.ts` | 5 | Three-tier env variable loader |
| `src/sync/sync-types.ts` | 6 | Sync-related interfaces |
| `src/sync/path-validator.ts` | 6 | Path traversal prevention |
| `src/sync/manifest.ts` | 6 | Sync manifest management |
| `src/sync/sync-engine.ts` | 6 | Filesystem sync orchestration |
| `src/index.ts` | 7 | Public API and orchestrator |
| `__tests__/unit/*.test.ts` | 1-7 | Unit tests per module |
| `__tests__/integration/*.test.ts` | 8 | Integration tests |
| `docker-compose.test.yml` | 8 | Azurite container for testing |

### Files to Modify

| File | Phase | Change |
|---|---|---|
| `CLAUDE.md` | 9 | Add tool documentation in XML format |
| `docs/design/project-design.md` | 9 | Architectural overview |
| `docs/design/configuration-guide.md` | 9 | Configuration variable documentation |
| `docs/design/project-functions.md` | 0 | Functional requirements |
| `Issues - Pending Items.md` | Ongoing | Track issues as discovered |

---

## 7. Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict mode) | Project requirement |
| Azure SDK | `@azure/storage-blob` ^12.31.0 | Official, actively maintained, TypeScript-native |
| Env parsing | `dotenv` ^16.x | Industry standard, 46M+ weekly downloads |
| Schema validation | `zod` ^3.x | Runtime + compile-time type safety |
| Test framework | `vitest` | Fast, TypeScript-native, ESM-first |
| Module system | ESM | Modern Node.js standard |
| Node.js target | >= 18.x LTS | Matches Azure SDK requirement |
| Integration testing | Azurite (Docker) | Official Microsoft Azure Storage emulator |

---

## 8. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | SAS token leaked in logs or errors | Medium | Critical | Sanitizer module intercepts all output; unit tests verify no leakage |
| R2 | Path traversal attack via malicious blob names | Low | Critical | Two-layer defense in path-validator; reject `..` and verify resolved path is under root |
| R3 | Large blob storage containers cause slow startup | Medium | High | Concurrency limit (configurable), incremental sync via manifest, timeout per blob |
| R4 | Azurite integration tests flaky in CI | Medium | Medium | Docker Compose with health checks; retry logic in test setup |
| R5 | Race condition: app reads files during sync | Medium | Medium | Document that `initAzureVenv()` must be awaited before app startup; `.env` loaded first |
| R6 | SAS token expires during long sync | Low | High | Proactive expiry check before sync starts; `AZURE_VENV_SAS_EXPIRY` config for early warning |
| R7 | Blob storage schema changes break SDK | Low | Medium | Pin SDK minor version; monitor Azure SDK changelog |
| R8 | Partial sync leaves inconsistent state | Medium | Medium | Manifest only records successful downloads; failed blobs retried on next startup |
| R9 | Cross-platform path separators | Low | Medium | Always use `path.join()` and `path.resolve()`; test on Windows and macOS |
| R10 | dotenv parsing edge cases (multiline, quotes, exports) | Low | Low | Use dotenv library (battle-tested); test with edge case .env files |

---

## 9. Acceptance Criteria (Overall)

1. **Functional:** Library reads local `.env`, connects to Azure Blob Storage, downloads all files, and loads remote `.env` with correct precedence
2. **Security:** SAS tokens never appear in logs, errors, or outputs; path traversal is prevented
3. **Reliability:** Partial sync failures do not corrupt state; incremental sync works correctly
4. **Performance:** Configurable concurrency; incremental sync skips unchanged files
5. **Observability:** Structured logging with configurable levels; SyncResult provides detailed statistics
6. **Developer Experience:** Clean TypeScript types exported; comprehensive JSDoc; clear error messages
7. **Testability:** >80% unit test coverage; integration tests against Azurite pass reliably
8. **Configuration:** No fallback values for required parameters; clear exceptions for missing config
9. **Cross-platform:** Works on Windows, macOS, and Linux

---

## 10. Estimated Effort

| Phase | Estimated Duration | Notes |
|---|---|---|
| Phase 0 | 0.5 day | Scaffolding |
| Phase 1 | 0.5 day | Error classes (simple) |
| Phase 2 | 1 day | URL parsing, Zod schemas |
| Phase 3 | 0.5 day | Logger, sanitizer |
| Phase 4 | 1.5 days | Blob client, SDK integration |
| Phase 5 | 1 day | Env loader, precedence logic |
| Phase 6 | 2 days | Sync engine, manifest, path validation |
| Phase 7 | 1.5 days | Orchestrator, public API |
| Phase 8 | 1.5 days | Integration tests with Azurite |
| Phase 9 | 1 day | Documentation, packaging |
| **Total** | **~11 days** | With parallelism: ~7 days |

---

## 11. Open Questions

1. Should the library support watching for blob changes after initial sync (file watcher mode)?
2. Should there be a CLI command to manually trigger re-sync?
3. Should the manifest file location be configurable or always at project root?
4. Should orphan file deletion (`deleteOrphans`) be supported in v1?
5. What is the maximum blob size threshold for switching from `downloadToFile()` to streaming?
