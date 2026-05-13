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

const { mockOpenCodeRun, mockClaudeRun, mockCodexRun } = vi.hoisted(() => ({
  mockOpenCodeRun: vi.fn(),
  mockClaudeRun: vi.fn(),
  mockCodexRun: vi.fn(),
}));
const agentMap: Record<string, any> = {
  opencode: { name: 'opencode', label: 'OpenCode', icon: '🦊', run: mockOpenCodeRun },
  claude:   { name: 'claude',   label: 'Claude',   icon: '🤖', run: mockClaudeRun },
  codex:    { name: 'codex',    label: 'Codex',    icon: '💻', run: mockCodexRun },
};
vi.mock('../agents/index.js', () => ({
  getAgent: (name: string) => agentMap[name],
  // /opencode goes through runWithRouter. Stub it to call the named agent
  // directly so the handler test stays focused on handler behaviour.
  runWithRouter: async (opts: any) => ({
    result: await agentMap[opts.preferredAgent].run(opts),
    agentUsed: opts.preferredAgent,
    fellBack: false,
  }),
}));

import { setupTaskHandlers } from '../bot/handlers/topic/tasks.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { getRecentTopicMessages } from '../db/queries/topicMessages.js';

function seedProject(db: TestDb): number {
  const proj = insertProject(db, {
    name: 'test-project',
    localPath: '/tmp/test',
    topicId: 100,
    createdAt: new Date(),
  });
  return proj!.id;
}

function makeBotStub() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    command: (name: string, handler: Function) => { handlers[name] = handler; },
    api: { editMessageText: vi.fn().mockResolvedValue(undefined), sendMessage: vi.fn() },
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

function makeCtx(opts: { match?: string; userId?: number } = {}) {
  return {
    message: { message_thread_id: 100, chat: { id: -100123456789 } },
    chat: { id: -100123456789 },
    from: { id: opts.userId ?? 42, username: 'tester' },
    match: opts.match ?? '',
    reply: vi.fn().mockResolvedValue({ message_id: 555 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('/opencode handler', () => {
  let db: TestDb;
  let projectId: number;
  let bot: ReturnType<typeof makeBotStub>;
  let projectManager: ReturnType<typeof makeProjectManager>;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
    bot = makeBotStub();
    projectManager = makeProjectManager(projectId);
    mockOpenCodeRun.mockReset();
    mockOpenCodeRun.mockResolvedValue({
      success: true,
      result: 'opencode reply',
      sessionId: 'ses_abc',
      costUsd: 0,
      toolsUsed: { read: 1 },
    });
    setupTaskHandlers(bot as any, projectManager as any, db);
  });

  it('rejects empty prompt with a usage hint', async () => {
    const ctx = makeCtx({ match: '' });
    await bot.handlers['opencode'](ctx);
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toContain('Usage: /opencode');
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });

  it('rejects when used outside a project topic', async () => {
    projectManager.getByTopicId = vi.fn().mockReturnValue(null);
    const ctx = makeCtx({ match: 'do something' });
    await bot.handlers['opencode'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith('This command must be used in a project topic.');
    expect(mockOpenCodeRun).not.toHaveBeenCalled();
  });

  it('forwards the prompt and cwd to the agent', async () => {
    const ctx = makeCtx({ match: 'check if main builds' });
    await bot.handlers['opencode'](ctx);
    expect(mockOpenCodeRun).toHaveBeenCalledTimes(1);
    const args = mockOpenCodeRun.mock.calls[0][0];
    expect(args.cwd).toBe('/tmp/test');
    expect(args.prompt).toContain('check if main builds');
  });

  it('saves the user prompt and the opencode reply to shared history', async () => {
    const ctx = makeCtx({ match: 'list files' });
    await bot.handlers['opencode'](ctx);
    const msgs = getRecentTopicMessages(db, projectId);
    expect(msgs.length).toBe(2);
    const user = msgs.find(m => m.sender === 'user');
    const oc = msgs.find(m => m.sender === 'opencode');
    expect(user).toMatchObject({ text: 'list files', senderName: 'tester' });
    expect(oc).toMatchObject({ text: 'opencode reply' });
  });

  it('renders an OpenCode-branded footer (no cost when zero)', async () => {
    const ctx = makeCtx({ match: 'do thing' });
    await bot.handlers['opencode'](ctx);
    const finalText = ctx.api.editMessageText.mock.calls.at(-1)![2] as string;
    expect(finalText).toContain('Powered by OpenCode');
    // costUsd was 0, so the dollar amount is omitted
    expect(finalText).not.toContain('$');
  });

  it('renders cost in the footer when costUsd > 0', async () => {
    mockOpenCodeRun.mockResolvedValueOnce({
      success: true,
      result: 'paid reply',
      sessionId: 'ses_paid',
      costUsd: 0.012,
      toolsUsed: {},
    });
    const ctx = makeCtx({ match: 'something' });
    await bot.handlers['opencode'](ctx);
    const finalText = ctx.api.editMessageText.mock.calls.at(-1)![2] as string;
    expect(finalText).toContain('$0.0120');
  });

  it('shows an error message when the agent throws', async () => {
    mockOpenCodeRun.mockRejectedValueOnce(new Error('opencode binary missing'));
    const ctx = makeCtx({ match: 'try' });
    await bot.handlers['opencode'](ctx);
    const finalText = ctx.api.editMessageText.mock.calls.at(-1)![2] as string;
    expect(finalText).toContain('OpenCode error');
    expect(finalText).toContain('opencode binary missing');
  });

  it('strips --more flag from the prompt and the saved history', async () => {
    const ctx = makeCtx({ match: 'continue --more' });
    await bot.handlers['opencode'](ctx);
    const args = mockOpenCodeRun.mock.calls[0][0];
    expect(args.prompt).not.toContain('--more');
    const userMsg = getRecentTopicMessages(db, projectId).find(m => m.sender === 'user');
    expect(userMsg?.text).not.toContain('--more');
  });

  it('marks the response with sender="opencode" (distinct from claude/codex)', async () => {
    const ctx = makeCtx({ match: 'do thing' });
    await bot.handlers['opencode'](ctx);
    const msgs = getRecentTopicMessages(db, projectId);
    const senders = msgs.map(m => m.sender);
    expect(senders).toContain('opencode');
    expect(senders).not.toContain('claude');
    expect(senders).not.toContain('codex');
  });
});
