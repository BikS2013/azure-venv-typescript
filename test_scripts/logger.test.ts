import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitize, createLogger } from '../src/logging/logger.js';

describe('sanitize', () => {
  it('should remove the exact SAS token', () => {
    const sasToken = 'sv=2021-06-08&ss=b&srt=co&sp=r&se=2025-01-01&sig=abc123';
    const input = `Downloading from https://account.blob.core.windows.net/container?${sasToken}`;

    const result = sanitize(input, sasToken);

    expect(result).not.toContain(sasToken);
    expect(result).toContain('[REDACTED]');
  });

  it('should replace sig= parameter', () => {
    const input = 'url?sv=2021&sig=secret_signature_value&sp=r';

    const result = sanitize(input, '');

    expect(result).not.toContain('secret_signature_value');
    expect(result).toContain('sig=[REDACTED]');
    // sv and sp should remain
    expect(result).toContain('sv=2021');
    expect(result).toContain('sp=r');
  });

  it('should replace se= parameter', () => {
    const input = 'url?se=2025-01-01T00%3A00%3A00Z&sp=r';

    const result = sanitize(input, '');

    expect(result).toContain('se=[REDACTED]');
    expect(result).not.toContain('2025-01-01');
  });

  it('should be a no-op when no sensitive content is present', () => {
    const input = 'Just a normal log message with no secrets';

    const result = sanitize(input, '');

    expect(result).toBe(input);
  });
});

describe('createLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should suppress debug messages when level is info', () => {
    const logger = createLogger('info', '');

    logger.debug('this should not appear');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('should emit info messages when level is info', () => {
    const logger = createLogger('info', '');

    logger.info('hello world');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[azure-venv]');
    expect(output).toContain('[INFO]');
    expect(output).toContain('hello world');
  });

  it('should emit debug messages when level is debug', () => {
    const logger = createLogger('debug', '');

    logger.debug('debug detail');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[DEBUG]');
    expect(output).toContain('debug detail');
  });

  it('should emit warn and error to console.error', () => {
    const logger = createLogger('info', '');

    logger.warn('a warning');
    logger.error('an error');

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const warnOutput = errorSpy.mock.calls[0][0] as string;
    expect(warnOutput).toContain('[WARN]');
    const errorOutput = errorSpy.mock.calls[1][0] as string;
    expect(errorOutput).toContain('[ERROR]');
  });

  it('should format messages with prefix, level, and timestamp', () => {
    const logger = createLogger('info', '');

    logger.info('test message');

    const output = logSpy.mock.calls[0][0] as string;
    // Matches pattern: [azure-venv] [INFO] [ISO-timestamp] test message
    expect(output).toMatch(
      /\[azure-venv\] \[INFO\] \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] test message/,
    );
  });

  it('should sanitize SAS tokens in log output', () => {
    const sasToken = 'sig=mysecret&se=2025-12-31';
    const logger = createLogger('info', sasToken);

    logger.info(`Connecting to https://account.blob.core.windows.net?${sasToken}`);

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('mysecret');
    expect(output).not.toContain('2025-12-31');
    expect(output).toContain('[REDACTED]');
  });
});
