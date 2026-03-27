import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'fs';
import { config } from '../config.js';
import * as schema from './schema.js';
import path from 'path';

export function createDb() {
  const dataDir = config.DATA_DIR.replace('~', process.env.HOME || '');
  mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'control.db');
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type Db = ReturnType<typeof createDb>['db'];
