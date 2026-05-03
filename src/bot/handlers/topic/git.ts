import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import { getPendingTasks } from '../../../db/queries/taskQueue.js';
import simpleGit from 'simple-git';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import type { Db } from '../../../db/client.js';

const pendingGithubPublic = new Map<number, { projectId: number; projectName: string }>();
const pendingVercelDeploy = new Map<number, { projectId: number; chatId: number; topicId: number }>();

export function getPendingGithubPublic(userId: number) {
  return pendingGithubPublic.get(userId);
}
export function clearPendingGithubPublic(userId: number): void {
  pendingGithubPublic.delete(userId);
}
export function getPendingVercelDeploy(userId: number) {
  return pendingVercelDeploy.get(userId);
}
export function clearPendingVercelDeploy(userId: number): void {
  pendingVercelDeploy.delete(userId);
}

export async function getGithubRemote(projectPath: string): Promise<string | null> {
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

export function buildVercelPrompt(_projectName: string, subcommand: string): string {
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

export function setupGitHandlers(bot: any, projectManager: ProjectManager, db: Db): void {

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
      const lines = log.all.map(c =>
        `${c.hash.slice(0, 7)} ${c.message} (${c.author_name})`
      ).join('\n');
      await ctx.reply(`Recent Commits:\n${lines}`);
    } catch {
      await ctx.reply('Not a git repository or git error.');
    }
  });

  bot.command('files', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const subPath = (ctx.match as string) || '';
    const resolvedBase = path.resolve(project.localPath);
    const targetPath = path.resolve(resolvedBase, subPath);

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

  bot.command('file', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const relPath = (ctx.match as string).trim();
    if (!relPath) {
      await ctx.reply('Usage: /file <path>\n\nExample: /file src/index.ts');
      return;
    }

    const resolvedBase = path.resolve(project.localPath);
    const targetPath = path.resolve(resolvedBase, relPath);

    if (!targetPath.startsWith(resolvedBase + path.sep)) {
      await ctx.reply('Invalid path: cannot navigate outside the project directory.');
      return;
    }

    try {
      const stat = statSync(targetPath);
      if (stat.isDirectory()) {
        await ctx.reply('That path is a directory. Use /files to list its contents.');
        return;
      }
      if (stat.size > 50 * 1024 * 1024) {
        await ctx.reply('File is too large to send (max 50 MB).');
        return;
      }
    } catch {
      await ctx.reply(`File not found: ${relPath}`);
      return;
    }

    const fileName = path.basename(targetPath);
    await ctx.replyWithDocument(new InputFile(targetPath, fileName));
  });

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

    if (arg === 'public') {
      const userId = ctx.from?.id;
      if (!userId) return;
      pendingGithubPublic.set(userId, { projectId: project.id, projectName: project.name });
      const keyboard = new InlineKeyboard()
        .text('Confirm Public', `confirm_github_public:${userId}`)
        .text('Cancel', `cancel_github_public:${userId}`);
      await ctx.reply(`⚠️ This will be a PUBLIC repository. Are you sure?`, { reply_markup: keyboard });
      return;
    }

    const prompt = buildGithubPrompt(project.name, 'private');
    await session.queueTask(prompt);
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ GitHub repo task queued (position ${pending.length}). Current task will finish first.`);
    } else {
      await ctx.reply(`✅ GitHub repo task queued (private).`);
    }
  });

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
      await ctx.reply(`🚀 Deploy ${project.name} to Vercel PRODUCTION?`, { reply_markup: keyboard });
      return;
    }

    const prompt = buildVercelPrompt(project.name, arg);
    await session.queueTask(prompt);
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ Vercel ${arg} task queued (position ${pending.length}). Current task will finish first.`);
    } else {
      await ctx.reply(`✅ Vercel ${arg} task queued.`);
    }
  });
}
