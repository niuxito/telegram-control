import type { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

// Guests get read-only access. Everything is denied unless listed here, so a
// new command or button is owner-only until it is explicitly allowed.
export const GUEST_COMMANDS = new Set([
  'help', 'start', 'status', 'info', 'list', 'queue', 'tasklist', 'tasklog',
  'session', 'summary', 'uptime', 'costs', 'requestaccess',
]);

const GUEST_CALLBACKS = [/^project:status:\d+$/];

export async function guestGuard(ctx: Context, next: NextFunction): Promise<void> {
  // Owner bypasses all restrictions
  if (ctx.from?.id === config.OWNER_USER_ID) {
    await next();
    return;
  }

  const text = ctx.message?.text;
  if (text?.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    if (GUEST_COMMANDS.has(cmd)) {
      await next();
      return;
    }
    await ctx.reply('This command is not available for guests (read-only access).');
    return;
  }

  const data = ctx.callbackQuery?.data;
  if (data !== undefined) {
    if (GUEST_CALLBACKS.some(re => re.test(data))) {
      await next();
      return;
    }
    await ctx.answerCallbackQuery('Read-only access.');
    return;
  }

  // Plain text (wake-word dispatch), voice, files, photos, etc. are ignored
}
