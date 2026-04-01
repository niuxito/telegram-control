import type { Context } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { addGuest, removeGuest, listGuests } from '../../db/queries/guests.js';
import type { Db } from '../../db/client.js';

export function setupGlobalCommands(bot: any, projectManager: ProjectManager, db: Db): void {
  bot.command('start', async (ctx: Context) => {
    await ctx.reply(
      '🤖 *Telegram Control Center*\n\nManage your Claude Code projects from Telegram.\n\n' +
      'Commands:\n' +
      '/list - List all projects\n' +
      '/help - Show help\n\n' +
      'Go to "New Projects" topic to create a project.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', async (ctx: Context) => {
    await ctx.reply(
      'Global Commands:\n' +
      '/list - List projects\n\n' +
      'New Projects topic:\n' +
      '/new <name> - Create project at PROJECTS_BASE_DIR/<name>\n' +
      '/import - Scan and import existing projects\n' +
      '/import <name> - Import specific project by name\n\n' +
      'Project topic commands:\n' +
      '/task <prompt> - Run Claude task\n' +
      '/status - Project status\n' +
      '/queue - Show task queue\n' +
      '/cancel - Cancel current task\n' +
      '/session - Session info\n' +
      '/git - Recent git log\n' +
      '/files - List files\n' +
      '/watch on|off - Toggle file watching\n' +
      '/gitwatch on|off - Toggle git watching\n' +
      '/pause - Pause project\n' +
      '/unpause - Resume project\n' +
      '/archive - Archive project\n' +
      '/info - Project info'
    );
  });

  // /guest add <user_id> [note] | /guest remove <user_id> | /guest list
  bot.command('guest', async (ctx: Context) => {
    const args = ((ctx.match as string) || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    if (sub === 'list') {
      const all = listGuests(db);
      if (all.length === 0) {
        await ctx.reply('No guests registered.');
        return;
      }
      const lines = all.map(g => `• ${g.userId}${g.note ? ` — ${g.note}` : ''}`).join('\n');
      await ctx.reply(`Guests:\n${lines}`);
      return;
    }

    if (sub === 'add') {
      const userId = parseInt(args[1]);
      if (isNaN(userId)) {
        await ctx.reply('Usage: /guest add <user_id> [note]');
        return;
      }
      const note = args.slice(2).join(' ') || undefined;
      addGuest(db, userId, note);
      await ctx.reply(`✅ Guest added: ${userId}${note ? ` (${note})` : ''}`);
      return;
    }

    if (sub === 'remove') {
      const userId = parseInt(args[1]);
      if (isNaN(userId)) {
        await ctx.reply('Usage: /guest remove <user_id>');
        return;
      }
      removeGuest(db, userId);
      await ctx.reply(`✅ Guest removed: ${userId}`);
      return;
    }

    await ctx.reply('Usage:\n/guest add <user_id> [note]\n/guest remove <user_id>\n/guest list');
  });

  bot.command('list', async (ctx: Context) => {
    const projects = projectManager.getAllProjects();
    if (projects.length === 0) {
      await ctx.reply('No active projects. Create one in the "New Projects" topic.');
      return;
    }
    const lines = projects.map(p =>
      `• ${p.name} — ${p.localPath} [${p.status}]`
    ).join('\n');
    // SECURITY: plain text — project name and path are user-supplied
    await ctx.reply(`Projects:\n${lines}`);
  });
}
