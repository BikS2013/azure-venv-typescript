# Prompt 001: Azure Blob Virtual Environment Library

## Overview

This prompt guides the full lifecycle of building a TypeScript library (`azure-venv`) that, at application startup, synchronizes an Azure Blob Storage folder to the hosting application's local filesystem and loads remote environment variables. The library makes cloud-hosted resources (configs, documents, text files) transparently available as if they were local files.

---

<prompt>
<role>
You are an expert TypeScript/Node.js developer with deep experience in Azure Blob Storage SDKs, filesystem operations, environment variable management, and library design. You follow strict configuration handling practices: no fallback values, no silent failures -- missing configuration must always raise explicit exceptions.
</role>

<context>
We are building a TypeScript library named `azure-venv` (Azure Virtual Environment). This library is designed to be loaded during an application's startup phase. Its purpose is to:

1. Read configuration from the local `.env` file and OS-exported environment variables.
2. If `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` are found, connect to the specified Azure Blob Storage location.
3. Synchronize (download) all files and folders from the remote Azure Blob Storage path into the hosting application's root directory, mirroring the remote folder structure locally.
4. If a `.env` file exists among the downloaded remote files, parse it and inject its variables into `process.env` before any other application logic runs.
5. Make these resources available to the application as regular local files.

The library is written in TypeScript, follows strict error handling (no fallback/default values for configuration), and must be thoroughly tested.
</context>

<!-- ============================================================ -->
<!-- PHASE 1: RESEARCH AND INVESTIGATION                          -->
<!-- ============================================================ -->

<phase name="research-and-investigation" order="1">
<objective>
Investigate the technologies, packages, and patterns needed to implement the azure-venv library. Produce a research summary document.
</objective>

<tasks>
<task name="azure-sdk-research">
Research the `@azure/storage-blob` npm package:
- How to authenticate using SAS tokens.
- How to list blobs within a specific virtual directory (prefix-based listing).
- How to download blobs to the local filesystem.
- How to handle pagination when listing blobs in large containers.
- How to parse the `AZURE_VENV` value to extract the storage account URL, container name, and blob prefix (virtual folder path).
- Understand the URL format: `https://<account>.blob.core.windows.net/<container>/<prefix>`.
</task>

<task name="env-file-handling-research">
Research `.env` file parsing in Node.js/TypeScript:
- Evaluate the `dotenv` package for loading local `.env` files.
- Understand how `dotenv` interacts with `process.env` (does it overwrite existing variables or not).
- Determine the correct loading order: local `.env` first, then remote `.env`, ensuring remote values can override local ones where appropriate.
- Investigate `dotenv` expansion features (variable interpolation within `.env` files).
</task>

<task name="filesystem-sync-research">
Research filesystem synchronization patterns:
- How to recursively create directory structures from blob prefixes.
- How to handle file overwrites and conflict resolution (always overwrite with remote version).
- How to use Node.js `fs` and `path` modules for cross-platform path handling.
- Consider file permissions and symbolic link handling.
- Investigate streaming downloads vs. buffered downloads for large files.
</task>

<task name="startup-hook-research">
Research application startup integration patterns:
- How libraries hook into application startup in Node.js/TypeScript.
- Synchronous vs. asynchronous initialization patterns.
- How to ensure the library completes its work before the rest of the application starts (top-level await, initialization functions, etc.).
</task>

<task name="error-handling-research">
Research error handling best practices:
- Azure SDK error types and how to catch/reclassify them.
- Custom error class patterns in TypeScript.
- How to produce actionable error messages for configuration and connectivity issues.
</task>
</tasks>

<output>
Save the research findings as `docs/reference/azure-venv-research.md`. The document must include:
- A summary of each research area.
- Links to official documentation.
- Recommended packages and their versions.
- Key code patterns discovered.
- Any risks or limitations found.
</output>
</phase>

<!-- ============================================================ -->
<!-- PHASE 2: PLANNING                                            -->
<!-- ============================================================ -->

<phase name="planning" order="2">
<objective>
Create a detailed implementation plan based on the research findings. The plan must define milestones, deliverables, and dependencies.
</objective>

<tasks>
<task name="create-implementation-plan">
Produce a plan document covering:

1. **Project Setup Milestone**
   - Initialize TypeScript project with `tsconfig.json`.
   - Configure ESLint, Prettier.
   - Set up the testing framework (Vitest or Jest).
   - Define npm package structure (`package.json`, entry points, exports map).
   - Configure build tooling (tsc or tsup).

2. **Core Library Milestone**
   - Implement configuration loader (local `.env` + OS env vars).
   - Implement Azure Blob Storage connector (authentication via SAS token).
   - Implement blob listing and directory structure resolution.
   - Implement file download and local mirroring.
   - Implement remote `.env` file detection and loading.
   - Implement the main initialization function (`initialize()` or `bootstrap()`).

3. **Error Handling Milestone**
   - Define custom exception classes.
   - Implement validation for all required configuration variables.
   - Implement retry logic for transient Azure errors.
   - Implement logging for diagnostic purposes.

4. **Testing Milestone**
   - Unit tests for each module.
   - Integration tests with Azure Blob Storage emulator (Azurite).
   - End-to-end tests simulating the full initialization flow.

5. **Documentation Milestone**
   - API documentation.
   - Configuration guide.
   - Usage examples.
   - Update project CLAUDE.md with tool documentation.
</task>
</tasks>

<output>
Save the plan as `docs/design/plan-001-azure-venv-library.md` following the project's plan naming convention.
</output>
</phase>

<!-- ============================================================ -->
<!-- PHASE 3: DESIGN AND ARCHITECTURE                             -->
<!-- ============================================================ -->

<phase name="design-and-architecture" order="3">
<objective>
Design the library architecture, define interfaces, module boundaries, and data flow. Make and document all architectural decisions.
</objective>

<tasks>
<task name="initialization-flow-design">
Design the complete initialization flow:

```
Application Start
       |
       v
[1] Load local .env file (if exists) into process.env
       |
       v
[2] Read OS environment variables (already in process.env)
       |
       v
[3] Check for AZURE_VENV and AZURE_VENV_SAS_TOKEN
       |
       +-- NOT FOUND --> Log info: "Azure VENV not configured, skipping sync." --> Return
       |
       +-- FOUND (only one of them) --> THROW ConfigurationError with explicit message
       |
       +-- BOTH FOUND --> Continue
       |
       v
[4] Parse AZURE_VENV to extract: storageAccountUrl, containerName, blobPrefix
       |
       v
[5] Connect to Azure Blob Storage using SAS token
       |
       v
[6] List all blobs under the blobPrefix
       |
       v
[7] For each blob:
       +-- Create local directory structure if needed
       +-- Download blob content to local path (relative to app root)
       |
       v
[8] Check if a .env file was downloaded from remote
       |
       +-- YES --> Parse remote .env and merge into process.env
       |            (remote values OVERRIDE local values)
       +-- NO  --> Continue
       |
       v
[9] Initialization complete. Return sync result summary.
```
</task>

<task name="module-design">
Design the module structure:

```
src/
  index.ts                    -- Public API entry point
  config/
    config-loader.ts          -- Loads local .env and reads env vars
    config-validator.ts       -- Validates required configuration
    config-types.ts           -- Configuration interfaces and types
  azure/
    blob-client-factory.ts    -- Creates authenticated BlobServiceClient
    blob-lister.ts            -- Lists blobs under a prefix
    blob-downloader.ts        -- Downloads individual blobs
    azure-types.ts            -- Azure-related types
  sync/
    sync-engine.ts            -- Orchestrates the full sync process
    directory-resolver.ts     -- Maps blob paths to local paths
    env-merger.ts             -- Handles remote .env merging
    sync-types.ts             -- Sync-related types
  errors/
    errors.ts                 -- Custom error classes
  logging/
    logger.ts                 -- Logging abstraction
  types/
    index.ts                  -- Shared types and interfaces
```
</task>

<task name="interface-design">
Define the core TypeScript interfaces:

```typescript
// Configuration
interface AzureVenvConfig {
  azureVenv: string;              // Full Azure Blob Storage URL with path
  azureVenvSasToken: string;      // SAS token for authentication
  appRootPath: string;            // Local application root directory
  syncOptions?: SyncOptions;      // Optional sync behavior configuration
}

interface ParsedAzureUrl {
  storageAccountUrl: string;      // https://<account>.blob.core.windows.net
  containerName: string;          // Container name
  blobPrefix: string;             // Virtual folder prefix
}

interface SyncOptions {
  overwriteExisting?: boolean;    // Default: true
  excludePatterns?: string[];     // Glob patterns to exclude
  maxConcurrentDownloads?: number; // Parallel download limit
  retryAttempts?: number;         // Retry count for failed downloads
  retryDelayMs?: number;          // Delay between retries
}

// Sync Results
interface SyncResult {
  totalBlobs: number;
  downloadedFiles: string[];
  skippedFiles: string[];
  failedFiles: SyncFailure[];
  remoteEnvLoaded: boolean;
  durationMs: number;
}

interface SyncFailure {
  blobPath: string;
  localPath: string;
  error: string;
}

// Public API
interface AzureVenvLibrary {
  initialize(options?: InitOptions): Promise<SyncResult | null>;
}

interface InitOptions {
  appRootPath?: string;           // Override for app root (defaults to process.cwd())
  localEnvPath?: string;          // Override for local .env file path
  syncOptions?: SyncOptions;
}
```
</task>

<task name="configuration-rules">
Define strict configuration handling rules:

1. `AZURE_VENV`: REQUIRED if `AZURE_VENV_SAS_TOKEN` is also present. Must be a valid Azure Blob Storage URL. If malformed, throw `ConfigurationError`.
2. `AZURE_VENV_SAS_TOKEN`: REQUIRED if `AZURE_VENV` is also present. Must be a non-empty string. If missing when `AZURE_VENV` is set, throw `ConfigurationError`.
3. If NEITHER variable is present, the library logs an informational message and returns `null` (no-op mode). This is the only acceptable "silent" behavior.
4. If ONLY ONE of the two variables is present, throw `ConfigurationError` with a message indicating which variable is missing.
5. NO DEFAULT VALUES. NO FALLBACKS. Every missing required config must produce an explicit exception with an actionable error message.
6. The `AZURE_VENV` URL must be parseable into storage account URL, container name, and blob prefix. If parsing fails, throw `ConfigurationError`.
</task>

<task name="error-class-design">
Define custom error classes:

```typescript
class AzureVenvError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AzureVenvError';
  }
}

class ConfigurationError extends AzureVenvError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}

class AzureConnectionError extends AzureVenvError {
  constructor(message: string, public readonly originalError?: Error) {
    super(message, 'AZURE_CONNECTION_ERROR');
    this.name = 'AzureConnectionError';
  }
}

class SyncError extends AzureVenvError {
  constructor(message: string, public readonly blobPath?: string) {
    super(message, 'SYNC_ERROR');
    this.name = 'SyncError';
  }
}
```
</task>

<task name="env-loading-order">
Define the exact environment variable loading precedence (highest priority first):

1. **Remote `.env` file** (from Azure Blob Storage) -- loaded last, highest priority.
2. **OS-exported environment variables** -- already present in `process.env`.
3. **Local `.env` file** -- loaded first, lowest priority (dotenv does not overwrite existing vars by default).

This means:
- Local `.env` is loaded with `dotenv.config()` (default: does NOT overwrite existing OS env vars).
- Remote `.env` is loaded AFTER sync with explicit overwrite enabled, so remote values take precedence over both local `.env` and OS vars.
- This behavior ensures the remote configuration in Azure Blob Storage is the authoritative source.
</task>
</tasks>

<output>
Save the design document as `docs/design/project-design.md` (the project's main design file).
Also update `docs/design/project-functions.md` with the functional requirements.
</output>
</phase>

<!-- ============================================================ -->
<!-- PHASE 4: IMPLEMENTATION                                      -->
<!-- ============================================================ -->

<phase name="implementation" order="4">
<objective>
Implement the azure-venv library in TypeScript following the design from Phase 3.
</objective>

<tasks>
<task name="project-setup">
Set up the TypeScript project:
- Initialize with `npm init`.
- Install dependencies: `@azure/storage-blob`, `dotenv`.
- Install dev dependencies: `typescript`, `vitest` (or `jest` + `ts-jest`), `@types/node`, `eslint`, `prettier`, `tsup` (for building).
- Configure `tsconfig.json` with strict mode enabled.
- Configure `package.json` exports for both ESM and CJS if needed.
- Set the `main` and `types` fields in `package.json`.
</task>

<task name="implement-config-module">
Implement the configuration module (`src/config/`):

- `config-loader.ts`:
  - Function `loadLocalEnv(envPath?: string): void` -- loads the local `.env` file using `dotenv`.
  - Function `getAzureVenvConfig(): AzureVenvConfig | null` -- reads `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` from `process.env`.
  - Returns `null` if neither variable is set.
  - Throws `ConfigurationError` if only one is set.

- `config-validator.ts`:
  - Function `validateConfig(config: AzureVenvConfig): void` -- validates all fields.
  - Function `parseAzureVenvUrl(url: string): ParsedAzureUrl` -- parses the Azure Blob Storage URL.
  - Throws `ConfigurationError` for any validation failure.
</task>

<task name="implement-azure-module">
Implement the Azure module (`src/azure/`):

- `blob-client-factory.ts`:
  - Function `createBlobServiceClient(storageAccountUrl: string, sasToken: string): BlobServiceClient`.
  - Must validate the connection by attempting a lightweight operation.
  - Throws `AzureConnectionError` on failure.

- `blob-lister.ts`:
  - Function `listBlobs(containerClient: ContainerClient, prefix: string): AsyncGenerator<BlobItem>`.
  - Handles pagination transparently.
  - Yields each blob item for streaming processing.

- `blob-downloader.ts`:
  - Function `downloadBlob(blobClient: BlobClient, localPath: string): Promise<void>`.
  - Creates parent directories as needed.
  - Uses streaming download for efficiency.
  - Implements retry logic for transient failures.
</task>

<task name="implement-sync-module">
Implement the sync module (`src/sync/`):

- `directory-resolver.ts`:
  - Function `resolveLocalPath(blobName: string, blobPrefix: string, appRootPath: string): string`.
  - Strips the blob prefix to compute the relative path.
  - Joins with the app root path.
  - Validates no path traversal attacks (e.g., `../` in blob names).

- `env-merger.ts`:
  - Function `mergeRemoteEnv(envFilePath: string): void`.
  - Parses the downloaded remote `.env` file.
  - Injects variables into `process.env`, OVERWRITING existing values.
  - Logs each variable name (not value) that is set or overwritten.

- `sync-engine.ts`:
  - Class `SyncEngine` or function `syncBlobs(config: AzureVenvConfig): Promise<SyncResult>`.
  - Orchestrates: connect -> list -> download -> merge env.
  - Tracks progress and builds `SyncResult`.
  - Handles concurrent downloads with configurable parallelism.
</task>

<task name="implement-public-api">
Implement the public API (`src/index.ts`):

```typescript
export async function initialize(options?: InitOptions): Promise<SyncResult | null> {
  // 1. Load local .env
  loadLocalEnv(options?.localEnvPath);

  // 2. Read and validate Azure config
  const config = getAzureVenvConfig();
  if (config === null) {
    logger.info('AZURE_VENV not configured. Skipping Azure blob sync.');
    return null;
  }

  // 3. Apply options overrides
  config.appRootPath = options?.appRootPath ?? process.cwd();
  if (options?.syncOptions) {
    config.syncOptions = { ...config.syncOptions, ...options.syncOptions };
  }

  // 4. Validate configuration
  validateConfig(config);

  // 5. Execute sync
  const result = await syncBlobs(config);

  // 6. Log summary
  logger.info(`Sync complete: ${result.downloadedFiles.length} files downloaded in ${result.durationMs}ms`);
  if (result.remoteEnvLoaded) {
    logger.info('Remote .env file loaded into process.env');
  }

  return result;
}

// Re-export types and errors for consumers
export { AzureVenvConfig, SyncResult, InitOptions, SyncOptions } from './types';
export { AzureVenvError, ConfigurationError, AzureConnectionError, SyncError } from './errors/errors';
```
</task>

<task name="implement-logging">
Implement the logging module (`src/logging/`):

- Use a simple logger abstraction that defaults to `console` but allows injection of a custom logger.
- Log levels: `debug`, `info`, `warn`, `error`.
- All log messages must be prefixed with `[azure-venv]` for easy identification.
- Never log sensitive values (SAS tokens, credentials). Log variable names only.
</task>
</tasks>

<constraints>
- ALL configuration variables that are required must raise `ConfigurationError` if missing. No fallbacks. No defaults for required values.
- TypeScript strict mode must be enabled.
- All public functions and interfaces must have JSDoc comments.
- No `any` types except where absolutely unavoidable (and must be justified with a comment).
- Use `async/await` throughout; no raw Promises or callbacks.
- File paths must use `path.join()` or `path.resolve()` for cross-platform compatibility.
- The library must be side-effect free on import. Sync only happens when `initialize()` is called.
</constraints>
</phase>

<!-- ============================================================ -->
<!-- PHASE 5: TESTING                                             -->
<!-- ============================================================ -->

<phase name="testing" order="5">
<objective>
Create a comprehensive test suite covering unit tests, integration tests, and end-to-end tests for the azure-venv library.
</objective>

<tasks>
<task name="test-infrastructure-setup">
Set up the testing infrastructure:
- Configure Vitest (preferred) or Jest with TypeScript support.
- Set up Azurite (Azure Storage Emulator) for integration tests.
  - Provide a Docker Compose file or npm script to start Azurite.
  - Create test fixtures: sample blobs, test `.env` files, nested folder structures.
- Configure test environment isolation (each test gets a clean `process.env`).
- Set up code coverage reporting.
</task>

<task name="unit-tests">
Write unit tests for each module:

**Config Module Tests** (`tests/unit/config/`):
- `config-loader.test.ts`:
  - Test loading a valid local `.env` file.
  - Test behavior when no local `.env` file exists.
  - Test that `getAzureVenvConfig()` returns `null` when neither variable is set.
  - Test that `getAzureVenvConfig()` throws `ConfigurationError` when only `AZURE_VENV` is set.
  - Test that `getAzureVenvConfig()` throws `ConfigurationError` when only `AZURE_VENV_SAS_TOKEN` is set.
  - Test that `getAzureVenvConfig()` returns valid config when both are set.

- `config-validator.test.ts`:
  - Test parsing valid Azure Blob Storage URLs with various formats.
  - Test parsing URLs with nested prefixes (e.g., `folder/subfolder/`).
  - Test that malformed URLs throw `ConfigurationError`.
  - Test that empty or whitespace-only values throw `ConfigurationError`.

**Azure Module Tests** (`tests/unit/azure/`):
- `blob-client-factory.test.ts`:
  - Test client creation with valid credentials (mock Azure SDK).
  - Test error handling when connection fails.

- `blob-lister.test.ts`:
  - Test listing blobs with a given prefix (mock ContainerClient).
  - Test handling of empty containers.
  - Test pagination handling with large blob lists.
  - Test filtering by prefix.

- `blob-downloader.test.ts`:
  - Test successful blob download to a local path.
  - Test directory creation for nested blob paths.
  - Test retry behavior on transient errors.
  - Test handling of download stream errors.

**Sync Module Tests** (`tests/unit/sync/`):
- `directory-resolver.test.ts`:
  - Test path resolution with simple blob names.
  - Test path resolution with nested prefixes.
  - Test path traversal attack prevention (`../` in blob names).
  - Test cross-platform path handling.

- `env-merger.test.ts`:
  - Test merging a remote `.env` file into `process.env`.
  - Test that remote values overwrite existing `process.env` values.
  - Test handling of malformed `.env` files.
  - Test that variable names are logged but values are not.

- `sync-engine.test.ts`:
  - Test the full sync orchestration with mocked dependencies.
  - Test concurrent download limiting.
  - Test `SyncResult` assembly.
  - Test handling of partial failures (some blobs fail, others succeed).

**Error Tests** (`tests/unit/errors/`):
- Test custom error class hierarchy.
- Test error codes and messages.
- Test error serialization.
</task>

<task name="integration-tests">
Write integration tests using Azurite:

**Setup** (`tests/integration/`):
- `setup.ts`: Start Azurite, create test container, upload test blobs.
- `teardown.ts`: Clean up test container and stop Azurite.

**Tests**:
- `full-sync.test.ts`:
  - Upload a set of test files to Azurite blob storage.
  - Run `initialize()` with config pointing to Azurite.
  - Verify all files are downloaded to the correct local paths.
  - Verify directory structure is correct.
  - Verify file contents match.

- `env-loading.test.ts`:
  - Upload a `.env` file to Azurite blob storage.
  - Run `initialize()`.
  - Verify remote `.env` variables are in `process.env`.
  - Verify remote values override local values.

- `error-scenarios.test.ts`:
  - Test with invalid SAS token.
  - Test with non-existent container.
  - Test with non-existent prefix.
  - Test with network timeout simulation.

- `large-sync.test.ts`:
  - Upload 100+ files with nested directories.
  - Verify all are synced correctly.
  - Verify concurrent download behavior.
</task>

<task name="e2e-tests">
Write end-to-end tests simulating real application startup:

- `tests/e2e/app-startup.test.ts`:
  - Create a minimal "application" that calls `initialize()` on startup.
  - Verify the application can access synced files after initialization.
  - Verify environment variables from remote `.env` are available.

- `tests/e2e/no-azure-config.test.ts`:
  - Test application startup without Azure configuration.
  - Verify the library returns `null` and does not interfere.

- `tests/e2e/partial-config.test.ts`:
  - Test application startup with only `AZURE_VENV` set.
  - Verify `ConfigurationError` is thrown with clear message.
</task>

<task name="test-fixtures">
Create test fixtures:

```
tests/fixtures/
  local-env/
    .env                      -- Sample local .env file
  remote-blobs/
    .env                      -- Sample remote .env file
    config/
      app-config.json         -- Sample config file
      feature-flags.json      -- Sample feature flags
    templates/
      email-template.html     -- Sample template
    data/
      seed-data.json          -- Sample data file
```
</task>
</tasks>

<test-coverage-targets>
- Minimum 90% line coverage.
- 100% coverage on error handling paths.
- 100% coverage on configuration validation.
</test-coverage-targets>
</phase>

<!-- ============================================================ -->
<!-- CROSS-CUTTING CONCERNS                                       -->
<!-- ============================================================ -->

<cross-cutting-concerns>
<security>
- NEVER log SAS tokens, connection strings, or environment variable values.
- Validate blob names to prevent path traversal attacks.
- Use HTTPS exclusively for Azure connections (enforced by the SDK).
- SAS tokens should have minimal required permissions (read + list).
</security>

<performance>
- Use streaming downloads for large files.
- Implement configurable concurrent download limits.
- Use async iterators for blob listing to minimize memory usage.
- Log timing information for each phase of the sync.
</performance>

<compatibility>
- Support Node.js 18+ (LTS).
- Cross-platform path handling (Windows, macOS, Linux).
- ESM and CJS module compatibility.
</compatibility>

<documentation>
- All public APIs must have JSDoc documentation.
- Update CLAUDE.md with the tool documentation after implementation.
- Create a configuration guide at `docs/design/configuration-guide.md`.
- Update `docs/design/project-design.md` with the final architecture.
- Update `docs/design/project-functions.md` with functional requirements.
</documentation>
</cross-cutting-concerns>

<!-- ============================================================ -->
<!-- DELIVERABLES CHECKLIST                                        -->
<!-- ============================================================ -->

<deliverables>
<deliverable>Research document at `docs/reference/azure-venv-research.md`</deliverable>
<deliverable>Implementation plan at `docs/design/plan-001-azure-venv-library.md`</deliverable>
<deliverable>Project design at `docs/design/project-design.md`</deliverable>
<deliverable>Functional requirements at `docs/design/project-functions.md`</deliverable>
<deliverable>Configuration guide at `docs/design/configuration-guide.md`</deliverable>
<deliverable>TypeScript source code under `src/`</deliverable>
<deliverable>Test suite under `tests/`</deliverable>
<deliverable>Test fixtures under `tests/fixtures/`</deliverable>
<deliverable>Updated `CLAUDE.md` with tool documentation</deliverable>
<deliverable>Updated `Issues - Pending Items.md` at project root</deliverable>
<deliverable>`package.json` with all dependencies and scripts</deliverable>
<deliverable>`tsconfig.json` with strict TypeScript configuration</deliverable>
</deliverables>

<!-- ============================================================ -->
<!-- EXECUTION INSTRUCTIONS                                       -->
<!-- ============================================================ -->

<execution-instructions>
Execute the phases in order (1 through 5). Each phase must be completed and its output saved before moving to the next phase. At each phase:

1. Announce which phase you are starting.
2. Complete all tasks within the phase.
3. Save all output documents to their specified locations.
4. Summarize what was accomplished before moving to the next phase.

After all phases are complete:
- Run the test suite and ensure all tests pass.
- Update the `Issues - Pending Items.md` file with any discovered issues or TODOs.
- Provide a final summary of the entire implementation.
</execution-instructions>
</prompt>
