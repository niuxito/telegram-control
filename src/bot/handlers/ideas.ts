import type { Context } from 'grammy';
import type { Db } from '../../db/client.js';
import { insertIdea, getRecentIdeas, deleteIdea, clearIdeas } from '../../db/queries/ideas.js';

// /idea               — list recent ideas (alias of /idea list)
// /idea <text>        — add a new idea
// /idea list          — list recent ideas
// /idea delete <id>   — delete one
// /idea clear         — clear all
//
// Global: works from any chat (DM, main group, project topic). Not tied to a
// project; this is the backlog of *future* projects.

export function setupIdeasHandler(bot: any, db: Db): void {
  bot.command('idea', async (ctx: Context) => {
    const arg = ((ctx.match as string) || '').trim();

    // Bare /idea or /idea list → show the backlog
    if (!arg || arg === 'list') {
      const items = getRecentIdeas(db, 20);
      if (items.length === 0) {
        await ctx.reply('No ideas yet. Add one with /idea <text>');
        return;
      }
      const lines = items.map(i => {
        const date = new Date(i.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        const author = i.addedByName ? ` (${i.addedByName})` : '';
        return `[${i.id}] ${date}${author}: ${i.text}`;
      }).join('\n');
      await ctx.reply(`💡 Ideas backlog:\n\`\`\`\n${lines}\n\`\`\``, { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'clear') {
      const count = clearIdeas(db);
      await ctx.reply(`🗑 Cleared ${count} idea(s).`);
      return;
    }

    if (arg.startsWith('delete ')) {
      const id = parseInt(arg.slice('delete '.length).trim(), 10);
      if (isNaN(id)) {
        await ctx.reply('Usage: /idea delete <id>');
        return;
      }
      const deleted = deleteIdea(db, id);
      await ctx.reply(deleted ? `✅ Idea ${id} deleted.` : `❌ Idea ${id} not found.`);
      return;
    }

    // Anything else is the body of a new idea
    insertIdea(db, arg, {
      addedBy: ctx.from?.id,
      addedByName: ctx.from?.username ?? ctx.from?.first_name ?? undefined,
    });
    await ctx.reply('💡 Idea saved.');
  });
}
