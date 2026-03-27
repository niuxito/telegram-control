import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertSession, getLatestSession } from '../db/queries/sessions.js';

// Helper to create a seed project and return its id
function seedProject(db: TestDb, name = 'test-project'): number {
  const proj = insertProject(db, {
    name,
    localPath: '/tmp/test',
    createdAt: new Date(),
  });
  return proj!.id;
}

describe('DB — sessions queries', () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe('insertSession / getLatestSession', () => {
    it('returns the inserted session via getLatestSession', () => {
      const projectId = seedProject(db);
      const now = new Date('2026-03-25T10:00:00Z');

      const inserted = insertSession(db, {
        projectId,
        claudeSessionId: 'claude-abc',
        lastUsedAt: now,
      });

      expect(inserted).toBeDefined();
      expect(inserted!.claudeSessionId).toBe('claude-abc');

      const latest = getLatestSession(db, projectId);
      expect(latest).toBeDefined();
      expect(latest!.id).toBe(inserted!.id);
    });

    it('returns undefined when no sessions exist for a project', () => {
      const projectId = seedProject(db);
      expect(getLatestSession(db, projectId)).toBeUndefined();
    });

    it('returns undefined for a non-existent project id', () => {
      expect(getLatestSession(db, 9999)).toBeUndefined();
    });

    it('defaults totalCostUsd to 0', () => {
      const projectId = seedProject(db);
      insertSession(db, { projectId, lastUsedAt: new Date() });
      const latest = getLatestSession(db, projectId);
      expect(latest!.totalCostUsd).toBe(0);
    });

    it('defaults messageCount to 0', () => {
      const projectId = seedProject(db);
      insertSession(db, { projectId, lastUsedAt: new Date() });
      const latest = getLatestSession(db, projectId);
      expect(latest!.messageCount).toBe(0);
    });

    it('defaults mode to "cli"', () => {
      const projectId = seedProject(db);
      insertSession(db, { projectId, lastUsedAt: new Date() });
      const latest = getLatestSession(db, projectId);
      expect(latest!.mode).toBe('cli');
    });

    it('stores a provided claudeSessionId', () => {
      const projectId = seedProject(db);
      insertSession(db, {
        projectId,
        claudeSessionId: 'session-xyz-999',
        lastUsedAt: new Date(),
      });
      const latest = getLatestSession(db, projectId);
      expect(latest!.claudeSessionId).toBe('session-xyz-999');
    });
  });

  describe('getLatestSession — ordering by lastUsedAt', () => {
    it('returns the most recently used session when multiple exist', () => {
      const projectId = seedProject(db);

      // Insert an older session
      insertSession(db, {
        projectId,
        claudeSessionId: 'old-session',
        lastUsedAt: new Date('2026-03-24T08:00:00Z'),
      });

      // Insert a newer session
      const newer = insertSession(db, {
        projectId,
        claudeSessionId: 'new-session',
        lastUsedAt: new Date('2026-03-25T09:00:00Z'),
      });

      const latest = getLatestSession(db, projectId);
      expect(latest).toBeDefined();
      expect(latest!.id).toBe(newer!.id);
      expect(latest!.claudeSessionId).toBe('new-session');
    });

    it('returns a single session when only one exists', () => {
      const projectId = seedProject(db);
      const only = insertSession(db, {
        projectId,
        claudeSessionId: 'only-session',
        lastUsedAt: new Date('2026-03-20T00:00:00Z'),
      });
      const latest = getLatestSession(db, projectId);
      expect(latest!.id).toBe(only!.id);
    });

    it('does not mix up sessions across different projects', () => {
      const projectA = seedProject(db, 'project-a');
      const projectB = seedProject(db, 'project-b');

      const sessionA = insertSession(db, {
        projectId: projectA,
        claudeSessionId: 'session-a',
        lastUsedAt: new Date('2026-03-25T12:00:00Z'),
      });
      insertSession(db, {
        projectId: projectB,
        claudeSessionId: 'session-b',
        lastUsedAt: new Date('2026-03-25T13:00:00Z'),
      });

      // Should only return project A's session, not B's
      const latestA = getLatestSession(db, projectA);
      expect(latestA!.id).toBe(sessionA!.id);
      expect(latestA!.claudeSessionId).toBe('session-a');
    });

    it('returns correct latest after inserting three sessions with different times', () => {
      const projectId = seedProject(db);

      insertSession(db, {
        projectId,
        claudeSessionId: 'first',
        lastUsedAt: new Date('2026-01-01T00:00:00Z'),
      });
      insertSession(db, {
        projectId,
        claudeSessionId: 'third',
        lastUsedAt: new Date('2026-03-01T00:00:00Z'),
      });
      insertSession(db, {
        projectId,
        claudeSessionId: 'second',
        lastUsedAt: new Date('2026-02-01T00:00:00Z'),
      });

      const latest = getLatestSession(db, projectId);
      // "third" has the most recent lastUsedAt
      expect(latest!.claudeSessionId).toBe('third');
    });
  });
});
