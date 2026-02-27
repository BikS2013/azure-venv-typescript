import { AzureVenvError } from './base.js';

/**
 * Thrown when the Azure Blob Storage service cannot be reached.
 *
 * Trigger conditions:
 * - Network unreachable (REQUEST_SEND_ERROR)
 * - DNS resolution failure
 * - Connection timeout (ETIMEDOUT)
 * - Container not found (404)
 * - Any RestError not related to authentication
 */
export class AzureConnectionError extends AzureVenvError {
  /** HTTP status code from the Azure response, if available. */
  public readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message, 'AZURE_CONNECTION_ERROR');
    this.name = 'AzureConnectionError';
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when SAS token authentication fails.
 *
 * Trigger conditions:
 * - SAS token is expired (403 with AuthenticationFailed)
 * - SAS token has insufficient permissions (403 with AuthorizationFailure)
 * - SAS token is malformed
 * - Proactive expiry check detects the token has expired
 */
export class AuthenticationError extends AzureVenvError {
  /** The expiry date of the SAS token, if it could be parsed. */
  public readonly expiryDate: Date | undefined;

  constructor(message: string, expiryDate?: Date) {
    super(message, 'AUTHENTICATION_ERROR');
    this.name = 'AuthenticationError';
    this.expiryDate = expiryDate;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
