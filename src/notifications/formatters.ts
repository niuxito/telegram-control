import type { Project } from '../db/queries/projects.js';
import type { GitCommit } from '../watchers/GitWatcher.js';
import type { CliErrorType } from '../claude/CliStrategy.js';

// SECURITY: these formatters return plain text (no parse_mode) to prevent Markdown injection
// from user-controlled strings such as commit messages, author names, file paths, and project names.

export function formatFileChanges(project: Project, files: string[]): string {
  const fileList = files.slice(0, 20).map(f => `  • ${f}`).join('\n');
  const extra = files.length > 20 ? `\n  ...and ${files.length - 20} more` : '';
  return `📝 File changes in ${project.name}\n\n${fileList}${extra}`;
}

export function formatGitCommits(project: Project, commits: GitCommit[]): string {
  const commitList = commits.slice(0, 10).map(c =>
    `  • ${c.hash} ${c.message} (${c.author})`
  ).join('\n');
  const extra = commits.length > 10 ? `\n  ...and ${commits.length - 10} more` : '';
  return `🔀 New commits in ${project.name}\n\n${commitList}${extra}`;
}

export function formatLimitError(errorType: CliErrorType): string {
  switch (errorType) {
    case 'auth_required':
      return (
        '🔑 Claude is not authenticated\n\n' +
        'The Claude CLI session is logged out or expired, so this task was not run.\n\n' +
        'Recommended: switch this project to Codex with /setdefault codex, or re-authenticate Claude with claude login.'
      );
    case 'usage_limit':
      return (
        '⛔ Usage limit reached\n\n' +
        'Claude has hit your plan\'s usage limit. Usage will reset after your current time block.\n\n' +
        'Check your usage at claude.ai/settings'
      );
    case 'rate_limit':
      return (
        '⚠️ Rate limit hit\n\n' +
        'Too many requests. Claude will be available again shortly — the task has been marked as failed.'
      );
    case 'overloaded':
      return (
        '⚠️ Claude is overloaded\n\n' +
        'Servers are temporarily busy. Try again in a few minutes.'
      );
    default:
      return '❌ Claude returned an error. Check server logs for details.';
  }
}
