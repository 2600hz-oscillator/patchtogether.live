// packages/web/src/lib/ui/workflow/shell-glyph-live.ts
//
// LIVE glyph binding for the RACKLINE <ModuleShell> face glyphs (the P1
// batch-1 owner feedback: "LIVE, not static"). Two halves:
//
//   1. `glyphBinding` — a PURE resolver that decides, from the module def
//      alone, HOW a face's declared glyph goes live:
//        • live-audio  — an AnalyserNode tap on the module's PRIMARY AUDIO
//                        output (tidyVco / kickdrum trace, vca / cloudseed
//                        RMS meter), rendered by ScopeScreen's existing live
//                        'waveform' mode / VuMeter's getLevel seam.
//        • env-params  — the envelope contour drawn REACTIVELY from the
//                        module's real attack/decay/sustain/release params
//                        (adsr — its outputs are sub-audio CV, so a 42 ms
//                        analyser window has nothing useful to show).
//        • wave-morph  — one cycle of the module's ACTUAL wave shape from its
//                        `shape` morph param (lfo's 0=sine → 1=saw → 2=square
//                        law), reactive to the knob — again a sub-audio
//                        source, so param-derived IS the live view.
//        • static      — the deterministic fallback trace (a future face
//                        with no seam yet).
//
//   2. `createShellGlyphTap` — the Web Audio glue for 'live-audio': a lazy,
//      self-releasing passive AnalyserNode on the module's output via the
//      engine's existing getOutputNode seam (the SAME seam the cross-domain
//      bridges + level-meter use — a thin tap, NOT a new metering stack).
//
// PERF POLICY (the synesthesia lazy-render lesson): the tap ATTACHES only
// when a glyph actually READS it (reads come from the shared onMeterFrame
// ticker, which is IntersectionObserver-gated — an off-screen tile never
// polls), and it RELEASES itself after GLYPH_TAP_IDLE_RELEASE_MS without a
// read (tile scrolled away / dock closed / document hidden). So: visible →
// tap mounted; hidden → tap released; unmount → dispose(). The analyser is a
// pure sink (never connected onward) and adds no load to the audio path.

import { rmsUnit } from '$lib/audio/level-meter';
import type { ModuleFace } from '$lib/graph/types';

/** The minimal def shape the binding resolver reads (AudioModuleDef,
 *  VideoModuleDef, or a test fixture). */
export interface GlyphDefLike {
  face?: ModuleFace;
  outputs?: readonly { id: string; type: string }[];
  params?: readonly { id: string; min?: number; max?: number }[];
}

/** The PARAM-DERIVED core-waveform law behind a 'dual' binding: which pure
 *  scope-screen-model derivation draws the module's ASSIGNED shape, and which
 *  param ids feed it (read through the LIVE/transient seam — see
 *  createLiveWaveSource). 'saw-pulse-mix' = tidyVco's two-osc law
 *  (sawPulseMixWaveSamples: shape1/shape2 morphs + shared PW, equal-power MIX). */
export type DualWaveSpec = {
  law: 'saw-pulse-mix';
  shape1: string;
  shape2?: string;
  pw?: string;
  mix?: string;
};

/** How a face glyph binds to live data — see the header. */
export type GlyphBinding =
  | { kind: 'live-audio'; portId: string }
  /** DUAL DISPLAY (owner spec): a PARAM-DERIVED static core waveform (always
   *  visible, gate or no gate) ALONGSIDE the live analyser trace on the
   *  primary audio output. For oscillators whose identity IS an assigned
   *  shape (tidyVco); other shape-identity sources can adopt it. */
  | { kind: 'dual'; portId: string; wave: DualWaveSpec }
  | { kind: 'env-params'; attack: string; decay: string; sustain: string; release: string }
  /**
   * PARAM-DERIVED single-cycle morph (the lfo law). `depthGain` is the module's
   * DEPTH → output-gain multiplier, carried on the binding so the SHELL never
   * has to know it: it used to be a literal `2 *` inside ModuleShell, a second
   * copy of a number whose only authoritative home is the worklet. It is read
   * off the module's OWN `face.glyphDepthGain` — this resolver is generic and
   * must not carry any single module's constant (see the field's doc on
   * ModuleFace).
   */
  | { kind: 'wave-morph'; shapeParamId: string; depthParamId?: string; depthGain: number }
  /**
   * TOPOLOGY (PF-15): the glyph draws the module's own SIGNAL ROUTING or layout —
   * no analyser, no gate, always live.
   *
   * ⚠ WIDENED 2026-08-23, exactly as this comment previously prescribed: it read
   * "when a SECOND topology-bearing module arrives, do NOT add a third glyph
   * literal: widen THIS branch to carry a layout-source id". It now does.
   *
   * `layoutSource` names WHAT FEEDS THE PICTURE, so the shell resolves the
   * renderer from data rather than from a param NAME:
   *   - a PARAM id  — the dx7 case, where a discrete `algorithm` param IS the
   *                   topology and its value is also the caption;
   *   - an EXTENSION id — a module whose picture is a pure layout function it
   *                   owns, with no param behind it.
   *
   * `paramId` is therefore NULLABLE, and that nullability is the whole point:
   * before this, a module with a card-drawn picture but no param literally named
   * `algorithm` had NO legal glyph literal at all — every other one falls through
   * to a dead `{kind:'static'}` and reddens the dead-glyph clause, so such
   * modules were forced to declare `'none'` and show nothing. That is five
   * modules today (pong, timelorde, scope, rasterize, wavesculpt).
   *
   * ⚠ THIS BRANCH REMOVES THE REFUSAL; IT DOES NOT DRAW ANYTHING. A module still
   * needs its own layout component and a `glyph` extension slot to gain a
   * picture. Widening without an adopter changes no pixel anywhere — verified.
   */
  | { kind: 'algorithm'; layoutSource: string; paramId: string | null }
  | { kind: 'static' }
  | { kind: 'none' };

/** The module's PRIMARY AUDIO output port id (the first declared `audio`
 *  output — out_l / audio_l / audio by convention), or null. Pure. */
export function primaryAudioOutPortId(def: GlyphDefLike | undefined): string | null {
  return def?.outputs?.find((o) => o.type === 'audio')?.id ?? null;
}

/**
 * Resolve the LIVE binding for a def's face glyph. Rules (pure, in order):
 *   - no face / glyph 'none'                 → none
 *   - glyph 'envelope' + real A/D/S/R params → env-params
 *   - glyph 'algorithm' + an `algorithm` param → algorithm (topology)
 *   - glyph 'waveform' + a primary AUDIO output + the saw↔pulse morph param
 *     set (a 0..1 `shape1` + `pw` + `mix` — the tidyVco osc law)
 *                                            → DUAL (param-wave + live trace)
 *   - any glyph + a primary AUDIO output     → live-audio (trace or RMS)
 *   - glyph 'waveform' + a 0..2 `shape` morph param (the lfo law)
 *                                            → wave-morph (+ depth swing)
 *   - otherwise                              → static (deterministic trace)
 */
export function glyphBinding(def: GlyphDefLike | undefined): GlyphBinding {
  const glyph = def?.face?.glyph ?? 'none';
  if (glyph === 'none') return { kind: 'none' };

  const params = def?.params ?? [];
  const has = (id: string) => params.some((p) => p.id === id);

  if (glyph === 'envelope') {
    if (has('attack') && has('decay') && has('sustain') && has('release')) {
      return { kind: 'env-params', attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' };
    }
    return { kind: 'static' };
  }

  // TOPOLOGY (PF-15) — resolved BEFORE the audio-out short-circuit BY DESIGN.
  // Every topology-bearing module is a sound SOURCE and therefore has a primary
  // audio output, so `if (audioOut) return live-audio` below would swallow this
  // branch entirely and silently paint the trace it exists to replace. Order is
  // the whole mechanism here; do not "tidy" it down with the other kinds.
  if (glyph === 'algorithm') {
    // A discrete `algorithm` param IS the topology and also its caption — the
    // dx7 case, and the only shape this branch used to accept.
    if (has('algorithm')) {
      return { kind: 'algorithm', layoutSource: 'algorithm', paramId: 'algorithm' };
    }
    // Otherwise the picture is fed by a layout function the MODULE owns, reached
    // through its extension's `glyph` slot. No param, so no caption — the
    // diagram is the whole glyph.
    const ext = def?.face?.extension;
    if (typeof ext === 'string' && ext.length > 0) {
      return { kind: 'algorithm', layoutSource: ext, paramId: null };
    }
    return { kind: 'static' };
  }

  const audioOut = primaryAudioOutPortId(def);
  if (audioOut && glyph === 'waveform') {
    // The DUAL-display capability: the module's identity is an ASSIGNED wave
    // shape (a 0..1 saw↔pulse morph + shared PW + osc mix), so the face shows
    // the param-derived core waveform ALWAYS (the live trace alone flatlines
    // when ungated) next to the live output trace.
    const shape1 = params.find((p) => p.id === 'shape1' && p.min === 0 && p.max === 1);
    if (shape1 && has('pw') && has('mix')) {
      return {
        kind: 'dual',
        portId: audioOut,
        wave: {
          law: 'saw-pulse-mix',
          shape1: 'shape1',
          shape2: has('shape2') ? 'shape2' : undefined,
          pw: 'pw',
          mix: 'mix',
        },
      };
    }
  }
  if (audioOut) return { kind: 'live-audio', portId: audioOut };

  if (glyph === 'waveform') {
    const shape = params.find((p) => p.id === 'shape' && p.min === 0 && p.max === 2);
    if (shape) {
      return {
        kind: 'wave-morph',
        shapeParamId: 'shape',
        depthParamId: has('depth') ? 'depth' : undefined,
        // The MODULE's multiplier, never this resolver's. 1 = "depth is already
        // the amplitude" — the only law a generic resolver can assume.
        depthGain: def?.face?.glyphDepthGain ?? 1,
      };
    }
  }
  return { kind: 'static' };
}

/**
 * The DISPLAY amplitude a `wave-morph` glyph draws: the module's real depth
 * gain, CLAMPED to the screen's ±1 box.
 *
 * ⚠ THE ONE HOME FOR THE CLAMP. It used to be re-implemented inline in
 * ModuleShell's wave-morph branch (`Math.min(1, b.depthGain * depth)`) while a
 * module-side `lfoGlyphAmp` held an identical copy that NOTHING rendered
 * through — so the module's test pinned an orphan and deleting the shell's
 * clamp changed the picture with every assertion still green. Both callers now
 * resolve here, which is what makes that test a real one.
 */
export function waveMorphGlyphAmp(depth: number, depthGain: number): number {
  return Math.min(1, Math.max(0, depth) * depthGain);
}

// ── The LIVE param-wave source (the dual/wave-morph transient-read seam) ────
//
// LIVE-WHILE-TWISTING (owner spec, critical): knob gestures are written
// TRANSIENT-FIRST — the engine handle carries the moving value during the
// gesture while the DURABLE node.params commit coalesces/settles behind it
// (drag-commit / cc-commit) — so a param-derived display that re-renders off
// COMMITTED params looks dead mid-drag. The wave source therefore reads the
// SAME live seam the motorized knobs read (cardParams.live → engine.readParam,
// falling back to the committed value while the engine isn't booted), and is
// POLLED on the shared visibility-gated meter frame (rAF-coalesced by
// construction). The derivation memoizes on the read TUPLE: an unchanged
// tuple returns the SAME buffer identity, so the consumer (ScopeScreen's
// polled wave mode) repaints ONLY on identity change — idle tiles cost one
// tuple compare per frame, no canvas work.

/**
 * A memoized live→samples pump: `read()` samples the CURRENT param tuple
 * (live/transient-first), `compute(vals)` derives the single-cycle buffer
 * (a pure scope-screen-model law). Returns a `get()` for ScopeScreen's
 * polled `getWaveform` seam — same tuple ⇒ same buffer identity.
 */
export function createLiveWaveSource(
  read: () => readonly number[],
  compute: (vals: readonly number[]) => Float32Array,
): () => Float32Array {
  let lastVals: readonly number[] | null = null;
  let buf: Float32Array | null = null;
  return () => {
    const vals = read();
    if (
      !buf ||
      !lastVals ||
      vals.length !== lastVals.length ||
      vals.some((v, i) => v !== lastVals![i])
    ) {
      lastVals = [...vals];
      buf = compute(vals);
    }
    return buf;
  };
}

// ── The live-audio tap ───────────────────────────────────────────────────────

/** Idle window with NO reads after which an attached tap self-releases (the
 *  reads are visibility-gated by onMeterFrame, so "no reads" ≡ "hidden"). */
export const GLYPH_TAP_IDLE_RELEASE_MS = 2000;
/** Analyser window: 2048 samples ≈ 43 ms at 48 kHz — the scope-module ring. */
export const GLYPH_TAP_FFT_SIZE = 2048;

/** The engine surface the tap consumes (PatchEngine-shaped; kept minimal so
 *  unit tests can hand in a mock). */
export interface GlyphTapEngineLike {
  hasDomain(domain: string): boolean;
  getDomain(domain: string): unknown;
}

interface AudioDomainLike {
  ctx: BaseAudioContext;
  getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
}

export interface ShellGlyphTap {
  /** Time-domain snapshot off the tap, or undefined while un-attachable
   *  (engine not booted / node not materialized). Attaches lazily. */
  getSamples(): Float32Array | undefined;
  /** Current output RMS 0..1 (0 while un-attachable). Attaches lazily. */
  getLevel(): number;
  /** True while the passive analyser is connected. */
  attached(): boolean;
  /** Release the tap + its idle timer. Terminal. */
  dispose(): void;
}

/**
 * A lazy, self-releasing analyser tap on `nodeId`'s `portId` output. See the
 * header for the attach/release policy. `getEngine` is read on every attach
 * attempt, so an engine reboot (AudioContext reset) re-resolves cleanly; a
 * re-materialized node (reconciler re-add) is re-tapped because the resolved
 * output node is identity-checked each read.
 */
export function createShellGlyphTap(
  getEngine: () => GlyphTapEngineLike | null,
  nodeId: string,
  portId: string,
  opts?: { idleMs?: number },
): ShellGlyphTap {
  const idleMs = opts?.idleMs ?? GLYPH_TAP_IDLE_RELEASE_MS;

  let disposed = false;
  let analyser: AnalyserNode | null = null;
  let src: { node: AudioNode; output: number } | null = null;
  let buf: Float32Array<ArrayBuffer> | null = null;
  let lastReadAt = 0;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function detach(): void {
    if (src && analyser) {
      try {
        src.node.disconnect(analyser);
      } catch {
        /* source already gone */
      }
    }
    analyser = null;
    src = null;
    if (idleTimer !== null) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  function startIdleTimer(): void {
    if (idleTimer !== null || typeof setInterval !== 'function') return;
    idleTimer = setInterval(() => {
      if (Date.now() - lastReadAt > idleMs) detach();
    }, Math.max(250, Math.floor(idleMs / 2)));
  }

  /** Resolve + (re)connect the analyser. Returns true when readable. */
  function ensureAttached(): boolean {
    if (disposed) return false;
    const engine = getEngine();
    if (!engine || typeof engine.hasDomain !== 'function' || !engine.hasDomain('audio')) {
      detach();
      return false;
    }
    let audio: AudioDomainLike;
    try {
      audio = engine.getDomain('audio') as AudioDomainLike;
    } catch {
      detach();
      return false;
    }
    const out = audio.getOutputNode(nodeId, portId);
    if (!out) {
      detach();
      return false;
    }
    if (analyser && src && (src.node !== out.node || src.output !== out.output)) {
      // Node re-materialized under the same id — re-tap the new node.
      detach();
    }
    if (!analyser) {
      if (typeof audio.ctx?.createAnalyser !== 'function') return false;
      const a = audio.ctx.createAnalyser();
      a.fftSize = GLYPH_TAP_FFT_SIZE;
      a.smoothingTimeConstant = 0;
      try {
        out.node.connect(a, out.output);
      } catch {
        return false;
      }
      analyser = a;
      src = out;
      if (!buf || buf.length !== a.fftSize) buf = new Float32Array(a.fftSize);
      startIdleTimer();
    }
    return true;
  }

  return {
    getSamples() {
      lastReadAt = Date.now();
      if (!ensureAttached() || !analyser || !buf) return undefined;
      analyser.getFloatTimeDomainData(buf);
      return buf;
    },
    getLevel() {
      lastReadAt = Date.now();
      if (!ensureAttached() || !analyser || !buf) return 0;
      analyser.getFloatTimeDomainData(buf);
      return rmsUnit(buf);
    },
    attached() {
      return analyser !== null;
    },
    dispose() {
      disposed = true;
      detach();
    },
  };
}
