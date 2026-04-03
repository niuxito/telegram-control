import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { extractTask, DEFAULT_WAKE_WORD } from './voice.js';
import { resolveAgentPrompt, buildPlanningIssuePrompt } from './agentIntent.js';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { getLatestSession } from '../../db/queries/sessions.js';
import { getRecentTasks, getPendingTasks, cancelPendingTasks, getTaskById } from '../../db/queries/taskQueue.js';
import { updateProject } from '../../db/queries/projects.js';
import { insertSchedule, getSchedulesByProject, deleteSchedule, setScheduleEnabled } from '../../db/queries/schedules.js';
import { insertLocalIssue, listLocalIssues, closeLocalIssue } from '../../db/queries/localIssues.js';
import type { ScheduleManager } from '../../projects/ScheduleManager.js';
import cron from 'node-cron';
import simpleGit from 'simple-git';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Db } from '../../db/client.js';

// Pending issue-without-github confirmations keyed by userId
const pendingIssueRequest = new Map<number, { projectId: number; description: string }>();

export function getPendingIssueRequest(userId: number) {
  return pendingIssueRequest.get(userId);
}
export function clearPendingIssueRequest(userId: number) {
  pendingIssueRequest.delete(userId);
}

/** Returns the GitHub remote URL if found, otherwise null. */
async function getGithubRemote(projectPath: string): Promise<string | null> {
  try {
    const git = simpleGit(projectPath);
    const remotes = await git.getRemotes(true);
    const gh = remotes.find(r =>
      r.refs.fetch?.includes('github.com') || r.refs.push?.includes('github.com')
    );
    return gh?.refs.fetch ?? null;
  } catch {
    return null;
  }
}

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

const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 3800;

function runProjectTests(cwd: string, _script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['test', '--', '--reporter=verbose'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });

    let output = '';
    const append = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      child.kill();
      resolve(formatTestOutput(output, null, true));
    }, TEST_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(formatTestOutput(output, code, false));
    });
  });
}

function formatTestOutput(raw: string, code: number | null, timedOut: boolean): string {
  const header = timedOut
    ? '⏱ Tests timed out after 120s\n\n'
    : code === 0
      ? '✅ Tests passed\n\n'
      : `❌ Tests failed (exit ${code})\n\n`;

  // Keep last MAX_OUTPUT_CHARS chars to capture failures (usually at the end)
  const trimmed = raw.length > MAX_OUTPUT_CHARS
    ? `...(truncated)\n${raw.slice(-MAX_OUTPUT_CHARS)}`
    : raw;

  return header + trimmed;
}

export function setupProjectTopicHandlers(bot: any, projectManager: ProjectManager, db: Db, scheduleManager?: ScheduleManager): void {

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

  // /issue [create <desc> | list [open|closed] | close <id>]
  bot.command('issue', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }

    const raw = (ctx.match as string).trim();
    const args = raw.split(/\s+/);
    const sub = args[0]?.toLowerCase();

    // /issue list [open|closed]
    if (sub === 'list') {
      const filter = (args[1] === 'closed' ? 'closed' : 'open') as 'open' | 'closed';
      const githubRemote = await getGithubRemote(project.localPath);
      const session = projectManager.getSession(project.id);
      if (githubRemote && session) {
        await session.queueTask(
          `List the ${filter} GitHub issues for this project.\n` +
          `Run: gh issue list --state ${filter} --limit 20\n` +
          `Format the output as a numbered list with title and issue number.`
        );
      } else {
        const issues = listLocalIssues(db, project.id, filter);
        if (issues.length === 0) {
          await ctx.reply(`No ${filter} issues found.`);
          return;
        }
        const lines = issues.map(i =>
          `#${i.id} ${i.title}\n   ${i.body.slice(0, 80)}${i.body.length > 80 ? '…' : ''}`
        ).join('\n\n');
        await ctx.reply(`Local issues (${filter}):\n\n${lines}`);
      }
      return;
    }

    // /issue close <id>
    if (sub === 'close') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await ctx.reply('Usage: /issue close <id>');
        return;
      }
      const githubRemote = await getGithubRemote(project.localPath);
      const session = projectManager.getSession(project.id);
      if (githubRemote && session) {
        await session.queueTask(`Close GitHub issue #${id}: run gh issue close ${id} and confirm.`);
      } else {
        closeLocalIssue(db, id, project.id);
        await ctx.reply(`✅ Issue #${id} closed.`);
      }
      return;
    }

    // /issue <description>  or  /issue create <description>
    const description = sub === 'create' ? args.slice(1).join(' ').trim() : raw;
    if (!description) {
      await ctx.reply(
        'Usage:\n' +
        '/issue <description> — create issue\n' +
        '/issue list [open|closed] — list issues\n' +
        '/issue close <id> — close an issue'
      );
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    const githubRemote = await getGithubRemote(project.localPath);

    if (githubRemote) {
      // GitHub configured — queue planning agent task
      await session.queueTask(buildPlanningIssuePrompt(description, true));
      const pending = getPendingTasks(db, project.id);
      if (pending.length > 1) {
        await ctx.reply(`✅ Issue task queued (position ${pending.length}).`);
      } else {
        await ctx.reply('✅ Planning agent started — analysing codebase and creating issue...');
      }
    } else {
      // No GitHub remote — ask user what to do
      const userId = ctx.from?.id;
      if (!userId) return;
      pendingIssueRequest.set(userId, { projectId: project.id, description });
      const keyboard = new InlineKeyboard()
        .text('Create GitHub repo first', `setup_github_for_issue:${userId}`)
        .row()
        .text('Store locally', `local_issue:${userId}`);
      await ctx.reply(
        'No GitHub remote found for this project. What would you like to do?',
        { reply_markup: keyboard }
      );
    }
  });

  // /tasklist [n] — show last N tasks (default 10)
  bot.command('tasklist', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const n = Math.min(parseInt((ctx.match as string) || '10') || 10, 50);
    const tasks = getRecentTasks(db, project.id, n);
    if (tasks.length === 0) {
      await ctx.reply('No tasks found.');
      return;
    }

    const statusIcon: Record<string, string> = {
      completed: '✅', failed: '❌', cancelled: '🚫', running: '⏳', pending: '🕐',
    };
    const lines = tasks.map(t => {
      const icon = statusIcon[t.status] ?? '•';
      const date = t.createdAt ? new Date(t.createdAt).toISOString().slice(11, 16) : '';
      const prompt = t.prompt.slice(0, 60) + (t.prompt.length > 60 ? '…' : '');
      const cost = t.costUsd ? ` $${t.costUsd.toFixed(4)}` : '';
      return `${icon} [${t.id}] ${date} ${prompt}${cost}`;
    }).join('\n');
    await ctx.reply(`Tasks (last ${tasks.length}):\n${lines}`);
  });

  // /tasklog <id> — full output of a specific task
  bot.command('tasklog', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const id = parseInt((ctx.match as string) || '');
    if (isNaN(id)) {
      await ctx.reply('Usage: /tasklog <id>');
      return;
    }

    const task = getTaskById(db, id);
    if (!task || task.projectId !== project.id) {
      await ctx.reply(`Task ${id} not found.`);
      return;
    }

    const statusIcon: Record<string, string> = {
      completed: '✅', failed: '❌', cancelled: '🚫', running: '⏳', pending: '🕐',
    };
    const icon = statusIcon[task.status] ?? '•';
    const date = task.createdAt ? new Date(task.createdAt).toLocaleString() : '';
    const cost = task.costUsd ? `$${task.costUsd.toFixed(4)}` : 'n/a';
    const header = `${icon} Task ${task.id} — ${task.status}\n${date} | cost: ${cost}\n\nPrompt: ${task.prompt}\n\n`;

    const output = task.result ?? '(no output)';
    const full = header + output;

    if (full.length > 4096) {
      await ctx.reply(header + output.slice(0, 4096 - header.length - 3) + '…');
    } else {
      await ctx.reply(full);
    }
  });

  // /schedule add <cron> <prompt> | /schedule list | /schedule remove <id> | /schedule on|off <id>
  bot.command('schedule', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const args = ((ctx.match as string) || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    if (sub === 'list') {
      const all = getSchedulesByProject(db, project.id);
      if (all.length === 0) {
        await ctx.reply('No schedules configured. Use /schedule add <cron> <prompt>');
        return;
      }
      const lines = all.map(s => {
        const status = s.enabled ? '✅' : '⏸';
        const last = s.lastRunAt ? new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'never';
        return `${status} [${s.id}] ${s.cronExpr}\n   ${s.prompt.slice(0, 60)}${s.prompt.length > 60 ? '…' : ''}\n   Last run: ${last}`;
      }).join('\n\n');
      await ctx.reply(`Schedules:\n\n${lines}`);
      return;
    }

    if (sub === 'add') {
      // Format: /schedule add <cron 5 fields> <prompt...>
      // e.g. /schedule add 0 9 * * 1 Run weekly report
      if (args.length < 7) {
        await ctx.reply('Usage: /schedule add <cron> <prompt>\nExample: /schedule add "0 9 * * 1" Run weekly lint');
        return;
      }
      // Support quoted cron or 5 separate fields
      let cronExpr: string;
      let promptStart: number;
      const joined = args.slice(1).join(' ');
      const quoted = joined.match(/^"([^"]+)"\s+([\s\S]+)$/);
      if (quoted) {
        cronExpr = quoted[1];
        promptStart = -1; // handled via quoted
      } else {
        cronExpr = args.slice(1, 6).join(' ');
        promptStart = 6;
      }
      const prompt = quoted ? quoted[2] : args.slice(promptStart).join(' ');

      if (!cron.validate(cronExpr)) {
        await ctx.reply(`Invalid cron expression: "${cronExpr}"\nFormat: minute hour day month weekday\nExample: "0 9 * * 1" = every Monday at 9:00`);
        return;
      }
      if (!prompt.trim()) {
        await ctx.reply('Prompt cannot be empty.');
        return;
      }

      const schedule = insertSchedule(db, { projectId: project.id, cronExpr, prompt: prompt.trim() });
      scheduleManager?.register(schedule!.id, project.id, cronExpr, prompt.trim());
      await ctx.reply(`✅ Schedule [${schedule!.id}] created\nCron: ${cronExpr}\nPrompt: ${prompt.trim()}`);
      return;
    }

    if (sub === 'remove') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await ctx.reply('Usage: /schedule remove <id>');
        return;
      }
      deleteSchedule(db, id, project.id);
      scheduleManager?.unregister(id);
      await ctx.reply(`✅ Schedule [${id}] removed.`);
      return;
    }

    if (sub === 'on' || sub === 'off') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await ctx.reply(`Usage: /schedule ${sub} <id>`);
        return;
      }
      const enabled = sub === 'on';
      setScheduleEnabled(db, id, project.id, enabled);
      if (enabled) {
        const all = getSchedulesByProject(db, project.id);
        const s = all.find(x => x.id === id);
        if (s) scheduleManager?.register(s.id, project.id, s.cronExpr, s.prompt);
      } else {
        scheduleManager?.unregister(id);
      }
      await ctx.reply(`✅ Schedule [${id}] ${enabled ? 'enabled ✅' : 'paused ⏸'}`);
      return;
    }

    await ctx.reply(
      'Schedule commands:\n' +
      '/schedule list — list all schedules\n' +
      '/schedule add <cron> <prompt> — create schedule\n' +
      '  Example: /schedule add "0 9 * * 1" Run weekly lint\n' +
      '  Cron format: minute hour day month weekday\n' +
      '/schedule remove <id> — delete schedule\n' +
      '/schedule on <id> — enable schedule\n' +
      '/schedule off <id> — pause schedule'
    );
  });

  // /test — run project tests and report result
  bot.command('test', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    // Detect test script from package.json
    let testScript = 'npm test';
    try {
      const pkg = JSON.parse(readFileSync(path.join(project.localPath, 'package.json'), 'utf-8'));
      if (!pkg.scripts?.test) {
        await ctx.reply('No test script found in package.json.');
        return;
      }
    } catch {
      // No package.json — try running npm test anyway, error will surface
    }

    const msg = await ctx.reply('🧪 Running tests...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    const output = await runProjectTests(project.localPath, testScript);
    await ctx.api.editMessageText(chatId, msgId, output);
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
