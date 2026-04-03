import { runWizard } from './setup/wizard.js';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { createBot } from './bot/bot.js';
import { ProjectManager } from './projects/ProjectManager.js';
import { createRouter } from './bot/router.js';
import { createAuthMiddleware } from './bot/middleware/auth.js';
import { guestGuard } from './bot/middleware/guestGuard.js';
import { setupGlobalCommands } from './bot/handlers/commands.js';
import { setupNewProjectHandler } from './bot/handlers/newProject.js';
import { setupProjectTopicHandlers } from './bot/handlers/projectTopic.js';
import { setupCallbackHandlers } from './bot/handlers/callbacks.js';
import { setupVoiceHandler } from './bot/handlers/voice.js';
import { startApiServer } from './api/server.js';
import { ScheduleManager } from './projects/ScheduleManager.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 0. Run setup wizard (skipped automatically after first successful run)
  const shouldStart = await runWizard();
  if (!shouldStart) process.exit(0);

  console.log('[Startup] Initializing Telegram Control Center...');

  // 1. Create DB and run migrations
  const { db, sqlite } = createDb();

  // Run migrations if migrations folder exists
  try {
    migrate(db, { migrationsFolder: path.join(__dirname, 'db/migrations') });
    console.log('[Startup] Database migrations applied');
  } catch (_err) {
    // Migrations may not exist yet on first run; create tables manually
    console.log('[Startup] No migrations found, using push mode');
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
        git_check_at INTEGER
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

      CREATE TABLE IF NOT EXISTS local_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        username TEXT,
        full_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        note TEXT,
        added_at INTEGER NOT NULL
      );
    `);
    console.log('[Startup] Tables created directly');
  }

  // Schema evolution — idempotent column additions and table creation
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN wake_word TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS local_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, closed_at INTEGER)`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_run_at INTEGER)`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, username TEXT, full_name TEXT, status TEXT NOT NULL DEFAULT 'pending', requested_at INTEGER NOT NULL, resolved_at INTEGER)`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, note TEXT, added_at INTEGER NOT NULL)`); } catch { /* already exists */ }

  // 2. Create bot
  const bot = createBot();

  // 3. ProjectManager
  const projectManager = new ProjectManager(db, bot);

  // 4. Setup middleware
  bot.use(createAuthMiddleware(db));
  bot.use(guestGuard);
  bot.use(createRouter(projectManager));

  // 5. Setup handlers
  const scheduleManager = new ScheduleManager(db, projectManager);
  setupGlobalCommands(bot, projectManager, db);
  setupNewProjectHandler(bot, projectManager);
  setupProjectTopicHandlers(bot, projectManager, db, scheduleManager);
  setupCallbackHandlers(bot, projectManager, db);
  setupVoiceHandler(bot, projectManager, db);

  // 6. Start API server
  startApiServer(projectManager, db, config.API_PORT, config.API_KEY);

  // 7. Load active projects (starts watchers)
  await projectManager.loadActiveProjects();

  // 8. Start schedule manager
  scheduleManager.start();

  // 9. Start bot
  bot.catch((err) => {
    console.error('[Bot Error]', err);
  });

  console.log('[Startup] Starting bot (long-polling)...');
  await bot.start({
    onStart: () => console.log('[Bot] Running!'),
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Shutdown] Stopping...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Shutdown] Stopping...');
  process.exit(0);
});

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
