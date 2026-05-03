import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { confirmCancelKeyboard } from '../keyboards.js';
import { config } from '../../config.js';

const execFileAsync = promisify(execFile);

// Pending new-project confirmations: userId -> { name }
const pendingConfirmations = new Map<number, { name: string }>();
// Pending import confirmations: userId -> { name }
const pendingImports = new Map<number, { name: string }>();
// Pending clone confirmations: userId -> { url }
const pendingClones = new Map<number, { url: string }>();
// Pending repo picker list: userId -> repos array (for index-based callback)
const pendingRepoLists = new Map<number, Array<{ nameWithOwner: string; url: string; isPrivate: boolean }>>();

export function setupNewProjectHandler(bot: any, projectManager: ProjectManager): void {

  // /new <name>  — path is auto-derived as PROJECTS_BASE_DIR/<name>
  bot.command('new', async (ctx: Context) => {
    const args = (ctx.match as string).trim();
    if (!args) {
      await ctx.reply(
        `Usage: /new <name>\n\nThe project will be created at ${config.PROJECTS_BASE_DIR}/<name>`
      );
      return;
    }

    // Only first word is the name (no spaces in project names)
    const name = args.split(/\s+/)[0];
    await promptCreateConfirmation(ctx, name);
  });

  // /clone [url]  — clone a GitHub repo and register it as a project
  //                  Only works in the New Projects topic.
  bot.command('clone', async (ctx: Context) => {
    const threadId = ctx.message?.message_thread_id;
    console.log(`[clone] threadId=${threadId} NEW_PROJECTS_TOPIC_ID=${config.NEW_PROJECTS_TOPIC_ID}`);
    if (threadId !== config.NEW_PROJECTS_TOPIC_ID) {
      await ctx.reply('⚠️ /clone can only be used in the New Projects topic.');
      return;
    }

    const url = (ctx.match as string).trim();

    if (!url) {
      await listGithubRepos(ctx);
      return;
    }

    await promptCloneConfirmation(ctx, url);
  });

  // /import             — lists untracked directories in PROJECTS_BASE_DIR
  // /import <name>      — directly imports a specific project
  bot.command('import', async (ctx: Context) => {
    const args = (ctx.match as string).trim();

    if (!args) {
      const untracked = projectManager.scanUntracked();

      if (untracked.length === 0) {
        await ctx.reply(
          `No untracked projects found in ${config.PROJECTS_BASE_DIR}.\n` +
          `All directories are already imported, or the folder is empty.`
        );
        return;
      }

      // Build inline keyboard: one button per project, 2 per row
      const keyboard = new InlineKeyboard();
      untracked.forEach((name, i) => {
        keyboard.text(`📦 ${name}`, `import_pick:${name}`);
        if (i % 2 === 1) keyboard.row();
      });

      await ctx.reply(
        `Found ${untracked.length} untracked project(s) in ${config.PROJECTS_BASE_DIR}:\n\nSelect one to import:`,
        { reply_markup: keyboard }
      );
      return;
    }

    // /import <name>
    const name = args.split(/\s+/)[0];
    await promptImportConfirmation(ctx, projectManager, name);
  });
}

async function promptCreateConfirmation(ctx: Context, name: string): Promise<void> {
  const userId = ctx.from!.id;
  const fullPath = `${config.PROJECTS_BASE_DIR}/${name}`;
  pendingConfirmations.set(userId, { name });

  await ctx.reply(
    `📁 Create new project?\n\nName: ${name}\nPath: ${fullPath}\n\nThis will scaffold the directory and create a Telegram topic.`,
    {
      reply_markup: confirmCancelKeyboard(
        `confirm_project:${userId}`,
        `cancel_project:${userId}`
      ),
    }
  );
}

async function promptImportConfirmation(
  ctx: Context,
  projectManager: ProjectManager,
  name: string
): Promise<void> {
  const userId = ctx.from!.id;
  const baseDir = config.PROJECTS_BASE_DIR;
  const fullPath = `${baseDir}/${name}`;

  // Check it exists and is untracked
  const untracked = projectManager.scanUntracked();
  if (!untracked.includes(name)) {
    const exists = untracked.length > 0;
    await ctx.reply(
      `Project "${name}" not found in ${baseDir} or already imported.\n` +
      (exists ? `Available: ${untracked.join(', ')}` : 'No untracked projects found.')
    );
    return;
  }

  pendingImports.set(userId, { name });

  await ctx.reply(
    `📦 Import existing project?\n\nName: ${name}\nPath: ${fullPath}\n\nThis will create a Telegram topic and start watching the project.`,
    {
      reply_markup: confirmCancelKeyboard(
        `confirm_import:${userId}`,
        `cancel_import:${userId}`
      ),
    }
  );
}

async function listGithubRepos(ctx: Context): Promise<void> {
  const statusMsg = await ctx.reply('🔍 Fetching your GitHub repositories...');

  let stdout: string;
  try {
    const result = await execFileAsync('gh', [
      'repo', 'list',
      '--limit', '30',
      '--json', 'nameWithOwner,url,isPrivate,description',
    ]);
    stdout = result.stdout;
  } catch (err: any) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `❌ Failed to fetch GitHub repos.\n\nMake sure \`gh\` is authenticated:\n\`gh auth login\`\n\nError: ${err.message}`
    );
    return;
  }

  let repos: Array<{ nameWithOwner: string; url: string; isPrivate: boolean; description: string }>;
  try {
    repos = JSON.parse(stdout);
  } catch {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ Could not parse repo list.');
    return;
  }

  if (repos.length === 0) {
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, 'No repositories found on your GitHub account.');
    return;
  }

  // Store repo list so the callback can look up by index (avoids 64-byte callback_data limit)
  const userId = ctx.from!.id;
  pendingRepoLists.set(userId, repos);

  // Build inline keyboard — one button per repo, one per row
  const keyboard = new InlineKeyboard();
  repos.forEach((repo, idx) => {
    const icon = repo.isPrivate ? '🔒' : '🌐';
    keyboard.text(`${icon} ${repo.nameWithOwner}`, `clone_pick:${userId}:${idx}`).row();
  });

  await ctx.api.editMessageText(
    ctx.chat!.id,
    statusMsg.message_id,
    `📋 Your GitHub repositories (${repos.length}):\n\nSelect one to clone:`,
    { reply_markup: keyboard }
  );
}

async function promptCloneConfirmation(ctx: Context, url: string): Promise<void> {
  const userId = ctx.from!.id;
  pendingClones.set(userId, { url });

  await ctx.reply(
    `🔗 Clone repository?\n\nURL: ${url}\n\nThis will clone the repo into ${config.PROJECTS_BASE_DIR} and create a Telegram topic.`,
    {
      reply_markup: confirmCancelKeyboard(
        `confirm_clone:${userId}`,
        `cancel_clone:${userId}`
      ),
    }
  );
}

export function getPendingConfirmation(userId: number) {
  return pendingConfirmations.get(userId);
}

export function clearPendingConfirmation(userId: number) {
  pendingConfirmations.delete(userId);
}

export function getPendingImport(userId: number) {
  return pendingImports.get(userId);
}

export function clearPendingImport(userId: number) {
  pendingImports.delete(userId);
}

export function getPendingClone(userId: number) {
  return pendingClones.get(userId);
}

export function setPendingClone(userId: number, url: string) {
  pendingClones.set(userId, { url });
}

export function clearPendingClone(userId: number) {
  pendingClones.delete(userId);
}

export function getRepoFromPendingList(userId: number, idx: number) {
  return pendingRepoLists.get(userId)?.[idx];
}

export function clearPendingRepoList(userId: number) {
  pendingRepoLists.delete(userId);
}

/** Called from router.ts for free-text messages in the New Projects topic. */
export async function handleNaturalLanguageProjectRequest(
  ctx: Context,
  projectManager: ProjectManager
): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  // Simple heuristic: treat the first "word-like" token as the project name
  // Strips common NL prefixes like "create project foo" -> "foo"
  const cleaned = text
    .toLowerCase()
    .replace(/^(create|new|add|make|init|import)\s+(project\s+)?/i, '')
    .trim();
  const name = cleaned.split(/\s+/)[0].replace(/[^a-z0-9_-]/gi, '-').replace(/-+$/, '');

  if (!name) {
    await ctx.reply(
      `Could not extract a project name. Please use:\n/new <name>\n/import <name>\n\nExample: /new price-tracker`
    );
    return;
  }

  // If it looks like an import request, show import prompt
  if (/import|existing|already|have/i.test(text)) {
    await promptImportConfirmation(ctx, projectManager, name);
  } else {
    await promptCreateConfirmation(ctx, name);
  }
}

/** Called from callbacks.ts when user clicks an import_pick button. */
export async function handleImportPick(
  ctx: any,
  projectManager: ProjectManager,
  name: string
): Promise<void> {
  const userId = ctx.from!.id;
  pendingImports.set(userId, { name });
  const fullPath = `${config.PROJECTS_BASE_DIR}/${name}`;

  await ctx.editMessageText(
    `📦 Import existing project?\n\nName: ${name}\nPath: ${fullPath}`,
    {
      reply_markup: confirmCancelKeyboard(
        `confirm_import:${userId}`,
        `cancel_import:${userId}`
      ),
    }
  );
}
