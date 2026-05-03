import type { Context, NextFunction } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import type { Db } from '../../../db/client.js';
import { getPendingTasks } from '../../../db/queries/taskQueue.js';
import { insertTopicMessage, getRecentTopicMessages, buildConversationContext, resolveContextLimit } from '../../../db/queries/topicMessages.js';
import { extractTask, DEFAULT_WAKE_WORD } from '../voice.js';
import { resolveAgentPrompt } from '../agentIntent.js';

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
  });
}
