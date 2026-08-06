import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  config: {
    BOT_TOKEN: 'fake-token',
    SUPERGROUP_ID: -100123456789,
    NEW_PROJECTS_TOPIC_ID: 2,
    OWNER_USER_ID: 42,
    ANTHROPIC_API_KEY: 'fake-key',
    PROJECTS_BASE_DIR: '/tmp/projects',
    DATA_DIR: '/tmp',
    LOG_LEVEL: 'info',
  },
}));

const runCliTaskMock = vi.fn();
vi.mock('../claude/CliStrategy.js', () => ({
  runCliTask: (...args: unknown[]) => runCliTaskMock(...args),
}));
vi.mock('../claude/CodexStrategy.js', () => ({
  runCodexTask: vi.fn(),
}));

import { ClaudeSession } from '../claude/ClaudeSession.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertSession, getLatestSession, updateSession } from '../db/queries/sessions.js';

function seedProject(db: TestDb, projectPath: string): number {
  const proj = insertProject(db, {
    name: 'test-project',
    localPath: projectPath,
    createdAt: new Date(),
    topicId: 100,
  });
  return proj!.id;
}

function makeBotStub() {
  return {
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    },
  };
}

describe('ClaudeSession.checkpoint — baseline snapshot regression', () => {
  let db: TestDb;
  let projectId: number;
  let projectPath: string;
  let session: ClaudeSession;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(tmpdir(), 'tc-checkpoint-'));
    ({ db } = createTestDb());
    projectId = seedProject(db, projectPath);
    const bot = makeBotStub();
    session = new ClaudeSession(db, bot as any, projectId, projectPath, 100, -100123456789, 'test-project');
    runCliTaskMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('snapshots totalCostUsd/messageCount as the new baseline instead of zeroing them', async () => {
    insertSession(db, {
      projectId,
      claudeSessionId: 'claude-abc',
      totalCostUsd: 1.23,
      messageCount: 42,
      lastUsedAt: new Date(),
    });

    runCliTaskMock.mockResolvedValue({
      success: true,
      sessionId: 'new-session',
      costUsd: 0,
      result: 'session summary',
      toolsUsed: {},
    });

    await session.checkpoint();

    const latest = getLatestSession(db, projectId);
    // The bug this guards against: an earlier version zeroed totalCostUsd/
    // messageCount here, which silently broke /budget tracking (it reads
    // session.totalCostUsd as the all-time spend). Those must stay intact —
    // only the checkpoint baseline should move.
    expect(latest!.totalCostUsd).toBe(1.23);
    expect(latest!.messageCount).toBe(42);
    expect(latest!.checkpointBaselineCostUsd).toBe(1.23);
    expect(latest!.checkpointBaselineMessageCount).toBe(42);
    expect(latest!.claudeSessionId).toBeNull();
  });

  it('brings messages/cost-since-checkpoint back to zero, preventing an immediate re-trigger', async () => {
    insertSession(db, {
      projectId,
      claudeSessionId: 'claude-abc',
      totalCostUsd: 0.55,
      messageCount: 31,
      lastUsedAt: new Date(),
    });

    runCliTaskMock.mockResolvedValue({
      success: true,
      sessionId: 'new-session',
      costUsd: 0,
      result: 'session summary',
      toolsUsed: {},
    });

    await session.checkpoint();

    const latest = getLatestSession(db, projectId);
    const messagesSinceCheckpoint = latest!.messageCount - latest!.checkpointBaselineMessageCount;
    const costSinceCheckpoint = latest!.totalCostUsd - latest!.checkpointBaselineCostUsd;

    expect(messagesSinceCheckpoint).toBe(0);
    expect(costSinceCheckpoint).toBe(0);

    // One more task lands (+1 message, some cost) — this should NOT already
    // be past the 30-message / $0.50 thresholds again.
    updateSession(db, latest!.id, {
      messageCount: latest!.messageCount + 1,
      totalCostUsd: latest!.totalCostUsd + 0.01,
    });
    const afterNextTask = getLatestSession(db, projectId);
    const messagesSince2 = afterNextTask!.messageCount - afterNextTask!.checkpointBaselineMessageCount;
    const costSince2 = afterNextTask!.totalCostUsd - afterNextTask!.checkpointBaselineCostUsd;
    expect(messagesSince2).toBeLessThan(30);
    expect(costSince2).toBeLessThan(0.50);
  });
});
