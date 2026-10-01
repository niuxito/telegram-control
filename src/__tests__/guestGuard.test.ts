import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: { OWNER_USER_ID: 42 } }));

import { guestGuard } from '../bot/middleware/guestGuard.js';

function makeCtx(update: { from: number; text?: string; data?: string; voice?: boolean; document?: boolean }) {
  return {
    from: { id: update.from },
    message: update.data !== undefined ? undefined : {
      text: update.text,
      voice: update.voice ? {} : undefined,
      document: update.document ? {} : undefined,
    },
    callbackQuery: update.data !== undefined ? { data: update.data } : undefined,
    reply: vi.fn(),
    answerCallbackQuery: vi.fn(),
  } as any;
}

async function passes(update: Parameters<typeof makeCtx>[0]) {
  const next = vi.fn();
  await guestGuard(makeCtx(update), next);
  return next.mock.calls.length === 1;
}

describe('guestGuard', () => {
  it('lets the owner do anything', async () => {
    expect(await passes({ from: 42, text: '/codex do it' })).toBe(true);
    expect(await passes({ from: 42, text: 'hello' })).toBe(true);
    expect(await passes({ from: 42, data: 'project:archive:1' })).toBe(true);
  });

  it('allows read-only commands for guests', async () => {
    for (const cmd of ['/status', '/tasklog', '/help@MyBot', '/requestaccess']) {
      expect(await passes({ from: 7, text: cmd })).toBe(true);
    }
  });

  it('blocks commands that run agents, read files or change state', async () => {
    for (const cmd of [
      '/codex x', '/plan x', '/review', '/opencode x', '/schedule add * * * * * x',
      '/file .env', '/files', '/secret', '/clone https://x', '/task x', '/checkpoint',
      '/context', '/note x', '/budget 5', '/model opus', '/setdefault', '/unknowncmd',
    ]) {
      expect(await passes({ from: 7, text: cmd }), cmd).toBe(false);
    }
  });

  it('ignores guest plain text, voice and files', async () => {
    expect(await passes({ from: 7, text: 'hey bot, deploy' })).toBe(false);
    expect(await passes({ from: 7, voice: true })).toBe(false);
    expect(await passes({ from: 7, document: true })).toBe(false);
  });

  it('only lets guests press read-only buttons', async () => {
    expect(await passes({ from: 7, data: 'project:status:3' })).toBe(true);
    for (const data of ['project:archive:3', 'project:pause:3', 'confirm_vercel_deploy:3', 'codex_retry:1:2']) {
      expect(await passes({ from: 7, data }), data).toBe(false);
    }
  });
});
