/**
 * Intent detection and prompt building for natural language agent messages.
 * Shared between text and voice handlers to avoid duplication.
 */

const ISSUE_PATTERNS = [
  /\bcrea[r]?\s+(una?\s+)?issue/i,
  /\bnuev[ao]\s+issue/i,
  /\babre?\s+(una?\s+)?issue/i,
  /\bcreate\s+(a[n]?\s+)?issue/i,
  /\bopen\s+(a[n]?\s+)?issue/i,
];

export function isIssueRequest(text: string): boolean {
  return ISSUE_PATTERNS.some(p => p.test(text));
}

export function buildIssueTaskPrompt(userRequest: string): string {
  return (
    `Create a GitHub issue based on this request: "${userRequest}"\n\n` +
    `Steps:\n` +
    `1. Extract a concise title (max 80 chars) from the request\n` +
    `2. Write a clear body/description\n` +
    `3. Run: gh issue create --title "..." --body "..."\n` +
    `4. Report the issue URL when done.\n\n` +
    `If the repo has no remote or gh is not configured, report the error clearly.`
  );
}

/**
 * Resolves the final prompt to queue based on detected intent.
 * Add more intents here as the bot grows.
 */
export function resolveAgentPrompt(text: string): string {
  if (isIssueRequest(text)) return buildIssueTaskPrompt(text);
  return text;
}
