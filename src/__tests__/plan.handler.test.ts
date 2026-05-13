import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { mockClaudeRun } = vi.hoisted(() => ({ mockClaudeRun: vi.fn() }));
vi.mock('../agents/index.js', () => ({
  getAgent: () => ({
    name: 'claude',
    label: 'Claude',
    icon: '🤖',
    run: mockClaudeRun,
  }),
  // /plan goes through runWithRouter. Stub it to just call the mocked agent
  // directly so the test focuses on the handler, not router internals.
  runWithRouter: async (opts: any) => ({
    result: await mockClaudeRun(opts),
    agentUsed: opts.preferredAgent ?? 'claude',
    fellBack: false,
  }),
}));

import { PLANNING_MODEL, setupTaskHandlers } from '../bot/handlers/topic/tasks.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { getRecentTopicMessages } from '../db/queries/topicMessages.js';

function seedProject(db: TestDb, topicId = 100): number {
  const proj = insertProject(db, {
    name: 'test-project',
    localPath: '/tmp/test',
    topicId,
    createdAt: new Date(),
  });
  return proj!.id;
}

function makeBotStub() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    command: (name: string, handler: Function) => { handlers[name] = handler; },
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    },
  };
}

function makeProjectManager(projectId: number) {
  return {
    getByTopicId: vi.fn().mockReturnValue({
      id: projectId,
      name: 'test-project',
      localPath: '/tmp/test',
      topicId: 100,
    }),
    getSession: vi.fn().mockReturnValue({}),
  };
}

function makeCtx(opts: { threadId?: number; match?: string; userId?: number } = {}) {
  const reply = vi.fn().mockResolvedValue({ message_id: 555 });
  return {
    message: { message_thread_id: opts.threadId ?? 100, chat: { id: -100123456789 } },
    chat: { id: -100123456789 },
    from: { id: opts.userId ?? 42, username: 'tester' },
    match: opts.match ?? '',
    reply,
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('PLANNING_MODEL constant', () => {
  it('points to a Claude Opus model', () => {
    expect(PLANNING_MODEL).toMatch(/^claude-opus-/);
  });
});

describe('/plan handler', () => {
  let db: TestDb;
  let projectId: number;
  let bot: ReturnType<typeof makeBotStub>;
  let projectManager: ReturnType<typeof makeProjectManager>;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
    bot = makeBotStub();
    projectManager = makeProjectManager(projectId);
    mockClaudeRun.mockReset();
    mockClaudeRun.mockResolvedValue({
      success: true,
      result: 'Here is the plan:\n1. Step one\n2. Step two',
      sessionId: 'sess-1',
      costUsd: 0.05,
      toolsUsed: {},
    });
    setupTaskHandlers(bot as any, projectManager as any, db);
  });

  it('rejects empty prompt with usage hint', async () => {
    const ctx = makeCtx({ match: '' });
    await bot.handlers['plan'](ctx);
    expect(ctx.reply).toHaveBeenCalled();
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain('Usage: /plan');
    expect(replyText).toContain(PLANNING_MODEL);
    expect(mockClaudeRun).not.toHaveBeenCalled();
  });

  it('rejects when used outside a project topic', async () => {
    projectManager.getByTopicId = vi.fn().mockReturnValue(null);
    const ctx = makeCtx({ match: 'do something' });
    await bot.handlers['plan'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith('This command must be used in a project topic.');
    expect(mockClaudeRun).not.toHaveBeenCalled();
  });

  it('forwards prompt and pins the model to PLANNING_MODEL', async () => {
    const ctx = makeCtx({ match: 'design a queue rehydration system' });
    await bot.handlers['plan'](ctx);

    expect(mockClaudeRun).toHaveBeenCalledTimes(1);
    const args = mockClaudeRun.mock.calls[0][0];
    expect(args.model).toBe(PLANNING_MODEL);
    expect(args.cwd).toBe('/tmp/test');
    expect(args.prompt).toContain('design a queue rehydration system');
  });

  it('saves the user prompt and the agent reply to shared history', async () => {
    const ctx = makeCtx({ match: 'plan the migration' });
    await bot.handlers['plan'](ctx);

    // Order-agnostic: both writes fire in the same millisecond when the agent
    // is mocked, so getRecentTopicMessages may return them in either order.
    const msgs = getRecentTopicMessages(db, projectId);
    expect(msgs.length).toBe(2);
    const user = msgs.find(m => m.sender === 'user');
    const claude = msgs.find(m => m.sender === 'claude');
    expect(user).toMatchObject({ text: 'plan the migration', senderName: 'tester' });
    expect(claude).toMatchObject({ text: 'Here is the plan:\n1. Step one\n2. Step two' });
  });

  it('appends a planning-lane footer with cost and model name', async () => {
    const ctx = makeCtx({ match: 'plan something' });
    await bot.handlers['plan'](ctx);

    const finalEdit = ctx.api.editMessageText.mock.calls.at(-1)!;
    const finalText = finalEdit[2] as string;
    expect(finalText).toContain('planning lane');
    expect(finalText).toContain(PLANNING_MODEL);
    expect(finalText).toContain('$0.0500');
  });

  it('shows an error message when the agent throws', async () => {
    mockClaudeRun.mockRejectedValueOnce(new Error('claude binary not found'));
    const ctx = makeCtx({ match: 'plan something' });
    await bot.handlers['plan'](ctx);

    const finalEdit = ctx.api.editMessageText.mock.calls.at(-1)!;
    const finalText = finalEdit[2] as string;
    expect(finalText).toContain('Planning error');
    expect(finalText).toContain('claude binary not found');
  });

  it('uses extended context when --more flag is passed', async () => {
    const ctx = makeCtx({ match: 'plan more --more' });
    await bot.handlers['plan'](ctx);

    // Status message is updated to mention extended context
    const editCalls = ctx.api.editMessageText.mock.calls;
    const extendedNotice = editCalls.find(c => (c[2] as string).includes('extended context'));
    expect(extendedNotice).toBeDefined();

    // The --more flag is stripped from what gets sent to the agent and saved
    const args = mockClaudeRun.mock.calls[0][0];
    expect(args.prompt).not.toContain('--more');
    const msgs = getRecentTopicMessages(db, projectId);
    expect(msgs[0].text).not.toContain('--more');
  });

  it('reports a footer with no cost when costUsd is missing', async () => {
    mockClaudeRun.mockResolvedValueOnce({
      success: true,
      result: 'short reply',
      sessionId: 'sess-1',
      // costUsd intentionally omitted
      toolsUsed: {},
    });
    const ctx = makeCtx({ match: 'plan something' });
    await bot.handlers['plan'](ctx);

    const finalText = ctx.api.editMessageText.mock.calls.at(-1)![2] as string;
    expect(finalText).toContain('Powered by Claude');
    expect(finalText).not.toContain('$');
  });
});
