// packages/dsp/src/lib/warrensspectrum-filterbank.ts
//
// WARREN'S SPECTRUM — the 8-band resonant FILTERBANK (phase 2).
//
// A port of `src/dsp/FilterBank.{h,cpp}` + `src/dsp/Svf.h` from the Warren's
// Spectrum VST (CMake project id `callsine`, MIT). Kept in its OWN file
// rather than folded into warrensspectrum-dsp.ts for one reason that matters
// to the ART gate: the spectral engine's `.f32` baselines are SHA-pinned to
// `lib/warrensspectrum-dsp.ts` + `warrensspectrum.ts`, and a filterbank that
// lives elsewhere can grow without dragging that pin — while a change to the
// ROUTING (which does live in the engine) correctly still moves it.
//
// ── WHY THE BANK IS THE PHASE-2 INCREMENT ─────────────────────────────────
// `PluginProcessor::processBlock` sums its input to MONO before the engine,
// and `resynthBuf_` is one channel: the plugin is mono all the way to here.
// STEREO IS CREATED IN THIS FILE, by `setPan`'s equal-power split. That is
// why the bank — not the FX slots, not MASSPASS — is what phase 2 buys.
//
// ── WHAT IS AND IS NOT PORTED ─────────────────────────────────────────────
// Ported: cutoff, resonance, type morph (LP→BP→HP), pan, MAIN send, the
// all-sends-zero band skip, and the TPT/Zavalishin SVF verbatim.
// NOT ported (phase 3, when the FX slots exist): `fx1Send` / `fx2Send`. A
// send with nothing to send to is a control that cannot move the output —
// exactly the dead-parameter class this module's own history warns about —
// so the two FX buses are absent rather than present-and-inert.
// `setBandBypass` is likewise absent: it exists upstream to keep a band's
// cutoff automation alive while muting it, and with no automation lanes on a
// per-band table here it would only duplicate `send = 0`.

/** Bands in the bank. Fixed at 8 by the upstream contract (`kNumBands`). */
export const WS_NUM_BANDS = 8;

/** Cutoff range — `PluginParams.h:246` (20 Hz .. 20 kHz, log-skewed). */
export const WS_BAND_CUTOFF_MIN_HZ = 20;
export const WS_BAND_CUTOFF_MAX_HZ = 20000;
/** Resonance range — `PluginParams.h:252` (0.5 .. 20; 0.7071 ≈ Butterworth). */
export const WS_BAND_Q_MIN = 0.5;
export const WS_BAND_Q_MAX = 20;
/** MAIN send range. Capped at 1.0 upstream in its phase 34 — the pre-1.0
 *  boost zone put 293/304 of its own ART sweep cases above 0 dBFS. Keep the
 *  cap; the module's GAIN control is where boost belongs. */
export const WS_BAND_SEND_MIN = 0;
export const WS_BAND_SEND_MAX = 1;

/** Log-spaced default cutoffs — `FilterBank::prepare` / `PluginParams.h:236`. */
export const WS_BAND_DEFAULT_HZ: readonly number[] = [60, 120, 250, 500, 1000, 2000, 4000, 8000];
/** Default type morph per band: lows HP, mids BP, highs LP — an EQ-shaped
 *  starting layout (`PluginParams.h:kBandDefaultType`). */
export const WS_BAND_DEFAULT_TYPE: readonly number[] = [1, 1, 1, 0.5, 0.5, 0, 0, 0];
export const WS_BAND_DEFAULT_Q = 0.7071;
export const WS_BAND_DEFAULT_PAN = 0;
export const WS_BAND_DEFAULT_SEND = 0.5;

/** One band's user-facing state. Plain numbers so the whole table survives a
 *  `structuredClone` across the AudioWorklet `port` boundary. */
export interface WsBandSettings {
  /** Hz, 20..20000. */
  cutoffHz: number;
  /** Resonance, 0.5..20. */
  q: number;
  /** 0 = LP, 0.5 = BP, 1 = HP; continuous. */
  type: number;
  /** -1 hard left .. +1 hard right, equal-power. */
  pan: number;
  /** MAIN-bus send, 0..1. At 0 the band is SKIPPED entirely. */
  send: number;
}

/** The shipped default bank — the VST's own opening layout. */
export function wsDefaultBands(): WsBandSettings[] {
  const out: WsBandSettings[] = [];
  for (let i = 0; i < WS_NUM_BANDS; i++) {
    out.push({
      cutoffHz: WS_BAND_DEFAULT_HZ[i]!,
      q: WS_BAND_DEFAULT_Q,
      type: WS_BAND_DEFAULT_TYPE[i]!,
      pan: WS_BAND_DEFAULT_PAN,
      send: WS_BAND_DEFAULT_SEND,
    });
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Coerce an untrusted band table (a saved rack, a Yjs proxy, a postMessage
 * payload) into exactly `WS_NUM_BANDS` well-formed bands.
 *
 * ⚠ This is the ONLY place a band value is range-checked. It exists because
 * the table does NOT travel as AudioParams — AudioParam would clamp for us,
 * a `node.data` blob will not — so an old/corrupt/hand-edited rack could
 * otherwise put a NaN cutoff into `Math.tan` and hand the whole bank a NaN
 * that never washes out of the SVF state.
 */
export function wsNormalizeBands(raw: unknown): WsBandSettings[] {
  const src = Array.isArray(raw) ? raw : [];
  const def = wsDefaultBands();
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return def.map((d, i) => {
    const b = (src[i] ?? {}) as Partial<WsBandSettings>;
    return {
      cutoffHz: clamp(num(b.cutoffHz, d.cutoffHz), WS_BAND_CUTOFF_MIN_HZ, WS_BAND_CUTOFF_MAX_HZ),
      q: clamp(num(b.q, d.q), WS_BAND_Q_MIN, WS_BAND_Q_MAX),
      type: clamp(num(b.type, d.type), 0, 1),
      pan: clamp(num(b.pan, d.pan), -1, 1),
      send: clamp(num(b.send, d.send), WS_BAND_SEND_MIN, WS_BAND_SEND_MAX),
    };
  });
}

/**
 * TPT (Zavalishin / Simper) state-variable filter — one instance yields LP,
 * BP and HP every sample, which is what makes a continuous type morph a
 * crossfade rather than three filters. Verbatim from `Svf.h`, including the
 * `[10 Hz, 0.45·fs]` cutoff clamp and the `q >= 0.05` floor.
 */
class WsSvf {
  private ic1 = 0;
  private ic2 = 0;
  private k = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;

  // Written by process(); read immediately after. Avoids allocating a tuple
  // per sample in the hot loop.
  lp = 0;
  bp = 0;
  hp = 0;

  constructor(private readonly sampleRate: number) {
    this.setCoefs(1000, WS_BAND_DEFAULT_Q);
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  setCoefs(cutoffHz: number, q: number): void {
    const fs = this.sampleRate;
    const fcut = clamp(cutoffHz, 10, fs * 0.45);
    const qSafe = Math.max(0.05, q);
    const g = Math.tan((Math.PI * fcut) / fs);
    const k = 1 / qSafe;
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  process(input: number): void {
    const v3 = input - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = input - this.k * v1 - v2;
  }
}

/** LP → BP → HP crossfade. `morphSvf` in `Svf.h`. */
export function wsMorphSvf(lp: number, bp: number, hp: number, mix: number): number {
  const m = clamp(mix, 0, 1);
  if (m < 0.5) {
    const t = m * 2;
    return lp * (1 - t) + bp * t;
  }
  const t = (m - 0.5) * 2;
  return bp * (1 - t) + hp * t;
}

/**
 * The 8-band bank. Mono in, stereo out.
 *
 * Per-sample cost is 8 SVFs + 8 equal-power pan multiplies + 2 accumulates,
 * MINUS every band whose send is 0 (the upstream `if (!active) continue`,
 * kept because it is what makes a partly-open bank cheap).
 *
 * Outputs are fields rather than a returned pair: this runs inside the
 * engine's per-sample loop, and returning `[l, r]` there allocates once per
 * sample.
 */
export class WsFilterBank {
  private readonly svf: WsSvf[] = [];
  private readonly type = new Float32Array(WS_NUM_BANDS);
  private readonly panL = new Float32Array(WS_NUM_BANDS);
  private readonly panR = new Float32Array(WS_NUM_BANDS);
  private readonly send = new Float32Array(WS_NUM_BANDS);

  /** Last processed sample, left / right. */
  outL = 0;
  outR = 0;

  constructor(sampleRate: number) {
    for (let i = 0; i < WS_NUM_BANDS; i++) this.svf.push(new WsSvf(sampleRate));
    this.setBands(wsDefaultBands());
  }

  reset(): void {
    for (const s of this.svf) s.reset();
    this.outL = 0;
    this.outR = 0;
  }

  /** Replace the whole table. Values are assumed already normalized —
   *  `wsNormalizeBands` is the seam that guarantees that. */
  setBands(bands: readonly WsBandSettings[]): void {
    for (let i = 0; i < WS_NUM_BANDS; i++) {
      const b = bands[i];
      if (!b) continue;
      this.setBand(i, b);
    }
  }

  setBand(i: number, b: WsBandSettings): void {
    if (i < 0 || i >= WS_NUM_BANDS) return;
    this.svf[i]!.setCoefs(b.cutoffHz, b.q);
    this.type[i] = b.type;
    this.send[i] = b.send;
    // Equal-power pan: angle 0..π/2 across -1..+1 (`FilterBank::setPan`).
    const ang = (clamp(b.pan, -1, 1) + 1) * (Math.PI * 0.25);
    this.panL[i] = Math.cos(ang);
    this.panR[i] = Math.sin(ang);
  }

  /** Advance one sample. Writes `outL` / `outR`. */
  process(x: number): void {
    let l = 0;
    let r = 0;
    for (let i = 0; i < WS_NUM_BANDS; i++) {
      const s = this.send[i]!;
      if (s <= 0) continue; // the upstream all-sends-zero skip
      const f = this.svf[i]!;
      f.process(x);
      const shaped = wsMorphSvf(f.lp, f.bp, f.hp, this.type[i]!) * s;
      l += shaped * this.panL[i]!;
      r += shaped * this.panR[i]!;
    }
    this.outL = l;
    this.outR = r;
  }
}
