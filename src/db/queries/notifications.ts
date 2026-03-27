import type { Db } from '../client.js';
import { notificationLog } from '../schema.js';

export function insertNotification(db: Db, data: typeof notificationLog.$inferInsert) {
  return db.insert(notificationLog).values(data).returning().get();
}
