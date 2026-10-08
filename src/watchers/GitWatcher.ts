import { simpleGit } from 'simple-git';

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export class GitWatcher {
  private dir: string;
  private onCommits: (commits: GitCommit[]) => void;
  private lastCheckAt: Date;
  private intervalMs = 60000; // 60 seconds
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dir: string, onCommits: (commits: GitCommit[]) => void, lastCheckAt?: Date) {
    this.dir = dir;
    this.onCommits = onCommits;
    this.lastCheckAt = lastCheckAt ?? new Date();
  }

  start(): void {
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    try {
      const git = simpleGit(this.dir);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) return;

      const sinceStr = this.lastCheckAt.toISOString();
      const log = await git.log(['--since', sinceStr, '--format=%H|%s|%an|%ai']);

      this.lastCheckAt = new Date();

      if (log.all.length > 0) {
        const commits: GitCommit[] = log.all.map(c => ({
          hash: c.hash.slice(0, 7),
          message: c.message,
          author: c.author_name,
          date: c.date,
        }));
        this.onCommits(commits);
      }
    } catch (_err) {
      // Not a git repo or git not available, ignore
    }
  }
}
