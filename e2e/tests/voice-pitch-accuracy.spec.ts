// e2e/tests/voice-pitch-accuracy.spec.ts
//
// DEFAULT-TUNING PITCH ACCURACY, REAL CHAIN — the owner guarantee "default
// tuning always leads to sequence notes matching reality": sequencing a note
// into a pitched voice AT FACTORY DEFAULTS must produce the correct
// real-world pitch (A440 standard) at the AUDIBLE output.
//
// The chain is the REAL one end to end (the poly-discipline lesson —
// engine-direct renders ship silent/wrong chains): SEQUENCER note (its own
// internal clock, S&H-latched pitch) → 1 V/oct pitch CV + gate → the voice
// (NO param overrides — the shipped defaults are the thing under test) →
// AUDIO OUT, measured on the terminal `outputSnapshot` tap (the limiter
// feeding ctx.destination — audibility and tuning from the same buffer).
//
// Measurement: YIN (packages/web/src/lib/audio/pitch-detect — the SCOPE
// tuner's estimator, imported node-side) bracketed one fifth around the
// expected note (a full voice's sub-octave square legitimately
// period-doubles an unbracketed estimator), MEDIAN over many analyser
// snapshots — a multi-oscillator default patch BEATS (one-sided OSC2 detune
// + unison spread), so single 2048-sample windows wobble by design.
//
// Bounds: the REAL-chain median must land within REAL_CHAIN_TOLERANCE_CENTS
// of the sequenced note. tidyVco's measured default center is ≈ +4.0¢ (the
// designed one-sided +6¢ OSC2 detune default; the V/oct core itself is
// exact to 0.01¢) — the deterministic ≤5¢ bound on that center is pinned by
// the unit tier (packages/web/src/lib/audio/default-pitch-accuracy.test.ts,
// byte-reproducible render → zero flake); this browser tier proves the LIVE
// chain lands on the SAME center, with 2¢ of margin for the 2048-window
// estimator spread on top of it.
//
// TWO NOTES per voice: C4 (MIDI 60 = 0 V) is the reality anchor — but 0 V
// is indistinguishable from an unpatched pitch input, so C5 (MIDI 72 = 1 V)
// is the chain-liveness control: a dead pitch cable would still read C4,
// and can never read C5.
//
// REGISTRY: add a row to PITCHED_VOICES to enroll a voice — batch-2 pitched
// voices (dx7, sixstrum, karplus) enroll the same check when they migrate.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { detectPitch } from '../../packages/web/src/lib/audio/pitch-detect';

test.describe.configure({ mode: 'parallel' });

/** ── THE REGISTRY — every pitched voice enrolls here ────────────────────
 *  `pitchPort`/`gatePort` = the voice's mono 1 V/oct pair; `outs` = its
 *  audio outputs (all wired to AUDIO OUT so the tap hears the whole bus). */
const PITCHED_VOICES = [
  { type: 'tidyVco', pitchPort: 'pitch', gatePort: 'gate', outs: ['out_l', 'out_r'] },
  // batch 2: { type: 'dx7', … }, { type: 'sixstrum', … }, { type: 'karplus', … }
] as const;

const REAL_CHAIN_TOLERANCE_CENTS = 6;

/** The sequenced notes: the reality anchor + the chain-liveness control. */
const NOTES = [
  { name: 'C4', midi: 60, hz: 261.6256 },
  { name: 'C5 (chain-liveness: 0 V ≡ unpatched, 1 V cannot be faked)', midi: 72, hz: 523.2511 },
] as const;

/** Read one terminal analyser snapshot off AUDIO OUT (the limiter tap). */
async function readOutputSnapshot(
  page: Page,
  outNodeId: string,
): Promise<{ samples: number[]; sampleRate: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const snap = eng.read(node, 'outputSnapshot') as { samples: Float32Array; sampleRate: number } | undefined;
    if (!snap) return null;
    return { samples: Array.from(snap.samples), sampleRate: snap.sampleRate };
  }, outNodeId);
}

for (const voice of PITCHED_VOICES) {
  for (const note of NOTES) {
    test(`${voice.type} @ FACTORY DEFAULTS: sequenced ${note.name} measures ≈ ${note.hz.toFixed(2)} Hz at the audible output`, async ({ page, rack, errorWatch }) => {
      void rack;
      await spawnPatch(
        page,
        [
          // The REAL default-mode mono source: the sequencer's internal
          // clock; length 1 so the latched (S&H) pitch is constant and the
          // gate re-opens every 250 ms at BPM 240 (gateLength 0.95 keeps
          // the voice sounding through nearly the whole cycle).
          { id: 'p-seq', type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio',
            params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.95 } },
          // THE VOICE — NO param overrides: factory-default tuning is the
          // system under test.
          { id: 'p-voice', type: voice.type, position: { x: 420, y: 60 }, domain: 'audio' },
          { id: 'p-out', type: 'audioOut', position: { x: 1050, y: 60 }, domain: 'audio',
            params: { master: 0.3 } },
        ],
        [
          { id: 'pe-gate', from: { nodeId: 'p-seq', portId: 'gate' }, to: { nodeId: 'p-voice', portId: voice.gatePort },
            sourceType: 'gate', targetType: 'gate' },
          // The melodic 1 V/oct path (polyPitchGate → cv, engine lane-0 split).
          { id: 'pe-pitch', from: { nodeId: 'p-seq', portId: 'pitch' }, to: { nodeId: 'p-voice', portId: voice.pitchPort },
            sourceType: 'polyPitchGate', targetType: 'cv' },
          ...voice.outs.map((out, i) => ({
            id: `pe-out${i}`,
            from: { nodeId: 'p-voice', portId: out },
            to: { nodeId: 'p-out', portId: i === 0 ? 'L' : 'R' },
            sourceType: 'audio', targetType: 'audio',
          })),
        ],
      );

      // Seed the sequenced note (chord 'mono' — one lane, no triad).
      await page.evaluate((midi) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const seq = w.__patch.nodes['p-seq'];
          if (!seq) return;
          if (!seq.data) seq.data = {};
          seq.data.steps = [
            { on: true, midi, chord: 'mono' },
            ...Array.from({ length: 31 }, () => ({ on: false, midi: null })),
          ];
        });
      }, note.midi);

      // Let the transport latch the pitch + open the first gate.
      await page.waitForTimeout(700);

      // ── Collect terminal snapshots; YIN each (bracketed one fifth around
      //    the expected note), then take the MEDIAN voiced reading. ──
      const minHz = note.hz / 1.5;
      const maxHz = note.hz * 1.55;
      const cents: number[] = [];
      let polled = 0;
      const deadline = Date.now() + 12_000;
      while (cents.length < 30 && Date.now() < deadline) {
        const snap = await readOutputSnapshot(page, 'p-out');
        polled += 1;
        if (snap && snap.samples.length >= 1024) {
          const r = detectPitch(new Float32Array(snap.samples), snap.sampleRate, { minHz, maxHz });
          // detectPitch RMS-gates silence (release troughs between gates)
          // and reports YIN confidence (cmnd — LOWER = more confident):
          // keep only solid periodic reads.
          if (r.hz != null && (r.confidence ?? 1) < 0.3) {
            cents.push(1200 * Math.log2(r.hz / note.hz));
          }
        }
        await page.waitForTimeout(90); // > the 2048-sample analyser span — fresh window each poll
      }

      // LIVENESS FIRST: the chain must actually sound (a dead graph must
      // fail here loudly, never pass a vacuous pitch check).
      expect(polled, 'the terminal tap was polled').toBeGreaterThan(10);
      expect(
        cents.length,
        `the real ${voice.type} chain is AUDIBLE at the terminal output (voiced YIN windows)`,
      ).toBeGreaterThanOrEqual(12);

      cents.sort((a, b) => a - b);
      const median = cents[cents.length >> 1]!;
      expect(
        Math.abs(median),
        `${voice.type} default tuning: sequenced ${note.name} measured ${median.toFixed(2)}¢ off ` +
          `${note.hz.toFixed(2)} Hz (must be ≤ ${REAL_CHAIN_TOLERANCE_CENTS}¢ — C4 must sound C4)`,
      ).toBeLessThanOrEqual(REAL_CHAIN_TOLERANCE_CENTS);

      errorWatch.assertClean();
    });
  }
}
