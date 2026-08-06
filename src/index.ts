import { runWizard } from './setup/wizard.js';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { createBot } from './bot/bot.js';
import { ProjectManager } from './projects/ProjectManager.js';
import { createRouter } from './bot/router.js';
import { createAuthMiddleware } from './bot/middleware/auth.js';
import { guestGuard } from './bot/middleware/guestGuard.js';
import { setupGlobalCommands, registerBotCommands } from './bot/handlers/commands.js';
import { setupNewProjectHandler } from './bot/handlers/newProject.js';
import { setupProjectTopicHandlers, getPendingSecret, clearPendingSecret } from './bot/handlers/projectTopic.js';
import { setupCallbackHandlers } from './bot/handlers/callbacks.js';
import { setupVoiceHandler } from './bot/handlers/voice.js';
import { setupFileHandler } from './bot/handlers/file.js';
import { startApiServer } from './api/server.js';
import { ScheduleManager } from './projects/ScheduleManager.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Last-line-of-defense safety net. Every known error path is caught locally;
// these handlers exist so a single transient failure (Telegram 5xx, network
// blip, etc.) does not kill the long-running bot process. Registered at module
// load so they cover startup errors too.
process.on('uncaughtException', (err) => {
  console.error('[Process] uncaughtException — bot stays up:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection — bot stays up:', reason);
});

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
        git_check_at INTEGER,
        wake_word TEXT,
        model TEXT,
        qa_enabled INTEGER NOT NULL DEFAULT 1,
        budget_usd REAL,
        default_agent TEXT NOT NULL DEFAULT 'claude'
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

      CREATE TABLE IF NOT EXISTS notification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        telegram_message_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS idea_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        added_by INTEGER,
        added_by_name TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    console.log('[Startup] Tables created directly');
  }

  // Schema evolution for existing databases — idempotent, safe to re-run
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN wake_word TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN model TEXT`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN qa_enabled INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN budget_usd REAL`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN default_agent TEXT NOT NULL DEFAULT 'claude'`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS project_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), text TEXT NOT NULL, created_at INTEGER NOT NULL)`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS topic_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), sender TEXT NOT NULL, sender_name TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL)`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, added_by INTEGER, added_by_name TEXT, created_at INTEGER NOT NULL)`); } catch { /* already exists */ }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS idea_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, text TEXT NOT NULL, added_by INTEGER, added_by_name TEXT, created_at INTEGER NOT NULL)`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE claude_sessions ADD COLUMN checkpoint_baseline_cost_usd REAL NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE claude_sessions ADD COLUMN checkpoint_baseline_message_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

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

  // Private DM handler for /secret flow — must be registered BEFORE projectTopic handlers
  // because the projectTopic message:text handler doesn't call next() and would swallow DMs.
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') { await next(); return; }
    const userId = ctx.from?.id;
    if (!userId || userId !== config.OWNER_USER_ID) { await next(); return; }

    const pending = getPendingSecret(userId);
    if (!pending) { await next(); return; }

    clearPendingSecret(userId);

    // Delete the DM immediately so the secret is not stored in Telegram
    try { await ctx.deleteMessage(); } catch { /* may fail if already gone */ }

    const session = projectManager.getSession(pending.projectId);
    if (!session) {
      await ctx.reply('⚠️ Project session not found. Secret was not sent.');
      return;
    }

    await session.queueTask(ctx.message.text);

    // Confirm in the original project topic (without showing the secret)
    try {
      await bot.api.sendMessage(
        pending.chatId,
        '🔒 Secret received and queued as a task. The message has been deleted.',
        { message_thread_id: pending.topicId }
      );
    } catch { /* non-fatal */ }

    await ctx.reply('✅ Secret delivered to the project. Your message has been deleted.');
  });

  setupProjectTopicHandlers(bot, projectManager, db, scheduleManager);
  setupCallbackHandlers(bot, projectManager, db);
  setupVoiceHandler(bot, projectManager, db);
  setupFileHandler(bot, projectManager, db);

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

  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] ${signal} received — stopping gracefully...`);
    try {
      bot.stop();
    } catch { /* already stopped */ }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Register commands with Telegram so they appear in the "/" autocomplete menu.
  // Failure here is non-fatal — the bot still works without the menu hint.
  try {
    await registerBotCommands(bot);
    console.log('[Startup] Bot commands registered with Telegram');
  } catch (err) {
    console.warn('[Startup] Failed to register bot commands:', err instanceof Error ? err.message : err);
  }

  console.log('[Startup] Starting bot (long-polling)...');
  await bot.start({
    onStart: () => console.log('[Bot] Running!'),
  });

  // bot.start() resolves when bot.stop() is called — clean up remaining resources
  console.log('[Shutdown] Bot stopped. Cleaning up...');
  scheduleManager.stop();
  await projectManager.stopAll();
  sqlite.close();
  console.log('[Shutdown] Done.');
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
