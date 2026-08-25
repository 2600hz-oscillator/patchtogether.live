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

/**
 * What the card paints while it is still on its INITIAL snapshot — the frozen
 * state this whole file exists to catch.
 *
 * ⚠ IT IS `off`, NOT `idle`, AND THAT IS WHY THE ORIGINAL ASSERTION WAS
 * VACUOUS. `Es9Card.svelte`'s `stateLabel` maps `case 'stopped': case 'idle':
 * return 'off'` — the string `idle` is a STATE NAME and never a RENDERED LABEL,
 * so `.not.toContain('idle')` was true on the very first poll, before the card
 * had subscribed to anything, and **the exact regression it was written for
 * would have rendered `off`, passed, and shipped.**
 */
const FROZEN_LABEL = 'off';

/**
 * What a SUBSCRIBED card settles on with no es9-bridge helper listening — the
 * transport worker's close, delivered through the subscription.
 *
 * MEASURED on this branch (MutationObserver over 12 s): the row cycles
 * `bridge not found` ↔ `connecting…` three times, spending all but a few
 * milliseconds of each ~1-5 s backoff period on the former. Either string is
 * proof of a live subscription; `off` is proof of the bug.
 */
const SUBSCRIBED_LABELS = /bridge not found|connecting/;

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

  const row = page.getByTestId(`es9-status-${NODE}`);

  // ⚠ BY TESTID, NOT BY VISIBLE TEXT. This used to be
  // `getByRole('button', { name: /^connect$/i })` — a match on a caption that
  // is one edit away from unfindable, and which would have made this whole
  // test silently vacuous rather than red. The testids arrived with the face's
  // `es9-connect` / `es9-disconnect` controlFamilies.
  const connect = row.getByTestId(`es9-connect-${NODE}`);
  await expect(
    connect,
    'with no helper listening the card is not connected, so CONNECT is the button it offers',
  ).toHaveCount(1);
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

test('⚠ DISCONNECT is UNREACHABLE from this card on CI, and that is stated rather than skipped', async ({
  page,
  rack,
}) => {
  // ⚠ THIS TEST REPLACES A BLOCK THAT WAS BOTH UNREACHABLE **AND WRONG IF
  // REACHED**, which is worse than either alone. It read:
  //
  //     const disconnect = row.getByRole('button', { name: /disconnect/i });
  //     if (await disconnect.count()) { … .toContain('stopped'); }
  //
  // The card renders DISCONNECT only while `connState === 'connected'`, which
  // no runner reaches — so the guard was always false and the body never ran.
  // And had it run it would have FAILED: `stop()` reports the state `stopped`,
  // and `stateLabel` renders that state as the label **`off`**. The comment
  // above it was emphatic that "DISCONNECT is deterministic … so that is what
  // we assert the wiring with", and the thing it asserted against was the
  // LABEL, not the state. A conditional block that never executes is a green
  // check certifying nothing.
  await spawnEs9(page);
  const row = page.getByTestId(`es9-status-${NODE}`);
  await expect(
    row.getByTestId(`es9-disconnect-${NODE}`),
    'no es9-bridge helper on this runner, so the card never reaches `connected` and never offers '
      + 'DISCONNECT. The gesture IS covered, on the FACE: both cells are always present there '
      + '(static captions, not one label that flips), and faces-parity drives each and requires '
      + 'the audition ledger to record a DELIVERED press.',
  ).toHaveCount(0);
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
  expect(text.length, 'the status row renders real text, not an empty node').toBeGreaterThan(0);
  await expect
    .poll(() => cardState(page), { timeout: 15_000 })
    .toMatch(SUBSCRIBED_LABELS);
});
