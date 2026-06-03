import { desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { ideas } from '../schema.js';

// Idea = a project we *might* build later. Global, not tied to a project.
// Lifecycle: /idea <text> → insert; /idea list → show; /idea delete <id> /
// /idea clear → remove.

export function insertIdea(
  db: Db,
  text: string,
  opts?: { addedBy?: number; addedByName?: string; createdAt?: Date },
): void {
  db.insert(ideas).values({
    text,
    addedBy: opts?.addedBy ?? null,
    addedByName: opts?.addedByName ?? null,
    ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
  }).run();
}

/**
 * Returns up to `limit` ideas, oldest first (so output reads chronologically).
 * Implementation grabs the latest `limit` by createdAt, then reverses, to keep
 * a stable cap on result size regardless of total backlog.
 */
export function getRecentIdeas(db: Db, limit = 20) {
  return db
    .select()
    .from(ideas)
    .orderBy(desc(ideas.createdAt))
    .limit(limit)
    .all()
    .reverse();
}

export function deleteIdea(db: Db, ideaId: number): boolean {
  const result = db.delete(ideas).where(eq(ideas.id, ideaId)).run();
  return result.changes > 0;
}

export function clearIdeas(db: Db): number {
  const result = db.delete(ideas).run();
  return result.changes;
}
