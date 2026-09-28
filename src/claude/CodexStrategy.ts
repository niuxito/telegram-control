import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CODEX_BIN = path.resolve(__dirname, '../../node_modules/.bin/codex');

// Marker prefix used in CodexRunResult.error when the failure is an auth
// problem detected by the preflight `codex login status` check. The adapter
// in src/agents/CodexStrategy.ts maps this to errorType='auth_required'.
export const CODEX_AUTH_REQUIRED_MARKER = 'auth_required:';

export interface CodexRunOptions {
  prompt: string;
  cwd: string;
  onTextChunk?: (text: string, accumulated: string) => void;
}

export interface CodexRunResult {
  success: boolean;
  result: string;
  error?: string;
}

/**
 * Runs `codex login status` and reports whether the current Codex CLI install
 * has a valid ChatGPT/OpenAI session. Cheap (sub-second) and side-effect-free.
 *
 * Returns { loggedIn, raw } so callers can pass the raw status string through
 * to the user in the failure path. If the binary itself can't be spawned or
 * the command takes too long, returns loggedIn=false with raw='probe failed'
 * so the caller treats it as a definite auth failure rather than guessing.
 */
export async function checkCodexAuth(): Promise<{ loggedIn: boolean; raw: string }> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ loggedIn: false, raw: 'probe failed: timeout' });
    }, 5_000);

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ loggedIn: false, raw: `probe failed: ${err.trim() || 'spawn error'}` });
    });

    child.on('close', () => {
      clearTimeout(timer);
      const raw = (out + err).trim();
      // The CLI prints "Logged in using ChatGPT" or "Logged in using OpenAI API key"
      // when authenticated, and "Not logged in" otherwise. The negation has to
      // be checked first because both strings contain "logged in".
      const loggedIn = /logged in/i.test(raw) && !/not\s+logged in/i.test(raw);
      resolve({ loggedIn, raw });
    });
  });
}

/** Parses a JSONL line from `codex exec --json` and extracts any visible text.
 *  Actual format: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */
function extractTextFromEvent(line: string): string | null {
  try {
    const event = JSON.parse(line);

    // Primary format: item.completed with agent_message
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      return typeof event.item.text === 'string' ? event.item.text : null;
    }

    // Fallbacks for other possible formats
    if (typeof event.item?.text === 'string' && event.item.text) return event.item.text;
    if (event.content && typeof event.content === 'string') return event.content;
    if (Array.isArray(event.content)) {
      return event.content
        .filter((c: any) => c.type === 'text' || c.type === 'output_text')
        .map((c: any) => c.text ?? c.output_text ?? '')
        .join('') || null;
    }
    if (typeof event.text === 'string' && event.text) return event.text;
    if (event.delta?.text) return event.delta.text;

  } catch {
    // Not JSON — ignore (codex prints "Reading prompt from stdin..." etc.)
  }
  return null;
}

// Prefix injected before every user prompt to keep Codex responses concise.
// Codex tends to be very verbose by default; this brings it in line with the
// short Telegram-message format we need.
const BREVITY_PREFIX =
  'Respond concisely. Summarise what you did or found in 3-5 sentences maximum. ' +
  'Skip preamble, internal thoughts, and tool traces. ' +
  'If you need to share code or a diff, include only the most relevant snippet.\n\n';

export async function runCodexTask(options: CodexRunOptions): Promise<CodexRunResult> {
  const { prompt, cwd, onTextChunk } = options;
  const augmentedPrompt = BREVITY_PREFIX + prompt;

  // Preflight: cheap login probe. `codex exec` in non-interactive mode fails
  // silently when the OAuth session has expired (exit code != 0, stderr only
  // contains the "Reading prompt from stdin..." banner). Catching it here gives
  // the user an actionable message instead of a confusing "finished with errors".
  const auth = await checkCodexAuth();
  if (!auth.loggedIn) {
    console.warn(`[CodexStrategy] Auth probe failed: ${auth.raw}`);
    return {
      success: false,
      result: '',
      error: `${CODEX_AUTH_REQUIRED_MARKER} ${auth.raw}`,
    };
  }

  // gpt-5.2-codex (the CLI default) only works with OpenAI API keys.
  // ChatGPT accounts require a model from the ChatGPT-compatible list;
  // gpt-5.4-mini is the cheapest option confirmed to work.
  const args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '-m', 'gpt-5.4-mini',
    '-C', cwd,
  ];

  const TIMEOUT_MS = 5 * 60 * 1000;

  return new Promise((resolve) => {
    console.log(`[CodexStrategy] Spawning codex, cwd=${cwd}`);

    const child = spawn(CODEX_BIN, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send prompt via stdin and close it immediately
    child.stdin.write(augmentedPrompt + '\n');
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, result: accumulatedText, error: 'Codex timed out after 5 minutes' });
    }, TIMEOUT_MS);

    child.on('spawn', () => console.log(`[CodexStrategy] Process spawned, pid=${child.pid}`));
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[CodexStrategy] Process error:', err.message);
      resolve({ success: false, result: '', error: err.message });
    });

    let accumulatedText = '';
    let stderrBuffer = '';
    let lineBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const text = extractTextFromEvent(line);
        if (text) {
          accumulatedText += text;
          onTextChunk?.(text, accumulatedText);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      // Flush any remaining partial line
      if (lineBuffer.trim()) {
        const text = extractTextFromEvent(lineBuffer);
        if (text) accumulatedText += text;
      }
      console.log(`[CodexStrategy] Process closed, code=${code}, accumulated=${accumulatedText.length} chars`);

      // stderr is NEVER shown to the user — it contains internal Codex diagnostics
      // and, critically, the risk-evaluation prompt that Codex leaks to stderr before
      // every exec run. Log it server-side only.
      if (stderrBuffer.trim()) {
        console.log(`[CodexStrategy] stderr (not forwarded to user): ${stderrBuffer.trim().slice(0, 500)}`);
      }

      if (code === 0 && accumulatedText) {
        resolve({ success: true, result: accumulatedText });
      } else if (code === 0) {
        // No JSON text extracted but clean exit — not an error, just nothing to say.
        resolve({ success: true, result: '(no output)' });
      } else {
        // Report exit code; do NOT include raw stderr which may contain internal prompts.
        const errMsg = `Codex exited with code ${code}`;
        resolve({ success: false, result: accumulatedText, error: errMsg });
      }
    });
  });
}
