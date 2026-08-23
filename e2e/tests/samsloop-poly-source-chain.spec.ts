// e2e/tests/samsloop-poly-source-chain.spec.ts
//
// SAMSLOOP through the REAL SOURCE CHAIN — the CLAUDE.md poly/MIDI rule, in the
// shape this module actually has.
//
// ── WHY THE CHAIN LOOKS DIFFERENT HERE, AND WHY THAT STILL SATISFIES THE RULE ─
//
// The rule exists because POLYHELM shipped green-but-silent: ART, behavioural
// and per-port coverage all drove the ENGINE CLASS directly with a synthetic
// note source, so nobody noticed the real MIDI-LANE→module chain was dead. What
// it forbids is engine-direct testing, not a particular cable type.
//
// samsloop declares NO `poly` port and NO `pitch` input. Its voices are STRUCK
// BY GATE EDGES on `trig` (`edge: 'trigger'`), so the real default-mode source
// chain for this module is a real sequencer's TRIGGER output into that jack.
// POLYSEQZ is one of the two sources the rule names, and it is the right one
// here for a second reason: it needs no MIDI hardware and no WebMIDI mock, so
// this spec measures the module rather than the runner's device permissions.
//
// ── WHAT THE THREE TESTS ARE FOR ────────────────────────────────────────────
//
//   1. MONO — a real sequencer's clock drives real trigger edges and the OUT
//      carries audio. This is the anti-POLYHELM leg.
//   2. POLY — the same chain with `poly: 1`, where overlapping strikes layer
//      instead of stealing. Voices SUM, so the poly peak is at least the mono
//      one; asserting the ORDER rather than a magic level keeps it a property
//      of the mixer instead of a number that drifts with the fixture.
//   3. MUST-READ-ZERO — the same patch with NO cable into `trig`. samsloop is
//      IDLE-BY-DEFAULT (no autoplay), so this is genuinely silent, and it is a
//      PERMANENT NEGATIVE CONTROL on the instrument: if the sampler ever
//      manufactures signal, or the early-exit leaks into a silence assertion,
//      this goes red. Without it "the module sounds" and "the meter is stuck
//      high" print identically.
//
// ⚠ THE OBSERVATION IS A BOUNDED CONDITION, NOT A FIXED WINDOW — the
// adsr-poly-midilane argument, which applies here for the same mechanical
// reason: a gated voice cannot sound until the MAIN-THREAD step scheduler ticks
// past its lookahead, and how many ticks fit in a wall-clock window is a
// property of the runner. The audible tests observe UNTIL audible with a cap
// that BOUNDS THE FAILURE; the silence test deliberately watches the whole
// window, because "it never got loud" only means something if we never stopped
// looking.

import { test, expect } from './_fixtures';
import { spawnPatch, type SpawnNode } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const AUDIBLE_FLOOR = 0.01;
/** CAP that BOUNDS THE FAILURE; it is NOT the gate. A sounding voice ends the
 *  window the moment it crosses the floor. */
const AUDIBLE_CAP_MS = 8_000;
/** Full-window observation for the SILENCE leg — no early exit. */
const SILENCE_WINDOW_MS = 600;

function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 12_000;
}

/**
 * Give samsloop a sample to play, through the LEGACY `node.data.samples` path
 * the factory already hydrates.
 *
 * ⚠ A REAL BUFFER RATHER THAN A FILE UPLOAD, deliberately. Driving the file
 * picker would make this spec a test of `decodeAudioData` and of whatever
 * fixture asset it loaded; seeding PCM puts the SOURCE CHAIN under test and
 * nothing else. The content is a full-scale square so the analyser floor is
 * never the thing being measured — this spec asks "did a trigger reach the
 * worklet", not "is the level right".
 */
async function seedSample(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const N = 4800; // 100 ms at 48 k — long enough to survive a loop wrap.
    const pcm: number[] = [];
    for (let i = 0; i < N; i++) pcm.push(i % 100 < 50 ? 0.8 : -0.8);
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.samples = pcm;
      n.data.sampleLength = N;
      n.data.sampleRate = 48_000;
      n.data.fileName = 'e2e-square.wav';
    });
  }, nodeId);
}

/** Seed always-on steps so the sequencer's clock fires every step. */
async function seedSeqSteps(
  page: import('@playwright/test').Page,
  seqId: string,
): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      t.data.steps = [
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
      ];
    });
  }, seqId);
}

/** The patch, with the `trig` cable optional so the silence leg is the SAME
 *  rack minus exactly one edge — the only difference that can explain a
 *  different reading. */
function nodes(poly: number): SpawnNode[] {
  return [
    {
      id: 'seq', type: 'polyseqz', position: { x: 40, y: 60 }, domain: 'audio' as const,
      params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 },
    },
    {
      id: 'sl', type: 'samsloop', position: { x: 360, y: 60 }, domain: 'audio' as const,
      // mode 1 = loop, so a struck voice keeps sounding across the window; the
      // window is the WHOLE sample (0..1 as a fraction).
      params: { rate: 1, mode: 1, start: 0, end: 1, poly },
    },
    {
      id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio' as const,
      params: { timeMs: 50 },
    },
  ];
}

const OUT_TO_SCOPE = {
  id: 'e_sl_sc',
  from: { nodeId: 'sl', portId: 'out' },
  to: { nodeId: 'sc', portId: 'ch1' },
  sourceType: 'audio' as const,
  targetType: 'audio' as const,
};

const CLOCK_TO_TRIG = {
  id: 'e_seq_sl',
  from: { nodeId: 'seq', portId: 'clock' },
  to: { nodeId: 'sl', portId: 'trig' },
  sourceType: 'gate' as const,
  targetType: 'gate' as const,
};

test('MONO — a real POLYSEQZ clock strikes samsloop and the OUT carries audio', async ({
  page, rack, errorWatch,
}) => {
  test.setTimeout(timeoutFor(1));
  await spawnPatch(page, nodes(0), [CLOCK_TO_TRIG, OUT_TO_SCOPE]);
  await seedSample(page, 'sl');
  await seedSeqSteps(page, 'seq');

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `samsloop OUT should carry audio when a real sequencer clock strikes trig — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('POLY — the same chain layers instead of stealing, and stays audible', async ({
  page, rack, errorWatch,
}) => {
  test.setTimeout(timeoutFor(1));
  await spawnPatch(page, nodes(1), [CLOCK_TO_TRIG, OUT_TO_SCOPE]);
  await seedSample(page, 'sl');
  await seedSeqSteps(page, 'seq');

  // ⚠ THE ASSERTION IS AUDIBILITY, NOT A LEVEL. Voices SUM, so a poly rack is
  // at least as loud as a mono one — but pinning a ratio here would be pinning
  // the fixture's overlap, which depends on how many clock edges land inside
  // the sample's own length on THIS runner. What must hold on every machine is
  // that turning poly on does not SILENCE the module, which is the failure the
  // voice allocator could actually produce (a steal that never restarts).
  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `samsloop OUT should carry audio in POLY mode — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

/** Read the worklet's published playhead off the live engine handle. Returns
 *  null until the engine has mounted this node. */
async function readPlayhead(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<{ position: number; voices: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      // ⚠ A GETTER, not the engine — `Canvas.svelte` assigns `() => engine`.
      __engine?: () => { read(n: unknown, k: string): unknown } | null;
    };
    const node = w.__patch.nodes[id];
    const engine = w.__engine?.();
    if (!node || !engine) return null;
    try {
      const p = engine.read(node, 'playhead') as
        | { position?: number; voices?: number }
        | undefined;
      if (!p || typeof p.position !== 'number') return null;
      return { position: p.position, voices: p.voices ?? 0 };
    } catch {
      return null;
    }
  }, nodeId);
}

test('POLY → MONO retires the extra voices — they do not freeze in the pool', async ({
  page, rack, errorWatch,
}) => {
  test.setTimeout(timeoutFor(2));
  // ⚠ THE DEFECT THIS PINS, found by reading the worklet rather than by a red
  // test. The per-sample render loop only walks voice 0 when `poly` is false, so
  // voices started in POLY and still sounding at the switch were neither
  // rendered NOR advanced — they FROZE in the pool. Two visible consequences:
  // the playhead publish walks the whole pool, so a frozen voice could win the
  // newest-age lead and the faceplate would draw a playhead that never moves
  // again; and flipping back to POLY resurrected them mid-sample.
  //
  // ⚠ ASSERTED ON THE VOICE COUNT, which is the worklet's OWN report of its
  // pool — not on the audio, because a frozen voice is SILENT and the output
  // would sound correct while the pool was wrong. This is the only observable
  // that can tell the two apart.
  await spawnPatch(page, nodes(1), [CLOCK_TO_TRIG, OUT_TO_SCOPE]);
  await seedSample(page, 'sl');
  await seedSeqSteps(page, 'seq');

  // Let the sequencer strike several times so more than one voice is live.
  await expect
    .poll(async () => (await readPlayhead(page, 'sl'))?.voices ?? 0, { timeout: AUDIBLE_CAP_MS })
    .toBeGreaterThan(1);

  // Flip to MONO.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => { w.__patch.nodes['sl']!.params.poly = 0; });
  });

  // The pool must drain to at most the single mono voice. Polled, because the
  // worklet publishes on its own ~20 Hz clock rather than on the param write.
  await expect
    .poll(async () => (await readPlayhead(page, 'sl'))?.voices ?? 99, { timeout: AUDIBLE_CAP_MS })
    .toBeLessThanOrEqual(1);

  // And the module is still playing — draining the pool must not silence it.
  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(
    w.peak,
    `MONO must keep sounding after the switch — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('MUST-READ-ZERO — no cable into trig means SILENCE (idle-by-default)', async ({
  page, rack, errorWatch,
}) => {
  test.setTimeout(timeoutFor(1));
  // The SAME rack minus exactly one edge. samsloop has a sample loaded and a
  // running sequencer beside it; the only thing missing is the trigger.
  await spawnPatch(page, nodes(0), [OUT_TO_SCOPE]);
  await seedSample(page, 'sl');
  await seedSeqSteps(page, 'seq');

  // Deliberately NO `untilPeak`: watch the whole window, because "it never got
  // loud" is only meaningful if we never stopped looking.
  const w = await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS);
  expect(
    w.peak,
    `samsloop must stay SILENT until triggered — a loaded sample does not autoplay — ${describeScopeWindow(w)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);
});
