import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';
import { runMigrations } from '../../db/migrate.js';

/**
 * Creates a fresh in-memory SQLite database built from the real migrations.
 * Each call returns a completely independent database instance.
 */
export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  runMigrations(db, sqlite);
  return { db, sqlite };
}

export type TestDb = ReturnType<typeof createTestDb>['db'];
