import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private dir: string;
  private onChange: (files: string[]) => void;
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private changedFiles: Set<string> = new Set();

  constructor(dir: string, onChange: (files: string[]) => void, debounceMs = 5000) {
    this.dir = dir;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  start(): void {
    this.watcher = chokidar.watch(this.dir, {
      ignored: [
        /(^|[\/\\])\../,       // dotfiles / hidden dirs
        /node_modules/,
        /\.git/,
        /dist\//,
        /build\//,
        /\.next\//,
        /\.nuxt\//,
        /\.cache\//,
        /coverage\//,
        /\.turbo\//,
        /data\//,              // SQLite DB, WAL, SHM — internal bot state
        /\.db$/,
        /\.db-wal$/,
        /\.db-shm$/,
        /\.log$/,              // log files
        /\.tmp$/,              // generic temp files
        /\.tmp\./,             // editor temp files (e.g. file.ts.tmp.1234.5678)
        /~$/,                  // editor swap/backup files
        /\.swp$/,
        /\.swo$/,
      ],
      persistent: true,
      ignoreInitial: true,
    });

    const handleChange = (filePath: string) => {
      const relative = path.relative(this.dir, filePath);
      this.changedFiles.add(relative);

      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const files = Array.from(this.changedFiles);
        this.changedFiles.clear();
        this.onChange(files);
      }, this.debounceMs);
    };

    this.watcher.on('change', handleChange);
    this.watcher.on('add', handleChange);
    this.watcher.on('unlink', handleChange);
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}
