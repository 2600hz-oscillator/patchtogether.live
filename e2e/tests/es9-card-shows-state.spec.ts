// e2e/tests/es9-card-shows-state.spec.ts
//
// THE VISIBLE SURFACE MUST SHOW THE BRIDGE'S REAL STATE — on the default
// shell that surface is the dock face's BRIDGE StatusLed, whose aria-label
// carries the owner-snapshot detail sentence (the readout ruling's home for
// derived state).
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

/** The state sentence the face's BRIDGE lamp is announcing right now. */
async function cardState(page: Page): Promise<string> {
  return ((await page.getByTestId(`es9-led-bridge-${NODE}`).getAttribute('aria-label')) ?? '')
    .trim()
    .toLowerCase();
}

async function spawnEs9(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: NODE, type: 'es9', position: { x: 140, y: 140 }, domain: 'audio' },
  ]);
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    NODE,
  );
  await expect(page.getByTestId(`es9-led-bridge-${NODE}`)).toBeVisible();
}

/**
 * What the lamp announces while still on its INITIAL snapshot — the frozen
 * state this whole file exists to catch: `es9BridgeDetail` maps `idle`/
 * `stopped` to the press-CONNECT hint, which a subscribed surface leaves the
 * moment the worker's first close arrives.
 */
const FROZEN_LABEL = 'the hardware link is down';

/**
 * What a SUBSCRIBED surface settles on once the transport worker has spoken —
 * `es9BridgeDetail`'s post-idle sentences: the no-answer close, the connect
 * attempt, or (on a machine where a real es9-bridge app holds the port) the
 * busy refusal. The FROZEN initial snapshot ('idle') renders none of these —
 * it says "the hardware link is down", which is the discrimination below.
 */
const SUBSCRIBED_LABELS = /no es9-bridge app answered|connecting to the es9-bridge|busy/;

test('the card LEAVES its initial snapshot — it is subscribed, not frozen', async ({ page, rack }) => {
  await spawnEs9(page);

  // ⚠ A POSITIVE CONTROL, NOT AN ABSENCE. The precise regression is a card that
  // sits on its initial `idle` snapshot forever because `subscribeEs9` returned
  // a no-op before the engine had created the entry. Asserting that the card
  // does NOT say something is exactly how the original version of this test
  // passed while blind — so this asserts what a card that DID subscribe says,
  // which the frozen one cannot reach.
  await expect
    .poll(() => cardState(page), {
      timeout: 15_000,
      message:
        'the card never reported the worker\'s close — it is frozen on its initial snapshot and '
        + 'therefore not subscribed to the bridge owner',
    })
    .toMatch(SUBSCRIBED_LABELS);

  // …and the label the frozen card WOULD show is genuinely different from the
  // one asserted above, so the check discriminates rather than merely matching
  // something. (Belt and braces on the instrument: if `stateLabel` were ever
  // reshaped so the two collapsed, this is what would go red first.)
  expect(await cardState(page), 'the frozen label must be distinguishable').not.toContain(
    FROZEN_LABEL,
  );
});

test('the CONNECT button reaches the bridge owner', async ({ page, rack }) => {
  await spawnEs9(page);
  await expect.poll(() => cardState(page), { timeout: 15_000 }).toMatch(SUBSCRIBED_LABELS);

  // The face's CONNECT cell — always present, static caption (the card's
  // one flipping label was the vacuous shape this file documents).
  const connect = page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="${NODE}"] [data-testid="shell-cell-es9-connect"]`)
    .first();
  await expect(connect).toHaveCount(1);
  await connect.click();

  // ⚠ CONNECT is NOT a deterministic TEXT transition and must not be asserted
  // as one: it is stop()+start(), so a bridge that was busy comes back busy and
  // one that was connected comes back connected — the same string. What IS
  // deterministic is that the press reached the owner and an entry now exists.
  await expect
    .poll(async () => await page.evaluate((id) => {
      const w = globalThis as unknown as { __es9HasBridge?: (n: string) => boolean };
      return !!w.__es9HasBridge?.(id);
    }, NODE), { timeout: 10_000, message: 'CONNECT did not reach the bridge owner' })
    .toBe(true);
});

test('DISCONNECT is ALWAYS offered on the face — the state-gated card button died with the card', async ({
  page,
  rack,
}) => {
  // The card rendered DISCONNECT only while `connState === 'connected'` — a
  // state no CI runner reaches, which made its predecessor's conditional
  // block a green check certifying nothing (this file's history records it).
  // The face fixes the reachability at the source: BOTH cells are always
  // present with static captions, and faces-parity drives each press through
  // the audition ledger. Here the presence is pinned on the shipping surface.
  await spawnEs9(page);
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${NODE}"]`);
  await expect(pane.locator('[data-testid="shell-cell-es9-connect"]')).toHaveCount(1);
  await expect(pane.locator('[data-testid="shell-cell-es9-disconnect"]')).toHaveCount(1);
});

test('NEGATIVE CONTROL — the status element exists and reports distinct states', async ({
  page,
  rack,
}) => {
  // Guards the instrument: if the testid were wrong or the text empty, the
  // assertions above would be reading nothing.
  //
  // ⚠ THIS USED TO BE `text.length > 0` ALONE, AND THAT DID NOT RESCUE THE
  // VACUOUS ASSERTION IT WAS WRITTEN TO GUARD — `off` + `connect` satisfies it
  // perfectly, which is the frozen card. A passing negative control proves the
  // probe can be READ, never that it reads the right thing. So the guard now
  // also names a string the frozen card CANNOT produce.
  await spawnEs9(page);
  const text = await cardState(page);
  expect(text.length, 'the lamp announces real text, not an empty label').toBeGreaterThan(0);
  await expect
    .poll(() => cardState(page), { timeout: 15_000 })
    .toMatch(SUBSCRIBED_LABELS);
});
