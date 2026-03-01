import type { BlobContent } from '../types/index.js';

/**
 * Return a flat, sorted list of BlobContent objects.
 * This is a convenience pass-through that ensures consistent sorting by relativePath.
 *
 * @param blobs - The in-memory blob contents after sync.
 * @returns Sorted array of BlobContent (by relativePath, ascending).
 */
export function sortBlobs(blobs: readonly BlobContent[]): BlobContent[] {
  return [...blobs].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
