// e2e/tests/topbar-buttons.spec.ts
//
// Rack Phase 3 — topbar cleanup.
//
// The manual browser Save / Load (patch) and Save Perf / Load Perf (browser-
// slot performance) buttons were removed. Durable per-rack persistence is the
// auto-sync path; the portable survivor is the .zip export/import. This spec
// pins the surviving button set so a regression that re-adds (or accidentally
// drops a survivor) is caught.

import { test, expect } from './_fixtures';
import { readFileSync } from 'node:fs';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('topbar: removed Save/Load/Save Perf/Load Perf buttons are gone', async ({ page, rack }) => {
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

test('topbar: Clear + zip Export/Load survivors remain', async ({ page, rack }) => {
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

// "Raw JSON" menu (restored raw-JSON envelope export/import; the convenience
// the old Save/Load buttons gave). Present in the top-RIGHT actions cluster
// with exactly two actions.
test('topbar: Raw JSON menu present with Export/Import JSON options', async ({ page, rack }) => {
  const select = page.getByTestId('raw-json-select');
  await expect(select).toBeVisible();
  // The two action options (plus the disabled placeholder).
  await expect(select.locator('option[value="export-json"]')).toHaveText('Export JSON (only)');
  await expect(select.locator('option[value="import-json"]')).toHaveText('Import JSON');
});

// "Export JSON (only)" downloads the patch as a raw JSON envelope (no zip).
// Drives the REAL menu (selectOption fires the onchange action), captures the
// download, and asserts the bytes are a valid envelopeVersion=1 envelope.
test('topbar: Raw JSON → Export JSON downloads a valid envelope', async ({ page, rack }) => {
  // A minimal patch so the export has content.
  await spawnPatch(
    page,
    [{ id: 'vco', type: 'analogVco' }, { id: 'out', type: 'audioOut' }],
    [{ id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' } }],
  );

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('raw-json-select').selectOption('export-json'),
  ]);

  // Filename is the envelope default (patch.imp.json — a .json file).
  expect(download.suggestedFilename()).toMatch(/\.json$/);

  // Read the downloaded bytes + assert a valid v2 LEAN envelope (no moduleSchemas).
  const path = await download.path();
  expect(path).toBeTruthy();
  const text = readFileSync(path as string, 'utf8');
  const env = JSON.parse(text) as { envelopeVersion: number; update: string; moduleSchemas?: unknown };
  expect(env.envelopeVersion).toBe(2);
  expect(typeof env.update).toBe('string');
  expect(env.moduleSchemas).toBeUndefined();
});

// Full UI round-trip: Export JSON via the menu → clear the patch → Import JSON
// via the menu (feeding the downloaded file into the native picker) restores
// the exact node/edge set. This exercises the REAL menu wiring end-to-end (the
// new surface), not just the underlying envelope contract.
test('topbar: Raw JSON Export → Import round-trips the patch via the menu', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco' },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'out', type: 'audioOut', params: { master: 0.4 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e2', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  const before = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> } };
    return { nodes: Object.keys(w.__patch.nodes).sort(), edges: Object.keys(w.__patch.edges).sort() };
  });

  // Export via the menu, capture the file.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('raw-json-select').selectOption('export-json'),
  ]);
  const savedPath = (await download.path()) as string;
  expect(savedPath).toBeTruthy();

  // Clear the rack.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(async () =>
    page.evaluate(() => Object.keys((globalThis as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes).length),
  ).toBe(0);

  // Import via the menu — selecting the option opens the native file picker,
  // which Playwright intercepts via the filechooser event; feed it the file.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('raw-json-select').selectOption('import-json'),
  ]);
  await chooser.setFiles(savedPath);

  // The exact node + edge set comes back.
  await expect.poll(async () =>
    page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> } };
      return { nodes: Object.keys(w.__patch.nodes).sort(), edges: Object.keys(w.__patch.edges).sort() };
    }),
  ).toEqual(before);
});
