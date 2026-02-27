import { describe, it, expect } from 'vitest';
import { NO_OP_SYNC_RESULT } from '../src/types/index.js';
import type { SyncResult, SyncedFileInfo, FileTreeNode, EnvDetails } from '../src/types/index.js';

describe('Introspection types on SyncResult', () => {
  it('NO_OP_SYNC_RESULT includes empty introspection fields', () => {
    expect(NO_OP_SYNC_RESULT.syncedFiles).toEqual([]);
    expect(NO_OP_SYNC_RESULT.fileTree).toEqual([]);
    expect(NO_OP_SYNC_RESULT.envDetails).toEqual({
      variables: {},
      sources: {},
      localKeys: [],
      remoteKeys: [],
      osKeys: [],
    });
  });

  it('SyncedFileInfo has all expected fields', () => {
    const file: SyncedFileInfo = {
      localPath: 'config.json',
      blobName: 'prefix/config.json',
      size: 1024,
      lastModified: '2026-01-01T00:00:00.000Z',
      etag: '"abc"',
    };

    expect(file.localPath).toBe('config.json');
    expect(file.blobName).toBe('prefix/config.json');
    expect(file.size).toBe(1024);
    expect(file.lastModified).toBe('2026-01-01T00:00:00.000Z');
    expect(file.etag).toBe('"abc"');
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
      skipped: 2,
      failed: 0,
      failedBlobs: [],
      duration: 1500,
      remoteEnvLoaded: true,
      envSources: { DB_HOST: 'remote' },
      syncedFiles: [
        {
          localPath: 'config.json',
          blobName: 'p/config.json',
          size: 100,
          lastModified: '2026-01-01T00:00:00.000Z',
          etag: '"e1"',
        },
      ],
      fileTree: [
        {
          name: 'config.json',
          type: 'file',
          path: 'config.json',
          size: 100,
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

    expect(result.syncedFiles).toHaveLength(1);
    expect(result.fileTree).toHaveLength(1);
    expect(result.envDetails.variables['DB_HOST']).toBe('remote-host');
  });
});
