import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { ProjectManager } from '../projects/ProjectManager.js';
import type { Db } from '../db/client.js';
import { getActiveProjects } from '../db/queries/projects.js';
import { getLatestSession } from '../db/queries/sessions.js';
import { getRecentTasks, getRunningTask, getPendingTasks } from '../db/queries/taskQueue.js';
import { agentEvents } from './events.js';

// ─── Auth ────────────────────────────────────────────────────────────────────

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  const auth = req.headers['authorization'] ?? '';
  return auth === `Bearer ${apiKey}`;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  json(res, { error: 'Not found' }, 404);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleHealth(res: ServerResponse): void {
  json(res, { ok: true, ts: Date.now() });
}

function handleAgents(res: ServerResponse, projectManager: ProjectManager, db: Db): void {
  const projects = getActiveProjects(db);
  const agents = projects.map(p => {
    const session = getLatestSession(db, p.id);
    const running = getRunningTask(db, p.id);
    const pending = getPendingTasks(db, p.id);
    const cs = projectManager.getSession(p.id);

    return {
      id: p.id,
      name: p.name,
      status: p.status,
      localPath: p.localPath,
      agent: {
        status: cs?.isProcessing() ? 'working' : (p.status === 'paused' ? 'paused' : 'idle'),
        currentTask: running ? {
          id: running.id,
          prompt: running.prompt,
          startedAt: running.createdAt,
          liveOutput: cs?.getLiveOutput() ?? null,
        } : null,
        pendingCount: pending.length,
        session: session ? {
          id: session.claudeSessionId,
          messageCount: session.messageCount,
          totalCostUsd: session.totalCostUsd,
          lastUsedAt: session.lastUsedAt,
        } : null,
      },
    };
  });

  json(res, agents);
}

function handleAgent(res: ServerResponse, id: number, projectManager: ProjectManager, db: Db): void {
  const projects = getActiveProjects(db);
  const p = projects.find(x => x.id === id);
  if (!p) return notFound(res);

  const session = getLatestSession(db, p.id);
  const running = getRunningTask(db, p.id);
  const pending = getPendingTasks(db, p.id);
  const recent = getRecentTasks(db, p.id, 20);
  const cs = projectManager.getSession(p.id);

  json(res, {
    id: p.id,
    name: p.name,
    status: p.status,
    localPath: p.localPath,
    watchFiles: p.watchFiles,
    watchGit: p.watchGit,
    createdAt: p.createdAt,
    agent: {
      status: cs?.isProcessing() ? 'working' : (p.status === 'paused' ? 'paused' : 'idle'),
      currentTask: running ? {
        id: running.id,
        prompt: running.prompt,
        startedAt: running.createdAt,
        liveOutput: cs?.getLiveOutput() ?? null,
      } : null,
      pendingCount: pending.length,
      pendingTasks: pending.map(t => ({ id: t.id, prompt: t.prompt, createdAt: t.createdAt })),
      session: session ? {
        id: session.claudeSessionId,
        messageCount: session.messageCount,
        totalCostUsd: session.totalCostUsd,
        lastUsedAt: session.lastUsedAt,
      } : null,
    },
    recentTasks: recent.map(t => ({
      id: t.id,
      prompt: t.prompt,
      status: t.status,
      costUsd: t.costUsd,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
}

function handleAgentTasks(res: ServerResponse, id: number, db: Db): void {
  const tasks = getRecentTasks(db, id, 50);
  if (!tasks.length) {
    // Could be an unknown project — return empty array either way
    return json(res, []);
  }
  json(res, tasks.map(t => ({
    id: t.id,
    prompt: t.prompt,
    status: t.status,
    costUsd: t.costUsd,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  })));
}

function handleLive(res: ServerResponse, projectManager: ProjectManager, db: Db): void {
  const projects = getActiveProjects(db);
  const live = projects
    .map(p => {
      const running = getRunningTask(db, p.id);
      const pending = getPendingTasks(db, p.id);
      const cs = projectManager.getSession(p.id);
      if (!running && pending.length === 0) return null;
      return {
        agentId: p.id,
        agentName: p.name,
        running: running ? {
          id: running.id,
          prompt: running.prompt,
          liveOutput: cs?.getLiveOutput() ?? null,
        } : null,
        pendingCount: pending.length,
      };
    })
    .filter(Boolean);

  json(res, live);
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function handleSSE(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connected event
  send('connected', { ts: Date.now() });

  const listener = (data: unknown) => {
    const evt = data as { type: string };
    send(evt.type, data);
  };

  agentEvents.on('agent', listener);

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => send('heartbeat', { ts: Date.now() }), 15_000);

  req.on('close', () => {
    agentEvents.off('agent', listener);
    clearInterval(heartbeat);
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function startApiServer(
  projectManager: ProjectManager,
  db: Db,
  port: number,
  apiKey?: string,
): void {
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization' });
      res.end();
      return;
    }

    if (!isAuthorized(req, apiKey)) return unauthorized(res);

    const url = req.url?.split('?')[0] ?? '/';

    // GET /api/health
    if (url === '/api/health') return handleHealth(res);

    // GET /api/agents
    if (url === '/api/agents') return handleAgents(res, projectManager, db);

    // GET /api/agents/live
    if (url === '/api/agents/live') return handleLive(res, projectManager, db);

    // GET /api/events  (SSE)
    if (url === '/api/events') return handleSSE(req, res);

    // GET /api/agents/:id
    const agentMatch = url.match(/^\/api\/agents\/(\d+)$/);
    if (agentMatch) return handleAgent(res, parseInt(agentMatch[1]), projectManager, db);

    // GET /api/agents/:id/tasks
    const tasksMatch = url.match(/^\/api\/agents\/(\d+)\/tasks$/);
    if (tasksMatch) return handleAgentTasks(res, parseInt(tasksMatch[1]), db);

    notFound(res);
  });

  server.listen(port, () => {
    console.log(`[API] Server running on http://localhost:${port}`);
  });
}
