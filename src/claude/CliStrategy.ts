import { spawn } from 'child_process';
import { parseLineDetailed, type StreamEvent } from './StreamParser.js';

export interface CliRunOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  onTextChunk?: (text: string, accumulated: string) => void;
  onToolUse?: (toolName: string) => void;
  onInit?: (sessionId: string) => void;
}

export type CliErrorType = 'usage_limit' | 'rate_limit' | 'overloaded' | 'unknown';

export interface CliRunResult {
  success: boolean;
  sessionId: string;
  costUsd: number;
  result: string;
  error?: string;
  errorType?: CliErrorType;
  toolsUsed: Record<string, number>;
}

export function classifyCliError(text: string): CliErrorType {
  const t = text.toLowerCase();
  if (t.includes('usage limit') || t.includes('quota') || t.includes('upgrade') || t.includes('claude.ai/upgrade')) return 'usage_limit';
  if (t.includes('rate limit') || t.includes('too many requests') || t.includes('429')) return 'rate_limit';
  if (t.includes('overloaded')) return 'overloaded';
  return 'unknown';
}

export async function runCliTask(options: CliRunOptions): Promise<CliRunResult> {
  const { prompt, cwd, sessionId, onTextChunk, onToolUse, onInit } = options;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    // SECURITY NOTE: --dangerously-skip-permissions bypasses ALL Claude Code permission confirmations,
    // including file reads, writes, shell command execution, and network requests. Claude runs with
    // the same OS-level permissions as this Node.js process. The cwd is set to the project directory
    // but Claude is NOT sandboxed to it — it can read/write anywhere the process user has access.
    // Only use this in a trusted, single-owner environment. Do NOT expose this bot publicly.
    '--dangerously-skip-permissions',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let accumulatedText = '';
    let resultEvent: CliRunResult | null = null;
    let toolsUsed: Record<string, number> = {};
    let initSessionId = sessionId ?? '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const events = parseLineDetailed(line);
        for (const event of events) {
          handleEvent(event);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      console.error('[claude stderr]', text);
    });

    child.on('close', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        const events = parseLineDetailed(buffer);
        for (const event of events) {
          handleEvent(event);
        }
      }

      if (resultEvent) {
        // If the result event already carries an error, also check stderr
        if (!resultEvent.success && resultEvent.error) {
          const combinedText = resultEvent.error + ' ' + stderrBuffer;
          const errorType = classifyCliError(combinedText);
          resolve({ ...resultEvent, errorType });
        } else {
          resolve(resultEvent);
        }
      } else if (code !== 0) {
        const errorText = stderrBuffer || `Process exited with code ${code}`;
        const errorType = classifyCliError(errorText);
        resolve({
          success: false,
          sessionId: initSessionId,
          costUsd: 0,
          result: '',
          error: errorText || `Process exited with code ${code}`,
          errorType,
          toolsUsed,
        });
      } else {
        resolve({
          success: true,
          sessionId: initSessionId,
          costUsd: 0,
          result: accumulatedText,
          toolsUsed,
        });
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    function handleEvent(event: StreamEvent) {
      switch (event.type) {
        case 'init':
          initSessionId = event.sessionId;
          onInit?.(event.sessionId);
          break;
        case 'text_chunk':
          accumulatedText += event.text;
          onTextChunk?.(event.text, accumulatedText);
          break;
        case 'tool_use':
          toolsUsed[event.toolName] = (toolsUsed[event.toolName] ?? 0) + 1;
          onToolUse?.(event.toolName);
          break;
        case 'result':
          resultEvent = {
            success: event.success,
            sessionId: event.sessionId || initSessionId,
            costUsd: event.costUsd,
            result: event.result,
            error: event.error,
            toolsUsed,
          };
          break;
      }
    }
  });
}
