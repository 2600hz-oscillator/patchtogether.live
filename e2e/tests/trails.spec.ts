// e2e/tests/trails.spec.ts
//
// ═════════ THE REAL-SOURCE-CHAIN GATE FOR THE BELA TRAILS MODULE ═════════
//
// AGENTS.md rule 8: a MIDI module ships an e2e wiring the REAL default-mode
// source through the module to an AUDIBLE-OUTPUT assertion. Driving the engine
// class directly, or asserting only that an edge materialised, has shipped
// modules that were green and silent.
//
// So the chain here is end to end and nothing in it is stubbed except the USB
// cable:
//
//   [simulated Bela Trails] --14-bit CC on the wire--> trails.x1
//   analogVco.sine --> vca.audio ;  trails.x1 --> vca.cv ;  vca.audio --> SCOPE.ch1
//
// The VCA spawns CLOSED (`base` defaults to 0, `cvAmount` to 1), so its output
// is the module's X jack made audible: silent at rest, open under a touch. That
// gives the positive assertion its own negative control in the same test — the
// SILENCE half runs first, over a full window with no early exit, and it is the
// half that would catch a rig where the scope, the cable or the spawn is broken
// rather than the module.
//
// ⚠ THE SIMULATED DEVICE IS NOT A SHORTCUT PAST THE DECODER. `__trailsTestInstall`
// installs an in-memory MIDIAccess whose one input is NAMED like the hardware
// and then runs the REAL `connectTrails()` against it, so the /trails/i port
// match, the shared `createMidiInputClaim` handler slot, the fan-out to the
// node and the module's own 14-bit assembler all execute. `touch()` emits the
// real CC byte pairs from the same constant table the decoder reads.
//
// ⚠ FILENAME: `trails.spec.ts` matches none of WEBGL_HEAVY_GLOBS, so it runs in
// the sharded `e2e` matrix job. A name colliding with one of those prefixes
// would remove it from CI entirely and look like ordinary bookkeeping.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import { sampleScopeRms } from '../_helpers/scope-poll';
import { installMidiMock } from '../_helpers/midi';

test.describe.configure({ mode: 'parallel' });

/** The scope RMS a closed VCA must stay under, and an open one must clear.
 *  Same floor the launchpad real-source-chain spec uses. */
const AUDIBLE_FLOOR = 0.03;
/** Full window for the SILENCE half — no early exit, because an assertion of
 *  silence has nothing to exit early on. */
const SILENCE_WINDOW_MS = 500;
/** How many non-silent samples in the analyser's 2048-sample ring make a
 *  STRUCTURED signal rather than a transient. Used both as the assertion's
 *  floor and as the window's early-exit target, so they cannot drift apart. */
const STRUCTURED_SAMPLES = 50;
/** Cap that BOUNDS THE FAILURE for the audible half; the `until*` target the
 *  caller names is the gate — and it must name the field it then asserts on.
 *  See `_module-coverage-helpers`, "the exit condition must imply the
 *  assertion": a window keyed on `untilPeak` may legitimately close on a single
 *  non-silent sample of the analyser ring, which is an `rms` of ~0.022 however
 *  loud the module is. */
const AUDIBLE_CAP_MS = 6000;

interface TrailsSim {
  touch(ch: number, x: number, y: number): void;
  gateOn(ch: number): void;
  gateOff(ch: number): void;
  /** NOTE MODE — what the device sends once both quantisations are enabled. */
  noteTouch(ch: number, xNote: number, yNote: number, velocity?: number): void;
  noteRelease(ch: number, xNote: number, yNote: number): void;
  clock(n?: number): void;
  send(bytes: number[]): void;
  attached(): boolean;
  portName: string;
}

/** Install the in-memory Trails through the app's own seam. Returns false when
 *  the hook is absent (a preview build without VITE_E2E_HOOKS), which the
 *  caller asserts rather than silently skipping. */
async function installSim(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const w = globalThis as unknown as { __trailsTestInstall?: () => Promise<boolean> };
    if (!w.__trailsTestInstall) return false;
    return await w.__trailsTestInstall();
  });
}

/** Put a finger on the pad, gate high. Coordinates are the pad's own 0..1. */
async function simTouch(page: Page, ch: number, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ ch, x, y }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      if (!w.__trailsSim) throw new Error('__trailsSim missing — install the simulated Trails first');
      w.__trailsSim.gateOn(ch);
      w.__trailsSim.touch(ch, x, y);
    },
    { ch, x, y },
  );
}

/** Move an already-touching finger without re-firing its gate. */
async function simMove(page: Page, ch: number, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ ch, x, y }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      if (!w.__trailsSim) throw new Error('__trailsSim missing — install the simulated Trails first');
      w.__trailsSim.touch(ch, x, y);
    },
    { ch, x, y },
  );
}

/** The module's live engine state — the same object the pad mirror paints. */
async function trailsState(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    return eng.read(node, 'state') as {
      status: { kind: string; portNames: string[] };
      channels: Array<{ x: number; y: number; gate: boolean; trail: unknown[] }>;
      axisMessages: number;
      clockTicks: number;
      loopRestarts: number;
      gateEdges: number[];
      stepTriggers: number[];
      midiFrames: number;
      midiFramesUnrecognised: number;
    } | null;
  }, nodeId);
}

/**
 * The real source chain. `vcaCvFrom` picks WHICH Trails jack opens the VCA:
 * `x1` (the position spec above) or `g1` (the loop-gate spec below). One
 * builder rather than two so the two specs cannot drift into testing different
 * racks and blaming the module for the difference.
 */
async function buildChain(page: Page, opts: { vcaCvFrom?: 'x1' | 'g1' } = {}): Promise<void> {
  const cvFrom = opts.vcaCvFrom ?? 'x1';
  await spawnPatch(
    page,
    [
      { id: 'tr', type: 'trails', position: { x: 60, y: 60 }, domain: 'audio' },
      { id: 'vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      // base 0 = CLOSED; cvAmount 1 = the CV IS the gain. Stated rather than
      // relied on, so a future change to the VCA's defaults reddens here
      // instead of quietly making the negative control vacuous.
      {
        id: 'vca',
        type: 'vca',
        position: { x: 640, y: 60 },
        domain: 'audio',
        params: { base: 0, cvAmount: 1 },
      },
      { id: 'scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
    ],
    [
      {
        id: 'e-osc',
        from: { nodeId: 'vco', portId: 'sine' },
        to: { nodeId: 'vca', portId: 'audio' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      {
        id: 'e-cv',
        from: { nodeId: 'tr', portId: cvFrom },
        to: { nodeId: 'vca', portId: 'cv' },
        sourceType: cvFrom === 'g1' ? 'gate' : 'cv',
        targetType: 'cv',
      },
      {
        id: 'e-scope',
        from: { nodeId: 'vca', portId: 'audio' },
        to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );
}

test('@trails a simulated touch reaches x1 and opens a real VCA → audible RMS', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  await buildChain(page);

  // (1) NEGATIVE CONTROL, first and over a FULL window: nothing has touched the
  //     pad, x1 rests at 0, the VCA is closed. If this half is not silent, the
  //     positive half below proves nothing about the module.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(
    before.rms,
    `a closed VCA must be silent before any touch — ${describeScopeWindow(before)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  // (2) Install the in-memory Trails through the REAL connect path.
  const installed = await installSim(page);
  expect(installed, 'simulated Trails installed + attached (needs VITE_E2E_HOOKS)').toBe(true);

  const bound = await trailsState(page, 'tr');
  expect(bound?.status.kind, 'the module reports the device as bound').toBe('bound');
  expect(bound?.status.portNames).toEqual(['Bela Trails']);

  // (3) A finger lands near the right edge of the pad on channel 1. These are
  //     REAL 14-bit CC byte pairs on wire channel 0.
  await simTouch(page, 1, 0.9, 0.5);

  const streamed = await trailsState(page, 'tr');
  expect(streamed?.axisMessages, 'the assembler decoded the touch').toBeGreaterThan(0);
  expect(streamed?.channels[0]?.x).toBeCloseTo(0.9, 2);
  expect(streamed?.channels[0]?.gate).toBe(true);

  // (4) THE AUDIBLE ASSERTION. x1 ≈ 0.9 is the VCA's gain now, so the oscillator
  //     reaches the scope.
  const flowing = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(flowing.polls, 'the SCOPE was sampled across the audible window').toBeGreaterThan(0);
  // ⚠ `peak`, NOT `rms` — matching the `untilPeak` target above, which is the
  // only field this window was told to wait for; the rms at that instant
  // is whatever a mostly-pre-touch buffer happened to hold, and asserting on it
  // makes this spec fail under load while the audio is perfectly fine (observed:
  // peak 0.1890 against rms 0.0246, polls=4, elapsed=61ms).
  expect(
    flowing.peak,
    `a touch on x1 must open the VCA — ${describeScopeWindow(flowing)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // …then the LEVEL, over a full window with no early exit.
  const after = await readScopePeakOverWindow(page, 'scp', SETTLE_WINDOW_MS);
  expect(after.polls, 'the SCOPE was sampled across the settled window').toBeGreaterThan(0);
  expect(
    after.rms,
    `and hold the VCA open — ${describeScopeWindow(after)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
  expect(after.nonzeroSamples, 'a structured signal, not a single glitch').toBeGreaterThan(50);
  expect(after.rms, 'the touch RAISED the output').toBeGreaterThan(before.rms + 0.02);

  // (5) THE OTHER DIRECTION: sliding back to the pad's left edge puts x1 at 0
  //     and closes the VCA again.
  //
  //     ⚠ MEASURED WITH `sampleScopeRms`, NOT `readScopePeakOverWindow`, and
  //     the difference is the instrument rather than the threshold. The window
  //     reader MAX-HOLDS: the scope's analyser ring is ~42 ms deep, so for the
  //     first samples after the close it still contains the audio from BEFORE
  //     it, and a max-hold reports that tail for the whole window no matter how
  //     silent the rest of it is (measured: rms 0.6364 across a fully-closed
  //     500 ms). `sampleScopeRms` returns the LO of the window, which is the
  //     quantity this assertion is actually about — "the signal reached
  //     silence and stayed there" — and it still runs entirely in the page.
  //
  //     Its own POSITIVE CONTROL is the step above: the same scope, in the same
  //     run, read well above the floor while the VCA was open, so a `lo` of
  //     ~zero here cannot be a scope that simply stopped producing.
  await simMove(page, 1, 0, 0.5);
  const lifted = await sampleScopeRms(page, 'scp', 25, 20);
  expect(lifted.samples, 'the SCOPE was sampled while closing').toBeGreaterThan(0);
  expect(
    lifted.lo,
    `x1 back at the pad's left edge must close the VCA `
      + `(lo=${lifted.lo.toFixed(4)} hi=${lifted.hi.toFixed(4)} samples=${lifted.samples})`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  errorWatch.assertClean();
});

// ═══════════ THE LOOP GATE ═══════════
//
// The owner's hardware report: "when the loop fires it doesn't seem like there
// is a gate event happening every time." This test is that report, made
// mechanical.
//
// The chain is the same real one as above with ONE cable moved: the VCA's CV
// comes from the GATE rather than from X, so the oscillator is audible exactly
// when the gate is high. Nothing is stubbed but the USB cable — `glide` streams
// the real 14-bit CC byte pairs a playing gesture produces, and `loopRestart`
// sends the real 0xFA the device sends "every time the playhead restarts from
// the beginning of the track".

/** How many loop repetitions the test announces. Small enough to stay fast,
 *  more than two so an off-by-one cannot pass. */
const LOOP_REPS = 4;

/** Gap between the page-side playback bursts, in ms.
 *
 *  ⚠ NOT a renderer wait — it is the DEVICE'S OWN STREAM RATE, the thing being
 *  simulated. It must stay well under the module's 120 ms activity timeout, or
 *  the gate falls between bursts and the test would be measuring a gap rather
 *  than the gapless playback it is about. 30 ms is a ~33 Hz gesture stream. */
const PLAYBACK_BURST_MS = 30;

interface TrailsLoopSim extends TrailsSim {
  glide(ch: number, steps: number, from?: { x: number; y: number }, to?: { x: number; y: number }): void;
  loopRestart(): void;
}

/** Start a gapless gesture playing back, the way the hardware does after a
 *  finger lifts. Runs in the page so the stream keeps flowing while Playwright
 *  awaits — a burst issued per Playwright round trip would be paced by the
 *  protocol instead of by the device. */
async function startPlayback(page: Page, ch: number): Promise<void> {
  await page.evaluate(
    ({ ch, everyMs }) => {
      const w = globalThis as unknown as {
        __trailsSim?: TrailsLoopSim;
        __trailsPlayback?: ReturnType<typeof setInterval>;
      };
      if (!w.__trailsSim) throw new Error('__trailsSim missing — install the simulated Trails first');
      const sim = w.__trailsSim;
      w.__trailsPlayback = setInterval(() => {
        sim.glide(ch, 4, { x: 0, y: 0.2 }, { x: 1, y: 0.8 });
      }, everyMs);
    },
    { ch, everyMs: PLAYBACK_BURST_MS },
  );
}

async function stopPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { __trailsPlayback?: ReturnType<typeof setInterval> };
    if (w.__trailsPlayback !== undefined) clearInterval(w.__trailsPlayback);
    w.__trailsPlayback = undefined;
  });
}

/**
 * Announce `n` loop repetitions and report the gate-edge counters from
 * IMMEDIATELY before and after — all inside ONE page call.
 *
 * ⚠ THE SINGLE ROUND TRIP IS THE POINT. Issuing the restarts as N separate
 * `page.evaluate`s put N protocol round trips inside the measured window, and
 * any main-thread stall longer than the module's 120 ms activity timeout would
 * let the contact gate fall and re-rise — adding an edge that belongs to the
 * test rig, not the module, and reddening an exact-delta assertion. Bracketing
 * the reads around the restarts in one synchronous block makes the delta a
 * property of the decode path and nothing else.
 */
async function announceLoops(
  page: Page,
  nodeId: string,
  n: number,
): Promise<{ before: number[]; after: number[]; loopsBefore: number; loopsAfter: number }> {
  return page.evaluate(
    ({ id, n }) => {
      const w = globalThis as unknown as {
        __trailsSim?: TrailsLoopSim;
        __engine?: () => {
          read: (nd: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      if (!w.__trailsSim) throw new Error('__trailsSim missing');
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) throw new Error('engine or node missing');
      const read = () => eng.read(node, 'state') as { gateEdges: number[]; loopRestarts: number };

      const start = read();
      const before = [...start.gateEdges];
      const loopsBefore = start.loopRestarts;
      for (let i = 0; i < n; i++) w.__trailsSim.loopRestart();
      const end = read();
      return { before, after: [...end.gateEdges], loopsBefore, loopsAfter: end.loopRestarts };
    },
    { id: nodeId, n },
  );
}

test('@trails a looping gesture strikes the gate ONCE PER REPETITION → audible', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  await buildChain(page, { vcaCvFrom: 'g1' });

  // (1) NEGATIVE CONTROL. Gate low, VCA closed, full window, no early exit.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(
    before.rms,
    `a closed VCA must be silent before the gate rises — ${describeScopeWindow(before)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  const installed = await installSim(page);
  expect(installed, 'simulated Trails installed + attached (needs VITE_E2E_HOOKS)').toBe(true);

  // (2) A recorded gesture starts playing back: continuous CC, never a gap.
  await startPlayback(page, 1);

  // (3) THE AUDIBLE ASSERTION. The gate rose, so the oscillator reaches the
  //     scope. This is also what makes the edge counts below mean something:
  //     they are counts of edges on a jack that demonstrably carries signal.
  //
  //     ⚠ `untilRms`, NOT `untilPeak` — the window has to wait for the quantity
  //     the assertion below is about. Keyed on peak this read exited 3 ms in on
  //     an analyser ring holding ONE non-silent sample (measured on run
  //     33579058140: peak=0.9949, rms=0.0220 = sqrt(0.9949²/2048)) and failed an
  //     rms floor of 0.03 while the audio was perfect.
  const open = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilRms: AUDIBLE_FLOOR,
  });
  expect(open.polls, 'the SCOPE was sampled across the audible window').toBeGreaterThan(0);
  expect(
    open.rms,
    `a playing gesture must open the VCA through g1 — ${describeScopeWindow(open)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
  expect(open.rms, 'the gate RAISED the output').toBeGreaterThan(before.rms + 0.02);

  // (4) The baseline, taken while the gesture plays and NOTHING has been
  //     announced. `loopRestarts` is 0 here on the nose — it counts decoded
  //     0xFA bytes and no timing can change that.
  //
  //     ⚠ The gate-edge count is read as a BASELINE rather than asserted to be
  //     exactly 1, deliberately. It "should" be 1 — that is the defect, and the
  //     unit suite pins it exactly, driving the same decoder with the same
  //     device double and no scheduler in the way. Here the number depends on
  //     whether the browser kept the playback interval under the module's
  //     120 ms activity timeout, so pinning it would be asserting on the test
  //     rig's timer rather than on the module. The DELTA below is measured
  //     inside a single page call, so no round trip can land in it.
  const streaming = await trailsState(page, 'tr');
  expect(streaming?.axisMessages, 'the gesture really is streaming').toBeGreaterThan(20);
  expect(streaming?.loopRestarts, 'no repetition has been announced yet').toBe(0);

  // (5) Now the device announces each repetition, as it does on hardware.
  const m = await announceLoops(page, 'tr', LOOP_REPS);
  expect(m.loopsAfter - m.loopsBefore, 'every repetition was decoded').toBe(LOOP_REPS);
  expect(
    m.after[0]! - m.before[0]!,
    `ONE gate edge per repetition and not one more — the 1:1 the fix is for `
      + `(edges went ${m.before[0]} → ${m.after[0]} across ${LOOP_REPS} restarts)`,
  ).toBe(LOOP_REPS);
  // …and the other three channels were not dragged along by a message that
  // speaks for one playhead.
  expect(
    m.after.slice(1).map((v, i) => v - m.before[i + 1]!),
    'only the playing channel re-struck',
  ).toEqual([0, 0, 0]);

  // (6) …and the retrigger notch did not cost the signal: the jack is still
  //     carrying audio after four re-strikes, so the fix articulates rather
  //     than interrupting.
  const after = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilRms: AUDIBLE_FLOOR,
  });
  expect(
    after.rms,
    `the gate must still be open after ${LOOP_REPS} retriggers — ${describeScopeWindow(after)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // (7) THE OTHER DIRECTION, and the second negative control: the gesture
  //     stops, the stream goes quiet, the contact gate falls and the VCA closes.
  //     Measured with `sampleScopeRms` for its LO rather than a max-hold window
  //     — see the note in the spec above for why a max-hold cannot assert
  //     silence straight after audio.
  await stopPlayback(page);
  const closed = await sampleScopeRms(page, 'scp', 25, 20);
  expect(closed.samples, 'the SCOPE was sampled while closing').toBeGreaterThan(0);
  expect(
    closed.lo,
    `a stopped gesture must close the VCA `
      + `(lo=${closed.lo.toFixed(4)} hi=${closed.hi.toFixed(4)} samples=${closed.samples})`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  errorWatch.assertClean();
});

// ═══════════ NOTE MODE ═══════════
//
// The owner's hardware report: "when i hit scale i am just getting one
// continuous note output even when i select other notes in the scale."
//
// The mechanism: with both pitch and temporal quantisation enabled the device
// stops sending CC entirely and sends MIDI notes — the SAME two axes on the
// SAME per-axis MIDI channels, quantised to a scale. The decoder's note branch
// kept only a gate, so every X/Y jack froze at its last CC value.
//
// ⚠ THIS SPEC ASSERTS THE JACK'S VALUE CHANGED BETWEEN TWO DIFFERENT NOTES, not
// that a gate fired. The loop-gate spec above was green throughout the entire
// life of this defect, because a gate is exactly what note mode never stopped
// producing.
//
// The chain is the SAME real one as the first spec — the simulated device's
// bytes, the /trails/i port match, the shared claim, the module's own decoder,
// x1 into a closed VCA into the scope — with `noteTouch` in place of `touch`.

/** The two notes the chain is driven with. Seven octaves apart so the two VCA
 *  gains are unmistakable at the scope, and both well inside the MIDI range so
 *  neither is clamped by the note window. */
const NOTE_LOW = 24;
const NOTE_HIGH = 108;

/**
 * How long each note's LEVEL is measured over — a full window, no early exit.
 *
 * ⚠ DERIVED FROM THE SCOPE, not chosen for feel: the `scp` node is spawned with
 * `timeMs: 200`, so its buffer holds 200 ms of history and the first ~200 ms
 * after a level change still shows the previous note. 500 ms guarantees the
 * window contains buffers made entirely of the note under test, and the reader
 * max-holds, so those are the ones that decide the number.
 */
const SETTLE_WINDOW_MS = 500;

/** Put a quantised finger on the pad — the note-mode equivalent of `simTouch`. */
async function simNote(page: Page, ch: number, xNote: number, yNote: number): Promise<void> {
  await page.evaluate(
    ({ ch, xNote, yNote }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      if (!w.__trailsSim) throw new Error('__trailsSim missing — install the simulated Trails first');
      w.__trailsSim.noteTouch(ch, xNote, yNote, 97);
    },
    { ch, xNote, yNote },
  );
}

test('@trails NOTE MODE steers x1 — a different note is a different level → audible', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  await buildChain(page);

  // (1) NEGATIVE CONTROL, full window, no early exit: nothing has been played,
  //     x1 rests at 0, the VCA is closed.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(
    before.rms,
    `a closed VCA must be silent before any note — ${describeScopeWindow(before)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  const installed = await installSim(page);
  expect(installed, 'simulated Trails installed + attached (needs VITE_E2E_HOOKS)').toBe(true);

  // (2) The player enables pitch quantisation and plays a LOW note. On the wire
  //     this is a real note-on per axis, on the axes' own MIDI channels — no CC
  //     at all, which is the state the defect lived in.
  await simNote(page, 1, NOTE_LOW, NOTE_LOW);

  const low = await trailsState(page, 'tr');
  expect(
    low?.axisMessages,
    'THE DEFECT: a note must decode as an AXIS, not only as a gate',
  ).toBeGreaterThan(0);
  const lowX = low!.channels[0]!.x;
  expect(lowX, 'the low note landed at its own point on the pad').toBeCloseTo(NOTE_LOW / 127, 2);
  expect(low?.channels[0]?.gate, 'and the gate still rises').toBe(true);

  // (3) AUDIBLE at the low note: x1 is the VCA's gain, so the oscillator is
  //     already reaching the scope. This is what makes the level comparison
  //     below a measurement of a live jack rather than of two silences.
  const lowWin = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(lowWin.polls, 'the SCOPE was sampled at the low note').toBeGreaterThan(0);
  // `peak` — the one field this window named as its target, and so the one an
  // early exit guarantees. See below.
  expect(
    lowWin.peak,
    `a quantised note must open the VCA through x1 — ${describeScopeWindow(lowWin)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // …and then the SETTLED level at that note, over a FULL window with no early
  // exit.
  //
  // ⚠ THE READ ABOVE CANNOT BE USED AS A LEVEL, and that is a property of the
  // instrument rather than a threshold to tune. `untilPeak` exits on the FIRST
  // poll that clears its target — measured here at polls=1, elapsed=0 ms — while
  // the scope is still showing a buffer that predates the note. It reported
  // 0.0788 for a note whose settled level is 0.1344, i.e. 40 % low, which is
  // exactly the size of error that makes a comparison between two levels
  // meaningless. It is a fine gate for "audio is flowing"; it is not a
  // measurement.
  const lowLevel = await readScopePeakOverWindow(page, 'scp', SETTLE_WINDOW_MS);
  expect(lowLevel.polls, 'the SCOPE was sampled across the low-note window').toBeGreaterThan(0);
  expect(lowLevel.rms, 'the note RAISED the output').toBeGreaterThan(before.rms + 0.02);

  // (4) THE ASSERTION THE BUG IS ABOUT. The player picks a different note in
  //     the scale, and the jack has to MOVE. Before the fix both of these read
  //     the same frozen value and the rack heard one held pitch forever.
  //
  //     The low note is RELEASED first, which is the monophonic stream the
  //     device actually produces — and on the way through it exercises the hold
  //     rule: a release must not move the jack, only the gate.
  await page.evaluate(
    ({ n }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      w.__trailsSim!.noteRelease(1, n, n);
    },
    { n: NOTE_LOW },
  );
  const between = await trailsState(page, 'tr');
  expect(between?.channels[0]?.gate, 'the release lowered the gate').toBe(false);
  expect(between?.channels[0]?.x, 'a release holds the position').toBeCloseTo(lowX, 4);

  await simNote(page, 1, NOTE_HIGH, NOTE_HIGH);
  const high = await trailsState(page, 'tr');
  const highX = high!.channels[0]!.x;
  expect(highX).toBeCloseTo(NOTE_HIGH / 127, 2);
  expect(
    highX - lowX,
    `a HIGHER note must read higher on the jack (low=${lowX.toFixed(4)} high=${highX.toFixed(4)})`,
  ).toBeGreaterThan(0.5);

  // (5) …AND THE RACK HEARD THE DIFFERENCE. The same instrument over the same
  //     window, so the two numbers are comparable by construction.
  //
  //     ⚠ MAX-HOLD IS THE RIGHT READER FOR A RISE, and the only one that
  //     survives the scope's own latency: the window opens on a buffer that
  //     still holds the previous level, so any reader that takes the window's
  //     MINIMUM reports the level that was there BEFORE the note (measured:
  //     high lo=0.1328 against a settled low of 0.1344 — the bands touch, and a
  //     4.5x change reads as no change at all). Max-hold cannot be dragged down
  //     by that stale prefix. The direction it is unsafe in — asserting SILENCE
  //     straight after audio — is not the direction asserted here, and the two
  //     specs above use `sampleScopeRms` for exactly that other direction.
  const highLevel = await readScopePeakOverWindow(page, 'scp', SETTLE_WINDOW_MS);
  expect(highLevel.polls, 'the SCOPE was sampled across the high-note window').toBeGreaterThan(0);
  const levels = `low ${describeScopeWindow(lowLevel)} · high ${describeScopeWindow(highLevel)}`;
  expect(
    highLevel.rms,
    `the higher note must open the VCA further — ${levels}`,
  ).toBeGreaterThan(lowLevel.rms);
  // 2x, against a jack ratio of 108/24 = 4.5: wide enough that no plausible
  // measurement error crosses it, narrow enough that it is not asserting the
  // exact gain of a VCA this spec does not own.
  expect(highLevel.rms, `and by a wide margin, not a hair — ${levels}`).toBeGreaterThan(
    lowLevel.rms * 2,
  );
  expect(highLevel.nonzeroSamples, 'a structured signal, not a single glitch').toBeGreaterThan(50);

  // (6) THE FINAL RELEASE. The hardware's release is a note-ON at velocity 0,
  //     so this is the real byte shape. The gate falls; the jack HOLDS at the
  //     pitch it reached, exactly as it does when a CC stream goes quiet —
  //     dropping it to zero between notes would slam every destination to the
  //     bottom of its range once per note.
  await page.evaluate(
    ({ n }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      w.__trailsSim!.noteRelease(1, n, n);
    },
    { n: NOTE_HIGH },
  );
  const released = await trailsState(page, 'tr');
  expect(released?.channels[0]?.gate, 'the release lowered the gate').toBe(false);
  expect(released?.channels[0]?.x, 'the position holds after the release').toBeCloseTo(highX, 4);

  errorWatch.assertClean();
});

// ═══════════ THE POLY NOTE BUSES ═══════════
//
// AGENTS.md rule 8, for the poly half: the REAL default-mode source through the
// module to an AUDIBLE-OUTPUT assertion. Nothing is stubbed but the USB cable.
//
//   [simulated Bela Trails, NOTE MODE] --note-on per axis on the wire-->
//   trails.poly1 --polyPitchGate--> tidyVco.poly ; tidyVco.out_l --> SCOPE.ch1
//
// TIDY VCO is a real polyphonic voice whose amp-EG sustain defaults to 0.75, so
// a held lane gate sustains and the assertion is about the module rather than
// about an envelope's decay.
//
// ⚠ THE CC-MODE STEP IS A SECOND NEGATIVE CONTROL, and the strongest one here.
// The poly buses are documented as alive ONLY in note mode; a full CC gesture
// that leaves the voice silent is what proves that end to end, and it would
// catch a poly port wired to something always-on.

/** Notes for the poly chain. Well away from C4 (= 0 V), so a lane sitting at
 *  its resting 0 cannot be mistaken for a pitch that was actually written. */
const POLY_NOTE_X = 48;
const POLY_NOTE_Y = 55;

test('@trails NOTE MODE plays a real poly voice through poly1 → audible', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  await spawnPatch(
    page,
    [
      { id: 'tr', type: 'trails', position: { x: 60, y: 60 }, domain: 'audio' },
      { id: 'voice', type: 'tidyVco', position: { x: 420, y: 60 }, domain: 'audio' },
      { id: 'scp', type: 'scope', position: { x: 820, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
    ],
    [
      {
        id: 'e-poly',
        from: { nodeId: 'tr', portId: 'poly1' },
        to: { nodeId: 'voice', portId: 'poly' },
        sourceType: 'polyPitchGate',
        targetType: 'polyPitchGate',
      },
      {
        id: 'e-scope',
        from: { nodeId: 'voice', portId: 'out_l' },
        to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // (1) NEGATIVE CONTROL. No notes, no lanes gated, the voice is silent.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(
    before.rms,
    `an ungated poly voice must be silent — ${describeScopeWindow(before)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  const installed = await installSim(page);
  expect(installed, 'simulated Trails installed + attached (needs VITE_E2E_HOOKS)').toBe(true);

  // (2) ⚠ SECOND NEGATIVE CONTROL: a full CC-mode gesture. The x/y jacks move
  //     and the contact gate rises, but the device is sending NO notes — so the
  //     poly bus must stay at rest and the voice must stay silent.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __trailsSim?: TrailsLoopSim };
    w.__trailsSim!.glide(1, 16, { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 });
  });
  const ccState = await trailsState(page, 'tr');
  expect(ccState?.axisMessages, 'the CC gesture really did arrive').toBeGreaterThan(0);
  const duringCc = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(
    duringCc.rms,
    `the poly bus is NOTE-MODE ONLY — a CC gesture must not play the voice `
      + `(${describeScopeWindow(duringCc)})`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  // (3) The player enables pitch quantisation. Now the device sends notes, and
  //     the SAME parse feeds the same channel's poly bus.
  await page.evaluate(
    ({ x, y }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      w.__trailsSim!.noteTouch(1, x, y);
    },
    { x: POLY_NOTE_X, y: POLY_NOTE_Y },
  );

  // (4) THE AUDIBLE ASSERTION. Two lanes gated, a real worklet voice, real
  //     sound at the scope.
  //     ⚠ Both fields this asserts on are named as targets. An `untilPeak` exit
  //     guarantees neither: it can close the window on an analyser ring holding
  //     a single non-silent sample, which is `rms` ~0.022 and `nonzero` 1.
  const playing = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilRms: AUDIBLE_FLOOR,
    untilNonzeroSamples: STRUCTURED_SAMPLES,
  });
  expect(playing.polls, 'the SCOPE was sampled while the voice played').toBeGreaterThan(0);
  expect(
    playing.rms,
    `a quantised note must PLAY the poly voice — ${describeScopeWindow(playing)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
  expect(playing.rms, 'the note RAISED the output').toBeGreaterThan(duringCc.rms + 0.02);
  expect(
    playing.nonzeroSamples,
    `a structured signal, not a single glitch — ${describeScopeWindow(playing)}`,
  ).toBeGreaterThan(STRUCTURED_SAMPLES);

  // (5) THE OTHER DIRECTION. Releasing both axes drops both lane gates and the
  //     voice releases. Measured with `sampleScopeRms` for its LO — a max-hold
  //     window cannot assert silence straight after audio (see the note in the
  //     first spec), and the amp EG needs its release to run out.
  await page.evaluate(
    ({ x, y }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      w.__trailsSim!.noteRelease(1, x, y);
    },
    { x: POLY_NOTE_X, y: POLY_NOTE_Y },
  );
  const released = await sampleScopeRms(page, 'scp', 40, 25);
  expect(released.samples, 'the SCOPE was sampled while releasing').toBeGreaterThan(0);
  expect(
    released.lo,
    `releasing both axes must close the poly voice `
      + `(lo=${released.lo.toFixed(4)} hi=${released.hi.toFixed(4)} samples=${released.samples})`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  errorWatch.assertClean();
});

// ═══════════ THE KICK PATCH — TWO LAYERS FROM ONE GESTURE ═══════════
//
// Owner: "in note mode (or not) i would like to be able to trigger kick drum
// from trails … i don't think our gates are there?" — and then, of the held
// gate: "this is kind of a cool effect so i want to understand why it's working
// the way it is now, before we change/fix it."
//
// Both are true at once, and this spec proves both at once:
//
//   trails.trig1 --> kickdrum.trigger_in   (the RHYTHM: one strike per step)
//   trails.g1    --> kickdrum.choke_in     (the DRONE: a level that stays high)
//   kickdrum.audio_l --> SCOPE.ch1
//
// ⚠ WHY A DECODER EDGE COUNT WOULD NOT DO. The claim is "a kick fires more than
// once in one held gesture". That is a claim about AUDIO, and the failure it
// guards against — a trigger that is scheduled but collapses into one edge
// because a later `cancelScheduledValues` eats it — is invisible to any count
// of what the module intended. So the assertion is on STRIKES HEARD AT THE
// SCOPE, counted as separate bursts of sound.

/** How many times EACH AXIS steps. Two axes take turns, so the gesture
 *  contains twice this many articulations. More than two so an off-by-one
 *  cannot pass, few enough to stay fast. */
const KICK_MOVES_PER_AXIS = 3;

/**
 * The strike-detection thresholds, DERIVED FROM THE MEASURED ENVELOPE rather
 * than guessed.
 *
 * A kick at `body_decay: 30` reads (RMS over the scope's 50 ms window) a peak of
 * ~0.65-0.75 and decays to ~0.03 before the next strike 300 ms later. So a
 * threshold pair anywhere inside that gap separates strikes cleanly.
 *
 * ⚠ THE FIRST VERSION OF THIS TEST USED `AUDIBLE_FLOOR` (0.03) AND ITS HALF
 * (0.015) AND COUNTED FOUR REAL STRIKES AS ONE. The trough between strikes is
 * ~0.027-0.05 — above the 0.015 re-arm — so the detector latched high on the
 * first strike and never re-armed. The audio was correct throughout; the
 * instrument was not. Both numbers now sit well inside the measured gap.
 */
const STRIKE_ON = 0.25;
const STRIKE_OFF = 0.10;

/**
 * Play an INTERLEAVED quantised gesture on channel 1, entirely inside the page.
 *
 * ⚠ INTERLEAVED, NOT ALIGNED, AND THAT IS THE WHOLE POINT OF THIS SPEC. X and Y
 * are quantised independently on the hardware, so each crosses its own scale
 * boundary at its own moment and one of them is essentially always sounding.
 * That is what holds the contact gate high for a whole gesture — the drone the
 * owner asked to keep — and it is the stream shape their MON capture shows.
 *
 * An earlier version released BOTH axes together before each strike. That is
 * the aligned case: the channel genuinely falls silent between steps, the
 * contact gate re-rises every time, and the spec would have "proved" a drone
 * that its own fixture had destroyed (`gateEdges` read 4, not 1).
 *
 * ⚠ ONE `page.evaluate`, spaced by the device's own step rate rather than by
 * Playwright round trips: a protocol hop between moves would pace the gesture by
 * the harness instead of the hardware.
 */
async function playInterleavedGesture(page: Page, moves: number, everyMs: number): Promise<void> {
  await page.evaluate(
    async ({ moves, everyMs }) => {
      const w = globalThis as unknown as { __trailsSim?: TrailsSim };
      const sim = w.__trailsSim!;
      let x = 60;
      let y = 72;
      // Both axes down to begin: the channel is now sounding and must STAY so.
      sim.noteTouch(1, x, y);
      for (let i = 0; i < moves; i++) {
        // X steps while Y keeps holding — the channel never goes silent.
        await new Promise((r) => setTimeout(r, everyMs));
        sim.send([0x90, x, 0]);
        x += 2;
        sim.send([0x90, x, 127]);
        // …then Y steps while X keeps holding.
        await new Promise((r) => setTimeout(r, everyMs));
        sim.send([0x91, y, 0]);
        y += 2;
        sim.send([0x91, y, 127]);
      }
    },
    { moves, everyMs },
  );
}

test('@trails TRIG strikes a real kick ONCE PER STEP while GATE holds the drone', async ({
  page,
  rack,
  errorWatch,
}) => {
  void rack;
  await spawnPatch(
    page,
    [
      { id: 'tr', type: 'trails', position: { x: 60, y: 60 }, domain: 'audio' },
      // ⚠ A SHORT BODY DECAY, and it is the instrument rather than taste. The
      // assertion counts SEPARATE strikes, so each has to finish before the
      // next: at the 120 ms default the tails overlap the 300 ms step interval
      // through the scope's own window and four strikes read as one long sound.
      { id: 'kick', type: 'kickdrum', position: { x: 420, y: 60 }, domain: 'audio', params: { body_decay: 30 } },
      // ⚠ AND A SHORT SCOPE WINDOW, for the same reason. `timeMs` is how much
      // history each RMS read averages over; at the 200 ms this file uses
      // elsewhere the window is LONGER THAN THE GAP BETWEEN STRIKES, so it
      // always contains one and the level never returns to silence between
      // them. Measured: 4 real strikes counted as 1. 50 ms is comfortably
      // shorter than the 300 ms step interval.
      { id: 'scp', type: 'scope', position: { x: 820, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      {
        id: 'e-trig',
        from: { nodeId: 'tr', portId: 'trig1' },
        to: { nodeId: 'kick', portId: 'trigger_in' },
        sourceType: 'gate',
        targetType: 'gate',
      },
      {
        id: 'e-scope',
        from: { nodeId: 'kick', portId: 'audio_l' },
        to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // (1) NEGATIVE CONTROL. An untriggered kick is silent.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(
    before.rms,
    `an untriggered kick must be silent — ${describeScopeWindow(before)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  const installed = await installSim(page);
  expect(installed, 'simulated Trails installed + attached (needs VITE_E2E_HOOKS)').toBe(true);

  // (2) Sample the scope CONTINUOUSLY while a quantised gesture plays, and count
  //     how many separate bursts of sound arrive. `sampleScopeRms` runs entirely
  //     in the page, so the gesture and the measurement share one main thread
  //     and neither is paced by Playwright.
  // Longer than the kick's 30 ms body decay AND than the scope's 50 ms window,
  // so consecutive strikes are separated by genuine silence at the instrument.
  const stepMs = 300;
  const measurement = page.evaluate(
    async ({ everyMs, samples, on, off }) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes.scp;
      const series: number[] = [];
      for (let i = 0; i < samples; i++) {
        const snap = eng?.read(node, 'snapshot') as { ch1?: Float32Array } | undefined;
        if (snap?.ch1 && snap.ch1.length > 0) {
          let energy = 0;
          for (let j = 0; j < snap.ch1.length; j++) energy += snap.ch1[j]! * snap.ch1[j]!;
          series.push(Math.sqrt(energy / snap.ch1.length));
        }
        await new Promise((r) => setTimeout(r, everyMs));
      }
      // A STRIKE is a rising crossing of the floor — the series going from
      // below it to above it. Counting samples above the floor would report one
      // long burst as many, and one decay as several.
      // SCHMITT-TRIGGERED, with both thresholds inside the measured gap between
      // a strike's peak and the trough before the next one. A single-threshold
      // detector latches on the first strike and reports one.
      let strikes = 0;
      let above = false;
      for (const v of series) {
        if (!above && v >= on) {
          strikes++;
          above = true;
        } else if (above && v < off) {
          above = false;
        }
      }
      return { strikes, samples: series.length, peak: Math.max(0, ...series) };
    },
    // 90 samples x 20 ms = 1.8 s, comfortably spanning 4 steps at 300 ms plus
    // the gesture's own start-up.
    // 130 samples x 20 ms = 2.6 s, spanning 6 articulations at 300 ms plus
    // the gesture's own start-up.
    { everyMs: 20, samples: 130, on: STRIKE_ON, off: STRIKE_OFF },
  );

  await playInterleavedGesture(page, KICK_MOVES_PER_AXIS, stepMs);
  const heard = await measurement;

  expect(heard.samples, 'the SCOPE was sampled throughout the gesture').toBeGreaterThan(10);
  expect(
    heard.peak,
    `the kick must be AUDIBLE at all (peak=${heard.peak.toFixed(4)})`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
  // ⚠ THE ASSERTION THE OWNER'S REPORT IS ABOUT. More than one strike inside a
  // single held gesture. Before the trigger jack existed the contact gate rose
  // once and a drum fired once, however long the gesture ran.
  expect(
    heard.strikes,
    `TRIG must strike the kick more than once in ONE gesture `
      + `(heard ${heard.strikes} strike(s) across ${KICK_MOVES_PER_AXIS * 2} articulations, `
      + `peak ${heard.peak.toFixed(4)})`,
  ).toBeGreaterThan(1);

  // (3) THE OTHER LAYER, in the same gesture: the contact gate never fell. This
  //     is the drone the owner asked to keep, asserted rather than assumed —
  //     `gateEdges` counts RISES, so one rise across a multi-step gesture is
  //     exactly "it went up once and stayed".
  const st = await trailsState(page, 'tr');
  expect(st?.gateEdges[0], 'the contact gate rose ONCE — the drone survives').toBe(1);
  expect(
    st?.stepTriggers[0],
    'while the trigger jack articulated every step',
  ).toBeGreaterThanOrEqual(KICK_MOVES_PER_AXIS * 2);
  expect(st?.channels[0]?.gate, 'and it is STILL high at the end of the gesture').toBe(true);

  errorWatch.assertClean();
});

test('@trails MON reports the traffic the module does NOT understand', async ({
  page,
  errorWatch,
}) => {
  // The diagnostic affordance, end to end. Its value is entirely in the
  // UNRECOGNISED half: every wire constant this module has is a reading of a
  // manual, and a monitor that only showed traffic the decoder already
  // understood could not falsify a single one of them.
  //
  // Navigated the same way as the two card specs below rather than through the
  // `rack` fixture, because this one asserts on the CARD'S DOM and TRAILS is a
  // bespoke surface — the card is the surface, so the spec should name the
  // shell it is reading instead of inheriting one.
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'tr', type: 'trails', position: { x: 200, y: 200 }, domain: 'audio' },
  ]);
  expect(await installSim(page)).toBe(true);

  await page.getByTestId('trails-mon-tr').click();

  await page.evaluate(() => {
    const w = globalThis as unknown as { __trailsSim?: TrailsLoopSim };
    const sim = w.__trailsSim!;
    sim.touch(1, 0.5, 0.5); // four frames the decoder understands
    // CC47 is the fine partner the MIDI convention would pair with CC15. A
    // firmware using it would look EXACTLY like this, and the readout has to
    // name it rather than silently dropping it.
    for (let i = 0; i < 5; i++) sim.send([0xb0, 47, 0x40]);
  });

  const log = page.getByTestId('trails-mon-text-tr');
  await expect(log).toContainText('ch1[1X] CC47', { timeout: 10_000 });
  // ⚠ THE COUNT, not the words. The header prints "N not decoded" even when N
  // is zero, so asserting the bare phrase would pass on a monitor that had
  // silently dropped every unrecognised frame — the one failure this test
  // exists to catch. Four decoded axis frames + five rejected CC47s.
  await expect(log).toContainText('5 not decoded');
  await expect(log).toContainText('trails-decode.ts');
  // The row the module DOES understand is there too, unflagged.
  await expect(log).toContainText('ch1[1X] CC15');

  // ⚠ THE READOUT MUST NOT LIE ABOUT VELOCITY. A strike and its running-status
  // release share one row — the release is a note-ON at velocity 0 — so the
  // row's raw last byte is 0 between every pair of strikes. The owner's first
  // real capture read `ch2 NOTE 81 on x106 last=0` on a device struck 53 times
  // and was nearly reported as "Trails sends velocity 0". The page has to show
  // the STRIKE's velocity, because that is the one number in this readout no
  // document can supply: the Trails manual never uses the word "velocity", so
  // whether the pad transmits touch force is answerable only by watching this.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __trailsSim?: TrailsLoopSim };
    const sim = w.__trailsSim!;
    for (let i = 0; i < 3; i++) {
      sim.noteTouch(1, 81, 81, 97);
      sim.noteRelease(1, 81, 81);
    }
  });
  await expect(log).toContainText('vel=97', { timeout: 10_000 });
  await expect(log).not.toContainText('vel=0');
  // …and the label carries no momentary state that could freeze out of step
  // with the value beside it.
  await expect(log).toContainText('ch1[1X] NOTE 81');
  await expect(log).not.toContainText('NOTE 81 on');

  errorWatch.assertClean();
});

test('@trails spawning the module requests NO Web MIDI access', async ({ page, errorWatch }) => {
  // Loading a patch that happens to contain a TRAILS must not raise a
  // permission prompt. The access request is gesture-gated on the card's
  // CONNECT button and lives nowhere else.
  await installMidiMock(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tr', type: 'trails', position: { x: 200, y: 200 }, domain: 'audio' }]);

  await expect(page.getByTestId('trails-card-tr')).toBeVisible();
  const calls = await page.evaluate(() => {
    const w = globalThis as unknown as { __mockMidi: { accessCallCount(): number } };
    return w.__mockMidi.accessCallCount();
  });
  expect(calls, 'the factory must never ask for MIDI access').toBe(0);

  // The resting card names the state rather than sitting blank.
  await expect(page.getByTestId('trails-status-tr')).toContainText(/CONNECT/i);
  await expect(page.getByTestId('trails-pad-tr')).toBeVisible();

  errorWatch.assertClean();
});

test('@trails CONNECT with no Trails plugged in EXPLAINS the no rather than going quiet', async ({
  page,
  errorWatch,
}) => {
  // The mock's one input is named "Mock MIDI Input", which /trails/i must not
  // match — so this is also the port matcher's negative control on a real page.
  await installMidiMock(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tr', type: 'trails', position: { x: 200, y: 200 }, domain: 'audio' }]);

  await page.getByTestId('trails-connect-tr').click();

  const status = page.getByTestId('trails-status-tr');
  await expect(status).toContainText(/USB-C/, { timeout: 10_000 });
  await expect(status).toHaveAttribute('role', 'alert');

  const state = await trailsState(page, 'tr');
  expect(state?.status.kind).toBe('no-port');
  expect(state?.status.portNames, 'a foreign port must not be adopted').toEqual([]);

  errorWatch.assertClean();
});
