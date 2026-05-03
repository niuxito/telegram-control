# telegram-control

## Project Overview
This project is managed via Telegram Control Center.

## Instructions
- Follow best practices for this project type
- Keep changes focused and well-tested
- Document significant decisions

---
## Checkpoint 2026-05-01

## Session 2026-05-01

### Key decisions
- **Shared conversation history**: stored full agent responses in DB (no truncation at save). Inject in prompts using intelligent extraction (extracts numbered/bulleted/header lines first, head+tail fallback for unstructured text). USER limit 400 chars, AGENT limit 2000 chars, total cap 6000.
- **Context window**: iterate newest→oldest when building context so when char cap hits, oldest messages drop (not newest).
- **Header instruction**: relaxed from "FORBIDDEN" to "Do NOT query DB for conversation history" — preserves Codex's filesystem access for legitimate work.
- **Checkpoint flow**: summarize-then-reset pattern. Current session generates the summary (via `runCliTask`), gets appended as dated markdown section to CLAUDE.md, then `claude_session_id` is cleared so next task starts fresh.

### Codebase changes
- `src/db/queries/topicMessages.ts`: added `extractAgentSummary()` for structured-content preservation; fixed iteration direction in `buildConversationContext()`.
- `src/claude/ClaudeSession.ts`: removed 2000-char save cap on Claude/Codex responses; added `checkpoint()` method that runs sync (bypasses queue), appends to CLAUDE.md, resets session ID.
- `src/bot/handlers/topic/config.ts`: added `/checkpoint` command (with diagnostic logging); added `/note` family (`add`, `list`, `delete`, `clear`).
- `src/bot/handlers/topic/tasks.ts`: added `/review` command (current diff or `gh pr diff`).
- `src/db/queries/projectNotes.ts`: new — CRUD for `project_notes`.
- `src/db/schema.ts`, `src/index.ts`, `src/__tests__/helpers/testDb.ts`: schema additions for `project_notes`, `topic_messages`.
- `src/bot/handlers/commands.ts`: help text updated for new commands.

### Findings & gotchas
- **Build is required for production**: bot runs `node dist/index.js`, so source edits don't apply until `npm run build` + restart. `tsx watch` is dev-only.
- Tests: 298/298 passing. No test coverage for `/checkpoint`, `/review`, `/note` yet.

### Pending
- Verify `/checkpoint` end-to-end after rebuild + restart.
- Add tests for new commands.
- Pending features: log streaming during long tasks, git event triggers, queue rehydration on restart (Codex's improvement #1).

---

¿Quieres que lo añada yo directamente a CLAUDE.md, o prefieres copiarlo manualmente?

---
## Checkpoint 2026-05-01

## Session 2026-05-01 (continuación)

### Key decisions
- **Markdown failure handling en `/checkpoint`**: elegido el patrón "reintentar sin Markdown" (igual que `ClaudeSession.editMessage`) en lugar de quitar el formato siempre — preserva el render cuando el preview sí es válido.
- **Mensajes de error diferenciados**: cuando `session.checkpoint()` ya escribió el fichero pero la edición posterior falla, ahora se muestra "⚠️ Checkpoint saved but failed to display summary" en vez de "❌ Checkpoint failed". Evita la confusión de creer que no se hizo nada cuando CLAUDE.md sí quedó modificado.

### Findings
- Bug raíz del falso "❌ Checkpoint failed": el `preview` se truncaba a 800 chars y, si el corte caía dentro de un bloque de código o dejaba `*`/`_` sin pareja, Telegram rechazaba el mensaje con `parse_mode: 'Markdown'` → saltaba al `catch` aunque el archivo y el reset de sesión ya estaban hechos.
- Mismo patrón de fallo ya estaba mitigado en `ClaudeSession.ts:120-133` para mensajes normales; el handler de `/checkpoint` no lo hacía.
- Falsa alarma anterior: `pgrep` ejecutado en la máquina de desarrollo, no en la Pi. Confirmado que si el bot responde por Telegram, está corriendo — no volver a "diagnosticar" que está caído desde aquí.

### Codebase changes
- `src/bot/handlers/topic/config.ts:71-96`: añadido try/catch interno alrededor del `editMessageText` con Markdown que reintenta como texto plano; flag `checkpointDone` para diferenciar el mensaje de error final.

### Pending
- **Reiniciar el bot en la Pi** y verificar `/checkpoint` end-to-end con el fix nuevo.
- Tests para `/checkpoint`, `/review`, `/note` (sigue pendiente del checkpoint anterior).
- Log streaming durante tareas largas, git event triggers, queue rehydration on restart (Codex's improvement #1).
