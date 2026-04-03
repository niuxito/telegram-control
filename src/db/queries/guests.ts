import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guests, accessRequests } from '../schema.js';

export function addGuest(db: Db, userId: number, note?: string) {
  return db.insert(guests).values({ userId, note }).onConflictDoUpdate({
    target: guests.userId,
    set: { note },
  }).returning().get();
}

export function removeGuest(db: Db, userId: number) {
  return db.delete(guests).where(eq(guests.userId, userId)).run();
}

export function getGuest(db: Db, userId: number) {
  return db.select().from(guests).where(eq(guests.userId, userId)).get();
}

export function listGuests(db: Db) {
  return db.select().from(guests).all();
}

export function upsertAccessRequest(db: Db, userId: number, username: string | undefined, fullName: string | undefined) {
  return db.insert(accessRequests)
    .values({ userId, username, fullName })
    .onConflictDoUpdate({
      target: accessRequests.userId,
      set: { username, fullName, status: 'pending', resolvedAt: null, requestedAt: new Date() },
    })
    .returning()
    .get();
}

export function getAccessRequest(db: Db, userId: number) {
  return db.select().from(accessRequests).where(eq(accessRequests.userId, userId)).get();
}

export function getPendingRequests(db: Db) {
  return db.select().from(accessRequests).where(eq(accessRequests.status, 'pending')).all();
}

export function resolveAccessRequest(db: Db, userId: number, status: 'approved' | 'denied') {
  return db.update(accessRequests)
    .set({ status, resolvedAt: new Date() })
    .where(eq(accessRequests.userId, userId))
    .run();
}
