/**
 * Base error class for all azure-venv errors.
 * All error messages are sanitized to remove SAS tokens before storage.
 */
export class AzureVenvError extends Error {
  /** Machine-readable error code for programmatic handling. */
  public readonly code: string;

  constructor(message: string, code: string = 'AZURE_VENV_ERROR') {
    super(message);
    this.name = 'AzureVenvError';
    this.code = code;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
