import { AzureVenvError } from './base.js';

/**
 * Thrown when a filesystem sync operation fails.
 *
 * Trigger conditions:
 * - Cannot create local directory (permission denied, disk full)
 * - Cannot write downloaded file to disk
 * - Manifest file is corrupted and cannot be parsed
 * - General orchestration failure during sync
 */
export class SyncError extends AzureVenvError {
  constructor(message: string) {
    super(message, 'SYNC_ERROR');
    this.name = 'SyncError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a blob name would resolve to a path outside the application root.
 *
 * Trigger conditions:
 * - Blob name contains '..' path segments
 * - Blob name is an absolute path
 * - Blob name contains URL-encoded traversal sequences (%2e%2e)
 * - Resolved path does not start with the root directory
 *
 * The offending blob is skipped (not downloaded). The error is caught by the sync engine
 * and recorded in SyncResult.failedBlobs.
 */
export class PathTraversalError extends AzureVenvError {
  /** The blob name that triggered the path traversal detection. */
  public readonly blobName: string;

  constructor(message: string, blobName: string) {
    super(message, 'PATH_TRAVERSAL_ERROR');
    this.name = 'PathTraversalError';
    this.blobName = blobName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
