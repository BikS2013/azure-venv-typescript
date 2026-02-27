import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEnvFile, parseEnvBuffer } from '../src/env/loader.js';
import type { Logger } from '../src/logging/logger.js';

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('parseEnvFile', () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-loader-test-'));
    logger = createMockLogger();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should parse key=value pairs from an existing file', async () => {
    const envPath = path.join(tmpDir, '.env');
    await fs.writeFile(envPath, 'FOO=bar\nBAZ=qux\n', 'utf-8');

    const result = await parseEnvFile(envPath, logger);

    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('should return empty record when file does not exist', async () => {
    const envPath = path.join(tmpDir, 'nonexistent.env');

    const result = await parseEnvFile(envPath, logger);

    expect(result).toEqual({});
  });

  it('should return empty record for an empty file', async () => {
    const envPath = path.join(tmpDir, '.env');
    await fs.writeFile(envPath, '', 'utf-8');

    const result = await parseEnvFile(envPath, logger);

    expect(result).toEqual({});
  });
});

describe('parseEnvBuffer', () => {
  it('should parse key=value pairs from a buffer', () => {
    const buffer = Buffer.from('KEY1=value1\nKEY2=value2\n');

    const result = parseEnvBuffer(buffer);

    expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });
  });

  it('should return empty record for an empty buffer', () => {
    const buffer = Buffer.from('');

    const result = parseEnvBuffer(buffer);

    expect(result).toEqual({});
  });
});
