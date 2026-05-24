// packages/web/src/lib/audio/modules/atlantis-catalyst.ts
//
// ATLANTISCATALYST — slow-drift macro brain.
//
// 8 correlated band-limited random-walk CV outputs (drift1..drift8) plus a
// scene_pulse gate that fires when the brain transitions to a new
// attractor, plus a scene_idx CV for downstream sequencing. Inputs include
// a manual `nudge` gate, a `freeze` latch, and the HYDROGEN-style transport
// CV row (play_cv + scene1..4_cv) for explicit scene jumps.
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

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { createTransportCv, TRANSPORT_CV_PORT_DEFS } from './transport-cv';
import { createRisingEdgeDetector } from './transport-helpers';

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
  type: 'atlantisCatalyst',
  domain: 'audio',
  label: 'CATALYST',
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
    const nudgeBuf = new Float32Array(2048);
    const nudgeDet = createRisingEdgeDetector(0.5);

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
    let lastSceneAt = ctx.currentTime; // seconds
    let nextSceneAt = ctx.currentTime + driftRateKnobToMeanScenePeriodS(live.driftRate);
    let frozen = false;
    let scenePulseUntil = 0;          // ctx.currentTime threshold

    function transitionScene(newScene?: number) {
      const sc = newScene ?? ((scene + 1) % 4);
      scene = sc;
      lastSceneAt = ctx.currentTime;
      // Stagger the next auto-change with jitter ±30%.
      const mean = driftRateKnobToMeanScenePeriodS(live.driftRate);
      const jitter = (prng() - 0.5) * 0.6;
      nextSceneAt = ctx.currentTime + Math.max(MIN_SCENE_S, mean * (1 + jitter));
      // Compute shared "weather" voltage for this scene.
      const shared = prng() * 2 - 1;
      // Ramp every drift output to a fresh target over 2-8 s.
      const rampS = 2 + prng() * 6;
      for (let i = 0; i < NUM_CHANNELS; i++) {
        const target = pickSceneTarget({
          prng, bias: live.bias, sceneDepth: live.sceneDepth,
          coherence: live.coherence, shared, current: current[i]!,
        });
        const now = ctx.currentTime;
        driftSrcs[i]!.offset.cancelScheduledValues(now);
        driftSrcs[i]!.offset.setValueAtTime(current[i]!, now);
        driftSrcs[i]!.offset.linearRampToValueAtTime(target, now + rampS);
        current[i] = target;
      }
      // Scene idx → -1..+1 (4 quantized levels).
      const idx = (scene / 3) * 2 - 1;
      sceneIdxSrc.offset.setValueAtTime(idx, ctx.currentTime);
      // Fire a scene pulse (50 ms gate).
      scenePulseSrc.offset.cancelScheduledValues(ctx.currentTime);
      scenePulseSrc.offset.setValueAtTime(1, ctx.currentTime);
      scenePulseSrc.offset.setValueAtTime(0, ctx.currentTime + SCENE_PULSE_MS / 1000);
      scenePulseUntil = ctx.currentTime + SCENE_PULSE_MS / 1000;
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
          if (!frozen) transitionScene(Math.max(0, Math.min(3, np.uiSceneJump - 1)));
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
      nudgeAna.getFloatTimeDomainData(nudgeBuf);
      if (nudgeDet.scan(nudgeBuf, 0, nudgeBuf.length) > 0 && !frozen) {
        transitionScene();
        return;
      }

      // Scene CV row → explicit scene jumps.
      const ev = transport.drain(TICK_MS / 1000);
      if (!frozen) {
        if (ev.queue1 > 0) { transitionScene(0); return; }
        if (ev.queue2 > 0) { transitionScene(1); return; }
        if (ev.queue3 > 0) { transitionScene(2); return; }
        if (ev.queue4 > 0) { transitionScene(3); return; }
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
