import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertNotification } from '../db/queries/notifications.js';

// Helper to create a seed project and return its id
function seedProject(db: TestDb, name = 'test-project'): number {
  const proj = insertProject(db, {
    name,
    localPath: '/tmp/test',
    createdAt: new Date(),
  });
  return proj!.id;
}

describe('DB — notifications queries', () => {
  let db: TestDb;
  let projectId: number;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
  });

  describe('insertNotification', () => {
    it('returns the inserted notification with an auto-incremented id', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{"files":["src/index.ts"]}',
        sentAt: new Date('2026-03-25T10:00:00Z'),
      });

      expect(inserted).toBeDefined();
      expect(inserted!.id).toBeGreaterThan(0);
    });

    it('stores the correct projectId', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(inserted!.projectId).toBe(projectId);
    });

    it('stores the correct type for file_change', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(inserted!.type).toBe('file_change');
    });

    it('stores the correct type for git_commit', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'git_commit',
        payload: '{"hash":"abc1234"}',
        sentAt: new Date(),
      });

      expect(inserted!.type).toBe('git_commit');
    });

    it('stores the correct type for task_complete', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'task_complete',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(inserted!.type).toBe('task_complete');
    });

    it('stores the correct type for task_error', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'task_error',
        payload: '{"error":"failed"}',
        sentAt: new Date(),
      });

      expect(inserted!.type).toBe('task_error');
    });

    it('stores the correct type for usage_limit', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'usage_limit',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(inserted!.type).toBe('usage_limit');
    });

    it('stores the correct type for rate_limit', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'rate_limit',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(inserted!.type).toBe('rate_limit');
    });

    it('stores the payload string exactly as provided', () => {
      const payload = JSON.stringify({ files: ['src/foo.ts', 'src/bar.ts'] });
      const inserted = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload,
        sentAt: new Date(),
      });

      expect(inserted!.payload).toBe(payload);
    });

    it('stores an optional telegramMessageId when provided', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{}',
        sentAt: new Date(),
        telegramMessageId: 42,
      });

      expect(inserted!.telegramMessageId).toBe(42);
    });

    it('telegramMessageId is null when not provided', () => {
      const inserted = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(inserted!.telegramMessageId).toBeNull();
    });

    it('auto-increments ids for consecutive insertions', () => {
      const first = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{}',
        sentAt: new Date(),
      });
      const second = insertNotification(db, {
        projectId,
        type: 'git_commit',
        payload: '{}',
        sentAt: new Date(),
      });

      expect(second!.id).toBeGreaterThan(first!.id);
    });

    it('can insert notifications for different projects independently', () => {
      const otherProjectId = seedProject(db, 'other-project');

      const n1 = insertNotification(db, {
        projectId,
        type: 'file_change',
        payload: '{"project":"first"}',
        sentAt: new Date(),
      });
      const n2 = insertNotification(db, {
        projectId: otherProjectId,
        type: 'git_commit',
        payload: '{"project":"second"}',
        sentAt: new Date(),
      });

      expect(n1!.projectId).toBe(projectId);
      expect(n2!.projectId).toBe(otherProjectId);
    });
  });
});
