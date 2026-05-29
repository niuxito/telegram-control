// Codex OAuth device-authorization flow driver.
//
// Spawns `codex login --device-auth` and parses its output to extract the
// activation URL and one-time code. Caller wires the rest (Telegram message
// + cancel button). When the user completes the flow in a browser, the codex
// process exits with code 0; we surface that as a clean onComplete event.
//
// Output shape (captured empirically against opencode-bundled @openai/codex
// v0.121.0 on 2026-05-29):
//
//   Welcome to Codex [v0.121.0]
//   OpenAI's command-line coding agent
//
//   Follow these steps to sign in with ChatGPT using device code authorization:
//
//   1. Open this link in your browser and sign in to your account
//      https://auth.openai.com/codex/device
//
//   2. Enter this one-time code (expires in 15 minutes)
//      SEC7-R726R
//
//   Device codes are a common phishing target. Never share this code.
//
// Real output also includes ANSI escape sequences which we strip before
// matching.

import { spawn, type ChildProcess } from 'child_process';
import { CODEX_BIN } from './CodexStrategy.js';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface DeviceAuthInit {
  url: string;
  code: string;
  expiresInMinutes?: number;
}

export interface DeviceAuthListener {
  onInit: (init: DeviceAuthInit) => void;     // URL + code captured
  onComplete: () => void;                       // user finished the flow, login is valid
  onError: (err: string) => void;               // spawn failed, parse failed, or exit before init
  onCancelled: () => void;                      // process killed by caller after init
}

export interface DeviceAuthHandle {
  process: ChildProcess;
  cancel: () => void;
}

/**
 * Parses a buffer of (possibly partial) stdout from `codex login --device-auth`.
 * Returns null if the URL or code isn't visible yet. Exported for testing.
 */
export function parseDeviceAuthOutput(buffer: string): DeviceAuthInit | null {
  const clean = stripAnsi(buffer);
  const urlMatch = clean.match(/https:\/\/auth\.openai\.com\/codex\/device/);
  // Code lives on its own line after the "Enter this one-time code" marker.
  // Pattern matches typical OAuth device codes: groups of letters/digits
  // separated by hyphens. We require at least one hyphen.
  const codeMatch = clean.match(/Enter this one-time code[^\n]*\n\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)/);
  if (!urlMatch || !codeMatch) return null;

  const minMatch = clean.match(/expires in (\d+)\s*minutes?/i);
  return {
    url: urlMatch[0],
    code: codeMatch[1],
    expiresInMinutes: minMatch ? parseInt(minMatch[1], 10) : undefined,
  };
}

/**
 * Starts the codex device-auth flow. Returns immediately with a handle that
 * exposes the child process and a cancel() helper. The listener callbacks
 * fire as the flow progresses.
 *
 * Lifecycle:
 *   - Spawn `codex login --device-auth`.
 *   - As stdout chunks arrive, try to parse out (url, code). On first hit,
 *     fire onInit.
 *   - When the process exits with code 0, fire onComplete.
 *   - If the process exits before onInit, fire onError ("exited before URL").
 *   - If cancel() was called, fire onCancelled on exit (whatever the code).
 */
export function startCodexDeviceAuth(listener: DeviceAuthListener): DeviceAuthHandle {
  const child = spawn(CODEX_BIN, ['login', '--device-auth'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '0' },
  });

  let buffer = '';
  let initSent = false;
  let cancelled = false;

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    if (!initSent) {
      const init = parseDeviceAuthOutput(buffer);
      if (init) {
        initSent = true;
        try { listener.onInit(init); } catch { /* listener errors are not fatal */ }
      }
    }
  });

  child.stderr.on('data', () => { /* codex device-auth writes to stdout only */ });

  child.on('error', (err) => {
    if (!initSent) listener.onError(`spawn failed: ${err.message}`);
  });

  child.on('close', (code) => {
    if (cancelled) {
      listener.onCancelled();
      return;
    }
    if (!initSent) {
      listener.onError(`codex login exited with code ${code ?? 'null'} before producing a device URL`);
      return;
    }
    if (code === 0) {
      listener.onComplete();
    } else {
      // Exited after init with non-zero code: likely a 15-minute server-side timeout.
      listener.onError(`codex login exited with code ${code} after device URL was shown (timeout or refused)`);
    }
  });

  return {
    process: child,
    cancel: () => {
      cancelled = true;
      child.kill();
    },
  };
}
