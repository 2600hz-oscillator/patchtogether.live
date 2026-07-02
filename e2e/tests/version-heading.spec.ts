// e2e/tests/version-heading.spec.ts
//
// Contract gate for the topbar brand heading.
//
// The heading renders `patchtogether v<version>`, where <version> is inlined
// into the client bundle at build time from the ROOT package.json (Vite
// `define: { __APP_VERSION__ }` in packages/web/vite.config.ts; the web
// package.json is a 0.0.0 placeholder, so the ROOT one is the source of truth).
//
// This spec reads that SAME root package.json off disk and asserts the rendered
// `[data-testid="app-version"]` text equals `v<version>` verbatim — so a stale
// hardcoded string, the wrong package.json, or a broken build-time injection
// fails CI instead of shipping a wrong version in the UI.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// e2e/tests → repo root. The dev server the spec drives is served from the same
// checkout, so its inlined __APP_VERSION__ comes from THIS package.json.
const ROOT_PKG_VERSION = (
  JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

test.describe.configure({ mode: 'parallel' });

test('topbar heading renders "patchtogether" + the package version', async ({ page }) => {
  // Sanity: we're comparing against a real X.Y.Z, not an empty/placeholder read.
  expect(ROOT_PKG_VERSION, 'root package.json version should be X.Y.Z').toMatch(
    /^\d+\.\d+\.\d+/,
  );

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const version = page.getByTestId('app-version');
  await expect(version, 'topbar version testid missing').toBeVisible();

  // The heading renders the version as `v<version>`; it must equal the root
  // package.json version verbatim (this is the whole point of the gate).
  await expect(version).toHaveText(`v${ROOT_PKG_VERSION}`);

  // The brand word sits alongside the version in the same heading.
  await expect(page.locator('header.topbar h1')).toContainText('patchtogether');
});
