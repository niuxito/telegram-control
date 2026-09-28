# telegram-control

## Project Overview
Telegram-based control center for running agent tasks per project.

## Instructions
- Follow best practices for this project type
- Keep changes focused and well-tested
- Document significant decisions

---
## Checkpoint 2026-09-25

Checkpoint written to `CLAUDE.md`, replacing the 2026-09-24 block per the single-latest-checkpoint convention. Covers the restart mechanics, the finding that this session runs as a child of the bot process, the graceful-shutdown timeout that forced a `kill -9`, and the two open issues (`BOT_COMMAND_INVALID`, `stopAll()` hang).
