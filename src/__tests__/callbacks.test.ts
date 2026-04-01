import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock config before any module that imports it ─────────────────────────────
vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake-token',
    SUPERGROUP_ID: -100123456789,
    NEW_PROJECTS_TOPIC_ID: 1,
    OWNER_USER_ID: 42,
    ANTHROPIC_API_KEY: 'fake-key',
    PROJECTS_BASE_DIR: '/tmp',
    DATA_DIR: '/tmp',
    LOG_LEVEL: 'info',
  },
}));

import { setupCallbackHandlers } from '../bot/handlers/callbacks.js';
import {
  getPendingGithubPublic,
  clearPendingGithubPublic,
  getPendingVercelDeploy,
  clearPendingVercelDeploy,
} from '../bot/handlers/projectTopic.js';
import { createTestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import type { TestDb } from './helpers/testDb.js';

const OWNER_ID = 42;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Creates a minimal in-memory DB with one project */
function makeDb(): { db: TestDb; projectId: number } {
  const { db } = createTestDb();
  const project = insertProject(db, {
    name: 'test-project',
    localPath: '/tmp/test-project',
    createdAt: new Date(),
    topicId: 100,
  });
  return { db, projectId: project!.id };
}

/** Simulates a bot that stores registered callback handlers by regex pattern */
function makeBotStub() {
  const handlers: Array<{ pattern: RegExp; handler: Function }> = [];
  return {
    callbackQuery: (pattern: RegExp, handler: Function) => {
      handlers.push({ pattern, handler });
    },
    /** Finds and calls the handler whose pattern matches data */
    triggerCallback: async (data: string, ctx: object) => {
      const entry = handlers.find((h) => h.pattern.test(data));
      if (!entry) throw new Error(`No handler matched: ${data}`);
      // Replicate Grammy's match array on ctx
      const match = data.match(entry.pattern)!;
      (ctx as any).match = match;
      await entry.handler(ctx);
    },
  };
}

/** Builds a minimal callback query context */
function makeCtx(opts: {
  userId?: number;
  data?: string;
} = {}) {
  const userId = opts.userId ?? OWNER_ID;
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const editMessageText = vi.fn().mockResolvedValue(undefined);

  return {
    from: { id: userId },
    callbackQuery: { data: opts.data ?? '' },
    answerCallbackQuery,
    editMessageText,
    // Expose mocks for assertions
    _answerCallbackQuery: answerCallbackQuery,
    _editMessageText: editMessageText,
  };
}

/** Builds a minimal mock session */
function makeSession(projectId: number) {
  return {
    queueTask: vi.fn().mockResolvedValue(1),
    getStatus: vi.fn().mockResolvedValue({ running: null, pendingCount: 0, session: null }),
    cancelCurrent: vi.fn(),
    isProcessing: vi.fn().mockReturnValue(false),
  };
}

// ── confirm_github_public ──────────────────────────────────────────────────────
describe('confirm_github_public callback', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let db: TestDb;
  let projectId: number;
  let projectManager: any;

  beforeEach(() => {
    bot = makeBotStub();
    ({ db, projectId } = makeDb());

    projectManager = {
      getSession: vi.fn(),
      createProject: vi.fn(),
      importProject: vi.fn(),
      scanUntracked: vi.fn().mockReturnValue([]),
      getByTopicId: vi.fn(),
      pauseProject: vi.fn(),
      archiveProject: vi.fn(),
      unpauseProject: vi.fn(),
      getAllProjects: vi.fn().mockReturnValue([]),
    };

    setupCallbackHandlers(bot, projectManager, db);

    // Clean up pending state before each test
    clearPendingGithubPublic(OWNER_ID);
    clearPendingVercelDeploy(OWNER_ID);
  });

  it('answers with "Unauthorized." when caller is not the owner', async () => {
    const ctx = makeCtx({ userId: 999 });
    await bot.triggerCallback(`confirm_github_public:${OWNER_ID}`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Unauthorized.');
  });

  it('answers with "Invalid token." when userId in data does not match owner', async () => {
    const ctx = makeCtx({ userId: OWNER_ID });
    // data contains userId 999, but OWNER_USER_ID is 42
    await bot.triggerCallback(`confirm_github_public:999`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Invalid token.');
  });

  it('answers with "No pending confirmation found." when map has no entry', async () => {
    // No entry was set in pendingGithubPublic
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_github_public:${OWNER_ID}`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('No pending confirmation found.');
  });

  it('answers with "Project session not found." when session does not exist', async () => {
    // Strategy:
    // 1. Populate the pending map via the command handler (session must exist at command time).
    // 2. Swap getSession to return undefined BEFORE the callback fires.

    const commandHandlers: Record<string, Function> = {};
    const commandBot: any = {
      command: (name: string, handler: Function) => {
        commandHandlers[name] = handler;
      },
      on: () => {},
    };

    const session = makeSession(projectId);
    projectManager.getByTopicId = vi.fn().mockReturnValue({
      id: projectId,
      name: 'test-project',
      localPath: '/tmp/test-project',
      topicId: 100,
      status: 'active',
      watchFiles: true,
      watchGit: true,
      createdAt: new Date(),
      archivedAt: null,
      gitCheckAt: null,
    });
    // Session present at command time so the map entry IS set
    projectManager.getSession = vi.fn().mockReturnValue(session);

    const { setupProjectTopicHandlers } = await import('../bot/handlers/projectTopic.js');
    setupProjectTopicHandlers(commandBot, projectManager, db);

    const commandCtx = {
      message: { message_thread_id: 100, chat: { id: -100 } },
      from: { id: OWNER_ID },
      match: 'public',
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await commandHandlers['github'](commandCtx);

    // Simulate session disappearing between command and callback
    projectManager.getSession = vi.fn().mockReturnValue(undefined);

    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_github_public:${OWNER_ID}`, ctx);

    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Project session not found.');
    expect(ctx._editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Project session not found')
    );
  });

  it('queues a public GitHub task and edits message on success', async () => {
    // Set up a pending github public entry via the command handler
    const commandHandlers: Record<string, Function> = {};
    const commandBot: any = {
      command: (name: string, handler: Function) => {
        commandHandlers[name] = handler;
      },
      on: () => {},
    };

    const session = makeSession(projectId);
    projectManager.getByTopicId = vi.fn().mockReturnValue({
      id: projectId,
      name: 'test-project',
      localPath: '/tmp/test-project',
      topicId: 100,
      status: 'active',
      watchFiles: true,
      watchGit: true,
      createdAt: new Date(),
      archivedAt: null,
      gitCheckAt: null,
    });
    projectManager.getSession = vi.fn().mockReturnValue(session);

    const { setupProjectTopicHandlers } = await import('../bot/handlers/projectTopic.js');
    setupProjectTopicHandlers(commandBot, projectManager, db);

    const commandCtx = {
      message: { message_thread_id: 100, chat: { id: -100 } },
      from: { id: OWNER_ID },
      match: 'public',
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await commandHandlers['github'](commandCtx);

    // Confirm the callback
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_github_public:${OWNER_ID}`, ctx);

    // Session should have been asked to queue a task
    expect(session.queueTask).toHaveBeenCalledOnce();
    const prompt: string = session.queueTask.mock.calls[0][0];
    expect(prompt).toContain('public'); // buildGithubPrompt with 'public'

    // Edit message should show success
    expect(ctx._editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('GitHub repo task queued')
    );

    // Pending state should be cleared
    expect(getPendingGithubPublic(OWNER_ID)).toBeUndefined();
  });
});

// ── cancel_github_public ───────────────────────────────────────────────────────
describe('cancel_github_public callback', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let db: TestDb;
  let projectManager: any;

  beforeEach(() => {
    bot = makeBotStub();
    ({ db } = makeDb());
    projectManager = {
      getSession: vi.fn(),
      createProject: vi.fn(),
      importProject: vi.fn(),
      scanUntracked: vi.fn().mockReturnValue([]),
      getByTopicId: vi.fn(),
      pauseProject: vi.fn(),
      archiveProject: vi.fn(),
      unpauseProject: vi.fn(),
    };
    setupCallbackHandlers(bot, projectManager, db);
    clearPendingGithubPublic(OWNER_ID);
    clearPendingVercelDeploy(OWNER_ID);
  });

  it('answers with "Unauthorized." when caller is not the owner', async () => {
    const ctx = makeCtx({ userId: 999 });
    await bot.triggerCallback(`cancel_github_public:${OWNER_ID}`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Unauthorized.');
  });

  it('answers with "Cancelled." and edits message when owner cancels', async () => {
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`cancel_github_public:${OWNER_ID}`, ctx);

    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Cancelled.');
    expect(ctx._editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('cancelled')
    );
  });

  it('clears the pendingGithubPublic entry for the userId', async () => {
    // Pre-condition: simulate a pending entry by running the command handler
    const commandHandlers: Record<string, Function> = {};
    const commandBot: any = {
      command: (name: string, handler: Function) => {
        commandHandlers[name] = handler;
      },
      on: () => {},
    };

    projectManager.getByTopicId = vi.fn().mockReturnValue({
      id: 1,
      name: 'test-project',
      localPath: '/tmp',
      topicId: 100,
      status: 'active',
      watchFiles: true,
      watchGit: true,
      createdAt: new Date(),
      archivedAt: null,
      gitCheckAt: null,
    });
    projectManager.getSession = vi.fn().mockReturnValue(makeSession(1));

    const { setupProjectTopicHandlers } = await import('../bot/handlers/projectTopic.js');
    setupProjectTopicHandlers(commandBot, projectManager, db);

    const commandCtx = {
      message: { message_thread_id: 100, chat: { id: -100 } },
      from: { id: OWNER_ID },
      match: 'public',
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await commandHandlers['github'](commandCtx);

    // Now cancel
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`cancel_github_public:${OWNER_ID}`, ctx);

    expect(getPendingGithubPublic(OWNER_ID)).toBeUndefined();
  });
});

// ── confirm_vercel_deploy ─────────────────────────────────────────────────────
describe('confirm_vercel_deploy callback', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let db: TestDb;
  let projectId: number;
  let projectManager: any;

  beforeEach(() => {
    bot = makeBotStub();
    ({ db, projectId } = makeDb());
    projectManager = {
      getSession: vi.fn(),
      createProject: vi.fn(),
      importProject: vi.fn(),
      scanUntracked: vi.fn().mockReturnValue([]),
      getByTopicId: vi.fn(),
      pauseProject: vi.fn(),
      archiveProject: vi.fn(),
      unpauseProject: vi.fn(),
    };
    setupCallbackHandlers(bot, projectManager, db);
    clearPendingGithubPublic(OWNER_ID);
    clearPendingVercelDeploy(OWNER_ID);
  });

  it('answers with "Unauthorized." when caller is not the owner', async () => {
    const ctx = makeCtx({ userId: 999 });
    await bot.triggerCallback(`confirm_vercel_deploy:${OWNER_ID}`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Unauthorized.');
  });

  it('answers with "Invalid token." when userId in data does not match owner', async () => {
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_vercel_deploy:999`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Invalid token.');
  });

  it('answers with "No pending confirmation found." when no deploy is pending', async () => {
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_vercel_deploy:${OWNER_ID}`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('No pending confirmation found.');
  });

  it('answers "Project session not found." when session is missing', async () => {
    // Strategy:
    // 1. Populate the pending map with session present at command time.
    // 2. Swap getSession to undefined before the callback fires.
    const commandHandlers: Record<string, Function> = {};
    const commandBot: any = {
      command: (name: string, handler: Function) => {
        commandHandlers[name] = handler;
      },
      on: () => {},
    };

    const session = makeSession(projectId);
    projectManager.getByTopicId = vi.fn().mockReturnValue({
      id: projectId,
      name: 'test-project',
      localPath: '/tmp/test-project',
      topicId: 100,
      status: 'active',
      watchFiles: true,
      watchGit: true,
      createdAt: new Date(),
      archivedAt: null,
      gitCheckAt: null,
    });
    // Session present when command fires — map entry gets set
    projectManager.getSession = vi.fn().mockReturnValue(session);

    const { setupProjectTopicHandlers } = await import('../bot/handlers/projectTopic.js');
    setupProjectTopicHandlers(commandBot, projectManager, db);

    const commandCtx = {
      message: { message_thread_id: 100, chat: { id: -100 } },
      from: { id: OWNER_ID },
      match: 'deploy',
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await commandHandlers['vercel'](commandCtx);

    // Simulate session disappearing between command and callback
    projectManager.getSession = vi.fn().mockReturnValue(undefined);

    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_vercel_deploy:${OWNER_ID}`, ctx);

    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Project session not found.');
  });

  it('queues a Vercel production deploy task and edits message on success', async () => {
    const commandHandlers: Record<string, Function> = {};
    const commandBot: any = {
      command: (name: string, handler: Function) => {
        commandHandlers[name] = handler;
      },
      on: () => {},
    };

    const session = makeSession(projectId);
    projectManager.getByTopicId = vi.fn().mockReturnValue({
      id: projectId,
      name: 'test-project',
      localPath: '/tmp/test-project',
      topicId: 100,
      status: 'active',
      watchFiles: true,
      watchGit: true,
      createdAt: new Date(),
      archivedAt: null,
      gitCheckAt: null,
    });
    projectManager.getSession = vi.fn().mockReturnValue(session);

    const { setupProjectTopicHandlers } = await import('../bot/handlers/projectTopic.js');
    setupProjectTopicHandlers(commandBot, projectManager, db);

    const commandCtx = {
      message: { message_thread_id: 100, chat: { id: -100 } },
      from: { id: OWNER_ID },
      match: 'deploy',
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await commandHandlers['vercel'](commandCtx);

    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`confirm_vercel_deploy:${OWNER_ID}`, ctx);

    expect(session.queueTask).toHaveBeenCalledOnce();
    // The prompt should contain the deploy instructions
    const prompt: string = session.queueTask.mock.calls[0][0];
    expect(prompt).toContain('vercel --prod');

    expect(ctx._editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Vercel')
    );

    // Pending state cleared
    expect(getPendingVercelDeploy(OWNER_ID)).toBeUndefined();
  });
});

// ── cancel_vercel_deploy ──────────────────────────────────────────────────────
describe('cancel_vercel_deploy callback', () => {
  let bot: ReturnType<typeof makeBotStub>;
  let db: TestDb;
  let projectManager: any;

  beforeEach(() => {
    bot = makeBotStub();
    ({ db } = makeDb());
    projectManager = {
      getSession: vi.fn(),
      createProject: vi.fn(),
      importProject: vi.fn(),
      scanUntracked: vi.fn().mockReturnValue([]),
      getByTopicId: vi.fn(),
      pauseProject: vi.fn(),
      archiveProject: vi.fn(),
      unpauseProject: vi.fn(),
    };
    setupCallbackHandlers(bot, projectManager, db);
    clearPendingGithubPublic(OWNER_ID);
    clearPendingVercelDeploy(OWNER_ID);
  });

  it('answers with "Unauthorized." when caller is not the owner', async () => {
    const ctx = makeCtx({ userId: 999 });
    await bot.triggerCallback(`cancel_vercel_deploy:${OWNER_ID}`, ctx);
    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Unauthorized.');
  });

  it('answers with "Cancelled." and edits message on cancel', async () => {
    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`cancel_vercel_deploy:${OWNER_ID}`, ctx);

    expect(ctx._answerCallbackQuery).toHaveBeenCalledWith('Cancelled.');
    expect(ctx._editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('cancelled')
    );
  });

  it('clears the pendingVercelDeploy entry for the userId', async () => {
    const commandHandlers: Record<string, Function> = {};
    const commandBot: any = {
      command: (name: string, handler: Function) => {
        commandHandlers[name] = handler;
      },
      on: () => {},
    };

    projectManager.getByTopicId = vi.fn().mockReturnValue({
      id: 1,
      name: 'test-project',
      localPath: '/tmp',
      topicId: 100,
      status: 'active',
      watchFiles: true,
      watchGit: true,
      createdAt: new Date(),
      archivedAt: null,
      gitCheckAt: null,
    });
    projectManager.getSession = vi.fn().mockReturnValue(makeSession(1));

    const { setupProjectTopicHandlers } = await import('../bot/handlers/projectTopic.js');
    setupProjectTopicHandlers(commandBot, projectManager, db);

    const commandCtx = {
      message: { message_thread_id: 100, chat: { id: -100 } },
      from: { id: OWNER_ID },
      match: 'deploy',
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await commandHandlers['vercel'](commandCtx);

    const ctx = makeCtx({ userId: OWNER_ID });
    await bot.triggerCallback(`cancel_vercel_deploy:${OWNER_ID}`, ctx);

    expect(getPendingVercelDeploy(OWNER_ID)).toBeUndefined();
  });
});
