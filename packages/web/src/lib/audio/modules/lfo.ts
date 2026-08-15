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
//   clock (gate): external clock; each rising edge hard-resets phase to 0
//     (it re-zeros phase only — the period is NOT measured and rate is unchanged).
//   rate (cv, log, paramTarget=rate): scales the LFO rate (log).
//   shape (cv, linear, paramTarget=shape): displaces the waveform-shape crossfade.
//   depth_cv (cv, linear, paramTarget=depth): displaces the output depth.
//
// Outputs:
//   phase0 / phase90 / phase180 / phase270 (cv): four phase-quadrature taps of the same LFO.
//
// Params:
//   rate (log 0.01..100 Hz, default 1): LFO frequency.
//   shape (linear 0..2, default 0): morph across sine → saw → square.
//   depth (linear 0..1, default 0.5): output amplitude (0 = still, 0.5 = unity ±1, 1 = ±2).

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
import { createWorkletNode } from '$lib/audio/worklet-guard';
import {
  LFO_DEPTH_GAIN,
  LFO_DEPTH_UNITY,
  LFO_SHAPE_LANDMARKS,
  lfoDepthReadout,
  lfoRateReadout,
} from './lfo-face-model';

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

  inputs: [
    // `edge: 'trigger'` — the DECLARED consumer semantic, and it is a fact of
    // the worklet, not an aspiration: `packages/dsp/src/lfo.ts` resets phase on
    // `lastClockSample < CLOCK_THRESHOLD && c >= CLOCK_THRESHOLD` and does
    // NOTHING on the falling edge or while the level stays high. A held gate is
    // one reset, not a hold. Declaring it makes the rear card paint the ▲
    // trigger glyph and puts the port under module-docs-lint's edge-vocabulary
    // gate (the prose below already speaks rising-edge/clock/reset/sync).
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // CV → AudioParam routing with cvScale per
    // docs/adr/004-cv-range-convention.md.
    // rate: log (0.01..100Hz spans ~13 octaves; cv=±1 = ±~6.5 octaves).
    // shape: linear (0..2 morph axis).
    { id: 'rate',  type: 'cv', paramTarget: 'rate',  cvScale: { mode: 'log' } },
    { id: 'shape', type: 'cv', paramTarget: 'shape', cvScale: { mode: 'linear' } },
    // depth: linear (0..1 amplitude axis). Sums into the depth param the
    // same way rate/shape CV inputs do.
    { id: 'depth_cv', type: 'cv', paramTarget: 'depth', label: 'depth', cvScale: { mode: 'linear' } },
  ],
  // PF-4 `PortDef.label` on the four taps — the ONE authored home for their
  // human names, read by BOTH surfaces (the card's PatchPanel via
  // resolveVerboseLabel, the rear card via rearHoleLabel). Without it the rear
  // derives `PHASE0` from the id, which is a DOWNGRADE from what the legacy
  // card hand-typed; with the card's own override deleted, the two surfaces can
  // no longer disagree. The angle IS the name here — every tap is the same
  // wave, so 'PHASE' on all four is a prefix carrying zero information, and the
  // rail is narrow. 180° is annotated `(anti)` because for sine and square it
  // is a polarity inversion of phase0 (the saw instead restarts its ramp half a
  // cycle early), which is the one tap whose behaviour is not "a bit later".
  outputs: [
    { id: 'phase0',   type: 'cv', label: '0°' },
    { id: 'phase90',  type: 'cv', label: '90°' },
    { id: 'phase180', type: 'cv', label: '180° (anti)' },
    { id: 'phase270', type: 'cv', label: '270°' },
  ],
  params: [
    // `format` (PF-3): 0.01–100 Hz means the dial's bottom two thirds are
    // sub-Hertz, where the raw number is useless and the PERIOD is the whole
    // point — see lfoRateReadout.
    { id: 'rate',  label: 'Rate',  defaultValue: 1,   min: 0.01, max: 100, curve: 'log', units: 'Hz',
      format: lfoRateReadout },
    // `landmarks` (PF-10), NOT `options`: the anchors are named waypoints of a
    // CONTINUOUS morph and every value between them is an audible blend.
    { id: 'shape', label: 'Shape', defaultValue: 0,   min: 0,    max: 2,   curve: 'linear',
      landmarks: LFO_SHAPE_LANDMARKS },
    // depth: 0 = still (flat), UNITY = ±1 (legacy swing), 1 = ±2 (deliberately
    // out of range). The default is the unity point BY ARITHMETIC — it is
    // `1 / LFO_DEPTH_GAIN`, imported from lfo-face-model, so it tracks the DSP's
    // `gain = max(0,depth) * 2` instead of being a literal that happens to
    // agree with it. The readout prints the SWING (`±1.00`), not the position.
    { id: 'depth', label: 'Depth', defaultValue: LFO_DEPTH_UNITY, min: 0, max: 1, curve: 'linear',
      format: lfoDepthReadout },
  ],

  // RACKLINE face curation — a QUADRATURE MODULATION BUS, not "an LFO".
  //
  // `order` is a PRIORITY ranking (what the tiers that show a SUBSET pick);
  // `pages` is FUNCTION order (what the tier that shows EVERYTHING reads like).
  // They answer different questions and here they deliberately DISAGREE — see
  // the pages note below. Only three params exist, so the 6-cell lane budget
  // (faceTierCap 'full') is never the constraint: `order` decides the MINI tile
  // (1 cell) and the COMPACT tile (2 cells + glyph), nothing else.
  //
  // RANK 1 `rate` — the one thing the glyph structurally CANNOT tell you. The
  //   wave-morph glyph draws a single normalized cycle, so it is speed-INVARIANT
  //   by construction: 0.01 Hz and 100 Hz paint the identical picture. Rate is
  //   also the only control a player rides mid-patch, and with `format` it now
  //   really is the headline readout the old face comment claimed (a bare
  //   "0.02" became "50.0 s").
  // RANK 2 `depth` — the modulation's ON/OFF *and* its amount: at 0 the DSP's
  //   `gain = max(0,depth) * 2` is exactly 0, so all four taps sit flat and the
  //   module emits nothing. The glyph reports depth only up to unity — the
  //   display amplitude SATURATES (lfoGlyphAmp, pinned in lfo-face-model.test)
  //   so the whole top half of the knob, unity → ±2, draws identically. A
  //   control the picture stops reporting halfway up needs its own cell.
  // RANK 3 `shape` — DEMOTED ON PURPOSE, because the glyph already draws it and
  //   draws it EXACTLY: ScopeScreen's `triMorphWaveSample` is the worklet's
  //   `morph()` verbatim, live off the transient param stream. That is the
  //   correct use of a glyph — it BUYS A RANK. Compact therefore reads
  //   rate · depth + a live picture of shape: speed, amount, waveform, whole
  //   module, one 192×180 tile.
  //
  // SHAPE_GLYPHS LOSS — ACCEPTED, and this is the argument. The legacy card's
  // Fader carried three static marks (sine / saw / square) on its track. The
  // face replaces them with (a) the live morph glyph, which shows the RESOLVED
  // wave continuously including every in-between blend, and (b) PF-10
  // `landmarks`, which puts the three anchors back on the dial as ticks plus a
  // nearest-name readout. Strictly more information than the marks, at both
  // tiers. Do NOT "fix" this with PF-1 `options`: shape is `linear 0..2` and the
  // crossfade between anchors is a documented feature — a Segmented would
  // delete two thirds of the control.
  //
  // ONE PAGE, and the merge argument is GROUPING, not budget (§1 of the design
  // program: the 720p dock fold is not tight). The old face had a `shape` band
  // holding a single knob and an `engine` band holding the other two, which
  // asserted that shape is not part of the engine. It is: the phase advances at
  // RATE, is mapped through SHAPE, and the result is scaled by DEPTH — one
  // oscillator, three stages, no second block to separate. The page label says
  // the fact a patcher actually needs instead of restating the three knob
  // captions printed directly underneath it: these controls move ALL FOUR taps
  // at once, because there is only one oscillator behind them.
  // ⚠ The page id is 'engine', NOT 'voice'/'sync': `rearFieldPlan` gives a
  // curated 'voice'/'signal' group the LEADING band slot and then walks
  // `face.pages` claiming a curated group per page id, so a page id colliding
  // with the curated rear group's id renders that band TWICE and reddens the
  // rear-derivation totality gate (dx7 hit exactly this).
  // ⚠ Page CONTROL order is the SIGNAL CHAIN (rate → shape → depth), which is
  // NOT `order`'s ranking. Both the dock band and the rear CV band read in
  // signal order; the lane tiles read in priority order. That divergence is the
  // rule, not a drift to reconcile.
  face: {
    order: ['rate', 'depth', 'shape'],
    pages: [
      { id: 'engine', label: 'one oscillator · four phase taps',
        controls: ['rate', 'shape', 'depth'] },
    ],
    glyph: 'waveform',
    // The DEPTH→swing multiplier the glyph draws with, declared on THIS module
    // rather than imported into the shared `glyphBinding` resolver. That
    // resolver fires for any def with `glyph:'waveform'` + a 0..2 `shape` + a
    // `depth`, so a constant living there would silently hand the LFO's ×2 to
    // the next adopter — and a test asserting `depthGain: LFO_DEPTH_GAIN` on
    // both rows would pass either way. It is the same number the DSP applies
    // and the same one `depth`'s default is derived from.
    glyphDepthGain: LFO_DEPTH_GAIN,
    // REAR CARD curation (rear-card-model) — the flip-side jack field.
    //  * The leading band holds `clock`, and derivation would head it 'voice'
    //    (any gate-cable input claims the voice slot). An LFO is a MODULATION
    //    SOURCE, not a voice: the band is labeled 'sync' — the function of the
    //    hole, a rising edge that hard-resets phase to 0, not a note trigger.
    //    Pinning the port also fixes it there if a note-ish input is ever added.
    //    The hole now also carries the ▲ trigger glyph, off the declared
    //    `edge: 'trigger'` on the port.
    //  * The single CV band mirrors the single dock page — same id, same label,
    //    same signal order (RATE → SHAPE → DEPTH) — so the rear reads like the
    //    front. (It said "the two CV bands" while the face had two pages; the
    //    page collapse made that false, so it moves in the same commit.)
    //  * `~` TICKS ON SHAPE + DEPTH, and this CORRECTS the face. The old
    //    comment claimed "every CV here is sample-and-held ONCE per ~128-sample
    //    block … none of these holes is an audio-rate destination". That is
    //    true of RATE ONLY, and deliberately so: `packages/dsp/src/lfo.ts`
    //    hoists `rateHeld = rateArr[0]` out of the sample loop precisely to
    //    keep multiplayer clients phase-aligned. SHAPE and DEPTH are read
    //    PER-SAMPLE inside that loop (`shapeArr[i]`, `depthArr[i]`, both
    //    declared a-rate), and their CV reaches the param through a plain
    //    cvScale curve with no de-zipping — so they are genuine audio-rate
    //    destinations (audio-rate morph / ring-mod-ish amplitude FM is a real
    //    patch here), and the rear was under-reporting them.
    rear: {
      groups: [{ id: 'voice', label: 'sync', ports: ['clock'] }],
      audioRate: ['shape', 'depth_cv'],
    },
  },

  docs: {
    explanation: "A low-frequency modulation source: one oscillator emits the same wave at four quadrature phase taps (0°/90°/180°/270°) so a single LFO can sweep several destinations in stereo or round-robin without re-tuning. The engine is three controls — Rate sets the cycle speed (0.01–100 Hz), Shape continuously morphs the waveform along one axis (sine → saw → square), and Depth scales the bipolar swing (0.5 = unity ±1). A rising edge on the clock input hard-resets phase to 0 — a true pulse-train lock when the LFO is free-running (solo on the public canvas, where it starts from phase 0 and each reset persists). In a shared/multiplayer rack the phase is instead anchored to the rack's shared clock (drift corrections smoothed over ~200 ms) so every client sees the same value at the same moment — and that anchor outranks the clock input between pulses: a clock edge still snaps phase to 0 at that instant, but the anchor then glides it back to the shared-clock-derived phase.",
    inputs: {
      clock: "External clock — each rising edge (crossing above 0.5) hard-resets the oscillator to phase 0. The reset only re-zeros the phase (the period is NOT measured; Rate still sets the speed between pulses), and it is intentionally hard: it snaps at the edge sample and cancels any in-flight shared-clock correction ramp, so a click on the edge is expected. Locking to an incoming pulse train is really a free-running feature: with no shared clock anchored (e.g. solo on the public canvas) each reset persists until the next pulse. In a shared/multiplayer rack the shared-clock anchor takes precedence between pulses — after a reset, its next divergence check schedules a ~200 ms glide back to the shared-clock-derived phase (the check runs once the anchor's periodic resync is active, within ~5 s of the clock attaching) — so there a clock edge is a momentary re-zero, not a lasting re-lock.",
      rate: "CV that scales the Rate knob on a logarithmic axis — ±1 multiplies the rate by about 100× / one-hundredth (≈ ±6.6 octaves of speed). Sample-and-held once at the start of each ~128-sample audio block so multiple clients stay phase-aligned despite sub-block CV latency differences.",
      shape: "CV that displaces the Shape control, sliding the waveform morph (sine → saw → square) up or down around the knob position. Read per-sample (a-rate) so the morph stays smooth.",
      depth_cv: "CV that sums into the Depth control, modulating the swing amount the same way the rate/shape CV inputs offset their params. ±1 sweeps depth across half its 0–1 range around the knob position. Read per-sample (a-rate) like Shape — not block-held like Rate — so an audio-rate signal here amplitude-modulates the taps rather than drifting them.",
    },
    outputs: {
      phase0: "The LFO at 0° (the reference phase). Bipolar wave centered on 0; its swing magnitude is set by Depth (0 = flat/still, 0.5 = unity ±1, 1 = ±2).",
      phase90: "The same LFO advanced a quarter cycle (phase + 0.25) — the 90° tap, useful as the offset partner for quadrature/stereo modulation.",
      phase180: "The same LFO advanced half a cycle (phase + 0.5) — the 180° tap; for the sine and square shapes this is a polarity inversion (moves opposite phase0), useful for ping-pong / push-pull modulation (the saw instead restarts its ramp half a cycle early).",
      phase270: "The same LFO advanced three-quarters of a cycle (phase + 0.75) — the 270° tap, completing the 0/90/180/270 quadrature set off one shared oscillator.",
    },
    controls: {
      rate: "How fast the LFO cycles, from 0.01 Hz (one sweep per ~100 s) to 100 Hz (audio-rate for FM-style use) on a logarithmic dial. It is the faceplate's headline readout, and it SWITCHES UNITS at 1 Hz: at or above 1 Hz it reads as a frequency (1.00 Hz, 12.3 Hz, 100 Hz) and below it as the PERIOD (0.5 Hz reads 2.00 s, the 0.01 Hz floor reads 100 s), because the dial's whole bottom two thirds are sub-Hertz where a raw number says nothing you can act on. 1 Hz is the only rate where the two readings are the same number, which is what makes the switch invisible. Sets the one speed shared by all four phase outputs; the clock input overrides phase, not rate.",
      shape: "Continuously morphs the waveform along the 0–2 axis: 0 = sine, 1 = saw, 2 = square, with smooth linear crossfades between adjacent anchors (e.g. 0.5 = halfway sine↔saw). The three anchors are marked on the dial as ticks and the readout names the NEAREST one, so you always know which region you are in — but the value between them is a real blend, not a snap: the dial does not detent and nothing quantizes. The face's live waveform glyph draws the resolved shape continuously as you move it, using the engine's own morph law rather than a stylized icon.",
      depth: "Output amplitude / swing, applied as gain = depth × 2 and not clamped: 0 = still (flat at the 0 center, no modulation), 0.5 = unity ±1 (the default, matches legacy patches), 1 = ±2 (deliberately beyond the normal ±1 range). The readout prints the SWING rather than the knob's own position — ±1.00 at the default, STILL at zero — because 0.50 reads like 'half' when it is actually unity. Orthogonal to shape: it only scales the swing, never shifts the center. Note the face's waveform glyph tracks it only up to unity, where the drawn cycle fills the screen box and saturates; past that the picture stops changing while the real swing keeps growing.",
    },
  },
  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'lfo', {
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
