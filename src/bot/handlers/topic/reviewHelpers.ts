// Pure helpers for /review. Extracted from tasks.ts so they can be unit-tested
// without mocking the bot, grammy, or `gh`.

export const MAX_REVIEW_DIFF_CHARS = 12_000;

/**
 * Extracts a PR number from either a bare integer string ("123") or a GitHub
 * URL containing "/pull/<n>". Returns null when neither pattern matches.
 *
 * Whitespace is trimmed; trailing punctuation in the URL form (e.g. a closing
 * paren in markdown) is allowed.
 */
export function parsePrReference(arg: string): number | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/pull\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);

  const numMatch = trimmed.match(/^\d+$/);
  if (numMatch) return parseInt(trimmed, 10);

  return null;
}

/**
 * Truncates a diff to at most `maxChars` characters, appending a marker line
 * so the reviewer knows content was elided. Short diffs are returned unchanged.
 */
export function truncateDiff(diff: string, maxChars: number = MAX_REVIEW_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + '\n... (diff truncated)';
}

/**
 * Builds the prompt sent to the agent for review.
 * `target` is a free-text label like "current changes" or "PR #42: ...".
 */
export function buildReviewPrompt(projectName: string, target: string, diff: string): string {
  return (
    `Please review the following code diff for ${projectName}.\n\n` +
    `Focus on: correctness, security issues, potential bugs, code quality, and anything that looks risky or should be reconsidered.\n` +
    `Be concise — highlight only the most important findings. If the code looks good, say so briefly.\n\n` +
    `${target ? `Context: ${target}\n\n` : ''}` +
    `\`\`\`diff\n${diff}\n\`\`\``
  );
}
