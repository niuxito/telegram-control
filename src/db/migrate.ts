import type Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Db } from './client.js';

// Same location from src/db (tsx, tests) and dist/db (build): <repo>/drizzle
export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

const INITIAL_MIGRATION = '0000_initial.sql';

// Columns added by hand before migrations existed. Old databases may lack any of them.
const LEGACY_COLUMNS = [
  `ALTER TABLE projects ADD COLUMN wake_word TEXT`,
  `ALTER TABLE projects ADD COLUMN model TEXT`,
  `ALTER TABLE projects ADD COLUMN qa_enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE projects ADD COLUMN budget_usd REAL`,
  `ALTER TABLE projects ADD COLUMN default_agent TEXT NOT NULL DEFAULT 'claude'`,
  `ALTER TABLE claude_sessions ADD COLUMN checkpoint_baseline_cost_usd REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE claude_sessions ADD COLUMN checkpoint_baseline_message_count INTEGER NOT NULL DEFAULT 0`,
];

function hasTable(sqlite: Database.Database, name: string): boolean {
  return Boolean(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/**
 * Databases created before migrations existed have the tables but no
 * migration history. Bring them up to the initial schema and record the
 * initial migration as applied, so drizzle only runs what comes after it.
 */
export function baselineLegacyDb(sqlite: Database.Database): boolean {
  if (!hasTable(sqlite, 'projects') || hasTable(sqlite, '__drizzle_migrations')) return false;

  const initialSql = readFileSync(path.join(MIGRATIONS_FOLDER, INITIAL_MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    // Legacy tables declare UNIQUE inline, so the separate unique indexes would be duplicates
    .filter(stmt => !/^\s*CREATE (UNIQUE )?INDEX/.test(stmt))
    .map(stmt => stmt.replace(/CREATE TABLE `/g, 'CREATE TABLE IF NOT EXISTS `'));

  const [initial] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  sqlite.transaction(() => {
    for (const stmt of initialSql) if (stmt.trim()) sqlite.exec(stmt);
    for (const stmt of LEGACY_COLUMNS) {
      try { sqlite.exec(stmt); } catch { /* column already exists */ }
    }
    sqlite.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
    sqlite.prepare(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`).run(initial.hash, initial.folderMillis);
  })();
  return true;
}

export function runMigrations(db: Db, sqlite: Database.Database): void {
  if (baselineLegacyDb(sqlite)) console.log('[Startup] Existing database baselined to the initial migration');
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
