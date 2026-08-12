// e2e/tests/rings-face.spec.ts
//
// THE RINGS FACE, driven for real — and the one assertion that could not be
// made anywhere else: THAT THE MODULE CAN NOW BE SOUNDED.
//
// rings is a BODY, not a voice. With nothing patched and nothing struck its
// output is not quiet, it is BIT-ZERO (pinned in the unit lane against the real
// algorithm, `rings-face-model.test.ts`). Before this face there was no strum
// control anywhere in the product — not on the card, not on any shell tier — so
// a user could spawn it, turn all seven knobs, and hear nothing. The audition
// added here is the fix, and it runs through a factory seam (`manualTrigger` →
// a host-side ConstantSource on the worklet's STRUM input) that writes NOTHING
// to the graph. That is precisely why `readParam`/`readData` are structurally
// blind to it and why the observable is the AUDITION LEDGER.
//
// ⚠ THE LEDGER'S `delivered` FIELD IS THE WHOLE POINT, and the negative control
// below is what makes this a real assertion rather than a button that flashes.
// `toBeEnabled()` and `click()` both pass against a seam that resolves nothing —
// that is the sixstrum defect, and it is exactly what a press-and-see test
// cannot distinguish. So this spec asserts `delivered: true` AND separately
// proves the predicate can read false, on this module, in this browser.
//
// What is NOT here, because it is already covered and duplicating it would be
// CI wall-time for nothing:
//   · that every cell is present and operable — `faces-parity`, registry-driven
//     off STRICT_FACES, which rings joins automatically;
//   · that the comb arithmetic matches the shipping DSP — `rings-face-model
//     .test.ts`, 24 legs including spectrum oracles on the real taps;
//   · that the dock renders three bands — the VRT roster's `openDock` count.
//
// Runs on /rack (no DB, no relay). The faceplate shell is the DEFAULT rack
// since #1459; `?shell=legacy` is the escape hatch, not this.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  ringsBodyText,
  ringsEvenTapText,
  ringsSecondPartialText,
} from '../../packages/web/src/lib/ui/modules/rings-face-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

interface AuditionRecord {
  seq: number;
  nodeId: string;
  seam: 'manual-strike' | 'manual-gate' | 'engine-message' | 'manual-press';
  high?: boolean;
  paramId?: string;
  delivered: boolean;
}

function readAuditionLog(page: Page): Promise<AuditionRecord[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __auditionLog?: () => AuditionRecord[] };
    return w.__auditionLog ? w.__auditionLog() : [];
  });
}

/** Mirrors `auditionDelivered`, which is negative-controlled in both directions
 *  in the unit lane on every run — so this side stays a thin read. */
const delivered = (log: AuditionRecord[], nodeId: string, sinceSeq: number): boolean =>
  log.some((r) => r.seq > sinceSeq && r.nodeId === nodeId && r.seam === 'manual-strike' && r.delivered);

/** Every manual-strike record for this node since `sinceSeq`, delivered or not.
 *  The distinction between "no record" and "a record saying it reached nothing"
 *  is the one the ledger exists to preserve. */
const attempts = (log: AuditionRecord[], nodeId: string, sinceSeq: number): AuditionRecord[] =>
  log.filter((r) => r.seq > sinceSeq && r.nodeId === nodeId && r.seam === 'manual-strike');

const lastSeq = (log: AuditionRecord[]): number =>
  log.reduce((m, r) => Math.max(m, r.seq), 0);

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function spawnRings(page: Page, id = 'rings-face-1'): Promise<string> {
  await spawnPatch(page, [{ id, type: 'rings', position: { x: 240, y: 200 } }]);
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
 *  so the expected string is a literal; the GESTURE is covered by faces-parity,
 *  which drags every cell. */
async function setParams(page: Page, nodeId: string, values: Record<string, number>): Promise<void> {
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

test.describe('rings face — THE AUDITION (the module could not be sounded before it)', () => {
  test('the dock STRUM cell reaches the engine and the ledger records delivered', async ({ page }) => {
    await gotoShell(page);
    const nodeId = await spawnRings(page);
    const dock = await openDock(page, nodeId);

    const strum = dock.locator('[data-cell-key="rings-strum-{n}"] button').first();
    await expect(strum, 'the STRUM action cell renders in the dock hero').toBeVisible();
    await expect(strum).toBeEnabled();

    const before = lastSeq(await readAuditionLog(page));
    await strum.click();

    await expect
      .poll(async () => delivered(await readAuditionLog(page), nodeId, before), {
        message:
          'pressing STRUM must reach a callable off the live engine handle. `delivered: false` ' +
          'means the seam resolved nothing — the sixstrum defect, which toBeEnabled() and ' +
          'click() both pass.',
        timeout: SLOW_RENDER ? 15_000 : 8_000,
      })
      .toBe(true);
  });

  test('the CARD STRUM button drives the SAME seam (one implementation, not two)', async ({ page }) => {
    // §7-B: the legacy card had a MODEL button, six faders and a jack field and
    // no way to excite any of it. It now shares the face's seam exactly.
    //
    // ⚠ `?shell=legacy`, AND THAT IS LOAD-BEARING RATHER THAN INCIDENTAL. rings
    // is in STRICT_FACES as of this PR, so `migrated()` is true and the DEFAULT
    // rack renders the curated ModuleShell face — the legacy card is not
    // mounted at all and its testids do not exist. This leg exists precisely
    // because the card is still the surface `?shell=legacy` users get, and the
    // defect it fixes (a module that cannot be sounded) was THEIRS first.
    await page.goto('/rack?shell=legacy&seed=none');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({
      timeout: SLOW_RENDER ? 30_000 : 15_000,
    });
    const nodeId = await spawnRings(page);

    const cardStrum = page.getByTestId(`rings-strum-${nodeId}-1`);
    await expect(cardStrum, 'the legacy card carries a STRUM button').toBeVisible();

    const before = lastSeq(await readAuditionLog(page));
    await cardStrum.click();

    await expect
      .poll(async () => delivered(await readAuditionLog(page), nodeId, before), {
        message: 'the card button must reach the same manual-strike seam the face cell reaches',
        timeout: SLOW_RENDER ? 15_000 : 8_000,
      })
      .toBe(true);
  });

  test('NEGATIVE CONTROL — the predicate reads FALSE when the seam cannot deliver', async ({ page }) => {
    // ⚠ WITHOUT THIS LEG THE TWO ABOVE PROVE NOTHING. A predicate that returned
    // `true` unconditionally would pass both. This drives the SAME button on a
    // node whose engine handle has been made unreachable, and requires the
    // ledger to record the attempt with `delivered: false` — so "pressed and
    // reached nothing" stays distinguishable from "never pressed", which is the
    // property the ledger exists for.
    await gotoShell(page);
    const nodeId = await spawnRings(page);
    const dock = await openDock(page, nodeId);

    // The DOCK action cell — rings is migrated, so this is the surface a user
    // actually gets (the legacy card is not mounted on the default rack).
    const strum = dock.locator('[data-cell-key="rings-strum-{n}"] button').first();
    await expect(strum).toBeVisible();

    // Sanity: it delivers BEFORE the perturbation, so a failure below is the
    // perturbation and not a broken spawn.
    let before = lastSeq(await readAuditionLog(page));
    await strum.click();
    await expect
      .poll(async () => delivered(await readAuditionLog(page), nodeId, before), {
        message: 'baseline: it must deliver before the seam is broken',
        timeout: SLOW_RENDER ? 15_000 : 8_000,
      })
      .toBe(true);

    // BREAK THE SEAM AT EXACTLY THE POINT THE PREDICATE DEPENDS ON: make the
    // engine stop answering the `manualTrigger` read key. That is the same
    // perturbation this repo ran by hand on karplus — disconnect the read key,
    // watch the probe go red while `toBeEnabled()` and `click()` both keep
    // passing — made permanent here.
    //
    // ⚠ IT PATCHES `read`, NOT ENGINE INTERNALS, and that is deliberate. An
    // earlier draft deleted the node from a `nodes` Map and silently SKIPPED,
    // because `PatchEngine` holds `domains`, not a flat map — a negative
    // control that skips is worse than none, since the two tests above then
    // assert nothing and the suite still reports green. `read(node, key)` is
    // the seam `resolveManualStrike` actually calls, so this cannot drift out
    // of relevance without the seam itself changing.
    const broke = await page.evaluate(() => {
      // ⚠ `__engine` is a GETTER (`() => engine`), not the engine — Canvas.svelte.
      const w = globalThis as unknown as {
        __engine?: () => { read?: (n: unknown, k: string) => unknown } | undefined;
      };
      const eng = typeof w.__engine === 'function' ? w.__engine() : undefined;
      if (!eng || typeof eng.read !== 'function') return false;
      const orig = eng.read.bind(eng);
      eng.read = (n: unknown, k: string) => (k === 'manualTrigger' ? undefined : orig(n, k));
      return true;
    });
    expect(
      broke,
      'the perturbation must APPLY — a negative control that cannot run is not a negative ' +
        'control, and a skip here would leave both delivered:true assertions vacuous',
    ).toBe(true);

    before = lastSeq(await readAuditionLog(page));
    await strum.click();

    await expect
      .poll(async () => attempts(await readAuditionLog(page), nodeId, before).length, {
        message: 'a press that reaches nothing must still be RECORDED, never dropped',
        timeout: SLOW_RENDER ? 15_000 : 8_000,
      })
      .toBeGreaterThan(0);

    const log = await readAuditionLog(page);
    expect(
      attempts(log, nodeId, before).every((r) => r.delivered === false),
      'with the handle gone the ledger must record delivered:false — if this reads true the ' +
        'probe cannot distinguish a working audition from a dead one, and both tests above are ' +
        'vacuous',
    ).toBe(true);
  });
});

test.describe('rings face — the three hero readouts say what no knob on the panel can', () => {
  test('each readout prints the MODEL value, and they are not knob readbacks', async ({ page }) => {
    await gotoShell(page);
    const nodeId = await spawnRings(page);
    const dock = await openDock(page, nodeId);

    // A state the three readouts distinguish: SYMPATHETIC, off a node.
    await setParams(page, nodeId, { model: 0, structure: 0.25, note: 0, position: 0.5 });

    const hero = dock.locator('[data-testid="face-hero"]');
    await expect(hero).toBeVisible();

    // Keyed by the readout's `valueId` — the shell writes
    // `data-hero-readout={paramId ?? valueId ?? label}` — so a readout silently
    // re-pointed at a PARAM would change this attribute and fail to resolve,
    // which is the substitution these assertions most need to catch.
    const readout = (valueId: string) => hero.locator(`[data-hero-readout="${valueId}"] dd`).first();

    // MODAL at the defaults.
    const p0 = { model: 0, note: 0, structure: 0.25, brightness: 0.5, damping: 0.5, position: 0.5, level: 0.8 };
    await expect(readout('rings-body')).toHaveText(ringsBodyText(p0));
    await expect(readout('rings-partial2-hz')).toHaveText(ringsSecondPartialText(p0));
    await expect(readout('rings-even-tap-state')).toHaveText(ringsEvenTapText(p0));

    // ⚠ THE SEAM THIS SPEC EXISTS FOR: switch MODEL and the `2nd` readout must
    // change, because the QUANTITY changes identity (partial 2 → a detuned
    // second string). A readout hard-wired to `2*f0*(1+s/2)` prints the same
    // number in both models and passes every assertion above.
    const p1 = { ...p0, model: 1 };
    await setParams(page, nodeId, { model: 1 });
    await expect(readout('rings-body')).toHaveText(ringsBodyText(p1));
    await expect(readout('rings-partial2-hz')).toHaveText(ringsSecondPartialText(p1));
    expect(
      ringsSecondPartialText(p1),
      'the two models must give different answers, or the leg above is vacuous',
    ).not.toBe(ringsSecondPartialText(p0));
  });

  test('the EVEN tap readout goes SILENT at the two pickup nodes — POSITION cannot say so', async ({ page }) => {
    await gotoShell(page);
    const nodeId = await spawnRings(page);
    const dock = await openDock(page, nodeId);

    const hero = dock.locator('[data-testid="face-hero"]');
    const evenTap = hero.locator('[data-hero-readout="rings-even-tap-state"] dd').first();

    await setParams(page, nodeId, { position: 0.5 });
    await expect(evenTap).toHaveText('live');

    // 0.25 and 0.75 put the EVEN output at DIGITAL ZERO (measured peak 5.028e-16
    // and 1.302e-15 against an unaffected ODD). A `paramId: 'position'` readout
    // prints `0.25` and `0.75` here and says nothing.
    for (const position of [0.25, 0.75]) {
      await setParams(page, nodeId, { position });
      await expect(evenTap, `POSITION ${position} is a node`).toHaveText('silent');
    }

    // …and 0.30 / 0.70 are the SAME bank as each other (bit-identical, measured)
    // while the knob prints two different numbers — both must read live.
    for (const position of [0.3, 0.7]) {
      await setParams(page, nodeId, { position });
      await expect(evenTap, `POSITION ${position} is live`).toHaveText('live');
    }
  });
});

test.describe('rings face — the hero picture is alive on a silent module', () => {
  test('the comb panel renders and its VIEW toggle changes the caption', async ({ page }) => {
    // The panel is DRAWN, never traced: rings outputs bit-zero at rest, so an
    // analyser-backed picture would be a flat line here. This is the assertion
    // that it is drawing from the params instead.
    await gotoShell(page);
    const nodeId = await spawnRings(page);
    const dock = await openDock(page, nodeId);

    const panel = dock.getByTestId('rings-comb');
    await expect(panel, 'the pickup-comb hero panel renders').toBeVisible();

    // ⚠ IT MUST NOT EMIT A CONTROL TESTID (shell-cells rule 1): faces-parity
    // asserts exact multiset equality between the dock's `control-*` testids
    // and the def's param ids, so a control-shaped testid inside a panel reads
    // as an unbacked extra control.
    await expect(panel.locator('[data-testid^="control-"]')).toHaveCount(0);

    const caption = panel.getByTestId('rings-comb-caption');
    const first = (await caption.textContent())?.trim();
    await panel.getByTestId('rings-comb-view').click();
    await expect(caption, 'the VIEW toggle must actually change the picture').not.toHaveText(first ?? '');
  });

  test('the drawn bank responds to POSITION — the comb is live, not a static image', async ({ page }) => {
    await gotoShell(page);
    const nodeId = await spawnRings(page);
    const dock = await openDock(page, nodeId);
    const panel = dock.getByTestId('rings-comb');
    await expect(panel).toBeVisible();

    /** The bar geometry, as the DOM has it. */
    const bars = async (): Promise<string> =>
      panel.locator('svg').first().evaluate((svg) =>
        Array.from(svg.querySelectorAll('line.bar'))
          .map((l) => `${l.getAttribute('x1')}:${l.getAttribute('y2')}`)
          .join('|'),
      );

    await setParams(page, nodeId, { position: 0.5 });
    const atMax = await bars();
    expect(atMax.length, 'the bank draws bars at all').toBeGreaterThan(0);

    // At 0.25 every EVEN-tap partial is nulled, so the drawn heights MUST move.
    await setParams(page, nodeId, { position: 0.25 });
    await expect
      .poll(bars, { message: 'POSITION must re-draw the comb', timeout: SLOW_RENDER ? 15_000 : 8_000 })
      .not.toBe(atMax);
  });
});
