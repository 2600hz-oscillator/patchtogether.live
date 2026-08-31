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
/** Cap that BOUNDS THE FAILURE for the audible half; `untilPeak` is the gate. */
const AUDIBLE_CAP_MS = 6000;

interface TrailsSim {
  touch(ch: number, x: number, y: number): void;
  gateOn(ch: number): void;
  gateOff(ch: number): void;
  clock(n?: number): void;
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
    } | null;
  }, nodeId);
}

async function buildChain(page: Page): Promise<void> {
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
        id: 'e-x1',
        from: { nodeId: 'tr', portId: 'x1' },
        to: { nodeId: 'vca', portId: 'cv' },
        sourceType: 'cv',
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
  const after = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(after.polls, 'the SCOPE was sampled across the audible window').toBeGreaterThan(0);
  expect(
    after.rms,
    `a touch on x1 must open the VCA — ${describeScopeWindow(after)}`,
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
