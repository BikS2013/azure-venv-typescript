import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlobDownloader } from '../src/sync/downloader.js';
import type { AzureVenvBlobClient } from '../src/azure/client.js';
import type { BlobInfo, BlobDownloadResult } from '../src/azure/types.js';
import type { Logger } from '../src/logging/logger.js';

/** Create a mock logger with vi.fn() stubs for all methods. */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Create a mock AzureVenvBlobClient with downloadToFile and downloadToFileStreaming stubs. */
function createMockClient(): AzureVenvBlobClient {
  return {
    listBlobs: vi.fn(),
    downloadToFile: vi.fn(),
    downloadToFileStreaming: vi.fn(),
    downloadToBuffer: vi.fn(),
  } as unknown as AzureVenvBlobClient;
}

/** Create a mock path validator that always returns a valid resolved path. */
function createMockPathValidator() {
  return {
    validateAndResolvePath: vi.fn((relativePath: string, rootDir: string) => {
      return `${rootDir}/${relativePath}`;
    }),
  };
}

/** Helper to create a BlobInfo object with a specified content length. */
function makeBlobInfo(name: string, contentLength: number): BlobInfo {
  return {
    name,
    etag: `"etag-${name}"`,
    lastModified: new Date('2026-01-01T00:00:00Z'),
    contentLength,
    contentMD5: undefined,
  };
}

/** Helper to create a BlobDownloadResult from a BlobInfo. */
function makeDownloadResult(blob: BlobInfo, localPath: string): BlobDownloadResult {
  return {
    blobName: blob.name,
    localPath,
    etag: blob.etag,
    lastModified: blob.lastModified,
    contentLength: blob.contentLength,
  };
}

describe('BlobDownloader - streaming threshold routing', () => {
  const MAX_BLOB_SIZE = 1000; // Small threshold for testing
  const ROOT_DIR = '/tmp/test-root';
  const PREFIX = 'prefix/';
  const CONCURRENCY = 5;

  let mockClient: AzureVenvBlobClient;
  let mockLogger: Logger;
  let mockPathValidator: ReturnType<typeof createMockPathValidator>;
  let downloader: BlobDownloader;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockClient = createMockClient();
    mockLogger = createMockLogger();
    mockPathValidator = createMockPathValidator();
    downloader = new BlobDownloader(
      mockClient,
      mockPathValidator,
      mockLogger,
      CONCURRENCY,
      MAX_BLOB_SIZE,
    );
  });

  it('uses downloadToFile for blobs below maxBlobSize threshold', async () => {
    const smallBlob = makeBlobInfo('prefix/small-file.txt', 500);
    const expectedPath = `${ROOT_DIR}/small-file.txt`;

    (mockClient.downloadToFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDownloadResult(smallBlob, expectedPath),
    );

    const results = await downloader.downloadBatch([smallBlob], ROOT_DIR, PREFIX);

    expect(results).toHaveLength(1);
    expect(mockClient.downloadToFile).toHaveBeenCalledTimes(1);
    expect(mockClient.downloadToFile).toHaveBeenCalledWith(
      smallBlob.name,
      expectedPath,
    );
    expect(mockClient.downloadToFileStreaming).not.toHaveBeenCalled();
  });

  it('uses downloadToFileStreaming for blobs above maxBlobSize threshold', async () => {
    const largeBlob = makeBlobInfo('prefix/large-file.bin', 2000);
    const expectedPath = `${ROOT_DIR}/large-file.bin`;

    (mockClient.downloadToFileStreaming as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDownloadResult(largeBlob, expectedPath),
    );

    const results = await downloader.downloadBatch([largeBlob], ROOT_DIR, PREFIX);

    expect(results).toHaveLength(1);
    expect(mockClient.downloadToFileStreaming).toHaveBeenCalledTimes(1);
    expect(mockClient.downloadToFileStreaming).toHaveBeenCalledWith(
      largeBlob.name,
      expectedPath,
    );
    expect(mockClient.downloadToFile).not.toHaveBeenCalled();
  });

  it('uses downloadToFile when blob is exactly at threshold (not greater than)', async () => {
    const exactBlob = makeBlobInfo('prefix/exact-file.dat', MAX_BLOB_SIZE);
    const expectedPath = `${ROOT_DIR}/exact-file.dat`;

    (mockClient.downloadToFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDownloadResult(exactBlob, expectedPath),
    );

    const results = await downloader.downloadBatch([exactBlob], ROOT_DIR, PREFIX);

    expect(results).toHaveLength(1);
    expect(mockClient.downloadToFile).toHaveBeenCalledTimes(1);
    expect(mockClient.downloadToFile).toHaveBeenCalledWith(
      exactBlob.name,
      expectedPath,
    );
    expect(mockClient.downloadToFileStreaming).not.toHaveBeenCalled();
  });

  it('routes a mixed batch correctly: small uses downloadToFile, large uses streaming', async () => {
    const smallBlob = makeBlobInfo('prefix/small.txt', 100);
    const largeBlob = makeBlobInfo('prefix/large.bin', 5000);
    const smallPath = `${ROOT_DIR}/small.txt`;
    const largePath = `${ROOT_DIR}/large.bin`;

    (mockClient.downloadToFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDownloadResult(smallBlob, smallPath),
    );
    (mockClient.downloadToFileStreaming as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDownloadResult(largeBlob, largePath),
    );

    const results = await downloader.downloadBatch(
      [smallBlob, largeBlob],
      ROOT_DIR,
      PREFIX,
    );

    expect(results).toHaveLength(2);
    expect(mockClient.downloadToFile).toHaveBeenCalledTimes(1);
    expect(mockClient.downloadToFile).toHaveBeenCalledWith(smallBlob.name, smallPath);
    expect(mockClient.downloadToFileStreaming).toHaveBeenCalledTimes(1);
    expect(mockClient.downloadToFileStreaming).toHaveBeenCalledWith(largeBlob.name, largePath);
  });
});
