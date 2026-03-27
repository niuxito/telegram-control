import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import { confirmCancelKeyboard } from '../keyboards.js';
import { config } from '../../config.js';

// Pending new-project confirmations: userId -> { name }
const pendingConfirmations = new Map<number, { name: string }>();
// Pending import confirmations: userId -> { name }
const pendingImports = new Map<number, { name: string }>();

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
