import { runCodexTask, CODEX_AUTH_REQUIRED_MARKER } from '../claude/CodexStrategy.js';
import type { AgentErrorType, AgentRunOptions, AgentRunResult, AgentStrategy } from './types.js';

// Adapter that wraps the existing runCodexTask CLI driver behind the common
// AgentStrategy interface. Codex doesn't expose costUsd, toolsUsed, sessionId,
// or onInit/onToolUse callbacks — those are simply omitted.
//
// Codex's error string is mapped to a coarse AgentErrorType when we can
// identify the pattern; otherwise it stays 'unknown'.
function classifyCodexError(err: string | undefined): AgentErrorType | undefined {
  if (!err) return undefined;
  // Preflight auth check uses an explicit marker, so we don't have to guess.
  if (err.startsWith(CODEX_AUTH_REQUIRED_MARKER)) return 'auth_required';
  const t = err.toLowerCase();
  if (t.includes('timed out') || t.includes('timeout')) return 'timeout';
  if (t.includes('quota') || t.includes('usage limit')) return 'usage_limit';
  if (t.includes('rate limit') || t.includes('429')) return 'rate_limit';
  if (t.includes('overloaded')) return 'overloaded';
  // Heuristic auth patterns in case codex exec itself ever surfaces them.
  if (/not logged in|session expired|unauthor/i.test(err)) return 'auth_required';
  return 'unknown';
}

export class CodexStrategy implements AgentStrategy {
  readonly name = 'codex' as const;
  readonly label = 'Codex';
  readonly icon = '💻';

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const r = await runCodexTask({
      prompt: options.prompt,
      cwd: options.cwd,
      onTextChunk: options.onTextChunk,
    });
    return {
      success: r.success,
      result: r.result,
      error: r.error,
      errorType: r.success ? undefined : classifyCodexError(r.error),
    };
  }
}
