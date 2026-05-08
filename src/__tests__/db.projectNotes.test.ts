import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertNote, getRecentNotes, deleteNote, clearNotes } from '../db/queries/projectNotes.js';

function seedProject(db: TestDb, name = 'test-project'): number {
  const proj = insertProject(db, {
    name,
    localPath: '/tmp/test',
    createdAt: new Date(),
  });
  return proj!.id;
}

describe('DB — projectNotes queries', () => {
  let db: TestDb;
  let projectId: number;

  beforeEach(() => {
    ({ db } = createTestDb());
    projectId = seedProject(db);
  });

  describe('insertNote / getRecentNotes', () => {
    it('a freshly inserted note is returned by getRecentNotes', () => {
      insertNote(db, projectId, 'first note');
      const notes = getRecentNotes(db, projectId);
      expect(notes.length).toBe(1);
      expect(notes[0].text).toBe('first note');
      expect(notes[0].projectId).toBe(projectId);
    });

    it('returns notes in chronological order (oldest first)', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      insertNote(db, projectId, 'oldest', new Date(t0));
      insertNote(db, projectId, 'middle', new Date(t0 + 1000));
      insertNote(db, projectId, 'newest', new Date(t0 + 2000));
      const notes = getRecentNotes(db, projectId);
      expect(notes.map(n => n.text)).toEqual(['oldest', 'middle', 'newest']);
    });

    it('returns empty array when project has no notes', () => {
      expect(getRecentNotes(db, projectId)).toEqual([]);
    });

    it('does not return notes from other projects', () => {
      const otherProjectId = seedProject(db, 'other-project');
      insertNote(db, projectId, 'mine');
      insertNote(db, otherProjectId, 'theirs');
      const mine = getRecentNotes(db, projectId);
      expect(mine.length).toBe(1);
      expect(mine[0].text).toBe('mine');
    });

    it('respects the limit parameter and keeps the most recent N', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 15; i++) insertNote(db, projectId, `note-${i}`, new Date(t0 + i * 1000));
      const notes = getRecentNotes(db, projectId, 5);
      expect(notes.length).toBe(5);
      // Last 5 inserted, returned chronologically (after .reverse()): 11..15
      expect(notes.map(n => n.text)).toEqual(['note-11', 'note-12', 'note-13', 'note-14', 'note-15']);
    });

    it('default limit is 10', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      for (let i = 1; i <= 20; i++) insertNote(db, projectId, `note-${i}`, new Date(t0 + i * 1000));
      const notes = getRecentNotes(db, projectId);
      expect(notes.length).toBe(10);
      // Last 10 inserted: 11..20
      expect(notes[0].text).toBe('note-11');
      expect(notes[9].text).toBe('note-20');
    });

    it('stores empty-ish text as-is (caller is responsible for validation)', () => {
      insertNote(db, projectId, '   ');
      const notes = getRecentNotes(db, projectId);
      expect(notes.length).toBe(1);
      expect(notes[0].text).toBe('   ');
    });

    it('preserves multi-line text verbatim', () => {
      const multiline = 'line one\nline two\nline three';
      insertNote(db, projectId, multiline);
      const notes = getRecentNotes(db, projectId);
      expect(notes[0].text).toBe(multiline);
    });
  });

  describe('deleteNote', () => {
    it('returns true when a note is deleted and removes it from the listing', () => {
      insertNote(db, projectId, 'doomed');
      const [note] = getRecentNotes(db, projectId);
      const ok = deleteNote(db, note.id, projectId);
      expect(ok).toBe(true);
      expect(getRecentNotes(db, projectId)).toEqual([]);
    });

    it('returns false when the note id does not exist', () => {
      expect(deleteNote(db, 9999, projectId)).toBe(false);
    });

    it('only removes the targeted note, leaving siblings intact', () => {
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      insertNote(db, projectId, 'keep-1',    new Date(t0));
      insertNote(db, projectId, 'remove-me', new Date(t0 + 1000));
      insertNote(db, projectId, 'keep-2',    new Date(t0 + 2000));
      const middle = getRecentNotes(db, projectId).find(n => n.text === 'remove-me')!;
      deleteNote(db, middle.id, projectId);
      const remaining = getRecentNotes(db, projectId).map(n => n.text);
      expect(remaining).toEqual(['keep-1', 'keep-2']);
    });
  });

  describe('clearNotes', () => {
    it('returns 0 and is a no-op when there are no notes', () => {
      expect(clearNotes(db, projectId)).toBe(0);
    });

    it('returns the number of notes removed and empties the listing', () => {
      insertNote(db, projectId, 'a');
      insertNote(db, projectId, 'b');
      insertNote(db, projectId, 'c');
      const count = clearNotes(db, projectId);
      expect(count).toBe(3);
      expect(getRecentNotes(db, projectId)).toEqual([]);
    });

    it('does not touch notes from other projects', () => {
      const otherProjectId = seedProject(db, 'other-project');
      insertNote(db, projectId, 'mine-1');
      insertNote(db, projectId, 'mine-2');
      insertNote(db, otherProjectId, 'theirs');
      const removed = clearNotes(db, projectId);
      expect(removed).toBe(2);
      expect(getRecentNotes(db, projectId)).toEqual([]);
      const theirs = getRecentNotes(db, otherProjectId);
      expect(theirs.length).toBe(1);
      expect(theirs[0].text).toBe('theirs');
    });
  });
});
