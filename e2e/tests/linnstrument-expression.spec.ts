// ═════ PER-VOICE EXPRESSION AT THE JACK — AUDIBLE, PER VOICE, CABLE PULLED ═════
//
// The audible half of V15 ("observer control") and the 2026-09-15 review's
// F03 (owner ruling: "a build"). AGENTS.md rule 8: a poly/MIDI module ships an
// e2e wiring the REAL default-mode source through the module to an
// AUDIBLE-OUTPUT assertion — here, per VOICE, with the expression cable pulled
// as the control. Nothing in the chain is stubbed except the USB cable:
//
//   [simulated LinnStrument, User Firmware Mode bytes on the wire]
//     → connectLinnstrument() → decodePhysicalMidi → mapSurface → registry
//     → linnstrument runtime (mpe-state lane k = bus lane k = jack k)
//         ├─▶ keys_poly    → PENTEMELODICA.poly            (lane i → voice i, fixed)
//         │      PENTE.out_l → SCOPE-REF   — the known-active REFERENCE: the notes
//         │                                  sound whatever the expression jacks do
//         ├─▶ keys_press1  → VCA1.cv  ; PENTE.voice1 → VCA1 → SCOPE1   (level, voice 1)
//         ├─▶ keys_press2  → VCA2.cv  ; PENTE.voice2 → VCA2 → SCOPE2   (level, voice 2)
//         └─▶ keys_timbre1 → RESOFILTER.cutoff_cv ; PENTE.voice1 → RESOFILTER → SCOPE3
//                                                                      (spectrum, voice 1)
//
// WHAT IS ASSERTED, IN ORDER
//   (1) silence-first on all four scopes over FULL windows before any device;
//   (2) two keys held with NO pressure: the reference sounds, both VCAs stay
//       shut — a gated topology with the note sounding and the level jack at
//       rest (design.md "silence controls must keep the synth gated");
//   (3) squeeze A (poly pressure Z on the row channel) → VCA1 opens; VCA2 stays
//       shut over a full window — PER VOICE, not broadcast;
//   (4) squeeze B → VCA2 opens; release A's pressure to 0 → VCA1 closes while
//       A's lane still reads gate 1 (pressure 0 is not a Note Off);
//   (5) TIMBRE as a LEVEL-INVARIANT band ratio on voice 1: bandMax(3·fA) /
//       bandMax(fA) through a 200 Hz low-pass. B's Y at 127 leaves A's ratio in
//       its resting spread (per voice); A's Y at 127 lifts it clear of that
//       spread (CC74 → timbre +1 → cutoff 200 + 9990 Hz); Y back to 64 (rest)
//       drops it again;
//   (6) DISCONNECT — the rule-8 control. The pressure edge is deleted from the
//       live Y.Doc: squeezing A no longer opens VCA1 while the reference still
//       sounds and the lane still reads the pressure (the state half of V15 is
//       still true; only the modulation is gone). WRONG-LANE: keys_press2 wired
//       into VCA1 — A's pressure leaves it shut, B's opens it. The timbre edge
//       is deleted at rest: A's Y at 127 no longer lifts the ratio;
//   (7) PANIC closes both VCAs within the cap and empties the lanes.
//
// THRESHOLDS. VCA_FLOOR is the trails floor the sibling specs use. The timbre
// ratio thresholds are MEASURED on THIS chain (PENTEMELODICA square voice →
// RESOFILTER LP, resonance 0) — the CUBE-calibrated BAND_* constants of
// linnstrument.spec.ts do not transfer and are not used here; see
// TIMBRE_RISE below for the numbers.
//
// THE OBSERVATION IS A BOUNDED CONDITION (adsr-poly-midilane): every "does it
// sound?" leg observes UNTIL audible with a cap that bounds the failure; every
// silence leg watches a full window and samples TWICE, asserting on the second.
//
// ⚠ FILENAME: `linnstrument-expression.spec.ts` matches none of
// e2e/webgl-heavy-globs.ts, so it runs in the sharded `e2e` matrix. A name
// colliding with one of those prefixes would remove it from CI entirely.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import {
  AUDIBLE_CAP_MS,
  KEY_A,
  KEY_B,
  SILENCE_WINDOW_MS,
  VCA_FLOOR,
  bandMax,
  cellNote,
  dispatch,
  hz,
  installSim,
  keysLanes,
  linnState,
  settledSilence,
  sim,
  timeoutFor,
} from './_linnstrument-helpers';

test.describe.configure({ mode: 'parallel' });

/** The floor PENTEMELODICA's mixed output must clear at the reference scope. */
const REF_FLOOR = 0.01;
/** Full window for one band-ratio reading. */
const RATIO_WINDOW_MS = 400;
/** How far the 3·f/f ratio must rise above the resting spread's high edge
 *  when the timbre jack goes to +1. PREDICTED for a 2-pole LP at Q 0.5
 *  (|H| = 1/(1+(f/fc)²)) on a square voice: rest (fc 200 Hz, fA 329.6 Hz)
 *  ≈ 0.145·⅓ ≈ 0.05; open (fc 10 190 Hz) ≈ ⅓ — ~6.5×. MEASURED 2026-09-15
 *  (darwin, this chain): rest 0.0556–0.0561, under B's Y 0.0553, A's Y open
 *  0.335 (6.0×), cable pulled 0.057–0.082. 3× sits at 0.168 — 2× under the
 *  measured rise and 2× above the widest cable-pulled reading. */
const TIMBRE_RISE = 3;

/** Two consecutive full-window ratio readings: the spread the leg is measured
 *  against. Level-invariant — both bands see the same voice at the same
 *  amplitude, so the VCA legs cannot leak into this one. */
async function timbreRatio(page: Page, fA: number): Promise<number> {
  const third = await bandMax(page, 'scp3', 3 * fA, RATIO_WINDOW_MS);
  const fund = await bandMax(page, 'scp3', fA, RATIO_WINDOW_MS);
  expect(fund, `the fundamental (${fA.toFixed(1)} Hz) is present at the filter output`).toBeGreaterThan(0);
  return third / fund;
}
async function timbreSpread(page: Page, fA: number): Promise<{ lo: number; hi: number }> {
  const a = await timbreRatio(page, fA);
  const b = await timbreRatio(page, fA);
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** Full window, twice, assert on the second — for a scope that must STAY
 *  silent (it already is; this is the "the cable is gone" shape). */
async function staysSilent(page: Page, scopeId: string, what: string): Promise<void> {
  await readScopePeakOverWindow(page, scopeId, SILENCE_WINDOW_MS);
  const second = await readScopePeakOverWindow(page, scopeId, SILENCE_WINDOW_MS);
  expect(second.polls, 'the SCOPE was sampled across the second window').toBeGreaterThan(0);
  expect(second.rms, `${what} — ${describeScopeWindow(second)}`).toBeLessThan(VCA_FLOOR);
}
async function opens(page: Page, scopeId: string, what: string): Promise<void> {
  const r = await readScopePeakOverWindow(page, scopeId, AUDIBLE_CAP_MS, { untilRms: VCA_FLOOR, untilNonzeroSamples: 50 });
  expect(r.rms, `${what} — ${describeScopeWindow(r)}`).toBeGreaterThan(VCA_FLOOR);
  expect(r.nonzeroSamples, 'a structured signal, not a glitch').toBeGreaterThan(50);
}

/** Edit the live patch's edges through the same transaction door spawnPatch
 *  uses (backdraft-clocked-delay.spec.ts precedent). */
async function deleteEdge(page: Page, edgeId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> }; __ydoc: { transact: (fn: () => void) => void } };
    w.__ydoc.transact(() => {
      delete w.__patch.edges[id];
    });
  }, edgeId);
}
async function addEdge(page: Page, e: SpawnEdge): Promise<void> {
  await page.evaluate((e) => {
    const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> }; __ydoc: { transact: (fn: () => void) => void } };
    w.__ydoc.transact(() => {
      w.__patch.edges[e.id] = { id: e.id, source: e.from, target: e.to, sourceType: e.sourceType, targetType: e.targetType };
    });
  }, e);
}

async function buildExpressionChain(page: Page): Promise<void> {
  const vca = (id: string, y: number): SpawnNode => ({
    id,
    type: 'vca',
    position: { x: 700, y },
    domain: 'audio',
    // base 0 = CLOSED; cvAmount 1 = the CV IS the gain. Stated, not relied on.
    params: { base: 0, cvAmount: 1 },
  });
  const scope = (id: string, y: number): SpawnNode => ({ id, type: 'scope', position: { x: 1000, y }, domain: 'audio', params: { timeMs: 50 } });
  const nodes: SpawnNode[] = [
    { id: 'ln', type: 'linnstrument', position: { x: 60, y: 60 }, domain: 'audio' },
    // A fast shared envelope, full sustain, so a held key is a held tone; two
    // SQUARE voices so the 3rd harmonic the timbre leg measures is there.
    { id: 'pm', type: 'pentemelodica', position: { x: 400, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 1, release: 0.2, v1_wave: 1, v2_wave: 1 } },
    vca('vca1', 60),
    vca('vca2', 300),
    // A 200 Hz low-pass under E4: at rest the 3rd harmonic is buried; the
    // timbre CV (+1 → +9990 Hz, linear) opens it.
    { id: 'rf', type: 'resofilter', position: { x: 700, y: 540 }, domain: 'audio', params: { cutoff: 200, resonance: 0, mode: 0, mix: 1 } },
    scope('scp-ref', 60),
    scope('scp1', 300),
    scope('scp2', 540),
    scope('scp3', 780),
  ];
  const edges: SpawnEdge[] = [
    { id: 'e-poly', from: { nodeId: 'ln', portId: 'keys_poly' }, to: { nodeId: 'pm', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
    { id: 'e-ref', from: { nodeId: 'pm', portId: 'out_l' }, to: { nodeId: 'scp-ref', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-v1', from: { nodeId: 'pm', portId: 'voice1' }, to: { nodeId: 'vca1', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-v2', from: { nodeId: 'pm', portId: 'voice2' }, to: { nodeId: 'vca2', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-press-1', from: { nodeId: 'ln', portId: 'keys_press1' }, to: { nodeId: 'vca1', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
    { id: 'e-press-2', from: { nodeId: 'ln', portId: 'keys_press2' }, to: { nodeId: 'vca2', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
    { id: 'e-scp1', from: { nodeId: 'vca1', portId: 'audio' }, to: { nodeId: 'scp1', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-scp2', from: { nodeId: 'vca2', portId: 'audio' }, to: { nodeId: 'scp2', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-v1-rf', from: { nodeId: 'pm', portId: 'voice1' }, to: { nodeId: 'rf', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-timbre-1', from: { nodeId: 'ln', portId: 'keys_timbre1' }, to: { nodeId: 'rf', portId: 'cutoff_cv' }, sourceType: 'cv', targetType: 'cv' },
    { id: 'e-scp3', from: { nodeId: 'rf', portId: 'out_l' }, to: { nodeId: 'scp3', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
  ];
  await spawnPatch(page, nodes, edges);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="linnstrument"])')).toHaveCount(1);
}

test('@linnstrument per-voice pressure opens ITS voice\'s VCA and timbre opens ITS voice\'s filter, at the jacks, through the real simulated instrument — and pulling the cable stops it (V15 audible, F03)', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  test.setTimeout(timeoutFor(24));
  await buildExpressionChain(page);
  const noteA = cellNote(KEY_A.col, KEY_A.row);
  const noteB = cellNote(KEY_B.col, KEY_B.row);
  const fA = hz(noteA);
  const laneA = async () => (await keysLanes(page, 'ln')).find((l) => l.note === noteA);
  const laneB = async () => (await keysLanes(page, 'ln')).find((l) => l.note === noteB);

  // (1) NEGATIVE CONTROL, first and over FULL windows: no device, every jack at
  //     rest, both VCAs closed, the filter fed by a silent voice.
  for (const id of ['scp-ref', 'scp1', 'scp2', 'scp3']) {
    const before = await readScopePeakOverWindow(page, id, SILENCE_WINDOW_MS);
    expect(before.polls, `${id} was actually sampled`).toBeGreaterThan(0);
    expect(before.peak, `${id} must be silent before any device exists — ${describeScopeWindow(before)}`).toBeLessThan(REF_FLOOR);
  }

  // (2) The device through the real connect + bind path, the instrument's own
  //     mode echo, then TWO keys with NO pressure: the notes sound at the
  //     reference while both level jacks rest at 0 and both VCAs stay shut.
  expect(await installSim(page), 'simulated LinnStrument installed + attached (needs VITE_E2E_HOOKS)').toBe(true);
  await sim(page, 'ackUserMode', true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.userMode)).toBe(true);
  await sim(page, 'touch', KEY_A.col, KEY_A.row, { x: 1000 });
  await sim(page, 'touch', KEY_B.col, KEY_B.row, { x: 200 });
  const ref = await readScopePeakOverWindow(page, 'scp-ref', AUDIBLE_CAP_MS, { untilRms: REF_FLOOR, untilNonzeroSamples: 50 });
  expect(ref.rms, `two held keys sound at PENTEMELODICA's output — ${describeScopeWindow(ref)}`).toBeGreaterThan(REF_FLOOR);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys)).toBe(2);
  expect((await laneA())?.pressure, 'A rests at pressure 0').toBe(0);
  expect((await laneB())?.pressure, 'B rests at pressure 0').toBe(0);
  await staysSilent(page, 'scp1', 'voice 1 sounds but its level jack rests at 0: VCA1 shut');
  await staysSilent(page, 'scp2', 'voice 2 sounds but its level jack rests at 0: VCA2 shut');

  // (3) SQUEEZE A. Poly pressure on the row channel → lane 0 → keys_press1 →
  //     VCA1 opens. VCA2, on lane 1's jack, stays shut over a full window.
  await sim(page, 'move', KEY_A.col, KEY_A.row, { z: 100 });
  await opens(page, 'scp1', 'pressure on A opens VCA1 (keys_press1)');
  await expect.poll(async () => (await laneA())?.pressure ?? -1).toBeCloseTo(100 / 127, 2);
  await staysSilent(page, 'scp2', 'pressure on A leaves VCA2 shut (per voice, not broadcast)');
  expect((await laneB())?.pressure, 'B\'s lane is untouched').toBe(0);

  // (4) SQUEEZE B → VCA2 opens; LIFT A's pressure to 0 → VCA1 closes while
  //     A's note is still held (gate 1, pressure 0 ≠ Note Off).
  await sim(page, 'move', KEY_B.col, KEY_B.row, { z: 100 });
  await opens(page, 'scp2', 'pressure on B opens VCA2 (keys_press2)');
  await sim(page, 'move', KEY_A.col, KEY_A.row, { z: 0 });
  await settledSilence(page, 'scp1', VCA_FLOOR, 'A\'s pressure back to 0 closes VCA1');
  expect(await laneA(), 'A is still a held voice with no pressure').toMatchObject({ gate: 1, pressure: 0 });
  expect((await linnState(page, 'ln'))?.active.keys, 'nothing was released').toBe(2);

  // (5) TIMBRE, per voice, as a level-invariant band ratio at the filter.
  //     Resting spread first; B's Y must not move it; A's Y must.
  const rest = await timbreSpread(page, fA);
  await sim(page, 'move', KEY_B.col, KEY_B.row, { y: 127 });
  await expect.poll(async () => (await laneB())?.timbre ?? -1).toBeCloseTo(1, 2);
  const underB = await timbreSpread(page, fA);
  expect(underB.hi, `B's timbre at +1 leaves A's filter alone (rest ${rest.lo.toFixed(3)}..${rest.hi.toFixed(3)}, under B ${underB.lo.toFixed(3)}..${underB.hi.toFixed(3)})`).toBeLessThan(rest.hi * TIMBRE_RISE);
  await sim(page, 'move', KEY_A.col, KEY_A.row, { y: 127 });
  await expect.poll(async () => (await laneA())?.timbre ?? -1).toBeCloseTo(1, 2);
  let openRatio = 0;
  await expect
    .poll(async () => (openRatio = await timbreRatio(page, fA)), { timeout: AUDIBLE_CAP_MS, message: `A's timbre at +1 must lift the 3·f/f ratio clear of its resting spread (rest hi ${rest.hi.toFixed(3)})` })
    .toBeGreaterThan(rest.hi * TIMBRE_RISE);
  //     …and back to rest (CC 64 → timbre 0.5 → jack 0): it follows down too.
  await sim(page, 'move', KEY_A.col, KEY_A.row, { y: 64 });
  await expect
    .poll(() => timbreRatio(page, fA), { timeout: AUDIBLE_CAP_MS, message: 'A\'s timbre back at rest drops the ratio again' })
    .toBeLessThan(rest.hi * TIMBRE_RISE);

  // (6) DISCONNECT — the rule-8 control. Pull keys_press1 → VCA1.cv from the
  //     live document; squeezing A no longer opens VCA1, while the note still
  //     sounds at the reference and the lane still reads the pressure.
  await deleteEdge(page, 'e-press-1');
  await sim(page, 'move', KEY_A.col, KEY_A.row, { z: 0 });
  await sim(page, 'move', KEY_A.col, KEY_A.row, { z: 100 });
  await expect.poll(async () => (await laneA())?.pressure ?? -1, { message: 'the state half is still true: the lane reads the pressure' }).toBeCloseTo(100 / 127, 2);
  await staysSilent(page, 'scp1', 'with the pressure cable pulled, squeezing A no longer opens VCA1');
  const stillRef = await readScopePeakOverWindow(page, 'scp-ref', AUDIBLE_CAP_MS, { untilRms: REF_FLOOR });
  expect(stillRef.rms, `the note audio remains at the reference — ${describeScopeWindow(stillRef)}`).toBeGreaterThan(REF_FLOOR);
  //     WRONG-LANE: lane 1's pressure jack into VCA1. A's pressure leaves it
  //     shut; B's opens it — the jack is the voice, not "the pressure".
  await sim(page, 'move', KEY_B.col, KEY_B.row, { z: 0 });
  await settledSilence(page, 'scp2', VCA_FLOOR, 'B\'s pressure to 0 closes VCA2 before the cross-wire');
  await addEdge(page, { id: 'e-press-x', from: { nodeId: 'ln', portId: 'keys_press2' }, to: { nodeId: 'vca1', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' });
  await sim(page, 'move', KEY_A.col, KEY_A.row, { z: 127 });
  await staysSilent(page, 'scp1', 'keys_press2 into VCA1: A\'s pressure leaves it shut');
  await sim(page, 'move', KEY_B.col, KEY_B.row, { z: 127 });
  await opens(page, 'scp1', 'keys_press2 into VCA1: B\'s pressure opens it');
  //     TIMBRE: pull keys_timbre1 → cutoff_cv at rest; A's Y at 127 no longer
  //     lifts the ratio, while the lane reads timbre 1. Sample twice, assert on
  //     the second (the settledSilence shape): the audio-graph edge removal
  //     lags the Y.Doc delete, so the first window after it can still see the
  //     cutoff open for part of its span — that window is only waited out.
  await deleteEdge(page, 'e-timbre-1');
  await sim(page, 'move', KEY_A.col, KEY_A.row, { y: 127 });
  await expect.poll(async () => (await laneA())?.timbre ?? -1).toBeCloseTo(1, 2);
  await expect
    .poll(() => timbreRatio(page, fA), { timeout: AUDIBLE_CAP_MS, message: `with the timbre cable pulled, the ratio must settle below the rise threshold within the cap (rest hi ${rest.hi.toFixed(3)})` })
    .toBeLessThan(rest.hi * TIMBRE_RISE);
  const unpatched = await timbreRatio(page, fA);
  expect(unpatched, `with the timbre cable pulled, A's timbre at +1 no longer opens the filter — and STAYS shut over a full window (rest hi ${rest.hi.toFixed(3)}, unpatched ${unpatched.toFixed(3)}, patched open ${openRatio.toFixed(3)})`).toBeLessThan(rest.hi * TIMBRE_RISE);

  // (7) PANIC — the same reducer intent the ranked cell dispatches: every
  //     voice off, pressure cleared, both VCAs silent within the cap.
  await dispatch(page, 'ln', { kind: 'panic' });
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys), { message: 'PANIC ends every voice' }).toBe(0);
  expect(await keysLanes(page, 'ln'), 'no gated lane remains').toEqual([]);
  await settledSilence(page, 'scp1', VCA_FLOOR, 'PANIC (VCA1)');
  await settledSilence(page, 'scp2', VCA_FLOOR, 'PANIC (VCA2)');
  await settledSilence(page, 'scp-ref', REF_FLOOR, 'PANIC (reference)');
  console.log('LINN_EXPRESSION', JSON.stringify({ rest, underB, openRatio, unpatched, ref: ref.rms, stillRef: stillRef.rms }));
  for (const k of [KEY_A, KEY_B]) await sim(page, 'release', k.col, k.row);
  errorWatch.assertClean();
});
