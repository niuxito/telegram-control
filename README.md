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

**1. Telegram.** Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token. Create a group, enable **Topics** in its settings, add the bot as **admin** with the *Manage topics* and *Delete messages* rights, and create a topic for new projects (for example "New Projects").

**2. Install and start.**

```bash
git clone https://github.com/niuxito/telegram-control.git
cd telegram-control
npm install
npm run build
cp .env.example .env    # set BOT_TOKEN, leave the IDs empty
npm start
```

A setup check verifies Node, dependencies, agent CLIs and `.env`, and tells you how to fix anything missing. Run it again at any time with `npm run setup`.

**3. Pair.** With only `BOT_TOKEN` set, the bot prints a one-time code. Send `/setup <code>` inside the new-projects topic: the bot checks its rights, saves the group, topic and owner IDs to `.env`, and starts. Whoever sends the code becomes the owner.

**4. Keep it running** (Linux with systemd):

```bash
npm run install-service
```

It installs a systemd **user** service with `Restart=always`, using your current `PATH` so the agents find the same CLIs as your shell. Logs: `journalctl --user -u telegram-control -f`.

### Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | Token from @BotFather |
| `SUPERGROUP_ID` | set by pairing | ID of the supergroup (negative number) |
| `NEW_PROJECTS_TOPIC_ID` | set by pairing | Thread ID of the topic used to create and import projects |
| `OWNER_USER_ID` | set by pairing | Your Telegram user ID. Only this user can run tasks |
| `ANTHROPIC_API_KEY` | no | Only if you use the Anthropic API instead of a Claude account |
| `OPENAI_API_KEY` | no | Enables voice messages (Whisper) |
| `PROJECTS_BASE_DIR` | no | Where projects live (default `~/projects`) |
| `API_HOST` / `API_PORT` / `API_KEY` | no | HTTP API. Listens on `127.0.0.1:3001` by default; any other host requires `API_KEY` |

<details>
<summary>Setting the IDs by hand instead of pairing</summary>

- In Telegram Desktop or Web, right-click a message in the new-projects topic → *Copy Message Link*. It looks like `https://t.me/c/1234567890/5/12`: `SUPERGROUP_ID` is `-100` followed by the first number (`-1001234567890`) and `NEW_PROJECTS_TOPIC_ID` is the second (`5`).
- Get your user ID from [@userinfobot](https://t.me/userinfobot) → `OWNER_USER_ID`.

</details>

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
