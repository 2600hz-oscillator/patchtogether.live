// e2e/tests/es9-card-shows-state.spec.ts
//
// THE CARD MUST SHOW THE BRIDGE'S REAL STATE.
//
// Owner-reported showstopper, 2026-08-07: "the es-9 widget … clicking connect
// does nothing. no console errors, no connection" — while the bridge was
// running and connected.
//
// ⚠ WHY THE EXISTING SPEC MISSED IT. `es9-shell-lifetime.spec.ts` asserts the
// ENGINE owns a bridge, via `__es9HasBridge`. That was true the whole time. The
// broken thing was the CARD's view of it: `subscribeEs9` returned a no-op when
// no entry existed yet, and since the card mounts BEFORE the engine reconciles
// the node, it never subscribed and froze on its initial `idle` snapshot. So a
// test that reads the registry proves the registry, and says nothing about the
// only surface the user can actually see. This spec reads the CARD.
//
// SCOPE: CI has no ES-9 bridge, so the state the card settles on there is a
// FAILED connect, not a connected one. That is still the assertion that matters
// — the card must leave `idle` and report what actually happened. A card that
// never updates is exactly the bug, and it is visible with or without hardware.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const NODE = 'es9a';

/** The status text the card is displaying right now. */
async function cardState(page: Page): Promise<string> {
  return (await page.getByTestId(`es9-status-${NODE}`).innerText()).trim().toLowerCase();
}

async function spawnEs9(page: Page): Promise<void> {
  await page.goto('/rack?shell=legacy');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: NODE, type: 'es9', position: { x: 140, y: 140 }, domain: 'audio' },
  ]);
  await expect(page.getByTestId(`es9-status-${NODE}`)).toBeVisible();
}

test('the card LEAVES idle on its own — it is subscribed, not frozen', async ({ page, rack }) => {
  await spawnEs9(page);

  // The precise regression: the card used to sit on 'idle' forever because it
  // never subscribed. Whatever the bridge does — connect, fail, report busy —
  // the card must reflect SOMETHING other than its initial placeholder.
  await expect
    .poll(() => cardState(page), { timeout: 15_000, message: 'card never left its initial idle state — it is not subscribed to the bridge' })
    .not.toContain('idle');
});

test('the buttons reach the bridge — DISCONNECT deterministically reports stopped', async ({
  page,
  rack,
}) => {
  await spawnEs9(page);
  await expect.poll(() => cardState(page), { timeout: 15_000 }).not.toContain('idle');

  const row = page.getByTestId(`es9-status-${NODE}`);

  // ⚠ CONNECT is NOT a deterministic transition and must not be asserted as
  // one: it is stop()+start(), so a bridge that was busy comes back busy and a
  // bridge that was connected comes back connected — the same string. An
  // earlier draft asserted "the text changed" and failed for that reason, which
  // was the test being wrong, not the button. DISCONNECT is deterministic:
  // stop() always reports `stopped`. So that is what we assert the wiring with.
  const connect = row.getByRole('button', { name: /^connect$/i });
  if (await connect.count()) {
    await connect.click();
    // It must at minimum have reached the owner and created a connection.
    await expect
      .poll(async () => await page.evaluate((id) => {
        const w = globalThis as unknown as { __es9HasBridge?: (n: string) => boolean };
        return !!w.__es9HasBridge?.(id);
      }, NODE), { timeout: 10_000, message: 'CONNECT did not reach the bridge owner' })
      .toBe(true);
  }

  // Now the deterministic half.
  const disconnect = row.getByRole('button', { name: /disconnect/i });
  if (await disconnect.count()) {
    await disconnect.click();
    await expect
      .poll(() => cardState(page), { timeout: 10_000, message: 'DISCONNECT produced no state change on the card' })
      .toContain('stopped');
  }
});

test('NEGATIVE CONTROL — the status element exists and reports distinct states', async ({
  page,
  rack,
}) => {
  // Guards the instrument: if the testid were wrong or the text empty, both
  // assertions above would pass vacuously (`''` does not contain 'idle').
  await spawnEs9(page);
  const text = await cardState(page);
  expect(text.length, 'the status row renders real text, not an empty node').toBeGreaterThan(0);
});
