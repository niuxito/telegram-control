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

// Patterns that indicate a development/implementation request → use /feature skill
const FEATURE_PATTERNS = [
  /\bimplementa[r]?\b/i,
  /\bdesarrolla[r]?\b/i,
  /\bañade?\s+/i,
  /\bagrega[r]?\s+/i,
  /\bconstruye?\b/i,
  /\brefactori[zs]a[r]?\b/i,
  /\bcrea[r]?\s+(un[ao]?\s+)?(nuevo\s+)?(comando|endpoint|función|feature|componente|módulo|clase|servicio|handler|ruta|página|vista|api|bot)/i,
  /\bimplement\b/i,
  /\brefactor\b/i,
  /\badd\s+(a\s+)?(new\s+)?(command|endpoint|function|feature|component|module|class|service|handler|route|page|api)/i,
  /\bbuild\s+(a\s+)?(new\s+)?/i,
  /\bdevelop\b/i,
];

// Patterns that are clearly NOT feature requests (informational, operational)
const NON_FEATURE_PATTERNS = [
  /\b(muestra|lista|explica|dame|dime|qué|cómo|cuál|cuánto|show|list|explain|what|how|which|status|git\s|deploy|test\s|check\s|ver\s|ejecuta|run\s|instala|install)\b/i,
];

export function isFeatureRequest(text: string): boolean {
  if (NON_FEATURE_PATTERNS.some(p => p.test(text))) return false;
  return FEATURE_PATTERNS.some(p => p.test(text));
}

export function isIssueRequest(text: string): boolean {
  return ISSUE_PATTERNS.some(p => p.test(text));
}

/**
 * Builds a prompt for a specialized planning + architecture agent.
 * The agent analyzes the codebase and produces a detailed issue specification
 * before creating it on GitHub (or printing it for local storage).
 *
 * @param userRequest  The raw user request describing the task
 * @param createOnGithub  If true, agent creates the issue via `gh`. If false, it only prints the spec.
 */
export function buildPlanningIssuePrompt(userRequest: string, createOnGithub: boolean): string {
  const creationStep = createOnGithub
    ? `5. Create the GitHub issue:\n` +
      `   gh issue create --title "<title>" --body "<full spec in markdown>"\n` +
      `   Report the issue URL when done.`
    : `5. Print the final specification in this exact format so it can be stored:\n` +
      `   ISSUE_TITLE: <title>\n` +
      `   ISSUE_BODY:\n` +
      `   <full spec in markdown>`;

  return (
    `You are a senior software architect and business analyst. Your job is to turn a rough request ` +
    `into a precise, actionable issue specification.\n\n` +
    `Request: "${userRequest}"\n\n` +
    `Follow these steps:\n\n` +
    `1. **Analyse the codebase**: Explore the relevant files to understand the current architecture, ` +
    `data models, existing patterns, and any code that will be affected.\n\n` +
    `2. **Business context**: Explain the motivation behind the request — what problem it solves ` +
    `and the value it brings.\n\n` +
    `3. **Functional requirements**: List exactly what the feature must do, written as user stories ` +
    `or acceptance criteria (Given/When/Then or bullet points).\n\n` +
    `4. **Technical specification**: Describe the proposed implementation:\n` +
    `   - Files / modules to create or modify\n` +
    `   - Data model changes (new tables, columns, schema migrations)\n` +
    `   - API / interface changes\n` +
    `   - Edge cases and error handling\n` +
    `   - Security considerations\n` +
    `   - Testing strategy\n\n` +
    creationStep
  );
}

/** Legacy wrapper kept for wake-word / voice flows that auto-detect issue requests */
export function buildIssueTaskPrompt(userRequest: string): string {
  return buildPlanningIssuePrompt(userRequest, true);
}

/**
 * Resolves the final prompt to queue based on detected intent.
 * Add more intents here as the bot grows.
 */
export function resolveAgentPrompt(text: string): string {
  if (isIssueRequest(text)) return buildIssueTaskPrompt(text);
  return text;
}
