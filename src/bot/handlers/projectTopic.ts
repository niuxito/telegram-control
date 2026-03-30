import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { extractTask, DEFAULT_WAKE_WORD } from './voice.js';
import { resolveAgentPrompt, buildIssueTaskPrompt } from './agentIntent.js';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { getLatestSession } from '../../db/queries/sessions.js';
import { getRecentTasks, getPendingTasks, cancelPendingTasks } from '../../db/queries/taskQueue.js';
import { updateProject } from '../../db/queries/projects.js';
import simpleGit from 'simple-git';
import { readdirSync } from 'fs';
import path from 'path';
import type { Db } from '../../db/client.js';

// Pending public-repo confirmations keyed by userId
const pendingGithubPublic = new Map<number, { projectId: number; projectName: string }>();

// Pending Vercel production deploy confirmations keyed by userId
const pendingVercelDeploy = new Map<number, { projectId: number; chatId: number; topicId: number }>();

export function getPendingVercelDeploy(userId: number) {
  return pendingVercelDeploy.get(userId);
}

export function clearPendingVercelDeploy(userId: number): void {
  pendingVercelDeploy.delete(userId);
}

export function getPendingGithubPublic(userId: number) {
  return pendingGithubPublic.get(userId);
}

export function clearPendingGithubPublic(userId: number): void {
  pendingGithubPublic.delete(userId);
}

export function buildVercelPrompt(projectName: string, subcommand: string): string {
  switch (subcommand) {
    case 'link':
      return (
        `Link this project to Vercel:\n` +
        `- Run: vercel link --yes\n` +
        `- If already linked, show the current project URL instead (check .vercel/project.json)\n` +
        `- Report the Vercel project name and dashboard URL when done.`
      );
    case 'deploy':
      return (
        `Before deploying to Vercel production, perform security checks:\n\n` +
        `1. **Check .gitignore**: Verify it covers .env, .env.*, *.key, *.pem, node_modules/, .vercel/\n` +
        `2. **Scan for secrets**: grep -rn --include="*.ts" --include="*.js" --include="*.json" -E "(API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)\\s*=\\s*['\"][^'\"]{8,}" . | grep -v node_modules | grep -v ".env.example"\n` +
        `3. **If secrets found**: Report and STOP. Do not deploy.\n` +
        `4. **If checks pass**: Run: vercel --prod\n` +
        `   Report the production URL when done.`
      );
    case 'preview':
      return (
        `Deploy this project to a Vercel preview URL:\n` +
        `- Run: vercel\n` +
        `- Report the preview URL when done.`
      );
    case 'logs':
      return (
        `Show recent Vercel deployment logs for this project:\n` +
        `- Run: vercel logs --limit 50\n` +
        `- Format the output clearly.`
      );
    case 'env':
      return (
        `List Vercel environment variables for this project:\n` +
        `- Run: vercel env ls\n` +
        `- Show the list clearly (names only, not values).`
      );
    case 'domains':
      return (
        `List domains configured for this Vercel project:\n` +
        `- Run: vercel domains ls\n` +
        `- Show the list clearly.`
      );
    default:
      return `Run: vercel ${subcommand}`;
  }
}

export function buildGithubPrompt(name: string, visibility: 'private' | 'public'): string {
  return (
    `Before creating a GitHub repository, perform security checks on this project:\n\n` +
    `1. **Check .gitignore**: Verify it exists and covers common sensitive files (.env, .env.*, *.key, *.pem, *.p12, *.pfx, id_rsa, id_ed25519, node_modules/, .DS_Store, secrets.*, credentials.*). Add any missing entries.\n\n` +
    `2. **Scan for secrets**: Search the codebase for hardcoded secrets. Look for patterns like:\n` +
    `   - Variables named *API_KEY*, *SECRET*, *PASSWORD*, *TOKEN*, *PRIVATE_KEY* assigned to string literals (not env var reads)\n` +
    `   - Common patterns: \`sk-\`, \`ghp_\`, \`xox\`, \`AKIA\` (AWS keys)\n` +
    `   - Any .env files that should NOT be committed\n` +
    `   Run: grep -rn --include="*.ts" --include="*.js" --include="*.json" --include="*.env" -E "(API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)\\s*=\\s*['\"][^'\"]{8,}" . | grep -v node_modules | grep -v ".env.example"\n\n` +
    `3. **If secrets found**: Report exactly which files and lines contain the issues. DO NOT create the repository. Ask the user to fix them first.\n\n` +
    `4. **If security checks pass**: Create the GitHub repository:\n` +
    `   - Repository name: ${name}\n` +
    `   - Visibility: ${visibility}\n` +
    `   - Add it as remote origin and push the current branch with --set-upstream\n` +
    `   - Use: gh repo create ${name} --${visibility} --source=. --remote=origin --push\n` +
    `   - If a remote already exists, show the current remote URL instead.\n\n` +
    `Report the results of each step clearly.`
  );
}

export function setupProjectTopicHandlers(bot: any, projectManager: ProjectManager, db: Db): void {

  // /task <prompt>
  bot.command('task', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }

    const prompt = ctx.match as string;
    if (!prompt) {
      await ctx.reply('Usage: /task <prompt>');
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    await session.queueTask(prompt);
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ Task queued (position ${pending.length}). Current task will finish first.`);
    }
  });

  // /status
  bot.command('status', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const session = projectManager.getSession(project.id);
    if (!session) {
      // SECURITY: plain text — project.name is user-supplied
      await ctx.reply(`📊 ${project.name}\nStatus: ${project.status}\nNo active session.`);
      return;
    }

    const status = await session.getStatus();
    // SECURITY: plain text — project.name is user-supplied
    await ctx.reply(
      `📊 ${project.name}\n` +
      `Status: ${project.status}\n` +
      `Running task: ${status.running ? '✅ Yes' : '❌ No'}\n` +
      `Pending tasks: ${status.pendingCount}\n` +
      `Session ID: ${status.session?.claudeSessionId?.slice(0, 8) ?? 'none'}...\n` +
      `Total cost: $${status.session?.totalCostUsd?.toFixed(4) ?? '0.0000'}\n` +
      `File watch: ${project.watchFiles ? '✅' : '❌'}\n` +
      `Git watch: ${project.watchGit ? '✅' : '❌'}`
    );
  });

  // /queue
  bot.command('queue', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const tasks = getRecentTasks(db, project.id, 10);
    if (tasks.length === 0) {
      await ctx.reply('No tasks in history.');
      return;
    }

    const lines = tasks.map(t =>
      `• [${t.status}] ${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? '...' : ''}`
    ).join('\n');
    // SECURITY: plain text — task prompts are user-supplied
    await ctx.reply(`Recent Tasks:\n${lines}`);
  });

  // /cancel
  bot.command('cancel', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    cancelPendingTasks(db, project.id);
    const session = projectManager.getSession(project.id);
    session?.cancelCurrent();
    await ctx.reply('✅ Cancelled pending tasks.');
  });

  // /session
  bot.command('session', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const session = getLatestSession(db, project.id);
    if (!session) {
      await ctx.reply('No session found. Start one with /task.');
      return;
    }
    // SECURITY: plain text — session IDs and timestamps contain no Markdown but keeping consistent
    await ctx.reply(
      `🔗 Session Info\n` +
      `ID: ${session.claudeSessionId ?? 'none'}\n` +
      `Messages: ${session.messageCount}\n` +
      `Total cost: $${session.totalCostUsd.toFixed(4)}\n` +
      `Last used: ${session.lastUsedAt}`
    );
  });

  // /git
  bot.command('git', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    try {
      const git = simpleGit(project.localPath);
      const log = await git.log({ maxCount: 10 });
      if (log.all.length === 0) {
        await ctx.reply('No commits yet.');
        return;
      }
      // SECURITY: send as plain text to avoid Markdown injection from commit messages/author names
      const lines = log.all.map(c =>
        `${c.hash.slice(0, 7)} ${c.message} (${c.author_name})`
      ).join('\n');
      await ctx.reply(`Recent Commits:\n${lines}`);
    } catch {
      await ctx.reply('Not a git repository or git error.');
    }
  });

  // /files [path]
  bot.command('files', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const subPath = (ctx.match as string) || '';
    const resolvedBase = path.resolve(project.localPath);
    const targetPath = path.resolve(resolvedBase, subPath);

    // SECURITY: prevent path traversal outside the project directory
    if (!targetPath.startsWith(resolvedBase + path.sep) && targetPath !== resolvedBase) {
      await ctx.reply('Invalid path: cannot navigate outside the project directory.');
      return;
    }

    try {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      const lines = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, 50)
        .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
        .join('\n');
      const displayPath = subPath || '/';
      await ctx.reply(`Files in ${displayPath}:\n${lines || 'Empty directory'}`);
    } catch {
      await ctx.reply('Cannot read directory.');
    }
  });

  // /watch on|off
  bot.command('watch', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /watch on|off');
      return;
    }

    projectManager.setWatchFiles(project.id, arg === 'on');
    await ctx.reply(`File watching ${arg === 'on' ? 'enabled ✅' : 'disabled ❌'}`);
  });

  // /gitwatch on|off
  bot.command('gitwatch', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /gitwatch on|off');
      return;
    }

    projectManager.setWatchGit(project.id, arg === 'on');
    await ctx.reply(`Git watching ${arg === 'on' ? 'enabled ✅' : 'disabled ❌'}`);
  });

  // /pause
  bot.command('pause', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await projectManager.pauseProject(project.id);
    await ctx.reply('⏸ Project paused. Use /unpause to resume.');
  });

  // /unpause
  bot.command('unpause', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await projectManager.unpauseProject(project.id);
    await ctx.reply('▶️ Project resumed.');
  });

  // /archive
  bot.command('archive', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await projectManager.archiveProject(project.id);
    await ctx.reply('🗄 Project archived.');
  });

  // /info
  bot.command('info', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    // SECURITY: plain text — project.name and project.localPath are user-supplied
    await ctx.reply(
      `ℹ️ ${project.name}\n` +
      `Path: ${project.localPath}\n` +
      `Status: ${project.status}\n` +
      `Topic ID: ${project.topicId}\n` +
      `Created: ${project.createdAt}\n` +
      `File watch: ${project.watchFiles ? '✅' : '❌'}\n` +
      `Git watch: ${project.watchGit ? '✅' : '❌'}`
    );
  });

  // /github [private|public]  — private by default; public requires inline confirmation
  bot.command('github', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }

    const arg = ((ctx.match as string) || '').trim().toLowerCase();
    if (arg !== '' && arg !== 'private' && arg !== 'public') {
      await ctx.reply('Usage: /github [private|public]');
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    // Public requires explicit confirmation via inline keyboard
    if (arg === 'public') {
      const userId = ctx.from?.id;
      if (!userId) return;
      pendingGithubPublic.set(userId, { projectId: project.id, projectName: project.name });
      const keyboard = new InlineKeyboard()
        .text('Confirm Public', `confirm_github_public:${userId}`)
        .text('Cancel', `cancel_github_public:${userId}`);
      await ctx.reply(
        `⚠️ This will be a PUBLIC repository. Are you sure?`,
        { reply_markup: keyboard }
      );
      return;
    }

    // Default: private — queue immediately
    const prompt = buildGithubPrompt(project.name, 'private');
    await session.queueTask(prompt);
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ GitHub repo task queued (position ${pending.length}). Current task will finish first.`);
    } else {
      await ctx.reply(`✅ GitHub repo task queued (private).`);
    }
  });

  // /vercel [link|deploy|preview|logs|env|domains]
  bot.command('vercel', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }

    const arg = ((ctx.match as string) || '').trim().toLowerCase();

    if (!arg) {
      await ctx.reply(
        'Vercel commands:\n' +
        '/vercel link — link repo to Vercel project\n' +
        '/vercel deploy — deploy to production (requires confirmation)\n' +
        '/vercel preview — deploy to preview URL\n' +
        '/vercel logs — view recent logs\n' +
        '/vercel env — list environment variables\n' +
        '/vercel domains — list domains'
      );
      return;
    }

    const validSubcommands = ['link', 'deploy', 'preview', 'logs', 'env', 'domains'];
    if (!validSubcommands.includes(arg)) {
      await ctx.reply('Usage: /vercel [link|deploy|preview|logs|env|domains]');
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    // Production deploy requires inline keyboard confirmation
    if (arg === 'deploy') {
      const userId = ctx.from?.id;
      if (!userId) return;
      pendingVercelDeploy.set(userId, {
        projectId: project.id,
        chatId: ctx.message?.chat.id ?? -1,
        topicId: ctx.message?.message_thread_id ?? -1,
      });
      const keyboard = new InlineKeyboard()
        .text('Deploy to Production', `confirm_vercel_deploy:${userId}`)
        .text('Cancel', `cancel_vercel_deploy:${userId}`);
      await ctx.reply(
        `🚀 Deploy ${project.name} to Vercel PRODUCTION?`,
        { reply_markup: keyboard }
      );
      return;
    }

    // All other subcommands — queue immediately
    const prompt = buildVercelPrompt(project.name, arg);
    await session.queueTask(prompt);
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ Vercel ${arg} task queued (position ${pending.length}). Current task will finish first.`);
    } else {
      await ctx.reply(`✅ Vercel ${arg} task queued.`);
    }
  });

  // /newsession
  bot.command('newsession', async (ctx: Context) => {
    await ctx.reply('🔄 New session will start on next /task command.');
  });

  // /alias [word] — set or show the wake word for this project topic
  bot.command('alias', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim().toLowerCase();

    if (!arg) {
      const current = project.wakeWord ?? DEFAULT_WAKE_WORD;
      await ctx.reply(`Current wake word: "${current}"${project.wakeWord ? '' : ' (default)'}`);
      return;
    }

    if (arg.includes(' ') || arg.length > 32) {
      await ctx.reply('Wake word must be a single word (max 32 chars).');
      return;
    }

    updateProject(db, project.id, { wakeWord: arg });
    await ctx.reply(`✅ Wake word set to "${arg}" for this project.`);
  });

  // /issue <description> — create a GitHub issue directly
  bot.command('issue', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }

    const description = (ctx.match as string).trim();
    if (!description) {
      await ctx.reply('Usage: /issue <description>');
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    await session.queueTask(buildIssueTaskPrompt(description));
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ Issue task queued (position ${pending.length}). Current task will finish first.`);
    }
  });

  // Text in a project topic → queue as task if:
  //   a) message is a reply to the bot, OR
  //   b) text starts with the project's wake word (default: "agente")
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return;

    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const isReplyToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
    const wakeWord = project.wakeWord ?? DEFAULT_WAKE_WORD;
    const taskFromWakeWord = extractTask(text, wakeWord);

    const prompt = isReplyToBot ? text : taskFromWakeWord;
    if (!prompt) return;

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    await session.queueTask(resolveAgentPrompt(prompt));
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ Task queued (position ${pending.length}). Current task will finish first.`);
    }
  });
}
