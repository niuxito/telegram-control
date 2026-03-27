import { describe, it, expect } from 'vitest';
import { formatFileChanges, formatGitCommits } from '../notifications/formatters.js';
import type { Project } from '../db/queries/projects.js';
import type { GitCommit } from '../watchers/GitWatcher.js';

// Minimal Project stub — only fields used by the formatters
function makeProject(name: string): Project {
  return {
    id: 1,
    name,
    localPath: '/tmp/project',
    topicId: null,
    status: 'active',
    createdAt: new Date(),
    archivedAt: null,
    watchFiles: true,
    watchGit: true,
    gitCheckAt: null,
  };
}

function makeCommit(hash: string, message: string, author: string): GitCommit {
  return { hash, message, author, date: '2026-03-25T00:00:00Z' };
}

describe('formatFileChanges', () => {
  const project = makeProject('my-app');

  it('includes the project name in the header', () => {
    const result = formatFileChanges(project, ['src/index.ts']);
    expect(result).toContain('my-app');
  });

  it('formats each file path as a plain bullet item', () => {
    const result = formatFileChanges(project, ['src/foo.ts', 'src/bar.ts']);
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('src/bar.ts');
  });

  it('handles a single file without truncation', () => {
    const result = formatFileChanges(project, ['README.md']);
    expect(result).not.toContain('more');
    expect(result).toContain('README.md');
  });

  it('shows exactly 20 files without truncation suffix when count is 20', () => {
    const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    const result = formatFileChanges(project, files);
    expect(result).not.toContain('more');
    files.forEach(f => expect(result).toContain(f));
  });

  it('truncates to 20 files and appends "...and N more" when count exceeds 20', () => {
    const files = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
    const result = formatFileChanges(project, files);
    // The 21st file should NOT appear
    expect(result).not.toContain('file20.ts');
    // Should mention the remaining 5
    expect(result).toContain('...and 5 more');
  });

  it('truncation shows correct remainder for 30 files (30 - 20 = 10 more)', () => {
    const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
    const result = formatFileChanges(project, files);
    expect(result).toContain('...and 10 more');
  });

  it('handles an empty file list gracefully', () => {
    const result = formatFileChanges(project, []);
    // Should not throw and should still include header
    expect(result).toContain('my-app');
  });

  it('uses the correct project name when it differs', () => {
    const otherProject = makeProject('backend-api');
    const result = formatFileChanges(otherProject, ['main.py']);
    expect(result).toContain('backend-api');
    expect(result).not.toContain('my-app');
  });
});

describe('formatGitCommits', () => {
  const project = makeProject('my-repo');

  it('includes the project name in the header', () => {
    const commits = [makeCommit('abc1234', 'fix: bug', 'Alice')];
    const result = formatGitCommits(project, commits);
    expect(result).toContain('my-repo');
  });

  it('formats each commit with hash, message, and author', () => {
    const commits = [makeCommit('abc1234', 'feat: add login', 'Bob')];
    const result = formatGitCommits(project, commits);
    expect(result).toContain('abc1234');
    expect(result).toContain('feat: add login');
    expect(result).toContain('Bob');
  });

  it('shows exactly 10 commits without truncation when count is 10', () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      makeCommit(`hash${i}`, `msg${i}`, 'Dev')
    );
    const result = formatGitCommits(project, commits);
    expect(result).not.toContain('more');
    commits.forEach(c => expect(result).toContain(c.hash));
  });

  it('truncates to 10 commits and appends "...and N more" when count exceeds 10', () => {
    const commits = Array.from({ length: 15 }, (_, i) =>
      makeCommit(`hash${i}`, `msg${i}`, 'Dev')
    );
    const result = formatGitCommits(project, commits);
    // The 11th commit's hash should NOT be present
    expect(result).not.toContain('hash10');
    expect(result).toContain('...and 5 more');
  });

  it('truncation shows correct remainder for 12 commits (12 - 10 = 2 more)', () => {
    const commits = Array.from({ length: 12 }, (_, i) =>
      makeCommit(`h${i}`, `m${i}`, 'Dev')
    );
    const result = formatGitCommits(project, commits);
    expect(result).toContain('...and 2 more');
  });

  it('handles an empty commit list gracefully', () => {
    const result = formatGitCommits(project, []);
    expect(result).toContain('my-repo');
  });

  it('formats author in plain text (no markdown)', () => {
    const commits = [makeCommit('aaa0000', 'chore: update deps', 'Charlie')];
    const result = formatGitCommits(project, commits);
    expect(result).toContain('Charlie');
    // Security fix: plain text, no Markdown italics
    expect(result).not.toContain('_(Charlie)_');
  });
});
