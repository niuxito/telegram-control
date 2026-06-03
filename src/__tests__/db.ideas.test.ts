import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertIdea, getRecentIdeas, deleteIdea, clearIdeas } from '../db/queries/ideas.js';

describe('DB — ideas queries', () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe('insertIdea / getRecentIdeas', () => {
    it('a freshly inserted idea is returned by getRecentIdeas', () => {
      insertIdea(db, 'build a price tracker');
      const items = getRecentIdeas(db);
      expect(items.length).toBe(1);
      expect(items[0].text).toBe('build a price tracker');
      expect(items[0].addedBy).toBeNull();
      expect(items[0].addedByName).toBeNull();
    });

    it('persists addedBy and addedByName when provided', () => {
      insertIdea(db, 'hello', { addedBy: 42, addedByName: 'niux' });
      const [item] = getRecentIdeas(db);
      expect(item.addedBy).toBe(42);
      expect(item.addedByName).toBe('niux');
    });

    it('returns chronological order (oldest first)', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      insertIdea(db, 'first',  { createdAt: new Date(t0) });
      insertIdea(db, 'middle', { createdAt: new Date(t0 + 1000) });
      insertIdea(db, 'newest', { createdAt: new Date(t0 + 2000) });
      expect(getRecentIdeas(db).map(i => i.text)).toEqual(['first', 'middle', 'newest']);
    });

    it('returns empty array when there are no ideas', () => {
      expect(getRecentIdeas(db)).toEqual([]);
    });

    it('respects the limit parameter — keeps the most recent N', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 25; i++) {
        insertIdea(db, `idea-${i}`, { createdAt: new Date(t0 + i * 1000) });
      }
      const items = getRecentIdeas(db, 5);
      expect(items.length).toBe(5);
      // Most recent 5 → ids 21..25, returned chronologically
      expect(items.map(i => i.text)).toEqual(['idea-21', 'idea-22', 'idea-23', 'idea-24', 'idea-25']);
    });

    it('default limit is 20', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 30; i++) {
        insertIdea(db, `idea-${i}`, { createdAt: new Date(t0 + i * 1000) });
      }
      expect(getRecentIdeas(db).length).toBe(20);
    });

    it('preserves multi-line text verbatim', () => {
      insertIdea(db, 'line one\nline two\nline three');
      const [item] = getRecentIdeas(db);
      expect(item.text).toBe('line one\nline two\nline three');
    });
  });

  describe('deleteIdea', () => {
    it('returns true when an idea is removed', () => {
      insertIdea(db, 'doomed');
      const [item] = getRecentIdeas(db);
      expect(deleteIdea(db, item.id)).toBe(true);
      expect(getRecentIdeas(db)).toEqual([]);
    });

    it('returns false when the id does not exist', () => {
      expect(deleteIdea(db, 9999)).toBe(false);
    });

    it('only removes the targeted idea, leaving siblings intact', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      insertIdea(db, 'keep-1',    { createdAt: new Date(t0) });
      insertIdea(db, 'remove-me', { createdAt: new Date(t0 + 1000) });
      insertIdea(db, 'keep-2',    { createdAt: new Date(t0 + 2000) });
      const middle = getRecentIdeas(db).find(i => i.text === 'remove-me')!;
      deleteIdea(db, middle.id);
      expect(getRecentIdeas(db).map(i => i.text)).toEqual(['keep-1', 'keep-2']);
    });
  });

  describe('clearIdeas', () => {
    it('returns 0 when the backlog is empty', () => {
      expect(clearIdeas(db)).toBe(0);
    });

    it('removes all ideas and returns the count', () => {
      insertIdea(db, 'a');
      insertIdea(db, 'b');
      insertIdea(db, 'c');
      expect(clearIdeas(db)).toBe(3);
      expect(getRecentIdeas(db)).toEqual([]);
    });
  });
});
