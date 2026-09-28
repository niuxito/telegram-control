import type { Context } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import { getRecentTasks, getPendingTasks, cancelPendingTasks, getTaskById } from '../../../db/queries/taskQueue.js';
import { insertTopicMessage, getRecentTopicMessages, buildConversationContext, resolveContextLimit } from '../../../db/queries/topicMessages.js';
import { getAgent, runWithRouter } from '../../../agents/index.js';
import { parsePrReference, truncateDiff, buildReviewPrompt, MAX_REVIEW_DIFF_CHARS } from './reviewHelpers.js';
import { setPendingQuotaRetry, buildQuotaRetryPrompt } from './quotaRetry.js';
import { readFileSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Db } from '../../../db/client.js';

const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 3800;
const TELEGRAM_MESSAGE_LIMIT = 4096;

// Model used by /plan — Claude CLI's "opus" alias always points at the most
// capable Opus release, so we don't have to bump this when new versions ship.
// Per-call override; does NOT change the project's persistent /model setting.
export const PLANNING_MODEL = 'opus';

function buildTopicPrompt(
  db: Db,
  projectId: number,
  senderName: string,
  prompt: string,
  limit: number,
): { historyLength: number; contextualPrompt: string } {
  insertTopicMessage(db, { projectId, sender: 'user', senderName, text: prompt });

  const history = getRecentTopicMessages(db, projectId, limit);
  const context = buildConversationContext(history.slice(0, -1));
  return {
    historyLength: history.length,
    contextualPrompt: context ? `${context}Current request: ${prompt}` : prompt,
  };
}

async function publishTopicMessage(
  ctx: Context,
  chatId: number,
  topicId: number,
  messageId: number,
  text: string,
  options?: Record<string, unknown>,
): Promise<void> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(remaining.slice(0, TELEGRAM_MESSAGE_LIMIT));
    remaining = remaining.slice(TELEGRAM_MESSAGE_LIMIT);
  }
  chunks.push(remaining);

  const firstChunk = chunks[0];
  try {
    await ctx.api.editMessageText(chatId, messageId, firstChunk, options);
  } catch (err) {
    console.warn('[topic/tasks] editMessageText failed, sending a replacement message:', err instanceof Error ? err.message : err);
    try {
      await ctx.api.sendMessage(chatId, firstChunk, {
        message_thread_id: topicId,
        ...options,
      });
    } catch (sendErr) {
      console.warn('[topic/tasks] sendMessage fallback failed:', sendErr instanceof Error ? sendErr.message : sendErr);
    }
  }

  for (const chunk of chunks.slice(1)) {
    try {
      await ctx.api.sendMessage(chatId, chunk, {
        message_thread_id: topicId,
      });
    } catch (err) {
      console.warn('[topic/tasks] chunk send failed:', err instanceof Error ? err.message : err);
    }
  }
}

function runProjectTests(cwd: string): Promise<string> {
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

  const trimmed = raw.length > MAX_OUTPUT_CHARS
    ? `...(truncated)\n${raw.slice(-MAX_OUTPUT_CHARS)}`
    : raw;

  return header + trimmed;
}

export function setupTaskHandlers(bot: any, projectManager: ProjectManager, db: Db): void {

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
    const senderName = ctx.from?.username ?? ctx.from?.first_name ?? 'User';
    insertTopicMessage(db, { projectId: project.id, sender: 'user', senderName, text: prompt });

    await session.queueTask(prompt);
    const pending = getPendingTasks(db, project.id);
    if (pending.length > 1) {
      await ctx.reply(`✅ Task queued (position ${pending.length}). Current task will finish first.`);
    }
  });

  bot.command('status', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply(`📊 ${project.name}\nStatus: ${project.status}\nNo active session.`);
      return;
    }
    const status = await session.getStatus();
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
    await ctx.reply(`Recent Tasks:\n${lines}`);
  });

  bot.command('cancel', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    cancelPendingTasks(db, project.id);
    const session = projectManager.getSession(project.id);
    session?.cancelCurrent();
    await ctx.reply('✅ Cancelled pending tasks.');
  });

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

  bot.command('test', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    try {
      const pkg = JSON.parse(readFileSync(path.join(project.localPath, 'package.json'), 'utf-8'));
      if (!pkg.scripts?.test) {
        await ctx.reply('No test script found in package.json.');
        return;
      }
    } catch {
      // No package.json — try anyway
    }

    const msg = await ctx.reply('🧪 Running tests...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;
    const output = await runProjectTests(project.localPath);
    await ctx.api.editMessageText(chatId, msgId, output);
  });

  bot.command('codex', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }
    const prompt = (ctx.match as string).trim();
    if (!prompt) {
      await ctx.reply('Usage: /codex <prompt>\n\nRuns the task using Codex (ChatGPT subscription) as a parallel AI agent.');
      return;
    }

    // Resolve context limit: --more flag or keyword detection
    const { limit, flagFound, promptClean } = resolveContextLimit(prompt);
    const finalUserPrompt = promptClean;

    const msg = await ctx.reply('🤖 Codex is working on it...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    const senderName = ctx.from?.username ?? ctx.from?.first_name ?? 'User';
    const { historyLength, contextualPrompt } = buildTopicPrompt(
      db,
      project.id,
      senderName,
      finalUserPrompt,
      limit,
    );

    if (flagFound) {
      await publishTopicMessage(
        ctx,
        chatId,
        project.topicId!,
        msgId,
        `🤖 Codex is working on it (with extended context: ${historyLength} messages)...`,
      );
    }

    let dots = 0;
    const heartbeat = setInterval(async () => {
      dots = (dots + 1) % 4;
      try {
        await ctx.api.editMessageText(chatId, msgId, `🤖 Codex is working on it${'.'.repeat(dots + 1)}`);
      } catch { /* ignore edit races */ }
    }, 5000);

    let codexResult: Awaited<ReturnType<typeof runWithRouter>> | undefined;
    let codexErr: any;
    try {
      codexResult = await runWithRouter({
        prompt: contextualPrompt,
        cwd: project.localPath,
        preferredAgent: 'codex',
        sensitivity: 'project-internal',
      });
    } catch (err: any) {
      codexErr = err;
    } finally {
      clearInterval(heartbeat);
    }

    if (codexErr) {
      await publishTopicMessage(ctx, chatId, project.topicId!, msgId, `❌ Codex error: ${codexErr.message}`);
      return;
    }

    const { result, agentUsed, fellBack } = codexResult!;

    // Codex auth expired → actionable message, no spawn of exec wasted
    if (!result.success && result.errorType === 'auth_required') {
      await publishTopicMessage(ctx, chatId, project.topicId!, msgId,
        '🔑 La sesión de Codex con OpenAI ha expirado.\n\n' +
        'Usa /codex_login para re-autenticar desde el móvil (te doy un ' +
        'enlace y un código). Mientras tanto puedes seguir con /task ' +
        '(Claude) o /opencode.'
      );
      return;
    }

    // Project-internal + usage_limit → offer opt-in fallback (privacy gate)
    if (!result.success && result.errorType === 'usage_limit') {
      const userId = ctx.from?.id;
      if (userId) {
        const { text, keyboard } = buildQuotaRetryPrompt(userId, 'Codex');
        await publishTopicMessage(ctx, chatId, project.topicId!, msgId, text, { reply_markup: keyboard });
        setPendingQuotaRetry(userId, {
          prompt: contextualPrompt,
          cwd: project.localPath,
          originalAgent: 'codex',
          projectId: project.id,
          chatId, topicId: project.topicId!, messageId: msgId,
        });
        return;
      }
    }

    const body = result.result?.trim() || result.error || '(no output)';
    const header = result.success ? '' : '⚠️ Codex finished with errors\n\n';
    const agentLabel = getAgent(agentUsed).label;
    const degradedNote = fellBack ? ` (auto-degraded from Codex after quota)` : '';
    const footer = `\n\n— ${getAgent(agentUsed).icon} Powered by ${agentLabel}${degradedNote}`;
    const full = header + body + footer;

    // Save response to shared history under the agent that actually answered
    if (result.result?.trim()) {
      insertTopicMessage(db, { projectId: project.id, sender: agentUsed, text: result.result.trim() });
    }

    await publishTopicMessage(ctx, chatId, project.topicId!, msgId, full);
  });

  // /opencode <prompt> — runs the task with OpenCode, the third AI agent.
  // Provider-agnostic: by default uses whatever OpenCode is configured with.
  bot.command('opencode', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }
    const prompt = (ctx.match as string).trim();
    if (!prompt) {
      await ctx.reply('Usage: /opencode <prompt>\n\nRuns the task using OpenCode (third AI agent).');
      return;
    }

    const { limit, flagFound, promptClean } = resolveContextLimit(prompt);
    const finalUserPrompt = promptClean;

    const msg = await ctx.reply('🦊 OpenCode is working on it...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    const senderName = ctx.from?.username ?? ctx.from?.first_name ?? 'User';
    insertTopicMessage(db, { projectId: project.id, sender: 'user', senderName, text: finalUserPrompt });

    const history = getRecentTopicMessages(db, project.id, limit);
    const context = buildConversationContext(history.slice(0, -1));
    const contextualPrompt = context ? `${context}Current request: ${finalUserPrompt}` : finalUserPrompt;

    if (flagFound) {
      await publishTopicMessage(
        ctx,
        chatId,
        project.topicId!,
        msgId,
        `🦊 OpenCode is working (extended context: ${history.length} messages)...`,
      );
    }

    let dots = 0;
    const heartbeat = setInterval(async () => {
      dots = (dots + 1) % 4;
      try {
        await ctx.api.editMessageText(chatId, msgId, `🦊 OpenCode is working${'.'.repeat(dots + 1)}`);
      } catch { /* ignore edit races */ }
    }, 5000);

    let opencodeResult: Awaited<ReturnType<typeof runWithRouter>> | undefined;
    let opencodeErr: any;
    try {
      opencodeResult = await runWithRouter({
        prompt: contextualPrompt,
        cwd: project.localPath,
        preferredAgent: 'opencode',
        sensitivity: 'project-internal',
      });
    } catch (err: any) {
      opencodeErr = err;
    } finally {
      clearInterval(heartbeat);
    }

    if (opencodeErr) {
      await publishTopicMessage(ctx, chatId, project.topicId!, msgId, `❌ OpenCode error: ${opencodeErr.message}`);
      return;
    }

    const { result: ocResult, agentUsed: ocAgent, fellBack: ocFellBack } = opencodeResult!;
    const body = ocResult.result?.trim() || ocResult.error || '(no output)';
    const header = ocResult.success ? '' : '⚠️ OpenCode finished with errors\n\n';
    const cost = ocResult.costUsd ? `💰 $${ocResult.costUsd.toFixed(4)} | ` : '';
    const agentLabel = getAgent(ocAgent).label;
    const degradedNote = ocFellBack ? ` (auto-degraded from OpenCode after quota)` : '';
    const footer = `\n\n---\n${cost}${getAgent(ocAgent).icon} Powered by ${agentLabel}${degradedNote}`;
    const full = header + body + footer;

    if (ocResult.result?.trim()) {
      insertTopicMessage(db, { projectId: project.id, sender: ocAgent, text: ocResult.result.trim() });
    }

    await publishTopicMessage(ctx, chatId, project.topicId!, msgId, full);
  });

  // /plan <prompt> — runs Claude with the most-capable model (Opus) for one
  // turn, without changing the project's default /model. Used for research
  // and planning where reasoning quality matters more than throughput.
  bot.command('plan', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }
    const prompt = (ctx.match as string).trim();
    if (!prompt) {
      await ctx.reply(
        `Usage: /plan <prompt>\n\nRuns the prompt with ${PLANNING_MODEL} for deeper reasoning. ` +
        `One-shot — does not change the project's /model setting.`
      );
      return;
    }

    const { limit, flagFound, promptClean } = resolveContextLimit(prompt);
    const finalUserPrompt = promptClean;

    const msg = await ctx.reply(`🧠 Planning with ${PLANNING_MODEL}...`);
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    const senderName = ctx.from?.username ?? ctx.from?.first_name ?? 'User';
    insertTopicMessage(db, { projectId: project.id, sender: 'user', senderName, text: finalUserPrompt });

    const history = getRecentTopicMessages(db, project.id, limit);
    const context = buildConversationContext(history.slice(0, -1));
    const contextualPrompt = context ? `${context}Current request: ${finalUserPrompt}` : finalUserPrompt;

    if (flagFound) {
      await publishTopicMessage(
        ctx,
        chatId,
        project.topicId!,
        msgId,
        `🧠 Planning with ${PLANNING_MODEL} (extended context: ${history.length} messages)...`,
      );
    }

    let dots = 0;
    const heartbeat = setInterval(async () => {
      dots = (dots + 1) % 4;
      try {
        await ctx.api.editMessageText(chatId, msgId, `🧠 Planning${'.'.repeat(dots + 1)}`);
      } catch { /* ignore edit races */ }
    }, 5000);

    let planResult: Awaited<ReturnType<typeof runWithRouter>> | undefined;
    let planErr: any;
    try {
      planResult = await runWithRouter({
        prompt: contextualPrompt,
        cwd: project.localPath,
        model: PLANNING_MODEL,
        preferredAgent: 'claude',
        sensitivity: 'project-internal',
      });
    } catch (err: any) {
      planErr = err;
    } finally {
      clearInterval(heartbeat);
    }

    if (planErr) {
      await publishTopicMessage(ctx, chatId, project.topicId!, msgId, `❌ Planning error: ${planErr.message}`);
      return;
    }

    const { result: planRes, agentUsed: planAgent } = planResult!;

    if (!planRes.success && planRes.errorType === 'usage_limit') {
      const userId = ctx.from?.id;
      if (userId) {
        const { text, keyboard } = buildQuotaRetryPrompt(userId, `Claude (${PLANNING_MODEL})`);
        await publishTopicMessage(ctx, chatId, project.topicId!, msgId, text, { reply_markup: keyboard });
        setPendingQuotaRetry(userId, {
          prompt: contextualPrompt,
          cwd: project.localPath,
          originalAgent: 'claude',
          projectId: project.id,
          chatId, topicId: project.topicId!, messageId: msgId,
        });
        return;
      }
    }

    const planBody = planRes.result?.trim() || planRes.error || '(no output)';
    const planHeader = planRes.success ? '' : '⚠️ Planning finished with errors\n\n';
    const planCost = planRes.costUsd ? `💰 $${planRes.costUsd.toFixed(4)} | ` : '';
    const lane = planAgent === 'claude'
      ? `Claude (${PLANNING_MODEL}, planning lane)`
      : `${getAgent(planAgent).label} (auto-degraded from Claude after quota)`;
    const planFooter = `\n\n---\n${planCost}🧠 Powered by ${lane}`;
    const planFull = planHeader + planBody + planFooter;

    if (planRes.result?.trim()) {
      insertTopicMessage(db, { projectId: project.id, sender: planAgent, text: planRes.result.trim() });
    }

    await publishTopicMessage(ctx, chatId, project.topicId!, msgId, planFull);
  });

  // /review         — review current git diff
  // /review <pr>    — review a specific PR number (requires gh CLI)
  // /review <url>   — review a PR by URL
  bot.command('review', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    const arg = (ctx.match as string).trim();
    const msg = await ctx.reply('🔍 Preparing review...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    try {
      let diffText = '';
      let reviewTarget = '';

      if (!arg) {
        // Review current working diff
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);

        const { stdout: staged } = await exec('git', ['diff', '--cached'], { cwd: project.localPath }).catch(() => ({ stdout: '' }));
        const { stdout: unstaged } = await exec('git', ['diff'], { cwd: project.localPath }).catch(() => ({ stdout: '' }));
        diffText = (staged + unstaged).trim();

        if (!diffText) {
          // Fall back to diff against main/master
          const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.localPath }).catch(() => ({ stdout: 'HEAD' }));
          const base = branch.trim() === 'main' ? 'HEAD~1' : 'main';
          const { stdout } = await exec('git', ['diff', base], { cwd: project.localPath }).catch(() => ({ stdout: '' }));
          diffText = stdout.trim();
          reviewTarget = `diff vs ${base}`;
        } else {
          reviewTarget = 'current changes (staged + unstaged)';
        }

        if (!diffText) {
          await ctx.api.editMessageText(chatId, msgId, 'No changes to review. Working tree is clean.');
          return;
        }

        diffText = truncateDiff(diffText, MAX_REVIEW_DIFF_CHARS);

      } else {
        // PR review via gh CLI
        const prNum = parsePrReference(arg);
        if (prNum === null) {
          await ctx.api.editMessageText(chatId, msgId, '❌ Invalid PR reference. Usage: /review <number> or /review <url>');
          return;
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);

        let prInfo = '';
        try {
          const { stdout } = await exec('gh', ['pr', 'view', String(prNum), '--json', 'title,body,additions,deletions,files'], { cwd: project.localPath });
          const pr = JSON.parse(stdout);
          prInfo = `PR #${prNum}: ${pr.title}\n\n${pr.body ?? ''}\n\n+${pr.additions} -${pr.deletions} in ${pr.files?.length ?? '?'} file(s)`;
        } catch {
          prInfo = `PR #${prNum}`;
        }

        const { stdout: diff } = await exec('gh', ['pr', 'diff', String(prNum)], { cwd: project.localPath });
        diffText = truncateDiff(diff.trim(), MAX_REVIEW_DIFF_CHARS);
        reviewTarget = prInfo;
      }

      await ctx.api.editMessageText(chatId, msgId, `🔍 Reviewing ${reviewTarget}...`);

      await session.queueTask(buildReviewPrompt(project.name, reviewTarget, diffText));

    } catch (err: any) {
      await ctx.api.editMessageText(chatId, msgId, `❌ Review error: ${err.message}`);
    }
  });
}
