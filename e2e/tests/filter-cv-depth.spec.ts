// e2e/tests/filter-cv-depth.spec.ts
//
// FILTER — the CV-DEPTH ATTENUVERTERS (P1 batch-3 rework). The filter's
// cutoff CV jack is mapped ±5 OCTAVES by the Faust source, which is far too
// much throw for a plain 0..1 envelope: before this rework the only way to
// tame it was an external attenuator module. `cutoff_cv_amt` / `res_cv_amt`
// are GainNodes in the engine's CV path (packages/web/src/lib/audio/modules/
// filter.ts), so this spec pins the two properties that matter:
//
//   1. the jack is LIVE at the default depth (+1) — an LFO into `cutoff`
//      really does swing the filter open and shut, and
//   2. depth 0 MUTES the jack — the same patch goes still.
//
// Measured through the SCOPE snapshot seam (the audio-controls.spec.ts
// harness): a saw through an LP filter whose corner is being swept produces
// a large RMS spread over time; with the jack muted the RMS is steady. The
// assertion is a RATIO between the two spreads, so it is insensitive to the
// absolute level, the LFO's phase at sample time, and the analyser window.
//
// Why an e2e and not a unit test: the attenuverter only exists in the
// FACTORY's Web Audio graph (the Faust DSP has no such control), so the only
// honest place to prove it is a real engine + a real worklet.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { sampleScopeRms, scopePollMsg } from '../_helpers/scope-poll';

/** RMS of the live SCOPE snapshot for `scopeNodeId` (null until warm). */
async function readScopeRms(page: Page, scopeNodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch?: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    if (!w.__patch || !w.__engine) return null;
    const eng = w.__engine();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
    if (!snap) return null;
    let sumSq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i] ?? 0;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / snap.ch1.length);
  }, scopeNodeId);
}

/** Mutate one node param through the dev __patch global, then yield to the
 *  reconciler + the audio thread. */
async function setParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, paramId, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes[nodeId];
        if (target) target.params[paramId] = value;
      });
    },
    { nodeId, paramId, value },
  );
  await page.waitForTimeout(150);
}

/** Sample the SCOPE RMS `n` times and return max/min — the "how much is this
 *  filter moving?" statistic. The LFO period (500 ms at rate=2) is covered
 *  ~2× by 16 samples at 70 ms, so the window always spans both extremes
 *  regardless of the phase we start on. */
async function rmsSpread(page: Page, scopeNodeId: string, n = 16): Promise<number> {
  // The sampling loop runs IN THE PAGE (one export site). The old form did one
  // CDP round trip per sample against the audio thread it was measuring, which
  // is also the thread whose filter sweep produces the spread being read.
  const w = await sampleScopeRms(page, scopeNodeId, n, 70);
  expect(
    w.samples,
    scopePollMsg(`rmsSpread(${scopeNodeId}) resolved NO scope buffer, so its spread is not a measurement`, w),
  ).toBeGreaterThan(0);
  return w.hi / Math.max(1e-6, w.lo);
}

test.describe('filter: CV-depth attenuverters gate the cutoff jack', () => {
  test('cutoff_cv_amt scales the cutoff CV — full depth sweeps, depth 0 mutes the jack', async ({
    page,
    rack,
  }) => {
    void rack;
    // VCO saw (C4, ~262 Hz) → FILTER (LP, corner parked at 200 Hz) → SCOPE
    // → silent Out (master 0 keeps the graph alive without making noise).
    // LFO phase0 (2 Hz sine, unity depth) → filter.cutoff: at depth +1 that
    // is ±5 octaves, i.e. the corner swings between the 20 Hz floor and
    // ~6.4 kHz, which takes the saw from nearly-silent to nearly-open.
    await spawnPatch(
      page,
      [
        { id: 'vco', type: 'analogVco' },
        { id: 'lfo', type: 'lfo', params: { rate: 2, shape: 0, depth: 0.5 } },
        { id: 'flt', type: 'filter', params: { cutoff: 200, resonance: 0.1, mode: 0 } },
        { id: 'scp', type: 'scope' },
        { id: 'out', type: 'audioOut', params: { master: 0 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'flt', portId: 'audio' } },
        { id: 'e2', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'flt', portId: 'cutoff' } },
        { id: 'e3', from: { nodeId: 'flt', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' } },
        { id: 'e4', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      ],
    );

    // Wait for the worklet to boot + the sweep to be running.
    let warm = false;
    for (let i = 0; i < 40 && !warm; i++) {
      const rms = await readScopeRms(page, 'scp');
      warm = rms !== null && rms > 0.001;
      if (!warm) await page.waitForTimeout(100);
    }
    expect(warm, 'the SCOPE saw signal through the filter').toBe(true);

    // 1) DEFAULT depth (+1): the jack is live and the corner is sweeping.
    const sweeping = await rmsSpread(page, 'scp');
    expect(
      sweeping,
      `cutoff_cv_amt=+1: the LFO should swing the LP corner across ±5 octaves (RMS spread ${sweeping.toFixed(2)}×)`,
    ).toBeGreaterThan(2);

    // 2) DEPTH 0 mutes the jack — same patch, same LFO, no sweep.
    await setParam(page, 'flt', 'cutoff_cv_amt', 0);
    // The DSP's ~7 Hz one-pole (si.smoo) needs a few hundred ms to settle
    // the corner back onto the knob before we start sampling.
    await page.waitForTimeout(600);
    const muted = await rmsSpread(page, 'scp');

    expect(
      sweeping / muted,
      `depth 0 must calm the sweep: spread was ${sweeping.toFixed(2)}× at depth +1 and ${muted.toFixed(2)}× at depth 0`,
    ).toBeGreaterThan(2);
  });
});
