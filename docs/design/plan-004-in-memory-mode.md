# Plan: In-Memory Mode for azure-venv (v0.4.0)

## Context

Currently `initAzureVenv()` downloads Azure Blob Storage files to the local disk before the app starts. This requires the app to have filesystem write permissions. The user wants the library to **read blob contents into memory** instead, making disk writes unnecessary. This becomes the **default and only mode** - the disk-sync behavior is removed entirely.

The .env precedence logic (OS > remote > local) is preserved and still applied to `process.env`.

## What Changes

### Removed (disk-based concepts)
- **BlobDownloader** class (`src/sync/downloader.ts`) - no longer downloads to disk
- **ManifestManager** class (`src/sync/manifest.ts`) - no manifest file needed
- **PathValidator** (`src/sync/path-validator.ts`) - no local paths to validate
- **Streaming downloads** (`AzureVenvBlobClient.downloadToFile`, `downloadToFileStreaming`) - not needed
- **Config fields**: `syncMode`, `maxBlobSize` (and their env vars `AZURE_VENV_SYNC_MODE`, `AZURE_VENV_MAX_BLOB_SIZE`) - no incremental sync or streaming threshold needed
- **Manifest file** (`.azure-venv-manifest.json`) - no longer created on disk
- **CLI `--sync-mode` flag** - removed

### Modified

#### 1. New type: `BlobContent` (`src/types/index.ts`)
```typescript
export interface BlobContent {
  readonly blobName: string;    // Full blob name in Azure
  readonly relativePath: string; // Path relative to prefix (e.g., "config/app.json")
  readonly content: Buffer;      // Raw blob content
  readonly size: number;         // Content length in bytes
  readonly etag: string;         // Blob ETag
  readonly lastModified: string; // ISO 8601
}
```

#### 2. Updated `SyncResult` (`src/types/index.ts`)
- Replace `syncedFiles: SyncedFileInfo[]` with `blobs: BlobContent[]`
- Replace `fileTree: FileTreeNode[]` with a tree built from blob relative paths (still useful for visualization)
- Keep: `attempted`, `totalBlobs`, `downloaded`, `failed`, `failedBlobs`, `duration`, `remoteEnvLoaded`, `envSources`, `envDetails`
- Remove: `skipped` (no incremental mode)

#### 3. Updated `SyncEngine` (`src/sync/engine.ts`)
- Remove `manifestManager` and `downloader` dependencies
- New method `readBlobs(config): Promise<{blobs: BlobContent[], ...stats}>` that:
  1. Lists all blobs under prefix
  2. Downloads each to buffer (using `client.downloadToBuffer()`) with concurrency control
  3. Returns array of `BlobContent` objects
- Keep `fetchRemoteEnv()` as-is (already returns Buffer)

#### 4. Updated `initAzureVenv()` (`src/initialize.ts`)
- Remove manifest, downloader, path-validator setup
- Call `syncEngine.readBlobs(config)` instead of `syncEngine.syncFiles(config)`
- Build introspection data from BlobContent array instead of manifest
- Still apply .env precedence to `process.env`

#### 5. Updated `AzureVenvBlobClient` (`src/azure/client.ts`)
- Remove `downloadToFile()` and `downloadToFileStreaming()` methods
- Keep `downloadToBuffer()`, `listBlobs()`, `translateError()`

#### 6. Updated `AzureVenvOptions` / config (`src/config/types.ts`, `src/config/validator.ts`)
- Remove `syncMode` and `maxBlobSize` options
- Remove `AZURE_VENV_SYNC_MODE` and `AZURE_VENV_MAX_BLOB_SIZE` validation

#### 7. Updated `BlobWatcher` / watch mode (`src/watch/watcher.ts`)
- Poll reads blobs to memory instead of downloading to disk
- `WatchChangeEvent.localPath` replaced with `WatchChangeEvent.relativePath`
- Change events now carry the updated `BlobContent`

#### 8. Updated introspection (`src/introspection/`)
- `manifestToSyncedFiles()` replaced with a function that works from `BlobContent[]`
- `buildFileTree()` adapted to work from `BlobContent[]` (using relativePath instead of localPath)
- `FileTreeNode.path` now represents the blob relative path, not a disk path

#### 9. Updated CLI (`src/cli/index.ts`)
- Display blob names and sizes instead of local file paths
- File tree shows blob hierarchy, not disk hierarchy

#### 10. Updated `NO_OP_SYNC_RESULT` (`src/types/index.ts`)
- Replace `syncedFiles: []` with `blobs: []`
- Remove `skipped: 0`

### Files to Modify
1. `src/types/index.ts` - Add BlobContent, update SyncResult, update FileTreeNode, update WatchChangeEvent, update NO_OP_SYNC_RESULT
2. `src/config/types.ts` - Remove syncMode, maxBlobSize from AzureVenvOptions and AzureVenvConfig
3. `src/config/validator.ts` - Remove syncMode, maxBlobSize validation
4. `src/azure/client.ts` - Remove downloadToFile, downloadToFileStreaming
5. `src/sync/engine.ts` - Rewrite to read blobs into memory with concurrency
6. `src/initialize.ts` - Remove disk infrastructure, use new readBlobs()
7. `src/watch/watcher.ts` - Poll reads to memory, updated events
8. `src/introspection/manifest-reader.ts` - Adapt to BlobContent[]
9. `src/introspection/file-tree.ts` - Adapt to BlobContent[]
10. `src/cli/index.ts` - Update display
11. `src/index.ts` - Update exports (remove SyncedFileInfo, add BlobContent)

### Files to Delete
1. `src/sync/downloader.ts` - No longer needed
2. `src/sync/manifest.ts` - No longer needed
3. `src/sync/path-validator.ts` - No longer needed

### Test Files to Update
1. `test_scripts/streaming-download.test.ts` - Remove or replace with buffer download tests
2. `test_scripts/manifest.test.ts` - Remove
3. `test_scripts/manifest-reader.test.ts` - Adapt to new BlobContent-based function
4. `test_scripts/file-tree.test.ts` - Adapt to new input format
5. `test_scripts/config-validator.test.ts` - Remove syncMode/maxBlobSize tests
6. `test_scripts/config-new-fields.test.ts` - Remove syncMode/maxBlobSize tests
7. `test_scripts/path-validator.test.ts` - Remove
8. `test_scripts/watcher.test.ts` - Adapt to in-memory mode
9. `test_scripts/introspection-types.test.ts` - Adapt to new types

## Implementation Order
1. Types first (`src/types/index.ts`) - new BlobContent, updated SyncResult
2. Config changes (`src/config/types.ts`, `src/config/validator.ts`) - remove disk-related fields
3. Azure client cleanup (`src/azure/client.ts`) - remove disk download methods
4. Sync engine rewrite (`src/sync/engine.ts`) - in-memory with concurrency
5. Delete removed files (`downloader.ts`, `manifest.ts`, `path-validator.ts`)
6. Introspection updates (`src/introspection/`) - adapt to BlobContent
7. Initialize rewrite (`src/initialize.ts`) - wire everything together
8. Watch mode update (`src/watch/watcher.ts`) - in-memory polling
9. CLI update (`src/cli/index.ts`) - display blob info
10. Exports update (`src/index.ts`)
11. Tests - update/remove/add

## Verification
1. `npx tsc --noEmit` - type-check passes
2. `npx vitest run` - all tests pass
3. `npm run build` - build succeeds
4. Review that no `fs.writeFile`, `fs.mkdir`, `downloadToFile`, or manifest writes remain in src/
