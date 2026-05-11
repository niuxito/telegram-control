import { runCliTask } from '../claude/CliStrategy.js';
import type { AgentRunOptions, AgentRunResult, AgentStrategy } from './types.js';

// Adapter that wraps the existing runCliTask CLI driver behind the common
// AgentStrategy interface. Behaviour is unchanged — this is a thin pass-through.
export class ClaudeStrategy implements AgentStrategy {
  readonly name = 'claude' as const;
  readonly label = 'Claude';
  readonly icon = '🤖';

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const r = await runCliTask({
      prompt: options.prompt,
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      signal: options.signal,
      onTextChunk: options.onTextChunk,
      onToolUse: options.onToolUse,
      onInit: options.onInit,
    });
    return {
      success: r.success,
      result: r.result,
      error: r.error,
      errorType: r.errorType,
      sessionId: r.sessionId,
      costUsd: r.costUsd,
      toolsUsed: r.toolsUsed,
    };
  }
}
