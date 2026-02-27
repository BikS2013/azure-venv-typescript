import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import type { EnvRecord } from '../types/index.js';
import type { Logger } from '../logging/logger.js';

/**
 * Load and parse a local .env file.
 *
 * @param envFilePath - Absolute path to the .env file.
 * @param logger - Logger instance.
 * @returns Parsed key-value pairs. Empty record if file does not exist.
 *
 * Contract:
 *   - Uses dotenv.parse() on the file contents (reads file manually, does NOT call dotenv.config())
 *   - If file does not exist: returns {} without error
 *   - If file exists but is empty: returns {}
 *   - Does NOT modify process.env (caller is responsible)
 *   - Malformed lines are ignored (dotenv behavior)
 *   - Logs file load at debug level
 */
export async function parseEnvFile(envFilePath: string, logger: Logger): Promise<EnvRecord> {
  let content: Buffer;
  try {
    content = await readFile(envFilePath);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info(`Local .env file not found at ${envFilePath}, proceeding without it`);
      return {};
    }
    throw err;
  }

  const parsed = parse(content);
  const keyCount = Object.keys(parsed).length;
  logger.debug(`Parsed ${keyCount} variable(s) from ${envFilePath}`);
  return parsed;
}

/**
 * Parse .env content from a Buffer (for remote .env files).
 *
 * @param content - Buffer containing .env file content.
 * @returns Parsed key-value pairs.
 *
 * Contract:
 *   - Uses dotenv.parse() on the buffer
 *   - Does NOT modify process.env
 *   - Returns empty record if buffer is empty
 */
export function parseEnvBuffer(content: Buffer): EnvRecord {
  return parse(content);
}
