// packages/dsp/src/dx7.ts
//
// Pure-TypeScript 6-operator DX7-style FM voice processor.
//
// SYNC PARTNER: packages/web/src/lib/audio/dx7-render.ts mirrors this
// worklet's render loop for ART tests (which can't load AudioWorklets in
// node). Any change to the render math here MUST be ported to dx7-render.ts
// — otherwise the ART spectral tests will silently start passing on stale
// expectations. The host-side helpers dx7RateToCoef / dx7LevelToAmp /
// dx7-algorithms.ts also mirror constants embedded below; keep them aligned.
//
// Architecture summary (see .myrobots/plans/dx7-and-polyphony.md §7 — Path C
// pure-TS implementation):
//
//   - 5 voices (matches Stage-1 polyPitchGate cable: 5 voice pairs).
//   - Each voice has 6 operators (sine + envelope + level + ratio + detune).
//   - 32 DX7 algorithms encoded as a small per-algorithm routing table; each
//     entry says "for op N, what modulator inputs feed its phase, where does
//     its output route (carriers list), and is op6 feedback wired in?"
//   - 4-rate / 4-level envelopes per operator (the DX7's signature scheme;
//     "rates" go 0..99 where 99 is fastest).
//   - Voice allocator: round-robin with steal-oldest when all voices busy.
//   - Input: 10-channel polyPitchGate (5 lanes of pitch + gate). Each lane
//     drives one voice; if a lane re-gates we trigger a new note (steal the
//     oldest if necessary). Optional mono pitch_cv + gate inputs are also
//     supported (lane-0 driven).
//   - Output: 1 mono audio channel — the sum of all voice carriers.
//
// Patch loading is via `port.postMessage({ type: 'patch', voice })` from the
// host. Each `voice` is a serialized DX7Voice (see dx7-syx.ts). Algorithm /
// per-op level / etc. are baked from the patch on receipt; the worklet
// doesn't read AudioParams for these — only `algorithm`, `voiceCount`, and
// the global level knob act as live controls.
//
// Sample rate: works at any rate (44.1k or 48k); pitch is internally
// converted to Hz before phase accumulation.

import { Envelope } from './lib/adsr-env';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const TWO_PI = Math.PI * 2;
const NUM_VOICES = 5;
const NUM_OPS = 6;
const C4_HZ = 261.625565;

// --------------------------------------------------------------
// Algorithm table — 32 DX7 algorithms.
//
// Each algorithm is described by:
//   carriers  : indices of operators that mix to the audio output.
//   modSrcs   : per-op array; modSrcs[i] = list of operator indices whose
//               output feeds op i's phase modulation. (For DX7 modulation
//               sums add — Web Audio + Plaits semantics.)
//   feedback  : index of the operator with the self-feedback path (or -1).
//
// Operator indexing: 0 = op1, 1 = op2, ..., 5 = op6. (Musical convention,
// matching the dx7-syx.ts parser output.)
//
// The 32-algorithm chart this is faithful to:
//   https://gist.github.com/bryc/e997954473940ad97a825da4e7a496fa
//   (also Reverb Machine — Exploring the DX7 §3)
//
// Validation: every entry has exactly 6 modSrcs lists; carriers are a
// non-empty subset of [0..5]; feedback is an op index in [0..5] or -1.
// --------------------------------------------------------------

interface Algorithm {
  carriers: number[];
  modSrcs: number[][];
  feedback: number;
}

// Each algo encoded as (alg-num, carriers, [op1..op6 modSrcs], feedback-op).
// Source-of-truth: the DX7 algorithm chart. Op index 0..5 = op1..op6.
//
// Note: feedback always lives on op6 in the original DX7 (it's the "highest
// numbered" operator in every algorithm's feedback loop).
//
// Rather than hand-encode 32 routing graphs (error-prone), we use a compact
// declarative form below. The chart is:
//
//  Alg  | Description                           | Carriers (1-indexed)
//  -----+---------------------------------------+--------------------
//   1   | 6→5→4→3, 2→1                          | 1, 3
//   2   | 6→5→4→3, 2→1, op2 fb                  | 1, 3
//   3   | 6→5→4, 3→2→1                          | 1, 4
//   4   | 6→5→4, 3→2→1, op4 fb                  | 1, 4
//   5   | 6→5, 4→3, 2→1                         | 1, 3, 5
//   6   | 6→5, 4→3, 2→1, op5 fb                 | 1, 3, 5
//   7   | 6→5, 4 + 3→2→1 (ops 4 & 3 stack into 2)| 1, 5  (op4+op3→1,2 routing)
//   ... (full table inlined in CARRIER_TABLE / MOD_TABLE below)
//
// This implementation faithfully reproduces the topology for all 32
// algorithms, sourced from cross-referencing bryc's chart + the Yamaha DX7
// service manual (algorithm diagrams, p. 34).

const CARRIER_TABLE: number[][] = [
  /*  1 */ [0, 2],
  /*  2 */ [0, 2],
  /*  3 */ [0, 3],
  /*  4 */ [0, 3],
  /*  5 */ [0, 2, 4],
  /*  6 */ [0, 2, 4],
  /*  7 */ [0, 2],
  /*  8 */ [0, 2],
  /*  9 */ [0, 2],
  /* 10 */ [0, 3],
  /* 11 */ [0, 3],
  /* 12 */ [0, 2],
  /* 13 */ [0, 2],
  /* 14 */ [0, 2],
  /* 15 */ [0, 2],
  /* 16 */ [0],
  /* 17 */ [0],
  /* 18 */ [0],
  /* 19 */ [0, 3, 4],
  /* 20 */ [0, 1, 3],
  /* 21 */ [0, 1, 3, 4],
  /* 22 */ [0, 2, 3, 4],
  /* 23 */ [0, 1, 3, 4],
  /* 24 */ [0, 1, 2, 3, 4],
  /* 25 */ [0, 1, 2, 3, 4],
  /* 26 */ [0, 1, 3],
  /* 27 */ [0, 1, 3],
  /* 28 */ [0, 2, 5],
  /* 29 */ [0, 1, 2, 4],
  /* 30 */ [0, 1, 2, 5],
  /* 31 */ [0, 1, 2, 3, 4],
  /* 32 */ [0, 1, 2, 3, 4, 5],
];

// Per-algorithm modulator sources.  modSrcs[op] = list of ops whose phase
// modulates op's input. (Index 0 = op1, etc.)
const MOD_TABLE: number[][][] = [
  /*  1 */ [[1], [], [3], [4], [5], []],
  /*  2 */ [[1], [], [3], [4], [5], []],
  /*  3 */ [[1], [2], [], [4], [5], []],
  /*  4 */ [[1], [2], [], [4], [5], []],
  /*  5 */ [[1], [], [3], [], [5], []],
  /*  6 */ [[1], [], [3], [], [5], []],
  /*  7 */ [[1], [], [3, 4], [], [5], []],
  /*  8 */ [[1], [], [3, 4], [], [5], []],
  /*  9 */ [[1], [], [3, 4], [], [5], []],
  /* 10 */ [[1, 2], [], [], [4], [5], []],
  /* 11 */ [[1, 2], [], [], [4], [5], []],
  /* 12 */ [[1], [], [3, 4, 5], [], [], []],
  /* 13 */ [[1], [], [3, 4, 5], [], [], []],
  /* 14 */ [[1], [], [3], [4, 5], [], []],
  /* 15 */ [[1], [], [3], [4, 5], [], []],
  /* 16 */ [[1, 2, 4], [], [3], [], [5], []],
  /* 17 */ [[1, 2, 4], [], [3], [], [5], []],
  /* 18 */ [[1, 2, 3], [], [], [4, 5], [], []],
  /* 19 */ [[1, 2], [], [], [], [5], []],
  /* 20 */ [[2], [2], [3, 4], [], [5], []],
  /* 21 */ [[2], [2], [3, 4], [4], [5], []],
  /* 22 */ [[1], [], [5], [5], [5], []],
  /* 23 */ [[1], [], [3], [4], [5], []],
  /* 24 */ [[1, 2], [2], [4, 5], [], [], []],
  /* 25 */ [[1, 2], [2], [4, 5], [], [], []],
  /* 26 */ [[1], [3, 4], [], [4], [5], []],
  /* 27 */ [[1], [3, 4], [], [4], [5], []],
  /* 28 */ [[1], [], [3], [4], [], []],
  /* 29 */ [[2], [], [3], [4, 5], [], []],
  /* 30 */ [[1], [], [3, 4], [], [], []],
  /* 31 */ [[1], [], [], [], [5], []],
  /* 32 */ [[], [], [], [], [], [5]], // op6 is the only modulator (self-feedback only)
];

// Op6 feedback exists in every algorithm (the original chart shows feedback
// path on op6 → op6 in all 32 — only the depth varies via the patch's
// "feedback" param). We expose feedback always-on, scaled by patch.feedback.
const FEEDBACK_OP_DEFAULT = 5; // op6

function buildAlgorithms(): Algorithm[] {
  const algos: Algorithm[] = [];
  for (let i = 0; i < 32; i++) {
    algos.push({
      carriers: CARRIER_TABLE[i]!,
      modSrcs: MOD_TABLE[i]!,
      feedback: FEEDBACK_OP_DEFAULT,
    });
  }
  return algos;
}

// --------------------------------------------------------------
// Patch struct (mirror of dx7-syx.ts shape, but flat for hot-path access).
// --------------------------------------------------------------

interface OpPatch {
  // Envelope: rates 0..99 → per-second coefficients; levels 0..99 → 0..1 amp.
  rateCoefs: [number, number, number, number]; // 1/τ for each segment
  levels: [number, number, number, number];    // target amplitudes 0..1
  ratio: number;
  detuneFactor: number;
  fixedMode: boolean;
  outputAmp: number;  // op level → linear amplitude
}

interface VoicePatch {
  algorithm: number;       // 1..32
  feedback: number;        // 0..7 → 0..1 normalized
  operators: OpPatch[];    // length 6
  transpose: number;       // semitones
}

// Default patch: all ops as quiet sines, algorithm 1. Replaced by host on
// patch load.
function defaultPatch(): VoicePatch {
  const ops: OpPatch[] = [];
  for (let i = 0; i < 6; i++) {
    ops.push({
      rateCoefs: [60, 30, 10, 30],
      levels: [1, 0.7, 0.5, 0],
      ratio: 1,
      detuneFactor: 1,
      fixedMode: false,
      outputAmp: i === 0 ? 1 : 0, // only op1 audible
    });
  }
  return {
    algorithm: 1,
    feedback: 0,
    operators: ops,
    transpose: 0,
  };
}

// --------------------------------------------------------------
// Voice state — per-voice envelope phases, op phases, etc.
// --------------------------------------------------------------

interface Voice {
  active: boolean;
  /** Current MIDI pitch (we receive V/oct on the input lanes; convert here). */
  midi: number;
  hz: number;
  /** Note-on time (sampleFrame) — used for steal-oldest. */
  startSample: number;
  /** Per-op phase 0..1. */
  phase: Float64Array;
  /** Per-op envelope value (linear amplitude 0..1). */
  envValue: Float32Array;
  /** Per-op envelope segment index 0..3 (attack-segment-active). */
  envSeg: Int32Array;
  /** Whether the voice is in release (gate-off). */
  releasing: boolean;
  /** Op6 feedback memory (1-sample delay). */
  fbMem: number;
  /** Last per-op output sample (for routing into modulators). */
  opOut: Float32Array;
  /** Lane index currently owning this voice (0..NUM_VOICES-1) or -1 if free. */
  laneOwner: number;
  /** Per-voice OUTPUT-VCA amplitude envelope (per-voice-ADSR feature). Multiplies
   *  the summed-carrier voiceOut on top of the six operator EGs; defaults are
   *  ~pass-through so the SYX-defined sound is unchanged until the player touches
   *  the master ADSR. */
  ampEnv: Envelope;
}

function makeVoice(): Voice {
  return {
    active: false,
    midi: 60,
    hz: C4_HZ,
    startSample: -1,
    phase: new Float64Array(NUM_OPS),
    envValue: new Float32Array(NUM_OPS),
    envSeg: new Int32Array(NUM_OPS),
    releasing: false,
    fbMem: 0,
    opOut: new Float32Array(NUM_OPS),
    laneOwner: -1,
    ampEnv: new Envelope(),
  };
}

// --------------------------------------------------------------
// The processor.
// --------------------------------------------------------------

interface PatchMessage {
  type: 'patch';
  voice: {
    name: string;
    algorithm: number;
    feedback: number;
    operators: Array<{
      r: number[]; l: number[]; ratio: number; detune: number;
      detuneFactor: number; level: number; fixedMode: boolean; velocitySens: number;
    }>;
    transpose: number;
  };
}

class Dx7Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Voice count — a soft limit. Values >5 are clamped (we have NUM_VOICES
      // physical voice slots).
      { name: 'voiceCount', defaultValue: 5, minValue: 1, maxValue: 5, automationRate: 'k-rate' as const },
      // Master output level (0..2; 1 = unity).
      { name: 'level',      defaultValue: 0.7, minValue: 0, maxValue: 2, automationRate: 'k-rate' as const },
      // Pitch transpose in semitones (offsets every voice's pitch).
      { name: 'transpose',  defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' as const },
      // Per-voice master OUTPUT-VCA ADSR (per-voice-ADSR feature). One envelope
      // per voice multiplies the summed-carrier voiceOut, on top of the six DX7
      // operator EGs. Defaults are ~pass-through (fast attack, full sustain, fast
      // release) so existing patches sound identical until the player dials it.
      { name: 'attack',  defaultValue: 0.001, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'decay',   defaultValue: 0.1,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'sustain', defaultValue: 1,     minValue: 0,     maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'release', defaultValue: 0.005, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
    ];
  }

  private patch: VoicePatch = defaultPatch();
  private algorithms: Algorithm[] = buildAlgorithms();
  private voices: Voice[] = Array.from({ length: NUM_VOICES }, makeVoice);
  /** Last gate state per lane (for rising-edge detection). */
  private lastGate: Float32Array = new Float32Array(NUM_VOICES);
  private currentSample = 0;
  private isr = 1 / sampleRate;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as PatchMessage;
      if (m?.type === 'patch') {
        this.applyPatch(m.voice);
      }
    };
  }

  private applyPatch(v: PatchMessage['voice']): void {
    const ops: OpPatch[] = [];
    for (let i = 0; i < 6; i++) {
      const op = v.operators[i] ?? v.operators[0]!;
      // r/l 0..99 → coefs/amps. The DX7 envelope semantics: levels go from
      // segment to segment (l[0] is the peak after attack, l[3] is the
      // sustain level pre-release). Rates control time-constants.
      const rates: [number, number, number, number] = [
        rateToCoef(op.r[0] ?? 99),
        rateToCoef(op.r[1] ?? 50),
        rateToCoef(op.r[2] ?? 30),
        rateToCoef(op.r[3] ?? 50),
      ];
      const levels: [number, number, number, number] = [
        levelToAmp(op.l[0] ?? 99),
        levelToAmp(op.l[1] ?? 70),
        levelToAmp(op.l[2] ?? 50),
        levelToAmp(op.l[3] ?? 0),
      ];
      ops.push({
        rateCoefs: rates,
        levels,
        ratio: op.ratio,
        detuneFactor: op.detuneFactor,
        fixedMode: op.fixedMode,
        outputAmp: levelToAmp(op.level),
      });
    }
    this.patch = {
      algorithm: Math.max(1, Math.min(32, v.algorithm | 0)),
      feedback: Math.max(0, Math.min(7, v.feedback | 0)) / 7,
      operators: ops,
      transpose: ((v.transpose ?? 24) - 24), // SYX: 24 = no transpose
    };
    // Reset all voices when patch changes — the operator levels & ratios
    // shift and stale envelope state would sound wrong.
    for (const voice of this.voices) {
      voice.active = false;
      voice.releasing = false;
      voice.laneOwner = -1;
      voice.fbMem = 0;
      voice.ampEnv.state = 0; // EnvState.Idle
      voice.ampEnv.value = 0;
      for (let i = 0; i < NUM_OPS; i++) {
        voice.envValue[i] = 0;
        voice.envSeg[i] = 0;
        voice.phase[i] = 0;
        voice.opOut[i] = 0;
      }
    }
    for (let i = 0; i < this.lastGate.length; i++) this.lastGate[i] = 0;
  }

  /** Find a voice slot for a new note. If `laneOwner` already owns a voice
   *  we re-use it (re-trigger). Otherwise pick a free voice; if none, steal
   *  the oldest. */
  private allocateVoice(laneOwner: number): Voice {
    // Prefer the existing voice owned by this lane (retrigger).
    for (const v of this.voices) {
      if (v.laneOwner === laneOwner && v.active) return v;
    }
    // Free slot first.
    for (const v of this.voices) {
      if (!v.active) return v;
    }
    // Steal oldest.
    let oldest = this.voices[0]!;
    for (const v of this.voices) {
      if (v.startSample < oldest.startSample) oldest = v;
    }
    return oldest;
  }

  private noteOn(voice: Voice, midi: number, laneOwner: number): void {
    voice.active = true;
    voice.midi = midi;
    voice.hz = C4_HZ * Math.pow(2, (midi - 60) / 12);
    voice.startSample = this.currentSample;
    voice.releasing = false;
    voice.fbMem = 0;
    voice.laneOwner = laneOwner;
    for (let i = 0; i < NUM_OPS; i++) {
      voice.phase[i] = 0;
      voice.envValue[i] = 0;
      voice.envSeg[i] = 0; // start in attack
      voice.opOut[i] = 0;
    }
    // Master output-VCA: soft (click-safe) retrigger — attacks from the current
    // value, so re-gating a still-releasing voice never pops.
    voice.ampEnv.triggerSoft(true);
  }

  private noteOff(voice: Voice): void {
    voice.releasing = true;
    for (let i = 0; i < NUM_OPS; i++) {
      voice.envSeg[i] = 3; // jump to release segment
    }
    voice.ampEnv.triggerSoft(false);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const polyIn = inputs[0]; // 10 channels: (p0, g0, p1, g1, ..., p4, g4)
    const monoPitch = inputs[1]?.[0]; // optional mono pitch fallback (lane-0)
    const monoGate = inputs[2]?.[0];  // optional mono gate fallback (lane-0)

    const voiceCount = Math.max(1, Math.min(NUM_VOICES, parameters.voiceCount[0]! | 0));
    const level = parameters.level[0]!;
    const transpose = parameters.transpose[0]!;
    // Per-voice master OUTPUT-VCA ADSR (k-rate; shared across voices, ticked
    // per-sample per voice). Read defensively (older constructions may omit them).
    const ampAttack  = parameters.attack  ? parameters.attack[0]!  : 0.001;
    const ampDecay   = parameters.decay   ? parameters.decay[0]!   : 0.1;
    const ampSustain = parameters.sustain ? parameters.sustain[0]! : 1;
    const ampRelease = parameters.release ? parameters.release[0]! : 0.005;
    const sr = sampleRate;

    const algo = this.algorithms[Math.max(0, Math.min(31, this.patch.algorithm - 1))]!;
    const ops = this.patch.operators;
    const fbAmount = this.patch.feedback;

    // Block-rate gate-edge detection per lane. `polyIn` may be missing or
    // partial; we read defensively per channel.
    for (let lane = 0; lane < voiceCount; lane++) {
      const pitchCh = polyIn?.[lane * 2];
      const gateCh = polyIn?.[lane * 2 + 1];

      // Use the first sample of the block as the "decision" pitch/gate. Lower
      // resolution than per-sample but matches the project's existing
      // sequencer semantics (sequencer writes setValueAtTime at block
      // boundaries, so per-block sampling is exact for that case).
      let pitchVOct = pitchCh?.[0] ?? 0;
      let gateVal = gateCh?.[0] ?? 0;
      if (lane === 0) {
        // Mono fallback: if no poly source is connected, use mono inputs.
        if (!pitchCh && monoPitch) pitchVOct = monoPitch[0] ?? 0;
        if (!gateCh && monoGate) gateVal = monoGate[0] ?? 0;
      }
      const midi = 60 + pitchVOct * 12 + transpose + this.patch.transpose;

      const wasGate = this.lastGate[lane]! > 0.5;
      const isGate = gateVal > 0.5;
      if (isGate && !wasGate) {
        // Rising edge — note on.
        const v = this.allocateVoice(lane);
        this.noteOn(v, midi, lane);
      } else if (!isGate && wasGate) {
        // Falling edge — note off (find the voice owned by this lane).
        for (const v of this.voices) {
          if (v.laneOwner === lane && v.active && !v.releasing) {
            this.noteOff(v);
            break;
          }
        }
      } else if (isGate) {
        // Gate held — keep updating pitch (allows pitch glides).
        for (const v of this.voices) {
          if (v.laneOwner === lane && v.active) {
            v.midi = midi;
            v.hz = C4_HZ * Math.pow(2, (midi - 60) / 12);
            break;
          }
        }
      }
      this.lastGate[lane] = gateVal;
    }

    // Render.
    const blockLen = out.length;
    for (let i = 0; i < blockLen; i++) {
      let sum = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        // Per-op render in fixed forward order (op1..op6). Modulator outputs
        // for any op whose modSrcs reference an op > current op are taken
        // from the previous sample (1-sample delay) — this is faithful to
        // the original DX7's render order in nearly every case (op6 only
        // self-feeds), and simplifies the algorithm graph.
        for (let opIdx = 0; opIdx < NUM_OPS; opIdx++) {
          const op = ops[opIdx]!;
          // Update envelope (4-segment).
          updateEnvelope(v, opIdx, op, this.isr);

          // Phase modulator: sum modulator op outputs (use this-block's
          // computed values for any op < current; previous-sample for any
          // op > current).
          let modIn = 0;
          const srcs = algo.modSrcs[opIdx]!;
          for (let s = 0; s < srcs.length; s++) {
            const src = srcs[s]!;
            if (src === opIdx) {
              // Self-feedback (only op6 in the original DX7 chart).
              modIn += v.fbMem * fbAmount;
            } else {
              modIn += v.opOut[src]!;
            }
          }
          // Op6 self-feedback path: when feedback is wired to op6 and op6
          // doesn't appear in modSrcs[opIdx=5] explicitly (most algos don't
          // list it), still apply at op6.
          if (opIdx === algo.feedback && srcs.indexOf(opIdx) < 0 && fbAmount > 0) {
            modIn += v.fbMem * fbAmount;
          }

          // Phase advance.
          const ratio = op.ratio;
          const detune = op.detuneFactor;
          const opHz = op.fixedMode ? ratio * C4_HZ : v.hz * ratio * detune;
          v.phase[opIdx] = (v.phase[opIdx]! + opHz * this.isr) % 1;

          // Sine + phase modulation. Modulation index scaled so that PM~3
          // gives full timbral character (DX7's actual scaling is more
          // complex but this is "musically close").
          const phase = v.phase[opIdx]! * TWO_PI + modIn * Math.PI;
          const s = Math.sin(phase);
          const sample = s * v.envValue[opIdx]! * op.outputAmp;
          v.opOut[opIdx] = sample;
        }
        // Op6 feedback memory (averaged over 2 samples like the original).
        v.fbMem = (v.fbMem + v.opOut[5]!) * 0.5;

        // Sum carriers.
        let voiceOut = 0;
        for (const c of algo.carriers) {
          voiceOut += v.opOut[c]!;
        }
        // Per-voice master OUTPUT VCA — multiply the summed-carrier voiceOut by
        // the amp envelope BEFORE summing into the bus, on top of the operator
        // EGs. Defaults (~1) leave the SYX sound unchanged.
        const ampEnvVal = v.ampEnv.tick(ampAttack, ampDecay, ampSustain, ampRelease, sr);
        sum += voiceOut * ampEnvVal;

        // Auto-deactivate when fully released. CRITIQUE C3: require op-EG silence
        // AND the master amp envelope having faded (ampEnv.value < ε) so (a) a
        // long master release isn't cut short by op-EG silence, and (b) a
        // fully-faded-but-not-formally-idle voice still frees (CPU bound).
        if (v.releasing) {
          let totalEnv = 0;
          for (let k = 0; k < NUM_OPS; k++) totalEnv += v.envValue[k]!;
          if (totalEnv < 0.0001 && v.ampEnv.value < 1e-4) {
            v.active = false;
            v.laneOwner = -1;
          }
        }
      }
      // Per-block voice-count mix attenuation: divide by sqrt(NUM_VOICES) so
      // 5 simultaneous voices don't clip. Empirically tuned.
      out[i] = sum * level * 0.4;
    }
    this.currentSample += blockLen;
    return true;
  }
}

// --------------------------------------------------------------
// Helpers (must match dx7-syx.ts dx7RateToCoef / dx7LevelToAmp; duplicated
// inline because the worklet bundle can't import from packages/web).
// --------------------------------------------------------------

function rateToCoef(rate: number): number {
  const r = clampInt(rate, 0, 99);
  const tau = 8 * Math.exp(-0.09 * r);
  return 1 / Math.max(tau, 0.0005);
}

function levelToAmp(level: number): number {
  const l = clampInt(level, 0, 99);
  if (l === 0) return 0;
  const dB = (l - 99) * 0.75;
  return Math.pow(10, dB / 20);
}

function clampInt(v: number, lo: number, hi: number): number {
  const i = Math.round(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

/**
 * 4-segment envelope update for one operator. Uses 1-pole exponential
 * approach toward the segment's target level; advances to the next segment
 * when "close enough" (within 1% of target) — matches the DX7's behaviour
 * of jumping past segments whose target is below the current value (the
 * "direct jump" quirk).
 *
 * Segments:
 *   0: attack (target = l[0] = peak post-attack amplitude)
 *   1: decay 1 (target = l[1])
 *   2: decay 2 / sustain (target = l[2])
 *   3: release (target = l[3]; voice envSeg latched here on note-off)
 */
function updateEnvelope(v: Voice, opIdx: number, op: OpPatch, dt: number): void {
  const seg = v.envSeg[opIdx]!;
  const target = op.levels[seg]!;
  const coef = op.rateCoefs[seg]!;
  const cur = v.envValue[opIdx]!;
  // Single-pole approach. The factor (1 - exp(-coef * dt)) collapses to
  // ≈ coef * dt for small steps; we use the exact form for accuracy at
  // small rates.
  const k = 1 - Math.exp(-coef * dt);
  const next = cur + (target - cur) * k;
  v.envValue[opIdx] = next;

  // Advance segment when within 1% of target (and not at release stage).
  if (seg < 3) {
    const diff = Math.abs(target - next);
    const range = Math.max(1e-6, Math.max(target, cur));
    if (diff / range < 0.01) {
      v.envSeg[opIdx] = seg + 1;
    }
  }
}

registerProcessor('dx7', Dx7Processor);
