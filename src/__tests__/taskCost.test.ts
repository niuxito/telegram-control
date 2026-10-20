import { describe, it, expect } from 'vitest';
import { taskCostFromCumulative } from '../claude/taskCost.js';

describe('taskCostFromCumulative', () => {
  it('a fresh session costs its whole reported total', () => {
    expect(taskCostFromCumulative(0.0021, 'new', undefined)).toBe(0.0021);
    expect(taskCostFromCumulative(0.0021, 'new', { claudeSessionId: null, reportedCostUsd: null, messageCount: 0 })).toBe(0.0021);
  });

  it('a resumed session costs the difference with the last total', () => {
    const cost = taskCostFromCumulative(0.00398, 's1', { claudeSessionId: 's1', reportedCostUsd: 0.00207, messageCount: 1 });
    expect(cost).toBeCloseTo(0.00191, 6);
  });

  it('a different session id means a new session', () => {
    expect(taskCostFromCumulative(0.5, 's2', { claudeSessionId: 's1', reportedCostUsd: 3, messageCount: 4 })).toBe(0.5);
  });

  it('does not attribute an unknown earlier total to the task', () => {
    // 150 USD reported on a long session started before totals were tracked
    expect(taskCostFromCumulative(150.27, 's1', { claudeSessionId: 's1', reportedCostUsd: null, messageCount: 40 })).toBe(0);
  });

  it('never goes negative', () => {
    expect(taskCostFromCumulative(1, 's1', { claudeSessionId: 's1', reportedCostUsd: 2, messageCount: 3 })).toBe(0);
  });
});
