// packages/dsp/src/twotracks.ts
//
// TWOTRACKS — tape loop emulator AudioWorklet (Phase 4: live waveform + WAV export).
//
// Phase 1 additions (reel A): stereo ring buffer, transport state machine,
// gate detection, varispeed, overdub, playhead reporting.
//
// Phase 2 additions:
//   • Reel B — independent second reel with its own ring buffer, cursor,
//     and transport state machine. All params/gates mirror reel A with _b suffix.
//   • 3-band biquad EQ per reel (applied after playback, before filter):
//       - Low-shelf  @ 200 Hz  (eqLow_{a,b}:  dB ±12, default 0)
//       - Mid-peak   @ 1 kHz   (eqMid_{a,b}:  dB ±12, default 0)
//       - High-shelf @ 8 kHz   (eqHigh_{a,b}: dB ±12, default 0)
//     Standard Audio Eq Cookbook biquad coefficients; separate L+R state.
//   • HP/LP/BP resonant SVF filter per reel (applied after EQ):
//       filterMode_{a,b}: 0=bypass, 1=HP, 2=LP, 3=BP (discrete)
//       cutoff_{a,b}: Hz, log-mapped by host; default 20000 (open)
//       reso_{a,b}: 0..1; default 0
//     Topology-preserving SVF (same math as resofilter-dsp.ts but inline;
//     NOT imported — the worklet is a standalone classic script entry).
//   • A/B mix law (linear crossfade with both-at-unity center):
//       ab param: 0..1 global
//       0→0.5: gainA=1, gainB rises 0→1
//       0.5→1: gainA falls 1→0, gainB=1
//       center 0.5: both at unity
//
// Phase 3 additions:
//   • Global Lofi stage (applied ONCE to combined A/B output):
//       lofi: 0=off, 1=low, 2=high, 3=error
//       lofiSeed: initial LCG PRNG state (reset on mode change)
//     Signal chain: saturation → HF loss → hiss → wow/flutter → chew(error only)
//     PRNG: 32-bit Numerical Recipes LCG (no Math.random() — worklet invariant)
//   • Per-reel scrub velocity → head-gap HF loss:
//       scrubVelocity_a, scrubVelocity_b: 0..10 (transient, not persisted)
//     1-pole IIR LP cutoff = max(400, 20000 / (1 + vel * 2)) Hz
//
// Phase 4 additions:
//   • Playhead messages now include `peaks`: a Float32Array of WAVEFORM_POINTS
//     peak-absolute values, computed over the live ring buffer. Sent every
//     playhead interval so the card can draw a live waveform without needing
//     the full buffer on the main thread.
//   • `dump-tape` request: host sends { type:'dump-tape', reel:'a'|'b' }.
//     Worklet responds with { type:'tape-data', reel, bufLen } plus transferred
//     bufL/bufR ArrayBuffers (copies, not the live ring buffer). The module
//     handler downloads the WAV directly without touching node.data.
//
// Signal path per reel:
//   ring-buffer read → scrub-loss LP → 3-band EQ → SVF filter → A/B mix → lofi → output
//
// Buffer layout: bufL[n] + bufR[n] parallel arrays (not interleaved).
// Playhead: worklet posts { type:'playhead', reel:'a'|'b', pos:0..1, state }
// every ~128 samples.
//
// IMPORTANT: this file does NOT export the Processor class at the top level —
// top-level exports break the ART classic-script eval. Class is registered via
// `registerProcessor` side-effect only.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tape length in samples (per channel). ~30 s at 48 kHz. */
const TWOTRACKS_MAX_SAMPLES = 1_440_000;

const TRIG_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Message types (host → worklet)
// ---------------------------------------------------------------------------

interface ResizeMessage {
  type: 'resize';
  reel: 'a' | 'b';
  length: number;
}

interface ResetMessage {
  type: 'reset';
  reel: 'a' | 'b';
}

interface SeekMessage {
  type: 'seek';
  reel: 'a' | 'b';
  pos: number;
}

interface DumpTapeMessage {
  type: 'dump-tape';
  reel: 'a' | 'b';
}

type TwoTracksMessage = ResizeMessage | ResetMessage | SeekMessage | DumpTapeMessage;

// ---------------------------------------------------------------------------
// Transport states
// ---------------------------------------------------------------------------

type TapeState = 'idle' | 'play' | 'armed' | 'rec' | 'overdub';

// ---------------------------------------------------------------------------
// EQ Biquad state (per band, per channel)
// ---------------------------------------------------------------------------

// Direct-form II transposed biquad state — two delay elements.
interface BiquadState { s1: number; s2: number; }

function makeBiquad(): BiquadState { return { s1: 0, s2: 0 }; }

/** Run one sample through a biquad (DF-II transposed).
 *  Coefficients: b0,b1,b2 (feed-forward), a1,a2 (feedback; a0 normalized to 1). */
function biquadStep(x: number, b0: number, b1: number, b2: number, a1: number, a2: number, st: BiquadState): number {
  const y = b0 * x + st.s1;
  st.s1 = b1 * x - a1 * y + st.s2;
  st.s2 = b2 * x - a2 * y;
  return y;
}

/**
 * Low-shelf biquad coefficients (Audio EQ Cookbook).
 * @param fcHz shelf frequency
 * @param dB   gain in dB (±12 max)
 * @param sr   sample rate
 */
function lowShelfCoeffs(fcHz: number, dB: number, sr: number): [number,number,number,number,number] {
  const A = Math.pow(10, dB / 40); // amplitude = 10^(dB/40) for shelf
  const w0 = 2 * Math.PI * fcHz / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const S = 1.0; // shelf slope = 1 (maximally flat)
  const alpha = sinW / 2 * Math.sqrt((A + 1/A) * (1/S - 1) + 2);

  const b0 =   A * ((A + 1) - (A - 1) * cosW + 2 * Math.sqrt(A) * alpha);
  const b1 = 2*A * ((A - 1) - (A + 1) * cosW);
  const b2 =   A * ((A + 1) - (A - 1) * cosW - 2 * Math.sqrt(A) * alpha);
  const a0 =        (A + 1) + (A - 1) * cosW + 2 * Math.sqrt(A) * alpha;
  const a1 =   -2 * ((A - 1) + (A + 1) * cosW);
  const a2 =        (A + 1) + (A - 1) * cosW - 2 * Math.sqrt(A) * alpha;
  return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}

/**
 * High-shelf biquad coefficients (Audio EQ Cookbook).
 */
function highShelfCoeffs(fcHz: number, dB: number, sr: number): [number,number,number,number,number] {
  const A = Math.pow(10, dB / 40);
  const w0 = 2 * Math.PI * fcHz / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const S = 1.0;
  const alpha = sinW / 2 * Math.sqrt((A + 1/A) * (1/S - 1) + 2);

  const b0 =   A * ((A + 1) + (A - 1) * cosW + 2 * Math.sqrt(A) * alpha);
  const b1 =-2*A * ((A - 1) + (A + 1) * cosW);
  const b2 =   A * ((A + 1) + (A - 1) * cosW - 2 * Math.sqrt(A) * alpha);
  const a0 =        (A + 1) - (A - 1) * cosW + 2 * Math.sqrt(A) * alpha;
  const a1 =    2 * ((A - 1) - (A + 1) * cosW);
  const a2 =        (A + 1) - (A - 1) * cosW - 2 * Math.sqrt(A) * alpha;
  return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}

/**
 * Peaking EQ biquad coefficients (Audio EQ Cookbook, "peakingEQ" form).
 * Q=1.0 gives a musically useful bandwidth.
 */
function peakEqCoeffs(fcHz: number, dB: number, sr: number): [number,number,number,number,number] {
  const A = Math.pow(10, dB / 40);
  const w0 = 2 * Math.PI * fcHz / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const Q = 1.0;
  const alpha = sinW / (2 * Q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha / A;
  return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}

// ---------------------------------------------------------------------------
// SVF filter state (per channel)
// ---------------------------------------------------------------------------

interface SvfState { ic1: number; ic2: number; }
function makeSvf(): SvfState { return { ic1: 0, ic2: 0 }; }

/**
 * One-sample TPT SVF step (Cytomic / Zavalishin form).
 * Returns { lp, bp, hp }.
 */
function svfStep(
  x: number,
  g: number,  // tan(π * fc / sr)
  k: number,  // 2 - 2*res, clamped above 0
  st: SvfState,
): { lp: number; bp: number; hp: number } {
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = x - st.ic2;
  const v1 = a1 * st.ic1 + a2 * v3;
  const v2 = st.ic2 + a2 * st.ic1 + a3 * v3;
  st.ic1 = 2 * v1 - st.ic1;
  st.ic2 = 2 * v2 - st.ic2;
  return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
}

/** Compute g = tan(π * fc / sr), clamped safely. */
function cutoffToG(fcHz: number, sr: number): number {
  const fc = fcHz < 10 ? 10 : fcHz > sr * 0.49 ? sr * 0.49 : fcHz;
  return Math.tan(Math.PI * fc / sr);
}

// ---------------------------------------------------------------------------
// A/B mix law (pure, exported as a helper comment; tested via ab gains utility)
// ---------------------------------------------------------------------------
//
// abGains(ab): gainA, gainB
//   ab in [0, 0.5]: gainA = 1.0, gainB = ab * 2
//   ab in [0.5, 1]: gainA = (1 - ab) * 2, gainB = 1.0
//   center (0.5): gainA = 1.0, gainB = 1.0 (both unity)

function abGains(ab: number): { gainA: number; gainB: number } {
  const t = ab < 0 ? 0 : ab > 1 ? 1 : ab;
  if (t <= 0.5) {
    return { gainA: 1.0, gainB: t * 2 };
  } else {
    return { gainA: (1 - t) * 2, gainB: 1.0 };
  }
}

// ---------------------------------------------------------------------------
// Reel state — one instance per reel (A + B)
// ---------------------------------------------------------------------------

class ReelState {
  // Ring buffers (stereo, separate L/R)
  bufL: Float32Array = new Float32Array(TWOTRACKS_MAX_SAMPLES);
  bufR: Float32Array = new Float32Array(TWOTRACKS_MAX_SAMPLES);
  bufLen: number = 0;

  // Playback cursor
  cursor: number = 0;

  // Transport state
  state: TapeState = 'idle';
  overdubFlag: boolean = false;
  pendingDecay: boolean = false;

  // Edge detection
  lastRecStart: number = 0;
  lastRecArm: number = 0;
  lastOverdubToggle: number = 0;

  // Pending seek from host
  pendingSeek: number | null = null;

  // EQ biquad states (low L+R, mid L+R, high L+R)
  eqLowL: BiquadState = makeBiquad();
  eqLowR: BiquadState = makeBiquad();
  eqMidL: BiquadState = makeBiquad();
  eqMidR: BiquadState = makeBiquad();
  eqHighL: BiquadState = makeBiquad();
  eqHighR: BiquadState = makeBiquad();

  // SVF filter states (L + R)
  svfL: SvfState = makeSvf();
  svfR: SvfState = makeSvf();

  // Playhead reporting throttle
  playheadFrameCount: number = 0;

  // Phase 3: scrub velocity HF loss state (1-pole IIR per channel)
  scrubLossL: number = 0;
  scrubLossR: number = 0;
}

// ---------------------------------------------------------------------------
// Lofi state — global, applied once to combined A/B output
// ---------------------------------------------------------------------------

/**
 * Lofi tape degradation stage.
 * Algorithm citation: Numerical Recipes LCG (Numerical Recipes in C, 2nd ed.),
 * combined with standard 1-pole IIR, tanh saturation, and slow sine wow/flutter.
 */
class LofiState {
  hfLossL: number = 0;   // 1-pole state L
  hfLossR: number = 0;   // 1-pole state R
  wowPhase: number = 0;
  flutterPhase: number = 0;
  rngState: number = 12345; // reset from lofiSeed on mode change
  lastLofiMode: number = -1;
  // Chew/dropout state (error mode only)
  grainActive: boolean = false;
  grainRemaining: number = 0;
  grainType: number = 0;       // 0=stutter, 1=silence
  stutterSampleL: number = 0;
  stutterSampleR: number = 0;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

class TwoTracksProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // ==================== REEL A ====================
      { name: 'rate',           defaultValue: 1,      minValue: -3, maxValue: 3,     automationRate: 'a-rate' as const },
      { name: 'mode',           defaultValue: 1,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'start',          defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'end',            defaultValue: 1,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'decay',          defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'rec_start',      defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      { name: 'rec_arm',        defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      { name: 'overdub_toggle', defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      // EQ per reel A
      { name: 'eqLow_a',        defaultValue: 0,      minValue: -12, maxValue: 12,   automationRate: 'k-rate' as const },
      { name: 'eqMid_a',        defaultValue: 0,      minValue: -12, maxValue: 12,   automationRate: 'k-rate' as const },
      { name: 'eqHigh_a',       defaultValue: 0,      minValue: -12, maxValue: 12,   automationRate: 'k-rate' as const },
      // Filter per reel A: mode 0=bypass,1=HP,2=LP,3=BP
      { name: 'filterMode_a',   defaultValue: 0,      minValue: 0,  maxValue: 3,     automationRate: 'k-rate' as const },
      { name: 'cutoff_a',       defaultValue: 20000,  minValue: 20, maxValue: 20000, automationRate: 'k-rate' as const },
      { name: 'reso_a',         defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },

      // ==================== REEL B ====================
      { name: 'rate_b',           defaultValue: 1,      minValue: -3, maxValue: 3,     automationRate: 'a-rate' as const },
      { name: 'mode_b',           defaultValue: 1,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'start_b',          defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'end_b',            defaultValue: 1,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'decay_b',          defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      { name: 'rec_start_b',      defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      { name: 'rec_arm_b',        defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      { name: 'overdub_toggle_b', defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      // EQ per reel B
      { name: 'eqLow_b',          defaultValue: 0,      minValue: -12, maxValue: 12,   automationRate: 'k-rate' as const },
      { name: 'eqMid_b',          defaultValue: 0,      minValue: -12, maxValue: 12,   automationRate: 'k-rate' as const },
      { name: 'eqHigh_b',         defaultValue: 0,      minValue: -12, maxValue: 12,   automationRate: 'k-rate' as const },
      // Filter per reel B
      { name: 'filterMode_b',     defaultValue: 0,      minValue: 0,  maxValue: 3,     automationRate: 'k-rate' as const },
      { name: 'cutoff_b',         defaultValue: 20000,  minValue: 20, maxValue: 20000, automationRate: 'k-rate' as const },
      { name: 'reso_b',           defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },

      // ==================== GLOBAL ====================
      /** A/B crossfade: 0=A only, 0.5=both unity, 1=B only */
      { name: 'ab',               defaultValue: 0,      minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
      // Lofi tape degradation (applied to combined output)
      { name: 'lofi',             defaultValue: 0,      minValue: 0,  maxValue: 3,     automationRate: 'k-rate' as const },
      { name: 'lofiSeed',         defaultValue: 12345,  minValue: 0,  maxValue: 4294967295, automationRate: 'k-rate' as const },
      // Scrub velocity — transient, host-driven, not persisted
      { name: 'scrubVelocity_a',  defaultValue: 0,      minValue: 0,  maxValue: 10,    automationRate: 'k-rate' as const },
      { name: 'scrubVelocity_b',  defaultValue: 0,      minValue: 0,  maxValue: 10,    automationRate: 'k-rate' as const },
    ];
  }

  private readonly PLAYHEAD_INTERVAL = 4; // every 4 blocks ≈ 11 ms at 48 kHz
  private readonly WAVEFORM_POINTS = 200; // peaks sent with each playhead update

  private reelA: ReelState = new ReelState();
  private reelB: ReelState = new ReelState();
  private lofiState: LofiState = new LofiState();

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as TwoTracksMessage);
  }

  private handleMessage(msg: TwoTracksMessage): void {
    if (!msg || typeof msg !== 'object') return;
    const reel = msg.reel === 'b' ? this.reelB : this.reelA;
    if (msg.type === 'resize') {
      const len = Math.max(1, Math.min(TWOTRACKS_MAX_SAMPLES, msg.length));
      reel.bufLen = len;
    } else if (msg.type === 'reset') {
      reel.cursor = 0;
      reel.state = 'idle';
      reel.pendingDecay = false;
    } else if (msg.type === 'seek') {
      reel.pendingSeek = Math.max(0, Math.min(1, msg.pos));
    } else if (msg.type === 'dump-tape') {
      const len = Math.min(reel.bufLen, TWOTRACKS_MAX_SAMPLES);
      if (len > 0) {
        // Copy the active portion (slice creates a new Float32Array, not a view).
        const copyL = reel.bufL.slice(0, len);
        const copyR = reel.bufR.slice(0, len);
        try {
          this.port.postMessage(
            { type: 'tape-data', reel: msg.reel, bufLen: len },
            [copyL.buffer, copyR.buffer],
          );
        } catch { /* port may be closed */ }
      }
    }
  }

  /** Linear interpolation read from a channel buffer. */
  private readChan(buf: Float32Array, pos: number): number {
    const len = buf.length;
    if (len === 0 || pos < 0) return 0;
    if (pos >= len - 1) {
      return pos < len ? (buf[len - 1] ?? 0) : 0;
    }
    const i = Math.floor(pos);
    const f = pos - i;
    const a = buf[i] ?? 0;
    const b = buf[i + 1] ?? 0;
    return a + (b - a) * f;
  }

  /** Apply overdub decay to the entire active window in place. */
  private applyDecay(reel: ReelState, windowStart: number, windowEnd: number, decayFactor: number): void {
    const s = Math.floor(windowStart);
    const e = Math.min(Math.ceil(windowEnd), reel.bufLen);
    for (let i = s; i < e; i++) {
      reel.bufL[i]! *= decayFactor;
      reel.bufR[i]! *= decayFactor;
    }
  }

  /**
   * Process one reel block and accumulate its output into outL/outR arrays,
   * scaled by gainA/gainB. Handles transport, EQ, filter, and scrub.
   */
  private processReel(
    reel: ReelState,
    reelId: 'a' | 'b',
    outL: Float32Array,
    outR: Float32Array,
    gain: number,
    inputs: Float32Array[][],
    inputOffset: number, // 0 for reel A (inputs 0,1), 2 for reel B (inputs 2,3)
    parameters: Record<string, Float32Array>,
    suffix: '' | '_b', // '' for reel A param names, '_b' for reel B
    blockLen: number,
  ): void {
    // --- k-rate params ---
    const kv = (name: string, fallback: number): number => {
      const arr = parameters[name];
      return arr && arr.length > 0 ? (arr[0] ?? fallback) : fallback;
    };
    // --- a-rate params ---
    const av = (name: string, i: number, fallback: number): number => {
      const arr = parameters[name];
      if (!arr || arr.length === 0) return fallback;
      return (arr.length > 1 ? arr[i] : arr[0]) ?? fallback;
    };

    // Reel A uses old param names (no suffix on core params) for back-compat.
    // Reel B uses _b suffix on all params.
    const pRate        = suffix === '' ? 'rate'            : 'rate_b';
    const pMode        = suffix === '' ? 'mode'            : 'mode_b';
    const pStart       = suffix === '' ? 'start'           : 'start_b';
    const pEnd         = suffix === '' ? 'end'             : 'end_b';
    const pDecay       = suffix === '' ? 'decay'           : 'decay_b';
    const pRecStart    = suffix === '' ? 'rec_start'       : 'rec_start_b';
    const pRecArm      = suffix === '' ? 'rec_arm'         : 'rec_arm_b';
    const pOverdubTog  = suffix === '' ? 'overdub_toggle'  : 'overdub_toggle_b';
    const pEqLow       = `eqLow${suffix === '' ? '_a' : '_b'}`;
    const pEqMid       = `eqMid${suffix === '' ? '_a' : '_b'}`;
    const pEqHigh      = `eqHigh${suffix === '' ? '_a' : '_b'}`;
    const pFilterMode  = `filterMode${suffix === '' ? '_a' : '_b'}`;
    const pCutoff      = `cutoff${suffix === '' ? '_a' : '_b'}`;
    const pReso        = `reso${suffix === '' ? '_a' : '_b'}`;
    const pScrubVel    = suffix === '' ? 'scrubVelocity_a' : 'scrubVelocity_b';

    const modeVal    = Math.round(kv(pMode, 1)); // 0=one-shot, 1=loop
    const startNorm  = kv(pStart, 0);
    const endNorm    = kv(pEnd, 1);
    const decayParam = kv(pDecay, 0);

    // EQ params (k-rate; biquad coeffs recomputed per block at k-rate)
    const eqLowDb  = kv(pEqLow, 0);
    const eqMidDb  = kv(pEqMid, 0);
    const eqHighDb = kv(pEqHigh, 0);

    // Filter params (k-rate)
    const filterMode = Math.round(kv(pFilterMode, 0)); // 0=bypass,1=HP,2=LP,3=BP
    const cutoffHz   = kv(pCutoff, 20000);
    const resoVal    = kv(pReso, 0);

    // Scrub velocity (k-rate)
    const scrubVelocity = kv(pScrubVel, 0);
    // Compute scrub loss 1-pole coefficient (bypass at low velocity)
    const scrubActive = scrubVelocity > 0.01;
    const scrubCutoff = Math.max(400, 20000 / (1 + scrubVelocity * 2));
    const scrubA = 1 - Math.exp(-2 * Math.PI * scrubCutoff / sampleRate);

    // Audio inputs for this reel
    const inL = inputs[inputOffset]?.[0];
    const inR = inputs[inputOffset + 1]?.[0] ?? inL;

    // Gate arrays (a-rate for edge detection)
    const recStartArr    = parameters[pRecStart]!;
    const recArmArr      = parameters[pRecArm]!;
    const overdubTogArr  = parameters[pOverdubTog]!;

    // Compute absolute window
    const maxLen      = reel.bufLen > 0 ? reel.bufLen : TWOTRACKS_MAX_SAMPLES;
    const windowStart = Math.max(0, Math.min(maxLen - 1, startNorm * maxLen));
    const windowEnd   = Math.max(windowStart + 1, Math.min(maxLen, endNorm * maxLen));
    const windowLen   = windowEnd - windowStart;

    const decayFactor = 0.90 - decayParam * 0.40;

    // Apply pending seek
    if (reel.pendingSeek !== null) {
      reel.cursor = windowStart + reel.pendingSeek * windowLen;
      reel.pendingSeek = null;
    }

    // Clamp cursor after param changes
    if (reel.cursor < windowStart || reel.cursor > windowEnd) {
      reel.cursor = windowStart;
    }

    // Compute EQ coefficients (k-rate, once per block)
    const lowC  = lowShelfCoeffs(200, eqLowDb, sampleRate);
    const midC  = peakEqCoeffs(1000, eqMidDb, sampleRate);
    const highC = highShelfCoeffs(8000, eqHighDb, sampleRate);

    // Compute SVF coefficients (k-rate, once per block)
    const svfG = cutoffToG(cutoffHz, sampleRate);
    const svfK = Math.max(0.003, 2 - 2 * (resoVal < 0 ? 0 : resoVal > 1 ? 1 : resoVal));

    for (let i = 0; i < blockLen; i++) {
      // ---- Gate edge detection ----
      const recStartVal   = recStartArr.length > 1 ? (recStartArr[i] ?? 0) : (recStartArr[0] ?? 0);
      const recArmVal     = recArmArr.length > 1   ? (recArmArr[i]   ?? 0) : (recArmArr[0]   ?? 0);
      const overdubTogVal = overdubTogArr.length > 1 ? (overdubTogArr[i] ?? 0) : (overdubTogArr[0] ?? 0);

      // rec_arm rising edge → ARMED
      if (reel.lastRecArm < TRIG_THRESHOLD && recArmVal >= TRIG_THRESHOLD) {
        reel.state = 'armed';
        reel.pendingDecay = true;
      }
      reel.lastRecArm = recArmVal;

      // rec_start rising edge → REC or OVERDUB
      if (reel.lastRecStart < TRIG_THRESHOLD && recStartVal >= TRIG_THRESHOLD) {
        if (reel.state !== 'rec' && reel.state !== 'overdub') {
          reel.state = reel.overdubFlag ? 'overdub' : 'rec';
          reel.pendingDecay = true;
          if (modeVal === 0) {
            reel.cursor = windowStart;
            if (reel.pendingDecay) {
              this.applyDecay(reel, windowStart, windowEnd, decayFactor);
              reel.pendingDecay = false;
            }
          }
        }
      }
      reel.lastRecStart = recStartVal;

      // overdub_toggle rising edge → flip overdub flag; swap rec↔overdub if active
      if (reel.lastOverdubToggle < TRIG_THRESHOLD && overdubTogVal >= TRIG_THRESHOLD) {
        reel.overdubFlag = !reel.overdubFlag;
        if (reel.state === 'rec') reel.state = 'overdub';
        else if (reel.state === 'overdub') reel.state = 'rec';
      }
      reel.lastOverdubToggle = overdubTogVal;

      // ---- ARMED: wait for cursor to cross windowStart ----
      if (reel.state === 'armed') {
        const rate0 = av(pRate, i, 1);
        if (modeVal === 0 || Math.abs(reel.cursor - windowStart) < Math.abs(rate0) + 1) {
          reel.state = reel.overdubFlag ? 'overdub' : 'rec';
          reel.pendingDecay = true;
          if (modeVal === 0) {
            reel.cursor = windowStart;
          }
        }
      }

      // ---- Decay application ----
      if (reel.pendingDecay && (reel.state === 'rec' || reel.state === 'overdub')) {
        if (reel.state === 'overdub') {
          this.applyDecay(reel, windowStart, windowEnd, decayFactor);
        }
        reel.pendingDecay = false;
      }

      // ---- Ring buffer read ----
      let sL = this.readChan(reel.bufL, reel.cursor);
      let sR = this.readChan(reel.bufR, reel.cursor);

      // ---- Scrub velocity HF loss (1-pole IIR LP) ----
      // Emulates head-gap high-frequency loss during manual scrubbing.
      // Only applied when velocity > 0.01 to avoid needless computation at idle.
      if (scrubActive) {
        sL = scrubA * sL + (1 - scrubA) * reel.scrubLossL;
        reel.scrubLossL = sL;
        sR = scrubA * sR + (1 - scrubA) * reel.scrubLossR;
        reel.scrubLossR = sR;
      }

      // ---- Write (record) ----
      if ((reel.state === 'rec' || reel.state === 'overdub') && reel.cursor >= 0) {
        const ci = Math.floor(reel.cursor);
        if (ci >= 0 && ci < TWOTRACKS_MAX_SAMPLES) {
          const srcL = inL ? (inL[i] ?? 0) : 0;
          const srcR = inR ? (inR[i] ?? 0) : srcL;
          if (reel.state === 'overdub') {
            reel.bufL[ci]! += srcL;
            reel.bufR[ci]! += srcR;
          } else {
            reel.bufL[ci] = srcL;
            reel.bufR[ci] = srcR;
          }
          if (ci >= reel.bufLen) reel.bufLen = ci + 1;
        }
      }

      // ---- 3-band EQ (applied to playback signal) ----
      // Only compute if not at unity (skip when all EQ is 0 dB)
      if (eqLowDb !== 0) {
        sL = biquadStep(sL, lowC[0], lowC[1], lowC[2], lowC[3], lowC[4], reel.eqLowL);
        sR = biquadStep(sR, lowC[0], lowC[1], lowC[2], lowC[3], lowC[4], reel.eqLowR);
      }
      if (eqMidDb !== 0) {
        sL = biquadStep(sL, midC[0], midC[1], midC[2], midC[3], midC[4], reel.eqMidL);
        sR = biquadStep(sR, midC[0], midC[1], midC[2], midC[3], midC[4], reel.eqMidR);
      }
      if (eqHighDb !== 0) {
        sL = biquadStep(sL, highC[0], highC[1], highC[2], highC[3], highC[4], reel.eqHighL);
        sR = biquadStep(sR, highC[0], highC[1], highC[2], highC[3], highC[4], reel.eqHighR);
      }

      // ---- SVF Filter (HP/LP/BP) ----
      // filterMode: 0=bypass, 1=HP, 2=LP, 3=BP
      if (filterMode !== 0) {
        const tapsL = svfStep(sL, svfG, svfK, reel.svfL);
        const tapsR = svfStep(sR, svfG, svfK, reel.svfR);
        if (filterMode === 1) {
          sL = tapsL.hp; sR = tapsR.hp;
        } else if (filterMode === 2) {
          sL = tapsL.lp; sR = tapsR.lp;
        } else {
          sL = tapsL.bp; sR = tapsR.bp;
        }
      }

      // ---- Output: accumulate scaled into the shared output buffers ----
      const isActive = reel.state !== 'idle';
      outL[i] += gain * (isActive ? sL : 0);
      outR[i] += gain * (isActive ? sR : 0);

      // ---- Advance cursor ----
      const rate = av(pRate, i, 1);
      reel.cursor += rate;

      // ---- Window boundary handling ----
      if (reel.cursor >= windowEnd) {
        if (modeVal === 1) {
          const ov = (reel.cursor - windowStart) % windowLen;
          reel.cursor = windowStart + ov;
          if (reel.state === 'overdub') {
            this.applyDecay(reel, windowStart, windowEnd, decayFactor);
          }
        } else {
          reel.cursor = windowEnd;
          if (reel.state === 'rec' || reel.state === 'overdub') {
            reel.state = 'play';
            reel.cursor = windowStart;
          } else if (reel.state === 'play') {
            reel.state = 'idle';
            reel.cursor = windowStart;
          }
        }
      } else if (reel.cursor < windowStart) {
        if (modeVal === 1) {
          const ov = (windowStart - reel.cursor) % windowLen;
          reel.cursor = windowEnd - ov;
        } else {
          reel.cursor = windowStart;
          if (reel.state === 'rec' || reel.state === 'overdub') {
            reel.state = 'play';
          } else if (reel.state === 'play') {
            reel.state = 'idle';
          }
        }
      }
    }

    // ---- Playhead reporting (throttled) ----
    reel.playheadFrameCount++;
    if (reel.playheadFrameCount >= this.PLAYHEAD_INTERVAL) {
      reel.playheadFrameCount = 0;
      const normalized = windowLen > 0
        ? Math.max(0, Math.min(1, (reel.cursor - windowStart) / windowLen))
        : 0;
      // Compute downsampled peak waveform for card display.
      const pts = this.WAVEFORM_POINTS;
      const peaks = new Float32Array(pts);
      if (reel.bufLen > 0) {
        const sampPerPt = reel.bufLen / pts;
        for (let p = 0; p < pts; p++) {
          const i0 = Math.floor(p * sampPerPt);
          const i1 = Math.min(Math.floor((p + 1) * sampPerPt), reel.bufLen);
          let mx = 0;
          for (let i = i0; i < i1; i++) {
            const s = Math.abs(reel.bufL[i] ?? 0);
            if (s > mx) mx = s;
          }
          peaks[p] = mx;
        }
      }
      try {
        this.port.postMessage({ type: 'playhead', reel: reelId, pos: normalized, state: reel.state, bufLen: reel.bufLen, peaks });
      } catch { /* worklet may be torn down */ }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL && !outR) return true;

    const blockLen = outL?.length ?? outR?.length ?? 128;

    // Zero the output buffers (we accumulate via +=)
    if (outL) outL.fill(0);
    if (outR) outR.fill(0);

    // A/B gain law
    const abVal = (parameters['ab']?.[0]) ?? 0;
    const { gainA, gainB } = abGains(abVal);

    // Temporary buffers for each reel's output
    const tmpAL = new Float32Array(blockLen);
    const tmpAR = new Float32Array(blockLen);
    const tmpBL = new Float32Array(blockLen);
    const tmpBR = new Float32Array(blockLen);

    // Process reel A: audio inputs [0]=L, [1]=R; gates via AudioParams
    // (inputs 2,3 reserved for reel B audio)
    this.processReel(
      this.reelA, 'a',
      tmpAL, tmpAR,
      1.0, // gain applied after mix below
      inputs, 0, // inputOffset=0 → inputs[0]=L, inputs[1]=R
      parameters, '',
      blockLen,
    );

    // Process reel B: audio inputs [2]=L, [3]=R
    this.processReel(
      this.reelB, 'b',
      tmpBL, tmpBR,
      1.0,
      inputs, 2, // inputOffset=2 → inputs[2]=L, inputs[3]=R
      parameters, '_b',
      blockLen,
    );

    // Mix reels into final output
    if (outL) {
      for (let i = 0; i < blockLen; i++) {
        outL[i] = (tmpAL[i] ?? 0) * gainA + (tmpBL[i] ?? 0) * gainB;
      }
    }
    if (outR) {
      for (let i = 0; i < blockLen; i++) {
        outR[i] = (tmpAR[i] ?? 0) * gainA + (tmpBR[i] ?? 0) * gainB;
      }
    }

    // ---- Global Lofi stage (applied to combined output) ----
    const lofiMode = Math.round((parameters['lofi']?.[0]) ?? 0);
    if (lofiMode > 0 && outL && outR) {
      const lofiSeedParam = (parameters['lofiSeed']?.[0]) ?? 12345;
      const lo = this.lofiState;

      // Reset LCG seed when mode changes
      if (lo.lastLofiMode !== lofiMode) {
        lo.rngState = Math.round(lofiSeedParam) >>> 0;
        lo.lastLofiMode = lofiMode;
      }

      // Per-mode constants
      // Saturation: tanh(drive * x + offset) * outGain
      const drive    = lofiMode === 1 ? 1.2 : 2.0;
      const offset   = lofiMode === 1 ? 0.01 : 0.03;
      const outGain  = lofiMode === 1 ? 1 / Math.tanh(1.2) : 1 / Math.tanh(2.0);

      // HF loss cutoff
      const hfCutoff = lofiMode === 1 ? 8000 : 4000;
      const hfA      = 1 - Math.exp(-2 * Math.PI * hfCutoff / sampleRate);

      // Hiss amplitude
      const hissAmp  = lofiMode === 1 ? 0.002 : lofiMode === 2 ? 0.006 : 0.010;

      // Wow/flutter depths
      const wowDepth     = lofiMode === 1 ? 0.0005 : 0.002;
      const flutterDepth = lofiMode === 1 ? 0.0003 : 0.001;

      // Wow LFO: ~0.7 Hz; flutter LFO: ~7 Hz
      const wowInc     = 2 * Math.PI * 0.7 / sampleRate;
      const flutterInc = 2 * Math.PI * 7.0 / sampleRate;

      // Granular chew constants (error mode only)
      const CHEW_PROB    = 0.00005;
      const MIN_GRAIN_MS = 20;
      const MAX_GRAIN_MS = 80;

      for (let i = 0; i < blockLen; i++) {
        let sL = outL[i] ?? 0;
        let sR = outR[i] ?? 0;

        // 1. Saturation (tanh soft-clip with asymmetry)
        sL = Math.tanh(drive * sL + offset) * outGain;
        sR = Math.tanh(drive * sR + offset) * outGain;

        // 2. HF loss (1-pole IIR low-pass)
        lo.hfLossL = hfA * sL + (1 - hfA) * lo.hfLossL;
        sL = lo.hfLossL;
        lo.hfLossR = hfA * sR + (1 - hfA) * lo.hfLossR;
        sR = lo.hfLossR;

        // 3. Hiss (LCG white noise, additive)
        lo.rngState = ((lo.rngState * 1664525 + 1013904223) >>> 0);
        const noiseL = (lo.rngState / 2147483648 - 1) * hissAmp;
        lo.rngState = ((lo.rngState * 1664525 + 1013904223) >>> 0);
        const noiseR = (lo.rngState / 2147483648 - 1) * hissAmp;
        sL += noiseL;
        sR += noiseR;

        // 4. Wow/flutter (multiply by small modulation — approximates flutter without delay line)
        const mod = wowDepth * Math.sin(lo.wowPhase) + flutterDepth * Math.cos(lo.flutterPhase);
        sL *= (1 + mod);
        sR *= (1 + mod);
        lo.wowPhase     += wowInc;
        lo.flutterPhase += flutterInc;
        // Wrap phases to prevent accumulation drift
        if (lo.wowPhase     > 2 * Math.PI) lo.wowPhase     -= 2 * Math.PI;
        if (lo.flutterPhase > 2 * Math.PI) lo.flutterPhase -= 2 * Math.PI;

        // 5. Granular chew / error dropouts (error mode only, lofi === 3)
        if (lofiMode === 3) {
          if (lo.grainActive) {
            lo.grainRemaining--;
            if (lo.grainRemaining <= 0) lo.grainActive = false;
          }
          if (!lo.grainActive) {
            // Roll LCG to decide if a new grain starts
            lo.rngState = ((lo.rngState * 1664525 + 1013904223) >>> 0);
            const prob = lo.rngState / 4294967296;
            if (prob < CHEW_PROB) {
              // New grain: random length 20-80ms
              lo.rngState = ((lo.rngState * 1664525 + 1013904223) >>> 0);
              const lenFrac = lo.rngState / 4294967296;
              const grainLenMs = MIN_GRAIN_MS + lenFrac * (MAX_GRAIN_MS - MIN_GRAIN_MS);
              lo.grainRemaining = Math.round(grainLenMs * sampleRate / 1000);
              // Random grain type: 0=stutter, 1=silence
              lo.rngState = ((lo.rngState * 1664525 + 1013904223) >>> 0);
              lo.grainType = (lo.rngState >>> 31); // MSB = 0 or 1
              lo.grainActive = true;
              if (lo.grainType === 0) {
                // Stutter: capture current input sample
                lo.stutterSampleL = sL;
                lo.stutterSampleR = sR;
              }
            }
          }
          if (lo.grainActive) {
            if (lo.grainType === 1) {
              // Silence
              sL = 0;
              sR = 0;
            } else {
              // Stutter (frozen sample)
              sL = lo.stutterSampleL;
              sR = lo.stutterSampleR;
            }
          }
        }

        outL[i] = sL;
        outR[i] = sR;
      }
    }

    return true;
  }
}

registerProcessor('twotracks', TwoTracksProcessor);
