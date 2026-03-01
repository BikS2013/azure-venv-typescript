import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/config/validator.js';
import { ConfigurationError } from '../src/errors/index.js';

/** Helper to build a minimal valid env record. */
function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AZURE_VENV: 'https://myaccount.blob.core.windows.net/mycontainer',
    AZURE_VENV_SAS_TOKEN:
      'sv=2020-08-04&ss=b&srt=sco&sp=rl&se=2099-12-31T23:59:59Z&st=2020-01-01T00:00:00Z&spr=https&sig=fakesig',
    ...overrides,
  };
}

describe('validateConfig - AZURE_VENV_POLL_INTERVAL', () => {
  it('defaults to 30000 when not provided', () => {
    const config = validateConfig(validEnv());
    expect(config).not.toBeNull();
    expect(config!.pollInterval).toBe(30000);
  });

  it('rejects values below 5000', () => {
    expect(() =>
      validateConfig(validEnv({ AZURE_VENV_POLL_INTERVAL: '1000' })),
    ).toThrow(ConfigurationError);
  });

  it('rejects values above 3600000', () => {
    expect(() =>
      validateConfig(validEnv({ AZURE_VENV_POLL_INTERVAL: '4000000' })),
    ).toThrow(ConfigurationError);
  });

  it('accepts the minimum valid value of 5000', () => {
    const config = validateConfig(validEnv({ AZURE_VENV_POLL_INTERVAL: '5000' }));
    expect(config).not.toBeNull();
    expect(config!.pollInterval).toBe(5000);
  });

  it('accepts the maximum valid value of 3600000', () => {
    const config = validateConfig(validEnv({ AZURE_VENV_POLL_INTERVAL: '3600000' }));
    expect(config).not.toBeNull();
    expect(config!.pollInterval).toBe(3600000);
  });
});

describe('validateConfig - AZURE_VENV_WATCH_ENABLED', () => {
  it('defaults to false when not provided', () => {
    const config = validateConfig(validEnv());
    expect(config).not.toBeNull();
    expect(config!.watchEnabled).toBe(false);
  });

  it('sets watchEnabled to true when AZURE_VENV_WATCH_ENABLED="true"', () => {
    const config = validateConfig(validEnv({ AZURE_VENV_WATCH_ENABLED: 'true' }));
    expect(config).not.toBeNull();
    expect(config!.watchEnabled).toBe(true);
  });

  it('sets watchEnabled to false when AZURE_VENV_WATCH_ENABLED="false"', () => {
    const config = validateConfig(validEnv({ AZURE_VENV_WATCH_ENABLED: 'false' }));
    expect(config).not.toBeNull();
    expect(config!.watchEnabled).toBe(false);
  });
});

describe('validateConfig - options override env vars for new fields', () => {
  it('options.pollInterval overrides AZURE_VENV_POLL_INTERVAL env var', () => {
    const config = validateConfig(
      validEnv({ AZURE_VENV_POLL_INTERVAL: '10000' }),
      { pollInterval: 60000 },
    );
    expect(config).not.toBeNull();
    expect(config!.pollInterval).toBe(60000);
  });

  it('options.watchEnabled overrides AZURE_VENV_WATCH_ENABLED env var', () => {
    const config = validateConfig(
      validEnv({ AZURE_VENV_WATCH_ENABLED: 'false' }),
      { watchEnabled: true },
    );
    expect(config).not.toBeNull();
    expect(config!.watchEnabled).toBe(true);
  });
});
