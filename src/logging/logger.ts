import { LogLevel } from '../config/types.js';

/**
 * Logger interface used by all modules.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Numeric ordering for log levels. */
const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Sanitize a string by removing SAS token signatures and sensitive URL parameters.
 *
 * @param input - The string to sanitize.
 * @param sasToken - The full SAS token to redact.
 * @returns Sanitized string with sensitive values replaced by '[REDACTED]'.
 *
 * Contract:
 *   - If sasToken is empty string, only regex-based sanitization is applied
 *   - Replaces exact sasToken substring with '[REDACTED]'
 *   - Replaces sig=<value> patterns with sig=[REDACTED]
 *   - Returns the input unchanged if no sensitive patterns are found
 *   - This is a pure function
 */
export function sanitize(input: string, sasToken: string): string {
  let result = input;

  // Replace exact SAS token string if provided
  if (sasToken.length > 0) {
    // Use split/join for literal string replacement (avoids regex special chars)
    result = result.split(sasToken).join('[REDACTED]');
  }

  // Replace sig=<value> patterns (up to next '&' or end of string)
  result = result.replace(/sig=[^&]*/g, 'sig=[REDACTED]');

  // Replace se=<value> patterns (up to next '&' or end of string)
  result = result.replace(/se=[^&]*/g, 'se=[REDACTED]');

  return result;
}

/**
 * Create a Logger instance with SAS token sanitization.
 *
 * @param level - Minimum log level to emit. Messages below this level are suppressed.
 * @param sasToken - The SAS token string to sanitize from all output. Can be empty string
 *   if SAS token is not yet known (e.g., during bootstrap before config is validated).
 * @returns Logger instance.
 *
 * Contract:
 *   - All log output is formatted as: [azure-venv] [LEVEL] [ISO-timestamp] message
 *   - Before emitting ANY log line, the sanitizer replaces:
 *     a. The exact sasToken string with '[REDACTED]'
 *     b. Any URL query parameter named 'sig' with 'sig=[REDACTED]'
 *     c. Any URL query parameter named 'se' with 'se=[REDACTED]'
 *     d. Any string matching the pattern 'sig=...' up to the next '&' or end of string
 *   - Level ordering: debug < info < warn < error
 *   - Output goes to console.log (debug, info) and console.error (warn, error)
 *   - The ...args are JSON.stringified and appended to the message (also sanitized)
 */
export function createLogger(level: LogLevel, sasToken: string): Logger {
  const minLevel = LOG_LEVEL_ORDER[level];

  function formatArgs(args: unknown[]): string {
    if (args.length === 0) return '';
    const parts = args.map((arg) => {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    });
    return ' ' + parts.join(' ');
  }

  function emit(msgLevel: LogLevel, message: string, args: unknown[]): void {
    if (LOG_LEVEL_ORDER[msgLevel] < minLevel) return;

    const timestamp = new Date().toISOString();
    const prefix = `[azure-venv] [${msgLevel.toUpperCase()}] [${timestamp}]`;
    const argsStr = formatArgs(args);
    const raw = `${prefix} ${message}${argsStr}`;
    const sanitized = sanitize(raw, sasToken);

    if (msgLevel === 'debug' || msgLevel === 'info') {
      console.log(sanitized);
    } else {
      console.error(sanitized);
    }
  }

  return {
    debug(message: string, ...args: unknown[]): void {
      emit('debug', message, args);
    },
    info(message: string, ...args: unknown[]): void {
      emit('info', message, args);
    },
    warn(message: string, ...args: unknown[]): void {
      emit('warn', message, args);
    },
    error(message: string, ...args: unknown[]): void {
      emit('error', message, args);
    },
  };
}
