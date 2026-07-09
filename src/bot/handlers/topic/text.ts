import type { Context, NextFunction } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import type { Db } from '../../../db/client.js';
import { getPendingTasks } from '../../../db/queries/taskQueue.js';
import { insertTopicMessage, getRecentTopicMessages, buildConversationContext, resolveContextLimit } from '../../../db/queries/topicMessages.js';
import { extractTask, DEFAULT_WAKE_WORD } from '../voice.js';
import { resolveAgentPrompt } from '../agentIntent.js';
import { runWithRouter, getAgent } from '../../../agents/index.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;

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
    console.warn('[topic/text] editMessageText failed, sending a replacement message:', err instanceof Error ? err.message : err);
    try {
      await ctx.api.sendMessage(chatId, firstChunk, {
        message_thread_id: topicId,
        ...options,
      });
    } catch (sendErr) {
      console.warn('[topic/text] sendMessage fallback failed:', sendErr instanceof Error ? sendErr.message : sendErr);
    }
  }

  for (const chunk of chunks.slice(1)) {
    try {
      await ctx.api.sendMessage(chatId, chunk, { message_thread_id: topicId });
    } catch (err) {
      console.warn('[topic/text] chunk send failed:', err instanceof Error ? err.message : err);
    }
  }
}

// Catch-all for free-text messages in a project topic. Must be registered AFTER
// every bot.command(...) so commands can match first; if not, this handler
// would swallow command messages and break them silently.
export function setupTopicTextFallback(bot: any, projectManager: ProjectManager, db: Db): void {
  bot.on('message:text', async (ctx: Context, next: NextFunction) => {
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) { await next(); return; }

    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) { await next(); return; }

    const isReplyToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
    const wakeWord = project.wakeWord ?? DEFAULT_WAKE_WORD;
    const taskFromWakeWord = extractTask(text, wakeWord);

    const prompt = isReplyToBot ? text : taskFromWakeWord;
    if (!prompt) { await next(); return; }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    const { limit, promptClean } = resolveContextLimit(prompt);
    const senderName = ctx.from?.username ?? ctx.from?.first_name ?? 'User';
    const defaultAgent = (project.defaultAgent ?? 'claude') as 'claude' | 'codex' | 'opencode';

    // --- Claude (default / legacy path) ---
    if (defaultAgent === 'claude') {
      insertTopicMessage(db, { projectId: project.id, sender: 'user', senderName, text: promptClean });

      const history = getRecentTopicMessages(db, project.id, limit);
      const context = buildConversationContext(history.slice(0, -1));
      const finalPrompt = context
        ? `${context}Current request: ${resolveAgentPrompt(promptClean)}`
        : resolveAgentPrompt(promptClean);

      await session.queueTask(finalPrompt);
      const pending = getPendingTasks(db, project.id);
      if (pending.length > 1) {
        await ctx.reply(`✅ Task queued (position ${pending.length}). Current task will finish first.`);
      }
      return;
    }

    // --- Codex / OpenCode path ---
    const agentMeta = getAgent(defaultAgent);
    const msg = await ctx.reply(`${agentMeta.icon} ${agentMeta.label} is working on it...`);
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    insertTopicMessage(db, { projectId: project.id, sender: 'user', senderName, text: promptClean });
    const history = getRecentTopicMessages(db, project.id, limit);
    const context = buildConversationContext(history.slice(0, -1));
    const contextualPrompt = context
      ? `${context}Current request: ${resolveAgentPrompt(promptClean)}`
      : resolveAgentPrompt(promptClean);

    let dots = 0;
    const heartbeat = setInterval(async () => {
      dots = (dots + 1) % 4;
      try {
        await ctx.api.editMessageText(chatId, msgId, `${agentMeta.icon} ${agentMeta.label} is working${'.'.repeat(dots + 1)}`);
      } catch { /* ignore edit races */ }
    }, 5000);

    let routedResult: Awaited<ReturnType<typeof runWithRouter>> | undefined;
    let routedErr: any;
    try {
      routedResult = await runWithRouter({
        prompt: contextualPrompt,
        cwd: project.localPath,
        preferredAgent: defaultAgent,
        sensitivity: 'project-internal',
      });
    } catch (err: any) {
      routedErr = err;
    } finally {
      clearInterval(heartbeat);
    }

    if (routedErr) {
      await publishTopicMessage(ctx, chatId, project.topicId!, msgId, `❌ ${agentMeta.label} error: ${routedErr.message}`);
      return;
    }

    const { result, agentUsed, fellBack } = routedResult!;
    const body = result.result?.trim() || result.error || '(no output)';
    const header = result.success ? '' : `⚠️ ${agentMeta.label} finished with errors\n\n`;
    const cost = result.costUsd ? `💰 $${result.costUsd.toFixed(4)} | ` : '';
    const usedMeta = getAgent(agentUsed);
    const degradedNote = fellBack ? ` (auto-degraded from ${agentMeta.label} after quota)` : '';
    const footer = `\n\n---\n${cost}${usedMeta.icon} Powered by ${usedMeta.label}${degradedNote}`;
    const full = header + body + footer;

    if (result.result?.trim()) {
      insertTopicMessage(db, { projectId: project.id, sender: agentUsed, text: result.result.trim() });
    }

    await publishTopicMessage(ctx, chatId, project.topicId!, msgId, full);
  });
}
