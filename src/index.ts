import { runWizard } from './setup/wizard.js';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
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
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Last-line-of-defense safety net, registered at module load so it covers startup.
// A rejected promise is usually a transient failure (Telegram 5xx, network blip),
// so the bot stays up. An uncaught exception leaves the process in an unknown
// state (e.g. the API failed to bind its port), so exit and let the supervisor
// (systemd: Restart=always) start a clean process.
process.on('uncaughtException', (err) => {
  console.error('[Process] uncaughtException — exiting:', err);
  process.exit(1);
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

  runMigrations(db, sqlite);
  console.log('[Startup] Database migrations applied');

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
  startApiServer(projectManager, db, config.API_PORT, config.API_HOST, config.API_KEY);

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
