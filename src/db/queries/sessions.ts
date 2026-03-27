import { eq, desc } from 'drizzle-orm';
import type { Db } from '../client.js';
import { claudeSessions } from '../schema.js';

export type Session = typeof claudeSessions.$inferSelect;

export function getLatestSession(db: Db, projectId: number) {
  return db.select().from(claudeSessions)
    .where(eq(claudeSessions.projectId, projectId))
    .orderBy(desc(claudeSessions.lastUsedAt))
    .limit(1)
    .get();
}

export function insertSession(db: Db, data: typeof claudeSessions.$inferInsert) {
  return db.insert(claudeSessions).values(data).returning().get();
}

export function updateSession(db: Db, id: number, data: Partial<typeof claudeSessions.$inferInsert>) {
  return db.update(claudeSessions).set(data).where(eq(claudeSessions.id, id)).returning().get();
}
