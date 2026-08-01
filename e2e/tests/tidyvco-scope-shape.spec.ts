// e2e/tests/tidyvco-scope-shape.spec.ts
//
// THE SCOPE MUST SHOW THE SHAPE THE KNOB CLAIMS. TIDY VCO → SCOPE.ch1, the
// voice droning on its HOLD gate with the filter parked wide open, and the
// SCOPE's OWN displayed buffer (the same `read(node,'snapshot')` the on-card
// canvas draws from) classified at all three SHAPE landmarks:
//
//     SHAPE 0 → SINE      SHAPE 0.5 → TRIANGLE      SHAPE 1 → SQUARE
//
// ── Why these statistics ────────────────────────────────────────────────
// Both are PHASE-INVARIANT (the analyser window starts wherever it starts,
// so anything alignment-dependent would be a flake generator) and both are
// direct readings of what the trace LOOKS like:
//
//   • CREST factor (peak / RMS)  — ideal 1.000 square, 1.414 sine, 1.732
//     triangle. It is literally "how far the trace pokes above its own
//     average height".
//   • DWELL fraction (|v| > 0.9·peak) — how much of the trace sits pinned
//     at the rails: ideal ≈ 1.00 square, 0.287 sine, 0.100 triangle.
//
// ⚠ THE LOAD-BEARING ASSERTION IS THE NON-MONOTONE ORDERING. Crest goes
// 1.39 → 1.56 → 1.11 across SHAPE 0 → 0.5 → 1: the MIDDLE is the extreme.
// No two-anchor morph can do that — the old saw↔pulse law ran monotonically
// DOWN from ~1.73 to ~1.10. So this test fails loudly if the DSP ever
// reverts to a two-anchor law, even one that still moves the knob.
//
// Measured through the real browser chain at C4 with the ladder wide open
// (offline reference from the pure core, 2048-sample window):
//     crest  s0 1.388  s0.5 1.558  s1 1.108
//     dwell  s0 0.292  s0.5 0.155  s1 0.667
// The bands below carry ~±0.1 of slack for the live graph.
//
// AUDIO-only — no WebGL/renderer tolerance needed. Card-side displays (the
// on-card WAVE screen and the shell's DUAL glyph) are covered by
// workflow-shell-dual-glyph.spec.ts + the scope-screen-model unit gates;
// this spec is about what a PATCHED-IN SCOPE shows.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, setNodeParams } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

interface ShapeStats {
  crest: number;
  dwell: number;
  peak: number;
  frames: number;
}

/**
 * Poll the SCOPE's displayed buffer until it carries real signal, then
 * classify the LOUDEST frame seen. Frames under the energy floor are
 * skipped so the statistics are never computed on silence (a vacuous pass
 * is the failure mode this guards).
 */
async function classifyScopeTrace(page: Page, scopeId: string, ms = 1500): Promise<ShapeStats> {
  const deadline = Date.now() + ms;
  const crests: number[] = [];
  const dwells: number[] = [];
  const peaks: number[] = [];
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, scopeId);
    if (snap) {
      const buf = snap.ch1 as unknown as number[];
      let peak = 0;
      let sq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i]!;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sq += v * v;
      }
      const rms = Math.sqrt(sq / Math.max(1, buf.length));
      if (rms > 5e-3 && peak > 0) {
        let hi = 0;
        for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]!) > 0.9 * peak) hi++;
        crests.push(peak / rms);
        dwells.push(hi / buf.length);
        peaks.push(peak);
      }
    }
    await page.waitForTimeout(60);
  }
  // MEDIAN, not the loudest frame. Picking the max-peak frame is a SELECTION
  // BIAS on exactly the statistic under test — the frame with the biggest
  // peak is by construction the frame with the biggest crest, so a sine read
  // 1.575 instead of its true 1.39. The median is the honest centre.
  const mid = (xs: number[]): number =>
    xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return { crest: mid(crests), dwell: mid(dwells), peak: mid(peaks), frames: crests.length };
}

test('TIDY VCO → SCOPE: the trace is a SINE at 0, a TRIANGLE at 0.5 and a SQUARE at 1', async ({
  page,
  rack,
  errorWatch,
}) => {
  await spawnPatch(
    page,
    [
      {
        id: 's-tv',
        type: 'tidyVco',
        position: { x: 80, y: 60 },
        domain: 'audio',
        params: {
          // Drone on the panel HOLD gate — no sequencer, so the trace is a
          // steady continuous wave rather than a gated burst (the gate/pitch
          // source chains are covered by tidy-vco.spec.ts).
          hold: 1,
          // Show the OSCILLATOR, not the voice: one osc, no sub/detune/fold,
          // ladder parked wide open with no resonance, drive or EG sweep, and
          // a flat sustained amp envelope.
          shape1: 0,
          shape2: 0,
          mix: 0,
          sub: 0,
          detune: 0,
          oct2: 0,
          fold: 0,
          sym: 0,
          cutoff: 14000,
          res: 0,
          drive: 0,
          env: 0,
          track: 0,
          width: 0,
          atk: 0.002,
          dec: 0.01,
          sus: 1,
          rel: 0.05,
          level: 0,
        },
      },
      { id: 's-scp', type: 'scope', position: { x: 620, y: 60 }, domain: 'audio', params: { timeMs: 20 } },
    ],
    [
      {
        id: 'se1',
        from: { nodeId: 's-tv', portId: 'out_l' },
        to: { nodeId: 's-scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  await expect(page.locator('.svelte-flow__node-scope')).toBeVisible();

  // Collect ALL THREE landmarks first, then assert — so a failure prints the
  // whole ladder instead of aborting on the first band.
  const sine = await classifyScopeTrace(page, 's-scp');
  await setNodeParams(page, 's-tv', { shape1: 0.5 });
  const tri = await classifyScopeTrace(page, 's-scp');
  await setNodeParams(page, 's-tv', { shape1: 1 });
  const square = await classifyScopeTrace(page, 's-scp');
  const ladder =
    `crest ${sine.crest.toFixed(3)} / ${tri.crest.toFixed(3)} / ${square.crest.toFixed(3)}  ` +
    `dwell ${sine.dwell.toFixed(3)} / ${tri.dwell.toFixed(3)} / ${square.dwell.toFixed(3)}`;

  // The SCOPE saw real signal at every landmark (never a vacuous pass).
  expect(sine.frames, 'live trace at SHAPE 0').toBeGreaterThan(0);
  expect(tri.frames, 'live trace at SHAPE 0.5').toBeGreaterThan(0);
  expect(square.frames, 'live trace at SHAPE 1').toBeGreaterThan(0);

  // ── SHAPE 0 — SINE ──────────────────────────────────────────────────
  expect(sine.crest, `SINE crest (ideal 1.414) — ${ladder}`).toBeGreaterThan(1.28);
  expect(sine.crest, `SINE crest (ideal 1.414) — ${ladder}`).toBeLessThan(1.47);
  expect(sine.dwell, `SINE rail dwell (ideal 0.287) — ${ladder}`).toBeGreaterThan(0.22);
  expect(sine.dwell, `SINE rail dwell (ideal 0.287) — ${ladder}`).toBeLessThan(0.38);

  // ── SHAPE 0.5 — TRIANGLE ────────────────────────────────────────────
  expect(tri.crest, `TRIANGLE crest (ideal 1.732) — ${ladder}`).toBeGreaterThan(1.47);
  expect(tri.dwell, `TRIANGLE rail dwell (ideal 0.100) — ${ladder}`).toBeLessThan(0.22);

  // ── SHAPE 1 — SQUARE ────────────────────────────────────────────────
  expect(square.crest, `SQUARE crest (ideal 1.000) — ${ladder}`).toBeLessThan(1.25);
  expect(square.dwell, `SQUARE rail dwell (ideal 1.000) — ${ladder}`).toBeGreaterThan(0.50);

  // ── THE SIGNATURE: the MIDDLE of the knob is the extreme ─────────────
  // Crest peaks at the TRIANGLE and bottoms at the SQUARE, with the SINE in
  // between. Any TWO-anchor morph (the old saw↔pulse law included) is
  // MONOTONE in this statistic and cannot produce that ordering — which is
  // what makes this a gate on the morph LAW, not merely on "the knob does
  // something".
  expect(tri.crest, `crest must peak at the TRIANGLE midpoint — ${ladder}`).toBeGreaterThan(sine.crest);
  expect(sine.crest, `and the SQUARE must sit below the SINE — ${ladder}`).toBeGreaterThan(square.crest);
  expect(square.dwell, `dwell runs the other way — ${ladder}`).toBeGreaterThan(sine.dwell);
  expect(sine.dwell, `dwell runs the other way — ${ladder}`).toBeGreaterThan(tri.dwell);
});
