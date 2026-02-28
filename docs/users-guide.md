# azure-venv User's Guide

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Quick Start](#3-quick-start)
4. [Azure Setup Prerequisites](#4-azure-setup-prerequisites)
5. [Configuration](#5-configuration)
6. [Programmatic API](#6-programmatic-api)
   - [One-Time Sync](#61-one-time-sync-initazurevenv)
   - [Watch Mode](#62-watch-mode-watchazurevenv)
   - [Introspection: Synced Files](#63-introspection-synced-files)
   - [Introspection: File Tree](#64-introspection-file-tree)
   - [Introspection: Environment Variables](#65-introspection-environment-variables)
   - [Standalone Utility Functions](#66-standalone-utility-functions)
7. [CLI Usage](#7-cli-usage)
8. [Environment Variable Precedence](#8-environment-variable-precedence)
9. [Error Handling](#9-error-handling)
10. [Sync Manifest](#10-sync-manifest)
11. [Security Considerations](#11-security-considerations)
12. [Type Reference](#12-type-reference)
13. [Common Patterns](#13-common-patterns)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Overview

**azure-venv** is a TypeScript library that synchronizes files and environment variables from Azure Blob Storage to your local application root at startup. It is designed to be called once, early in your application's lifecycle, before any code that depends on the synced files or variables.

Key capabilities:

- Download all blobs under a configurable prefix to the local filesystem
- Load a remote `.env` file from Azure and merge it with a local `.env` using a three-tier precedence model
- Return a detailed `SyncResult` including a flat file list, a hierarchical file tree, and full environment variable introspection
- Optionally continue watching for changes via ETag-based polling
- Provide a CLI for one-time sync or continuous watch from the terminal

---

## 2. Installation

### From GitHub

```bash
npm install BikS2013/azure-venv-typescript
```

To pin to a specific commit or tag:

```bash
npm install BikS2013/azure-venv-typescript#main
npm install BikS2013/azure-venv-typescript#<commit-sha>
```

### Verify installation

```bash
npx azure-venv --version
```

### Requirements

- Node.js >= 18.0.0
- An Azure Storage account with a SAS token

---

## 3. Quick Start

**Step 1.** Set the required environment variables (or place them in a `.env` file):

```bash
export AZURE_VENV="https://myaccount.blob.core.windows.net/mycontainer/config/prod"
export AZURE_VENV_SAS_TOKEN="sv=2022-11-02&ss=b&srt=sco&sp=rl&se=2026-12-31..."
```

**Step 2.** Call `initAzureVenv()` at the top of your application:

```typescript
import { initAzureVenv } from 'azure-venv';

async function main() {
  const result = await initAzureVenv();

  if (!result.attempted) {
    console.log('Azure sync not configured, continuing with local files only');
  } else {
    console.log(`Synced ${result.downloaded} files in ${result.duration}ms`);
  }

  // Your application code starts here.
  // Remote files and environment variables are now available.
}

main();
```

That is all that is needed. The library downloads all blobs under the prefix `config/prod/` to your current working directory, loads any remote `.env` into `process.env`, and returns a result object with full statistics.

---

## 4. Azure Setup Prerequisites

### 4.1 Storage Account and Container

1. Create an Azure Storage Account (or use an existing one).
2. Create a Blob Container within the account.
3. Upload your configuration files and (optionally) a `.env` file.

The blob structure might look like:

```
mycontainer/
  config/
    prod/
      .env                    <-- remote environment variables
      templates/
        email/welcome.html
        email/reset.html
      certs/server.pem
      settings.json
```

### 4.2 SAS Token

Generate a Shared Access Signature (SAS) token with the following minimum permissions:

| Permission | Required | Purpose |
|-----------|----------|---------|
| Read (r) | Yes | Download blob content |
| List (l) | Yes | Enumerate blobs under prefix |

You can generate a SAS token via:
- Azure Portal: Storage Account > Shared access signature
- Azure CLI: `az storage container generate-sas`
- Azure SDKs

**Important:** The SAS token should **not** include a leading `?` character. If your token starts with `?`, strip it before setting `AZURE_VENV_SAS_TOKEN`.

### 4.3 Constructing the AZURE_VENV URL

The URL format is:

```
https://<account>.blob.core.windows.net/<container>/<prefix>
```

| Component | Example | Description |
|-----------|---------|-------------|
| account | `myaccount` | Storage account name |
| container | `mycontainer` | Blob container name |
| prefix | `config/prod` | Virtual directory prefix (optional, can be empty) |

If you omit the prefix, all blobs in the container are synced.

---

## 5. Configuration

### 5.1 Environment Variables

All configuration is read from environment variables. The library loads a local `.env` file first, so you can place these settings in `.env` if preferred.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_VENV` | Yes* | - | Azure Blob Storage URL |
| `AZURE_VENV_SAS_TOKEN` | Yes* | - | SAS token for authentication |
| `AZURE_VENV_SAS_EXPIRY` | No | - | ISO 8601 date for proactive expiry warnings |
| `AZURE_VENV_SYNC_MODE` | No | `full` | `full` re-downloads everything; `incremental` uses ETag manifest |
| `AZURE_VENV_FAIL_ON_ERROR` | No | `false` | If `true`, Azure errors throw and prevent app startup |
| `AZURE_VENV_CONCURRENCY` | No | `5` | Maximum parallel blob downloads (1-50) |
| `AZURE_VENV_TIMEOUT` | No | `30000` | Per-blob download timeout in milliseconds |
| `AZURE_VENV_LOG_LEVEL` | No | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `AZURE_VENV_MAX_BLOB_SIZE` | No | `104857600` | Blobs larger than this (bytes) use streaming download. Min: 1 MB |
| `AZURE_VENV_POLL_INTERVAL` | No | `30000` | Watch mode polling interval in ms (5 s - 1 hr) |
| `AZURE_VENV_WATCH_ENABLED` | No | `false` | Enable continuous watch mode after initial sync |

*`AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` are required together. If neither is set, the library becomes a no-op and returns immediately. If only one is set, a `ConfigurationError` is thrown.

### 5.2 Programmatic Overrides

Every optional configuration variable can also be overridden via the `options` parameter:

```typescript
const result = await initAzureVenv({
  rootDir: '/app/data',          // sync files here instead of cwd
  envPath: 'config/.env',        // local .env at a non-default path
  syncMode: 'incremental',       // skip unchanged files
  failOnError: true,             // throw on any Azure failure
  concurrency: 10,               // faster parallel downloads
  timeout: 60000,                // longer timeout for large files
  logLevel: 'debug',             // verbose output
  maxBlobSize: 50 * 1024 * 1024, // stream files > 50 MB
});
```

Programmatic overrides take precedence over environment variables.

### 5.3 SAS Expiry Warning

If you set `AZURE_VENV_SAS_EXPIRY` to an ISO 8601 date (e.g., `2026-06-30T00:00:00Z`), the library will log a warning if the token expires within 7 days. This helps you rotate tokens proactively.

---

## 6. Programmatic API

### 6.1 One-Time Sync (`initAzureVenv`)

```typescript
import { initAzureVenv } from 'azure-venv';
import type { SyncResult } from 'azure-venv';

const result: SyncResult = await initAzureVenv(options?);
```

**What it does (in order):**

1. Loads the local `.env` file (does not override existing OS environment variables)
2. Reads `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` from `process.env`
3. If both are present, connects to Azure Blob Storage
4. Downloads a remote `.env` (if one exists under the prefix) and applies three-tier precedence
5. Syncs all remaining blobs to the local filesystem
6. Builds introspection data (file list, file tree, env details)
7. Returns a `SyncResult`

If `AZURE_VENV` is not set, it returns immediately with `{ attempted: false, ... }` and empty introspection fields.

**Example:**

```typescript
const result = await initAzureVenv({ syncMode: 'incremental' });

console.log(`Attempted:  ${result.attempted}`);
console.log(`Downloaded: ${result.downloaded}`);
console.log(`Skipped:    ${result.skipped}`);
console.log(`Failed:     ${result.failed}`);
console.log(`Duration:   ${result.duration}ms`);
console.log(`Files:      ${result.syncedFiles.length}`);
console.log(`Env vars:   ${Object.keys(result.envDetails.variables).length}`);
```

### 6.2 Watch Mode (`watchAzureVenv`)

```typescript
import { watchAzureVenv } from 'azure-venv';
import type { WatchResult } from 'azure-venv';

const { initialSync, stop }: WatchResult = await watchAzureVenv(options?);
```

This performs the same initial sync as `initAzureVenv`, then starts a background poller that checks for blob changes (additions or modifications) on a configurable interval.

**Example:**

```typescript
const { initialSync, stop } = await watchAzureVenv({
  pollInterval: 60000,  // check every 60 seconds
  logLevel: 'debug',
});

console.log(`Initial sync downloaded ${initialSync.downloaded} files`);

// The watcher now runs in the background.
// Changed blobs are re-downloaded automatically.
// Remote .env changes trigger re-application of precedence.

// To stop watching:
// stop();
```

**Cancellation with AbortSignal:**

```typescript
const controller = new AbortController();

const { initialSync, stop } = await watchAzureVenv({
  signal: controller.signal,
});

// Later, cancel from outside:
controller.abort();
```

The watcher also listens for `SIGINT` and `SIGTERM` for graceful shutdown.

### 6.3 Introspection: Synced Files

After sync, `result.syncedFiles` provides a flat, alphabetically sorted list of every file that azure-venv placed on the local filesystem.

```typescript
const result = await initAzureVenv();

for (const file of result.syncedFiles) {
  console.log(`Path:     ${file.localPath}`);
  console.log(`Blob:     ${file.blobName}`);
  console.log(`Size:     ${file.size} bytes`);
  console.log(`Modified: ${file.lastModified}`);
  console.log(`ETag:     ${file.etag}`);
  console.log('---');
}
```

Each `SyncedFileInfo` object contains:

| Field | Type | Description |
|-------|------|-------------|
| `localPath` | `string` | Relative path from application root (forward-slash normalized) |
| `blobName` | `string` | Full blob name in Azure Blob Storage |
| `size` | `number` | File size in bytes |
| `lastModified` | `string` | Last modified date in Azure (ISO 8601) |
| `etag` | `string` | ETag of the blob at time of sync |

### 6.4 Introspection: File Tree

`result.fileTree` provides the same data as `syncedFiles`, but organized as a hierarchical tree. Directories appear before files at each level, and both are sorted alphabetically.

```typescript
const result = await initAzureVenv();

function printTree(nodes: readonly FileTreeNode[], indent = ''): void {
  for (const node of nodes) {
    if (node.type === 'directory') {
      console.log(`${indent}${node.name}/`);
      if (node.children) {
        printTree(node.children, indent + '  ');
      }
    } else {
      console.log(`${indent}${node.name} (${node.size} bytes)`);
    }
  }
}

printTree(result.fileTree);
```

Output example:

```
certs/
  server.pem (2048 bytes)
templates/
  email/
    reset.html (2500 bytes)
    welcome.html (3000 bytes)
  sms/
    verify.txt (100 bytes)
settings.json (512 bytes)
```

Each `FileTreeNode` object contains:

| Field | Type | Present On | Description |
|-------|------|-----------|-------------|
| `name` | `string` | Both | File or directory name (segment only) |
| `type` | `'file' \| 'directory'` | Both | Node type |
| `path` | `string` | Both | Relative path from application root |
| `children` | `FileTreeNode[]` | Directories | Child nodes (sorted: dirs first, then files) |
| `size` | `number` | Files | File size in bytes |
| `blobName` | `string` | Files | Full blob name in Azure |

### 6.5 Introspection: Environment Variables

`result.envDetails` provides full visibility into the environment variables that azure-venv manages, including their values, sources, and which tier they came from.

```typescript
const result = await initAzureVenv();
const { envDetails } = result;

// All tracked variables and their values
console.log('Variables:', envDetails.variables);
// { DB_HOST: 'prod-db.example.com', API_KEY: 'sk-...', LOG_LEVEL: 'warn' }

// Which tier each variable came from
console.log('Sources:', envDetails.sources);
// { DB_HOST: 'remote', API_KEY: 'os', LOG_LEVEL: 'local' }

// Keys grouped by source tier
console.log('From local .env:', envDetails.localKeys);   // ['LOG_LEVEL']
console.log('From remote .env:', envDetails.remoteKeys);  // ['DB_HOST']
console.log('From OS environment:', envDetails.osKeys);   // ['API_KEY']
```

The `EnvDetails` interface:

| Field | Type | Description |
|-------|------|-------------|
| `variables` | `Record<string, string>` | Key-value map of all tracked environment variables |
| `sources` | `Record<string, EnvSource>` | Source tier for each variable: `'os'`, `'remote'`, or `'local'` |
| `localKeys` | `string[]` | Keys that originated from the local `.env` file |
| `remoteKeys` | `string[]` | Keys that originated from the remote `.env` file synced from Azure |
| `osKeys` | `string[]` | OS environment keys that were preserved (not overridden) |

### 6.6 Standalone Utility Functions

The introspection utilities are also exported for use outside the sync flow:

```typescript
import { buildFileTree, manifestToSyncedFiles } from 'azure-venv';
import type { SyncedFileInfo, FileTreeNode, SyncManifest } from 'azure-venv';
```

**`manifestToSyncedFiles(manifest: SyncManifest): SyncedFileInfo[]`**

Converts a `SyncManifest` (as stored in `.azure-venv-manifest.json`) to a flat, sorted list of `SyncedFileInfo` objects. Useful if you need to read the manifest directly.

**`buildFileTree(syncedFiles: readonly SyncedFileInfo[]): FileTreeNode[]`**

Builds a hierarchical tree from a flat list. Can be used with any `SyncedFileInfo[]` array, not just the one from `SyncResult`.

```typescript
import * as fs from 'node:fs';
import { manifestToSyncedFiles, buildFileTree } from 'azure-venv';

// Read manifest directly from disk
const raw = fs.readFileSync('.azure-venv-manifest.json', 'utf-8');
const manifest = JSON.parse(raw);

const files = manifestToSyncedFiles(manifest);
const tree = buildFileTree(files);

console.log(`${files.length} files in ${tree.length} root entries`);
```

---

## 7. CLI Usage

The library includes a CLI tool accessible via `npx azure-venv`.

### 7.1 One-Time Sync

```bash
npx azure-venv sync [options]
```

Options:

| Flag | Description |
|------|-------------|
| `--root-dir <path>` | Application root directory |
| `--log-level <level>` | `debug`, `info`, `warn`, `error` |
| `--fail-on-error` | Exit with code 1 on any Azure failure |
| `--concurrency <n>` | Max parallel downloads |
| `--sync-mode <mode>` | `full` or `incremental` |

**Example:**

```bash
AZURE_VENV="https://myaccount.blob.core.windows.net/mycontainer/prod" \
AZURE_VENV_SAS_TOKEN="sv=2022-11-02&ss=b..." \
npx azure-venv sync --log-level debug --sync-mode incremental
```

The CLI prints a summary including synced files, file tree, and environment variables.

### 7.2 Continuous Watch

```bash
npx azure-venv watch [options]
```

Includes all sync options plus:

| Flag | Description |
|------|-------------|
| `--poll-interval <ms>` | Polling interval in milliseconds |

Press `Ctrl+C` to stop gracefully.

### 7.3 Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (or sync failure when `--fail-on-error` is set) |
| 130 | Interrupted by SIGINT |

---

## 8. Environment Variable Precedence

azure-venv uses a three-tier precedence model for environment variables. Higher tiers always win:

```
Priority (highest to lowest):
  1. OS environment variables   (already in process.env before any .env loading)
  2. Remote .env                (downloaded from Azure Blob Storage)
  3. Local .env                 (on disk at rootDir/.env)
```

**What this means in practice:**

- If `DB_HOST=localhost` is in your local `.env` and `DB_HOST=prod-db.example.com` is in the remote `.env`, the remote value wins.
- If `DB_HOST=override` is set as an OS environment variable, that always wins regardless of what the `.env` files say.
- Variables unique to a single tier are always included.

After precedence resolution, all winning values are applied to `process.env`. The `envDetails` field on `SyncResult` tells you exactly which tier each variable came from.

---

## 9. Error Handling

### 9.1 Error Classes

The library exports a hierarchy of typed errors:

| Error Class | When Thrown | Always Throws? |
|-------------|-----------|----------------|
| `ConfigurationError` | `AZURE_VENV` set without `AZURE_VENV_SAS_TOKEN` (or vice versa), invalid URL format, invalid parameter values | Yes (always) |
| `AuthenticationError` | SAS token expired or rejected by Azure | Yes (always) |
| `AzureConnectionError` | Azure unreachable, DNS failure, network timeout | Only if `failOnError: true` |
| `SyncError` | Filesystem write failure, path traversal attempt | Only if `failOnError: true` |
| `PathTraversalError` | Blob name attempts to escape root directory | Only if `failOnError: true` |

All errors extend `AzureVenvError`, which extends the standard `Error`.

### 9.2 failOnError Behavior

When `failOnError` is `false` (the default), Azure connection and sync errors are caught internally, logged as warnings, and a degraded `SyncResult` is returned with `downloaded: 0` and empty introspection fields. Your application continues to start.

When `failOnError` is `true`, these errors propagate as exceptions and prevent application startup.

Configuration and authentication errors always throw regardless of this setting.

### 9.3 Error Handling Pattern

```typescript
import {
  initAzureVenv,
  ConfigurationError,
  AuthenticationError,
  AzureConnectionError,
} from 'azure-venv';

try {
  const result = await initAzureVenv({ failOnError: true });

  if (result.failed > 0) {
    console.warn(`${result.failed} blobs failed to download:`, result.failedBlobs);
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error('Invalid azure-venv configuration:', error.message);
    process.exit(1);
  }
  if (error instanceof AuthenticationError) {
    console.error('Azure authentication failed (SAS expired?):', error.message);
    process.exit(1);
  }
  if (error instanceof AzureConnectionError) {
    console.error('Cannot reach Azure:', error.message);
    process.exit(1);
  }
  throw error; // unexpected
}
```

### 9.4 Graceful Degradation (Default)

```typescript
const result = await initAzureVenv(); // failOnError defaults to false

if (!result.attempted) {
  // AZURE_VENV not configured, library is a no-op
} else if (result.failed > 0) {
  // Some blobs failed, but app can continue
} else {
  // Full success
}

// In all cases, result.syncedFiles, result.fileTree, and result.envDetails
// are available (may be empty arrays/objects on failure).
```

---

## 10. Sync Manifest

The library maintains a JSON manifest file at `{rootDir}/.azure-venv-manifest.json`. This file tracks the ETag, size, and last-modified date of every synced blob.

**Purpose:**
- In `incremental` sync mode, unchanged blobs (same ETag) are skipped
- In watch mode, the manifest is compared against current blob ETags to detect changes
- The `syncedFiles` and `fileTree` introspection data is built from this manifest

**You should:**
- Add `.azure-venv-manifest.json` to your `.gitignore`
- Not modify or delete this file manually
- Not make its location configurable (it is always at the project root)

---

## 11. Security Considerations

### SAS Token

- The SAS token is never logged. The library's logger automatically sanitizes any SAS token values that appear in log output.
- Store the SAS token in environment variables or a `.env` file, never in source code.
- Set `AZURE_VENV_SAS_EXPIRY` to get proactive warnings before the token expires.

### Environment Variable Values

- `result.envDetails.variables` contains the **actual values** of environment variables, which may include passwords, API keys, connection strings, and other secrets.
- Do not log, serialize to external systems, or expose `envDetails.variables` without filtering sensitive keys.
- If you only need to know **which** variables were loaded and **where** they came from, use `envDetails.sources`, `envDetails.localKeys`, `envDetails.remoteKeys`, and `envDetails.osKeys` instead.

### Path Traversal

- The library validates all blob names to prevent path traversal attacks. A blob named `../../etc/passwd` would be rejected with a `PathTraversalError`.
- All files are written within the configured `rootDir` boundary.

---

## 12. Type Reference

All types are importable from `'azure-venv'`:

```typescript
import type {
  // Configuration
  AzureVenvOptions,     // Options parameter for initAzureVenv/watchAzureVenv
  AzureVenvConfig,      // Full validated config (internal)
  ParsedBlobUrl,        // Parsed AZURE_VENV URL components
  LogLevel,             // 'debug' | 'info' | 'warn' | 'error'
  SyncMode,             // 'full' | 'incremental'

  // Sync result
  SyncResult,           // Return type of initAzureVenv
  SyncedFileInfo,       // Single synced file info (flat)
  FileTreeNode,         // Hierarchical tree node
  EnvDetails,           // Environment variable introspection
  EnvSource,            // 'os' | 'remote' | 'local'
  EnvRecord,            // Record<string, string>
  EnvLoadResult,        // Internal env loading result

  // Manifest
  SyncManifest,         // Full manifest structure
  ManifestEntry,        // Single blob's manifest entry

  // Watch mode
  WatchResult,          // Return type of watchAzureVenv
  WatchOptions,         // Watch configuration options
  WatchChangeEvent,     // Single change event
  WatchChangeType,      // 'added' | 'modified'

  // Azure
  BlobInfo,             // Blob metadata from listing
  BlobDownloadResult,   // Download operation result

  // Logging
  Logger,               // Logger interface
} from 'azure-venv';
```

Value exports:

```typescript
import {
  // Functions
  initAzureVenv,          // One-time sync
  watchAzureVenv,         // Watch mode sync
  buildFileTree,          // Utility: flat list -> tree
  manifestToSyncedFiles,  // Utility: manifest -> flat list

  // Error classes
  AzureVenvError,         // Base error class
  ConfigurationError,     // Invalid configuration
  AzureConnectionError,   // Network/connectivity errors
  AuthenticationError,    // SAS token errors
  SyncError,              // Filesystem/sync errors
  PathTraversalError,     // Path security violation
} from 'azure-venv';
```

---

## 13. Common Patterns

### 13.1 Application Bootstrap

The most common pattern: call `initAzureVenv` at the very top of your application entry point, before importing anything that depends on synced files or environment variables.

```typescript
// app.ts
import { initAzureVenv } from 'azure-venv';

const syncResult = await initAzureVenv();

// Now it's safe to import modules that read process.env or local config files
const { startServer } = await import('./server.js');
await startServer();
```

### 13.2 Conditional Behavior Based on Synced Files

```typescript
const result = await initAzureVenv();

const hasTemplates = result.syncedFiles.some(f => f.localPath.startsWith('templates/'));
const hasCerts = result.syncedFiles.some(f => f.localPath.endsWith('.pem'));

if (hasTemplates) {
  console.log('Email templates available');
}
if (hasCerts) {
  console.log('TLS certificates synced');
}
```

### 13.3 Displaying Sync Summary to Users

```typescript
const result = await initAzureVenv();

if (result.attempted) {
  console.log(`azure-venv: ${result.downloaded} downloaded, ${result.skipped} unchanged, ${result.failed} failed (${result.duration}ms)`);
  console.log(`  Files: ${result.syncedFiles.length}`);
  console.log(`  Env vars: ${Object.keys(result.envDetails.variables).length} (${result.envDetails.remoteKeys.length} from remote)`);
}
```

### 13.4 Checking Where a Specific Variable Came From

```typescript
const result = await initAzureVenv();

const dbHost = result.envDetails.sources['DB_HOST'];
if (dbHost === 'remote') {
  console.log('DB_HOST was loaded from the remote .env in Azure');
} else if (dbHost === 'local') {
  console.log('DB_HOST came from the local .env file');
} else if (dbHost === 'os') {
  console.log('DB_HOST was already in the OS environment');
} else {
  console.log('DB_HOST was not set by azure-venv');
}
```

### 13.5 Finding a Specific File in the Tree

```typescript
import type { FileTreeNode } from 'azure-venv';

function findNode(nodes: readonly FileTreeNode[], targetPath: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children) {
      const found = findNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return undefined;
}

const result = await initAzureVenv();
const certNode = findNode(result.fileTree, 'certs/server.pem');

if (certNode) {
  console.log(`Certificate found: ${certNode.size} bytes`);
}
```

### 13.6 Watch Mode with Change Logging

```typescript
const { initialSync, stop } = await watchAzureVenv({
  pollInterval: 30000,
  logLevel: 'info',
});

console.log(`Initial sync: ${initialSync.downloaded} files, ${initialSync.syncedFiles.length} total`);

// Changes are logged automatically by the library at info level.
// The watcher re-downloads modified blobs and re-applies .env precedence.

// Graceful shutdown on SIGTERM (e.g., in a container)
process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
```

### 13.7 Using Without Azure (Local-Only .env)

If `AZURE_VENV` is not set, the library still loads your local `.env` file and returns immediately. This makes it safe to use in development environments without Azure access:

```typescript
const result = await initAzureVenv();
// result.attempted === false
// result.syncedFiles === []
// result.envDetails.variables contains local .env values
// process.env has been populated from local .env
```

---

## 14. Troubleshooting

### Nothing happens (no sync, no errors)

Check that both `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` are set. If neither is set, the library silently returns a no-op result. Enable debug logging to see what's happening:

```typescript
const result = await initAzureVenv({ logLevel: 'debug' });
console.log('attempted:', result.attempted);
```

### ConfigurationError: AZURE_VENV_SAS_TOKEN is required when AZURE_VENV is set

You set `AZURE_VENV` but not `AZURE_VENV_SAS_TOKEN` (or vice versa). Both must be set together, or both must be absent.

### AuthenticationError

Your SAS token is expired or invalid. Check:
- The token has not expired (check the `se` parameter in the token)
- The token has `r` (read) and `l` (list) permissions
- The token applies to the correct storage account and container
- The token does not have a leading `?`

### Files sync but environment variables are not updated

- The remote `.env` must be a blob named `.env` directly under the configured prefix. For example, if `AZURE_VENV=https://account.blob.core.windows.net/container/prod`, the remote `.env` must be at `prod/.env`.
- Use `result.remoteEnvLoaded` to check if a remote `.env` was found.
- Use `result.envDetails` to inspect the final state of all variables.

### Incremental sync re-downloads everything

The manifest file (`.azure-venv-manifest.json`) may be missing or corrupted. Delete it and run a full sync to rebuild it:

```bash
rm .azure-venv-manifest.json
npx azure-venv sync --sync-mode full
```

### SAS expiry warning not appearing

Set `AZURE_VENV_SAS_EXPIRY` to the token's expiration date in ISO 8601 format:

```bash
export AZURE_VENV_SAS_EXPIRY="2026-06-30T00:00:00Z"
```

The warning appears when the expiry is within 7 days.

### Large files cause timeouts

For blobs larger than 100 MB, the library automatically switches to streaming download. You can lower this threshold and increase the timeout:

```typescript
const result = await initAzureVenv({
  maxBlobSize: 10 * 1024 * 1024,  // stream files > 10 MB
  timeout: 120000,                  // 2 minute timeout per blob
});
```
