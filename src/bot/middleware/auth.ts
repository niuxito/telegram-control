import type { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  // SECURITY: Silently ignore all requests from users other than the owner.
  // Replying would leak the bot's existence to unauthorized users.
  if (userId !== config.OWNER_USER_ID) {
    return;
  }

  // SECURITY: Only process messages/callbacks from the configured supergroup,
  // or from callback queries that originate from inline keyboards posted in that chat.
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (chatId !== undefined && chatId !== config.SUPERGROUP_ID) {
    // Silently ignore messages from other chats
    return;
  }

  await next();
}
