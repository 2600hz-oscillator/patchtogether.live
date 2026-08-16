// e2e/tests/illogic-face.spec.ts
//
// THE ILLOGIC FACE, driven for real — and specifically the two seams the other
// gates cannot see.
//
// `faces-parity` proves the four cells are present and operable.
// `illogic-face-model.test.ts` proves the arithmetic and the glyph resolution.
// `art/scenarios/illogic/face-audit.test.ts` proves the arithmetic is what the
// shipping factory does. None of them can see:
//
//  1. THAT THE DOM PRINTS AND DRAWS IT, for the live graph value, and keeps
//     doing so when the value moves. In particular that `logic` holds ×1.00
//     while its three neighbours move — a NEGATIVE control on a rendered
//     surface, which is where a wrong one is hardest to notice, because a
//     readout that moved with everything else would look more responsive.
//
//  2. ⚠ THAT THE LOGIC BLOCK BEHAVES THE SAME WAY IN A DIFFERENT WEB AUDIO
//     IMPLEMENTATION. The whole edge-fidelity and knob-immunity story was
//     measured under `node-web-audio-api`, and the product runs in Chrome.
//     `and` is built on the gain-AudioParam multiplier trick, whose fidelity is
//     an implementation property (an a-rate vs k-rate difference would show up
//     as exactly the dropped-edge signature #1703/#1725 had). So the last test
//     drives a real gate through the real engine in a real browser and asserts
//     BOTH halves of the headline there: the boolean output is a clean 0/1, and
//     it is unmoved by the attenuverters.
//
// Every expectation is computed by `$lib/ui/modules/illogic-face-model` — the
// SAME functions the readout registry and the panel call — so a change to the
// arithmetic moves the test and the product together, and the assertions that
// carry information are the RELATIONS (distinct / invariant / moved), not the
// literals.
//
// Runs on /rack (no DB, no relay). The faceplate shell is the DEFAULT rack
// since #1459.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  ILLOGIC_ATT_PARAM_IDS,
  ILLOGIC_LOGIC_TAPPED_INPUTS,
  illogicBusCeilingText,
  illogicChannelInputId,
  illogicDiffGainText,
  illogicLogicGainText,
  illogicSumGainText,
} from '../../packages/web/src/lib/ui/modules/illogic-face-model';
// ⚠ THIS IMPORT REACHES THE DEF, and on most modules that would not load here.
// `illogic-face-model` imports `$lib/audio/modules/illogic` to derive its port
// and param rosters, and a def that pulls a worklet in through a `?url` import
// cannot be resolved by node outside vite — which is why featurecv's face spec
// imports its model and says, in as many words, that it never imports the def.
// ILLOGIC HAS NO WORKLET (GainNodes, WaveShapers and one ConstantSource), so the
// chain resolves. If it ever grows one, this import is the thing that breaks.

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** A reader over an explicit overlay, in the shape the model reads — the def
 *  defaults fill anything not named. */
const at = (over: Record<string, number> = {}) => (id: string) => over[id];

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
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

/** Write a param straight into the graph. The point is to land on an EXACT
 *  value so the expectation is computable; the GESTURE is faces-parity's job. */
async function setParam(page: Page, nodeId: string, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, key, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId]!;
        n.params = { ...(n.params ?? {}), [key]: value };
      });
    },
    { nodeId, key, value },
  );
}

/** One hero readout, by its registered `valueId`. */
const heroReadout = (dock: Locator, valueId: string): Locator =>
  dock.locator(`[data-hero-readout="${valueId}"] dd`);

/**
 * Every readout the hero ACTUALLY PAINTED, read off the rendered faceplate.
 * DERIVED FROM THE ARTIFACT, not from a list — so a fifth readout enrols itself
 * in the distinctness clause below and a readout that silently stopped
 * rendering shrinks the set rather than being skipped.
 */
async function paintedHeroReadouts(dock: Locator): Promise<string[]> {
  return dock
    .locator('[data-hero-readout]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-hero-readout') ?? '').filter(Boolean));
}

/** The routing picture — rendered OUTSIDE the ModuleShell subtree (DockFullView
 *  owns the `.page.has-sidebar` grid), so it is scoped to the dock view. */
const routingPanel = (page: Page): Locator =>
  page.getByTestId('dock-full-view').getByTestId('sidebar-panel-illogic-routing');

interface GateStats {
  /** ch1 peak — the boolean jack under test. */
  peak: number;
  /**
   * ch2 peak — the COMPLEMENT jack.
   *
   * ⚠ IT EXISTS TO GATE READINESS, and leaving it out was a real flake (1 run
   * in 9). The two edges into the scope materialise independently, so ch1 can
   * be live while ch2's analyser still holds zeros — and then at every sample
   * where AND is LOW the complement reads |0 + 0 − 1| = 1 and the test fails
   * claiming the module broke its own truth table. "Not wired yet" and
   * "wired and wrong" were indistinguishable from the assertion's output,
   * which is the CLAUDE.md instrument rule in miniature.
   */
  peakB: number;
  /** Fraction of ch1 samples that are NEITHER near 0 nor near 1 — a gate's
   *  "cleanness". A soft or interpolated gate raises this. */
  intermediate: number;
  /** Did BOTH levels appear inside the window? A window that caught only one
   *  side proves nothing about a gate, and `false` here is what tells us so. */
  sawLow: boolean;
  sawHigh: boolean;
  /** max |ch1 + ch2 − 1| over the window — the AND/NAND complement, from ONE
   *  snapshot so the two channels are the same instant. */
  complementErr: number;
  total: number;
}

/**
 * Read the scope's two channels out of the live engine, in ONE snapshot.
 *
 * ⚠ THE ACCUMULATOR IS IN THE PAGE (CLAUDE.md: never sample a page-side
 * quantity with a Playwright-side poll loop) and it reports `total` +
 * `sawLow`/`sawHigh`, so "clean gate", "empty buffer" and "the window only
 * caught one level" are three distinguishable outcomes rather than one green.
 *
 * ⚠ AND EVERY METRIC IS WINDOW-INDEPENDENT, deliberately. The first draft of
 * this test measured DUTY CYCLE, which is unsound here: an AnalyserNode holds
 * 2048 samples = 42.7 ms at 48 kHz, so at 8 Hz the window covers a THIRD of one
 * cycle and the duty it reports is whichever phase happened to be captured
 * (measured 0.117 then 0.742 on an unchanged signal — a textbook instrument
 * artefact wearing the shape of a finding). Peak, cleanliness and the
 * complement relation are all pointwise, so none of them depends on how much of
 * a cycle the window holds.
 */
async function readGate(page: Page, scopeId: string): Promise<GateStats> {
  return page.evaluate(
    ({ scopeId }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const empty = {
        peak: 0, peakB: 0, intermediate: 1, sawLow: false, sawHigh: false, complementErr: 1, total: 0,
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[scopeId];
      if (!eng || !node) return empty;
      const snap = eng.read(node, 'snapshot') as Record<string, Float32Array> | undefined;
      const a = snap?.ch1;
      const b = snap?.ch2;
      if (!a || !b) return empty;
      let peak = 0;
      let peakB = 0;
      let mid = 0;
      let sawLow = false;
      let sawHigh = false;
      let complementErr = 0;
      for (let i = 0; i < a.length; i++) {
        const v = a[i]!;
        if (Math.abs(v) > peak) peak = Math.abs(v);
        if (Math.abs(b[i]!) > peakB) peakB = Math.abs(b[i]!);
        if (Math.abs(v) < 0.02) sawLow = true;
        else if (Math.abs(v - 1) < 0.02) sawHigh = true;
        else mid++;
        complementErr = Math.max(complementErr, Math.abs(v + b[i]! - 1));
      }
      return { peak, peakB, intermediate: mid / a.length, sawLow, sawHigh, complementErr, total: a.length };
    },
    { scopeId },
  );
}

/** Peak on ch1 alone — used for the SUM-bus positive control after the repatch,
 *  where ch2 carries nothing and the complement is meaningless. */
async function readPeak(page: Page, scopeId: string): Promise<number> {
  return (await readGate(page, scopeId)).peak;
}

test.describe('illogic face — four identical dials, and the four numbers they cannot print', () => {
  test('the hero prints four DERIVED values; three follow the graph and `logic` does not', async ({
    page,
  }) => {
    await gotoShell(page);
    const id = 'illogic-face-1';
    await spawnPatch(page, [{ id, type: 'illogic', position: { x: 240, y: 200 } }]);
    const dock = await openDock(page, id);

    // 1 · AT THE DEFAULTS. A fresh spawn has NO stored params — `node.params`
    // is a sparse overlay — so this also proves the def-default fallback in
    // `illogicFaceParams` is wired, not merely the live read.
    //
    // ⚠ `diff` READS ×0.00 HERE. One of the two mix buses ships configured as a
    // common-mode null, underneath four faders sitting at maximum.
    await expect(heroReadout(dock, 'illogic-sum-gain')).toHaveText(illogicSumGainText(at()));
    await expect(heroReadout(dock, 'illogic-diff-gain')).toHaveText(illogicDiffGainText(at()));
    await expect(heroReadout(dock, 'illogic-bus-ceiling')).toHaveText(illogicBusCeilingText(at()));
    await expect(heroReadout(dock, 'illogic-logic-gain')).toHaveText(illogicLogicGainText(at()));

    // 2 · THE ROSTER IS READ OFF THE RENDERED FACEPLATE, so a readout that
    // stopped painting shrinks the set rather than being skipped.
    const painted = await paintedHeroReadouts(dock);
    expect(painted, 'the hero paints its declared readouts').toEqual(
      expect.arrayContaining([
        'illogic-sum-gain',
        'illogic-diff-gain',
        'illogic-bus-ceiling',
        'illogic-logic-gain',
      ]),
    );

    // 3 · FLIP A SUBTRACTED CHANNEL. `sum` FALLS (4 → 2) and `diff` RISES
    // (0 → 2) — opposite directions on one gesture, which is the property that
    // stops them being one readout spelled twice. Meanwhile `peak` is still
    // (sign-blind) and `logic` is still (the knobs do not reach it): two
    // stillnesses with DIFFERENT causes, and this is the only surface where all
    // four are visible at once.
    const ch3 = ILLOGIC_ATT_PARAM_IDS[2]!;
    await setParam(page, id, ch3, -1);
    const subFlipped = at({ [ch3]: -1 });
    await expect(heroReadout(dock, 'illogic-sum-gain')).toHaveText(illogicSumGainText(subFlipped));
    await expect(heroReadout(dock, 'illogic-diff-gain')).toHaveText(illogicDiffGainText(subFlipped));
    await expect(heroReadout(dock, 'illogic-bus-ceiling')).toHaveText(illogicBusCeilingText(subFlipped));
    await expect(heroReadout(dock, 'illogic-logic-gain')).toHaveText(illogicLogicGainText(subFlipped));
    expect(illogicSumGainText(subFlipped), 'sum fell').not.toBe(illogicSumGainText(at()));
    expect(illogicDiffGainText(subFlipped), 'diff rose off the null').not.toBe(illogicDiffGainText(at()));

    // 3b · FLIP AN ADDED CHANNEL INSTEAD, where all three bus gains land on
    // DIFFERENT numbers (×2.00 / ×−2.00 / ×4.00). This is what proves the
    // agreement at the defaults was a property of the defaults and not three
    // reads of one value — and it is also where the `−` sign has to survive
    // into the DOM.
    await setParam(page, id, ch3, 1);
    const ch2 = ILLOGIC_ATT_PARAM_IDS[1]!;
    await setParam(page, id, ch2, -1);
    const addFlipped = at({ [ch2]: -1 });
    await expect(heroReadout(dock, 'illogic-sum-gain')).toHaveText(illogicSumGainText(addFlipped));
    await expect(heroReadout(dock, 'illogic-diff-gain')).toHaveText(illogicDiffGainText(addFlipped));
    await expect(heroReadout(dock, 'illogic-bus-ceiling')).toHaveText(illogicBusCeilingText(addFlipped));
    const texts = await Promise.all(
      ['illogic-sum-gain', 'illogic-diff-gain', 'illogic-bus-ceiling'].map((v) =>
        heroReadout(dock, v).textContent(),
      ),
    );
    expect(new Set(texts).size, `expected three distinct bus gains, got ${texts.join(' / ')}`).toBe(3);

    // 4 · MUTE A CHANNEL: `peak` finally moves, which proves it counts channels
    // rather than printing a constant that happens to be sign-blind.
    const ch1 = ILLOGIC_ATT_PARAM_IDS[0]!;
    await setParam(page, id, ch1, 0);
    const muted = at({ [ch2]: -1, [ch1]: 0 });
    await expect(heroReadout(dock, 'illogic-bus-ceiling')).toHaveText(illogicBusCeilingText(muted));
    // `logic` STILL has not moved, across every perturbation in this test.
    await expect(heroReadout(dock, 'illogic-logic-gain')).toHaveText(illogicLogicGainText(muted));
  });

  test('the routing picture draws the taps, the polarity split and the SIGN', async ({ page }) => {
    await gotoShell(page);
    const id = 'illogic-face-2';
    await spawnPatch(page, [{ id, type: 'illogic', position: { x: 240, y: 200 } }]);
    await openDock(page, id);

    const panel = routingPanel(page);
    await expect(panel).toBeVisible();

    // WHICH CHANNELS THE LOGIC BLOCK TAPS, read off what was DRAWN. The picture
    // exists for this one fact, so a picture that drew it wrong would be worse
    // than no picture.
    const tapped = await panel
      .locator('[data-logic="true"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    expect(tapped.sort()).toEqual(
      [...ILLOGIC_LOGIC_TAPPED_INPUTS].map((p) => `illogic-row-${p}`).sort(),
    );

    // THE POLARITY SPLIT reaches the drawing: the DIFF bus must add some
    // channels and subtract others, or it is not a difference bus.
    const signs = await panel
      .locator('[data-diff-sign]')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-diff-sign'))));
    expect(new Set(signs), 'the picture draws both polarities').toEqual(new Set([1, -1]));

    // THE SIGN, which is the one thing a level meter is structurally blind to.
    // Nothing is hatched at the shipped defaults; flipping one knob hatches
    // exactly one row.
    const row = (n: number) => panel.getByTestId(`illogic-row-${illogicChannelInputId(n)}`);
    await expect(panel.locator('[data-neg="true"]')).toHaveCount(0);
    await setParam(page, id, ILLOGIC_ATT_PARAM_IDS[1]!, -0.5);
    await expect(panel.locator('[data-neg="true"]')).toHaveCount(1);
    await expect(row(1)).toHaveAttribute('data-amount', '-0.5');

    // ⚠ AND IT EMITS NO CONTROL TESTID. faces-parity asserts exact multiset
    // equality between the dock's `control-*` testids and the def's param ids,
    // so a control-shaped testid inside a read-only picture reads as an
    // unbacked extra control (sidebar-panels.ts rule 1).
    await expect(panel.locator('[data-testid^="control-"]')).toHaveCount(0);
  });

  test('IN A REAL BROWSER: the logic jacks are a clean gate, and the knobs do not reach them', async ({
    page,
  }) => {
    // ⚠ THE CROSS-IMPLEMENTATION LEG. Everything else about the logic block was
    // measured under node-web-audio-api; `and` is built on the
    // gain-AudioParam multiplier, whose behaviour is an implementation
    // property. This drives the shipping engine in Chrome.
    await gotoShell(page);
    const il = 'il-logic';
    const scope = 'il-scope';
    await spawnPatch(
      page,
      [
        // A SQUARE LFO (shape 2) at unity depth: a genuine ±1 gate train, so
        // both logic inputs cross the 0.5 threshold cleanly and neither ever
        // rests inside the WaveShaper's interpolation band (#1750).
        //
        // ⚠ RATE 100 Hz (the dial's top) IS AN INSTRUMENT CHOICE, not taste.
        // The AnalyserNode window is 2048 samples = 42.7 ms, so at 100 Hz it
        // holds ~4.3 whole cycles and BOTH gate levels are guaranteed to appear
        // in every capture — asserted below via `sawLow`/`sawHigh` rather than
        // assumed. At the 8 Hz this test first used, the window covered a third
        // of one cycle and the capture was a phase lottery.
        { id: 'lfo', type: 'lfo', position: { x: 60, y: 100 }, params: { rate: 100, shape: 2 } },
        { id: il, type: 'illogic', position: { x: 380, y: 100 } },
        { id: scope, type: 'scope', position: { x: 700, y: 100 }, params: { timeMs: 100 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: il, portId: 'in1' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'e2', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: il, portId: 'in2' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'e3', from: { nodeId: il, portId: 'and' }, to: { nodeId: scope, portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
        { id: 'e4', from: { nodeId: il, portId: 'nand' }, to: { nodeId: scope, portId: 'ch2' }, sourceType: 'gate', targetType: 'audio' },
      ],
    );

    // ⚠ READINESS IS BOTH CHANNELS, not one. The two edges into the scope
    // materialise independently, and the complement assertion below reads them
    // together — so polling on AND alone lets a run reach it with NAND's
    // analyser still full of zeros. Measured: that flaked 1 run in 9, printing
    // a complement error of exactly 1.0, which reads as "the module broke its
    // own truth table" and is really "the cable was not plugged in yet".
    await expect
      .poll(async () => { const g = await readGate(page, scope); return Math.min(g.peak, g.peakB); }, {
        message: 'BOTH the AND and NAND jacks must reach full scale in the real engine',
        timeout: SLOW_RENDER ? 20_000 : 10_000,
      })
      .toBeGreaterThan(0.9);

    const before = await readGate(page, scope);
    expect(before.total, 'the analyser handed us a real buffer').toBeGreaterThan(0);
    expect(before.peakB, 'the NAND channel is live, not still zeros').toBeGreaterThan(0.9);
    expect(before.sawLow && before.sawHigh, 'the window caught BOTH gate levels').toBe(true);
    expect(
      before.intermediate,
      `AND must be a clean 0/1 gate; ${(before.intermediate * 100).toFixed(1)} % of samples were neither 0 nor 1`,
    ).toBeLessThan(0.05);
    // THE COMPLEMENT RELATION, in Chrome, from ONE snapshot: with a single
    // source into both inputs, AND == gate and NAND == 1 − gate, so the two
    // channels sum to 1 at every sample. Pointwise, so it does not care how
    // much of a cycle the analyser window holds.
    expect(
      before.complementErr,
      `max |AND + NAND − 1| over the window (linear amplitude) = ${before.complementErr.toExponential(3)}`,
    ).toBeLessThan(0.02);

    // ⚠ THE HEADLINE, IN THE BROWSER: run every attenuverter to a different
    // extreme — including zero, which mutes every mix output on the module —
    // and the boolean jacks do not budge.
    for (const [i, p] of ILLOGIC_ATT_PARAM_IDS.entries()) {
      await setParam(page, il, p, [0, -1, 0.5, -0.25][i]!);
    }
    await expect
      .poll(async () => { const g = await readGate(page, scope); return Math.min(g.peak, g.peakB); }, {
        message: 'AND and NAND after the knob sweep',
        timeout: SLOW_RENDER ? 20_000 : 10_000,
      })
      .toBeGreaterThan(0.9);
    const after = await readGate(page, scope);
    expect(after.sawLow && after.sawHigh, 'still toggling after the sweep').toBe(true);
    expect(after.intermediate, 'still a clean gate').toBeLessThan(0.05);
    expect(
      after.complementErr,
      'the AND/NAND complement survives every attenuverter setting',
    ).toBeLessThan(0.02);

    // POSITIVE CONTROL on the same probe, so "unmoved" is not "the scope is
    // frozen": the very knobs that left AND alone DO silence the SUM bus.
    await page.evaluate(
      ({ scopeId, il }) => {
        const w = globalThis as unknown as {
          __patch: {
            nodes: Record<string, unknown>;
            edges: Record<string, unknown>;
          };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          delete w.__patch.edges['e3'];
          w.__patch.edges['e5'] = {
            id: 'e5',
            from: { nodeId: il, portId: 'sum' },
            to: { nodeId: scopeId, portId: 'ch1' },
            sourceType: 'cv',
            targetType: 'audio',
          };
        });
      },
      { scopeId: scope, il },
    );
    for (const p of ILLOGIC_ATT_PARAM_IDS) await setParam(page, il, p, 0);
    await expect
      .poll(async () => readPeak(page, scope), {
        message: 'with every attenuverter at 0 the SUM bus must go silent',
        timeout: SLOW_RENDER ? 20_000 : 10_000,
      })
      .toBeLessThan(0.01);
  });
});
