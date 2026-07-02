// e2e/tests/house-style.spec.ts
//
// Phase 0 of the UX-overhaul plan extracted the docs "house" stylesheet out of
// routes/docs/+layout.svelte's inline <style> block into the shared global
// packages/web/src/lib/styles/house.css, imported by the docs layout. The move
// is meant to be BEHAVIOR-IDENTICAL: every rule was already keyed under
// `.docs-root` (the layout chrome via Svelte scoping, the page content via
// explicit `.docs-root :global(...)`), so dropping the `:global()` wrappers and
// prefixing the chrome selectors with `.docs-root` yields the exact same
// cascade.
//
// This spec is the CI-real guard that the extracted sheet is actually loaded and
// applied on the docs routes. It asserts computed values across every tier of
// the sheet — the palette custom properties, the `.docs-root` root rule, the
// topbar chrome, the `.hero` block, and the content typography — so a dropped
// import, a broken selector, or a lost `:global()` unwrap would fail here. It
// asserts computed colors/positions rather than pixels, so it is deterministic
// and free of the ±1px raster flake that a text-heavy VRT baseline invites.
//
// The definitive "pixel-identical" proof of the no-op was done locally as a
// before/after screenshot diff (0 differing pixels on /docs and /docs/testing);
// this spec is the durable regression gate.

import { test, expect, type Page } from '@playwright/test';

// house.css palette tokens, as the browser reports them (hex → rgb()).
const ACCENT = 'rgb(0, 240, 255)'; // --doc-accent #00f0ff
const FG = 'rgb(200, 212, 220)'; // --doc-fg     #c8d4dc
const FG_DIM = 'rgb(110, 122, 130)'; // --doc-fg-dim #6e7a82

async function computed(page: Page, selector: string, prop: string): Promise<string> {
  return page.locator(selector).first().evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p).trim(),
    prop,
  );
}

async function assertHouseStyleApplied(page: Page): Promise<void> {
  // Tier 1 — palette custom properties are defined on .docs-root (the token
  // block at the top of house.css loaded).
  await expect
    .poll(() => computed(page, '.docs-root', '--doc-accent'))
    .toBe('#00f0ff');
  expect(await computed(page, '.docs-root', '--doc-fg')).toBe('#c8d4dc');

  // Tier 2 — the .docs-root root rule (position + palette-driven color).
  expect(await computed(page, '.docs-root', 'position')).toBe('fixed');
  expect(await computed(page, '.docs-root', 'color')).toBe(FG);

  // Tier 3 — topbar chrome (formerly a Svelte-scoped selector, now
  // `.docs-root .brand a`): the brand link renders in the accent color.
  expect(await computed(page, '.docs-root .brand a', 'color')).toBe(ACCENT);

  // Tier 4 — the .hero block: relative positioning (anchors the corner
  // brackets) and the accent-colored title. The h1 accent also proves the
  // `.docs-root .hero h1` rule still out-specifies `.docs-root h1` (which is
  // --doc-fg) — i.e. cascade ordering survived the extraction.
  expect(await computed(page, '.hero', 'position')).toBe('relative');
  expect(await computed(page, '.hero h1', 'color')).toBe(ACCENT);
  expect(await computed(page, '.hero .sub', 'color')).toBe(FG_DIM);
}

test('docs home adopts the extracted house stylesheet', async ({ page }) => {
  const res = await page.goto('/docs');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('.docs-root')).toBeVisible();
  await assertHouseStyleApplied(page);
});

test('docs testing page adopts the extracted house stylesheet', async ({ page }) => {
  const res = await page.goto('/docs/testing');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('.docs-root')).toBeVisible();
  await assertHouseStyleApplied(page);
});
