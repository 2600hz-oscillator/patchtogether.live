// packages/web/src/lib/audio/modules/wavesculpt.ts
//
// WAVESCULPT — hybrid 4-oscillator 3D video synth.
//
// v2 (post-wavetable-engine refactor):
//   The per-osc audio source is now a WAVETABLE oscillator from the shared
//   engine at packages/dsp/src/lib/wavetable-osc.ts. All four
//   oscillators live in one AudioWorklet (`wavesculpt-engine`) so the
//   per-osc summation, distance attenuation, and stereo panning happen in
//   the worklet block loop rather than on the WebAudio graph. This keeps
//   the audio-rate hot path tight (one worklet vs four OscillatorNodes +
//   chained GainNodes) and lets each ribbon's visual shape come straight
//   from the same wavetable frames the worklet samples.
//
// Mental model still:
//   A 3D unit box [-1, +1]^3 holds four "wall oscillators". Each emits a
//   wave ribbon from a wall-position along a per-oscillator Vector
//   pointing into the box. A single user-camera renders the scene; its
//   position is set by an XY pad for X/Y and a HEIGHT slider for Z. The
//   four ribbons carry oscillator colors: RED, GREEN, BLUE, ALPHA.
//
//   Audio output = sum of the four wavetable oscillators, each weighted
//   by env (per-osc ADSR) × distGain (camera↔source distance). The
//   distance gain is the SINGLE SOURCE OF TRUTH — computed once each
//   envelope tick on the JS side, and mirrored into the worklet via
//   AudioParam writes. The visual camera distance uses the same number
//   (no double-modulation), so the dogfood feedback "closer = louder" is
//   inherently consistent across audio + visual.
//
// New v2 params (per oscillator):
//   - tune{N}    (semitones, -36..+36)
//   - fine{N}    (cents, -100..+100)
//   - morph{N}   (0..1, wavetable frame position)
//   - spread{N}  (1..5, stereo tap spread)
//   - fold{N}    (0..1, wavefolder amount)
//   - ADSR (A/D/S/R per osc) — JS-side envelope, unchanged from v1.
//   - thickness{N} (0..1, ribbon perpendicular extrusion) — unchanged.
//   - pitch{N}   REMOVED (folded into tune+fine; semantically identical
//                with strictly cleaner UX vs. having pitch AND tune AND
//                fine all stacked).
//   - morph{N}   semantics CHANGED: was "0..1 pick between saw/sine/tri",
//                now "0..1 wavetable frame position".
//
// New camera params:
//   - zoom (0.3..3) — used as camera distance scalar. Visual: closer = bigger
//     ribbons. Audio: closer = louder (smaller dist² in distGain formula).
//   - rot  (-1..+1) — camera rotation around Y axis. -1 = full left, +1 =
//     full right. Visual only; audio is rotation-invariant (distance is
//     scalar). New in v2 — wired through the second "zoom/rot" joystick on
//     the card.
//
// Per-osc wavetable selection rides node.data (indexed: wavetableSourceN,
// wavetableFramesN, wavetableLabelN for N=1..4). The factory polls
// livePatch.nodes[id].data and reposts on change.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { isInputPortConnected } from './transport-helpers';
import workletUrl from '@patchtogether.live/dsp/dist/wavesculpt-engine.js?url';
import {
  framesToPlain,
  framesFromPlain,
  getFactoryTable,
  DEFAULT_FACTORY_TABLE_ID,
} from '$lib/audio/wavetable-factory-tables';

// ---------- card → module frame-drawer registry ----------

type FrameDrawer = (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
const FRAME_DRAWERS: Map<string, FrameDrawer> = new Map();

export function installWavesculptFrameDrawer(nodeId: string, fn: FrameDrawer): void {
  FRAME_DRAWERS.set(nodeId, fn);
}
export function uninstallWavesculptFrameDrawer(nodeId: string): void {
  FRAME_DRAWERS.delete(nodeId);
}

// ---------- wavetable-frames registry (card-readable, per-node) ----------
//
// The card needs the per-osc active frame each tick so it can upload it
// into the ribbon vertex-shader texture. The audio module is the source
// of truth for "which frames are loaded for osc N" — it's the one running
// the poll loop against node.data. We mirror the resolved frames into
// this Map so the card can read them WITHOUT having to also re-resolve
// from node.data (duplicating that logic across two files = drift bait).

const FRAMES_REGISTRY: Map<string, Float32Array[][]> = new Map();
export function getWavesculptFrames(nodeId: string): Float32Array[][] | undefined {
  return FRAMES_REGISTRY.get(nodeId);
}

// ---------- pure helpers (unit-testable) ----------

export const WALL_LAYOUT: ReadonlyArray<{ src: [number, number, number]; vec: [number, number, number] }> = [
  { src: [ 1, 0, 0], vec: [-1, 0, 0] },
  { src: [-1, 0, 0], vec: [ 1, 0, 0] },
  { src: [ 0, 1, 0], vec: [ 0,-1, 0] },
  { src: [ 0,-1, 0], vec: [ 0, 1, 0] },
];

/** Distance-attenuated gain for one oscillator given the user camera
 *  position. Same formula as v1; documented in WALL_LAYOUT comment.
 *  Single source of truth — used both for the visual and (after JS-side
 *  mirroring) for the audio worklet's distGain AudioParam. */
export function distanceGain(
  source: readonly [number, number, number],
  vector: readonly [number, number, number],
  camera: readonly [number, number, number],
): number {
  const dx = camera[0] - source[0];
  const dy = camera[1] - source[1];
  const dz = camera[2] - source[2];
  const dist2 = dx * dx + dy * dy + dz * dz;
  if (dist2 < 1e-6) return 1;
  const dist = Math.sqrt(dist2);
  const ndx = dx / dist, ndy = dy / dist, ndz = dz / dist;
  const vlen = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  const fx = vector[0] / vlen, fy = vector[1] / vlen, fz = vector[2] / vlen;
  const dot = fx * ndx + fy * ndy + fz * ndz;
  const directional = Math.max(0, dot);
  const falloff = 1 / (1 + dist2);
  return directional * falloff;
}

/** Compute the 3D eye position from camera params. Zoom scales the
 *  distance from the box center toward the user; rot rotates around Y;
 *  pos_x/pos_y/pos_z offset the eye laterally. Pure so unit tests can
 *  pin "zoom in → eye closer to origin" and "zoom in → audio louder
 *  via the distGain helper consuming this position".
 *
 *  Range note: at zoom=1 (default), the eye is 2.5 units from origin.
 *  At zoom=3 (max), it's ~0.83 units → INSIDE the unit box, very close
 *  to a wall → max audio gain. At zoom=0.3 (min), it's ~8.3 units → far
 *  outside → low gain. This gives a ~10x audible gain swing across the
 *  zoom knob's full sweep, matching the dogfood spec. */
export function eyeFromCamera(
  posX: number, posY: number, posZ: number,
  zoom: number, rot: number,
): [number, number, number] {
  // Base distance: 2.5 / zoom — bigger zoom = smaller distance.
  const baseDist = 2.5 / Math.max(0.05, zoom);
  // Rot rotates the base direction around Y. rot=0 → looking along -Z.
  const rad = rot * Math.PI; // ±1 → full ±180°
  const dx = Math.sin(rad) * baseDist;
  const dz = Math.cos(rad) * baseDist;
  return [posX * 1.5 + dx, posY * 1.5, posZ * 1.5 + dz];
}

const C4_HZ = 261.626;
export function voctToHz(voct: number): number {
  return C4_HZ * Math.pow(2, voct);
}

export function detuneOctaveOffset(oscIdx: number, detune: number): number {
  if (oscIdx === 0) return 0;
  if (oscIdx === 1) return detune;
  if (oscIdx === 2) return detune * 0.5;
  return -detune;
}

// ---------- ADSR helper (unchanged from v1; tests still reference it) ----------

const NUM_OSC = 4;
const ENV_TICK_MS = 8;
const GATE_HIGH = 0.5;

interface VoiceState {
  env: number;
  gateHigh: boolean;
  phase: 'idle' | 'attack' | 'decay' | 'sustain' | 'release';
  phaseT: number;
}

function newVoiceState(): VoiceState {
  return { env: 0, gateHigh: false, phase: 'idle', phaseT: 0 };
}

export function tickEnvelope(
  state: VoiceState,
  dtMs: number,
  params: { A: number; D: number; S: number; R: number },
): VoiceState {
  const aMs = Math.max(1, params.A * 1000);
  const dMs = Math.max(1, params.D * 1000);
  const rMs = Math.max(1, params.R * 1000);
  const sLevel = Math.max(0, Math.min(1, params.S));
  let { env, phase, phaseT } = state;
  phaseT += dtMs;
  switch (phase) {
    case 'idle':
      env = 0;
      break;
    case 'attack': {
      const t = phaseT / aMs;
      env = Math.min(1, t);
      if (env >= 1) { phase = 'decay'; phaseT = 0; env = 1; }
      break;
    }
    case 'decay': {
      const t = phaseT / dMs;
      env = 1 - (1 - sLevel) * Math.min(1, t);
      if (t >= 1) { phase = 'sustain'; phaseT = 0; env = sLevel; }
      break;
    }
    case 'sustain':
      env = sLevel;
      break;
    case 'release': {
      const t = phaseT / rMs;
      const startEnv = (state as VoiceState & { _releaseStart?: number })._releaseStart ?? env;
      env = Math.max(0, startEnv * (1 - Math.min(1, t)));
      if (env <= 1e-4) { phase = 'idle'; phaseT = 0; env = 0; }
      break;
    }
  }
  return { ...state, env, phase, phaseT };
}

export function unisonRouting(unison: boolean): number[] {
  if (!unison) return [0, 1, 2, 3];
  return [0, 0, 0, 0];
}

/**
 * "Walking" voice normalling, applied independently to the gate chain
 * and the pitch chain. Mirrors classic patch-cable behavior: a signal
 * patched into voice 1's input normals through to subsequent voices
 * until the chain is broken by another patched cable downstream.
 *
 *   g1 patched, g2 unpatched, g3 patched, g4 unpatched
 *     → gate route [0, 0, 2, 2]
 *
 *   p1 patched, p2 unpatched, p3 unpatched, p4 patched
 *     → pitch route [0, 0, 0, 3]
 *
 * If voice 1 itself is unpatched, the chain stays at voice 1 (sourceIdx
 * 0) — same convention as analog modules' "no input = silent or
 * intrinsic". With every voice unpatched, every voice still sources
 * itself (no cross-voice coupling) so the unison-driven workflow stays
 * the default behavior.
 */
export function normalledChain(patched: readonly boolean[]): number[] {
  const out: number[] = [];
  // Determine if ANY voice in the chain is patched. If none are, every
  // voice sources itself (vanilla independent operation).
  const anyPatched = patched.some(Boolean);
  if (!anyPatched) return patched.map((_, i) => i);

  let current = 0; // walk pointer
  for (let i = 0; i < patched.length; i++) {
    if (patched[i]) current = i;
    out.push(current);
  }
  return out;
}

/** Resolve gate + pitch routing for the 4 voices, accounting for
 *  unison (overrides both chains to voice 1), chord mode (overrides
 *  pitch chain to voice 1), and normalling on whichever chain is left
 *  open. Pure so unit tests can pin every combination. */
export function effectiveVoiceRouting(
  unison: boolean,
  chordMode: boolean,
  gatePatched: readonly boolean[],
  pitchPatched: readonly boolean[],
): { gateRoute: number[]; pitchRoute: number[] } {
  if (unison) {
    return { gateRoute: [0, 0, 0, 0], pitchRoute: [0, 0, 0, 0] };
  }
  const gateRoute = normalledChain(gatePatched);
  // In chord mode every voice reads voice-1's pitch (then the factory
  // applies per-voice chord-interval offsets via the tune AudioParam).
  const pitchRoute = chordMode ? [0, 0, 0, 0] : normalledChain(pitchPatched);
  return { gateRoute, pitchRoute };
}

/** Major / minor (and minor-7th / major-7th) chord intervals in
 *  semitones, root + first three chord tones. Voice 1 plays the root,
 *  voices 2/3/4 add the listed intervals on top. */
export const CHORD_INTERVALS_SEMITONES = {
  // Major triad + octave: 1 - 3 - 5 - 8
  major: [0, 4, 7, 12],
  // Minor triad + octave: 1 - ♭3 - 5 - 8
  minor: [0, 3, 7, 12],
} as const;
export type ChordQuality = keyof typeof CHORD_INTERVALS_SEMITONES;

/** Resolve a 0..1 chord-quality knob value to a discrete quality.
 *  We discretise at 0.5 so a quarter-turn lands in major and the
 *  other half lands in minor — easy to dial without overshoot, and
 *  the discrete-curve param avoids fractional in-between states. */
export function chordQualityFromKnob(v: number): ChordQuality {
  return v >= 0.5 ? 'minor' : 'major';
}

// ---------- per-osc wavetable data (rides node.data) ----------

export interface WavesculptOscData {
  wavetableSource?: string;      // 'factory:<id>' or 'user'
  wavetableFrames?: number[][];  // plain arrays (Yjs-safe)
  wavetableLabel?: string;
}

export interface WavesculptData {
  width?: number;
  height?: number;
  osc1?: WavesculptOscData;
  osc2?: WavesculptOscData;
  osc3?: WavesculptOscData;
  osc4?: WavesculptOscData;
}

interface ResolvedFrames {
  frames: Float32Array[];
  label: string;
  signature: string;
}

function resolveOscFrames(oscData: WavesculptOscData | undefined): ResolvedFrames {
  const src = oscData?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
  if (src === 'user' && Array.isArray(oscData?.wavetableFrames)) {
    return {
      frames: framesFromPlain(oscData!.wavetableFrames!),
      label: oscData?.wavetableLabel ?? 'USER',
      signature: `user:${oscData!.wavetableFrames!.length}:${oscData?.wavetableLabel ?? ''}`,
    };
  }
  if (src.startsWith('factory:')) {
    const id = src.slice('factory:'.length);
    const t = getFactoryTable(id) ?? getFactoryTable(DEFAULT_FACTORY_TABLE_ID);
    if (t) {
      return {
        frames: t.frames.map((f) => new Float32Array(f)),
        label: t.label,
        signature: `factory:${t.id}`,
      };
    }
  }
  const t = getFactoryTable(DEFAULT_FACTORY_TABLE_ID)!;
  return {
    frames: t.frames.map((f) => new Float32Array(f)),
    label: t.label,
    signature: `factory:${t.id}`,
  };
}

// ---------- module def ----------

const POLL_MS = 200;
const loadedContexts = new WeakSet<BaseAudioContext>();

export const wavesculptDef: AudioModuleDef = {
  type: 'wavesculpt',
  domain: 'audio',
  label: 'WAVESCULPT',
  category: 'sources',
  schemaVersion: 2,

  inputs: [
    { id: 'gate1',     type: 'gate' },
    { id: 'pitch_cv1', type: 'cv' },
    { id: 'gate2',     type: 'gate' },
    { id: 'pitch_cv2', type: 'cv' },
    { id: 'gate3',     type: 'gate' },
    { id: 'pitch_cv3', type: 'cv' },
    { id: 'gate4',     type: 'gate' },
    { id: 'pitch_cv4', type: 'cv' },
    // Per-osc morph CV. Routed straight to the worklet's morph{N}
    // a-rate AudioParam, so any CV source (LFO, ENV, SCORE.env, etc.)
    // sweeps the wavetable frame position per voice independently.
    { id: 'morph1_cv', type: 'cv', paramTarget: 'morph1', cvScale: { mode: 'linear' } },
    { id: 'morph2_cv', type: 'cv', paramTarget: 'morph2', cvScale: { mode: 'linear' } },
    { id: 'morph3_cv', type: 'cv', paramTarget: 'morph3', cvScale: { mode: 'linear' } },
    { id: 'morph4_cv', type: 'cv', paramTarget: 'morph4', cvScale: { mode: 'linear' } },
    { id: 'pos_x', type: 'cv', paramTarget: 'pos_x', cvScale: { mode: 'linear' } },
    { id: 'pos_y', type: 'cv', paramTarget: 'pos_y', cvScale: { mode: 'linear' } },
    { id: 'pos_z', type: 'cv', paramTarget: 'pos_z', cvScale: { mode: 'linear' } },
    { id: 'zoom',  type: 'cv', paramTarget: 'zoom',  cvScale: { mode: 'linear' } },
    { id: 'rot',   type: 'cv', paramTarget: 'rot',   cvScale: { mode: 'linear' } },
    { id: 'alpha_in', type: 'video' },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
    { id: 'video_out', type: 'mono-video' },
  ],
  params: (() => {
    // Build as a mutable list, then return — the def's `params` is
    // `readonly ParamDef[]`, so we can't push into it directly.
    type ParamDef = AudioModuleDef['params'][number];
    const ps: ParamDef[] = [];
    for (let i = 1; i <= 4; i++) {
      ps.push({ id: `tune${i}`,   label: `T${i}`,  defaultValue: 0,    min: -36,  max: 36,  curve: 'linear', units: 'st' });
      ps.push({ id: `fine${i}`,   label: `F${i}`,  defaultValue: 0,    min: -100, max: 100, curve: 'linear', units: '¢' });
      ps.push({ id: `morph${i}`,  label: `M${i}`,  defaultValue: 0,    min: 0,    max: 1,   curve: 'linear' });
      ps.push({ id: `spread${i}`, label: `S${i}`,  defaultValue: 1,    min: 1,    max: 5,   curve: 'linear' });
      ps.push({ id: `fold${i}`,   label: `Fd${i}`, defaultValue: 0,    min: 0,    max: 1,   curve: 'linear' });
      ps.push({ id: `A${i}`,      label: `A${i}`,  defaultValue: 0.01, min: 0.001, max: 5, curve: 'log', units: 's' });
      ps.push({ id: `D${i}`,      label: `D${i}`,  defaultValue: 0.1,  min: 0.001, max: 5, curve: 'log', units: 's' });
      ps.push({ id: `S${i}`,      label: `Su${i}`, defaultValue: 0.7,  min: 0, max: 1, curve: 'linear' });
      ps.push({ id: `R${i}`,      label: `R${i}`,  defaultValue: 0.5,  min: 0.001, max: 5, curve: 'log', units: 's' });
      ps.push({ id: `thickness${i}`, label: `Th${i}`, defaultValue: 0.3, min: 0, max: 1, curve: 'linear' });
      // Per-osc FX slot. fxType = 0=OFF, 1=REVERB, 2=DELAY (discrete).
      // fxAmount = single amount knob mapped to the FX's wet/mix internally.
      // The slot sits PRE-SPATIAL-MIX so the FX shapes the raw osc before
      // env+dist+pan are applied — closing the loop on the user spec:
      // "the effect ONLY affects the oscillator … pre-mix".
      ps.push({ id: `fxType${i}`,   label: `FX${i}`,    defaultValue: 0,   min: 0,    max: 2,   curve: 'discrete' });
      ps.push({ id: `fxAmount${i}`, label: `FXAmt${i}`, defaultValue: 0.4, min: 0,    max: 1,   curve: 'linear'  });
    }
    ps.push({ id: 'pos_x', label: 'X',     defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'pos_y', label: 'Y',     defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'pos_z', label: 'H',     defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'zoom',  label: 'Zoom',  defaultValue: 1, min: 0.3, max: 3, curve: 'log' });
    ps.push({ id: 'rot',   label: 'Rot',   defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'unison', label: 'Unison', defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
    ps.push({ id: 'detune', label: 'Detune', defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    // Chord mode: button toggles, knob picks the chord quality (0 = major,
    // 1 = minor — discretised in chordQualityFromKnob). When on, every
    // voice's pitch reads from voice 1 (overriding the normal chain) and
    // voices 2/3/4 get a per-voice semitone offset via the tune param.
    // Pre-existing tune values are NOT overwritten while chord-mode is
    // active; they're restored from node.params when chord mode flips off.
    ps.push({ id: 'chord_mode',    label: 'Chord',    defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
    ps.push({ id: 'chord_quality', label: 'Quality',  defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
    // Video mode: 0 = PROXIMITY (3D ribbons, default — the original render),
    // 1 = BIRDSEYE (top-down 2D floorplan showing the spatial system).
    ps.push({ id: 'video_mode',    label: 'View',     defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
    ps.push({ id: 'alpha_brightness', label: 'A.Bright', defaultValue: 1, min: 0, max: 2, curve: 'linear' });
    ps.push({ id: 'hsync_drift',        defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'HS Drift' });
    ps.push({ id: 'hsync_loss',         defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'HS Loss' });
    ps.push({ id: 'vsync_drift',        defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'VS Drift' });
    ps.push({ id: 'scan_wobble',        defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Wobble' });
    ps.push({ id: 'chroma_phase',       defaultValue: 0,    min: -1, max: 1, curve: 'linear', label: 'Hue' });
    ps.push({ id: 'chroma_instability', defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Shimmer' });
    ps.push({ id: 'feedback_gain',      defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Feedback' });
    ps.push({ id: 'feedback_delay',     defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Delay' });
    ps.push({ id: 'wavefold',           defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Wavefold' });
    ps.push({ id: 'bloom',              defaultValue: 0.4,  min: 0,  max: 1, curve: 'linear', label: 'Bloom' });
    ps.push({ id: 'noise',              defaultValue: 0.05, min: 0,  max: 1, curve: 'linear', label: 'Noise' });
    ps.push({ id: 'master_gain',        defaultValue: 1,    min: 0,  max: 2, curve: 'linear', label: 'Gain' });
    return ps;
  })(),

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = (node.params ?? {}) as Record<string, number>;
    const param = (k: string, d: number) =>
      (initialParams[k] ?? d) as number;

    const live: Record<string, number> = {};
    for (const p of wavesculptDef.params) live[p.id] = param(p.id, p.defaultValue);

    // Populate the frames registry synchronously so the card has frames
    // the moment it mounts. resolveAndPostAll() below runs again after
    // the worklet loads and on every poll — this just closes the gap
    // where uploadWaveTex() would otherwise see an empty registry and
    // render a fixed sine fallback that ignores morph.
    {
      const data0 = (livePatch.nodes[node.id]?.data ?? {}) as WavesculptData;
      const initFrames: Float32Array[][] = [];
      for (let i = 0; i < 4; i++) {
        const oscData = data0[`osc${i + 1}` as keyof WavesculptData] as WavesculptOscData | undefined;
        initFrames.push(resolveOscFrames(oscData).frames);
      }
      FRAMES_REGISTRY.set(node.id, initFrames);
    }

    // Load the engine worklet once per AudioContext.
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // The worklet has 4 mono CV-input ports (pitch_cv1..4) → input count 4.
    // Outputs 0..3 are stereo per-osc raw shaped signal (NO env, NO
    // dist, NO pan). The JS factory applies env+dist+pan+FX-slot
    // downstream of the worklet, which is what lets each osc have its
    // own FX slot insertion point.
    const engineNode = new AudioWorkletNode(ctx, 'wavesculpt-engine', {
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [2, 2, 2, 2],
    });
    const engineParams = engineNode.parameters as unknown as Map<string, AudioParam>;

    // Mirror initial knob values into worklet params (tune/fine/morph/
    // spread/fold; env + distGain are no longer worklet AudioParams).
    for (let i = 1; i <= 4; i++) {
      for (const k of [`tune${i}`, `fine${i}`, `morph${i}`, `spread${i}`, `fold${i}`]) {
        engineParams.get(k)?.setValueAtTime(live[k] ?? 0, ctx.currentTime);
      }
    }

    // ---------------- Per-osc audio chain ----------------
    //
    // Per osc:
    //   engineNode.output(i)         (stereo, raw shaped)
    //     → preFxBus[i]              (stereo input bus, always live)
    //     → [active FX node]          (DELAY or REVERB; bypass = direct
    //        or fxBypass[i]           connection on fxBypass when OFF)
    //     → envDistGain[i]           (env * dist scalar, JS-side)
    //     → panner[i]                (per-osc pan — RED right, GREEN left,
    //                                 BLUE/ALPHA center; replaces the
    //                                 worklet's panForOsc loop)
    //     → busL/busR                (master stereo bus)
    interface OscChain {
      preFx: GainNode;       // worklet output i lands here
      fxBypass: GainNode;    // direct-passthrough when fxType=OFF
      fxActive: AudioNode | null;   // currently-instantiated FX (DelayNode wrapper, ConvolverNode wrapper)
      fxDispose: (() => void) | null;
      currentFxType: number; // 0=OFF, 1=REVERB, 2=DELAY
      envDist: GainNode;     // env * dist gating
      panner: StereoPannerNode;
    }
    const oscChains: OscChain[] = [];
    const busL = ctx.createGain();
    const busR = ctx.createGain();
    busL.gain.value = 1;
    busR.gain.value = 1;
    // Master stereo bus = StereoPanner inputs summed via a ChannelSplitter
    // (panners are stereo-in stereo-out; busL/busR want mono per side).
    const masterSplitter = ctx.createChannelSplitter(2);
    masterSplitter.connect(busL, 0);
    masterSplitter.connect(busR, 1);

    for (let i = 0; i < NUM_OSC; i++) {
      const preFx = ctx.createGain();
      preFx.gain.value = 1;
      engineNode.connect(preFx, i);

      const fxBypass = ctx.createGain();
      fxBypass.gain.value = 1; // default OFF = direct path
      preFx.connect(fxBypass);

      const envDist = ctx.createGain();
      envDist.gain.value = 0; // env starts at 0
      fxBypass.connect(envDist);

      const panner = ctx.createStereoPanner();
      // panForOsc: RED (x=+1) → pan +1 (right), GREEN (-1) → pan -1 (left),
      // BLUE/ALPHA (x=0) → pan 0 (center). Equal-power; matches the
      // worklet's prior panForOsc() math.
      const panX = i === 0 ? 1 : i === 1 ? -1 : 0;
      panner.pan.value = panX;
      envDist.connect(panner);
      panner.connect(masterSplitter);

      oscChains.push({
        preFx,
        fxBypass,
        fxActive: null,
        fxDispose: null,
        currentFxType: 0,
        envDist,
        panner,
      });
    }

    // ---------------- Per-osc wavetable resolution + poll loop ----------------
    const resolvedSigs: string[] = ['', '', '', ''];
    function resolveAndPostAll(): void {
      const data = (livePatch.nodes[node.id]?.data ?? {}) as WavesculptData;
      const allFrames: Float32Array[][] = [];
      for (let i = 0; i < 4; i++) {
        const oscData = data[`osc${i + 1}` as keyof WavesculptData] as WavesculptOscData | undefined;
        const next = resolveOscFrames(oscData);
        allFrames.push(next.frames);
        if (next.signature !== resolvedSigs[i]) {
          resolvedSigs[i] = next.signature;
          try {
            engineNode.port.postMessage({
              type: 'loadWavetable',
              oscIdx: i,
              frames: framesToPlain(next.frames),
            });
          } catch (err) {
            console.error('[wavesculpt] loadWavetable post failed', err);
          }
        }
      }
      FRAMES_REGISTRY.set(node.id, allFrames);
    }
    resolveAndPostAll();

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function poll(): void {
      if (!alive) return;
      resolveAndPostAll();
      pollTimer = setTimeout(poll, POLL_MS);
    }
    pollTimer = setTimeout(poll, POLL_MS);

    // ---------------- Pitch CV taps (so the JS-side ADSR ticker can also
    //                  read incoming V/oct for the visual pitch indicator,
    //                  even though the worklet receives the same CV via
    //                  its input ports directly) + gate taps ----------------
    function makeAnalyserTap(): { gain: GainNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer>; sil: ConstantSourceNode } {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
      gain.connect(an);
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(gain);
      return { gain, an, buf, sil };
    }
    const gateTaps = Array.from({ length: NUM_OSC }, () => makeAnalyserTap());
    // Per-osc pitch_cv goes BOTH to the worklet (for audio-rate pitch) AND
    // to a tap (so the JS side can sample for any future use — kept for
    // symmetry with v1's structure even though we don't currently need
    // the JS-side read of pitch).
    const pitchTaps = Array.from({ length: NUM_OSC }, () => makeAnalyserTap());
    // Wire each pitchTap to the corresponding worklet input.
    for (let i = 0; i < NUM_OSC; i++) {
      pitchTaps[i]!.gain.connect(engineNode, 0, i);
    }

    // ---------------- ADSR scheduler + distGain mirror ----------------
    const voices: VoiceState[] = Array.from({ length: NUM_OSC }, newVoiceState);
    let lastTick = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function readTail(buf: Float32Array<ArrayBuffer>): number {
      return buf[buf.length - 1] ?? 0;
    }

    // Cached signatures so we only re-post a routing message to the
    // worklet when the patched/unpatched state actually changes — not
    // every 8 ms tick. Same idea as the wavetable-frame signature cache
    // earlier in the file.
    let lastPitchRouteSig = '';

    // ---------------- Per-osc FX slot machinery ----------------
    //
    // Each osc's chain sits between the worklet output and the env-dist
    // gate. The FX node is inlined (not a sub-factory) for two reasons:
    //   * Cheap: a DelayNode + feedback loop or a ConvolverNode with a
    //     synthesised IR is much smaller than spinning up a full Faust-
    //     reverb worklet instance per osc.
    //   * Audible character matches the standalone DELAY module's
    //     topology, so swapping the FX slot for a real cable to
    //     standalone DELAY sounds the same.
    //
    // ensureFxSlot(i, fxType) tears down the previous FX (if any) and
    // builds the new one wired into oscChains[i] (preFx → [fx] → envDist
    // when active; preFx → fxBypass → envDist when OFF). applyFxAmount
    // tweaks the wet level; for REVERB it folds distGain into the wet
    // so closer-to-camera = wetter.
    interface FxSlotState {
      input: AudioNode;
      output: AudioNode;
      setMix: (mix: number) => void;
      dispose: () => void;
    }
    function makeDelayFx(): FxSlotState {
      // Mirror of delay.ts topology — sized for a moderate slap-back
      // that still feels "delay-y" at the default 0.25 s. The user
      // dials fxAmount for wet level; time + feedback are sensible
      // defaults the FX slot UI doesn't expose (full control via the
      // standalone DELAY module if needed).
      const inG = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const out = ctx.createGain();
      const d = ctx.createDelay(2);
      d.delayTime.value = 0.28;
      const fb = ctx.createGain();
      fb.gain.value = 0.45;
      inG.connect(dry);
      inG.connect(d);
      d.connect(fb);
      fb.connect(d);
      d.connect(wet);
      dry.connect(out);
      wet.connect(out);
      dry.gain.value = 1;
      wet.gain.value = 0;
      return {
        input: inG,
        output: out,
        setMix(m) {
          const clamp = Math.max(0, Math.min(1, m));
          // Equal-power crossfade.
          dry.gain.setTargetAtTime(Math.sqrt(1 - clamp), ctx.currentTime, 0.02);
          wet.gain.setTargetAtTime(Math.sqrt(clamp),     ctx.currentTime, 0.02);
        },
        dispose() {
          try { inG.disconnect(); } catch { /* */ }
          try { dry.disconnect(); } catch { /* */ }
          try { wet.disconnect(); } catch { /* */ }
          try { d.disconnect();   } catch { /* */ }
          try { fb.disconnect();  } catch { /* */ }
          try { out.disconnect(); } catch { /* */ }
        },
      };
    }
    function makeReverbFx(): FxSlotState {
      // Simple Schroeder-style reverb via ConvolverNode + synthesized
      // exponential-decay noise IR. The IR is generated once per FX
      // instance (cheap); decay time + size are baked in (0.8 s @
      // sr=ctx.sampleRate). User controls wet level via fxAmount —
      // additionally modulated by per-osc distance for the spatial
      // strongest-closest behavior the user asked for.
      const inG = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const out = ctx.createGain();
      const conv = ctx.createConvolver();
      // Build IR: stereo exponential-decay white noise, 0.8 s long.
      const irDurSec = 0.8;
      const irLen = Math.round(ctx.sampleRate * irDurSec);
      const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = ir.getChannelData(ch);
        for (let n = 0; n < irLen; n++) {
          const t = n / irLen;
          // Exponential decay with `e^-7t` ≈ -60 dB at end of IR.
          data[n] = (Math.random() * 2 - 1) * Math.exp(-7 * t);
        }
      }
      conv.buffer = ir;
      inG.connect(dry);
      inG.connect(conv);
      conv.connect(wet);
      dry.connect(out);
      wet.connect(out);
      dry.gain.value = 1;
      wet.gain.value = 0;
      return {
        input: inG,
        output: out,
        setMix(m) {
          const clamp = Math.max(0, Math.min(1, m));
          dry.gain.setTargetAtTime(Math.sqrt(1 - clamp), ctx.currentTime, 0.02);
          wet.gain.setTargetAtTime(Math.sqrt(clamp),     ctx.currentTime, 0.02);
        },
        dispose() {
          try { inG.disconnect();  } catch { /* */ }
          try { dry.disconnect();  } catch { /* */ }
          try { wet.disconnect();  } catch { /* */ }
          try { conv.disconnect(); } catch { /* */ }
          try { out.disconnect();  } catch { /* */ }
        },
      };
    }

    const fxSlots: Array<FxSlotState | null> = [null, null, null, null];

    function ensureFxSlot(oscIdx: number, fxType: number): void {
      const chain = oscChains[oscIdx]!;
      if (chain.currentFxType === fxType) return;
      // Tear down previous wiring.
      try { chain.preFx.disconnect(); } catch { /* */ }
      const old = fxSlots[oscIdx];
      if (old) {
        old.dispose();
        fxSlots[oscIdx] = null;
      }
      if (fxType === 0) {
        // OFF — direct passthrough via fxBypass.
        chain.preFx.connect(chain.fxBypass);
      } else {
        const fx = fxType === 1 ? makeReverbFx() : makeDelayFx();
        fxSlots[oscIdx] = fx;
        chain.preFx.connect(fx.input);
        fx.output.connect(chain.envDist);
      }
      chain.currentFxType = fxType;
    }

    function applyFxAmount(
      oscIdx: number, fxType: number, fxAmount: number, distG: number,
    ): void {
      const fx = fxSlots[oscIdx];
      if (!fx) return;
      // REVERB (fxType=1): wet = fxAmount * distGain. Closer to camera
      // = wetter; matches the user spec's "reverb params change based
      // on where we are in space, being strongest closest to the
      // oscillator." DELAY's wet stays purely fxAmount.
      const wet = fxType === 1 ? fxAmount * distG : fxAmount;
      fx.setMix(wet);
    }

    function tick(): void {
      if (!alive) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dtMs = now - lastTick;
      lastTick = now;

      const gateRead: number[] = new Array(NUM_OSC);
      for (let i = 0; i < NUM_OSC; i++) {
        gateTaps[i]!.an.getFloatTimeDomainData(gateTaps[i]!.buf);
        gateRead[i] = readTail(gateTaps[i]!.buf);
      }

      const unison = (live.unison ?? 0) >= 0.5;
      const chordMode = (live.chord_mode ?? 0) >= 0.5;
      const chordQuality = chordQualityFromKnob(live.chord_quality ?? 0);

      // Patched-state detection. isInputPortConnected walks edges once
      // per call — N=4 voices × 2 ports per tick is trivially cheap.
      const edges = Object.values(livePatch.edges);
      const gatePatched: boolean[] = [
        isInputPortConnected(edges, node.id, 'gate1'),
        isInputPortConnected(edges, node.id, 'gate2'),
        isInputPortConnected(edges, node.id, 'gate3'),
        isInputPortConnected(edges, node.id, 'gate4'),
      ];
      const pitchPatched: boolean[] = [
        isInputPortConnected(edges, node.id, 'pitch_cv1'),
        isInputPortConnected(edges, node.id, 'pitch_cv2'),
        isInputPortConnected(edges, node.id, 'pitch_cv3'),
        isInputPortConnected(edges, node.id, 'pitch_cv4'),
      ];
      const { gateRoute, pitchRoute } = effectiveVoiceRouting(
        unison,
        chordMode,
        gatePatched,
        pitchPatched,
      );

      // Pitch routing happens INSIDE the worklet (each osc selects
      // which pitch_cv input to sample for its V/oct). Post a message
      // when the route changes; the worklet defaults to identity
      // [0,1,2,3] until it receives one.
      const pitchSig = pitchRoute.join(',');
      if (pitchSig !== lastPitchRouteSig) {
        lastPitchRouteSig = pitchSig;
        try {
          engineNode.port.postMessage({ type: 'setPitchRoute', route: pitchRoute });
        } catch { /* worklet not yet ready */ }
      }

      // Camera position drives BOTH the visual eye AND the audio
      // distGain. Computing once here from the COMBINED (knob + CV)
      // values means a patched LFO modulates both consistently —
      // closer-to-the-wall = louder + visually bigger.
      const camPos = eyeFromCamera(
        readCamShadow(sPosX, live.pos_x ?? 0),
        readCamShadow(sPosY, live.pos_y ?? 0),
        readCamShadow(sPosZ, live.pos_z ?? 0),
        readCamShadow(sZoom, live.zoom ?? 1),
        readCamShadow(sRot,  live.rot  ?? 0),
      );

      for (let i = 0; i < NUM_OSC; i++) {
        // Gate sourcing: the JS-side ADSR re-reads the (potentially
        // normalled) gate so the envelope fires for every voice in the
        // chain, even those whose own gate input is unpatched.
        const gateSourceIdx = gateRoute[i]!;
        const gateNow = gateRead[gateSourceIdx]! >= GATE_HIGH;
        const v = voices[i]!;
        if (gateNow && !v.gateHigh) {
          v.gateHigh = true;
          v.phase = 'attack';
          v.phaseT = 0;
        } else if (!gateNow && v.gateHigh) {
          v.gateHigh = false;
          (v as VoiceState & { _releaseStart?: number })._releaseStart = v.env;
          v.phase = 'release';
          v.phaseT = 0;
        }
        const params = {
          A: live[`A${i + 1}`]!,
          D: live[`D${i + 1}`]!,
          S: live[`S${i + 1}`]!,
          R: live[`R${i + 1}`]!,
        };
        const newState = tickEnvelope(v, dtMs, params);
        Object.assign(v, newState);

        // JS-side env + dist gating. The worklet emits raw shaped
        // stereo per osc on its own output; we apply env*dist HERE so
        // the per-osc FX slot (DELAY/REVERB) sits BEFORE the gate —
        // matches the canonical "FX shapes the oscillator pre-mix"
        // semantic the user asked for.
        const distG = distanceGain(WALL_LAYOUT[i]!.src, WALL_LAYOUT[i]!.vec, camPos);
        const envDist = v.env * distG;
        try {
          oscChains[i]!.envDist.gain.setTargetAtTime(envDist, ctx.currentTime, 0.005);
        } catch { /* defensive */ }

        // Push the combined (knob + CV) morph value from the shadow
        // analyser into the worklet's morph{N} AudioParam. The shadow
        // is the single source of truth — same analyser the
        // engine.readParam('morph{N}') + engine.read(node, 'morph')
        // surfaces read, and ultimately the same value the joystick
        // UI displays once it points at engine.read(node, 'morph').
        // Audio-rate-ish push (one update per ENV_TICK ≈ 16ms) —
        // smooth enough for visible/audible morph CV without clicking
        // at wavetable frame boundaries.
        try {
          const morphValue = readCamShadow(sMorph[i]!, live[`morph${i + 1}`] ?? 0);
          engineParams.get(`morph${i + 1}`)?.setTargetAtTime(morphValue, ctx.currentTime, 0.01);
        } catch { /* defensive — worklet may not have surfaced the param */ }

        // FX slot management — rebuild the FX node when fxType changes.
        // Distance-modulated reverb: when REVERB is active, the
        // effective wet level is fxAmount * distG (closer to the
        // emitter = wetter; matches "strongest closest to the
        // oscillator"). DELAY's mix is just fxAmount (no spatial
        // modulation — delay-time-of-flight already happens naturally
        // via the audio path's speed-of-sound metaphor in the
        // distance gain).
        const fxType = Math.round(live[`fxType${i + 1}`] ?? 0);
        const fxAmount = Math.max(0, Math.min(1, live[`fxAmount${i + 1}`] ?? 0.4));
        ensureFxSlot(i, fxType);
        applyFxAmount(i, fxType, fxAmount, distG);

        // Per-osc tune resolution. Priority:
        //   1. Chord mode: voice i = root + chord-interval[i] semitones,
        //      overriding the user's tune knob.
        //   2. Unison mode: base tune + detune offset.
        //   3. Default: leave the user's tune knob alone (setParam path
        //      already wrote it to the worklet AudioParam).
        if (chordMode) {
          const interval = CHORD_INTERVALS_SEMITONES[chordQuality][i] ?? 0;
          // Combine the user's voice-1 tune knob (root offset) with the
          // chord interval so they can transpose the chord by tweaking
          // tune1. Voices 2-4 ignore their own tune knobs while chord
          // mode is on.
          const root = live.tune1 ?? 0;
          try {
            engineParams.get(`tune${i + 1}`)?.setTargetAtTime(root + interval, ctx.currentTime, 0.005);
          } catch { /* */ }
        } else if (unison) {
          const detune = live.detune ?? 0;
          const detuneOct = detuneOctaveOffset(i, detune);
          const tuneSt = (live[`tune${i + 1}`] ?? 0) + detuneOct * 12;
          try {
            engineParams.get(`tune${i + 1}`)?.setTargetAtTime(tuneSt, ctx.currentTime, 0.005);
          } catch { /* */ }
        } else {
          // Restore the per-voice tune knob in case chord/unison was
          // just toggled off — without this the tune param would stay
          // stuck at the most-recent chord-mode value.
          try {
            engineParams.get(`tune${i + 1}`)?.setTargetAtTime(
              live[`tune${i + 1}`] ?? 0,
              ctx.currentTime,
              0.005,
            );
          } catch { /* */ }
        }
      }
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;
    if (typeof setInterval !== 'undefined') {
      intervalId = setInterval(tick, ENV_TICK_MS);
    }

    // ---------------- Camera-CV shadow gains (for engine per-param tap) ----------------
    //
    // Each camera CV input owns a GainNode whose .gain AudioParam is the
    // `param:` target the engine writes incoming CV modulation onto
    // (LFO → pos_x, etc.). To READ the combined value (knob + CV) we
    // drive the GainNode's input from a `sink` ConstantSource that
    // outputs 1.0 — so the GainNode's output equals .gain's current
    // effective value (intrinsic knob + audio-rate modulation summed in
    // by the engine). An AnalyserNode tap on the GainNode lets the
    // tick() loop sample that combined value sample-accurately each
    // tick, then feed it into eyeFromCamera() so audio distGain AND
    // visual camera both reflect the live modulated value.
    //
    // Pre-fix bug: tick() read `live.pos_x` etc — the JS-side cached
    // knob — so an LFO patched to pos_x updated the AudioParam but
    // never moved the camera.
    interface CamShadow {
      gain: GainNode;
      analyser: AnalyserNode;
      buf: Float32Array<ArrayBuffer>;
      sink: ConstantSourceNode;
    }
    const shadowSinks: ConstantSourceNode[] = [];
    function makeShadow(initial: number): CamShadow {
      const g = ctx.createGain();
      g.gain.setValueAtTime(initial, ctx.currentTime);
      const sink = ctx.createConstantSource();
      // offset=1 so g's output = 1 × g.gain.value = the combined
      // (knob + CV) value. The output is read via the analyser tap;
      // no downstream audio path consumes it.
      sink.offset.value = 1;
      sink.start();
      sink.connect(g);
      const analyser = ctx.createAnalyser();
      // fftSize=32 matches the engine's paramTapBuf (engine.ts ~line 162).
      // We only need the most-recent sample.
      analyser.fftSize = 32;
      analyser.smoothingTimeConstant = 0;
      g.connect(analyser);
      const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      shadowSinks.push(sink);
      return { gain: g, analyser, buf, sink };
    }
    const sPosX = makeShadow(live.pos_x ?? 0);
    const sPosY = makeShadow(live.pos_y ?? 0);
    const sPosZ = makeShadow(live.pos_z ?? 0);
    const sZoom = makeShadow(live.zoom ?? 1);
    const sRot  = makeShadow(live.rot  ?? 0);
    // Per-osc morph shadows. Same pattern as the camera shadows:
    // CV cables connect into morph{N}_cv → shadow gain AudioParam;
    // the shadow analyser captures the combined (knob + CV) value
    // at audio rate; tick() reads it + pushes the combined value to
    // the worklet's morph{N} AudioParam via setTargetAtTime. This
    // unifies the source-of-truth: spatial audio, the JS-side worklet
    // morph push, and the UI joystick all read the same combined
    // sample.
    const sMorph: CamShadow[] = [];
    for (let i = 0; i < NUM_OSC; i++) {
      sMorph.push(makeShadow(live[`morph${i + 1}`] ?? 0));
    }

    /** Read the latest combined (knob + CV) value from a camera shadow.
     *  Falls back to the knob value when the analyser hasn't yet
     *  produced any non-zero samples (very early in the lifecycle,
     *  before the audio thread has rendered the first quantum). */
    function readCamShadow(s: CamShadow, fallback: number): number {
      s.analyser.getFloatTimeDomainData(s.buf);
      const tail = s.buf[s.buf.length - 1] ?? 0;
      // Tail==0 with no CV patched would still be correct because the
      // knob set it to 0; but with knob=non-zero and no CV the
      // analyser DOES read the non-zero value. The fallback is a
      // belt-and-braces for the first-block-undefined case (rare in
      // practice since the engine renders the first quantum
      // synchronously after the worklet connects).
      return tail !== 0 || s.gain.gain.value === 0 ? tail : fallback;
    }

    // ---------------- Mono-video bridge ----------------
    const videoAnalyser = ctx.createAnalyser();
    videoAnalyser.fftSize = 256;
    busL.connect(videoAnalyser);

    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const fn = FRAME_DRAWERS.get(node.id);
      if (fn) {
        try { fn(canvas); return; } catch { /* fall through */ }
      }
      const c2d = canvas.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!c2d) return;
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Build the inputs map imperatively so the mixed node types
    // (GainNode for the gate/pitch/camera taps, AudioWorkletNode for
    // the worklet-AudioParam routes) don't make TS narrow the Map's
    // value type to a single concrete shape.
    const inputsMap: Map<
      string,
      { node: AudioNode; input: number; param?: AudioParam }
    > = new Map();
    inputsMap.set('gate1',     { node: gateTaps[0]!.gain,  input: 0 });
    inputsMap.set('gate2',     { node: gateTaps[1]!.gain,  input: 0 });
    inputsMap.set('gate3',     { node: gateTaps[2]!.gain,  input: 0 });
    inputsMap.set('gate4',     { node: gateTaps[3]!.gain,  input: 0 });
    inputsMap.set('pitch_cv1', { node: pitchTaps[0]!.gain, input: 0 });
    inputsMap.set('pitch_cv2', { node: pitchTaps[1]!.gain, input: 0 });
    inputsMap.set('pitch_cv3', { node: pitchTaps[2]!.gain, input: 0 });
    inputsMap.set('pitch_cv4', { node: pitchTaps[3]!.gain, input: 0 });
    inputsMap.set('pos_x', { node: sPosX.gain, input: 0, param: sPosX.gain.gain });
    inputsMap.set('pos_y', { node: sPosY.gain, input: 0, param: sPosY.gain.gain });
    inputsMap.set('pos_z', { node: sPosZ.gain, input: 0, param: sPosZ.gain.gain });
    inputsMap.set('zoom',  { node: sZoom.gain, input: 0, param: sZoom.gain.gain });
    inputsMap.set('rot',   { node: sRot.gain,  input: 0, param: sRot.gain.gain  });
    // Per-osc morph CV → shadow gain (mirroring the camera CV path).
    // The engine connects the modulator into the shadow's gain
    // AudioParam; the analyser captures combined (knob + CV) at audio
    // rate. tick() reads the shadow + pushes the combined value to
    // the worklet's morph{N} AudioParam (~60Hz via setTargetAtTime),
    // which is plenty fast for visible/audible morph modulation
    // without the worklet seeing audio-rate stepping that'd cause
    // clicks at wavetable frame boundaries.
    for (let i = 0; i < NUM_OSC; i++) {
      const s = sMorph[i]!;
      inputsMap.set(`morph${i + 1}_cv`, { node: s.gain, input: 0, param: s.gain.gain });
    }

    const handle: AudioDomainNodeHandle = {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['L', { node: busL, output: 0 }],
        ['R', { node: busR, output: 0 }],
      ]),
      videoSources: new Map([
        ['video_out', {
          analyser: videoAnalyser,
          sampleRate: ctx.sampleRate,
          drawFrame,
        }],
      ]),
      setParam(paramId, value) {
        live[paramId] = value;
        if (paramId === 'pos_x') sPosX.gain.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'pos_y') sPosY.gain.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'pos_z') sPosZ.gain.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'zoom')  sZoom.gain.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'rot')   sRot.gain.gain.setValueAtTime(value, ctx.currentTime);
        // Per-osc morph knob → corresponding shadow gain. The shadow
        // is the single source of truth: tick() reads it and pushes
        // combined (knob + CV) into the worklet's morph{N} AudioParam.
        const mm = /^morph([1-4])$/.exec(paramId);
        if (mm) {
          const idx = Number(mm[1]) - 1;
          sMorph[idx]?.gain.gain.setValueAtTime(value, ctx.currentTime);
        }
        // Mirror per-osc tune/fine/spread/fold into worklet AudioParams.
        // morph is intentionally excluded — its worklet param is driven
        // by the tick() loop from the shadow, NOT by setParam, so the
        // CV component isn't clobbered by an immediate knob write.
        const m = /^(tune|fine|spread|fold)([1-4])$/.exec(paramId);
        if (m) {
          try { engineParams.get(paramId)?.setValueAtTime(value, ctx.currentTime); } catch { /* */ }
        }
      },
      readParam(paramId) {
        // Returns the KNOB ONLY. The engine layer (engine.ts
        // PatchEngine.readParam) sums this with the paramTap analyser
        // sample, giving (knob + CV). The shadow-analyser path used
        // by read('camera')/read('morph') gives the same combined
        // value via a different route — both are the single source
        // of truth. DON'T return combined here or engine.readParam
        // double-counts the CV contribution.
        return live[paramId];
      },
      read(key) {
        if (key === 'voiceState') {
          return voices.map((v) => ({ env: v.env, phase: v.phase }));
        }
        if (key === 'live') {
          return { ...live };
        }
        // Unified single-source-of-truth reads. The same shadow
        // analyser samples that drive the spatial audio mix are
        // exposed here for the card (joystick + WebGL render) to
        // read. So joystick dot, ribbon viewport, and spatial mix
        // ALL reflect the same instant.
        if (key === 'camera') {
          return {
            pos_x: readCamShadow(sPosX, live.pos_x ?? 0),
            pos_y: readCamShadow(sPosY, live.pos_y ?? 0),
            pos_z: readCamShadow(sPosZ, live.pos_z ?? 0),
            zoom:  readCamShadow(sZoom, live.zoom  ?? 1),
            rot:   readCamShadow(sRot,  live.rot   ?? 0),
          };
        }
        if (key === 'morph') {
          return {
            1: readCamShadow(sMorph[0]!, live.morph1 ?? 0),
            2: readCamShadow(sMorph[1]!, live.morph2 ?? 0),
            3: readCamShadow(sMorph[2]!, live.morph3 ?? 0),
            4: readCamShadow(sMorph[3]!, live.morph4 ?? 0),
          };
        }
        if (key === 'wallLayout') return WALL_LAYOUT;
        if (key === 'wavetableFrames') return FRAMES_REGISTRY.get(node.id);
        return undefined;
      },
      dispose() {
        alive = false;
        FRAME_DRAWERS.delete(node.id);
        FRAMES_REGISTRY.delete(node.id);
        if (intervalId !== null) clearInterval(intervalId);
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { engineNode.disconnect(); } catch { /* */ }
        // Per-osc chain + FX slot teardown.
        for (let i = 0; i < NUM_OSC; i++) {
          const slot = fxSlots[i];
          if (slot) slot.dispose();
          const c = oscChains[i];
          if (c) {
            try { c.preFx.disconnect();    } catch { /* */ }
            try { c.fxBypass.disconnect(); } catch { /* */ }
            try { c.envDist.disconnect();  } catch { /* */ }
            try { c.panner.disconnect();   } catch { /* */ }
          }
        }
        try { masterSplitter.disconnect(); } catch { /* */ }
        for (const t of pitchTaps) {
          try { t.sil.stop(); } catch { /* */ }
          t.gain.disconnect();
          t.an.disconnect();
          t.sil.disconnect();
        }
        for (const t of gateTaps) {
          try { t.sil.stop(); } catch { /* */ }
          t.gain.disconnect();
          t.an.disconnect();
          t.sil.disconnect();
        }
        for (const s of shadowSinks) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const s of [sPosX, sPosY, sPosZ, sZoom, sRot]) {
          try { s.gain.disconnect(); } catch { /* */ }
          try { s.analyser.disconnect(); } catch { /* */ }
        }
        busL.disconnect();
        busR.disconnect();
        videoAnalyser.disconnect();
      },
    };

    return handle;
  },
};
