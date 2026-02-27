import { describe, it, expect } from 'vitest';
import {
  AzureVenvError,
  ConfigurationError,
  AzureConnectionError,
  AuthenticationError,
  SyncError,
  PathTraversalError,
} from '../src/errors/index.js';

describe('AzureVenvError (base)', () => {
  it('is an instance of Error', () => {
    const err = new AzureVenvError('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AzureVenvError);
  });

  it('has the correct default code', () => {
    const err = new AzureVenvError('test');
    expect(err.code).toBe('AZURE_VENV_ERROR');
  });

  it('allows a custom code', () => {
    const err = new AzureVenvError('test', 'CUSTOM_CODE');
    expect(err.code).toBe('CUSTOM_CODE');
  });

  it('sets the name property', () => {
    const err = new AzureVenvError('test');
    expect(err.name).toBe('AzureVenvError');
  });

  it('stores the message', () => {
    const err = new AzureVenvError('detailed message');
    expect(err.message).toBe('detailed message');
  });
});

describe('ConfigurationError', () => {
  it('is an instance of AzureVenvError and Error', () => {
    const err = new ConfigurationError('bad config', 'MY_PARAM');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AzureVenvError);
    expect(err).toBeInstanceOf(ConfigurationError);
  });

  it('has code CONFIGURATION_ERROR', () => {
    const err = new ConfigurationError('bad config', 'MY_PARAM');
    expect(err.code).toBe('CONFIGURATION_ERROR');
  });

  it('stores the parameter name', () => {
    const err = new ConfigurationError('missing', 'AZURE_VENV');
    expect(err.parameter).toBe('AZURE_VENV');
  });

  it('sets the name property', () => {
    const err = new ConfigurationError('msg', 'p');
    expect(err.name).toBe('ConfigurationError');
  });
});

describe('AzureConnectionError', () => {
  it('is an instance of AzureVenvError and Error', () => {
    const err = new AzureConnectionError('connection failed');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AzureVenvError);
    expect(err).toBeInstanceOf(AzureConnectionError);
  });

  it('has code AZURE_CONNECTION_ERROR', () => {
    const err = new AzureConnectionError('fail');
    expect(err.code).toBe('AZURE_CONNECTION_ERROR');
  });

  it('stores statusCode when provided', () => {
    const err = new AzureConnectionError('not found', 404);
    expect(err.statusCode).toBe(404);
  });

  it('statusCode is undefined when not provided', () => {
    const err = new AzureConnectionError('timeout');
    expect(err.statusCode).toBeUndefined();
  });

  it('sets the name property', () => {
    const err = new AzureConnectionError('msg');
    expect(err.name).toBe('AzureConnectionError');
  });
});

describe('AuthenticationError', () => {
  it('is an instance of AzureVenvError and Error', () => {
    const err = new AuthenticationError('auth failed');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AzureVenvError);
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('has code AUTHENTICATION_ERROR', () => {
    const err = new AuthenticationError('expired');
    expect(err.code).toBe('AUTHENTICATION_ERROR');
  });

  it('stores expiryDate when provided', () => {
    const date = new Date('2025-06-01T00:00:00Z');
    const err = new AuthenticationError('expired', date);
    expect(err.expiryDate).toBe(date);
  });

  it('expiryDate is undefined when not provided', () => {
    const err = new AuthenticationError('auth failed');
    expect(err.expiryDate).toBeUndefined();
  });

  it('sets the name property', () => {
    const err = new AuthenticationError('msg');
    expect(err.name).toBe('AuthenticationError');
  });
});

describe('SyncError', () => {
  it('is an instance of AzureVenvError and Error', () => {
    const err = new SyncError('sync failed');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AzureVenvError);
    expect(err).toBeInstanceOf(SyncError);
  });

  it('has code SYNC_ERROR', () => {
    const err = new SyncError('disk full');
    expect(err.code).toBe('SYNC_ERROR');
  });

  it('sets the name property', () => {
    const err = new SyncError('msg');
    expect(err.name).toBe('SyncError');
  });
});

describe('PathTraversalError', () => {
  it('is an instance of AzureVenvError and Error', () => {
    const err = new PathTraversalError('traversal detected', '../evil.txt');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AzureVenvError);
    expect(err).toBeInstanceOf(PathTraversalError);
  });

  it('has code PATH_TRAVERSAL_ERROR', () => {
    const err = new PathTraversalError('traversal', '../evil.txt');
    expect(err.code).toBe('PATH_TRAVERSAL_ERROR');
  });

  it('stores the blobName', () => {
    const err = new PathTraversalError('traversal', '../../etc/passwd');
    expect(err.blobName).toBe('../../etc/passwd');
  });

  it('sets the name property', () => {
    const err = new PathTraversalError('msg', 'blob');
    expect(err.name).toBe('PathTraversalError');
  });
});
