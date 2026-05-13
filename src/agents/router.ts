import type { AgentName, AgentRunOptions, AgentRunResult } from './types.js';
import { getAgent } from './index.js';

// Sensitivity tags drive whether the router is allowed to auto-degrade to a
// free Zen-backed agent (currently OpenCode) when the preferred agent hits
// usage_limit.
//
// Why this matters: OpenCode Zen's own docs (https://opencode.ai/docs/zen/)
// state that for free models "during its free period, collected data may be
// used to improve the model". The Nemotron 3 Super free option logs prompts
// and outputs to NVIDIA. Paid Zen / Claude / OpenAI API are zero-retention
// (with the standard 30-day OpenAI/Anthropic policy windows). So we MUST NOT
// auto-route sensitive content there without explicit user consent.
//
//   'public'           — prompt and context are derived from public information
//                        (e.g. a git log on a public repo, a list of files in
//                        an open-source project). Safe to auto-fall back to a
//                        free upstream that may train on it.
//   'project-internal' — prompt contains code, file contents, or commit messages
//                        from a project that may or may not be public. The bot
//                        can't tell. Treat as private; never auto-degrade.
//   'secret'           — prompt is known to contain credentials or other
//                        secrets (e.g. /secret flow). Hard-fail on quota issues
//                        rather than route anywhere new.
export type TaskSensitivity = 'public' | 'project-internal' | 'secret';

export interface RoutedRunOptions extends AgentRunOptions {
  preferredAgent: AgentName;
  sensitivity: TaskSensitivity;
}

export interface RoutedRunResult {
  result: AgentRunResult;
  agentUsed: AgentName;
  fellBack: boolean;          // true when we used a non-preferred agent
}

// The single agent we auto-fall-back to when the preferred one runs out of
// quota AND the task is privacy-safe. OpenCode's default provider is
// configurable per host; in our setup it points at a free Zen model so
// callers don't pay anything.
const FREE_FALLBACK: AgentName = 'opencode';

/**
 * Runs a task through the preferred agent, with optional automatic fallback
 * to a free agent on usage_limit failures. Privacy-aware: only 'public'
 * tasks are eligible for auto-fallback. Everything else returns the original
 * failure so the caller can prompt the user before re-routing.
 *
 * The returned `agentUsed` and `fellBack` let callers tell the user which
 * agent actually answered, e.g. in the message footer.
 */
export async function runWithRouter(opts: RoutedRunOptions): Promise<RoutedRunResult> {
  const { preferredAgent, sensitivity, ...runOpts } = opts;

  const primary = await getAgent(preferredAgent).run(runOpts);
  if (primary.success || primary.errorType !== 'usage_limit') {
    return { result: primary, agentUsed: preferredAgent, fellBack: false };
  }

  // Quota hit. Auto-fallback only when content is safe to share with a
  // potentially data-retaining provider and the preferred agent isn't
  // already the free fallback target.
  if (sensitivity === 'public' && preferredAgent !== FREE_FALLBACK) {
    const fallback = await getAgent(FREE_FALLBACK).run(runOpts);
    if (fallback.success || fallback.errorType !== 'usage_limit') {
      return { result: fallback, agentUsed: FREE_FALLBACK, fellBack: true };
    }
  }

  // For 'project-internal' / 'secret', or when even the fallback failed,
  // surface the original failure so the caller can decide what to do
  // (e.g. show an inline keyboard asking the user to consent to free tier).
  return { result: primary, agentUsed: preferredAgent, fellBack: false };
}
