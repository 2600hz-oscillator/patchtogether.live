// packages/web/src/lib/audio/modules/atlantis-catalyst.ts
//
// SCENECHANGE (internal type id stays `atlantisCatalyst` for back-compat
// with saved rackspaces) — slow-drift macro brain with persistent scene
// save/recall.
//
// 8 correlated band-limited random-walk CV outputs (drift1..drift8) plus a
// scene_pulse gate that fires when the brain transitions to a new
// attractor, plus a scene_idx CV for downstream sequencing. Inputs include
// a manual `nudge` gate, a `freeze` latch, and the HYDROGEN-style transport
// CV row (play_cv + scene1..4_cv) for explicit scene jumps / slot recall.
//
// "Catalyst-controller" idea per the Atlantis-patch plan: a single
// scheduler-driven orchestrator that nudges the entire ecosystem of a
// large patch into new attractor regions on demand or on a slow timer,
// without the user touching every knob. The 8 drift outputs are
// individually-correlated O-U random walks (coherence knob controls how
// much each channel tracks a shared "weather" voltage).
//
// Pure JS — no worklet — implemented as 8 ConstantSourceNodes whose
// .offset is updated by a setInterval orchestrator at ~25 Hz, with
// linearRampToValueAtTime smoothing on scene transitions. Same shape
// BUGGLES uses (also setInterval-driven). Reuses createTransportCv for
// the scene-CV input row.
//
// Inputs:
//   nudge (gate): rising edge nudges to a new attractor immediately.
//   freeze (gate): held high latches the drift outputs at their current values.
//   seed_cv (cv): per-instance seed CV (latches the random walk's seed).
//   play_cv / scene1_cv..scene4_cv: standard transport CV row (play + scene-slot recalls).
//
// Outputs:
//   drift1..drift8 (cv): 8 correlated band-limited random-walk CV outputs.
//   scene_pulse (gate): one-pulse gate when the brain transitions to a new scene.
//   scene_idx (cv): the current scene index as a CV.
//
// Params:
//   driftRate (log, default DRIFT_DEFAULT): random-walk rate.
//   chaos (linear 0..1): randomness amount.
//   coherence (linear 0..1): how much each channel tracks the shared "weather" voltage.
//   sceneDepth (linear 0..1): scene-transition contrast.
//   autoMode (discrete 0..1): on = auto-transition on a slow timer, off = manual only.
//   bias (linear -1..1): DC offset on all 8 drift outputs.
//   level (linear 0..1): output amplitude.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { createTransportCv, TRANSPORT_CV_PORT_DEFS } from './transport-cv';
import { createEdgeCounter } from '$lib/audio/edge-detect';

const TICK_MS = 25; // drift-rate orchestrator tick (40 Hz)
const SCENE_PULSE_MS = 50;
const NUM_CHANNELS = 8;

/** Min/max seconds between auto scene changes, mapped from the
 *  driftRate knob (knob 0..1, mapped log). */
const MIN_SCENE_S = 4;
const MAX_SCENE_S = 240;

/** Pure helper: knob 0..1 → mean seconds between auto scene changes. */
export function driftRateKnobToMeanScenePeriodS(knob: number): number {
  const k = Math.max(0, Math.min(1, knob));
  // Log mapping over MIN..MAX.
  return MIN_SCENE_S * Math.pow(MAX_SCENE_S / MIN_SCENE_S, 1 - k);
}

/** Pure helper: pick the next random target for one channel.
 *  Used by the orchestrator on a scene transition. */
export function pickSceneTarget(args: {
  prng: () => number;
  bias: number;          // -1..+1
  sceneDepth: number;    // 0..1 — how big a step
  coherence: number;     // 0..1
  shared: number;        // -1..+1 — the "weather" voltage all channels share when coherence=1
  current: number;       // -1..+1 current value
}): number {
  const indep = args.prng() * 2 - 1;
  const mixed = args.coherence * args.shared + (1 - args.coherence) * indep;
  // Bias + scene-depth step around current.
  const target = args.current + args.sceneDepth * (mixed + args.bias - args.current);
  return Math.max(-1, Math.min(1, target));
}

/** Mulberry32 — deterministic seed per node id so cross-rack mates see
 *  the same drift trajectory. */
export function makePrng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface AtlantisCatalystParams {
  driftRate: number;
  chaos: number;
  coherence: number;
  sceneDepth: number;
  autoMode: number;
  bias: number;
  level: number;
}

/** Persistent scene snapshot stored under `node.data.scenes['1'..'4']`.
 *  Captures the user-visible state of the brain so a later recall puts the
 *  patch back into the same "weather" — independently of the PRNG. */
export interface CatalystScene {
  driftRate: number;
  chaos: number;
  coherence: number;
  sceneDepth: number;
  autoMode: number;
  bias: number;
  level: number;
  /** Current value of each of the 8 drift outputs at capture time. */
  drift: number[];
}

export type CatalystSceneSlot = '1' | '2' | '3' | '4';
export type CatalystSceneMap = Partial<Record<CatalystSceneSlot, CatalystScene | null>>;

/** Pure helper: capture current live params + drift values into a Scene. */
export function captureScene(
  live: AtlantisCatalystParams,
  driftValues: readonly number[],
): CatalystScene {
  const drift = new Array<number>(NUM_CHANNELS);
  for (let i = 0; i < NUM_CHANNELS; i++) drift[i] = driftValues[i] ?? 0;
  return {
    driftRate: live.driftRate,
    chaos: live.chaos,
    coherence: live.coherence,
    sceneDepth: live.sceneDepth,
    autoMode: live.autoMode,
    bias: live.bias,
    level: live.level,
    drift,
  };
}

/** Pure helper: validate + coerce arbitrary input into a CatalystScene, or
 *  null if the shape doesn't match. Used to defensively read snapshots that
 *  came in over Yjs from a remote collaborator. */
export function coerceScene(raw: unknown): CatalystScene | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const driftRaw = r.drift;
  if (!Array.isArray(driftRaw)) return null;
  const drift = new Array<number>(NUM_CHANNELS);
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const v = driftRaw[i];
    drift[i] = typeof v === 'number' ? Math.max(-1, Math.min(1, v)) : 0;
  }
  const num = (k: string, fb: number): number => (typeof r[k] === 'number' ? (r[k] as number) : fb);
  return {
    driftRate: num('driftRate', DEFAULTS.driftRate),
    chaos: num('chaos', DEFAULTS.chaos),
    coherence: num('coherence', DEFAULTS.coherence),
    sceneDepth: num('sceneDepth', DEFAULTS.sceneDepth),
    autoMode: num('autoMode', DEFAULTS.autoMode),
    bias: num('bias', DEFAULTS.bias),
    level: num('level', DEFAULTS.level),
    drift,
  };
}

/** Pure helper: apply a snapshot. Returns the mutated `live` object (same
 *  reference, mutated in place) plus the target drift values; caller decides
 *  how to ramp the audio-rate ConstantSources. */
export function applyScene(
  snap: CatalystScene,
  live: AtlantisCatalystParams,
): { live: AtlantisCatalystParams; driftTargets: number[] } {
  live.driftRate = snap.driftRate;
  live.chaos = snap.chaos;
  live.coherence = snap.coherence;
  live.sceneDepth = snap.sceneDepth;
  live.autoMode = snap.autoMode;
  live.bias = snap.bias;
  live.level = snap.level;
  const driftTargets = new Array<number>(NUM_CHANNELS);
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const v = snap.drift[i];
    driftTargets[i] = typeof v === 'number' ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return { live, driftTargets };
}

const DEFAULTS: AtlantisCatalystParams = {
  driftRate: 0.18,
  chaos: 0.5,
  coherence: 0.55,
  sceneDepth: 0.7,
  autoMode: 1,
  bias: 0,
  level: 1,
};

export const atlantisCatalystDef: AudioModuleDef = {
  // Type id stays `atlantisCatalyst` for back-compat with saved rackspaces;
  // only the display label flipped to SCENECHANGE.
  type: 'atlantisCatalyst',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'scenechange',
  category: 'modulation',
  schemaVersion: 1,
  inputs: [
    { id: 'nudge',  type: 'gate' },
    { id: 'freeze', type: 'gate' },
    { id: 'seed_cv', type: 'cv' },
    // HYDROGEN-style transport-CV row (scene jumps from external triggers).
    // Map queue1..queue4 onto scene1..scene4 for caller clarity, but reuse
    // the same port ids the engine knows about.
    ...TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    { id: 'drift1', type: 'cv' },
    { id: 'drift2', type: 'cv' },
    { id: 'drift3', type: 'cv' },
    { id: 'drift4', type: 'cv' },
    { id: 'drift5', type: 'cv' },
    { id: 'drift6', type: 'cv' },
    { id: 'drift7', type: 'cv' },
    { id: 'drift8', type: 'cv' },
    { id: 'scene_pulse', type: 'gate' },
    { id: 'scene_idx',   type: 'cv' },
  ],
  params: [
    { id: 'driftRate',  label: 'Drift',  defaultValue: DEFAULTS.driftRate,  min: 0, max: 1, curve: 'log' },
    { id: 'chaos',      label: 'Chaos',  defaultValue: DEFAULTS.chaos,      min: 0, max: 1, curve: 'linear' },
    { id: 'coherence',  label: 'Coh',    defaultValue: DEFAULTS.coherence,  min: 0, max: 1, curve: 'linear' },
    { id: 'sceneDepth', label: 'Depth',  defaultValue: DEFAULTS.sceneDepth, min: 0, max: 1, curve: 'linear' },
    { id: 'autoMode',   label: 'Auto',   defaultValue: DEFAULTS.autoMode,   min: 0, max: 1, curve: 'discrete' },
    { id: 'bias',       label: 'Bias',   defaultValue: DEFAULTS.bias,       min: -1, max: 1, curve: 'linear' },
    { id: 'level',      label: 'Level',  defaultValue: DEFAULTS.level,      min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A slow-drift 'macro brain' (displayed as SCENECHANGE) that nudges a whole patch into new states without you touching every knob. It emits EIGHT correlated CV outputs (drift1–drift8), each a smooth band-limited random walk; a Coherence control sets how tightly the eight tracks move together versus wandering independently, and a Chaos control sets how much they jitter. On a timer (Drift sets the spacing, from a few seconds to minutes) — or on demand via the NUDGE button/gate — it transitions to a fresh 'scene', ramping all eight outputs smoothly to new targets. A scene_pulse gate fires on each transition and a scene_idx CV reports which scene is current, so downstream sequencers can follow along. You can save up to four scenes and recall them deterministically (the queue CV inputs jump straight to a scene), and FREEZE latches every output where it stands. Patch the drift outputs into filter cutoffs, mix levels, FX depths — anywhere you'd want hands-free, slowly-evolving modulation.",
    inputs: {
      nudge: "A rising edge manually triggers the next scene transition (the same as the card's NUDGE button), cycling the scene index forward. Ignored while frozen.",
      freeze: "While this gate is held high, all eight drift outputs latch at their current values and stop wandering; drop it low (or toggle the card's FREEZE button) to release them.",
      seed_cv: "Per-instance seed CV: latches the random-walk generator's seed so the drift sequence can be made reproducible across sessions.",
      play_cv: "Shared transport play gate (reserved for transport sync); ATLANTIS-CATALYST takes its scene jumps from the queue inputs below.",
      reset_cv: "Shared transport reset gate (reserved for transport sync).",
      queue1_cv: "A rising edge jumps to scene 1 — recalling its saved snapshot if one exists, otherwise making a fresh transition toward scene-index 1.",
      queue2_cv: "A rising edge jumps to scene 2 — recalling its saved snapshot if one exists, else a fresh transition.",
      queue3_cv: "A rising edge jumps to scene 3 — recalling its saved snapshot if one exists, else a fresh transition.",
      queue4_cv: "A rising edge jumps to scene 4 — recalling its saved snapshot if one exists, else a fresh transition.",
    },
    outputs: {
      drift1: "Smooth band-limited random-walk CV (-1..+1), channel 1; ramps toward a new target on each scene change and jitters within it by the Chaos amount. Patch into any modulation destination.",
      drift2: "Random-walk CV channel 2 — correlated with the others by the Coherence amount.",
      drift3: "Random-walk CV channel 3.",
      drift4: "Random-walk CV channel 4.",
      drift5: "Random-walk CV channel 5.",
      drift6: "Random-walk CV channel 6.",
      drift7: "Random-walk CV channel 7.",
      drift8: "Random-walk CV channel 8 — the eighth of the correlated drift bank.",
      scene_pulse: "A short gate pulse that fires on every scene transition (timer, manual nudge, or queued recall) — patch it where you want a downstream event to mark 'a new scene just started'.",
      scene_idx: "CV that reports the current scene as a voltage (-1..+1 across scenes 0..3), so another module can address its own scene/snapshot selector from this one.",
    },
    controls: {
      driftRate: "How long between automatic scene changes, from a few seconds (high) to several minutes (low) — how restlessly the brain explores new states (the card's Drift fader).",
      chaos: "How much micro-jitter the eight outputs add even while holding a scene (0..1): 0 is glassy-smooth, higher values keep the voltages subtly alive.",
      coherence: "How tightly the eight channels move together (0..1): 0 makes them fully independent random walks, 1 locks them onto one shared 'weather' voltage, and 0.55 (default) is a balanced blend.",
      sceneDepth: "How far each scene transition moves the outputs (0..1) — small for gentle shifts, large for dramatic jumps between scenes.",
      autoMode: "Whether scenes change on their own: on (default) transitions automatically on the Drift timer; off means scenes only change when you nudge or send a queue CV.",
      bias: "A DC offset added to all eight drift outputs (-1..+1), tilting the whole bank's average higher or lower.",
      level: "Overall output amplitude of the eight drift CVs (0..1), ramped smoothly when changed to avoid clicks.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Per-instance deterministic PRNG seed from node id.
    let seed = 0;
    for (let i = 0; i < node.id.length; i++) {
      seed = ((seed << 5) - seed + node.id.charCodeAt(i)) | 0;
    }
    const prng = makePrng(seed);

    // ---------------- CV outputs ----------------
    const driftSrcs: ConstantSourceNode[] = [];
    const driftGains: GainNode[] = [];
    const current: number[] = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      src.start();
      const gain = ctx.createGain();
      gain.gain.value = DEFAULTS.level;
      src.connect(gain);
      driftSrcs.push(src);
      driftGains.push(gain);
      current.push(0);
    }

    const sceneIdxSrc = ctx.createConstantSource();
    sceneIdxSrc.offset.value = 0;
    sceneIdxSrc.start();
    const scenePulseSrc = ctx.createConstantSource();
    scenePulseSrc.offset.value = 0;
    scenePulseSrc.start();

    // ---------------- Gate / CV inputs ----------------
    const nudgeGain = ctx.createGain();
    const nudgeAna = ctx.createAnalyser();
    nudgeAna.fftSize = 2048;
    nudgeAna.smoothingTimeConstant = 0;
    nudgeGain.connect(nudgeAna);
    const nudgeSilence = ctx.createConstantSource();
    nudgeSilence.offset.value = 0;
    nudgeSilence.start();
    nudgeSilence.connect(nudgeGain);
    // Windowed rising-edge counter (shared seam): a single nudge transitions
    // the scene exactly once — the old scan(buf, 0, len) re-scanned the whole
    // buffer each tick and could double-transition.
    const nudgeCounter = createEdgeCounter({ ctx, analyser: nudgeAna });

    const freezeGain = ctx.createGain();
    const freezeAna = ctx.createAnalyser();
    freezeAna.fftSize = 2048;
    freezeAna.smoothingTimeConstant = 0;
    freezeGain.connect(freezeAna);
    const freezeSilence = ctx.createConstantSource();
    freezeSilence.offset.value = 0;
    freezeSilence.start();
    freezeSilence.connect(freezeGain);
    const freezeBuf = new Float32Array(2048);

    const seedGain = ctx.createGain();
    seedGain.gain.value = 1;
    const seedSilence = ctx.createConstantSource();
    seedSilence.offset.value = 0;
    seedSilence.start();
    seedSilence.connect(seedGain);

    const transport = createTransportCv(ctx);

    // ---------------- Live params ----------------
    const live: AtlantisCatalystParams = {
      ...DEFAULTS,
      ...(node.params as Partial<AtlantisCatalystParams>),
    };
    // Apply initial level to the gain stages.
    for (const g of driftGains) g.gain.setValueAtTime(live.level, ctx.currentTime);

    // Scheduler state.
    let scene = 0;                    // current scene index 0..3
    let nextSceneAt = ctx.currentTime + driftRateKnobToMeanScenePeriodS(live.driftRate);
    let frozen = false;
    let scenePulseUntil = 0;          // ctx.currentTime threshold

    // Ramp every drift ConstantSource to `targets[i]` over `rampS` seconds,
    // mutating `current[]` to mirror the new state. Shared core of both
    // transitionScene (stochastic) and recallScene (deterministic).
    function rampDriftTo(targets: readonly number[], rampS: number) {
      const now = ctx.currentTime;
      for (let i = 0; i < NUM_CHANNELS; i++) {
        const tgt = Math.max(-1, Math.min(1, targets[i] ?? 0));
        driftSrcs[i]!.offset.cancelScheduledValues(now);
        driftSrcs[i]!.offset.setValueAtTime(current[i]!, now);
        driftSrcs[i]!.offset.linearRampToValueAtTime(tgt, now + rampS);
        current[i] = tgt;
      }
    }

    // Fire scene_pulse + scene_idx for a transition into scene index `sc`.
    function emitSceneSignals(sc: number) {
      scene = sc;
      const idx = (scene / 3) * 2 - 1;
      sceneIdxSrc.offset.setValueAtTime(idx, ctx.currentTime);
      scenePulseSrc.offset.cancelScheduledValues(ctx.currentTime);
      scenePulseSrc.offset.setValueAtTime(1, ctx.currentTime);
      scenePulseSrc.offset.setValueAtTime(0, ctx.currentTime + SCENE_PULSE_MS / 1000);
      scenePulseUntil = ctx.currentTime + SCENE_PULSE_MS / 1000;
    }

    function transitionScene(newScene?: number) {
      const sc = newScene ?? ((scene + 1) % 4);
      // Stagger the next auto-change with jitter ±30%.
      const mean = driftRateKnobToMeanScenePeriodS(live.driftRate);
      const jitter = (prng() - 0.5) * 0.6;
      nextSceneAt = ctx.currentTime + Math.max(MIN_SCENE_S, mean * (1 + jitter));
      // Compute shared "weather" voltage for this scene + roll fresh targets.
      const shared = prng() * 2 - 1;
      const targets: number[] = [];
      for (let i = 0; i < NUM_CHANNELS; i++) {
        targets.push(pickSceneTarget({
          prng, bias: live.bias, sceneDepth: live.sceneDepth,
          coherence: live.coherence, shared, current: current[i]!,
        }));
      }
      rampDriftTo(targets, 2 + prng() * 6);
      emitSceneSignals(sc);
    }

    /** Deterministic recall — apply a saved Scene snapshot to live params
     *  and ramp the 8 drift outputs to the saved values over ~2s. Does NOT
     *  consult the PRNG, so the same snapshot always produces the same
     *  brain state. */
    function recallScene(sc: number, snap: CatalystScene) {
      const { driftTargets } = applyScene(snap, live);
      // Update audio-rate gain to match the recalled level.
      for (const g of driftGains) g.gain.setTargetAtTime(live.level, ctx.currentTime, 0.05);
      // Mirror live.* back to patch.params so the UI faders snap to the
      // recalled values (and remote rack-mates see the change).
      const t = livePatch.nodes[node.id];
      if (t) {
        const p = t.params as Record<string, number>;
        p.driftRate = live.driftRate;
        p.chaos = live.chaos;
        p.coherence = live.coherence;
        p.sceneDepth = live.sceneDepth;
        p.autoMode = live.autoMode;
        p.bias = live.bias;
        p.level = live.level;
      }
      rampDriftTo(driftTargets, 2);
      // Re-arm the auto-mode timer with the (possibly recalled) drift rate.
      const mean = driftRateKnobToMeanScenePeriodS(live.driftRate);
      nextSceneAt = ctx.currentTime + mean;
      emitSceneSignals(sc);
    }

    /** Read `node.data.scenes[slot]` (1..4) and return a coerced Scene, or
     *  null if the slot is empty / malformed. */
    function readSavedScene(slot: number): CatalystScene | null {
      const t = livePatch.nodes[node.id];
      if (!t) return null;
      const scenes = (t.data as { scenes?: Record<string, unknown> } | undefined)?.scenes;
      if (!scenes) return null;
      const key = String(slot) as CatalystSceneSlot;
      return coerceScene(scenes[key]);
    }

    /** Recall slot N if saved; otherwise fall back to a stochastic
     *  transition into scene index N (back-compat with the old behavior
     *  the Atlantis example patch expects). */
    function jumpToScene(slotOneIndexed: number) {
      const sc = Math.max(0, Math.min(3, slotOneIndexed - 1));
      const snap = readSavedScene(slotOneIndexed);
      if (snap) recallScene(sc, snap);
      else transitionScene(sc);
    }

    let lastUiSceneJump = 0;
    function drainInputAndStep() {
      // Pull live params from the patch each tick so knob moves take effect.
      const np = livePatch.nodes[node.id]?.params as (AtlantisCatalystParams & {
        uiSceneJump?: number; uiFreeze?: number;
      }) | undefined;
      if (np) {
        if (typeof np.driftRate  === 'number') live.driftRate  = np.driftRate;
        if (typeof np.chaos      === 'number') live.chaos      = np.chaos;
        if (typeof np.coherence  === 'number') live.coherence  = np.coherence;
        if (typeof np.sceneDepth === 'number') live.sceneDepth = np.sceneDepth;
        if (typeof np.autoMode   === 'number') live.autoMode   = np.autoMode;
        if (typeof np.bias       === 'number') live.bias       = np.bias;
        if (typeof np.level      === 'number') live.level      = np.level;
        // UI-driven scene jumps land via these markers (1..4 = jump to that
        // scene; 0 = idle). Set by AtlantisCatalystCard's buttons; cleared
        // here once observed so a re-click re-fires.
        if (typeof np.uiSceneJump === 'number' && np.uiSceneJump !== 0 && np.uiSceneJump !== lastUiSceneJump) {
          lastUiSceneJump = np.uiSceneJump;
          if (!frozen) jumpToScene(np.uiSceneJump);
          // Clear the marker so a future identical value still fires.
          if (livePatch.nodes[node.id]) {
            (livePatch.nodes[node.id]!.params as Record<string, number>).uiSceneJump = 0;
          }
          lastUiSceneJump = 0;
          return;
        }
        if (typeof np.uiFreeze === 'number') {
          // uiFreeze acts as a UI-side latch — mirror it to the frozen flag
          // (the freeze gate input still works as before).
          frozen = np.uiFreeze >= 0.5;
        }
      }
      // Level → drift gain (audio-rate ramp to avoid clicks).
      for (const g of driftGains) g.gain.setTargetAtTime(live.level, ctx.currentTime, 0.05);

      // Freeze: read last sample of the buf.
      freezeAna.getFloatTimeDomainData(freezeBuf);
      frozen = freezeBuf[freezeBuf.length - 1]! > 0.5;

      // Nudge → manual transition.
      if (nudgeCounter.poll(ctx.currentTime) > 0 && !frozen) {
        transitionScene();
        return;
      }

      // Scene CV row → recall slot N if saved; otherwise stochastic
      // transition into scene N (back-compat with the Atlantis demo, which
      // expects gates here to fire scene-changes).
      const ev = transport.drain(TICK_MS / 1000);
      if (!frozen) {
        if (ev.queue1 > 0) { jumpToScene(1); return; }
        if (ev.queue2 > 0) { jumpToScene(2); return; }
        if (ev.queue3 > 0) { jumpToScene(3); return; }
        if (ev.queue4 > 0) { jumpToScene(4); return; }
      }

      // Auto-mode timer.
      if (!frozen && live.autoMode >= 0.5 && ctx.currentTime >= nextSceneAt) {
        transitionScene();
        return;
      }

      // Between scenes: superimpose small chaos jitter on each output
      // (proportional to `chaos`). The setTargetAtTime time-constant
      // smooths the steps into a soft random walk visible at audio rate.
      if (!frozen && live.chaos > 0.001) {
        const now = ctx.currentTime;
        for (let i = 0; i < NUM_CHANNELS; i++) {
          const jitter = (prng() - 0.5) * 0.15 * live.chaos;
          const target = Math.max(-1, Math.min(1, current[i]! + jitter));
          // Tiny time-constant so the random nudge is audible at ~25 Hz.
          driftSrcs[i]!.offset.setTargetAtTime(target, now, 0.3);
          current[i] = target;
        }
      }
    }

    const timer = setInterval(drainInputAndStep, TICK_MS);

    // ---------------- Handle ----------------
    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['nudge',   { node: nudgeGain,   input: 0 }],
        ['freeze',  { node: freezeGain,  input: 0 }],
        ['seed_cv', { node: seedGain,    input: 0 }],
        ...Array.from(transport.inputs.entries()).map(([id, v]) =>
          [id, v] as [string, { node: AudioNode; input: number }],
        ),
      ]),
      outputs: new Map([
        ['drift1', { node: driftGains[0]!, output: 0 }],
        ['drift2', { node: driftGains[1]!, output: 0 }],
        ['drift3', { node: driftGains[2]!, output: 0 }],
        ['drift4', { node: driftGains[3]!, output: 0 }],
        ['drift5', { node: driftGains[4]!, output: 0 }],
        ['drift6', { node: driftGains[5]!, output: 0 }],
        ['drift7', { node: driftGains[6]!, output: 0 }],
        ['drift8', { node: driftGains[7]!, output: 0 }],
        ['scene_pulse', { node: scenePulseSrc, output: 0 }],
        ['scene_idx',   { node: sceneIdxSrc,   output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'level') {
          for (const g of driftGains) g.gain.setTargetAtTime(value, ctx.currentTime, 0.05);
        }
        if (paramId in live) (live as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (live as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'scene') return scene;
        if (key === 'pulsing') return ctx.currentTime < scenePulseUntil;
        if (key === 'frozen') return frozen;
        if (key === 'secsToNextScene') return Math.max(0, nextSceneAt - ctx.currentTime);
        if (key === 'driftValues') return current.slice();
        return undefined;
      },
      dispose() {
        clearInterval(timer);
        try { for (const s of driftSrcs) s.stop(); } catch { /* already stopped */ }
        try { sceneIdxSrc.stop(); scenePulseSrc.stop(); } catch { /* already stopped */ }
        try { nudgeSilence.stop(); freezeSilence.stop(); seedSilence.stop(); } catch { /* already stopped */ }
        for (const s of driftSrcs) s.disconnect();
        for (const g of driftGains) g.disconnect();
        sceneIdxSrc.disconnect(); scenePulseSrc.disconnect();
        nudgeGain.disconnect(); nudgeAna.disconnect(); nudgeSilence.disconnect();
        freezeGain.disconnect(); freezeAna.disconnect(); freezeSilence.disconnect();
        seedGain.disconnect(); seedSilence.disconnect();
        transport.dispose();
      },
    };
  },
};
