import { ParsedBlobUrl } from './types.js';
import { ConfigurationError } from '../errors/index.js';

/**
 * Parse an AZURE_VENV URL string into its component parts.
 *
 * @param azureVenvUrl - The AZURE_VENV environment variable value.
 *   Format: https://<account>.blob.core.windows.net/<container>[/<prefix>]
 *
 * @returns ParsedBlobUrl with accountUrl, containerName, and prefix.
 *
 * @throws ConfigurationError with parameter='AZURE_VENV' if:
 *   - URL is not a valid URL (cannot be parsed by new URL())
 *   - URL scheme is not 'https:'
 *   - URL host does not end with '.blob.core.windows.net'
 *   - URL path does not contain at least one segment (container name)
 *
 * Contract:
 *   - accountUrl is always "https://<host>" with no trailing slash
 *   - containerName is always the first path segment
 *   - prefix is always empty string OR a path ending with '/'
 *   - prefix never starts with '/'
 *   - SAS token must NOT be part of the URL
 */
export function parseBlobUrl(azureVenvUrl: string): ParsedBlobUrl {
  // Attempt to parse URL
  let parsed: URL;
  try {
    parsed = new URL(azureVenvUrl);
  } catch {
    throw new ConfigurationError(
      `AZURE_VENV is not a valid URL: "${azureVenvUrl}"`,
      'AZURE_VENV',
    );
  }

  // Validate HTTPS protocol
  if (parsed.protocol !== 'https:') {
    throw new ConfigurationError(
      `AZURE_VENV must use HTTPS scheme, got "${parsed.protocol}"`,
      'AZURE_VENV',
    );
  }

  // Validate host ends with .blob.core.windows.net
  if (!parsed.hostname.endsWith('.blob.core.windows.net')) {
    throw new ConfigurationError(
      `AZURE_VENV host must end with ".blob.core.windows.net", got "${parsed.hostname}"`,
      'AZURE_VENV',
    );
  }

  // Extract path segments (remove leading slash and split)
  const pathSegments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0);

  // Validate that at least one path segment exists (container name)
  if (pathSegments.length === 0) {
    throw new ConfigurationError(
      'AZURE_VENV URL must contain a container name in the path',
      'AZURE_VENV',
    );
  }

  // Build accountUrl (protocol + host, no trailing slash)
  const accountUrl = `${parsed.protocol}//${parsed.hostname}`;

  // First segment is the container name
  const containerName = pathSegments[0];

  // Remaining segments form the prefix
  let prefix = '';
  if (pathSegments.length > 1) {
    prefix = pathSegments.slice(1).join('/') + '/';
  }

  return {
    accountUrl,
    containerName,
    prefix,
  };
}
