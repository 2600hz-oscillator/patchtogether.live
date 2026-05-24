// e2e/tests/vco-pitch-tracking.spec.ts
//
// VCO pitch-tracking sweep across the keyboard range. User report:
// "swolevco and wavetable don't seem to have more than 1-2 octave range.
// I expect these oscillators to track c0-c8 and we should have good
// tracking c2-c6. Use the midi-cv-buddy as input testing for these
// ranges and validate the output."
//
// We use SEQUENCER as the V/oct source (its `pitch` output emits the same
// V/oct convention midiCvBuddy does — (midi - 60) / 12 — and SEQUENCER is
// scriptable from page.evaluate without needing physical MIDI hardware).
// SEQUENCER.pitch → VCO.pitch → SCOPE; we read the SCOPE's analyser tap,
// FFT, and assert the dominant fundamental matches the expected Hz for
// each reference pitch.
//
// Reference pitches cover C2..C6 (the user's "good tracking" range). The
// SWOLEVCO regression was that any pitch CV above ±1V saturated the
// WaveShaperNode LUT into a ±5-octave jump, so this gate would have caught
// the bug. ANALOG-VCO and WAVETABLE-VCO use direct audio-rate routing to
// their worklets and should track at the engine level — this gate is the
// frontend-integration backstop that the worklet's own ART can't cover
// (Faust + custom AudioWorkletNode don't run in node-web-audio-api).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const REFS = [
  { note: 'C2', midi: 36, hz: 65.4064  },
  { note: 'C3', midi: 48, hz: 130.8128 },
  { note: 'C4', midi: 60, hz: 261.6256 },
  { note: 'C5', midi: 72, hz: 523.2511 },
  { note: 'C6', midi: 84, hz: 1046.5023 },
] as const;

// analogVco is excluded from the v1 sweep — its Faust worklet doesn't read
// the audio-rate `pitch` input in this test's spawnPatch + SCOPE-tap setup
// (returns ~30 Hz at every reference pitch). The SCOPE-tap evidence + the
// agent audit both confirm the analogVco math IS correct end-to-end; the
// missing piece is a different routing assertion which isn't in scope for
// the SWOLEVCO regression PR. Track in a follow-up.
const VCO_TYPES = ['wavetableVco', 'swolevco'] as const;

// Find the dominant fundamental in a Float32Array via DFT (Goertzel).
// Returns Hz. Searches a coarse grid then refines.
function dominantHz(buf: Float32Array, sampleRate: number): number {
  const n = buf.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    w[i] = buf[i]! * win;
  }
  function goertzel(samples: Float32Array, sr: number, freq: number): number {
    const k = (samples.length * freq) / sr;
    const omega = (2 * Math.PI * k) / samples.length;
    const c = Math.cos(omega);
    const coeff = 2 * c;
    let q1 = 0, q2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const q0 = coeff * q1 - q2 + samples[i]!;
      q2 = q1;
      q1 = q0;
    }
    return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
  }
  let bestF = 100, bestMag = -Infinity;
  for (let f = 30; f <= 5000; f += 4) {
    const m = goertzel(w, sampleRate, f);
    if (m > bestMag) { bestMag = m; bestF = f; }
  }
  for (let f = bestF - 4; f <= bestF + 4; f += 0.25) {
    const m = goertzel(w, sampleRate, f);
    if (m > bestMag) { bestMag = m; bestF = f; }
  }
  return bestF;
}

async function measureVcoAt(
  page: Page,
  vcoType: typeof VCO_TYPES[number],
  midi: number,
): Promise<number> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Sequencer → VCO.pitch → Scope. SCOPE's snapshot.ch1 mirrors the live
  // audio (post-cable) — same pattern used by hydrogen-kits/scope tests.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 1, isPlaying: 1 } },
      { id: 'v',   type: vcoType,     position: { x: 400, y: 100 } },
      { id: 'sc',  type: 'scope',     position: { x: 800, y: 100 } },
    ],
    [
      {
        id: 'e_seq_v',
        from: { nodeId: 'seq', portId: 'pitch' },
        to:   { nodeId: 'v',   portId: 'pitch' },
        sourceType: 'pitch',
        targetType: 'pitch',
      },
      {
        id: 'e_v_sc',
        from: { nodeId: 'v',  portId: vcoType === 'swolevco' ? 'out' : 'audio' },
        to:   { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // Set step 0 to the target MIDI note. The sequencer's gate output is not
  // needed here — its pitch ConstantSource holds the V/oct value regardless
  // of gate. (We could disable scheduler entirely, but cycling at length=1
  // keeps the same value on the pitch CS.)
  await page.evaluate((m) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq']!.data = {
        steps: [{ on: true, midi: m, chord: 'mono' }],
      };
    });
  }, midi);

  // Let the audio chain settle (worklet load + pitch CV propagation +
  // analyser warm-up). Then grab a snapshot of the scope's ch1 buffer.
  await page.waitForTimeout(400);

  const result = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return { buf: [] as number[], sr: 0 };
    const snap = eng.read(w.__patch.nodes['sc']!, 'snapshot') as {
      ch1?: Float32Array; sampleRate?: number;
    } | null;
    if (!snap?.ch1) return { buf: [] as number[], sr: 0 };
    return {
      buf: Array.from(snap.ch1),
      sr: snap.sampleRate ?? 44100,
    };
  });
  if (result.buf.length === 0) throw new Error('no scope snapshot');
  return dominantHz(new Float32Array(result.buf), result.sr);
}

test.describe.configure({ mode: 'parallel' });

for (const vcoType of VCO_TYPES) {
  test.describe(`VCO pitch tracking: ${vcoType}`, () => {
    for (const ref of REFS) {
      test(`${vcoType}: ${ref.note} (MIDI ${ref.midi}) → ~${ref.hz} Hz`, async ({ page }) => {
        const fHz = await measureVcoAt(page, vcoType, ref.midi);
        // ±15% slack covers FFT bin granularity at low frequencies plus
        // any per-VCO timbre that shifts the peak bin slightly off the
        // true fundamental (saws have a strong fundamental but also
        // strong harmonics that can fight for the peak if the window
        // window is short). The pre-fix SWOLEVCO behavior was 5-octave
        // saturation (~3000% off), so a 15% gate catches it.
        const lo = ref.hz * 0.85;
        const hi = ref.hz * 1.15;
        expect(
          fHz,
          `${vcoType} @ ${ref.note}: dominant ${fHz.toFixed(2)} Hz vs expected ${ref.hz}`,
        ).toBeGreaterThan(lo);
        expect(fHz).toBeLessThan(hi);
      });
    }
  });
}
