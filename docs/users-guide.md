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
   - [Working with In-Memory Blobs](#63-working-with-in-memory-blobs)
   - [Introspection: File Tree](#64-introspection-file-tree)
   - [Introspection: Environment Variables](#65-introspection-environment-variables)
   - [Blob Metadata and Source Lookup](#66-blob-metadata-and-source-lookup)
   - [Standalone Utility Functions](#67-standalone-utility-functions)
7. [Asset Store](#7-asset-store)
   - [Creating an Asset Store](#71-creating-an-asset-store)
   - [Two-Scope Initialization Pattern](#72-two-scope-initialization-pattern)
   - [Retrieving Assets](#73-retrieving-assets)
   - [Environment Variable Aliases](#74-environment-variable-aliases)
   - [Refreshing from Azure](#75-refreshing-from-azure)
   - [Building a REST API](#76-building-a-rest-api)
8. [CLI Usage](#8-cli-usage)
9. [Environment Variable Precedence](#9-environment-variable-precedence)
10. [Error Handling](#10-error-handling)
11. [Security Considerations](#11-security-considerations)
12. [Type Reference](#12-type-reference)
13. [Common Patterns](#13-common-patterns)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Overview

**azure-venv** is a TypeScript library that reads files and environment variables from Azure Blob Storage into memory at startup. All blob contents are held as in-memory `Buffer` objects — no files are written to disk.

Key capabilities:

- Read all blobs under a configurable prefix into memory as `BlobContent` objects
- Load a remote `.env` file from Azure and merge it with a local `.env` using a three-tier precedence model
- Return a detailed `SyncResult` including in-memory blob contents, a hierarchical file tree, and full environment variable introspection
- Look up blobs by their source origin using `source_path@source_registry` expressions
- Provide an `AssetStore` class for registry-scoped asset retrieval with caching
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
    console.log(`Read ${result.downloaded} blobs in ${result.duration}ms`);
  }

  // Access in-memory blob contents
  const configBlob = result.blobs.find(b => b.relativePath === 'config.json');
  if (configBlob) {
    const config = JSON.parse(configBlob.content.toString('utf-8'));
    console.log('Config loaded:', config);
  }

  // Remote env vars are now in process.env
  const { startServer } = await import('./server.js');
  await startServer();
}

main();
```

All blobs are read into memory as `BlobContent` objects. The remote `.env` is loaded into `process.env` with three-tier precedence. No files are written to disk.

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

### 4.2 Blob Metadata Convention

All blobs should carry two custom metadata fields when uploaded:

| Metadata Key | Description | Example |
|---|---|---|
| `source_registry` | The origin repository where the file is maintained | `github.com/org/repo` |
| `source_path` | The path of the file inside the source repository | `config/settings.json` |

These metadata values are automatically read during sync and exposed on each `BlobContent` object as `sourceRegistry` and `sourcePath`. They enable source-based lookups via `findBlobBySource()` and `AssetStore`.

### 4.3 SAS Token

Generate a Shared Access Signature (SAS) token with the following minimum permissions:

| Permission | Required | Purpose |
|-----------|----------|---------|
| Read (r) | Yes | Download blob content |
| List (l) | Yes | Enumerate blobs under prefix |

You can generate a SAS token via:
- Azure Portal: Storage Account > Shared access signature
- Azure CLI: `az storage container generate-sas`
- Azure SDKs

**Important:** The SAS token should **not** include a leading `?` character. If your token starts with `?`, the library strips it automatically.

### 4.4 Constructing the AZURE_VENV URL

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
| `AZURE_VENV_SAS_EXPIRY` | No | - | Expiry date for proactive warnings (see 5.3) |
| `AZURE_VENV_FAIL_ON_ERROR` | No | `false` | If `true`, Azure errors throw and prevent app startup |
| `AZURE_VENV_CONCURRENCY` | No | `5` | Maximum parallel blob downloads (1-50) |
| `AZURE_VENV_TIMEOUT` | No | `30000` | Per-blob download timeout in milliseconds |
| `AZURE_VENV_LOG_LEVEL` | No | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `AZURE_VENV_POLL_INTERVAL` | No | `30000` | Watch mode polling interval in ms (5 s - 1 hr) |
| `AZURE_VENV_WATCH_ENABLED` | No | `false` | Enable continuous watch mode after initial sync |

*`AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` are required together. If neither is set, the library becomes a no-op and returns immediately. If only one is set, a `ConfigurationError` is thrown.

### 5.2 Programmatic Overrides

Every optional configuration variable can also be overridden via the `options` parameter:

```typescript
const result = await initAzureVenv({
  rootDir: '/app/data',          // resolve local .env from here
  envPath: 'config/.env',        // local .env at a non-default path
  failOnError: true,             // throw on any Azure failure
  concurrency: 10,               // faster parallel downloads
  timeout: 60000,                // longer timeout for large blobs
  logLevel: 'debug',             // verbose output
});
```

Programmatic overrides take precedence over environment variables.

### 5.3 SAS Expiry Warning

Set `AZURE_VENV_SAS_EXPIRY` to a date value and the library will:
- **Throw `AuthenticationError`** if the date is in the past
- **Log a warning** if the token expires within 7 days

Accepted date formats:

| Format | Example |
|--------|---------|
| `yyyy-mm-dd` | `2026-12-31` |
| ISO 8601 datetime | `2026-12-31T00:00:00Z` |
| ISO 8601 with timezone | `2026-12-31T23:59:59+02:00` |
| Date with time (no TZ) | `2026-12-31T23:59:59` |
| Month/day/year | `12/31/2026` |

If the format is unrecognizable, a `ConfigurationError` is thrown.

If `AZURE_VENV_SAS_EXPIRY` is not set, the library attempts to read the `se` parameter from the SAS token itself.

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
5. Reads all remaining blobs into memory as `BlobContent` objects
6. Builds introspection data (blob list, file tree, env details)
7. Returns a `SyncResult`

If `AZURE_VENV` is not set, it returns immediately with `{ attempted: false, ... }` and empty introspection fields.

**Example:**

```typescript
const result = await initAzureVenv();

console.log(`Attempted:  ${result.attempted}`);
console.log(`Downloaded: ${result.downloaded}`);
console.log(`Failed:     ${result.failed}`);
console.log(`Duration:   ${result.duration}ms`);
console.log(`Blobs:      ${result.blobs.length}`);
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

console.log(`Initial sync read ${initialSync.downloaded} blobs`);

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

### 6.3 Working with In-Memory Blobs

After sync, `result.blobs` provides a flat, sorted list of every blob read into memory. Each `BlobContent` object holds the raw content as a `Buffer`.

```typescript
const result = await initAzureVenv();

for (const blob of result.blobs) {
  console.log(`Path:     ${blob.relativePath}`);
  console.log(`Blob:     ${blob.blobName}`);
  console.log(`Size:     ${blob.size} bytes`);
  console.log(`Modified: ${blob.lastModified}`);
  console.log(`ETag:     ${blob.etag}`);
  console.log(`Registry: ${blob.sourceRegistry ?? '(none)'}`);
  console.log(`Source:   ${blob.sourcePath ?? '(none)'}`);
  console.log('---');
}
```

**Reading content:**

```typescript
// Text content (JSON, YAML, Markdown, etc.)
const configBlob = result.blobs.find(b => b.relativePath === 'config.json');
if (configBlob) {
  const config = JSON.parse(configBlob.content.toString('utf-8'));
}

// Binary content (images, certificates, etc.)
const certBlob = result.blobs.find(b => b.relativePath === 'certs/server.pem');
if (certBlob) {
  // certBlob.content is a Buffer — use directly with any API that accepts Buffer
}

// Filter blobs by extension
const yamlBlobs = result.blobs.filter(b => b.relativePath.endsWith('.yaml'));

// Get total size
const totalSize = result.blobs.reduce((sum, b) => sum + b.size, 0);
```

Each `BlobContent` object contains:

| Field | Type | Description |
|-------|------|-------------|
| `blobName` | `string` | Full blob name in Azure Blob Storage |
| `relativePath` | `string` | Path relative to the configured prefix (forward-slash normalized) |
| `content` | `Buffer` | Raw blob content |
| `size` | `number` | Content length in bytes |
| `etag` | `string` | Blob ETag |
| `lastModified` | `string` | Last modified date (ISO 8601) |
| `sourceRegistry` | `string \| undefined` | From blob metadata `source_registry` |
| `sourcePath` | `string \| undefined` | From blob metadata `source_path` |

### 6.4 Introspection: File Tree

`result.fileTree` provides blob data organized as a hierarchical tree. Directories appear before files at each level, and both are sorted alphabetically.

```typescript
import type { FileTreeNode } from 'azure-venv';

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
settings.json (512 bytes)
```

Each `FileTreeNode` object contains:

| Field | Type | Present On | Description |
|-------|------|-----------|-------------|
| `name` | `string` | Both | File or directory name (segment only) |
| `type` | `'file' \| 'directory'` | Both | Node type |
| `path` | `string` | Both | Relative path from the blob prefix |
| `children` | `FileTreeNode[]` | Directories | Child nodes (sorted: dirs first, then files) |
| `size` | `number` | Files | File size in bytes |
| `blobName` | `string` | Files | Full blob name in Azure |

### 6.5 Introspection: Environment Variables

`result.envDetails` provides full visibility into the environment variables that azure-venv manages.

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
| `remoteKeys` | `string[]` | Keys that originated from the remote `.env` file in Azure |
| `osKeys` | `string[]` | OS environment keys that were preserved (not overridden) |

> **Security Warning:** `envDetails.variables` contains **actual values** including secrets. See [Security Considerations](#11-security-considerations).

### 6.6 Blob Metadata and Source Lookup

Blobs with `source_registry` and `source_path` metadata can be looked up using source expressions:

```typescript
import { initAzureVenv, findBlobBySource } from 'azure-venv';

const result = await initAzureVenv();

// Look up by source expression: source_path@source_registry
const blob = findBlobBySource(result.blobs, 'config/app.json@github.com/org/repo');

if (blob) {
  console.log(`Found: ${blob.relativePath}`);
  console.log(`Content: ${blob.content.toString('utf-8')}`);
}
```

**Expression rules:**
- Format: `source_path@source_registry`
- Splits on the **last** `@`, so `source_path` may contain `@` characters
- Both parts are compared **case-sensitively**
- Returns `BlobContent | undefined`
- Throws `Error` if the expression format is invalid

For a higher-level API with caching and registry defaults, see [Asset Store](#7-asset-store).

### 6.7 Standalone Utility Functions

The introspection utilities are also exported for use outside the sync flow:

```typescript
import { buildFileTree, sortBlobs, findBlobBySource } from 'azure-venv';
import type { BlobContent, FileTreeNode } from 'azure-venv';
```

| Function | Signature | Description |
|----------|-----------|-------------|
| `sortBlobs` | `(blobs: readonly BlobContent[]) → BlobContent[]` | Sort blobs by `relativePath` |
| `buildFileTree` | `(blobs: readonly BlobContent[]) → FileTreeNode[]` | Build hierarchical tree from blob list |
| `findBlobBySource` | `(blobs, expression) → BlobContent \| undefined` | Look up blob by `source_path@source_registry` |

---

## 7. Asset Store

The `AssetStore` class provides a higher-level API for applications that consume configuration files, prompt templates, and other assets from Azure Blob Storage. It wraps `SyncResult.blobs` with registry-scoped lookups, optional caching, and typed retrieval methods.

### 7.1 Creating an Asset Store

**From an existing SyncResult (direct):**

```typescript
import { initAzureVenv, AssetStore } from 'azure-venv';

const syncResult = await initAzureVenv();
const store = new AssetStore(syncResult, {
  registry: 'github.com/org/repo',  // default registry for short keys
  cacheTTL: 300000,                  // optional, default: 0 (disabled)
});
```

**Via initAssetStore (recommended for two-scope pattern):**

```typescript
import { initAzureVenv, initAssetStore } from 'azure-venv';

// Step 1: Load env vars from scoped prefix
await initAzureVenv();

// Step 2: Load asset blobs from a different container/prefix
const store = await initAssetStore({
  url: process.env.AZURE_ASSET_STORE!,
  sasToken: process.env.AZURE_ASSET_SAS_TOKEN!,
  registry: process.env.ASSET_REGISTRY!,
  cacheTTL: 300000,  // optional
});
```

### 7.2 Two-Scope Initialization Pattern

Many applications need two separate Azure scopes:

1. **Environment scope** — a narrow prefix containing `.env` files loaded into `process.env`
2. **Asset scope** — a wider container with all configuration files, prompts, and other assets

```
Azure Blob Storage
    |
    |--- AZURE_VENV (scoped prefix)
    |       |--- .env           --> loaded into process.env
    |       |--- settings/      --> scoped blobs
    |
    |--- AZURE_ASSET_STORE (container-level)
            |--- config/app.json
            |--- prompts/filter.md
            |--- settings/agents.yaml
```

`initAssetStore()` handles this cleanly:

```typescript
import { initAzureVenv, initAssetStore } from 'azure-venv';

// Step 1: Load env vars (populates process.env)
const envResult = await initAzureVenv();

// Step 2: Load all asset blobs
const store = await initAssetStore({
  url: process.env.AZURE_ASSET_STORE!,
  sasToken: process.env.AZURE_ASSET_SAS_TOKEN!,
  registry: process.env.ASSET_REGISTRY!,
});

// Use the store
const config = store.getJsonAsset<AppConfig>('config/app.json');
```

`initAssetStore()` internally saves/restores `process.env.AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` so the two scopes don't interfere.

**Environment variables for two-scope pattern:**

| Variable | Scope | Description |
|---|---|---|
| `AZURE_VENV` | Env | Scoped prefix URL for environment variable loading |
| `AZURE_VENV_SAS_TOKEN` | Env | SAS token for the scoped prefix |
| `AZURE_ASSET_STORE` | Assets | Container-level URL for loading all asset blobs |
| `AZURE_ASSET_SAS_TOKEN` | Assets | SAS token for the asset store |
| `ASSET_REGISTRY` | Both | Default `source_registry` for blob lookups |

### 7.3 Retrieving Assets

**Short keys vs. full expressions:**

Keys without `@` have the default registry appended automatically. Keys with `@` are used as-is.

```typescript
// Short key — registry appended: "config/agents.yaml@github.com/org/repo"
const yaml = store.getAsset('config/agents.yaml');

// Full expression — used as-is
const other = store.getAsset('config/app.json@github.com/other/repo');
```

**Retrieval methods:**

```typescript
// UTF-8 string (throws if not found)
const content: string = store.getAsset('config/agents.yaml');

// Parsed JSON with type parameter (throws if not found or invalid JSON)
const config = store.getJsonAsset<{ name: string }>('config/app.json');

// Raw Buffer for binary content (throws if not found)
const buffer: Buffer = store.getRawAsset('images/logo.png');

// Non-throwing lookup (returns BlobContent | undefined)
const blob = store.findAsset('config/agents.yaml');

// Existence check
if (store.hasAsset('config/agents.yaml')) { /* ... */ }
```

**Discovery:**

```typescript
// List all source expressions for blobs with metadata
const assets: string[] = store.listAssets();
// ["config/app.json@github.com/org/repo", "config/agents.yaml@github.com/org/repo", ...]

// Availability and counts
store.isAvailable();    // boolean — true if any blobs loaded
store.blobCount;        // number
store.defaultRegistry;  // string — the configured registry
```

**Caching:**

By default, caching is disabled (`cacheTTL: 0`). When enabled, the store caches the UTF-8 string result of `Buffer.toString()` to avoid repeated conversion for frequently accessed assets.

```typescript
const store = new AssetStore(syncResult, {
  registry: 'github.com/org/repo',
  cacheTTL: 300000,  // 5 minutes
});

// Manually clear the cache
store.clearCache();
```

**YAML parsing:**

The library does not include a YAML parser to stay lightweight. Use the `yaml` package:

```bash
npm install yaml
```

```typescript
import yaml from 'yaml';

const yamlContent = store.getAsset('config/agents.yaml');
const config = yaml.parse(yamlContent);
```

### 7.4 Environment Variable Aliases

The `resolveAssetKey()` utility reads an environment variable and returns its value as an asset key. This supports a pattern where asset paths are configured in the remote `.env`:

```typescript
import { resolveAssetKey } from 'azure-venv';

// In the remote .env:
// FILTER_WITH_SAMPLE=langgraph-monitor/prompts/filter_with_sample.md
// AGENT_CONFIG=langgraph-monitor/config/agents.yaml

const key = resolveAssetKey('FILTER_WITH_SAMPLE');
// Returns: "langgraph-monitor/prompts/filter_with_sample.md"

const content = store.getAsset(key);
```

`resolveAssetKey()` throws if the environment variable is not set or is empty.

### 7.5 Refreshing from Azure

Stores created via `initAssetStore()` can re-sync from Azure without restarting:

```typescript
await store.refresh();
// Clears cache, re-syncs all blobs from Azure, updates the store in-place
```

`refresh()` uses the stored init config (URL, SAS token) so it works correctly even after `process.env.AZURE_VENV` has been restored.

Stores created directly from `SyncResult` (via `new AssetStore(...)`) do not support `refresh()` — create a new store instead.

### 7.6 Building a REST API

The library does not include Express middleware. You can build your own REST layer:

```typescript
import express from 'express';
import { AssetStore, resolveAssetKey } from 'azure-venv';

function createAssetRouter(store: AssetStore): express.Router {
  const router = express.Router();

  // GET /assets/:path(*) — retrieve by path
  router.get('/:assetPath(*)', (req, res) => {
    try {
      const content = store.getAsset(req.params.assetPath);
      const ext = req.params.assetPath.split('.').pop();
      const contentType = ext === 'json' ? 'application/json'
        : ext === 'yaml' || ext === 'yml' ? 'text/yaml'
        : 'text/plain';
      res.type(contentType).send(content);
    } catch {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  // GET /by-env/:envVarName — retrieve by env var alias
  router.get('/by-env/:envVarName', (req, res) => {
    try {
      const key = resolveAssetKey(req.params.envVarName);
      const content = store.getAsset(key);
      res.type('text/plain').send(content);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /refresh — re-sync from Azure
  router.post('/refresh', async (_req, res) => {
    try {
      await store.refresh();
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

// Usage:
// app.use('/api/assets', createAssetRouter(store));
```

---

## 8. CLI Usage

The library includes a CLI tool accessible via `npx azure-venv`.

### 8.1 One-Time Sync

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

**Example:**

```bash
AZURE_VENV="https://myaccount.blob.core.windows.net/mycontainer/prod" \
AZURE_VENV_SAS_TOKEN="sv=2022-11-02&ss=b..." \
npx azure-venv sync --log-level debug
```

The CLI prints a summary including blob list, file tree, and environment variables.

### 8.2 Continuous Watch

```bash
npx azure-venv watch [options]
```

Includes all sync options plus:

| Flag | Description |
|------|-------------|
| `--poll-interval <ms>` | Polling interval in milliseconds |

Press `Ctrl+C` to stop gracefully.

### 8.3 Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (or sync failure when `--fail-on-error` is set) |
| 130 | Interrupted by SIGINT |

---

## 9. Environment Variable Precedence

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

## 10. Error Handling

### 10.1 Error Classes

The library exports a hierarchy of typed errors:

| Error Class | When Thrown | Always Throws? |
|-------------|-----------|----------------|
| `ConfigurationError` | Partial config (one of AZURE_VENV/SAS_TOKEN missing), invalid URL, invalid parameter values, invalid SAS expiry date | Yes |
| `AuthenticationError` | SAS token expired or rejected by Azure | Yes |
| `AzureConnectionError` | Azure unreachable, DNS failure, network timeout | Only if `failOnError: true` |
| `SyncError` | Blob download failures | Only if `failOnError: true` |

All errors extend `AzureVenvError`, which extends the standard `Error`.

### 10.2 failOnError Behavior

When `failOnError` is `false` (the default), Azure connection and sync errors are caught internally, logged as warnings, and a degraded `SyncResult` is returned with `downloaded: 0` and empty introspection fields. Your application continues to start.

When `failOnError` is `true`, these errors propagate as exceptions and prevent application startup.

Configuration and authentication errors always throw regardless of this setting.

### 10.3 Error Handling Pattern

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

### 10.4 Graceful Degradation (Default)

```typescript
const result = await initAzureVenv(); // failOnError defaults to false

if (!result.attempted) {
  // AZURE_VENV not configured, library is a no-op
} else if (result.failed > 0) {
  // Some blobs failed, but app can continue
} else {
  // Full success
}

// In all cases, result.blobs, result.fileTree, and result.envDetails
// are available (may be empty arrays/objects on failure).
```

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

### In-Memory Blob Content

- `BlobContent.content` buffers hold the raw file data in memory. For sensitive files (certificates, keys), ensure they are not inadvertently logged or exposed.

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

  // Sync result
  SyncResult,           // Return type of initAzureVenv
  BlobContent,          // Single in-memory blob (content, relativePath, metadata)
  FileTreeNode,         // Hierarchical tree node
  EnvDetails,           // Environment variable introspection
  EnvSource,            // 'os' | 'remote' | 'local'
  EnvRecord,            // Record<string, string>
  EnvLoadResult,        // Internal env loading result

  // Watch mode
  WatchResult,          // Return type of watchAzureVenv
  WatchOptions,         // Watch configuration options
  WatchChangeEvent,     // Single change event
  WatchChangeType,      // 'added' | 'modified'

  // Asset store
  AssetStoreOptions,      // Options for AssetStore constructor
  InitAssetStoreOptions,  // Options for initAssetStore()

  // Azure
  BlobInfo,             // Blob metadata from listing

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
  buildFileTree,          // Utility: blob list -> hierarchical tree
  sortBlobs,              // Utility: sort blobs by relativePath
  findBlobBySource,       // Utility: look up blob by source expression
  initAssetStore,         // Two-scope asset store initialization
  resolveAssetKey,        // Env var -> asset key resolution

  // Classes
  AssetStore,             // Registry-scoped asset store with caching

  // Error classes
  AzureVenvError,         // Base error class
  ConfigurationError,     // Invalid configuration
  AzureConnectionError,   // Network/connectivity errors
  AuthenticationError,    // SAS token errors
  SyncError,              // Download failures
} from 'azure-venv';
```

---

## 13. Common Patterns

### 13.1 Application Bootstrap

Call `initAzureVenv` at the very top of your application entry point, before importing anything that depends on environment variables or blob content.

```typescript
import { initAzureVenv } from 'azure-venv';

const syncResult = await initAzureVenv();

// Now it's safe to import modules that read process.env
const { startServer } = await import('./server.js');
await startServer();
```

### 13.2 Full Bootstrap with Asset Store

```typescript
import { initAzureVenv, initAssetStore } from 'azure-venv';

// Step 1: Load environment variables
const envResult = await initAzureVenv();

// Step 2: Load asset store (if configured)
let store;
if (process.env.AZURE_ASSET_STORE) {
  store = await initAssetStore({
    url: process.env.AZURE_ASSET_STORE,
    sasToken: process.env.AZURE_ASSET_SAS_TOKEN!,
    registry: process.env.ASSET_REGISTRY!,
  });
}

// Step 3: Start the application with both env vars and assets available
const { startServer } = await import('./server.js');
await startServer(store);
```

### 13.3 Reading a JSON Config from Blobs

```typescript
const result = await initAzureVenv();

const configBlob = result.blobs.find(b => b.relativePath === 'config.json');
if (configBlob) {
  const config = JSON.parse(configBlob.content.toString('utf-8'));
  console.log('App config:', config);
}
```

### 13.4 Reading a JSON Config from Asset Store

```typescript
interface AppConfig {
  name: string;
  version: string;
  features: string[];
}

const config = store.getJsonAsset<AppConfig>('config/app.json');
console.log(`${config.name} v${config.version}`);
```

### 13.5 Loading YAML Config via Asset Store

```bash
npm install yaml
```

```typescript
import yaml from 'yaml';

const yamlContent = store.getAsset('config/agents.yaml');
const agents = yaml.parse(yamlContent);
```

### 13.6 Loading Prompt Templates via Env Aliases

```typescript
import { resolveAssetKey } from 'azure-venv';

// Remote .env contains: FILTER_PROMPT=prompts/filter_with_sample.md
const key = resolveAssetKey('FILTER_PROMPT');
const prompt = store.getAsset(key);
```

### 13.7 Conditional Behavior Based on Blobs

```typescript
const result = await initAzureVenv();

const hasTemplates = result.blobs.some(b => b.relativePath.startsWith('templates/'));
const hasCerts = result.blobs.some(b => b.relativePath.endsWith('.pem'));

if (hasTemplates) {
  console.log('Email templates available');
}
if (hasCerts) {
  console.log('TLS certificates loaded');
}
```

### 13.8 Displaying Sync Summary

```typescript
const result = await initAzureVenv();

if (result.attempted) {
  console.log(`azure-venv: ${result.downloaded} read, ${result.failed} failed (${result.duration}ms)`);
  console.log(`  Blobs: ${result.blobs.length}`);
  console.log(`  Env vars: ${Object.keys(result.envDetails.variables).length} (${result.envDetails.remoteKeys.length} from remote)`);
}
```

### 13.9 Checking Where a Specific Variable Came From

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

### 13.10 Finding a Specific Node in the File Tree

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

### 13.11 Watch Mode with Graceful Shutdown

```typescript
const { initialSync, stop } = await watchAzureVenv({
  pollInterval: 30000,
  logLevel: 'info',
});

console.log(`Initial sync: ${initialSync.downloaded} blobs`);

process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
```

### 13.12 Using Without Azure (Local-Only .env)

If `AZURE_VENV` is not set, the library still loads your local `.env` file and returns immediately:

```typescript
const result = await initAzureVenv();
// result.attempted === false
// result.blobs === []
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

### ConfigurationError: invalid date format for SAS_EXPIRY

`AZURE_VENV_SAS_EXPIRY` contains an unrecognizable date. Use `yyyy-mm-dd` (e.g., `2026-12-31`) or ISO 8601 format (e.g., `2026-12-31T00:00:00Z`).

### Blobs read but environment variables are not updated

- The remote `.env` must be a blob named `.env` directly under the configured prefix. For example, if `AZURE_VENV=https://account.blob.core.windows.net/container/prod`, the remote `.env` must be at `prod/.env`.
- Use `result.remoteEnvLoaded` to check if a remote `.env` was found.
- Use `result.envDetails` to inspect the final state of all variables.

### SAS expiry warning not appearing

Set `AZURE_VENV_SAS_EXPIRY` to the token's expiration date:

```bash
export AZURE_VENV_SAS_EXPIRY="2026-06-30"
```

The warning appears when the expiry is within 7 days.

### Asset not found in AssetStore

- Verify the blob has `source_registry` and `source_path` metadata set
- Check the registry matches `store.defaultRegistry`
- Use `store.listAssets()` to see all available source expressions
- Try the full expression: `store.getAsset('path@registry')`

### initAssetStore throws ConfigurationError

All three options are required: `url`, `sasToken`, and `registry`. Ensure the corresponding environment variables (`AZURE_ASSET_STORE`, `AZURE_ASSET_SAS_TOKEN`, `ASSET_REGISTRY`) are set.

### Large number of blobs causes slow startup

Reduce the number of blobs by narrowing the prefix in `AZURE_VENV`, or increase concurrency:

```typescript
const result = await initAzureVenv({
  concurrency: 20,   // up to 50
  timeout: 120000,   // 2 minute timeout per blob
});
```

Note: All blobs are held in memory. Ensure the process has sufficient memory for your blob set.
