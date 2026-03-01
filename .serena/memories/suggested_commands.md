# Suggested Commands

## Development
- `npm run build` - Compile TypeScript to dist/ (includes postbuild for CLI executable)
- `npx tsc --noEmit` - Type-check without emitting

## Testing
- `npx vitest run` - Run all 142 tests (14 test files)
- `npx vitest` - Run tests in watch mode
- `npx vitest run --coverage` - Run with coverage

## CLI
- `npx azure-venv sync [options]` - One-time blob sync
  - `--root-dir <path>` - App root directory (default: cwd)
  - `--log-level <level>` - debug, info, warn, error (default: info)
  - `--fail-on-error` - Exit with error if sync fails
  - `--concurrency <number>` - Max parallel downloads (default: 5)
  - `--sync-mode <mode>` - full or incremental (default: full)
- `npx azure-venv watch [options]` - Continuous watch mode (all sync options plus:)
  - `--poll-interval <ms>` - Polling interval (default: 30000)

## Task Completion Checklist
1. Run `npx tsc --noEmit` to verify types
2. Run `npx vitest run` to verify all 142 tests pass
3. Run `npm run build` to verify build succeeds

## Test Files
- config-parser.test.ts - URL parsing
- config-validator.test.ts - Zod validation
- config-new-fields.test.ts - New config fields
- env-loader.test.ts - .env file parsing
- env-precedence.test.ts - Three-tier precedence
- path-validator.test.ts - Path traversal prevention
- manifest.test.ts - ETag manifest management
- manifest-reader.test.ts - manifestToSyncedFiles()
- file-tree.test.ts - buildFileTree()
- introspection-types.test.ts - Introspection type tests
- streaming-download.test.ts - Size threshold routing
- watcher.test.ts - BlobWatcher
- logger.test.ts - Logger with SAS sanitization
- errors.test.ts - Custom error hierarchy