// Quota-retry flow. When a project-internal task fails with usage_limit, the
// router does NOT auto-fall-back (privacy gate). Instead, the handler can call
// offerQuotaRetry() to show the user an inline keyboard giving them the choice
// to opt in to the free Zen tier (OpenCode) or cancel.
//
// State is per-user, in-memory. A bot restart loses pending retries — the
// keyboard buttons become no-ops, which is acceptable for a transient UI flow.

import { InlineKeyboard } from 'grammy';
import type { AgentName } from '../../../agents/index.js';

export interface PendingQuotaRetry {
  prompt: string;            // The full (already context-prepended) prompt to re-run
  cwd: string;
  originalAgent: AgentName;  // Which agent ran out of quota — used in the success footer
  projectId: number;
  chatId: number;
  topicId: number;
  messageId: number;         // The Telegram message that holds the keyboard
}

const pendingRetries = new Map<number, PendingQuotaRetry>();

export function setPendingQuotaRetry(userId: number, retry: PendingQuotaRetry): void {
  pendingRetries.set(userId, retry);
}

export function getPendingQuotaRetry(userId: number): PendingQuotaRetry | undefined {
  return pendingRetries.get(userId);
}

export function clearPendingQuotaRetry(userId: number): void {
  pendingRetries.delete(userId);
}

/**
 * Builds the consent keyboard + body shown when a project-internal task hits
 * usage_limit. Returned as { text, keyboard } so the caller can edit the
 * existing live message instead of sending a new one.
 */
export function buildQuotaRetryPrompt(userId: number, agentLabel: string): {
  text: string;
  keyboard: InlineKeyboard;
} {
  return {
    text:
      `⚠️ ${agentLabel} is out of quota.\n\n` +
      `OpenCode's free tier can answer this, but Zen docs say free models ` +
      `"may use collected data to improve the model". Don't pick this if your ` +
      `prompt contains anything sensitive.`,
    keyboard: new InlineKeyboard()
      .text('🦊 Retry with OpenCode (free)', `quota_retry_opencode:${userId}`)
      .row()
      .text('✋ Cancel', `quota_cancel:${userId}`),
  };
}
