# Plan 002: Design Decisions Enhancements

**Date:** 2026-02-27
**Status:** Draft
**Based on:** [investigation-design-decisions-v2.md](../reference/investigation-design-decisions-v2.md)
**Predecessor Plan:** [plan-001-azure-venv-library.md](plan-001-azure-venv-library.md)
**Design Reference:** [project-design.md](project-design.md)

---

## 1. Objective

Implement five design decisions on top of the existing `azure-venv` library:

1. **Watch Mode** -- Polling-based blob change detection after initial sync
2. **CLI Command** -- `azure-venv` CLI with `sync` and `watch` subcommands
3. **Manifest Location Lock** -- Remove `manifestPath` configurability, always use project root
4. **Orphan Files** -- Document as NOT in scope (decision only, no code)
5. **Configurable Blob Size Threshold** -- Streaming download for large blobs

The public API `initAzureVenv()` must remain fully backwards-compatible.

---

## 2. Current Codebase Snapshot

### Files That Exist Today

```
src/
  index.ts                    # Public API barrel (exports initAzureVenv, types, errors)
  initialize.ts               # initAzureVenv orchestrator
  config/
    parser.ts                 # AZURE_VENV URL parser
    validator.ts              # Zod validation, builds AzureVenvConfig
    types.ts                  # AzureVenvConfig, AzureVenvOptions, RawEnvConfig
  azure/
    client.ts                 # AzureVenvBlobClient (listBlobs, downloadToFile, downloadToBuffer)
    types.ts                  # BlobInfo, BlobClientConfig, BlobDownloadResult
  sync/
    engine.ts                 # SyncEngine (fetchRemoteEnv, syncFiles)
    downloader.ts             # BlobDownloader (downloadBatch with semaphore)
    manifest.ts               # ManifestManager (load, save, needsUpdate, createEntry)
    path-validator.ts         # validateAndResolvePath, stripPrefix
  env/
    loader.ts                 # parseEnvFile, parseEnvBuffer
    precedence.ts             # applyPrecedence (three-tier)
  errors/
    index.ts                  # Error barrel
    base.ts                   # AzureVenvError
    config.ts                 # ConfigurationError
    azure.ts                  # AzureConnectionError, AuthenticationError
    sync.ts                   # SyncError, PathTraversalError
  logging/
    logger.ts                 # createLogger, sanitize, Logger interface
  types/
    index.ts                  # SyncResult, SyncManifest, ManifestEntry, EnvSource, etc.
```

### Key Current Types

- `AzureVenvConfig` has `manifestPath: string` (configurable)
- `AzureVenvOptions` has `manifestPath?: string` (optional)
- `RawEnvConfig` has no watch or threshold env vars
- `AzureVenvBlobClient` has `downloadToFile()` and `downloadToBuffer()`, no streaming
- `BlobDownloader` always calls `client.downloadToFile()` regardless of blob size
- `BlobInfo` already has `contentLength`

---

## 3. Implementation Units (Parallel Work Streams)

The five design decisions decompose into five independent implementation units (A-E). Units A, B, and E can start in parallel. Unit C depends on A. Unit D depends on A and C.

### Unit A: Configuration Changes
**Scope:** New types, new env vars, remove manifestPath, update Zod schemas

### Unit B: Streaming Downloader
**Scope:** Add `downloadToFileStreaming()` to `AzureVenvBlobClient`, modify `BlobDownloader` to check threshold

### Unit C: Watch Module
**Scope:** New `src/watch/` directory with `BlobWatcher` class
**Depends on:** Unit A (for `WatchConfig` types and `AZURE_VENV_POLL_INTERVAL` / `AZURE_VENV_WATCH_ENABLED`)

### Unit D: CLI Module
**Scope:** New `src/cli/` directory with Commander.js-based CLI
**Depends on:** Unit A (config types), Unit C (watchAzureVenv function)

### Unit E: Manifest Location Fix
**Scope:** Remove `manifestPath` from options, hardcode to root
**Depends on:** Unit A (for type changes, can be merged into Unit A)

---

## 4. Phased Implementation Plan

### Phase 1: Configuration and Type Changes (Unit A + Unit E)

**Objective:** Update all configuration types, Zod schemas, and env var parsing for the five design decisions. Also fix manifest path to always be at project root.

#### Files to MODIFY

| File | Changes |
|---|---|
| `src/config/types.ts` | (1) Remove `manifestPath` from `AzureVenvConfig`. (2) Remove `manifestPath` from `AzureVenvOptions`. (3) Add `maxBlobSize: number` to `AzureVenvConfig`. (4) Add `maxBlobSize?: number` to `AzureVenvOptions`. (5) Add `pollInterval: number` to `AzureVenvConfig`. (6) Add `watchEnabled: boolean` to `AzureVenvConfig`. (7) Add `pollInterval?: number` to `AzureVenvOptions`. (8) Add `watchEnabled?: boolean` to `AzureVenvOptions`. (9) Add `AZURE_VENV_MAX_BLOB_SIZE`, `AZURE_VENV_POLL_INTERVAL`, `AZURE_VENV_WATCH_ENABLED` to `RawEnvConfig`. (10) Add `WatchOptions` interface. (11) Add `WatchChangeEvent` interface. |
| `src/config/validator.ts` | (1) Add `AZURE_VENV_MAX_BLOB_SIZE` to Zod schema (string -> number transform, default `'104857600'`, min 1048576 i.e. 1MB). (2) Add `AZURE_VENV_POLL_INTERVAL` to Zod schema (string -> number, default `'30000'`, min 5000). (3) Add `AZURE_VENV_WATCH_ENABLED` to Zod schema (enum `'true'|'false'`, default `'false'`, boolean transform). (4) Remove `manifestPath` from the config builder (hardcode to `.azure-venv-manifest.json`). (5) Wire new options overrides: `maxBlobSize`, `pollInterval`, `watchEnabled`. |
| `src/initialize.ts` | (1) Remove `config.manifestPath` usage -- replace with `path.resolve(config.rootDir, '.azure-venv-manifest.json')`. (2) Pass `config.maxBlobSize` to `BlobDownloader` constructor. (3) Deprecation: if caller passes `manifestPath` in options, ignore it silently (backwards compat -- the field no longer exists in the type, but JS callers may still pass it). |
| `src/types/index.ts` | (1) Add re-exports for new types: `WatchOptions`, `WatchChangeEvent`, `WatchResult`. (2) Add `WatchResult` interface. |
| `src/index.ts` | (1) Add exports for `WatchOptions`, `WatchChangeEvent`, `WatchResult`. (2) Will later export `watchAzureVenv` (deferred to Phase 3). |

#### Files to CREATE

None in this phase (all changes are to existing files).

#### Detailed Type Definitions

```typescript
// In src/config/types.ts -- NEW additions

/**
 * Options for watch mode polling.
 */
export interface WatchOptions {
  /** Polling interval in ms. Default: 30000. Min: 5000. Env: AZURE_VENV_POLL_INTERVAL */
  pollInterval?: number;

  /** Callback invoked when blob changes are detected. */
  onChange?: (changes: WatchChangeEvent) => void;

  /** Callback invoked on watch cycle errors. */
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

```typescript
// In src/types/index.ts -- NEW addition

/**
 * Result returned by watchAzureVenv(), providing control over the watcher.
 */
export interface WatchResult {
  /** Stops the watcher. Returns a Promise that resolves when all cleanup is done. */
  stop(): Promise<void>;
}
```

#### Manifest Path Migration (Unit E)

**Current:** `AzureVenvConfig.manifestPath` is configurable (defaults to `.azure-venv-manifest.json`).

**Target:** Remove `manifestPath` from both `AzureVenvConfig` and `AzureVenvOptions`. Everywhere in the codebase that reads `config.manifestPath`, replace with:
```typescript
const manifestPath = path.resolve(rootDir, '.azure-venv-manifest.json');
```

**Affected locations:**
1. `src/config/types.ts` -- Remove field from `AzureVenvConfig` and `AzureVenvOptions`
2. `src/config/validator.ts` -- Remove `manifestPath` from config builder
3. `src/initialize.ts` (line 102) -- Replace `config.manifestPath` with hardcoded value

**Backwards Compatibility:** Since `manifestPath` was optional in `AzureVenvOptions`, removing it is a source-level breaking change only for TypeScript callers who explicitly passed it. JavaScript callers passing `{ manifestPath: '...' }` will simply have the property ignored. This is acceptable because the option was always redundant (the manifest must be at project root for watch mode to work correctly).

#### Acceptance Criteria -- Phase 1

- [ ] `AzureVenvConfig` contains `maxBlobSize`, `pollInterval`, `watchEnabled` fields
- [ ] `AzureVenvConfig` does NOT contain `manifestPath`
- [ ] `AzureVenvOptions` contains `maxBlobSize?`, `pollInterval?`, `watchEnabled?` fields
- [ ] `AzureVenvOptions` does NOT contain `manifestPath?`
- [ ] `RawEnvConfig` lists all three new env vars
- [ ] Zod schema validates `AZURE_VENV_MAX_BLOB_SIZE` (default 104857600, min 1048576)
- [ ] Zod schema validates `AZURE_VENV_POLL_INTERVAL` (default 30000, min 5000)
- [ ] Zod schema validates `AZURE_VENV_WATCH_ENABLED` (default 'false', boolean)
- [ ] `WatchOptions`, `WatchChangeEvent`, `WatchResult` types are exported
- [ ] `initAzureVenv()` still works with no arguments (backwards compat)
- [ ] `initAzureVenv({ rootDir: '/tmp' })` still works (backwards compat)
- [ ] `npx tsc --noEmit` passes with no errors
- [ ] All existing unit tests pass without modification

---

### Phase 2: Streaming Downloader (Unit B)

**Objective:** Add streaming download capability for large blobs. Blobs exceeding `maxBlobSize` use `stream.pipeline()` instead of `downloadToFile()`.

**Can run in parallel with:** Phase 1 (but must integrate Phase 1 types before merge)

#### Files to MODIFY

| File | Changes |
|---|---|
| `src/azure/client.ts` | Add `downloadToFileStreaming(blobName: string, localPath: string): Promise<BlobDownloadResult>` method. Uses `blobClient.download(0)` to get a readable stream, then `pipeline()` from `node:stream/promises` to write to disk via `fs.createWriteStream()`. Returns same `BlobDownloadResult` shape. |
| `src/sync/downloader.ts` | (1) Accept `maxBlobSize: number` as constructor parameter. (2) In `downloadOne()`, check `blob.contentLength > this.maxBlobSize`. If true, call `this.client.downloadToFileStreaming()`. If false, call `this.client.downloadToFile()` (existing behavior). |
| `src/initialize.ts` | Pass `config.maxBlobSize` to `BlobDownloader` constructor. |

#### Files to CREATE

None.

#### Streaming Download Implementation

```typescript
// In src/azure/client.ts -- NEW method on AzureVenvBlobClient

import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs';

async downloadToFileStreaming(
  blobName: string,
  localPath: string,
): Promise<BlobDownloadResult> {
  this.logger.debug(
    `Streaming download blob "${blobName}" to "${localPath}"`
  );

  try {
    const parentDir = path.dirname(localPath);
    await fsPromises.mkdir(parentDir, { recursive: true });

    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download(0);

    if (!downloadResponse.readableStreamBody) {
      throw new SyncError(
        `No readable stream body in download response for "${blobName}"`
      );
    }

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
      `Streamed blob "${blobName}" (${result.contentLength} bytes)`
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
      `Failed to stream blob "${blobName}" to "${localPath}"`
    );
  }
}
```

#### BlobDownloader Changes

```typescript
// In src/sync/downloader.ts -- modified constructor and downloadOne

export class BlobDownloader {
  private readonly client: AzureVenvBlobClient;
  private readonly pathValidator: { validateAndResolvePath: typeof validateAndResolvePath };
  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly maxBlobSize: number;

  constructor(
    client: AzureVenvBlobClient,
    pathValidator: { validateAndResolvePath: typeof validateAndResolvePath },
    logger: Logger,
    concurrency: number,
    maxBlobSize: number,  // NEW parameter
  ) {
    // ...existing...
    this.maxBlobSize = maxBlobSize;
  }

  // Inside downloadOne, replace the download call:
  //   BEFORE: const result = await this.client.downloadToFile(blob.name, localPath);
  //   AFTER:
  const result = blob.contentLength > this.maxBlobSize
    ? await this.client.downloadToFileStreaming(blob.name, localPath)
    : await this.client.downloadToFile(blob.name, localPath);
}
```

#### Acceptance Criteria -- Phase 2

- [ ] `AzureVenvBlobClient` has a `downloadToFileStreaming()` method
- [ ] `downloadToFileStreaming()` uses `pipeline()` from `node:stream/promises`
- [ ] `downloadToFileStreaming()` creates parent directories before writing
- [ ] `downloadToFileStreaming()` returns the same `BlobDownloadResult` shape as `downloadToFile()`
- [ ] `downloadToFileStreaming()` sanitizes SAS tokens in error messages
- [ ] `BlobDownloader` constructor accepts `maxBlobSize` parameter
- [ ] Blobs with `contentLength > maxBlobSize` route to streaming download
- [ ] Blobs with `contentLength <= maxBlobSize` route to existing `downloadToFile()`
- [ ] Default threshold is 104857600 (100 MB)
- [ ] All existing unit tests still pass (no change in behavior for blobs under threshold)
- [ ] `npx tsc --noEmit` passes

---

### Phase 3: Watch Module (Unit C)

**Objective:** Implement polling-based blob change detection with ETag comparison.

**Depends on:** Phase 1 (for `WatchOptions`, `WatchChangeEvent`, `WatchResult` types and `pollInterval`/`watchEnabled` config)

#### Files to CREATE

| File | Purpose |
|---|---|
| `src/watch/watcher.ts` | `BlobWatcher` class -- core polling logic |
| `src/watch/index.ts` | Barrel export for watch module |

#### Files to MODIFY

| File | Changes |
|---|---|
| `src/index.ts` | Add export: `export { watchAzureVenv } from './watch/index.js'` |
| `src/initialize.ts` | No change -- `initAzureVenv` remains as-is. Watch mode is a separate entry point. |

#### BlobWatcher Architecture

```typescript
// src/watch/watcher.ts

import type { AzureVenvConfig } from '../config/types.js';
import type { WatchOptions, WatchChangeEvent } from '../config/types.js';
import type { WatchResult } from '../types/index.js';
import type { Logger } from '../logging/logger.js';
import type { SyncManifest, ManifestEntry } from '../types/index.js';
import { AzureVenvBlobClient } from '../azure/client.js';
import { ManifestManager } from '../sync/manifest.js';
import { BlobDownloader } from '../sync/downloader.js';
import { SyncEngine } from '../sync/engine.js';
import { parseEnvBuffer } from '../env/loader.js';
import { applyPrecedence } from '../env/precedence.js';

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
    > & Pick<WatchOptions, 'onChange' | 'onError'>,
  ) {}

  start(): WatchResult {
    this.logger.info(
      `Starting watch mode (poll interval: ${this.watchOptions.pollInterval}ms)`
    );

    this.intervalId = setInterval(
      () => void this.poll(),
      this.watchOptions.pollInterval,
    );

    // Graceful shutdown on SIGINT/SIGTERM
    const shutdown = (): void => {
      void this.stop();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return {
      stop: () => this.stop(),
    };
  }

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
          setTimeout(resolve, this.shutdownTimeout)
        ),
      ]);
    }

    this.logger.info('Watch mode stopped');
  }

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

      // 4. Detect deletions
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
        `Changes detected: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`
      );

      // 5. Download changed/new blobs
      const changedBlobs = currentBlobs.filter(
        (b) => added.includes(b.name) || modified.includes(b.name)
      );

      if (changedBlobs.length > 0) {
        await this.downloader.downloadBatch(
          changedBlobs,
          this.config.rootDir,
          prefix,
        );
      }

      // 6. Check if .env changed
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
          // Re-apply precedence using the original OS snapshot
          // Local env is already in process.env, so pass empty
          applyPrecedence(this.osEnvSnapshot, {}, remoteEnv, this.logger);
        }
      }

      // 7. Update manifest (remove deleted, update changed)
      const updatedEntries = { ...manifest.entries };
      for (const name of deleted) {
        delete updatedEntries[name];
      }
      // Changed/added entries are updated by the downloader via SyncEngine
      // But we need to save the deletions
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

#### Public Watch API

```typescript
// src/watch/index.ts

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

  const manifestPath = path.resolve(config.rootDir, '.azure-venv-manifest.json');
  const manifestManager = new ManifestManager(manifestPath, logger);
  const downloader = new BlobDownloader(
    blobClient,
    { validateAndResolvePath },
    logger,
    config.concurrency,
    config.maxBlobSize,
  );
  const syncEngine = new SyncEngine(blobClient, manifestManager, downloader, logger);

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

#### Acceptance Criteria -- Phase 3

- [ ] `BlobWatcher` class polls at configurable interval
- [ ] Poll cycle compares ETags from `listBlobsFlat()` against manifest
- [ ] New blobs are detected and downloaded
- [ ] Modified blobs (ETag changed) are re-downloaded
- [ ] Deleted blobs are detected and removed from manifest
- [ ] Remote .env changes trigger re-application of three-tier precedence
- [ ] OS env snapshot is reused across all poll cycles (never overwritten)
- [ ] `onChange` callback fires with `WatchChangeEvent`
- [ ] `onError` callback fires on poll cycle failures
- [ ] `stop()` clears the interval and aborts in-flight requests
- [ ] SIGINT and SIGTERM trigger graceful shutdown
- [ ] `watchAzureVenv()` performs initial sync before starting polling
- [ ] `watchAzureVenv()` throws `ConfigurationError` if AZURE_VENV is not set
- [ ] `npx tsc --noEmit` passes
- [ ] No polling occurs after `stop()` is called

---

### Phase 4: CLI Module (Unit D)

**Objective:** Create `azure-venv` CLI with `sync` and `watch` subcommands using Commander.js.

**Depends on:** Phase 1 (types), Phase 3 (watchAzureVenv function)

#### Files to CREATE

| File | Purpose |
|---|---|
| `src/cli/index.ts` | CLI entry point with Commander.js program definition |

#### Files to MODIFY

| File | Changes |
|---|---|
| `package.json` | (1) Add `"commander": "^14.x"` to `dependencies`. (2) Add `"bin": { "azure-venv": "./dist/cli/index.js" }`. (3) Ensure `dist/cli/index.js` has shebang via build script or prepend step. |
| `tsconfig.json` | Ensure `src/cli/` is included in compilation. |

#### CLI Implementation

```typescript
// src/cli/index.ts
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

// Common options shared between sync and watch
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--root-dir <path>', 'Application root directory', process.cwd())
    .option('--env-path <path>', 'Path to local .env file', '.env')
    .option('--sync-mode <mode>', 'Sync mode: full or incremental', 'full')
    .option('--concurrency <n>', 'Parallel downloads', '5')
    .option('--log-level <level>', 'Log level: debug, info, warn, error', 'info')
    .option('--fail-on-error', 'Exit with code 1 on sync errors')
    .option('--json', 'Output result as JSON');
}

// sync command
const syncCmd = new Command('sync')
  .description('One-time sync from Azure Blob Storage');

addCommonOptions(syncCmd);

syncCmd.action(async (opts) => {
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
    handleError(error, opts.json);
  }
});

// watch command
const watchCmd = new Command('watch')
  .description('Start continuous polling for blob changes');

addCommonOptions(watchCmd);
watchCmd.option(
  '--poll-interval <ms>',
  'Polling interval in milliseconds',
  '30000'
);

watchCmd.action(async (opts) => {
  try {
    const options = buildOptions(opts);
    const pollInterval = parseInt(opts.pollInterval, 10);

    const watcher = await watchAzureVenv(options, {
      pollInterval,
      onChange: (changes) => {
        if (opts.json) {
          console.log(JSON.stringify(changes));
        } else {
          console.log(
            `[azure-venv] Changes: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}` +
            (changes.envChanged ? ' (env updated)' : '')
          );
        }
      },
      onError: (error) => {
        console.error(`[azure-venv] Watch error: ${error.message}`);
      },
    });

    // Keep process alive -- watcher interval keeps it running
    // SIGINT/SIGTERM are handled by BlobWatcher

  } catch (error: unknown) {
    handleError(error, opts.json);
  }
});

program.addCommand(syncCmd);
program.addCommand(watchCmd);

program.parse();

// --- Helper functions ---

function buildOptions(opts: Record<string, string | boolean | undefined>): AzureVenvOptions {
  const options: AzureVenvOptions = {};

  if (typeof opts.rootDir === 'string') options.rootDir = opts.rootDir;
  if (typeof opts.envPath === 'string') options.envPath = opts.envPath;
  if (typeof opts.syncMode === 'string') options.syncMode = opts.syncMode as SyncMode;
  if (typeof opts.concurrency === 'string') options.concurrency = parseInt(opts.concurrency, 10);
  if (typeof opts.logLevel === 'string') options.logLevel = opts.logLevel as LogLevel;
  if (opts.failOnError === true) options.failOnError = true;

  return options;
}

function printSyncResult(result: { attempted: boolean; downloaded: number; skipped: number; failed: number; duration: number; remoteEnvLoaded: boolean }): void {
  if (!result.attempted) {
    console.log('azure-venv: not configured (AZURE_VENV not set)');
    return;
  }

  console.log('azure-venv sync complete');
  console.log(`  Downloaded: ${result.downloaded} blobs`);
  console.log(`  Skipped:    ${result.skipped} blobs (unchanged)`);
  console.log(`  Failed:     ${result.failed} blobs`);
  console.log(`  Duration:   ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`  Remote .env: ${result.remoteEnvLoaded ? 'loaded' : 'not found'}`);
}

function handleError(error: unknown, json: boolean | undefined): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`azure-venv error: ${message}`);
  }
  process.exit(1);
}
```

#### Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error / sync failure (when `--fail-on-error`) |
| 2 | Invalid CLI arguments (Commander.js default) |
| 130 | Interrupted by SIGINT |

#### Shebang Handling

The file `src/cli/index.ts` must start with `#!/usr/bin/env node`. Since TypeScript strips shebangs on compilation, we need one of:
- **Option A (recommended):** Add a `postbuild` script in `package.json` that prepends the shebang: `echo '#!/usr/bin/env node' | cat - dist/cli/index.js > temp && mv temp dist/cli/index.js && chmod +x dist/cli/index.js`
- **Option B:** Use `tsconfig.json` `"removeComments": false` and rely on TypeScript 5.5+ shebang preservation.

#### Acceptance Criteria -- Phase 4

- [ ] `azure-venv sync` performs a one-time sync (calls `initAzureVenv()`)
- [ ] `azure-venv watch` starts continuous polling (calls `watchAzureVenv()`)
- [ ] `azure-venv --help` prints usage information
- [ ] `azure-venv sync --help` prints sync-specific options
- [ ] `azure-venv watch --help` prints watch-specific options
- [ ] `--json` flag outputs machine-parseable JSON
- [ ] `--fail-on-error` exits with code 1 on errors
- [ ] `--poll-interval` is passed to watch mode
- [ ] `--root-dir`, `--env-path`, `--sync-mode`, `--concurrency`, `--log-level` are passed through
- [ ] Exit codes follow the documented table
- [ ] `commander` is added to `package.json` dependencies
- [ ] `bin` entry is added to `package.json`
- [ ] Built CLI is executable (`chmod +x`)
- [ ] `npx tsc --noEmit` passes

---

### Phase 5: Documentation and Orphan Files Decision

**Objective:** Document the orphan files decision and update all affected documentation.

#### Files to MODIFY

| File | Changes |
|---|---|
| `docs/design/project-design.md` | Add sections for: watch mode architecture, CLI tool, streaming downloads, manifest location decision, orphan files decision |
| `docs/design/project-functions.md` | Add FR-018 through FR-025 (see below) |
| `docs/design/configuration-guide.md` (if exists) | Add new env vars: `AZURE_VENV_MAX_BLOB_SIZE`, `AZURE_VENV_POLL_INTERVAL`, `AZURE_VENV_WATCH_ENABLED` |
| `CLAUDE.md` | Add tool documentation for `azure-venv` CLI in XML format |
| `Issues - Pending Items.md` | Update with orphan files decision, remove any resolved items |

#### Orphan Files Decision Documentation

Add to `project-design.md`:

> **Design Decision: Orphan File Cleanup -- NOT IN SCOPE**
>
> Orphan files are local files that exist in the sync manifest but no longer exist in Azure Blob Storage. Watch mode detects deletions by comparing the manifest against the current blob list but does NOT delete local files. Deleted blobs are removed from the manifest only.
>
> Rationale: Automatic file deletion is a destructive operation that risks data loss if the blob listing is temporarily incomplete (e.g., Azure outage, prefix misconfiguration). Users who need orphan cleanup should implement it in their `onChange` callback using the `deleted` array from `WatchChangeEvent`.

#### Acceptance Criteria -- Phase 5

- [ ] Orphan files decision is documented in project-design.md
- [ ] All new functional requirements are in project-functions.md
- [ ] Configuration guide is updated with new env vars
- [ ] CLAUDE.md has CLI tool documentation in XML format
- [ ] `Issues - Pending Items.md` is current

---

### Phase 6: Testing

**Objective:** Write unit tests for all new functionality.

#### Files to CREATE

| File | Purpose |
|---|---|
| `__tests__/unit/config/validator-v2.test.ts` | Tests for new Zod schema entries (maxBlobSize, pollInterval, watchEnabled) |
| `__tests__/unit/azure/client-streaming.test.ts` | Tests for `downloadToFileStreaming()` method |
| `__tests__/unit/sync/downloader-threshold.test.ts` | Tests for blob size threshold routing in BlobDownloader |
| `__tests__/unit/watch/watcher.test.ts` | Tests for BlobWatcher poll cycle, change detection, graceful shutdown |
| `__tests__/unit/watch/watch-api.test.ts` | Tests for `watchAzureVenv()` public API |
| `__tests__/unit/cli/cli.test.ts` | Tests for CLI argument parsing and command routing |

#### Files to MODIFY

| File | Changes |
|---|---|
| `__tests__/unit/config/validator.test.ts` | Add tests for manifest path removal, ensure old `manifestPath` option is gracefully ignored |
| `__tests__/unit/sync/downloader.test.ts` | Update constructor calls to include `maxBlobSize` parameter |

#### Acceptance Criteria -- Phase 6

- [ ] All new Zod schema fields have validation tests
- [ ] Streaming download has tests for success, error handling, and SAS sanitization
- [ ] Blob size threshold routing is tested for above/below/equal cases
- [ ] BlobWatcher poll cycle is tested with mocked blob client
- [ ] Change detection (added, modified, deleted) is correctly identified
- [ ] Graceful shutdown is tested (stop clears interval, aborts controller)
- [ ] CLI argument parsing is tested
- [ ] All existing tests pass without modification (backwards compat)
- [ ] `npm test` passes

---

## 5. Dependency Graph

```
Phase 1: Config + Types + Manifest Fix (Unit A + E)
    |
    +---+---+
    |       |
    v       v
Phase 2   Phase 3
Streaming  Watch
(Unit B)   (Unit C)
    |       |
    +---+---+
        |
        v
    Phase 4: CLI (Unit D)
        |
        v
    Phase 5: Documentation
        |
        v
    Phase 6: Testing
```

**Parallel execution opportunities:**
- Phase 2 and Phase 3 can run in parallel after Phase 1
- Phase 5 (documentation) can start alongside Phase 4 (only the CLI section of docs depends on Phase 4)
- Test files can be written alongside their implementation phases

---

## 6. Complete File Change Summary

### Files to CREATE (7 new files)

| File | Phase | Purpose |
|---|---|---|
| `src/watch/watcher.ts` | 3 | BlobWatcher class with polling logic |
| `src/watch/index.ts` | 3 | Watch module barrel + `watchAzureVenv()` public function |
| `src/cli/index.ts` | 4 | CLI entry point with Commander.js |
| `__tests__/unit/config/validator-v2.test.ts` | 6 | Tests for new config fields |
| `__tests__/unit/azure/client-streaming.test.ts` | 6 | Tests for streaming download |
| `__tests__/unit/sync/downloader-threshold.test.ts` | 6 | Tests for size threshold routing |
| `__tests__/unit/watch/watcher.test.ts` | 6 | Tests for BlobWatcher |

### Files to MODIFY (11 existing files)

| File | Phase | Summary of Changes |
|---|---|---|
| `src/config/types.ts` | 1 | Remove `manifestPath`, add `maxBlobSize`, `pollInterval`, `watchEnabled`, add `WatchOptions`, `WatchChangeEvent` |
| `src/config/validator.ts` | 1 | Add 3 new Zod fields, remove `manifestPath` from config builder |
| `src/initialize.ts` | 1, 2 | Hardcode manifest path, pass `maxBlobSize` to downloader |
| `src/types/index.ts` | 1 | Add `WatchResult` interface, re-export watch types |
| `src/index.ts` | 1, 3 | Export new types and `watchAzureVenv` |
| `src/azure/client.ts` | 2 | Add `downloadToFileStreaming()` method |
| `src/sync/downloader.ts` | 2 | Add `maxBlobSize` parameter, route to streaming for large blobs |
| `package.json` | 4 | Add `commander` dependency, add `bin` entry, update version |
| `docs/design/project-design.md` | 5 | Architecture updates for all five decisions |
| `docs/design/project-functions.md` | 5 | New functional requirements FR-018 to FR-025 |
| `CLAUDE.md` | 5 | CLI tool documentation |

---

## 7. Backwards Compatibility Analysis

| Change | Impact | Mitigation |
|---|---|---|
| Remove `manifestPath` from `AzureVenvOptions` | TypeScript callers passing `manifestPath` get compile error | Minor -- the option was undocumented in the API; JS callers unaffected |
| Remove `manifestPath` from `AzureVenvConfig` | Internal only, not used by consumers | No impact |
| Add `maxBlobSize` to `BlobDownloader` constructor | Internal only, not a public API | No impact |
| Add `watchAzureVenv()` export | Additive -- new function, does not change existing | No impact |
| Add `WatchOptions`, `WatchChangeEvent`, `WatchResult` types | Additive -- new types | No impact |
| Add `commander` dependency | Increases install size | Acceptable for CLI functionality |
| `initAzureVenv()` signature unchanged | **Must remain**: `initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult>` | Verified -- no signature change |
| New env vars have defaults | Existing deployments without new env vars work unchanged | Defaults match current behavior |

**Verdict:** The only breaking change is the removal of `manifestPath` from `AzureVenvOptions`. This is intentional and acceptable because the manifest must always be at the project root for watch mode to work correctly.

---

## 8. New Configuration Variables

| Variable | Type | Default | Min | Feature | Phase |
|---|---|---|---|---|---|
| `AZURE_VENV_MAX_BLOB_SIZE` | integer (bytes) | `104857600` (100 MB) | `1048576` (1 MB) | Streaming threshold | 1 |
| `AZURE_VENV_POLL_INTERVAL` | integer (ms) | `30000` (30s) | `5000` (5s) | Watch polling interval | 1 |
| `AZURE_VENV_WATCH_ENABLED` | `'true'` or `'false'` | `'false'` | -- | Enable watch mode | 1 |

---

## 9. New Dependencies

| Package | Version | Purpose | Phase |
|---|---|---|---|
| `commander` | `^14.x` | CLI framework (zero transitive dependencies) | 4 |

No new dependencies for Phases 1-3 (streaming uses Node.js built-in `node:stream/promises`).

---

## 10. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Watch polling creates excessive Azure API costs | Medium | Medium | Default 30s interval; document cost implications; minimum 5s enforced |
| R2 | Watch poll and app code read same file concurrently | Medium | Medium | Document that consumers should use `onChange` callback, not filesystem watchers |
| R3 | Streaming download loses data on network interruption | Low | High | `pipeline()` auto-cleans up; partial file is left on disk (next sync overwrites) |
| R4 | CLI shebang stripped by TypeScript compiler | Medium | Low | Post-build script to prepend shebang |
| R5 | Watch mode leaks intervals on unhandled exceptions | Low | Medium | Safety timeout in `stop()`; double-shutdown guard |
| R6 | Removing `manifestPath` breaks existing consumers | Low | Medium | Option was undocumented; JS callers silently ignore extra properties |
| R7 | Large poll cycles overlap (previous not finished) | Medium | Medium | `isPollRunning` guard prevents overlapping polls |

---

## 11. Estimated Effort

| Phase | Estimated Duration | Parallelizable With |
|---|---|---|
| Phase 1: Config + Types | 0.5 day | -- |
| Phase 2: Streaming Downloader | 0.5 day | Phase 3 |
| Phase 3: Watch Module | 1.5 days | Phase 2 |
| Phase 4: CLI Module | 1 day | Phase 5 (partial) |
| Phase 5: Documentation | 0.5 day | Phase 4 (partial) |
| Phase 6: Testing | 1.5 days | -- |
| **Total** | **~5.5 days** | **With parallelism: ~4 days** |

---

## 12. Open Questions from Plan 001 -- Resolution

| # | Question from Plan 001 | Resolution |
|---|---|---|
| 1 | Should the library support watching for blob changes? | **YES** -- Implemented as `watchAzureVenv()` with polling (Phase 3) |
| 2 | Should there be a CLI command for re-sync? | **YES** -- `azure-venv sync` and `azure-venv watch` commands (Phase 4) |
| 3 | Should the manifest file location be configurable? | **NO** -- Always at `<rootDir>/.azure-venv-manifest.json` (Phase 1) |
| 4 | Should orphan file deletion be supported in v1? | **NO** -- Not in scope. Deletions tracked in manifest only. Documented decision. |
| 5 | What is the max blob size threshold for streaming? | **100 MB** (104857600 bytes), configurable via `AZURE_VENV_MAX_BLOB_SIZE` (Phase 2) |
