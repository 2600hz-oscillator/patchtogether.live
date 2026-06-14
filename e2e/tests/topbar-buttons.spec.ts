// e2e/tests/topbar-buttons.spec.ts
//
// Rack Phase 3 — topbar cleanup.
//
// The manual browser Save / Load (patch) and Save Perf / Load Perf (browser-
// slot performance) buttons were removed. Durable per-rack persistence is the
// auto-sync path; the portable survivor is the .zip export/import. This spec
// pins the surviving button set so a regression that re-adds (or accidentally
// drops a survivor) is caught.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('topbar: removed Save/Load/Save Perf/Load Perf buttons are gone', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const header = page.locator('header');

  // REMOVED — manual patch Save/Load (exact, so "Load Perf (.zip)" /
  // "Load example…" don't false-match).
  await expect(header.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Load', exact: true })).toHaveCount(0);
  // REMOVED — browser-slot performance.
  await expect(header.getByRole('button', { name: 'Save Perf', exact: true })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Load Perf', exact: true })).toHaveCount(0);
  // The removed-feature testids are gone too.
  await expect(page.getByTestId('save-perf-btn')).toHaveCount(0);
  await expect(page.getByTestId('load-perf-btn')).toHaveCount(0);
});

test('topbar: Clear + zip Export/Load survivors remain', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const header = page.locator('header');

  // SURVIVORS.
  await expect(header.getByRole('button', { name: 'Clear' })).toBeVisible();
  await expect(page.getByTestId('export-perf-zip-btn')).toBeVisible();
  await expect(page.getByTestId('load-perf-zip-btn')).toBeVisible();
  await expect(
    header.getByRole('button', { name: 'Export Perf (.zip)', exact: true }),
  ).toBeVisible();
  await expect(
    header.getByRole('button', { name: 'Load Perf (.zip)', exact: true }),
  ).toBeVisible();
});
