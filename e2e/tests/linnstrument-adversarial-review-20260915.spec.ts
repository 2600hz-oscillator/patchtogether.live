// ═════════ THE REAL-SOURCE-CHAIN GATE FOR THE LINNSTRUMENT MODULE ═════════
//
// AGENTS.md rule 8: a poly or MIDI module ships an e2e wiring the REAL
// default-mode source through the module to an AUDIBLE-OUTPUT assertion.
// Driving the engine class directly, or asserting only that an edge
// materialised, has shipped modules that were green and silent.
//
// Nothing in these chains is stubbed except the USB cable:
//
//   [simulated LinnStrument, User Firmware Mode bytes on the wire]
//     → linnstrument.keys_poly → CUBE.poly ; CUBE.L → SCOPE.ch1        (keys, arp)
//     → linnstrument.r_x → VCA.cv ; analogVco.sine → VCA.audio → SCOPE (pad)
//
// `__linnstrumentTestInstall` (Canvas.svelte) installs an in-memory MIDIAccess
// whose input/output pair is NAMED like the instrument and runs the REAL
// `connectLinnstrument()` against it: the /linnstrument/i port match, the
// shared `createMidiInputClaim` handler slot, the NRPN 245 User-Mode entry on
// the OUTPUT, `decodePhysicalMidi` → `mapSurface`, the source-registry fan-out,
// the runtime's selection reducer and MPE voice allocator, and the LED writer
// all execute. Every driver call spells the real bytes (Note On per cell on the
// ROW channel, CC X lo/hi pairs, CC Y, poly pressure Z) from the same constant
// table the decoder reads.
//
// ── WHAT IS ASSERTED, PER ACCEPTANCE VECTOR ─────────────────────────────────
//   V01/V14  the +1 wire column and the epoch gate are on the real path (the
//            unbound-device control: a touch on an unbound port is not a voice).
//   V05      the retained pair survives save → fresh page → load, asserted AT
//            THE JACK (audio through the VCA after load), not as node presence
//            — the samsloop-load-audible precedent.
//   V06      a horizontal X move on a held key is a REAL pitch movement on the
//            lane: a new band appears at the bent frequency.
//   V12      the keys arp SEQUENCES a held chord: two distinct pitches sound
//            over time on the bus, at a real voice output.
//   V13      two touches on one pitch are refcounted: releasing one keeps the
//            note in the arp's held set; releasing both drops it.
//   D13      two keys at two pitches → two frequencies at the output at once
//            (poly identity: two contacts are two voices — decision-register
//            D13; the package's vector corpus has no V-number for this).
//   V16      "stopped source": silence-first over a FULL window with no Note
//            On while a known positive reference later reads nonzero — the
//            silence-first + audible-key pair below IS that vector.
//   V15      "observer control": pressure (Z) and timbre (Y) reach the voice's
//            expression LANE. ⚠ STATE HALF ONLY. The vector's audible claim
//            (unpatch the pressure path → level modulation disappears) needs
//            an expression jack, and none ships: D14 (`polyCv`) is a
//            graph-wide change the owner has not ruled on, so the two poly
//            buses carry PITCH + GATE only and per-lane pressure / timbre are
//            read through `read(node, 'card-api').expression(region)`. V15's
//            audible half stays DEFERRED (vectors.ts records the WP-D
//            deferral; it is not resolved here) and is deliberately not faked
//            by patching a scalar somewhere else.
//   MODE     `userMode` on the status and the session is the instrument's OWN
//            NRPN 245 readback: false after the bind's write, true only once
//            the (simulated) instrument echoes the notification.
//   PANIC    the control-column PANIC cell (D17 recommendation, `extra_controls`
//            default ON) closes every voice on the bus within the cap.
//
// ── NEGATIVE CONTROLS, PERMANENT ────────────────────────────────────────────
//   * silence-first over a FULL window before any device exists;
//   * a device that is GRANTED but UNBOUND: a touch reaches no voice, no audio;
//   * the unselected G pair holds 0 at its own jack while the finger moves R;
//   * a band that must be ABSENT is measured over a full window before the key
//     that would produce it lands;
//   * every silence assertion samples TWICE and asserts on the SECOND window,
//     so a frozen analyser buffer cannot read as liveness.
//
// ── THE OBSERVATION IS A BOUNDED CONDITION ──────────────────────────────────
// Every "does it sound?" leg observes UNTIL audible with a cap that BOUNDS THE
// FAILURE (the adsr-poly-midilane argument: a gated voice cannot sound until
// the main-thread scheduler ticks, and how many ticks fit in a wall-clock
// window is a property of the runner). Silence legs watch the whole window.
// Test timeouts scale with the number of capture windows, never a flat value.
//
// ⚠ FILENAME: `linnstrument.spec.ts` matches none of WEBGL_HEAVY_GLOBS, so it
// runs in the sharded `e2e` matrix job. A name colliding with one of those
// prefixes would remove it from CI entirely and look like ordinary bookkeeping.

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
  arp: { keys: { enabled: boolean; running: boolean; held: number[]; playing: number | null } };
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

test('@adversarial-linn PANIC stops a released latched note at the real CUBE audio output', async ({ page, rack, errorWatch }) => {
  void rack;
  test.setTimeout(timeoutFor(6));
  await buildKeysChain(page, { keys_arp_on: 1, keys_arp_latch: 1, keys_arp_div: 1 });
  const empty = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(empty.peak, describeScopeWindow(empty)).toBeLessThan(CUBE_FLOOR);
  expect(await installSim(page)).toBe(true);
  await sim(page, 'ackUserMode', true);
  await sim(page, 'touch', KEY_A.col, KEY_A.row, { x: 500 });
  const positive = await readScopePeakOverWindow(page, 'scp', 1500, { untilRms: CUBE_FLOOR, untilNonzeroSamples: 50 });
  expect(positive.rms, describeScopeWindow(positive)).toBeGreaterThan(CUBE_FLOOR);
  await sim(page, 'release', KEY_A.col, KEY_A.row);
  expect((await linnState(page, 'ln'))?.active.keys).toBe(0);
  expect((await linnState(page, 'ln'))?.arp.keys.running).toBe(true);
  await sim(page, 'touch', CONTROL_COL, PANIC_ROW);
  await sim(page, 'release', CONTROL_COL, PANIC_ROW);
  // One full observation absorbs the declared 0.2 s release tail and old ring.
  await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  const after = await readScopePeakOverWindow(page, 'scp', 1200);
  console.log('ADVERSARIAL_AUDIO', JSON.stringify({ empty, positive, after, state: await linnState(page, 'ln') }));
  expect(after.polls).toBeGreaterThan(0);
  expect(after.peak, `PANIC must stay silent through further arp ticks: ${describeScopeWindow(after)}`).toBeLessThan(CUBE_FLOOR);
  errorWatch.assertClean();
});
