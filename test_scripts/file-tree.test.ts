import { describe, it, expect } from 'vitest';
import { buildFileTree } from '../src/introspection/file-tree.js';
import type { SyncedFileInfo, FileTreeNode } from '../src/types/index.js';

function makeFile(localPath: string, size = 100, blobName?: string): SyncedFileInfo {
  return {
    localPath,
    blobName: blobName ?? `prefix/${localPath}`,
    size,
    lastModified: '2026-01-01T00:00:00.000Z',
    etag: '"etag"',
  };
}

describe('buildFileTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it('creates a single file node at root level', () => {
    const files = [makeFile('config.json', 512)];
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toEqual({
      name: 'config.json',
      type: 'file',
      path: 'config.json',
      size: 512,
      blobName: 'prefix/config.json',
    });
  });

  it('creates nested directory structure', () => {
    const files = [makeFile('src/utils/helper.ts')];
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('src');
    expect(tree[0].type).toBe('directory');
    expect(tree[0].path).toBe('src');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].name).toBe('utils');
    expect(tree[0].children![0].type).toBe('directory');
    expect(tree[0].children![0].children).toHaveLength(1);
    expect(tree[0].children![0].children![0].name).toBe('helper.ts');
    expect(tree[0].children![0].children![0].type).toBe('file');
  });

  it('shares directory nodes for files in same directory', () => {
    const files = [
      makeFile('src/a.ts'),
      makeFile('src/b.ts'),
    ];
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('src');
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children![0].name).toBe('a.ts');
    expect(tree[0].children![1].name).toBe('b.ts');
  });

  it('sorts directories before files at each level', () => {
    const files = [
      makeFile('readme.md'),
      makeFile('src/index.ts'),
      makeFile('docs/guide.md'),
    ];
    const tree = buildFileTree(files);

    // Root level: docs/, src/ (directories first), then readme.md (file)
    expect(tree).toHaveLength(3);
    expect(tree[0].type).toBe('directory');
    expect(tree[0].name).toBe('docs');
    expect(tree[1].type).toBe('directory');
    expect(tree[1].name).toBe('src');
    expect(tree[2].type).toBe('file');
    expect(tree[2].name).toBe('readme.md');
  });

  it('sorts alphabetically within directories and files groups', () => {
    const files = [
      makeFile('config/z-setting.json'),
      makeFile('config/a-setting.json'),
    ];
    const tree = buildFileTree(files);

    expect(tree[0].children![0].name).toBe('a-setting.json');
    expect(tree[0].children![1].name).toBe('z-setting.json');
  });

  it('handles deep nesting correctly', () => {
    const files = [makeFile('a/b/c/d/e.txt')];
    const tree = buildFileTree(files);

    let node: FileTreeNode = tree[0];
    expect(node.name).toBe('a');
    expect(node.path).toBe('a');

    node = node.children![0];
    expect(node.name).toBe('b');
    expect(node.path).toBe('a/b');

    node = node.children![0];
    expect(node.name).toBe('c');
    expect(node.path).toBe('a/b/c');

    node = node.children![0];
    expect(node.name).toBe('d');
    expect(node.path).toBe('a/b/c/d');

    node = node.children![0];
    expect(node.name).toBe('e.txt');
    expect(node.type).toBe('file');
    expect(node.path).toBe('a/b/c/d/e.txt');
  });

  it('normalizes backslash paths to forward slashes', () => {
    const file: SyncedFileInfo = {
      localPath: 'dir\\sub\\file.txt',
      blobName: 'prefix/dir/sub/file.txt',
      size: 100,
      lastModified: '2026-01-01T00:00:00.000Z',
      etag: '"etag"',
    };
    const tree = buildFileTree([file]);

    expect(tree[0].name).toBe('dir');
    expect(tree[0].path).toBe('dir');
    expect(tree[0].children![0].name).toBe('sub');
    expect(tree[0].children![0].path).toBe('dir/sub');
    expect(tree[0].children![0].children![0].path).toBe('dir/sub/file.txt');
  });

  it('file nodes have size and blobName, no children', () => {
    const files = [makeFile('data.json', 2048, 'myblob')];
    const tree = buildFileTree(files);

    expect(tree[0].size).toBe(2048);
    expect(tree[0].blobName).toBe('myblob');
    expect(tree[0].children).toBeUndefined();
  });

  it('directory nodes do not have size or blobName', () => {
    const files = [makeFile('dir/file.txt')];
    const tree = buildFileTree(files);

    expect(tree[0].type).toBe('directory');
    expect(tree[0].size).toBeUndefined();
    expect(tree[0].blobName).toBeUndefined();
  });

  it('handles complex mixed tree structure', () => {
    const files = [
      makeFile('.env'),
      makeFile('config/app.json', 200),
      makeFile('config/db.json', 150),
      makeFile('templates/email/welcome.html', 3000),
      makeFile('templates/email/reset.html', 2500),
      makeFile('templates/sms/verify.txt', 100),
      makeFile('data/seed.sql', 50000),
    ];
    const tree = buildFileTree(files);

    // Root level: config/, data/, templates/ (dirs first, alphabetical), then .env (file)
    expect(tree.map((n) => n.name)).toEqual(['config', 'data', 'templates', '.env']);

    // config/ has 2 files
    const config = tree[0];
    expect(config.children).toHaveLength(2);
    expect(config.children![0].name).toBe('app.json');
    expect(config.children![1].name).toBe('db.json');

    // templates/ has 2 subdirectories
    const templates = tree[2];
    expect(templates.children).toHaveLength(2);
    expect(templates.children![0].name).toBe('email');
    expect(templates.children![1].name).toBe('sms');

    // templates/email/ has 2 files
    const email = templates.children![0];
    expect(email.children).toHaveLength(2);
    expect(email.children![0].name).toBe('reset.html');
    expect(email.children![1].name).toBe('welcome.html');
  });
});
