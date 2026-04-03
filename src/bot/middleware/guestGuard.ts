import type { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

// Commands that mutate state — guests are not allowed to run these
const WRITE_COMMANDS = new Set([
  'task', 'cancel', 'watch', 'gitwatch', 'pause', 'unpause', 'archive',
  'github', 'vercel', 'newsession', 'alias', 'issue', 'new', 'import',
  'test', 'guest',
]);

export async function guestGuard(ctx: Context, next: NextFunction): Promise<void> {
  // Owner bypasses all restrictions
  if (ctx.from?.id === config.OWNER_USER_ID) {
    await next();
    return;
  }

  // Allow /requestaccess for everyone (handled before auth blocks)
  if (ctx.message?.text?.startsWith('/requestaccess')) {
    await next();
    return;
  }

  // For guests: block write commands
  if (ctx.message?.text?.startsWith('/')) {
    const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
    if (WRITE_COMMANDS.has(cmd)) {
      await ctx.reply('This command is not available for guests (read-only access).');
      return;
    }
  }

  // Block plain text messages (would trigger wake-word task dispatch)
  if (ctx.message?.text && !ctx.message.text.startsWith('/')) {
    return;
  }

  // Block voice messages
  if (ctx.message?.voice) {
    return;
  }

  await next();
}
