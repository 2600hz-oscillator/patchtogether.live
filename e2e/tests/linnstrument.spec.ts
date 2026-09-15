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

test('@linnstrument keys → CUBE poly → audible: silence-first, an UNBOUND device is silent, two keys are two pitches, X bends the lane, Z/Y reach the lane, release → silence', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  test.setTimeout(timeoutFor(11));
  await buildKeysChain(page);

  // (1) NEGATIVE CONTROL, first and over a FULL window: no device exists, both
  //     buses are all-gates-low, CUBE's poly gating makes an un-gated lane
  //     EXACTLY 0. If this half is not silent, nothing below proves anything.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(before.peak, `a patched-but-untouched KEYS bus must be silent — ${describeScopeWindow(before)}`).toBeLessThan(CUBE_FLOOR);

  // (2) A GRANTED BUT UNBOUND device. The access is held, the port is listed,
  //     and NOTHING is attached — so a touch has no handler to reach. This is
  //     the control that separates "the module heard the wire" from "the
  //     module heard a global".
  const unboundInstall = await installSim(page, { bind: false });
  expect(unboundInstall, 'the install hook is present (VITE_E2E_HOOKS) and, unbound, attaches nothing').toBe(false);
  const unboundStatus = await sim(page, 'status');
  expect(unboundStatus.kind, 'granted, port present, not bound').toBe('unbound');
  expect(unboundStatus.portNames).toEqual(['LinnStrument MIDI']);
  await sim(page, 'touch', KEY_A.col, KEY_A.row, { x: 1000 });
  const unbound = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(unbound.peak, `a touch on an UNBOUND port must not sound — ${describeScopeWindow(unbound)}`).toBeLessThan(CUBE_FLOOR);
  expect((await linnState(page, 'ln'))?.active.keys, 'and allocates no voice').toBe(0);
  await sim(page, 'release', KEY_A.col, KEY_A.row);

  // (3) BIND through the real path: the claim attaches, User Firmware Mode
  //     entry (NRPN 245) leaves on the OUTPUT, the session becomes connected.
  expect(await sim(page, 'bind'), 'bindLinnstrument() resolves the sim port').toBe(true);
  expect(await sim(page, 'attached'), 'the input claim holds the handler').toBe(true);
  expect(containsRun(await sim(page, 'writes'), USER_MODE_ON), 'NRPN 245 = 1 was written to the instrument').toBe(true);
  expect(containsRun(await sim(page, 'writes'), USER_MODE_READ), 'and the mode was READ back (NRPN 299 = 245) so an already-in-User-Mode instrument still answers').toBe(true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.state), { message: 'the runtime sees the session' }).toBe('connected');
  //     The write proves nothing about the instrument: the mode is REQUESTED
  //     until its own NRPN 245 notification comes back (design.md:188).
  expect((await sim(page, 'status')).userMode, 'userMode is not inferred from our write').toBe(false);
  expect((await linnState(page, 'ln'))?.session.userMode, 'nor is the session\'s').toBe(false);
  //     The sim's echo rides channel 9, exactly as the firmware's does.
  await sim(page, 'ackUserMode', true);
  expect((await sim(page, 'status')).userMode, 'the readback confirms User Firmware Mode').toBe(true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.userMode), { message: 'the runtime sees the confirmation' }).toBe(true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.state)).toBe('mode_changed');

  // (4) THE AUDIBLE ASSERTION. One key — real Note On + a CC X lo/hi pair on
  //     the row channel — is a voice on the bus, and CUBE gates it open.
  await sim(page, 'touch', KEY_A.col, KEY_A.row, { x: 1000 });
  const flowing = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, { untilPeak: CUBE_FLOOR });
  expect(flowing.polls, 'the SCOPE was sampled across the audible window').toBeGreaterThan(0);
  expect(flowing.peak, `a held key must sound at CUBE's output — ${describeScopeWindow(flowing)}`).toBeGreaterThan(CUBE_FLOOR);
  const lanesA = await keysLanes(page, 'ln');
  expect(lanesA.map((l) => l.note), 'one gated lane, at the cell\'s note').toEqual([cellNote(KEY_A.col, KEY_A.row)]);

  // (5) D13 — TWO PITCHES, TWO VOICES. The first key's fundamental is present; the second
  //     key's is ABSENT over a full window BEFORE it lands (the band's own
  //     negative control), then present once it does — while the first stays.
  const fA = hz(cellNote(KEY_A.col, KEY_A.row));
  const fB = hz(cellNote(KEY_B.col, KEY_B.row));
  const bandA = await pollScopeBandAmp(page, 'scp', fA, BAND_PRESENT, AUDIBLE_CAP_MS);
  expect(bandA.best, `KEY_A's fundamental (${fA.toFixed(1)} Hz) is at the output (samples=${bandA.samples})`).toBeGreaterThan(BAND_PRESENT);
  const bAbsent = await bandMax(page, 'scp', fB, BAND_ABSENT_WINDOW_MS);
  expect(bAbsent, `KEY_B's fundamental (${fB.toFixed(1)} Hz) is ABSENT before KEY_B lands`).toBeLessThan(BAND_ABSENT);
  await sim(page, 'touch', KEY_B.col, KEY_B.row, { x: 200 });
  const bandB = await pollScopeBandAmp(page, 'scp', fB, BAND_PRESENT, AUDIBLE_CAP_MS);
  expect(bandB.best, `KEY_B's fundamental (${fB.toFixed(1)} Hz) appears (samples=${bandB.samples})`).toBeGreaterThan(BAND_PRESENT);
  expect(bandB.best, 'and it ROSE against its own absent reading').toBeGreaterThan(bAbsent * 2);
  expect(await bandMax(page, 'scp', fA, BAND_ABSENT_WINDOW_MS), 'KEY_A still sounds under KEY_B — two voices, not a steal').toBeGreaterThan(BAND_PRESENT);
  expect((await keysLanes(page, 'ln')).map((l) => l.note).sort(), 'two gated lanes at two notes').toEqual(
    [cellNote(KEY_A.col, KEY_A.row), cellNote(KEY_B.col, KEY_B.row)].sort(),
  );

  // (6) V15 — Z and Y reach the lane (the STATE half; the audible half is
  //     D14-blocked and stays deferred, see the header). Z is poly pressure on
  //     the row channel, Y is CC (col+64).
  await sim(page, 'move', KEY_A.col, KEY_A.row, { z: 100, y: 120 });
  await expect
    .poll(async () => (await keysLanes(page, 'ln')).find((l) => l.note === cellNote(KEY_A.col, KEY_A.row))?.pressure ?? -1, {
      message: 'Z 100 lands on KEY_A\'s lane as pressure 100/127',
    })
    .toBeCloseTo(100 / 127, 2);
  expect((await keysLanes(page, 'ln')).find((l) => l.note === cellNote(KEY_A.col, KEY_A.row))?.timbre, 'Y 120 lands as timbre 120/127').toBeCloseTo(120 / 127, 2);
  expect((await keysLanes(page, 'ln')).find((l) => l.note === cellNote(KEY_B.col, KEY_B.row))?.pressure, 'KEY_B\'s lane is untouched (per-voice, not broadcast)').toBe(0);

  // (7) RELEASE IS PER VOICE: KEY_B lifts, its band decays within the cap
  //     while KEY_A keeps sounding — a Note Off on the wire ends ONE lane.
  await sim(page, 'release', KEY_B.col, KEY_B.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys), { message: 'one voice ends' }).toBe(1);
  await expect
    .poll(() => bandMax(page, 'scp', fB, BAND_ABSENT_WINDOW_MS), { timeout: AUDIBLE_CAP_MS, message: `KEY_B's fundamental (${fB.toFixed(1)} Hz) decays after its Note Off` })
    .toBeLessThan(BAND_ABSENT);
  expect(await bandMax(page, 'scp', fA, BAND_ABSENT_WINDOW_MS), 'KEY_A still sounds alone').toBeGreaterThan(BAND_PRESENT);

  // (8) V06 — X IS PITCH ON THE LANE, audibly. +5 semitones of raw X from the
  //     touch's initial X bends KEY_A up a fourth: a new band appears at the
  //     bent frequency (not a harmonic of the held note, and far enough from it
  //     that Goertzel leakage over the 2048-sample ring cannot fake it) and the
  //     lane's pitch CV moved by 5/12 V.
  const bent = cellNote(KEY_A.col, KEY_A.row) + 5;
  const fBent = hz(bent);
  const bentAbsent = await bandMax(page, 'scp', fBent, BAND_ABSENT_WINDOW_MS);
  expect(bentAbsent, `${fBent.toFixed(1)} Hz is ABSENT before the bend`).toBeLessThan(BAND_ABSENT);
  await sim(page, 'move', KEY_A.col, KEY_A.row, { x: 1000 + 5 * SEMITONE_RAW });
  const bandBent = await pollScopeBandAmp(page, 'scp', fBent, BAND_PRESENT, AUDIBLE_CAP_MS);
  expect(bandBent.best, `the bent fundamental (${fBent.toFixed(1)} Hz) appears (samples=${bandBent.samples})`).toBeGreaterThan(BAND_PRESENT);
  expect(bandBent.best, 'and it ROSE against its own absent reading').toBeGreaterThan(bentAbsent * 2);
  expect(await bandMax(page, 'scp', fA, BAND_ABSENT_WINDOW_MS), `the un-bent fundamental (${fA.toFixed(1)} Hz) MOVED AWAY — a bend, not a second voice`).toBeLessThan(BAND_ABSENT);
  const laneBent = (await keysLanes(page, 'ln')).find((l) => l.note === cellNote(KEY_A.col, KEY_A.row));
  expect(laneBent?.bend, 'the lane carries +5 semitones of bend').toBeCloseTo(5, 1);
  expect(laneBent?.pitchCv, 'pitch CV = (note − 60 + bend) / 12').toBeCloseTo((bent - 60) / 12, 2);

  // (9) RELEASE → SILENCE. The last Note Off on the wire; CUBE's 0.2 s release
  //     decays; sampled twice, asserted on the second window.
  await sim(page, 'release', KEY_A.col, KEY_A.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys), { message: 'the last voice ends' }).toBe(0);
  await settledSilence(page, 'scp', CUBE_FLOOR, 'releasing every key');

  errorWatch.assertClean();
});

// ── THE PAD CHAIN: a pad finger → r_x → VCA ; g_x → a second VCA ──────────
//
// Two VCAs on two scopes so the SELECTION is asserted at the jacks: the R
// pair follows the finger (R is selected by default, D08) while the G pair,
// unselected, holds (0, 0) — its VCA stays shut in the same run.
async function buildPadChain(page: Page): Promise<void> {
  const vca = (id: string, x: number): SpawnNode => ({
    id,
    type: 'vca',
    position: { x, y: 60 },
    domain: 'audio',
    // base 0 = CLOSED; cvAmount 1 = the CV IS the gain. Stated, not relied on.
    params: { base: 0, cvAmount: 1 },
  });
  const nodes: SpawnNode[] = [
    { id: 'ln', type: 'linnstrument', position: { x: 60, y: 60 }, domain: 'audio' },
    { id: 'vco', type: 'analogVco', position: { x: 60, y: 420 }, domain: 'audio' },
    vca('vca-r', 420),
    vca('vca-g', 420),
    { id: 'scp-r', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
    { id: 'scp-g', type: 'scope', position: { x: 900, y: 420 }, domain: 'audio', params: { timeMs: 200 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e-osc-r', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca-r', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-osc-g', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca-g', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-cv-r', from: { nodeId: 'ln', portId: 'r_x' }, to: { nodeId: 'vca-r', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
    { id: 'e-cv-g', from: { nodeId: 'ln', portId: 'g_x' }, to: { nodeId: 'vca-g', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
    { id: 'e-scp-r', from: { nodeId: 'vca-r', portId: 'audio' }, to: { nodeId: 'scp-r', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'e-scp-g', from: { nodeId: 'vca-g', portId: 'audio' }, to: { nodeId: 'scp-g', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
  ];
  await spawnPatch(page, nodes, edges);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="linnstrument"])')).toHaveCount(1);
}

test('@linnstrument a pad finger opens a real VCA on R X while G X holds shut; the pair is RETAINED on release, survives save → reload AT THE JACK (V05), and CENTER closes it', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  test.setTimeout(timeoutFor(9));
  await buildPadChain(page);

  // (1) NEGATIVE CONTROL: every pair rests at (0, 0), both VCAs are closed.
  const beforeR = await readScopePeakOverWindow(page, 'scp-r', SILENCE_WINDOW_MS);
  expect(beforeR.polls).toBeGreaterThan(0);
  expect(beforeR.rms, `R X at rest must keep its VCA closed — ${describeScopeWindow(beforeR)}`).toBeLessThan(VCA_FLOOR);
  const beforeG = await readScopePeakOverWindow(page, 'scp-g', SILENCE_WINDOW_MS);
  expect(beforeG.rms, `G X at rest must keep its VCA closed — ${describeScopeWindow(beforeG)}`).toBeLessThan(VCA_FLOOR);

  // (2) The device, through the real connect + bind path.
  expect(await installSim(page), 'simulated LinnStrument installed + attached (needs VITE_E2E_HOOKS)').toBe(true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.state)).toBe('connected');
  const mask = (await linnState(page, 'ln'))?.selection.mask;
  expect(mask, 'D08 recommendation hydrated: R selected, G and B not').toEqual({ r: true, g: false, b: false });

  // (3) A finger lands on the pad's right column with a real CC X pair. The
  //     reducer maps u ≈ 0.95 → R X ≈ +0.9, which is now the R VCA's gain.
  await sim(page, 'touch', PAD_CELL.col, PAD_CELL.row, { x: PAD_RAW_X });
  const flowing = await readScopePeakOverWindow(page, 'scp-r', AUDIBLE_CAP_MS, { untilPeak: VCA_FLOOR });
  expect(flowing.peak, `a pad touch on R X must open the R VCA — ${describeScopeWindow(flowing)}`).toBeGreaterThan(VCA_FLOOR);
  const settled = await readScopePeakOverWindow(page, 'scp-r', SILENCE_WINDOW_MS);
  expect(settled.rms, `and hold it open — ${describeScopeWindow(settled)}`).toBeGreaterThan(VCA_FLOOR);
  expect(settled.nonzeroSamples, 'a structured signal, not a glitch').toBeGreaterThan(50);
  const pairs = (await linnState(page, 'ln'))?.selection.pairs;
  expect(pairs?.r.x, 'R X follows the finger').toBeGreaterThan(0.8);
  expect(pairs?.g, 'G holds (0, 0): not selected').toEqual({ x: 0, y: 0 });
  // The unselected pair AT ITS JACK, full window, in the same run.
  const gWhileTouched = await readScopePeakOverWindow(page, 'scp-g', SILENCE_WINDOW_MS);
  expect(gWhileTouched.rms, `G X must stay 0 while the finger moves R — ${describeScopeWindow(gWhileTouched)}`).toBeLessThan(VCA_FLOOR);

  // (4) RETAINED ON RELEASE (hold, no snap-back — joystick #1963 shape): the
  //     finger lifts, the VCA stays open. Two windows; the second is asserted.
  await sim(page, 'release', PAD_CELL.col, PAD_CELL.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.pad), { message: 'the pad voice ends' }).toBe(0);
  await sampleScopeRms(page, 'scp-r', 10, 20);
  const retained = await sampleScopeRms(page, 'scp-r', 20, 20);
  expect(retained.samples).toBeGreaterThan(0);
  expect(retained.lo, `R X is RETAINED after the finger lifts (lo=${retained.lo.toFixed(4)} hi=${retained.hi.toFixed(4)})`).toBeGreaterThan(VCA_FLOOR);
  // …and the gesture end FLUSHED the pair into the patch's params.
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> }> } }).__patch.nodes['ln']?.params?.pos_r_x ?? null), {
      message: 'pos_r_x is committed durably on gesture end',
    })
    .toBeGreaterThan(0.8);

  // (5) V05 — SAVE → FRESH PAGE → LOAD, asserted AT THE JACK. The fresh page
  //     has NO device (the sim died with the old document), so the only thing
  //     that can open the R VCA is the retained pair coming back through the
  //     patch. Node presence is not the assertion; audio is.
  const envelope = await page.evaluate(() => (window as unknown as { __persistence?: { save?: () => unknown } }).__persistence?.save?.());
  expect(envelope, '__persistence.save() unavailable — DEV build expected').toBeTruthy();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown }; __ensureEngine?: unknown };
    return typeof w.__persistence?.load === 'function' && typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
  await page.evaluate((env) => {
    (window as unknown as { __persistence: { load: (env: unknown) => unknown } }).__persistence.load(env);
  }, envelope);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="linnstrument"])')).toHaveCount(1, { timeout: 10_000 });
  expect(await page.evaluate(() => typeof (globalThis as unknown as { __linnstrumentSim?: unknown }).__linnstrumentSim), 'no device survives the reload').toBe('undefined');
  const reloaded = await readScopePeakOverWindow(page, 'scp-r', AUDIBLE_CAP_MS, { untilRms: VCA_FLOOR });
  expect(reloaded.rms, `the retained R X opens the R VCA on the FRESH page — ${describeScopeWindow(reloaded)}`).toBeGreaterThan(VCA_FLOOR);
  const reloadedG = await readScopePeakOverWindow(page, 'scp-g', SILENCE_WINDOW_MS);
  expect(reloadedG.rms, `and G X is still 0 after the reload — ${describeScopeWindow(reloadedG)}`).toBeLessThan(VCA_FLOOR);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.selection.pairs.r.x ?? null)).toBeGreaterThan(0.8);

  // (6) CENTER — the same reducer intent the ranked cell dispatches — returns
  //     the SELECTED pair to (0, 0), so the R VCA closes.
  await dispatch(page, 'ln', { kind: 'center' });
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.selection.pairs.r.x)).toBe(0);
  await settledSilence(page, 'scp-r', VCA_FLOOR, 'CENTER on the selected R pair');

  errorWatch.assertClean();
});

// ── THE ARP: a held chord is SEQUENCED on the KEYS bus ─────────────────────
test('@linnstrument keys arp — a held chord is SEQUENCED to audible notes (V12), a duplicate pitch is refcounted (V13), and the control-column PANIC silences within the cap', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  test.setTimeout(timeoutFor(7));
  // Arp ON at the 4× division: 125 ms steps at the default 120 bpm (no TIMELORDE
  // is spawned; the runtime's bpm read falls back to 120), so a chord walks
  // several times inside one capture window.
  await buildKeysChain(page, { keys_arp_on: 1, keys_arp_div: 1 });

  // (1) NEGATIVE CONTROL: arp ON, nothing held → nothing to sequence.
  expect((await linnState(page, 'ln'))?.arp.keys, 'arp enabled, not running').toMatchObject({ enabled: true, running: false, held: [] });
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.peak, `an arp with no held notes is silent — ${describeScopeWindow(before)}`).toBeLessThan(CUBE_FLOOR);

  expect(await installSim(page), 'simulated LinnStrument installed + attached (needs VITE_E2E_HOOKS)').toBe(true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.state)).toBe('connected');

  // (2) HOLD a three-note chord (no release) → the held set fills and the arp
  //     runs. The direct voice writes are swallowed; only the arp sounds.
  const chord = [KEY_A, KEY_C, KEY_B];
  for (const k of chord) await sim(page, 'touch', k.col, k.row, { x: 500 });
  const notes = chord.map((k) => cellNote(k.col, k.row)).sort((a, b) => a - b);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.arp.keys.held), { message: 'the chord is the arp\'s held set' }).toEqual(notes);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.arp.keys.running)).toBe(true);

  // (3) AUDIBLE, structured, over a fresh window until it rings.
  let out = { rms: 0, nonzeroSamples: 0, polls: 0 };
  await expect
    .poll(async () => {
      out = await readScopePeakOverWindow(page, 'scp', 800, { untilRms: CUBE_FLOOR, untilNonzeroSamples: 50 });
      return out.rms;
    }, { timeout: 15_000, message: 'the arp produces audible RMS at the voice output' })
    .toBeGreaterThan(CUBE_FLOOR);
  expect(out.nonzeroSamples, 'structured signal (the arp is producing notes), not a glitch').toBeGreaterThan(50);

  // (4) V12 — A SEQUENCE, not one note: two DISTINCT chord pitches each reach
  //     the output within the cap (one lane, so they can only alternate).
  const fLow = hz(notes[0]!);
  const fHigh = hz(notes[notes.length - 1]!);
  const low = await pollScopeBandAmp(page, 'scp', fLow, BAND_PRESENT, AUDIBLE_CAP_MS);
  expect(low.best, `the lowest chord note (${fLow.toFixed(1)} Hz) is played (samples=${low.samples})`).toBeGreaterThan(BAND_PRESENT);
  const high = await pollScopeBandAmp(page, 'scp', fHigh, BAND_PRESENT, AUDIBLE_CAP_MS);
  expect(high.best, `the highest chord note (${fHigh.toFixed(1)} Hz) is played (samples=${high.samples})`).toBeGreaterThan(BAND_PRESENT);

  // (5) V13 — DUPLICATE-PITCH REFCOUNT. Two cells, one pitch (41): held once;
  //     releasing ONE keeps it; releasing BOTH drops it.
  const dup = cellNote(DUP_1.col, DUP_1.row);
  expect(cellNote(DUP_2.col, DUP_2.row), 'the two cells map to one pitch').toBe(dup);
  await sim(page, 'touch', DUP_1.col, DUP_1.row);
  await sim(page, 'touch', DUP_2.col, DUP_2.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.arp.keys.held), { message: 'one pitch, two touches, held ONCE' }).toEqual([dup, ...notes]);
  expect((await linnState(page, 'ln'))?.active.keys, 'but FIVE voices on the bus (D13: same pitch, distinct touches)').toBe(5);
  await sim(page, 'release', DUP_1.col, DUP_1.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys)).toBe(4);
  expect((await linnState(page, 'ln'))?.arp.keys.held, 'releasing one of two same-pitch touches KEEPS the note').toEqual([dup, ...notes]);
  await sim(page, 'release', DUP_2.col, DUP_2.row);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.arp.keys.held), { message: 'releasing the second drops it' }).toEqual(notes);

  // (6) PANIC from the CONTROL COLUMN (app col 16, bottom row — the D17
  //     recommendation, `extra_controls` default ON): a real cell Note On on
  //     the wire → control_edge → the reducer's panic effect → every voice on
  //     both buses off, the arp cancelled. The chord is still physically held;
  //     panic ends its voices, so the held set empties and nothing resumes.
  await sim(page, 'touch', CONTROL_COL, PANIC_ROW);
  await sim(page, 'release', CONTROL_COL, PANIC_ROW);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.active.keys), { message: 'PANIC ends every voice' }).toBe(0);
  expect((await linnState(page, 'ln'))?.arp.keys, 'the arp has nothing left to walk').toMatchObject({ held: [], running: false });
  await settledSilence(page, 'scp', CUBE_FLOOR, 'PANIC');
  // The stale releases of a panicked chord are release-after-steal NO-OPs.
  for (const k of chord) await sim(page, 'release', k.col, k.row);
  expect((await linnState(page, 'ln'))?.active.keys).toBe(0);

  errorWatch.assertClean();
});

// ── THE WEB BINDS FROM THE FACE (owner ruling 2026-09-15) ──────────────────
//
// /preflight is a native-shell feature. In a browser the module's CONNECT is
// the whole gesture: the layer binds the port named like a LinnStrument with
// NO rig pick and RECORDS it on this machine, so a reload + CONNECT binds the
// same port. `installSimulatedLinnstrument()` IS `connectLinnstrument()`
// against an in-memory access (the same seam the ranked CONNECT cell reaches),
// so the bind below is the real by-name path; the discriminator against the
// sim's explicit-bind fallback is the RECORDED pick, which only the by-name
// path writes.
test('@linnstrument CONNECT with NO rig pick binds the simulated port by NAME, records the pick on this machine, and the pick survives a reload', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  test.setTimeout(timeoutFor(2));
  await spawnPatch(page, [{ id: 'ln', type: 'linnstrument', position: { x: 60, y: 60 }, domain: 'audio' }]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="linnstrument"])')).toHaveCount(1);
  const pick = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as { __rigBindings?: () => { linnstrument?: { deviceId?: string } } };
      return w.__rigBindings?.()?.linnstrument?.deviceId ?? null;
    });
  expect(await pick(), 'no rig pick to start with').toBeNull();

  // The connect: bound with no explicit bind — the port matched by name.
  expect(await installSim(page), 'connect alone attaches the LinnStrument port').toBe(true);
  const st = await sim(page, 'status');
  expect(st.kind).toBe('bound');
  expect(st.boundPortName).toBe('LinnStrument MIDI');
  expect(containsRun(await sim(page, 'writes'), USER_MODE_ON), 'User Firmware Mode entry left on the paired output').toBe(true);
  await expect.poll(() => linnState(page, 'ln').then((s) => s?.session.state), { message: 'the runtime sees the session' }).toBe('connected');
  // …and RECORDED: the by-name path wrote the rig store (the explicit path never does).
  await expect.poll(pick, { message: 'the bound port is remembered in the per-machine rig store' }).toBe('sim-linnstrument-in');

  // The pick is a property of THIS MACHINE, not the patch: a reload keeps it
  // (localStorage) with no device present — the next CONNECT binds it again.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => typeof (globalThis as unknown as { __linnstrumentSim?: unknown }).__linnstrumentSim), 'no device survives the reload').toBe('undefined');
  await expect.poll(pick, { message: 'the pick survived the reload' }).toBe('sim-linnstrument-in');
  // The same port id comes back → CONNECT binds THAT port through the rig pick.
  expect(await installSim(page), 'after the reload, connect re-binds the remembered port').toBe(true);
  expect((await sim(page, 'status')).boundPortName).toBe('LinnStrument MIDI');
  expect(containsRun(await sim(page, 'writes'), USER_MODE_ON)).toBe(true);
  errorWatch.assertClean();
});
