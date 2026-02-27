# Investigation: Azure Virtual Environment (VENV) Library for TypeScript

**Date:** 2026-02-27
**Status:** Research Complete
**Author:** Technical Investigation

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Azure Storage Blob SDK Analysis](#azure-storage-blob-sdk-analysis)
3. [Environment Variable Management](#environment-variable-management)
4. [Filesystem Sync Patterns](#filesystem-sync-patterns)
5. [Existing Solutions and Alternatives](#existing-solutions-and-alternatives)
6. [Comparison Matrix](#comparison-matrix)
7. [Recommended Approach](#recommended-approach)
8. [Security Considerations](#security-considerations)
9. [Error Handling and Resilience](#error-handling-and-resilience)
10. [AZURE_VENV URL Format Design](#azure_venv-url-format-design)
11. [Technical Architecture Outline](#technical-architecture-outline)
12. [References](#references)

---

## 1. Executive Summary

This investigation covers the design and implementation of a TypeScript library ("azure-venv") that acts as a virtual folder system, synchronizing files from Azure Blob Storage to a local application root at startup. The library reads `AZURE_VENV` and `AZURE_VENV_SAS_TOKEN` from local `.env` files or OS environment variables, connects to the specified Azure Blob Storage container/path, downloads all files and folders locally, and prioritizes a remote `.env` file for environment variable loading.

**Key Findings:**

- **SDK:** `@azure/storage-blob` v12.31.0 (latest) is the recommended and actively maintained SDK for TypeScript/JavaScript. It provides full support for SAS token authentication, blob listing (flat and hierarchical), and multiple download strategies (stream, buffer, file).
- **Download Strategy:** `downloadToFile()` is the simplest and most appropriate method for syncing blobs to local filesystem. For very large files, streaming is preferred to avoid memory exhaustion.
- **Sync Strategy:** Flat listing with prefix filtering is the most efficient approach. Conditional downloads using `If-Modified-Since` / ETag headers can optimize re-sync operations.
- **Environment Variables:** The `dotenv` library (or native Node.js `--env-file` in v20.6+) handles `.env` file parsing. A three-tier precedence model (OS env > remote `.env` > local `.env`) is recommended.
- **No existing library** performs exactly this function. The closest alternatives (BlobFuse, rclone, azure-storage-fs) either target different platforms, are OS-level mounts, or are outdated.
- **Security:** SAS tokens must never be logged, paths must be validated to prevent traversal attacks, and HTTPS must always be used.

---

## 2. Azure Storage Blob SDK Analysis

### 2.1 SDK Version and Status

| Property | Value |
|---|---|
| Package | `@azure/storage-blob` |
| Latest Version | 12.31.0 |
| npm Weekly Downloads | 5M+ |
| Node.js Support | >= 18.x (LTS) |
| TypeScript Support | Native (written in TypeScript) |
| License | MIT |

The SDK is actively maintained by Microsoft as part of the Azure SDK for JavaScript monorepo. It supports service version 2025-11-05 as of v12.31.0.

**Source:** [npm - @azure/storage-blob](https://www.npmjs.com/package/@azure/storage-blob) | [GitHub Changelog](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/storage/storage-blob/CHANGELOG.md)

### 2.2 SAS Token Authentication

The SDK supports three authentication methods, of which SAS token is the most portable for this use case:

```typescript
import { BlobServiceClient } from "@azure/storage-blob";

// Using SAS token appended to URL
const sasUrl = `https://${accountName}.blob.core.windows.net?${sasToken}`;
const blobServiceClient = new BlobServiceClient(sasUrl);

// Or at container level
const containerUrl = `https://${accountName}.blob.core.windows.net/${containerName}?${sasToken}`;
const containerClient = new ContainerClient(containerUrl);
```

**Three types of SAS tokens:**

| SAS Type | Signed With | Scope | Recommendation |
|---|---|---|---|
| **User Delegation SAS** | Microsoft Entra credentials | Blob/Container | Most secure; recommended by Microsoft |
| **Service SAS** | Storage account key | Single service resource | Good for scoped access |
| **Account SAS** | Storage account key | One or more services | Broadest access; use cautiously |

For this library, a **Service SAS** or **Account SAS** scoped to a specific container with **read** and **list** permissions is the minimum required. The SAS token query parameters include:

- `sv` - Signed version
- `se` - Signed expiry (ISO 8601)
- `st` - Signed start time
- `sp` - Signed permissions (e.g., `rl` for read+list)
- `sr` - Signed resource (e.g., `c` for container)
- `sig` - Signature
- `sip` - Signed IP range (optional)
- `spr` - Signed protocol (e.g., `https`)

**Source:** [SAS Overview](https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview) | [Create a service SAS (JavaScript)](https://learn.microsoft.com/en-us/azure/storage/blobs/sas-service-create-javascript)

### 2.3 Listing Blobs

Two listing approaches are available:

#### Flat Listing (Recommended for sync)

Returns all blobs as a flat list. Blob names include the full path (e.g., `folder1/subfolder/file.txt`). This is the simplest approach for downloading everything.

```typescript
const listOptions: ContainerListBlobsOptions = {
  prefix: 'my-path-prefix/',  // Optional: filter by virtual directory
  includeMetadata: false,
};

for await (const blob of containerClient.listBlobsFlat(listOptions)) {
  console.log(`Blob: ${blob.name}`);
  // blob.name = "folder1/file.txt"
  // blob.properties.lastModified = Date
  // blob.properties.etag = string
  // blob.properties.contentLength = number
}
```

#### Hierarchical Listing

Returns blobs organized by virtual directories. Requires recursive traversal. More complex but useful for UI display.

```typescript
for await (const response of containerClient
  .listBlobsByHierarchy('/', listOptions)
  .byPage({ maxPageSize: 100 })) {
  // response.segment.blobPrefixes = virtual directories
  // response.segment.blobItems = blobs at this level
}
```

**Recommendation:** Use **flat listing** with prefix for the sync operation. It is simpler, requires fewer API calls, and returns all blobs in a single pass.

**Source:** [List blobs with JavaScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-list-javascript)

### 2.4 Download Methods

| Method | Best For | Memory Usage | Parallelism | Node.js Only |
|---|---|---|---|---|
| `downloadToFile()` | Direct disk write | Minimal | No | Yes |
| `download()` + stream | Large files, low memory | Minimal | No | Yes |
| `downloadToBuffer()` | Throughput optimization | High (full blob in memory) | Yes (configurable) | Yes |

**Recommendation:** Use `downloadToFile()` as the primary method. It writes directly to disk, has minimal memory overhead, and is the simplest API. Fall back to streaming for files larger than a configurable threshold (e.g., 100MB).

```typescript
async function downloadBlobToFile(
  containerClient: ContainerClient,
  blobName: string,
  filePath: string
): Promise<void> {
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.downloadToFile(filePath);
}
```

**Source:** [Download a blob with JavaScript/TypeScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-download-javascript)

### 2.5 Conditional Downloads (Optimization)

The SDK supports conditional requests via `ModifiedAccessConditions`:

```typescript
const blobClient = containerClient.getBlobClient(blobName);
const properties = await blobClient.getProperties();

// Only download if modified since last sync
await blobClient.downloadToFile(filePath, 0, undefined, {
  conditions: {
    ifModifiedSince: lastSyncTimestamp
  }
});
```

This allows incremental sync without re-downloading unchanged files, using:
- `If-Modified-Since` header with `lastModified` timestamp
- `If-None-Match` header with `ETag` value
- `Content-MD5` for integrity verification

**Source:** [Manage concurrency in Blob Storage](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage) | [ModifiedAccessConditions](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/modifiedaccessconditions?view=azure-node-latest)

---

## 3. Environment Variable Management

### 3.1 dotenv Library

The `dotenv` library (46M+ weekly npm downloads) is the standard for `.env` file loading in Node.js.

**Key API:**

```typescript
import * as dotenv from 'dotenv';

// Load .env file (does NOT override existing env vars by default)
dotenv.config();

// Load with override (WILL override existing env vars)
dotenv.config({ override: true });

// Parse a string/buffer without modifying process.env
const parsed = dotenv.parse(Buffer.from('KEY=value'));

// Load from custom path
dotenv.config({ path: '/custom/path/.env' });
```

**Critical behavior:** By default, `dotenv.config()` does NOT override environment variables that are already set. The `override: true` option changes this behavior.

**Source:** [GitHub - motdotla/dotenv](https://github.com/motdotla/dotenv)

### 3.2 Native Node.js Support (v20.6+)

Node.js v20.6.0 introduced native `.env` file support:
- `--env-file=.env` CLI flag
- `process.loadEnvFile('.env')` function

This eliminates the need for the `dotenv` dependency but requires Node.js 20.6+.

**Source:** [You Don't Need dotenv Anymore](https://typescript.tv/best-practices/you-dont-need-dotenv-anymore/)

### 3.3 Proposed Precedence Model (Three-Tier)

The library should implement a clear, deterministic precedence model:

```
Priority (highest to lowest):
1. OS Environment Variables (already in process.env)
2. Remote .env from Azure Blob Storage (AZURE_VENV)
3. Local .env file (application root)
```

**Loading sequence:**

```
Step 1: Load local .env file (dotenv.config(), no override)
        -> This populates AZURE_VENV and AZURE_VENV_SAS_TOKEN if not already set
Step 2: Read AZURE_VENV and AZURE_VENV_SAS_TOKEN from process.env
Step 3: If both are present, connect to Azure Blob Storage
Step 4: Check if remote .env exists in blob storage
Step 5: If remote .env exists, download and parse it
Step 6: Apply remote .env values to process.env (override local .env values but NOT OS env vars)
Step 7: Download/sync all other files from blob storage to local root
```

**Rationale:** OS environment variables take highest priority (set by deployment platform, CI/CD, etc.). Remote `.env` overrides local `.env` because it represents centralized configuration. Local `.env` provides defaults and the bootstrap config (AZURE_VENV credentials).

**Source:** [Best Practices for Bootstrapping Node.js Configuration](https://lirantal.com/blog/best-practices-for-bootstrapping-a-node-js-application-configuration)

### 3.4 Type Safety with Zod

For configuration validation, combining dotenv with Zod provides compile-time type safety:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  AZURE_VENV: z.string().url().optional(),
  AZURE_VENV_SAS_TOKEN: z.string().min(1).optional(),
  AZURE_VENV_SAS_EXPIRY: z.string().datetime().optional(),
});

type EnvConfig = z.infer<typeof envSchema>;
```

---

## 4. Filesystem Sync Patterns

### 4.1 Directory Creation

Modern Node.js (v10.12+) supports recursive directory creation natively:

```typescript
import * as fs from 'fs';
import * as path from 'path';

// Create nested directories cross-platform
await fs.promises.mkdir(path.dirname(localFilePath), { recursive: true });
```

Always use `path.join()` and `path.dirname()` for cross-platform compatibility (handles `/` vs `\` on Windows vs Unix).

**Source:** [Node.js - Working with folders](https://nodejs.org/en/learn/manipulating-files/working-with-folders-in-nodejs)

### 4.2 Sync Algorithm

The recommended sync algorithm for downloading blob storage to local filesystem:

```
1. List all blobs in container (flat listing with prefix)
2. For each blob:
   a. Compute local file path: path.join(appRoot, blobName.replace(prefix, ''))
   b. Validate path (no traversal)
   c. Check if local file exists and compare timestamps/ETags
   d. If file needs update:
      i.  Create parent directories (recursive: true)
      ii. Download blob to local path
3. Optionally: Delete local files not present in blob storage (full mirror)
4. Record sync metadata (timestamps, ETags) for future incremental sync
```

### 4.3 Overwrite Strategies

| Strategy | Description | Use Case |
|---|---|---|
| **Always Overwrite** | Download every blob regardless | First sync, guaranteed consistency |
| **ETag-Based** | Compare stored ETag with blob ETag | Precise change detection |
| **Timestamp-Based** | Compare local file mtime with blob lastModified | Simple, good enough for most cases |
| **Content-MD5** | Compare MD5 hashes | High integrity requirement |
| **Skip if exists** | Only download missing files | Fastest, risk of stale files |

**Recommendation:** Use **ETag-based** comparison with a local manifest file (`.azure-venv-manifest.json`) that stores blob name, ETag, lastModified, and contentLength. On first run, use **Always Overwrite**. On subsequent runs, compare manifest entries.

### 4.4 Cross-Platform Path Handling

Critical considerations:
- Always use `path.join()` instead of string concatenation with `/`
- Use `path.resolve()` to get absolute paths
- Use `path.normalize()` as part of (but not sole) path validation
- Handle Windows long path names (> 260 chars) if needed
- Blob names use `/` as delimiter; convert to OS-specific separator with `path.join()`

---

## 5. Existing Solutions and Alternatives

### 5.1 BlobFuse2 (Microsoft)

**What:** OS-level virtual file system driver for Linux (FUSE-based).

| Aspect | Detail |
|---|---|
| Platform | Linux only |
| Type | Kernel-level mount |
| POSIX compliance | Partial (rename not atomic) |
| Node.js integration | Access via `fs` module on mounted path |
| Maintenance | Active; v1 EOL September 2026 |

**Why not suitable:** Linux-only, requires root/sudo for mount, not embeddable in a Node.js library, doesn't work in containerized environments without privileged access.

**Source:** [BlobFuse2](https://learn.microsoft.com/en-us/azure/storage/blobs/blobfuse2-what-is) | [GitHub](https://github.com/Azure/azure-storage-fuse)

### 5.2 rclone

**What:** Cross-platform CLI tool for cloud storage sync and mount.

| Aspect | Detail |
|---|---|
| Platform | Windows, Linux, macOS |
| Type | CLI tool (sync + mount) |
| Azure support | Yes (Azure Blob) |
| Node.js integration | Via `child_process` |

**Why not suitable:** External binary dependency, not embeddable as a library, requires separate installation.

**Source:** [rclone - Azure Blob](https://rclone.org/azureblob/)

### 5.3 AzCopy

**What:** Microsoft's CLI tool for data transfer to/from Azure Storage.

| Aspect | Detail |
|---|---|
| Platform | Windows, Linux, macOS |
| Type | CLI tool (copy/sync only) |
| Sync support | Yes (`azcopy sync`) |
| Node.js integration | Via `child_process` |

**Why not suitable:** Same as rclone - external binary, not embeddable.

**Source:** [AzCopy](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azcopy-v10)

### 5.4 azure-storage-fs (npm)

**What:** Node.js package providing `fs`-like API for Azure Blob Storage.

| Aspect | Detail |
|---|---|
| Last Updated | ~2018 (unmaintained) |
| SDK Version | Uses legacy `azure-storage` package |
| Block blob only | Yes |

**Why not suitable:** Unmaintained, uses deprecated SDK, provides virtual fs API (not sync-to-local).

**Source:** [npm - azure-storage-fs](https://www.npmjs.com/package/azure-storage-fs)

### 5.5 Custom SDK-Based Approach (Recommended)

Build a custom sync library using `@azure/storage-blob` SDK directly. This provides:
- Full control over sync logic and behavior
- No external binary dependencies
- Cross-platform by nature (Node.js)
- TypeScript-native with full type safety
- Embeddable as an npm package

---

## 6. Comparison Matrix

| Criteria | BlobFuse2 | rclone | AzCopy | azure-storage-fs | Custom SDK |
|---|---|---|---|---|---|
| **Embeddable in Node.js** | No | No | No | Yes | Yes |
| **Cross-platform** | Linux only | Yes | Yes | Yes | Yes |
| **TypeScript native** | No | No | No | No | Yes |
| **Active maintenance** | Yes | Yes | Yes | No | Self-maintained |
| **No external deps** | No (FUSE) | No (binary) | No (binary) | Yes | Yes |
| **SAS token support** | Yes | Yes | Yes | Partial | Yes |
| **Incremental sync** | Cache-based | Yes | Yes | No | Custom (ETag) |
| **Virtual folder** | OS mount | OS mount | Copy only | API only | Download to local |
| **Startup integration** | Manual | Manual | Manual | Manual | Native |
| **Env var loading** | No | No | No | No | Custom |
| **Production ready** | Yes | Yes | Yes | No | Needs testing |

**Winner: Custom SDK approach** - Only option that satisfies all requirements (embeddable, cross-platform, TypeScript-native, no external binaries, env var integration).

---

## 7. Recommended Approach

### 7.1 Architecture Overview

Build a TypeScript library with the following components:

```
azure-venv/
  src/
    index.ts              # Main entry point / bootstrap function
    config.ts             # Configuration validation (Zod)
    blob-client.ts        # Azure Blob Storage client wrapper
    sync-engine.ts        # File sync logic
    env-loader.ts         # Environment variable loading (3-tier)
    path-validator.ts     # Path traversal prevention
    manifest.ts           # Sync manifest (ETags, timestamps)
    logger.ts             # Logging (with SAS token sanitization)
    types.ts              # TypeScript interfaces
```

### 7.2 Bootstrap Flow

```typescript
import { initAzureVenv } from 'azure-venv';

// Call at application startup, BEFORE other imports
await initAzureVenv({
  rootDir: process.cwd(),        // Target directory for synced files
  envPath: '.env',               // Local .env file path
  manifestPath: '.azure-venv-manifest.json',
  overwriteStrategy: 'etag',    // 'always' | 'etag' | 'timestamp'
  concurrency: 5,               // Parallel downloads
  timeout: 30000,               // Per-blob download timeout
  retries: 3,                   // Retry count per blob
});
```

### 7.3 Key Design Decisions

1. **Async-first**: The entire bootstrap is async. The host application must `await` initialization before proceeding.

2. **Flat listing with prefix stripping**: If `AZURE_VENV` points to `https://account.blob.core.windows.net/mycontainer/config/prod/`, blobs listed with prefix `config/prod/` have the prefix stripped when mapped to local paths.

3. **Remote .env priority processing**: The remote `.env` is downloaded and loaded BEFORE other files, ensuring environment variables are available for the rest of the application.

4. **Manifest-based incremental sync**: A JSON manifest file records the ETag and lastModified for each synced blob. On subsequent runs, only changed blobs are downloaded.

5. **Graceful degradation**: If Azure is unreachable, the library logs a warning and continues with local files (fail-open or fail-closed is configurable).

6. **No file deletion by default**: The library only downloads/updates files. It does not delete local files that no longer exist in blob storage unless explicitly configured (`deleteOrphans: true`).

### 7.4 Dependencies

| Package | Purpose | Version |
|---|---|---|
| `@azure/storage-blob` | Azure Blob Storage SDK | ^12.31.0 |
| `dotenv` | `.env` file parsing | ^16.x |
| `zod` | Configuration validation | ^3.x |

**Note:** For Node.js 20.6+, `dotenv` can be replaced with native `process.loadEnvFile()`.

---

## 8. Security Considerations

### 8.1 SAS Token Security

| Risk | Mitigation |
|---|---|
| Token in logs | Sanitize all URLs before logging; replace SAS query params with `[REDACTED]` |
| Token in source control | Never commit `.env` files; use `.gitignore` |
| Token expiration | Parse `se` parameter from SAS to detect expiration proactively; add `AZURE_VENV_SAS_EXPIRY` config parameter |
| Over-permissive token | Require only `r` (read) and `l` (list) permissions; document minimum required permissions |
| Token interception | Enforce HTTPS only; validate URL scheme |
| Token in error messages | Sanitize `RestError` details before propagation |

**SAS URL Sanitization:**

```typescript
function sanitizeSasUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '[SAS_REDACTED]';
    return parsed.toString();
  } catch {
    return '[INVALID_URL]';
  }
}
```

**SAS Expiry Detection:**

```typescript
function parseSasExpiry(sasToken: string): Date | null {
  const params = new URLSearchParams(sasToken);
  const se = params.get('se');
  return se ? new Date(se) : null;
}

function isSasExpired(sasToken: string): boolean {
  const expiry = parseSasExpiry(sasToken);
  if (!expiry) return false;  // Cannot determine; assume valid
  return expiry.getTime() < Date.now();
}
```

**Source:** [Azure SAS Token Security Best Practices](https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview#best-practices-when-using-sas) | [Microsoft SAS Token Incident (2023)](https://msrc.microsoft.com/blog/2023/09/microsoft-mitigated-exposure-of-internal-information-in-a-storage-account-due-to-overly-permissive-sas-token/)

### 8.2 Path Traversal Prevention

Blob names can contain `../` sequences that could write files outside the intended directory.

**Two-layer defense:**

```typescript
import * as path from 'path';

function validateAndResolvePath(rootDir: string, blobName: string): string {
  // Layer 1: Reject obviously malicious names
  const decodedName = decodeURIComponent(blobName);
  if (decodedName.includes('..') || path.isAbsolute(decodedName)) {
    throw new Error(`Path traversal detected in blob name: ${blobName}`);
  }

  // Layer 2: Resolve and verify containment
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(rootDir, decodedName);

  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    throw new Error(`Path traversal detected: resolved path escapes root directory`);
  }

  return resolvedPath;
}
```

**Source:** [Node.js Path Traversal Guide](https://www.stackhawk.com/blog/node-js-path-traversal-guide-examples-and-prevention/) | [Google Cloud Storage path containment fix](https://github.com/googleapis/nodejs-storage/commit/08d7abf32dd365b24ce34c66174be06c30bfce8f)

### 8.3 Additional Security Measures

- **Never log `AZURE_VENV_SAS_TOKEN` value** - mask in all log output
- **Validate HTTPS scheme** - reject `http://` URLs for blob storage
- **File permission restrictions** - set downloaded files to 0644 (read-only for others)
- **Manifest file integrity** - consider signing the manifest to prevent tampering
- **Rate limiting** - implement backoff on Azure API errors to prevent accidental DoS

---

## 9. Error Handling and Resilience

### 9.1 Azure Unreachable

When Azure Blob Storage is unreachable (network failure, DNS resolution failure):

```typescript
try {
  await syncFromAzure(config);
} catch (error) {
  if (error instanceof RestError) {
    if (error.code === 'REQUEST_SEND_ERROR' || error.code === 'ETIMEDOUT') {
      logger.warn('Azure Blob Storage unreachable. Using local files only.');
      if (config.failOnUnreachable) {
        throw new AzureVenvError('Azure unreachable and failOnUnreachable is enabled');
      }
    }
  }
}
```

**Configurable behavior:**
- `failOnUnreachable: true` - Throw error, prevent app startup (strict mode)
- `failOnUnreachable: false` - Log warning, continue with local files (resilient mode)

### 9.2 SAS Token Expiration

The SDK throws `RestError` with `statusCode: 403` when a SAS token is expired or invalid:

```typescript
if (error instanceof RestError && error.statusCode === 403) {
  const errorCode = error.details?.errorCode;
  if (errorCode === 'AuthenticationFailed' || errorCode === 'AuthorizationFailure') {
    // Check if token is expired
    const expiry = parseSasExpiry(sasToken);
    if (expiry && expiry < new Date()) {
      throw new AzureVenvError(
        `SAS token expired at ${expiry.toISOString()}. Please renew AZURE_VENV_SAS_TOKEN.`
      );
    }
    throw new AzureVenvError('SAS token authentication failed. Check permissions and validity.');
  }
}
```

**Source:** [Troubleshoot 403 Errors (Azure Blob Storage)](https://learn.microsoft.com/en-us/troubleshoot/azure/azure-storage/blobs/authentication/storage-troubleshoot-403-errors) | [SAS Error Codes](https://learn.microsoft.com/en-us/rest/api/storageservices/sas-error-codes)

### 9.3 Partial Sync Recovery

If sync fails midway (e.g., one blob out of 100 fails to download):

1. **Manifest tracking**: Write manifest entries only for successfully synced blobs
2. **Retry with backoff**: Retry failed blobs up to N times with exponential backoff
3. **Continue on individual failure**: Log the error and continue syncing remaining blobs
4. **Final status report**: Report how many blobs succeeded/failed at the end

```typescript
interface SyncResult {
  totalBlobs: number;
  downloaded: number;
  skipped: number;     // Already up-to-date
  failed: number;
  failedBlobs: string[];
  duration: number;    // milliseconds
}
```

### 9.4 Retry Strategy

```typescript
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000,    // 1 second
  maxDelay: 30000,       // 30 seconds
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
```

The `@azure/storage-blob` SDK has built-in retry policies. Configure via `StoragePipelineOptions`:

```typescript
const pipeline = newPipeline(new AnonymousCredential(), {
  retryOptions: {
    maxTries: 3,
    tryTimeoutInMs: 30000,
    retryDelayInMs: 1000,
    maxRetryDelayInMs: 30000,
  },
});
```

---

## 10. AZURE_VENV URL Format Design

### 10.1 Recommended Format

The `AZURE_VENV` variable should contain a container URL with an optional virtual directory prefix:

```
AZURE_VENV=https://<account>.blob.core.windows.net/<container>[/<virtual-directory-prefix>]
AZURE_VENV_SAS_TOKEN=sv=2025-01-05&se=2026-03-01T00:00:00Z&sp=rl&sr=c&sig=...
```

**Examples:**

```bash
# Sync entire container
AZURE_VENV=https://myaccount.blob.core.windows.net/mycontainer

# Sync a specific virtual directory
AZURE_VENV=https://myaccount.blob.core.windows.net/mycontainer/config/production

# SAS token (note: no leading '?')
AZURE_VENV_SAS_TOKEN=sv=2025-01-05&se=2026-06-01T00:00:00Z&sp=rl&sr=c&sig=abc123...
```

### 10.2 URL Parsing

```typescript
interface AzureVenvConfig {
  accountUrl: string;       // https://myaccount.blob.core.windows.net
  containerName: string;    // mycontainer
  prefix: string;           // config/production/ (with trailing slash)
  sasToken: string;         // The full SAS query string
}

function parseAzureVenvUrl(url: string): Omit<AzureVenvConfig, 'sasToken'> {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (pathParts.length === 0) {
    throw new Error('AZURE_VENV must include a container name');
  }

  const containerName = pathParts[0];
  const prefix = pathParts.length > 1
    ? pathParts.slice(1).join('/') + '/'
    : '';

  return {
    accountUrl: `${parsed.protocol}//${parsed.host}`,
    containerName,
    prefix,
  };
}
```

### 10.3 Additional Configuration Parameters

| Variable | Required | Description |
|---|---|---|
| `AZURE_VENV` | Yes | Azure Blob Storage container URL with optional prefix |
| `AZURE_VENV_SAS_TOKEN` | Yes | SAS token (without leading `?`) |
| `AZURE_VENV_SAS_EXPIRY` | Recommended | ISO 8601 date for proactive expiry warning |
| `AZURE_VENV_SYNC_MODE` | No | `full` (default) or `incremental` |
| `AZURE_VENV_FAIL_ON_ERROR` | No | `true` or `false` (default: `false`) |
| `AZURE_VENV_CONCURRENCY` | No | Number of parallel downloads (default: `5`) |
| `AZURE_VENV_TIMEOUT` | No | Per-blob download timeout in ms (default: `30000`) |
| `AZURE_VENV_LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |

---

## 11. Technical Architecture Outline

### 11.1 Component Diagram

```
+------------------+
|   Host App       |
|   (startup)      |
+--------+---------+
         |
         v
+--------+---------+
|  azure-venv      |
|  initAzureVenv() |
+--------+---------+
         |
    +----+----+
    |         |
    v         v
+---+---+ +---+----+
| Env   | | Sync   |
| Loader| | Engine |
+---+---+ +---+----+
    |         |
    v         v
+---+---+ +---+----+
| dotenv| | Azure  |
| parse | | Blob   |
+-------+ | SDK    |
          +---+----+
              |
              v
         +----+----+
         | Azure   |
         | Blob    |
         | Storage |
         +---------+
```

### 11.2 Sequence Diagram (Startup)

```
Host App          azure-venv        dotenv         Azure Blob Storage
   |                  |               |                    |
   |--initAzureVenv-->|               |                    |
   |                  |--config()---->|                    |
   |                  |<--parsed------|                    |
   |                  |                                    |
   |                  |  [Check AZURE_VENV in process.env] |
   |                  |                                    |
   |                  |-------listBlobsFlat(.env)--------->|
   |                  |<-------.env blob content-----------|
   |                  |                                    |
   |                  |  [Parse remote .env, apply to      |
   |                  |   process.env with precedence]     |
   |                  |                                    |
   |                  |-------listBlobsFlat(prefix)------->|
   |                  |<------blob list--------------------|
   |                  |                                    |
   |                  |  [For each blob:]                  |
   |                  |-------downloadToFile()------------>|
   |                  |<------file content-----------------|
   |                  |                                    |
   |                  |  [Write manifest]                  |
   |                  |                                    |
   |<--SyncResult-----|                                    |
   |                  |                                    |
```

### 11.3 Performance Considerations

- **Parallel downloads**: Use `Promise.allSettled` with concurrency limit (e.g., p-limit or custom semaphore) for parallel blob downloads
- **Pagination**: Handle `listBlobsFlat` pagination for containers with > 5000 blobs
- **Streaming for large files**: Auto-switch to stream-based download for blobs exceeding a size threshold
- **Connection pooling**: The SDK uses HTTP keep-alive by default; no extra configuration needed

---

## 12. References

### Official Microsoft Documentation
- [Azure Blob Storage client library for JavaScript - API Reference](https://learn.microsoft.com/en-us/javascript/api/overview/azure/storage-blob-readme?view=azure-node-latest)
- [Get started with Azure Blob Storage and JavaScript/TypeScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-javascript-get-started)
- [List blobs with JavaScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-list-javascript)
- [Download a blob with JavaScript/TypeScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-download-javascript)
- [Grant limited access with SAS](https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview)
- [Create a service SAS with JavaScript](https://learn.microsoft.com/en-us/azure/storage/blobs/sas-service-create-javascript)
- [Create an account SAS with JavaScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-account-delegation-sas-create-javascript)
- [Performance tuning for uploads/downloads (JavaScript)](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-tune-upload-download-javascript)
- [Troubleshoot 403 Errors (Azure Blob Storage)](https://learn.microsoft.com/en-us/troubleshoot/azure/azure-storage/blobs/authentication/storage-troubleshoot-403-errors)
- [SAS Error Codes](https://learn.microsoft.com/en-us/rest/api/storageservices/sas-error-codes)
- [SAS Expiration Policy](https://learn.microsoft.com/en-us/azure/storage/common/sas-expiration-policy)
- [Manage concurrency in Blob Storage](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage)
- [ModifiedAccessConditions interface](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/modifiedaccessconditions?view=azure-node-latest)
- [ContainerClient class](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/containerclient?view=azure-node-latest)
- [BlobFuse2 - What is it?](https://learn.microsoft.com/en-us/azure/storage/blobs/blobfuse2-what-is)

### npm Packages
- [@azure/storage-blob (npm)](https://www.npmjs.com/package/@azure/storage-blob) - v12.31.0
- [@azure/storage-blob Changelog (GitHub)](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/storage/storage-blob/CHANGELOG.md)
- [dotenv (GitHub)](https://github.com/motdotla/dotenv)
- [azure-storage-fs (npm)](https://www.npmjs.com/package/azure-storage-fs) - Unmaintained

### Security Resources
- [Azure SAS Token Security - BigID](https://bigid.com/blog/understanding-azure-sas-tokens/)
- [Understanding Risks of Azure SAS Tokens - Cyera](https://www.cyera.com/blog/understanding-the-risks-of-azure-sas-tokens)
- [Best Practices to Prevent SAS Security Risks - AdminDroid](https://blog.admindroid.com/best-practices-to-prevent-security-risks-in-azure-shared-access-signatures/)
- [Microsoft SAS Token Incident (2023)](https://msrc.microsoft.com/blog/2023/09/microsoft-mitigated-exposure-of-internal-information-in-a-storage-account-due-to-overly-permissive-sas-token/)
- [Node.js Path Traversal Prevention - StackHawk](https://www.stackhawk.com/blog/node-js-path-traversal-guide-examples-and-prevention/)
- [Secure Coding Practices - Node.js Security](https://www.nodejs-security.com/blog/secure-coding-practices-nodejs-path-traversal-vulnerabilities)
- [Google Cloud Storage path containment fix](https://github.com/googleapis/nodejs-storage/commit/08d7abf32dd365b24ce34c66174be06c30bfce8f)

### Best Practices and Patterns
- [Best Practices for Bootstrapping Node.js Configuration](https://lirantal.com/blog/best-practices-for-bootstrapping-a-node-js-application-configuration)
- [Node.js Best Practices (GitHub)](https://github.com/goldbergyoni/nodebestpractices)
- [You Don't Need dotenv Anymore](https://typescript.tv/best-practices/you-dont-need-dotenv-anymore/)
- [@azure/storage-blob NPM Guide (2025)](https://generalistprogrammer.com/tutorials/azure-storage-blob-npm-package-guide)

### Alternative Tools
- [rclone - Azure Blob](https://rclone.org/azureblob/)
- [BlobFuse (GitHub)](https://github.com/Azure/azure-storage-fuse)
- [Azure SAS Token Guidelines - Mark Heath](https://markheath.net/post/azure-blob-sas-guidelines)
