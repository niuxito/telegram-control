import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AgentRunOptions, AgentRunResult, AgentStrategy, AgentErrorType } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = path.resolve(__dirname, '../../node_modules/.bin/opencode');

const TIMEOUT_MS = 5 * 60 * 1000;

// JSONL event shape from `opencode run --format json`. Captured empirically
// against opencode-ai v1.14.48. The fields we rely on are stable across the
// event types we observe (step_start, tool_use, step_finish, text).
interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: any;
}

function extractText(event: OpenCodeEvent): string | null {
  if (event.type === 'text' && typeof event.part?.text === 'string') {
    return event.part.text;
  }
  return null;
}

function extractToolName(event: OpenCodeEvent): string | null {
  if (event.type === 'tool_use' && event.part?.tool) {
    return String(event.part.tool);
  }
  return null;
}

function classifyOpenCodeError(msg: string | undefined): AgentErrorType {
  if (!msg) return 'unknown';
  const t = msg.toLowerCase();
  if (t.includes('timed out') || t.includes('timeout')) return 'timeout';
  if (t.includes('quota') || t.includes('usage limit')) return 'usage_limit';
  if (t.includes('rate limit') || t.includes('429')) return 'rate_limit';
  if (t.includes('overloaded')) return 'overloaded';
  return 'unknown';
}

export interface OpenCodeStrategyOptions {
  // 'build' (full tool access, default) or 'plan' (read-only).
  // Forwarded to `--agent <mode>` if set.
  agentMode?: 'build' | 'plan';
}

export class OpenCodeStrategy implements AgentStrategy {
  readonly name = 'opencode' as const;
  readonly label = 'OpenCode';
  readonly icon = '🦊';

  constructor(private opts: OpenCodeStrategyOptions = {}) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { prompt, cwd, sessionId, model, signal, onTextChunk, onToolUse } = options;

    const args = [
      'run',
      '--format', 'json',
      '--dangerously-skip-permissions',
      '--dir', cwd,
    ];
    if (this.opts.agentMode) args.push('--agent', this.opts.agentMode);
    if (model) args.push('--model', model);
    if (sessionId) args.push('--session', sessionId);

    return new Promise((resolve) => {
      console.log(`[OpenCodeStrategy] Spawning opencode, cwd=${cwd}, sessionId=${sessionId ?? 'none'}, model=${model ?? 'default'}`);

      const child = spawn(OPENCODE_BIN, args, {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Pipe the prompt via stdin to avoid arg-length limits on long prompts
      // and to keep shell-special characters out of the argv.
      child.stdin.write(prompt + '\n');
      child.stdin.end();

      let accumulated = '';
      let stderr = '';
      let lineBuffer = '';
      let sessionIdSeen: string | undefined;
      let costUsd = 0;
      const toolsUsed: Record<string, number> = {};

      const timer = setTimeout(() => {
        child.kill();
        resolve({
          success: false,
          result: accumulated,
          error: 'OpenCode timed out after 5 minutes',
          errorType: 'timeout',
          sessionId: sessionIdSeen,
          costUsd,
          toolsUsed,
        });
      }, TIMEOUT_MS);

      const onAbort = () => {
        child.kill();
        clearTimeout(timer);
        resolve({
          success: false,
          result: accumulated,
          error: 'Aborted',
          errorType: 'unknown',
          sessionId: sessionIdSeen,
          costUsd,
          toolsUsed,
        });
      };
      signal?.addEventListener('abort', onAbort);

      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          success: false,
          result: '',
          error: err.message,
          errorType: 'unknown',
        });
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: OpenCodeEvent;
        try {
          event = JSON.parse(line);
        } catch {
          return; // Non-JSON line — opencode prints banners ("Performing... migration") here
        }

        if (event.sessionID && !sessionIdSeen) sessionIdSeen = event.sessionID;

        const text = extractText(event);
        if (text) {
          accumulated += text;
          onTextChunk?.(text, accumulated);
        }

        const tool = extractToolName(event);
        if (tool) {
          toolsUsed[tool] = (toolsUsed[tool] ?? 0) + 1;
          onToolUse?.(tool);
        }

        if (event.type === 'step_finish' && typeof event.part?.cost === 'number') {
          costUsd += event.part.cost;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (lineBuffer.trim()) processLine(lineBuffer);

        console.log(`[OpenCodeStrategy] closed code=${code}, sessionId=${sessionIdSeen ?? 'none'}, cost=$${costUsd}, text=${accumulated.length}chars`);

        if (code === 0 && accumulated) {
          resolve({
            success: true,
            result: accumulated,
            sessionId: sessionIdSeen,
            costUsd,
            toolsUsed,
          });
        } else if (code === 0) {
          // Exit 0 with no text: surface stderr as best-effort output
          resolve({
            success: true,
            result: stderr.trim() || '(no output)',
            sessionId: sessionIdSeen,
            costUsd,
            toolsUsed,
          });
        } else {
          const errMsg = stderr.trim() || `OpenCode exited with code ${code}`;
          resolve({
            success: false,
            result: accumulated,
            error: errMsg,
            errorType: classifyOpenCodeError(errMsg),
            sessionId: sessionIdSeen,
            costUsd,
            toolsUsed,
          });
        }
      });
    });
  }
}
