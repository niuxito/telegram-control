import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake', SUPERGROUP_ID: -1, NEW_PROJECTS_TOPIC_ID: 2,
    OWNER_USER_ID: 42, ANTHROPIC_API_KEY: 'x', PROJECTS_BASE_DIR: '/tmp',
    DATA_DIR: '/tmp', LOG_LEVEL: 'info',
  },
}));

import { setupConfigHandlers } from '../bot/handlers/topic/config.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertSession, getLatestSession } from '../db/queries/sessions.js';

function makeBotStub() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    command: (name: string, fn: Function) => { handlers[name] = fn; },
  };
}

function makeCtx(threadId: number) {
  return {
    message: { message_thread_id: threadId },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

describe('/newsession', () => {
  let db: TestDb;
  let bot: ReturnType<typeof makeBotStub>;
  let projectId: number;
  const topicId = 100;

  beforeEach(() => {
    ({ db } = createTestDb());
    const project = insertProject(db, {
      name: 'test-project',
      localPath: '/tmp/test-project',
      createdAt: new Date(),
      topicId,
    });
    projectId = project!.id;

    const projectManager = {
      getByTopicId: (tid: number) => (tid === topicId ? project : undefined),
    };

    bot = makeBotStub();
    setupConfigHandlers(bot as any, projectManager as any, db);
  });

  it('actually clears the stored claudeSessionId so the next task starts fresh', async () => {
    insertSession(db, {
      projectId,
      claudeSessionId: 'stale-session-id',
      lastUsedAt: new Date(),
    });

    await bot.handlers['newsession'](makeCtx(topicId));

    const session = getLatestSession(db, projectId);
    expect(session?.claudeSessionId).toBeNull();
  });

  it('confirms the reset to the user', async () => {
    insertSession(db, {
      projectId,
      claudeSessionId: 'stale-session-id',
      lastUsedAt: new Date(),
    });

    const ctx = makeCtx(topicId);
    await bot.handlers['newsession'](ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Session reset'));
  });

  it('does not throw when there is no session yet', async () => {
    const ctx = makeCtx(topicId);
    await bot.handlers['newsession'](ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No session to reset'));
  });

  it('does nothing outside a project topic', async () => {
    const ctx = makeCtx(999);
    await bot.handlers['newsession'](ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
