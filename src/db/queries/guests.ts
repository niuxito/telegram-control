import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guests } from '../schema.js';

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
