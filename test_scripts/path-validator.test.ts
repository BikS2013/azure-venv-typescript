import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { stripPrefix, validateAndResolvePath } from '../src/sync/path-validator.js';
import { PathTraversalError } from '../src/errors/index.js';

describe('stripPrefix', () => {
  it('should strip a normal prefix from blob name', () => {
    const result = stripPrefix('config/prod/settings.json', 'config/prod/');
    expect(result).toBe('settings.json');
  });

  it('should return blob name unchanged when prefix is empty', () => {
    const result = stripPrefix('settings.json', '');
    expect(result).toBe('settings.json');
  });

  it('should throw PathTraversalError when blob does not start with prefix', () => {
    expect(() => stripPrefix('other/settings.json', 'config/prod/')).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError when result is empty after stripping', () => {
    expect(() => stripPrefix('config/prod/', 'config/prod/')).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError when result is "/" after stripping', () => {
    // "config/prod//" minus prefix "config/prod/" leaves "/", which is treated as empty
    expect(() => stripPrefix('config/prod//', 'config/prod/')).toThrow(
      PathTraversalError,
    );
  });
});

describe('validateAndResolvePath', () => {
  const rootDir = '/app/root';

  it('should resolve a normal relative path to an absolute path under rootDir', () => {
    const result = validateAndResolvePath('file.txt', rootDir);
    expect(result).toBe(path.resolve(rootDir, 'file.txt'));
  });

  it('should throw PathTraversalError for path with ".."', () => {
    expect(() => validateAndResolvePath('../escape.txt', rootDir)).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError for absolute path', () => {
    expect(() => validateAndResolvePath('/etc/passwd', rootDir)).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError for URL-encoded traversal (%2e%2e)', () => {
    expect(() => validateAndResolvePath('%2e%2e/escape.txt', rootDir)).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError for empty path', () => {
    expect(() => validateAndResolvePath('', rootDir)).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError for whitespace-only path', () => {
    expect(() => validateAndResolvePath('   ', rootDir)).toThrow(
      PathTraversalError,
    );
  });

  it('should throw PathTraversalError for path that resolves outside rootDir', () => {
    // A path with embedded ".." that tries to escape
    expect(() =>
      validateAndResolvePath('sub/../../escape.txt', rootDir),
    ).toThrow(PathTraversalError);
  });

  it('should resolve nested path correctly', () => {
    const result = validateAndResolvePath('sub/dir/file.txt', rootDir);
    expect(result).toBe(path.resolve(rootDir, 'sub/dir/file.txt'));
  });
});
