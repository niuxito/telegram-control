import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { insertTask, getRecentTasks, displayPrompt, SECRET_PROMPT } from '../db/queries/taskQueue.js';
import { projects } from '../db/schema.js';

describe('displayPrompt', () => {
  it('hides secret prompts', () => {
    expect(displayPrompt({ prompt: 'DB_PASSWORD=hunter2', secret: true })).toBe(SECRET_PROMPT);
    expect(displayPrompt({ prompt: 'DB_PASSWORD=hunter2', secret: true }, 5)).toBe(SECRET_PROMPT);
  });

  it('shows and truncates normal prompts', () => {
    expect(displayPrompt({ prompt: 'fix the build', secret: false })).toBe('fix the build');
    expect(displayPrompt({ prompt: 'fix the build' }, 3)).toBe('fix…');
  });
});

describe('task_queue.secret', () => {
  it('defaults to false and stores secret tasks', () => {
    const { db } = createTestDb();
    const project = db.insert(projects).values({ name: 'p', localPath: '/tmp/p', createdAt: new Date() }).returning().get();
    insertTask(db, { projectId: project.id, prompt: 'normal', status: 'pending' });
    insertTask(db, { projectId: project.id, prompt: 'TOKEN=abc', status: 'pending', secret: true });

    const shown = getRecentTasks(db, project.id, 10).map(t => displayPrompt(t)).sort();
    expect(shown).toEqual(['normal', SECRET_PROMPT].sort());
  });
});
