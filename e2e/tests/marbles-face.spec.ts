// e2e/tests/marbles-face.spec.ts
//
// THE MARBLES FACE, driven for real.
//
// `faces-parity` already proves every cell is present and operable, and
// `marbles-face-model.test.ts` already proves the arithmetic matches the
// shipping DSP. Neither can see the seam BETWEEN them: that the DOM prints what
// the model computes, for the LIVE graph value, and keeps doing so when the
// value moves. On this module that seam carries the whole argument, because
// the faceplate deliberately has no prose on it (owner directive 2026-08-11) —
// every fact it states is a bare value, so a value wired to the wrong thing is
// the entire failure mode.
//
// FOUR PROPERTIES, each one the thing a wrong implementation cannot have:
//
//  1. `T random` / `X random` are NON-MONOTONE in DÉJÀ VU. A readout that
//     simply scaled with the knob — the obvious wrong implementation, and the
//     one a reviewer checking "does it move when I turn it" would pass — reads
//     MAXIMUM at 1.0. The module's maximum repetition is at 0.5, so the correct
//     value at 1.0 equals the value at 0.0 and both differ from the middle.
//  2. `T loop` prints `free`, NOT a length, at the shipped DÉJÀ VU 0 — because
//     LENGTH is bit-exactly inert there — and starts printing one as soon as
//     the loop exists.
//  3. `glide` and `quantiser` read `0 %` and `off` TOGETHER at the shipped
//     STEPS 0.50. That pair is the dead gap between the two regimes, and it is
//     the reason SCALE does nothing on a freshly spawned module.
//  4. The grid cells for T MODEL and SCALE show their NAMES. Undeclared they
//     print `0.00`…`5.00`; declared as a `Segmented` they clip to `Raag B…`.
//
// Runs on /rack (no DB, no relay) — the normal e2e lane. The faceplate shell is
// the DEFAULT rack since #1459.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
// ⚠ NOT from the def. `marbles.ts` imports its worklet as `…?url`, which Node
// cannot resolve, so importing it here fails the whole spec file at collection
// ("does not provide an export named 'default'") — which is why the rosters
// live in `marbles-names.ts` and the model imports neither. Pulling the SAME
// functions the shell calls is the point: a re-typed expectation would pass
// against a broken registry.
import {
  MARBLES_SCALE_NAMES,
  MARBLES_T_MODEL_NAMES,
} from '../../packages/web/src/lib/audio/modules/marbles-names';
import {
  marblesBpmText,
  marblesFaceParams,
  marblesGlideText,
  marblesLoopText,
  marblesModelText,
  marblesQuantiserText,
  marblesRandomText,
  marblesStepText,
  type MarblesFaceParams,
} from '../../packages/web/src/lib/ui/modules/marbles-face-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** The face's params with `over` applied over the def defaults, in the shape
 *  the model reads — the SAME resolver the shell uses, so a default change
 *  moves the expectation and the render together. */
const at = (over: Partial<MarblesFaceParams> = {}): MarblesFaceParams =>
  marblesFaceParams((id) => (over as Record<string, number>)[id]);

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function spawnMarbles(page: Page): Promise<string> {
  const id = 'marbles-face-1';
  await spawnPatch(page, [{ id, type: 'marbles', position: { x: 240, y: 200 } }]);
  return id;
}

async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** Write params straight into the graph. The point is to land on EXACT values
 *  so the expected string is computable; the GESTURE is covered by
 *  faces-parity, which drags every cell. */
async function setParams(
  page: Page,
  nodeId: string,
  values: Record<string, number>,
): Promise<void> {
  await page.evaluate(
    ({ nodeId, values }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        n.params = { ...(n.params ?? {}), ...values };
      });
    },
    { nodeId, values },
  );
}


test.describe('marbles face — the values that carry a faceplate with no prose', () => {
  // ⚠ THREE READOUT TESTS STOOD HERE AND ALL THREE ARE DELETED WITH THEIR
  // SURFACE (owner ruling, 2026-08-19 — the hero strip and the dock sidebar are
  // both gone). Naming them, because each carried a real finding that no longer
  // has anywhere to be shown:
  //
  //   * "T/X RANDOM is non-monotone" — DÉJÀ VU's travel prints p = (2·dv − 1)²,
  //     so 1.0 reads like 0.0 and the MIDDLE of the dial is the extreme. That is
  //     the whole reason the readout existed rather than a dial readback.
  //   * "the LOOP readout refuses to print a length it cannot honour" — at the
  //     shipped DÉJÀ VU 0, LENGTH is bit-exactly inert, so the face printed
  //     'free' rather than the def default of 8.
  //   * "GLIDE and QUANTISER read 0 % / off together" — the shipped state sits
  //     in the dead gap between STEPS 0.49 and 0.536, so both halves of that
  //     dial do nothing at its default.
  //
  // ⚠ THE ARITHMETIC SURVIVES in marbles-face-model.test.ts (unit lane, with
  // its own negative controls). What is gone is the JOIN — nothing now asserts
  // that any of those three facts reaches a surface a player can see, because
  // no such surface remains. Stated rather than quietly absorbed.

  test('the two GRID cells show NAMES, not 0.00…5.00, and CLUSTERS says what it runs as', async ({
    page,
  }) => {
    await gotoShell(page);
    const id = await spawnMarbles(page);
    const dock = await openDock(page, id);

    // The chip carries `control-<paramId>` (the portaled grid is outside the
    // dock shell, so a testid there would drop the param out of faces-parity's
    // multiset). Undeclared, these two params render as knobs printing a float.
    const tModel = dock.locator('[data-testid="control-t_model"]');
    const scale = dock.locator('[data-testid="control-scale"]');
    await expect(tModel).toBeVisible();
    await expect(scale).toBeVisible();
    await expect(tModel).toContainText(MARBLES_T_MODEL_NAMES[0]);
    await expect(scale).toContainText(MARBLES_SCALE_NAMES[0]);
    await expect(tModel).not.toContainText('0.00');
    await expect(scale).not.toContainText('0.00');

    // …and the LONGEST caption in either roster survives, which is what a
    // `Segmented` row could not do: `.seg` is `flex: 1`, so every caption is
    // allotted the roster mean and "Raag Bhairav" clips to "Raag B…".
    await setParams(page, id, { scale: 4 });
    await expect(scale).toContainText(MARBLES_SCALE_NAMES[4]);

    // ⚠ THE STUB FINDING LOST ITS SURFACE HERE, and it is worth naming because
    // it is a live DEFECT rather than a nicety: `t_model` 1 is called CLUSTERS
    // but the DSP runs the COIN generator for it (a two-line commented
    // fall-through in marbles-core). The face used to say so through a sidebar
    // readout printing `CLUSTERS … COIN`, with a negative control on an
    // implemented model printing its bare name. The sidebar is deleted (owner,
    // 2026-08-19), so the module now presents CLUSTERS as though it were
    // implemented and nothing on any surface contradicts that.
    //
    // `marblesModelText` still computes the disclosure and is still pinned in
    // marbles-face-model.test.ts; it simply has no renderer. That is a real
    // regression in what the instrument TELLS you, caused by the ruling and
    // recorded here rather than lost.
  });

  test('THE FACEPLATE CARRIES NO SENTENCES — bare values and plain band labels', async ({
    page,
  }) => {
    // The owner directive this face was authored under (2026-08-11): *"we
    // should prefer almost zero AI authored text… i want to lose all the ai
    // text"*. A `hint` is annotation-gated and paints nothing at rest, so the
    // only durable way to keep prose OFF this panel is to assert its absence
    // where it would appear.
    await gotoShell(page);
    const id = await spawnMarbles(page);
    const dock = await openDock(page, id);

    // BAND HEADERS ARE PLAIN LABELS: no numbering, no em-dash clause, no
    // sentence. The six are CLOCK / T GATES / T LOOP / X CV / QUANTISER /
    // X LOOP.
    const labels = await dock.locator('[data-testid="face-page"] .page-label').allTextContents();
    expect(labels.length, `six bands, got ${labels.join(' | ')}`).toBe(6);
    for (const l of labels) {
      expect(l.trim(), `band label "${l}" must be a plain label`).not.toMatch(/[—–.]|·|\d\s·/);
      expect(
        l.trim().split(/\s+/).length,
        `band label "${l}" must be at most three words`,
      ).toBeLessThanOrEqual(3);
    }

    // EVERY READOUT IS A VALUE, NOT A CLAUSE. The longest legitimate value on
    // ⚠ THE SECOND HALF USED TO READ THE HERO READOUT STRIP, and it is
    // RE-POINTED rather than deleted, because this test enforces the owner's
    // rule directly and the rule got STRONGER, not weaker: the strip is gone
    // entirely (2026-08-19), so the surviving question is whether the text that
    // remains on the faceplate is still nothing but names.
    //
    // The subject is now every CONTROL CAPTION — the one text role a resting
    // faceplate is allowed besides band labels — asserted the same way: a
    // caption is a NAME, so it is short and carries no clause punctuation.
    await expect(
      dock.getByTestId('face-hero-readouts'),
      'the hero readout strip is deleted platform-wide, not merely empty here',
    ).toHaveCount(0);

    const captions = await dock.locator('[data-cell-key] .label').allTextContents();
    expect(
      captions.length,
      'the sweep found no control captions — it would pass vacuously',
    ).toBeGreaterThan(0);
    for (const c of captions) {
      expect(c.trim().length, `control caption "${c}" must be a bare name`).toBeLessThanOrEqual(16);
      expect(c, `control caption "${c}" must not be a sentence`).not.toMatch(/—|,\s/);
    }
  });
});
