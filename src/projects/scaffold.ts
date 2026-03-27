import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { config } from '../config.js';

/**
 * Validates that the given resolved path is within the allowed PROJECTS_BASE_DIR.
 * Throws an error if the path escapes the base directory.
 */
export function assertWithinProjectsBaseDir(resolvedPath: string): void {
  const baseDir = path.resolve(expandPath(config.PROJECTS_BASE_DIR));
  const normalised = path.resolve(resolvedPath);
  if (!normalised.startsWith(baseDir + path.sep) && normalised !== baseDir) {
    throw new Error(
      `Path "${normalised}" is outside the allowed projects directory "${baseDir}". ` +
      `Update PROJECTS_BASE_DIR in your .env if you need a different base directory.`
    );
  }
}

export function scaffoldProject(projectName: string, localPath: string): void {
  const expandedPath = localPath.replace(/^~/, process.env.HOME || '');

  // SECURITY: ensure the project path is within PROJECTS_BASE_DIR
  assertWithinProjectsBaseDir(expandedPath);

  if (!existsSync(expandedPath)) {
    mkdirSync(expandedPath, { recursive: true });
  }

  // Git init if not already a git repo
  const gitDir = path.join(expandedPath, '.git');
  if (!existsSync(gitDir)) {
    execSync('git init', { cwd: expandedPath, stdio: 'ignore' });
  }

  // Create CLAUDE.md if not exists
  const claudeMdPath = path.join(expandedPath, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# ${projectName}

## Project Overview
This project is managed via Telegram Control Center.

## Instructions
- Follow best practices for this project type
- Keep changes focused and well-tested
- Document significant decisions
`);
  }
}

export function expandPath(p: string): string {
  return p.replace(/^~/, process.env.HOME || '');
}
