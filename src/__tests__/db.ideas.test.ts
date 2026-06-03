import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import {
  insertIdea,
  getRecentIdeas,
  deleteIdea,
  clearIdeas,
  appendIdeaEntry,
  getIdeaById,
  getIdeaEntries,
  getIdeaThread,
} from '../db/queries/ideas.js';

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

  describe('appendIdeaEntry / getIdeaEntries', () => {
    it('appends an entry to an existing idea', () => {
      const idea = insertIdea(db, 'main idea');
      const entry = appendIdeaEntry(db, idea.id, 'first note', { addedBy: 7, addedByName: 'alice' });
      expect(entry).toBeDefined();
      expect(entry!.ideaId).toBe(idea.id);
      expect(entry!.text).toBe('first note');
      expect(entry!.addedBy).toBe(7);
      expect(entry!.addedByName).toBe('alice');
    });

    it('returns undefined when appending to a non-existent idea', () => {
      expect(appendIdeaEntry(db, 9999, 'note')).toBeUndefined();
    });

    it('getIdeaEntries returns entries in chronological order', () => {
      const idea = insertIdea(db, 'main');
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      appendIdeaEntry(db, idea.id, 'first',  { createdAt: new Date(t0) });
      appendIdeaEntry(db, idea.id, 'second', { createdAt: new Date(t0 + 1000) });
      appendIdeaEntry(db, idea.id, 'third',  { createdAt: new Date(t0 + 2000) });
      expect(getIdeaEntries(db, idea.id).map(e => e.text)).toEqual(['first', 'second', 'third']);
    });

    it('entries from one idea do not bleed into another', () => {
      const a = insertIdea(db, 'A');
      const b = insertIdea(db, 'B');
      appendIdeaEntry(db, a.id, 'belongs to A');
      appendIdeaEntry(db, b.id, 'belongs to B');
      expect(getIdeaEntries(db, a.id).map(e => e.text)).toEqual(['belongs to A']);
      expect(getIdeaEntries(db, b.id).map(e => e.text)).toEqual(['belongs to B']);
    });
  });

  describe('getIdeaThread', () => {
    it('returns the idea plus its ordered entries', () => {
      const idea = insertIdea(db, 'headline', { addedByName: 'alice' });
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      appendIdeaEntry(db, idea.id, 'add one', { addedByName: 'bob',     createdAt: new Date(t0) });
      appendIdeaEntry(db, idea.id, 'add two', { addedByName: 'charlie', createdAt: new Date(t0 + 1000) });
      const thread = getIdeaThread(db, idea.id);
      expect(thread).toBeDefined();
      expect(thread!.idea.text).toBe('headline');
      expect(thread!.entries.map(e => e.text)).toEqual(['add one', 'add two']);
      expect(thread!.entries.map(e => e.addedByName)).toEqual(['bob', 'charlie']);
    });

    it('returns undefined when the idea does not exist', () => {
      expect(getIdeaThread(db, 9999)).toBeUndefined();
    });

    it('returns an empty entries list when the idea has no notes yet', () => {
      const idea = insertIdea(db, 'lonely');
      const thread = getIdeaThread(db, idea.id);
      expect(thread!.entries).toEqual([]);
    });
  });

  describe('getIdeaById', () => {
    it('returns the matching idea', () => {
      const idea = insertIdea(db, 'find me');
      expect(getIdeaById(db, idea.id)?.text).toBe('find me');
    });

    it('returns undefined for a missing id', () => {
      expect(getIdeaById(db, 9999)).toBeUndefined();
    });
  });

  describe('getRecentIdeas — entryCount', () => {
    it('reports 0 for ideas without entries', () => {
      insertIdea(db, 'alone');
      const [item] = getRecentIdeas(db);
      expect(item.entryCount).toBe(0);
    });

    it('reports the correct number of entries per idea', () => {
      const a = insertIdea(db, 'A');
      const b = insertIdea(db, 'B');
      appendIdeaEntry(db, a.id, 'a1');
      appendIdeaEntry(db, a.id, 'a2');
      appendIdeaEntry(db, a.id, 'a3');
      appendIdeaEntry(db, b.id, 'b1');
      const items = getRecentIdeas(db);
      const ideaA = items.find(i => i.text === 'A')!;
      const ideaB = items.find(i => i.text === 'B')!;
      expect(ideaA.entryCount).toBe(3);
      expect(ideaB.entryCount).toBe(1);
    });
  });

  describe('cascade delete', () => {
    it('deleteIdea also removes its entries', () => {
      const idea = insertIdea(db, 'doomed');
      appendIdeaEntry(db, idea.id, 'note 1');
      appendIdeaEntry(db, idea.id, 'note 2');
      expect(getIdeaEntries(db, idea.id).length).toBe(2);
      deleteIdea(db, idea.id);
      expect(getIdeaEntries(db, idea.id)).toEqual([]);
    });

    it('clearIdeas removes every entry across every idea', () => {
      const a = insertIdea(db, 'A');
      const b = insertIdea(db, 'B');
      appendIdeaEntry(db, a.id, 'a1');
      appendIdeaEntry(db, b.id, 'b1');
      clearIdeas(db);
      expect(getIdeaEntries(db, a.id)).toEqual([]);
      expect(getIdeaEntries(db, b.id)).toEqual([]);
    });
  });
});
