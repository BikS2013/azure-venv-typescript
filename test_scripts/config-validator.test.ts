import { describe, it, expect, vi } from 'vitest';
import { validateConfig } from '../src/config/validator.js';
import { ConfigurationError, AuthenticationError } from '../src/errors/index.js';

/** Helper to build a minimal valid env. */
function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AZURE_VENV: 'https://myaccount.blob.core.windows.net/mycontainer',
    AZURE_VENV_SAS_TOKEN: 'sv=2020-08-04&ss=b&srt=sco&sp=rl&se=2099-12-31T23:59:59Z&st=2020-01-01T00:00:00Z&spr=https&sig=fakesig',
    ...overrides,
  };
}

describe('validateConfig', () => {
  // -------------------------------------------------------
  // Null / partial config scenarios
  // -------------------------------------------------------
  it('returns null when neither AZURE_VENV nor SAS_TOKEN are set', () => {
    const result = validateConfig({});
    expect(result).toBeNull();
  });

  it('throws ConfigurationError when only AZURE_VENV is set', () => {
    expect(() =>
      validateConfig({
        AZURE_VENV: 'https://myaccount.blob.core.windows.net/mycontainer',
      }),
    ).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when only SAS_TOKEN is set', () => {
    expect(() =>
      validateConfig({
        AZURE_VENV_SAS_TOKEN: 'sv=2020-08-04&ss=b',
      }),
    ).toThrow(ConfigurationError);
  });

  // -------------------------------------------------------
  // Valid config
  // -------------------------------------------------------
  it('returns AzureVenvConfig when both required vars are set and valid', () => {
    const config = validateConfig(validEnv());
    expect(config).not.toBeNull();
    expect(config!.blobUrl.accountUrl).toBe(
      'https://myaccount.blob.core.windows.net',
    );
    expect(config!.blobUrl.containerName).toBe('mycontainer');
    expect(config!.sasToken).toContain('sv=2020-08-04');
  });

  // -------------------------------------------------------
  // Expired SAS token
  // -------------------------------------------------------
  it('throws AuthenticationError when SAS token is expired', () => {
    const env = validEnv({
      AZURE_VENV_SAS_TOKEN: 'sv=2020-08-04&ss=b&se=2020-01-01T00:00:00Z&sig=fakesig',
    });
    expect(() => validateConfig(env)).toThrow(AuthenticationError);
  });

  it('throws AuthenticationError when AZURE_VENV_SAS_EXPIRY is in the past', () => {
    const env = validEnv({
      AZURE_VENV_SAS_EXPIRY: '2020-01-01T00:00:00Z',
    });
    expect(() => validateConfig(env)).toThrow(AuthenticationError);
  });

  // -------------------------------------------------------
  // Options override env vars
  // -------------------------------------------------------
  it('options override env var values', () => {
    const env = validEnv({
      AZURE_VENV_SYNC_MODE: 'full',
      AZURE_VENV_CONCURRENCY: '10',
    });
    const config = validateConfig(env, {
      syncMode: 'incremental',
      concurrency: 3,
    });
    expect(config!.syncMode).toBe('incremental');
    expect(config!.concurrency).toBe(3);
  });

  // -------------------------------------------------------
  // Default values for operational params
  // -------------------------------------------------------
  it('uses correct defaults for operational params', () => {
    const config = validateConfig(validEnv());
    expect(config!.syncMode).toBe('full');
    expect(config!.failOnError).toBe(false);
    expect(config!.concurrency).toBe(5);
    expect(config!.timeout).toBe(30000);
    expect(config!.logLevel).toBe('info');
    expect(config!.envPath).toBe('.env');
    expect(config!.maxBlobSize).toBe(104857600);
    expect(config!.pollInterval).toBe(30000);
    expect(config!.watchEnabled).toBe(false);
  });

  // -------------------------------------------------------
  // SAS token with leading ? gets stripped
  // -------------------------------------------------------
  it('strips leading ? from SAS token', () => {
    const env = validEnv({
      AZURE_VENV_SAS_TOKEN: '?sv=2020-08-04&ss=b&srt=sco&sp=rl&se=2099-12-31T23:59:59Z&sig=fakesig',
    });
    const config = validateConfig(env);
    expect(config!.sasToken.startsWith('?')).toBe(false);
    expect(config!.sasToken).toBe(
      'sv=2020-08-04&ss=b&srt=sco&sp=rl&se=2099-12-31T23:59:59Z&sig=fakesig',
    );
  });

  // -------------------------------------------------------
  // Invalid AZURE_VENV_CONCURRENCY
  // -------------------------------------------------------
  it('throws ConfigurationError for invalid AZURE_VENV_CONCURRENCY', () => {
    const env = validEnv({ AZURE_VENV_CONCURRENCY: 'abc' });
    expect(() => validateConfig(env)).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when AZURE_VENV_CONCURRENCY exceeds max', () => {
    const env = validEnv({ AZURE_VENV_CONCURRENCY: '100' });
    expect(() => validateConfig(env)).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for zero AZURE_VENV_CONCURRENCY', () => {
    const env = validEnv({ AZURE_VENV_CONCURRENCY: '0' });
    expect(() => validateConfig(env)).toThrow(ConfigurationError);
  });

  // -------------------------------------------------------
  // rootDir and other options
  // -------------------------------------------------------
  it('accepts rootDir from options', () => {
    const config = validateConfig(validEnv(), { rootDir: '/tmp/test' });
    expect(config!.rootDir).toBe('/tmp/test');
  });

  // -------------------------------------------------------
  // Invalid env var values
  // -------------------------------------------------------
  it('throws ConfigurationError for invalid AZURE_VENV_TIMEOUT', () => {
    const env = validEnv({ AZURE_VENV_TIMEOUT: 'fast' });
    expect(() => validateConfig(env)).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for invalid AZURE_VENV_LOG_LEVEL', () => {
    const env = validEnv({ AZURE_VENV_LOG_LEVEL: 'verbose' });
    expect(() => validateConfig(env)).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for invalid AZURE_VENV_SYNC_MODE', () => {
    const env = validEnv({ AZURE_VENV_SYNC_MODE: 'partial' });
    expect(() => validateConfig(env)).toThrow(ConfigurationError);
  });

  // -------------------------------------------------------
  // Warns for soon-to-expire tokens (no throw)
  // -------------------------------------------------------
  it('warns but does not throw when SAS token expires within 7 days', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const env = validEnv({
      AZURE_VENV_SAS_EXPIRY: threeDaysFromNow.toISOString(),
    });
    const config = validateConfig(env);
    expect(config).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('expires within 7 days'),
    );
    warnSpy.mockRestore();
  });
});
