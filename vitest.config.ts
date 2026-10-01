import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Placeholder config so tests never depend on (or read) a developer's .env.
    // dotenv does not override variables that are already set.
    env: {
      BOT_TOKEN: '123456:test-token',
      SUPERGROUP_ID: '-1000000000001',
      NEW_PROJECTS_TOPIC_ID: '2',
      OWNER_USER_ID: '42',
      DATA_DIR: './data-test',
      PROJECTS_BASE_DIR: '/tmp/telegram-control-test-projects',
    },
  },
});
