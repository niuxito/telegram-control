import { describe, it, expect } from 'vitest';
import { setEnvValues } from '../setup/envFile.js';
import { evaluateSetupMessage, type SetupMessage } from '../setup/pairing.js';

describe('setEnvValues', () => {
  it('fills placeholders and keeps comments and order', () => {
    const before = 'BOT_TOKEN=123:abc\nSUPERGROUP_ID=               # negative ID\n# comment\nOWNER_USER_ID=\n';
    expect(setEnvValues(before, { SUPERGROUP_ID: '-1009', OWNER_USER_ID: '42' }))
      .toBe('BOT_TOKEN=123:abc\nSUPERGROUP_ID=-1009\n# comment\nOWNER_USER_ID=42\n');
  });

  it('appends missing keys before the trailing newline', () => {
    expect(setEnvValues('BOT_TOKEN=x\n', { NEW_PROJECTS_TOPIC_ID: '5' })).toBe('BOT_TOKEN=x\nNEW_PROJECTS_TOPIC_ID=5\n');
    expect(setEnvValues('', { A: '1' })).toBe('A=1\n');
  });

  it('does not touch keys that only share a prefix', () => {
    expect(setEnvValues('API_KEY=k\nAPI_KEY_EXTRA=e', { API_KEY: 'n' })).toBe('API_KEY=n\nAPI_KEY_EXTRA=e');
  });
});

const base: SetupMessage = {
  code: '123456', expectedCode: '123456', chatType: 'supergroup', isForum: true,
  chatId: -1009, threadId: 5, userId: 42,
  botRights: { isAdmin: true, canManageTopics: true, canDeleteMessages: true },
};

describe('evaluateSetupMessage', () => {
  it('pairs with a valid message', () => {
    const result = evaluateSetupMessage(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).toEqual({ SUPERGROUP_ID: '-1009', NEW_PROJECTS_TOPIC_ID: '5', OWNER_USER_ID: '42' });
  });

  it('ignores a wrong code silently', () => {
    expect(evaluateSetupMessage({ ...base, code: '000000' })).toEqual({ ok: false, reply: null });
    expect(evaluateSetupMessage({ ...base, code: '' })).toEqual({ ok: false, reply: null });
  });

  it('explains what is wrong with the chat', () => {
    expect(evaluateSetupMessage({ ...base, chatType: 'private' }).reply).toMatch(/supergroup/);
    expect(evaluateSetupMessage({ ...base, isForum: false }).reply).toMatch(/Topics/);
    expect(evaluateSetupMessage({ ...base, threadId: undefined }).reply).toMatch(/General/);
  });

  it('lists missing bot rights', () => {
    expect(evaluateSetupMessage({ ...base, botRights: { isAdmin: false, canManageTopics: false, canDeleteMessages: false } }).reply).toMatch(/admin/);
    const reply = evaluateSetupMessage({ ...base, botRights: { isAdmin: true, canManageTopics: false, canDeleteMessages: false } }).reply;
    expect(reply).toMatch(/Manage topics/);
    expect(reply).toMatch(/Delete messages/);
  });
});
