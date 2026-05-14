import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include:     ['server/tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider:  'v8',
      include:   ['server/services/**/*.ts', 'server/utils/**/*.ts'],
      exclude:   ['server/tests/**', 'server/routes/**'],
      thresholds: {
        lines:     60,
        functions: 70,
      },
    },
  },
});
