import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { projects } from '../schema.js';

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export function getProjectByTopicId(db: Db, topicId: number) {
  return db.select().from(projects).where(eq(projects.topicId, topicId)).get();
}

export function getProjectById(db: Db, id: number) {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function getProjectByName(db: Db, name: string) {
  return db.select().from(projects).where(eq(projects.name, name)).get();
}

export function getActiveProjects(db: Db) {
  return db.select().from(projects).where(inArray(projects.status, ['active', 'paused'])).all();
}

export function getAllProjects(db: Db) {
  return db.select().from(projects).all();
}

export function insertProject(db: Db, data: NewProject) {
  return db.insert(projects).values(data).returning().get();
}

export function updateProject(db: Db, id: number, data: Partial<NewProject>) {
  return db.update(projects).set(data).where(eq(projects.id, id)).returning().get();
}
