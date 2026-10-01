import { describe, it, expect, vi } from 'vitest';

describe('config', () => {
  it('keeps secrets in config but removes them from process.env', async () => {
    vi.resetModules();
    Object.assign(process.env, {
      BOT_TOKEN: '123:abc', SUPERGROUP_ID: '-100', NEW_PROJECTS_TOPIC_ID: '2', OWNER_USER_ID: '42',
      API_KEY: 'k', OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a',
    });
    const { config } = await import('../config.js');

    expect(config.BOT_TOKEN).toBe('123:abc');
    expect(config.API_KEY).toBe('k');
    for (const name of ['BOT_TOKEN', 'API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(process.env[name], name).toBeUndefined();
    }
    expect(process.env.OWNER_USER_ID).toBe('42');
  });
});
