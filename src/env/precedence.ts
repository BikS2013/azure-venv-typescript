import type { EnvRecord, EnvLoadResult, EnvSource } from '../types/index.js';
import type { Logger } from '../logging/logger.js';

/**
 * Apply the three-tier environment variable precedence model to process.env.
 *
 * Precedence (highest to lowest):
 *   1. OS environment variables (already in process.env before library init)
 *   2. Remote .env from Azure Blob Storage
 *   3. Local .env file
 *
 * @param osEnvSnapshot - Snapshot of process.env keys taken BEFORE any .env loading.
 *   These keys represent genuine OS-level environment variables.
 * @param localEnv - Parsed key-value pairs from local .env file.
 * @param remoteEnv - Parsed key-value pairs from remote .env file. Empty record if no remote .env.
 * @param logger - Logger instance.
 * @returns EnvLoadResult with the merged variables, source tracking, and per-tier key lists.
 *
 * Contract:
 *   - MUTATES process.env (this is the intended side effect)
 *   - For each key in localEnv:
 *     - If key is in osEnvSnapshot: do NOT override (OS wins)
 *     - Otherwise: set process.env[key] = localEnv[key], record source='local'
 *   - For each key in remoteEnv:
 *     - If key is in osEnvSnapshot: do NOT override (OS wins)
 *     - Otherwise: set process.env[key] = remoteEnv[key], record source='remote'
 *       (this overrides any local .env value for the same key)
 *   - Return EnvLoadResult with complete source tracking
 *   - Log summary at info level: "Applied N local vars, M remote vars, K OS-preserved vars"
 *   - Log each variable source at debug level (key name only, never values)
 */
export function applyPrecedence(
  osEnvSnapshot: ReadonlySet<string>,
  localEnv: Readonly<EnvRecord>,
  remoteEnv: Readonly<EnvRecord>,
  logger: Logger,
): EnvLoadResult {
  const variables: EnvRecord = {};
  const sources: Record<string, EnvSource> = {};
  const localKeys: string[] = [];
  const remoteKeys: string[] = [];
  const osKeys: string[] = [];

  // Step 1: Apply local .env values (lowest priority among .env sources)
  for (const key of Object.keys(localEnv)) {
    if (osEnvSnapshot.has(key)) {
      // OS wins - track this key as OS-preserved
      if (!osKeys.includes(key)) {
        osKeys.push(key);
      }
      logger.debug(`Variable '${key}' preserved from OS environment (local .env skipped)`);
      continue;
    }
    process.env[key] = localEnv[key];
    variables[key] = localEnv[key];
    sources[key] = 'local';
    localKeys.push(key);
    logger.debug(`Variable '${key}' set from local .env`);
  }

  // Step 2: Apply remote .env values (overrides local, but not OS)
  for (const key of Object.keys(remoteEnv)) {
    if (osEnvSnapshot.has(key)) {
      // OS wins - track this key as OS-preserved
      if (!osKeys.includes(key)) {
        osKeys.push(key);
      }
      logger.debug(`Variable '${key}' preserved from OS environment (remote .env skipped)`);
      continue;
    }
    process.env[key] = remoteEnv[key];
    variables[key] = remoteEnv[key];
    sources[key] = 'remote';
    remoteKeys.push(key);
    logger.debug(`Variable '${key}' set from remote .env`);
  }

  // For OS-preserved keys, capture their current values in the variables map
  for (const key of osKeys) {
    const osValue = process.env[key];
    if (osValue !== undefined) {
      variables[key] = osValue;
      sources[key] = 'os';
    }
  }

  logger.info(
    `Applied ${localKeys.length} local vars, ${remoteKeys.length} remote vars, ${osKeys.length} OS-preserved vars`,
  );

  return {
    variables,
    sources,
    localKeys,
    remoteKeys,
    osKeys,
  };
}
