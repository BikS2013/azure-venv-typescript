# Asset API Pattern for azure-venv

This document describes the asset consumption pattern built into the `azure-venv` library. Users can embed asset retrieval and serving functionality in their applications using `AssetStore`, `initAssetStore()`, and `resolveAssetKey()`.

## Overview

The Asset API pattern extends `azure-venv`'s in-memory blob sync with:

1. **`AssetStore`** — a class that wraps `SyncResult.blobs` with registry-scoped lookups, optional caching, and typed retrieval (`getAsset`, `getJsonAsset`, `getRawAsset`)
2. **`initAssetStore()`** — a convenience function for the two-scope initialization pattern (env vars + asset blobs from separate prefixes)
3. **`resolveAssetKey()`** — a utility to resolve environment variable names to asset keys
4. **A two-scope initialization** pattern that separates environment variable loading from asset blob loading using two independent calls to `initAzureVenv()`

## Architecture

```
Azure Blob Storage
    |
    |--- AZURE_VENV (scoped prefix)
    |       |--- .env           --> loaded into process.env
    |       |--- settings/      --> scoped blobs (env overrides)
    |
    |--- AZURE_ASSET_STORE (container-level)
            |--- config/app.json
            |--- prompts/filter.md
            |--- settings/agents.yaml
            |--- ...all asset blobs

               initAzureVenv() + initAssetStore()
                      |
              +-------+--------+
              |                |
         SyncResult       AssetStore
         (env vars)       (asset blobs)
              |                |
              v                v
        process.env      Application Services
                           |
              +------------+-------------+
              |            |             |
         AgentService  LLMService   REST API
         (YAML config) (YAML config) (user-built)
```

## Core Concepts

### Blob Metadata Convention

Every blob in Azure Blob Storage carries two custom metadata fields:

| Metadata Key | Description | Example |
|---|---|---|
| `source_registry` | The origin repository where the file is maintained | `github.com/org/repo` |
| `source_path` | The path of the file inside the source repository | `config/agents.yaml` |

These are set when blobs are uploaded and are available on every `BlobContent` object after sync as `sourceRegistry` and `sourcePath`.

### Source Expression

Assets are identified by a **source expression** in the format:

```
<source_path>@<source_registry>
```

For example: `config/agents.yaml@github.com/org/repo`

- The `@` delimiter splits on the **last** occurrence (so `source_path` may contain `@`)
- Both parts are matched **case-sensitively**
- The `findBlobBySource()` function from `azure-venv` performs this lookup

### Registry Fallback via Short Keys

To avoid repeating the registry in every lookup, `AssetStore` is configured with a default registry. When a key is passed to any retrieval method:

- If the key **contains** `@`, it is used as-is (full source expression)
- If the key **does not contain** `@`, the default registry is appended: `key@registry`

This allows callers to use short keys like `config/agents.yaml` instead of the full expression.

## Two-Scope Initialization Pattern

The application calls `initAzureVenv()` for environment variables, then `initAssetStore()` for asset blobs.

### Scope 1: Environment Variables

```typescript
import { initAzureVenv } from 'azure-venv';

// AZURE_VENV points to a scoped prefix: .../container/prefix/settings/
// This loads .env files into process.env with three-tier precedence
const envResult = await initAzureVenv();
```

### Scope 2: Asset Blobs via initAssetStore()

```typescript
import { initAssetStore } from 'azure-venv';

// Load ALL blobs from the asset container into an AssetStore
const store = await initAssetStore({
  url: process.env.AZURE_ASSET_STORE!,       // container-level URL
  sasToken: process.env.AZURE_ASSET_SAS_TOKEN!, // SAS token for the asset container
  registry: process.env.ASSET_REGISTRY!,      // default source_registry
  cacheTTL: 300000,                           // optional, default: 0 (disabled)
});
```

`initAssetStore()` internally:
1. Saves the current `process.env.AZURE_VENV` and `AZURE_VENV_SAS_TOKEN`
2. Temporarily overrides them with the asset container URL/SAS
3. Calls `initAzureVenv()` to sync all blobs into memory
4. Restores the original environment variables (even on error)
5. Returns an `AssetStore` instance with `refresh()` capability

### Environment Variables for Two-Scope Pattern

| Variable | Scope | Required | Description |
|---|---|---|---|
| `AZURE_VENV` | Env | Yes* | Scoped prefix URL for environment variable loading |
| `AZURE_VENV_SAS_TOKEN` | Env | Yes* | SAS token for the scoped prefix |
| `AZURE_ASSET_STORE` | Assets | Yes | Container-level URL for loading all asset blobs |
| `AZURE_ASSET_SAS_TOKEN` | Assets | Yes | SAS token for asset store |
| `ASSET_REGISTRY` | Both | Yes | Default `source_registry` for blob lookups |

*Required for the env scope. If neither `AZURE_VENV` nor `AZURE_VENV_SAS_TOKEN` is set, the library is a no-op for env loading.

## AssetStore API

### Creating from SyncResult (Direct)

```typescript
import { initAzureVenv, AssetStore } from 'azure-venv';

const syncResult = await initAzureVenv();
const store = new AssetStore(syncResult, {
  registry: 'github.com/org/repo',
  cacheTTL: 300000,  // optional, default: 0
});
```

**Note:** Stores created directly from `SyncResult` do not support `refresh()`. Use `initAssetStore()` for refresh capability.

### Creating via initAssetStore (Recommended)

```typescript
import { initAzureVenv, initAssetStore } from 'azure-venv';

// Step 1: Load env vars
await initAzureVenv();

// Step 2: Load asset blobs
const store = await initAssetStore({
  url: process.env.AZURE_ASSET_STORE!,
  sasToken: process.env.AZURE_ASSET_SAS_TOKEN!,
  registry: process.env.ASSET_REGISTRY!,
});
```

### Retrieval Methods

```typescript
// Get asset as UTF-8 string (short key — registry appended automatically)
const yamlContent = store.getAsset('config/agents.yaml');

// Get asset as UTF-8 string (full expression — registry in key)
const explicit = store.getAsset('config/app.json@github.com/other/repo');

// Parse JSON asset with type parameter
const config = store.getJsonAsset<{ name: string }>('config/app.json');

// Get raw Buffer (for binary content)
const buffer = store.getRawAsset('images/logo.png');

// Non-throwing lookup
const blob = store.findAsset('config/agents.yaml');  // BlobContent | undefined

// Existence check
if (store.hasAsset('config/agents.yaml')) { /* ... */ }
```

### Discovery and Inspection

```typescript
// List all source expressions for blobs with metadata
const assets = store.listAssets();
// ["config/app.json@github.com/org/repo", "config/agents.yaml@github.com/org/repo", ...]

// Check availability
store.isAvailable();  // boolean — true if any blobs are loaded
store.blobCount;      // number — count of loaded blobs
store.defaultRegistry; // string — the configured default registry
```

### Caching

```typescript
// Cache is disabled by default (cacheTTL: 0)
// Enable with a TTL in milliseconds:
const store = new AssetStore(syncResult, {
  registry: 'github.com/org/repo',
  cacheTTL: 300000,  // 5 minutes
});

// Manually clear the cache
store.clearCache();
```

The cache stores the UTF-8 string result of `Buffer.toString()` to avoid repeated conversion for frequently accessed assets. The underlying `BlobContent` objects are always available via `findAsset()`.

### Refresh from Azure

```typescript
// Only available on stores created via initAssetStore()
await store.refresh();
// Clears cache, re-syncs all blobs from Azure, updates the store in-place
```

`refresh()` uses the stored init config (URL, SAS token) to re-sync, so it works correctly even after `process.env.AZURE_VENV` has been restored to its original value.

## Environment Variable Alias Resolution

The `resolveAssetKey()` utility reads an environment variable and returns its value as an asset key:

```typescript
import { resolveAssetKey } from 'azure-venv';

// process.env.FILTER_WITH_SAMPLE = "langgraph-monitor/prompts/filter_with_sample.md"
const key = resolveAssetKey('FILTER_WITH_SAMPLE');
const content = store.getAsset(key);
```

This supports the pattern where asset paths are configured as environment variables in the remote `.env` file, allowing frontends or external consumers to reference assets by well-known variable names.

`resolveAssetKey()` throws if the environment variable is not set or is empty.

## Consumption Patterns

### Pattern 1: YAML Configuration Files

Services load YAML config from blobs. **Note:** The library does not include a YAML parser — use the `yaml` package.

```typescript
import yaml from 'yaml';  // npm install yaml

const configKey = process.env.AGENT_CONFIG_ASSET_KEY!;
const yamlContent = store.getAsset(configKey);
const config = yaml.parse(yamlContent);
```

### Pattern 2: JSON Configuration Files

```typescript
interface AppConfig { name: string; version: string; features: string[] }

const config = store.getJsonAsset<AppConfig>('config/app.json');
console.log(config.name, config.version);
```

### Pattern 3: Prompt Templates via Env Alias

```typescript
import { resolveAssetKey } from 'azure-venv';

// Environment variables (loaded from remote .env via azure-venv):
// FILTER_WITH_SAMPLE=langgraph-monitor/prompts/filter_with_sample.md
// THREAD_EVALUATION_PROMPT=langgraph-monitor/prompts/thread_evaluation.md

const promptKey = resolveAssetKey('FILTER_WITH_SAMPLE');
const promptContent = store.getAsset(promptKey);
```

### Pattern 4: REST API (User-Built)

The library does not include Express middleware. Users build their own REST layer:

```typescript
import express from 'express';
import { AssetStore, resolveAssetKey } from 'azure-venv';

function createAssetRouter(store: AssetStore, registry: string): express.Router {
  const router = express.Router();

  // GET /api/assets/:assetPath(*)
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

  // GET /api/assets/by-env/:envVarName
  router.get('/by-env/:envVarName', (req, res) => {
    try {
      const key = resolveAssetKey(req.params.envVarName);
      const content = store.getAsset(key);
      res.type('text/plain').send(content);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/assets/refresh
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
```

## Public API Summary

### Exports from `azure-venv`

| Export | Kind | Description |
|---|---|---|
| `AssetStore` | Class | Registry-scoped asset store with caching |
| `initAssetStore(options)` | Function | Two-scope init helper, returns `Promise<AssetStore>` |
| `resolveAssetKey(envVarName)` | Function | Reads env var as asset key |
| `AssetStoreOptions` | Type | Options for `AssetStore` constructor |
| `InitAssetStoreOptions` | Type | Options for `initAssetStore()` |

### AssetStore Methods

| Method | Returns | Description |
|---|---|---|
| `getAsset(key)` | `string` | UTF-8 content, throws if not found |
| `getRawAsset(key)` | `Buffer` | Raw binary content, throws if not found |
| `getJsonAsset<T>(key)` | `T` | Parsed JSON, throws if not found or invalid JSON |
| `findAsset(key)` | `BlobContent \| undefined` | Non-throwing blob lookup |
| `hasAsset(key)` | `boolean` | Existence check |
| `listAssets()` | `string[]` | All `sourcePath@sourceRegistry` expressions |
| `isAvailable()` | `boolean` | Whether any blobs are loaded |
| `clearCache()` | `void` | Clear the string cache |
| `refresh()` | `Promise<void>` | Re-sync from Azure (initAssetStore stores only) |

### AssetStore Properties

| Property | Type | Description |
|---|---|---|
| `blobCount` | `number` | Number of blobs in the store |
| `defaultRegistry` | `string` | The configured default registry |

## azure-venv Types Used

| Type | Usage |
|---|---|
| `SyncResult` | Returned by `initAzureVenv()`, passed to `AssetStore` constructor |
| `SyncResult.blobs` | `readonly BlobContent[]` — the in-memory blob list |
| `BlobContent` | Individual blob with `content` (Buffer), `relativePath`, `sourceRegistry`, `sourcePath` |
| `BlobContent.sourceRegistry` | `string \| undefined` — from blob metadata `source_registry` |
| `BlobContent.sourcePath` | `string \| undefined` — from blob metadata `source_path` |
| `findBlobBySource()` | Internal lookup function used by `AssetStore` |
| `initAzureVenv()` | Used by `initAssetStore()` for the underlying blob sync |
| `ConfigurationError` | Thrown by `initAssetStore()` for missing required options |

## Design Decisions

1. **No YAML dependency** — The library stays lightweight. Users add the `yaml` package themselves and call `yaml.parse(store.getAsset(key))`.
2. **No Express middleware** — REST API is a user-land concern. The reference pattern above shows how to build one.
3. **Cache disabled by default** — `cacheTTL: 0` means no caching. The main cost being cached is `Buffer.toString('utf-8')` conversion.
4. **refresh() requires initAssetStore()** — Direct `AssetStore` instances from `SyncResult` don't store the Azure config needed to re-sync. Users must either use `initAssetStore()` or create a new store manually.
5. **process.env swap encapsulated** — `initAssetStore()` handles the temporary environment override internally, restoring original values even on error via `try/finally`.
6. **registry is required** — No fallback. `initAssetStore()` throws `ConfigurationError` if `url`, `sasToken`, or `registry` is missing.
7. **Short keys are the primary API** — Most callers use `store.getAsset('config/app.json')` without caring about the registry. Full expressions are supported for cross-registry lookups.
