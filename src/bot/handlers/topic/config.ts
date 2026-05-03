import type { Context } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import { getLatestSession } from '../../../db/queries/sessions.js';
import { updateProject } from '../../../db/queries/projects.js';
import { insertNote, getRecentNotes, deleteNote, clearNotes } from '../../../db/queries/projectNotes.js';
import { DEFAULT_WAKE_WORD } from '../voice.js';
import path from 'path';
import type { Db } from '../../../db/client.js';

const pendingSecrets = new Map<number, { projectId: number; chatId: number; topicId: number }>();

export function getPendingSecret(userId: number) {
  return pendingSecrets.get(userId);
}
export function setPendingSecret(userId: number, data: { projectId: number; chatId: number; topicId: number }) {
  pendingSecrets.set(userId, data);
}
export function clearPendingSecret(userId: number) {
  pendingSecrets.delete(userId);
}

export function setupConfigHandlers(bot: any, projectManager: ProjectManager, db: Db): void {

  bot.command('session', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const session = getLatestSession(db, project.id);
    if (!session) {
      await ctx.reply('No session found. Start one with /task.');
      return;
    }
    await ctx.reply(
      `🔗 Session Info\n` +
      `ID: ${session.claudeSessionId ?? 'none'}\n` +
      `Messages: ${session.messageCount}\n` +
      `Total cost: $${session.totalCostUsd.toFixed(4)}\n` +
      `Last used: ${session.lastUsedAt}`
    );
  });

  bot.command('newsession', async (ctx: Context) => {
    await ctx.reply('🔄 New session will start on next /task command.');
  });

  // /checkpoint — summarize current session into CLAUDE.md and reset
  bot.command('checkpoint', async (ctx: Context) => {
    const threadId = ctx.message?.message_thread_id ?? -1;
    const project = projectManager.getByTopicId(threadId);
    console.log(`[checkpoint] threadId=${threadId} project=${project?.name ?? 'NOT FOUND'}`);
    if (!project) {
      await ctx.reply(`⚠️ This command must be used inside a project topic. (thread_id: ${threadId})`);
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('No active session to checkpoint.');
      return;
    }

    if (session.isProcessing()) {
      await ctx.reply('⚠️ A task is running. Wait for it to finish before creating a checkpoint.');
      return;
    }

    const msg = await ctx.reply('🔖 Generating session checkpoint...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    let checkpointDone = false;
    try {
      const { summary, appended } = await session.checkpoint();
      checkpointDone = true;

      if (!summary) {
        await ctx.api.editMessageText(chatId, msgId,
          '⚠️ Could not generate summary. Session has been reset anyway.\n\nUse /context to add context manually.');
        return;
      }

      const preview = summary.length > 800 ? summary.slice(0, 800) + '…' : summary;
      const successText =
        `🔖 Checkpoint saved${appended ? ' to CLAUDE.md' : ''}. Session reset.\n\n` +
        `📄 Summary:\n${preview}`;
      try {
        await ctx.api.editMessageText(chatId, msgId, successText, { parse_mode: 'Markdown' });
      } catch (mdErr) {
        console.warn('[checkpoint] Markdown edit failed, retrying as plain text:', mdErr instanceof Error ? mdErr.message : mdErr);
        await ctx.api.editMessageText(chatId, msgId, successText);
      }
    } catch (err: any) {
      const prefix = checkpointDone
        ? '⚠️ Checkpoint saved but failed to display summary'
        : '❌ Checkpoint failed';
      await ctx.api.editMessageText(chatId, msgId, `${prefix}: ${err.message}`);
    }
  });

  bot.command('watch', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /watch on|off');
      return;
    }
    projectManager.setWatchFiles(project.id, arg === 'on');
    await ctx.reply(`File watching ${arg === 'on' ? 'enabled ✅' : 'disabled ❌'}`);
  });

  bot.command('gitwatch', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /gitwatch on|off');
      return;
    }
    projectManager.setWatchGit(project.id, arg === 'on');
    await ctx.reply(`Git watching ${arg === 'on' ? 'enabled ✅' : 'disabled ❌'}`);
  });

  bot.command('pause', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await projectManager.pauseProject(project.id);
    await ctx.reply('⏸ Project paused. Use /unpause to resume.');
  });

  bot.command('unpause', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await projectManager.unpauseProject(project.id);
    await ctx.reply('▶️ Project resumed.');
  });

  bot.command('archive', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await projectManager.archiveProject(project.id);
    await ctx.reply('🗄 Project archived.');
  });

  bot.command('info', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;
    await ctx.reply(
      `ℹ️ ${project.name}\n` +
      `Path: ${project.localPath}\n` +
      `Status: ${project.status}\n` +
      `Topic ID: ${project.topicId}\n` +
      `Created: ${project.createdAt}\n` +
      `File watch: ${project.watchFiles ? '✅' : '❌'}\n` +
      `Git watch: ${project.watchGit ? '✅' : '❌'}`
    );
  });

  bot.command('model', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const AVAILABLE_MODELS = [
      { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6    — most capable' },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6  — balanced (CLI default)' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5   — fastest, cheapest' },
    ];

    const arg = (ctx.match as string).trim();

    if (!arg) {
      const session = projectManager.getSession(project.id);
      const current = session?.getModel() ?? project.model ?? null;
      const currentLabel = current
        ? (AVAILABLE_MODELS.find(m => m.id === current)?.label ?? current)
        : 'CLI default (Sonnet 4.6)';
      const list = AVAILABLE_MODELS
        .map(m => `  ${m.id === current ? '✅' : '◻️'} ${m.label}`)
        .join('\n');
      await ctx.reply(
        `🤖 Model for ${project.name}:\nCurrent: ${currentLabel}\n\nAvailable:\n${list}\n\n` +
        `Use /model <name> to change, /model reset to use CLI default.`
      );
      return;
    }

    if (arg === 'reset') {
      await updateProject(db, project.id, { model: null });
      projectManager.getSession(project.id)?.setModel(null);
      await ctx.reply('✅ Model reset to CLI default (Sonnet 4.6).');
      return;
    }

    const match = AVAILABLE_MODELS.find(m => m.id === arg || m.id.startsWith(arg));
    if (!match) {
      await ctx.reply(
        `❌ Unknown model: ${arg}\n\nAvailable:\n` +
        AVAILABLE_MODELS.map(m => `  ${m.id}`).join('\n')
      );
      return;
    }

    await updateProject(db, project.id, { model: match.id });
    projectManager.getSession(project.id)?.setModel(match.id);
    await ctx.reply(`✅ Model set to ${match.id} for ${project.name}.`);
  });

  bot.command('context', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const { readFile, writeFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const claudeMdPath = path.join(project.localPath, 'CLAUDE.md');

    const arg = (ctx.match as string).trim();

    if (!arg) {
      if (!existsSync(claudeMdPath)) {
        await ctx.reply(`No CLAUDE.md found in ${project.name}.\n\nCreate one with:\n/context <content>`);
        return;
      }
      const content = await readFile(claudeMdPath, 'utf8');
      if (!content.trim()) {
        await ctx.reply('CLAUDE.md is empty.');
        return;
      }
      const display = content.length > 3800 ? content.slice(0, 3800) + '\n\n… (truncated)' : content;
      await ctx.reply(`📄 CLAUDE.md for *${project.name}*:\n\`\`\`\n${display}\n\`\`\``, { parse_mode: 'Markdown' });
      return;
    }

    if (arg.startsWith('append ')) {
      const addition = arg.slice('append '.length).trim();
      if (!addition) {
        await ctx.reply('Usage: /context append <text>');
        return;
      }
      const existing = existsSync(claudeMdPath) ? await readFile(claudeMdPath, 'utf8') : '';
      const separator = existing && !existing.endsWith('\n') ? '\n' : '';
      await writeFile(claudeMdPath, existing + separator + addition + '\n', 'utf8');
      await ctx.reply(`✅ Appended to CLAUDE.md in *${project.name}*.`, { parse_mode: 'Markdown' });
      return;
    }

    await writeFile(claudeMdPath, arg + '\n', 'utf8');
    await ctx.reply(`✅ CLAUDE.md updated in *${project.name}*.`, { parse_mode: 'Markdown' });
  });

  bot.command('alias', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim().toLowerCase();
    if (!arg) {
      const current = project.wakeWord ?? DEFAULT_WAKE_WORD;
      await ctx.reply(`Current wake word: "${current}"${project.wakeWord ? '' : ' (default)'}`);
      return;
    }
    if (arg.includes(' ') || arg.length > 32) {
      await ctx.reply('Wake word must be a single word (max 32 chars).');
      return;
    }
    updateProject(db, project.id, { wakeWord: arg });
    await ctx.reply(`✅ Wake word set to "${arg}" for this project.`);
  });

  // /budget           — show current spend and limit
  // /budget <amount>  — set budget limit in USD
  // /budget off       — remove limit
  bot.command('budget', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim();

    if (!arg) {
      // Show current spend
      const { getLatestSession } = await import('../../../db/queries/sessions.js');
      const session = getLatestSession(db, project.id);
      const spent = session?.totalCostUsd ?? 0;
      const limit = project.budgetUsd ?? null;
      const bar = limit
        ? (() => {
            const pct = Math.min((spent / limit) * 100, 100);
            const filled = Math.round(pct / 10);
            return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${pct.toFixed(0)}%`;
          })()
        : null;

      await ctx.reply(
        `💰 Budget — ${project.name}\n\n` +
        `Spent:  $${spent.toFixed(4)}\n` +
        `Limit:  ${limit ? `$${limit.toFixed(2)}` : 'none'}\n` +
        (bar ? `\n${bar}\n` : '') +
        `\nUse /budget <amount> to set a limit, /budget off to remove it.`
      );
      return;
    }

    if (arg === 'off') {
      await updateProject(db, project.id, { budgetUsd: null });
      await ctx.reply('✅ Budget limit removed.');
      return;
    }

    const amount = parseFloat(arg);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount. Usage: /budget 5.00');
      return;
    }

    await updateProject(db, project.id, { budgetUsd: amount });
    await ctx.reply(`✅ Budget limit set to $${amount.toFixed(2)} for ${project.name}.`);
  });

  // /note <text>        — save a note
  // /note list          — show last 10 notes
  // /note delete <id>   — delete a note
  // /note clear         — clear all notes
  bot.command('note', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const arg = (ctx.match as string).trim();

    if (!arg || arg === 'list') {
      const notes = getRecentNotes(db, project.id, 10);
      if (notes.length === 0) {
        await ctx.reply('No notes yet. Add one with /note <text>');
        return;
      }
      const lines = notes.map(n => {
        const date = new Date(n.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
        return `[${n.id}] ${date}: ${n.text}`;
      }).join('\n');
      await ctx.reply(`📝 Notes for *${project.name}*:\n\`\`\`\n${lines}\n\`\`\``, { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'clear') {
      const count = clearNotes(db, project.id);
      await ctx.reply(`🗑 Cleared ${count} note(s).`);
      return;
    }

    if (arg.startsWith('delete ')) {
      const id = parseInt(arg.slice('delete '.length).trim());
      if (isNaN(id)) {
        await ctx.reply('Usage: /note delete <id>');
        return;
      }
      const deleted = deleteNote(db, id, project.id);
      await ctx.reply(deleted ? `✅ Note ${id} deleted.` : `❌ Note ${id} not found.`);
      return;
    }

    insertNote(db, project.id, arg);
    await ctx.reply('📝 Note saved.');
  });

  bot.command('secret', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const userId = ctx.from!.id;
    setPendingSecret(userId, { projectId: project.id, chatId: ctx.chat!.id, topicId: project.topicId! });

    await ctx.reply(
      `🔒 Secret mode activated for *${project.name}*.\n\n` +
      `Send me the sensitive information via private DM. ` +
      `The message will be passed to the project and deleted immediately.\n\n` +
      `_This request expires in 5 minutes._`,
      { parse_mode: 'Markdown' }
    );

    setTimeout(() => clearPendingSecret(userId), 5 * 60 * 1000);
  });
}
