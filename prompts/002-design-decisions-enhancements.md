# Prompt 002: Azure-Venv Design Decisions & Enhancements

## Overview

This prompt guides the implementation of critical design decisions and feature enhancements for the existing `azure-venv` library. These enhancements include: watch mode for continuous sync, CLI re-sync command, manifest location standardization, orphan file management decisions, and configurable blob size thresholds.

---

<prompt>
<role>
You are an expert TypeScript/Node.js developer with deep experience in Azure Blob Storage SDKs, filesystem operations, CLI development, and library design patterns. You understand polling-based file watching, ETag-based change detection, and streaming operations. You follow strict configuration handling practices: no fallback values for required configuration, but operational defaults are acceptable for optional features.
</role>

<context>
The `azure-venv` library already exists and provides initial sync of Azure Blob Storage to local filesystem on application startup. This prompt extends the library with five design decisions:

1. **WATCH MODE**: Enable continuous monitoring and re-sync of blob changes after initial sync
2. **CLI RE-SYNC COMMAND**: Provide a standalone CLI tool for manual re-sync operations
3. **MANIFEST LOCATION**: Standardize manifest file location to always be at project root
4. **ORPHAN FILE MANAGEMENT**: Document the decision to exclude orphan cleanup from v1
5. **CONFIGURABLE BLOB SIZE THRESHOLD**: Make the streaming vs buffered download threshold configurable

See the existing library implementation and design in `docs/design/project-design.md` and the codebase under `src/`.
</context>

<!-- ============================================================ -->
<!-- PHASE 1: RESEARCH AND INVESTIGATION                          -->
<!-- ============================================================ -->

<phase name="research-and-investigation" order="1">
<objective>
Research best approaches, patterns, and technologies needed to implement each design decision. Produce a comprehensive research document covering all five enhancements.
</objective>

<tasks>
<task name="watch-mode-research">
Research continuous blob monitoring patterns:

**ETag-Based Change Detection**:
- How Azure Blob Storage ETags work as version identifiers
- How to retrieve ETags during blob listing (`BlobItem.properties.etag`)
- How ETags change when blob content is modified
- Best practices for comparing ETags to detect changes
- Handling of new blobs (no previous ETag) vs modified blobs (ETag changed) vs deleted blobs (missing from listing)

**Polling vs Event-Based Approaches**:
- Azure Blob Storage change feed capabilities and limitations
- Cost and latency considerations for Event Grid vs polling
- Justification for polling-based approach for this use case
- Recommended polling intervals (trade-off between latency and API costs)
- Best practices for implementing interval-based polling in Node.js

**Manifest Design**:
- Structure for storing blob metadata: `{ [blobPath]: { etag: string, lastModified: Date, localPath: string } }`
- JSON serialization and deserialization patterns
- Atomic file write patterns to prevent corruption
- Where to store the manifest (`.azure-venv-manifest.json` at project root)

**State Management**:
- How to initialize the manifest after the first sync
- How to update the manifest after each re-sync
- How to handle manifest corruption or deletion
- How to handle partial sync failures (some blobs succeed, others fail)

**Configuration Design**:
- Environment variable: `AZURE_VENV_WATCH_ENABLED` (boolean: "true"/"false", default: "false")
- Environment variable: `AZURE_VENV_WATCH_INTERVAL_MS` (number in milliseconds, default: 60000 = 1 minute)
- How to validate and parse these values
- How to gracefully shut down the watch loop on process signals (SIGINT, SIGTERM)
</task>

<task name="cli-command-research">
Research CLI development patterns in Node.js/TypeScript:

**CLI Frameworks**:
- Evaluate `commander` vs `yargs` vs built-in `process.argv` parsing
- Recommended approach for simple single-command CLIs
- How to structure help messages and usage documentation

**Package.json `bin` Configuration**:
- How to declare CLI entry points in `package.json` (`"bin": { "azure-venv-sync": "./dist/cli.js" }`)
- Shebang requirements for cross-platform compatibility (`#!/usr/bin/env node`)
- Build configuration to ensure CLI files are executable and properly bundled

**CLI Implementation Pattern**:
- How to invoke the existing `initialize()` function from a CLI context
- How to handle async operations in CLI scripts (top-level await or `.then()/.catch()`)
- How to provide meaningful output to the user (progress indicators, success/error messages)
- How to exit with appropriate exit codes (0 for success, non-zero for failure)
- How to read configuration from `.env` files in the current working directory

**Testing CLI Commands**:
- How to test CLI scripts in integration tests
- How to spawn child processes to test the CLI
- How to capture stdout/stderr in tests
</task>

<task name="manifest-location-research">
Research manifest file location best practices:

**Standard Locations**:
- Compare options: project root, `.azure-venv/` directory, OS-specific config directories
- Rationale for choosing project root for visibility and simplicity
- Naming convention: `.azure-venv-manifest.json` (hidden file, follows dotfile convention)

**Git Integration**:
- Should the manifest be committed to git? (Answer: No, add to `.gitignore`)
- Why: manifest represents local state, may differ across environments

**Path Resolution**:
- How to reliably determine the project root (use `appRootPath` from config)
- How to construct the manifest path from app root
- Cross-platform path handling
</task>

<task name="orphan-file-management-research">
Research orphan file cleanup patterns and trade-offs:

**Definition of Orphan Files**:
- Files that exist locally but no longer exist in Azure Blob Storage
- Created when blobs are deleted from Azure after being synced locally

**Implementation Approaches**:
- Manifest-based detection: files in manifest but not in current blob listing
- Filesystem scan-based detection: files on disk but not in blob listing
- Hybrid approach

**Risks and Considerations**:
- Risk of accidentally deleting user-created local files
- Risk of deleting files from other sources (non-Azure files)
- Complexity of distinguishing Azure-synced files from other files
- Need for user confirmation before deletion

**Decision for v1**:
- Exclude orphan file cleanup from v1 scope
- Document as a future enhancement
- Rationale: prioritize safety and simplicity; users can manually clean up if needed
- Add to `Issues - Pending Items.md` as a potential v2 feature
</task>

<task name="blob-size-threshold-research">
Research streaming vs buffered download patterns:

**Azure SDK Download Methods**:
- `downloadToFile()`: Downloads blob directly to a file (buffered approach, efficient for small-to-medium files)
- `download()` with stream: Returns a readable stream, must be manually piped to file (streaming approach, efficient for large files)
- Memory usage implications of each approach

**Threshold Configuration**:
- Environment variable: `AZURE_VENV_MAX_BLOB_SIZE` (bytes, default: 104857600 = 100MB)
- Can be set in local `.env` or remote Azure `.env` file
- How to parse and validate the value (must be a positive integer)
- What happens if the value is invalid (throw `ConfigurationError`)

**Download Strategy**:
- If blob size ≤ threshold: use `downloadToFile()` (simpler, single SDK call)
- If blob size > threshold: use `download()` + stream piping (lower memory footprint)
- How to determine blob size before download (`BlobItem.properties.contentLength`)

**Default Value Rationale**:
- 100MB is a reasonable operational default based on typical use cases
- Large enough to handle most config/template files efficiently
- Small enough to prevent memory issues with buffered downloads
- Users can override if their use case differs
</task>

<task name="backward-compatibility-research">
Research backward compatibility considerations:

**Impact on Existing Users**:
- Watch mode is disabled by default (opt-in) → no impact
- CLI command is additive → no impact
- Manifest location change may require migration if users were configuring `manifestPath`
- Blob size threshold uses a sensible default → no impact unless users have very large files

**Migration Strategy for Manifest Location**:
- If `manifestPath` option currently exists and is configurable, it must be removed/locked
- Document the breaking change clearly
- Consider adding a migration script or warning if old manifest location is detected
</task>
</tasks>

<output>
Save the research findings as `docs/reference/azure-venv-enhancements-research.md`. The document must include:
- Summary of each research area (one section per enhancement)
- Recommended approaches with justifications
- Configuration design for watch mode and blob size threshold
- Links to relevant Azure SDK documentation
- Code pattern examples where helpful
- Risk analysis and mitigation strategies
- Backward compatibility considerations
</output>
</phase>

<!-- ============================================================ -->
<!-- PHASE 2: PLANNING                                            -->
<!-- ============================================================ -->

<phase name="planning" order="2">
<objective>
Create a detailed implementation plan for all five design decisions, breaking down the work into milestones, tasks, and dependencies.
</objective>

<tasks>
<task name="create-implementation-plan">
Produce a comprehensive plan document covering:

**1. Manifest Location Standardization (First Priority)**
   - Why first: foundation for watch mode, simplifies architecture
   - Tasks:
     - Remove `manifestPath` from configuration options (if it exists)
     - Update manifest file handling to always use `path.join(appRootPath, '.azure-venv-manifest.json')`
     - Update documentation
     - Add `.azure-venv-manifest.json` to `.gitignore` template
   - Dependencies: None
   - Risk: Low (simplification)

**2. Configurable Blob Size Threshold (Second Priority)**
   - Why second: independent feature, improves download efficiency
   - Tasks:
     - Add `AZURE_VENV_MAX_BLOB_SIZE` configuration option
     - Update configuration loader to read and validate the value
     - Update blob downloader to check blob size and choose download strategy
     - Add configuration documentation
     - Add tests for threshold behavior
   - Dependencies: None
   - Risk: Low (isolated change)

**3. Watch Mode Implementation (Third Priority)**
   - Why third: requires manifest to be established
   - Tasks:
     - Design manifest structure and file format
     - Implement manifest initialization after first sync
     - Implement ETag-based change detection
     - Implement polling loop with configurable interval
     - Implement graceful shutdown on SIGINT/SIGTERM
     - Add watch mode configuration options
     - Add watch mode tests (unit and integration)
     - Document watch mode usage
   - Dependencies: Manifest location standardization
   - Risk: Medium (new async loop, state management, shutdown handling)

**4. CLI Re-Sync Command (Fourth Priority)**
   - Why fourth: depends on watch mode being stable
   - Tasks:
     - Choose CLI framework (or use built-in argv parsing)
     - Create CLI entry point script (`src/cli.ts`)
     - Add `bin` entry to `package.json`
     - Implement CLI logic (read config, call `initialize()`, display output)
     - Add shebang and ensure executable permissions
     - Update build process to include CLI bundle
     - Test CLI command (spawn process in tests)
     - Document CLI usage in README and CLAUDE.md
   - Dependencies: Core sync logic must be stable
   - Risk: Low (thin wrapper around existing logic)

**5. Orphan File Management Documentation (Final)**
   - Why final: documentation-only task
   - Tasks:
     - Document the decision to exclude orphan cleanup from v1
     - Add rationale to project design document
     - Add future enhancement note to `Issues - Pending Items.md`
     - Describe potential approaches for v2 consideration
   - Dependencies: None
   - Risk: None (documentation only)

**Testing Milestones**:
- Unit tests for each new feature
- Integration tests with Azurite for watch mode and blob size threshold
- CLI integration tests (spawn process, verify output)
- Manual end-to-end testing of watch mode with live Azure storage
- Performance testing of blob size threshold with various file sizes

**Documentation Milestones**:
- Update `docs/design/project-design.md` with new architecture
- Update `docs/design/configuration-guide.md` with new configuration options
- Update `docs/design/project-functions.md` with new features
- Update `CLAUDE.md` with CLI tool documentation
- Update `Issues - Pending Items.md` with orphan file management decision
</task>

<task name="dependency-mapping">
Create a dependency map:

```
Manifest Location Standardization (no deps)
        |
        v
Watch Mode Implementation
        |
        +----> CLI Re-Sync Command
        |
Configurable Blob Size Threshold (no deps)
        |
Orphan File Management Documentation (no deps)
```
</task>

<task name="risk-assessment">
Assess and document risks:

**Watch Mode Risks**:
- Risk: Polling loop never stops (process hangs)
  - Mitigation: Implement proper shutdown handlers for SIGINT/SIGTERM
- Risk: Manifest file corruption
  - Mitigation: Use atomic writes (write to temp file, then rename)
- Risk: Excessive Azure API calls (cost)
  - Mitigation: Default to 1-minute interval, document cost implications
- Risk: Memory leak in long-running watch loop
  - Mitigation: Careful resource cleanup, testing with long-running scenarios

**CLI Command Risks**:
- Risk: CLI not executable on Unix systems
  - Mitigation: Ensure shebang is present, test on multiple platforms
- Risk: CLI doesn't find `.env` file
  - Mitigation: Use `process.cwd()` as base path, document working directory requirement

**Blob Size Threshold Risks**:
- Risk: Invalid configuration value
  - Mitigation: Strict validation with clear error messages
- Risk: Threshold too low (forces streaming for small files, inefficient)
  - Mitigation: Reasonable default (100MB), clear documentation
</task>
</tasks>

<output>
Save the plan as `docs/design/plan-002-azure-venv-enhancements.md` following the project's plan naming convention. Include:
- Overview of all five design decisions
- Detailed implementation tasks for each
- Dependency map showing execution order
- Risk assessment with mitigation strategies
- Testing strategy for each feature
- Documentation update checklist
</output>
</phase>

<!-- ============================================================ -->
<!-- PHASE 3: DESIGN AND ARCHITECTURE                             -->
<!-- ============================================================ -->

<phase name="design-and-architecture" order="3">
<objective>
Design the detailed architecture for each enhancement, including interfaces, types, module boundaries, state management, and data flow.
</objective>

<tasks>
<task name="manifest-design">
Design the manifest file structure and handling:

**Manifest File Format**:
```typescript
interface BlobManifestEntry {
  etag: string;              // Azure Blob ETag (used for change detection)
  lastModified: string;      // ISO 8601 timestamp
  contentLength: number;     // Blob size in bytes
  localPath: string;         // Absolute path where blob was synced locally
  blobPath: string;          // Full blob path (includes prefix)
}

interface AzureVenvManifest {
  version: string;           // Manifest schema version (e.g., "1.0.0")
  generatedAt: string;       // ISO 8601 timestamp of last sync
  containerName: string;     // Azure container name
  blobPrefix: string;        // Blob prefix (virtual folder)
  entries: Record<string, BlobManifestEntry>; // Key: blob name, Value: metadata
}
```

**Manifest Operations**:
- `loadManifest(appRootPath: string): AzureVenvManifest | null` -- reads manifest, returns null if not found
- `saveManifest(manifest: AzureVenvManifest, appRootPath: string): Promise<void>` -- atomically writes manifest
- `updateManifest(manifest: AzureVenvManifest, blobItems: BlobItem[], appRootPath: string): AzureVenvManifest` -- updates entries based on current blob listing
- `detectChanges(manifest: AzureVenvManifest, currentBlobs: BlobItem[]): BlobChanges` -- compares ETags, returns what changed

**Manifest Path**:
- Always: `path.join(appRootPath, '.azure-venv-manifest.json')`
- No configurability
- Add to `.gitignore`

**Atomic Write Pattern**:
```typescript
async function saveManifest(manifest: AzureVenvManifest, appRootPath: string): Promise<void> {
  const manifestPath = path.join(appRootPath, '.azure-venv-manifest.json');
  const tempPath = `${manifestPath}.tmp`;

  // Write to temp file
  await fs.promises.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Atomic rename
  await fs.promises.rename(tempPath, manifestPath);
}
```
</task>

<task name="watch-mode-design">
Design the watch mode architecture:

**Configuration Options**:
```typescript
interface WatchOptions {
  enabled: boolean;          // AZURE_VENV_WATCH_ENABLED (default: false)
  intervalMs: number;        // AZURE_VENV_WATCH_INTERVAL_MS (default: 60000)
}
```

**Change Detection Types**:
```typescript
interface BlobChanges {
  added: BlobItem[];         // New blobs not in manifest
  modified: BlobItem[];      // Blobs with different ETags
  deleted: string[];         // Blob paths in manifest but not in current listing
}

type ChangeType = 'added' | 'modified' | 'deleted';

interface ChangeEvent {
  type: ChangeType;
  blobPath: string;
  localPath?: string;
}
```

**Watch Loop Architecture**:
```typescript
class BlobWatcher {
  private intervalId: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  async start(config: AzureVenvConfig, options: WatchOptions): Promise<void> {
    // Initial sync
    await this.performSync(config);

    // Set up polling interval
    this.intervalId = setInterval(async () => {
      if (this.isShuttingDown) return;
      await this.checkForChanges(config);
    }, options.intervalMs);

    // Register shutdown handlers
    this.registerShutdownHandlers();
  }

  private async checkForChanges(config: AzureVenvConfig): Promise<void> {
    // 1. Load current manifest
    // 2. List current blobs from Azure
    // 3. Detect changes (added, modified, deleted)
    // 4. Sync changed blobs
    // 5. Update manifest
    // 6. Log changes
  }

  private registerShutdownHandlers(): void {
    const shutdown = () => {
      this.isShuttingDown = true;
      if (this.intervalId) {
        clearInterval(this.intervalId);
      }
      logger.info('[azure-venv] Watch mode stopped gracefully.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
```

**Integration with Main API**:
```typescript
export async function initialize(options?: InitOptions): Promise<SyncResult | null> {
  // ... existing sync logic ...

  const watchOptions = getWatchOptions(); // Read from env vars

  if (watchOptions.enabled) {
    logger.info('[azure-venv] Watch mode enabled. Starting blob monitoring...');
    const watcher = new BlobWatcher();
    await watcher.start(config, watchOptions);
    // Note: watch mode runs indefinitely; process must be explicitly terminated
  }

  return result;
}
```

**Error Handling in Watch Loop**:
- Transient Azure errors: log warning, continue watching (don't crash)
- Persistent errors (e.g., invalid credentials): log error, stop watching
- Manifest corruption: log error, recreate manifest from scratch
</task>

<task name="cli-design">
Design the CLI command:

**CLI Entry Point** (`src/cli.ts`):
```typescript
#!/usr/bin/env node

import { initialize } from './index';
import { logger } from './logging/logger';

async function main() {
  try {
    logger.info('[azure-venv-sync] Starting manual re-sync...');

    const result = await initialize({
      appRootPath: process.cwd(),
    });

    if (result === null) {
      logger.info('[azure-venv-sync] No Azure configuration found. Nothing to sync.');
      process.exit(0);
    }

    logger.info(`[azure-venv-sync] Sync complete: ${result.downloadedFiles.length} files downloaded.`);
    if (result.failedFiles.length > 0) {
      logger.error(`[azure-venv-sync] ${result.failedFiles.length} files failed to download.`);
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    logger.error(`[azure-venv-sync] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
```

**Package.json Configuration**:
```json
{
  "name": "azure-venv",
  "version": "1.0.0",
  "bin": {
    "azure-venv-sync": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli.ts --format cjs,esm --dts",
    "sync": "node dist/cli.js"
  }
}
```

**Build Configuration** (tsup):
- Ensure `cli.ts` is included in build output
- Ensure shebang is preserved in built file
- Generate both CJS and ESM versions if needed (CJS sufficient for CLI)

**CLI Usage Documentation**:
```bash
# After npm install (global or local)
npx azure-venv-sync

# Or if installed globally
azure-venv-sync

# Or via npm script
npm run sync
```
</task>

<task name="blob-size-threshold-design">
Design the configurable blob size threshold:

**Configuration**:
```typescript
interface DownloadOptions {
  maxBlobSize: number;       // AZURE_VENV_MAX_BLOB_SIZE (default: 104857600 = 100MB)
}
```

**Configuration Loading**:
```typescript
function getDownloadOptions(): DownloadOptions {
  const maxBlobSizeStr = process.env.AZURE_VENV_MAX_BLOB_SIZE;

  if (maxBlobSizeStr === undefined) {
    return { maxBlobSize: 104857600 }; // Default: 100MB
  }

  const maxBlobSize = parseInt(maxBlobSizeStr, 10);

  if (isNaN(maxBlobSize) || maxBlobSize <= 0) {
    throw new ConfigurationError(
      `AZURE_VENV_MAX_BLOB_SIZE must be a positive integer (bytes). Got: "${maxBlobSizeStr}"`
    );
  }

  return { maxBlobSize };
}
```

**Download Strategy Selection**:
```typescript
async function downloadBlob(
  blobClient: BlobClient,
  localPath: string,
  contentLength: number,
  maxBlobSize: number
): Promise<void> {
  // Create parent directory
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  if (contentLength <= maxBlobSize) {
    // Small-to-medium blobs: use buffered download
    logger.debug(`[azure-venv] Downloading ${blobClient.name} using buffered method (${contentLength} bytes)`);
    await blobClient.downloadToFile(localPath);
  } else {
    // Large blobs: use streaming download
    logger.debug(`[azure-venv] Downloading ${blobClient.name} using streaming method (${contentLength} bytes)`);
    const response = await blobClient.download();

    if (!response.readableStreamBody) {
      throw new SyncError('Blob download response has no stream body', blobClient.name);
    }

    const writeStream = fs.createWriteStream(localPath);

    await new Promise<void>((resolve, reject) => {
      response.readableStreamBody!
        .pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });
  }

  logger.debug(`[azure-venv] Downloaded ${blobClient.name} to ${localPath}`);
}
```

**Integration**:
- Update `blob-downloader.ts` to accept `maxBlobSize` parameter
- Pass `contentLength` from `BlobItem.properties.contentLength` to `downloadBlob()`
- Log which strategy is used for each blob (debug level)
</task>

<task name="configuration-schema-update">
Update the complete configuration schema with all new options:

```typescript
interface AzureVenvConfig {
  // Existing required options
  azureVenv: string;                      // AZURE_VENV
  azureVenvSasToken: string;              // AZURE_VENV_SAS_TOKEN
  appRootPath: string;                    // Derived from options or process.cwd()

  // Existing optional options
  syncOptions?: SyncOptions;

  // NEW: Watch mode options
  watchOptions?: WatchOptions;

  // NEW: Download options
  downloadOptions?: DownloadOptions;
}

interface WatchOptions {
  enabled: boolean;                       // AZURE_VENV_WATCH_ENABLED (default: false)
  intervalMs: number;                     // AZURE_VENV_WATCH_INTERVAL_MS (default: 60000)
}

interface DownloadOptions {
  maxBlobSize: number;                    // AZURE_VENV_MAX_BLOB_SIZE (default: 104857600)
}
```

**Environment Variable Summary**:
| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `AZURE_VENV` | string | yes (if token set) | - | Azure Blob Storage URL with path |
| `AZURE_VENV_SAS_TOKEN` | string | yes (if URL set) | - | SAS token for authentication |
| `AZURE_VENV_WATCH_ENABLED` | boolean | no | false | Enable watch mode for continuous sync |
| `AZURE_VENV_WATCH_INTERVAL_MS` | number | no | 60000 | Polling interval in milliseconds |
| `AZURE_VENV_MAX_BLOB_SIZE` | number | no | 104857600 | Max blob size for buffered download (bytes) |
</task>

<task name="orphan-file-documentation-design">
Design the documentation for orphan file management decision:

**Section for project-design.md**:
```markdown
### Orphan File Management (Not Implemented in v1)

**Definition**: Orphan files are local files that were previously synced from Azure Blob Storage but have since been deleted from the remote storage.

**Decision**: Orphan file cleanup is NOT implemented in v1 of azure-venv.

**Rationale**:
1. **Safety**: Risk of accidentally deleting user-created local files that happen to be in the sync directory
2. **Simplicity**: Detecting true orphans requires careful logic to distinguish Azure-synced files from other sources
3. **User Control**: Users can manually delete files they no longer need
4. **Future Enhancement**: This feature can be added in v2 with proper safeguards (e.g., confirmation prompts, dry-run mode)

**Potential v2 Approaches**:
- Manifest-based detection: files in manifest but not in current Azure blob listing
- Optional cleanup with user confirmation
- Dry-run mode to preview deletions before executing
- Configurable behavior (never clean, prompt, auto-clean)

**Current Behavior**:
- Files that are deleted from Azure Blob Storage remain on the local filesystem
- The manifest will no longer track them after the next sync
- Watch mode will not re-download deleted files
```

**Section for Issues - Pending Items.md**:
```markdown
## Future Enhancements

### Orphan File Cleanup (v2 Consideration)
**Priority**: Medium
**Status**: Not Implemented in v1

Implement optional cleanup of local files that were previously synced from Azure but have been deleted from remote storage.

**Requirements**:
- Safe detection of orphan files (distinguish from user-created files)
- User confirmation before deletion
- Dry-run mode to preview deletions
- Configurable behavior via environment variable
- Comprehensive testing to prevent accidental data loss

**Reference**: See project-design.md for detailed analysis and rationale for v1 exclusion.
```
</task>

<task name="module-structure-update">
Update the module structure to accommodate new features:

```
src/
  index.ts                    -- Public API (updated with watch mode support)
  cli.ts                      -- NEW: CLI entry point
  config/
    config-loader.ts          -- UPDATED: load watch and download options
    config-validator.ts       -- UPDATED: validate new options
    config-types.ts           -- UPDATED: new interfaces
  azure/
    blob-client-factory.ts    -- No changes
    blob-lister.ts            -- No changes
    blob-downloader.ts        -- UPDATED: add size threshold logic
    azure-types.ts            -- No changes
  sync/
    sync-engine.ts            -- UPDATED: initialize manifest after sync
    directory-resolver.ts     -- No changes
    env-merger.ts             -- No changes
    sync-types.ts             -- UPDATED: new types
  watch/                      -- NEW: Watch mode module
    blob-watcher.ts           -- NEW: Watch loop implementation
    change-detector.ts        -- NEW: ETag-based change detection
    watch-types.ts            -- NEW: Watch-related types
  manifest/                   -- NEW: Manifest management module
    manifest-manager.ts       -- NEW: Load/save/update manifest
    manifest-types.ts         -- NEW: Manifest interfaces
  errors/
    errors.ts                 -- No changes (may add watch-specific errors)
  logging/
    logger.ts                 -- No changes
  types/
    index.ts                  -- UPDATED: export new types
```
</task>
</tasks>

<output>
Update `docs/design/project-design.md` with:
- New manifest architecture and file format
- Watch mode architecture and flow
- CLI command design
- Blob size threshold configuration and logic
- Orphan file management decision and rationale
- Updated configuration schema with all new options
- Updated module structure

Create a new section in the design document for each enhancement with detailed technical specifications.
</output>
</phase>

<!-- ============================================================ -->
<!-- PHASE 4: IMPLEMENTATION                                      -->
<!-- ============================================================ -->

<phase name="implementation" order="4">
<objective>
Implement all five design decisions following the architecture from Phase 3. Implement in the planned order: manifest location, blob size threshold, watch mode, CLI command, orphan file documentation.
</objective>

<tasks>
<task name="implement-manifest-location-standardization">
**Priority**: 1st (Foundation for other features)

Implementation steps:
1. Review current codebase for any `manifestPath` configuration option
2. Remove or lock `manifestPath` to always use project root
3. Update all manifest file operations to use: `path.join(appRootPath, '.azure-venv-manifest.json')`
4. Add `.azure-venv-manifest.json` to `.gitignore` (if .gitignore exists in project template)
5. Update any existing tests that reference manifest path
6. Update documentation to reflect the standardized location

Code changes:
```typescript
// In manifest-manager.ts (or wherever manifest path is determined)
function getManifestPath(appRootPath: string): string {
  return path.join(appRootPath, '.azure-venv-manifest.json');
}

// Remove any manifestPath from config interfaces
// Remove any manifestPath parameters from functions
```

Testing:
- Verify manifest is created at project root after first sync
- Verify manifest is loaded from project root on subsequent syncs
- Verify no other locations are checked or used
</task>

<task name="implement-manifest-management">
**Priority**: 1st (Required for watch mode)

Create the `src/manifest/` module:

**File: `src/manifest/manifest-types.ts`**:
```typescript
export interface BlobManifestEntry {
  etag: string;
  lastModified: string;
  contentLength: number;
  localPath: string;
  blobPath: string;
}

export interface AzureVenvManifest {
  version: string;
  generatedAt: string;
  containerName: string;
  blobPrefix: string;
  entries: Record<string, BlobManifestEntry>;
}
```

**File: `src/manifest/manifest-manager.ts`**:
Implement:
- `getManifestPath(appRootPath: string): string`
- `loadManifest(appRootPath: string): Promise<AzureVenvManifest | null>`
- `saveManifest(manifest: AzureVenvManifest, appRootPath: string): Promise<void>` (with atomic write)
- `createManifest(containerName: string, blobPrefix: string, blobItems: BlobItem[], appRootPath: string): AzureVenvManifest`
- `updateManifestEntries(manifest: AzureVenvManifest, blobItems: BlobItem[], appRootPath: string): void`

**Integration**:
- Update `sync-engine.ts` to create/update manifest after successful sync
- Pass `BlobItem[]` to manifest manager to populate entries with ETags

Testing:
- Test manifest creation with sample blob items
- Test manifest loading (file exists, file doesn't exist, corrupted JSON)
- Test atomic save (write to temp, rename)
- Test manifest update with new/modified/deleted blobs
</task>

<task name="implement-blob-size-threshold">
**Priority**: 2nd (Independent feature)

Implementation steps:

1. **Update `src/config/config-types.ts`**:
```typescript
export interface DownloadOptions {
  maxBlobSize: number;
}
```

2. **Update `src/config/config-loader.ts`**:
```typescript
export function getDownloadOptions(): DownloadOptions {
  const maxBlobSizeStr = process.env.AZURE_VENV_MAX_BLOB_SIZE;

  if (maxBlobSizeStr === undefined) {
    return { maxBlobSize: 104857600 }; // 100MB default
  }

  const maxBlobSize = parseInt(maxBlobSizeStr, 10);

  if (isNaN(maxBlobSize) || maxBlobSize <= 0) {
    throw new ConfigurationError(
      `AZURE_VENV_MAX_BLOB_SIZE must be a positive integer (bytes). Got: "${maxBlobSizeStr}"`
    );
  }

  return { maxBlobSize };
}
```

3. **Update `src/azure/blob-downloader.ts`**:
```typescript
export async function downloadBlob(
  blobClient: BlobClient,
  localPath: string,
  contentLength: number,
  maxBlobSize: number
): Promise<void> {
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  if (contentLength <= maxBlobSize) {
    logger.debug(`[azure-venv] Downloading ${blobClient.name} using buffered method (${contentLength} bytes)`);
    await blobClient.downloadToFile(localPath);
  } else {
    logger.debug(`[azure-venv] Downloading ${blobClient.name} using streaming method (${contentLength} bytes)`);
    const response = await blobClient.download();

    if (!response.readableStreamBody) {
      throw new SyncError('Blob download response has no stream body', blobClient.name);
    }

    const writeStream = fs.createWriteStream(localPath);

    await new Promise<void>((resolve, reject) => {
      response.readableStreamBody!
        .pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });
  }
}
```

4. **Update `src/sync/sync-engine.ts`**:
- Load `downloadOptions` from config
- Pass `contentLength` and `maxBlobSize` to `downloadBlob()`

Testing:
- Test with `AZURE_VENV_MAX_BLOB_SIZE` unset (uses default)
- Test with valid value (e.g., 50000000 = 50MB)
- Test with invalid values (non-numeric, negative, zero)
- Test download strategy selection (small blob uses buffered, large uses streaming)
- Integration test with blobs of various sizes
</task>

<task name="implement-watch-mode">
**Priority**: 3rd (Depends on manifest)

Implementation steps:

1. **Create `src/watch/watch-types.ts`**:
```typescript
export interface WatchOptions {
  enabled: boolean;
  intervalMs: number;
}

export interface BlobChanges {
  added: BlobItem[];
  modified: BlobItem[];
  deleted: string[];
}

export type ChangeType = 'added' | 'modified' | 'deleted';

export interface ChangeEvent {
  type: ChangeType;
  blobPath: string;
  localPath?: string;
}
```

2. **Create `src/watch/change-detector.ts`**:
```typescript
export function detectChanges(
  manifest: AzureVenvManifest,
  currentBlobs: BlobItem[]
): BlobChanges {
  const added: BlobItem[] = [];
  const modified: BlobItem[] = [];
  const deleted: string[] = [];

  // Create a map of current blobs by path
  const currentBlobMap = new Map<string, BlobItem>();
  for (const blob of currentBlobs) {
    currentBlobMap.set(blob.name, blob);
  }

  // Check for modified and deleted blobs
  for (const [blobPath, entry] of Object.entries(manifest.entries)) {
    const currentBlob = currentBlobMap.get(blobPath);

    if (!currentBlob) {
      // Blob in manifest but not in current listing = deleted
      deleted.push(blobPath);
    } else if (currentBlob.properties.etag !== entry.etag) {
      // Blob exists but ETag changed = modified
      modified.push(currentBlob);
    }
    // else: no change
  }

  // Check for added blobs
  for (const blob of currentBlobs) {
    if (!manifest.entries[blob.name]) {
      added.push(blob);
    }
  }

  return { added, modified, deleted };
}
```

3. **Create `src/watch/blob-watcher.ts`**:
```typescript
export class BlobWatcher {
  private intervalId: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  async start(config: AzureVenvConfig, options: WatchOptions): Promise<void> {
    logger.info(`[azure-venv] Watch mode started. Polling interval: ${options.intervalMs}ms`);

    // Set up polling interval
    this.intervalId = setInterval(async () => {
      if (this.isShuttingDown) return;

      try {
        await this.checkForChanges(config);
      } catch (error) {
        logger.error(`[azure-venv] Error in watch loop: ${error instanceof Error ? error.message : String(error)}`);
        // Continue watching despite errors (transient failures should not stop the watcher)
      }
    }, options.intervalMs);

    // Register shutdown handlers
    this.registerShutdownHandlers();
  }

  private async checkForChanges(config: AzureVenvConfig): Promise<void> {
    logger.debug('[azure-venv] Checking for blob changes...');

    // 1. Load current manifest
    const manifest = await loadManifest(config.appRootPath);
    if (!manifest) {
      logger.warn('[azure-venv] Manifest not found. Skipping change detection.');
      return;
    }

    // 2. List current blobs from Azure
    const parsedUrl = parseAzureVenvUrl(config.azureVenv);
    const blobServiceClient = createBlobServiceClient(parsedUrl.storageAccountUrl, config.azureVenvSasToken);
    const containerClient = blobServiceClient.getContainerClient(parsedUrl.containerName);

    const currentBlobs: BlobItem[] = [];
    for await (const blob of listBlobs(containerClient, parsedUrl.blobPrefix)) {
      currentBlobs.push(blob);
    }

    // 3. Detect changes
    const changes = detectChanges(manifest, currentBlobs);

    // 4. Log changes
    const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length;
    if (totalChanges === 0) {
      logger.debug('[azure-venv] No changes detected.');
      return;
    }

    logger.info(`[azure-venv] Changes detected: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`);

    // 5. Sync changed blobs (added + modified)
    const blobsToSync = [...changes.added, ...changes.modified];
    for (const blob of blobsToSync) {
      const localPath = resolveLocalPath(blob.name, parsedUrl.blobPrefix, config.appRootPath);
      const blobClient = containerClient.getBlobClient(blob.name);

      await downloadBlob(
        blobClient,
        localPath,
        blob.properties.contentLength!,
        config.downloadOptions?.maxBlobSize ?? 104857600
      );

      logger.info(`[azure-venv] Re-synced: ${blob.name}`);
    }

    // 6. Update manifest (but don't delete orphan files)
    updateManifestEntries(manifest, currentBlobs, config.appRootPath);
    await saveManifest(manifest, config.appRootPath);

    // 7. Check if remote .env was modified and reload if necessary
    const remoteEnvModified = blobsToSync.some(blob => blob.name.endsWith('.env'));
    if (remoteEnvModified) {
      logger.info('[azure-venv] Remote .env file was modified. Reloading environment variables...');
      const envPath = path.join(config.appRootPath, '.env');
      if (await fs.promises.access(envPath).then(() => true).catch(() => false)) {
        mergeRemoteEnv(envPath);
      }
    }
  }

  private registerShutdownHandlers(): void {
    const shutdown = () => {
      logger.info('[azure-venv] Shutdown signal received. Stopping watch mode...');
      this.isShuttingDown = true;

      if (this.intervalId) {
        clearInterval(this.intervalId);
      }

      logger.info('[azure-venv] Watch mode stopped gracefully.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  stop(): void {
    this.isShuttingDown = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
```

4. **Update `src/config/config-loader.ts`**:
```typescript
export function getWatchOptions(): WatchOptions {
  const enabledStr = process.env.AZURE_VENV_WATCH_ENABLED?.toLowerCase();
  const intervalStr = process.env.AZURE_VENV_WATCH_INTERVAL_MS;

  const enabled = enabledStr === 'true';

  let intervalMs = 60000; // Default: 1 minute
  if (intervalStr !== undefined) {
    const parsed = parseInt(intervalStr, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new ConfigurationError(
        `AZURE_VENV_WATCH_INTERVAL_MS must be a positive integer (milliseconds). Got: "${intervalStr}"`
      );
    }
    intervalMs = parsed;
  }

  return { enabled, intervalMs };
}
```

5. **Update `src/index.ts`**:
```typescript
export async function initialize(options?: InitOptions): Promise<SyncResult | null> {
  // ... existing sync logic ...

  // After successful sync
  const watchOptions = getWatchOptions();

  if (watchOptions.enabled) {
    logger.info('[azure-venv] Watch mode enabled. Starting blob monitoring...');
    const watcher = new BlobWatcher();
    // Note: This will run indefinitely; use CLI or application lifecycle to manage
    await watcher.start(config, watchOptions);
  }

  return result;
}
```

Testing:
- Unit test for `detectChanges()` with various scenarios (added, modified, deleted, no changes)
- Unit test for watch option parsing (valid, invalid, defaults)
- Integration test with Azurite: modify a blob, verify watch loop detects and re-syncs
- Integration test: add a new blob, verify detection
- Integration test: delete a blob (verify it's detected but not deleted locally)
- Test shutdown handlers (SIGINT, SIGTERM)
- Test error handling in watch loop (transient errors should not stop the watcher)
</task>

<task name="implement-cli-command">
**Priority**: 4th (Standalone feature)

Implementation steps:

1. **Create `src/cli.ts`**:
```typescript
#!/usr/bin/env node

import { initialize } from './index.js'; // Use .js extension for ESM compatibility
import { logger } from './logging/logger.js';

async function main(): Promise<void> {
  try {
    logger.info('[azure-venv-sync] Starting manual re-sync...');

    // Use current working directory as app root
    const result = await initialize({
      appRootPath: process.cwd(),
    });

    if (result === null) {
      logger.info('[azure-venv-sync] No Azure configuration found. Nothing to sync.');
      process.exit(0);
    }

    // Display summary
    logger.info(`[azure-venv-sync] Sync complete!`);
    logger.info(`  - Files downloaded: ${result.downloadedFiles.length}`);
    logger.info(`  - Files skipped: ${result.skippedFiles.length}`);
    logger.info(`  - Files failed: ${result.failedFiles.length}`);
    logger.info(`  - Duration: ${result.durationMs}ms`);

    if (result.remoteEnvLoaded) {
      logger.info(`  - Remote .env file loaded: Yes`);
    }

    if (result.failedFiles.length > 0) {
      logger.error('[azure-venv-sync] Some files failed to download:');
      for (const failure of result.failedFiles) {
        logger.error(`  - ${failure.blobPath}: ${failure.error}`);
      }
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    logger.error(`[azure-venv-sync] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.error(`[azure-venv-sync] Unhandled rejection: ${reason}`);
  process.exit(1);
});

main();
```

2. **Update `package.json`**:
```json
{
  "name": "azure-venv",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "azure-venv-sync": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/index.ts src/cli.ts --format esm --dts",
    "sync": "node dist/cli.js"
  },
  "files": [
    "dist"
  ]
}
```

3. **Update build configuration** (if using tsup):
- Ensure `cli.ts` is included in build
- Ensure shebang is preserved
- Ensure executable permissions are set

4. **Post-build script** (if needed):
```json
{
  "scripts": {
    "postbuild": "chmod +x dist/cli.js"
  }
}
```

Testing:
- Unit test: spawn CLI process, verify exit code 0 on success
- Unit test: spawn CLI process with invalid config, verify exit code 1
- Integration test: run CLI with Azurite, verify files are synced
- Manual test: install package locally, run `npx azure-venv-sync`
- Manual test: verify help output and error messages are clear
</task>

<task name="document-orphan-file-decision">
**Priority**: 5th (Documentation only)

Implementation steps:

1. **Update `docs/design/project-design.md`**:
Add a new section titled "Orphan File Management Decision" with the content designed in Phase 3.

2. **Update `Issues - Pending Items.md`**:
Add a new future enhancement item for orphan file cleanup under the "Future Enhancements" section.

3. **Update `docs/design/project-functions.md`**:
Add a functional requirement noting that orphan file cleanup is NOT a feature in v1.

No code changes required.
</task>

<task name="update-configuration-guide">
Update `docs/design/configuration-guide.md` with all new configuration options:

Add sections for:
- `AZURE_VENV_WATCH_ENABLED`
- `AZURE_VENV_WATCH_INTERVAL_MS`
- `AZURE_VENV_MAX_BLOB_SIZE`

For each, document:
- Purpose and use
- How to set the value
- Valid values and defaults
- Examples
- Recommendations (e.g., don't set watch interval too low to avoid excessive API costs)
</task>

<task name="update-gitignore">
Add the manifest file to `.gitignore`:

```
.azure-venv-manifest.json
```

If the library provides a template or documentation for `.gitignore`, include this there as well.
</task>
</tasks>

<constraints>
- All new configuration variables must be validated with clear error messages
- Watch mode must be opt-in (disabled by default)
- Watch mode must handle shutdown signals gracefully
- CLI must use the same configuration loading logic as the library
- Manifest writes must be atomic to prevent corruption
- All changes must maintain backward compatibility (except manifest location, which is a simplification)
- No fallback values for required configuration; operational defaults only for optional features
- Comprehensive logging at appropriate levels (debug, info, warn, error)
- All new code must follow existing code style and patterns
</constraints>
</phase>

<!-- ============================================================ -->
<!-- PHASE 5: TESTING                                             -->
<!-- ============================================================ -->

<phase name="testing" order="5">
<objective>
Create comprehensive tests for all new features: manifest management, blob size threshold, watch mode, and CLI command.
</objective>

<tasks>
<task name="unit-tests-manifest">
Write unit tests for manifest management (`tests/unit/manifest/`):

**File: `manifest-manager.test.ts`**:
- Test `loadManifest()` with existing manifest file
- Test `loadManifest()` with non-existent file (returns null)
- Test `loadManifest()` with corrupted JSON (throws or returns null)
- Test `saveManifest()` creates manifest file
- Test `saveManifest()` uses atomic write (write to temp, rename)
- Test `createManifest()` generates valid manifest from blob items
- Test `updateManifestEntries()` updates entries correctly
- Test manifest path is always `<appRoot>/.azure-venv-manifest.json`
</task>

<task name="unit-tests-change-detection">
Write unit tests for change detection (`tests/unit/watch/`):

**File: `change-detector.test.ts`**:
- Test `detectChanges()` with no changes (empty arrays)
- Test `detectChanges()` with added blobs
- Test `detectChanges()` with modified blobs (different ETags)
- Test `detectChanges()` with deleted blobs (in manifest, not in listing)
- Test `detectChanges()` with mixed changes (added + modified + deleted)
- Test `detectChanges()` with empty manifest
- Test `detectChanges()` with empty blob listing
</task>

<task name="unit-tests-blob-size-threshold">
Write unit tests for blob size threshold (`tests/unit/azure/`):

**File: `blob-downloader.test.ts`** (update existing or create new):
- Test `downloadBlob()` uses buffered download for small blobs (size <= threshold)
- Test `downloadBlob()` uses streaming download for large blobs (size > threshold)
- Test threshold parsing from environment variable
- Test invalid threshold values throw `ConfigurationError`
- Test default threshold (100MB) is used when not configured
</task>

<task name="unit-tests-watch-options">
Write unit tests for watch options (`tests/unit/config/`):

**File: `config-loader.test.ts`** (update existing):
- Test `getWatchOptions()` with enabled=true
- Test `getWatchOptions()` with enabled=false or undefined (default)
- Test `getWatchOptions()` with valid interval
- Test `getWatchOptions()` with invalid interval (throws)
- Test `getWatchOptions()` with default interval (60000ms)
</task>

<task name="integration-tests-watch-mode">
Write integration tests for watch mode using Azurite (`tests/integration/`):

**File: `watch-mode.test.ts`**:
- Setup: Start Azurite, create container, upload initial blobs
- Test: Start watch mode, modify a blob, wait for polling interval, verify re-sync
- Test: Add a new blob, verify detection and download
- Test: Delete a blob from Azure, verify detection (but not local deletion)
- Test: Modify remote `.env` file, verify variables are reloaded
- Test: Shutdown signals stop watch mode gracefully
- Teardown: Stop Azurite, clean up

**Note**: Use shorter polling intervals in tests (e.g., 5000ms) to speed up tests.
</task>

<task name="integration-tests-blob-size-threshold">
Write integration tests for blob size threshold (`tests/integration/`):

**File: `blob-size-threshold.test.ts`**:
- Upload blobs of various sizes to Azurite (small: 1KB, medium: 50MB, large: 150MB)
- Set `AZURE_VENV_MAX_BLOB_SIZE` to 100MB
- Run sync
- Verify all blobs are downloaded correctly
- Verify log messages indicate which download method was used (buffered vs streaming)
- Test with different threshold values
</task>

<task name="integration-tests-cli">
Write integration tests for CLI command (`tests/integration/`):

**File: `cli.test.ts`**:
- Test: Spawn CLI process with valid config, verify exit code 0
- Test: Spawn CLI process without config, verify exit code 0, no sync
- Test: Spawn CLI process with invalid config, verify exit code 1
- Test: Verify CLI output contains expected messages
- Test: Verify CLI performs actual sync (check for downloaded files)
- Test: Verify CLI handles errors gracefully (e.g., network failure)

**Implementation pattern**:
```typescript
import { spawn } from 'child_process';

async function runCli(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/cli.js'], {
      env: { ...process.env, ...env },
      cwd: testAppRoot,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });
}
```
</task>

<task name="e2e-tests">
Write end-to-end tests simulating real-world usage:

**File: `tests/e2e/watch-mode-e2e.test.ts`**:
- Simulate an application that starts with watch mode enabled
- Modify blobs in Azure during runtime
- Verify application can access updated files
- Verify environment variables are reloaded

**File: `tests/e2e/cli-e2e.test.ts`**:
- Install the package locally in a test directory
- Run `npx azure-venv-sync`
- Verify files are synced
- Verify environment variables are loaded
- Verify subsequent runs work correctly
</task>

<task name="test-fixtures-update">
Update test fixtures to support new features:

```
tests/fixtures/
  manifest/
    valid-manifest.json           -- Sample valid manifest
    empty-manifest.json           -- Empty manifest
    corrupted-manifest.json       -- Invalid JSON
  remote-blobs/
    large-file.bin                -- >100MB file for threshold testing
    small-file.txt                -- <1MB file
  env-files/
    updated-env                   -- Modified .env file for watch mode tests
```
</task>

<task name="test-coverage-verification">
Run coverage reports and ensure:
- Manifest management: 100% coverage
- Change detection: 100% coverage
- Watch mode: >90% coverage (exclude shutdown handlers)
- Blob size threshold: 100% coverage
- CLI: >90% coverage
- Overall project: >90% coverage
</task>
</tasks>

<test-scenarios>
**Watch Mode Scenarios**:
1. No changes detected (happy path)
2. Single blob modified
3. Multiple blobs modified simultaneously
4. New blob added
5. Blob deleted from Azure (detected but not deleted locally)
6. Remote `.env` modified (variables reloaded)
7. Manifest file deleted (graceful recovery)
8. Azure connection fails during watch loop (error logged, continues watching)
9. Shutdown signal received (graceful stop)

**Blob Size Threshold Scenarios**:
1. Blob size < threshold (buffered download)
2. Blob size = threshold (buffered download)
3. Blob size > threshold (streaming download)
4. Invalid threshold config (error thrown)
5. Threshold not configured (default used)

**CLI Scenarios**:
1. Valid config, successful sync
2. No config, no-op
3. Invalid config, error exit
4. Partial sync failure (some files fail)
5. Azure connection error
6. Working directory has no `.env` file
</test-scenarios>
</phase>

<!-- ============================================================ -->
<!-- CROSS-CUTTING CONCERNS                                       -->
<!-- ============================================================ -->

<cross-cutting-concerns>
<security>
- NEVER log SAS tokens or environment variable values in watch loop logs
- Validate all configuration values before use
- Ensure manifest file is not readable by other users (check file permissions if necessary)
- CLI should not expose sensitive information in help or error messages
</security>

<performance>
- Watch mode polling interval should be configurable to balance responsiveness vs API costs
- Use ETag-based change detection to minimize unnecessary downloads
- Manifest file should be cached in memory during watch loop (avoid disk I/O on every poll)
- Concurrent download limits should still apply in watch mode re-sync
- Large blob streaming should minimize memory usage
</performance>

<reliability>
- Manifest writes must be atomic (no partial writes)
- Watch mode must handle transient Azure errors without crashing
- Watch mode must handle manifest corruption gracefully (recreate if needed)
- CLI must provide clear error messages and appropriate exit codes
- All async operations must have proper error handling
</reliability>

<usability>
- Watch mode should log meaningful messages at info level (not just debug)
- CLI should provide clear output for success and failure cases
- Configuration guide must explain cost implications of watch mode polling frequency
- Default values should be sensible for common use cases
</usability>

<documentation>
- Update `CLAUDE.md` with CLI tool documentation (following the specified format)
- Update configuration guide with all new options
- Update project design with architecture diagrams if helpful
- Provide examples of watch mode usage in README or usage guide
- Document the orphan file decision clearly
</documentation>
</cross-cutting-concerns>

<!-- ============================================================ -->
<!-- DELIVERABLES CHECKLIST                                        -->
<!-- ============================================================ -->

<deliverables>
<deliverable>Research document at `docs/reference/azure-venv-enhancements-research.md`</deliverable>
<deliverable>Implementation plan at `docs/design/plan-002-azure-venv-enhancements.md`</deliverable>
<deliverable>Updated project design at `docs/design/project-design.md`</deliverable>
<deliverable>Updated functional requirements at `docs/design/project-functions.md`</deliverable>
<deliverable>Updated configuration guide at `docs/design/configuration-guide.md`</deliverable>
<deliverable>Manifest management module at `src/manifest/`</deliverable>
<deliverable>Watch mode module at `src/watch/`</deliverable>
<deliverable>CLI entry point at `src/cli.ts`</deliverable>
<deliverable>Updated blob downloader with size threshold logic</deliverable>
<deliverable>Updated configuration loader with new options</deliverable>
<deliverable>Updated `src/index.ts` with watch mode integration</deliverable>
<deliverable>Updated `package.json` with `bin` entry</deliverable>
<deliverable>Comprehensive test suite for all new features</deliverable>
<deliverable>Updated `.gitignore` with manifest file</deliverable>
<deliverable>Updated `CLAUDE.md` with CLI tool documentation</deliverable>
<deliverable>Updated `Issues - Pending Items.md` with orphan file enhancement note</deliverable>
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

**Implementation Order Within Phase 4**:
1. Manifest location standardization (foundation)
2. Manifest management module (required for watch mode)
3. Blob size threshold (independent feature)
4. Watch mode (depends on manifest)
5. CLI command (depends on stable sync logic)
6. Orphan file documentation (final, documentation only)

After all phases are complete:
- Run the full test suite and ensure all tests pass.
- Verify test coverage meets targets (>90% overall, 100% for critical paths).
- Manually test watch mode with a live Azure storage account (if possible).
- Manually test CLI command in a real project context.
- Update the `Issues - Pending Items.md` file with any discovered issues or TODOs.
- Provide a final summary of the entire implementation with a feature checklist.
</execution-instructions>

<!-- ============================================================ -->
<!-- NOTES AND REMINDERS                                          -->
<!-- ============================================================ -->

<notes>
**Key Design Principles**:
1. Watch mode is opt-in (disabled by default) to avoid unexpected behavior
2. Manifest location is standardized for simplicity and predictability
3. Blob size threshold has a sensible operational default (100MB)
4. Orphan file cleanup is explicitly excluded from v1 for safety
5. CLI is a thin wrapper around the existing `initialize()` function

**Backward Compatibility**:
- Watch mode is additive (no breaking changes)
- Blob size threshold is additive (no breaking changes)
- Manifest location change may be breaking if users were configuring it (document clearly)
- CLI is additive (no breaking changes)

**Future Enhancements** (not in scope for this prompt):
- Event Grid integration for real-time blob change notifications
- Orphan file cleanup with user confirmation
- Incremental sync (only download changed portions of large files)
- Compression support for blob uploads/downloads
- Multi-container support
- Support for Azure managed identities (in addition to SAS tokens)
</notes>
</prompt>
