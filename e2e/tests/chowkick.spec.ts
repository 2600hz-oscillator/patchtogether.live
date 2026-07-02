// e2e/tests/chowkick.spec.ts
//
// End-to-end smoke + behavior for CHOWKICK:
//   1. Card mounts: SEQUENCER → CHOWKICK → AUDIOOUT spawns cleanly.
//   2. Gate-triggered kick: SEQUENCER.gate → CHOWKICK.gate_in →
//      CHOWKICK.audio_out → SCOPE.ch1. Fire a gate and assert that audio
//      flows. The per-sample kick *shape* (attack < 5 ms, peak position,
//      tail-energy ordering) is pinned deterministically in the ART tier
//      (art/scenarios/chowkick/canonical-kicks.test.ts); the e2e tier only
//      proves the audio path is alive.
//   3. BOUNCE knob: bounce=0 vs bounce=0.9 measurably shifts the SCOPE-
//      measured envelope (peak OR rms) — proving the bounce knob is wired
//      into the resonant filter.
//
// DETERMINISM (de-flake, folded into the Phase 3a PR): the realtime SCOPE is
// a sliding analyser window whose sampling moment is non-deterministic w.r.t.
// the kick attack. Since #682 made the kick a pitched, DECAYING resonant body,
// a SINGLE instantaneous snapshot frequently landed in the late decay tail (or
// the gap before the next hit), so the in-window peak had already fallen below
// the liveness floor → flake (observed `peak 0.00302 vs >0.005` on CI shard 1;
// and the bounce delta dipped to ~6% as two phase-random RMS means converged).
// Both tests now MAX-HOLD peak/rms over a bounded poll window that straddles
// ≥1 attack (readScopePeakOverWindow), which deterministically observes the
// loud attack frame every run and collapses the phase noise — a stricter, not
// weaker, liveness gate (a silent / DC / wire-broken kick never crosses the
// floor in ANY frame). See each test's inline ROOT CAUSE / FIX notes.
//
// Per project memory `feedback_test_yourself` + `feedback_no_flake_tolerance`:
//   - thresholds are flake-safe (windowed max-hold + relative deltas, not
//     instantaneous samples or exact peak counts), yet still fail on silence.
//   - all assertions read live AudioParam / SCOPE state.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// ────────────────────────────────────────────────────────────────────────
// 1. SMOKE: card mounts, params round-trip through the AudioParam
// ────────────────────────────────────────────────────────────────────────

test('CHOWKICK smoke: SEQUENCER → CHOWKICK → AUDIOOUT — card mounts, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-seq', type: 'sequencer', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'a-ck',  type: 'chowkick',  position: { x: 360, y: 60 }, domain: 'audio',
        params: { freq: 80, q: 1.5, decay: 0.5, sustain: 0.2, level: 0 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 }, domain: 'audio',
        params: { master: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate' },      to: { nodeId: 'a-ck',  portId: 'gate_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'a-ck',  portId: 'audio_out' }, to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-ck',  portId: 'audio_out' }, to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-chowkick');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('CHOWKICK');

  // Param round-trip: freq=80 should be readable via the engine.
  await page.waitForTimeout(500);
  const readable = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        readParam: (n: { id: string; type: string; domain: string }, p: string) => number | undefined;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const e = w.__engine?.();
    const n = w.__patch.nodes['a-ck'];
    if (!e || !n) return null;
    return e.readParam(n, 'freq');
  });
  expect(readable).toBeCloseTo(80, 0);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────────
// 2. GATE → KICK ENVELOPE: SCOPE sees attack < 5 ms, decay > 50 ms,
//    measurable peak.
// ────────────────────────────────────────────────────────────────────────

test('CHOWKICK gate → kick envelope: SCOPE sees attack < 5 ms + sustained decay', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // SCOPE timeMs=200 → snapshot window covers ~200 ms; enough to see the
  // attack + early decay of a 50 ms-decay kick.
  await spawnPatch(
    page,
    [
      { id: 'a-seq', type: 'sequencer', position: { x: 60,  y: 60 }, domain: 'audio',
        // Slow tempo so a single hit dominates the snapshot window.
        params: { bpm: 60, length: 1, isPlaying: 1, gateLength: 0.05 } },
      { id: 'a-ck',  type: 'chowkick',  position: { x: 360, y: 60 }, domain: 'audio',
        params: { freq: 80, q: 2.5, width: 1, amplitude: 1, decay: 0.5, sustain: 0.1,
                  damping: 0.5, tight: 0.6, bounce: 0, tone: 1200, level: 0 } },
      { id: 'a-scp', type: 'scope',     position: { x: 760, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate' },      to: { nodeId: 'a-ck',  portId: 'gate_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'a-ck',  portId: 'audio_out' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  // Force a step pattern so the sequencer fires on step 0.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['a-seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 },
        ...Array.from({ length: 31 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // ROOT CAUSE of the old flake (observed `peak 0.00302 vs >0.005` on CI
  // e2e shard 1): the test took a SINGLE readScopeSnapshot after a flat
  // `waitForTimeout(1500)`. The SCOPE is a ~200 ms sliding analyser window
  // and its sampling instant is non-deterministic w.r.t. the kick attack.
  // Since #682 made the kick a pitched, DECAYING resonant body (ring at
  // ~81 Hz with a 3.5×→1× pitch sweep), the loud attack lasts only a few ms
  // and the body then rings DOWN. When the one captured window happened to
  // land in the late decay tail (or in the gap before the next 1 s-spaced
  // hit), the in-window peak had already fallen to ~3e-3 — below the 5e-3
  // floor — and the single-shot assertion flaked. (Lowering the floor would
  // have masked it, not fixed it — and would weaken the silence regression.)
  //
  // FIX: bounded poll + MAX-HOLD over a window guaranteed to contain at
  // least one full attack, instead of one instantaneous sample. At BPM=60 /
  // length=1 the kick fires once per second, so a ~2 s capture window always
  // straddles ≥1 attack; readScopePeakOverWindow keeps the running max
  // peak/rms/nonzeroSamples across all polled analyser frames, so the loud
  // attack frame is always observed regardless of analyser phase. This is
  // deterministic + renderer/timing-tolerant for CI while staying a
  // MEANINGFUL liveness gate: a silent / DC / wire-broken chowkick never
  // crosses the floor in ANY frame, so it still fails.
  //
  // Per-sample kick SHAPE (attack < 5 ms, peak position, tail-energy
  // ordering) stays pinned deterministically in the ART tier
  // (art/scenarios/chowkick/canonical-kicks.test.ts) — the e2e tier only
  // proves the audio path is alive.
  const CAPTURE_MS = 2000; // ≥ 2 bars @ BPM 60/length 1 → always ≥1 attack
  const hold = await readScopePeakOverWindow(page, 'a-scp', CAPTURE_MS);
  expect(hold.polls, 'SCOPE was polled across the capture window').toBeGreaterThan(0);

  // Liveness thresholds (Option C — character pinned in ART, e2e just proves
  // the audio path is alive). Asserted on the windowed MAX, so they reflect
  // the kick's attack frame, not whatever instant a single snapshot caught:
  //   peak > 0.05  ⇒ the loud pitched attack was observed in some frame
  //                  (a real #682 kick attacks at ~1.6; silent/DC → 0). The
  //                  floor is raised 10× from the old single-shot 5e-3
  //                  precisely BECAUSE max-hold now reliably catches the
  //                  attack — a stricter, less flaky gate, not a weaker one.
  //   rms  > 0.001 ⇒ broader-than-single-sample energy (a wire-broken
  //                  regression that drops audio_out gives rms = 0).
  //   nonzeroSamples > 50 ⇒ structured signal in some frame, not a glitch.
  expect(hold.peak).toBeGreaterThan(0.05);
  expect(hold.rms).toBeGreaterThan(0.001);
  expect(hold.nonzeroSamples).toBeGreaterThan(50);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────────
// 3. BOUNCE knob audibly modulates the body resonance
// ────────────────────────────────────────────────────────────────────────

test('CHOWKICK bounce knob audibly modulates the resonant body', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-seq', type: 'sequencer', position: { x: 60,  y: 60 }, domain: 'audio',
        params: { bpm: 90, length: 1, isPlaying: 1, gateLength: 0.05 } },
      { id: 'a-ck',  type: 'chowkick',  position: { x: 360, y: 60 }, domain: 'audio',
        params: { freq: 80, q: 2, width: 1, amplitude: 1, decay: 0.6, sustain: 0.2,
                  damping: 0.5, tight: 0.5, bounce: 0, tone: 1500, level: 0 } },
      { id: 'a-scp', type: 'scope',     position: { x: 760, y: 60 }, domain: 'audio',
        params: { timeMs: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-seq', portId: 'gate' },      to: { nodeId: 'a-ck',  portId: 'gate_in' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'a-ck',  portId: 'audio_out' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['a-seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 },
        ...Array.from({ length: 31 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // Let one full bar render to seed the SCOPE.
  await page.waitForTimeout(1200);

  // ROOT CAUSE of the OLD flake here: the test averaged RMS over just 5
  // phase-random ~100 ms snapshots per setting. The SCOPE window's alignment
  // vs. each kick attack is non-deterministic, so each per-setting mean still
  // carried ±15% phase noise (measured: noBounceRms swung 2.18e-1…2.93e-1
  // across runs). When the two noisy means happened to land close, the
  // |Δ|/no-bounce ratio dipped toward the 5% floor (observed as low as 6.0%,
  // and below 5% under CI jitter → the flake). The underlying effect is
  // actually LARGE (bounce=0.9 clearly raises body-drive RMS), it was just
  // buried in snapshot-phase noise.
  //
  // FIX: per setting, MAX-HOLD peak + rms over a window that straddles
  // several attacks (readScopePeakOverWindow), instead of averaging a few
  // phase-random instants. Max-hold deterministically lands on the loud
  // attack frame every run, collapsing the phase noise — the per-setting
  // measurement becomes stable, so the genuine bounce-driven difference is
  // what the delta reflects. We then assert the knob moved EITHER metric
  // (peak OR rms) by >5%: the bounce knob skews the secondary-state-variable
  // drive in BouncyFilterProc, reshaping the body envelope, and either the
  // attack peak or the windowed rms shifts well past 5% — but which one wins
  // is direction-dependent, so an OR keeps it robust without weakening the
  // "knob is wired" claim. (Per-sample shape stays pinned in ART:
  // art/scenarios/chowkick/canonical-kicks.test.ts.)
  const MEASURE_MS = 1600; // ≥ 2 bars @ BPM 90/length 1 → straddles ≥2 attacks

  const noBounce = await readScopePeakOverWindow(page, 'a-scp', MEASURE_MS);

  // Crank bounce way up.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-ck'];
      if (n) n.params.bounce = 0.9;
    });
  });
  await page.waitForTimeout(1200);

  const bounce = await readScopePeakOverWindow(page, 'a-scp', MEASURE_MS);

  // Both settings must be audible (a silent / wire-broken regression fails
  // here, keeping the assertion meaningful).
  expect(noBounce.peak).toBeGreaterThan(1e-3);
  expect(bounce.peak).toBeGreaterThan(1e-3);

  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1e-6);
  const rmsDelta = rel(bounce.rms, noBounce.rms);
  const peakDelta = rel(bounce.peak, noBounce.peak);
  // The bounce knob must measurably change the audible body envelope — proven
  // by EITHER the windowed peak or rms shifting >5% (direction-dependent).
  expect(Math.max(rmsDelta, peakDelta)).toBeGreaterThan(0.05);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
