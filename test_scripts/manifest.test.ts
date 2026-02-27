import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ManifestManager } from '../src/sync/manifest.js';
import type { Logger } from '../src/logging/logger.js';
import type { SyncManifest, ManifestEntry } from '../src/types/index.js';
import type { BlobInfo } from '../src/azure/types.js';

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('ManifestManager', () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
    logger = createMockLogger();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('load()', () => {
    it('should return empty manifest when file does not exist', async () => {
      const manifestPath = path.join(tmpDir, 'nonexistent.json');
      const manager = new ManifestManager(manifestPath, logger);

      const result = await manager.load();

      expect(result.version).toBe(1);
      expect(result.lastSyncAt).toBe('');
      expect(result.entries).toEqual({});
    });

    it('should return parsed manifest when file is valid', async () => {
      const manifestPath = path.join(tmpDir, 'manifest.json');
      const manifest: SyncManifest = {
        version: 1,
        lastSyncAt: '2024-01-01T00:00:00.000Z',
        entries: {
          'blob1.txt': {
            blobName: 'blob1.txt',
            etag: '"abc123"',
            lastModified: '2024-01-01T00:00:00.000Z',
            contentLength: 100,
            localPath: 'blob1.txt',
            syncedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

      const manager = new ManifestManager(manifestPath, logger);
      const result = await manager.load();

      expect(result.version).toBe(1);
      expect(result.entries['blob1.txt'].etag).toBe('"abc123"');
    });

    it('should return empty manifest when file contains invalid JSON', async () => {
      const manifestPath = path.join(tmpDir, 'bad.json');
      await fs.writeFile(manifestPath, '{not valid json!!!', 'utf-8');

      const manager = new ManifestManager(manifestPath, logger);
      const result = await manager.load();

      expect(result.version).toBe(1);
      expect(result.lastSyncAt).toBe('');
      expect(result.entries).toEqual({});
    });
  });

  describe('save()', () => {
    it('should write formatted JSON to disk', async () => {
      const manifestPath = path.join(tmpDir, 'output.json');
      const manager = new ManifestManager(manifestPath, logger);

      const manifest: SyncManifest = {
        version: 1,
        lastSyncAt: '',
        entries: {
          'test.txt': {
            blobName: 'test.txt',
            etag: '"etag1"',
            lastModified: '2024-01-01T00:00:00.000Z',
            contentLength: 50,
            localPath: 'test.txt',
            syncedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };

      await manager.save(manifest);

      const content = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(content) as SyncManifest;

      expect(parsed.version).toBe(1);
      expect(parsed.lastSyncAt).not.toBe('');
      expect(parsed.entries['test.txt'].etag).toBe('"etag1"');
      // Verify it's formatted with indentation
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });
  });

  describe('needsUpdate()', () => {
    it('should return true when entry is missing from manifest', () => {
      const manager = new ManifestManager('/tmp/test.json', logger);
      const blobInfo: BlobInfo = {
        name: 'new-blob.txt',
        etag: '"etag1"',
        lastModified: new Date(),
        contentLength: 100,
        contentMD5: undefined,
      };
      const manifest: SyncManifest = {
        version: 1,
        lastSyncAt: '',
        entries: {},
      };

      expect(manager.needsUpdate(blobInfo, manifest)).toBe(true);
    });

    it('should return false when ETag matches', () => {
      const manager = new ManifestManager('/tmp/test.json', logger);
      const blobInfo: BlobInfo = {
        name: 'existing.txt',
        etag: '"etag1"',
        lastModified: new Date(),
        contentLength: 100,
        contentMD5: undefined,
      };
      const manifest: SyncManifest = {
        version: 1,
        lastSyncAt: '',
        entries: {
          'existing.txt': {
            blobName: 'existing.txt',
            etag: '"etag1"',
            lastModified: '2024-01-01T00:00:00.000Z',
            contentLength: 100,
            localPath: 'existing.txt',
            syncedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };

      expect(manager.needsUpdate(blobInfo, manifest)).toBe(false);
    });

    it('should return true when ETag differs', () => {
      const manager = new ManifestManager('/tmp/test.json', logger);
      const blobInfo: BlobInfo = {
        name: 'changed.txt',
        etag: '"etag-new"',
        lastModified: new Date(),
        contentLength: 200,
        contentMD5: undefined,
      };
      const manifest: SyncManifest = {
        version: 1,
        lastSyncAt: '',
        entries: {
          'changed.txt': {
            blobName: 'changed.txt',
            etag: '"etag-old"',
            lastModified: '2024-01-01T00:00:00.000Z',
            contentLength: 100,
            localPath: 'changed.txt',
            syncedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };

      expect(manager.needsUpdate(blobInfo, manifest)).toBe(true);
    });
  });

  describe('createEntry()', () => {
    it('should create a correct ManifestEntry', () => {
      const manager = new ManifestManager('/tmp/test.json', logger);
      const now = new Date('2024-06-15T12:00:00.000Z');
      const blobInfo: BlobInfo = {
        name: 'prefix/file.txt',
        etag: '"etag-abc"',
        lastModified: now,
        contentLength: 512,
        contentMD5: undefined,
      };

      const entry = manager.createEntry(blobInfo, 'file.txt');

      expect(entry.blobName).toBe('prefix/file.txt');
      expect(entry.etag).toBe('"etag-abc"');
      expect(entry.lastModified).toBe('2024-06-15T12:00:00.000Z');
      expect(entry.contentLength).toBe(512);
      expect(entry.localPath).toBe('file.txt');
      expect(entry.syncedAt).toBeTruthy();
      // syncedAt should be a valid ISO string
      expect(() => new Date(entry.syncedAt)).not.toThrow();
    });
  });
});
