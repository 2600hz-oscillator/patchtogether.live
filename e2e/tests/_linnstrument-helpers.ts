// ═════════ SHARED LINNSTRUMENT E2E HELPERS ═════════
//
// One copy of the simulated-instrument driver, the keyboard map, the floors
// and the observation helpers the LinnStrument specs share
// (linnstrument.spec.ts, linnstrument-panic-audible.spec.ts,
// linnstrument-expression.spec.ts). A pure move: every constant below was
// spelled identically in each spec before the third copy would have been
// written. Not a spec — the `_` prefix keeps it out of the Playwright match.
//
// The floors and BAND_* magnitudes were MEASURED on the CUBE chain
// (linnstrument.spec.ts, 2026-09-14); a spec on a different chain measures
// its own thresholds and says so.

import { expect } from './_fixtures';
import { type Locator, type Page } from '@playwright/test';
import { pollScopeBandAmp, sampleScopeRms } from '../_helpers/scope-poll';
/** The floor a gated CUBE voice must clear (adsr-poly-midilane's floor). */
export const CUBE_FLOOR = 0.01;
/** The floor a closed VCA must stay under and an open one must clear (trails'). */
export const VCA_FLOOR = 0.03;
/** Full window for every SILENCE assertion — no early exit. */
export const SILENCE_WINDOW_MS = 600;
/** CAP that BOUNDS THE FAILURE of an audible leg; it is NOT the gate. */
export const AUDIBLE_CAP_MS = 8_000;
/** Goertzel band magnitudes, MEASURED 2026-09-14 on CUBE's default tables over
 *  the scope's 2048-sample ring (darwin, this chain): a gated voice reads
 *  0.33–0.57 at its fundamental (one, two or three voices held), while a bin
 *  no voice is at reads ≤ 0.13 — that residue is rectangular-window leakage
 *  from a fundamental one to five bins away, not signal. PRESENT must clear
 *  the first; ABSENT must stay under the second; every present/absent pair is
 *  also asserted as a ratio against its own reading. */
export const BAND_PRESENT = 0.2;
export const BAND_ABSENT = 0.15;
/** Full window for a MUST-BE-ABSENT band measurement. */
export const BAND_ABSENT_WINDOW_MS = 400;

export function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 12_000;
}

// ── THE KEYBOARD, AS THE PROFILE MAPS IT ──────────────────────────────────
// keys region = app cols 0..15 × rows 0..7, note = root + col + 5·row with the
// def's `keys_root` default 36 (D09 +1/+5, keyboardCellToMidi). Wire column is
// app col + 1 and the note channel is the row — the sim spells those bytes.
export const KEYS_ROOT = 36;
export const cellNote = (col: number, row: number): number => KEYS_ROOT + col + row * 5;
export const KEY_A = { col: 8, row: 4 }; // 64 — E4
export const KEY_B = { col: 0, row: 7 }; // 71 — B4
export const KEY_C = { col: 6, row: 5 }; // 67 — G4
/** Two DIFFERENT cells that map to ONE pitch (41): the V13 refcount pair. */
export const DUP_1 = { col: 5, row: 0 };
export const DUP_2 = { col: 0, row: 1 };
/** The control column is app col 16; PANIC is its bottom row (profile
 *  `controlRows.panic` = 0, the D17 recommendation, `extra_controls` ON). */
export const CONTROL_COL = 16;
export const PANIC_ROW = 0;
/** The pad is app cols 17..24; this is its right-hand column, mid-height. */
export const PAD_CELL = { col: 24, row: 4 };
/** Raw X (0..16383) the sim sends for the pad finger — inside the pad's
 *  raw-X span under the profile's whole-device prior [0, 4265] (25 columns →
 *  the pad spans 2900..4265), so `u` lands near the right edge. */
export const PAD_RAW_X = 4200;
/** Raw-X units per semitone column under the same prior: 4265 / 25. */
export const SEMITONE_RAW = 4265 / 25;
/** CUBE's fundamental is C4 = 261.626 Hz at 0 V (packages/dsp/src/cube.ts
 *  `C4_HZ`), and the bus carries (note − 60 + bend) / 12 V. */
export const hz = (midi: number): number => 261.626 * Math.pow(2, (midi - 60) / 12);

/** NRPN 245 = User Firmware Mode ON: MSB 1, LSB 117, data 1. The bytes the
 *  REAL bind path must have written to the instrument's output. */
export const USER_MODE_ON: number[][] = [
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
export const USER_MODE_READ: number[][] = [
  [0xb0, 99, 2],
  [0xb0, 98, 43],
  [0xb0, 6, 1],
  [0xb0, 38, 117],
  [0xb0, 101, 127],
  [0xb0, 100, 127],
];
export function containsRun(writes: number[][], seq: number[][]): boolean {
  for (let i = 0; i + seq.length <= writes.length; i++) {
    if (seq.every((m, j) => writes[i + j]?.length === m.length && m.every((b, k) => writes[i + j]?.[k] === b))) return true;
  }
  return false;
}

export interface LinnSim {
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
export interface LinnSnapshot {
  session: { state: string; epoch: number; userMode: boolean };
  selection: { mask: Record<'r' | 'g' | 'b', boolean>; pairs: Record<'r' | 'g' | 'b', { x: number; y: number }> };
  active: { keys: number; pad: number };
  arp: { keys: { enabled: boolean; running: boolean; held: number[]; playing: number | null } };
}
export interface Lane {
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
export async function installSim(page: Page, opts: { bind?: boolean } = {}): Promise<boolean | null> {
  return page.evaluate(async (o) => {
    const w = globalThis as unknown as { __linnstrumentTestInstall?: (o: { bind?: boolean }) => Promise<boolean> };
    if (!w.__linnstrumentTestInstall) return null;
    return await w.__linnstrumentTestInstall(o);
  }, opts);
}

/** Call one driver method in the page. */
export async function sim<K extends keyof LinnSim>(page: Page, method: K, ...args: Parameters<LinnSim[K]>): Promise<ReturnType<LinnSim[K]>> {
  return page.evaluate(
    ({ method, args }) => {
      const w = globalThis as unknown as { __linnstrumentSim?: Record<string, (...a: unknown[]) => unknown> };
      if (!w.__linnstrumentSim) throw new Error('__linnstrumentSim missing — install the simulated LinnStrument first');
      return w.__linnstrumentSim[method]!(...args) as never;
    },
    { method, args: args as unknown[] },
  );
}

/** Open a node's dock faceplate, scoped BY NODE (launchpad-face.spec.ts's
 *  shape: an unscoped dock locator keeps resolving after the occupant swaps). */
export async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** The module's live runtime snapshot — `read(node, 'state')`. */
export async function linnState(page: Page, nodeId: string): Promise<LinnSnapshot | null> {
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
export async function keysLanes(page: Page, nodeId: string): Promise<Lane[]> {
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
export async function dispatch(page: Page, nodeId: string, intent: { kind: 'center' | 'panic' }): Promise<void> {
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
export async function bandMax(page: Page, scopeId: string, freq: number, windowMs: number): Promise<number> {
  const r = await pollScopeBandAmp(page, scopeId, freq, Number.POSITIVE_INFINITY, windowMs);
  expect(r.samples, `the SCOPE was sampled for the ${freq.toFixed(0)} Hz band`).toBeGreaterThan(0);
  return r.best;
}

/** Sample twice, assert on the second: a frozen buffer cannot read as silence
 *  that "arrived" — the first window absorbs the release tail and the analyser
 *  ring, the second is what is asserted. */
export async function settledSilence(page: Page, scopeId: string, floor: number, what: string): Promise<void> {
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
