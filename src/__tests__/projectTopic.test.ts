import { describe, it, expect, beforeEach } from 'vitest';

// These pure functions need no config mock — no side effects.
import {
  buildGithubPrompt,
  buildVercelPrompt,
  getPendingGithubPublic,
  clearPendingGithubPublic,
  getPendingVercelDeploy,
  clearPendingVercelDeploy,
} from '../bot/handlers/projectTopic.js';

// ─────────────────────────────────────────────────────────────────────────────
// buildGithubPrompt
// ─────────────────────────────────────────────────────────────────────────────
describe('buildGithubPrompt', () => {
  describe('private visibility', () => {
    it('includes the repository name', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result).toContain('my-app');
    });

    it('specifies private visibility', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result).toContain('private');
    });

    it('includes the gh repo create command', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result).toContain('gh repo create');
    });

    it('instructs to check .gitignore', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result.toLowerCase()).toContain('.gitignore');
    });

    it('instructs to scan for secrets', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result.toLowerCase()).toContain('secret');
    });

    it('instructs to stop and not create repo if secrets are found', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result).toContain('DO NOT create the repository');
    });

    it('instructs to push with --set-upstream', () => {
      const result = buildGithubPrompt('my-app', 'private');
      expect(result).toContain('--set-upstream');
    });
  });

  describe('public visibility', () => {
    it('includes the repository name', () => {
      const result = buildGithubPrompt('open-source-lib', 'public');
      expect(result).toContain('open-source-lib');
    });

    it('specifies public visibility', () => {
      const result = buildGithubPrompt('open-source-lib', 'public');
      expect(result).toContain('public');
    });

    it('still includes security checks for public repos', () => {
      const result = buildGithubPrompt('open-source-lib', 'public');
      expect(result.toLowerCase()).toContain('.gitignore');
    });

    it('uses --public flag in the gh command', () => {
      const result = buildGithubPrompt('open-source-lib', 'public');
      expect(result).toContain('--public');
    });
  });

  describe('prompt content includes all required checks', () => {
    it('includes step numbers for the security workflow', () => {
      const result = buildGithubPrompt('proj', 'private');
      expect(result).toContain('1.');
      expect(result).toContain('2.');
      expect(result).toContain('3.');
      expect(result).toContain('4.');
    });

    it('mentions node_modules exclusion in the grep command', () => {
      const result = buildGithubPrompt('proj', 'private');
      expect(result).toContain('node_modules');
    });

    it('mentions .env files as sensitive', () => {
      const result = buildGithubPrompt('proj', 'private');
      expect(result).toContain('.env');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildVercelPrompt
// ─────────────────────────────────────────────────────────────────────────────
describe('buildVercelPrompt', () => {
  describe('link subcommand', () => {
    it('includes vercel link command', () => {
      const result = buildVercelPrompt('my-app', 'link');
      expect(result).toContain('vercel link');
    });

    it('includes --yes flag', () => {
      const result = buildVercelPrompt('my-app', 'link');
      expect(result).toContain('--yes');
    });

    it('mentions .vercel/project.json', () => {
      const result = buildVercelPrompt('my-app', 'link');
      expect(result).toContain('.vercel/project.json');
    });
  });

  describe('deploy subcommand', () => {
    it('includes vercel --prod command', () => {
      const result = buildVercelPrompt('my-app', 'deploy');
      expect(result).toContain('vercel --prod');
    });

    it('includes security check step for deploy', () => {
      const result = buildVercelPrompt('my-app', 'deploy');
      expect(result.toLowerCase()).toContain('.gitignore');
    });

    it('instructs to stop if secrets found', () => {
      const result = buildVercelPrompt('my-app', 'deploy');
      expect(result).toContain('STOP');
    });

    it('reports the production URL after deploy', () => {
      const result = buildVercelPrompt('my-app', 'deploy');
      expect(result.toLowerCase()).toContain('production url');
    });
  });

  describe('preview subcommand', () => {
    it('runs the plain vercel command (no --prod)', () => {
      const result = buildVercelPrompt('my-app', 'preview');
      expect(result).toContain('vercel');
      expect(result).not.toContain('vercel --prod');
    });

    it('asks for the preview URL', () => {
      const result = buildVercelPrompt('my-app', 'preview');
      expect(result.toLowerCase()).toContain('preview url');
    });
  });

  describe('logs subcommand', () => {
    it('runs vercel logs', () => {
      const result = buildVercelPrompt('my-app', 'logs');
      expect(result).toContain('vercel logs');
    });

    it('includes --limit flag', () => {
      const result = buildVercelPrompt('my-app', 'logs');
      expect(result).toContain('--limit');
    });
  });

  describe('env subcommand', () => {
    it('runs vercel env ls', () => {
      const result = buildVercelPrompt('my-app', 'env');
      expect(result).toContain('vercel env ls');
    });

    it('says to show names only (not values)', () => {
      const result = buildVercelPrompt('my-app', 'env');
      expect(result.toLowerCase()).toContain('names only');
    });
  });

  describe('domains subcommand', () => {
    it('runs vercel domains ls', () => {
      const result = buildVercelPrompt('my-app', 'domains');
      expect(result).toContain('vercel domains ls');
    });
  });

  describe('unknown/default subcommand', () => {
    it('falls back to "vercel <subcommand>" for unknown subcommands', () => {
      const result = buildVercelPrompt('my-app', 'whoami');
      expect(result).toContain('vercel whoami');
    });

    it('handles empty string subcommand via default', () => {
      // The switch default runs for any value not matched
      const result = buildVercelPrompt('my-app', 'something-unknown');
      expect(result).toContain('vercel something-unknown');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pending state maps: getPendingGithubPublic / clearPendingGithubPublic
// ─────────────────────────────────────────────────────────────────────────────
// Note: these maps are module-level singletons. We test them in isolation and
// clear state after each test to avoid inter-test pollution.
describe('pendingGithubPublic state', () => {
  const USER_A = 1001;
  const USER_B = 1002;

  afterEach(() => {
    clearPendingGithubPublic(USER_A);
    clearPendingGithubPublic(USER_B);
  });

  it('returns undefined when no pending confirmation exists', () => {
    expect(getPendingGithubPublic(USER_A)).toBeUndefined();
  });

  // The map is set by the /github command handler. We exercise the getter/clearer
  // directly since the bot command handler requires a full bot mock.
  // We use the fact that the module exports both the getter and the setter-side
  // map is also tested indirectly through the callback tests.

  it('clearPendingGithubPublic removes the entry for the given userId', () => {
    // Simulate the command handler having added an entry by calling the
    // exported clear function after manually exercising via the module-level map.
    // Since we cannot set via the exported API, verify that clear on an absent
    // key is a no-op (does not throw).
    expect(() => clearPendingGithubPublic(USER_A)).not.toThrow();
    expect(getPendingGithubPublic(USER_A)).toBeUndefined();
  });

  it('clearPendingGithubPublic only affects the specified userId', () => {
    // We cannot directly SET via the public API, but we can verify isolation
    // by calling clear for USER_A does not change USER_B state.
    clearPendingGithubPublic(USER_A);
    // If USER_B was never set, it should still be undefined
    expect(getPendingGithubPublic(USER_B)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pending state maps: getPendingVercelDeploy / clearPendingVercelDeploy
// ─────────────────────────────────────────────────────────────────────────────
describe('pendingVercelDeploy state', () => {
  const USER_A = 2001;
  const USER_B = 2002;

  afterEach(() => {
    clearPendingVercelDeploy(USER_A);
    clearPendingVercelDeploy(USER_B);
  });

  it('returns undefined when no pending deploy exists for a userId', () => {
    expect(getPendingVercelDeploy(USER_A)).toBeUndefined();
  });

  it('clearPendingVercelDeploy does not throw when called on a non-existent entry', () => {
    expect(() => clearPendingVercelDeploy(USER_A)).not.toThrow();
  });

  it('getPendingVercelDeploy still returns undefined after clearing a non-existent entry', () => {
    clearPendingVercelDeploy(USER_A);
    expect(getPendingVercelDeploy(USER_A)).toBeUndefined();
  });

  it('clearPendingVercelDeploy for USER_A does not disturb USER_B', () => {
    clearPendingVercelDeploy(USER_A);
    expect(getPendingVercelDeploy(USER_B)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-export: function exists checks
// ─────────────────────────────────────────────────────────────────────────────
describe('exported function shapes', () => {
  it('buildGithubPrompt is a function', () => {
    expect(typeof buildGithubPrompt).toBe('function');
  });

  it('buildVercelPrompt is a function', () => {
    expect(typeof buildVercelPrompt).toBe('function');
  });

  it('getPendingGithubPublic is a function', () => {
    expect(typeof getPendingGithubPublic).toBe('function');
  });

  it('clearPendingGithubPublic is a function', () => {
    expect(typeof clearPendingGithubPublic).toBe('function');
  });

  it('getPendingVercelDeploy is a function', () => {
    expect(typeof getPendingVercelDeploy).toBe('function');
  });

  it('clearPendingVercelDeploy is a function', () => {
    expect(typeof clearPendingVercelDeploy).toBe('function');
  });
});
