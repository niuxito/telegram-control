import { spawn } from 'child_process';
import { parseLineDetailed, type StreamEvent } from './StreamParser.js';

export interface CliRunOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  onTextChunk?: (text: string, accumulated: string) => void;
  onToolUse?: (toolName: string) => void;
  onInit?: (sessionId: string) => void;
}

export type CliErrorType = 'usage_limit' | 'rate_limit' | 'overloaded' | 'auth_required' | 'unknown';

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
  if (/not logged in|not authenticated|session expired|unauthori[sz]ed|login required|auth.*required|please log in/i.test(t)) return 'auth_required';
  if (t.includes('usage limit') || t.includes('quota') || t.includes('upgrade') || t.includes('claude.ai/upgrade')) return 'usage_limit';
  if (t.includes('rate limit') || t.includes('too many requests') || t.includes('429')) return 'rate_limit';
  if (t.includes('overloaded')) return 'overloaded';
  return 'unknown';
}

export async function runCliTask(options: CliRunOptions): Promise<CliRunResult> {
  const { prompt, cwd, sessionId, model, signal, onTextChunk, onToolUse, onInit } = options;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
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

  if (model) {
    args.push('--model', model);
  }

  const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  return new Promise((resolve, reject) => {
    console.log(`[CliStrategy] Spawning claude, cwd=${cwd}, sessionId=${sessionId ?? 'none'}`);
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('spawn', () => console.log(`[CliStrategy] Process spawned, pid=${child.pid}`));
    child.on('error', (err) => console.error(`[CliStrategy] Process error:`, err.message));

    if (signal) {
      signal.addEventListener('abort', () => {
        console.log(`[CliStrategy] Abort signal received, killing pid=${child.pid}`);
        child.kill('SIGTERM');
      }, { once: true });
    }

    let buffer = '';
    let accumulatedText = '';
    let resultEvent: CliRunResult | null = null;
    let toolsUsed: Record<string, number> = {};
    let initSessionId = sessionId ?? '';
    let stderrBuffer = '';

    // Inactivity timeout: reset on every stdout/stderr chunk.
    // This allows complex long-running tasks to complete as long as Claude
    // keeps producing output, but kills truly hung processes.
    let timeoutHandle = setTimeout(onTimeout, TASK_TIMEOUT_MS);
    function resetTimeout() {
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(onTimeout, TASK_TIMEOUT_MS);
    }
    function onTimeout() {
      console.error(`[CliStrategy] Inactivity timeout after ${TASK_TIMEOUT_MS/1000}s, killing process pid=${child.pid}`);
      child.kill('SIGTERM');
      resolve({
        success: false,
        sessionId: initSessionId,
        costUsd: 0,
        result: accumulatedText,
        error: 'Task timed out after 10 minutes of inactivity',
        errorType: 'unknown',
        toolsUsed,
      });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      resetTimeout();
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
      resetTimeout();
      const text = chunk.toString();
      stderrBuffer += text;
      console.error('[claude stderr]', text);
    });

    child.on('close', (code) => {
      console.log(`[CliStrategy] Process closed, code=${code}, hasResult=${!!resultEvent}, accumulated=${accumulatedText.length}chars`);
      clearTimeout(timeoutHandle);

      if (signal?.aborted) {
        resolve({
          success: false,
          sessionId: initSessionId,
          costUsd: 0,
          result: accumulatedText,
          error: 'Task cancelled by user',
          errorType: 'unknown',
          toolsUsed,
        });
        return;
      }

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
