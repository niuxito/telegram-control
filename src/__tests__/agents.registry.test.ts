import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake-token',
    SUPERGROUP_ID: -100123456789,
    NEW_PROJECTS_TOPIC_ID: 2,
    OWNER_USER_ID: 42,
    ANTHROPIC_API_KEY: 'fake-key',
    PROJECTS_BASE_DIR: '/tmp/projects',
    DATA_DIR: '/tmp',
    LOG_LEVEL: 'info',
  },
}));

// Stub the underlying CLI/Codex spawners so we can verify the adapters route
// through them without spawning real binaries.
vi.mock('../claude/CliStrategy.js', () => ({
  runCliTask: vi.fn().mockResolvedValue({
    success: true,
    sessionId: 'sess-claude',
    costUsd: 0.001,
    result: 'claude reply',
    toolsUsed: { Bash: 2 },
  }),
}));
vi.mock('../claude/CodexStrategy.js', () => ({
  runCodexTask: vi.fn().mockResolvedValue({
    success: true,
    result: 'codex reply',
  }),
}));

import { getAgent, listAgents } from '../agents/index.js';
import { runCliTask } from '../claude/CliStrategy.js';
import { runCodexTask } from '../claude/CodexStrategy.js';

describe('agents registry — getAgent / listAgents', () => {
  it('exposes Claude with the expected name/label/icon', () => {
    const a = getAgent('claude');
    expect(a.name).toBe('claude');
    expect(a.label).toBe('Claude');
    expect(a.icon).toBe('🤖');
    expect(typeof a.run).toBe('function');
  });

  it('exposes Codex with the expected name/label/icon', () => {
    const a = getAgent('codex');
    expect(a.name).toBe('codex');
    expect(a.label).toBe('Codex');
    expect(a.icon).toBe('💻');
    expect(typeof a.run).toBe('function');
  });

  it('listAgents returns both registered strategies', () => {
    const all = listAgents();
    expect(all.map(a => a.name).sort()).toEqual(['claude', 'codex']);
  });
});

describe('ClaudeStrategy.run', () => {
  it('forwards every option to runCliTask', async () => {
    const onTextChunk = vi.fn();
    const onToolUse = vi.fn();
    const onInit = vi.fn();
    const signal = new AbortController().signal;

    await getAgent('claude').run({
      prompt: 'p', cwd: '/x', sessionId: 's', model: 'm',
      signal, onTextChunk, onToolUse, onInit,
    });

    expect(runCliTask).toHaveBeenCalledWith({
      prompt: 'p', cwd: '/x', sessionId: 's', model: 'm',
      signal, onTextChunk, onToolUse, onInit,
    });
  });

  it('passes through every result field that Claude exposes', async () => {
    const r = await getAgent('claude').run({ prompt: 'p', cwd: '/x' });
    expect(r).toEqual({
      success: true,
      result: 'claude reply',
      error: undefined,
      errorType: undefined,
      sessionId: 'sess-claude',
      costUsd: 0.001,
      toolsUsed: { Bash: 2 },
    });
  });
});

describe('CodexStrategy.run', () => {
  it('forwards prompt/cwd/onTextChunk only (Codex ignores the rest)', async () => {
    const onTextChunk = vi.fn();
    await getAgent('codex').run({
      prompt: 'p', cwd: '/x', sessionId: 'ignored', model: 'ignored',
      onTextChunk,
    });
    expect(runCodexTask).toHaveBeenCalledWith({ prompt: 'p', cwd: '/x', onTextChunk });
  });

  it('omits provider-specific fields (sessionId, costUsd, toolsUsed)', async () => {
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.success).toBe(true);
    expect(r.result).toBe('codex reply');
    expect(r.sessionId).toBeUndefined();
    expect(r.costUsd).toBeUndefined();
    expect(r.toolsUsed).toBeUndefined();
  });

  it('classifies "timed out" errors as timeout', async () => {
    vi.mocked(runCodexTask).mockResolvedValueOnce({
      success: false, result: '', error: 'Codex timed out after 5 minutes',
    });
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.errorType).toBe('timeout');
    expect(r.error).toContain('timed out');
  });

  it('classifies "quota" / "usage limit" errors as usage_limit', async () => {
    vi.mocked(runCodexTask).mockResolvedValueOnce({
      success: false, result: '', error: 'Out of quota for this account',
    });
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.errorType).toBe('usage_limit');
  });

  it('classifies "rate limit" / 429 as rate_limit', async () => {
    vi.mocked(runCodexTask).mockResolvedValueOnce({
      success: false, result: '', error: 'HTTP 429 rate limit exceeded',
    });
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.errorType).toBe('rate_limit');
  });

  it('classifies "overloaded" as overloaded', async () => {
    vi.mocked(runCodexTask).mockResolvedValueOnce({
      success: false, result: '', error: 'Provider is overloaded',
    });
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.errorType).toBe('overloaded');
  });

  it('falls back to "unknown" for unrecognised errors', async () => {
    vi.mocked(runCodexTask).mockResolvedValueOnce({
      success: false, result: '', error: 'Something else broke',
    });
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.errorType).toBe('unknown');
  });

  it('leaves errorType undefined on successful runs', async () => {
    const r = await getAgent('codex').run({ prompt: 'p', cwd: '/x' });
    expect(r.errorType).toBeUndefined();
  });
});
