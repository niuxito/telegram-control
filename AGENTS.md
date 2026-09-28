# telegram-control — context for AI coding agents

## What this project is
A Telegram bot that acts as a control center for running AI coding agent tasks
across multiple software projects. Each project gets a Telegram forum topic; the
bot routes user messages to Claude CLI, Codex CLI, or OpenCode and streams
results back to the chat.

## Key architectural decisions
- **Agent strategies** (`src/agents/`) implement a common `AgentStrategy`
  interface. Adding a new agent means adding a file there and registering it in
  `src/agents/index.ts`.
- **Codex stderr is never forwarded to the user** — it contains internal
  evaluation prompts. Only JSON-extracted text from stdout goes to Telegram.
- **Project-internal tasks never auto-degrade** to free-tier agents that may
  train on data. See `src/agents/router.ts` for the sensitivity model.
- **ClaudeSession** manages a persistent Claude CLI process per project; Codex
  and OpenCode are ephemeral (spawned per task).

## Tech stack
- Runtime: Node.js 22+ with ESM (`"type": "module"`)
- Language: TypeScript 5 (strict mode, `noUncheckedIndexedAccess`)
- Bot framework: grammY
- Database: SQLite via better-sqlite3 + Drizzle ORM
- Test runner: Vitest

## Common commands
```
npm run build   # tsc → dist/
npm test        # vitest run
npm run dev     # tsx watch src/index.ts
```

## Sensitive areas
- `src/claude/CodexStrategy.ts` — Codex CLI integration. Avoid leaking stderr.
- `src/agents/router.ts` — privacy routing. Never route `project-internal`
  tasks to free/data-retaining providers without explicit user consent.
- `.env` — never commit. Credentials are in Vercel Env Variables for any
  deployed sub-projects; for this bot they stay in `.env` on the host machine.

## Additional context files
- `docs/agents/opencode.md` — OpenCode CLI integration research (pre-implementation).
- `docs/agents/vercel-context.md` — Vercel best practices (only relevant when
  working on a sub-project that deploys to Vercel).
- `API.md` — REST API exposed by this bot.
- `CLAUDE.md` — session checkpoints and per-session notes.
