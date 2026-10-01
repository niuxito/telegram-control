import { Bot } from 'grammy';
import { randomInt } from 'crypto';
import { readEnvFile, writeEnvValues } from './envFile.js';

export const PAIRING_KEYS = ['SUPERGROUP_ID', 'NEW_PROJECTS_TOPIC_ID', 'OWNER_USER_ID'] as const;

/** Values from process.env win over .env, like dotenv does. */
function currentValue(env: Record<string, string>, key: string): string {
  return (process.env[key] || env[key] || '').trim();
}

/** Pairing is needed when there is a bot token but some Telegram ID is missing. */
export function needsPairing(envPath: string): boolean {
  const env = readEnvFile(envPath);
  return Boolean(currentValue(env, 'BOT_TOKEN')) && PAIRING_KEYS.some(key => !currentValue(env, key));
}

export interface SetupMessage {
  code: string;
  expectedCode: string;
  chatType: string;
  isForum: boolean;
  chatId: number;
  threadId?: number;
  userId?: number;
  botRights?: { isAdmin: boolean; canManageTopics: boolean; canDeleteMessages: boolean };
}

export type SetupResult =
  | { ok: false; reply: string | null }
  | { ok: true; reply: string; values: Record<(typeof PAIRING_KEYS)[number], string> };

/** Pure decision for a `/setup <code>` message, kept separate so it can be tested. */
export function evaluateSetupMessage(msg: SetupMessage): SetupResult {
  // Wrong or missing code: stay silent so the bot does not reveal it is in setup mode
  if (msg.code !== msg.expectedCode) return { ok: false, reply: null };

  if (msg.chatType === 'private') {
    return { ok: false, reply: 'Add me to your supergroup as admin, then send this command inside a topic of that group.' };
  }
  if (msg.chatType !== 'supergroup' || !msg.isForum) {
    return { ok: false, reply: 'This group has no topics. Enable Topics in the group settings and send the command again inside a topic.' };
  }
  if (!msg.threadId) {
    return { ok: false, reply: 'Send the command inside the topic you want to use for new projects (not in General).' };
  }

  const missing: string[] = [];
  if (!msg.botRights?.isAdmin) missing.push('admin');
  else {
    if (!msg.botRights.canManageTopics) missing.push('Manage topics');
    if (!msg.botRights.canDeleteMessages) missing.push('Delete messages');
  }
  if (missing.length) {
    return { ok: false, reply: `I need these rights in this group: ${missing.join(', ')}. Update them and send the command again.` };
  }
  if (!msg.userId) return { ok: false, reply: null };

  return {
    ok: true,
    reply: 'Paired. This topic will be used for new projects and you are the owner. Telegram Control is starting.',
    values: {
      SUPERGROUP_ID: String(msg.chatId),
      NEW_PROJECTS_TOPIC_ID: String(msg.threadId),
      OWNER_USER_ID: String(msg.userId),
    },
  };
}

/**
 * Runs a minimal bot until the owner sends `/setup <code>` in a topic of the
 * supergroup, then writes the IDs to .env and to process.env.
 */
export async function runPairing(envPath: string): Promise<void> {
  const env = readEnvFile(envPath);
  const bot = new Bot(currentValue(env, 'BOT_TOKEN'));
  try {
    await bot.init();
  } catch (err) {
    console.error(`BOT_TOKEN was rejected by Telegram (${(err as Error).message}). Copy it again from @BotFather into .env.`);
    process.exit(1);
  }
  const expectedCode = String(randomInt(100000, 1000000));

  console.log(`
=== Telegram pairing ===

1. Add @${bot.botInfo.username} to your supergroup as admin
   (rights: Manage topics, Delete messages). The group needs Topics enabled.
2. In the topic you want to use for new projects, send:

     /setup ${expectedCode}

Waiting for the message...
`);

  await new Promise<void>((resolve) => {
    bot.command('setup', async (ctx) => {
      const chat = ctx.chat;
      let botRights: SetupMessage['botRights'];
      if (chat.type === 'supergroup') {
        const member = await ctx.api.getChatMember(chat.id, bot.botInfo.id);
        botRights = {
          isAdmin: member.status === 'administrator' || member.status === 'creator',
          canManageTopics: member.status === 'creator' || (member.status === 'administrator' && Boolean(member.can_manage_topics)),
          canDeleteMessages: member.status === 'creator' || (member.status === 'administrator' && member.can_delete_messages),
        };
      }

      const result = evaluateSetupMessage({
        code: String(ctx.match).trim(),
        expectedCode,
        chatType: chat.type,
        isForum: chat.type === 'supergroup' && Boolean(chat.is_forum),
        chatId: chat.id,
        threadId: ctx.message?.message_thread_id,
        userId: ctx.from?.id,
        botRights,
      });

      if (result.reply) await ctx.reply(result.reply);
      if (!result.ok) return;

      writeEnvValues(envPath, result.values);
      Object.assign(process.env, result.values);
      console.log(`[Pairing] Saved ${PAIRING_KEYS.join(', ')} to .env`);
      // Stop after this handler returns, so the main bot does not race this poller
      setImmediate(() => { bot.stop().then(resolve, resolve); });
    });

    bot.start({ drop_pending_updates: true });
  });
}
