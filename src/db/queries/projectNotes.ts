import { desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { projectNotes } from '../schema.js';

export function insertNote(db: Db, projectId: number, text: string, createdAt?: Date): void {
  db.insert(projectNotes).values({
    projectId,
    text,
    ...(createdAt ? { createdAt } : {}),
  }).run();
}

export function getRecentNotes(db: Db, projectId: number, limit = 10) {
  return db
    .select()
    .from(projectNotes)
    .where(eq(projectNotes.projectId, projectId))
    .orderBy(desc(projectNotes.createdAt))
    .limit(limit)
    .all()
    .reverse();
}

export function deleteNote(db: Db, noteId: number, projectId: number): boolean {
  const result = db
    .delete(projectNotes)
    .where(eq(projectNotes.id, noteId))
    .run();
  return result.changes > 0;
}

export function clearNotes(db: Db, projectId: number): number {
  const result = db
    .delete(projectNotes)
    .where(eq(projectNotes.projectId, projectId))
    .run();
  return result.changes;
}
