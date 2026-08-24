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
// Measurement: the voice's DECLARED estimator (see TWO ESTIMATORS below —
// YIN from packages/web/src/lib/audio/pitch-detect, the SCOPE tuner's own,
// imported node-side; or the spectral fundamental), bracketed around the
// expected note (a full voice's sub-octave square legitimately period-doubles
// an unbracketed reader), MEDIAN over many analyser snapshots — a
// multi-oscillator default patch BEATS (one-sided OSC2 detune + unison
// spread), so single 2048-sample windows wobble by design.
//
// Bounds: the REAL-chain median must land within REAL_CHAIN_TOLERANCE_CENTS
// of the sequenced note. tidyVco's measured default center is ≈ +4.0¢ (the
// designed one-sided +6¢ OSC2 detune default; the V/oct core itself is
// exact to 0.01¢) — the deterministic ≤5¢ bound on that center is pinned by
// the unit tier (packages/web/src/lib/audio/default-pitch-accuracy.test.ts,
// byte-reproducible render → zero flake); this browser tier proves the LIVE
// chain lands on the SAME center, with 2¢ of margin for the 2048-window
// estimator spread on top of it. Measured here across 3 repeats: dx7 +0.28¢ /
// +0.21¢ (C4/C5, inter-quartile spread 0.00¢), sixstrum −3.56¢ / −3.49¢ (its
// designed SPREAD detune on the low string; IQR 0.26¢) — both landing on the
// SAME centers the deterministic unit tier renders offline.
//
// NOTE-ON CADENCE is per voice (`seqBpm`). The default BPM 240 re-gates every
// 250 ms, which puts an AM component at 4 Hz on the output — ±26¢ of sidebands
// at C4, right where a 42 ms window is trying to resolve a 6¢ question — and
// for a PLUCKED voice it also means the window almost never sees a rung-out
// string. Both batch-2 voices therefore sequence at BPM 60 (a note per second);
// it tightened dx7's inter-quartile spread from ~35¢ to 0¢ and moved
// sixstrum's median from a transient-dragged −7.8¢ onto its true −3.56¢.
// tidyVco is a sustained oscillator and keeps the original 240.
//
// TWO NOTES per voice: C4 (MIDI 60 = 0 V) is the reality anchor — but 0 V
// is indistinguishable from an unpatched pitch input, so C5 (MIDI 72 = 1 V)
// is the chain-liveness control: a dead pitch cable would still read C4,
// and can never read C5.
//
// REGISTRY: add a row to PITCHED_VOICES to enroll a voice — karplus, the last
// un-migrated batch-2 pitched voice, enrolls the same check when it migrates.
//
// TWO WIRINGS, because "the voice's REAL 1 V/oct path" is not the same port on
// every instrument and this spec exists precisely to drive the real one:
//   'mono' — the classic pitch-CV + gate pair (tidyVco, and dx7's legacy
//            single-voice route, which the worklet reads only while POLY is
//            unpatched — which is the case here).
//   'poly' — the polyPitchGate bus IS the voice's V/oct path. SIX STRUM has no
//            mono pitch input at all: its mono CHORD jack is a pitch-CLASS
//            root for the chord voicer (the octave comes from TUNING +
//            REGISTER), so wiring CHORD would measure the voicer, not the
//            tuning. Lane 0 → string 1 is where 1 V/oct actually lives.
// One cable carries both pitch and gate in the poly case, so those rows wire
// no separate gate — exactly how you would really play the module.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { detectPitch } from '../../packages/web/src/lib/audio/pitch-detect';

test.describe.configure({ mode: 'parallel' });

interface PitchedVoice {
  type: string;
  /** The voice's REAL 1 V/oct route (see the two-wirings note above). */
  wiring:
    | { kind: 'mono'; pitchPort: string; gatePort: string }
    | { kind: 'poly'; polyPort: string };
  /** Its audio outputs — all wired to AUDIO OUT so the tap hears the whole bus. */
  outs: string[];
  /** How "the pitch" is read off a 2048-sample terminal window. See the
   *  TWO ESTIMATORS note below. Defaults to 'period'. */
  estimator?: 'period' | 'fundamental';
  /** Sequencer BPM override (default 240 = a note-on every 250 ms). A
   *  PLUCKED voice needs its note to actually RING before the next strike:
   *  the 42 ms analyser window is measuring a transient otherwise. */
  seqBpm?: number;
}

// TWO ESTIMATORS, because "the pitch" of a 42 ms window is only unambiguous
// for a harmonic tone, and both batch-2 voices break that assumption:
//
//   'period'      — YIN on the raw window (the original estimator; what a
//                   period-tracking tuner does). Correct for a harmonic voice
//                   like tidyVco.
//   'fundamental' — the frequency of the FIRST PARTIAL, found as the peak of
//                   the Hann-windowed |X(f)| curve (a two-pass Goertzel scan)
//                   within ±6 % of the expected note. What a spectrum analyser
//                   reads.
//
// The two agree on a harmonic tone and diverge exactly where the physics says
// they should — which is why each voice DECLARES the one that answers "is this
// module in tune":
//
//   * SIX STRUM is an inharmonic plucked string. Its damping loop-filter adds
//     more phase delay at higher frequencies, so its partials sit progressively
//     FLAT of the harmonic series (measured on the pure core: f1 exact, f2/2 at
//     −13.5 ¢, f3/3 at −15.1 ¢). A time-domain period estimator returns an
//     amplitude-weighted compromise across those partials, so it reads ~14 ¢
//     flat while the attack is bright and glides up to the fundamental as the
//     upper partials damp away (−27 ¢ at 20 ms → −4 ¢ at 1 s). Nothing is out
//     of tune: the FUNDAMENTAL is rock-steady at −3.56 ¢ (SPREAD's designed
//     detune on the low string) for the whole decay, and at +0.02 ¢ with SPREAD
//     zeroed. So the string's tuning is the fundamental, and this is the tier
//     that has to say so. (Worth knowing when playing it: a PERIOD-tracking
//     tuner or a pitch-tracker patched to SIX STRUM will read the attack of a
//     plucked note ~10-15 ¢ flat. That is the instrument's inharmonicity, not
//     a tuning error — the same thing happens to a tuner on a real guitar.)
//   * DX7 at its default E.PIANO 1 preset is a high-index FM voice; on a 42 ms
//     window YIN periodically locks onto a competing minimum ~100 ¢ up (its
//     confidence collapses from ~0.001 to ~0.08 when it does, which is the
//     tell). The first partial is unambiguous.
//
// The deterministic unit tier measures both voices over long windows deep in
// the note, where the two estimators converge — the two tiers agree on the
// same numbers, from opposite directions.

/** ── THE REGISTRY — every pitched voice enrolls here ─────────────────── */
const PITCHED_VOICES: PitchedVoice[] = [
  { type: 'tidyVco', wiring: { kind: 'mono', pitchPort: 'pitch', gatePort: 'gate' }, outs: ['out_l', 'out_r'] },
  // P1 batch 2 — the two pitched voices promoted with their faces.
  // dx7: the mono PITCH CV + GATE pair (POLY left unpatched, which is what
  // makes the worklet read it). Its shipped default preset carries the
  // patch's own stored transpose, so this also pins "a fresh dx7 is in tune".
  { type: 'dx7', wiring: { kind: 'mono', pitchPort: 'pitch_cv', gatePort: 'gate' }, outs: ['out'], estimator: 'fundamental', seqBpm: 60 },
  // sixstrum: POLY lane 0 → string 1 (see the two-wirings note). Each gate
  // rising edge re-plucks the string, so the tap stays voiced across the poll.
  { type: 'sixstrum', wiring: { kind: 'poly', polyPort: 'poly' }, outs: ['out'], estimator: 'fundamental', seqBpm: 60 },
];

const REAL_CHAIN_TOLERANCE_CENTS = 6;

/** Hann-windowed Goertzel magnitude at `f`. */
function goertzelMag(buf: Float32Array, f: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * f) / sr);
  const n = buf.length;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = buf[i]! * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

/** Peak of |X(f)| within ±6 % of `around` — coarse 1 Hz sweep, then a 0.02 Hz
 *  refinement (a flat scan at 0.02 Hz would be ~150× the work for the same
 *  answer). Returns null when the window is too quiet to mean anything. */
function spectralFundamental(buf: Float32Array, sr: number, around: number): number | null {
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i]! * buf[i]!;
  if (Math.sqrt(energy / buf.length) < 0.002) return null; // silence gate (mirrors detectPitch's)

  const lo = around * 0.94;
  const hi = around * 1.06;
  let best = around;
  let bestMag = -1;
  for (let f = lo; f <= hi; f += 1) {
    const m = goertzelMag(buf, f, sr);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  const fineLo = Math.max(lo, best - 1.5);
  const fineHi = Math.min(hi, best + 1.5);
  for (let f = fineLo; f <= fineHi; f += 0.02) {
    const m = goertzelMag(buf, f, sr);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  return best;
}

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

// ── ⏸ FLAKE-PARK #1847 ──────────────────────────────────────────────────────
// tidyVco failed then PASSED ON RETRY at the same SHA on BOTH notes during the
// 96 h CI census to 2026-08-18 (C4: 4 observations; C5: 11 across 6 SHAs and 6
// branches). Every one of those jobs reported SUCCESS, so the debt never showed
// in the green/red signal. Parked with `test.fixme`, not deleted; the assertion
// body below is untouched and still runs for every other PITCHED_VOICE.
// LOST WHILE PARKED: the owner guarantee that "default tuning always leads to
// sequence notes matching reality" FOR TIDYVCO — a sequenced note at SHIPPED
// DEFAULTS (no param overrides) measuring the right real-world Hz at the AUDIBLE
// output, through the REAL sequencer→1 V/oct→voice chain. The C5 leg additionally
// carries the chain-liveness argument (0 V is indistinguishable from unpatched,
// so only the 1 V case proves the cable is live) — parking it removes the only
// non-fakeable leg for this voice.
// Parked per VOICE, so both notes go together; re-enable only on a root cause
// (#1847), never because "it passes now".
const FLAKE_PARK_1847: Record<string, string> = {
  tidyVco:
    'FLAKE-PARK #1847 — nondeterministic on CI: 15 recovered-on-retry observations across both notes in the 96 h census to 2026-08-18; parked until root-caused',
};

for (const voice of PITCHED_VOICES) {
  for (const note of NOTES) {
    const parkReason = FLAKE_PARK_1847[voice.type];
    if (parkReason) {
      test.fixme(
        `${voice.type} @ FACTORY DEFAULTS: sequenced ${note.name} measures ≈ ${note.hz.toFixed(2)} Hz at the audible output`,
        { annotation: { type: 'fixme', description: parkReason } },
        () => {
          /* FLAKE-PARKED — see FLAKE_PARK_1847 and #1847 */
        },
      );
      continue;
    }
    test(`${voice.type} @ FACTORY DEFAULTS: sequenced ${note.name} measures ≈ ${note.hz.toFixed(2)} Hz at the audible output`, async ({ page, rack, errorWatch }) => {
      void rack;
      await spawnPatch(
        page,
        [
          // The REAL default-mode mono source: the sequencer's internal
          // clock; length 1 so the latched (S&H) pitch is constant and the
          // gate re-opens every step (gateLength 0.95 keeps the voice
          // sounding through nearly the whole cycle). BPM 240 = a step every
          // 250 ms; a voice that needs longer between note-ons overrides it.
          { id: 'p-seq', type: 'kria', position: { x: 60, y: 60 }, domain: 'audio',
            params: { bpm: voice.seqBpm ?? 240, length: 1, isPlaying: 1, gateLength: 0.95 } },
          // THE VOICE — NO param overrides: factory-default tuning is the
          // system under test.
          { id: 'p-voice', type: voice.type, position: { x: 420, y: 60 }, domain: 'audio' },
          { id: 'p-out', type: 'audioOut', position: { x: 1050, y: 60 }, domain: 'audio',
            params: { master: 0.3 } },
        ],
        [
          ...(voice.wiring.kind === 'mono'
            ? [
                { id: 'pe-gate', from: { nodeId: 'p-seq', portId: 'gate' }, to: { nodeId: 'p-voice', portId: voice.wiring.gatePort },
                  sourceType: 'gate', targetType: 'gate' },
                // The melodic 1 V/oct path (polyPitchGate → cv, engine lane-0 split).
                { id: 'pe-pitch', from: { nodeId: 'p-seq', portId: 'pitch' }, to: { nodeId: 'p-voice', portId: voice.wiring.pitchPort },
                  sourceType: 'polyPitchGate', targetType: 'cv' },
              ]
            : [
                // The poly bus carries the lane's pitch AND its gate on one
                // cable — the module's real melodic route.
                { id: 'pe-poly', from: { nodeId: 'p-seq', portId: 'pitch' }, to: { nodeId: 'p-voice', portId: voice.wiring.polyPort },
                  sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
              ]),
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

      // ── Collect terminal snapshots, measure each with the voice's declared
      //    estimator (both bracketed around the expected note — a voice's own
      //    sub-octave content legitimately period-doubles an unbracketed
      //    reader), then take the MEDIAN reading. ──
      const minHz = note.hz / 1.5;
      const maxHz = note.hz * 1.55;
      const estimator = voice.estimator ?? 'period';
      const cents: number[] = [];
      let polled = 0;
      const deadline = Date.now() + 12_000;
      while (cents.length < 30 && Date.now() < deadline) {
        const snap = await readOutputSnapshot(page, 'p-out');
        polled += 1;
        if (snap && snap.samples.length >= 1024) {
          const buf = new Float32Array(snap.samples);
          if (estimator === 'period') {
            const r = detectPitch(buf, snap.sampleRate, { minHz, maxHz });
            // detectPitch RMS-gates silence (release troughs between gates)
            // and reports YIN confidence (cmnd — LOWER = more confident):
            // keep only solid periodic reads.
            if (r.hz != null && (r.confidence ?? 1) < 0.3) {
              cents.push(1200 * Math.log2(r.hz / note.hz));
            }
          } else {
            const hz = spectralFundamental(buf, snap.sampleRate, note.hz);
            if (hz != null) cents.push(1200 * Math.log2(hz / note.hz));
          }
        }
        await page.waitForTimeout(90); // > the 2048-sample analyser span — fresh window each poll
      }

      // LIVENESS FIRST: the chain must actually sound (a dead graph must
      // fail here loudly, never pass a vacuous pitch check). Both estimators
      // return nothing for a silent window, so an empty/short reading set is
      // a dead graph, not a tuning result.
      expect(polled, 'the terminal tap was polled').toBeGreaterThan(10);
      expect(
        cents.length,
        `the real ${voice.type} chain is AUDIBLE at the terminal output (measurable windows)`,
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
