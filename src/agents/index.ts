import { ClaudeStrategy } from './ClaudeStrategy.js';
import { CodexStrategy } from './CodexStrategy.js';
import type { AgentName, AgentStrategy } from './types.js';

// Single registry of available agents. Add a new strategy here when you wire
// up a new backend (e.g. OpenCode in a follow-up PR).
const registry: Record<AgentName, AgentStrategy> = {
  claude: new ClaudeStrategy(),
  codex: new CodexStrategy(),
};

export function getAgent(name: AgentName): AgentStrategy {
  return registry[name];
}

export function listAgents(): AgentStrategy[] {
  return Object.values(registry);
}

export type { AgentName, AgentStrategy, AgentRunOptions, AgentRunResult, AgentErrorType } from './types.js';
