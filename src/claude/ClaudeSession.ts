import type { Db } from '../db/client.js';
import { getLatestSession, insertSession, updateSession } from '../db/queries/sessions.js';
import { insertTask, updateTask, getRunningTask, getPendingTasks } from '../db/queries/taskQueue.js';
import { runCliTask } from './CliStrategy.js';
import { formatLimitError } from '../notifications/formatters.js';
import { agentEvents } from '../api/events.js';
import type { Bot } from 'grammy';

/** Remove backtick wrapping around URLs so Telegram renders them as clickable links. */
function unwrapUrlsFromCode(text: string): string {
  return text.replace(/`(https?:\/\/[^\s`]+)`/g, '$1');
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

  constructor(db: Db, bot: Bot, projectId: number, projectPath: string, topicId: number, chatId: number, projectName = '') {
    this.db = db;
    this.bot = bot;
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.topicId = topicId;
    this.chatId = chatId;
    this.projectName = projectName;
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
    this.processQueue();
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
        await this.runTask(task.id, task.prompt);
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

    // Send initial "working" message
    const workingMsg = await this.bot.api.sendMessage(
      this.chatId,
      '⏳ Working...',
      { message_thread_id: this.topicId }
    );

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
      } catch {
        // Retry as plain text if Markdown parsing fails (e.g. unmatched symbols)
        try {
          await this.bot.api.editMessageText(
            this.chatId,
            workingMsg.message_id,
            display + suffix,
            {}
          );
          editSucceeded = true;
        } catch {
          // Ignore edit errors (message not modified, etc.)
        }
      }
      // For final messages: if edit failed (e.g. rate-limited), send as a new message
      // so the result is always delivered to the user.
      if (isFinal && !editSucceeded) {
        try {
          await this.bot.api.sendMessage(this.chatId, display + suffix, {
            message_thread_id: this.topicId,
          });
        } catch {
          // Best-effort
        }
      }
    };

    let editTimer: ReturnType<typeof setTimeout> | null = null;

    // Heartbeat: for long-running tasks, send a periodic update every 30s so the
    // user knows the task is still alive and to keep the Telegram session warm.
    const taskStartTime = Date.now();
    const heartbeatTimer = setInterval(async () => {
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

    try {
      const result = await runCliTask({
        prompt,
        cwd: this.projectPath,
        sessionId: session?.claudeSessionId ?? undefined,
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
      clearInterval(heartbeatTimer);

      // Detect rate/usage limit errors before rendering the final message
      const isLimitError = !result.success &&
        result.errorType !== undefined &&
        result.errorType !== 'unknown';

      if (isLimitError) {
        const notificationText = formatLimitError(result.errorType!);
        await editMessage(notificationText, true);
        // Also send as a separate pinned-style message so it stands out in the topic
        try {
          await this.bot.api.sendMessage(this.chatId, notificationText, {
            message_thread_id: this.topicId,
          });
        } catch {
          // Non-fatal — the edit above already surfaced the error
        }
        updateTask(this.db, taskId, {
          status: 'failed',
          result: result.error ?? notificationText,
          costUsd: result.costUsd,
          completedAt: new Date(),
        });
        return;
      }

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
      clearInterval(heartbeatTimer);
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

  async getStatus() {
    const running = getRunningTask(this.db, this.projectId);
    const pending = getPendingTasks(this.db, this.projectId);
    const session = getLatestSession(this.db, this.projectId);
    return { running, pendingCount: pending.length, session };
  }

  async cancelCurrent() {
    // Mark running tasks as cancelled
    const running = getRunningTask(this.db, this.projectId);
    if (running) {
      updateTask(this.db, running.id, { status: 'cancelled', completedAt: new Date() });
    }
  }

  isProcessing() {
    return this.processing;
  }
}
