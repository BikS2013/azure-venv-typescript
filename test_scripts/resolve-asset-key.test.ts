import { describe, it, expect, afterEach } from 'vitest';
import { resolveAssetKey } from '../src/assets/resolve-asset-key.js';

describe('resolveAssetKey', () => {
  const ENV_VAR = 'TEST_ASSET_KEY_VAR';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('returns the value of the environment variable', () => {
    process.env[ENV_VAR] = 'config/agents.yaml';
    expect(resolveAssetKey(ENV_VAR)).toBe('config/agents.yaml');
  });

  it('throws when the environment variable is not set', () => {
    expect(() => resolveAssetKey(ENV_VAR)).toThrow('not set or is empty');
  });

  it('throws when the environment variable is empty string', () => {
    process.env[ENV_VAR] = '';
    expect(() => resolveAssetKey(ENV_VAR)).toThrow('not set or is empty');
  });
});
