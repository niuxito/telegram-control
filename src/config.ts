import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { z } from 'zod';

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  SUPERGROUP_ID: z.string().min(1).transform(v => parseInt(v)),
  NEW_PROJECTS_TOPIC_ID: z.string().min(1).transform(v => parseInt(v)),
  OWNER_USER_ID: z.string().min(1).transform(v => parseInt(v)),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  API_PORT: z.string().default('3001').transform(v => parseInt(v)),
  API_HOST: z.string().default('127.0.0.1'),
  API_KEY: z.string().optional(),
  PROJECTS_BASE_DIR: z.string().default('~/projects'),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid configuration in .env:\n${problems}\n\nSee .env.example and the Configuration section of README.md.`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();

// Secrets stay in `config` only. Agents, `npm test` and git/gh run as child
// processes that inherit process.env, and must not be able to read them.
export const SECRET_ENV_VARS = ['BOT_TOKEN', 'API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
for (const name of SECRET_ENV_VARS) delete process.env[name];
