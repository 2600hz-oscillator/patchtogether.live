// e2e/tests/kria.spec.ts
//
// KRIA real-source-chain proof (the poly/real-source discipline): a running
// KRIA pattern, clocked by the rack's TIMELORDE, must drive a downstream VOICE
// to AUDIBLE output — not just "an edge materializes". The chain is the real one
// a user builds:
//
//   kria.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   kria.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// With NO pattern seeded the tracks fire nothing → ch1 is silent. After seeding
// a running pattern on track 0 (via the same Y.Doc path the card/grid use), the
// track's gates pulse the VCA open at the pattern's pitch → audible, structured
// RMS at the scope. The pre→post delta proves the running pattern actually
// produces sound through the real spawn + engine + TIMELORDE clock lock
// (catches the green-but-silent class).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

test('KRIA: running pattern clocked by TIMELORDE → VCO+VCA → audible gated RMS (silent until seeded)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      // TIMELORDE runs by default (running=1); fast tempo so gate pulses land in
      // the measurement window.
      { id: 'a-tl', type: 'timelorde', position: { x: 60, y: 360 }, domain: 'audio',
        params: { bpm: 240 } },
      { id: 'a-kria', type: 'kria', position: { x: 60, y: 60 }, domain: 'audio',
        params: { bpm: 240 } },
      { id: 'a-vco', type: 'analogVco', position: { x: 460, y: 60 }, domain: 'audio' },
      { id: 'a-vca', type: 'vca', position: { x: 760, y: 60 }, domain: 'audio',
        // base 0 → fully closed when cv=0; cvAmount 1 → gate opens it fully.
        params: { base: 0, cvAmount: 1 } },
      { id: 'a-scp', type: 'scope', position: { x: 1040, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      // track 1 pitch → VCO v/oct
      { id: 'e1', from: { nodeId: 'a-kria', portId: 'pitch1' }, to: { nodeId: 'a-vco', portId: 'pitch' },
        sourceType: 'pitch', targetType: 'pitch' },
      // VCO tone → VCA audio in
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'sine' }, to: { nodeId: 'a-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      // track 1 gate → VCA cv (opens the amp while a note sounds)
      { id: 'e3', from: { nodeId: 'a-kria', portId: 'gate1' }, to: { nodeId: 'a-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      // gated voice → scope ch1
      { id: 'e4', from: { nodeId: 'a-vca', portId: 'audio' }, to: { nodeId: 'a-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-kria');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('KRIA');

  // Before any pattern is seeded the tracks fire nothing → silent.
  const before = await readScopePeakOverWindow(page, 'a-scp', 500);
  expect(before.rms, `silent before a pattern is seeded`).toBeLessThan(0.03);

  // Seed a running pattern on track 0 via the same Y.Doc path the card/grid use:
  // all 16 steps trigged at degree 0 + octave +2 (MIDI 72 = +1 V/oct ≠ 0V).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const STEPS = 16;
    const track = () => ({
      trig: new Array(STEPS).fill(true),
      ratchet: new Array(STEPS).fill(1),
      note: new Array(STEPS).fill(0),
      octave: new Array(STEPS).fill(2),
      duration: new Array(STEPS).fill(0.8),
      probability: new Array(STEPS).fill(1),
      glide: new Array(STEPS).fill(0),
      loopStart: 0,
      loopLength: STEPS,
      timeDivision: 1,
      direction: 'forward',
      muted: false,
    });
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-kria'];
      if (!n.data) n.data = {};
      n.data.active = 0;
      n.data.cued = null;
      n.data.cueSteps = 0;
      n.data.patterns = {
        '0': { scale: 'major', root: 48, tracks: [track(), track(), track(), track()] },
      };
    });
  });

  // Max-hold over a window so the assertion is renderer/timing-tolerant on CI.
  const after = await readScopePeakOverWindow(page, 'a-scp', 1500);
  expect(after.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
  expect(after.rms, `audible gated RMS after seeding the pattern`).toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, `structured signal, not a glitch`).toBeGreaterThan(50);
  expect(after.rms, `seeding the pattern raised the output`).toBeGreaterThan(before.rms + 0.02);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
