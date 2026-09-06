// packages/web/src/lib/audio/modules/audio-out.ts
//
// Audio Out — terminal stereo output. Two MONO inputs (L, R), each routed to
// the corresponding channel of a stereo bus. Eurorack convention: every patch
// cable is mono; if you want stereo, you patch both L and R.
//
// Audio-fidelity stage (PR feat/audio-fidelity-mixmstrs-comp-swolevco):
//
//   Two safety nets sit between user signal and AudioContext.destination:
//
//     1. DC blocker — a 5Hz BiquadFilter highpass on each channel. Catches
//        DC offset that any module elsewhere in the patch may have allowed
//        to leak through (e.g., LFO patched into an audio chain via VCA;
//        long-running feedback loops biasing slowly). Inaudible at 5Hz —
//        well below the lowest pitched note we care about (~20Hz) — but
//        eliminates the slow drift that, over hours, can clip the
//        downstream limiter or speaker excursion.
//
//     2. Master limiter — a look-ahead brickwall limiter worklet at a
//        -1 dBFS ceiling (packages/dsp/src/lib/master-limiter-dsp.ts).
//        Below the ceiling it is the IDENTITY, so a normally-leveled mix
//        passes untouched; above it, it applies the minimum reduction that
//        reaches the ceiling and the output is genuinely bounded.
//
//   Both stages are ALWAYS on for the terminal output. They are designed
//   to be inaudible on properly-leveled mixes; the design intent is "no
//   speaker damage from a runaway patch", not "make everything sound
//   compressed."
//
// P0-A1 (DSP audit, .myrobots/plans/dsp-stack-bass-freq-audit-2026-07-01.md).
// Stage 2 used to be a plain `DynamicsCompressorNode` at threshold -6 dB,
// ratio 4, knee 6, attack 3 ms, release 50 ms. Measured on that node (see
// art/scenarios/audio-out/master-limiter-sub-pump.test.ts for the harness):
//
//   input peak   sub-band gain ripple   output peak
//     -5.4 dBFS         0.003 dB           0.619
//     -2.9 dBFS         0.259 dB           0.805
//     +0.6 dBFS         1.606 dB           1.065   ← clips
//     +3.1 dBFS         3.044 dB           1.240   ← clips
//     +9.1 dBFS         5.032 dB           1.602   ← clips
//
// i.e. exactly where the safety net was supposed to act, it BOTH pumped the
// sub by several dB per strike AND still let the mix clip the device — a 4:1
// compressor is not a limiter. It also added a constant +1.35 dB of automatic
// makeup gain to every patch, which the brickwall does not.
//
// Inputs:
//   L (audio): left-channel signal to the speakers.
//   R (audio): right-channel signal to the speakers.
//
// Outputs: none (terminal sink).
//
// Params:
//   master (linear 0..1, default 0.7): master output gain pre-limiter.
//
// Read keys (not ports — no contract surface):
//   outputSnapshot            terminal samples, MONO DOWNMIX. Cannot tell
//                             only-L from only-R (both read half level), and
//                             reads ~0 for an anti-phase pair.
//   outputSnapshotL / …R      the same terminal point, PER CHANNEL. Use these
//                             for any assertion about WHICH side is audible.
//                             Negative-controlled both directions on every run
//                             by art/scenarios/audio-out/per-channel-taps.test.ts.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { watchLiveNodeData } from '$lib/audio/live-node-data';
// The ceiling is imported from the limiter core, NOT re-typed here: the worklet
// and this file's degraded fallback must agree by construction. (Relative,
// because `@patchtogether.live/dsp`'s exports map has no type resolution for
// bare `src/**` specifiers; the `?url` dist import below goes through the
// package name as usual.)
import { MASTER_CEILING_DB } from '../../../../../dsp/src/lib/master-limiter-dsp';
import { clearSinkReport, reportSink } from '$lib/audio/output-sink-report';
// The degraded tail + the runtime latch recovery live in a DIST-FREE module so
// they are covered by a pure unit test (audio-out-failover.test.ts) — this file
// cannot be imported outside Vite because of the `?url` worklet import below.
import {
  buildCeilingClipper,
  failoverTerminalTailToClip,
} from '$lib/audio/audio-out-failover';
import workletUrl from '@patchtogether.live/dsp/dist/master-limiter.js?url';
import { createWorkletNode, onWorkletNodeError } from '$lib/audio/worklet-guard';

const LIMITER_PROCESSOR = 'master-limiter';
const limiterLoaded = new WeakSet<BaseAudioContext>();

/** The saved output-device pick on a node: `data.outputDeviceId`, or `''`
 *  (the browser default sink) when the patch never chose one. Read by the
 *  factory at boot AND by the live-data watcher after a same-session load at
 *  a reused id (`$lib/audio/live-node-data`) — the reconciler never
 *  re-materializes such a node, so the boot-time apply alone left the loaded
 *  patch's sink unapplied and the audio on whichever device the PREVIOUS
 *  patch chose. */
export function audioOutSinkPickOf(node: ModuleNode): string {
  const saved = (node.data ?? {})['outputDeviceId'];
  return typeof saved === 'string' ? saved : '';
}

export const audioOutDef: AudioModuleDef = {
  type: 'audioOut',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'audio out',
  category: 'output',

  inputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  outputs: [],

  params: [
    {
      id: 'master',
      label: 'Master',
      defaultValue: 0.7,
      min: 0,
      max: 1,
      curve: 'linear',
      units: 'gain',
    },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // The rack's TERMINAL, promoted. One param, one bespoke body, and a lane
  // picture that is mechanically refused.
  face: {
    // ONE RANK, AND NOTHING TO ARGUE. `master` is the only param this module
    // has ever had.
    order: ['master'],

    // A MASTER LEVEL IS A THROW, NOT A DIAL — and UNDECLARED it silently
    // becomes a dial, because `'fader'` and `'hue'` are the two primitives the
    // shell cannot infer (`0..1 linear` is the same shape as any other
    // continuous scalar). The card has always mounted a `NeonFader` here;
    // `mixmstrs` and `noise` are the precedent, and `noise` carries this exact
    // declaration for exactly this reason.
    paramCells: { master: 'fader' },

    // ⚠ NO LANE PICTURE, AND THE REFUSAL IS MECHANICAL RATHER THAN A TASTE
    // CALL. `primaryAudioOutPortId` finds the first `audio` OUTPUT port, and
    // this module declares `outputs: []` — it is a terminal sink. So the id is
    // null, every live-glyph literal falls to `{kind:'static'}`, and the
    // unconditional dead-glyph clause catches it. Declaring `'none'` states the
    // outcome instead of shipping a binding that resolves to a dashed label.
    //
    // ⚠ AND THIS IS THE MODULE WHERE A PICTURE IS MOST WANTED AND LEAST
    // REACHABLE. The terminal L/R level is the single most useful thing a
    // rack-wide glance could carry — it is measured at `tail`, so it sees the
    // master gain AND the limiter's action, unlike a passthrough glyph. But the
    // PINNED instance is canvas-hidden and has NO LANE TILE, so a glyph would
    // paint only on user-ADDED instances: the minority case, and the one that
    // matters least, since a user who deliberately added a second output is
    // already looking at it. The picture goes in the body instead, where the
    // pinned instance can actually see it.
    glyph: 'none',

    // ── THE BODY ───────────────────────────────────────────────────────────
    //
    // `$lib/ui/modules/audioOut/shell-extension.ts` → `fullViewBody`. It carries
    // the two things a `ParamDef` cannot express, and the reason they belong
    // together is that they are the two halves of "where is my sound going":
    //
    //   1. THE TERMINAL STEREO METER — the thing this module has never had.
    //      Three analyser taps already hang off `tail` (the exact node feeding
    //      `ctx.destination`) and are read by NOTHING in the UI: they exist for
    //      e2e audibility assertions. So the rack's terminal currently cannot
    //      tell you whether it is clipping. The owner's list of genuine
    //      width-earners names "a live picture" first; this is that picture, it
    //      is what the module is about, and it costs no new engine work.
    //
    //   2. THE OUTPUT DEVICE PICKER — an `enumerateDevices()` roster plus the
    //      `setSinkId` support/error states, which are neither params nor node
    //      data with a roster the def could declare.
    //
    // ⚠ (2) IS WHY THIS MODULE'S migration disposition WAS `bespoke-surface`,
    // and the body is exactly the answer that entry was asking for. It is also
    // not a new idea: `cameraInput` had the SAME problem — a `<select>`
    // populated from `enumerateDevices()` and persisted to a `node.data` key —
    // and `legacy-fallback.ts` records the resolution by name: the picker
    // "moved into the faceplate's EXTENSION BODY, which is the one slot that
    // can hold a control no `ParamDef` can express."
    //
    // ⚠ AND IT IS DELIBERATELY NOT A `selector` SHELL CELL, which is the route
    // that looks obvious and is worse here. `SHELL_CELLS` is keyed by
    // `face.order` key, so a selector needs a declared non-param CONTROL — i.e.
    // a `controlFamilies` entry on this def (the `milkdrop-preset-select` shape)
    // — which puts an OS-device dropdown on the COMPACT LANE TILE of every
    // added instance. That is wide on the one face that should be narrowest,
    // and its options are the runner's own hardware names, which is a baseline
    // full of machine-specific text. The body keeps the picker one click away
    // (dock full view / the 🎧 tray, which IS the pinned instance's surface) and
    // the tile a single throw.
    //
    // ⚠ 2D, NOT WEBGL, AND THAT IS A COST DECISION. The attest basis rule is
    // derived from CONTENT, so a body written against a WebGL context would
    // enrol this module automatically and make every later edit cost a real-GPU
    // re-attest window. There is no reason to use WebGL for two bars.
    extension: 'audioOut',

    // ⚠ THE HERO IS THE FADER, AND THE FIRST DRAFT OF THIS FACE OMITTED IT.
    // The reasoning was that "a hero MOVES a key out of its band, and with one
    // param there is nothing to promote it above" — which is true about RANK
    // and wrong about LAYOUT. MEASURED: with no hero the single ranked key
    // stays in the page-less `__all` band, so the dock renders ONE labelled
    // section band containing one fader, under a body. `noise` — also one
    // param, also a fader — declares a hero for exactly this reason:
    // `heroFacePlan` DROPS the emptied band ("a labelled void where they
    // were"), leaving the plate as body + control with no section furniture
    // naming a band of one.
    //
    // `hero.control`, NOT `hero.cell`: a `hero.cell` suppresses the shell glyph
    // at the dock, and there is no glyph here to suppress (`glyph: 'none'`).
    // The extension body takes the hero PICTURE's place; the hero CONTROL sits
    // beside it, and every param cell stays intact.
    hero: { control: 'master' },

    // NO `pages`, NO `tabbed`.
    //   * two bands would need two things to put in them; the picker is in the
    //     body, so there is nothing left to name.
    //   * `DOCK_TAB_MIN_BANDS` is 7. A tab rail could not engage here even if
    //     someone asked for one, and the opt-in is owner-instruction-only.
    //
    // COMPACT BY DEFAULT: `FACE_WIDTH_EXEMPTIONS` is untouched and this face
    // must never become an entry. One fader plus a meter is the narrowest face
    // in its wave and should stay that way.
  },

  docs: {
    explanation:
      "The terminal stereo output — where the patch reaches your speakers. It takes two mono inputs (L and R), each routed to one side of the stereo bus, following the Eurorack convention that every cable is mono and you patch both sides for stereo. Mental model: the last module in the chain; whatever you wire into L and R is what you hear. Two always-on safety stages sit between your signal and the hardware: a 5 Hz DC-blocking high-pass (inaudible, but it stops slow DC drift from a feedback loop or a misrouted LFO from stressing your speakers) and a master brickwall limiter with a -1 dBFS ceiling. The limiter looks ahead 2 ms, so anything that stays under the ceiling passes through at exactly unity — it does not compress, colour or pump your low end — and anything above it is turned down by just enough to reach the ceiling, which is what stops a runaway patch clipping the device. The card also lets you choose the output device on browsers that support it. There are no outputs — this is a sink.",
    inputs: {
      L: "Left-channel audio to the speakers. Patch a mono source here for the left side; for a stereo source wire both L and R.",
      R: "Right-channel audio to the speakers. Leave it unpatched for a mono signal in L, or wire the right side of a stereo source here.",
    },
    outputs: {},
    controls: {
      master:
        "Master output level applied to both channels before the limiter, 0 (silence) to 1 (unity), default 0.7. It sets your overall loudness; the limiter downstream is a brickwall ceiling that does nothing at all until you exceed -1 dBFS, so use this for the actual mix level rather than driving into the limiter for loudness.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const gainL = ctx.createGain();
    const gainR = ctx.createGain();
    const initialMaster = (node.params ?? {}).master ?? 0.7;
    gainL.gain.value = initialMaster;
    gainR.gain.value = initialMaster;

    // ---------------- Stage 1: DC blocker (per channel) ----------------
    //
    // A 1st-order (Q=0.707) highpass at 5Hz. The cutoff is far below the
    // lowest audible pitch (~20Hz), so the audible frequency content is
    // attenuated by less than 0.1 dB. But DC and sub-audio drift are
    // attenuated by ~12 dB/octave below 5Hz — enough to keep the limiter
    // and speaker safe.
    const dcL = ctx.createBiquadFilter();
    dcL.type = 'highpass';
    dcL.frequency.value = 5;
    dcL.Q.value = 0.707;
    const dcR = ctx.createBiquadFilter();
    dcR.type = 'highpass';
    dcR.frequency.value = 5;
    dcR.Q.value = 0.707;
    gainL.connect(dcL);
    gainR.connect(dcR);

    // ---------------- Stage 2: master limiter (stereo) ----------------
    //
    // Collapse the two DC-blocked channels into one stereo bus, then hand it
    // to the look-ahead brickwall limiter worklet. It is stereo-LINKED (one
    // gain across L/R) so the image never wanders on a peak; the core carries
    // the design notes and the no-overshoot proof.
    const merger = ctx.createChannelMerger(2);
    dcL.connect(merger, 0, 0);
    dcR.connect(merger, 0, 1);

    // `tail` is whatever node ends up feeding ctx.destination — the limiter
    // normally, the degraded clipper if the worklet cannot load.
    let tail: AudioNode;
    // Non-null iff the worklet actually built — the node whose runtime latch we
    // have to survive. See `failoverTerminalTailToClip` above.
    let limiter: AudioWorkletNode | null = null;
    try {
      if (!limiterLoaded.has(ctx)) {
        await ctx.audioWorklet.addModule(workletUrl);
        limiterLoaded.add(ctx);
      }
      // 'discrete' + explicit 2: L and R are two INDEPENDENT mono jacks, not a
      // stereo pair to be up/down-mixed. An unpatched R stays silent.
      limiter = createWorkletNode(node, ctx, LIMITER_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
      tail = limiter;
    } catch (err) {
      // audioOut is the TERMINAL sink: a rejected factory here means the whole
      // patch is silent, which is a worse failure than a degraded ceiling. So
      // fall back to a synchronous, pure-graph hard clip at the same ceiling —
      // memoryless, hence still incapable of ducking the sub — and say so.
      //
      // ⚠ THIS CATCH IS LOAD-TIME ONLY. A throw inside the limiter's process()
      // happens on the render thread AFTER construction and cannot reach here.
      // That path is handled by the processorerror wiring further down.
      console.warn(
        `[audio-out] master limiter worklet unavailable; falling back to a ${MASTER_CEILING_DB} dBFS hard clip`,
        err,
      );
      tail = buildCeilingClipper(ctx);
    }
    merger.connect(tail);
    tail.connect(ctx.destination);

    // Terminal-output tap. An AnalyserNode hung off the SAME node that feeds
    // ctx.destination, so a read of its buffer proves signal actually
    // reached the audible terminal stage — not merely some upstream analyser
    // (e.g. a SCOPE's ch1 sink, which buffers samples whether or not anything
    // downstream reaches the speakers). E2E audibility assertions read this via
    // read('outputSnapshot'); it is a passive sink (never connected onward) so
    // it costs nothing audible and can't alter the signal path.
    const outTap = ctx.createAnalyser();
    outTap.fftSize = 2048;
    outTap.smoothingTimeConstant = 0;
    tail.connect(outTap);
    const outBuf = new Float32Array(outTap.fftSize);

    // ---------------- Per-channel terminal taps (L / R) ----------------
    //
    // `outTap` above is STRUCTURALLY BLIND TO STEREO. An AnalyserNode
    // analyses a MONO DOWNMIX per spec (Web Audio §AnalyserNode: the input is
    // down-mixed to mono using its channelCount/channelInterpretation, which
    // default to max/speakers), so on the stereo terminal bus:
    //
    //   - only-L and only-R are INDISTINGUISHABLE — both read exactly half
    //     level. Measured under node-web-audio-api with a 0.5-amplitude sine
    //     into L only: mono tap RMS 0.1745, left tap RMS 0.3491, right 0.
    //   - an ANTI-PHASE stereo pair reads ~0 — "perfectly silent" and
    //     "perfectly cancelling" are the same number.
    //
    // So a `read('outputSnapshot')` assertion can never say WHICH side is
    // audible. These two taps can. A ChannelSplitter(2) hung off the SAME
    // `tail` node that feeds ctx.destination gives one mono stream per
    // channel — same terminal point as `outTap`, so both see limiter action
    // and the master gain, i.e. exactly what the speakers get.
    //
    // Purely additive: `outputSnapshot` above is untouched, and these are
    // passive sinks (never connected onward) so the audible signal path is
    // byte-identical.
    const chanSplit = ctx.createChannelSplitter(2);
    tail.connect(chanSplit);
    const outTapL = ctx.createAnalyser();
    outTapL.fftSize = 2048;
    outTapL.smoothingTimeConstant = 0;
    const outTapR = ctx.createAnalyser();
    outTapR.fftSize = 2048;
    outTapR.smoothingTimeConstant = 0;
    chanSplit.connect(outTapL, 0);
    chanSplit.connect(outTapR, 1);
    const outBufL = new Float32Array(outTapL.fftSize);
    const outBufR = new Float32Array(outTapR.fftSize);

    // ---------------- Runtime latch → hard-clip failover ----------------
    //
    // Registered here rather than at construction because the failover has to
    // rewire the TAPS too, and they do not exist until now. There is no `await`
    // between the limiter's construction and this line, so no event can be
    // missed in the gap: `processorerror` is delivered as a task on the main
    // thread, and this whole factory body runs to completion first.
    //
    // The shared guard (worklet-guard.ts) has ALREADY logged and ledgered the
    // latch by the time this runs — this listener is the RECOVERY, not the
    // report.
    if (limiter) {
      let failedOver = false;
      onWorkletNodeError(limiter, () => {
        if (failedOver) return; // a latched processor may fire more than once
        failedOver = true;
        tail = failoverTerminalTailToClip(ctx, tail, merger, [
          ctx.destination,
          outTap,
          chanSplit,
        ]);
      });
    }

    // Keep both gain nodes in the active graph even if nothing is patched
    // to either input. (Same trick as the Faust modules' channel mergers —
    // a silent ConstantSource per side ensures the node processes.)
    const silenceL = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceL.start();
    silenceL.connect(gainL);
    const silenceR = ctx.createConstantSource();
    silenceR.offset.value = 0;
    silenceR.start();
    silenceR.connect(gainR);

    // ---------------- THE OUTPUT SINK — the ONE owner of setSinkId ----------
    //
    // Choosing which hardware device the browser sends to used to live entirely
    // on `AudioOutCard`: it applied the pick, and it ALSO ran a 100 ms x 50
    // retry loop that re-applied the saved id once the engine appeared. Two
    // code paths that had to agree, plus a timer `onDestroy` never cleared.
    //
    // ⚠ THAT ARRANGEMENT DEPENDED ON THE CARD BEING MOUNTED, AND IT STOPPED
    // BEING GUARANTEED. The PINNED audio out is canvas-hidden; its only surface
    // is the 🎧 topbar panel, and with the module promoted that panel mounts the
    // FACEPLATE instead of the card. MEASURED: audioOut is in neither
    // DOM_SOURCE_LANE_TYPES nor CARD_PRODUCER_LANE_TYPES, so
    // `needsHeadlessSourceMount` is false and no headless host would have kept a
    // copy alive. The saved device would simply have stopped being restored.
    //
    // So the apply lives HERE, where it always could have: the factory runs on
    // engine boot BY CONSTRUCTION, which is the event the retry loop was
    // polling for. The loop is deleted rather than moved. `node.data` is the
    // source of truth on both paths — boot reads it, `write()` applies a change
    // — so the reload path and the click path are the same code.
    //
    // ⚠ FEATURE-DETECTED ON THE LIVE CONTEXT, deliberately. An OfflineAudio-
    // Context (the ART harness) has no `setSinkId`, so `sinkSupported` is false
    // there and nothing in this block runs — which is why adding it costs the
    // ART property tests nothing.
    const sinkCtx = ctx as BaseAudioContext & {
      setSinkId?: (deviceId: string) => Promise<void>;
    };
    const sinkSupported = typeof sinkCtx.setSinkId === 'function';
    /** The id actually APPLIED (not merely requested) — the observable half. */
    let sinkDeviceId: string | null = null;
    /** The last rejection. TRANSIENT: cleared on the next successful apply, and
     *  cleared here rather than left to a caller, because a stale error under a
     *  working picker was a real defect on the card. */
    let sinkError: string | null = null;
    /** The id most recently HANDED to `applySink` (applied or not). The
     *  live-data watcher compares the doc against this, so the picker's own
     *  `write()` (which applies AND persists) is never applied a second time. */
    let requestedSinkId = '';

    /** Publish the current sink state. `read('outputSink')` is a plain function
     *  call and therefore not reactive, so a UI `$derived` over it would never
     *  recompute on a rejection — the report is what makes the failure REACH a
     *  surface. Both are kept: the read for a test that wants a pull, the
     *  report for the UI that needs a push. */
    function publishSink(): void {
      reportSink(node.id, { supported: sinkSupported, deviceId: sinkDeviceId, error: sinkError });
    }

    async function applySink(deviceId: string): Promise<void> {
      requestedSinkId = deviceId;
      if (!sinkSupported) {
        // Not an error the user caused — the browser cannot do this at all, and
        // the picker reports that as its DISABLED state, not as a failure.
        sinkError = null;
        publishSink();
        return;
      }
      try {
        await sinkCtx.setSinkId!(deviceId);
        sinkDeviceId = deviceId;
        sinkError = null;
      } catch (err) {
        // The device can disappear between enumerate and apply. Surfaced
        // through the report (push) AND `read('outputSink')` (pull) so the
        // picker can announce it without polling.
        sinkError = (err as Error).message || 'setSinkId failed';
      }
      publishSink();
    }

    // Restore the saved pick at BOOT. Floated deliberately: the factory must not
    // block the audio graph on a device negotiation, and a failure lands in
    // `sinkError` rather than rejecting the whole terminal sink (which would
    // silence the entire patch — see the limiter catch above for the same
    // priority).
    {
      publishSink(); // support/idle state is known now, before any pick
      const saved = audioOutSinkPickOf(node);
      if (saved.length > 0) void applySink(saved);
    }

    // ── RE-APPLY ON A SAME-SESSION LOAD AT A REUSED ID ────────────────────
    // A load over a running rack keeps this handle (same id, same type) and
    // the block above has already run, so the loaded patch's pick reached
    // nothing. Watch the LIVE node's pick and apply a change through the one
    // owner of setSinkId. `''` (no pick) is applied too — it is the browser's
    // default sink, and it is what a fresh-page load of that patch would give.
    const stopSinkWatch = watchLiveNodeData<string>({
      nodeId: node.id,
      initial: audioOutSinkPickOf(node),
      project: audioOutSinkPickOf,
      onChange(next) {
        if (next !== requestedSinkId) void applySink(next);
      },
    });

    return {
      domain: 'audio',
      inputs: new Map([
        ['L', { node: gainL, input: 0 }],
        ['R', { node: gainR, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(paramId, value) {
        if (paramId === 'master') {
          gainL.gain.setValueAtTime(value, ctx.currentTime);
          gainR.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      /**
       * ⚠ WITHOUT THIS, NO FADE ON THE MASTER WAS EVER ACTUALLY SCHEDULED.
       *
       * `PatchEngine.scheduleParam` (engine.ts) reaches an AudioParam three
       * ways, in order: the handle's own `scheduleParam`; the param's CV-target
       * AudioParam at `inputs.get(paramId)?.param`; then a best-effort
       * IMMEDIATE `setParam`. This handle had no `scheduleParam`, and `master`
       * is not a CV port — `inputs` carries only the audio pins L and R — so
       * every call landed on branch three and became a hard step at
       * `ctx.currentTime`. `holdParam` degraded the same way, through its own
       * `else` branch.
       *
       * The failure was SILENT and shaped exactly like success: the value
       * arrived, the knob followed, `readParam` agreed. Only the RAMP was
       * missing. Anything envelope-shaped on the master — an automation lane, a
       * fade-out, the click-free crossfade the continuity work exists to serve —
       * was a jump wearing a ramp's name, and a jump on the master bus is a
       * click on the actual output.
       *
       * Both channels get the identical schedule. `linearRampToValueAtTime`
       * needs a starting event to ramp FROM, so an explicit `setValueAtTime` at
       * `now` anchors it — otherwise the ramp interpolates from whatever the
       * last scheduled event was, which after a long-idle gain is a jump at the
       * ramp's start rather than at its end.
       */
      scheduleParam(paramId, value, atTime, ramp) {
        if (paramId !== 'master') return;
        const now = ctx.currentTime;
        for (const g of [gainL.gain, gainR.gain]) {
          if (ramp && atTime > now) {
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(value, atTime);
          } else {
            g.setValueAtTime(value, Math.max(now, atTime));
          }
        }
      },
      readParam(paramId) {
        if (paramId === 'master') return gainL.gain.value;
        return undefined;
      },
      write(key, value) {
        // THE ONLY CALLER OF setSinkId IN THE APP. See `applySink` above.
        if (key === 'outputDeviceId' && typeof value === 'string') void applySink(value);
      },
      read(key) {
        // The sink state — support, the id actually applied, and the last
        // rejection. The picker's `aria-valuetext` and the model test read
        // this; nothing paints it. Read off the thing that CALLS setSinkId, so
        // it cannot drift from what actually happened.
        if (key === 'outputSink') {
          return { supported: sinkSupported, deviceId: sinkDeviceId, error: sinkError };
        }
        // Terminal-output samples — what the limiter is feeding to
        // ctx.destination this frame. Used by e2e to assert end-to-end
        // audibility (signal reached the speakers through the user's patch).
        if (key === 'outputSnapshot') {
          outTap.getFloatTimeDomainData(outBuf);
          return { samples: outBuf, sampleRate: ctx.sampleRate };
        }
        // Per-CHANNEL terminal samples, same shape as `outputSnapshot`, so
        // every existing helper works on them unchanged. Use these — never
        // the mono key — whenever an assertion is about WHICH side is
        // audible; the mono key cannot tell only-L from only-R.
        if (key === 'outputSnapshotL') {
          outTapL.getFloatTimeDomainData(outBufL);
          return { samples: outBufL, sampleRate: ctx.sampleRate };
        }
        if (key === 'outputSnapshotR') {
          outTapR.getFloatTimeDomainData(outBufR);
          return { samples: outBufR, sampleRate: ctx.sampleRate };
        }
        return undefined;
      },
      dispose() {
        stopSinkWatch();
        clearSinkReport(node.id);
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        gainL.disconnect();
        gainR.disconnect();
        dcL.disconnect();
        dcR.disconnect();
        merger.disconnect();
        try { tail.disconnect(); } catch { /* */ }
        try { outTap.disconnect(); } catch { /* */ }
        try { chanSplit.disconnect(); } catch { /* */ }
        try { outTapL.disconnect(); } catch { /* */ }
        try { outTapR.disconnect(); } catch { /* */ }
      },
    };
  },
};
