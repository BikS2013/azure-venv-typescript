# Investigation: Design Decisions for azure-venv v2 Features

**Date:** 2026-02-27
**Project:** azure-venv (Azure Blob Storage virtual environment sync library)
**Scope:** Three new features -- Blob Watch Mode, CLI Re-Sync Command, Configurable Blob Size Threshold

---

## Executive Summary

This research document investigates three new features for the `azure-venv` TypeScript library. The library currently syncs Azure Blob Storage to the local filesystem on application startup via `initAzureVenv()`. The proposed features extend it with: (1) continuous polling-based change detection for blob updates, (2) a standalone CLI tool for manual re-synchronization, and (3) a configurable threshold to switch between buffered and streaming downloads for large blobs.

**Key Recommendations:**
- **Watch Mode:** Use ETag + lastModified polling via `listBlobsFlat()` with configurable interval (default 30s), managed by `setInterval` + `AbortController` for graceful shutdown. Avoid the Change Feed SDK (still in preview, requires special auth).
- **CLI Tool:** Use `commander.js` (zero dependencies, 270M weekly downloads, actively maintained) with a `bin` entry in `package.json`. Keep commands minimal: `azure-venv sync` and `azure-venv watch`.
- **Blob Size Threshold:** Use `BlobClient.download()` with `stream.pipeline()` for blobs above threshold; keep current `downloadToFile()` for blobs below. Default threshold: 100 MB. Configurable via `AZURE_VENV_MAX_BLOB_SIZE`.

---

## Feature 1: Blob Watch Mode (Polling-Based Change Detection)

### 1.1 How Azure Blob Storage Exposes Change Information

Azure Blob Storage provides four mechanisms for detecting changes:

| Mechanism | Type | Latency | Requires Extra Service | Node.js SDK Support |
|-----------|------|---------|----------------------|---------------------|
| **ETags** | Per-blob property, updated on every mutation | Immediate (on read) | No | Yes (`@azure/storage-blob`) |
| **lastModified** | Per-blob timestamp | Immediate (on read) | No | Yes (`@azure/storage-blob`) |
| **Change Feed** | Append-only log of all blob changes | Minutes (near real-time) | No (but must be enabled on storage account) | Preview SDK (`@azure/storage-blob-changefeed`) |
| **Event Grid** | Push-based event subscription | Seconds | Yes (Event Grid subscription, webhook endpoint) | Yes (`@azure/eventgrid`) |

#### ETags and lastModified (Recommended for Polling)

Every blob has an `etag` (opaque version identifier) and a `lastModified` timestamp that update on every write operation. The current `azure-venv` library already retrieves both via `listBlobsFlat()` (see `client.ts` line 60-68) and stores them in the manifest.

**Advantages:**
- Already available in the current codebase
- No additional Azure services or SDK packages required
- Works with SAS token authentication (the auth model already in use)
- ETag comparison is reliable and precise per-blob

**Limitations:**
- Requires periodic polling (listing all blobs under the prefix)
- Each poll is a List Blobs API call (billed per 10,000 operations)
- Cannot detect deletions without comparing full blob list against manifest

#### Change Feed

The `@azure/storage-blob-changefeed` package is still in **preview** (latest: `12.0.0-preview.4`). It requires `StorageSharedKeyCredential` or `TokenCredential` -- it does **not** support SAS tokens. This is a dealbreaker since `azure-venv` authenticates exclusively via SAS tokens.

**Verdict:** Not viable for this library due to authentication incompatibility.

#### Event Grid

Event Grid provides push-based real-time notifications but requires an HTTP endpoint (webhook) or Azure Function to receive events. This is incompatible with a Node.js library running inside an application process.

**Verdict:** Not viable for a library-mode tool. Better suited for server-based architectures.

### 1.2 Recommended Polling Approach

**Strategy:** Compare ETags from `listBlobsFlat()` against the local manifest on each poll cycle.

```
Poll Cycle:
  1. Call listBlobsFlat(prefix) -> get current blob list with ETags
  2. Compare each blob's ETag against manifest entry
  3. Download blobs where ETag differs (changed/new)
  4. Detect deleted blobs (in manifest but not in blob list)
  5. Update manifest
  6. If remote .env changed -> re-run env precedence logic
  7. Emit events (onChange callback) for consumers
  8. Schedule next poll
```

**Comparison with chokidar/fs.watch patterns:**

File watchers like `chokidar` use a similar pattern internally for polling mode:
- Store file stats (mtime, size) in a Map
- Poll at intervals using `fs.stat()`
- Compare current stats against stored stats
- Emit add/change/unlink events

Our approach mirrors this but operates on Azure blob metadata rather than filesystem stats.

### 1.3 Configurable Polling Interval

| Use Case | Recommended Interval | Rationale |
|----------|---------------------|-----------|
| Development / testing | 5-10 seconds | Quick feedback loop |
| Production / config sync | 30-60 seconds | Balance between freshness and API cost |
| Large containers (1000+ blobs) | 60-300 seconds | Reduce API call volume |

**Recommendation:**
- Default: **30 seconds** (30000 ms)
- Minimum: **5 seconds** (5000 ms) -- enforced with validation
- Environment variable: `AZURE_VENV_POLL_INTERVAL` (in milliseconds)
- Programmatic option: `pollInterval` in watch options

### 1.4 Graceful Shutdown

The watch mode must handle `SIGINT` (Ctrl+C) and `SIGTERM` (container orchestrator stop) gracefully.

**Recommended Pattern:**

```typescript
class BlobWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private abortController = new AbortController();
  private isShuttingDown = false;

  start(intervalMs: number): void {
    this.intervalId = setInterval(() => this.poll(), intervalMs);

    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) return; // prevent duplicate shutdown
    this.isShuttingDown = true;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.abortController.abort(); // cancel in-flight downloads
    // Wait for current poll to complete (if running)
    // Cleanup resources
  }

  private async poll(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    // ... poll logic with abort signal passed to download operations
  }
}
```

Key design decisions:
- Use `AbortController` to cancel in-flight HTTP requests to Azure
- Use an `isShuttingDown` flag to prevent duplicate shutdown logic
- `clearInterval` stops future polls; `abort()` cancels the current in-flight poll
- Return a `Promise` from `stop()` so callers can await cleanup completion
- Forced exit timeout (e.g., 10 seconds) as a safety net

### 1.5 Re-Running Env Precedence on Remote .env Changes

When watch mode detects that the remote `.env` blob has changed:

1. Download the new remote `.env` to buffer
2. Parse it with `parseEnvBuffer()` (already exists in the codebase)
3. Re-apply three-tier precedence: **OS env > remote .env > local .env**
4. Update `process.env` for variables that changed
5. Emit an `envChanged` event with the list of changed keys

**Important consideration:** OS environment variables (captured in `osEnvSnapshot`) must remain dominant. The snapshot must be taken once at initialization and reused across all watch cycles. Variables set by the OS must never be overwritten by remote `.env` changes.

### 1.6 Watch Mode API Design

```typescript
interface WatchOptions {
  pollInterval?: number;       // ms, default 30000, min 5000
  onChange?: (changes: WatchChangeEvent) => void;
  onError?: (error: Error) => void;
}

interface WatchChangeEvent {
  added: string[];      // new blob relative paths
  modified: string[];   // changed blob relative paths
  deleted: string[];    // removed blob relative paths
  envChanged: boolean;  // whether .env was updated
}

interface BlobWatcher {
  stop(): Promise<void>;
}

// Usage:
const watcher = await watchAzureVenv(options?: WatchOptions): Promise<BlobWatcher>;
```

---

## Feature 2: CLI Re-Sync Command

### 2.1 CLI Framework Comparison

| Criteria | **commander.js** | **yargs** | **process.argv (no framework)** |
|----------|-----------------|-----------|--------------------------------|
| Weekly downloads | ~270M | ~140M | N/A |
| Dependencies | **0** | **16** | **0** |
| Bundle size | 209 KB | 231 KB | 0 |
| GitHub stars | 27,911 | 11,434 | N/A |
| Last update | Days ago (active) | 8+ months ago | N/A |
| TypeScript support | Built-in + `@commander-js/extra-typings` | Built-in types | Manual |
| Open issues | 19 | 303 | N/A |
| Auto help generation | Yes | Yes | No |
| Subcommands | Native, first-class | Supported but verbose | Manual |
| Validation | Basic | Advanced (built-in) | Manual |
| Learning curve | Low | Medium | Low (but more code) |

**Other alternatives considered:**
- **cmd-ts**: TypeScript-first, strong typing, but very low adoption (~2K weekly downloads)
- **Stricli** (Bloomberg): TypeScript-first, tree-shakeable, but very new and niche
- **minimist**: Ultra-minimal parser, no help generation, no subcommands

### 2.2 Recommendation: commander.js

**Rationale:**
1. **Zero dependencies** -- critical for a library that consumers install into their projects
2. **Most popular** -- 270M weekly downloads, battle-tested
3. **Active maintenance** -- updated within days, only 19 open issues
4. **Clean subcommand model** -- matches Azure CLI patterns (verb-based commands)
5. **Sufficient TypeScript support** -- `@commander-js/extra-typings` provides full type inference
6. **Simple API** -- low learning curve, maps cleanly to our small command surface

Yargs is a strong alternative but its 16 transitive dependencies and 303 open issues make it less attractive for a library context. The raw `process.argv` approach is viable for our small command set but would require reimplementing help text, option parsing, and validation.

### 2.3 CLI Design

#### package.json `bin` Entry

```json
{
  "bin": {
    "azure-venv": "./dist/cli.js"
  }
}
```

The compiled `dist/cli.js` must start with the shebang:
```
#!/usr/bin/env node
```

#### Command Structure

Following Azure CLI patterns (target-action), the CLI should use subcommands:

```
azure-venv sync    # One-time sync (calls initAzureVenv internally)
azure-venv watch   # Start watch mode (polling)
azure-venv status  # Show current manifest/sync status (future)
```

#### CLI Options

```
azure-venv sync [options]
  --root-dir <path>       Application root directory (default: cwd)
  --env-path <path>       Path to local .env file (default: .env)
  --sync-mode <mode>      full | incremental (default: full)
  --concurrency <n>       Parallel downloads (default: 5)
  --log-level <level>     debug | info | warn | error (default: info)
  --fail-on-error         Exit with code 1 on sync errors
  --json                  Output result as JSON

azure-venv watch [options]
  (inherits all sync options)
  --poll-interval <ms>    Polling interval in ms (default: 30000)
```

#### Interaction with the Library

The CLI should import and call the library's public API:

```typescript
// cli.ts
import { initAzureVenv } from './index.js';
import { watchAzureVenv } from './watch.js';

// For sync command:
const result = await initAzureVenv(cliOptions);

// For watch command:
const watcher = await watchAzureVenv(watchOptions);
```

This ensures the CLI and the programmatic API share the same code path, configuration validation, and error handling.

### 2.4 Exit Codes

Following Azure CLI conventions and POSIX standards:

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | General error (sync failed, config error) |
| 2 | Invalid CLI arguments / usage error |
| 3 | Resource not found (e.g., container does not exist) |
| 130 | Interrupted by SIGINT (Ctrl+C) -- standard Unix convention |

### 2.5 Output Formats

- **Default (human-readable):** Colored text with sync statistics
- **JSON (`--json` flag):** Machine-parseable JSON matching `SyncResult` type
- **Quiet (future):** Suppress all output except errors

Example human-readable output:
```
azure-venv sync complete
  Downloaded: 12 blobs
  Skipped:    3 blobs (unchanged)
  Failed:     0 blobs
  Duration:   1.4s
  Remote .env: loaded (8 variables)
```

---

## Feature 3: Configurable Blob Size Threshold (Streaming vs Buffered)

### 3.1 Azure SDK Download Methods

The `@azure/storage-blob` SDK provides three download approaches:

| Method | Memory Usage | Parallelism | Best For |
|--------|-------------|-------------|----------|
| `downloadToFile(path)` | Low (SDK handles streaming to disk) | No | Small-medium files, convenience |
| `downloadToBuffer()` | **High** (entire blob in memory) | Yes (tunable `blockSize` + `concurrency`) | Small files needing in-memory processing |
| `download()` -> `readableStreamBody` | **Very low** (chunked streaming) | No (single stream) | Large files, memory-constrained environments |

#### Current Implementation

The codebase currently uses:
- `downloadToFile()` for syncing blobs to disk (`client.ts` line 102)
- `downloadToBuffer()` for fetching remote `.env` content (`client.ts` line 142)

Both are appropriate for their current use cases, but `downloadToFile()` has a known issue: it can **hang indefinitely under poor network conditions** (Azure SDK issue #25722).

### 3.2 Memory Impact Analysis

For a Node.js process with default V8 heap (1.5-4 GB depending on system):

| Blob Size | `downloadToFile()` Memory | `downloadToBuffer()` Memory | Streaming Memory |
|-----------|--------------------------|---------------------------|-----------------|
| 1 MB | ~1 MB (transient) | ~1 MB | ~64 KB (chunk size) |
| 10 MB | ~10 MB (transient) | ~10 MB | ~64 KB |
| 100 MB | ~100 MB (transient) | ~100 MB | ~64 KB |
| 500 MB | ~500 MB (transient) | ~500 MB (may OOM) | ~64 KB |
| 1 GB | ~1 GB (transient) | Likely OOM | ~64 KB |

`downloadToFile()` uses internal buffering (the SDK reads chunks and writes to disk), but the entire download response is managed by the SDK. For very large files, explicit streaming via `download()` + `pipeline()` gives the most control over memory and error handling.

### 3.3 Recommended Streaming Pattern

For blobs exceeding the size threshold, use the `stream.pipeline()` pattern:

```typescript
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs';

async function downloadBlobStreaming(
  blobClient: BlockBlobClient,
  localPath: string,
): Promise<void> {
  const downloadResponse = await blobClient.download(0);

  if (!downloadResponse.readableStreamBody) {
    throw new SyncError('No readable stream body in download response');
  }

  const writeStream = fs.createWriteStream(localPath);

  await pipeline(
    downloadResponse.readableStreamBody,
    writeStream,
  );
}
```

**Why `pipeline()` over `.pipe()`:**
- `pipeline()` properly propagates errors from any stream in the chain
- `pipeline()` automatically cleans up (destroys) all streams on error
- `pipeline()` returns a Promise (using the `stream/promises` version)
- `.pipe()` does not propagate errors -- a failure in the writable stream is silently ignored

### 3.4 Default Threshold

| Threshold | Rationale |
|-----------|-----------|
| 10 MB | Conservative; most config files are well under this |
| 50 MB | Good balance for mixed workloads |
| **100 MB** | Industry standard for "large file" boundary; matches Azure SDK internal chunking defaults |
| 256 MB | Aggressive; allows large buffers |

**Recommendation: 100 MB (104,857,600 bytes)**

Rationale:
- `downloadToFile()` works reliably for files up to ~100 MB in typical environments
- Above 100 MB, memory pressure becomes significant for multi-blob concurrent downloads
- 100 MB aligns with Azure's own block size defaults for parallel operations
- This is the threshold where streaming provides measurable memory savings

### 3.5 Configuration

**Environment variable:** `AZURE_VENV_MAX_BLOB_SIZE`

- Value: integer in bytes
- Default: `104857600` (100 MB)
- Example: `AZURE_VENV_MAX_BLOB_SIZE=52428800` (50 MB)

**Programmatic option:** `maxBlobSize` in `AzureVenvOptions`

```typescript
interface AzureVenvOptions {
  // ... existing options ...
  maxBlobSize?: number;  // bytes, default 104857600
}
```

**Implementation in downloader:**

```typescript
async downloadOne(blob: BlobInfo, localPath: string): Promise<BlobDownloadResult> {
  if (blob.contentLength > this.maxBlobSize) {
    return this.downloadStreaming(blob, localPath);
  }
  return this.client.downloadToFile(blob.name, localPath);
}
```

### 3.6 Impact on Current Architecture

The change is isolated to:
1. **`config/types.ts`** -- Add `maxBlobSize` to `AzureVenvConfig` and `AzureVenvOptions`
2. **`config/validator.ts`** -- Add validation for `AZURE_VENV_MAX_BLOB_SIZE`
3. **`azure/client.ts`** -- Add a new `downloadStreaming()` method
4. **`sync/downloader.ts`** -- Branch download logic based on `contentLength` vs threshold

The `BlobInfo` type already includes `contentLength` (set in `client.ts` line 65), so no changes are needed to the blob listing logic.

---

## Cross-Feature Dependencies

```
Feature 1 (Watch Mode)
    depends on: Feature 3 (streaming for large blob re-downloads)
    provides: watch infrastructure for Feature 2 CLI watch command

Feature 2 (CLI)
    depends on: Feature 1 (watch command wraps watch mode)
    depends on: existing sync API (sync command wraps initAzureVenv)

Feature 3 (Blob Size Threshold)
    independent: can be implemented first
    used by: Feature 1 (watch re-downloads) and existing sync
```

**Recommended implementation order:**
1. Feature 3 (Configurable Blob Size Threshold) -- independent, smallest scope
2. Feature 1 (Blob Watch Mode) -- uses Feature 3's streaming
3. Feature 2 (CLI Re-Sync Command) -- wraps both sync and watch

---

## New Configuration Variables Summary

| Variable | Type | Default | Feature |
|----------|------|---------|---------|
| `AZURE_VENV_MAX_BLOB_SIZE` | integer (bytes) | `104857600` (100 MB) | Feature 3 |
| `AZURE_VENV_POLL_INTERVAL` | integer (ms) | `30000` (30s) | Feature 1 |

---

## New Dependencies Summary

| Package | Version | Purpose | Feature |
|---------|---------|---------|---------|
| `commander` | ^14.x | CLI framework | Feature 2 |

No new dependencies required for Features 1 and 3 -- they use only the existing `@azure/storage-blob` SDK and Node.js built-in modules (`node:stream/promises`, `node:fs`).

---

## References

### Azure Blob Storage Change Detection
- [Azure Blob Storage Change Feed](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-change-feed)
- [Azure Storage Blob Change Feed client library for JavaScript](https://learn.microsoft.com/en-us/javascript/api/overview/azure/storage-blob-changefeed-readme?view=azure-node-preview)
- [@azure/storage-blob-changefeed on npm](https://www.npmjs.com/package/@azure/storage-blob-changefeed)
- [Managing Concurrency in Microsoft Azure Storage (ETags)](https://azure.microsoft.com/en-us/blog/managing-concurrency-in-microsoft-azure-storage-2/)

### Azure SDK Download Methods
- [BlockBlobClient class reference](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/blockblobclient?view=azure-node-latest)
- [Download a blob with JavaScript or TypeScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-download-javascript)
- [Performance tuning for uploads and downloads](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-tune-upload-download-javascript)
- [How to Download from Azure Blob Storage with Streams](https://williamandrewgriffin.com/how-to-download-from-azure-blob-storage-with-streams-using-express/)
- [BlockBlobClient.downloadToFile hangs under poor network (Issue #25722)](https://github.com/Azure/azure-sdk-for-js/issues/25722)
- [Stream blobs to Azure Blob Storage with Node.js (Sample)](https://learn.microsoft.com/en-us/samples/azure-samples/azure-sdk-for-js-storage-blob-stream-nodejs/stream-blobs-nodejs/)
- [@azure/storage-blob on npm](https://www.npmjs.com/package/@azure/storage-blob)

### CLI Frameworks
- [Commander.js vs Yargs comparison](https://npm-compare.com/commander,yargs)
- [Commander.js vs Yargs npm trends](https://npmtrends.com/commander-vs-yargs)
- [Commander.js vs other CLI frameworks](https://app.studyraid.com/en/read/11908/379336/commanderjs-vs-other-cli-frameworks)
- [Stricli alternatives considered](https://bloomberg.github.io/stricli/docs/getting-started/alternatives)
- [Node.js CLI app packages landscape](https://blog.kilpatrick.cloud/posts/node-cli-app-packages/)
- [Creating a CLI for your Node.js app using TypeScript](https://dev.to/int0h/creating-a-cli-for-your-node-js-app-using-typescript-124p)

### Azure CLI Design Patterns
- [Azure CLI output formats](https://learn.microsoft.com/en-us/cli/azure/format-output-azure-cli?view=azure-cli-latest)
- [Azure CLI command guidelines](https://github.com/Azure/azure-cli/blob/dev/doc/command_guidelines.md)
- [Tips for using the Azure CLI effectively](https://learn.microsoft.com/en-us/cli/azure/use-cli-effectively)

### Node.js Graceful Shutdown
- [How to Build a Graceful Shutdown Handler in Node.js](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view)
- [Node.js Graceful Shutdown: A Beginner's Guide](https://dev.to/yusadolat/nodejs-graceful-shutdown-a-beginners-guide-40b6)
- [Graceful Shutdown in NodeJS (Medium)](https://nairihar.medium.com/graceful-shutdown-in-nodejs-2f8f59d1c357)
- [Graceful shutdown with Node.js and Kubernetes](https://blog.risingstack.com/graceful-shutdown-node-js-kubernetes/)
