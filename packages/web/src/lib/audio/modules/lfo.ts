// packages/web/src/lib/audio/modules/lfo.ts
//
// Module def for the clockable LFO. DSP is a custom JS AudioWorklet
// (packages/dsp/src/lfo.ts). Four outputs at 0°/90°/180°/270° let one LFO
// drive multiple voices in stereo / quadrature without needing to re-tune.
//
// Phase 1 of the shared-state-sync plan: phase is derived from the rack
// epoch + rate. The factory reads epoch_ms from the active SharedClock
// (window-global) and sends it to the worklet on `init`. A 5 s/200 ms
// resync loop keeps the phase aligned despite hardware-clock drift.
//
// Inputs:
//   clock (gate): external clock; when patched, rate is locked to the measured period.
//   rate (cv, log, paramTarget=rate): scales the LFO rate (log).
//   shape (cv, linear, paramTarget=shape): displaces the waveform-shape crossfade.
//   depth_cv (cv, linear, paramTarget=depth): displaces the output depth.
//
// Outputs:
//   phase0 / phase90 / phase180 / phase270 (cv): four phase-quadrature taps of the same LFO.
//
// Params:
//   rate (log 0.01..100 Hz, default 1): LFO frequency.
//   shape (linear 0..2, default 0): morph across sine ↔ tri ↔ saw.
//   depth (linear 0..1, default 0.5): output amplitude (0..1 scales the ±1 bipolar swing).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef, SyncedModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/lfo.js?url';
import { mulberry32 } from '$lib/sync/prng';
import {
  RESYNC_INTERVAL_MS,
  RESYNC_SMOOTHING_MS,
  type SharedClockHandle,
} from '$lib/audio/shared-clock.svelte';
import { computeLfoState } from './lfo-state';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** A test-friendly hook so the engine / page can publish the active
 *  shared clock without coupling the module def to a Svelte context.
 *  The factory reads from this slot on construction; null = legacy
 *  free-running behavior. */
let activeSharedClock: SharedClockHandle | null = null;

/** Live LFO worklet handles; the active shared clock pings these on
 *  every resync interval (or whenever resetEpoch fires) so previously-
 *  constructed instances pick up a new epoch retroactively. */
type LfoResyncListener = (kind: 'init' | 'resync' | 'reset') => void;
const liveListeners = new Set<LfoResyncListener>();

export function setActiveSharedClock(clock: SharedClockHandle | null): void {
  activeSharedClock = clock;
  // Push a fresh init to every live LFO so they pick up the new clock
  // (or fall back to free-running if clock is null).
  if (clock) {
    for (const fn of liveListeners) fn('init');
  }
}
export function getActiveSharedClock(): SharedClockHandle | null {
  return activeSharedClock;
}
/** Test-only: count how many LFO worklets are currently registered. */
export function _liveLfoCount(): number {
  return liveListeners.size;
}

const baseDef: AudioModuleDef = {
  type: 'lfo',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'lfo',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'clock', type: 'gate' },
    // CV → AudioParam routing with cvScale per
    // .myrobots/plans/cv-range-standard.md.
    // rate: log (0.01..100Hz spans ~13 octaves; cv=±1 = ±~6.5 octaves).
    // shape: linear (0..2 morph axis).
    { id: 'rate',  type: 'cv', paramTarget: 'rate',  cvScale: { mode: 'log' } },
    { id: 'shape', type: 'cv', paramTarget: 'shape', cvScale: { mode: 'linear' } },
    // depth: linear (0..1 amplitude axis). Sums into the depth param the
    // same way rate/shape CV inputs do.
    { id: 'depth_cv', type: 'cv', paramTarget: 'depth', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'phase0',   type: 'cv' },
    { id: 'phase90',  type: 'cv' },
    { id: 'phase180', type: 'cv' },
    { id: 'phase270', type: 'cv' },
  ],
  params: [
    { id: 'rate',  label: 'Rate',  defaultValue: 1,   min: 0.01, max: 100, curve: 'log', units: 'Hz' },
    { id: 'shape', label: 'Shape', defaultValue: 0,   min: 0,    max: 2,   curve: 'linear' },
    // depth: 0 = still (flat), 0.5 = unity (legacy), 1 = 2× (out of range).
    // Default 0.5 so existing patches behave identically.
    { id: 'depth', label: 'Depth', defaultValue: 0.5, min: 0,    max: 1,   curve: 'linear' },
  ],

  docs: {
    explanation: "A low-frequency modulation source: one oscillator emits the same wave at four phase taps (0°/90°/180°/270°) so a single LFO can sweep several voices in stereo or quadrature without re-tuning. Rate sets the cycle speed, Shape continuously morphs the waveform (sine → saw → square), and Depth scales the swing. In a shared/multiplayer rack the phase is anchored to the rack's shared clock so every client sees the same value at the same moment; solo on the public canvas it simply free-runs from phase 0.",
    inputs: {
      clock: "External clock — each rising edge (crossing above 0.5) hard-resets the oscillator to phase 0, locking the LFO to an incoming pulse train (e.g. a shared sequencer's tempo). The reset is intentionally hard with no smoothing, so a click on the edge is expected; Rate still sets the speed between pulses — the clock only re-zeros the phase, it does not measure the period or change the rate.",
      rate: "CV that scales the Rate knob on a logarithmic axis — ±1 multiplies the rate by about 100× / one-hundredth (≈ ±6.6 octaves of speed). Sample-and-held once at the start of each audio block so multiple clients stay phase-aligned despite sub-block CV latency differences.",
      shape: "CV that displaces the Shape control, sliding the waveform morph (sine → saw → square) up or down. Read per-sample (a-rate) so the morph stays smooth.",
      depth_cv: "CV that sums into the Depth control, modulating the output swing amount the same way the Rate/Shape CV inputs offset their params (labeled DEPTH on the panel).",
    },
    outputs: {
      phase0: "The LFO at 0° (the reference phase). Bipolar wave centered on 0; its swing magnitude is set by Depth (0 = flat/still, 0.5 = unity ±1, 1 = ±2).",
      phase90: "The same LFO advanced a quarter cycle (phase + 0.25) — the 90° tap, useful as the offset partner for quadrature/stereo modulation.",
      phase180: "The same LFO advanced half a cycle (phase + 0.5) — the 180° tap; for the sine shape this is a polarity inversion (moves opposite phase0), useful for ping-pong / push-pull modulation.",
      phase270: "The same LFO advanced three-quarters of a cycle (phase + 0.75) — the 270° tap, completing the 0/90/180/270 quadrature set off one shared oscillator.",
    },
    controls: {
      rate: "How fast the LFO cycles, from 0.01 Hz (one sweep per ~100 s) to 100 Hz (audio-rate for FM-style use), on a log fader. Sets the speed shared by all four phase outputs; the clock input overrides phase, not rate.",
      shape: "Continuously morphs the waveform across the 0–2 range: 0 = sine, 1 = saw, 2 = square, with smooth crossfades in between (e.g. value 0.5 = halfway sine↔saw). The fader's glyphs mark sine / saw / square.",
      depth: "Output amplitude / swing, applied as gain = depth × 2 and not clamped: 0 = still (flat at the 0 center, no modulation), 0.5 = unity ±1 (the default, matches legacy patches), 1 = ±2 (deliberately beyond the normal ±1 range). Orthogonal to shape — it only scales the swing, never shifts the center.",
    },
  },
  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'lfo', {
      numberOfInputs: 1,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of baseDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const rateParam = params.get('rate');
    const shapeParam = params.get('shape');
    const depthParam = params.get('depth');

    // Wire up shared-clock anchoring. If no clock is active (e.g., the
    // public single-user `/` canvas), the worklet free-runs from phase=0
    // exactly like the pre-shared-clock behavior — there is no audible
    // regression for solo users.
    let resyncTimer: ReturnType<typeof setInterval> | null = null;
    const initFromClock = (kind: 'init' | 'resync' | 'reset') => {
      const clock = activeSharedClock;
      if (!clock) return;
      const epoch = clock.epoch_ms;
      const sharedNow = clock.sharedTimeNow();
      if (epoch === null || sharedNow === null) return;
      // ctx.currentTime is the audio-thread "now" expressed in seconds;
      // map it to shared-time-seconds via (sharedNow / 1000) being the
      // shared time at the moment we read ctx.currentTime.
      const audioOrigin_s = ctx.currentTime;
      const messageType = kind === 'reset' ? 'init' : kind;
      workletNode.port.postMessage({
        type: messageType,
        epoch_ms: epoch,
        audioOrigin_s,
        smoothing_ms: kind === 'init' || kind === 'reset' ? 0 : RESYNC_SMOOTHING_MS,
      });
    };
    // Register so a later setActiveSharedClock(...) fires init even if
    // the worklet was constructed before the clock arrived (typical
    // ordering: page mount → spawn modules → provider attach → clock
    // attach → first epoch from heartbeat).
    const listener: LfoResyncListener = (kind) => initFromClock(kind);
    liveListeners.add(listener);
    let resetUnsub: (() => void) | null = null;
    if (activeSharedClock) {
      // Try once now; if the clock hasn't converged yet we'll catch up via
      // the resync timer + the listener push.
      initFromClock('init');
      resetUnsub = activeSharedClock.onReset(() => initFromClock('reset'));
    }
    // Periodic resync (drift compensation, plan §6) runs even when no
    // clock is active — it's a no-op in that case.
    resyncTimer = setInterval(() => initFromClock('resync'), RESYNC_INTERVAL_MS);

    const handle: AudioDomainNodeHandle & { read?: (key: string) => unknown } = {
      domain: 'audio',
      inputs: new Map([
        ['clock',    { node: workletNode, input: 0 }],
        ['rate',     { node: workletNode, input: 0, param: rateParam! }],
        ['shape',    { node: workletNode, input: 0, param: shapeParam! }],
        ['depth_cv', { node: workletNode, input: 0, param: depthParam! }],
      ]),
      outputs: new Map([
        ['phase0',   { node: workletNode, output: 0 }],
        ['phase90',  { node: workletNode, output: 1 }],
        ['phase180', { node: workletNode, output: 2 }],
        ['phase270', { node: workletNode, output: 3 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        if (resyncTimer !== null) clearInterval(resyncTimer);
        liveListeners.delete(listener);
        resetUnsub?.();
        workletNode.disconnect();
        try { workletNode.port.close(); } catch { /* port may already be closed */ }
      },
    };
    return handle;
  },
};

/**
 * SyncedModuleDef view of the same module. Adds a pure
 * `computeStateAt(t_ms_since_epoch, params, prng)` so unit tests + future
 * offline simulators can reproduce the worklet's instantaneous phase
 * without instantiating a real AudioWorkletProcessor.
 */
export const lfoDef: SyncedModuleDef = {
  ...baseDef,
  resyncOnReset: true,
  computeStateAt(tMsSinceEpoch, params, _prng) {
    return computeLfoState(tMsSinceEpoch, params);
  },
};

// Sanity: prng helper exposed so consumers can build per-instance PRNGs.
// LFO itself is fully deterministic from (epoch, rate), so prng is unused
// in computeStateAt. Imported so the dependency is explicit and tree-shake
// friendly even if no other module touches sync/prng.
void mulberry32;
