import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  localPath: text('local_path').notNull(),
  topicId: integer('topic_id').unique(),
  status: text('status', { enum: ['active', 'paused', 'archived'] }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
  watchFiles: integer('watch_files', { mode: 'boolean' }).notNull().default(true),
  watchGit: integer('watch_git', { mode: 'boolean' }).notNull().default(true),
  gitCheckAt: integer('git_check_at', { mode: 'timestamp' }),
  wakeWord: text('wake_word'),
});

export const claudeSessions = sqliteTable('claude_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  claudeSessionId: text('claude_session_id'),
  mode: text('mode', { enum: ['cli', 'api'] }).notNull().default('cli'),
  totalCostUsd: real('total_cost_usd').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const taskQueue = sqliteTable('task_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  prompt: text('prompt').notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] }).notNull().default('pending'),
  liveMessageId: integer('live_message_id'),
  result: text('result'),
  costUsd: real('cost_usd'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const notificationLog = sqliteTable('notification_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  type: text('type', { enum: ['file_change', 'git_commit', 'task_complete', 'task_error', 'usage_limit', 'rate_limit'] }).notNull(),
  payload: text('payload').notNull(),
  sentAt: integer('sent_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  telegramMessageId: integer('telegram_message_id'),
});
