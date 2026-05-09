// Pure helpers for the /checkpoint flow. Extracted from ClaudeSession so they
// can be unit-tested without spawning a real CLI.

export const CHECKPOINT_PROMPT =
  'Generate a concise session checkpoint for CLAUDE.md. Include:\n' +
  '1. Key decisions made in this session\n' +
  '2. Important context and findings\n' +
  '3. Current state of the codebase (what was changed/added)\n' +
  '4. Pending work or open issues\n\n' +
  'Format it as a dated markdown section. Be specific and brief — this will be read by a fresh session.';

/**
 * Builds the dated markdown block that gets appended to CLAUDE.md.
 * Date defaults to "today" (UTC, YYYY-MM-DD) so callers don't have to pass it.
 */
export function formatCheckpointBlock(summary: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().slice(0, 10);
  return `\n---\n## Checkpoint ${dateStr}\n\n${summary}\n`;
}

/**
 * Combines the existing CLAUDE.md content with a new block, inserting a newline
 * separator if the existing content doesn't already end with one.
 * Returns "" when the existing file is empty/missing — the block alone is fine.
 */
export function composeCheckpointAppend(existing: string, block: string): string {
  if (!existing) return block;
  const separator = existing.endsWith('\n') ? '' : '\n';
  return existing + separator + block;
}
