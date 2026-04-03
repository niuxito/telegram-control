import type { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';
import { getGuest } from '../../db/queries/guests.js';
import type { Db } from '../../db/client.js';

export function createAuthMiddleware(db: Db) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;

    // Owner always has full access
    if (userId === config.OWNER_USER_ID) {
      await next();
      return;
    }

    // SECURITY: Only process messages from the configured supergroup
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
    if (chatId !== undefined && chatId !== config.SUPERGROUP_ID) {
      return;
    }

    // Registered guests get read-only access
    if (userId !== undefined && getGuest(db, userId)) {
      await next();
      return;
    }

    // Allow /requestaccess so unknown users can request access
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/requestaccess')) {
      await next();
      return;
    }

    // SECURITY: Silently ignore all other users
  };
}
