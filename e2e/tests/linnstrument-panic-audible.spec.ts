// ═════════ PANIC vs A LATCHED ARP — AT THE REAL CUBE AUDIO OUTPUT ═════════
//
// The audible half of the 2026-09-15 review's F01 (contracts: R03 in
// packages/web/src/lib/midi/linnstrument-review-contracts.test.ts). The chain
// is the module's real default-mode source chain (AGENTS.md rule 8):
//
//   [simulated LinnStrument, User Firmware Mode bytes on the wire]
//     → connectLinnstrument() → decodePhysicalMidi → mapSurface → registry
//     → linnstrument runtime (arp, latch) → keys_poly → CUBE.poly → CUBE.L → SCOPE
//
// THE DEFECT IT PINS. With the keys arp ON and HOLD (latch) ON, one key is
// pressed and RELEASED: the arp keeps walking the latched pool with no voice
// alive. PANIC from the control column (the D17 recommendation's bottom cell)
// then reached `arp.cancel()`, which cleared the playing marker and the step
// clock but KEPT the latched pool; `panicMpe` had no live voice to end; and the
// next scheduler tick re-anchored the clock and played the note again. Three
// runs read a post-PANIC peak of 0.9998 / RMS 0.635 against a 0.01 floor.
//
// WHAT IS ASSERTED, IN ORDER
//   * NEGATIVE CONTROL first, over a full window: the patched chain is silent
//     before any device exists;
//   * POSITIVE CONTROL: the latched arp is audible after the finger has lifted
//     (`active.keys` 0, `arp.keys.running` true — the real latch precondition);
//   * PANIC: one full window absorbs CUBE's declared 0.2 s release tail and
//     the analyser ring, then a SECOND 1.2 s window — long enough for several
//     125 ms arp steps — must stay under the floor (sample twice, assert on
//     the second). The runtime snapshot is logged with the readings.
//
// ⚠ FILENAME: `linnstrument-panic-audible.spec.ts` matches none of
// e2e/webgl-heavy-globs.ts, so it runs in the sharded `e2e` matrix. A name
// colliding with one of those prefixes would remove it from CI entirely.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import { pollScopeBandAmp, sampleScopeRms } from '../_helpers/scope-poll';

test.describe.configure({ mode: 'parallel' });

/** The floor a gated CUBE voice must clear (adsr-poly-midilane's floor). */
const CUBE_FLOOR = 0.01;
/** The floor a closed VCA must stay under and an open one must clear (trails'). */
const VCA_FLOOR = 0.03;
/** Full window for every SILENCE assertion — no early exit. */
const SILENCE_WINDOW_MS = 600;
/** CAP that BOUNDS THE FAILURE of an audible leg; it is NOT the gate. */
const AUDIBLE_CAP_MS = 8_000;
/** Goertzel band magnitudes, MEASURED 2026-09-14 on CUBE's default tables over
 *  the scope's 2048-sample ring (darwin, this chain): a gated voice reads
 *  0.33–0.57 at its fundamental (one, two or three voices held), while a bin
 *  no voice is at reads ≤ 0.13 — that residue is rectangular-window leakage
 *  from a fundamental one to five bins away, not signal. PRESENT must clear
 *  the first; ABSENT must stay under the second; every present/absent pair is
 *  also asserted as a ratio against its own reading. */
const BAND_PRESENT = 0.2;
const BAND_ABSENT = 0.15;
/** Full window for a MUST-BE-ABSENT band measurement. */
const BAND_ABSENT_WINDOW_MS = 400;

function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 12_000;
}

// ── THE KEYBOARD, AS THE PROFILE MAPS IT ──────────────────────────────────
// keys region = app cols 0..15 × rows 0..7, note = root + col + 5·row with the
// def's `keys_root` default 36 (D09 +1/+5, keyboardCellToMidi). Wire column is
// app col + 1 and the note channel is the row — the sim spells those bytes.
const KEYS_ROOT = 36;
const cellNote = (col: number, row: number): number => KEYS_ROOT + col + row * 5;
const KEY_A = { col: 8, row: 4 }; // 64 — E4
const KEY_B = { col: 0, row: 7 }; // 71 — B4
const KEY_C = { col: 6, row: 5 }; // 67 — G4
/** Two DIFFERENT cells that map to ONE pitch (41): the V13 refcount pair. */
const DUP_1 = { col: 5, row: 0 };
const DUP_2 = { col: 0, row: 1 };
/** The control column is app col 16; PANIC is its bottom row (profile
 *  `controlRows.panic` = 0, the D17 recommendation, `extra_controls` ON). */
const CONTROL_COL = 16;
const PANIC_ROW = 0;
/** The pad is app cols 17..24; this is its right-hand column, mid-height. */
const PAD_CELL = { col: 24, row: 4 };
/** Raw X (0..16383) the sim sends for the pad finger — inside the pad's
 *  raw-X span under the profile's whole-device prior [0, 4265] (25 columns →
 *  the pad spans 2900..4265), so `u` lands near the right edge. */
const PAD_RAW_X = 4200;
/** Raw-X units per semitone column under the same prior: 4265 / 25. */
const SEMITONE_RAW = 4265 / 25;
/** CUBE's fundamental is C4 = 261.626 Hz at 0 V (packages/dsp/src/cube.ts
 *  `C4_HZ`), and the bus carries (note − 60 + bend) / 12 V. */
const hz = (midi: number): number => 261.626 * Math.pow(2, (midi - 60) / 12);

/** NRPN 245 = User Firmware Mode ON: MSB 1, LSB 117, data 1. The bytes the
 *  REAL bind path must have written to the instrument's output. */
const USER_MODE_ON: number[][] = [
  [0xb0, 99, 1],
  [0xb0, 98, 117],
  [0xb0, 6, 0],
  [0xb0, 38, 1],
  [0xb0, 101, 127],
  [0xb0, 100, 127],
];
/** NRPN 299 = 245: the bind's "what mode are you in?" read — the firmware
 *  answers it whether or not the entry changed anything (an instrument that
 *  was ALREADY in User Mode echoes nothing on the entry itself). */
const USER_MODE_READ: number[][] = [
  [0xb0, 99, 2],
  [0xb0, 98, 43],
  [0xb0, 6, 1],
  [0xb0, 38, 117],
  [0xb0, 101, 127],
  [0xb0, 100, 127],
];
function containsRun(writes: number[][], seq: number[][]): boolean {
  for (let i = 0; i + seq.length <= writes.length; i++) {
    if (seq.every((m, j) => writes[i + j]?.length === m.length && m.every((b, k) => writes[i + j]?.[k] === b))) return true;
  }
  return false;
}

interface LinnSim {
  touch(col: number, row: number, o?: { velocity?: number; x?: number; y?: number; z?: number }): void;
  move(col: number, row: number, o: { x?: number; y?: number; z?: number }): void;
  release(col: number, row: number, velocity?: number): void;
  bind(): boolean;
  attached(): boolean;
  writes(): number[][];
  /** The simulated instrument's NRPN 245 mode notification — the only thing that confirms User Mode. */
  ackUserMode(on?: boolean): void;
  status(): { kind: string; portNames: string[]; boundPortName: string | null; userMode: boolean };
}
interface LinnSnapshot {
  session: { state: string; epoch: number; userMode: boolean };
  selection: { mask: Record<'r' | 'g' | 'b', boolean>; pairs: Record<'r' | 'g' | 'b', { x: number; y: number }> };
  active: { keys: number; pad: number };
  arp: { keys: { enabled: boolean; running: boolean; params: { latch: boolean }; held: number[]; effective: number[]; playing: number | null } };
}
interface Lane {
  lane: number;
  voice: number | null;
  note: number | null;
  gate: 0 | 1;
  pressure: number;
  timbre: number;
  bend: number;
  pitchCv: number;
}

/** Install the in-memory LinnStrument through the app's own seam. Returns the
 *  ATTACHED state (false for `{ bind: false }`), or null when the hook is
 *  absent (a preview build without VITE_E2E_HOOKS) — asserted, never skipped. */
async function installSim(page: Page, opts: { bind?: boolean } = {}): Promise<boolean | null> {
  return page.evaluate(async (o) => {
    const w = globalThis as unknown as { __linnstrumentTestInstall?: (o: { bind?: boolean }) => Promise<boolean> };
    if (!w.__linnstrumentTestInstall) return null;
    return await w.__linnstrumentTestInstall(o);
  }, opts);
}

/** Call one driver method in the page. */
async function sim<K extends keyof LinnSim>(page: Page, method: K, ...args: Parameters<LinnSim[K]>): Promise<ReturnType<LinnSim[K]>> {
  return page.evaluate(
    ({ method, args }) => {
      const w = globalThis as unknown as { __linnstrumentSim?: Record<string, (...a: unknown[]) => unknown> };
      if (!w.__linnstrumentSim) throw new Error('__linnstrumentSim missing — install the simulated LinnStrument first');
      return w.__linnstrumentSim[method]!(...args) as never;
    },
    { method, args: args as unknown[] },
  );
}

/** The module's live runtime snapshot — `read(node, 'state')`. */
async function linnState(page: Page, nodeId: string): Promise<LinnSnapshot | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    return (eng.read(node, 'state') as LinnSnapshot | undefined) ?? null;
  }, nodeId);
}

/** The per-lane expression the runtime keeps aligned to the bus (V15's state half). */
async function keysLanes(page: Page, nodeId: string): Promise<Lane[]> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return [];
    const api = eng.read(node, 'card-api') as { expression: (r: 'keys') => Lane[] } | undefined;
    return api ? api.expression('keys').filter((l) => l.gate === 1) : [];
  }, nodeId);
}

/** A reducer intent through the SAME door the ranked cells use. */
async function dispatch(page: Page, nodeId: string, intent: { kind: 'center' | 'panic' }): Promise<void> {
  await page.evaluate(
    ({ id, intent }) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      const api = eng && node ? (eng.read(node, 'card-api') as { dispatch: (i: unknown) => void } | undefined) : undefined;
      if (!api) throw new Error('linnstrument card-api not reachable');
      api.dispatch(intent);
    },
    { id: nodeId, intent },
  );
}

/** The MAX Goertzel magnitude at `freq` over a FULL window (the threshold is
 *  unreachable, so the poller never exits early) — for a band that must be
 *  ABSENT, or that must merely still be present. */
async function bandMax(page: Page, scopeId: string, freq: number, windowMs: number): Promise<number> {
  const r = await pollScopeBandAmp(page, scopeId, freq, Number.POSITIVE_INFINITY, windowMs);
  expect(r.samples, `the SCOPE was sampled for the ${freq.toFixed(0)} Hz band`).toBeGreaterThan(0);
  return r.best;
}

/** Sample twice, assert on the second: a frozen buffer cannot read as silence
 *  that "arrived" — the first window absorbs the release tail and the analyser
 *  ring, the second is what is asserted. */
async function settledSilence(page: Page, scopeId: string, floor: number, what: string): Promise<void> {
  await expect
    .poll(async () => (await sampleScopeRms(page, scopeId, 10, 20)).hi, {
      timeout: AUDIBLE_CAP_MS,
      message: `${what} — the output must reach silence within the cap`,
    })
    .toBeLessThan(floor);
  const second = await sampleScopeRms(page, scopeId, 20, 20);
  expect(second.samples, 'the SCOPE was sampled across the second silence window').toBeGreaterThan(0);
  expect(second.hi, `${what} — and STAY silent (hi=${second.hi.toFixed(4)} over ${second.samples} samples)`).toBeLessThan(floor);
}

// ── THE KEYS CHAIN: linnstrument.keys_poly → CUBE.poly → SCOPE ────────────
async function buildKeysChain(page: Page, linnParams: Record<string, number> = {}): Promise<void> {
  const nodes: SpawnNode[] = [
    { id: 'ln', type: 'linnstrument', position: { x: 60, y: 60 }, domain: 'audio', params: linnParams },
    // The adsr-poly-midilane CUBE: a fast per-voice envelope, high sustain, so a
    // held key is a held tone and a released key decays in 0.2 s.
    { id: 'cb', type: 'cube', position: { x: 420, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2, level: 1 } },
    { id: 'scp', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e-poly', from: { nodeId: 'ln', portId: 'keys_poly' }, to: { nodeId: 'cb', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
    { id: 'e-out', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
  ];
  await spawnPatch(page, nodes, edges);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="linnstrument"])')).toHaveCount(1);
}

test('@linnstrument PANIC stops a released, latched arp note at the real CUBE audio output', async ({ page, rack, errorWatch }) => {
  void rack;
  test.setTimeout(timeoutFor(6));
  await buildKeysChain(page, { keys_arp_on: 1, keys_arp_latch: 1, keys_arp_div: 1 });
  // NEGATIVE CONTROL, full window: nothing exists yet, the chain is silent.
  const empty = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(empty.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(empty.peak, describeScopeWindow(empty)).toBeLessThan(CUBE_FLOOR);
  expect(await installSim(page)).toBe(true);
  await sim(page, 'ackUserMode', true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.userMode)).toBe(true);
  // POSITIVE CONTROL: press, and the latched arp is audible AFTER the release —
  // no live voice, the arp running on a frozen pool (the real latch precondition).
  await sim(page, 'touch', KEY_A.col, KEY_A.row, { x: 500 });
  const positive = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, { untilRms: CUBE_FLOOR, untilNonzeroSamples: 50 });
  expect(positive.rms, describeScopeWindow(positive)).toBeGreaterThan(CUBE_FLOOR);
  await sim(page, 'release', KEY_A.col, KEY_A.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys)).toBe(0);
  expect((await linnState(page, 'ln'))?.arp.keys, 'released, latched, still walking').toMatchObject({ running: true, params: { latch: true }, held: [], effective: [cellNote(KEY_A.col, KEY_A.row)] });
  const stillPlaying = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, { untilRms: CUBE_FLOOR, untilNonzeroSamples: 50 });
  expect(stillPlaying.rms, `the latched note sounds with no finger down — ${describeScopeWindow(stillPlaying)}`).toBeGreaterThan(CUBE_FLOOR);

  // PANIC from the control column: the wire → control_edge → the reducer's
  // panic effect → the runtime. The STATE half first: the arp has forgotten
  // its pool, so no later tick has anything to play (F01's mechanism).
  await sim(page, 'touch', CONTROL_COL, PANIC_ROW);
  await sim(page, 'release', CONTROL_COL, PANIC_ROW);
  const afterPanic = await linnState(page, 'ln');
  expect(afterPanic?.arp.keys, 'PANIC forgets the latched pool').toMatchObject({ running: false, held: [], effective: [], playing: null });
  expect(afterPanic?.active.keys).toBe(0);

  // THE AUDIBLE HALF — a bounded condition, then a full window (the sibling
  // spec's settledSilence shape). CUBE's gate closes NOW but its per-voice
  // envelope rings out: the release is an exponential TIME CONSTANT
  // (adsr-env.ts `value *= exp(-1 / (sr * release))`), so 0.2 s reaches the
  // 0.01 floor only after ~4.5τ ≈ 0.9 s plus the analyser ring — measured
  // here as 0.61 → 0.16 → 0.018 → 0.0006 over consecutive 200 ms polls, and
  // ~0.06 peak still standing a full 600 ms window after PANIC. A fixed
  // absorption window therefore cannot tell a tail from a restart; this can:
  // a restarted arp NEVER reaches the floor and fails at the cap, a stuck gate
  // (sustain 0.9) never reaches it either, only a closing gate does. Then the
  // SECOND window — 1.2 s, nearly ten 125 ms arp steps — must stay under the
  // floor (sample twice, assert on the second).
  const settling: number[] = [];
  await expect
    .poll(
      async () => {
        const hi = (await sampleScopeRms(page, 'scp', 10, 20)).hi;
        settling.push(hi);
        return hi;
      },
      { timeout: AUDIBLE_CAP_MS, message: 'PANIC — the output must reach silence within the cap (a restarted arp never does)' },
    )
    .toBeLessThan(CUBE_FLOOR);
  const after = await readScopePeakOverWindow(page, 'scp', 1200);
  console.log('PANIC_AUDIO', JSON.stringify({ empty, positive, stillPlaying, settling: settling.map((v) => +v.toFixed(4)), after, state: await linnState(page, 'ln') }));
  expect(after.polls, 'the SCOPE was sampled across the whole post-PANIC window').toBeGreaterThan(0);
  expect(after.peak, `PANIC must STAY silent through further arp ticks: ${describeScopeWindow(after)}`).toBeLessThan(CUBE_FLOOR);
  expect((await linnState(page, 'ln'))?.arp.keys, 'and the arp is still stopped at the end of the window').toMatchObject({ running: false, effective: [] });
  errorWatch.assertClean();
});
