import type { Db } from '../db/client.js';
import type { Bot } from 'grammy';
import { readdirSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import {
  getActiveProjects,
  getAllProjects,
  getProjectByTopicId,
  getProjectById,
  insertProject,
  updateProject,
  type Project,
} from '../db/queries/projects.js';
import { ClaudeSession } from '../claude/ClaudeSession.js';
import { FileWatcher } from '../watchers/FileWatcher.js';
import { GitWatcher } from '../watchers/GitWatcher.js';
import { NotificationService } from '../notifications/NotificationService.js';
import { scaffoldProject, expandPath } from './scaffold.js';
import { simpleGit } from 'simple-git';
import { config } from '../config.js';

export class ProjectManager {
  private db: Db;
  private bot: Bot;
  private sessions: Map<number, ClaudeSession> = new Map();
  private fileWatchers: Map<number, FileWatcher> = new Map();
  private gitWatchers: Map<number, GitWatcher> = new Map();
  private notificationService: NotificationService;

  constructor(db: Db, bot: Bot) {
    this.db = db;
    this.bot = bot;
    this.notificationService = new NotificationService(bot, config.SUPERGROUP_ID);
  }

  async loadActiveProjects(): Promise<void> {
    const projects = getActiveProjects(this.db);
    for (const project of projects) {
      if (project.topicId) {
        await this.startProjectRuntime(project);
      }
    }
    console.log(`[ProjectManager] Loaded ${projects.length} active projects`);
  }

  private async startProjectRuntime(project: Project): Promise<void> {
    if (!project.topicId) return;

    const session = new ClaudeSession(
      this.db,
      this.bot,
      project.id,
      expandPath(project.localPath),
      project.topicId,
      config.SUPERGROUP_ID,
      project.name,
      project.model ?? undefined
    );
    this.sessions.set(project.id, session);

    // Rehydrate the queue: clean up tasks left running by a previous process
    // and resume any pending tasks that were waiting before the restart.
    try {
      const { orphaned, resumed } = await session.rehydrate();
      if (orphaned || resumed) {
        console.log(`[ProjectManager] ${project.name}: rehydrated ${orphaned} orphaned, resumed ${resumed} pending`);
      }
    } catch (err) {
      console.warn(`[ProjectManager] ${project.name}: rehydrate failed —`, err instanceof Error ? err.message : err);
    }

    if (project.watchFiles) {
      const fw = new FileWatcher(
        expandPath(project.localPath),
        (files) => this.notificationService.notifyFileChanges(project, files)
      );
      fw.start();
      this.fileWatchers.set(project.id, fw);
    }

    if (project.watchGit) {
      const gw = new GitWatcher(
        expandPath(project.localPath),
        (commits) => this.notificationService.notifyGitCommits(project, commits),
        project.gitCheckAt ?? undefined
      );
      gw.start();
      this.gitWatchers.set(project.id, gw);
    }
  }

  /** Creates a new project under PROJECTS_BASE_DIR/<name>, scaffolding the directory. */
  async createProject(name: string): Promise<Project> {
    const localPath = path.join(expandPath(config.PROJECTS_BASE_DIR), name);
    scaffoldProject(name, localPath);
    return this._registerProject(name, localPath, '🚀 Project created!');
  }

  /** Clones a GitHub repo into PROJECTS_BASE_DIR/<name> and registers it.
   *  Uses `gh repo clone` so existing gh auth credentials are used automatically. */
  async cloneProject(url: string): Promise<Project> {
    const match = url.match(/([^/]+?)(?:\.git)?$/);
    if (!match) throw new Error(`Cannot extract repo name from URL: ${url}`);
    const name = match[1];
    const baseDir = expandPath(config.PROJECTS_BASE_DIR);
    const localPath = path.join(baseDir, name);
    console.log(`[ProjectManager] Cloning ${url} into ${localPath} via gh`);

    await new Promise<void>((resolve, reject) => {
      const child = spawn('gh', ['repo', 'clone', url, localPath], {
        stdio: 'pipe',
        cwd: baseDir,
      });
      child.on('close', (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`gh repo clone exited with code ${code}`));
      });
      child.on('error', reject);
    });

    return this._registerProject(name, localPath, '🔗 Project cloned!');
  }

  /** Imports an existing directory from PROJECTS_BASE_DIR/<name> without overwriting anything. */
  async importProject(name: string): Promise<Project> {
    const localPath = path.join(expandPath(config.PROJECTS_BASE_DIR), name);
    scaffoldProject(name, localPath); // adds CLAUDE.md if missing; skips existing dirs/git
    return this._registerProject(name, localPath, '📦 Project imported!');
  }

  /** Shared logic: create forum topic, insert in DB, start watchers, send welcome message. */
  private async _registerProject(name: string, localPath: string, label: string): Promise<Project> {
    const topic = await this.bot.api.createForumTopic(config.SUPERGROUP_ID, `📁 ${name}`);

    const project = insertProject(this.db, {
      name,
      localPath,
      topicId: topic.message_thread_id,
      status: 'active',
    });

    await this.startProjectRuntime(project);

    await this.bot.api.sendMessage(
      config.SUPERGROUP_ID,
      `${label} "${name}"\n\nPath: ${localPath}\n\nUse /task <prompt> to start working.`,
      { message_thread_id: topic.message_thread_id }
    );

    return project;
  }

  /**
   * Returns directory names inside PROJECTS_BASE_DIR that exist on disk
   * but are not yet tracked in the database.
   */
  scanUntracked(): string[] {
    const baseDir = expandPath(config.PROJECTS_BASE_DIR);
    const trackedPaths = new Set(getAllProjects(this.db).map(p => p.localPath));

    try {
      return readdirSync(baseDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .filter(name => !trackedPaths.has(path.join(baseDir, name)));
    } catch {
      return [];
    }
  }

  getByTopicId(topicId: number): Project | undefined {
    return getProjectByTopicId(this.db, topicId) ?? undefined;
  }

  getSession(projectId: number): ClaudeSession | undefined {
    return this.sessions.get(projectId);
  }

  async archiveProject(projectId: number): Promise<void> {
    updateProject(this.db, projectId, { status: 'archived', archivedAt: new Date() });
    this.fileWatchers.get(projectId)?.stop();
    this.gitWatchers.get(projectId)?.stop();
    this.fileWatchers.delete(projectId);
    this.gitWatchers.delete(projectId);
    this.sessions.delete(projectId);
  }

  async pauseProject(projectId: number): Promise<void> {
    updateProject(this.db, projectId, { status: 'paused' });
    this.fileWatchers.get(projectId)?.stop();
    this.gitWatchers.get(projectId)?.stop();
  }

  async unpauseProject(projectId: number): Promise<void> {
    const project = getProjectById(this.db, projectId);
    if (!project) return;
    updateProject(this.db, projectId, { status: 'active' });
    if (project.topicId) {
      await this.startProjectRuntime({ ...project, status: 'active' });
    }
  }

  getAllProjects(): Project[] {
    return getActiveProjects(this.db);
  }

  async stopAll(): Promise<void> {
    for (const [_id, fw] of this.fileWatchers) fw.stop();
    for (const [_id, gw] of this.gitWatchers) gw.stop();
    this.fileWatchers.clear();
    this.gitWatchers.clear();
    this.sessions.clear();
  }

  setWatchFiles(projectId: number, enabled: boolean): void {
    const project = getProjectById(this.db, projectId);
    if (!project) return;
    updateProject(this.db, projectId, { watchFiles: enabled });
    if (enabled && !this.fileWatchers.has(projectId)) {
      const fw = new FileWatcher(
        expandPath(project.localPath),
        (files) => this.notificationService.notifyFileChanges(project, files)
      );
      fw.start();
      this.fileWatchers.set(projectId, fw);
    } else if (!enabled) {
      this.fileWatchers.get(projectId)?.stop();
      this.fileWatchers.delete(projectId);
    }
  }

  setWatchGit(projectId: number, enabled: boolean): void {
    const project = getProjectById(this.db, projectId);
    if (!project) return;
    updateProject(this.db, projectId, { watchGit: enabled });
    if (enabled && !this.gitWatchers.has(projectId)) {
      const gw = new GitWatcher(
        expandPath(project.localPath),
        (commits) => this.notificationService.notifyGitCommits(project, commits),
        project.gitCheckAt ?? undefined
      );
      gw.start();
      this.gitWatchers.set(projectId, gw);
    } else if (!enabled) {
      this.gitWatchers.get(projectId)?.stop();
      this.gitWatchers.delete(projectId);
    }
  }
}
