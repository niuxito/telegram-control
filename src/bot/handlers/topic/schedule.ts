import type { Context } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import { insertSchedule, getSchedulesByProject, deleteSchedule, setScheduleEnabled } from '../../../db/queries/schedules.js';
import type { ScheduleManager } from '../../../projects/ScheduleManager.js';
import cron from 'node-cron';
import type { Db } from '../../../db/client.js';

export function setupScheduleHandlers(bot: any, projectManager: ProjectManager, db: Db, scheduleManager?: ScheduleManager): void {

  bot.command('schedule', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) return;

    const args = ((ctx.match as string) || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    if (sub === 'list') {
      const all = getSchedulesByProject(db, project.id);
      if (all.length === 0) {
        await ctx.reply('No schedules configured. Use /schedule add <cron> <prompt>');
        return;
      }
      const lines = all.map(s => {
        const status = s.enabled ? '✅' : '⏸';
        const last = s.lastRunAt ? new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'never';
        return `${status} [${s.id}] ${s.cronExpr}\n   ${s.prompt.slice(0, 60)}${s.prompt.length > 60 ? '…' : ''}\n   Last run: ${last}`;
      }).join('\n\n');
      await ctx.reply(`Schedules:\n\n${lines}`);
      return;
    }

    if (sub === 'add') {
      if (args.length < 7) {
        await ctx.reply('Usage: /schedule add <cron> <prompt>\nExample: /schedule add "0 9 * * 1" Run weekly lint');
        return;
      }
      let cronExpr: string;
      let promptStart: number;
      const joined = args.slice(1).join(' ');
      const quoted = joined.match(/^"([^"]+)"\s+([\s\S]+)$/);
      if (quoted) {
        cronExpr = quoted[1];
        promptStart = -1;
      } else {
        cronExpr = args.slice(1, 6).join(' ');
        promptStart = 6;
      }
      const prompt = quoted ? quoted[2] : args.slice(promptStart).join(' ');

      if (!cron.validate(cronExpr)) {
        await ctx.reply(`Invalid cron expression: "${cronExpr}"\nFormat: minute hour day month weekday\nExample: "0 9 * * 1" = every Monday at 9:00`);
        return;
      }
      if (!prompt.trim()) {
        await ctx.reply('Prompt cannot be empty.');
        return;
      }

      const schedule = insertSchedule(db, { projectId: project.id, cronExpr, prompt: prompt.trim() });
      scheduleManager?.register(schedule!.id, project.id, cronExpr, prompt.trim());
      await ctx.reply(`✅ Schedule [${schedule!.id}] created\nCron: ${cronExpr}\nPrompt: ${prompt.trim()}`);
      return;
    }

    if (sub === 'remove') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await ctx.reply('Usage: /schedule remove <id>');
        return;
      }
      deleteSchedule(db, id, project.id);
      scheduleManager?.unregister(id);
      await ctx.reply(`✅ Schedule [${id}] removed.`);
      return;
    }

    if (sub === 'on' || sub === 'off') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await ctx.reply(`Usage: /schedule ${sub} <id>`);
        return;
      }
      const enabled = sub === 'on';
      setScheduleEnabled(db, id, project.id, enabled);
      if (enabled) {
        const all = getSchedulesByProject(db, project.id);
        const s = all.find(x => x.id === id);
        if (s) scheduleManager?.register(s.id, project.id, s.cronExpr, s.prompt);
      } else {
        scheduleManager?.unregister(id);
      }
      await ctx.reply(`✅ Schedule [${id}] ${enabled ? 'enabled ✅' : 'paused ⏸'}`);
      return;
    }

    await ctx.reply(
      'Schedule commands:\n' +
      '/schedule list — list all schedules\n' +
      '/schedule add <cron> <prompt> — create schedule\n' +
      '  Example: /schedule add "0 9 * * 1" Run weekly lint\n' +
      '  Cron format: minute hour day month weekday\n' +
      '/schedule remove <id> — delete schedule\n' +
      '/schedule on <id> — enable schedule\n' +
      '/schedule off <id> — pause schedule'
    );
  });
}
