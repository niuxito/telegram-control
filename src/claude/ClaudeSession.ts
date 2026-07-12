import type { Db } from '../db/client.js';
import { insertTopicMessage } from '../db/queries/topicMessages.js';
import { getLatestSession, insertSession, updateSession } from '../db/queries/sessions.js';
import { insertTask, updateTask, getRunningTask, getRunningTasksByProject, getPendingTasks } from '../db/queries/taskQueue.js';
import { getProjectById } from '../db/queries/projects.js';
import { runCliTask } from './CliStrategy.js';
import { runCodexTask } from './CodexStrategy.js';
import { CHECKPOINT_PROMPT, formatCheckpointBlock, composeCheckpointAppend } from './checkpointFormat.js';
import { formatLimitError } from '../notifications/formatters.js';
import { agentEvents } from '../api/events.js';
import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';


/** Remove backtick wrapping around URLs so Telegram renders them as clickable links. */
function unwrapUrlsFromCode(text: string): string {
  return text.replace(/`(https?:\/\/[^\s`]+)`/g, '$1');
}

/** True for Telegram/HTTP errors that are worth retrying (gateway timeouts, rate limits, network glitches). */
function isTransientTelegramError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { error_code?: number; code?: string; name?: string; cause?: { code?: string } };
  if (e.error_code && [429, 500, 502, 503, 504].includes(e.error_code)) return true;
  const code = e.code ?? e.cause?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND'].includes(code)) return true;
  if (e.name === 'HttpError') return true;
  return false;
}

/** Retries a Telegram API call on transient errors with exponential backoff (max ~30s total). */
async function withTelegramRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientTelegramError(err) || attempt === maxAttempts) throw err;
      const delay = Math.min(1500 * attempt, 8000);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ClaudeSession] ${label} transient error (attempt ${attempt}/${maxAttempts}, retry in ${delay}ms): ${msg}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export class ClaudeSession {
  private db: Db;
  private bot: Bot;
  private projectId: number;
  private projectPath: string;
  private topicId: number;
  private chatId: number;
  private processing = false;
  private projectName = '';
  private liveOutput = '';

  private model: string | undefined;
  private currentTaskController: AbortController | null = null;

  constructor(db: Db, bot: Bot, projectId: number, projectPath: string, topicId: number, chatId: number, projectName = '', model?: string) {
    this.db = db;
    this.bot = bot;
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.topicId = topicId;
    this.chatId = chatId;
    this.projectName = projectName;
    this.model = model ?? undefined;
  }

  setModel(model: string | null) {
    this.model = model ?? undefined;
  }

  getModel(): string | undefined {
    return this.model;
  }

  getLiveOutput(): string {
    return this.liveOutput;
  }

  async queueTask(prompt: string): Promise<number> {
    const task = insertTask(this.db, {
      projectId: this.projectId,
      prompt,
      status: 'pending',
    });
    // Fire-and-forget: any rejection that escaped runTask's own try/catch is
    // logged here so it never surfaces as an unhandledRejection.
    this.processQueue().catch((err) => {
      console.error(`[ClaudeSession ${this.projectName}] processQueue rejected unexpectedly:`, err);
    });
    return task.id;
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        const pending = getPendingTasks(this.db, this.projectId);
        if (pending.length === 0) break;

        const task = pending[0];
        try {
          await this.runTask(task.id, task.prompt);
        } catch (err) {
          // runTask has its own catch, but defend against anything that slips through
          // (e.g. an error thrown before the inner try, or by the catch handler itself)
          // so a single failure does not abandon the rest of the queue.
          console.error(`[ClaudeSession ${this.projectName}] runTask escaped for task ${task.id}:`, err);
          try {
            updateTask(this.db, task.id, {
              status: 'failed',
              result: err instanceof Error ? err.message : String(err),
              completedAt: new Date(),
            });
          } catch (dbErr) {
            console.error(`[ClaudeSession ${this.projectName}] also failed to mark task ${task.id} as failed:`, dbErr);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async runTask(taskId: number, prompt: string) {
    updateTask(this.db, taskId, { status: 'running' });
    this.liveOutput = '';
    agentEvents.emit('agent', { type: 'task:started', agentId: this.projectId, agentName: this.projectName, taskId, prompt });

    const session = getLatestSession(this.db, this.projectId);

    // Send initial "working" message — retry transient 5xx/network errors so a
    // single Telegram blip cannot tear down the queue processor.
    let workingMsg: Awaited<ReturnType<typeof this.bot.api.sendMessage>>;
    try {
      workingMsg = await withTelegramRetry('sendMessage(working)', () =>
        this.bot.api.sendMessage(this.chatId, '⏳ Working...', { message_thread_id: this.topicId })
      );
    } catch (err) {
      console.error(`[ClaudeSession] Could not send initial working message for task ${taskId}:`, err);
      updateTask(this.db, taskId, {
        status: 'failed',
        result: `Telegram error sending initial message: ${err instanceof Error ? err.message : String(err)}`,
        completedAt: new Date(),
      });
      agentEvents.emit('agent', { type: 'task:failed', agentId: this.projectId, agentName: this.projectName, taskId });
      return;
    }

    updateTask(this.db, taskId, { liveMessageId: workingMsg.message_id });

    let accumulatedText = '';
    let lastEdit = 0;
    const EDIT_DEBOUNCE_MS = 800;

    const editMessage = async (text: string, isFinal = false) => {
      const now = Date.now();
      if (!isFinal && now - lastEdit < EDIT_DEBOUNCE_MS) return;
      lastEdit = now;

      const processed = unwrapUrlsFromCode(text);
      const display = processed.length > 4000 ? '...' + processed.slice(-3997) : processed;
      const suffix = isFinal ? '' : ' ●';
      let editSucceeded = false;
      try {
        await this.bot.api.editMessageText(
          this.chatId,
          workingMsg.message_id,
          display + suffix,
          { parse_mode: 'Markdown' }
        );
        editSucceeded = true;
      } catch (err) {
        console.warn(`[ClaudeSession] editMessage Markdown failed (task ${taskId}, isFinal=${isFinal}):`, err instanceof Error ? err.message : err);
        // Retry as plain text if Markdown parsing fails (e.g. unmatched symbols)
        try {
          await this.bot.api.editMessageText(
            this.chatId,
            workingMsg.message_id,
            display + suffix,
            {}
          );
          editSucceeded = true;
        } catch (err2) {
          console.warn(`[ClaudeSession] editMessage plain text failed (task ${taskId}, isFinal=${isFinal}):`, err2 instanceof Error ? err2.message : err2);
        }
      }
      // For final messages: if edit failed (e.g. rate-limited), send as a new message
      // so the result is always delivered to the user.
      if (isFinal && !editSucceeded) {
        console.warn(`[ClaudeSession] Both edits failed for task ${taskId}, falling back to sendMessage`);
        try {
          await this.bot.api.sendMessage(this.chatId, display + suffix, {
            message_thread_id: this.topicId,
          });
          console.log(`[ClaudeSession] sendMessage fallback succeeded for task ${taskId}`);
        } catch (err3) {
          console.error(`[ClaudeSession] sendMessage fallback also failed for task ${taskId}:`, err3 instanceof Error ? err3.message : err3);
        }
      }
    };

    let editTimer: ReturnType<typeof setTimeout> | null = null;
    let taskDone = false;

    // Heartbeat: for long-running tasks, send a periodic update every 30s so the
    // user knows the task is still alive and to keep the Telegram session warm.
    const taskStartTime = Date.now();
    const heartbeatTimer = setInterval(async () => {
      if (taskDone) return;
      const elapsedSec = Math.round((Date.now() - taskStartTime) / 1000);
      const preview = accumulatedText.length > 200
        ? '...' + accumulatedText.slice(-200)
        : accumulatedText;
      const heartbeatText = preview
        ? `${preview} ●\n\n⏳ Still working... (${elapsedSec}s)`
        : `⏳ Still working... (${elapsedSec}s)`;
      try {
        await this.bot.api.editMessageText(
          this.chatId,
          workingMsg.message_id,
          heartbeatText,
        );
        lastEdit = Date.now();
      } catch {
        // Ignore heartbeat edit errors
      }
    }, 30_000);

    const controller = new AbortController();
    this.currentTaskController = controller;

    try {
      const result = await runCliTask({
        prompt,
        cwd: this.projectPath,
        sessionId: session?.claudeSessionId ?? undefined,
        model: this.model,
        signal: controller.signal,
        onInit: (sessionId) => {
          // Update or create session record
          if (session) {
            updateSession(this.db, session.id, {
              claudeSessionId: sessionId,
              lastUsedAt: new Date(),
            });
          } else {
            insertSession(this.db, {
              projectId: this.projectId,
              claudeSessionId: sessionId,
              mode: 'cli',
            });
          }
        },
        onTextChunk: (_chunk, accumulated) => {
          accumulatedText = accumulated;
          this.liveOutput = accumulated;
          agentEvents.emit('agent', { type: 'task:output', agentId: this.projectId, agentName: this.projectName, text: accumulated });
          if (editTimer) clearTimeout(editTimer);
          editTimer = setTimeout(() => editMessage(accumulatedText), EDIT_DEBOUNCE_MS);
        },
        onToolUse: (_toolName) => {
          // Tool use is tracked in result.toolsUsed
        },
      });

      if (editTimer) clearTimeout(editTimer);
      taskDone = true;
      clearInterval(heartbeatTimer);
      this.currentTaskController = null;

      // Detect rate/usage limit errors before rendering the final message
      const isLimitError = !result.success &&
        result.errorType !== undefined &&
        result.errorType !== 'unknown';

      if (isLimitError) {
        const notificationText = formatLimitError(result.errorType!);
        await editMessage(notificationText, true);

        updateTask(this.db, taskId, {
          status: 'failed',
          result: result.error ?? notificationText,
          costUsd: result.costUsd,
          completedAt: new Date(),
        });

        // Offer Codex fallback only for usage_limit (not rate_limit/overloaded which are transient)
        if (result.errorType === 'usage_limit') {
          const keyboard = new InlineKeyboard()
            .text('🔄 Retry with Codex (OpenAI)', `codex_retry:${this.projectId}:${taskId}`);
          try {
            await this.bot.api.sendMessage(
              this.chatId,
              '💡 Want to retry this task using Codex (OpenAI)?',
              { message_thread_id: this.topicId, reply_markup: keyboard }
            );
          } catch {
            // Non-fatal
          }
        }
        return;
      }

      console.log(`[ClaudeSession] Task ${taskId} completed. success=${result.success} cost=$${result.costUsd} resultLen=${result.result?.length ?? 0} accumulatedLen=${accumulatedText.length}`);

      // Build final message
      const toolSummary = Object.entries(result.toolsUsed)
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');

      const costPart = result.costUsd > 0 ? `💰 $${result.costUsd.toFixed(4)} | ` : '';
      const footer = `\n\n---\n${costPart}🛠 Tools: ${toolSummary || 'none'} | 💾 Session saved`;

      const finalText = unwrapUrlsFromCode(result.result || accumulatedText);

      if (finalText.length + footer.length > 4000) {
        // Split into multiple messages
        await editMessage(finalText.slice(0, 4000), true);
        // Send remaining as new messages
        let remaining = finalText.slice(4000);
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, 4096);
          remaining = remaining.slice(4096);
          await this.bot.api.sendMessage(this.chatId, chunk, {
            message_thread_id: this.topicId,
            parse_mode: 'Markdown',
          });
        }
        await this.bot.api.sendMessage(this.chatId, footer.trim(), {
          message_thread_id: this.topicId,
        });
      } else {
        await editMessage(finalText + footer, true);
      }

      // Update session cost
      const updatedSession = getLatestSession(this.db, this.projectId);
      if (updatedSession) {
        updateSession(this.db, updatedSession.id, {
          totalCostUsd: (updatedSession.totalCostUsd ?? 0) + result.costUsd,
          messageCount: (updatedSession.messageCount ?? 0) + 1,
          lastUsedAt: new Date(),
          claudeSessionId: result.sessionId || updatedSession.claudeSessionId,
        });
      }

      insertTopicMessage(this.db, { projectId: this.projectId, sender: 'claude', text: finalText });

      // Budget alert: check if total spend has crossed the project limit
      const project = getProjectById(this.db, this.projectId);
      if (project?.budgetUsd != null) {
        const updatedSession = getLatestSession(this.db, this.projectId);
        const totalSpent = (updatedSession?.totalCostUsd ?? 0) + result.costUsd;
        const limit = project.budgetUsd;
        const pct = (totalSpent / limit) * 100;

        if (totalSpent >= limit) {
          await this.bot.api.sendMessage(
            this.chatId,
            `🚨 *Budget exceeded* for ${this.projectName}\n\nSpent: $${totalSpent.toFixed(4)} / $${limit.toFixed(2)} (${pct.toFixed(0)}%)\n\nUse /budget to review or /pause to stop tasks.`,
            { message_thread_id: this.topicId, parse_mode: 'Markdown' }
          );
        } else if (pct >= 80) {
          await this.bot.api.sendMessage(
            this.chatId,
            `⚠️ *Budget warning* for ${this.projectName}\n\nSpent: $${totalSpent.toFixed(4)} / $${limit.toFixed(2)} (${pct.toFixed(0)}%)`,
            { message_thread_id: this.topicId, parse_mode: 'Markdown' }
          );
        }
      }

      // Auto-checkpoint: when the Claude CLI session grows past the thresholds,
      // summarize it into CLAUDE.md and reset. Without this, `--resume` keeps
      // re-billing the whole conversation as input tokens forever.
      // Runs in the background so it doesn't delay the reply the user just got.
      const AUTO_CHECKPOINT_MESSAGES = 30;
      const AUTO_CHECKPOINT_COST = 0.50;
      const latest = getLatestSession(this.db, this.projectId);
      if (result.success && latest && (
        (latest.messageCount ?? 0) >= AUTO_CHECKPOINT_MESSAGES ||
        (latest.totalCostUsd ?? 0) >= AUTO_CHECKPOINT_COST
      )) {
        console.log(`[ClaudeSession ${this.projectName}] Auto-checkpoint triggered: messages=${latest.messageCount}, cost=$${latest.totalCostUsd?.toFixed(4)}`);
        this.autoCheckpoint(latest.messageCount ?? 0, latest.totalCostUsd ?? 0).catch(err => {
          console.warn(`[ClaudeSession ${this.projectName}] Auto-checkpoint failed:`, err instanceof Error ? err.message : err);
        });
      }

      updateTask(this.db, taskId, {
        status: result.success ? 'completed' : 'failed',
        result: result.result,
        costUsd: result.costUsd,
        completedAt: new Date(),
      });
      this.liveOutput = '';
      agentEvents.emit('agent', result.success
        ? { type: 'task:completed', agentId: this.projectId, agentName: this.projectName, taskId, costUsd: result.costUsd }
        : { type: 'task:failed',    agentId: this.projectId, agentName: this.projectName, taskId }
      );
    } catch (err) {
      if (editTimer) clearTimeout(editTimer);
      taskDone = true;
      clearInterval(heartbeatTimer);
      this.currentTaskController = null;
      const errorMsg = err instanceof Error ? err.message : String(err);
      // SECURITY: log the full error server-side but do not expose internal details to Telegram
      console.error(`[ClaudeSession] Task ${taskId} failed:`, err);
      await editMessage('❌ Task failed. Check server logs for details.', true);
      updateTask(this.db, taskId, {
        status: 'failed',
        result: errorMsg,
        completedAt: new Date(),
      });
      this.liveOutput = '';
      agentEvents.emit('agent', { type: 'task:failed', agentId: this.projectId, agentName: this.projectName, taskId });
    }
  }

  /** Runs a previously-failed task using Codex as fallback. */
  async runWithCodex(taskId: number, prompt: string): Promise<void> {
    if (this.processing) {
      await this.bot.api.sendMessage(
        this.chatId,
        '⚠️ A task is already running. Please wait for it to finish before retrying with Codex.',
        { message_thread_id: this.topicId }
      );
      return;
    }

    this.processing = true;
    const workingMsg = await this.bot.api.sendMessage(
      this.chatId,
      '⏳ Running with Codex...',
      { message_thread_id: this.topicId }
    );

    updateTask(this.db, taskId, { status: 'running', liveMessageId: workingMsg.message_id });
    this.liveOutput = '';

    const taskStartTime = Date.now();
    const heartbeatTimer = setInterval(async () => {
      const elapsedSec = Math.round((Date.now() - taskStartTime) / 1000);
      try {
        await this.bot.api.editMessageText(
          this.chatId, workingMsg.message_id,
          `⏳ Codex working... (${elapsedSec}s)`
        );
      } catch { /* ignore */ }
    }, 30_000);

    try {
      const result = await runCodexTask({
        prompt,
        cwd: this.projectPath,
        onTextChunk: (_chunk, accumulated) => { this.liveOutput = accumulated; },
      });

      clearInterval(heartbeatTimer);

      const finalText = result.result || '(no output)';
      const footer = '\n\n---\n🤖 Powered by Codex (OpenAI)';
      const display = finalText.length > 4000 ? '...' + finalText.slice(-3997) : finalText;

      try {
        await this.bot.api.editMessageText(
          this.chatId, workingMsg.message_id,
          display + footer,
          { parse_mode: 'Markdown' }
        );
      } catch {
        await this.bot.api.editMessageText(
          this.chatId, workingMsg.message_id,
          display + footer
        );
      }

      // Save Codex response to shared conversation history (full text, no truncation)
      if (result.result?.trim()) {
        insertTopicMessage(this.db, { projectId: this.projectId, sender: 'codex', text: result.result.trim() });
      }

      updateTask(this.db, taskId, {
        status: result.success ? 'completed' : 'failed',
        result: result.result,
        completedAt: new Date(),
      });
    } catch (err) {
      clearInterval(heartbeatTimer);
      console.error('[ClaudeSession] Codex fallback failed:', err);
      await this.bot.api.editMessageText(
        this.chatId, workingMsg.message_id,
        '❌ Codex task failed. Check server logs.'
      );
      updateTask(this.db, taskId, { status: 'failed', completedAt: new Date() });
    } finally {
      this.processing = false;
      this.liveOutput = '';
    }
  }

  async getStatus() {
    const running = getRunningTask(this.db, this.projectId);
    const pending = getPendingTasks(this.db, this.projectId);
    const session = getLatestSession(this.db, this.projectId);
    return { running, pendingCount: pending.length, session };
  }

  /**
   * Runs a checkpoint automatically in the background, notifying the topic
   * before and after. Uses `checkpoint()` under the hood; adds a "why" hint
   * (which threshold fired) and swallows failures so a broken checkpoint
   * never breaks the task loop.
   */
  private async autoCheckpoint(messageCount: number, totalCostUsd: number): Promise<void> {
    const reason = messageCount >= 30
      ? `${messageCount} messages`
      : `$${totalCostUsd.toFixed(4)} spent`;
    try {
      await this.bot.api.sendMessage(
        this.chatId,
        `🔖 Auto-checkpoint triggered (${reason}). Summarising and resetting the Claude session...`,
        { message_thread_id: this.topicId }
      );
    } catch { /* non-fatal */ }

    const { summary, appended } = await this.checkpoint();
    const done = appended
      ? `✅ Auto-checkpoint saved to CLAUDE.md. Fresh Claude session for the next task.`
      : `⚠️ Auto-checkpoint could not build a summary. Session reset anyway.`;
    try {
      await this.bot.api.sendMessage(this.chatId, done, { message_thread_id: this.topicId });
    } catch { /* non-fatal */ }
    void summary;
  }

  /**
   * Generates a session summary, appends it to CLAUDE.md, and resets the session.
   * Runs synchronously (bypasses the task queue) so the result is captured immediately.
   */
  async checkpoint(): Promise<{ summary: string; appended: boolean }> {
    const { readFile, writeFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');

    const session = getLatestSession(this.db, this.projectId);

    const result = await runCliTask({
      prompt: CHECKPOINT_PROMPT,
      cwd: this.projectPath,
      sessionId: session?.claudeSessionId ?? undefined,
      model: this.model,
    });
    const summary = result.result?.trim() ?? '';
    console.log(`[ClaudeSession] Checkpoint result: success=${result.success}, length=${summary.length}`);

    let appended = false;
    if (summary) {
      const claudeMdPath = path.join(this.projectPath, 'CLAUDE.md');
      const existing = existsSync(claudeMdPath) ? await readFile(claudeMdPath, 'utf8') : '';
      const block = formatCheckpointBlock(summary);
      await writeFile(claudeMdPath, composeCheckpointAppend(existing, block), 'utf8');
      appended = true;
    }

    // Reset session: next task will start a fresh Claude Code session
    if (session) {
      updateSession(this.db, session.id, { claudeSessionId: null });
    }

    return { summary, appended };
  }

  // Called once at startup. Cleans up orphaned tasks left over from a previous
  // process (running tasks whose CLI was killed) and resumes the in-memory
  // queue if there are still pending tasks waiting.
  async rehydrate(): Promise<{ orphaned: number; resumed: number }> {
    const orphans = getRunningTasksByProject(this.db, this.projectId);
    for (const task of orphans) {
      const note = '[interrupted by bot restart — re-issue with /task to retry]';
      updateTask(this.db, task.id, {
        status: 'failed',
        result: note,
        completedAt: new Date(),
      });
      const interruptedText = `❌ Task interrupted by bot restart.\n\nPrompt: ${task.prompt.slice(0, 200)}${task.prompt.length > 200 ? '…' : ''}\n\nUse /task to retry.`;
      try {
        if (task.liveMessageId) {
          await this.bot.api.editMessageText(this.chatId, task.liveMessageId, interruptedText);
        } else {
          await this.bot.api.sendMessage(this.chatId, interruptedText, { message_thread_id: this.topicId });
        }
      } catch {
        // Message may have been deleted; non-fatal — DB row is already updated.
      }
    }

    const pending = getPendingTasks(this.db, this.projectId);
    if (pending.length > 0) {
      console.log(`[ClaudeSession ${this.projectName}] Resuming ${pending.length} pending task(s) after restart`);
      this.processQueue();
    }

    return { orphaned: orphans.length, resumed: pending.length };
  }

  async cancelCurrent() {
    // Kill the real Claude process first, then update DB
    if (this.currentTaskController) {
      this.currentTaskController.abort();
      this.currentTaskController = null;
    }
    const running = getRunningTask(this.db, this.projectId);
    if (running) {
      updateTask(this.db, running.id, { status: 'cancelled', completedAt: new Date() });
    }
  }

  isProcessing() {
    return this.processing;
  }
}
