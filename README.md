# Telegram Control

An AI agent orchestrator you drive from Telegram. Every project is a topic in a Telegram supergroup: send a message, an agent (Claude Code, Codex or OpenCode) works on the repo, commits, can deploy, and reports back in the same topic.

[Leer en español](README.es.md)

## Why

Working with AI coding agents meant opening a terminal, picking the right project, starting the task and waiting in front of the screen. With several projects active at once, the context switching was the real cost. Telegram Control turns each project into a chat topic: start a task from your phone, follow its progress live and review the result when you can, without keeping a laptop open.

## Features

- **One topic per project.** Plain messages in a project topic become tasks for that project.
- **Per-project task queue.** Tasks run in order, with history, status, cost and full logs (`/queue`, `/tasklist`, `/tasklog`).
- **Pluggable agents.** Claude Code, Codex or OpenCode per project or per task, with persistent sessions to keep context and control cost.
- **Session checkpoints.** Summarise the work done and reset the context without losing the thread.
- **Reviews and issues.** Review the current diff or a PR, and create issues through a planning agent.
- **Schedules.** Run a prompt on a cron expression.
- **Notifications.** File changes and new git commits are reported in the project topic.
- **Deploys from the chat.** Push to GitHub and deploy to Vercel without leaving Telegram.
- **Guests.** Give other people read-only access to project status.
- **HTTP + SSE API** to watch agents from other tools (see [API.md](API.md)).

Send `/help` in the group for the full command list.

## Requirements

- Node.js 20+ and build tools for `better-sqlite3` (`build-essential`, `python3` on Debian/Ubuntu).
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and a supergroup with **topics enabled**, with the bot as admin.
- At least one agent CLI, installed and logged in as the user that runs the bot: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude login`), and optionally Codex or OpenCode.
- Optional: `gh` (GitHub CLI) and `vercel` for issues, PRs and deploys.

Any machine with Node works. A Raspberry Pi is a good always-on host, but not a requirement.

## Getting started

```bash
git clone https://github.com/niuxito/telegram-control.git
cd telegram-control
npm install
cp .env.example .env   # fill in the values below
npm run build
npm start
```

On first start a setup check verifies Node, dependencies, agent CLIs and `.env`, and tells you how to fix anything missing (it creates `.env` from `.env.example` if there is none). Run it again at any time with `npm run setup`.

### Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token → `BOT_TOKEN`.
2. Create a group, open its settings and enable **Topics** (this turns it into a supergroup).
3. Add the bot to the group as **admin** with the *Manage topics* and *Delete messages* rights. Admins receive every message in the group, so privacy mode does not get in the way.
4. Create a topic for new projects, for example "New Projects", and send any message in it.
5. Get the IDs from that message: in Telegram Desktop or Web, right-click the message → *Copy Message Link*. It looks like `https://t.me/c/1234567890/5/12`:
   - `SUPERGROUP_ID` is `-100` followed by the first number: `-1001234567890`
   - `NEW_PROJECTS_TOPIC_ID` is the second number: `5`
6. Get your own user ID by messaging [@userinfobot](https://t.me/userinfobot) → `OWNER_USER_ID`.

### Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | Token from @BotFather |
| `SUPERGROUP_ID` | yes | ID of the supergroup (negative number) |
| `NEW_PROJECTS_TOPIC_ID` | yes | Thread ID of the topic used to create and import projects |
| `OWNER_USER_ID` | yes | Your Telegram user ID. Only this user can run tasks |
| `ANTHROPIC_API_KEY` | no | Only if you use the Anthropic API instead of a Claude account |
| `OPENAI_API_KEY` | no | Enables voice messages (Whisper) |
| `PROJECTS_BASE_DIR` | no | Where projects live (default `~/projects`) |
| `API_HOST` / `API_PORT` / `API_KEY` | no | HTTP API. Listens on `127.0.0.1:3001` by default; any other host requires `API_KEY` |

### Run as a service

[`scripts/telegram-control.service`](scripts/telegram-control.service) is a systemd **user** service that restarts the bot on failure. Installation steps are in the file.

## Security

Agents run with their permission prompts disabled, as your user, on your machine. Read [SECURITY.md](SECURITY.md) before you install it.

## Development

```bash
npm run dev          # watch mode
npm test             # vitest
npx tsc --noEmit     # type check
npm run db:generate  # create a migration after changing src/db/schema.ts
```

Migrations live in [`drizzle/`](drizzle) and run on startup. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a map of the code and the areas where help is welcome.

Stack: TypeScript · [grammY](https://grammy.dev) · SQLite + [Drizzle ORM](https://orm.drizzle.team) · chokidar · simple-git · node-cron.

## License

[MIT](LICENSE)
