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

/** One hero readout, by its registered `valueId`. */
const hero = (dock: Locator, valueId: string): Locator =>
  dock.locator(`[data-hero-readout="${valueId}"] dd`);

/** One SIDEBAR readout, by its LABEL.
 *
 * ⚠ THE ATTRIBUTE IS THE LABEL, NOT THE `valueId` — `FaceSidebar` emits
 * `data-side-readout={r.paramId ?? r.label}`, unlike the hero, which emits the
 * `valueId`. That is why this face's two loop rows are labelled `T loop` and
 * `X loop` rather than `loop` twice: two blocks sharing a label would collide
 * on one selector. The sidebar also renders OUTSIDE the ModuleShell
 * (DockFullView owns the grid), so it is scoped to the dock pane. */
const side = (page: Page, label: string): Locator =>
  page.getByTestId('dock-full-view').locator(`[data-side-readout="${label}"] dd`);

test.describe('marbles face — the values that carry a faceplate with no prose', () => {
  test('T/X RANDOM is non-monotone: 1.0 reads like 0.0, and the middle is the extreme', async ({
    page,
  }) => {
    await gotoShell(page);
    const id = await spawnMarbles(page);
    const dock = await openDock(page, id);

    // 1 · AT THE SHIPPED DEFAULT. A fresh spawn has NO stored params —
    // `node.params` is a sparse overlay — so this also proves the def-default
    // fallback in `marblesFaceParams` is wired, not just the live read.
    await expect(hero(dock, 'marbles-t-random')).toHaveText(marblesRandomText(0));
    await expect(hero(dock, 'marbles-x-random')).toHaveText(marblesRandomText(0));
    await expect(hero(dock, 'marbles-bpm')).toHaveText(marblesBpmText(at()));
    await expect(hero(dock, 'marbles-step')).toHaveText(marblesStepText(at()));

    const readTRandom = () => hero(dock, 'marbles-t-random').textContent();
    const atZero = await readTRandom();

    // 2 · THE MIDDLE IS THE EXTREME. `p = (2·dv − 1)²` is 0 at the lock.
    await setParams(page, id, { deja_vu: 0.5, x_deja_vu: 0.5 });
    await expect(hero(dock, 'marbles-t-random')).toHaveText(marblesRandomText(0.5));
    await expect(hero(dock, 'marbles-x-random')).toHaveText(marblesRandomText(0.5));
    const atHalf = await readTRandom();
    expect(atHalf, 'the lock must not read the same as free').not.toBe(atZero);

    // 3 · THE PROPERTY A MONOTONE IMPLEMENTATION CANNOT HAVE. At the TOP of the
    // knob the value returns to its BOTTOM reading. A readout that scaled with
    // the knob would print its maximum here and its minimum at step 1.
    await setParams(page, id, { deja_vu: 1, x_deja_vu: 1 });
    await expect(hero(dock, 'marbles-t-random')).toHaveText(marblesRandomText(1));
    expect(
      await readTRandom(),
      'DÉJÀ VU 1 and DÉJÀ VU 0 are equally disordered — that IS this module',
    ).toBe(atZero);

    // 4 · AND IT COMES BACK DOWN, so a value that only ever grew cannot pass.
    await setParams(page, id, { deja_vu: 0.5 });
    await expect(hero(dock, 'marbles-t-random')).toHaveText(marblesRandomText(0.5));
  });

  test('the LOOP readout refuses to print a length it cannot honour', async ({ page }) => {
    await gotoShell(page);
    const id = await spawnMarbles(page);
    const dock = await openDock(page, id);

    // At the shipped DÉJÀ VU 0, LENGTH is BIT-EXACTLY inert (asserted against
    // the real DSP in marbles-face-model.test.ts), so the faceplate must not
    // advertise it. `8` is the def default and would be the wrong answer.
    await expect(side(page, 'T loop')).toHaveText('free');
    await expect(side(page, 'T loop')).not.toHaveText(/\d/);

    // Moving LENGTH alone changes NOTHING, because there is no loop to be that
    // long — the same invariance the DSP has.
    await setParams(page, id, { length: 3 });
    await expect(side(page, 'T loop')).toHaveText('free');

    // Open the loop and the length appears — so the clause above is a real
    // condition and not a hard-coded string.
    await setParams(page, id, { deja_vu: 0.5 });
    await expect(side(page, 'T loop')).toHaveText(marblesLoopText(0.5, 3));
    await expect(side(page, 'T loop')).toHaveText('3 steps');
  });

  test('GLIDE and QUANTISER read 0 % / off together — the gap the module ships in', async ({
    page,
  }) => {
    await gotoShell(page);
    const id = await spawnMarbles(page);
    const dock = await openDock(page, id);

    // THE SHIPPED STATE: the portamento has ended (STEPS 0.49) and the
    // quantiser has not started (STEPS 0.536), so both halves of that dial are
    // doing nothing at its default of 0.50, and SCALE has nothing to act on.
    await expect(side(page, 'glide')).toHaveText('0 %');
    await expect(side(page, 'quantiser')).toHaveText('off');
    await expect(side(page, 'scales')).toHaveText('1 of 6');

    // BELOW the gap it is a portamento…
    await setParams(page, id, { steps: 0 });
    await expect(side(page, 'glide')).toHaveText(marblesGlideText(at({ steps: 0 })));
    await expect(side(page, 'glide')).not.toHaveText('0 %');
    await expect(side(page, 'quantiser')).toHaveText('off');

    // …and ABOVE it a quantiser, with the glide gone.
    await setParams(page, id, { steps: 0.79 });
    await expect(side(page, 'glide')).toHaveText('0 %');
    await expect(side(page, 'quantiser')).toHaveText(
      marblesQuantiserText(at({ steps: 0.79 })),
    );
    await expect(side(page, 'quantiser')).toHaveText('7 of 12');
    await expect(side(page, 'scales')).toHaveText('6 of 6');

    // ⚠ AND THE `scales` VALUE MUST NOT MOVE WITH `scale` — it counts how many
    // of the six DIFFER at this STEPS, which is a property of the quantiser
    // level and not of the selection. A readout wired to the selected scale
    // would change here.
    await setParams(page, id, { scale: 4 });
    await expect(side(page, 'scales')).toHaveText('6 of 6');
    await expect(side(page, 'quantiser')).toHaveText(
      marblesQuantiserText(at({ steps: 0.79, scale: 4 })),
    );
  });

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

    // THE STUB. `t_model` 1 is named CLUSTERS and the DSP runs the COIN
    // generator for it — a two-line commented fall-through in marbles-core. The
    // faceplate refuses to paint it as its own model.
    await setParams(page, id, { t_model: 1 });
    await expect(side(page, 'model')).toHaveText(
      marblesModelText(at({ t_model: 1 })),
    );
    await expect(side(page, 'model')).toHaveText(/CLUSTERS.*COIN/);
    // NEGATIVE CONTROL: a model that IS implemented prints its bare name.
    await setParams(page, id, { t_model: 2 });
    await expect(side(page, 'model')).toHaveText(MARBLES_T_MODEL_NAMES[2]);
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
    // this face is `DC -5.00 V` (10 characters) — anything sentence-shaped is
    // longer and contains a verb or an em-dash.
    const values = await dock
      .getByTestId('face-hero-readouts')
      .locator('dd')
      .allTextContents();
    expect(values.length).toBe(4);
    for (const v of values) {
      expect(v.trim().length, `hero readout "${v}" must be a bare value`).toBeLessThanOrEqual(16);
      expect(v, `hero readout "${v}" must not be a sentence`).not.toMatch(/—|,\s/);
    }
  });
});
