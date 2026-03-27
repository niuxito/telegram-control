import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── classifyCliError ──────────────────────────────────────────────────────────
// Imported directly — no side-effects, no config dependency.
import { classifyCliError } from '../claude/CliStrategy.js';

// ── runCliTask mock setup ─────────────────────────────────────────────────────
// spawnMock must be declared at module scope so the hoisted vi.mock factory
// closure can reference it.
const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Build a fake child process that emits stdout/stderr data then closes.
function makeChild(opts: {
  stdoutLines?: string[];
  stderrLines?: string[];
  exitCode?: number;
  spawnError?: Error;
}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  // Schedule async emission so callers can attach listeners first.
  setImmediate(() => {
    if (opts.spawnError) {
      child.emit('error', opts.spawnError);
      return;
    }

    for (const line of opts.stdoutLines ?? []) {
      child.stdout.emit('data', Buffer.from(line + '\n'));
    }
    for (const line of opts.stderrLines ?? []) {
      child.stderr.emit('data', Buffer.from(line + '\n'));
    }
    child.emit('close', opts.exitCode ?? 0);
  });

  return child;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('classifyCliError', () => {
  describe('usage_limit classification', () => {
    it('classifies text containing "usage limit" (lowercase)', () => {
      expect(classifyCliError('you have exceeded your usage limit')).toBe('usage_limit');
    });

    it('classifies text containing "Usage Limit" (mixed case)', () => {
      expect(classifyCliError('Usage Limit reached')).toBe('usage_limit');
    });

    it('classifies text containing "quota"', () => {
      expect(classifyCliError('your quota has been exhausted')).toBe('usage_limit');
    });

    it('classifies text containing "upgrade"', () => {
      expect(classifyCliError('please upgrade your plan')).toBe('usage_limit');
    });

    it('classifies text containing "claude.ai/upgrade"', () => {
      expect(classifyCliError('visit claude.ai/upgrade to continue')).toBe('usage_limit');
    });

    it('is case-insensitive for UPGRADE', () => {
      expect(classifyCliError('UPGRADE NOW')).toBe('usage_limit');
    });
  });

  describe('rate_limit classification', () => {
    it('classifies text containing "rate limit"', () => {
      expect(classifyCliError('rate limit exceeded')).toBe('rate_limit');
    });

    it('classifies text containing "too many requests"', () => {
      expect(classifyCliError('Too many requests, slow down')).toBe('rate_limit');
    });

    it('classifies text containing "429"', () => {
      expect(classifyCliError('HTTP 429 error')).toBe('rate_limit');
    });

    it('is case-insensitive for RATE LIMIT', () => {
      expect(classifyCliError('RATE LIMIT HIT')).toBe('rate_limit');
    });
  });

  describe('overloaded classification', () => {
    it('classifies text containing "overloaded"', () => {
      expect(classifyCliError('API is overloaded right now')).toBe('overloaded');
    });

    it('is case-insensitive for OVERLOADED', () => {
      expect(classifyCliError('SERVERS ARE OVERLOADED')).toBe('overloaded');
    });
  });

  describe('unknown classification', () => {
    it('classifies an empty string as unknown', () => {
      expect(classifyCliError('')).toBe('unknown');
    });

    it('classifies a generic error message as unknown', () => {
      expect(classifyCliError('process exited with code 1')).toBe('unknown');
    });

    it('classifies a random string as unknown', () => {
      expect(classifyCliError('something unexpected happened')).toBe('unknown');
    });

    it('classifies numeric exit code messages as unknown', () => {
      expect(classifyCliError('Process exited with code 127')).toBe('unknown');
    });
  });

  describe('priority ordering', () => {
    it('classifies "quota 429" as usage_limit (quota checked before 429)', () => {
      expect(classifyCliError('quota exceeded, got 429')).toBe('usage_limit');
    });

    it('classifies "rate limit overloaded" as rate_limit (rate_limit checked before overloaded)', () => {
      expect(classifyCliError('rate limit hit, servers overloaded')).toBe('rate_limit');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('runCliTask', () => {
  let runCliTask: typeof import('../claude/CliStrategy.js').runCliTask;

  beforeEach(async () => {
    spawnMock.mockReset();
    // Re-import to pick up the mocked child_process
    ({ runCliTask } = await import('../claude/CliStrategy.js'));
  });

  // ── JSON line helpers ──────────────────────────────────────────────────────
  function jsonLine(obj: unknown): string {
    return JSON.stringify(obj);
  }

  function initLine(sessionId: string) {
    return jsonLine({ type: 'system', subtype: 'init', session_id: sessionId });
  }

  function textLine(text: string) {
    return jsonLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
  }

  function toolLine(name: string) {
    return jsonLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input: {} }] },
    });
  }

  function resultLine(
    subtype: 'success' | 'error',
    opts: Record<string, unknown> = {}
  ) {
    return jsonLine({
      type: 'result',
      subtype,
      cost_usd: 0.001,
      session_id: 'ses-result',
      result: 'done',
      ...opts,
    });
  }

  // ── happy path ─────────────────────────────────────────────────────────────
  it('resolves with success:true when result event has success subtype', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [initLine('sess-abc'), textLine('hello'), resultLine('success')],
        exitCode: 0,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('ses-result');
    expect(result.costUsd).toBe(0.001);
  });

  it('calls onTextChunk for each text block and accumulates text', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [
          initLine('s1'),
          textLine('Hello '),
          textLine('world'),
          resultLine('success', { result: '' }),
        ],
        exitCode: 0,
      })
    );

    const chunks: string[] = [];
    await runCliTask({
      prompt: 'do stuff',
      cwd: '/tmp',
      onTextChunk: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toContain('Hello ');
    expect(chunks).toContain('world');
  });

  it('calls onInit with the session ID from the init event', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [initLine('init-sess-xyz'), resultLine('success')],
        exitCode: 0,
      })
    );

    const onInit = vi.fn();
    await runCliTask({ prompt: 'do stuff', cwd: '/tmp', onInit });

    expect(onInit).toHaveBeenCalledOnce();
    expect(onInit).toHaveBeenCalledWith('init-sess-xyz');
  });

  it('calls onToolUse for tool_use blocks', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [initLine('s1'), toolLine('Bash'), resultLine('success')],
        exitCode: 0,
      })
    );

    const onToolUse = vi.fn();
    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp', onToolUse });

    expect(onToolUse).toHaveBeenCalledWith('Bash');
    expect(result.toolsUsed['Bash']).toBe(1);
  });

  it('counts repeated tool calls correctly in toolsUsed', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [
          initLine('s1'),
          toolLine('Bash'),
          toolLine('Bash'),
          toolLine('Write'),
          resultLine('success'),
        ],
        exitCode: 0,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.toolsUsed['Bash']).toBe(2);
    expect(result.toolsUsed['Write']).toBe(1);
  });

  it('passes --resume <sessionId> when sessionId option is provided', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [resultLine('success', { session_id: 'existing-sess' })],
        exitCode: 0,
      })
    );

    await runCliTask({ prompt: 'do stuff', cwd: '/tmp', sessionId: 'existing-sess' });

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).toContain('--resume');
    expect(args).toContain('existing-sess');
  });

  it('does NOT include --resume when sessionId is omitted', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdoutLines: [resultLine('success')], exitCode: 0 })
    );

    await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).not.toContain('--resume');
  });

  it('always includes --output-format stream-json and --dangerously-skip-permissions', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdoutLines: [resultLine('success')], exitCode: 0 })
    );

    await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('spawns with the provided cwd', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdoutLines: [resultLine('success')], exitCode: 0 })
    );

    await runCliTask({ prompt: 'do stuff', cwd: '/my/project' });

    const spawnOpts = spawnMock.mock.calls[0][2];
    expect(spawnOpts.cwd).toBe('/my/project');
  });

  // ── error paths ────────────────────────────────────────────────────────────
  it('resolves with success:false when result event has error subtype', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [
          initLine('s1'),
          resultLine('error', { result: 'Task timed out' }),
        ],
        exitCode: 0,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.success).toBe(false);
  });

  it('resolves with success:false on non-zero exit with no result event', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [],
        stderrLines: ['Error: command not found'],
        exitCode: 1,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Error: command not found');
  });

  it('classifies rate_limit errors from stderr text', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [],
        stderrLines: ['rate limit exceeded'],
        exitCode: 1,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('rate_limit');
  });

  it('classifies usage_limit errors from stderr text', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [],
        stderrLines: ['usage limit reached, upgrade at claude.ai/upgrade'],
        exitCode: 1,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.errorType).toBe('usage_limit');
  });

  it('classifies overloaded errors from stderr text', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdoutLines: [],
        stderrLines: ['Claude is overloaded'],
        exitCode: 1,
      })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.errorType).toBe('overloaded');
  });

  it('falls back to "Process exited with code N" message when stderr is empty', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdoutLines: [], stderrLines: [], exitCode: 2 })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('2');
  });

  it('rejects when spawn emits an error event (e.g. ENOENT)', async () => {
    const spawnError = new Error('ENOENT: claude not found');

    // makeChild with spawnError causes child.emit('error', ...) asynchronously.
    // The Promise should reject.
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('error', spawnError));
      return child;
    });

    await expect(
      runCliTask({ prompt: 'do stuff', cwd: '/tmp' })
    ).rejects.toThrow('ENOENT: claude not found');
  });

  // ── zero-exit with no result event ─────────────────────────────────────────
  it('resolves with success:true using accumulated text when process exits 0 with no result event', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdoutLines: [textLine('some output')], exitCode: 0 })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.success).toBe(true);
    expect(result.result).toBe('some output');
    expect(result.costUsd).toBe(0);
  });

  it('includes toolsUsed as empty object when no tools were called', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdoutLines: [resultLine('success')], exitCode: 0 })
    );

    const result = await runCliTask({ prompt: 'do stuff', cwd: '/tmp' });
    expect(result.toolsUsed).toEqual({});
  });
});
