import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Resolve the real temp dir once (resolves symlinks, e.g. /tmp -> /private/tmp on macOS)
const REAL_TMP = fs.realpathSync(os.tmpdir());

// Mock config before importing scaffold so Zod validation doesn't fail.
// PROJECTS_BASE_DIR must match the resolved tmp path so scaffoldProject tests
// can create directories under it.
vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake-token',
    SUPERGROUP_ID: -100123456789,
    NEW_PROJECTS_TOPIC_ID: 1,
    OWNER_USER_ID: 999,
    ANTHROPIC_API_KEY: 'fake-key',
    // This value is used as a string literal; it is evaluated at module parse time
    // (vi.mock factory runs synchronously at hoist time). We rely on the fact that
    // the config mock is always evaluated after REAL_TMP is computed above.
    PROJECTS_BASE_DIR: '/tmp',   // overridden per-suite via mockPROJECTS_BASE_DIR below
    DATA_DIR: '/tmp',
    LOG_LEVEL: 'info',
  },
}));

// After the mock is set up, we can override the PROJECTS_BASE_DIR field to the real
// temp path. We import the mocked config and patch the field directly.
import { config } from '../config.js';
import { assertWithinProjectsBaseDir, scaffoldProject } from '../projects/scaffold.js';

// ─────────────────────────────────────────────────────────────────────────────
// assertWithinProjectsBaseDir
// We override config.PROJECTS_BASE_DIR to control what the function uses.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertWithinProjectsBaseDir', () => {
  beforeEach(() => {
    // Set to a concrete path so the assertions are predictable
    (config as any).PROJECTS_BASE_DIR = REAL_TMP;
  });

  it('does not throw for a path directly inside the base dir', () => {
    expect(() =>
      assertWithinProjectsBaseDir(path.join(REAL_TMP, 'my-project'))
    ).not.toThrow();
  });

  it('does not throw for a deeply nested path inside the base dir', () => {
    expect(() =>
      assertWithinProjectsBaseDir(path.join(REAL_TMP, 'a', 'b', 'c'))
    ).not.toThrow();
  });

  it('throws when the path escapes the base dir via ../', () => {
    // e.g. /tmp/../etc/passwd normalises to /etc/passwd
    expect(() =>
      assertWithinProjectsBaseDir(path.join(REAL_TMP, '..', 'etc', 'passwd'))
    ).toThrow();
  });

  it('throws for a path completely outside the base dir', () => {
    expect(() =>
      assertWithinProjectsBaseDir('/home/user/secret')
    ).toThrow();
  });

  it('throws for /etc directory', () => {
    expect(() => assertWithinProjectsBaseDir('/etc')).toThrow();
  });

  it('error message mentions the disallowed path', () => {
    let message = '';
    try {
      assertWithinProjectsBaseDir('/home/user/secret');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('/home/user/secret');
  });

  it('error message mentions the base directory', () => {
    let message = '';
    try {
      assertWithinProjectsBaseDir('/home/user/secret');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(REAL_TMP);
  });

  it('does not throw when the path equals the base dir itself', () => {
    expect(() => assertWithinProjectsBaseDir(REAL_TMP)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scaffoldProject
// Uses a real temporary directory so we can verify FS side-effects.
// PROJECTS_BASE_DIR is set to the parent of each tmpDir so the assertion passes.
// ─────────────────────────────────────────────────────────────────────────────
describe('scaffoldProject', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(REAL_TMP, 'scaffold-test-'));
    // Allow scaffoldProject to create directories inside tmpDir
    (config as any).PROJECTS_BASE_DIR = tmpDir;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('creates the project directory if it does not exist', () => {
    const projectPath = path.join(tmpDir, 'new-project');
    scaffoldProject('new-project', projectPath);
    expect(fs.existsSync(projectPath)).toBe(true);
  });

  it('does not throw when the directory already exists', () => {
    const projectPath = path.join(tmpDir, 'existing-project');
    fs.mkdirSync(projectPath);
    expect(() => scaffoldProject('existing-project', projectPath)).not.toThrow();
  });

  it('initialises a git repository (.git directory created)', () => {
    const projectPath = path.join(tmpDir, 'git-project');
    scaffoldProject('git-project', projectPath);
    expect(fs.existsSync(path.join(projectPath, '.git'))).toBe(true);
  });

  it('does not reinitialise git if .git already exists', () => {
    const projectPath = path.join(tmpDir, 'already-git');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(path.join(projectPath, '.git'));

    // Write a sentinel file inside .git to verify git init is NOT re-run
    const headPath = path.join(projectPath, '.git', 'HEAD');
    fs.writeFileSync(headPath, 'sentinel');

    scaffoldProject('already-git', projectPath);

    expect(fs.readFileSync(headPath, 'utf8')).toBe('sentinel');
  });

  it('creates a CLAUDE.md file in the project directory', () => {
    const projectPath = path.join(tmpDir, 'claude-project');
    scaffoldProject('claude-project', projectPath);
    expect(fs.existsSync(path.join(projectPath, 'CLAUDE.md'))).toBe(true);
  });

  it('CLAUDE.md contains the project name', () => {
    const projectPath = path.join(tmpDir, 'my-app');
    scaffoldProject('my-app', projectPath);
    const content = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('my-app');
  });

  it('does not overwrite an existing CLAUDE.md', () => {
    const projectPath = path.join(tmpDir, 'keep-existing');
    fs.mkdirSync(projectPath);
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, 'custom content');

    scaffoldProject('keep-existing', projectPath);

    expect(fs.readFileSync(claudeMdPath, 'utf8')).toBe('custom content');
  });

  it('throws when the project path escapes the PROJECTS_BASE_DIR', () => {
    // /etc is not inside tmpDir
    expect(() => scaffoldProject('evil', '/etc/evil-project')).toThrow();
  });
});
