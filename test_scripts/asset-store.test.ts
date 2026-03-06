import { describe, it, expect, beforeEach } from 'vitest';
import { AssetStore } from '../src/assets/asset-store.js';
import type { SyncResult, BlobContent } from '../src/types/index.js';

function makeBlob(overrides: Partial<BlobContent> = {}): BlobContent {
  return {
    blobName: 'prefix/file.txt',
    relativePath: 'file.txt',
    content: Buffer.from('default content'),
    size: 15,
    etag: '"etag"',
    lastModified: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSyncResult(blobs: BlobContent[] = []): SyncResult {
  return {
    attempted: true,
    totalBlobs: blobs.length,
    downloaded: blobs.length,
    failed: 0,
    failedBlobs: [],
    duration: 100,
    remoteEnvLoaded: false,
    envSources: {},
    blobs,
    fileTree: [],
    envDetails: { variables: {}, sources: {}, localKeys: [], remoteKeys: [], osKeys: [] },
  };
}

const testBlobs: BlobContent[] = [
  makeBlob({
    blobName: 'container/config/app.json',
    relativePath: 'config/app.json',
    content: Buffer.from(JSON.stringify({ name: 'test-app', version: '1.0' })),
    sourceRegistry: 'github.com/org/repo',
    sourcePath: 'config/app.json',
  }),
  makeBlob({
    blobName: 'container/config/agents.yaml',
    relativePath: 'config/agents.yaml',
    content: Buffer.from('agents:\n  - name: agent1\n    url: http://localhost:3000'),
    sourceRegistry: 'github.com/org/repo',
    sourcePath: 'config/agents.yaml',
  }),
  makeBlob({
    blobName: 'container/prompts/greeting.md',
    relativePath: 'prompts/greeting.md',
    content: Buffer.from('# Hello\nYou are a helpful assistant.'),
    sourceRegistry: 'github.com/org/repo',
    sourcePath: 'prompts/greeting.md',
  }),
  makeBlob({
    blobName: 'container/other/file.txt',
    relativePath: 'other/file.txt',
    content: Buffer.from('other registry content'),
    sourceRegistry: 'azure-devops/project/repo',
    sourcePath: 'other/file.txt',
  }),
  makeBlob({
    blobName: 'container/no-metadata.txt',
    relativePath: 'no-metadata.txt',
    content: Buffer.from('no metadata'),
  }),
];

describe('AssetStore', () => {
  let store: AssetStore;

  beforeEach(() => {
    store = new AssetStore(makeSyncResult(testBlobs), {
      registry: 'github.com/org/repo',
    });
  });

  // -------------------------------------------------------
  // Availability and counts
  // -------------------------------------------------------
  it('isAvailable returns true when blobs exist', () => {
    expect(store.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no blobs', () => {
    const empty = new AssetStore(makeSyncResult([]), { registry: 'reg' });
    expect(empty.isAvailable()).toBe(false);
  });

  it('blobCount returns the number of blobs', () => {
    expect(store.blobCount).toBe(5);
  });

  it('defaultRegistry returns the configured registry', () => {
    expect(store.defaultRegistry).toBe('github.com/org/repo');
  });

  // -------------------------------------------------------
  // getAsset (short key with registry auto-append)
  // -------------------------------------------------------
  it('getAsset retrieves by short key (auto-appends registry)', () => {
    const content = store.getAsset('config/agents.yaml');
    expect(content).toContain('agents:');
  });

  it('getAsset retrieves by full expression', () => {
    const content = store.getAsset('other/file.txt@azure-devops/project/repo');
    expect(content).toBe('other registry content');
  });

  it('getAsset throws for non-existent asset', () => {
    expect(() => store.getAsset('nonexistent/path')).toThrow('Asset not found');
  });

  // -------------------------------------------------------
  // getRawAsset
  // -------------------------------------------------------
  it('getRawAsset returns a Buffer', () => {
    const buf = store.getRawAsset('config/app.json');
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('getRawAsset throws for non-existent asset', () => {
    expect(() => store.getRawAsset('nope')).toThrow('Asset not found');
  });

  // -------------------------------------------------------
  // getJsonAsset
  // -------------------------------------------------------
  it('getJsonAsset parses JSON and returns typed object', () => {
    const data = store.getJsonAsset<{ name: string; version: string }>('config/app.json');
    expect(data.name).toBe('test-app');
    expect(data.version).toBe('1.0');
  });

  it('getJsonAsset throws on invalid JSON', () => {
    expect(() => store.getJsonAsset('config/agents.yaml')).toThrow();
  });

  // -------------------------------------------------------
  // findAsset and hasAsset
  // -------------------------------------------------------
  it('findAsset returns BlobContent for existing asset', () => {
    const blob = store.findAsset('prompts/greeting.md');
    expect(blob).toBeDefined();
    expect(blob!.relativePath).toBe('prompts/greeting.md');
  });

  it('findAsset returns undefined for missing asset', () => {
    expect(store.findAsset('missing')).toBeUndefined();
  });

  it('hasAsset returns true for existing asset', () => {
    expect(store.hasAsset('config/app.json')).toBe(true);
  });

  it('hasAsset returns false for missing asset', () => {
    expect(store.hasAsset('missing')).toBe(false);
  });

  // -------------------------------------------------------
  // listAssets
  // -------------------------------------------------------
  it('listAssets returns source expressions for blobs with metadata', () => {
    const assets = store.listAssets();
    expect(assets).toContain('config/app.json@github.com/org/repo');
    expect(assets).toContain('config/agents.yaml@github.com/org/repo');
    expect(assets).toContain('other/file.txt@azure-devops/project/repo');
    // The no-metadata blob should not appear
    expect(assets).toHaveLength(4);
  });

  // -------------------------------------------------------
  // Caching
  // -------------------------------------------------------
  it('does not cache when cacheTTL is 0 (default)', () => {
    const content1 = store.getAsset('config/app.json');
    const content2 = store.getAsset('config/app.json');
    expect(content1).toBe(content2);
    // Both calls should work, no cache involved
  });

  it('caches when cacheTTL > 0', () => {
    const cached = new AssetStore(makeSyncResult(testBlobs), {
      registry: 'github.com/org/repo',
      cacheTTL: 60000,
    });

    const content1 = cached.getAsset('config/app.json');
    const content2 = cached.getAsset('config/app.json');
    expect(content1).toBe(content2);
  });

  it('clearCache clears the internal cache', () => {
    const cached = new AssetStore(makeSyncResult(testBlobs), {
      registry: 'github.com/org/repo',
      cacheTTL: 60000,
    });

    cached.getAsset('config/app.json');
    cached.clearCache();
    // Should still work after clearing (re-reads from blobs)
    const content = cached.getAsset('config/app.json');
    expect(content).toContain('test-app');
  });

  // -------------------------------------------------------
  // refresh
  // -------------------------------------------------------
  it('refresh throws when store was not created via initAssetStore', async () => {
    await expect(store.refresh()).rejects.toThrow('only available on stores created via initAssetStore');
  });
});
