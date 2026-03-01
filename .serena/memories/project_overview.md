# azure-venv Project Overview

## Purpose
TypeScript library that syncs Azure Blob Storage files and environment variables to local filesystem on app startup, with optional continuous watch mode and CLI.

## Version
v0.3.0 (Introspection)

## Tech Stack
- Language: TypeScript (strict mode, ESM)
- Runtime: Node.js >= 18
- Dependencies: @azure/storage-blob, commander, dotenv, zod
- Testing: vitest (142 tests, 14 test files)
- Build: tsc

## Key Commands
- Build: `npm run build`
- Test: `npx vitest run`
- Type-check: `npx tsc --noEmit`
- CLI sync: `npx azure-venv sync`
- CLI watch: `npx azure-venv watch`

## Project Structure
```
src/
  index.ts              - Public API exports
  initialize.ts         - Main orchestrator (initAzureVenv)
  config/
    parser.ts           - AZURE_VENV URL parser
    validator.ts        - Config validation (Zod schemas)
    types.ts            - Configuration types/interfaces
  azure/
    client.ts           - Azure Blob Storage client (buffered + streaming)
    types.ts            - Azure-related types
  sync/
    engine.ts           - Sync orchestrator
    downloader.ts       - File download with concurrency + size threshold
    manifest.ts         - ETag manifest management
    path-validator.ts   - Path traversal prevention
  env/
    loader.ts           - .env file parser
    precedence.ts       - Three-tier precedence resolver
  watch/
    watcher.ts          - BlobWatcher class + watchAzureVenv function
    index.ts            - Barrel exports
  introspection/
    manifest-reader.ts  - manifestToSyncedFiles() - flat file list
    file-tree.ts        - buildFileTree() - hierarchical tree
    index.ts            - Barrel exports
  cli/
    index.ts            - CLI tool (sync/watch subcommands)
  errors/
    base.ts             - Base error class
    azure.ts            - Azure-specific errors
    config.ts           - Config errors
    sync.ts             - Sync errors
    index.ts            - Barrel exports
  logging/
    logger.ts           - Logger with SAS sanitization
  types/
    index.ts            - Shared types (SyncResult, SyncedFileInfo, FileTreeNode, etc.)
test_scripts/           - 14 test files
docs/design/            - Plans and project design
docs/reference/         - Research and reference material
```

## Public API
- `initAzureVenv(options?): Promise<SyncResult>` - Main entry point, one-time sync
- `watchAzureVenv(options?): Promise<WatchResult>` - Continuous watch mode
- Exported types: SyncResult, SyncedFileInfo, FileTreeNode, EnvDetails, WatchResult, WatchChangeEvent, WatchOptions, SyncManifest, ManifestEntry, EnvLoadResult
- Type aliases: EnvRecord, EnvSource, WatchChangeType
- Constants: NO_OP_SYNC_RESULT
- Utilities: buildFileTree(), manifestToSyncedFiles()

## Key Architecture
- 10 modules: config, azure, sync, env, watch, introspection, cli, errors, logging, types
- 3-tier env precedence: OS > remote .env > local .env
- ETag manifest for incremental sync (always at `{rootDir}/.azure-venv-manifest.json`)
- SAS token sanitization in all logs
- Streaming downloads for blobs > AZURE_VENV_MAX_BLOB_SIZE (default 100MB)
- BlobWatcher class: constructor, start(), stop(), poll() methods

## Key Interfaces (src/types/index.ts)
- SyncResult: attempted, downloaded, skipped, failed, totalBlobs, duration, failedBlobs, envSources, remoteEnvLoaded, envDetails, syncedFiles, fileTree
- FileTreeNode: name, type, path, children, blobName, size
- SyncedFileInfo: localPath, blobName, size, etag, lastModified
- EnvDetails: variables, sources, osKeys, remoteKeys, localKeys
- WatchResult: initialSync, stop
- WatchChangeEvent: type, blobName, localPath, timestamp

## Configuration Variables
| Variable | Required | Default |
|----------|----------|---------|
| AZURE_VENV | Yes* | - |
| AZURE_VENV_SAS_TOKEN | Yes* | - |
| AZURE_VENV_SAS_EXPIRY | No | - |
| AZURE_VENV_SYNC_MODE | No | full |
| AZURE_VENV_FAIL_ON_ERROR | No | false |
| AZURE_VENV_CONCURRENCY | No | 5 |
| AZURE_VENV_TIMEOUT | No | 30000 |
| AZURE_VENV_LOG_LEVEL | No | info |
| AZURE_VENV_MAX_BLOB_SIZE | No | 104857600 |
| AZURE_VENV_POLL_INTERVAL | No | 30000 |
| AZURE_VENV_WATCH_ENABLED | No | false |

*Required together - if one is set, both must be set. If neither, library is a no-op.

## Conventions
- All code in TypeScript
- No fallback values for AZURE_VENV and AZURE_VENV_SAS_TOKEN (raise exceptions)
- Operational params can have defaults (approved exception)
- Tests in test_scripts/ directory
- Plans in docs/design/plan-NNN-desc.md
- Tools documented in CLAUDE.md with XML format
- Singular table names for databases