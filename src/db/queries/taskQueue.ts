import { eq, and, desc, gte } from 'drizzle-orm';
import type { Db } from '../client.js';
import { taskQueue } from '../schema.js';

export type Task = typeof taskQueue.$inferSelect;

export function getPendingTasks(db: Db, projectId: number) {
  return db.select().from(taskQueue)
    .where(and(eq(taskQueue.projectId, projectId), eq(taskQueue.status, 'pending')))
    .orderBy(taskQueue.createdAt)
    .all();
}

export function getRunningTask(db: Db, projectId: number) {
  return db.select().from(taskQueue)
    .where(and(eq(taskQueue.projectId, projectId), eq(taskQueue.status, 'running')))
    .get();
}

// Plural variant used at startup to detect orphaned tasks left in 'running'
// after a crash/restart. Should usually return 0 or 1; more is defensive.
export function getRunningTasksByProject(db: Db, projectId: number) {
  return db.select().from(taskQueue)
    .where(and(eq(taskQueue.projectId, projectId), eq(taskQueue.status, 'running')))
    .orderBy(taskQueue.createdAt)
    .all();
}

export function insertTask(db: Db, data: typeof taskQueue.$inferInsert) {
  return db.insert(taskQueue).values(data).returning().get();
}

export function updateTask(db: Db, id: number, data: Partial<typeof taskQueue.$inferInsert>) {
  return db.update(taskQueue).set(data).where(eq(taskQueue.id, id)).returning().get();
}

export function getRecentTasks(db: Db, projectId: number, limit = 5) {
  return db.select().from(taskQueue)
    .where(eq(taskQueue.projectId, projectId))
    .orderBy(desc(taskQueue.createdAt))
    .limit(limit)
    .all();
}

export function getTaskById(db: Db, id: number) {
  return db.select().from(taskQueue).where(eq(taskQueue.id, id)).get();
}

export function getTasksSince(db: Db, since: Date) {
  return db.select().from(taskQueue)
    .where(gte(taskQueue.createdAt, since))
    .orderBy(taskQueue.createdAt)
    .all();
}

export function cancelPendingTasks(db: Db, projectId: number) {
  return db.update(taskQueue)
    .set({ status: 'cancelled' })
    .where(and(eq(taskQueue.projectId, projectId), eq(taskQueue.status, 'pending')))
    .run();
}
