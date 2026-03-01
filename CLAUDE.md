# azure-venv

TypeScript library that reads Azure Blob Storage files into memory and loads environment variables at startup, with optional continuous watch mode. No disk writes required.

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
    client.ts           - Azure Blob Storage client wrapper (buffer downloads only)
    types.ts            - Azure-related types
  sync/
    engine.ts           - In-memory sync orchestrator with concurrency control
  env/
    loader.ts           - .env file parser
    precedence.ts       - Three-tier precedence resolver
  watch/
    watcher.ts          - BlobWatcher class + watchAzureVenv function
  introspection/
    manifest-reader.ts  - sortBlobs() - sorted flat list from BlobContent[]
    file-tree.ts        - buildFileTree() - hierarchical tree from BlobContent[]
    index.ts            - Barrel exports
  cli/
    index.ts            - CLI tool (azure-venv sync/watch)
  errors/               - Custom error hierarchy
  logging/
    logger.ts           - Logger with SAS sanitization
  types/
    index.ts            - Shared types (SyncResult, BlobContent, FileTreeNode, EnvDetails, etc.)
test_scripts/           - Unit and integration tests
docs/
  design/               - Technical design and plans
  reference/            - Research and reference material
```

## Tools

<azure-venv-build>
    <objective>
        Build the azure-venv TypeScript library
    </objective>
    <command>
        npm run build
    </command>
    <info>
        Compiles TypeScript source files from src/ to dist/ using tsc.
        Output includes .js files and .d.ts type declarations.
        Also makes the CLI executable via postbuild script.
        Requires: npm install to have been run first.
    </info>
</azure-venv-build>

<azure-venv-test>
    <objective>
        Run the azure-venv test suite
    </objective>
    <command>
        npx vitest run
    </command>
    <info>
        Runs all unit tests using Vitest.
        Test files are located in test_scripts/ directory.
        Tests cover: config parsing, validation, env loading,
        precedence resolution, logging, error classes,
        watcher, introspection (sortBlobs, file-tree, types).

        For watch mode: npx vitest
        For coverage: npx vitest run --coverage
    </info>
</azure-venv-test>

<azure-venv-typecheck>
    <objective>
        Type-check the azure-venv library without emitting output
    </objective>
    <command>
        npx tsc --noEmit
    </command>
    <info>
        Runs the TypeScript compiler in check-only mode.
        Verifies all types are correct without producing output files.
        Uses tsconfig.json with strict mode enabled.
    </info>
</azure-venv-typecheck>

<azure-venv-cli-sync>
    <objective>
        One-time read from Azure Blob Storage via CLI
    </objective>
    <command>
        npx azure-venv sync [options]
    </command>
    <info>
        Performs a one-time read of Azure Blob Storage files into memory.
        Reads AZURE_VENV and AZURE_VENV_SAS_TOKEN from environment.

        Options:
          --root-dir <path>       Application root directory (default: cwd)
          --log-level <level>     Log level: debug, info, warn, error (default: info)
          --fail-on-error         Exit with error if Azure sync fails
          --concurrency <number>  Max parallel downloads (default: 5)

        Exit codes: 0=success, 1=error, 130=SIGINT
    </info>
</azure-venv-cli-sync>

<azure-venv-cli-watch>
    <objective>
        Start continuous watch mode for Azure Blob Storage changes
    </objective>
    <command>
        npx azure-venv watch [options]
    </command>
    <info>
        Performs initial sync then polls for blob changes continuously.
        Press Ctrl+C to stop gracefully.

        Options:
          --root-dir <path>         Application root directory (default: cwd)
          --log-level <level>       Log level: debug, info, warn, error (default: info)
          --fail-on-error           Exit with error if Azure sync fails
          --concurrency <number>    Max parallel downloads (default: 5)
          --poll-interval <ms>      Polling interval in ms (default: 30000)

        Exit codes: 0=success, 1=error, 130=SIGINT
    </info>
</azure-venv-cli-watch>

## Configuration Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| AZURE_VENV | Yes* | - | Azure Blob Storage URL (https://account.blob.core.windows.net/container/prefix) |
| AZURE_VENV_SAS_TOKEN | Yes* | - | SAS token for authentication (without leading ?) |
| AZURE_VENV_SAS_EXPIRY | No | - | ISO 8601 expiry date for proactive warnings |
| AZURE_VENV_FAIL_ON_ERROR | No | false | Whether Azure errors prevent app startup |
| AZURE_VENV_CONCURRENCY | No | 5 | Max parallel blob downloads (1-50) |
| AZURE_VENV_TIMEOUT | No | 30000 | Per-blob download timeout in ms |
| AZURE_VENV_LOG_LEVEL | No | info | Log level: debug, info, warn, error |
| AZURE_VENV_POLL_INTERVAL | No | 30000 | Watch mode polling interval in ms (5s-1hr) |
| AZURE_VENV_WATCH_ENABLED | No | false | Enable watch mode after initial sync |

*Required together - if one is set, both must be set. If neither is set, the library is a no-op.

## Design Decisions (v0.4.0 - In-Memory Mode)

- **In-memory only**: All blob contents are read into memory as `BlobContent` objects; no disk writes
- **Removed**: `BlobDownloader`, `ManifestManager`, `PathValidator`, streaming downloads, `syncMode`, `maxBlobSize`
- **SyncResult.blobs**: Replaces `syncedFiles` - array of `BlobContent` with `relativePath`, `content` (Buffer), `size`, `etag`, `lastModified`
- **Watch mode**: Uses in-memory ETag tracking instead of disk manifest for change detection
- **File tree**: Built from `BlobContent[]` using `relativePath` instead of disk paths
- **Introspection**: `sortBlobs()` replaces `manifestToSyncedFiles()`, `buildFileTree()` accepts `BlobContent[]`

## Design Decisions (v0.3.0 - Introspection)

- **File introspection**: SyncResult includes `blobs` (flat list) and `fileTree` (hierarchical) built from blob data
- **Env introspection**: SyncResult includes `envDetails` with variables, sources, and keys grouped by tier
- **New module**: `src/introspection/` with `sortBlobs()` and `buildFileTree()` utility functions
- **Public exports**: `BlobContent`, `FileTreeNode`, `EnvDetails` types + `buildFileTree`, `sortBlobs` functions
- **No new config**: No additional environment variables required
- **Security note**: `EnvDetails.variables` contains actual values; consumers should not log/serialize without filtering

## Design Decisions (v1.1)

- **Watch mode**: ETag-based polling, configurable interval, graceful SIGINT/SIGTERM shutdown
- **CLI**: Commander.js with `sync` and `watch` subcommands
