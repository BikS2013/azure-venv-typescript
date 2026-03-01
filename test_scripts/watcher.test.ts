import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlobWatcher } from '../src/watch/watcher.js';
import type { AzureVenvBlobClient } from '../src/azure/client.js';
import type { AzureVenvConfig } from '../src/config/types.js';
import type { Logger } from '../src/logging/logger.js';
import type { BlobInfo } from '../src/azure/types.js';

/** Create a mock logger with vi.fn() stubs. */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Create a mock AzureVenvBlobClient. */
function createMockClient(blobs: BlobInfo[] = []): AzureVenvBlobClient {
  return {
    listBlobs: vi.fn().mockResolvedValue(blobs),
    downloadToBuffer: vi.fn(),
  } as unknown as AzureVenvBlobClient;
}

/** Build a minimal valid AzureVenvConfig for testing. */
function createMockConfig(overrides: Partial<AzureVenvConfig> = {}): AzureVenvConfig {
  return {
    blobUrl: {
      accountUrl: 'https://myaccount.blob.core.windows.net',
      containerName: 'mycontainer',
      prefix: 'test/',
    },
    sasToken: 'sv=2020-08-04&sig=fakesig',
    sasExpiry: null,
    failOnError: false,
    concurrency: 5,
    timeout: 30000,
    logLevel: 'info',
    rootDir: '/tmp/test-watcher',
    envPath: '.env',
    pollInterval: 5000, // Short interval for testing
    watchEnabled: true,
    ...overrides,
  };
}

describe('BlobWatcher', () => {
  let mockLogger: Logger;
  let mockClient: AzureVenvBlobClient;
  let config: AzureVenvConfig;
  let watcher: BlobWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockClient = createMockClient();
    config = createMockConfig();
    watcher = new BlobWatcher(
      config,
      mockClient,
      mockLogger,
      new Set<string>(),
      {},
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start() returns an object with a stop function', () => {
    const handle = watcher.start();

    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe('function');

    // Clean up
    handle.stop();
  });

  it('calling stop() clears the polling interval (no more polls after stop)', async () => {
    const handle = watcher.start();

    // Advance time to trigger one poll cycle
    await vi.advanceTimersByTimeAsync(config.pollInterval);

    const callCountAfterFirstPoll = (mockClient.listBlobs as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfterFirstPoll).toBe(1);

    // Stop the watcher
    handle.stop();

    // Advance time again - should NOT trigger another poll
    await vi.advanceTimersByTimeAsync(config.pollInterval);

    const callCountAfterStop = (mockClient.listBlobs as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfterStop).toBe(callCountAfterFirstPoll);
  });

  it('polls at the configured interval using fake timers', async () => {
    const handle = watcher.start();

    // No poll should have fired yet (first poll is after one interval, not immediately)
    expect(mockClient.listBlobs).not.toHaveBeenCalled();

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(config.pollInterval);
    expect(mockClient.listBlobs).toHaveBeenCalledTimes(1);

    // Advance past another interval
    await vi.advanceTimersByTimeAsync(config.pollInterval);
    expect(mockClient.listBlobs).toHaveBeenCalledTimes(2);

    // Advance past a third interval
    await vi.advanceTimersByTimeAsync(config.pollInterval);
    expect(mockClient.listBlobs).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it('uses pollInterval from options when provided', async () => {
    const customInterval = 10000;
    const handle = watcher.start({ pollInterval: customInterval });

    // After the config's pollInterval (5000ms), no poll should fire yet
    await vi.advanceTimersByTimeAsync(config.pollInterval);
    expect(mockClient.listBlobs).not.toHaveBeenCalled();

    // After the custom interval (10000ms total), one poll should fire
    await vi.advanceTimersByTimeAsync(customInterval - config.pollInterval);
    expect(mockClient.listBlobs).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('respects external AbortSignal to stop the watcher', async () => {
    const abortController = new AbortController();
    const handle = watcher.start({ signal: abortController.signal });

    // Advance to trigger one poll
    await vi.advanceTimersByTimeAsync(config.pollInterval);
    expect(mockClient.listBlobs).toHaveBeenCalledTimes(1);

    // Abort externally
    abortController.abort();

    // Advance time again - should not trigger more polls
    await vi.advanceTimersByTimeAsync(config.pollInterval);

    // We verify the watcher logged that it stopped
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Watch mode stopped'),
    );

    handle.stop();
  });

  it('logs "no changes detected" when blob list matches known ETags', async () => {
    const handle = watcher.start();

    // Advance to trigger one poll with empty blob list (default mock returns [])
    await vi.advanceTimersByTimeAsync(config.pollInterval);
    // Allow async poll operations to complete
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no changes detected'),
    );

    handle.stop();
  });

  it('calls listBlobs with the correct prefix from config', async () => {
    const handle = watcher.start();

    await vi.advanceTimersByTimeAsync(config.pollInterval);

    expect(mockClient.listBlobs).toHaveBeenCalledWith(config.blobUrl.prefix);

    handle.stop();
  });
});
