import type { Context, NextFunction } from 'grammy';
import type { ProjectManager } from '../projects/ProjectManager.js';
import { config } from '../config.js';
import { handleNaturalLanguageProjectRequest } from './handlers/newProject.js';

export function createRouter(projectManager: ProjectManager) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const threadId = ctx.message?.message_thread_id;

    // If no thread ID, it's a message in general/no topic
    if (!threadId) {
      await next();
      return;
    }

    // New Projects topic: natural language handling
    if (threadId === config.NEW_PROJECTS_TOPIC_ID) {
      const text = ctx.message?.text;
      if (text && !text.startsWith('/')) {
        await handleNaturalLanguageProjectRequest(ctx, projectManager);
        return;
      }
    }

    await next();
  };
}
