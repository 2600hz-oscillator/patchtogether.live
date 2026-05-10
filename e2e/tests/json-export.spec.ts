// e2e/tests/json-export.spec.ts
//
// Filename-prompt UX for the Save (JSON export) action. The two cases below
// pin the contract:
//   1. Pressing Save and accepting the prompt unchanged downloads patch.imp.json.
//   2. Typing a custom filename downloads with that name (sanitized + .imp.json
//      suffix appended if missing).
//
// Cancellation + sanitization edge cases are unit-tested against
// sanitizeFilename in packages/web/src/lib/graph/persistence.test.ts; this spec
// covers only what the prompt-mediated browser path can exercise.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('json-export: default filename when user accepts prompt unchanged', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Accepting with no override = default value (patch.imp.json).
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('prompt');
    expect(dialog.defaultValue()).toBe('patch.imp.json');
    await dialog.accept();
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('patch.imp.json');
});

test('json-export: custom filename from prompt drives the download name', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // User types `my-cool-patch` (no extension). Sanitizer appends `.imp.json`.
  page.once('dialog', async (dialog) => {
    await dialog.accept('my-cool-patch');
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('my-cool-patch.imp.json');
});
