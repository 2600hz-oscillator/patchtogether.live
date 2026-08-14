import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/probe.spec.ts',
  workers: 1,
  retries: 0,
  reporter: [['json', { outputFile: 'probe-report.json' }]],
});
