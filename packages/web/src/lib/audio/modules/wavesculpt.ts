// packages/web/src/lib/audio/modules/wavesculpt.ts
//
// WAVESCULPT — hybrid 4-oscillator video synth.
//
// Mental model:
//   A 3D unit box [-1, +1]^3 holds four "wall oscillators". Each
//   oscillator emits a wave ribbon shape from a wall-position along a
//   per-oscillator Vector pointing into the box. A single user-camera
//   inside the box renders the visible scene; its position is set by an
//   XY pad (joystick) for X/Y and a HEIGHT slider for Z. The four ribbons
//   carry oscillator colors: RED, GREEN, BLUE, ALPHA (the fourth either
//   masks transparency, or — for v1 simplicity — adds an outline pass).
//
//   Audio output is the SUM of all four oscillators, each weighted by a
//   distance-attenuation function of (camera position vs source position
//   + Vector direction). The closer + more "in front of" the ribbon the
//   camera is, the louder the oscillator. This means the same gestures
//   that change what the user SEES also change what they HEAR.
//
//   The visible screen is post-processed through a BENTBOX-style CRT
//   shader (12 bending knobs). That happens in the video layer; the
//   audio side just emits voices + lets the card render.
//
// v1 simplifications (vs the full spec):
//   * 4 oscillators × {gate, pitch_cv, morph (saw/tri/sine), ADSR};
//   * Wall positions + Vector dirs are FIXED (R = +X, G = -X, B = +Y, A = -Y);
//     each Vector points along its wall's normal into the box. Per-osc
//     vector_x/vector_y CV inputs are deferred.
//   * No ALPHA-channel compositing IN port v1 — the ALPHA oscillator
//     renders as a faint white outline so all 4 voices are visible.
//   * No rotation slider — camera is always upright.
//
// Audio architecture (per oscillator):
//   OscillatorNode (type set per morph) → GainNode(ADSR envelope) →
//   GainNode(distance gain L) + GainNode(distance gain R) → stereo bus.
//
//   Stereo panning: oscillators on +X tilt right, -X tilt left, +Y/-Y are
//   centered. (The visual layout has the user looking into the box; left/
//   right cameras → left/right ears.)
//
//   ADSR: cheap JS-side envelope: setValueAtTime / linearRampToValueAtTime
//   on the per-osc gain node, driven by the per-osc gate input via an
//   AnalyserNode tap polled at ~120 Hz from a setInterval. This avoids
//   shipping an AudioWorklet just for envelopes.
//
//   UNISON: when ON, oscillator 1's gate fires all four; oscillators
//   2/3/4 inherit pitch from osc 1 with a per-oscillator detune offset
//   derived from the Detune knob (-1..+1).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

// ---------- card → module frame-drawer registry ----------

/**
 * Per-node-id registry of card-installed frame drawers. The card sets
 * an entry on mount (writes its OffscreenCanvas-renderer into the
 * registry); the audio module's drawFrame callback reads it. We use a
 * plain Map keyed by node id (not a WeakMap) so the card can clear its
 * entry on unmount AND we can wipe the slot even after the audio
 * handle disposes. Both sides defensively no-op when the registry is
 * empty for a given node — happens transiently during init.
 */
type FrameDrawer = (canvas: OffscreenCanvas | HTMLCanvasElement) => void;
const FRAME_DRAWERS: Map<string, FrameDrawer> = new Map();

/** Card-side helper: install a frame drawer for a node. The audio
 *  module's mono-video bridge calls into this drawer each video frame. */
export function installWavesculptFrameDrawer(nodeId: string, fn: FrameDrawer): void {
  FRAME_DRAWERS.set(nodeId, fn);
}

/** Card-side helper: clear a frame drawer (on unmount). */
export function uninstallWavesculptFrameDrawer(nodeId: string): void {
  FRAME_DRAWERS.delete(nodeId);
}

// ---------- pure helpers (unit-testable) ----------

/** Per-oscillator wall position + inward Vector for v1's static layout.
 *  Indexed 0..3 for osc1..osc4. */
export const WALL_LAYOUT: ReadonlyArray<{ src: [number, number, number]; vec: [number, number, number] }> = [
  // RED — +X wall, vector points -X (into the box).
  { src: [ 1, 0, 0], vec: [-1, 0, 0] },
  // GREEN — -X wall, vector points +X.
  { src: [-1, 0, 0], vec: [ 1, 0, 0] },
  // BLUE — +Y wall, vector points -Y.
  { src: [ 0, 1, 0], vec: [ 0,-1, 0] },
  // ALPHA — -Y wall, vector points +Y.
  { src: [ 0,-1, 0], vec: [ 0, 1, 0] },
];

/** Distance-attenuated gain for one oscillator given the user camera
 *  position. Formula matches the brief:
 *    dirToCam = normalize(cameraPos - sourcePos)
 *    forward  = normalize(vector)
 *    gain     = max(0, dot(forward, dirToCam)) * 1 / (1 + dist^2)
 *
 *  At the source position itself, dirToCam is undefined; we clamp the
 *  result to 1.0 (camera-inside-the-ribbon case).
 *
 *  Pure helper — unit-tested. */
export function distanceGain(
  source: readonly [number, number, number],
  vector: readonly [number, number, number],
  camera: readonly [number, number, number],
): number {
  const dx = camera[0] - source[0];
  const dy = camera[1] - source[1];
  const dz = camera[2] - source[2];
  const dist2 = dx * dx + dy * dy + dz * dz;
  if (dist2 < 1e-6) return 1; // camera right at the source
  const dist = Math.sqrt(dist2);
  const ndx = dx / dist, ndy = dy / dist, ndz = dz / dist;
  // Normalize vector.
  const vlen = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  const fx = vector[0] / vlen, fy = vector[1] / vlen, fz = vector[2] / vlen;
  const dot = fx * ndx + fy * ndy + fz * ndz;
  const directional = Math.max(0, dot);
  // Inverse-square-ish falloff. We use 1 / (1 + dist^2) so gain stays
  // musically usable across the full unit-box range (max distance ≈ 2√3
  // corner-to-corner).
  const falloff = 1 / (1 + dist2);
  return directional * falloff;
}

/** Stereo pan for one wall position. +X → right, -X → left; Y/Z are
 *  centered. Returns (L gain, R gain) in [0..1] each, equal-power. */
export function stereoPanForSource(source: readonly [number, number, number]): { l: number; r: number } {
  // Map X∈[-1..+1] → angle∈[0..π/2]. -1 = 0 (full left), +1 = π/2 (full right).
  const x = Math.max(-1, Math.min(1, source[0]));
  const angle = ((x + 1) / 2) * (Math.PI / 2);
  return { l: Math.cos(angle), r: Math.sin(angle) };
}

/** Pitch CV (V/oct, 0V = C4) → Hz, anchored at C4 = 261.626 Hz. */
const C4_HZ = 261.626;
export function voctToHz(voct: number): number {
  return C4_HZ * Math.pow(2, voct);
}

/** Apply the Detune knob to a base pitch for each non-primary
 *  oscillator under UNISON. detune ∈ [-1..+1]; -1 = osc2/3/4 are -1
 *  octave; +1 = +1 octave. v1 spreads the three voices linearly. */
export function detuneOctaveOffset(oscIdx: number, detune: number): number {
  // oscIdx is 0..3 — primary is 0. Non-primaries get a per-voice spread.
  // Spread factor differentiates voices so the chorus is musical:
  //   osc1: 0   (anchor)
  //   osc2: detune * 1.0
  //   osc3: detune * 0.5
  //   osc4: detune * 1.0 (opposite sign so 2+4 spread out)
  if (oscIdx === 0) return 0;
  if (oscIdx === 1) return detune;
  if (oscIdx === 2) return detune * 0.5;
  return -detune;
}

/** Map a morph value 0..1 to an OscillatorType (saw → sine → triangle).
 *  v1 uses three discrete shapes; future could crossfade with three
 *  GainNodes like SWOLEVCO. Picks the closest shape — a simple v1 path
 *  that's still gesturally useful (morph fader audibly chooses one). */
export function morphToOscType(morph: number): OscillatorType {
  const m = Math.max(0, Math.min(1, morph));
  if (m < 1 / 3) return 'sawtooth';
  if (m < 2 / 3) return 'sine';
  return 'triangle';
}

// ---------- module def ----------

const NUM_OSC = 4;
const ENV_TICK_MS = 8; // ~120 Hz envelope update — plenty for ADSR shapes
const GATE_HIGH = 0.5;

interface VoiceState {
  /** Current envelope value (0..1). Smoothed via target-driven ramps. */
  env: number;
  /** Whether the gate is currently HIGH. */
  gateHigh: boolean;
  /** Phase of the envelope: idle / attack / decay / sustain / release. */
  phase: 'idle' | 'attack' | 'decay' | 'sustain' | 'release';
  /** Time (ms-since-epoch) phase entered. */
  phaseT: number;
}

function newVoiceState(): VoiceState {
  return { env: 0, gateHigh: false, phase: 'idle', phaseT: 0 };
}

/** Update one voice's envelope state by tickMs. Pure helper — exported
 *  for unit tests. */
export function tickEnvelope(
  state: VoiceState,
  dtMs: number,
  params: { A: number; D: number; S: number; R: number },
): VoiceState {
  // Convert seconds → ms for the curve calcs.
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
      // Decay from whatever env was when release started (we stored it
      // at gate-fall via setting `state.env` and `state.phaseT = 0`).
      // We assume the caller pinned `state.env` before transitioning.
      const startEnv = (state as VoiceState & { _releaseStart?: number })._releaseStart ?? env;
      env = Math.max(0, startEnv * (1 - Math.min(1, t)));
      if (env <= 1e-4) { phase = 'idle'; phaseT = 0; env = 0; }
      break;
    }
  }
  return { ...state, env, phase, phaseT };
}

/** Compute initial UNISON-aware gate-and-pitch routing for all 4 voices
 *  given the primary gate + the unison toggle. Returns an array of which
 *  source oscillator each voice should read its gate/pitch from. */
export function unisonRouting(unison: boolean): number[] {
  if (!unison) return [0, 1, 2, 3];
  return [0, 0, 0, 0];
}

export const wavesculptDef: AudioModuleDef = {
  type: 'wavesculpt',
  domain: 'audio',
  label: 'WAVESCULPT',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    // Per-oscillator gate + pitch CV (V/oct).
    { id: 'gate1',     type: 'gate' },
    { id: 'pitch_cv1', type: 'pitch' },
    { id: 'gate2',     type: 'gate' },
    { id: 'pitch_cv2', type: 'pitch' },
    { id: 'gate3',     type: 'gate' },
    { id: 'pitch_cv3', type: 'pitch' },
    { id: 'gate4',     type: 'gate' },
    { id: 'pitch_cv4', type: 'pitch' },
    // Camera-position CV inputs (joystick X/Y + HEIGHT Z).
    { id: 'pos_x', type: 'cv', paramTarget: 'pos_x', cvScale: { mode: 'linear' } },
    { id: 'pos_y', type: 'cv', paramTarget: 'pos_y', cvScale: { mode: 'linear' } },
    { id: 'pos_z', type: 'cv', paramTarget: 'pos_z', cvScale: { mode: 'linear' } },
    { id: 'zoom',  type: 'cv', paramTarget: 'zoom',  cvScale: { mode: 'linear' } },
    // ALPHA LAYER IN: deferred to v2. Declared here so the deferred plumbing
    // doesn't shift port IDs later. Marked as video; v1 ignores it.
    { id: 'alpha_in', type: 'video' },
  ],
  outputs: [
    // Stereo audio out.
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
    // Mono-video out (the rendered 3D scene with CRT post). The card's
    // `videoSources` map exposes the draw function so the engine can blit
    // it into a downstream video module.
    { id: 'video_out', type: 'mono-video' },
  ],
  params: [
    // Per-osc morph + ADSR.
    { id: 'morph1', label: 'M1', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'A1',     label: 'A1', defaultValue: 0.01, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'D1',     label: 'D1', defaultValue: 0.1,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'S1',     label: 'S1', defaultValue: 0.7,  min: 0, max: 1, curve: 'linear' },
    { id: 'R1',     label: 'R1', defaultValue: 0.5,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'morph2', label: 'M2', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'A2',     label: 'A2', defaultValue: 0.01, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'D2',     label: 'D2', defaultValue: 0.1,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'S2',     label: 'S2', defaultValue: 0.7,  min: 0, max: 1, curve: 'linear' },
    { id: 'R2',     label: 'R2', defaultValue: 0.5,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'morph3', label: 'M3', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'A3',     label: 'A3', defaultValue: 0.01, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'D3',     label: 'D3', defaultValue: 0.1,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'S3',     label: 'S3', defaultValue: 0.7,  min: 0, max: 1, curve: 'linear' },
    { id: 'R3',     label: 'R3', defaultValue: 0.5,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'morph4', label: 'M4', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'A4',     label: 'A4', defaultValue: 0.01, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'D4',     label: 'D4', defaultValue: 0.1,  min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'S4',     label: 'S4', defaultValue: 0.7,  min: 0, max: 1, curve: 'linear' },
    { id: 'R4',     label: 'R4', defaultValue: 0.5,  min: 0.001, max: 5, curve: 'log', units: 's' },

    // Per-osc base pitch (semitones — added to incoming V/oct CV).
    { id: 'pitch1', label: 'P1', defaultValue: 0, min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'pitch2', label: 'P2', defaultValue: 0, min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'pitch3', label: 'P3', defaultValue: 0, min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'pitch4', label: 'P4', defaultValue: 0, min: -36, max: 36, curve: 'linear', units: 'st' },

    // Camera params.
    { id: 'pos_x', label: 'X',     defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_y', label: 'Y',     defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_z', label: 'H',     defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'zoom',  label: 'Zoom',  defaultValue: 1, min: 0.3, max: 3, curve: 'log' },

    // UNISON + Detune.
    { id: 'unison', label: 'Unison', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'detune', label: 'Detune', defaultValue: 0, min: -1, max: 1, curve: 'linear' },

    // Bentscreen wiggles (mirror BENTBOX's 12 knobs).
    { id: 'hsync_drift',        defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'HS Drift' },
    { id: 'hsync_loss',         defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'HS Loss' },
    { id: 'vsync_drift',        defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'VS Drift' },
    { id: 'scan_wobble',        defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Wobble' },
    { id: 'chroma_phase',       defaultValue: 0,    min: -1, max: 1, curve: 'linear', label: 'Hue' },
    { id: 'chroma_instability', defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Shimmer' },
    { id: 'feedback_gain',      defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Feedback' },
    { id: 'feedback_delay',     defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Delay' },
    { id: 'wavefold',           defaultValue: 0,    min: 0,  max: 1, curve: 'linear', label: 'Wavefold' },
    { id: 'bloom',              defaultValue: 0.4,  min: 0,  max: 1, curve: 'linear', label: 'Bloom' },
    { id: 'noise',              defaultValue: 0.05, min: 0,  max: 1, curve: 'linear', label: 'Noise' },
    { id: 'master_gain',        defaultValue: 1,    min: 0,  max: 2, curve: 'linear', label: 'Gain' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = (node.params ?? {}) as Record<string, number>;
    const param = (k: string, d: number) =>
      (initialParams[k] ?? d) as number;

    // Live param shadow — read by setParam handlers + by the card's
    // video-render callback (which needs camera + bentbox values + per-
    // oscillator envelope state). We keep this as a plain Record so the
    // card can read it via the engine's read() hook.
    const live: Record<string, number> = {};
    for (const p of wavesculptDef.params) live[p.id] = param(p.id, p.defaultValue);

    // ---------------- Oscillators ----------------
    const oscNodes: OscillatorNode[] = [];
    const oscEnvGains: GainNode[] = [];
    const oscLGains: GainNode[] = [];
    const oscRGains: GainNode[] = [];

    // Stereo bus.
    const busL = ctx.createGain();
    const busR = ctx.createGain();
    busL.gain.value = 1;
    busR.gain.value = 1;

    for (let i = 0; i < NUM_OSC; i++) {
      const osc = ctx.createOscillator();
      osc.type = morphToOscType(live[`morph${i + 1}`] ?? 0.5);
      const baseHz = voctToHz(live[`pitch${i + 1}`]! / 12);
      osc.frequency.setValueAtTime(baseHz, ctx.currentTime);
      osc.start();

      const envG = ctx.createGain();
      envG.gain.value = 0; // starts silent until gate fires
      osc.connect(envG);

      // Per-osc stereo split. envG → (gL → busL) + (gR → busR).
      const pan = stereoPanForSource(WALL_LAYOUT[i]!.src);
      const gL = ctx.createGain();
      const gR = ctx.createGain();
      gL.gain.value = pan.l;
      gR.gain.value = pan.r;
      envG.connect(gL);
      envG.connect(gR);
      gL.connect(busL);
      gR.connect(busR);

      oscNodes.push(osc);
      oscEnvGains.push(envG);
      oscLGains.push(gL);
      oscRGains.push(gR);
    }

    // ---------------- Pitch CV taps ----------------
    // Each pitch_cvN is a CV input we sample on the envelope tick. We use
    // an AnalyserNode per input. The OscillatorNode .frequency is set
    // discretely from JS (cheap to update every envelope tick).
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
    const pitchTaps = Array.from({ length: NUM_OSC }, () => makeAnalyserTap());
    const gateTaps  = Array.from({ length: NUM_OSC }, () => makeAnalyserTap());

    // ---------------- ADSR scheduler ----------------
    const voices: VoiceState[] = Array.from({ length: NUM_OSC }, newVoiceState);
    let alive = true;
    let lastTick = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const tickerHandle = (typeof setInterval !== 'undefined' ? setInterval : null);

    function readTail(buf: Float32Array<ArrayBuffer>): number {
      return buf[buf.length - 1] ?? 0;
    }

    function tick() {
      if (!alive) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dtMs = now - lastTick;
      lastTick = now;

      // Sample CV taps.
      const gateRead: number[] = new Array(NUM_OSC);
      const pitchRead: number[] = new Array(NUM_OSC);
      for (let i = 0; i < NUM_OSC; i++) {
        gateTaps[i]!.an.getFloatTimeDomainData(gateTaps[i]!.buf);
        pitchTaps[i]!.an.getFloatTimeDomainData(pitchTaps[i]!.buf);
        gateRead[i] = readTail(gateTaps[i]!.buf);
        pitchRead[i] = readTail(pitchTaps[i]!.buf);
      }

      const unison = (live.unison ?? 0) >= 0.5;
      const routing = unisonRouting(unison);

      for (let i = 0; i < NUM_OSC; i++) {
        const sourceIdx = routing[i]!;
        const gateNow = gateRead[sourceIdx]! >= GATE_HIGH;
        const v = voices[i]!;
        // Gate-rise detection.
        if (gateNow && !v.gateHigh) {
          v.gateHigh = true;
          v.phase = 'attack';
          v.phaseT = 0;
        } else if (!gateNow && v.gateHigh) {
          v.gateHigh = false;
          // Capture the env where release begins.
          (v as VoiceState & { _releaseStart?: number })._releaseStart = v.env;
          v.phase = 'release';
          v.phaseT = 0;
        }
        // Step envelope.
        const params = {
          A: live[`A${i + 1}`]!,
          D: live[`D${i + 1}`]!,
          S: live[`S${i + 1}`]!,
          R: live[`R${i + 1}`]!,
        };
        const newState = tickEnvelope(v, dtMs, params);
        Object.assign(v, newState);
        // Apply env to gain node + camera distance attenuation.
        const camera: [number, number, number] = [
          live.pos_x ?? 0,
          live.pos_y ?? 0,
          live.pos_z ?? 0,
        ];
        const distGain = distanceGain(WALL_LAYOUT[i]!.src, WALL_LAYOUT[i]!.vec, camera);
        const gainValue = v.env * distGain;
        oscEnvGains[i]!.gain.setTargetAtTime(gainValue, ctx.currentTime, 0.005);

        // Pitch update — base pitch + unison detune + incoming V/oct.
        const detune = live.detune ?? 0;
        const detuneOct = detuneOctaveOffset(i, detune);
        const basePitchSt = live[`pitch${unison ? 1 : i + 1}`] ?? 0;
        const incomingVoct = pitchRead[unison ? 0 : i] ?? 0;
        const hz = voctToHz(basePitchSt / 12 + (unison ? detuneOct : 0) + incomingVoct);
        try {
          oscNodes[i]!.frequency.setTargetAtTime(hz, ctx.currentTime, 0.005);
        } catch { /* defensive — ignore Web Audio rejects */ }
      }
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;
    if (tickerHandle) {
      intervalId = tickerHandle(tick, ENV_TICK_MS);
    }

    // ---------------- Camera position shadow (for CV) ----------------
    // pos_x/y/z/zoom CV inputs are routed via shadow GainNodes; setParam
    // mirrors them into `live` so the card's draw callback sees the
    // up-to-date value.
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

    // ---------------- Mono-video bridge: a small idle analyser ----------------
    // The bridge needs an analyser per videoSource. We tap busL with a
    // throwaway analyser so the engine has something to look at; the
    // actual drawing is done in drawFrame, which reads `live` + per-voice
    // envelope state. The card-side drawing also happens via the same
    // path (it calls the module's read('renderFrame') hook).
    const videoAnalyser = ctx.createAnalyser();
    videoAnalyser.fftSize = 256;
    busL.connect(videoAnalyser);

    // drawFrame consults the per-node-id registry. The card installs its
    // own drawer on mount and clears it on unmount. Until installed, we
    // clear-to-black so the bridge always has SOMETHING to upload.
    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const fn = FRAME_DRAWERS.get(node.id);
      if (fn) {
        try { fn(canvas); return; } catch { /* fall through to fallback */ }
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
        // Gates + pitch_cvs route into the gate/pitch analyser taps.
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
        // Mirror camera-CV params into the shadow gains so the engine's
        // per-param tap analyser sees the live value.
        if (paramId === 'pos_x') sPosX.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'pos_y') sPosY.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'pos_z') sPosZ.gain.setValueAtTime(value, ctx.currentTime);
        if (paramId === 'zoom')  sZoom.gain.setValueAtTime(value, ctx.currentTime);
        // Morph change → swap oscillator waveform type.
        const morphMatch = /^morph(\d)$/.exec(paramId);
        if (morphMatch) {
          const idx = Number(morphMatch[1]!) - 1;
          if (idx >= 0 && idx < NUM_OSC) {
            try { oscNodes[idx]!.type = morphToOscType(value); } catch { /* */ }
          }
        }
      },
      readParam(paramId) {
        return live[paramId];
      },
      read(key) {
        // Card-side hooks. The card uses these to drive its own canvas
        // (separate from the engine's per-frame bridge) so the on-card
        // display tracks the same state.
        if (key === 'voiceState') {
          return voices.map((v) => ({ env: v.env, phase: v.phase }));
        }
        if (key === 'live') {
          return { ...live };
        }
        if (key === 'wallLayout') return WALL_LAYOUT;
        // The card installs its own frame renderer via this magic key;
        // value is a function taking (canvas) that draws the scene.
        return undefined;
      },
      dispose() {
        alive = false;
        FRAME_DRAWERS.delete(node.id);
        if (intervalId !== null) clearInterval(intervalId);
        for (const o of oscNodes) {
          try { o.stop(); } catch { /* */ }
          o.disconnect();
        }
        for (const g of oscEnvGains) g.disconnect();
        for (const g of oscLGains) g.disconnect();
        for (const g of oscRGains) g.disconnect();
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
        busL.disconnect();
        busR.disconnect();
        videoAnalyser.disconnect();
      },
    };

    return handle;
  },
};
