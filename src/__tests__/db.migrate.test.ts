import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { runMigrations } from '../db/migrate.js';

function open() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const tables = (sqlite: Database.Database) =>
  sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r: any) => r.name);
const columns = (sqlite: Database.Database, table: string) =>
  sqlite.prepare(`PRAGMA table_info('${table}')`).all().map((c: any) => c.name);
const migrationCount = (sqlite: Database.Database) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM "__drizzle_migrations"`).get() as any).n;

describe('runMigrations', () => {
  it('creates every schema table on a fresh database', () => {
    const { sqlite, db } = open();
    runMigrations(db, sqlite);
    expect(tables(sqlite)).toEqual(expect.arrayContaining([
      'projects', 'claude_sessions', 'task_queue', 'local_issues', 'schedules', 'access_requests',
      'guests', 'project_notes', 'ideas', 'idea_entries', 'topic_messages', 'notification_log', '__drizzle_migrations',
    ]));
    expect(migrationCount(sqlite)).toBe(1);
  });

  it('is idempotent', () => {
    const { sqlite, db } = open();
    runMigrations(db, sqlite);
    runMigrations(db, sqlite);
    expect(migrationCount(sqlite)).toBe(1);
  });

  it('baselines a legacy database without losing data', () => {
    const { sqlite, db } = open();
    // Shape of a database from before wake_word/model/... and the later tables existed
    sqlite.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, local_path TEXT NOT NULL,
        topic_id INTEGER UNIQUE, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, archived_at INTEGER,
        watch_files INTEGER NOT NULL DEFAULT 1, watch_git INTEGER NOT NULL DEFAULT 1, git_check_at INTEGER);
      CREATE TABLE claude_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
        claude_session_id TEXT, mode TEXT NOT NULL DEFAULT 'cli', total_cost_usd REAL NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL);
      INSERT INTO projects (name, local_path, topic_id, created_at) VALUES ('demo', '/tmp/demo', 10, 1);
    `);

    runMigrations(db, sqlite);

    expect(columns(sqlite, 'projects')).toEqual(expect.arrayContaining(['wake_word', 'model', 'budget_usd', 'default_agent']));
    expect(columns(sqlite, 'claude_sessions')).toEqual(expect.arrayContaining(['checkpoint_baseline_cost_usd']));
    expect(tables(sqlite)).toEqual(expect.arrayContaining(['ideas', 'idea_entries', 'topic_messages', 'project_notes']));
    expect(sqlite.prepare(`SELECT name, default_agent FROM projects`).all()).toEqual([{ name: 'demo', default_agent: 'claude' }]);
    expect(migrationCount(sqlite)).toBe(1);
  });
});
