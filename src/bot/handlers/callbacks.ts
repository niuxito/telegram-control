import type { CallbackQueryContext, Context } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import type { Db } from '../../db/client.js';
import {
  getPendingConfirmation,
  clearPendingConfirmation,
  getPendingImport,
  clearPendingImport,
  getPendingClone,
  setPendingClone,
  clearPendingClone,
  getRepoFromPendingList,
  clearPendingRepoList,
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
import { confirmCancelKeyboard } from '../keyboards.js';
import { insertLocalIssue } from '../../db/queries/localIssues.js';
import { getPendingTasks, getTaskById } from '../../db/queries/taskQueue.js';
import { config } from '../../config.js';
import { getAgent } from '../../agents/index.js';
import { getPendingQuotaRetry, clearPendingQuotaRetry } from './topic/quotaRetry.js';
import { insertTopicMessage } from '../../db/queries/topicMessages.js';

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

  // ── Clone repository ─────────────────────────────────────────────────────
  // ── Clone: repo picker ────────────────────────────────────────────────────
  bot.callbackQuery(/^clone_pick:(\d+):(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }

    const userId = parseInt(ctx.match[1]);
    const idx = parseInt(ctx.match[2]);

    const repo = getRepoFromPendingList(userId, idx);
    if (!repo) { await ctx.answerCallbackQuery('Selection expired. Run /clone again.'); return; }

    clearPendingRepoList(userId);
    setPendingClone(userId, repo.url);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🔗 Clone repository?\n\nURL: ${repo.url}\n\nThis will clone the repo into ${config.PROJECTS_BASE_DIR} and create a Telegram topic.`,
      {
        reply_markup: confirmCancelKeyboard(
          `confirm_clone:${userId}`,
          `cancel_clone:${userId}`
        ),
      }
    );
  });

  bot.callbackQuery(/^confirm_clone:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    if (userId !== config.OWNER_USER_ID) { await ctx.answerCallbackQuery('Invalid token.'); return; }

    const pending = getPendingClone(userId);
    if (!pending) { await ctx.answerCallbackQuery('No pending clone found.'); return; }

    clearPendingClone(userId);
    await ctx.answerCallbackQuery('Cloning...');
    await ctx.editMessageText(`🔄 Cloning ${pending.url}...`);

    try {
      const project = await projectManager.cloneProject(pending.url);
      await ctx.editMessageText(
        `✅ Repository cloned!\nPath: ${project.localPath}\nA new topic has been created.`
      );
    } catch (err) {
      console.error('[Callbacks] Failed to clone repository:', err);
      await ctx.editMessageText('❌ Failed to clone repository. Check the URL and server logs.');
    }
  });

  bot.callbackQuery(/^cancel_clone:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }
    const userId = parseInt(ctx.match[1]);
    clearPendingClone(userId);
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.editMessageText('❌ Clone cancelled.');
  });

  // ── Codex fallback retry ─────────────────────────────────────────────────
  bot.callbackQuery(/^codex_retry:(\d+):(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery('Unauthorized.'); return; }

    const projectId = parseInt(ctx.match[1]);
    const taskId    = parseInt(ctx.match[2]);

    const session = projectManager.getSession(projectId);
    if (!session) {
      await ctx.answerCallbackQuery('Project session not found.');
      return;
    }

    const task = getTaskById(db, taskId);
    if (!task) {
      await ctx.answerCallbackQuery('Task not found.');
      return;
    }

    await ctx.answerCallbackQuery('Starting Codex...');
    await ctx.editMessageText('🔄 Retrying with Codex (OpenAI)...');
    session.runWithCodex(taskId, task.prompt);
  });

  // ── Quota retry: opt-in to OpenCode free Zen on usage_limit ───────────────
  // The router's privacy gate blocks auto-fallback for project-internal tasks;
  // these buttons let the user explicitly consent (or cancel).

  bot.callbackQuery(/^quota_retry_opencode:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    const buttonOwner = parseInt(ctx.match[1]);
    if (ctx.from?.id !== buttonOwner) {
      await ctx.answerCallbackQuery('This button is for the user who started the task.');
      return;
    }

    const retry = getPendingQuotaRetry(buttonOwner);
    if (!retry) {
      await ctx.answerCallbackQuery('Retry is no longer available (bot may have restarted).');
      return;
    }
    clearPendingQuotaRetry(buttonOwner);

    await ctx.answerCallbackQuery('Running on OpenCode...');
    await ctx.editMessageText('🦊 Retrying with OpenCode free tier...');

    try {
      const result = await getAgent('opencode').run({
        prompt: retry.prompt,
        cwd: retry.cwd,
      });

      const body = result.result?.trim() || result.error || '(no output)';
      const header = result.success ? '' : '⚠️ OpenCode finished with errors\n\n';
      const cost = result.costUsd ? `💰 $${result.costUsd.toFixed(4)} | ` : '';
      const originalLabel = getAgent(retry.originalAgent).label;
      const footer = `\n\n---\n${cost}🦊 Powered by OpenCode (you opted in after ${originalLabel} quota)`;
      const full = header + body + footer;

      if (result.result?.trim()) {
        insertTopicMessage(db, { projectId: retry.projectId, sender: 'opencode', text: result.result.trim() });
      }

      if (full.length > 4096) {
        await ctx.editMessageText(full.slice(0, 4093) + '…');
      } else {
        await ctx.editMessageText(full);
      }
    } catch (err: any) {
      await ctx.editMessageText(`❌ OpenCode error: ${err.message}`);
    }
  });

  bot.callbackQuery(/^quota_cancel:(\d+)$/, async (ctx: CallbackQueryContext<Context>) => {
    const buttonOwner = parseInt(ctx.match[1]);
    if (ctx.from?.id !== buttonOwner) {
      await ctx.answerCallbackQuery('This button is for the user who started the task.');
      return;
    }

    clearPendingQuotaRetry(buttonOwner);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('✋ Cancelled. Quota retry dismissed.');
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
