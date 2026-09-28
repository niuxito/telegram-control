// /codex_login flow — kicks off `codex login --device-auth`, posts URL+code
// to Telegram with a cancel button, and edits the message to success/failure
// when the spawned process exits.
//
// State is per-user, in-memory. A bot restart loses pending logins — the
// cancel button becomes a no-op, which is acceptable for a transient UI flow.

import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { startCodexDeviceAuth, type DeviceAuthHandle } from '../../../claude/codexDeviceAuth.js';

interface PendingLogin {
  handle: DeviceAuthHandle;
  chatId: number;
  messageId: number;
}

const pendingLogins = new Map<number, PendingLogin>();

export function getPendingCodexLogin(userId: number): PendingLogin | undefined {
  return pendingLogins.get(userId);
}

export function clearPendingCodexLogin(userId: number): void {
  pendingLogins.delete(userId);
}

export function setupCodexLoginHandler(bot: any): void {
  bot.command('codex_login', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // One login at a time per user — kill any previous attempt first.
    const existing = pendingLogins.get(userId);
    if (existing) {
      existing.handle.cancel();
      pendingLogins.delete(userId);
    }

    const msg = await ctx.reply('🔑 Starting Codex device authentication...');
    const chatId = ctx.chat!.id;
    const msgId = msg.message_id;

    const handle = startCodexDeviceAuth({
      onInit: async ({ url, code, expiresInMinutes }) => {
        pendingLogins.set(userId, { handle, chatId, messageId: msgId });
        const expiresText = expiresInMinutes ? `${expiresInMinutes} min` : '~15 min';
        const keyboard = new InlineKeyboard()
          .text('✋ Cancel login', `codex_login_cancel:${userId}`);
        const text =
          `🔑 *Codex re-login*\n\n` +
          `1\\. Open this link on any device:\n` +
          `   ${url}\n\n` +
          `2\\. Enter this one\\-time code:\n` +
          `   \`${code}\`\n\n` +
          `_Expires in ${expiresText}\\. I'll let you know when you're in\\._`;
        try {
          await ctx.api.editMessageText(chatId, msgId, text, {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard,
          });
        } catch {
          // Fall back to plain text if MarkdownV2 escaping ever slips
          const plain =
            `🔑 Codex re-login\n\n` +
            `1. Open this link on any device:\n   ${url}\n\n` +
            `2. Enter this one-time code:\n   ${code}\n\n` +
            `Expires in ${expiresText}.`;
          await ctx.api.editMessageText(chatId, msgId, plain, { reply_markup: keyboard });
        }
      },
      onComplete: async () => {
        pendingLogins.delete(userId);
        try {
          await ctx.api.editMessageText(chatId, msgId,
            '✅ Codex logged in.\n\n/codex and the OpenCode fallback are working again. ' +
            'Retry whatever was blocked.');
        } catch { /* user may have deleted the message */ }
      },
      onCancelled: async () => {
        pendingLogins.delete(userId);
        try {
          await ctx.api.editMessageText(chatId, msgId, '✋ Codex login cancelled.');
        } catch { /* non-fatal */ }
      },
      onError: async (err) => {
        pendingLogins.delete(userId);
        try {
          await ctx.api.editMessageText(chatId, msgId, `❌ Codex login error: ${err}`);
        } catch { /* non-fatal */ }
      },
    });
  });
}
