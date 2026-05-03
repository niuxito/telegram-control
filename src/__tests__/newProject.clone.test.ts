import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be defined before vi.mock factories run) ──────────────
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

// ── Mock config before any module that imports it ─────────────────────────────
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

// ── Mock execFileAsync (the promisified execFile used by listGithubRepos) ─────
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));

import { setupNewProjectHandler } from '../bot/handlers/newProject.js';
import {
  getPendingClone,
  clearPendingClone,
  setPendingClone,
} from '../bot/handlers/newProject.js';

const NEW_PROJECTS_TOPIC_ID = 2;
const OTHER_TOPIC_ID = 99;
const OWNER_ID = 42;

// ── Bot stub ──────────────────────────────────────────────────────────────────

function makeBotStub() {
  const handlers: Record<string, Function> = {};
  return {
    command: (name: string, handler: Function) => { handlers[name] = handler; },
    triggerCommand: async (name: string, ctx: object) => {
      if (!handlers[name]) throw new Error(`No handler for command: ${name}`);
      await handlers[name](ctx);
    },
  };
}

// ── Minimal ProjectManager stub ───────────────────────────────────────────────

function makeProjectManager() {
  return {
    cloneProject: vi.fn().mockResolvedValue({
      id: 1,
      name: 'my-repo',
      localPath: '/tmp/projects/my-repo',
      topicId: 50,
    }),
    scanUntracked: vi.fn().mockReturnValue([]),
    createProject: vi.fn(),
    importProject: vi.fn(),
  };
}

// ── Context builder ───────────────────────────────────────────────────────────

function makeCtx(opts: {
  threadId?: number;
  match?: string;
  userId?: number;
} = {}) {
  const reply = vi.fn().mockResolvedValue({ message_id: 1 });
  const api = { editMessageText: vi.fn().mockResolvedValue(undefined) };

  return {
    message: {
      message_thread_id: opts.threadId,
      chat: { id: -100 },
    },
    chat: { id: -100 },
    from: { id: opts.userId ?? OWNER_ID },
    match: opts.match ?? '',
    reply,
    api,
    _reply: reply,
    _editMessageText: api.editMessageText,
  };
}

// ── /clone topic guard ────────────────────────────────────────────────────────

describe('/clone — topic guard', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let projectManager: ReturnType<typeof makeProjectManager>;

  beforeEach(() => {
    bot = makeBotStub();
    projectManager = makeProjectManager();
    setupNewProjectHandler(bot, projectManager);
    clearPendingClone(OWNER_ID);
  });

  it('blocks the command when sent from a different topic', async () => {
    const ctx = makeCtx({ threadId: OTHER_TOPIC_ID });
    await bot.triggerCommand('clone', ctx);
    expect(ctx._reply).toHaveBeenCalledWith(
      expect.stringContaining('New Projects topic')
    );
  });

  it('blocks the command when message_thread_id is undefined (not in a forum topic)', async () => {
    const ctx = makeCtx({ threadId: undefined });
    await bot.triggerCommand('clone', ctx);
    expect(ctx._reply).toHaveBeenCalledWith(
      expect.stringContaining('New Projects topic')
    );
  });

  it('does NOT block when sent from the New Projects topic', async () => {
    // With a URL so it goes to confirmation, not gh repo list
    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: 'https://github.com/user/repo' });
    await bot.triggerCommand('clone', ctx);
    // Should show confirmation, not the warning
    const replyText: string = ctx._reply.mock.calls[0]?.[0] ?? '';
    expect(replyText).not.toContain('can only be used');
  });
});

// ── /clone with URL ───────────────────────────────────────────────────────────

describe('/clone <url> — confirmation flow', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let projectManager: ReturnType<typeof makeProjectManager>;

  beforeEach(() => {
    bot = makeBotStub();
    projectManager = makeProjectManager();
    setupNewProjectHandler(bot, projectManager);
    clearPendingClone(OWNER_ID);
  });

  it('sets pendingClone with the given URL', async () => {
    const url = 'https://github.com/user/my-repo';
    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: url });
    await bot.triggerCommand('clone', ctx);
    expect(getPendingClone(OWNER_ID)).toEqual({ url });
  });

  it('replies with a confirmation message containing the URL', async () => {
    const url = 'https://github.com/user/my-repo';
    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: url });
    await bot.triggerCommand('clone', ctx);
    const replyText: string = ctx._reply.mock.calls[0][0];
    expect(replyText).toContain(url);
  });

  it('includes confirm and cancel keyboard buttons', async () => {
    const url = 'https://github.com/user/my-repo';
    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: url });
    await bot.triggerCommand('clone', ctx);
    const replyOptions = ctx._reply.mock.calls[0][1];
    expect(replyOptions?.reply_markup).toBeDefined();
  });
});

// ── /clone without URL — gh repo list ────────────────────────────────────────

describe('/clone (no url) — GitHub repo listing', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let projectManager: ReturnType<typeof makeProjectManager>;

  beforeEach(() => {
    bot = makeBotStub();
    projectManager = makeProjectManager();
    setupNewProjectHandler(bot, projectManager);
    clearPendingClone(OWNER_ID);
  });

  it('sends a "Fetching..." message before calling gh', async () => {
    mockExecFile.mockResolvedValue({ stdout: '[]', stderr: '' });

    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: '' });
    await bot.triggerCommand('clone', ctx);
    expect(ctx._reply).toHaveBeenCalledWith(
      expect.stringContaining('Fetching')
    );
  });

  it('shows error if gh fails', async () => {
    mockExecFile.mockRejectedValue(new Error('gh not found'));

    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: '' });
    await bot.triggerCommand('clone', ctx);
    expect(ctx._editMessageText).toHaveBeenCalledWith(
      -100,
      1,
      expect.stringContaining('Failed')
    );
  });

  it('shows error when repo list is empty', async () => {
    mockExecFile.mockResolvedValue({ stdout: '[]', stderr: '' });

    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: '' });
    await bot.triggerCommand('clone', ctx);
    expect(ctx._editMessageText).toHaveBeenCalledWith(
      -100,
      1,
      expect.stringContaining('No repositories found')
    );
  });

  it('shows inline keyboard with repos when gh succeeds', async () => {
    const repos = [
      { nameWithOwner: 'user/repo-a', url: 'https://github.com/user/repo-a', isPrivate: false, description: '' },
      { nameWithOwner: 'user/repo-b', url: 'https://github.com/user/repo-b', isPrivate: true, description: 'private' },
    ];
    mockExecFile.mockResolvedValue({ stdout: JSON.stringify(repos), stderr: '' });

    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: '' });
    await bot.triggerCommand('clone', ctx);

    const [, , text, opts] = ctx._editMessageText.mock.calls[0];
    expect(text).toContain('2'); // "2 repositories"
    expect(opts?.reply_markup).toBeDefined();
  });

  it('uses index-based callback data to stay under 64-byte Telegram limit', async () => {
    const repos = [
      { nameWithOwner: 'user/a-very-long-repository-name-that-would-overflow', url: 'https://github.com/user/a-very-long-repository-name-that-would-overflow', isPrivate: false, description: '' },
    ];
    mockExecFile.mockResolvedValue({ stdout: JSON.stringify(repos), stderr: '' });

    const ctx = makeCtx({ threadId: NEW_PROJECTS_TOPIC_ID, match: '' });
    await bot.triggerCommand('clone', ctx);

    const [, , , opts] = ctx._editMessageText.mock.calls[0];
    const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
    for (const btn of buttons) {
      expect(btn.callback_data?.length ?? 0).toBeLessThanOrEqual(64);
    }
  });
});

// ── setPendingClone / getPendingClone / clearPendingClone ─────────────────────

describe('pendingClone map helpers', () => {
  beforeEach(() => clearPendingClone(OWNER_ID));

  it('setPendingClone stores the url', () => {
    setPendingClone(OWNER_ID, 'https://github.com/x/y');
    expect(getPendingClone(OWNER_ID)).toEqual({ url: 'https://github.com/x/y' });
  });

  it('clearPendingClone removes the entry', () => {
    setPendingClone(OWNER_ID, 'https://github.com/x/y');
    clearPendingClone(OWNER_ID);
    expect(getPendingClone(OWNER_ID)).toBeUndefined();
  });

  it('getPendingClone returns undefined for unknown userId', () => {
    expect(getPendingClone(999)).toBeUndefined();
  });
});
