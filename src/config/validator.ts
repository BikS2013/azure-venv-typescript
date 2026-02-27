import { z } from 'zod';
import { AzureVenvConfig, AzureVenvOptions } from './types.js';
import { ConfigurationError, AuthenticationError } from '../errors/index.js';
import { parseBlobUrl } from './parser.js';

/**
 * Zod schema for validating raw environment variables.
 * Used internally by validateConfig().
 *
 * Required fields (AZURE_VENV, AZURE_VENV_SAS_TOKEN) have no defaults --
 * their absence is detected BEFORE Zod validation in validateConfig().
 */
const azureVenvEnvSchema = z.object({
  AZURE_VENV: z.string().url().refine(
    (url) => url.startsWith('https://'),
    { message: 'AZURE_VENV must use HTTPS scheme' },
  ),
  AZURE_VENV_SAS_TOKEN: z.string().min(1, 'AZURE_VENV_SAS_TOKEN must not be empty'),
  AZURE_VENV_SAS_EXPIRY: z.string().datetime().optional(),
  AZURE_VENV_SYNC_MODE: z.enum(['full', 'incremental']).default('full'),
  AZURE_VENV_FAIL_ON_ERROR: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AZURE_VENV_CONCURRENCY: z
    .string()
    .regex(/^\d+$/, 'AZURE_VENV_CONCURRENCY must be a positive integer')
    .default('5')
    .transform(Number)
    .refine((n) => n > 0 && n <= 50, 'AZURE_VENV_CONCURRENCY must be between 1 and 50'),
  AZURE_VENV_TIMEOUT: z
    .string()
    .regex(/^\d+$/, 'AZURE_VENV_TIMEOUT must be a positive integer')
    .default('30000')
    .transform(Number)
    .refine((n) => n >= 1000 && n <= 300000, 'AZURE_VENV_TIMEOUT must be between 1000 and 300000'),
  AZURE_VENV_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AZURE_VENV_MAX_BLOB_SIZE: z
    .string()
    .regex(/^\d+$/, 'AZURE_VENV_MAX_BLOB_SIZE must be a positive integer')
    .default('104857600')
    .transform(Number)
    .refine((n) => n >= 1048576, 'AZURE_VENV_MAX_BLOB_SIZE must be at least 1048576 (1MB)'),
  AZURE_VENV_POLL_INTERVAL: z
    .string()
    .regex(/^\d+$/, 'AZURE_VENV_POLL_INTERVAL must be a positive integer')
    .default('30000')
    .transform(Number)
    .refine((n) => n >= 5000 && n <= 3600000, 'AZURE_VENV_POLL_INTERVAL must be between 5000 and 3600000'),
  AZURE_VENV_WATCH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * Parse SAS expiry from either the AZURE_VENV_SAS_EXPIRY env var or the 'se' parameter
 * within the SAS token itself.
 *
 * @param expiryEnv - Value of AZURE_VENV_SAS_EXPIRY if set.
 * @param sasToken - The SAS token string.
 * @returns Parsed Date or null if no expiry could be determined.
 */
function parseSasExpiry(expiryEnv: string | undefined, sasToken: string): Date | null {
  // Prefer explicit AZURE_VENV_SAS_EXPIRY if provided
  if (expiryEnv) {
    const date = new Date(expiryEnv);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // Fall back to 'se' parameter in the SAS token
  try {
    const params = new URLSearchParams(sasToken);
    const seValue = params.get('se');
    if (seValue) {
      const date = new Date(seValue);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  } catch {
    // SAS token may not be valid URL params format; ignore
  }

  return null;
}

/**
 * Check SAS token expiry and throw AuthenticationError if expired.
 * Logs a warning if the token expires within 7 days.
 *
 * @param expiry - The parsed expiry date, or null if unknown.
 */
function checkSasExpiry(expiry: Date | null): void {
  if (expiry === null) {
    return;
  }

  const now = new Date();

  // If expired, throw AuthenticationError
  if (expiry.getTime() <= now.getTime()) {
    throw new AuthenticationError(
      `SAS token has expired (expiry: ${expiry.toISOString()})`,
      expiry,
    );
  }

  // Warn if expiring within 7 days
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (expiry.getTime() - now.getTime() <= sevenDaysMs) {
    console.warn(
      `[azure-venv] [WARN] SAS token expires within 7 days (expiry: ${expiry.toISOString()})`,
    );
  }
}

/**
 * Check process.env for AZURE_VENV configuration and validate if present.
 *
 * @param env - Environment variables record (typically process.env).
 * @param options - User-provided options overrides (optional fields only).
 *
 * @returns null if AZURE_VENV is not set (library is not configured, no error).
 * @returns AzureVenvConfig if AZURE_VENV is set and configuration is valid.
 *
 * @throws ConfigurationError if:
 *   - AZURE_VENV is set but AZURE_VENV_SAS_TOKEN is missing
 *   - AZURE_VENV fails URL validation (delegates to parseBlobUrl)
 *   - AZURE_VENV_SAS_TOKEN is empty string
 *   - Any optional parameter has an invalid value
 *
 * @throws AuthenticationError if:
 *   - SAS token is detected as expired (via 'se' param or AZURE_VENV_SAS_EXPIRY)
 *
 * Contract:
 *   - Options override env vars override defaults
 *   - Returns a fully resolved AzureVenvConfig with all fields populated
 *   - Operational defaults: syncMode='full', failOnError=false,
 *     concurrency=5, timeout=30000, logLevel='info'
 *   - Warns if SAS token expires within 7 days
 */
export function validateConfig(
  env: Record<string, string | undefined>,
  options?: AzureVenvOptions,
): AzureVenvConfig | null {
  const azureVenv = env['AZURE_VENV'];
  const sasToken = env['AZURE_VENV_SAS_TOKEN'];

  // If AZURE_VENV is not set
  if (!azureVenv) {
    // If AZURE_VENV_SAS_TOKEN is also not set, the library is not configured -- return null
    if (!sasToken) {
      return null;
    }
    // AZURE_VENV_SAS_TOKEN is set but AZURE_VENV is missing -- partial config error
    throw new ConfigurationError(
      'AZURE_VENV_SAS_TOKEN is set but AZURE_VENV is missing. Both must be provided.',
      'AZURE_VENV',
    );
  }

  // AZURE_VENV is set but AZURE_VENV_SAS_TOKEN is missing -- partial config error
  if (!sasToken) {
    throw new ConfigurationError(
      'AZURE_VENV is set but AZURE_VENV_SAS_TOKEN is missing. Both must be provided.',
      'AZURE_VENV_SAS_TOKEN',
    );
  }

  // At this point both azureVenv and sasToken are guaranteed to be non-empty strings

  // Build the raw env object for Zod validation, filtering out undefined values
  const rawEnv: Record<string, string> = {
    AZURE_VENV: azureVenv,
    AZURE_VENV_SAS_TOKEN: sasToken,
  };

  // Include optional env vars only if they are defined
  const optionalKeys = [
    'AZURE_VENV_SAS_EXPIRY',
    'AZURE_VENV_SYNC_MODE',
    'AZURE_VENV_FAIL_ON_ERROR',
    'AZURE_VENV_CONCURRENCY',
    'AZURE_VENV_TIMEOUT',
    'AZURE_VENV_LOG_LEVEL',
    'AZURE_VENV_MAX_BLOB_SIZE',
    'AZURE_VENV_POLL_INTERVAL',
    'AZURE_VENV_WATCH_ENABLED',
  ] as const;

  for (const key of optionalKeys) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      rawEnv[key] = value;
    }
  }

  // Validate via Zod schema
  const parseResult = azureVenvEnvSchema.safeParse(rawEnv);

  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const paramName = firstIssue.path.length > 0
      ? String(firstIssue.path[0])
      : 'AZURE_VENV';
    throw new ConfigurationError(
      `Configuration validation failed: ${firstIssue.message}`,
      paramName,
    );
  }

  const validated = parseResult.data;

  // Parse the AZURE_VENV URL (delegates detailed validation to parseBlobUrl)
  const blobUrl = parseBlobUrl(validated.AZURE_VENV);

  // Strip leading '?' from SAS token if present
  const cleanSasToken = validated.AZURE_VENV_SAS_TOKEN.startsWith('?')
    ? validated.AZURE_VENV_SAS_TOKEN.slice(1)
    : validated.AZURE_VENV_SAS_TOKEN;

  // Parse SAS expiry
  const sasExpiry = parseSasExpiry(validated.AZURE_VENV_SAS_EXPIRY, cleanSasToken);

  // Check if SAS token is expired (throws AuthenticationError if so)
  checkSasExpiry(sasExpiry);

  // Build the final config, applying options overrides over env vars over defaults
  const config: AzureVenvConfig = {
    blobUrl,
    sasToken: cleanSasToken,
    sasExpiry,
    syncMode: options?.syncMode ?? validated.AZURE_VENV_SYNC_MODE,
    failOnError: options?.failOnError ?? validated.AZURE_VENV_FAIL_ON_ERROR,
    concurrency: options?.concurrency ?? validated.AZURE_VENV_CONCURRENCY,
    timeout: options?.timeout ?? validated.AZURE_VENV_TIMEOUT,
    logLevel: options?.logLevel ?? validated.AZURE_VENV_LOG_LEVEL,
    rootDir: options?.rootDir ?? process.cwd(),
    envPath: options?.envPath ?? '.env',
    maxBlobSize: options?.maxBlobSize ?? validated.AZURE_VENV_MAX_BLOB_SIZE,
    pollInterval: options?.pollInterval ?? validated.AZURE_VENV_POLL_INTERVAL,
    watchEnabled: options?.watchEnabled ?? validated.AZURE_VENV_WATCH_ENABLED,
  };

  return config;
}
