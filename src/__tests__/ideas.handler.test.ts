import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake', SUPERGROUP_ID: -1, NEW_PROJECTS_TOPIC_ID: 2,
    OWNER_USER_ID: 42, ANTHROPIC_API_KEY: 'x', PROJECTS_BASE_DIR: '/tmp',
    DATA_DIR: '/tmp', LOG_LEVEL: 'info',
  },
}));

import { setupIdeasHandler } from '../bot/handlers/ideas.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertIdea, getRecentIdeas } from '../db/queries/ideas.js';

function makeBotStub() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    command: (name: string, fn: Function) => { handlers[name] = fn; },
  };
}

function makeCtx(opts: { match?: string; userId?: number; username?: string } = {}) {
  return {
    match: opts.match ?? '',
    from: { id: opts.userId ?? 42, username: opts.username ?? 'tester', first_name: 'Test' },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

describe('/idea handler', () => {
  let db: TestDb;
  let bot: ReturnType<typeof makeBotStub>;

  beforeEach(() => {
    ({ db } = createTestDb());
    bot = makeBotStub();
    setupIdeasHandler(bot as any, db);
  });

  it('saves a new idea with addedBy / addedByName from the context', async () => {
    const ctx = makeCtx({ match: 'build a price tracker', userId: 7, username: 'alice' });
    await bot.handlers['idea'](ctx);

    const items = getRecentIdeas(db);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      text: 'build a price tracker',
      addedBy: 7,
      addedByName: 'alice',
    });
    expect(ctx.reply).toHaveBeenCalledWith('💡 Idea saved.');
  });

  it('falls back to first_name when username is missing', async () => {
    const ctx = {
      match: 'an idea',
      from: { id: 1, first_name: 'Bob' },
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    };
    await bot.handlers['idea'](ctx as any);
    const [item] = getRecentIdeas(db);
    expect(item.addedByName).toBe('Bob');
  });

  it('bare /idea lists ideas when the backlog has items', async () => {
    insertIdea(db, 'idea one');
    insertIdea(db, 'idea two');
    const ctx = makeCtx({ match: '' });
    await bot.handlers['idea'](ctx);

    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('Ideas backlog');
    expect(reply).toContain('idea one');
    expect(reply).toContain('idea two');
  });

  it('bare /idea on an empty backlog shows the empty-state hint', async () => {
    const ctx = makeCtx({ match: '' });
    await bot.handlers['idea'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith('No ideas yet. Add one with /idea <text>');
  });

  it('/idea list behaves like bare /idea', async () => {
    insertIdea(db, 'one');
    const ctx = makeCtx({ match: 'list' });
    await bot.handlers['idea'](ctx);
    expect(ctx.reply.mock.calls[0][0] as string).toContain('one');
  });

  it('/idea clear empties the backlog and reports the count', async () => {
    insertIdea(db, 'a');
    insertIdea(db, 'b');
    insertIdea(db, 'c');
    const ctx = makeCtx({ match: 'clear' });
    await bot.handlers['idea'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith('🗑 Cleared 3 idea(s).');
    expect(getRecentIdeas(db)).toEqual([]);
  });

  it('/idea delete <id> removes one and reports success', async () => {
    insertIdea(db, 'survive');
    insertIdea(db, 'remove');
    const target = getRecentIdeas(db).find(i => i.text === 'remove')!;
    const ctx = makeCtx({ match: `delete ${target.id}` });
    await bot.handlers['idea'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith(`✅ Idea ${target.id} deleted.`);
    expect(getRecentIdeas(db).map(i => i.text)).toEqual(['survive']);
  });

  it('/idea delete <missing-id> reports not found, leaves backlog intact', async () => {
    insertIdea(db, 'keep');
    const ctx = makeCtx({ match: 'delete 9999' });
    await bot.handlers['idea'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith('❌ Idea 9999 not found.');
    expect(getRecentIdeas(db).length).toBe(1);
  });

  it('/idea delete with non-numeric id shows usage hint', async () => {
    const ctx = makeCtx({ match: 'delete oops' });
    await bot.handlers['idea'](ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /idea delete <id>');
  });

  it('credit line includes the username when the idea has addedByName', async () => {
    insertIdea(db, 'shared idea', { addedBy: 99, addedByName: 'bob' });
    const ctx = makeCtx({ match: 'list' });
    await bot.handlers['idea'](ctx);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('(bob)');
    expect(reply).toContain('shared idea');
  });
});
