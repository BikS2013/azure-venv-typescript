import { AzureVenvError } from './base.js';

/**
 * Thrown when required configuration is missing or invalid.
 *
 * Trigger conditions:
 * - AZURE_VENV is present but AZURE_VENV_SAS_TOKEN is missing (or vice versa)
 * - AZURE_VENV is not a valid HTTPS URL
 * - AZURE_VENV URL does not contain a container name
 * - AZURE_VENV_SYNC_MODE has an invalid value (not 'full' or 'incremental')
 * - AZURE_VENV_CONCURRENCY is not a positive integer
 * - AZURE_VENV_TIMEOUT is not a positive integer
 * - AZURE_VENV_LOG_LEVEL is not a valid log level
 */
export class ConfigurationError extends AzureVenvError {
  /** The configuration parameter name that caused the error. */
  public readonly parameter: string;

  constructor(message: string, parameter: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
    this.parameter = parameter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
