import { eq, and } from 'drizzle-orm';
import type { Db } from '../client.js';
import { schedules } from '../schema.js';

export function insertSchedule(db: Db, data: { projectId: number; cronExpr: string; prompt: string }) {
  return db.insert(schedules).values(data).returning().get();
}

export function getSchedulesByProject(db: Db, projectId: number) {
  return db.select().from(schedules).where(eq(schedules.projectId, projectId)).all();
}

export function getAllEnabledSchedules(db: Db) {
  return db.select().from(schedules).where(eq(schedules.enabled, true)).all();
}

export function deleteSchedule(db: Db, id: number, projectId: number) {
  return db.delete(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.projectId, projectId)))
    .run();
}

export function updateScheduleLastRun(db: Db, id: number) {
  return db.update(schedules).set({ lastRunAt: new Date() }).where(eq(schedules.id, id)).run();
}

export function setScheduleEnabled(db: Db, id: number, projectId: number, enabled: boolean) {
  return db.update(schedules)
    .set({ enabled })
    .where(and(eq(schedules.id, id), eq(schedules.projectId, projectId)))
    .run();
}
