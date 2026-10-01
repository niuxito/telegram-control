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

export const config = envSchema.parse(process.env);
