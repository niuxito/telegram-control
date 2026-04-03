import { eq, and } from 'drizzle-orm';
import type { Db } from '../client.js';
import { localIssues } from '../schema.js';

export function insertLocalIssue(db: Db, projectId: number, title: string, body: string) {
  return db.insert(localIssues).values({ projectId, title, body }).returning().get();
}

export function listLocalIssues(db: Db, projectId: number, status: 'open' | 'closed' = 'open') {
  return db.select().from(localIssues)
    .where(and(eq(localIssues.projectId, projectId), eq(localIssues.status, status)))
    .all();
}

export function closeLocalIssue(db: Db, id: number, projectId: number) {
  return db.update(localIssues)
    .set({ status: 'closed', closedAt: new Date() })
    .where(and(eq(localIssues.id, id), eq(localIssues.projectId, projectId)))
    .run();
}
