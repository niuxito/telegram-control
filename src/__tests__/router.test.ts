import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake', SUPERGROUP_ID: -1, NEW_PROJECTS_TOPIC_ID: 2,
    OWNER_USER_ID: 1, ANTHROPIC_API_KEY: 'x', PROJECTS_BASE_DIR: '/tmp',
    DATA_DIR: '/tmp', LOG_LEVEL: 'info',
  },
}));

const { mockClaudeRun, mockCodexRun, mockOpenCodeRun } = vi.hoisted(() => ({
  mockClaudeRun: vi.fn(),
  mockCodexRun: vi.fn(),
  mockOpenCodeRun: vi.fn(),
}));

vi.mock('../agents/ClaudeStrategy.js', () => ({
  ClaudeStrategy: class {
    name = 'claude'; label = 'Claude'; icon = '🤖';
    run = mockClaudeRun;
  },
}));
vi.mock('../agents/CodexStrategy.js', () => ({
  CodexStrategy: class {
    name = 'codex'; label = 'Codex'; icon = '💻';
    run = mockCodexRun;
  },
}));
vi.mock('../agents/OpenCodeStrategy.js', () => ({
  OpenCodeStrategy: class {
    name = 'opencode'; label = 'OpenCode'; icon = '🦊';
    run = mockOpenCodeRun;
  },
}));

import { runWithRouter } from '../agents/index.js';

const baseOpts = { prompt: 'hello', cwd: '/x' };

beforeEach(() => {
  mockClaudeRun.mockReset();
  mockCodexRun.mockReset();
  mockOpenCodeRun.mockReset();
});

describe('runWithRouter — happy path', () => {
  it('returns the primary agent result when it succeeds', async () => {
    mockClaudeRun.mockResolvedValue({ success: true, result: 'ok' });
    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'project-internal',
    });
    expect(r.agentUsed).toBe('claude');
    expect(r.fellBack).toBe(false);
    expect(r.result.success).toBe(true);
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });

  it('does not fall back on non-quota errors', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', error: 'something else', errorType: 'unknown',
    });
    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'public',
    });
    expect(r.agentUsed).toBe('claude');
    expect(r.fellBack).toBe(false);
    expect(r.result.success).toBe(false);
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });

  it('does not fall back on timeout errors (transient, retry not safe)', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', error: 'timed out', errorType: 'timeout',
    });
    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'public',
    });
    expect(r.agentUsed).toBe('claude');
    expect(r.fellBack).toBe(false);
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });
});

describe('runWithRouter — usage_limit + public sensitivity (auto-fallback)', () => {
  it('falls back to OpenCode when Claude hits usage_limit on a public task', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', error: 'quota exceeded', errorType: 'usage_limit',
    });
    mockOpenCodeRun.mockResolvedValue({ success: true, result: 'opencode result' });

    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'public',
    });

    expect(r.agentUsed).toBe('opencode');
    expect(r.fellBack).toBe(true);
    expect(r.result.success).toBe(true);
    expect(r.result.result).toBe('opencode result');
  });

  it('falls back to OpenCode when Codex hits usage_limit on a public task', async () => {
    mockCodexRun.mockResolvedValue({
      success: false, result: '', error: 'quota', errorType: 'usage_limit',
    });
    mockOpenCodeRun.mockResolvedValue({ success: true, result: 'oc result' });

    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'codex', sensitivity: 'public',
    });
    expect(r.agentUsed).toBe('opencode');
    expect(r.fellBack).toBe(true);
  });

  it('returns the primary failure when the fallback also fails on quota', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', error: 'quota', errorType: 'usage_limit',
    });
    mockOpenCodeRun.mockResolvedValue({
      success: false, result: '', error: 'quota', errorType: 'usage_limit',
    });

    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'public',
    });
    expect(r.agentUsed).toBe('claude');
    expect(r.fellBack).toBe(false);
    expect(r.result.errorType).toBe('usage_limit');
  });

  it('does NOT try to fall back to OpenCode from OpenCode (no self-fallback)', async () => {
    mockOpenCodeRun.mockResolvedValue({
      success: false, result: '', error: 'quota', errorType: 'usage_limit',
    });

    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'opencode', sensitivity: 'public',
    });
    expect(r.agentUsed).toBe('opencode');
    expect(r.fellBack).toBe(false);
    expect(mockOpenCodeRun).toHaveBeenCalledTimes(1);
  });
});

describe('runWithRouter — privacy gate', () => {
  it('does NOT auto-fall-back on usage_limit when sensitivity is project-internal', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', error: 'quota', errorType: 'usage_limit',
    });

    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'project-internal',
    });
    expect(r.agentUsed).toBe('claude');
    expect(r.fellBack).toBe(false);
    expect(r.result.errorType).toBe('usage_limit');
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });

  it('does NOT auto-fall-back on usage_limit when sensitivity is secret', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', error: 'quota', errorType: 'usage_limit',
    });

    const r = await runWithRouter({
      ...baseOpts, preferredAgent: 'claude', sensitivity: 'secret',
    });
    expect(r.agentUsed).toBe('claude');
    expect(r.fellBack).toBe(false);
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });
});

describe('runWithRouter — option forwarding', () => {
  it('forwards model and sessionId to the primary agent', async () => {
    mockClaudeRun.mockResolvedValue({ success: true, result: 'ok' });
    await runWithRouter({
      prompt: 'p', cwd: '/x', model: 'claude-opus-4-7', sessionId: 'sess-1',
      preferredAgent: 'claude', sensitivity: 'project-internal',
    });
    expect(mockClaudeRun).toHaveBeenCalledWith({
      prompt: 'p', cwd: '/x', model: 'claude-opus-4-7', sessionId: 'sess-1',
    });
  });

  it('does not pass routing-only fields (preferredAgent, sensitivity) to the agent', async () => {
    mockClaudeRun.mockResolvedValue({ success: true, result: 'ok' });
    await runWithRouter({
      prompt: 'p', cwd: '/x',
      preferredAgent: 'claude', sensitivity: 'public',
    });
    const args = mockClaudeRun.mock.calls[0][0];
    expect(args.preferredAgent).toBeUndefined();
    expect(args.sensitivity).toBeUndefined();
  });

  it('forwards the same options to the fallback agent', async () => {
    mockClaudeRun.mockResolvedValue({
      success: false, result: '', errorType: 'usage_limit',
    });
    mockOpenCodeRun.mockResolvedValue({ success: true, result: 'ok' });

    await runWithRouter({
      prompt: 'p', cwd: '/x', model: 'm', sessionId: 's',
      preferredAgent: 'claude', sensitivity: 'public',
    });
    expect(mockOpenCodeRun).toHaveBeenCalledWith({
      prompt: 'p', cwd: '/x', model: 'm', sessionId: 's',
    });
  });
});
