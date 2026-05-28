import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mockSpawn }));

// Re-import after the mock is in place so the module picks up the mocked spawn.
const { checkCodexAuth, CODEX_AUTH_REQUIRED_MARKER } = await import('../claude/CodexStrategy.js');

function makeFakeChild(stdoutChunks: string[] = [], stderrChunks: string[] = [], exitCode: number = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  // Emit data + close on next microtask so the listeners can attach first.
  setImmediate(() => {
    for (const c of stdoutChunks) child.stdout.emit('data', Buffer.from(c));
    for (const c of stderrChunks) child.stderr.emit('data', Buffer.from(c));
    child.emit('close', exitCode);
  });

  return child;
}

describe('checkCodexAuth', () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  it('returns loggedIn=true when stdout contains "Logged in using ChatGPT"', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild(['Logged in using ChatGPT\n']));
    const r = await checkCodexAuth();
    expect(r.loggedIn).toBe(true);
    expect(r.raw).toContain('Logged in using ChatGPT');
  });

  it('returns loggedIn=true on "Logged in using OpenAI API key"', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild(['Logged in using OpenAI API key\n']));
    const r = await checkCodexAuth();
    expect(r.loggedIn).toBe(true);
  });

  it('is case-insensitive on the "logged in" substring', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild(['LOGGED IN using something\n']));
    expect((await checkCodexAuth()).loggedIn).toBe(true);
  });

  it('returns loggedIn=false on "Not logged in"', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild(['Not logged in\n']));
    const r = await checkCodexAuth();
    expect(r.loggedIn).toBe(false);
    expect(r.raw).toContain('Not logged in');
  });

  it('returns loggedIn=false on empty output', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild([]));
    expect((await checkCodexAuth()).loggedIn).toBe(false);
  });

  it('returns loggedIn=false with a "probe failed" raw when spawn errors', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => { child.emit('error', new Error('ENOENT')); });
    mockSpawn.mockReturnValueOnce(child);

    const r = await checkCodexAuth();
    expect(r.loggedIn).toBe(false);
    expect(r.raw).toMatch(/probe failed/);
  });

  it('reads stderr too (some codex versions print status there)', async () => {
    mockSpawn.mockReturnValueOnce(makeFakeChild([], ['Logged in using ChatGPT\n']));
    expect((await checkCodexAuth()).loggedIn).toBe(true);
  });
});

describe('CODEX_AUTH_REQUIRED_MARKER', () => {
  it('is the literal "auth_required:" prefix the adapter looks for', () => {
    expect(CODEX_AUTH_REQUIRED_MARKER).toBe('auth_required:');
  });
});
