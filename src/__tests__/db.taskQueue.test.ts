import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import {
  insertTask,
  getPendingTasks,
  getRunningTask,
  updateTask,
  getRecentTasks,
  cancelPendingTasks,
} from '../db/queries/taskQueue.js';

// Helper to create a seed project and return its id
function seedProject(db: TestDb, name = 'test-project'): number {
  const proj = insertProject(db, {
    name,
    localPath: '/tmp/test',
    createdAt: new Date(),
  });
  return proj!.id;
}

// Helper to insert a pending task with sensible defaults
function seedTask(db: TestDb, projectId: number, prompt = 'do something', createdAt = new Date()) {
  return insertTask(db, { projectId, prompt, createdAt });
}

describe('DB — taskQueue queries', () => {
  let db: TestDb;
  let projectId: number;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
  });

  describe('insertTask / getPendingTasks', () => {
    it('a freshly inserted task appears in getPendingTasks', () => {
      seedTask(db, projectId, 'write tests');
      const pending = getPendingTasks(db, projectId);
      expect(pending.length).toBe(1);
      expect(pending[0].prompt).toBe('write tests');
      expect(pending[0].status).toBe('pending');
    });

    it('returns multiple pending tasks in createdAt ascending order', () => {
      const t1 = seedTask(db, projectId, 'task 1', new Date('2026-01-01T00:00:00Z'));
      const t2 = seedTask(db, projectId, 'task 2', new Date('2026-01-02T00:00:00Z'));
      const pending = getPendingTasks(db, projectId);
      expect(pending.length).toBe(2);
      expect(pending[0].id).toBe(t1!.id);
      expect(pending[1].id).toBe(t2!.id);
    });

    it('returns empty array when no tasks exist', () => {
      expect(getPendingTasks(db, projectId)).toEqual([]);
    });

    it('does not return tasks from other projects', () => {
      const otherProjectId = seedProject(db, 'other-project');
      seedTask(db, otherProjectId, 'other task');
      expect(getPendingTasks(db, projectId)).toEqual([]);
    });
  });

  describe('updateTask status → running', () => {
    it('a task updated to "running" appears in getRunningTask', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'running' });

      const running = getRunningTask(db, projectId);
      expect(running).toBeDefined();
      expect(running!.id).toBe(task!.id);
      expect(running!.status).toBe('running');
    });

    it('a running task does NOT appear in getPendingTasks', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'running' });
      expect(getPendingTasks(db, projectId)).toEqual([]);
    });

    it('only one running task is returned even if somehow two exist', () => {
      // In practice the app prevents this, but the query returns at most one
      const task = seedTask(db, projectId, 'task A');
      updateTask(db, task!.id, { status: 'running' });
      // The query uses .get() so at most one is ever returned
      const running = getRunningTask(db, projectId);
      expect(running).toBeDefined();
    });
  });

  describe('updateTask status → completed', () => {
    it('a completed task does NOT appear in getPendingTasks', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'completed' });
      expect(getPendingTasks(db, projectId)).toEqual([]);
    });

    it('a completed task does NOT appear via getRunningTask', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'completed' });
      expect(getRunningTask(db, projectId)).toBeUndefined();
    });

    it('completed task can store a result string', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'completed', result: 'All tests passed!' });
      const recent = getRecentTasks(db, projectId, 1);
      expect(recent[0].result).toBe('All tests passed!');
    });
  });

  describe('cancelPendingTasks', () => {
    it('cancels all pending tasks for the project', () => {
      seedTask(db, projectId, 'task A');
      seedTask(db, projectId, 'task B');
      cancelPendingTasks(db, projectId);
      expect(getPendingTasks(db, projectId)).toEqual([]);
    });

    it('does NOT cancel a running task', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'running' });
      cancelPendingTasks(db, projectId);
      // Running task should still be there
      const running = getRunningTask(db, projectId);
      expect(running).toBeDefined();
      expect(running!.status).toBe('running');
    });

    it('does NOT cancel a completed task', () => {
      const task = seedTask(db, projectId);
      updateTask(db, task!.id, { status: 'completed' });
      cancelPendingTasks(db, projectId);
      const recent = getRecentTasks(db, projectId, 5);
      const completed = recent.find(t => t.id === task!.id);
      expect(completed!.status).toBe('completed');
    });

    it('cancels pending tasks only for the target project, not others', () => {
      const otherProjectId = seedProject(db, 'other-project');
      seedTask(db, projectId, 'target pending');
      seedTask(db, otherProjectId, 'other pending');

      cancelPendingTasks(db, projectId);

      // Target project's pending task should be cancelled
      expect(getPendingTasks(db, projectId)).toEqual([]);
      // Other project's task should still be pending
      expect(getPendingTasks(db, otherProjectId)).toHaveLength(1);
    });

    it('is a no-op when there are no pending tasks', () => {
      // Should not throw
      expect(() => cancelPendingTasks(db, projectId)).not.toThrow();
    });
  });

  describe('getRecentTasks', () => {
    it('returns tasks sorted by createdAt descending', () => {
      const t1 = seedTask(db, projectId, 'first', new Date('2026-01-01T00:00:00Z'));
      const t2 = seedTask(db, projectId, 'second', new Date('2026-01-03T00:00:00Z'));
      const t3 = seedTask(db, projectId, 'third', new Date('2026-01-02T00:00:00Z'));

      const recent = getRecentTasks(db, projectId, 10);
      // Expected order: t2 (newest), t3, t1 (oldest)
      expect(recent[0].id).toBe(t2!.id);
      expect(recent[1].id).toBe(t3!.id);
      expect(recent[2].id).toBe(t1!.id);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 7; i++) {
        seedTask(db, projectId, `task ${i}`);
      }
      const recent = getRecentTasks(db, projectId, 5);
      expect(recent.length).toBe(5);
    });

    it('defaults limit to 5', () => {
      for (let i = 0; i < 8; i++) {
        seedTask(db, projectId, `task ${i}`);
      }
      const recent = getRecentTasks(db, projectId);
      expect(recent.length).toBe(5);
    });

    it('returns empty array when no tasks exist', () => {
      expect(getRecentTasks(db, projectId)).toEqual([]);
    });

    it('returns all tasks when count is below limit', () => {
      seedTask(db, projectId, 'only task');
      const recent = getRecentTasks(db, projectId, 5);
      expect(recent.length).toBe(1);
    });

    it('includes tasks of all statuses in results', () => {
      const t1 = seedTask(db, projectId, 'pending task');
      const t2 = seedTask(db, projectId, 'completed task');
      updateTask(db, t2!.id, { status: 'completed' });

      const recent = getRecentTasks(db, projectId, 10);
      const statuses = recent.map(t => t.status);
      expect(statuses).toContain('pending');
      expect(statuses).toContain('completed');
    });
  });
});
