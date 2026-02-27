# Issues - Pending Items

**Project:** azure-venv Library
**Last Updated:** 2026-02-27

---

## Pending Items



---

## Completed Items

### C-010: downloadToFile Created Parent Directories (P-005)
**Priority:** Low
**Date Fixed:** 2026-02-28
**Description:** `downloadToFile()` and `downloadToFileStreaming()` in `src/azure/client.ts` created parent directories with `fs.mkdir`, duplicating work already done by `BlobDownloader`. Removed the `mkdir` calls from both client methods to align with the design contract (caller's responsibility). The `path` import was also removed as it became unused. The `fs` import is still needed for `unlink` in the streaming error cleanup.

### C-009: ESLint Configuration Missing (P-009)
**Priority:** Medium
**Date Fixed:** 2026-02-27
**Description:** ESLint v10.0.2 required new flat config format. Created `eslint.config.js` with `@eslint/js` and `typescript-eslint`, configured for TypeScript strict checking. Also fixed 2 lint errors: unused `rootDir` parameter in `SyncEngine.fetchRemoteEnv()` (renamed to `_rootDir`) and `let` that should be `const` for manifest variable. `npm run lint` now runs with 0 errors, 1 warning (safe non-null assertion in FIFO queue).

### C-008: Streaming Download Leaves Partial Files on Failure (P-008)
**Priority:** Low
**Date Fixed:** 2026-02-27
**Description:** `downloadToFileStreaming()` in `src/azure/client.ts` now cleans up partial files in the catch block. On streaming failure, `fs.unlink(localPath)` is called to remove the incomplete file before re-throwing the error. The unlink is wrapped in a try/catch since the file may not exist if the failure occurred before writing started.

### C-007: CLI Commander Defaults Override Environment Variables (P-007)
**Priority:** Low
**Date Fixed:** 2026-02-27
**Description:** Commander option definitions in `src/cli/index.ts` had hardcoded defaults (`'info'`, `'5'`, `'full'`, etc.) that always populated `AzureVenvOptions`, causing environment variables like `AZURE_VENV_LOG_LEVEL` to be silently ignored. Fixed by removing all default values from `.option()` calls so commander returns `undefined` when the user doesn't pass the flag. `buildOptions()` already only sets values when not `undefined`, so env vars now take effect when CLI flags are omitted.

### C-006: Design Doc Updated for 7-Day SAS Expiry + Array listBlobs (P-003, P-004)
**Priority:** Low
**Date Fixed:** 2026-02-27
**Description:** Updated `docs/design/project-design.md`: (1) Changed SAS expiry warning threshold from "24 hours" to "7 days" in Section 6 Step 4 and Section 7.2 to match the implementation. (2) Changed `listBlobs()` signature from `AsyncGenerator<BlobInfo>` to `Promise<BlobInfo[]>` in Section 7.3 to match the array-based implementation, with a note about potential AsyncGenerator refactoring for very large containers.

### C-003: CLI SIGINT Exit Code Bug
**Priority:** Medium
**Date Fixed:** 2026-02-27
**Description:** In `src/cli/index.ts`, the watch command's `shutdown()` function called `process.exit(0)` regardless of signal type. Fixed by passing the exit code as a parameter: SIGINT uses 130, SIGTERM uses 0.

### C-004: CLI Watch Command Process Exits Immediately
**Priority:** High
**Date Fixed:** 2026-02-27
**Description:** `BlobWatcher.start()` calls `this.intervalId.unref()` which let the CLI process exit immediately. Fixed by adding `process.stdin.resume()` in the CLI watch command to keep the event loop alive.

### C-005: Package Version Mismatch
**Priority:** Low
**Date Fixed:** 2026-02-27
**Description:** `package.json` had version `0.1.0` while CLI declared `0.2.0`. Fixed by updating `package.json` to `0.2.0`.

### C-001: Semaphore Bug in BlobDownloader (CRITICAL)
**Priority:** Critical
**Date Fixed:** 2026-02-27
**Description:** Concurrency semaphore used single `resolveSlot` callback causing deadlock. Fixed with FIFO queue.

### C-002: Missing Validation for SAS_TOKEN Without AZURE_VENV
**Priority:** Medium
**Date Fixed:** 2026-02-27
**Description:** `validateConfig()` didn't detect AZURE_VENV_SAS_TOKEN present without AZURE_VENV. Fixed with explicit check.

### P-001: Open Design Questions from Plan -- RESOLVED
**Priority:** High
**Date Resolved:** 2026-02-27
**Description:** All five design questions answered and implemented in v1.1.

### P-006: checkSasExpiry Uses console.warn -- ACCEPTED
**Priority:** Low
**Date Resolved:** 2026-02-27
**Resolution:** User confirmed `checkSasExpiry()` in `src/config/validator.ts` should keep using `console.warn` directly. This is intentional since the function runs during config validation before the SAS-sanitizing logger exists, and the message only contains the expiry date (no SAS token), so there is no security concern.

### P-002: Configuration Defaults vs. No-Fallback Rule -- RESOLVED
**Priority:** Medium
**Date Resolved:** 2026-02-27
**Resolution:** User confirmed operational parameters can have sensible defaults.
