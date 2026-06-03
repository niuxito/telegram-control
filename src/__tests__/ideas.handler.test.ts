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
import {
  insertIdea,
  getRecentIdeas,
  appendIdeaEntry,
  getIdeaEntries,
} from '../db/queries/ideas.js';

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

  it('/idea list shows entry counts when notes have been appended', async () => {
    const idea = insertIdea(db, 'growing idea');
    appendIdeaEntry(db, idea.id, 'note 1');
    appendIdeaEntry(db, idea.id, 'note 2');
    const ctx = makeCtx({ match: 'list' });
    await bot.handlers['idea'](ctx);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('growing idea');
    expect(reply).toContain('2 notes');
  });

  it('/idea list omits the count marker for ideas with no entries', async () => {
    insertIdea(db, 'fresh idea');
    const ctx = makeCtx({ match: 'list' });
    await bot.handlers['idea'](ctx);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).not.toContain('notes]');
    expect(reply).not.toContain('note]');
  });

  describe('/idea show', () => {
    it('renders headline + chronological timeline of entries', async () => {
      const idea = insertIdea(db, 'main idea', { addedByName: 'alice' });
      appendIdeaEntry(db, idea.id, 'first follow-up',  { addedByName: 'bob' });
      appendIdeaEntry(db, idea.id, 'second follow-up', { addedByName: 'charlie' });
      const ctx = makeCtx({ match: `show ${idea.id}` });
      await bot.handlers['idea'](ctx);
      const reply = ctx.reply.mock.calls[0][0] as string;
      expect(reply).toContain('main idea');
      expect(reply).toContain('first follow-up');
      expect(reply).toContain('second follow-up');
      // Order must be first → second
      expect(reply.indexOf('first follow-up')).toBeLessThan(reply.indexOf('second follow-up'));
    });

    it('hints to use /idea append when the idea has no entries yet', async () => {
      const idea = insertIdea(db, 'lonely');
      const ctx = makeCtx({ match: `show ${idea.id}` });
      await bot.handlers['idea'](ctx);
      const reply = ctx.reply.mock.calls[0][0] as string;
      expect(reply).toContain('No extra notes');
      expect(reply).toContain('/idea append');
    });

    it('reports not found when the id does not exist', async () => {
      const ctx = makeCtx({ match: 'show 9999' });
      await bot.handlers['idea'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith('❌ Idea 9999 not found.');
    });

    it('reports usage hint when no id is supplied', async () => {
      const ctx = makeCtx({ match: 'show' });
      await bot.handlers['idea'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Usage: /idea show <id>');
    });
  });

  describe('/idea append', () => {
    it('adds an entry crediting the author', async () => {
      const idea = insertIdea(db, 'parent');
      const ctx = makeCtx({ match: `append ${idea.id} new detail`, userId: 13, username: 'derek' });
      await bot.handlers['idea'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(`✍️ Added a note to idea ${idea.id}.`);
      const [entry] = getIdeaEntries(db, idea.id);
      expect(entry.text).toBe('new detail');
      expect(entry.addedBy).toBe(13);
      expect(entry.addedByName).toBe('derek');
    });

    it('preserves multi-word note bodies', async () => {
      const idea = insertIdea(db, 'parent');
      const ctx = makeCtx({ match: `append ${idea.id} this has multiple words and spaces` });
      await bot.handlers['idea'](ctx);
      const [entry] = getIdeaEntries(db, idea.id);
      expect(entry.text).toBe('this has multiple words and spaces');
    });

    it('reports not found when the idea does not exist', async () => {
      const ctx = makeCtx({ match: 'append 9999 some note' });
      await bot.handlers['idea'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith('❌ Idea 9999 not found.');
    });

    it('reports usage hint when the id is non-numeric', async () => {
      const ctx = makeCtx({ match: 'append oops some note' });
      await bot.handlers['idea'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Usage: /idea append <id> <text>');
    });

    it('reports usage hint when the note body is empty', async () => {
      const idea = insertIdea(db, 'parent');
      const ctx = makeCtx({ match: `append ${idea.id}` });
      await bot.handlers['idea'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Usage: /idea append <id> <text>');
    });
  });
});
