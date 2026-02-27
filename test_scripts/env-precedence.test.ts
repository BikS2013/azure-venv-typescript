import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyPrecedence } from '../src/env/precedence.js';
import type { Logger } from '../src/logging/logger.js';

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('applyPrecedence', () => {
  let logger: Logger;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    logger = createMockLogger();
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env exactly
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value;
    }
  });

  it('should let OS vars take precedence over remote and local', () => {
    // Simulate OS env having a key
    process.env['SHARED_KEY'] = 'os-value';
    const osSnapshot = new Set(['SHARED_KEY']);

    const localEnv = { SHARED_KEY: 'local-value' };
    const remoteEnv = { SHARED_KEY: 'remote-value' };

    const result = applyPrecedence(osSnapshot, localEnv, remoteEnv, logger);

    // OS value should be preserved
    expect(process.env['SHARED_KEY']).toBe('os-value');
    expect(result.sources['SHARED_KEY']).toBe('os');
    expect(result.osKeys).toContain('SHARED_KEY');
  });

  it('should let remote vars override local vars', () => {
    const osSnapshot = new Set<string>();

    const localEnv = { DB_HOST: 'localhost' };
    const remoteEnv = { DB_HOST: 'remote-db.example.com' };

    const result = applyPrecedence(osSnapshot, localEnv, remoteEnv, logger);

    expect(process.env['DB_HOST']).toBe('remote-db.example.com');
    expect(result.sources['DB_HOST']).toBe('remote');
    expect(result.remoteKeys).toContain('DB_HOST');
  });

  it('should apply local vars when there is no conflict', () => {
    const osSnapshot = new Set<string>();

    const localEnv = { LOCAL_ONLY: 'local-val' };
    const remoteEnv = {};

    const result = applyPrecedence(osSnapshot, localEnv, remoteEnv, logger);

    expect(process.env['LOCAL_ONLY']).toBe('local-val');
    expect(result.sources['LOCAL_ONLY']).toBe('local');
    expect(result.localKeys).toContain('LOCAL_ONLY');
  });

  it('should track all sources correctly in EnvLoadResult', () => {
    process.env['OS_VAR'] = 'os-original';
    const osSnapshot = new Set(['OS_VAR']);

    const localEnv = {
      OS_VAR: 'local-attempt',
      LOCAL_VAR: 'local-val',
      OVERLAP: 'local-overlap',
    };
    const remoteEnv = {
      OS_VAR: 'remote-attempt',
      REMOTE_VAR: 'remote-val',
      OVERLAP: 'remote-overlap',
    };

    const result = applyPrecedence(osSnapshot, localEnv, remoteEnv, logger);

    expect(result.osKeys).toContain('OS_VAR');
    expect(result.localKeys).toContain('LOCAL_VAR');
    expect(result.remoteKeys).toContain('REMOTE_VAR');
    expect(result.remoteKeys).toContain('OVERLAP');

    expect(result.sources['OS_VAR']).toBe('os');
    expect(result.sources['LOCAL_VAR']).toBe('local');
    expect(result.sources['REMOTE_VAR']).toBe('remote');
    expect(result.sources['OVERLAP']).toBe('remote');
  });

  it('should mutate process.env correctly', () => {
    const osSnapshot = new Set<string>();

    const localEnv = { NEW_LOCAL: 'lv' };
    const remoteEnv = { NEW_REMOTE: 'rv' };

    applyPrecedence(osSnapshot, localEnv, remoteEnv, logger);

    expect(process.env['NEW_LOCAL']).toBe('lv');
    expect(process.env['NEW_REMOTE']).toBe('rv');
  });
});
