import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';

/**
 * Creates a fresh in-memory SQLite database with all tables created inline.
 * Each call returns a completely independent database instance.
 */
export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      topic_id INTEGER UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      watch_files INTEGER NOT NULL DEFAULT 1,
      watch_git INTEGER NOT NULL DEFAULT 1,
      git_check_at INTEGER,
      wake_word TEXT
    );

    CREATE TABLE IF NOT EXISTS claude_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      claude_session_id TEXT,
      mode TEXT NOT NULL DEFAULT 'cli',
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      live_message_id INTEGER,
      result TEXT,
      cost_usd REAL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      telegram_message_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      note TEXT,
      added_at INTEGER NOT NULL
    );
  `);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type TestDb = ReturnType<typeof createTestDb>['db'];
