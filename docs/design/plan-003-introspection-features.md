# Plan 003: Introspection Features -- File Tree & Environment Variable Listing

**Date:** 2026-02-28
**Status:** Draft
**Version:** 1.0
**Pre-Requisite Analysis:** [../reference/codebase-analysis-introspection-features.md](../reference/codebase-analysis-introspection-features.md)
**Design Reference:** [project-design.md](project-design.md)
**Functions Reference:** [project-functions.md](project-functions.md)

---

## 1. Summary

This plan adds two introspection capabilities to the `azure-venv` library:

1. **File Tree Introspection (FR-026):** After sync, the hosting application can access a structured representation of all synced files (flat list + hierarchical tree).
2. **Environment Variable Introspection (FR-027):** After sync, the hosting application can access the full list of environment variables introduced by azure-venv, with their source tier and value.

Both features extend the existing `SyncResult` interface with new fields, propagated from data that is already computed internally but not currently exposed.

---

## 2. Design Decisions

### 2.1 File Tree Representation

**Decision:** Provide both a flat list (`syncedFiles: readonly SyncedFileInfo[]`) and a hierarchical tree (`fileTree: readonly FileTreeNode[]`) in `SyncResult`.

**Rationale:**
- The flat list is the canonical data source, built directly from the manifest after sync.
- The hierarchical tree is a convenience for consumers who need a folder-structure view.
- A utility function `buildFileTree(syncedFiles)` will construct the tree from the flat list. This function is also exported for consumers who want to rebuild the tree at any time.
- The tree is an array of root-level nodes (not a single root node), because synced files may span multiple top-level directories.

### 2.2 Environment Variable Exposure

**Decision:** Add an `envDetails` field to `SyncResult` containing the full `EnvLoadResult` data structure (variables, sources, localKeys, remoteKeys, osKeys).

**Rationale:**
- `applyPrecedence()` already computes `EnvLoadResult` with all needed data; we just need to propagate it.
- The existing `envSources` field is retained for backward compatibility (it is a subset of `envDetails.sources`).
- Exposing variable values is acceptable because: (a) these values are already in `process.env`, and (b) the caller already has full access to them. The structured format makes introspection explicit rather than requiring the caller to scan `process.env`.

### 2.3 Security Consideration

**Decision:** Include variable values in `envDetails.variables` but document that the `SyncResult` object should not be logged or serialized in production without filtering sensitive keys.

**Rationale:** The library already loads all values into `process.env`. Providing them in a structured object does not change the security surface, but the documentation should call this out explicitly.

### 2.4 Backward Compatibility

**Decision:** All new fields in `SyncResult` are **required** (non-optional), following the existing convention. This is acceptable because:
- All 7 SyncResult construction sites are internal to the library.
- No external consumer constructs `SyncResult` manually (it is a return type).
- TypeScript will catch any missed construction site at compile time.
- This will be a minor version bump (v0.3.0) since the interface is additive for consumers.

### 2.5 Watch Mode

**Decision:** The `poll()` method in `BlobWatcher` does NOT return a `SyncResult`, so introspection data is only available from the initial sync. If a consumer needs updated file/env data after watch polls, they can re-read the manifest file or inspect `process.env` directly. Extending `poll()` is out of scope for this plan.

---

## 3. New Types

### 3.1 SyncedFileInfo

```typescript
/**
 * Information about a single file synced from Azure Blob Storage.
 */
export interface SyncedFileInfo {
  /** Relative path of the file within the application root. */
  readonly localPath: string;

  /** Full blob name in Azure Blob Storage. */
  readonly blobName: string;

  /** File size in bytes. */
  readonly size: number;

  /** Last modified date in Azure (ISO 8601). */
  readonly lastModified: string;

  /** ETag of the blob at time of sync. */
  readonly etag: string;
}
```

### 3.2 FileTreeNode

```typescript
/**
 * A node in the hierarchical file tree representation.
 */
export interface FileTreeNode {
  /** File or directory name (not the full path). */
  readonly name: string;

  /** Whether this node is a file or directory. */
  readonly type: 'file' | 'directory';

  /** Relative path from the application root. */
  readonly path: string;

  /** Child nodes (only for directories). */
  readonly children?: readonly FileTreeNode[];

  /** File size in bytes (only for files). */
  readonly size?: number;

  /** Full blob name in Azure (only for files). */
  readonly blobName?: string;
}
```

### 3.3 EnvDetails

```typescript
/**
 * Full environment variable introspection data.
 */
export interface EnvDetails {
  /** Key-value map of all tracked environment variables. */
  readonly variables: Readonly<Record<string, string>>;

  /** Source tier for each variable ('os' | 'remote' | 'local'). */
  readonly sources: Readonly<Record<string, EnvSource>>;

  /** Keys that came from the local .env file. */
  readonly localKeys: readonly string[];

  /** Keys that came from the remote .env file. */
  readonly remoteKeys: readonly string[];

  /** OS environment keys that were preserved (not overridden). */
  readonly osKeys: readonly string[];
}
```

### 3.4 Extended SyncResult

```typescript
export interface SyncResult {
  // ... existing fields unchanged ...

  /** Flat list of all synced files (from manifest). */
  readonly syncedFiles: readonly SyncedFileInfo[];

  /** Hierarchical tree of all synced files. */
  readonly fileTree: readonly FileTreeNode[];

  /** Full environment variable introspection data. */
  readonly envDetails: EnvDetails;
}
```

---

## 4. Implementation Steps

### Phase 1: Types and Utility Functions (Foundation)

#### Step 1.1: Define New Types in `src/types/index.ts`

**File:** `src/types/index.ts`
**Action:** Add the following new interfaces/types after the existing `EnvLoadResult` interface:
- `SyncedFileInfo` interface
- `FileTreeNode` interface
- `EnvDetails` interface

**Symbols to add:**
- `SyncedFileInfo` (new interface, after line 49)
- `FileTreeNode` (new interface, after `SyncedFileInfo`)
- `EnvDetails` (new interface, after `FileTreeNode`)

**Verification:** `npx tsc --noEmit` passes (no consumers yet, types are just defined).

#### Step 1.2: Extend `SyncResult` Interface

**File:** `src/types/index.ts`
**Action:** Add three new required fields to the `SyncResult` interface (lines 54-81):
- `syncedFiles: readonly SyncedFileInfo[]`
- `fileTree: readonly FileTreeNode[]`
- `envDetails: EnvDetails`

**Impact:** This will immediately cause compile errors in all 7 SyncResult construction sites. This is intentional -- TypeScript will guide us through every place that needs updating.

**Verification:** `npx tsc --noEmit` shows exactly 7 errors (6 inline constructions + NO_OP_SYNC_RESULT). Count must match.

#### Step 1.3: Update `NO_OP_SYNC_RESULT` Constant

**File:** `src/types/index.ts`
**Symbol:** `NO_OP_SYNC_RESULT` (line 86)
**Action:** Add default empty values for the three new fields:
```typescript
syncedFiles: [],
fileTree: [],
envDetails: {
  variables: {},
  sources: {},
  localKeys: [],
  remoteKeys: [],
  osKeys: [],
},
```

**Verification:** One fewer type error after this change.

#### Step 1.4: Export New Types from `src/index.ts`

**File:** `src/index.ts`
**Action:** Add to the `export type` statement for result types (line 8):
- `SyncedFileInfo`
- `FileTreeNode`
- `EnvDetails`

Also export the `buildFileTree` utility function (from Step 1.5) as a named export.

**Verification:** New types are importable from the package root.

#### Step 1.5: Implement `buildFileTree()` Utility Function

**File:** `src/introspection/file-tree.ts` (NEW FILE)
**Action:** Create a new module with:

```typescript
/**
 * Build a hierarchical file tree from a flat list of synced files.
 *
 * @param syncedFiles - Flat list of synced file info objects.
 * @returns Array of root-level FileTreeNode objects.
 */
export function buildFileTree(syncedFiles: readonly SyncedFileInfo[]): FileTreeNode[]
```

**Algorithm:**
1. For each `SyncedFileInfo`, split `localPath` by `/` (normalize path separators first).
2. Build a nested map structure, creating intermediate directory nodes as needed.
3. Convert the map to a sorted array of `FileTreeNode` objects (directories first, then files, alphabetically within each group).

**File:** `src/introspection/index.ts` (NEW FILE)
**Action:** Barrel export for the introspection module.

**File:** `src/introspection/manifest-reader.ts` (NEW FILE)
**Action:** Create a function that converts `SyncManifest.entries` to `SyncedFileInfo[]`:

```typescript
/**
 * Convert manifest entries to a flat list of SyncedFileInfo objects.
 *
 * @param manifest - The sync manifest after sync completes.
 * @returns Flat list of SyncedFileInfo, sorted by localPath.
 */
export function manifestToSyncedFiles(manifest: SyncManifest): SyncedFileInfo[]
```

**Verification:** Unit tests pass (see Phase 3, Step 3.1).

---

### Phase 2: Wire Introspection Data into Orchestrators

#### Step 2.1: Update `initAzureVenv()` Success Path

**File:** `src/initialize.ts`
**Symbols to modify:** `initAzureVenv` function (line 44)
**Action:**

1. **Import** `ManifestManager` (already imported), `manifestToSyncedFiles`, and `buildFileTree` from the new introspection module.

2. **After** `syncEngine.syncFiles(config)` completes (line 129), reload the manifest to get the full file list:
   ```typescript
   const finalManifest = await manifestManager.load();
   const syncedFiles = manifestToSyncedFiles(finalManifest);
   const fileTree = buildFileTree(syncedFiles);
   ```

3. **Build `envDetails`** from the existing `envResult` (which is `EnvLoadResult`):
   ```typescript
   const envDetails: EnvDetails = {
     variables: envResult.variables,
     sources: envResult.sources,
     localKeys: [...envResult.localKeys],
     remoteKeys: [...envResult.remoteKeys],
     osKeys: [...envResult.osKeys],
   };
   ```

4. **Add** the three new fields to the `SyncResult` object literal (line 134):
   ```typescript
   syncedFiles,
   fileTree,
   envDetails,
   ```

**Verification:** `npx tsc --noEmit` -- error count decreases by 1.

#### Step 2.2: Update `initAzureVenv()` AzureVenvError Fallback

**File:** `src/initialize.ts`
**Location:** Lines 165-175 (first catch block, `error instanceof AzureVenvError`)
**Action:** Add empty defaults for the three new fields:
```typescript
syncedFiles: [],
fileTree: [],
envDetails: {
  variables: {},
  sources: {},
  localKeys: [],
  remoteKeys: [],
  osKeys: [],
},
```

**Verification:** `npx tsc --noEmit` -- error count decreases by 1.

#### Step 2.3: Update `initAzureVenv()` Unknown Error Fallback

**File:** `src/initialize.ts`
**Location:** Lines 189-199 (second catch block, unknown errors)
**Action:** Same empty defaults as Step 2.2.

**Verification:** `npx tsc --noEmit` -- error count decreases by 1.

#### Step 2.4: Update `watchAzureVenv()` Success Path

**File:** `src/watch/watcher.ts`
**Symbol:** `watchAzureVenv` function (line 323)
**Action:**

1. **Import** `manifestToSyncedFiles` and `buildFileTree` from the introspection module.

2. **After** `syncEngine.syncFiles(config)` completes (line 418), reload the manifest:
   ```typescript
   const finalManifest = await manifestManager.load();
   const syncedFiles = manifestToSyncedFiles(finalManifest);
   const fileTree = buildFileTree(syncedFiles);
   ```

3. **Build `envDetails`** from the existing `envResult` (same as Step 2.1).

4. **Add** the three new fields to the `initialSync` object literal (line 422).

**Verification:** `npx tsc --noEmit` -- error count decreases by 1.

#### Step 2.5: Update `watchAzureVenv()` AzureVenvError Fallback

**File:** `src/watch/watcher.ts`
**Location:** Lines 477-487 (AzureVenvError catch block)
**Action:** Add empty defaults for the three new fields to the `initialSync` object.

**Verification:** `npx tsc --noEmit` -- error count decreases by 1.

#### Step 2.6: Update `watchAzureVenv()` Unknown Error Fallback

**File:** `src/watch/watcher.ts`
**Location:** Lines 505-515 (unknown error catch block)
**Action:** Same empty defaults as Step 2.5.

**Verification:** `npx tsc --noEmit` -- 0 type errors remaining. Full clean compile.

---

### Phase 3: CLI Updates

#### Step 3.1: Update `printSyncSummary()`

**File:** `src/cli/index.ts`
**Symbol:** `printSyncSummary` function (line 17)
**Action:** Add new output sections after the existing env sources display:

```
=== Synced Files ===
  Total files:    <count>
  <localPath> (<size> bytes)
  <localPath> (<size> bytes)
  ...

=== File Tree ===
  <tree representation using indentation>
  config/
    db.json (1234 bytes)
    app.json (567 bytes)
  scripts/
    setup.sh (890 bytes)

=== Environment Variables ===
  Total variables: <count>
  <name> = <value> [source: <os|remote|local>]
  ...
```

**Design choices:**
- File tree uses 2-space indentation per depth level.
- Variable values are shown (the CLI is a developer tool, and values are already in process.env).
- Sections are only printed if there is data (e.g., no "Synced Files" section if `syncedFiles.length === 0`).

**Verification:** Build succeeds; manual CLI test with mock data.

---

### Phase 4: Unit Tests

#### Step 4.1: Test `buildFileTree()` Utility

**File:** `test_scripts/file-tree.test.ts` (NEW FILE)
**Test cases:**
1. Empty input returns empty array.
2. Single file at root level produces one file node.
3. Single file in subdirectory produces directory node with file child.
4. Multiple files in same directory are grouped under one directory node.
5. Nested directories (e.g., `a/b/c/file.txt`) produce nested directory nodes.
6. Mixed files and directories at root level, sorted correctly (directories first).
7. Multiple root-level directories with files.
8. Files with platform-specific path separators are normalized.

#### Step 4.2: Test `manifestToSyncedFiles()` Utility

**File:** `test_scripts/manifest-reader.test.ts` (NEW FILE)
**Test cases:**
1. Empty manifest entries returns empty array.
2. Single manifest entry is converted correctly.
3. Multiple entries are sorted by localPath.
4. All ManifestEntry fields map to SyncedFileInfo fields correctly.

#### Step 4.3: Test `SyncResult` New Fields (Integration-Style)

**File:** `test_scripts/introspection-integration.test.ts` (NEW FILE)
**Test cases:**
1. `NO_OP_SYNC_RESULT` has empty `syncedFiles`, `fileTree`, and `envDetails`.
2. `SyncResult` type includes all three new fields (compile-time test via type assertion).
3. `EnvDetails` structure matches `EnvLoadResult` shape.

#### Step 4.4: Update Existing Tests

**File:** `test_scripts/watcher.test.ts`
**Action:** If any test constructs a mock `SyncResult`, add the three new fields with empty defaults.

**File:** `test_scripts/config-new-fields.test.ts`
**Action:** Review for any `SyncResult` assertions that need updating.

**Verification:** `npx vitest run` -- all tests pass (existing + new).

---

### Phase 5: Documentation and Exports

#### Step 5.1: Update `src/index.ts` Exports

**File:** `src/index.ts`
**Action:**
- Export `SyncedFileInfo`, `FileTreeNode`, `EnvDetails` types.
- Export `buildFileTree` function from `./introspection/file-tree.js`.
- Export `manifestToSyncedFiles` function from `./introspection/manifest-reader.js`.

#### Step 5.2: Update CLAUDE.md

**File:** `CLAUDE.md`
**Action:**
- Update the "Project Structure" section to include `src/introspection/` module.
- Add `buildFileTree` and `manifestToSyncedFiles` as documented utility functions.
- Update the SyncResult description in any relevant sections.

#### Step 5.3: Update `project-design.md`

**File:** `docs/design/project-design.md`
**Action:** Add a Section 12 addendum documenting:
- The new `SyncedFileInfo`, `FileTreeNode`, and `EnvDetails` types.
- The `buildFileTree()` algorithm.
- The data flow for introspection (manifest -> SyncedFileInfo -> FileTreeNode).
- Updated SyncResult interface specification.

#### Step 5.4: Update `project-functions.md`

**File:** `docs/design/project-functions.md`
**Action:** Add FR-026 and FR-027 (see Section 7 of this plan).

---

## 5. Parallelization

| Step | Dependencies | Can Parallelize With |
|------|-------------|---------------------|
| 1.1 (Define types) | None | -- |
| 1.2 (Extend SyncResult) | 1.1 | -- |
| 1.3 (Update NO_OP) | 1.2 | -- |
| 1.5 (buildFileTree + manifestToSyncedFiles) | 1.1 | 1.2, 1.3 |
| 2.1 (initAzureVenv success) | 1.2, 1.3, 1.5 | 2.4 |
| 2.2 (initAzureVenv error 1) | 1.2, 1.3 | 2.1, 2.3, 2.4, 2.5, 2.6 |
| 2.3 (initAzureVenv error 2) | 1.2, 1.3 | 2.1, 2.2, 2.4, 2.5, 2.6 |
| 2.4 (watchAzureVenv success) | 1.2, 1.3, 1.5 | 2.1 |
| 2.5 (watchAzureVenv error 1) | 1.2, 1.3 | 2.1-2.4, 2.6 |
| 2.6 (watchAzureVenv error 2) | 1.2, 1.3 | 2.1-2.5 |
| 3.1 (CLI printSyncSummary) | 1.2 | 2.x steps |
| 4.1-4.2 (new tests) | 1.5 | 2.x, 3.1 |
| 4.3-4.4 (integration + update tests) | 2.1-2.6 | 3.1 |
| 5.1-5.4 (docs/exports) | All above | Each other |

**Recommended execution order:**
1. Phase 1 (sequential: 1.1 -> 1.2 -> 1.3, then 1.5 in parallel with 1.4)
2. Phase 2 (all 6 steps can be done in one pass through each file)
3. Phase 3 and Phase 4 in parallel
4. Phase 5 last

---

## 6. Files Modified/Created Summary

| File | Action | Nature |
|------|--------|--------|
| `src/types/index.ts` | MODIFY | Add 3 interfaces, extend SyncResult, update NO_OP_SYNC_RESULT |
| `src/introspection/file-tree.ts` | CREATE | `buildFileTree()` utility function |
| `src/introspection/manifest-reader.ts` | CREATE | `manifestToSyncedFiles()` utility function |
| `src/introspection/index.ts` | CREATE | Barrel exports |
| `src/initialize.ts` | MODIFY | Populate new SyncResult fields in 3 locations |
| `src/watch/watcher.ts` | MODIFY | Populate new SyncResult fields in 3 locations |
| `src/cli/index.ts` | MODIFY | Extend `printSyncSummary()` output |
| `src/index.ts` | MODIFY | Export new types + utility functions |
| `test_scripts/file-tree.test.ts` | CREATE | Unit tests for buildFileTree |
| `test_scripts/manifest-reader.test.ts` | CREATE | Unit tests for manifestToSyncedFiles |
| `test_scripts/introspection-integration.test.ts` | CREATE | Integration tests for new SyncResult fields |
| `test_scripts/watcher.test.ts` | MODIFY | Update mock SyncResult objects if needed |
| `CLAUDE.md` | MODIFY | Update project structure + add utility docs |
| `docs/design/project-design.md` | MODIFY | Add Section 12 addendum |
| `docs/design/project-functions.md` | MODIFY | Add FR-026, FR-027 |

**Total:** 9 files modified, 6 files created.

---

## 7. New Functional Requirements

### FR-026: File Tree Introspection

**Priority:** Medium
**Phase:** Plan 003 - Phase 1-2

After sync completes, the library must provide the hosting application with a structured representation of all files synced from Azure Blob Storage. This data is included in the `SyncResult` object as two fields:

- `syncedFiles`: A flat, sorted list of `SyncedFileInfo` objects, each containing `localPath`, `blobName`, `size`, `lastModified`, and `etag`.
- `fileTree`: A hierarchical array of `FileTreeNode` objects representing the directory structure, with nested `children` for directories.

The data source is the sync manifest (`SyncManifest.entries`), which is the authoritative record of all synced files. In incremental mode, the manifest includes all previously synced files, not just those downloaded in the current cycle.

A standalone utility function `buildFileTree(syncedFiles)` is also exported for consumers who need to rebuild the tree at any time.

**Inputs:** Sync manifest entries (post-sync).
**Outputs:** `SyncResult.syncedFiles` (flat list), `SyncResult.fileTree` (hierarchical tree).
**No-op case:** When azure-venv is not configured, both fields are empty arrays.
**Error fallback case:** When sync fails with `failOnError=false`, both fields are empty arrays.

### FR-027: Environment Variable Introspection

**Priority:** Medium
**Phase:** Plan 003 - Phase 1-2

After sync completes, the library must provide the hosting application with a structured view of all environment variables managed by azure-venv. This data is included in the `SyncResult` object as a new `envDetails` field of type `EnvDetails`:

- `variables`: Key-value map of all tracked environment variables (from all three tiers).
- `sources`: Map of variable name to source tier (`'os'`, `'remote'`, or `'local'`).
- `localKeys`: Array of keys from the local `.env` file.
- `remoteKeys`: Array of keys from the remote `.env` file.
- `osKeys`: Array of OS environment keys that were preserved.

The existing `envSources` field on `SyncResult` is retained for backward compatibility and is equivalent to `envDetails.sources`.

**Security note:** The `envDetails.variables` map contains actual values, which may include secrets. The `SyncResult` object should not be logged or serialized to external systems without filtering.

**Inputs:** `EnvLoadResult` from `applyPrecedence()`.
**Outputs:** `SyncResult.envDetails`.
**No-op case:** When azure-venv is not configured, `envDetails` has all empty collections.
**Error fallback case:** When sync fails with `failOnError=false`, `envDetails` has all empty collections.

---

## 8. Verification Checklist

- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] `npx vitest run` passes all tests (existing + new)
- [ ] `npm run build` succeeds
- [ ] New types (`SyncedFileInfo`, `FileTreeNode`, `EnvDetails`) are importable from package root
- [ ] `buildFileTree()` and `manifestToSyncedFiles()` are importable from package root
- [ ] `NO_OP_SYNC_RESULT` includes all new fields with empty defaults
- [ ] All 6 inline SyncResult construction sites include the new fields
- [ ] CLI `printSyncSummary()` displays synced files and env variables when present
- [ ] No regressions in existing 119 tests
- [ ] CLAUDE.md updated with new module and utilities
- [ ] project-design.md updated with Section 12 addendum
- [ ] project-functions.md updated with FR-026 and FR-027
