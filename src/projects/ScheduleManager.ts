import cron, { type ScheduledTask } from 'node-cron';
import type { Db } from '../db/client.js';
import type { ProjectManager } from './ProjectManager.js';
import { getAllEnabledSchedules, updateScheduleLastRun } from '../db/queries/schedules.js';

export class ScheduleManager {
  private db: Db;
  private projectManager: ProjectManager;
  private jobs = new Map<number, ScheduledTask>();

  constructor(db: Db, projectManager: ProjectManager) {
    this.db = db;
    this.projectManager = projectManager;
  }

  start(): void {
    const all = getAllEnabledSchedules(this.db);
    for (const schedule of all) {
      this.register(schedule.id, schedule.projectId, schedule.cronExpr, schedule.prompt);
    }
    console.log(`[ScheduleManager] Started with ${all.length} active schedule(s)`);
  }

  register(id: number, projectId: number, cronExpr: string, prompt: string): void {
    this.unregister(id);
    if (!cron.validate(cronExpr)) {
      console.warn(`[ScheduleManager] Invalid cron expression for schedule ${id}: ${cronExpr}`);
      return;
    }
    const task = cron.schedule(cronExpr, async () => {
      const session = this.projectManager.getSession(projectId);
      if (!session) {
        console.warn(`[ScheduleManager] No session for project ${projectId}, skipping schedule ${id}`);
        return;
      }
      console.log(`[ScheduleManager] Firing schedule ${id} for project ${projectId}`);
      await session.queueTask(prompt);
      updateScheduleLastRun(this.db, id);
    });
    this.jobs.set(id, task);
  }

  unregister(id: number): void {
    const existing = this.jobs.get(id);
    if (existing) {
      existing.stop();
      this.jobs.delete(id);
    }
  }

  stop(): void {
    for (const [id, task] of this.jobs) {
      task.stop();
      this.jobs.delete(id);
    }
  }
}
