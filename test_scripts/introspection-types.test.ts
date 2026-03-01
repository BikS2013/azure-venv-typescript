import { describe, it, expect } from 'vitest';
import { NO_OP_SYNC_RESULT } from '../src/types/index.js';
import type { SyncResult, BlobContent, FileTreeNode, EnvDetails } from '../src/types/index.js';

describe('Introspection types on SyncResult', () => {
  it('NO_OP_SYNC_RESULT includes empty introspection fields', () => {
    expect(NO_OP_SYNC_RESULT.blobs).toEqual([]);
    expect(NO_OP_SYNC_RESULT.fileTree).toEqual([]);
    expect(NO_OP_SYNC_RESULT.envDetails).toEqual({
      variables: {},
      sources: {},
      localKeys: [],
      remoteKeys: [],
      osKeys: [],
    });
  });

  it('NO_OP_SYNC_RESULT does not have skipped field', () => {
    expect(NO_OP_SYNC_RESULT).not.toHaveProperty('skipped');
  });

  it('BlobContent has all expected fields', () => {
    const blob: BlobContent = {
      blobName: 'prefix/config.json',
      relativePath: 'config.json',
      content: Buffer.from('{}'),
      size: 2,
      etag: '"abc"',
      lastModified: '2026-01-01T00:00:00.000Z',
    };

    expect(blob.blobName).toBe('prefix/config.json');
    expect(blob.relativePath).toBe('config.json');
    expect(blob.content).toBeInstanceOf(Buffer);
    expect(blob.size).toBe(2);
    expect(blob.etag).toBe('"abc"');
    expect(blob.lastModified).toBe('2026-01-01T00:00:00.000Z');
  });

  it('FileTreeNode directory has children', () => {
    const dir: FileTreeNode = {
      name: 'src',
      type: 'directory',
      path: 'src',
      children: [
        {
          name: 'index.ts',
          type: 'file',
          path: 'src/index.ts',
          size: 512,
          blobName: 'prefix/src/index.ts',
        },
      ],
    };

    expect(dir.type).toBe('directory');
    expect(dir.children).toHaveLength(1);
    expect(dir.children![0].type).toBe('file');
    expect(dir.children![0].size).toBe(512);
  });

  it('FileTreeNode file has no children', () => {
    const file: FileTreeNode = {
      name: 'app.json',
      type: 'file',
      path: 'app.json',
      size: 256,
      blobName: 'prefix/app.json',
    };

    expect(file.children).toBeUndefined();
  });

  it('EnvDetails has all tier keys', () => {
    const details: EnvDetails = {
      variables: { DB_HOST: 'localhost', API_KEY: 'secret' },
      sources: { DB_HOST: 'local', API_KEY: 'remote' },
      localKeys: ['DB_HOST'],
      remoteKeys: ['API_KEY'],
      osKeys: [],
    };

    expect(Object.keys(details.variables)).toHaveLength(2);
    expect(details.sources['DB_HOST']).toBe('local');
    expect(details.localKeys).toContain('DB_HOST');
    expect(details.remoteKeys).toContain('API_KEY');
    expect(details.osKeys).toHaveLength(0);
  });

  it('SyncResult can be constructed with all fields including introspection', () => {
    const result: SyncResult = {
      attempted: true,
      totalBlobs: 5,
      downloaded: 3,
      failed: 0,
      failedBlobs: [],
      duration: 1500,
      remoteEnvLoaded: true,
      envSources: { DB_HOST: 'remote' },
      blobs: [
        {
          blobName: 'p/config.json',
          relativePath: 'config.json',
          content: Buffer.from('{}'),
          size: 2,
          etag: '"e1"',
          lastModified: '2026-01-01T00:00:00.000Z',
        },
      ],
      fileTree: [
        {
          name: 'config.json',
          type: 'file',
          path: 'config.json',
          size: 2,
          blobName: 'p/config.json',
        },
      ],
      envDetails: {
        variables: { DB_HOST: 'remote-host' },
        sources: { DB_HOST: 'remote' },
        localKeys: [],
        remoteKeys: ['DB_HOST'],
        osKeys: [],
      },
    };

    expect(result.blobs).toHaveLength(1);
    expect(result.fileTree).toHaveLength(1);
    expect(result.envDetails.variables['DB_HOST']).toBe('remote-host');
  });
});
