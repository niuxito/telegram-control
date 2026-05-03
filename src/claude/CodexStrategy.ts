import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = path.resolve(__dirname, '../../node_modules/.bin/codex');

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

export async function runCodexTask(options: CodexRunOptions): Promise<CodexRunResult> {
  const { prompt, cwd, onTextChunk } = options;

  const args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
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
    child.stdin.write(prompt + '\n');
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

      if (code === 0 && accumulatedText) {
        resolve({ success: true, result: accumulatedText });
      } else if (code === 0) {
        resolve({ success: true, result: stderrBuffer.trim() || '(no output)' });
      } else {
        const errMsg = stderrBuffer.trim() || `Codex exited with code ${code}`;
        resolve({ success: false, result: accumulatedText, error: errMsg });
      }
    });
  });
}
