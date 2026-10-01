import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'http';
import { isAuthorized, canStartApi } from '../api/server.js';

const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;

describe('API auth', () => {
  it('is open without a key', () => {
    expect(isAuthorized(req(), undefined)).toBe(true);
  });

  it('requires the exact bearer token when a key is set', () => {
    expect(isAuthorized(req('Bearer s3cret'), 's3cret')).toBe(true);
    expect(isAuthorized(req('Bearer wrong!'), 's3cret')).toBe(false);
    expect(isAuthorized(req('Bearer s3cretX'), 's3cret')).toBe(false);
    expect(isAuthorized(req(), 's3cret')).toBe(false);
  });
});

describe('API binding', () => {
  it('serves loopback without a key', () => {
    expect(canStartApi('127.0.0.1', undefined)).toBe(true);
    expect(canStartApi('::1', undefined)).toBe(true);
  });

  it('refuses other interfaces without a key', () => {
    expect(canStartApi('0.0.0.0', undefined)).toBe(false);
    expect(canStartApi('192.168.1.10', '')).toBe(false);
    expect(canStartApi('0.0.0.0', 'k')).toBe(true);
  });
});
