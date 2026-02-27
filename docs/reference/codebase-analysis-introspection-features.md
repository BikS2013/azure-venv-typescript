# Codebase Analysis: Introspection Features (File Tree & Env Variable Listing)

**Date:** 2026-02-28
**Purpose:** Pre-implementation analysis for two new introspection capabilities:
1. Get a tree of folders/files synced from Azure Blob Storage
2. Get a list of environment variables introduced via remote .env file(s)

---

## 1. Project Overview

**azure-venv** is a TypeScript library that synchronizes Azure Blob Storage files and environment variables to the local application root on startup, with optional continuous watch mode.

- **Entry points:** `initAzureVenv()` for one-shot sync, `watchAzureVenv()` for continuous polling
- **Public API surface:** Exported from `src/index.ts`
- **CLI:** `azure-venv sync` and `azure-venv watch` via Commander.js (`src/cli/index.ts`)
- **Return types:** `SyncResult` (from `initAzureVenv`), `WatchResult` (from `watchAzureVenv`)

---

## 2. Architecture Map

### Module Structure

```
src/
  index.ts              - Barrel file: re-exports public API (functions + types)
  initialize.ts         - initAzureVenv() orchestrator
  config/
    types.ts            - AzureVenvOptions, AzureVenvConfig, ParsedBlobUrl, RawEnvConfig
    parser.ts           - AZURE_VENV URL parser
    validator.ts        - Zod-based config validation
  azure/
    client.ts           - AzureVenvBlobClient (buffered + streaming downloads)
    types.ts            - BlobInfo, BlobClientConfig, BlobDownloadResult
  sync/
    engine.ts           - SyncEngine class (fetchRemoteEnv, syncFiles)
    downloader.ts       - BlobDownloader class (downloadBatch with concurrency)
    manifest.ts         - ManifestManager class (load, save, needsUpdate, createEntry)
    path-validator.ts   - Path traversal prevention
  env/
    loader.ts           - parseEnvFile(), parseEnvBuffer()
    precedence.ts       - applyPrecedence() - 3-tier resolver
  watch/
    watcher.ts          - BlobWatcher class + watchAzureVenv() function
    index.ts            - Watch module barrel exports
  cli/
    index.ts            - CLI tool (sync/watch subcommands, printSyncSummary)
  errors/               - Custom error hierarchy
  logging/
    logger.ts           - Logger with SAS sanitization
  types/
    index.ts            - All shared interfaces/types + NO_OP_SYNC_RESULT constant
```

### Data Flow (initAzureVenv)

```
initAzureVenv(options?)
  -> Capture OS env snapshot
  -> Load local .env (parseEnvFile)
  -> Apply local .env to process.env (without overriding OS)
  -> Validate config (validateConfig)
  -> [if not configured] return NO_OP_SYNC_RESULT
  -> Create AzureVenvBlobClient
  -> Create ManifestManager, BlobDownloader, SyncEngine
  -> Fetch remote .env (SyncEngine.fetchRemoteEnv -> buffer)
  -> Parse remote .env (parseEnvBuffer)
  -> Apply 3-tier precedence (applyPrecedence -> EnvLoadResult)
  -> Sync files (SyncEngine.syncFiles -> stats)
  -> Build and return SyncResult
```

---

## 3. Relevant Symbol Map

### Core Return Types

#### `SyncResult` (src/types/index.ts, lines 53-81)
```typescript
export interface SyncResult {
  readonly attempted: boolean;
  readonly totalBlobs: number;
  readonly downloaded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failedBlobs: readonly string[];
  readonly duration: number;
  readonly remoteEnvLoaded: boolean;
  readonly envSources: Readonly<Record<string, EnvSource>>;
}
```
**Key observation:** `envSources` already tracks which variables came from which source (os/remote/local), but does NOT include the variable values. The values are only in `EnvLoadResult.variables` which is not propagated to `SyncResult`.

#### `NO_OP_SYNC_RESULT` (src/types/index.ts, lines 86-96)
```typescript
export const NO_OP_SYNC_RESULT: SyncResult = {
  attempted: false, totalBlobs: 0, downloaded: 0, skipped: 0,
  failed: 0, failedBlobs: [], duration: 0,
  remoteEnvLoaded: false, envSources: {},
} as const;
```
**Impact:** Must be updated if SyncResult gains new fields.

#### `WatchResult` (src/types/index.ts, lines 172-178)
```typescript
export interface WatchResult {
  readonly initialSync: SyncResult;
  readonly stop: () => void;
}
```
**Impact:** Wraps SyncResult -- any additions to SyncResult automatically flow through.

#### `EnvLoadResult` (src/types/index.ts, lines 33-49)
```typescript
export interface EnvLoadResult {
  readonly variables: Readonly<EnvRecord>;  // key -> value
  readonly sources: Readonly<Record<string, EnvSource>>;  // key -> 'os'|'remote'|'local'
  readonly localKeys: readonly string[];
  readonly remoteKeys: readonly string[];
  readonly osKeys: readonly string[];
}
```
**Key observation:** This is the richest env data structure. Currently only `sources` is propagated to `SyncResult.envSources`. The `variables`, `localKeys`, `remoteKeys`, `osKeys` are discarded.

#### `EnvRecord` (src/types/index.ts, line 29)
```typescript
export type EnvRecord = Record<string, string>;
```

#### `EnvSource` (src/types/index.ts, line 24)
```typescript
export type EnvSource = 'os' | 'remote' | 'local';
```

### Manifest Types (File Tracking Data)

#### `SyncManifest` (src/types/index.ts, lines 123-133)
```typescript
export interface SyncManifest {
  readonly version: number;
  readonly lastSyncAt: string;
  readonly entries: Record<string, ManifestEntry>;
}
```

#### `ManifestEntry` (src/types/index.ts, lines 100-119)
```typescript
export interface ManifestEntry {
  readonly blobName: string;      // Full blob name in Azure
  readonly etag: string;
  readonly lastModified: string;  // ISO 8601
  readonly contentLength: number;
  readonly localPath: string;     // Relative to rootDir
  readonly syncedAt: string;      // ISO 8601
}
```
**Key observation:** `ManifestEntry.localPath` holds the relative path of each synced file. The manifest is the authoritative record of all synced files.

### Azure Types

#### `BlobDownloadResult` (src/azure/types.ts, lines 43-58)
```typescript
export interface BlobDownloadResult {
  readonly blobName: string;
  readonly localPath: string;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentLength: number;
}
```

#### `BlobInfo` (src/azure/types.ts, lines 3-18)
```typescript
export interface BlobInfo {
  readonly name: string;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentLength: number;
  readonly contentMD5: string | undefined;
}
```

### Orchestrator Functions

#### `initAzureVenv` (src/initialize.ts, lines 43-200)
- Signature: `async function initAzureVenv(options?: AzureVenvOptions): Promise<SyncResult>`
- Creates `SyncEngine`, calls `syncEngine.syncFiles(config)` and `applyPrecedence()`
- `envResult` (EnvLoadResult) is available at line ~128 but only `envResult.sources` is used (line 139)
- `syncStats` from `syncEngine.syncFiles()` provides download counts but NOT the list of synced files
- The manifest is saved internally by `SyncEngine.syncFiles()` but is not returned

#### `watchAzureVenv` (src/watch/watcher.ts, lines 322-521)
- Signature: `async function watchAzureVenv(options?: AzureVenvOptions & WatchOptions): Promise<WatchResult>`
- Mirrors initAzureVenv logic then starts BlobWatcher
- Same data loss: `envResult` is only partially used, manifest is not returned

#### `SyncEngine.syncFiles` (src/sync/engine.ts, lines 67-177)
- Returns: `{ downloaded, skipped, failed, failedBlobs, totalBlobs }`
- Internally calls `downloader.downloadBatch()` which returns `BlobDownloadResult[]`
- The `BlobDownloadResult[]` contains localPath for each downloaded file
- The manifest is updated and saved within this method (lines 152-166) but NOT returned

#### `applyPrecedence` (src/env/precedence.ts, lines 31-97)
- Signature: `applyPrecedence(osEnvSnapshot, localEnv, remoteEnv, logger): EnvLoadResult`
- Returns full `EnvLoadResult` with `variables`, `sources`, `localKeys`, `remoteKeys`, `osKeys`
- Currently only `sources` is propagated to SyncResult

#### `ManifestManager` (src/sync/manifest.ts, lines 22-161)
- `load(): Promise<SyncManifest>` -- loads from `{rootDir}/.azure-venv-manifest.json`
- `save(manifest: SyncManifest): Promise<void>` -- atomic write
- `createEntry(blobInfo, localPath): ManifestEntry` -- creates entry for synced blob
- `needsUpdate(blobInfo, manifest): boolean` -- ETag comparison

### Configuration Types

#### `AzureVenvOptions` (src/config/types.ts, lines 81-111)
```typescript
export interface AzureVenvOptions {
  rootDir?: string;
  envPath?: string;
  syncMode?: SyncMode;
  failOnError?: boolean;
  concurrency?: number;
  timeout?: number;
  logLevel?: LogLevel;
  maxBlobSize?: number;
  pollInterval?: number;
  watchEnabled?: boolean;
}
```

### CLI

#### `printSyncSummary` (src/cli/index.ts, lines 16-40)
- Consumes `SyncResult` to display sync stats
- Would need updating to display new introspection data if CLI should expose it

---

## 4. Pattern Catalog

### Result Construction Pattern
Both `initAzureVenv` and `watchAzureVenv` build SyncResult inline as object literals:
```typescript
const result: SyncResult = {
  attempted: true,
  totalBlobs: syncStats.totalBlobs,
  // ...
  envSources: envResult.sources,
};
```
There are **6 places** where SyncResult is constructed:
1. `initAzureVenv` success path (src/initialize.ts, line 133)
2. `initAzureVenv` AzureVenvError fallback (src/initialize.ts, ~line 170)
3. `initAzureVenv` unknown error fallback (src/initialize.ts, ~line 188)
4. `watchAzureVenv` success path (src/watch/watcher.ts, line 421)
5. `watchAzureVenv` AzureVenvError fallback (src/watch/watcher.ts, ~line 472)
6. `watchAzureVenv` unknown error fallback (src/watch/watcher.ts, ~line 502)

Plus `NO_OP_SYNC_RESULT` constant (src/types/index.ts, line 86).

### Error Handling Pattern
- ConfigurationError and AuthenticationError always propagate
- AzureVenvError: propagates if `failOnError=true`, returns degraded SyncResult otherwise
- Unknown errors: wrapped as AzureConnectionError if `failOnError=true`
- In degraded results, all counts are 0 and envSources is empty `{}`

### No-Op Pattern
When AZURE_VENV is not configured, `NO_OP_SYNC_RESULT` is returned with `attempted: false`.

### Data Available But Not Propagated
- **File list:** The manifest (`SyncManifest.entries`) contains all synced files with their `localPath`, `blobName`, `contentLength`, `etag`, `lastModified`. This data is written to disk but never returned to the caller.
- **Env variables:** `EnvLoadResult.variables` (key-value pairs), `localKeys`, `remoteKeys`, `osKeys` are computed by `applyPrecedence()` but only `sources` is returned.

---

## 5. Impact Analysis

### Feature 1: File Tree of Synced Files

#### Data Source Options
**Option A: Build from manifest after sync (Recommended)**
- After `syncEngine.syncFiles()` completes and the manifest is saved, load the manifest and extract entries
- The manifest already has `localPath` (relative to rootDir) and `contentLength` for every synced file
- This is the most reliable source as it represents the authoritative record

**Option B: Collect from download results**
- Modify `SyncEngine.syncFiles()` to return `BlobDownloadResult[]` in addition to stats
- Drawback: in incremental mode, skipped files wouldn't appear unless manifest is also consulted

#### Files That MUST Be Modified

| File | Change | Reason |
|------|--------|--------|
| `src/types/index.ts` | Add `FileTreeNode` interface (or similar), add `syncedFiles` field to `SyncResult` | New type + extended result |
| `src/types/index.ts` | Update `NO_OP_SYNC_RESULT` with empty tree | Keep constant in sync |
| `src/initialize.ts` | After `syncEngine.syncFiles()`, build file tree from manifest, add to SyncResult | Populate new field |
| `src/watch/watcher.ts` | Same change in `watchAzureVenv()` success path + error fallbacks | Parity with initAzureVenv |
| `src/index.ts` | Export new types (`FileTreeNode` or similar) | Public API surface |
| `src/cli/index.ts` | Update `printSyncSummary` to optionally display file tree | CLI output |

#### New Types Needed
```typescript
// Option A: Flat list (simpler, let consumer build tree)
interface SyncedFileInfo {
  readonly localPath: string;      // relative to rootDir
  readonly blobName: string;       // full Azure blob name
  readonly contentLength: number;  // size in bytes
  readonly lastModified: string;   // ISO 8601
  readonly etag: string;
}

// Option B: Hierarchical tree (richer but more complex)
interface FileTreeNode {
  readonly name: string;           // file or directory name
  readonly type: 'file' | 'directory';
  readonly localPath: string;      // relative to rootDir
  readonly children?: readonly FileTreeNode[];  // only for directories
  readonly size?: number;          // only for files (bytes)
  readonly blobName?: string;      // only for files
}
```

#### Suggested Approach
Add two fields to `SyncResult`:
- `syncedFiles: readonly SyncedFileInfo[]` -- flat list of all synced files (from manifest)
- `fileTree: FileTreeNode` -- hierarchical tree built from the flat list

Or simpler: just `syncedFiles` as a flat list and provide a utility function `buildFileTree(syncedFiles)` that consumers can use.

### Feature 2: List of Introduced Environment Variables

#### Data Source
- `applyPrecedence()` already returns `EnvLoadResult` with:
  - `variables`: full key-value map of all tracked env vars
  - `sources`: which tier each var came from
  - `remoteKeys`: specifically which keys came from the remote .env
  - `localKeys`: which keys came from local .env
  - `osKeys`: which OS keys were preserved

Currently, only `envResult.sources` is propagated to `SyncResult.envSources`.

#### Files That MUST Be Modified

| File | Change | Reason |
|------|--------|--------|
| `src/types/index.ts` | Add `EnvVariableInfo` interface (or similar), add `envVariables` field to `SyncResult` | New type + extended result |
| `src/types/index.ts` | Update `NO_OP_SYNC_RESULT` | Keep constant in sync |
| `src/initialize.ts` | Propagate `envResult.variables` (or richer data) to SyncResult | Populate new field |
| `src/watch/watcher.ts` | Same in `watchAzureVenv()` | Parity |
| `src/index.ts` | Export new types | Public API surface |
| `src/cli/index.ts` | Update `printSyncSummary` to optionally display env vars | CLI output |

#### New Types Needed
```typescript
interface EnvVariableInfo {
  readonly name: string;
  readonly value: string;
  readonly source: EnvSource;  // 'os' | 'remote' | 'local'
}
```

Or simply extend SyncResult with the full `EnvLoadResult`:
```typescript
// Add to SyncResult:
readonly envVariables: Readonly<EnvRecord>;      // key-value pairs
readonly envLocalKeys: readonly string[];         // keys from local .env
readonly envRemoteKeys: readonly string[];        // keys from remote .env
readonly envOsKeys: readonly string[];            // OS-preserved keys
```

#### Suggested Approach
Add a structured `envDetails` field to `SyncResult`:
```typescript
readonly envDetails: {
  readonly variables: Readonly<EnvRecord>;
  readonly sources: Readonly<Record<string, EnvSource>>;
  readonly localKeys: readonly string[];
  readonly remoteKeys: readonly string[];
  readonly osKeys: readonly string[];
};
```
This would make `envSources` redundant (subsumed by `envDetails.sources`), but keeping it for backward compatibility is prudent.

---

## 6. Risk Assessment

### Low Risk
- **Type additions are additive:** Adding optional fields to SyncResult or adding new interfaces does not break existing consumers. However, SyncResult fields are `readonly` and not optional, so any new required field is a **breaking change** for code constructing SyncResult manually.
- **EnvLoadResult data is already computed:** The `applyPrecedence()` return value has all needed env data; we just need to propagate it.

### Medium Risk
- **6 SyncResult construction sites:** Every place that constructs a SyncResult must be updated. Missing one means a type error (good -- TypeScript catches it) but there are 6 sites plus the NO_OP constant.
- **Manifest loading after sync:** Need to reload the manifest after `syncEngine.syncFiles()` completes to get the full file list. In incremental mode, the manifest includes previously synced files too (which is correct -- the tree should show ALL synced files, not just those downloaded this cycle).
- **Watch mode `poll()` method:** If the file tree / env vars should be updated during watch, the `BlobWatcher.poll()` method would need changes too. However, `poll()` does not return a SyncResult, so this may be out of scope.

### High Risk
- **Security consideration for env variables:** Exposing variable VALUES in the return type means sensitive data (passwords, tokens) would be available in the SyncResult object. The library already loads these into `process.env`, so it is already accessible, but having them in a data structure that might be logged or serialized increases the risk surface. Consider whether to include values or just names+sources.
- **Breaking change if fields are required:** If new fields are added as required (non-optional) to SyncResult, this is a semver-major change. Adding them as optional preserves backward compatibility.

---

## 7. Constraints from Existing Code

1. **SyncResult is readonly:** All fields use `readonly` modifier. New fields should follow this convention.
2. **NO_OP_SYNC_RESULT must be updated:** The constant at src/types/index.ts line 86 must include default values for any new fields.
3. **Error fallback SyncResults:** In both `initAzureVenv` and `watchAzureVenv`, error catch blocks construct degraded SyncResult objects (6 sites total). All must include the new fields with appropriate defaults.
4. **WatchResult wraps SyncResult:** `WatchResult.initialSync` is `SyncResult`, so changes flow through automatically.
5. **CLI printSyncSummary:** Consumes SyncResult at src/cli/index.ts:16. Should be updated to display new data.
6. **Public exports in src/index.ts:** Any new types/interfaces must be exported here.
7. **Manifest is always at `{rootDir}/.azure-venv-manifest.json`:** This is a design decision documented in the project -- not configurable.
8. **3-tier precedence is already computed:** `applyPrecedence()` returns `EnvLoadResult` with all the data needed for feature 2. No changes needed to `precedence.ts` or `loader.ts`.
9. **SyncEngine.syncFiles() saves manifest internally:** The manifest data is available after this method completes by calling `manifestManager.load()`.
10. **The .env file is excluded from syncFiles:** `SyncEngine.syncFiles()` filters out the `.env` blob (line ~93 of engine.ts). The file tree should note whether a remote .env was loaded, or list it separately.

---

## Summary of Files to Modify

| Priority | File | Lines Affected | Nature of Change |
|----------|------|---------------|------------------|
| P0 | `src/types/index.ts` | 53-96 | Add new interfaces, extend SyncResult, update NO_OP_SYNC_RESULT |
| P0 | `src/initialize.ts` | 125-145 | Build file list from manifest, propagate full envResult |
| P0 | `src/watch/watcher.ts` | 418-435, 462-485, 495-515 | Same changes in watchAzureVenv success + error paths |
| P1 | `src/index.ts` | 7-8 | Export new types |
| P1 | `src/cli/index.ts` | 16-40 | Update printSyncSummary for new data |
| P2 | `src/sync/engine.ts` | 67-177 | Optional: return richer data from syncFiles |

**Total estimated new/modified types:** 2-3 new interfaces, 1 modified interface (SyncResult), 1 modified constant (NO_OP_SYNC_RESULT)
**Total files to modify:** 5-6
**Backward compatibility:** Achievable if new SyncResult fields are optional or if this is declared a minor version bump with required fields (all construction sites are internal)
