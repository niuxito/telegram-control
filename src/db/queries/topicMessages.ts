import { desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../client.js';
import { topicMessages } from '../schema.js';

const MAX_STORED_MESSAGES = 100;
const MAX_CONTEXT_CHARS = 6000;   // hard cap on injected context to avoid token waste
const MAX_CONTEXT_MESSAGES = 50;  // absolute message cap

/** Patterns that suggest the user expects the agent to have prior context. */
const NEEDS_MORE_CONTEXT_PATTERNS = [
  /\b(continúa|continua|sigue|como\s+antes|el\s+anterior|la\s+anterior|como\s+discutimos|como\s+dijiste|lo\s+que\s+dijiste|lo\s+que\s+mencionaste)\b/i,
  /\b(continue|as\s+before|previous(ly)?|as\s+we\s+discussed|as\s+you\s+said|from\s+before|earlier)\b/i,
  /\bmás\s+contexto\b/i,
  /\bmore\s+context\b/i,
];

export function needsMoreContext(prompt: string): boolean {
  return NEEDS_MORE_CONTEXT_PATTERNS.some(p => p.test(prompt));
}

export function insertTopicMessage(
  db: Db,
  data: { projectId: number; sender: 'user' | 'claude' | 'codex' | 'opencode'; senderName?: string; text: string; createdAt?: Date }
): void {
  db.insert(topicMessages).values({
    projectId: data.projectId,
    sender: data.sender,
    senderName: data.senderName ?? null,
    text: data.text,
    ...(data.createdAt ? { createdAt: data.createdAt } : {}),
  }).run();

  // Prune oldest messages, keeping only MAX_STORED_MESSAGES per project
  const cutoff = db
    .select({ id: topicMessages.id })
    .from(topicMessages)
    .where(eq(topicMessages.projectId, data.projectId))
    .orderBy(desc(topicMessages.createdAt))
    .limit(1)
    .offset(MAX_STORED_MESSAGES)
    .all();

  if (cutoff.length > 0) {
    db.delete(topicMessages)
      .where(lt(topicMessages.id, cutoff[0].id))
      .run();
  }
}

export function getRecentTopicMessages(
  db: Db,
  projectId: number,
  limit = 20
): Array<{ sender: string; senderName: string | null; text: string; createdAt: Date | null }> {
  const capped = Math.min(limit, MAX_CONTEXT_MESSAGES);
  const rows = db
    .select()
    .from(topicMessages)
    .where(eq(topicMessages.projectId, projectId))
    .orderBy(desc(topicMessages.createdAt))
    .limit(capped)
    .all();

  return rows.reverse(); // chronological order
}

/**
 * Builds a conversation context string to prepend to agent prompts.
 * Agent responses get a higher per-message char limit than user messages
 * since they contain denser, more relevant information.
 * Respects a total char cap so we never waste tokens on a wall of history.
 * Returns empty string if there are no messages.
 */
/**
 * Extracts the most informative content from a long agent response.
 * Preserves structured content (numbered lists, bullet points, headers)
 * and falls back to head+tail truncation for unstructured text.
 */
function extractAgentSummary(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Extract all structured lines: numbered items, bullets, headers, code fences
  const structuredLines = text
    .split('\n')
    .filter(l => /^(\d+\.|[-*•]|\*\*|#{1,3}\s|```)/.test(l.trim()));

  if (structuredLines.length > 0) {
    const structured = structuredLines.join('\n');
    if (structured.length <= limit) return structured + '\n(full response in history)';
    // Still too long: keep as many structured lines as fit
    const kept: string[] = [];
    let total = 0;
    for (const l of structuredLines) {
      if (total + l.length + 1 > limit - 30) break;
      kept.push(l);
      total += l.length + 1;
    }
    return kept.join('\n') + '\n…(truncated)';
  }

  // No structure: head + tail
  const head = Math.floor(limit * 0.7);
  const tail = limit - head - 10;
  return text.slice(0, head) + '\n…\n' + text.slice(-tail);
}

export function buildConversationContext(
  messages: ReturnType<typeof getRecentTopicMessages>,
): string {
  if (messages.length === 0) return '';

  const USER_MSG_LIMIT = 400;
  const AGENT_MSG_LIMIT = 2000;

  // Iterate newest→oldest so that when we hit the char cap we drop the
  // oldest messages, not the most recent ones.
  let total = 0;
  const kept: string[] = [];
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isAgent = m.sender === 'claude' || m.sender === 'codex' || m.sender === 'opencode';
    const charLimit = isAgent ? AGENT_MSG_LIMIT : USER_MSG_LIMIT;
    const name = m.sender === 'user'
      ? (m.senderName ?? 'User')
      : m.sender === 'claude' ? 'Claude'
      : m.sender === 'codex' ? 'Codex'
      : 'OpenCode';
    const text = isAgent
      ? extractAgentSummary(m.text, charLimit)
      : m.text.length > charLimit ? m.text.slice(0, charLimit) + '…' : m.text;
    const line = `[${name}] ${text}`;

    total += line.length + 1;
    if (total > MAX_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
    kept.unshift(line); // prepend to preserve chronological order
  }

  if (truncated) {
    kept.unshift('… (earlier messages omitted to stay within context limit)');
  }

  return (
    `=== CONVERSATION HISTORY (${kept.length} messages) ===\n` +
    `This is the shared chat log between the user and the AI agents (Claude, Codex, OpenCode).\n` +
    `Each message is prefixed by the speaker's label. Use this to keep continuity across turns.\n` +
    `IMPORTANT: This history is complete and authoritative. Do NOT query the database or use shell commands\n` +
    `to look up conversation history — everything you need is already provided here.\n` +
    `If you need older messages not shown here, tell the user to add --more to their request.\n` +
    `==========\n` +
    kept.join('\n') +
    `\n==========\n\n`
  );
}

/**
 * Resolves how many messages to fetch based on explicit flag and keyword detection.
 * Returns { limit, flagFound, promptClean }.
 */
export function resolveContextLimit(prompt: string): { limit: number; flagFound: boolean; promptClean: string } {
  // Explicit --more / -m flag: fetch up to MAX_CONTEXT_MESSAGES
  const moreFlag = /\s*--more\b|\s*-m\b/.exec(prompt);
  if (moreFlag) {
    return {
      limit: MAX_CONTEXT_MESSAGES,
      flagFound: true,
      promptClean: prompt.replace(moreFlag[0], '').trim(),
    };
  }

  // Keyword detection: fetch 40 messages instead of the default 20
  if (needsMoreContext(prompt)) {
    return { limit: 40, flagFound: false, promptClean: prompt };
  }

  return { limit: 20, flagFound: false, promptClean: prompt };
}
