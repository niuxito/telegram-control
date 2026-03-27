import type { Bot } from 'grammy';
import type { Project } from '../db/queries/projects.js';
import type { GitCommit } from '../watchers/GitWatcher.js';
import { formatFileChanges, formatGitCommits } from './formatters.js';

export class NotificationService {
  private bot: Bot;
  private chatId: number;

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  async notifyFileChanges(project: Project, files: string[]): Promise<void> {
    if (!project.topicId) return;
    try {
      // SECURITY: no parse_mode — formatters produce plain text to avoid Markdown injection
      await this.bot.api.sendMessage(
        this.chatId,
        formatFileChanges(project, files),
        { message_thread_id: project.topicId }
      );
    } catch (err) {
      console.error('[NotificationService] Error sending file change notification:', err);
    }
  }

  async notifyGitCommits(project: Project, commits: GitCommit[]): Promise<void> {
    if (!project.topicId) return;
    try {
      // SECURITY: no parse_mode — formatters produce plain text to avoid Markdown injection
      await this.bot.api.sendMessage(
        this.chatId,
        formatGitCommits(project, commits),
        { message_thread_id: project.topicId }
      );
    } catch (err) {
      console.error('[NotificationService] Error sending git commit notification:', err);
    }
  }
}
