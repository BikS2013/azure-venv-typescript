import { describe, it, expect } from 'vitest';
import { sortBlobs } from '../src/introspection/manifest-reader.js';
import type { BlobContent } from '../src/types/index.js';

function makeBlob(relativePath: string, blobName?: string, size = 100): BlobContent {
  return {
    blobName: blobName ?? `prefix/${relativePath}`,
    relativePath,
    content: Buffer.from('test'),
    size,
    etag: '"abc123"',
    lastModified: '2026-01-01T12:00:00.000Z',
  };
}

describe('sortBlobs', () => {
  it('returns empty array for empty input', () => {
    const result = sortBlobs([]);
    expect(result).toEqual([]);
  });

  it('returns blobs sorted by relativePath', () => {
    const blobs = [
      makeBlob('z-file.txt'),
      makeBlob('a-file.txt'),
      makeBlob('dir/m-file.txt'),
    ];

    const result = sortBlobs(blobs);
    expect(result.map((b) => b.relativePath)).toEqual([
      'a-file.txt',
      'dir/m-file.txt',
      'z-file.txt',
    ]);
  });

  it('preserves all blob fields', () => {
    const blobs = [makeBlob('config.json', 'prefix/config.json', 1024)];
    const result = sortBlobs(blobs);

    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe('config.json');
    expect(result[0].blobName).toBe('prefix/config.json');
    expect(result[0].size).toBe(1024);
    expect(result[0].etag).toBe('"abc123"');
    expect(result[0].lastModified).toBe('2026-01-01T12:00:00.000Z');
    expect(result[0].content).toBeInstanceOf(Buffer);
  });

  it('does not mutate the original array', () => {
    const blobs = [makeBlob('b.txt'), makeBlob('a.txt')];
    const result = sortBlobs(blobs);

    expect(blobs[0].relativePath).toBe('b.txt');
    expect(result[0].relativePath).toBe('a.txt');
  });
});
