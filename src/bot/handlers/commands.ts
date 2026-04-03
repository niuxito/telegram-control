import type { Context } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { addGuest, removeGuest, listGuests, upsertAccessRequest, getAccessRequest, getPendingRequests, resolveAccessRequest } from '../../db/queries/guests.js';
import { config } from '../../config.js';
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
      'Global commands:\n' +
      '/list — list projects\n' +
      '/guest add|remove|list|requests|approve|deny — manage guests\n' +
      '/requestaccess — request read-only access (for guests)\n\n' +

      'New Projects topic:\n' +
      '/new <name> — create project\n' +
      '/import [name] — import existing project\n\n' +

      'Project topic — tasks:\n' +
      '/task <prompt> — run Claude task\n' +
      '/status — project status\n' +
      '/queue — recent tasks\n' +
      '/tasklist [n] — last N tasks with status\n' +
      '/tasklog <id> — full output of a task\n' +
      '/cancel — cancel current task\n' +
      '/test — run npm test\n\n' +

      'Project topic — issues:\n' +
      '/issue <description> — create issue (GitHub or local)\n' +
      '/issue list [open|closed] — list issues\n' +
      '/issue close <id> — close an issue\n\n' +

      'Project topic — git:\n' +
      '/git — recent commits\n' +
      '/files [path] — list files\n' +
      '/github [private|public] — create GitHub repo\n' +
      '/vercel link|deploy|preview|logs|env|domains\n\n' +

      'Project topic — schedule:\n' +
      '/schedule add "<cron>" <prompt> — create schedule\n' +
      '/schedule list — list schedules\n' +
      '/schedule on|off|remove <id>\n\n' +

      'Project topic — config:\n' +
      '/session — session info\n' +
      '/newsession — reset session\n' +
      '/watch on|off — file watching\n' +
      '/gitwatch on|off — git watching\n' +
      '/alias [word] — set wake word\n' +
      '/pause / /unpause — pause project\n' +
      '/archive — archive project\n' +
      '/info — project info'
    );
  });

  // /requestaccess — any user in the supergroup can request guest access
  bot.command('requestaccess', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Owner doesn't need to request access
    if (userId === config.OWNER_USER_ID) {
      await ctx.reply('You are the owner, you already have full access.');
      return;
    }

    const username = ctx.from?.username;
    const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');

    const existing = getAccessRequest(db, userId);
    if (existing?.status === 'approved') {
      await ctx.reply('Your access has already been approved.');
      return;
    }
    if (existing?.status === 'pending') {
      await ctx.reply('Your request is already pending. The admin will review it shortly.');
      return;
    }

    upsertAccessRequest(db, userId, username, fullName || undefined);
    await ctx.reply('✅ Access request sent. You will be notified when the admin reviews it.');

    // Notify the owner
    const display = username ? `@${username} (${userId})` : `${fullName} (${userId})`;
    try {
      await ctx.api.sendMessage(
        config.SUPERGROUP_ID,
        `🔔 Access request from ${display}\n\n/guest approve ${userId}\n/guest deny ${userId}`
      );
    } catch {
      // Non-fatal if notification fails
    }
  });

  // /guest approve|deny|requests|add|remove|list
  bot.command('guest', async (ctx: Context) => {
    const args = ((ctx.match as string) || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    if (sub === 'requests') {
      const pending = getPendingRequests(db);
      if (pending.length === 0) {
        await ctx.reply('No pending access requests.');
        return;
      }
      const lines = pending.map(r => {
        const display = r.username ? `@${r.username}` : r.fullName ?? 'Unknown';
        return `• ${display} (${r.userId}) — /guest approve ${r.userId} | /guest deny ${r.userId}`;
      }).join('\n');
      await ctx.reply(`Pending requests:\n${lines}`);
      return;
    }

    if (sub === 'approve') {
      const userId = parseInt(args[1]);
      if (isNaN(userId)) {
        await ctx.reply('Usage: /guest approve <user_id>');
        return;
      }
      const req = getAccessRequest(db, userId);
      resolveAccessRequest(db, userId, 'approved');
      const note = req?.username ?? req?.fullName ?? undefined;
      addGuest(db, userId, note);
      await ctx.reply(`✅ Access approved for ${userId}.`);
      try {
        await ctx.api.sendMessage(userId, '✅ Your access request has been approved. You can now use the bot.');
      } catch { /* user may not have started the bot in DM */ }
      return;
    }

    if (sub === 'deny') {
      const userId = parseInt(args[1]);
      if (isNaN(userId)) {
        await ctx.reply('Usage: /guest deny <user_id>');
        return;
      }
      resolveAccessRequest(db, userId, 'denied');
      await ctx.reply(`❌ Access denied for ${userId}.`);
      try {
        await ctx.api.sendMessage(userId, '❌ Your access request has been denied.');
      } catch { /* user may not have started the bot in DM */ }
      return;
    }

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

    await ctx.reply(
      'Guest commands:\n' +
      '/guest requests — list pending access requests\n' +
      '/guest approve <user_id> — approve a request\n' +
      '/guest deny <user_id> — deny a request\n' +
      '/guest list — list current guests\n' +
      '/guest add <user_id> [note] — add guest manually\n' +
      '/guest remove <user_id> — revoke access'
    );
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
