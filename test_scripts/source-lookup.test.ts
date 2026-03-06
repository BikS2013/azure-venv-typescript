import { describe, it, expect } from 'vitest';
import { findBlobBySource } from '../src/introspection/source-lookup.js';
import type { BlobContent } from '../src/types/index.js';

function makeBlob(overrides: Partial<BlobContent> = {}): BlobContent {
  return {
    blobName: 'prefix/file.txt',
    relativePath: 'file.txt',
    content: Buffer.from('content'),
    size: 7,
    etag: '"etag"',
    lastModified: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('findBlobBySource', () => {
  const blobs: BlobContent[] = [
    makeBlob({
      blobName: 'prefix/config/app.json',
      relativePath: 'config/app.json',
      sourceRegistry: 'github.com/org/repo',
      sourcePath: 'config/app.json',
    }),
    makeBlob({
      blobName: 'prefix/scripts/deploy.sh',
      relativePath: 'scripts/deploy.sh',
      sourceRegistry: 'azure-devops/project/repo',
      sourcePath: 'scripts/deploy.sh',
    }),
    makeBlob({
      blobName: 'prefix/readme.md',
      relativePath: 'readme.md',
      sourceRegistry: 'github.com/org/repo',
      sourcePath: 'docs/readme.md',
    }),
    makeBlob({
      blobName: 'prefix/no-metadata.txt',
      relativePath: 'no-metadata.txt',
      // no sourceRegistry or sourcePath
    }),
  ];

  it('finds a blob by source_path@source_registry', () => {
    const result = findBlobBySource(blobs, 'config/app.json@github.com/org/repo');
    expect(result).toBeDefined();
    expect(result!.relativePath).toBe('config/app.json');
  });

  it('finds a different blob with same registry but different path', () => {
    const result = findBlobBySource(blobs, 'docs/readme.md@github.com/org/repo');
    expect(result).toBeDefined();
    expect(result!.relativePath).toBe('readme.md');
  });

  it('finds a blob from a different registry', () => {
    const result = findBlobBySource(blobs, 'scripts/deploy.sh@azure-devops/project/repo');
    expect(result).toBeDefined();
    expect(result!.relativePath).toBe('scripts/deploy.sh');
  });

  it('returns undefined when source_path does not match', () => {
    const result = findBlobBySource(blobs, 'nonexistent/path@github.com/org/repo');
    expect(result).toBeUndefined();
  });

  it('returns undefined when source_registry does not match', () => {
    const result = findBlobBySource(blobs, 'config/app.json@unknown-registry');
    expect(result).toBeUndefined();
  });

  it('returns undefined when blob has no metadata', () => {
    const result = findBlobBySource(blobs, 'no-metadata.txt@any-registry');
    expect(result).toBeUndefined();
  });

  it('handles source_path containing @ by splitting on last @', () => {
    const blobsWithAt: BlobContent[] = [
      makeBlob({
        sourceRegistry: 'my-registry',
        sourcePath: 'user@host/path/file.txt',
      }),
    ];
    const result = findBlobBySource(blobsWithAt, 'user@host/path/file.txt@my-registry');
    expect(result).toBeDefined();
    expect(result!.sourcePath).toBe('user@host/path/file.txt');
  });

  it('is case-sensitive for both path and registry', () => {
    const result = findBlobBySource(blobs, 'Config/App.json@github.com/org/repo');
    expect(result).toBeUndefined();
  });

  it('throws on invalid expression - missing @', () => {
    expect(() => findBlobBySource(blobs, 'no-at-sign')).toThrow(
      'Invalid source expression',
    );
  });

  it('throws on invalid expression - @ at start', () => {
    expect(() => findBlobBySource(blobs, '@registry-only')).toThrow(
      'Invalid source expression',
    );
  });

  it('throws on invalid expression - @ at end', () => {
    expect(() => findBlobBySource(blobs, 'path-only@')).toThrow(
      'Invalid source expression',
    );
  });

  it('returns undefined for empty blob array', () => {
    const result = findBlobBySource([], 'path@registry');
    expect(result).toBeUndefined();
  });
});
