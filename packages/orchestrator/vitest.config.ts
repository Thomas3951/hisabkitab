import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // DB-backed tests (pairing/dedupe) share one test database — keep files serial.
    fileParallelism: false,
  },
});
