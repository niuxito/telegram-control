# Security

Telegram Control gives an AI agent a shell on your machine and lets you drive it from a chat. Understand what that means before you install it.

## Threat model

**Agents run unattended with full permissions.** Claude Code, Codex and OpenCode are started with their permission prompts disabled (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`), as the user that runs the bot. They can read and write any file that user can, run any command, and use any credential it has: SSH keys, `gh`, `vercel`, cloud CLIs, browser profiles.

**Untrusted content can steer an agent (prompt injection).** An agent reads the code, issues, diffs and files it works on. A cloned repository, a pull request or an issue written by someone else can contain instructions that the agent follows. Treat every task on content you do not control as running that content's author's commands.

**The bot's own secrets are kept out of reach.** `BOT_TOKEN`, `API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are removed from the environment after the configuration is read, so agents, `npm test` and other child processes do not inherit them. Anything else the agent's user can access (files, CLI logins) is still reachable.

**Your Telegram account is the key.** Only `OWNER_USER_ID` can start tasks. Whoever controls that account controls the machine. Enable Telegram two-step verification and keep the bot token secret.

**Guests are read-only.** Guests can only run status commands and press the project status button. Every other command and button is owner-only by default.

**The HTTP API exposes project paths and live task output.** It listens on `127.0.0.1` by default. On any other interface it refuses to start without `API_KEY`. Put it behind TLS if you expose it beyond your machine.

## Recommendations

- Run the bot as a **dedicated user** (or in a container or VM) that only has the credentials it needs. Do not run it as your main account on a machine with sensitive data.
- Use scoped tokens: a fine-grained GitHub token limited to the repos you manage, a Vercel token limited to the projects you deploy.
- Be careful with `/clone` and `/review` on repositories and pull requests from people you do not trust.
- Keep the bot, the agent CLIs and Node up to date.

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/niuxito/telegram-control/security/advisories/new) and include steps to reproduce. You will get a reply within a week.
