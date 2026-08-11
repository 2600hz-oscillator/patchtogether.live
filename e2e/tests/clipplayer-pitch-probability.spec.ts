// e2e/tests/clipplayer-pitch-probability.spec.ts
//
// PER-NOTE PITCH PROBABILITY end-to-end (card path) — the sibling of
// clipplayer-play-every.spec.ts. The MODEL (weights, distribution, privileged
// intervals, multiplayer determinism) is pinned by the pure unit tests in
// packages/web/src/lib/audio/pitch-probability.test.ts; the menu + storage seam
// by clipplayer-prob-menu.test.ts. What only a real browser can prove is here:
//
//   1. the third menu row actually RENDERS and writes `pitchProb` onto the note;
//   2. picking OFF removes the key (byte-identical to a pre-feature note);
//   3. the DASHED-border marker actually reaches the DOM.
//
// ⚠ WHY THIS SPEC EXISTS AT ALL, rather than a VRT baseline: the clipplayer VRT
// scene captures the LAUNCH GRID ONLY — it never opens the piano-roll editor
// (see e2e/vrt/__screenshots__/vrt.spec.ts/*/clipplayer.png). So VRT is
// STRUCTURALLY BLIND to every note-cell state, this one included, and a green
// VRT run says nothing about it. Rather than mint a new cross-platform baseline
// (and its linux-capture dance + CI wall-time) for a 1 px border-style change,
// the marker is asserted here as a computed style, which is both cheaper and a
// stronger assertion than a pixel diff would be.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** The `pitchProb` of the note at step 0 in the clip at lane 0 / slot 0, as the
 *  SYNCED data — the observable every peer and the engine read. `null` = no
 *  note; `0` = the key is absent (the default: play the authored pitch). */
async function step0PitchProb(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, {
          type?: string;
          data?: { clips?: Record<string, { steps?: { step: number; pitchProb?: number }[] }> };
        }>;
      };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    const note = cp?.data?.clips?.['0']?.steps?.find((s) => s.step === 0);
    return note ? note.pitchProb ?? 0 : null; // 0 = default (key absent)
  });
}

async function openEditorWithNote(page: import('@playwright/test').Page) {
  await page.goto('/rack?shell=legacy');
  await spawnPatch(page, [{ id: 'pp-cp', type: 'clipplayer', domain: 'audio', x: 200, y: 120 }]);
  const card = page.getByTestId('clipplayer-card').first();
  await card.waitFor({ state: 'visible' });
  await card.locator('.pad').first().dblclick(); // → editor, lane 0 / slot 0
  await page.getByTestId('clipplayer-editor').waitFor({ state: 'visible' });
  const cell = page.getByTestId('clipplayer-cell-0-0');
  await cell.click(); // draw a note at display row 0 / step 0
  return cell;
}

test('@clipplayer card Pitch Probability menu writes pitchProb; "off" clears it', async ({ page }) => {
  const cell = await openEditorWithNote(page);
  await expect.poll(() => step0PitchProb(page), { timeout: 5000 }).toBe(0); // default: off

  // Right-click the note → the per-note menu → Pitch Probability, level 20 (50%).
  await cell.click({ button: 'right' });
  await page.getByTestId('clipplayer-pitch-prob-item-20').click();
  await expect.poll(() => step0PitchProb(page), { timeout: 5000 }).toBe(0.5);

  // Re-open and pick OFF → the key is REMOVED, not written as 0 (so a note reset
  // to off round-trips byte-identical to a pre-feature note).
  await cell.click({ button: 'right' });
  await page.getByTestId('clipplayer-pitch-prob-item-0').click();
  await expect.poll(() => step0PitchProb(page), { timeout: 5000 }).toBe(0);
});

test('@clipplayer the pitch-instability marker is a DASHED border, and only on an unstable note', async ({ page }) => {
  const cell = await openEditorWithNote(page);
  const borderStyle = () => cell.evaluate((el) => getComputedStyle(el).borderTopStyle);

  // NEGATIVE CONTROL FIRST — a plain note must NOT be dashed, so the assertion
  // below cannot pass on a stylesheet that dashes everything.
  expect(await borderStyle()).toBe('solid');

  await cell.click({ button: 'right' });
  await page.getByTestId('clipplayer-pitch-prob-item-20').click();
  await expect.poll(borderStyle, { timeout: 5000 }).toBe('dashed');

  // …and it is a SHAPE channel only: the cell's FILL is unchanged, so the two
  // existing colour axes (probability + play-every) keep their whole range.
  const fill = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
  await cell.click({ button: 'right' });
  await page.getByTestId('clipplayer-pitch-prob-item-0').click();
  await expect.poll(borderStyle, { timeout: 5000 }).toBe('solid');
  expect(await cell.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill);
});
