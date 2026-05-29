import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mockSpawn }));

const { parseDeviceAuthOutput, startCodexDeviceAuth } =
  await import('../claude/codexDeviceAuth.js');

// Real, ANSI-coloured output captured from `codex login --device-auth` on the
// Pi 2026-05-29 (codex v0.121.0). Used to make sure the parser handles the
// actual byte sequence, not a sanitised approximation.
const REAL_OUTPUT_RAW =
  '\n' +
  'Welcome to Codex [v[90m0.121.0[0m]\n' +
  '[90mOpenAI\'s command-line coding agent[0m\n\n' +
  'Follow these steps to sign in with ChatGPT using device code authorization:\n\n' +
  '1. Open this link in your browser and sign in to your account\n' +
  '   [94mhttps://auth.openai.com/codex/device[0m\n\n' +
  '2. Enter this one-time code [90m(expires in 15 minutes)[0m\n' +
  '   [94mSEC7-R726R[0m\n\n' +
  '[90mDevice codes are a common phishing target. Never share this code.[0m\n';

describe('parseDeviceAuthOutput', () => {
  it('extracts URL, code, and expiry from the real ANSI output', () => {
    const r = parseDeviceAuthOutput(REAL_OUTPUT_RAW);
    expect(r).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'SEC7-R726R',
      expiresInMinutes: 15,
    });
  });

  it('returns null when only the welcome banner has arrived', () => {
    const partial =
      '\nWelcome to Codex [v[90m0.121.0[0m]\n' +
      "[90mOpenAI's command-line coding agent[0m\n\n";
    expect(parseDeviceAuthOutput(partial)).toBeNull();
  });

  it('returns null when the URL is visible but the code is not yet', () => {
    const partial =
      'Follow these steps...\n\n' +
      '1. Open this link in your browser and sign in to your account\n' +
      '   [94mhttps://auth.openai.com/codex/device[0m\n\n' +
      '2. Enter this one-time code (expires in 15 minutes)\n';
    expect(parseDeviceAuthOutput(partial)).toBeNull();
  });

  it('handles output without ANSI escapes', () => {
    const plain =
      '1. Open this link in your browser and sign in to your account\n' +
      '   https://auth.openai.com/codex/device\n\n' +
      '2. Enter this one-time code (expires in 15 minutes)\n' +
      '   ABCD-EFGHI\n';
    expect(parseDeviceAuthOutput(plain)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGHI',
      expiresInMinutes: 15,
    });
  });

  it('accepts codes with multiple hyphen groups', () => {
    const out =
      '1. Open this link in your browser and sign in to your account\n' +
      '   https://auth.openai.com/codex/device\n\n' +
      '2. Enter this one-time code (expires in 10 minutes)\n' +
      '   ABCD-EFGH-IJKL\n';
    expect(parseDeviceAuthOutput(out)?.code).toBe('ABCD-EFGH-IJKL');
  });

  it('rejects codes without any hyphen', () => {
    const out =
      '2. Enter this one-time code (expires in 15 minutes)\n' +
      '   ABCDEFGHI\n';
    // No code parsed because at least one hyphen is required
    expect(parseDeviceAuthOutput(out)).toBeNull();
  });

  it('omits expiresInMinutes if the duration line is missing', () => {
    const out =
      '1. Open this link in your browser and sign in to your account\n' +
      '   https://auth.openai.com/codex/device\n\n' +
      '2. Enter this one-time code\n' +
      '   ABCD-EFGH\n';
    const r = parseDeviceAuthOutput(out);
    expect(r?.url).toBeDefined();
    expect(r?.code).toBe('ABCD-EFGH');
    expect(r?.expiresInMinutes).toBeUndefined();
  });
});

function makeFakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('startCodexDeviceAuth — lifecycle', () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  it('fires onInit as soon as the URL+code are visible in stdout', async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);

    const onInit = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const onCancelled = vi.fn();
    startCodexDeviceAuth({ onInit, onComplete, onError, onCancelled });

    child.stdout.emit('data', Buffer.from(REAL_OUTPUT_RAW));

    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onInit.mock.calls[0][0]).toMatchObject({
      url: 'https://auth.openai.com/codex/device',
      code: 'SEC7-R726R',
      expiresInMinutes: 15,
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('fires onInit only once even if more chunks arrive', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);

    const onInit = vi.fn();
    startCodexDeviceAuth({
      onInit,
      onComplete: () => {},
      onError: () => {},
      onCancelled: () => {},
    });

    child.stdout.emit('data', Buffer.from(REAL_OUTPUT_RAW));
    child.stdout.emit('data', Buffer.from('extra chunk that mentions the code SEC7-R726R again\n'));

    expect(onInit).toHaveBeenCalledTimes(1);
  });

  it('fires onComplete when the process exits 0 after init', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);
    const onComplete = vi.fn();

    startCodexDeviceAuth({
      onInit: () => {},
      onComplete,
      onError: () => {},
      onCancelled: () => {},
    });
    child.stdout.emit('data', Buffer.from(REAL_OUTPUT_RAW));
    child.emit('close', 0);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires onError with a clear message when the process exits before init', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);
    const onError = vi.fn();

    startCodexDeviceAuth({
      onInit: () => {},
      onComplete: () => {},
      onError,
      onCancelled: () => {},
    });
    child.emit('close', 1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('before producing a device URL');
  });

  it('fires onError with non-zero exit after init (e.g. server-side timeout)', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);
    const onError = vi.fn();

    startCodexDeviceAuth({
      onInit: () => {},
      onComplete: () => {},
      onError,
      onCancelled: () => {},
    });
    child.stdout.emit('data', Buffer.from(REAL_OUTPUT_RAW));
    child.emit('close', 2);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('timeout');
  });

  it('cancel() kills the process and fires onCancelled on close', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);
    const onCancelled = vi.fn();
    const onComplete = vi.fn();

    const handle = startCodexDeviceAuth({
      onInit: () => {},
      onComplete,
      onError: () => {},
      onCancelled,
    });

    child.stdout.emit('data', Buffer.from(REAL_OUTPUT_RAW));
    handle.cancel();
    child.emit('close', null);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('handle.process is the spawned child', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValueOnce(child);

    const handle = startCodexDeviceAuth({
      onInit: () => {}, onComplete: () => {}, onError: () => {}, onCancelled: () => {},
    });
    expect(handle.process).toBe(child);
  });
});
