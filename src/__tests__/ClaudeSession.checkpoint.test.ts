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
import { CHECKPOINT_PROMPT } from '../claude/checkpointFormat.js';
import { createTestDb, type TestDb } from './helpers/testDb.js';
import { insertProject } from '../db/queries/projects.js';
import { insertSession, getLatestSession, updateSession } from '../db/queries/sessions.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Waits until `predicate()` is true, polling on microtask/macrotask boundaries. */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('waitFor: condition never became true');
}

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

  it('re-fetches the session before writing the baseline, so a task that completes during the checkpoint CLI call is not lost', async () => {
    insertSession(db, {
      projectId,
      claudeSessionId: 'claude-abc',
      totalCostUsd: 0.30,
      messageCount: 30,
      lastUsedAt: new Date(),
    });

    const checkpointCall = deferred<any>();
    runCliTaskMock.mockImplementation((args: any) => {
      if (args.prompt === CHECKPOINT_PROMPT) return checkpointCall.promise;
      return Promise.resolve({ success: true, sessionId: 'sess', costUsd: 0, result: 'ok', toolsUsed: {} });
    });

    const checkpointPromise = session.checkpoint();

    // Simulate another task completing (and bumping the live counters) while
    // the checkpoint's own CLI call is still in flight.
    const before = getLatestSession(db, projectId)!;
    updateSession(db, before.id, {
      totalCostUsd: before.totalCostUsd + 0.05,
      messageCount: before.messageCount + 1,
    });

    checkpointCall.resolve({ success: true, sessionId: 'new-session', costUsd: 0, result: 'session summary', toolsUsed: {} });
    await checkpointPromise;

    const latest = getLatestSession(db, projectId)!;
    // Baseline must match the values as of the reset, including the
    // concurrent task's contribution — not the stale snapshot read before
    // the (slow) checkpoint CLI call started.
    expect(latest.checkpointBaselineMessageCount).toBe(31);
    expect(latest.checkpointBaselineCostUsd).toBeCloseTo(0.35, 5);
  });
});

describe('ClaudeSession auto-checkpoint — re-entrancy guard', () => {
  let db: TestDb;
  let projectId: number;
  let projectPath: string;
  let session: ClaudeSession;
  let bot: ReturnType<typeof makeBotStub>;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(tmpdir(), 'tc-checkpoint-guard-'));
    ({ db } = createTestDb());
    projectId = seedProject(db, projectPath);
    bot = makeBotStub();
    session = new ClaudeSession(db, bot as any, projectId, projectPath, 100, -100123456789, 'test-project');
    runCliTaskMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  // Skipped: auto-checkpoint is disabled (AUTO_CHECKPOINT_ENABLED = false in
  // ClaudeSession.ts) until the real over-triggering cause is found, so the
  // trigger path this test exercises never fires. Re-enable this test
  // alongside the feature.
  it.skip('does not fire a second auto-checkpoint while one is still in flight', async () => {
    insertSession(db, {
      projectId,
      claudeSessionId: 'claude-abc',
      totalCostUsd: 0,
      messageCount: 29,
      lastUsedAt: new Date(),
    });

    const checkpointCall = deferred<any>();
    let checkpointCalls = 0;
    runCliTaskMock.mockImplementation((args: any) => {
      if (args.prompt === CHECKPOINT_PROMPT) {
        checkpointCalls++;
        return checkpointCall.promise;
      }
      return Promise.resolve({ success: true, sessionId: 'sess', costUsd: 0, result: 'ok', toolsUsed: {} });
    });

    // Task 1 pushes messageCount to 30 — crosses the auto-checkpoint threshold
    // and kicks off checkpoint() in the background (its CLI call stays pending).
    await session.queueTask('task 1');
    await waitFor(() => session.isCheckpointInProgress());
    expect(checkpointCalls).toBe(1);

    // Task 2 lands while the checkpoint is still in flight. It would also be
    // past threshold (31 - baseline(0) >= 30) if the guard weren't in place.
    await session.queueTask('task 2');
    await waitFor(() => !session.isProcessing());
    expect(checkpointCalls).toBe(1);

    checkpointCall.resolve({ success: true, sessionId: 'new-session', costUsd: 0, result: 'session summary', toolsUsed: {} });
    await waitFor(() => !session.isCheckpointInProgress());

    expect(checkpointCalls).toBe(1);
  });
});
