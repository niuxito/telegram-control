import type { Config } from 'drizzle-kit';
import { config } from 'dotenv';
config();

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATA_DIR ? `${process.env.DATA_DIR}/control.db` : './data/control.db',
  },
} satisfies Config;
