import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock config before importing scaffold so Zod validation doesn't run
vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake-token',
    SUPERGROUP_ID: -100123456789,
    NEW_PROJECTS_TOPIC_ID: 1,
    OWNER_USER_ID: 999,
    ANTHROPIC_API_KEY: 'fake-key',
    PROJECTS_BASE_DIR: '/tmp',
    DATA_DIR: '/tmp',
    LOG_LEVEL: 'info',
  },
}));

import { expandPath } from '../projects/scaffold.js';

describe('expandPath', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/home/testuser';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('expands a leading ~ to the HOME directory', () => {
    expect(expandPath('~/foo')).toBe('/home/testuser/foo');
  });

  it('expands a bare ~ to the HOME directory', () => {
    expect(expandPath('~')).toBe('/home/testuser');
  });

  it('expands ~/nested/deep/path correctly', () => {
    expect(expandPath('~/projects/claude-code/telegram')).toBe(
      '/home/testuser/projects/claude-code/telegram'
    );
  });

  it('does not modify an absolute path starting with /', () => {
    expect(expandPath('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('does not modify an absolute path that already has HOME prefix', () => {
    expect(expandPath('/home/testuser/foo')).toBe('/home/testuser/foo');
  });

  it('does not modify a relative path without ~', () => {
    expect(expandPath('relative/path')).toBe('relative/path');
  });

  it('does not expand ~ that appears in the middle of the path', () => {
    expect(expandPath('/some/~path')).toBe('/some/~path');
  });

  it('uses empty string when HOME is undefined', () => {
    delete process.env.HOME;
    expect(expandPath('~/foo')).toBe('/foo');
  });

  it('preserves trailing slashes', () => {
    expect(expandPath('~/foo/')).toBe('/home/testuser/foo/');
  });
});
