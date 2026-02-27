import { describe, it, expect } from 'vitest';
import { parseBlobUrl } from '../src/config/parser.js';
import { ConfigurationError } from '../src/errors/index.js';

describe('parseBlobUrl', () => {
  it('parses a valid URL with account and container', () => {
    const result = parseBlobUrl(
      'https://myaccount.blob.core.windows.net/mycontainer',
    );
    expect(result.accountUrl).toBe('https://myaccount.blob.core.windows.net');
    expect(result.containerName).toBe('mycontainer');
    expect(result.prefix).toBe('');
  });

  it('parses a valid URL with prefix and adds trailing slash', () => {
    const result = parseBlobUrl(
      'https://myaccount.blob.core.windows.net/mycontainer/path/to/dir',
    );
    expect(result.accountUrl).toBe('https://myaccount.blob.core.windows.net');
    expect(result.containerName).toBe('mycontainer');
    expect(result.prefix).toBe('path/to/dir/');
  });

  it('throws ConfigurationError for an invalid URL', () => {
    expect(() => parseBlobUrl('not-a-url')).toThrow(ConfigurationError);
    try {
      parseBlobUrl('not-a-url');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).parameter).toBe('AZURE_VENV');
    }
  });

  it('throws ConfigurationError for HTTP scheme', () => {
    expect(() =>
      parseBlobUrl('http://myaccount.blob.core.windows.net/mycontainer'),
    ).toThrow(ConfigurationError);
    try {
      parseBlobUrl('http://myaccount.blob.core.windows.net/mycontainer');
    } catch (e) {
      expect((e as ConfigurationError).parameter).toBe('AZURE_VENV');
      expect((e as ConfigurationError).message).toContain('HTTPS');
    }
  });

  it('throws ConfigurationError for non-blob host', () => {
    expect(() =>
      parseBlobUrl('https://myaccount.example.com/mycontainer'),
    ).toThrow(ConfigurationError);
    try {
      parseBlobUrl('https://myaccount.example.com/mycontainer');
    } catch (e) {
      expect((e as ConfigurationError).parameter).toBe('AZURE_VENV');
      expect((e as ConfigurationError).message).toContain(
        '.blob.core.windows.net',
      );
    }
  });

  it('throws ConfigurationError when no container in path', () => {
    expect(() =>
      parseBlobUrl('https://myaccount.blob.core.windows.net'),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseBlobUrl('https://myaccount.blob.core.windows.net/'),
    ).toThrow(ConfigurationError);
  });

  it('parses a URL with query params correctly (ignores them)', () => {
    const result = parseBlobUrl(
      'https://myaccount.blob.core.windows.net/mycontainer/prefix?sv=2020-08-04&ss=b',
    );
    expect(result.accountUrl).toBe('https://myaccount.blob.core.windows.net');
    expect(result.containerName).toBe('mycontainer');
    expect(result.prefix).toBe('prefix/');
  });

  it('prefix never starts with a slash', () => {
    const result = parseBlobUrl(
      'https://myaccount.blob.core.windows.net/mycontainer/a/b/c',
    );
    expect(result.prefix).toBe('a/b/c/');
    expect(result.prefix.startsWith('/')).toBe(false);
  });

  it('accountUrl has no trailing slash', () => {
    const result = parseBlobUrl(
      'https://myaccount.blob.core.windows.net/mycontainer',
    );
    expect(result.accountUrl.endsWith('/')).toBe(false);
  });
});
