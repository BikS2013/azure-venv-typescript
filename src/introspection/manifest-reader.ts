import type { SyncManifest, SyncedFileInfo } from '../types/index.js';

/**
 * Convert manifest entries to a flat, sorted list of SyncedFileInfo objects.
 *
 * @param manifest - The sync manifest after sync completes.
 * @returns Flat list of SyncedFileInfo, sorted alphabetically by localPath.
 */
export function manifestToSyncedFiles(manifest: SyncManifest): SyncedFileInfo[] {
  const entries = Object.values(manifest.entries);

  return entries
    .map((entry) => ({
      localPath: entry.localPath.replace(/\\/g, '/'),
      blobName: entry.blobName,
      size: entry.contentLength,
      lastModified: entry.lastModified,
      etag: entry.etag,
    }))
    .sort((a, b) => a.localPath.localeCompare(b.localPath));
}
