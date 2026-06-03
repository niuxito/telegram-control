import { desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { ideaEntries, ideas } from '../schema.js';

export type Idea = typeof ideas.$inferSelect;
export type IdeaEntry = typeof ideaEntries.$inferSelect;
export type IdeaWithEntryCount = Idea & { entryCount: number };

type IdeaMeta = { addedBy?: number; addedByName?: string; createdAt?: Date };

function normalizeIdeaMeta(opts?: IdeaMeta) {
  return {
    addedBy: opts?.addedBy ?? null,
    addedByName: opts?.addedByName ?? null,
    ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
  };
}

export function insertIdea(
  db: Db,
  text: string,
  opts?: IdeaMeta,
): Idea {
  return db.insert(ideas).values({
    text,
    ...normalizeIdeaMeta(opts),
  }).returning().get();
}

export function appendIdeaEntry(
  db: Db,
  ideaId: number,
  text: string,
  opts?: IdeaMeta,
): IdeaEntry | undefined {
  const idea = getIdeaById(db, ideaId);
  if (!idea) return undefined;

  return db.insert(ideaEntries).values({
    ideaId,
    text,
    ...normalizeIdeaMeta(opts),
  }).returning().get();
}

export function getIdeaById(db: Db, ideaId: number): Idea | undefined {
  return db.select().from(ideas).where(eq(ideas.id, ideaId)).get();
}

export function getIdeaEntries(db: Db, ideaId: number): IdeaEntry[] {
  return db
    .select()
    .from(ideaEntries)
    .where(eq(ideaEntries.ideaId, ideaId))
    .orderBy(ideaEntries.createdAt)
    .all();
}

export function getIdeaThread(db: Db, ideaId: number) {
  const idea = getIdeaById(db, ideaId);
  if (!idea) return undefined;
  return {
    idea,
    entries: getIdeaEntries(db, ideaId),
  };
}

export function getRecentIdeas(db: Db, limit = 20) {
  const items = db
    .select()
    .from(ideas)
    .orderBy(desc(ideas.createdAt))
    .limit(limit)
    .all()
    .reverse();

  const counts = db
    .select({
      ideaId: ideaEntries.ideaId,
      count: ideaEntries.id,
    })
    .from(ideaEntries)
    .all()
    .reduce<Map<number, number>>((map, row) => {
      map.set(row.ideaId, (map.get(row.ideaId) ?? 0) + 1);
      return map;
    }, new Map());

  return items.map(item => ({
    ...item,
    entryCount: counts.get(item.id) ?? 0,
  })) satisfies IdeaWithEntryCount[];
}

export function deleteIdea(db: Db, ideaId: number): boolean {
  db.delete(ideaEntries).where(eq(ideaEntries.ideaId, ideaId)).run();
  const result = db.delete(ideas).where(eq(ideas.id, ideaId)).run();
  return result.changes > 0;
}

export function clearIdeas(db: Db): number {
  db.delete(ideaEntries).run();
  const result = db.delete(ideas).run();
  return result.changes;
}
