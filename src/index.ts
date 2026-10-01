// Entry point. The setup check must run before anything imports config.ts,
// which exits on an invalid .env, so it can explain how to fix it first.
// The rest of the bot is loaded afterwards with a dynamic import.
import { runWizard } from './setup/wizard.js';

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

const shouldStart = await runWizard();
if (!shouldStart) process.exit(0);

const { startApp } = await import('./app.js');
await startApp().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
