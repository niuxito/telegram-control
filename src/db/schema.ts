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
  model: text('model'),
  qaEnabled: integer('qa_enabled', { mode: 'boolean' }).notNull().default(true),
  budgetUsd: real('budget_usd'),
  defaultAgent: text('default_agent', { enum: ['claude', 'codex', 'opencode'] }).notNull().default('claude'),
});

export const claudeSessions = sqliteTable('claude_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  claudeSessionId: text('claude_session_id'),
  mode: text('mode', { enum: ['cli', 'api'] }).notNull().default('cli'),
  totalCostUsd: real('total_cost_usd').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  // Snapshot of totalCostUsd/messageCount at the last checkpoint. The
  // auto-checkpoint trigger compares current totals against this baseline
  // instead of the totals themselves, since those stay cumulative for /budget.
  checkpointBaselineCostUsd: real('checkpoint_baseline_cost_usd').notNull().default(0),
  checkpointBaselineMessageCount: integer('checkpoint_baseline_message_count').notNull().default(0),
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

export const localIssues = sqliteTable('local_issues', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
});

export const schedules = sqliteTable('schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  cronExpr: text('cron_expr').notNull(),
  prompt: text('prompt').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
});

export const accessRequests = sqliteTable('access_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().unique(),
  username: text('username'),
  fullName: text('full_name'),
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull().default('pending'),
  requestedAt: integer('requested_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
});

export const guests = sqliteTable('guests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().unique(),
  note: text('note'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const projectNotes = sqliteTable('project_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  text: text('text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// Global backlog of project ideas, not tied to any existing project. Anyone
// with access to the bot (owner or guest) can add an idea via /idea <text>.
// addedBy / addedByName are optional so we can credit ideas in /idea list.
export const ideas = sqliteTable('ideas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  addedBy: integer('added_by'),
  addedByName: text('added_by_name'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// Append-only history for an idea. The original ideas.text is the title/headline;
// each entry expands the idea over time, similar to an issue timeline.
export const ideaEntries = sqliteTable('idea_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ideaId: integer('idea_id').notNull().references(() => ideas.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  addedBy: integer('added_by'),
  addedByName: text('added_by_name'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const topicMessages = sqliteTable('topic_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  sender: text('sender', { enum: ['user', 'claude', 'codex', 'opencode'] }).notNull(),
  senderName: text('sender_name'),
  text: text('text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const notificationLog = sqliteTable('notification_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  type: text('type', { enum: ['file_change', 'git_commit', 'task_complete', 'task_error', 'usage_limit', 'rate_limit'] }).notNull(),
  payload: text('payload').notNull(),
  sentAt: integer('sent_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  telegramMessageId: integer('telegram_message_id'),
});
