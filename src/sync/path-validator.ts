import * as path from 'node:path';

import { PathTraversalError } from '../errors/index.js';

/**
 * Strip a prefix from a blob name to produce a relative local path.
 *
 * @param blobName - Full blob name including prefix. Example: "config/prod/settings.json"
 * @param prefix - The prefix to strip. Example: "config/prod/"
 * @returns Relative path with prefix removed. Example: "settings.json"
 *
 * @throws PathTraversalError if the resulting relative path is empty after stripping,
 *   or the blob name does not start with the prefix.
 */
export function stripPrefix(blobName: string, prefix: string): string {
  if (prefix === '') {
    return blobName;
  }

  if (!blobName.startsWith(prefix)) {
    throw new PathTraversalError(
      `Blob name "${blobName}" does not start with expected prefix "${prefix}"`,
      blobName,
    );
  }

  const relativePath = blobName.slice(prefix.length);

  if (relativePath === '' || relativePath === '/') {
    throw new PathTraversalError(
      `Blob name "${blobName}" resolves to empty path after stripping prefix "${prefix}"`,
      blobName,
    );
  }

  return relativePath;
}

/**
 * Validate and resolve a blob name to a safe local file path.
 *
 * Two-layer defense:
 * Layer 1: Reject blob names containing '..' segments or absolute paths.
 * Layer 2: After path.resolve(), verify the result is within rootDir.
 *
 * @param blobName - Full blob name in Azure (prefix will be stripped).
 * @param rootDir - Absolute path to the application root directory.
 * @returns Absolute local file path that is guaranteed to be under rootDir.
 *
 * @throws PathTraversalError if any security check fails.
 */
export function validateAndResolvePath(blobName: string, rootDir: string): string {
  // URL-decode the blob name to catch encoded traversal sequences like %2e%2e
  let decoded: string;
  try {
    decoded = decodeURIComponent(blobName);
  } catch {
    // If decoding fails, use the original name
    decoded = blobName;
  }

  // Layer 1a: Reject blob names containing '..' path segments
  const segments = decoded.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === '..') {
      throw new PathTraversalError(
        `Blob name "${blobName}" contains path traversal segment ".."`,
        blobName,
      );
    }
  }

  // Layer 1b: Reject absolute paths
  if (path.isAbsolute(decoded)) {
    throw new PathTraversalError(
      `Blob name "${blobName}" resolves to an absolute path`,
      blobName,
    );
  }

  // Layer 1c: Reject empty or whitespace-only paths
  if (decoded.trim() === '') {
    throw new PathTraversalError(
      `Blob name "${blobName}" is empty or contains only whitespace`,
      blobName,
    );
  }

  // Resolve to absolute path
  const resolvedPath = path.resolve(rootDir, decoded);

  // Layer 2: Verify resolved path is within rootDir
  // Ensure rootDir ends with separator for proper prefix checking
  const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;

  if (!resolvedPath.startsWith(normalizedRoot) && resolvedPath !== rootDir) {
    throw new PathTraversalError(
      `Resolved path "${resolvedPath}" escapes root directory "${rootDir}"`,
      blobName,
    );
  }

  return resolvedPath;
}
