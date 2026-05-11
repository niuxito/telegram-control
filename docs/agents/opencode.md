# OpenCode — research notes for telegram-control integration

> Status: research / pre-implementation. Sources at the bottom; everything
> below was extracted from official docs in May 2026.

## TL;DR for this project

- **OpenCode** is an MIT-licensed terminal/IDE/desktop coding agent (`opencode-ai`
  on npm) that is **provider-agnostic**. It can route to 75+ providers including
  Anthropic, OpenAI, Google, GitHub Copilot, local models, and its own curated
  gateway "Zen".
- It has a **headless `run` mode** (single prompt → stdout) and a **`serve`
  mode** that exposes an HTTP API (default `127.0.0.1:4096`) — both fit our
  spawn-and-collect or session-reuse patterns.
- Auth model is flexible: BYOK API keys, OAuth (GitHub Copilot, ChatGPT
  Plus/Pro), or **OpenCode Zen** which has a small set of **free models** plus
  paid SOTA models (GPT-5.x, Claude 4.x, Gemini 3.1 Pro, Qwen, etc.) on a
  centrally-billed wallet.
- Built-in **`plan`** agent is read-only and ideal for the "SOTA-for-planning"
  lane the user described; **`build`** is the default full-access agent and is
  the equivalent of Claude CLI / `codex exec`.

This makes OpenCode the natural place for two of our planned routing lanes:
**(a) cheap/systematic tasks on free Zen models** and **(b) planning/research
on SOTA models** — both without us having to wire individual provider SDKs.

---

## 1. What it is

> "A powerful AI coding agent. Built for the terminal." — github.com/sst/opencode

- **Repository**: `github.com/sst/opencode` (note: there's an older Go-flavoured
  fork at `github.com/opencode-ai/opencode`; the SST one is the one we want).
- **License**: MIT.
- **Distribution**:
  - npm: `npm i -g opencode-ai`
  - install script: `curl -fsSL https://opencode.ai/install | bash`
  - Homebrew, Scoop, Chocolatey, Pacman, Nix.
- **Binary name**: `opencode`.
- Privacy claim: "does not store any of your code or context data."

## 2. CLI surface relevant to us

Subcommands that matter for an automation host:

| Command | What it does |
|---------|--------------|
| `opencode run "<prompt>"` | Non-interactive: executes one prompt and prints the response. **This is our `runCodexTask` equivalent.** |
| `opencode serve` | Starts a local HTTP server (default `127.0.0.1:4096`) that exposes the full API. Lets us reuse sessions across many requests instead of spawning a fresh process each time. |
| `opencode session list / delete` | Manage persisted sessions. |
| `opencode export <id>` / `import` | Save / restore sessions as JSON. Useful for moving context between machines. |
| `opencode auth login / list / logout` | Provider credentials. |
| `opencode models` | Lists models available for current provider config. |
| `opencode stats` | Token usage and cost. |
| `opencode acp` | Agent Client Protocol over stdin/stdout (alternative to `serve` for IPC use). |

### `run` flags (from official `opencode.ai/docs/cli/`)

- `--format json` — machine-readable output. **Required** for our integration.
- `--model <provider>/<model>` — pin model per call. Example
  `--model anthropic/claude-sonnet-4-6` or `--model opencode-zen/big-pickle`.
- `--dir <path>` — working directory. Equivalent to our `cwd`.
- `--session <id>` — resume an existing session.
- `--continue` — continue the most recent session in the given directory.
- `--attach <url>` — execute against a running `opencode serve` instance
  instead of starting a fresh process.
- (Some older sources mention `-p` / `-f` / `-q`. Those are the legacy short
  flags; the long form `run --format json` is what the current docs show.)

### Concrete examples shown in docs

```
opencode run "Explain the use of context in Go"
opencode run --format json --dir /tmp/proj "Summarize this codebase"
opencode run --attach http://localhost:4096 "Explain async/await"
opencode run --continue "Now refactor the function we just discussed"
```

## 3. `serve` mode HTTP API

A daemon-friendly alternative to one-shot `run`. We could keep one
`opencode serve` per project (or one global) and POST messages to it.

**Start**:
```
OPENCODE_SERVER_PASSWORD=secret opencode serve --port 4096 --hostname 127.0.0.1
```
Auth is HTTP basic, username defaults to `opencode`, override with
`OPENCODE_SERVER_USERNAME`.

**Endpoints** (subset that matters):

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/global/health` | health + version |
| `GET`  | `/doc` | OpenAPI 3.1 spec — authoritative reference |
| `GET`  | `/provider` | list configured providers |
| `GET`/`PATCH` | `/config` | read/update config |
| `GET`  | `/session` | list sessions |
| `POST` | `/session` | create session |
| `DELETE` | `/session/:id` | delete session |
| `POST` | `/session/:id/message` | send prompt, wait for response |
| `POST` | `/session/:id/prompt_async` | fire-and-forget; returns 204 |
| `GET`  | `/session/:id/message` | list messages in session |
| `POST` | `/session/:id/command` | run a slash command |

The message body shape:
```json
{ "model": "...", "agent": "build", "system": "...", "tools": [...], "parts": [...] }
```

For our use: hit `POST /session/:id/message` with `parts: [{ type: "text", text: "<prompt>" }]`.

## 4. Tiers and how we'd use them

OpenCode unifies three independent things — *the agent runtime*, *the
authentication/billing*, and *the model* — and lets you mix any of them.

### Provider options

| Path | Auth | Billing | Notes |
|------|------|---------|-------|
| **OpenCode Zen** | sign in to opencode.ai → get API key → `opencode auth login zen` | Centrally billed wallet (auto-reload, monthly caps) | 40+ models including GPT-5.x, Claude 4.x, Gemini 3.1 Pro. **5 free models** (Big Pickle, MiniMax M2.5 Free, Ling 2.6 Flash, Hy3 Preview, Nemotron 3 Super) — "limited time" free during feedback collection. |
| **BYOK** (Anthropic / OpenAI / Google / etc.) | `opencode auth login <provider>` with own API key | Direct provider invoice | We can reuse the `ANTHROPIC_API_KEY` already in our `.env` to hit Claude via OpenCode without a Zen account. |
| **OAuth** (GitHub Copilot, ChatGPT Plus/Pro) | login flow | Subscription | Equivalent to how `codex exec` uses ChatGPT subscription today. |
| **Local models** | none / via Ollama or LM Studio | None | Privacy-first option, no quotas — but slow and limited capability. |

### Free / cheap lane that solves the "Vercel deploy ran out of quota" problem

The user's pain point was: a low-stakes deploy command failed because Claude
hit a quota. Two ways OpenCode addresses this *out of the box*:

1. **Zen free models** — pin a free Zen model (e.g. `--model opencode-zen/big-pickle`)
   for purely systematic invocations like running `gh repo create` or
   `vercel --prod`. These commands don't need SOTA reasoning; a 7B model that
   can call a tool reliably is enough.
2. **Local model fallback** — if even the free Zen tier is rate-limited or
   unavailable, configure a local Ollama model as the fallback for the
   "systematic" lane. Costs zero, never quota-blocked.

### SOTA lane for planning/research

The user's other request: SOTA for planning. OpenCode supports this two ways:

1. **`plan` built-in agent + SOTA model**. `opencode run --agent plan --model opencode-zen/gpt-5.5 "Plan the migration to Drizzle 0.40"` — read-only by default, suggests changes without writing.
2. **Custom agents**. JSON / Markdown agent definitions in
   `~/.config/opencode/agents/` or `.opencode/agents/`. Could ship a
   `research-deep.md` agent in our repo that pins Gemini 3.1 Pro (good for
   long context) for "investigate this codebase" tasks.

## 5. Built-in agents

Two ship by default and are selectable via `--agent` (or Tab in the TUI):

- **`build`** (default): full tool access. Equivalent to Claude CLI
  `--dangerously-skip-permissions` or `codex exec --dangerously-bypass-approvals-and-sandbox`.
- **`plan`**: file edits and bash require approval (`ask` mode). Good for
  read-only investigation, second opinions, code review.

Custom agents:
- **JSON config** in `opencode.json`
- **Markdown** in `~/.config/opencode/agents/<name>.md` (global) or
  `.opencode/agents/<name>.md` (project-local)
- Interactive: `opencode agent create`

A subagent can be invoked from a primary agent via `@` mention, or auto-routed
based on the subagent's description. Useful pattern for our "team" feature
later (e.g. a `tester` subagent the `build` agent can invoke after edits).

## 6. Comparison vs Claude CLI and Codex

| Feature | Claude CLI (`claude`) | Codex (`codex exec`) | OpenCode (`opencode run/serve`) |
|---|---|---|---|
| Non-interactive run | `claude -p "..." --output-format stream-json` | `codex exec --json` | `opencode run --format json` |
| Server mode | no | no | `opencode serve` (HTTP) |
| Session resume | `claude -r <id>` | no (uses `--ephemeral`) | `--session <id>` / `--continue` |
| Provider lock-in | Anthropic only | OpenAI only | **None** — 75+ providers |
| Model selection per call | `--model` | implicit (ChatGPT subscription) | `--model provider/model` |
| Free tier | account quota | ChatGPT Plus subscription | 5 free Zen models + local |
| Built-in plan/build separation | no (single agent) | no | **yes**, `--agent plan`/`build` |
| Cost/usage stats | in JSON output | not exposed | `opencode stats` + per-msg in API |
| License | proprietary | proprietary | MIT |

The unique advantages OpenCode brings to our project:

- A **single binary** that gives us access to GPT-5.x, Claude, Gemini, Qwen,
  and free models — without us writing per-provider client code.
- **Server mode** lets us amortize startup cost across many tasks. Claude CLI
  and Codex both pay full process-spawn cost per invocation today.
- **Session resume** that works across providers — we can have a session
  pinned to GPT-5.5 for planning and another pinned to Claude Sonnet for
  implementation, both within OpenCode's session model.

## 7. Integration design (preview — not yet implemented)

This is what an `OpenCodeStrategy` adapter would look like in this repo, after
PR1 introduces the common `AgentStrategy` interface.

```ts
// src/agents/OpenCodeStrategy.ts (sketch)
import { spawn } from 'child_process';
import type { AgentStrategy, AgentRunOptions, AgentRunResult } from './types.js';

export class OpenCodeStrategy implements AgentStrategy {
  name = 'opencode' as const;
  label = 'OpenCode';
  icon = '🦊';

  constructor(private opts: { defaultModel?: string; agentMode?: 'build' | 'plan' } = {}) {}

  async run(o: AgentRunOptions): Promise<AgentRunResult> {
    const args = ['run', '--format', 'json', '--dir', o.cwd];
    if (this.opts.agentMode) args.push('--agent', this.opts.agentMode);
    if (o.model ?? this.opts.defaultModel) args.push('--model', o.model ?? this.opts.defaultModel!);
    if (o.sessionId) args.push('--session', o.sessionId);

    return new Promise((resolve) => {
      const child = spawn('opencode', args, { cwd: o.cwd });
      child.stdin.write(o.prompt + '\n');
      child.stdin.end();
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d.toString(); o.onTextChunk?.(d.toString(), out); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('close', (code) => {
        // Parse JSON output, extract result + sessionId + cost
        // (exact JSON shape: see /doc OpenAPI on a running server)
        resolve({ success: code === 0, result: out, error: err || undefined });
      });
    });
  }
}
```

For the **`serve` mode** alternative, we'd start a single `opencode serve`
process per project (managed by `ProjectManager`) and use `fetch()` to
`POST /session/:id/message`. Trade-off:

- Spawn-per-task (above): simpler, no daemon to babysit, slow per-call.
- Serve-once: one extra long-running process per project, faster per-call,
  needs lifecycle management at startup/shutdown.

Recommendation: ship spawn-per-task first (mirror Codex's pattern), evaluate
move to serve mode if latency or quota interaction becomes a bottleneck.

## 8. Open questions to resolve before implementation

1. **Exact JSON shape of `opencode run --format json`**. The API for `serve`
   mode is documented in OpenAPI; the CLI JSON format is not. We should run
   `opencode run --format json "hello"` once and capture the output to
   determine which fields exist (sessionId, costUsd, tokens used).
2. **Quota / rate limit behaviour of free Zen models**. The docs say "limited
   time" — we need a graceful fallback when a free model becomes unavailable.
3. **Session sharing across processes**. If we spawn a fresh `opencode run`
   for each task with `--continue`, does it pick up the previous session
   from the SQLite DB OpenCode stores at `~/.local/share/opencode/`? Need
   to verify on a real install before relying on this.
4. **Tool sandbox interaction**. OpenCode has its own permission system. Our
   bot needs unattended write access — verify that `--agent build` plus an
   `opencode.json` config can disable interactive prompts the way Claude CLI's
   `--dangerously-skip-permissions` does.

---

## Sources

All fetched May 2026.

- [OpenCode home](https://opencode.ai/)
- [OpenCode CLI docs](https://opencode.ai/docs/cli/)
- [OpenCode server docs](https://opencode.ai/docs/server/)
- [OpenCode agents docs](https://opencode.ai/docs/agents/)
- [OpenCode Zen docs](https://opencode.ai/docs/zen/)
- [OpenCode commands docs](https://opencode.ai/docs/commands/)
- [github.com/sst/opencode](https://github.com/sst/opencode)
