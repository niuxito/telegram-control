import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// Stub the CLI/Codex strategies so processQueue (called from rehydrate when
// pending tasks exist) doesn't try to spawn real binaries during tests.
vi.mock('../claude/CliStrategy.js', () => ({
  runCliTask: vi.fn().mockResolvedValue({
    success: true,
    sessionId: 'fake-session',
    costUsd: 0,
    result: '',
    toolsUsed: {},
  }),
}));
vi.mock('../claude/CodexStrategy.js', () => ({
  runCodexTask: vi.fn().mockResolvedValue({
    success: true,
    result: '',
  }),
}));

import { ClaudeSession } from '../claude/ClaudeSession.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertTask, updateTask, getTaskById } from '../db/queries/taskQueue.js';

function seedProject(db: TestDb): number {
  const proj = insertProject(db, {
    name: 'test-project',
    localPath: '/tmp/test',
    createdAt: new Date(),
    topicId: 100,
  });
  return proj!.id;
}

function makeBotStub() {
  return {
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    },
  };
}

describe('ClaudeSession.rehydrate', () => {
  let db: TestDb;
  let projectId: number;
  let bot: ReturnType<typeof makeBotStub>;
  let session: ClaudeSession;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
    bot = makeBotStub();
    // ClaudeSession's constructor expects a grammy Bot — the stub has the same
    // shape for the API we exercise here (api.editMessageText / api.sendMessage).
    session = new ClaudeSession(db, bot as any, projectId, '/tmp/test', 100, -100123456789, 'test-project');
  });

  it('returns { orphaned: 0, resumed: 0 } when there is nothing to do', async () => {
    const result = await session.rehydrate();
    expect(result).toEqual({ orphaned: 0, resumed: 0 });
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('marks orphaned running tasks as failed and reports them', async () => {
    const task = insertTask(db, { projectId, prompt: 'half-finished work', createdAt: new Date() });
    updateTask(db, task!.id, { status: 'running', liveMessageId: 555 });

    const result = await session.rehydrate();
    expect(result.orphaned).toBe(1);

    const updated = getTaskById(db, task!.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.completedAt).toBeTruthy();
    expect(updated?.result).toContain('interrupted by bot restart');
  });

  it('edits the live message when the orphaned task has a liveMessageId', async () => {
    const task = insertTask(db, { projectId, prompt: 'a thing', createdAt: new Date() });
    updateTask(db, task!.id, { status: 'running', liveMessageId: 555 });

    await session.rehydrate();

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text] = bot.api.editMessageText.mock.calls[0];
    expect(chatId).toBe(-100123456789);
    expect(messageId).toBe(555);
    expect(text).toContain('interrupted by bot restart');
    expect(text).toContain('a thing');
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a fresh message when the orphaned task has no liveMessageId', async () => {
    const task = insertTask(db, { projectId, prompt: 'no live id', createdAt: new Date() });
    updateTask(db, task!.id, { status: 'running' });

    await session.rehydrate();

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = bot.api.sendMessage.mock.calls[0];
    expect(chatId).toBe(-100123456789);
    expect(text).toContain('interrupted by bot restart');
    expect(text).toContain('no live id');
    expect(opts).toEqual({ message_thread_id: 100 });
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  it('handles multiple orphaned tasks independently', async () => {
    const t1 = insertTask(db, { projectId, prompt: 'one', createdAt: new Date('2026-01-01') });
    const t2 = insertTask(db, { projectId, prompt: 'two', createdAt: new Date('2026-01-02') });
    updateTask(db, t1!.id, { status: 'running', liveMessageId: 111 });
    updateTask(db, t2!.id, { status: 'running' });

    const result = await session.rehydrate();
    expect(result.orphaned).toBe(2);

    expect(getTaskById(db, t1!.id)?.status).toBe('failed');
    expect(getTaskById(db, t2!.id)?.status).toBe('failed');
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('truncates very long prompts in the interruption message', async () => {
    const longPrompt = 'x'.repeat(500);
    const task = insertTask(db, { projectId, prompt: longPrompt, createdAt: new Date() });
    updateTask(db, task!.id, { status: 'running', liveMessageId: 555 });

    await session.rehydrate();

    const text = bot.api.editMessageText.mock.calls[0][2] as string;
    expect(text).toContain('x'.repeat(200));
    expect(text).toContain('…');
    // The text should not contain the full 500 x's
    expect(text.includes('x'.repeat(201))).toBe(false);
  });

  it('reports resumed count without invoking the bot when there are pending tasks', async () => {
    // Pending tasks alone (no running) — rehydrate should report resumed > 0 but
    // not call any bot API. processQueue is fired internally; we don't await it
    // here, and runCliTask isn't actually exercised because the task lifecycle
    // would only proceed asynchronously.
    insertTask(db, { projectId, prompt: 'queued-1', createdAt: new Date('2026-01-01') });
    insertTask(db, { projectId, prompt: 'queued-2', createdAt: new Date('2026-01-02') });

    const result = await session.rehydrate();
    expect(result.orphaned).toBe(0);
    expect(result.resumed).toBe(2);
  });

  it('continues when editing/sending the bot message fails (non-fatal)', async () => {
    bot.api.editMessageText.mockRejectedValueOnce(new Error('telegram is down'));
    const task = insertTask(db, { projectId, prompt: 'a', createdAt: new Date() });
    updateTask(db, task!.id, { status: 'running', liveMessageId: 555 });

    const result = await session.rehydrate();
    expect(result.orphaned).toBe(1);
    // DB row was still updated even though Telegram edit failed
    expect(getTaskById(db, task!.id)?.status).toBe('failed');
  });
});
