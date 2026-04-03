import type { CallbackQueryContext, Context } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import type { Db } from '../../db/client.js';
import {
  getPendingConfirmation,
  clearPendingConfirmation,
  getPendingImport,
  clearPendingImport,
  handleImportPick,
} from './newProject.js';
import {
  getPendingGithubPublic,
  clearPendingGithubPublic,
  buildGithubPrompt,
  getPendingVercelDeploy,
  clearPendingVercelDeploy,
  buildVercelPrompt,
  getPendingIssueRequest,
  clearPendingIssueRequest,
} from './projectTopic.js';
import { buildPlanningIssuePrompt } from './agentIntent.js';
import { insertLocalIssue } from '../../db/queries/localIssues.js';
import { getPendingTasks } from '../../db/queries/taskQueue.js';
import { config } from '../../config.js';

function isOwner(ctx: CallbackQueryContext<Context>): boolean {
  return ctx.from?.id === config.OWNER_USER_ID;
}

export function setupCallbackHandlers(bot: any, projectManager: ProjectManager, db: Db): void {

  // ── Create project ────────────────────────────────────────────────────────
  bot.callbackQuery(/^confirm_project:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    const pending = getPendingConfirmation(userId);
    if (!pending) { await ctx.answerCallbackQuery('No pending confirmation found.'); return; }

    clearPendingConfirmation(userId);
    await ctx.answerCallbackQuery('Creating project...');
    await ctx.editMessageText('🔄 Creating project...');

    try {
      const project = await projectManager.createProject(pending.name);
      await ctx.editMessageText(
        `✅ Project created!\nPath: ${project.localPath}\nA new topic has been created.`
      );
    } catch (err) {
      console.error('[Callbacks] Failed to create project:', err);
      await ctx.editMessageText('❌ Failed to create project. Check server logs for details.');
    }
  });

  bot.callbackQuery(/^cancel_project:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    clearPendingConfirmation(userId);
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.editMessageText('❌ Project creation cancelled.');
  });

  // ── Import project ────────────────────────────────────────────────────────

  // User clicked a project name in the /import list
  bot.callbackQuery(/^import_pick:(.+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await handleImportPick(ctx, projectManager, name);
  });

  bot.callbackQuery(/^confirm_import:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    const pending = getPendingImport(userId);
    if (!pending) { await ctx.answerCallbackQuery('No pending import found.'); return; }

    clearPendingImport(userId);
    await ctx.answerCallbackQuery('Importing...');
    await ctx.editMessageText('🔄 Importing project...');

    try {
      const project = await projectManager.importProject(pending.name);
      await ctx.editMessageText(
        `✅ Project imported!\nPath: ${project.localPath}\nA new topic has been created.`
      );
    } catch (err) {
      console.error('[Callbacks] Failed to import project:', err);
      await ctx.editMessageText('❌ Failed to import project. Check server logs for details.');
    }
  });

  bot.callbackQuery(/^cancel_import:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    clearPendingImport(userId);
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.editMessageText('❌ Import cancelled.');
  });

  // ── Project action buttons ────────────────────────────────────────────────
  bot.callbackQuery(/^project:status:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const projectId = parseInt(ctx.match[1]);
    const session = projectManager.getSession(projectId);
    if (!session) { await ctx.answerCallbackQuery('No active session.'); return; }
    const status = await session.getStatus();
    await ctx.answerCallbackQuery(
      `Running: ${status.running ? 'Yes' : 'No'} | Pending: ${status.pendingCount}`
    );
  });

  bot.callbackQuery(/^project:pause:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    await projectManager.pauseProject(parseInt(ctx.match[1]));
    await ctx.answerCallbackQuery('Project paused.');
  });

  bot.callbackQuery(/^project:archive:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    await projectManager.archiveProject(parseInt(ctx.match[1]));
    await ctx.answerCallbackQuery('Project archived.');
  });

  // ── GitHub public repo confirmation ───────────────────────────────────────

  bot.callbackQuery(/^confirm_github_public:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    const pending = getPendingGithubPublic(userId);
    if (!pending) { await ctx.answerCallbackQuery('No pending confirmation found.'); return; }

    clearPendingGithubPublic(userId);

    const session = projectManager.getSession(pending.projectId);
    if (!session) {
      await ctx.answerCallbackQuery('Project session not found.');
      await ctx.editMessageText('❌ Project session not found. Project may be paused or archived.');
      return;
    }

    await ctx.answerCallbackQuery('Queuing public repo task...');

    const prompt = buildGithubPrompt(pending.projectName, 'public');
    await session.queueTask(prompt);
    const pendingTasks = getPendingTasks(db, pending.projectId);
    if (pendingTasks.length > 1) {
      await ctx.editMessageText(`✅ GitHub repo task queued (position ${pendingTasks.length}). Current task will finish first.`);
    } else {
      await ctx.editMessageText(`✅ GitHub repo task queued (public).`);
    }
  });

  bot.callbackQuery(/^cancel_github_public:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    clearPendingGithubPublic(userId);
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.editMessageText('❌ GitHub repo creation cancelled.');
  });

  // ── Issue without GitHub — setup repo first ──────────────────────────────
  bot.callbackQuery(/^setup_github_for_issue:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    const pending = getPendingIssueRequest(userId);
    if (!pending) { await ctx.answerCallbackQuery('Request expired.'); return; }
    clearPendingIssueRequest(userId);

    const session = projectManager.getSession(pending.projectId);
    if (!session) { await ctx.answerCallbackQuery('Session not found.'); return; }

    await ctx.answerCallbackQuery('Setting up GitHub repo...');
    // First create the repo, then create the issue
    const setupPrompt =
      buildGithubPrompt('', 'private') + '\n\n' +
      'After the repo is created, continue with:\n' +
      buildPlanningIssuePrompt(pending.description, true);
    await session.queueTask(setupPrompt);
    await ctx.editMessageText('✅ Queued: create GitHub repo + planning agent for the issue.');
  });

  // ── Issue without GitHub — store locally ─────────────────────────────────
  bot.callbackQuery(/^local_issue:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    const pending = getPendingIssueRequest(userId);
    if (!pending) { await ctx.answerCallbackQuery('Request expired.'); return; }
    clearPendingIssueRequest(userId);

    const session = projectManager.getSession(pending.projectId);
    if (!session) { await ctx.answerCallbackQuery('Session not found.'); return; }

    await ctx.answerCallbackQuery('Analysing and storing locally...');
    // Run planning agent, store the output as a local issue
    await session.queueTask(buildPlanningIssuePrompt(pending.description, false));
    await ctx.editMessageText('✅ Planning agent started — result will be stored as a local issue.');
  });

  // ── Vercel production deploy confirmation ─────────────────────────────────

  bot.callbackQuery(/^confirm_vercel_deploy:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    const pending = getPendingVercelDeploy(userId);
    if (!pending) { await ctx.answerCallbackQuery('No pending confirmation found.'); return; }

    clearPendingVercelDeploy(userId);

    const session = projectManager.getSession(pending.projectId);
    if (!session) {
      await ctx.answerCallbackQuery('Project session not found.');
      await ctx.editMessageText('❌ Project session not found. Project may be paused or archived.');
      return;
    }

    await ctx.answerCallbackQuery('Queuing production deploy task...');

    const prompt = buildVercelPrompt('', 'deploy');
    await session.queueTask(prompt);
    const pendingTasks = getPendingTasks(db, pending.projectId);
    if (pendingTasks.length > 1) {
      await ctx.editMessageText(`✅ Vercel deploy task queued (position ${pendingTasks.length}). Current task will finish first.`);
    } else {
      await ctx.editMessageText(`✅ Vercel production deploy task queued.`);
    }
  });

  bot.callbackQuery(/^cancel_vercel_deploy:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    clearPendingVercelDeploy(userId);
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.editMessageText('❌ Vercel production deploy cancelled.');
  });
}
