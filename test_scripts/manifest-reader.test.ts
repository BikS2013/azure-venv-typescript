import { describe, it, expect } from 'vitest';
import { manifestToSyncedFiles } from '../src/introspection/manifest-reader.js';
import type { SyncManifest } from '../src/types/index.js';

describe('manifestToSyncedFiles', () => {
  it('returns empty array for empty manifest', () => {
    const manifest: SyncManifest = {
      version: 1,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      entries: {},
    };

    const result = manifestToSyncedFiles(manifest);
    expect(result).toEqual([]);
  });

  it('maps ManifestEntry fields to SyncedFileInfo correctly', () => {
    const manifest: SyncManifest = {
      version: 1,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      entries: {
        'prefix/config.json': {
          blobName: 'prefix/config.json',
          etag: '"abc123"',
          lastModified: '2026-01-01T12:00:00.000Z',
          contentLength: 1024,
          localPath: 'config.json',
          syncedAt: '2026-01-01T12:00:01.000Z',
        },
      },
    };

    const result = manifestToSyncedFiles(manifest);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      localPath: 'config.json',
      blobName: 'prefix/config.json',
      size: 1024,
      lastModified: '2026-01-01T12:00:00.000Z',
      etag: '"abc123"',
    });
  });

  it('excludes syncedAt from output (internal bookkeeping)', () => {
    const manifest: SyncManifest = {
      version: 1,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      entries: {
        'blob1': {
          blobName: 'blob1',
          etag: '"e1"',
          lastModified: '2026-01-01T00:00:00.000Z',
          contentLength: 100,
          localPath: 'file1.txt',
          syncedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    };

    const result = manifestToSyncedFiles(manifest);
    expect(result[0]).not.toHaveProperty('syncedAt');
  });

  it('sorts output alphabetically by localPath', () => {
    const manifest: SyncManifest = {
      version: 1,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      entries: {
        'blob-z': {
          blobName: 'blob-z',
          etag: '"e1"',
          lastModified: '2026-01-01T00:00:00.000Z',
          contentLength: 100,
          localPath: 'z-file.txt',
          syncedAt: '2026-01-01T00:00:01.000Z',
        },
        'blob-a': {
          blobName: 'blob-a',
          etag: '"e2"',
          lastModified: '2026-01-01T00:00:00.000Z',
          contentLength: 200,
          localPath: 'a-file.txt',
          syncedAt: '2026-01-01T00:00:01.000Z',
        },
        'blob-m': {
          blobName: 'blob-m',
          etag: '"e3"',
          lastModified: '2026-01-01T00:00:00.000Z',
          contentLength: 300,
          localPath: 'dir/m-file.txt',
          syncedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    };

    const result = manifestToSyncedFiles(manifest);
    expect(result.map((f) => f.localPath)).toEqual([
      'a-file.txt',
      'dir/m-file.txt',
      'z-file.txt',
    ]);
  });

  it('normalizes backslash paths to forward slashes', () => {
    const manifest: SyncManifest = {
      version: 1,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      entries: {
        'blob1': {
          blobName: 'blob1',
          etag: '"e1"',
          lastModified: '2026-01-01T00:00:00.000Z',
          contentLength: 100,
          localPath: 'subdir\\nested\\file.txt',
          syncedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    };

    const result = manifestToSyncedFiles(manifest);
    expect(result[0].localPath).toBe('subdir/nested/file.txt');
  });

  it('maps contentLength to size field', () => {
    const manifest: SyncManifest = {
      version: 1,
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      entries: {
        'blob1': {
          blobName: 'blob1',
          etag: '"e1"',
          lastModified: '2026-01-01T00:00:00.000Z',
          contentLength: 52428800,
          localPath: 'large-file.bin',
          syncedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    };

    const result = manifestToSyncedFiles(manifest);
    expect(result[0].size).toBe(52428800);
  });
});
