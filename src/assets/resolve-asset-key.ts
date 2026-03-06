/**
 * Resolve an environment variable name to an asset key.
 *
 * Reads `process.env[envVarName]` and returns its value as an asset key
 * for use with AssetStore.getAsset().
 *
 * @param envVarName - The name of the environment variable to read.
 * @returns The asset key string from the environment variable.
 * @throws {Error} If the environment variable is not set or is empty.
 *
 * @example
 * ```typescript
 * // process.env.FILTER_WITH_SAMPLE = "langgraph-monitor/prompts/filter_with_sample.md"
 * const key = resolveAssetKey('FILTER_WITH_SAMPLE');
 * const content = store.getAsset(key);
 * ```
 */
export function resolveAssetKey(envVarName: string): string {
  const value = process.env[envVarName];
  if (!value) {
    throw new Error(
      `Environment variable "${envVarName}" is not set or is empty. ` +
      'Cannot resolve asset key.',
    );
  }
  return value;
}
