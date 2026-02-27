import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import type { SyncManifest, ManifestEntry, BlobInfo } from '../types/index.js';
import type { Logger } from '../logging/logger.js';
import { SyncError } from '../errors/index.js';

/**
 * Default empty manifest returned when no manifest file exists or the file is corrupted.
 */
function createEmptyManifest(): SyncManifest {
  return {
    version: 1,
    lastSyncAt: '',
    entries: {},
  };
}

/**
 * Manages the .azure-venv-manifest.json file for incremental sync tracking.
 */
export class ManifestManager {
  private readonly manifestPath: string;
  private readonly logger: Logger;

  /**
   * @param manifestPath - Absolute path to the manifest file.
   * @param logger - Logger instance.
   */
  constructor(manifestPath: string, logger: Logger) {
    this.manifestPath = manifestPath;
    this.logger = logger;
  }

  /**
   * Load the manifest from disk.
   *
   * @returns The loaded SyncManifest, or a fresh empty manifest if the file does not exist
   *          or is corrupted. Never throws.
   */
  async load(): Promise<SyncManifest> {
    try {
      const content = await fs.readFile(this.manifestPath, 'utf-8');
      const parsed = JSON.parse(content) as SyncManifest;

      // Basic schema validation
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.version !== 'number' ||
        typeof parsed.entries !== 'object' ||
        parsed.entries === null
      ) {
        this.logger.warn(
          `Manifest file "${this.manifestPath}" has invalid schema, returning empty manifest`,
        );
        return createEmptyManifest();
      }

      this.logger.debug(
        `Loaded manifest with ${Object.keys(parsed.entries).length} entries`,
      );
      return parsed;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        this.logger.debug('No manifest file found, starting with empty manifest');
        return createEmptyManifest();
      }

      this.logger.warn(
        `Failed to load manifest from "${this.manifestPath}": ${error instanceof Error ? error.message : String(error)}. Returning empty manifest.`,
      );
      return createEmptyManifest();
    }
  }

  /**
   * Save the manifest to disk atomically (write to temp file, then rename).
   *
   * @param manifest - The manifest to persist.
   * @throws SyncError if write fails.
   */
  async save(manifest: SyncManifest): Promise<void> {
    const updatedManifest: SyncManifest = {
      ...manifest,
      lastSyncAt: new Date().toISOString(),
    };

    const content = JSON.stringify(updatedManifest, null, 2);
    const dir = path.dirname(this.manifestPath);
    const tempPath = path.join(
      dir,
      `.manifest-tmp-${crypto.randomBytes(8).toString('hex')}`,
    );

    try {
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      // Write to temp file
      await fs.writeFile(tempPath, content, 'utf-8');

      // Atomic rename
      await fs.rename(tempPath, this.manifestPath);

      this.logger.debug(
        `Saved manifest with ${Object.keys(updatedManifest.entries).length} entries`,
      );
    } catch (error: unknown) {
      // Clean up temp file if rename failed
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }

      throw new SyncError(
        `Failed to save manifest to "${this.manifestPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a blob needs to be downloaded based on its ETag.
   *
   * @param blobInfo - The blob metadata from Azure.
   * @param manifest - Current manifest state.
   * @returns true if the blob needs downloading (new or changed), false if unchanged.
   */
  needsUpdate(blobInfo: BlobInfo, manifest: SyncManifest): boolean {
    const entry = manifest.entries[blobInfo.name];

    if (!entry) {
      return true;
    }

    return entry.etag !== blobInfo.etag;
  }

  /**
   * Create a manifest entry for a successfully synced blob.
   *
   * @param blobInfo - The blob metadata.
   * @param localPath - The relative local path (relative to rootDir).
   * @returns A new ManifestEntry.
   */
  createEntry(blobInfo: BlobInfo, localPath: string): ManifestEntry {
    return {
      blobName: blobInfo.name,
      etag: blobInfo.etag,
      lastModified: blobInfo.lastModified.toISOString(),
      contentLength: blobInfo.contentLength,
      localPath,
      syncedAt: new Date().toISOString(),
    };
  }
}
