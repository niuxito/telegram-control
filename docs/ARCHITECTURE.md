# Architecture

Telegram Control is a modular monolith: one Node.js process, one SQLite database, and the Telegram bot as the main interface. This page is a map for contributors.

## Request flow

1. A message arrives through grammY long polling.
2. Middleware runs in order: `bot/middleware/auth.ts` (owner, guests, supergroup only), then `bot/middleware/guestGuard.ts` (guests get an allowlist of read-only commands and buttons).
3. A handler in `bot/handlers/` matches the command or the plain text in a project topic.
4. Work for an agent goes through `ClaudeSession.queueTask()`, which stores it in `task_queue` and runs one task at a time per project.
5. The agent runs as a child process (Claude Code, Codex or OpenCode CLI) in the project directory. Its streamed output updates a live Telegram message and is emitted on the API's SSE stream.

## Layout

| Path | Responsibility |
|---|---|
| `src/index.ts` | Entry point: setup check first, then a dynamic import of `app.ts` (so a bad `.env` gets a readable error) |
| `src/app.ts` | Bootstrap: database, bot, middleware, handlers, API, schedules, project loading |
| `src/config.ts` | Validates `.env` with zod, then removes secrets from `process.env` so child processes cannot read them |
| `src/setup/` | First-run checks for Node, dependencies, agent CLIs and `.env`, and pairing (`/setup <code>`) that fills in the Telegram IDs |
| `src/bot/handlers/` | Telegram commands and callbacks, grouped by domain (`topic/tasks`, `topic/git`, `topic/config`, …) |
| `src/claude/` | `ClaudeSession` (per-project queue, sessions, checkpoints, cost) and the low-level CLI/API strategies and stream parsing |
| `src/agents/` | Registry of agent backends and the router that picks or falls back between them |
| `src/projects/` | `ProjectManager` (project lifecycle, sessions, watchers) and `ScheduleManager` (cron) |
| `src/watchers/` | File and git watchers. They only send notifications, they never start agents |
| `src/notifications/` | Formatting and sending of notifications |
| `src/api/` | Read-only HTTP + SSE API (see [API.md](../API.md)) |
| `src/db/` | Drizzle schema, queries and the migration runner |
| `drizzle/` | Generated SQL migrations, applied on startup |

## Persistence

`src/db/schema.ts` is the single source of truth. After changing it, run `npm run db:generate` and commit the new file in `drizzle/`. Migrations run on startup; tests build their in-memory database from the same migrations. Databases created before migrations existed are baselined automatically (`src/db/migrate.ts`).

## Process model

The bot is meant to run under a supervisor (see `scripts/telegram-control.service`). Uncaught exceptions and API server errors exit the process so it restarts clean; rejected promises are logged and survived because they are usually transient network errors.

## Where help is welcome

- **Large handlers.** `claude/ClaudeSession.ts` (~760 lines), `bot/handlers/topic/tasks.ts` (~650), `bot/handlers/commands.ts` and `bot/handlers/topic/config.ts` mix command parsing, business logic, persistence and message formatting. Moving the logic into services would make it easier to test and to add commands.
- **Permissions next to commands.** The guest allowlist lives apart from the command registrations. Declaring the required role where each command and button is registered, with a test that fails when one is missing, would remove that drift.
- **In-memory state.** Pending secrets, confirmations and similar flows live in `Map`s and are lost on restart.
- **Typing.** About 30 `any` in non-test code, mostly around grammY contexts.
- **Message editing.** Chunking, editing and the fallback to new messages are implemented in more than one place.
- **Unused column.** `projects.qa_enabled` is never read.
