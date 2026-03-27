import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertSession, updateSession, getLatestSession } from '../db/queries/sessions.js';

// Helper to create a seed project
function seedProject(db: TestDb, name = 'test-project'): number {
  const proj = insertProject(db, {
    name,
    localPath: '/tmp/test',
    createdAt: new Date(),
  });
  return proj!.id;
}

describe('DB — updateSession', () => {
  let db: TestDb;
  let projectId: number;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
  });

  it('returns the updated session record', () => {
    const session = insertSession(db, { projectId, lastUsedAt: new Date() });
    const updated = updateSession(db, session!.id, { claudeSessionId: 'new-id' });
    expect(updated).toBeDefined();
    expect(updated!.id).toBe(session!.id);
  });

  it('updates claudeSessionId', () => {
    const session = insertSession(db, { projectId, lastUsedAt: new Date() });
    updateSession(db, session!.id, { claudeSessionId: 'updated-session-id' });

    const latest = getLatestSession(db, projectId);
    expect(latest!.claudeSessionId).toBe('updated-session-id');
  });

  it('updates totalCostUsd', () => {
    const session = insertSession(db, { projectId, lastUsedAt: new Date() });
    updateSession(db, session!.id, { totalCostUsd: 1.2345 });

    const latest = getLatestSession(db, projectId);
    expect(latest!.totalCostUsd).toBeCloseTo(1.2345, 4);
  });

  it('accumulates cost across multiple updates', () => {
    const session = insertSession(db, { projectId, lastUsedAt: new Date() });
    updateSession(db, session!.id, { totalCostUsd: 0.5 });
    const after1 = getLatestSession(db, projectId);

    updateSession(db, session!.id, { totalCostUsd: (after1!.totalCostUsd ?? 0) + 0.3 });
    const after2 = getLatestSession(db, projectId);

    expect(after2!.totalCostUsd).toBeCloseTo(0.8, 4);
  });

  it('updates messageCount', () => {
    const session = insertSession(db, { projectId, lastUsedAt: new Date() });
    updateSession(db, session!.id, { messageCount: 5 });

    const latest = getLatestSession(db, projectId);
    expect(latest!.messageCount).toBe(5);
  });

  it('updates lastUsedAt timestamp', () => {
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-03-25T12:00:00Z');

    const session = insertSession(db, { projectId, lastUsedAt: oldDate });
    updateSession(db, session!.id, { lastUsedAt: newDate });

    const latest = getLatestSession(db, projectId);
    // Timestamps are stored as integers (ms), compare by value
    expect(latest!.lastUsedAt.getTime()).toBe(newDate.getTime());
  });

  it('can update multiple fields in a single call', () => {
    const session = insertSession(db, { projectId, lastUsedAt: new Date() });
    const newDate = new Date('2026-03-26T00:00:00Z');

    updateSession(db, session!.id, {
      claudeSessionId: 'multi-update',
      totalCostUsd: 2.5,
      messageCount: 10,
      lastUsedAt: newDate,
    });

    const latest = getLatestSession(db, projectId);
    expect(latest!.claudeSessionId).toBe('multi-update');
    expect(latest!.totalCostUsd).toBeCloseTo(2.5, 4);
    expect(latest!.messageCount).toBe(10);
  });

  it('returns undefined when updating a non-existent session id', () => {
    const result = updateSession(db, 9999, { claudeSessionId: 'ghost' });
    expect(result).toBeUndefined();
  });

  it('does not affect other sessions in the same project', () => {
    const s1 = insertSession(db, {
      projectId,
      claudeSessionId: 'session-one',
      lastUsedAt: new Date('2026-03-20T00:00:00Z'),
    });
    const s2 = insertSession(db, {
      projectId,
      claudeSessionId: 'session-two',
      lastUsedAt: new Date('2026-03-21T00:00:00Z'),
    });

    updateSession(db, s1!.id, { totalCostUsd: 9.99 });

    // s2 should be unchanged
    // We need to fetch s2 directly — verify via getLatestSession (which returns newest)
    const latest = getLatestSession(db, projectId);
    expect(latest!.id).toBe(s2!.id); // s2 is newest by lastUsedAt
    expect(latest!.totalCostUsd).toBe(0); // s2 untouched
  });
});
