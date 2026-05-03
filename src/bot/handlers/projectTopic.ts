import type { ProjectManager } from '../../projects/ProjectManager.js';
import type { ScheduleManager } from '../../projects/ScheduleManager.js';
import type { Db } from '../../db/client.js';

import { setupTaskHandlers } from './topic/tasks.js';
import { setupGitHandlers } from './topic/git.js';
import { setupIssueHandlers } from './topic/issues.js';
import { setupScheduleHandlers } from './topic/schedule.js';
import { setupConfigHandlers } from './topic/config.js';
import { setupTopicTextFallback } from './topic/text.js';

// Re-export pending state helpers used by callbacks.ts and index.ts
export { getPendingSecret, setPendingSecret, clearPendingSecret } from './topic/config.js';
export { getPendingGithubPublic, clearPendingGithubPublic, getPendingVercelDeploy, clearPendingVercelDeploy, buildGithubPrompt, buildVercelPrompt } from './topic/git.js';
export { getPendingIssueRequest, clearPendingIssueRequest } from './topic/issues.js';

export function setupProjectTopicHandlers(
  bot: any,
  projectManager: ProjectManager,
  db: Db,
  scheduleManager?: ScheduleManager,
): void {
  setupTaskHandlers(bot, projectManager, db);
  setupGitHandlers(bot, projectManager, db);
  setupIssueHandlers(bot, projectManager, db);
  setupScheduleHandlers(bot, projectManager, db, scheduleManager);
  setupConfigHandlers(bot, projectManager, db);
  // Catch-all text handler — must be registered LAST so it doesn't swallow commands
  setupTopicTextFallback(bot, projectManager, db);
}
