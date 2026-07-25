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

/** How a face glyph binds to live data — see the header. */
export type GlyphBinding =
  | { kind: 'live-audio'; portId: string }
  | { kind: 'env-params'; attack: string; decay: string; sustain: string; release: string }
  | { kind: 'wave-morph'; shapeParamId: string; depthParamId?: string }
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

  const audioOut = primaryAudioOutPortId(def);
  if (audioOut) return { kind: 'live-audio', portId: audioOut };

  if (glyph === 'waveform') {
    const shape = params.find((p) => p.id === 'shape' && p.min === 0 && p.max === 2);
    if (shape) {
      return { kind: 'wave-morph', shapeParamId: 'shape', depthParamId: has('depth') ? 'depth' : undefined };
    }
  }
  return { kind: 'static' };
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
