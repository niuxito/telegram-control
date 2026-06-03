import type { Context } from 'grammy';
import type { Db } from '../../db/client.js';
import {
  appendIdeaEntry,
  clearIdeas,
  deleteIdea,
  getIdeaThread,
  getRecentIdeas,
  insertIdea,
} from '../../db/queries/ideas.js';

// /idea               — list recent ideas (alias of /idea list)
// /idea <text>        — add a new idea
// /idea list          — list recent ideas
// /idea show <id>     — show the full idea thread
// /idea append <id> <text> — add a note to an idea
// /idea delete <id>   — delete one
// /idea clear         — clear all
//
// Global: works from any chat (DM, main group, project topic). Not tied to a
// project; this is the backlog of *future* projects.

function formatIdeaDate(value: Date | string | number): string {
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatIdeaAuthor(name?: string | null): string {
  return name ? ` (${name})` : '';
}

function formatIdeaListLine(idea: { id: number; createdAt: Date; addedByName?: string | null; text: string; entryCount: number }) {
  const notes = idea.entryCount > 0 ? ` [${idea.entryCount} note${idea.entryCount === 1 ? '' : 's'}]` : '';
  return `[${idea.id}] ${formatIdeaDate(idea.createdAt)}${formatIdeaAuthor(idea.addedByName)}${notes}: ${idea.text}`;
}

function formatIdeaThread(thread: NonNullable<ReturnType<typeof getIdeaThread>>) {
  const lines = [
    `#${thread.idea.id} ${thread.idea.text}`,
    `Added: ${formatIdeaDate(thread.idea.createdAt)}${formatIdeaAuthor(thread.idea.addedByName)}`,
  ];

  if (thread.entries.length === 0) {
    lines.push('');
    lines.push('No extra notes yet. Use /idea append <id> <text> to expand it.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Timeline:');
  for (const entry of thread.entries) {
    lines.push(`- ${formatIdeaDate(entry.createdAt)}${formatIdeaAuthor(entry.addedByName)}: ${entry.text}`);
  }
  return lines.join('\n');
}

export function setupIdeasHandler(bot: any, db: Db): void {
  bot.command('idea', async (ctx: Context) => {
    const arg = ((ctx.match as string) || '').trim();
    const [sub, ...rest] = arg.split(/\s+/);
    const tail = rest.join(' ').trim();

    // Bare /idea or /idea list → show the backlog
    if (!arg || arg === 'list') {
      const items = getRecentIdeas(db, 20);
      if (items.length === 0) {
        await ctx.reply('No ideas yet. Add one with /idea <text>');
        return;
      }
      const lines = items.map(formatIdeaListLine).join('\n');
      await ctx.reply(`💡 Ideas backlog:\n\`\`\`\n${lines}\n\`\`\``, { parse_mode: 'Markdown' });
      return;
    }

    if (sub === 'show') {
      const id = parseInt(rest[0] ?? '', 10);
      if (isNaN(id)) {
        await ctx.reply('Usage: /idea show <id>');
        return;
      }
      const thread = getIdeaThread(db, id);
      if (!thread) {
        await ctx.reply(`❌ Idea ${id} not found.`);
        return;
      }
      await ctx.reply(`💡 Idea thread:\n\`\`\`\n${formatIdeaThread(thread)}\n\`\`\``, { parse_mode: 'Markdown' });
      return;
    }

    if (sub === 'append') {
      const id = parseInt(rest[0] ?? '', 10);
      // The note body is everything after the id, NOT including the id itself.
      const noteText = rest.slice(1).join(' ').trim();
      if (isNaN(id) || !noteText) {
        await ctx.reply('Usage: /idea append <id> <text>');
        return;
      }
      const entry = appendIdeaEntry(db, id, noteText, {
        addedBy: ctx.from?.id,
        addedByName: ctx.from?.username ?? ctx.from?.first_name ?? undefined,
      });
      if (!entry) {
        await ctx.reply(`❌ Idea ${id} not found.`);
        return;
      }
      await ctx.reply(`✍️ Added a note to idea ${id}.`);
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
