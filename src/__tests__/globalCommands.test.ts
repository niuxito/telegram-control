import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake',
    SUPERGROUP_ID: -1,
    NEW_PROJECTS_TOPIC_ID: 2,
    OWNER_USER_ID: 42,
    ANTHROPIC_API_KEY: 'x',
    PROJECTS_BASE_DIR: '/tmp',
    DATA_DIR: '/tmp',
    LOG_LEVEL: 'info',
  },
}));

import { setupGlobalCommands } from '../bot/handlers/commands.js';
import { createTestDb } from './helpers/testDb.js';

function makeBotStub() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    command: (name: string, fn: Function) => { handlers[name] = fn; },
  };
}

function makeProjectManager() {
  return {};
}

function makeCtx() {
  return {
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

describe('global commands help', () => {
  it('documents the idea thread commands', async () => {
    const { db } = createTestDb();
    const bot = makeBotStub();
    setupGlobalCommands(bot as any, makeProjectManager() as any, db);

    const ctx = makeCtx();
    await bot.handlers['help'](ctx);

    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('/idea show <id> — show one idea as a thread');
    expect(reply).toContain('/idea append <id> <text> — add more detail to an idea');
  });
});
