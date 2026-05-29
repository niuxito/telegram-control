import type { Context } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { addGuest, removeGuest, listGuests, upsertAccessRequest, getAccessRequest, getPendingRequests, resolveAccessRequest } from '../../db/queries/guests.js';
import { getTasksSince } from '../../db/queries/taskQueue.js';
import { config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { setupCodexLoginHandler } from './topic/codexLogin.js';

export function setupGlobalCommands(bot: any, projectManager: ProjectManager, db: Db): void {
  // Codex device-auth flow — works from any chat (DM or topic) since it's a
  // global concern (Codex login is per-host, not per-project).
  setupCodexLoginHandler(bot);
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
      '📋 Global commands:\n' +
      '/list — list all projects\n' +
      '/broadcast <prompt> — run a task in all active projects\n' +
      '/summary [hours] — activity summary (default: last 24h)\n' +
      '/uptime — server CPU, RAM, disk and bot uptime\n' +
      '/help — show this message\n' +
      '/guest add|remove|list — manage guest users\n' +
      '/guest requests — pending access requests\n' +
      '/guest approve|deny <id> — approve/deny access request\n' +
      '/requestaccess — request read-only guest access\n\n' +

      '🆕 New Projects topic:\n' +
      '/new <name> — create a new project\n' +
      '/import [name] — import existing local project\n' +
      '/clone [url] — clone GitHub repo (no url = pick from list)\n\n' +

      '🤖 Project topic — tasks:\n' +
      '/task <prompt> — run a Claude task\n' +
      '/codex <prompt> — run a task with Codex (ChatGPT subscription)\n' +
      '/codex-login — re-authenticate Codex via OAuth device flow\n' +
      '/opencode <prompt> — run a task with OpenCode (third AI agent)\n' +
      '/plan <prompt> — one-shot planning with Claude Opus 4.7 (deeper reasoning)\n' +
      '/status — current task status\n' +
      '/queue — show task queue\n' +
      '/tasklist [n] — last N tasks with status and cost\n' +
      '/tasklog <id> — full output of a specific task\n' +
      '/cancel — cancel the running task\n' +
      '/test — run npm test\n' +
      '/review — review current git diff\n' +
      '/review <pr> — review a PR by number or URL\n\n' +

      '🐛 Project topic — issues:\n' +
      '/issue <description> — create issue via planning agent\n' +
      '/issue list [open|closed] — list GitHub or local issues\n' +
      '/issue close <id> — close an issue\n\n' +

      '📁 Project topic — files:\n' +
      '/files [path] — list files in project directory\n' +
      '/file <path> — send a file as Telegram attachment\n' +
      'Send any file/photo — saves it to the project directory\n' +
      'Send file + caption — saves and queues caption as task\n\n' +

      '🔀 Project topic — git:\n' +
      '/git — show recent commits\n' +
      '/github [private|public] — create GitHub repo\n' +
      '/vercel link — link to Vercel project\n' +
      '/vercel deploy — deploy to production\n' +
      '/vercel preview — deploy preview\n' +
      '/vercel logs — show deployment logs\n' +
      '/vercel env — show environment variables\n' +
      '/vercel domains — show domains\n\n' +

      '🕐 Project topic — schedule:\n' +
      '/schedule add "<cron>" <prompt> — create scheduled task\n' +
      '/schedule list — list schedules\n' +
      '/schedule on <id> — enable schedule\n' +
      '/schedule off <id> — disable schedule\n' +
      '/schedule remove <id> — delete schedule\n\n' +

      '⚙️ Project topic — config:\n' +
      '/budget — show spend and limit\n' +
      '/budget <amount> — set budget limit in USD\n' +
      '/budget off — remove limit\n' +
      '/note <text> — save a note for this project\n' +
      '/note list — list recent notes\n' +
      '/note delete <id> — delete a note\n' +
      '/note clear — clear all notes\n' +
      '/secret — send sensitive data privately via DM\n' +
      '/context — show CLAUDE.md\n' +
      '/context <text> — replace CLAUDE.md\n' +
      '/context append <text> — append to CLAUDE.md\n' +
      '/model — show/set Claude model for this project\n' +
      '/session — session info and cost\n' +
      '/newsession — start a fresh session\n' +
      '/checkpoint — summarize session into CLAUDE.md and reset\n' +
      '/watch on|off — toggle file change notifications\n' +
      '/gitwatch on|off — toggle git commit notifications\n' +
      '/alias [word] — set wake word for voice messages\n' +
      '/pause — pause the project\n' +
      '/unpause — resume a paused project\n' +
      '/archive — archive the project\n' +
      '/info — project details'
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

  // /uptime — server CPU, RAM, disk and process uptime
  bot.command('uptime', async (ctx: Context) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { freemem, totalmem, loadavg, uptime: osUptime } = await import('node:os');
    const exec = promisify(execFile);

    // Disk usage
    let diskLine = 'N/A';
    try {
      const { stdout } = await exec('df', ['-h', '--output=size,used,avail,pcent', '/']);
      const lines = stdout.trim().split('\n');
      if (lines[1]) diskLine = lines[1].trim().replace(/\s+/g, '  ');
    } catch { /* non-linux fallback */ }

    const totalMB  = totalmem() / 1024 / 1024;
    const freeMB   = freemem()  / 1024 / 1024;
    const usedMB   = totalMB - freeMB;
    const ramPct   = ((usedMB / totalMB) * 100).toFixed(1);
    const [l1, l5, l15] = loadavg().map(n => n.toFixed(2));

    const osSec    = Math.floor(osUptime());
    const procSec  = Math.floor(process.uptime());
    const fmt = (s: number) => {
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    await ctx.reply(
      `🖥 Server status\n\n` +
      `CPU load:  ${l1} / ${l5} / ${l15} (1m / 5m / 15m)\n` +
      `RAM:       ${usedMB.toFixed(0)} / ${totalMB.toFixed(0)} MB (${ramPct}%)\n` +
      `Disk (/):  ${diskLine}\n\n` +
      `OS uptime:  ${fmt(osSec)}\n` +
      `Bot uptime: ${fmt(procSec)}`
    );
  });

  // /summary [hours] — activity summary across all projects (default: last 24h)
  bot.command('summary', async (ctx: Context) => {
    const arg = (ctx.match as string).trim();
    const hours = parseInt(arg) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const allProjects = projectManager.getAllProjects();
    const tasks = getTasksSince(db, since);

    if (tasks.length === 0) {
      await ctx.reply(`No activity in the last ${hours}h.`);
      return;
    }

    // Group tasks by projectId
    const byProject = new Map<number, typeof tasks>();
    for (const task of tasks) {
      if (!byProject.has(task.projectId)) byProject.set(task.projectId, []);
      byProject.get(task.projectId)!.push(task);
    }

    const statusIcon = (s: string) =>
      s === 'completed' ? '✅' : s === 'failed' ? '❌' : s === 'cancelled' ? '🚫' : '⏳';

    const lines: string[] = [`📊 Activity summary — last ${hours}h\n`];
    let totalCompleted = 0, totalFailed = 0, totalCost = 0;

    for (const [projectId, ptasks] of byProject) {
      const project = allProjects.find(p => p.id === projectId);
      const name = project?.name ?? `project#${projectId}`;
      const completed = ptasks.filter(t => t.status === 'completed').length;
      const failed    = ptasks.filter(t => t.status === 'failed').length;
      const cost      = ptasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);

      totalCompleted += completed;
      totalFailed    += failed;
      totalCost      += cost;

      lines.push(`*${name}* — ${ptasks.length} task(s)`);
      for (const t of ptasks.slice(-5)) {
        const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '…' : t.prompt;
        lines.push(`  ${statusIcon(t.status)} ${prompt}`);
      }
      if (ptasks.length > 5) lines.push(`  … and ${ptasks.length - 5} more`);
      if (cost > 0) lines.push(`  💰 $${cost.toFixed(4)}`);
      lines.push('');
    }

    lines.push(`Totals: ✅ ${totalCompleted}  ❌ ${totalFailed}  💰 $${totalCost.toFixed(4)}`);

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /broadcast <prompt> — queue the same task in all active projects
  bot.command('broadcast', async (ctx: Context) => {
    const prompt = (ctx.match as string).trim();
    if (!prompt) {
      await ctx.reply('Usage: /broadcast <prompt>\n\nQueues the same task in all active projects.');
      return;
    }

    const projects = projectManager.getAllProjects().filter(p => p.status === 'active');
    if (projects.length === 0) {
      await ctx.reply('No active projects to broadcast to.');
      return;
    }

    const results: string[] = [];
    for (const project of projects) {
      const session = projectManager.getSession(project.id);
      if (!session) {
        results.push(`⚠️ ${project.name} — no session`);
        continue;
      }
      await session.queueTask(prompt);
      results.push(`✅ ${project.name}`);
    }

    await ctx.reply(`📡 Broadcast sent to ${projects.length} project(s):\n${results.join('\n')}`);
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

// Registers every command with Telegram so they appear in the "/" menu.
// Keep this list in sync with /help in setupGlobalCommands.
export async function registerBotCommands(bot: any): Promise<void> {
  const commands = [
    // Global
    { command: 'list',          description: 'List all projects' },
    { command: 'broadcast',     description: 'Run a task in all active projects' },
    { command: 'summary',       description: 'Activity summary (default last 24h)' },
    { command: 'uptime',        description: 'Server CPU, RAM, disk and bot uptime' },
    { command: 'help',          description: 'Show command help' },
    { command: 'guest',         description: 'Manage guests: add|remove|list|requests|approve|deny' },
    { command: 'requestaccess', description: 'Request read-only guest access' },

    // New Projects topic
    { command: 'new',    description: 'Create a new project' },
    { command: 'import', description: 'Import existing local project' },
    { command: 'clone',  description: 'Clone a GitHub repo (no url = pick from list)' },

    // Project topic — tasks
    { command: 'task',     description: 'Run a Claude task' },
    { command: 'codex',    description: 'Run a task with Codex (ChatGPT subscription)' },
    { command: 'codex-login', description: 'Re-authenticate Codex via OAuth device flow' },
    { command: 'opencode', description: 'Run a task with OpenCode (third AI agent)' },
    { command: 'plan',     description: 'Plan with Claude Opus 4.7 (one-shot, deeper reasoning)' },
    { command: 'status',   description: 'Current task status' },
    { command: 'queue',    description: 'Show recent task queue' },
    { command: 'tasklist', description: 'Last N tasks with status and cost' },
    { command: 'tasklog',  description: 'Full output of a specific task' },
    { command: 'cancel',   description: 'Cancel running and pending tasks' },
    { command: 'test',     description: 'Run npm test' },
    { command: 'review',   description: 'Review current diff or a PR by number/url' },

    // Project topic — issues
    { command: 'issue', description: 'Create or manage issues (list|close)' },

    // Project topic — files
    { command: 'files', description: 'List files in project directory' },
    { command: 'file',  description: 'Send a file as Telegram attachment' },

    // Project topic — git
    { command: 'git',    description: 'Show recent commits' },
    { command: 'github', description: 'Create GitHub repo (private|public)' },
    { command: 'vercel', description: 'Vercel: link|deploy|preview|logs|env|domains' },

    // Project topic — schedule
    { command: 'schedule', description: 'Schedules: add|list|on|off|remove' },

    // Project topic — config
    { command: 'budget',     description: 'Show or set budget limit in USD' },
    { command: 'note',       description: 'Project notes: add|list|delete|clear' },
    { command: 'secret',     description: 'Send sensitive data privately via DM' },
    { command: 'context',    description: 'Show, replace, or append CLAUDE.md' },
    { command: 'model',      description: 'Show or set Claude model for this project' },
    { command: 'session',    description: 'Session info and cost' },
    { command: 'newsession', description: 'Start a fresh session' },
    { command: 'checkpoint', description: 'Summarize session into CLAUDE.md and reset' },
    { command: 'watch',      description: 'Toggle file change notifications (on|off)' },
    { command: 'gitwatch',   description: 'Toggle git commit notifications (on|off)' },
    { command: 'alias',      description: 'Set wake word for voice messages' },
    { command: 'pause',      description: 'Pause the project' },
    { command: 'unpause',    description: 'Resume a paused project' },
    { command: 'archive',    description: 'Archive the project' },
    { command: 'info',       description: 'Project details' },
  ];

  await bot.api.setMyCommands(commands);
}
