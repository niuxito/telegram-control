import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import {
  insertTopicMessage,
  getRecentTopicMessages,
  buildConversationContext,
  resolveContextLimit,
  needsMoreContext,
} from '../db/queries/topicMessages.js';

function seedProject(db: TestDb, name = 'test-project'): number {
  const proj = insertProject(db, {
    name,
    localPath: '/tmp/test',
    createdAt: new Date(),
  });
  return proj!.id;
}

describe('topicMessages — needsMoreContext', () => {
  it('matches Spanish "continúa"', () => {
    expect(needsMoreContext('continúa con el cambio')).toBe(true);
  });

  it('matches Spanish "continua" without accent', () => {
    expect(needsMoreContext('continua donde lo dejamos')).toBe(true);
  });

  it('matches English "continue"', () => {
    expect(needsMoreContext('please continue')).toBe(true);
  });

  it('matches "as before"', () => {
    expect(needsMoreContext('do it as before')).toBe(true);
  });

  it('matches "como dijiste"', () => {
    expect(needsMoreContext('hazlo como dijiste antes')).toBe(true);
  });

  it('matches "más contexto"', () => {
    expect(needsMoreContext('necesito más contexto')).toBe(true);
  });

  it('matches "more context"', () => {
    expect(needsMoreContext('I need more context for this')).toBe(true);
  });

  it('does NOT match an unrelated prompt', () => {
    expect(needsMoreContext('write a function that sums two numbers')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(needsMoreContext('CONTINUE the work')).toBe(true);
  });
});

describe('topicMessages — resolveContextLimit', () => {
  it('returns default limit (20) for an unrelated prompt', () => {
    const r = resolveContextLimit('add a new endpoint');
    expect(r.limit).toBe(20);
    expect(r.flagFound).toBe(false);
    expect(r.promptClean).toBe('add a new endpoint');
  });

  it('returns expanded limit (40) when a context keyword is present', () => {
    const r = resolveContextLimit('continúa con la refactorización');
    expect(r.limit).toBe(40);
    expect(r.flagFound).toBe(false);
    expect(r.promptClean).toBe('continúa con la refactorización');
  });

  it('returns max limit (50) and strips the --more flag', () => {
    const r = resolveContextLimit('do something --more');
    expect(r.limit).toBe(50);
    expect(r.flagFound).toBe(true);
    expect(r.promptClean).toBe('do something');
  });

  it('returns max limit (50) and strips the -m flag', () => {
    const r = resolveContextLimit('do something -m');
    expect(r.limit).toBe(50);
    expect(r.flagFound).toBe(true);
    expect(r.promptClean).toBe('do something');
  });

  it('--more takes precedence over keyword detection', () => {
    const r = resolveContextLimit('continúa --more');
    expect(r.limit).toBe(50);
    expect(r.flagFound).toBe(true);
  });

  it('strips --more from the middle of the prompt', () => {
    const r = resolveContextLimit('please --more do the thing');
    expect(r.flagFound).toBe(true);
    expect(r.promptClean).toBe('please do the thing');
  });
});

describe('topicMessages — insertTopicMessage / getRecentTopicMessages', () => {
  let db: TestDb;
  let projectId: number;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
  });

  it('inserts a user message and returns it via getRecentTopicMessages', () => {
    insertTopicMessage(db, { projectId, sender: 'user', senderName: 'niux', text: 'hello' });
    const msgs = getRecentTopicMessages(db, projectId);
    expect(msgs.length).toBe(1);
    expect(msgs[0].sender).toBe('user');
    expect(msgs[0].senderName).toBe('niux');
    expect(msgs[0].text).toBe('hello');
  });

  it('inserts an agent message without senderName (null)', () => {
    insertTopicMessage(db, { projectId, sender: 'claude', text: 'response' });
    const msgs = getRecentTopicMessages(db, projectId);
    expect(msgs[0].sender).toBe('claude');
    expect(msgs[0].senderName).toBeNull();
  });

  it('returns messages in chronological order (oldest first)', () => {
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    insertTopicMessage(db, { projectId, sender: 'user', senderName: 'a', text: '1', createdAt: new Date(t0) });
    insertTopicMessage(db, { projectId, sender: 'claude', text: '2', createdAt: new Date(t0 + 1000) });
    insertTopicMessage(db, { projectId, sender: 'user', senderName: 'a', text: '3', createdAt: new Date(t0 + 2000) });
    const msgs = getRecentTopicMessages(db, projectId);
    expect(msgs.map(m => m.text)).toEqual(['1', '2', '3']);
  });

  it('respects the limit parameter', () => {
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 1; i <= 30; i++) {
      insertTopicMessage(db, {
        projectId, sender: 'user', senderName: 'a', text: `m${i}`,
        createdAt: new Date(t0 + i * 1000),
      });
    }
    const msgs = getRecentTopicMessages(db, projectId, 5);
    expect(msgs.length).toBe(5);
    expect(msgs[0].text).toBe('m26');
    expect(msgs[4].text).toBe('m30');
  });

  it('caps limit at MAX_CONTEXT_MESSAGES (50) even if a larger value is requested', () => {
    for (let i = 1; i <= 80; i++) {
      insertTopicMessage(db, { projectId, sender: 'user', senderName: 'a', text: `m${i}` });
    }
    const msgs = getRecentTopicMessages(db, projectId, 200);
    // Pruning kicks in at 100 stored, so total rows ≤ 100; fetch is then capped at 50.
    expect(msgs.length).toBeLessThanOrEqual(50);
  });

  it('does not return messages from other projects', () => {
    const otherId = seedProject(db, 'other-project');
    insertTopicMessage(db, { projectId, sender: 'user', text: 'mine' });
    insertTopicMessage(db, { projectId: otherId, sender: 'user', text: 'theirs' });
    const mine = getRecentTopicMessages(db, projectId);
    expect(mine.length).toBe(1);
    expect(mine[0].text).toBe('mine');
  });

  it('prunes older messages once MAX_STORED_MESSAGES (100) is exceeded', () => {
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 1; i <= 110; i++) {
      insertTopicMessage(db, {
        projectId, sender: 'user', text: `m${i}`,
        createdAt: new Date(t0 + i * 1000),
      });
    }
    const msgs = getRecentTopicMessages(db, projectId, 200);
    // Storage cap is 100, fetch is then capped at 50 by MAX_CONTEXT_MESSAGES
    expect(msgs.length).toBeLessThanOrEqual(50);
    // Most recent message must always survive
    expect(msgs[msgs.length - 1].text).toBe('m110');
    // The very first message must be pruned
    expect(msgs.find(m => m.text === 'm1')).toBeUndefined();
  });
});

describe('topicMessages — buildConversationContext', () => {
  it('returns empty string when there are no messages', () => {
    expect(buildConversationContext([])).toBe('');
  });

  it('builds a compact header + messages block when messages exist', () => {
    const ctx = buildConversationContext([
      { sender: 'user', senderName: 'niux', text: 'hello', createdAt: new Date() },
      { sender: 'claude', senderName: null, text: 'hi back', createdAt: new Date() },
    ]);
    expect(ctx).toContain('Chat log — 2 msgs');
    expect(ctx).toContain('[niux] hello');
    expect(ctx).toContain('[Claude] hi back');
    // Delimiter is the shorter '---' separator on its own line
    expect(ctx).toMatch(/---\n[\s\S]+---/);
  });

  it('keeps the banner under 80 chars to save tokens', () => {
    // The whole raison d'être of the banner shrink: no more ~450-char preamble.
    const ctx = buildConversationContext([
      { sender: 'user', senderName: 'niux', text: 'x', createdAt: new Date() },
    ]);
    const firstLine = ctx.split('\n')[0];
    expect(firstLine.length).toBeLessThanOrEqual(80);
  });

  it('uses "User" as fallback name when senderName is null on a user message', () => {
    const ctx = buildConversationContext([
      { sender: 'user', senderName: null, text: 'no name here', createdAt: new Date() },
    ]);
    expect(ctx).toContain('[User] no name here');
  });

  it('labels Codex messages with "Codex"', () => {
    const ctx = buildConversationContext([
      { sender: 'codex', senderName: null, text: 'codex says hi', createdAt: new Date() },
    ]);
    expect(ctx).toContain('[Codex] codex says hi');
  });

  it('labels OpenCode messages with "OpenCode"', () => {
    const ctx = buildConversationContext([
      { sender: 'opencode', senderName: null, text: 'opencode says hi', createdAt: new Date() },
    ]);
    expect(ctx).toContain('[OpenCode] opencode says hi');
  });

  it('treats OpenCode as an agent for the per-message char limit', () => {
    const longText = 'o'.repeat(3000);
    const ctx = buildConversationContext([
      { sender: 'opencode', senderName: null, text: longText, createdAt: new Date() },
    ]);
    // Agent limit is 2000 (vs 400 for users) so most of the text survives
    expect(ctx).toContain('o'.repeat(1000));
  });

  it('truncates long user messages with the USER_MSG_LIMIT (400 chars)', () => {
    const longUser = 'u'.repeat(1000);
    const ctx = buildConversationContext([
      { sender: 'user', senderName: 'niux', text: longUser, createdAt: new Date() },
    ]);
    // 400 chars + ellipsis (1 char), inside a "[niux] …" line
    expect(ctx).toContain('u'.repeat(400) + '…');
    expect(ctx).not.toContain('u'.repeat(401));
  });

  it('preserves structured agent content (numbered/bulleted lines) when long', () => {
    const structured =
      '1. First item with some detail\n' +
      '2. Second item with more detail\n' +
      '3. Third item\n' +
      '- bullet a\n' +
      '- bullet b\n' +
      'a bunch of unstructured filler '.repeat(100);
    const ctx = buildConversationContext([
      { sender: 'claude', senderName: null, text: structured, createdAt: new Date() },
    ]);
    expect(ctx).toContain('1. First item');
    expect(ctx).toContain('2. Second item');
    expect(ctx).toContain('- bullet a');
  });

  it('falls back to head+tail truncation for unstructured agent text over the limit', () => {
    const unstructured = 'A'.repeat(1000) + 'MIDDLE_MARKER' + 'Z'.repeat(1500);
    const ctx = buildConversationContext([
      { sender: 'claude', senderName: null, text: unstructured, createdAt: new Date() },
    ]);
    // Head should contain the start, tail should contain the end, ellipsis between
    expect(ctx).toContain('A'.repeat(100));
    expect(ctx).toContain('Z'.repeat(100));
    expect(ctx).toContain('…');
  });

  it('drops oldest messages first when total chars exceed MAX_CONTEXT_CHARS (6000)', () => {
    // Build messages: many big agent responses that together blow past 6000 chars
    const bigBlob = 'X'.repeat(1800); // ~1.8k each, times several = exceeds cap
    const messages = Array.from({ length: 6 }, (_, i) => ({
      sender: 'claude' as const,
      senderName: null,
      text: `MARK${i} ` + bigBlob,
      createdAt: new Date(2026, 0, i + 1),
    }));
    const ctx = buildConversationContext(messages);
    // The newest message (MARK5) must be kept
    expect(ctx).toContain('MARK5');
    // The oldest message (MARK0) must be dropped
    expect(ctx).not.toContain('MARK0');
    // The truncation banner is added
    expect(ctx).toContain('earlier messages omitted');
  });

  it('hints about --more flag for older history', () => {
    const ctx = buildConversationContext([
      { sender: 'user', senderName: 'niux', text: 'hi', createdAt: new Date() },
    ]);
    expect(ctx).toContain('--more');
  });
});
