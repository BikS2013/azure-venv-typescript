# Asset API Pattern for azure-venv

This document describes the asset consumption pattern built on top of the `azure-venv` library. It is intended as a reference for enriching `azure-venv-typescript` so that users of the library can embed the same asset retrieval and serving functionality in their own applications.

## Overview

The Asset API pattern extends `azure-venv`'s in-memory blob sync with:

1. **A service layer** (`AssetService`) that wraps `findBlobBySource()` with caching, registry-scoped lookups, and refresh capability
2. **A REST API** that exposes assets over HTTP with content-type negotiation and environment-variable aliasing
3. **A two-scope initialization** pattern that separates environment variable loading from asset blob loading using two independent calls to `initAzureVenv()`
4. **An internal consumption pattern** where application services (agents, LLM, etc.) retrieve configuration files (YAML, JSON, Markdown) from the in-memory blob store at runtime

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

               initAzureVenv() x 2
                      |
              +-------+--------+
              |                |
         SyncResult       SyncResult
         (env vars)       (asset blobs)
              |                |
              v                v
        process.env      AssetService
                           |
              +------------+-------------+
              |            |             |
         AgentService  LLMService   REST API
         (YAML config) (YAML config) (/api/assets/*)
```

## Core Concepts

### Blob Metadata Convention

Every blob in Azure Blob Storage carries two custom metadata fields:

| Metadata Key | Description | Example |
|---|---|---|
| `source_registry` | The origin repository where the file is maintained | `github.com/org/repo` |
| `source_path` | The path of the file inside the source repository | `config/agents.yaml` |

These are set when blobs are uploaded and are available on every `BlobContent` object after sync.

### Source Expression

Assets are identified by a **source expression** in the format:

```
<source_path>@<source_registry>
```

For example: `config/agents.yaml@github.com/org/repo`

- The `@` delimiter splits on the **last** occurrence (so `source_path` may contain `@`)
- Both parts are matched **case-sensitively**
- The `findBlobBySource()` function from `azure-venv` performs this lookup

### Registry Fallback

To avoid repeating the registry in every lookup, a default **asset registry** is configured via the `ASSET_REGISTRY` environment variable. The AssetService constructs the full expression:

- If the asset key **contains** `@`, it is used as-is (full expression)
- If the asset key **does not contain** `@`, the registry is appended: `assetKey@ASSET_REGISTRY`

This allows callers to use short keys like `config/agents.yaml` instead of the full expression.

## Two-Scope Initialization Pattern

The application calls `initAzureVenv()` twice with different scopes:

### Scope 1: Environment Variables (scoped prefix)

```typescript
// AZURE_VENV points to a specific prefix: .../container/prefix/settings/
// This loads .env files and a narrow set of config blobs
const envSyncResult = await initAzureVenv();
```

**Purpose:** Load remote `.env` files into `process.env` with three-tier precedence (OS > remote > local).

### Scope 2: Asset Blobs (container-level)

```typescript
// Temporarily override AZURE_VENV to point to the container root
// AZURE_ASSET_STORE = https://account.blob.core.windows.net/container/
const originalVenv = process.env.AZURE_VENV;
const originalSas = process.env.AZURE_VENV_SAS_TOKEN;

process.env.AZURE_VENV = process.env.AZURE_ASSET_STORE;
process.env.AZURE_VENV_SAS_TOKEN = process.env.AZURE_ASSET_SAS_TOKEN || process.env.AZURE_VENV_SAS_TOKEN;

const assetSyncResult = await initAzureVenv();

// Restore original values
process.env.AZURE_VENV = originalVenv;
process.env.AZURE_VENV_SAS_TOKEN = originalSas;

// Create the asset service from the container-level sync result
const assetService = new AssetService(assetSyncResult);
```

**Purpose:** Load ALL blobs from the container into memory for asset retrieval by source expression.

### Environment Variables for Two-Scope Pattern

| Variable | Scope | Description |
|---|---|---|
| `AZURE_VENV` | Env | Scoped prefix URL for environment variable loading |
| `AZURE_VENV_SAS_TOKEN` | Env | SAS token for the scoped prefix |
| `AZURE_ASSET_STORE` | Assets | Container-level URL for loading all asset blobs |
| `AZURE_ASSET_SAS_TOKEN` | Assets | SAS token for asset store (falls back to `AZURE_VENV_SAS_TOKEN`) |
| `ASSET_REGISTRY` | Both | Default `source_registry` for blob lookups |

## AssetService Implementation

The `AssetService` wraps `azure-venv`'s blob list with caching and a simplified lookup API.

### Class Definition

```typescript
import type { SyncResult, BlobContent } from 'azure-venv';
import { findBlobBySource, initAzureVenv } from 'azure-venv';

export class AssetService {
  private blobs: BlobContent[];
  private cache: Map<string, { data: string; timestamp: number }> = new Map();
  private cacheTTL = 300000; // 5 minutes

  constructor(syncResult: SyncResult) {
    this.blobs = [...syncResult.blobs];
  }

  isAvailable(): boolean {
    return this.blobs.length > 0;
  }

  getAsset(registry: string, assetKey: string): string {
    // Build the full source expression
    const expression = assetKey.includes('@') ? assetKey : `${assetKey}@${registry}`;

    // Check cache
    const cached = this.cache.get(expression);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    // Look up blob by source_path@source_registry
    const blob = findBlobBySource(this.blobs, expression);
    if (!blob) {
      throw new Error(`Asset not found: ${expression}`);
    }

    const data = blob.content.toString('utf-8');

    // Update cache
    this.cache.set(expression, { data, timestamp: Date.now() });

    return data;
  }

  async refreshCache(registry: string, assetKey: string): Promise<void> {
    const expression = assetKey.includes('@') ? assetKey : `${assetKey}@${registry}`;
    this.cache.delete(expression);

    // Re-sync from Azure to get fresh blobs
    const syncResult = await initAzureVenv();
    if (syncResult.attempted && syncResult.blobs.length > 0) {
      this.blobs = [...syncResult.blobs];
    }
  }

  close(): void {
    // No-op: no external connections to close
  }
}
```

### Key Design Decisions

1. **In-memory cache with TTL** — Avoids repeated `findBlobBySource()` scans for hot assets. Default TTL is 5 minutes.
2. **Registry fallback** — Callers pass short asset keys; the registry is appended automatically unless the key already contains `@`.
3. **Refresh re-syncs from Azure** — `refreshCache()` calls `initAzureVenv()` again to pick up blob changes without restarting the application.
4. **Content as UTF-8 string** — All assets are returned as strings. Callers are responsible for parsing (JSON, YAML, etc.).
5. **SyncResult as constructor input** — The service is initialized from the second `initAzureVenv()` call (container-level scope).

## REST API Endpoints

The REST API exposes three endpoints for consuming assets over HTTP.

### GET /api/assets/{assetPath}

Retrieve an asset by its path within the registry.

```
GET /api/assets/config/agents.yaml
GET /api/assets/prompts/filter_with_sample.md
GET /api/assets/config/client-settings.json
```

**Behavior:**
- The `assetPath` is URL-decoded and used as the asset key
- Content-Type is negotiated based on file extension:
  - `.json` → `application/json` (parsed and re-serialized)
  - `.yaml` / `.yml` → `text/yaml`
  - Everything else → `text/plain`
- Returns `404` if the asset is not found

### GET /api/assets/by-env/{envVarName}

Retrieve an asset using an environment variable as an alias for the asset key.

```
GET /api/assets/by-env/THREAD_EVALUATION_PROMPT
GET /api/assets/by-env/FILTER_WITH_SAMPLE
GET /api/assets/by-env/CLIENT_CONFIG_SETTINGS
```

**Behavior:**
- Reads `process.env[envVarName]` to get the asset key
- If the env var is not set, returns `400`
- Fetches the asset using the resolved key
- Same content-type negotiation as the direct path endpoint

**Use case:** Allows the frontend or external consumers to fetch assets by a well-known environment variable name rather than hardcoding blob paths. The mapping between env var names and asset keys is managed in the remote `.env` configuration.

### POST /api/assets/refresh

Force a cache refresh and re-sync from Azure for a specific asset.

```json
POST /api/assets/refresh
Content-Type: application/json

{
  "assetKey": "config/agents.yaml"
}
```

**Behavior:**
- Clears the in-memory cache for the specified asset
- Re-syncs all blobs from Azure Blob Storage
- Returns `200` on success

## Internal Consumption Patterns

Application services consume assets programmatically through `AssetService.getAsset()`.

### Pattern 1: YAML Configuration Files

Services load their configuration from YAML files stored as blobs. The asset key is specified via an environment variable.

```typescript
// AgentService: loads agent definitions from YAML
const configAssetKey = process.env.AGENT_CONFIG_ASSET_KEY;  // e.g., "langgraph-monitor/config/agents.yaml"
const yamlContent = assetService.getAsset(process.env.ASSET_REGISTRY!, configAssetKey);
const config = yaml.parse(yamlContent);
// config.agents → [ { name, url, database_connection_string }, ... ]

// LLMService: loads LLM provider configurations from YAML
const configAssetKey = process.env.LLM_CONFIG_ASSET_KEY;  // e.g., "langgraph-monitor/config/llm.yaml"
const yamlContent = assetService.getAsset(process.env.ASSET_REGISTRY!, configAssetKey);
const config = yaml.load(yamlContent);
// config.configurations → [ { name, provider, model, enabled }, ... ]
```

### Pattern 2: Prompt Templates

Markdown or text files used as LLM prompt templates, referenced by environment variable aliases.

```typescript
// Environment variables (loaded from remote .env via azure-venv):
// FILTER_WITH_SAMPLE=langgraph-monitor/prompts/filter_with_sample.md
// THREAD_EVALUATION_PROMPT=langgraph-monitor/prompts/thread_evaluation.md

// Retrieved via REST: GET /api/assets/by-env/FILTER_WITH_SAMPLE
// Or programmatically:
const promptKey = process.env.FILTER_WITH_SAMPLE;
const promptContent = assetService.getAsset(process.env.ASSET_REGISTRY!, promptKey);
```

### Pattern 3: Client Configuration

JSON configuration files served to the frontend.

```typescript
// CLIENT_CONFIG_SETTINGS=langgraph-monitor/config/client-settings.json
// Retrieved via REST: GET /api/assets/by-env/CLIENT_CONFIG_SETTINGS
// Returns parsed JSON directly
```

## Proposed azure-venv Enhancement

To embed this pattern natively in `azure-venv`, the library could provide:

### 1. AssetStore Class

A built-in wrapper around `SyncResult.blobs` that provides:

```typescript
import { initAzureVenv, AssetStore } from 'azure-venv';

const syncResult = await initAzureVenv();
const store = new AssetStore(syncResult, {
  registry: 'github.com/org/repo',  // default registry for short keys
  cacheTTL: 300000,                  // optional, default 5 min
});

// Short key (registry appended automatically)
const config = store.getAsset('config/agents.yaml');        // returns string
const parsed = store.getJsonAsset('config/app.json');       // returns parsed object
const yaml = store.getYamlAsset('config/agents.yaml');      // returns parsed YAML

// Full expression (registry in key)
const explicit = store.getAsset('config/app.json@github.com/other/repo');

// Refresh from Azure
await store.refresh();

// Check availability
store.isAvailable();  // boolean
store.blobCount;      // number
```

### 2. Two-Scope Helper

A convenience function for the two-scope initialization pattern:

```typescript
import { initAzureVenv, initAssetStore } from 'azure-venv';

// Step 1: Load env vars (scoped prefix) — existing behavior
const envResult = await initAzureVenv();

// Step 2: Load asset blobs (container-level scope) — new helper
const store = await initAssetStore({
  url: process.env.AZURE_ASSET_STORE,          // container-level URL
  sasToken: process.env.AZURE_ASSET_SAS_TOKEN,  // optional, falls back to AZURE_VENV_SAS_TOKEN
  registry: process.env.ASSET_REGISTRY,         // default source_registry
  cacheTTL: 300000,                             // optional
});

// Use the store
const agentConfig = store.getYamlAsset('config/agents.yaml');
```

This would eliminate the manual `process.env` swap currently required for the two-scope pattern.

### 3. Express Middleware (Optional)

For applications using Express, a route factory:

```typescript
import { createAssetRouter } from 'azure-venv/express';

const router = createAssetRouter(store, {
  basePath: '/api/assets',
  envAliasRoute: true,   // enables /by-env/:envVarName
  refreshRoute: true,    // enables POST /refresh
});

app.use(router);
```

### 4. Environment Variable Alias Resolution

A utility function for the env-var-to-asset-key pattern:

```typescript
import { resolveAssetKey } from 'azure-venv';

// Reads the env var and resolves it to an asset key
const key = resolveAssetKey('THREAD_EVALUATION_PROMPT');
// Returns: "langgraph-monitor/prompts/thread_evaluation.md"

const content = store.getAsset(key);
```

## Summary of azure-venv Types Used

| Type | Usage |
|---|---|
| `SyncResult` | Returned by `initAzureVenv()`, passed to `AssetService` constructor |
| `SyncResult.blobs` | `readonly BlobContent[]` — the in-memory blob list |
| `SyncResult.attempted` | `boolean` — whether Azure sync was attempted |
| `SyncResult.downloaded` | `number` — count of blobs downloaded |
| `BlobContent` | Individual blob with `content` (Buffer), `relativePath`, `sourceRegistry`, `sourcePath` |
| `BlobContent.content` | `Buffer` — raw blob content, converted to string via `.toString('utf-8')` |
| `BlobContent.sourceRegistry` | `string | undefined` — from blob metadata `source_registry` |
| `BlobContent.sourcePath` | `string | undefined` — from blob metadata `source_path` |
| `findBlobBySource()` | Lookup function: `(blobs, expression) → BlobContent | undefined` |
| `initAzureVenv()` | Main entry point: reads env, syncs blobs, returns `SyncResult` |
