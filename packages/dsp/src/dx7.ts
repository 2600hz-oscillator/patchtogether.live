// packages/dsp/src/dx7.ts
//
// Pure-TypeScript 6-operator DX7-style FM voice processor.
//
// SYNC PARTNER: packages/web/src/lib/audio/dx7-render.ts mirrors this
// worklet's render loop for ART tests (which can't load AudioWorklets in
// node). Any change to the render math here MUST be ported to dx7-render.ts
// — otherwise the ART spectral tests will silently start passing on stale
// expectations. The algorithm tables and the whole operator-envelope /
// fixed-frequency law are duplicated inline below and gated by
// dx7-algorithms.test.ts + dx7-envelope-mirror.test.ts; keep them aligned.
//
// Architecture summary ( — Path C
// pure-TS implementation):
//
//   - 5 voices (matches Stage-1 polyPitchGate cable: 5 voice pairs).
//   - Each voice has 6 operators (sine + envelope + level + ratio + detune).
//   - 32 DX7 algorithms encoded as a small per-algorithm routing table; each
//     entry says "for op N, what modulator inputs feed its phase, where does
//     its output route (carriers list), and where is THIS algorithm's single
//     feedback loop wired?" (the feedback operator varies per algorithm — see
//     FEEDBACK_TABLE below).
//   - 4-rate / 4-level envelopes per operator (the DX7's signature scheme;
//     "rates" go 0..99 where 99 is fastest). The envelope runs in the dB
//     domain: it IDLES AND ENDS AT L4, rises to L1, falls to L2 then L3, and
//     HOLDS AT L3 for as long as the gate is high; note-off jumps to the
//     release segment, which targets L4. Decays are linear in dB; the attack
//     is msfa's asymptotic log-domain law. See the mirrored law block at the
//     bottom of this file (and dx7-syx.ts) for the sources.
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
// `{type:'patch'}` is DESTRUCTIVE (it resets every voice) and is reserved for
// a preset LOAD. Live editing uses the incremental, NON-destructive messages
// `voice` / `opParam` / `algorithm` / `feedback` — see the message-protocol
// block above the Dx7Message union below for the full contract and the value
// domain each field carries.
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
//               sums add — Web Audio + Plaits semantics.) The feedback path
//               is NOT listed here; an op never appears in its own list.
//   feedback  : {from, to} — the algorithm's single feedback loop. The
//               1-sample memory is fed from op `from` and modulates op `to`.
//               `from === to` is the usual self-loop.
//
// Operator indexing: 0 = op1, 1 = op2, ..., 5 = op6. (Musical convention,
// matching the dx7-syx.ts parser output.)
//
// FEEDBACK IS PER-ALGORITHM. It is NOT always op6 — the DX7 moves the loop to
// a different operator per algorithm, and that placement is exactly what
// distinguishes otherwise-identical routings (1 vs 2, 3 vs 4, 5 vs 6, 7/8/9,
// 10 vs 11, 12 vs 13, 14 vs 15, 16 vs 17, 26 vs 27). Two algorithms (4 and 6)
// use a MULTI-OPERATOR loop (op4 → op6 and op5 → op6 respectively) rather than
// a self-loop, which is why `feedback` is a pair and not a single index.
//
// PROVENANCE — the tables below were DERIVED, not hand-typed, by decoding two
// independent authoritative sources and asserting they agree on all 32 rows
// (they do, exactly):
//   (a) the real DX7 OPS-chip ALGORITHM ROM dump — Ken Shirriff, "Yamaha DX7
//       chip reverse-engineering, part 4: how algorithms are implemented"
//       (righto.com, 2021-12), footnote 5. Words are "SEL / FREN MREN / COM";
//       column N is latched while op N is at the output, so it selects op
//       N-1's modulation (column 1 wraps to op6). FREN=1 latches the feedback
//       register FROM op N; SEL=5 is the averaged ("anti-hunting") feedback
//       path INTO op N-1.
//   (b) `FmCore::algorithms` in Dexed / Google's music-synthesizer-for-android
//       (`Source/msfa/fm_core.cc`) — 6 bytes per algorithm, ordered op6..op1,
//       encoding in/out bus plus FB_IN (receives feedback) / FB_OUT (sources
//       it).
//
// Validation: every entry has exactly 6 modSrcs lists; carriers are a
// non-empty subset of [0..5]; feedback.from / feedback.to are in [0..5]. The
// authoritative golden lives in the web mirror's
// `dx7-algorithms.test.ts`, which also asserts all 32 rows are DISTINCT.
// --------------------------------------------------------------

interface Feedback {
  /** Operator index (0..5) whose output feeds the loop's 1-sample memory. */
  from: number;
  /** Operator index (0..5) whose phase that memory modulates. */
  to: number;
}

interface Algorithm {
  carriers: number[];
  modSrcs: number[][];
  feedback: Feedback;
}

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
  /* 10 */ [[1], [2], [], [4, 5], [], []],
  /* 11 */ [[1], [2], [], [4, 5], [], []],
  /* 12 */ [[1], [], [3, 4, 5], [], [], []],
  /* 13 */ [[1], [], [3, 4, 5], [], [], []],
  /* 14 */ [[1], [], [3], [4, 5], [], []],
  /* 15 */ [[1], [], [3], [4, 5], [], []],
  /* 16 */ [[1, 2, 4], [], [3], [], [5], []],
  /* 17 */ [[1, 2, 4], [], [3], [], [5], []],
  /* 18 */ [[1, 2, 3], [], [], [4], [5], []],
  /* 19 */ [[1], [2], [], [5], [5], []],
  /* 20 */ [[2], [2], [], [4, 5], [], []],
  /* 21 */ [[2], [2], [], [5], [5], []],
  /* 22 */ [[1], [], [5], [5], [5], []],
  /* 23 */ [[], [2], [], [5], [5], []],
  /* 24 */ [[], [], [5], [5], [5], []],
  /* 25 */ [[], [], [], [5], [5], []],
  /* 26 */ [[], [2], [], [4, 5], [], []],
  /* 27 */ [[], [2], [], [4, 5], [], []],
  /* 28 */ [[1], [], [3], [4], [], []],
  /* 29 */ [[], [], [3], [], [5], []],
  /* 30 */ [[], [], [3], [4], [], []],
  /* 31 */ [[], [], [], [], [5], []],
  /* 32 */ [[], [], [], [], [], []], // six independent carriers; op6 self-feeds
];

// Per-algorithm feedback loop, as [from, to] operator indices. `from === to`
// is a self-loop; algorithms 4 (op4 → op6) and 6 (op5 → op6) are the two
// multi-operator loops on the real DX7. Depth is the patch's `feedback` param.
const FEEDBACK_TABLE: [number, number][] = [
  /*  1 */ [5, 5], /*  2 */ [1, 1], /*  3 */ [5, 5], /*  4 */ [3, 5],
  /*  5 */ [5, 5], /*  6 */ [4, 5], /*  7 */ [5, 5], /*  8 */ [3, 3],
  /*  9 */ [1, 1], /* 10 */ [2, 2], /* 11 */ [5, 5], /* 12 */ [1, 1],
  /* 13 */ [5, 5], /* 14 */ [5, 5], /* 15 */ [1, 1], /* 16 */ [5, 5],
  /* 17 */ [1, 1], /* 18 */ [2, 2], /* 19 */ [5, 5], /* 20 */ [2, 2],
  /* 21 */ [2, 2], /* 22 */ [5, 5], /* 23 */ [5, 5], /* 24 */ [5, 5],
  /* 25 */ [5, 5], /* 26 */ [5, 5], /* 27 */ [2, 2], /* 28 */ [4, 4],
  /* 29 */ [5, 5], /* 30 */ [4, 4], /* 31 */ [5, 5], /* 32 */ [5, 5],
];

function buildAlgorithms(): Algorithm[] {
  const algos: Algorithm[] = [];
  for (let i = 0; i < 32; i++) {
    const [from, to] = FEEDBACK_TABLE[i]!;
    algos.push({
      carriers: CARRIER_TABLE[i]!,
      modSrcs: MOD_TABLE[i]!,
      feedback: { from, to },
    });
  }
  return algos;
}

// --------------------------------------------------------------
// Patch struct (mirror of dx7-syx.ts shape, but flat for hot-path access).
// --------------------------------------------------------------

interface OpPatch {
  // Envelope, in the DX7's own dB domain: rates 0..99 → dB per second (linear
  // in dB); levels 0..99 → target dB (0 dB = unity, DX7_EG_FLOOR_DB = silence).
  ratesDbPerSec: [number, number, number, number];
  levelsDb: [number, number, number, number];
  ratio: number;
  detuneFactor: number;
  fixedMode: boolean;
  /** FIXED-mode frequency in Hz. Meaningless unless `fixedMode`. */
  fixedHz: number;
  outputAmp: number;  // op level → linear amplitude
}

interface VoicePatch {
  algorithm: number;       // 1..32
  feedback: number;        // 0..7 → 0..1 normalized
  operators: OpPatch[];    // length 6
  transpose: number;       // semitones
}

// Default patch: all ops as quiet sines, algorithm 1. Replaced by host on
// patch load (the module's factory sends a real patch immediately), so this
// only ever sounds in tests and in the window before the first patch message.
//
// The rate slots are DX7 RATE BYTES (0..99) now, not the raw 1/τ coefficients
// they held before the authentic-envelope PR. R4 = 80 is chosen so the release
// still takes ~30 ms, matching the old placeholder — `dx7-ampenv.test.ts`'s
// deactivate guard drives THIS patch and asserts a voice frees inside ~0.5 s
// of release, which a slow R4 would break.
function defaultPatch(): VoicePatch {
  const ops: OpPatch[] = [];
  for (let i = 0; i < 6; i++) {
    ops.push({
      ratesDbPerSec: [
        dx7RateToDbPerSec(99), dx7RateToDbPerSec(50),
        dx7RateToDbPerSec(30), dx7RateToDbPerSec(80),
      ],
      levelsDb: [
        dx7LevelToDb(99), dx7LevelToDb(70),
        dx7LevelToDb(50), dx7LevelToDb(0),
      ],
      ratio: 1,
      detuneFactor: 1,
      fixedMode: false,
      fixedHz: C4_HZ,
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
  /** Per-op envelope value in dB — the authoritative EG state. Float64: at
   *  rate 0 the per-sample step is ~5e-6 dB, under float32 epsilon here. */
  envDb: Float64Array;
  /** Per-op envelope value (linear amplitude 0..1), derived from `envDb`. */
  envValue: Float32Array;
  /** Per-op envelope segment index: 0..2 run while the gate is high, 3 is the
   *  release (entered on note-off only — reaching it with the gate still high
   *  is the L3 HOLD), 4 means finished. */
  envSeg: Int32Array;
  /** Whether the voice is in release (gate-off). */
  releasing: boolean;
  /** Feedback-loop memory (1-sample delay); which op feeds it is per-algorithm. */
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
    envDb: new Float64Array(NUM_OPS),
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
      /** Optional — absent on patches saved before the fixed-frequency fix. */
      fixedHz?: number;
    }>;
    transpose: number;
  };
}

// --------------------------------------------------------------
// INCREMENTAL, NON-DESTRUCTIVE MESSAGES
//
// `{type:'patch'}` is a preset LOAD: it rebuilds the whole patch AND resets
// every voice (see applyPatch). That is correct for "the player picked a
// different voice", and WRONG for "the player nudged one operator" — an edit
// gesture must not kill the notes that are sounding while you make it.
//
// So the port speaks five messages, mirroring the setParam / separate-
// clearBuffers split in packages/dsp/src/cloudseed.ts:
//
//   patch     — full voice, RESETS voices        (preset LOAD only)
//   voice     — full voice, does NOT reset       (a REMOTE voiceRev bump: a
//                                                 rack-mate's edit must not
//                                                 stop YOUR notes)
//   opParam   — one operator field, no reset
//   algorithm — 1..32, no reset (process() re-reads this.patch.algorithm at
//               the top of every block, so the routing graph re-binds itself
//               on the next block with no voice state disturbed)
//   feedback  — 0..7, no reset (stored normalized; the worklet divides by 7)
//
// OPERATOR MUTE ROUTES THROUGH `opParam { field:'level', value:0 }`, never
// through `{type:'patch'}`. Two reasons, and they are the whole reason this
// split exists:
//   1. the host keeps the operator's real level in node.data.voice, so UNmute
//      is just another opParam re-sending the stored value; and
//   2. `{type:'patch'}` is HOSTILE to anything sounding — in two distinct
//      ways, both pinned by dx7-messages.test.ts, and NEITHER of them is the
//      benign "the note just stops":
//        * a lane whose gate is still HIGH gets HARD-RETRIGGERED. applyPatch
//          zeroes `lastGate`, so on the very next block the block-rate edge
//          detector in process() reads `isGate && !wasGate` and fires a fresh
//          noteOn — envelopes back to segment 0, phases back to 0, the master
//          VCA soft-retriggered. The held note re-articulates: a click and a
//          new attack in the middle of the chord you are holding.
//        * a lane whose gate has already FALLEN (the note is ringing out its
//          release tail) is killed outright and never comes back — there is
//          no future rising edge to revive it.
//      So a mute button wired to the whole-patch message would re-attack every
//      held note and chop every tail on EVERY click.
//
// VALUE DOMAIN — get this wrong and you have a ~1000x envelope error. This
// worklet stores DERIVED values, not the raw DX7 bytes:
//   ratesDbPerSec = dx7RateToDbPerSec(rate)   (dB per second)
//   levelsDb      = dx7LevelToDb(level)       (dB, 0 dB = unity)
//   outputAmp     = levelToAmp(level)         (LINEAR amplitude — the operator
//                                              output level is not an EG level)
// The host therefore sends the RAW 0..99 byte for r0..r3 / l0..l3 / level and
// applyOpParam runs the SAME transform applyPatch runs; it sends the
// already-resolved FLOAT for ratio (host dx7Ratio(coarse,fine)), detuneFactor
// (host dx7DetuneFactor) and fixedHz (host dx7FixedHz(coarse,fine)), which are
// stored verbatim.
// --------------------------------------------------------------

/** The operator fields an `opParam` message may address. */
type Dx7OpField =
  | 'r0' | 'r1' | 'r2' | 'r3'      // envelope rates,  RAW 0..99
  | 'l0' | 'l1' | 'l2' | 'l3'      // envelope levels, RAW 0..99
  | 'level'                        // operator output level, RAW 0..99
  | 'ratio'                        // resolved float (host dx7Ratio)
  | 'detuneFactor'                 // resolved float (host dx7DetuneFactor)
  | 'fixedMode'                    // 0 | 1
  | 'fixedHz';                     // resolved float (host dx7FixedHz), > 0

interface VoiceMessage {
  type: 'voice';
  voice: PatchMessage['voice'];
}
interface OpParamMessage {
  type: 'opParam';
  op: number;          // 0..5
  field: Dx7OpField;
  value: number;
}
interface AlgorithmMessage {
  type: 'algorithm';
  value: number;       // 1..32
}
interface FeedbackMessage {
  type: 'feedback';
  value: number;       // 0..7
}

type Dx7Message =
  | PatchMessage
  | VoiceMessage
  | OpParamMessage
  | AlgorithmMessage
  | FeedbackMessage;

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
      const m = e.data as Dx7Message | null | undefined;
      if (!m) return;
      switch (m.type) {
        case 'patch':
          // Preset LOAD — the whole sound changes, so stale voice state would
          // sound wrong. This is the ONLY message that resets.
          this.applyPatch(m.voice, true);
          break;
        case 'voice':
          // Same payload, NON-destructive: a remote voiceRev bump.
          this.applyPatch(m.voice, false);
          break;
        case 'opParam':
          this.applyOpParam(m.op, m.field, m.value);
          break;
        case 'algorithm':
          this.setAlgorithm(m.value);
          break;
        case 'feedback':
          this.setFeedback(m.value);
          break;
        default:
          break;
      }
    };
  }

  /**
   * Rebuild the whole patch from a serialized voice.
   *
   * @param reset when true (a preset LOAD) every voice is silenced and
   *        `lastGate` is zeroed. Pass FALSE for a non-destructive re-send.
   *        Zeroing `lastGate` is what makes a reset hostile to a held note:
   *        process()'s edge detector sees the still-high gate as a fresh
   *        RISING edge on the next block and hard-retriggers the note (and a
   *        note already in release is killed with no edge left to revive it).
   *        See the message-protocol block above the Dx7Message union.
   */
  private applyPatch(v: PatchMessage['voice'], reset: boolean): void {
    const ops: OpPatch[] = [];
    for (let i = 0; i < 6; i++) {
      const op = v.operators[i] ?? v.operators[0]!;
      // r/l 0..99 → dB-domain rates/levels. DX7 envelope semantics: the four
      // levels are the segment TARGETS — L1 is the post-attack peak, L3 is the
      // level held while the gate is high, and L4 is BOTH the idle/start level
      // and the release target.
      const ratesDbPerSec: [number, number, number, number] = [
        dx7RateToDbPerSec(op.r[0] ?? 99),
        dx7RateToDbPerSec(op.r[1] ?? 50),
        dx7RateToDbPerSec(op.r[2] ?? 30),
        dx7RateToDbPerSec(op.r[3] ?? 50),
      ];
      const levelsDb: [number, number, number, number] = [
        dx7LevelToDb(op.l[0] ?? 99),
        dx7LevelToDb(op.l[1] ?? 70),
        dx7LevelToDb(op.l[2] ?? 50),
        dx7LevelToDb(op.l[3] ?? 0),
      ];
      ops.push({
        ratesDbPerSec,
        levelsDb,
        ratio: op.ratio,
        detuneFactor: op.detuneFactor,
        fixedMode: op.fixedMode,
        // Patches saved before `fixedHz` existed carry only the derived ratio.
        fixedHz:
          typeof op.fixedHz === 'number' && Number.isFinite(op.fixedHz) && op.fixedHz > 0
            ? op.fixedHz
            : dx7FixedHzFromRatio(op.ratio),
        outputAmp: levelToAmp(op.level),
      });
    }
    this.patch = {
      algorithm: Math.max(1, Math.min(32, v.algorithm | 0)),
      feedback: Math.max(0, Math.min(7, v.feedback | 0)) / 7,
      operators: ops,
      transpose: ((v.transpose ?? 24) - 24), // SYX: 24 = no transpose
    };
    if (!reset) return;
    // Reset all voices when patch changes — the operator levels & ratios
    // shift and stale envelope state would sound wrong. The DX7 envelope IDLES
    // AT L4 (which is also where the release lands), so that is the reset
    // value, not zero.
    for (const voice of this.voices) {
      voice.active = false;
      voice.releasing = false;
      voice.laneOwner = -1;
      voice.fbMem = 0;
      voice.ampEnv.state = 0; // EnvState.Idle
      voice.ampEnv.value = 0;
      for (let i = 0; i < NUM_OPS; i++) {
        voice.envDb[i] = ops[i]!.levelsDb[3];
        voice.envValue[i] = dx7EgAmpFromDb(voice.envDb[i]!);
        voice.envSeg[i] = 0;
        voice.phase[i] = 0;
        voice.opOut[i] = 0;
      }
    }
    for (let i = 0; i < this.lastGate.length; i++) this.lastGate[i] = 0;
  }

  /**
   * Apply ONE operator field in place. Touches `this.patch.operators[op]` and
   * NOTHING else — no voice state, no `lastGate` — so a live held note keeps
   * playing (and simply renders with the new value from the very next sample).
   *
   * The transforms MUST match applyPatch's: the host sends the RAW 0..99 DX7
   * byte for rates/levels and this converts, because the worklet's hot path
   * reads coefficients and amplitudes, never bytes. `ratio` / `detuneFactor`
   * arrive already resolved by the host helpers and are stored verbatim.
   */
  private applyOpParam(op: number, field: Dx7OpField, value: number): void {
    const idx = Math.round(op);
    if (!Number.isFinite(idx) || idx < 0 || idx >= NUM_OPS) return;
    if (!Number.isFinite(value)) return;
    const o = this.patch.operators[idx];
    if (!o) return;
    switch (field) {
      case 'r0': o.ratesDbPerSec[0] = dx7RateToDbPerSec(value); break;
      case 'r1': o.ratesDbPerSec[1] = dx7RateToDbPerSec(value); break;
      case 'r2': o.ratesDbPerSec[2] = dx7RateToDbPerSec(value); break;
      case 'r3': o.ratesDbPerSec[3] = dx7RateToDbPerSec(value); break;
      case 'l0': o.levelsDb[0] = dx7LevelToDb(value); break;
      case 'l1': o.levelsDb[1] = dx7LevelToDb(value); break;
      case 'l2': o.levelsDb[2] = dx7LevelToDb(value); break;
      case 'l3': o.levelsDb[3] = dx7LevelToDb(value); break;
      // Operator MUTE is exactly this message with value 0 — see the protocol
      // comment above for why it must never be a whole-patch re-send.
      case 'level': o.outputAmp = levelToAmp(value); break;
      case 'ratio': o.ratio = value; break;
      case 'detuneFactor': o.detuneFactor = value; break;
      case 'fixedMode': o.fixedMode = value !== 0; break;
      // FIXED-mode frequency, in Hz, already resolved by the host's
      // dx7FixedHz(coarse, fine). Guarded because a non-positive value would
      // silence a fixed operator outright rather than mistune it.
      case 'fixedHz': if (value > 0) o.fixedHz = value; break;
      default: break;
    }
  }

  /** Live algorithm change, no reset: process() re-reads this.patch.algorithm
   *  at the top of every block, so the routing graph re-binds on the next one. */
  private setAlgorithm(value: number): void {
    if (!Number.isFinite(value)) return;
    this.patch.algorithm = Math.max(1, Math.min(32, Math.round(value)));
  }

  /** Live feedback-depth change, no reset. Stored NORMALIZED (0..1) — the
   *  divide-by-7 lives here, exactly as in applyPatch. */
  private setFeedback(value: number): void {
    if (!Number.isFinite(value)) return;
    this.patch.feedback = Math.max(0, Math.min(7, Math.round(value))) / 7;
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
      // The DX7 envelope STARTS at L4 — the same level it ends on — not at
      // silence. For the (very common) L4 = 0 patch that is the floor anyway;
      // for a patch with L4 > 0 the operator is already sounding at note-on.
      voice.envDb[i] = this.patch.operators[i]!.levelsDb[3];
      voice.envValue[i] = dx7EgAmpFromDb(voice.envDb[i]!);
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
      // msfa's `keydown(false)` → `advance(3)`: the release is entered from
      // WHEREVER the envelope had got to, including mid-attack.
      voice.envSeg[i] = 3;
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
        // the original DX7's render order in nearly every case, and
        // simplifies the algorithm graph. The feedback loop is always a
        // 1-sample delay by construction (v.fbMem is committed after the
        // whole op sweep, below).
        for (let opIdx = 0; opIdx < NUM_OPS; opIdx++) {
          const op = ops[opIdx]!;
          // Update envelope (4-segment, dB domain; holds at L3 until note-off).
          dx7EgTick(
            v.envDb, v.envSeg, opIdx,
            op.levelsDb, op.ratesDbPerSec, v.releasing, this.isr,
          );
          v.envValue[opIdx] = dx7EgAmpFromDb(v.envDb[opIdx]!);

          // Phase modulator: sum modulator op outputs (use this-block's
          // computed values for any op < current; previous-sample for any
          // op > current).
          let modIn = 0;
          const srcs = algo.modSrcs[opIdx]!;
          for (let s = 0; s < srcs.length; s++) {
            modIn += v.opOut[srcs[s]!]!;
          }
          // The feedback path, which is PER-ALGORITHM: inject the loop memory
          // into the op the chart wires it to (op6 in most algorithms, but
          // op2/op3/op4/op5 in others — see FEEDBACK_TABLE).
          if (opIdx === algo.feedback.to && fbAmount > 0) {
            modIn += v.fbMem * fbAmount;
          }

          // Phase advance.
          const ratio = op.ratio;
          const detune = op.detuneFactor;
          // FIXED mode ignores the note pitch, the ratio table AND detune.
          const opHz = op.fixedMode ? op.fixedHz : v.hz * ratio * detune;
          v.phase[opIdx] = (v.phase[opIdx]! + opHz * this.isr) % 1;

          // Sine + phase modulation. Modulation index scaled so that PM~3
          // gives full timbral character (DX7's actual scaling is more
          // complex but this is "musically close").
          const phase = v.phase[opIdx]! * TWO_PI + modIn * Math.PI;
          const s = Math.sin(phase);
          const sample = s * v.envValue[opIdx]! * op.outputAmp;
          v.opOut[opIdx] = sample;
        }
        // Feedback memory, sourced from THIS algorithm's feedback operator
        // (averaged over 2 samples like the original's anti-hunting filter).
        v.fbMem = (v.fbMem + v.opOut[algo.feedback.from]!) * 0.5;

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
// Helpers (must match dx7-syx.ts dx7LevelToAmp; duplicated inline because the
// worklet bundle can't import from packages/web).
// --------------------------------------------------------------

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

// ==============================================================
// THE OPERATOR ENVELOPE + FIXED-FREQUENCY LAW.
//
// MIRRORED VERBATIM from `packages/web/src/lib/audio/dx7-syx.ts`, which
// carries the full derivation and its two authoritative sources (Dexed/msfa
// `env.cc` + hexter's hardware-measured EG tables). The region between the two
// `dx7-envelope-mirror` markers must be TEXTUALLY IDENTICAL on both sides
// modulo the `export ` keyword — `dx7-envelope-mirror.test.ts` extracts both
// blocks, normalises them, requires equality, AND evaluates this copy to
// cross-check it numerically against the web one. Do NOT edit this block
// alone; edit the pair. Do NOT paraphrase the comments either — they are part
// of the compared text.
// ==============================================================

// dx7-envelope-mirror:start

/** 20·log10(2) — one octave of amplitude, in dB. */
const DX7_DB_PER_OCTAVE = 6.020599913279624;

/** dB per unit of the 0..99 operator LEVEL scale; level 99 = 0 dB = unity. */
const DX7_EG_LEVEL_DB_PER_STEP = 0.75;

/** Level 0 — the envelope's silence floor, in dB. Reaching it means zero. */
const DX7_EG_FLOOR_DB = (0 - 99) * DX7_EG_LEVEL_DB_PER_STEP;

/** The attack-compensation floor: a rising segment starting below this snaps
 *  up to it first. msfa's `jumptarget = 1716` back-converts to EG level 31,
 *  which is exactly hexter's "rise quickly to 31, then continue normally"
 *  (and why hexter's `rise_percent[0..31]` are all 1e-5 — levels below 31
 *  cost no time). */
const DX7_EG_ATTACK_JUMP_DB = (31 - 99) * DX7_EG_LEVEL_DB_PER_STEP;

/** hexter's MEASURED ratio of full-scale decay time to full-scale attack time
 *  at the SAME rate byte: `decay_duration[r] / rise_duration[r]`, a flat 8.01
 *  across rates 0..70 (it drifts only where the measurement resolution runs
 *  out). This is the attack's one calibration constant. */
const DX7_EG_ATTACK_SPEEDUP = 8.01;

/** The rising asymptote. msfa's rising law is
 *  `level_ += (((17 << 24) - level_) >> 24) * inc_` — the increment scales
 *  with the distance to a ceiling — but WHERE that ceiling lands on OUR level
 *  scale is ambiguous, because ours spans 74.25 dB and msfa's ~90: pinning our
 *  level 99 to msfa's unity-gain reference (`14 << 24`) gives 18.06 dB, and
 *  pinning it to msfa's maximum EG output gives 12.04 dB. So we take the form
 *  from msfa and the CALIBRATION from hexter's hardware measurement, solving
 *    -FLOOR / (DB_PER_OCTAVE · ln(1 - JUMP/CEIL)) = ATTACK_SPEEDUP
 *  for the ceiling. The answer, 13.92 dB, sits inside the msfa bracket — which
 *  is the cross-check that the two sources describe the same curve. */
const DX7_EG_ATTACK_CEIL_DB =
  -DX7_EG_ATTACK_JUMP_DB /
  (Math.exp(-DX7_EG_FLOOR_DB / (DX7_DB_PER_OCTAVE * DX7_EG_ATTACK_SPEEDUP)) - 1);

/** hexter's MEASURED seconds for a full-scale decay at rate 0
 *  (`dx7_voice_eg_rate_decay_duration[0]`). The rate law's one calibration
 *  constant; the shape of the curve is msfa's closed form. */
const DX7_EG_RATE0_FULL_SCALE_S = 317.487;

/** dB/s contributed by one unit of the quantised rate's mantissa. */
const DX7_EG_RATE_UNIT_DB_PER_S =
  -DX7_EG_FLOOR_DB / DX7_EG_RATE0_FULL_SCALE_S / 4;

/** Envelope LEVEL byte (0..99) → dB, on the same scale `dx7LevelToAmp` uses. */
function dx7LevelToDb(level: number): number {
  return (clampInt(level, 0, 99) - 99) * DX7_EG_LEVEL_DB_PER_STEP;
}

/** Envelope RATE byte (0..99) → dB per second, LINEAR IN dB (msfa's
 *  `inc_ = (4 + (qrate & 3)) << (2 + LG_N + (qrate >> 2))`). Quantised: the
 *  99 rate bytes collapse onto 64 distinct speeds, exactly as on the hardware. */
function dx7RateToDbPerSec(rate: number): number {
  const q = Math.min(63, (clampInt(rate, 0, 99) * 41) >> 6);
  return (4 + (q & 3)) * Math.pow(2, q >> 2) * DX7_EG_RATE_UNIT_DB_PER_S;
}

/** Envelope dB → linear amplitude. The floor is hard zero, so a segment that
 *  lands on level 0 is truly silent and the voice allocator can free the slot. */
function dx7EgAmpFromDb(db: number): number {
  return db <= DX7_EG_FLOOR_DB ? 0 : Math.pow(10, db / 20);
}

/**
 * Advance ONE operator's envelope by `dt` seconds, in place.
 *
 * `envSeg[i]` is the DX7 segment index: 0..2 run while the gate is high, 3 is
 * the release (entered only on note-off), 4 means finished. Reaching 3 with
 * the gate still high is the SUSTAIN — the envelope holds at L3 and this
 * function is a no-op until `releasing` goes true.
 *
 * `envDb` must be a Float64Array: at rate 0 the per-sample step is ~5e-6 dB,
 * which is below float32 epsilon at these magnitudes and would stall.
 */
function dx7EgTick(
  envDb: Float64Array,
  envSeg: Int32Array,
  i: number,
  levelsDb: readonly number[],
  ratesDbPerSec: readonly number[],
  releasing: boolean,
  dt: number,
): void {
  let seg = envSeg[i]!;
  if (seg >= 4) return;                  // finished
  if (seg === 3 && !releasing) return;   // HOLD at L3 while the gate is high
  let db = envDb[i]!;
  const target = levelsDb[seg]!;
  const rate = ratesDbPerSec[seg]!;
  if (db < target) {
    // RISING — msfa's asymptotic log-domain attack, after the level-31 jump.
    if (db < DX7_EG_ATTACK_JUMP_DB) db = DX7_EG_ATTACK_JUMP_DB;
    db += rate * ((DX7_EG_ATTACK_CEIL_DB - db) / DX7_DB_PER_OCTAVE) * dt;
    if (db >= target) {
      db = target;
      seg += 1;
    }
  } else {
    // FALLING (and the degenerate already-at-target case) — linear in dB.
    db -= rate * dt;
    if (db <= target) {
      db = target;
      seg += 1;
    }
  }
  envDb[i] = db;
  envSeg[i] = seg;
}

/** FIXED-frequency operator pitch in Hz: `10^((coarse & 3) + fine/100)`, so
 *  1 Hz .. 9.772 kHz. msfa: `logfreq = (4458616 * ((coarse & 3) * 100 + fine))
 *  >> 3` in Q24 log2 — 4458616/8 = 557327 ≈ (1<<24)·log2(10)/100. The note
 *  pitch, the ratio table and detune are ALL ignored in this mode. */
function dx7FixedHz(coarse: number, fine: number): number {
  return Math.pow(10, (coarse & 3) + clampInt(fine, 0, 99) / 100);
}

/** Legacy fallback for patches saved before `fixedHz` existed, which stored
 *  only `dx7Ratio(coarse, fine) = base · (1 + fine/100)`. Exact whenever
 *  fine = 0 (the overwhelmingly common cartridge case) and for coarse 0/1;
 *  genuinely ambiguous above that (ratio 3.0 is both coarse 3 / fine 0 and
 *  coarse 2 / fine 50), where we take the largest integer base ≤ ratio. */
function dx7FixedHzFromRatio(ratio: number): number {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const base = r < 1 ? 0 : Math.min(31, Math.floor(r));
  const fine = clampInt((r / (base === 0 ? 0.5 : base) - 1) * 100, 0, 99);
  return dx7FixedHz(base, fine);
}

// dx7-envelope-mirror:end

registerProcessor('dx7', Dx7Processor);
