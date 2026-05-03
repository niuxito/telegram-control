import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SETUP_COMPLETE_FILE = path.join(DATA_DIR, '.setup-complete');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = 'ok' | 'warn' | 'error';

interface CheckResult {
  label: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function tryRun(cmd: string): string | null {
  try {
    return run(cmd);
  } catch {
    return null;
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function renderResult(r: CheckResult): void {
  const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌';
  console.log(`${icon} ${r.label} — ${r.message}`);
  if (r.fix) {
    const lines = r.fix.split('\n');
    for (const line of lines) {
      console.log(`   ${line}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNodeVersion(): CheckResult {
  const label = 'Node.js';
  const raw = process.version; // e.g. "v22.1.0"
  const major = parseInt(raw.replace('v', '').split('.')[0], 10);
  if (major >= 18) {
    return { label, status: 'ok', message: raw };
  }
  return {
    label,
    status: 'error',
    message: `${raw} (requires >= 18)`,
    fix: 'Install Node.js 18+ via nvm:\n  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash\n  nvm install 22\n  nvm use 22',
  };
}

function checkNpmPackages(): CheckResult {
  const label = 'npm packages';
  const nodeModules = path.join(PROJECT_ROOT, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    return { label, status: 'ok', message: 'installed' };
  }
  return {
    label,
    status: 'error',
    message: 'node_modules not found',
    fix: 'Run:\n  npm install',
  };
}

function checkBetterSqlite(): CheckResult {
  const label = 'better-sqlite3 native module';
  // Use execSync to probe the native module without ESM import machinery.
  // This avoids the require()-in-ESM issue while still catching native binding errors.
  const nodeModules = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(nodeModules)) {
    return {
      label,
      status: 'error',
      message: 'not found in node_modules',
      fix: 'Run:\n  npm install',
    };
  }
  const result = tryRun(
    `node --input-type=module --eval "import Database from 'better-sqlite3'; new Database(':memory:').close();" 2>&1`
  );
  if (result !== null && !result.toLowerCase().includes('error')) {
    return { label, status: 'ok', message: 'OK' };
  }
  return {
    label,
    status: 'error',
    message: result ? `failed (${result.split('\n')[0]})` : 'native binding failed to load',
    fix: 'Install build tools then rebuild:\n  sudo apt-get install -y build-essential python3\n  npm rebuild better-sqlite3',
  };
}

function checkClaudeCli(): CheckResult {
  const label = 'Claude CLI';
  const out = tryRun('claude --version');
  if (out) {
    return { label, status: 'ok', message: out.split('\n')[0] };
  }
  return {
    label,
    status: 'error',
    message: 'not installed',
    fix: 'Install (native installer):\n  curl -fsSL https://claude.ai/install.sh | bash\nThen authenticate (interactive):\n  claude login',
  };
}

function checkClaudeAuth(): CheckResult {
  const label = 'Claude authenticated';
  // Try `claude whoami` first; fall back to checking ~/.claude/
  const out = tryRun('claude whoami 2>/dev/null');
  if (out && out.length > 0 && !out.toLowerCase().includes('not logged')) {
    return { label, status: 'ok', message: out.split('\n')[0] };
  }
  // Fallback: check for credentials file
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const claudeDir = path.join(homeDir, '.claude');
  if (fs.existsSync(claudeDir) && fs.readdirSync(claudeDir).length > 0) {
    return { label, status: 'ok', message: 'credentials found in ~/.claude/' };
  }
  return {
    label,
    status: 'error',
    message: 'not authenticated',
    fix: 'Run:\n  claude login',
  };
}

function checkCodexCli(): CheckResult {
  const label = 'Codex CLI (optional — parallel AI agent with ChatGPT subscription)';
  const localBin = path.join(PROJECT_ROOT, 'node_modules/.bin/codex');
  if (fs.existsSync(localBin)) {
    const out = tryRun(`${localBin} --version`);
    return { label, status: 'ok', message: out?.split('\n')[0] ?? 'installed (local)' };
  }
  const globalOut = tryRun('codex --version');
  if (globalOut) {
    return { label, status: 'ok', message: globalOut.split('\n')[0] };
  }
  return {
    label,
    status: 'warn',
    message: 'not installed (optional)',
    fix: 'Install:\n  npm install @openai/codex\nThen authenticate with your ChatGPT subscription:\n  npx codex login',
  };
}

function checkCodexAuth(): CheckResult {
  const label = 'Codex authenticated';
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const codexConfig = path.join(homeDir, '.codex');
  if (fs.existsSync(codexConfig) && fs.readdirSync(codexConfig).length > 0) {
    return { label, status: 'ok', message: 'credentials found in ~/.codex/' };
  }
  return {
    label,
    status: 'warn',
    message: 'not authenticated (optional)',
    fix: 'Run:\n  npx codex login',
  };
}

function checkGhCli(): CheckResult {
  const label = 'gh CLI (optional — needed for /github command)';
  const out = tryRun('gh --version');
  if (out) {
    return { label, status: 'ok', message: out.split('\n')[0] };
  }
  return {
    label,
    status: 'warn',
    message: 'not installed (optional)',
    fix: 'Install on Raspberry Pi (Debian):\n  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg\n  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null\n  sudo apt update && sudo apt install gh\n  gh auth login',
  };
}

function checkGhAuth(): CheckResult {
  const label = 'gh authenticated';
  const out = tryRun('gh auth status 2>&1');
  if (out && out.includes('Logged in')) {
    return { label, status: 'ok', message: 'authenticated' };
  }
  return {
    label,
    status: 'warn',
    message: 'not authenticated (optional)',
    fix: 'Run:\n  gh auth login',
  };
}

function checkVercelCli(): CheckResult {
  const label = 'Vercel CLI (optional — needed for /vercel command)';
  const out = tryRun('vercel --version');
  if (out) {
    return { label, status: 'ok', message: out.split('\n')[0] };
  }
  return {
    label,
    status: 'warn',
    message: 'not installed (optional)',
    fix: 'Install:\n  npm install -g vercel\nThen authenticate:\n  vercel login',
  };
}

function checkVercelAuth(): CheckResult {
  const label = 'Vercel authenticated';
  const out = tryRun('vercel whoami 2>/dev/null');
  if (out && out.length > 0 && !out.toLowerCase().includes('error')) {
    return { label, status: 'ok', message: out.split('\n')[0] };
  }
  return {
    label,
    status: 'warn',
    message: 'not authenticated (optional)',
    fix: 'Run:\n  vercel login',
  };
}

function checkGit(): CheckResult {
  const label = 'git';
  const out = tryRun('git --version');
  if (out) {
    return { label, status: 'ok', message: out };
  }
  return {
    label,
    status: 'error',
    message: 'not installed',
    fix: 'Install:\n  sudo apt-get install -y git',
  };
}

function checkEnvFile(): CheckResult {
  const label = '.env file';
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    return { label, status: 'ok', message: 'found' };
  }
  const examplePath = path.join(PROJECT_ROOT, '.env.example');
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    return {
      label,
      status: 'warn',
      message: 'created from .env.example',
      fix: 'Edit .env and fill in your credentials.',
    };
  }
  return {
    label,
    status: 'error',
    message: '.env not found and no .env.example to copy from',
    fix: 'Create a .env file with the required variables (see .env.example).',
  };
}

function checkRequiredEnvVars(): CheckResult {
  const label = 'Required env vars';
  // Load .env manually to avoid side effects from the full config module
  const envPath = path.join(PROJECT_ROOT, '.env');
  const env: Record<string, string> = {};

  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      env[key] = value;
    }
  }

  // Merge with actual process.env (already-set vars take precedence)
  const merged = { ...env, ...process.env };

  const required = [
    'BOT_TOKEN',
    'SUPERGROUP_ID',
    'NEW_PROJECTS_TOPIC_ID',
    'OWNER_USER_ID',
  ];
  // ANTHROPIC_API_KEY is optional if using Claude account auth
  const optional = ['ANTHROPIC_API_KEY'];

  const missing = required.filter((k) => !merged[k] || merged[k] === '');
  const missingOptional = optional.filter((k) => !merged[k] || merged[k] === '');

  if (missing.length === 0 && missingOptional.length === 0) {
    return { label, status: 'ok', message: 'all set' };
  }

  if (missing.length > 0) {
    let fix = `Edit .env and set: ${missing.join(', ')}`;
    if (missingOptional.length > 0) {
      fix += `\nOptional (not set): ${missingOptional.join(', ')} — not needed if using Claude account auth`;
    }
    return { label, status: 'error', message: `missing: ${missing.join(', ')}`, fix };
  }

  // Only optional missing
  return {
    label,
    status: 'warn',
    message: `ANTHROPIC_API_KEY not set (OK if using Claude account auth)`,
    fix: 'Set ANTHROPIC_API_KEY in .env if you want to use the Anthropic API directly.',
  };
}

// ---------------------------------------------------------------------------
// Main wizard runner
// ---------------------------------------------------------------------------

export async function runWizard(): Promise<boolean> {
  const forceCheck = process.argv.includes('--check');

  // Skip if already set up and not forcing a re-check
  if (!forceCheck && fs.existsSync(SETUP_COMPLETE_FILE)) {
    return true;
  }

  console.log('\n=== Telegram Control — Setup Check ===\n');

  // Run all checks
  const results: CheckResult[] = [];

  results.push(checkNodeVersion());
  results.push(checkNpmPackages());
  results.push(checkBetterSqlite());
  results.push(checkClaudeCli());
  results.push(checkClaudeAuth());

  const codexResult = checkCodexCli();
  results.push(codexResult);
  if (codexResult.status === 'ok') {
    results.push(checkCodexAuth());
  }

  const ghResult = checkGhCli();
  results.push(ghResult);
  if (ghResult.status === 'ok') {
    results.push(checkGhAuth());
  }

  const vercelResult = checkVercelCli();
  results.push(vercelResult);
  if (vercelResult.status === 'ok') {
    results.push(checkVercelAuth());
  }

  results.push(checkGit());
  results.push(checkEnvFile());
  results.push(checkRequiredEnvVars());

  // Print results
  for (const r of results) {
    renderResult(r);
  }

  // Count errors and warnings
  const errors = results.filter((r) => r.status === 'error');
  const warnings = results.filter((r) => r.status === 'warn');

  console.log('\n=== Summary ===');
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ All checks passed! Starting bot...\n');
    markSetupComplete();
    return true;
  }

  if (errors.length > 0) {
    console.log(`❌ ${errors.length} required item${errors.length > 1 ? 's' : ''} missing — fix before starting.`);
  }
  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} optional item${warnings.length > 1 ? 's' : ''} missing — some commands will be unavailable.`);
  }
  console.log('');

  if (errors.length === 0) {
    // Only warnings — safe to start
    markSetupComplete();
    console.log('✅ Required checks passed. Starting bot with warnings...\n');
    return true;
  }

  // There are errors — ask the user
  const answer = await prompt('Fix required items and run again, or start anyway? [fix/start/quit]: ');

  if (answer === 'start') {
    console.log('[Setup] Starting anyway...\n');
    return true;
  }

  if (answer === 'fix' || answer === 'y') {
    console.log('[Setup] Fix the issues above and run again.\n');
    return false;
  }

  // quit or anything else
  console.log('[Setup] Exiting.\n');
  return false;
}

function markSetupComplete(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(SETUP_COMPLETE_FILE, new Date().toISOString() + '\n', 'utf8');
}
