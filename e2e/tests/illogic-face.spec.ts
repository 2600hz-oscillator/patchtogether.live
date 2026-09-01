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

/**
 * ONE readiness budget, named once and shared by all three places that wait for
 * the scope to fill. It used to be the literal `SLOW_RENDER ? 20_000 : 10_000`
 * written out three times, which is how the negative control below came to
 * exceed its own test timeout without anyone being able to see the sum.
 */
const READY_BUDGET_MS = SLOW_RENDER ? 20_000 : 10_000;

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
  /**
   * Samples where BOTH channels read ~0 — the fingerprint of a HALF-FILLED
   * ANALYSER, and the whole subject of #1823.
   *
   * ⚠ IT CANNOT HAPPEN IN A CORRECT SIGNAL. With one source into both inputs
   * AND is the gate and NAND is its complement, so exactly one of them is high
   * at every sample; even mid-transition the pair sits near 0.5/0.5, not 0/0.
   * It happens for one reason: the ch2 edge materialised PART-WAY THROUGH the
   * 2048-sample window, so the older part of ch2's buffer is still the zeros it
   * was allocated with while ch1 already carries signal. At those indices the
   * complement reads |0 + 0 − 1| = 1.
   *
   * ⚠ AND THIS IS WHY `peakB > 0.9` WAS THE WRONG READINESS TEST. `peak` is an
   * ANY-sample property (a max) and `complementErr` is an EVERY-sample property
   * (a pointwise max of error). A part-filled buffer satisfies the first and
   * fails the second, so the poll certified a window the assertion then
   * rejected — a gate answering a different question from the one being asked.
   */
  bothZero: number;
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
        peak: 0, peakB: 0, intermediate: 1, sawLow: false, sawHigh: false, complementErr: 1,
        bothZero: 0, total: 0,
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
      let bothZero = 0;
      for (let i = 0; i < a.length; i++) {
        const v = a[i]!;
        if (Math.abs(v) > peak) peak = Math.abs(v);
        if (Math.abs(b[i]!) > peakB) peakB = Math.abs(b[i]!);
        if (Math.abs(v) < 0.02) sawLow = true;
        else if (Math.abs(v - 1) < 0.02) sawHigh = true;
        else mid++;
        complementErr = Math.max(complementErr, Math.abs(v + b[i]! - 1));
        if (Math.abs(v) < 0.02 && Math.abs(b[i]!) < 0.02) bothZero++;
      }
      return {
        peak, peakB, intermediate: mid / a.length, sawLow, sawHigh, complementErr,
        bothZero, total: a.length,
      };
    },
    { scopeId },
  );
}

/**
 * Read the scope until the snapshot is FULLY POPULATED on both channels, and
 * return THAT snapshot — #1823.
 *
 * ⚠ THE POINT IS THAT THE VALIDATED WINDOW AND THE ASSERTED WINDOW ARE THE SAME
 * OBJECT. The previous shape was
 *
 *     await expect.poll(() => readGate(...).peak…).toBeGreaterThan(0.9);
 *     const before = await readGate(...);          // ← a DIFFERENT snapshot
 *
 * so readiness was established for one buffer and the complement asserted on
 * another. Returning the snapshot that passed removes the seam entirely rather
 * than making it narrower; there is no interval in which the subject can change
 * because there is no second read.
 *
 * ⚠ THE PREDICATE IS DELIBERATELY WEAKER THAN THE ASSERTION, and that is the
 * design constraint that took the most care. Polling on "the complement holds"
 * and then asserting the complement would be self-fulfilling — a gate that
 * cannot fail. `bothZero` is strictly weaker: a correct signal never has both
 * channels at zero, but plenty of BROKEN ones satisfy it. Both jacks stuck HIGH
 * gives `bothZero === 0` and `complementErr === 1`, so the assertion keeps its
 * teeth on exactly the failure mode a readiness check must not swallow.
 *
 * ⚠ NOT A LONGER WAIT. The timeout bounds the failure; it is not the mechanism.
 * The mechanism is that the returned window is PROVEN free of pre-connection
 * zeros, so a slower machine takes more iterations rather than producing a
 * differently-correct answer.
 */
async function readGateWhenPopulated(
  page: Page,
  scopeId: string,
  what: string,
): Promise<GateStats> {
  const deadline = Date.now() + READY_BUDGET_MS;
  let last = await readGate(page, scopeId);
  while (Date.now() < deadline) {
    if (last.total > 0 && last.bothZero === 0 && last.peak > 0.9 && last.peakB > 0.9) return last;
    last = await readGate(page, scopeId);
  }
  throw new Error(
    `${what}: the scope never produced a fully-populated window. ` +
      `total=${last.total} peak(AND)=${last.peak.toFixed(3)} peak(NAND)=${last.peakB.toFixed(3)} ` +
      `bothZero=${last.bothZero}/${last.total} samples. ` +
      `bothZero > 0 means part of the window predates the ch2 edge (the #1823 race); ` +
      `peak(NAND) ≈ 0 with bothZero ≈ half the window means the NAND jack is genuinely dead.`,
  );
}

/**
 * Peak on ch1 alone — used for the SUM-bus positive control after the repatch,
 * where ch2 carries nothing and the complement is meaningless.
 *
 * ⚠ THE SIBLING AUDIT FOR #1823, RECORDED SO IT IS NOT REDONE OR "FIXED". Two
 * other places in this file poll `readGate` and they do NOT carry the race,
 * for a reason that is worth stating rather than rechecking:
 *
 *   · the SUM-bus control polls `readPeak(...) < 0.01`. "Peak below a floor" is
 *     an EVERY-sample property (a max under a bound), so a half-filled window
 *     can only DELAY it — the live part keeps the peak up — never satisfy it
 *     early. Safe direction.
 *   · the #1823 negative control polls `peak > 0.9` and then asserts
 *     `bothZero > 0`. A stale window can only INCREASE `bothZero`, so again the
 *     race cannot manufacture a pass.
 *
 * The rule the two share, and the one the flake broke: a readiness poll is safe
 * when the race can only push the measurement AWAY from the assertion's
 * threshold. It was unsafe at the two complement sites because `peak` (any
 * sample) and `complementErr` (every sample) move in opposite directions on a
 * partially-populated buffer.
 */
async function readPeak(page: Page, scopeId: string): Promise<number> {
  return (await readGate(page, scopeId)).peak;
}

test.describe('illogic face — four identical dials, and the four numbers they cannot print', () => {

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 21 recovered-on-retry observation(s) across 19 SHA(s) / 13 branch(es) in the
  // 96 h CI census to 2026-08-18 — it also hard-failed 3 time(s) on a branch, but the recovered-on-retry runs stayed green.
  // LOST WHILE PARKED: the two seams no unit or ART gate can reach — that ILLOGIC's DOM prints and redraws the LIVE graph value, and that the knobs cannot contaminate the logic jacks' clean gate output.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  //
  // ⚠ ONE HYPOTHESIS TESTED AND REFUTED, 2026-09-01 — recorded so it is not
  // re-run. The sibling negative control below WAS a budget overrun: it spends
  // `READY_BUDGET_MS` twice (once polling, then again driving
  // `readGateWhenPopulated` to EXHAUSTION, which is its contract), ~40 s against
  // Playwright's 30 s default, and it failed with the timeout's message rather
  // than the refusal's. The obvious guess was that THIS leg shares that cause —
  // it declares three budgeted waits, 3 x 20 s = 60 s on CI, which is also over
  // the clock. IT DOES NOT. All three of its waits are expected to SUCCEED, so
  // each returns as soon as the analyser window fills and none of the three
  // budgets is actually spent; a wait that genuinely exhausted here would THROW
  // "never produced a fully-populated window", a hard failure with its own
  // message, not a timeout. MEASURED, `E2E_SWIFTSHADER=1`, 5 consecutive runs:
  // 10.8 / 10.6 / 10.8 / 10.7 / 10.6 s — a tight distribution with ~19 s of
  // headroom. Cross-check that the local clock is not simply faster than CI:
  // `e2e-timings.generated.json` records 26.8 s for this FILE with this leg
  // skipped — i.e. essentially the negative control alone — and that same leg
  // measures 30.3 s locally under the same flag, so local is at least as slow
  // as CI here. A leg at 10.7 s locally is not the one hitting a 30 s wall.
  //
  // So the park STANDS: the 21 recovered-on-retry observations still have no
  // proven cause, and the double-budget arithmetic is now excluded rather than
  // merely unexamined. Five local passes say nothing about CI nondeterminism.
  test.fixme('IN A REAL BROWSER: the logic jacks are a clean gate, and the knobs do not reach them', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 21 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({
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

    // ⚠ READINESS IS A PROPERTY OF THE SNAPSHOT WE ASSERT ON — #1823.
    //
    // This used to poll `min(peak, peakB) > 0.9` and then take a SECOND
    // snapshot to assert against. Both halves were reasonable and the pair was
    // not: `peak` is an ANY-sample property, the complement is an EVERY-sample
    // property, so a window whose ch2 edge landed part-way through satisfied the
    // poll and failed the assertion. Measured at 1 run in 9 on `origin/main`,
    // printing exactly `1.000e+0` — the fingerprint of |0 + 0 − 1| at the
    // indices where ch2 was still its allocated zeros.
    //
    // `readGateWhenPopulated` returns the window it validated, so there is no
    // second read and no interval for the subject to change in.
    const before = await readGateWhenPopulated(page, scope, 'AND/NAND at the shipped defaults');
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
    // Same seam, same fix — the knob sweep re-writes params but the analyser
    // window is still 2048 samples wide, so a snapshot taken while the sweep's
    // effect is straddling it carries pre-sweep samples too.
    const after = await readGateWhenPopulated(page, scope, 'AND/NAND after the knob sweep');
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
        timeout: READY_BUDGET_MS,
      })
      .toBeLessThan(0.01);
  });

  // ── #1823 · THE READINESS PREDICATE, NEGATIVE-CONTROLLED ─────────────────
  //
  // The fix for the 1-in-9 flake replaced a readiness poll that answered a
  // DIFFERENT question from the assertion (`peak`, an any-sample max) with one
  // that is a property of the asserted window itself (`bothZero`, an
  // every-sample count). A readiness check that cannot fail is worse than the
  // race it replaced — it converts a loud flake into a silent pass — so this
  // leg proves the predicate discriminates, on a patch where a channel is
  // genuinely not live.
  //
  // ⚠ IT IS ALSO THE PROOF THAT THE PREDICATE IS NOT SELF-FULFILLING. Polling
  // on the complement and then asserting the complement would be a gate that
  // cannot fail; `bothZero` is strictly weaker, and the case below is one the
  // complement assertion would also reject — so readiness rejects a subset of
  // what the assertion rejects, never a superset.
  test('#1823 NEGATIVE CONTROL: an unwired NAND jack is REFUSED, not silently awaited', async ({
    page,
  }) => {
    // ⚠ THE ONLY TEST IN THIS FILE THAT SPENDS THE READINESS BUDGET **TWICE**,
    // and on CI that structurally exceeds Playwright's 30 s default — which is
    // what made it flaky rather than any nondeterminism in the subject. The
    // arithmetic, on CI (`READY_BUDGET_MS` = 20 s):
    //
    //   the AND-is-live poll ......................... up to 20 s
    //   readGateWhenPopulated, DRIVEN TO EXHAUSTION ... a further 20 s
    //
    // Every other caller of `readGateWhenPopulated` expects it to SUCCEED, so
    // it returns as soon as the window fills and the second budget is never
    // spent. This leg is the one place the refusal itself is the contract, so
    // the wait is guaranteed to run to its deadline. ~40 s of declared budget
    // against a 30 s test timeout is green only while the first poll happens to
    // return quickly, which is why it passed almost always and then failed on a
    // loaded shard with `page.evaluate: Test timeout of 30000ms exceeded` — the
    // TIMEOUT's message, not the refusal's, so the assertion never got to run.
    //
    // ⚠ NOT A LONGER WAIT IN THE SENSE THE RENDERER RULE FORBIDS. Nothing here
    // waits on a frame or sleeps: this is the FAILURE BOUND, and it is DERIVED
    // from the two budgets this test is already documented to spend rather than
    // picked. `readGateWhenPopulated`'s own header makes the same distinction:
    // "the timeout bounds the failure; it is not the mechanism".
    test.setTimeout(2 * READY_BUDGET_MS + 30_000);
    await gotoShell(page);
    const il = 'il-nc';
    const scope = 'il-nc-scope';
    // The SAME patch as the cross-implementation leg, with ONE edge missing:
    // AND reaches the scope, NAND does not. That is exactly the state the race
    // produced transiently, made permanent so it can be asserted on.
    await spawnPatch(
      page,
      [
        { id: 'lfo', type: 'lfo', position: { x: 60, y: 100 }, params: { rate: 100, shape: 2 } },
        { id: il, type: 'illogic', position: { x: 380, y: 100 } },
        { id: scope, type: 'scope', position: { x: 700, y: 100 }, params: { timeMs: 100 } },
      ],
      [
        { id: 'n1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: il, portId: 'in1' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'n2', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: il, portId: 'in2' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'n3', from: { nodeId: il, portId: 'and' }, to: { nodeId: scope, portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
        // …and deliberately NO edge from `nand` to ch2.
      ],
    );

    // AND alone reaches full scale, so this is NOT "nothing is wired" — the
    // half-live state is the whole point.
    await expect
      .poll(async () => (await readGate(page, scope)).peak, {
        message: 'the AND jack must be live, or this control proves nothing',
        timeout: READY_BUDGET_MS,
      })
      .toBeGreaterThan(0.9);

    const g = await readGate(page, scope);
    expect(g.peakB, 'ch2 carries nothing — the NAND edge was never made').toBeLessThan(0.02);
    expect(
      g.bothZero,
      'the stale/dead-channel fingerprint must FIRE here: wherever AND is low, both channels ' +
        'read zero. If this is 0 the predicate cannot see a dead channel and the readiness ' +
        'check is decoration.',
    ).toBeGreaterThan(0);
    // …and the old predicate's own failure mode, recorded: the complement
    // reads exactly 1.0 here, which is the number the flake printed.
    expect(g.complementErr).toBeGreaterThan(0.9);

    // THE ACTUAL CONTRACT: readiness REFUSES this window rather than returning
    // it, and says which of the two causes it is.
    await expect(
      readGateWhenPopulated(page, scope, 'negative control'),
      'an unwired channel must be reported, never awaited into a pass',
    ).rejects.toThrow(/fully-populated window/);
  });
});
