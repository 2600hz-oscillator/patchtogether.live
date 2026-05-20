// packages/web/src/lib/audio/modules/wavesculpt.ts
//
// WAVESCULPT — hybrid 4-oscillator 3D video synth.
//
// v2 (post-wavetable-engine refactor):
//   The per-osc audio source is now a WAVETABLE oscillator (same shared
//   engine WAVECEL uses — packages/dsp/src/lib/wavetable-osc.ts). All four
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
//                now "0..1 wavetable frame position" (WAVECEL-style).
//
// New camera params:
//   - zoom (0.3..3) — used as camera distance scalar. Visual: closer = bigger
//     ribbons. Audio: closer = louder (smaller dist² in distGain formula).
//   - rot  (-1..+1) — camera rotation around Y axis. -1 = full left, +1 =
//     full right. Visual only; audio is rotation-invariant (distance is
//     scalar). New in v2 — wired through the second "zoom/rot" joystick on
//     the card.
//
// Per-osc wavetable selection rides node.data (same shape as wavecel.data
// but indexed: wavetableSourceN, wavetableFramesN, wavetableLabelN for
// N=1..4). The factory polls livePatch.nodes[id].data and reposts on change.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/wavesculpt-engine.js?url';
import {
  framesToPlain,
  framesFromPlain,
  getFactoryTable,
  DEFAULT_FACTORY_TABLE_ID,
} from '$lib/audio/wavecel-factory-tables';

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
    }
    ps.push({ id: 'pos_x', label: 'X',     defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'pos_y', label: 'Y',     defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'pos_z', label: 'H',     defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'zoom',  label: 'Zoom',  defaultValue: 1, min: 0.3, max: 3, curve: 'log' });
    ps.push({ id: 'rot',   label: 'Rot',   defaultValue: 0, min: -1, max: 1, curve: 'linear' });
    ps.push({ id: 'unison', label: 'Unison', defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
    ps.push({ id: 'detune', label: 'Detune', defaultValue: 0, min: -1, max: 1, curve: 'linear' });
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
    // Output 0 is stereo (L, R).
    const engineNode = new AudioWorkletNode(ctx, 'wavesculpt-engine', {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const engineParams = engineNode.parameters as unknown as Map<string, AudioParam>;

    // Mirror initial knob values into worklet params.
    for (let i = 1; i <= 4; i++) {
      for (const k of [`tune${i}`, `fine${i}`, `morph${i}`, `spread${i}`, `fold${i}`]) {
        engineParams.get(k)?.setValueAtTime(live[k] ?? 0, ctx.currentTime);
      }
    }

    // Split the worklet's stereo output into two single-channel buses
    // so the existing L/R port contract holds.
    const splitter = ctx.createChannelSplitter(2);
    engineNode.connect(splitter);
    const busL = ctx.createGain();
    const busR = ctx.createGain();
    busL.gain.value = 1;
    busR.gain.value = 1;
    splitter.connect(busL, 0);
    splitter.connect(busR, 1);

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
      const routing = unisonRouting(unison);

      // Camera position drives BOTH the visual eye AND the audio distGain.
      // Computing once here is the single source of truth.
      const camPos = eyeFromCamera(
        live.pos_x ?? 0,
        live.pos_y ?? 0,
        live.pos_z ?? 0,
        live.zoom ?? 1,
        live.rot ?? 0,
      );

      for (let i = 0; i < NUM_OSC; i++) {
        const sourceIdx = routing[i]!;
        const gateNow = gateRead[sourceIdx]! >= GATE_HIGH;
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

        // Mirror env + distGain into the worklet's AudioParams.
        const distG = distanceGain(WALL_LAYOUT[i]!.src, WALL_LAYOUT[i]!.vec, camPos);
        try {
          engineParams.get(`env${i + 1}`)?.setTargetAtTime(v.env, ctx.currentTime, 0.005);
          engineParams.get(`distGain${i + 1}`)?.setTargetAtTime(distG, ctx.currentTime, 0.005);
        } catch { /* defensive */ }

        // Per-osc UNISON detune → apply to tune param (semitones).
        if (unison) {
          const detune = live.detune ?? 0;
          const detuneOct = detuneOctaveOffset(i, detune);
          // Combine base tune + detune offset (in semitones).
          const tuneSt = (live[`tune${i + 1}`] ?? 0) + detuneOct * 12;
          try {
            engineParams.get(`tune${i + 1}`)?.setTargetAtTime(tuneSt, ctx.currentTime, 0.005);
          } catch { /* */ }
        }
      }
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;
    if (typeof setInterval !== 'undefined') {
      intervalId = setInterval(tick, ENV_TICK_MS);
    }

    // ---------------- Camera-CV shadow gains (for engine per-param tap) ----------------
    function makeShadow(initial: number): GainNode {
      const g = ctx.createGain();
      g.gain.setValueAtTime(initial, ctx.currentTime);
      const sink = ctx.createConstantSource();
      sink.offset.value = 0;
      sink.start();
      sink.connect(g);
      shadowSinks.push(sink);
      return g;
    }
    const shadowSinks: ConstantSourceNode[] = [];
    const sPosX = makeShadow(live.pos_x ?? 0);
    const sPosY = makeShadow(live.pos_y ?? 0);
    const sPosZ = makeShadow(live.pos_z ?? 0);
    const sZoom = makeShadow(live.zoom ?? 1);
    const sRot  = makeShadow(live.rot  ?? 0);

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

    const handle: AudioDomainNodeHandle = {
      domain: 'audio',
      inputs: new Map([
        ['gate1',     { node: gateTaps[0]!.gain,  input: 0 }],
        ['gate2',     { node: gateTaps[1]!.gain,  input: 0 }],
        ['gate3',     { node: gateTaps[2]!.gain,  input: 0 }],
        ['gate4',     { node: gateTaps[3]!.gain,  input: 0 }],
        ['pitch_cv1', { node: pitchTaps[0]!.gain, input: 0 }],
        ['pitch_cv2', { node: pitchTaps[1]!.gain, input: 0 }],
        ['pitch_cv3', { node: pitchTaps[2]!.gain, input: 0 }],
        ['pitch_cv4', { node: pitchTaps[3]!.gain, input: 0 }],
        ['pos_x', { node: sPosX, input: 0, param: sPosX.gain }],
        ['pos_y', { node: sPosY, input: 0, param: sPosY.gain }],
        ['pos_z', { node: sPosZ, input: 0, param: sPosZ.gain }],
        ['zoom',  { node: sZoom, input: 0, param: sZoom.gain }],
        ['rot',   { node: sRot,  input: 0, param: sRot.gain  }],
      ]),
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
        if (paramId === 'pos_x') sPosX.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'pos_y') sPosY.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'pos_z') sPosZ.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'zoom')  sZoom.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'rot')   sRot.gain.setValueAtTime(value, ctx.currentTime);
        // Mirror per-osc tune/fine/morph/spread/fold into worklet AudioParams.
        const m = /^(tune|fine|morph|spread|fold)([1-4])$/.exec(paramId);
        if (m) {
          try { engineParams.get(paramId)?.setValueAtTime(value, ctx.currentTime); } catch { /* */ }
        }
      },
      readParam(paramId) {
        return live[paramId];
      },
      read(key) {
        if (key === 'voiceState') {
          return voices.map((v) => ({ env: v.env, phase: v.phase }));
        }
        if (key === 'live') {
          return { ...live };
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
        try { splitter.disconnect(); } catch { /* */ }
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
        sPosX.disconnect();
        sPosY.disconnect();
        sPosZ.disconnect();
        sZoom.disconnect();
        sRot.disconnect();
        busL.disconnect();
        busR.disconnect();
        videoAnalyser.disconnect();
      },
    };

    return handle;
  },
};
