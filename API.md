# Telegram Control — API Reference

Read-only HTTP API that exposes the state of all agents (projects) running in the bot.
Designed for external consumers such as dashboards or visualizations.

## Base URL

```
http://<host>:3001
```

Default port is `3001`. Configure via `API_PORT` in `.env`.

## Authentication

Optional. If `API_KEY` is set in `.env`, all requests must include:

```
Authorization: Bearer <API_KEY>
```

If `API_KEY` is not set, the API is open with no auth required.

---

## Endpoints

### `GET /api/health`

Health check.

**Response**
```json
{ "ok": true, "ts": 1711234567890 }
```

---

### `GET /api/agents`

All active/paused agents with their current state.

**Response** — array of agent objects:
```json
[
  {
    "id": 1,
    "name": "telegram-control",
    "status": "active",
    "localPath": "/home/pi/projects/telegram-control",
    "agent": {
      "status": "working",        // "working" | "idle" | "paused"
      "currentTask": {
        "id": 42,
        "prompt": "Refactor the auth module",
        "startedAt": "2026-03-29T10:00:00.000Z",
        "liveOutput": "Reading src/auth.ts...\nAnalyzing patterns..."
      },
      "pendingCount": 2,
      "session": {
        "id": "abc123",
        "messageCount": 18,
        "totalCostUsd": 0.0423,
        "lastUsedAt": "2026-03-29T09:58:00.000Z"
      }
    }
  }
]
```

`currentTask` is `null` when the agent is idle.
`liveOutput` is the real-time streaming text from Claude as it works.

---

### `GET /api/agents/:id`

Full detail for a single agent including the 20 most recent tasks.

**Response**
```json
{
  "id": 1,
  "name": "telegram-control",
  "status": "active",
  "localPath": "/home/pi/projects/telegram-control",
  "watchFiles": true,
  "watchGit": true,
  "createdAt": "2026-03-01T00:00:00.000Z",
  "agent": {
    "status": "working",
    "currentTask": { "id": 42, "prompt": "...", "startedAt": "...", "liveOutput": "..." },
    "pendingCount": 1,
    "pendingTasks": [
      { "id": 43, "prompt": "Write tests for auth module", "createdAt": "..." }
    ],
    "session": { "id": "abc123", "messageCount": 18, "totalCostUsd": 0.0423, "lastUsedAt": "..." }
  },
  "recentTasks": [
    {
      "id": 41,
      "prompt": "Fix TypeScript errors",
      "status": "completed",
      "costUsd": 0.0031,
      "createdAt": "2026-03-29T09:00:00.000Z",
      "completedAt": "2026-03-29T09:02:10.000Z"
    }
  ]
}
```

Task statuses: `pending` | `running` | `completed` | `failed` | `cancelled`

---

### `GET /api/agents/:id/tasks`

Last 50 tasks for a specific agent.

**Response** — array of task objects (same shape as `recentTasks` above).

---

### `GET /api/agents/live`

Only agents that currently have running or pending work. Useful for polling the "active" state.

**Response**
```json
[
  {
    "agentId": 1,
    "agentName": "telegram-control",
    "running": {
      "id": 42,
      "prompt": "Refactor the auth module",
      "liveOutput": "Reading src/auth.ts..."
    },
    "pendingCount": 2
  }
]
```

Returns an empty array `[]` when all agents are idle.

---

### `GET /api/events` — Server-Sent Events (SSE)

Real-time event stream. Connect once and receive push events as agents work.

**Connection**
```js
const source = new EventSource('http://<host>:3001/api/events', {
  headers: { Authorization: 'Bearer <API_KEY>' }  // omit if no API_KEY
});
```

**Event types**

| Event | When | Data |
|---|---|---|
| `connected` | On connect | `{ ts }` |
| `heartbeat` | Every 15s | `{ ts }` |
| `task:started` | Task begins | `{ type, agentId, agentName, taskId, prompt }` |
| `task:output` | Text chunk from Claude | `{ type, agentId, agentName, text }` |
| `task:completed` | Task finished | `{ type, agentId, agentName, taskId, costUsd }` |
| `task:failed` | Task failed/errored | `{ type, agentId, agentName, taskId }` |

**Example listener**
```js
source.addEventListener('task:started', (e) => {
  const { agentId, agentName, prompt } = JSON.parse(e.data);
  console.log(`${agentName} started: ${prompt}`);
});

source.addEventListener('task:output', (e) => {
  const { agentId, text } = JSON.parse(e.data);
  // Update the agent's live output in your UI
});

source.addEventListener('task:completed', (e) => {
  const { agentId, costUsd } = JSON.parse(e.data);
  console.log(`Agent ${agentId} done. Cost: $${costUsd}`);
});
```

---

## Quick start for the game project

```ts
const BASE = 'http://raspberry.local:3001';

// 1. Load all agents on startup
const agents = await fetch(`${BASE}/api/agents`).then(r => r.json());

// 2. Subscribe to real-time events
const source = new EventSource(`${BASE}/api/events`);

source.addEventListener('task:started', (e) => {
  const ev = JSON.parse(e.data);
  // Animate agent ev.agentId → "working" state
});

source.addEventListener('task:output', (e) => {
  const ev = JSON.parse(e.data);
  // Show ev.text as speech bubble / activity log
});

source.addEventListener('task:completed', (e) => {
  const ev = JSON.parse(e.data);
  // Animate agent ev.agentId → "idle" state, show cost
});

// 3. Poll /api/agents/live as fallback if SSE is unavailable
setInterval(async () => {
  const live = await fetch(`${BASE}/api/agents/live`).then(r => r.json());
  // Sync game state with live
}, 2000);
```

---

## CORS

All endpoints include `Access-Control-Allow-Origin: *` so browser-based projects can connect directly without a proxy.
