import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPendingQuotaRetry,
  getPendingQuotaRetry,
  clearPendingQuotaRetry,
  buildQuotaRetryPrompt,
  type PendingQuotaRetry,
} from '../bot/handlers/topic/quotaRetry.js';

const USER_A = 1001;
const USER_B = 1002;

function fixture(): PendingQuotaRetry {
  return {
    prompt: 'do the thing',
    cwd: '/tmp/proj',
    originalAgent: 'codex',
    projectId: 7,
    chatId: -100123,
    topicId: 42,
    messageId: 555,
  };
}

describe('quotaRetry — pending state map', () => {
  beforeEach(() => {
    clearPendingQuotaRetry(USER_A);
    clearPendingQuotaRetry(USER_B);
  });

  it('returns undefined when nothing has been stored', () => {
    expect(getPendingQuotaRetry(USER_A)).toBeUndefined();
  });

  it('round-trips a pending retry through set/get', () => {
    const data = fixture();
    setPendingQuotaRetry(USER_A, data);
    expect(getPendingQuotaRetry(USER_A)).toEqual(data);
  });

  it('clearPendingQuotaRetry removes the entry', () => {
    setPendingQuotaRetry(USER_A, fixture());
    clearPendingQuotaRetry(USER_A);
    expect(getPendingQuotaRetry(USER_A)).toBeUndefined();
  });

  it('clear on a non-existent entry is a no-op', () => {
    expect(() => clearPendingQuotaRetry(USER_A)).not.toThrow();
  });

  it('users are isolated — setting A does not affect B', () => {
    setPendingQuotaRetry(USER_A, fixture());
    expect(getPendingQuotaRetry(USER_B)).toBeUndefined();
  });

  it('setting again overwrites the previous entry', () => {
    setPendingQuotaRetry(USER_A, fixture());
    const replacement = { ...fixture(), prompt: 'different prompt' };
    setPendingQuotaRetry(USER_A, replacement);
    expect(getPendingQuotaRetry(USER_A)?.prompt).toBe('different prompt');
  });
});

describe('quotaRetry — buildQuotaRetryPrompt', () => {
  it('mentions the agent that ran out of quota', () => {
    const { text } = buildQuotaRetryPrompt(USER_A, 'Codex');
    expect(text).toContain('Codex is out of quota');
  });

  it('warns about free models retaining data for training', () => {
    const { text } = buildQuotaRetryPrompt(USER_A, 'Codex');
    expect(text).toContain('improve the model');
    expect(text.toLowerCase()).toContain('sensitive');
  });

  it('returns a keyboard with two rows: retry + cancel', () => {
    const { keyboard } = buildQuotaRetryPrompt(USER_A, 'Codex');
    // grammy InlineKeyboard exposes its rows via .inline_keyboard
    const rows = (keyboard as any).inline_keyboard as Array<Array<any>>;
    expect(rows.length).toBe(2);
    expect(rows[0][0].text).toContain('OpenCode');
    expect(rows[1][0].text).toContain('Cancel');
  });

  it('encodes the userId into both callback_data strings', () => {
    const { keyboard } = buildQuotaRetryPrompt(USER_A, 'Codex');
    const rows = (keyboard as any).inline_keyboard as Array<Array<any>>;
    expect(rows[0][0].callback_data).toBe(`quota_retry_opencode:${USER_A}`);
    expect(rows[1][0].callback_data).toBe(`quota_cancel:${USER_A}`);
  });

  it('produces different callback_data for different users', () => {
    const a = buildQuotaRetryPrompt(USER_A, 'Codex');
    const b = buildQuotaRetryPrompt(USER_B, 'Codex');
    const aRows = (a.keyboard as any).inline_keyboard;
    const bRows = (b.keyboard as any).inline_keyboard;
    expect(aRows[0][0].callback_data).not.toBe(bRows[0][0].callback_data);
  });

  it('callback_data stays under the 64-byte Telegram limit', () => {
    // Worst case: a very large userId (Telegram user IDs are int64 but typical
    // values fit in 10 digits). Verify with a 15-digit synthetic ID.
    const huge = 999_999_999_999_999;
    const { keyboard } = buildQuotaRetryPrompt(huge, 'Codex');
    const rows = (keyboard as any).inline_keyboard;
    for (const row of rows) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });
});
