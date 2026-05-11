// Common interface for everything that can run an agent task.
// Per-provider strategies (Claude, Codex, ... and later OpenCode) implement
// this; the rest of the codebase talks to the strategy, not the underlying
// `runCliTask` / `runCodexTask` functions directly.

export type AgentName = 'claude' | 'codex';

export type AgentErrorType =
  | 'usage_limit'   // ran out of subscription / API credits
  | 'rate_limit'    // 429-style transient
  | 'overloaded'    // upstream model overloaded
  | 'timeout'       // local timeout fired before agent responded
  | 'unknown';

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  onTextChunk?: (chunk: string, accumulated: string) => void;
  // Optional callbacks — not every backend can produce these.
  onToolUse?: (toolName: string) => void;
  onInit?: (sessionId: string) => void;
}

export interface AgentRunResult {
  success: boolean;
  result: string;
  error?: string;
  errorType?: AgentErrorType;
  // Provider-specific extras. Optional so adapters can omit what they don't expose.
  sessionId?: string;
  costUsd?: number;
  toolsUsed?: Record<string, number>;
}

export interface AgentStrategy {
  readonly name: AgentName;
  readonly label: string;
  readonly icon: string;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}
