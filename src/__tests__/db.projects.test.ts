import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import {
  insertProject,
  getProjectById,
  getProjectByTopicId,
  getProjectByName,
  getActiveProjects,
  updateProject,
} from '../db/queries/projects.js';

// Shared project seed data
const BASE_PROJECT = {
  name: 'test-project',
  localPath: '/tmp/test-project',
  createdAt: new Date('2026-01-01T00:00:00Z'),
} as const;

describe('DB — projects queries', () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe('insertProject / getProjectById', () => {
    it('returns the inserted project by id with correct data', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      expect(inserted).toBeDefined();
      expect(inserted!.id).toBeGreaterThan(0);

      const fetched = getProjectById(db, inserted!.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe('test-project');
      expect(fetched!.localPath).toBe('/tmp/test-project');
    });

    it('returns undefined for a non-existent id', () => {
      expect(getProjectById(db, 999)).toBeUndefined();
    });

    it('defaults status to "active"', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      expect(inserted!.status).toBe('active');
    });

    it('defaults watchFiles and watchGit to true', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      expect(inserted!.watchFiles).toBe(true);
      expect(inserted!.watchGit).toBe(true);
    });
  });

  describe('getProjectByTopicId', () => {
    it('finds a project by its topic id', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT, topicId: 42 });
      const fetched = getProjectByTopicId(db, 42);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(inserted!.id);
      expect(fetched!.topicId).toBe(42);
    });

    it('returns undefined when no project has that topic id', () => {
      insertProject(db, { ...BASE_PROJECT, topicId: 1 });
      expect(getProjectByTopicId(db, 999)).toBeUndefined();
    });

    it('returns undefined when the project has no topicId (null)', () => {
      insertProject(db, { ...BASE_PROJECT });
      // With a null topicId the project should not be found by any topicId
      expect(getProjectByTopicId(db, 0)).toBeUndefined();
    });
  });

  describe('getProjectByName', () => {
    it('finds a project by its name', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      const fetched = getProjectByName(db, 'test-project');
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(inserted!.id);
    });

    it('returns undefined for an unknown name', () => {
      insertProject(db, { ...BASE_PROJECT });
      expect(getProjectByName(db, 'no-such-project')).toBeUndefined();
    });

    it('is case-sensitive (SQLite default)', () => {
      insertProject(db, { ...BASE_PROJECT });
      // Different casing should not find the project
      expect(getProjectByName(db, 'TEST-PROJECT')).toBeUndefined();
    });
  });

  describe('getActiveProjects', () => {
    it('returns active projects', () => {
      insertProject(db, { ...BASE_PROJECT });
      const active = getActiveProjects(db);
      expect(active.length).toBe(1);
      expect(active[0].status).toBe('active');
    });

    it('returns paused projects', () => {
      insertProject(db, { ...BASE_PROJECT, status: 'paused' });
      const active = getActiveProjects(db);
      expect(active.length).toBe(1);
      expect(active[0].status).toBe('paused');
    });

    it('does NOT return archived projects', () => {
      insertProject(db, { ...BASE_PROJECT, status: 'archived' });
      const active = getActiveProjects(db);
      expect(active.length).toBe(0);
    });

    it('returns a mix of active and paused but not archived', () => {
      insertProject(db, { name: 'proj-a', localPath: '/a', createdAt: new Date(), status: 'active' });
      insertProject(db, { name: 'proj-b', localPath: '/b', createdAt: new Date(), status: 'paused' });
      insertProject(db, { name: 'proj-c', localPath: '/c', createdAt: new Date(), status: 'archived' });
      const active = getActiveProjects(db);
      expect(active.length).toBe(2);
      const statuses = active.map(p => p.status);
      expect(statuses).toContain('active');
      expect(statuses).toContain('paused');
      expect(statuses).not.toContain('archived');
    });

    it('returns empty array when no projects exist', () => {
      expect(getActiveProjects(db)).toEqual([]);
    });
  });

  describe('updateProject', () => {
    it('changes the status correctly', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      const updated = updateProject(db, inserted!.id, { status: 'archived' });
      expect(updated!.status).toBe('archived');
    });

    it('reflects the update when fetched afterwards', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      updateProject(db, inserted!.id, { status: 'paused' });
      const fetched = getProjectById(db, inserted!.id);
      expect(fetched!.status).toBe('paused');
    });

    it('can update localPath', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      updateProject(db, inserted!.id, { localPath: '/new/path' });
      const fetched = getProjectById(db, inserted!.id);
      expect(fetched!.localPath).toBe('/new/path');
    });

    it('can update topicId', () => {
      const inserted = insertProject(db, { ...BASE_PROJECT });
      updateProject(db, inserted!.id, { topicId: 77 });
      const fetched = getProjectById(db, inserted!.id);
      expect(fetched!.topicId).toBe(77);
    });

    it('updating a non-existent id returns undefined', () => {
      const result = updateProject(db, 9999, { status: 'paused' });
      expect(result).toBeUndefined();
    });
  });
});
