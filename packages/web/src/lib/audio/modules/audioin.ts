// packages/web/src/lib/audio/modules/audioin.ts
//
// AUDIO IN — system audio input source. Streams from a user-selected
// audioinput device (mic / line-in / aggregate) via `getUserMedia` +
// `createMediaStreamSource`, exposing L + R audio outputs for downstream
// patching.
//
// Split of responsibility:
//
//   - This factory is DOM-free. It builds the per-instance audio graph
//     (gain knob + stereo splitter + L/R output gain nodes + a silent
//     constant-source keep-alive on each output) and exposes a single
//     module-runtime hook — `read('attach', stream | null)` — which the
//     UI calls to swap a live MediaStream in (or out).
//
//   - The STREAM belongs to the NODE, not to any component:
//     `$lib/ui/modules/node-audio-input-registry.svelte.ts` owns
//     `getUserMedia`, the engine attach and the late-engine reconciler on
//     GRAPH lifetime (#1590 — `MediaStreamTrack.stop()` is irreversible,
//     and a card unmount used to call it).
//
//   - The DEVICE ROSTER and the saved keys belong to
//     `$lib/audio/input-device.svelte.ts` — one `enumerateDevices()` and
//     one `devicechange` listener for the whole app, whichever of the
//     module's surfaces happen to be painting a picker.
//
//   - The SURFACES (the faceplate's `tileBody` + `fullViewBody`, and
//     `AudioinCard.svelte` under `?shell=legacy`) render a projection and
//     invoke `$lib/ui/modules/audioIn/audio-in-actions.ts`. None of them
//     owns the resource, which is what lets any of them unmount.
//
// ⚠ THIS PARAGRAPH USED TO SAY "the CARD owns the getUserMedia permission
// flow, the device dropdown, the devicechange subscription, the status LED
// and the lifecycle of the MediaStream". Every clause of that is now false:
// #1590 moved the stream to the node, and the face moved the other four.
//
// Why this seam: engine code stays jsdom-testable (no MediaStream / mic
// permission shims) and the permission UX lives on a rendered surface,
// where a real click can carry the browser's activation context.
//
// Stereo handling:
//
//   The engine graph always exposes BOTH 'audio_l_out' + 'audio_r_out'.
//   When the attached MediaStream is mono, the same source feeds both
//   sides (the source's single channel is wired to both L + R gains via
//   parallel .connect()s). When stereo, a ChannelSplitterNode separates
//   the two channels. The REGISTRY decides which by inspecting
//   `stream.getAudioTracks()[0].getSettings().channelCount` when
//   attaching; we don't need to expose a knob since the upstream device
//   tells us.
//
//   The acquire REQUESTS a 2-channel capture (getUserMedia
//   `channelCount: 2`, via devices.buildAudioInConstraints) so a
//   multichannel USB interface (e.g. Expert Sleepers ES-9) hands us a
//   true L/R pair instead of a browser-downmixed mono signal. This gives
//   the device's FIRST stereo pair (inputs 1/2). EMPIRICAL FINDING
//   (DevTools console probe vs. a real ES-9 in Chrome): the browser caps
//   ES-9 capture at 2 channels — `track.getCapabilities().channelCount`
//   returns `{ max: 2, min: 1 }` and `getUserMedia({ channelCount:
//   { exact: 4 } })` throws OverconstrainedError. So 4-in / per-channel
//   (3/4, 5/6, …) is NOT reachable in-browser — that's the native track
//   (`patchtogether.es9`). The WIRING decision still
//   trusts the track's reported channelCount: >=2 takes the splitter
//   (true L/R), 1 or UNREPORTED takes the mono fan-out (L=R) — the safe
//   default, since a mono source through the stereo splitter would leave
//   R silent (discrete interpretation, no up-mix). A genuine stereo
//   device reports channelCount: 2.
//
//   To avoid the "shape changes mid-life" problem, we ALWAYS build the
//   splitter path + always wire both gain nodes; the attach hook just
//   connects the source node to either (a) both L + R gains directly
//   (mono) or (b) the splitter (stereo). Disconnect is symmetric. The
//   gain knobs after the splitter mean a stereo source's level is
//   still controlled by the single gain param.
//
// Permission UX:
//
//   The factory does NOT request microphone permission on engine boot —
//   it wires up the graph and waits for an attach call. Permission is
//   asked for ONLY when a surface is mounted AND either the player clicked
//   ENABLE or this origin already holds a grant (which the browser reports
//   by de-redacting the enumerated device LABELS). Loading a patch that
//   merely contains this module never pops a mic prompt. With nothing
//   attached the module emits silence — same as a patched-but-unsourced
//   input.
//
// Inputs: none.
//
// Outputs:
//   audio_l_out (audio): channel 1 from the attached input device.
//   audio_r_out (audio): channel 2 — duplicated from L if the source is
//     mono.
//
//   Only a stereo PAIR is exposed. EMPIRICAL FINDING (DevTools console
//   probe vs. a real ES-9 in Chrome): the browser caps ES-9 capture at 2
//   channels — `track.getCapabilities().channelCount` returns
//   `{ max: 2, min: 1 }`, and `getUserMedia({ channelCount:{exact:4} })`
//   throws OverconstrainedError. So 4-in / per-channel capture is NOT
//   reachable in-browser; it's the NATIVE track (`patchtogether.es9`).
//   The earlier audio_3_out/audio_4_out ports were a phantom feature (they
//   could never carry signal) and were removed.
//
// Params:
//   gain (linear 0..2, default 1.0): post-source gain. Useful for hot
//     line-ins (turn down) + quiet condenser mics (turn up). Symmetric
//     across both channels; we don't expose per-channel trim.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Module-runtime contract beyond AudioDomainNodeHandle: the card calls
 *  `read('attach', { stream, channelCount })` to wire a live source in,
 *  and `read('attach', null)` to detach. Returns nothing (the read API
 *  is repurposed for one-way commands here; the engine handle has no
 *  dedicated "set external node" method). */
export interface AudioInAttachPayload {
  stream: MediaStream;
  /** From `track.getSettings().channelCount` — defaults to 1 (mono) when
   *  the browser doesn't report it. */
  channelCount: number;
}

export const audioInDef: AudioModuleDef = {
  type: 'audioIn',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'audio in',
  category: 'sources',

  // NOT singleton — users may want multiple AUDIO IN instances on
  // different physical inputs (mic + line-in + USB interface).
  //
  // ⚠ THE PARAGRAPH HERE USED TO DESCRIBE A FILTER THAT HAS NEVER EXISTED.
  // It read: "the card-side dropdown filters out devices already in use by
  // another AUDIO IN instance to nudge the user away from double-allocating
  // the same physical input". No surface has ever implemented that — the
  // roster is `enumerateDevices()` filtered on `kind === 'audioinput'` and
  // nothing else, in `$lib/audio/input-device.svelte.ts`. What IS true is
  // the consequence the old sentence trailed with: picking a device another
  // instance (or another application) already holds makes the second
  // getUserMedia fail with `NotReadableError`, which surfaces as the
  // `device-in-use` state on the FAULT lamp with a RETRY beside it.
  inputs: [],
  // The stereo pair (L/R = device channels 1/2) — the hard browser ceiling
  // for ES-9 capture (getCapabilities().channelCount max=2; an exact:4
  // request throws OverconstrainedError). >2-in / per-channel is native-
  // only (patchtogether.es9).
  outputs: [
    { id: 'audio_l_out', type: 'audio' },
    { id: 'audio_r_out', type: 'audio' },
  ],

  params: [
    {
      id: 'gain',
      label: 'Gain',
      defaultValue: 1.0,
      min: 0,
      max: 2,
      curve: 'linear',
      units: 'gain',
    },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // The rack's SOURCE FROM OUTSIDE, promoted — `audioOut`'s twin, one wire
  // earlier, and deliberately built to the same narrow shape.
  face: {
    // ONE RANK, AND NOTHING TO ARGUE. `gain` is the only param this module has
    // ever had, and the picker / lamps / acquire / music mode are not params at
    // all (see `extension`).
    order: ['gain'],

    // A LEVEL IS A THROW, NOT A DIAL — and UNDECLARED it silently becomes a
    // dial, because `'fader'` is one of the two primitives the shell cannot
    // infer (a continuous scale is the same shape as any other). The card has
    // always mounted a `NeonFader` here; `audioOut`, `mixmstrs` and `noise` are
    // the precedent.
    paramCells: { gain: 'fader' },

    // ⚠ A REAL LANE PICTURE, AND THIS IS THE ONE BINDER IN THE WAVE THAT GETS
    // ONE. `primaryAudioOutPortId` finds the first `audio` OUTPUT port; this
    // module declares two, so it resolves `audio_l_out`, `glyphBinding` returns
    // `{kind:'live-audio'}` and the tile paints the signal actually arriving
    // from the device. That is the exact question a player has about an input —
    // *is anything coming in?* — answered without expanding anything, and it is
    // mechanically UNAVAILABLE to `audioOut` next door (`outputs: []`, so every
    // live-glyph literal there falls to the static placeholder).
    //
    // ⚠ `'meter'` RATHER THAN `'scope'` IS A NAME, NOT A BINDING: both resolve
    // through the same `if (audioOut) return {kind:'live-audio'}` arm. It is
    // declared as the level of an input rather than as a waveform to read.
    //
    // ⚠ IT IS ALSO DETERMINISTIC UNDER VRT, and not by luck: with no prior
    // microphone grant nothing is ever acquired (see `bindAudioInputSurface`),
    // so both outputs carry the factory's silent constant-source keep-alive and
    // the tap reads zeros — and the face VRT harness freezes the analyser taps
    // pre-frame regardless.
    glyph: 'meter',

    // ── THE BODY ───────────────────────────────────────────────────────────
    //
    // `$lib/ui/modules/audioIn/shell-extension.ts` → `fullViewBody` AND
    // `tileBody`. They carry the four things this module has that no `ParamDef`
    // can express, and all four are one idea — WHERE IS MY SOUND COMING FROM:
    //
    //   1. THE DEVICE PICKER — an `enumerateDevices()` roster, service state
    //      that differs per machine and changes when hardware is plugged in, so
    //      it is not an `options` roster a def could declare.
    //   2. THE ACQUIRE GESTURE — an ACTION, and the ONLY route to a first
    //      `getUserMedia` grant, which the browser will only honour from a real
    //      click.
    //   3. THE CAPTURE LAMPS — an eight-state machine no single param carries.
    //   4. MUSIC MODE — a `node.data` flag that forces the browser capture DSP
    //      off, which cannot be changed on a live track and so re-acquires.
    //
    // ⚠ TWO SLOTS, AND THE SECOND ONE IS THE POINT. `cameraInput` shipped
    // `fullViewBody` alone and its lane tile could neither pick a device nor
    // START one. AUDIO IN would inherit that in a worse form: this module is in
    // neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so
    // `needsHeadlessSourceMount` is false and after promotion NO card is mounted
    // anywhere to fall back to — a tile with a live meter and no way to open a
    // device would read as broken while being merely shut.
    //
    // ⚠ DELIBERATELY NOT A `selector` SHELL CELL, which is the route that looks
    // obvious and is worse here — `audioOut`'s argument, verbatim: `SHELL_CELLS`
    // is keyed by `face.order` key, so a selector needs a declared non-param
    // CONTROL (a `controlFamilies` entry), and its options are the runner's own
    // hardware names, i.e. a baseline full of machine-specific text.
    //
    // ⚠ NO CANVAS IN EITHER BODY. The `EXTENSION_BODY_ROLES` role is
    // `status-primitive` (imports `StatusLed`, mounts no drawing surface); the
    // module's picture is the SHELL's glyph, which is generic and already live.
    extension: 'audioIn',

    // ⚠ THE HERO IS THE FADER, for `audioOut`'s measured reason. With no hero
    // the single ranked key stays in the page-less `__all` band, so the dock
    // renders one labelled section band containing one fader under a body;
    // `heroFacePlan` DROPS the emptied band, leaving body + control with no
    // section furniture naming a band of one.
    //
    // `hero.control`, NOT `hero.cell`: a `hero.cell` suppresses the shell glyph
    // at the dock — and here that would be suppressing something twice, since
    // the extension body already takes the hero picture's place on a faceplate
    // view (`dockFullViewHeadPlan`). The lane tile's glyph is untouched by
    // either, which is where this module's picture actually earns its keep.
    hero: { control: 'gain' },

    // NO `pages`, NO `tabbed`. One ranked key cannot fill two bands, and
    // `DOCK_TAB_MIN_BANDS` is 7 — a tab rail could not engage here even if
    // someone asked for one, and the opt-in is owner-instruction-only.
    //
    // COMPACT BY DEFAULT: `FACE_WIDTH_EXEMPTIONS` is untouched and this face
    // must never become an entry.
  },

  docs: {
    explanation:
      "Brings system audio INTO the patch: it streams from a microphone, line-in, or USB interface you pick on the module and exposes the signal as a stereo L/R pair you can patch into the rack. Mental model: a live external source — sing, plug in a guitar/synth, or capture another app — and treat it like any oscillator output, sending it through filters, effects, and out to AUDIO OUT. Pick the device and switch it on from the module itself, on the rack tile or in the expanded view; permission is requested only when you enable it, not on patch load, so loading a patch never pops a mic prompt. Once granted, opening the same rack again re-opens the input on its own. The input belongs to the module, not to the panel you opened it from, so collapsing or closing that panel never stops the capture — only stopping it yourself, or deleting the module, does. Stereo handling is automatic: a stereo device feeds L and R separately, a mono source is duplicated to both sides. (Browser capture caps at a stereo pair — more than two channels per device is native-only — so only L/R are exposed.)",
    inputs: {},
    outputs: {
      audio_l_out:
        "Left channel of the selected input device (channel 1). For a mono source this carries the single channel, duplicated to the right output as well.",
      audio_r_out:
        "Right channel of the selected input device (channel 2). For a mono source it carries a copy of the left channel so both sides have signal.",
    },
    controls: {
      gain:
        "Post-source level trim applied equally to both channels, 0 (silence) to 2 (×2, +6 dB), default 1 (unity). Turn it down for a hot line-in that's clipping, up for a quiet condenser mic; there is no per-channel trim.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---------- Per-instance audio graph ----------
    //
    //   sourceNode (MediaStreamSource)            ← attached lazily by card
    //        │
    //   ┌────┴─────┐ (mono path: same node → L + R gains directly)
    //   │          │
    //   │   ┌──────┴─ splitter(2) (used for the stereo source)
    //   │   │  │
    //  gainL gainR
    //   │     │
    //  L_out  R_out   (the two declared output ports)
    //
    // The two gain nodes + the splitter are PERSISTENT (built once at
    // factory time). The source node is swapped on each attach() —
    // connections from gain → outputs never move.
    //
    // Only the stereo pair (L/R = device channels 1/2) is exposed: the
    // browser caps ES-9 capture at 2 channels (getCapabilities max=2;
    // channelCount:{exact:4} → OverconstrainedError), so 4-in / per-channel
    // is native-only (the native track).
    const initialGain = (node.params ?? {}).gain ?? 1.0;

    const gainL = ctx.createGain();
    gainL.gain.value = initialGain;
    const gainR = ctx.createGain();
    gainR.gain.value = initialGain;
    // Stereo splitter — ch0 → L, ch1 → R for a 2-channel source.
    const splitter = ctx.createChannelSplitter(2);

    // Keep the output gain nodes in the active graph even when no stream
    // is attached yet. Without this, downstream modules see no audio
    // activity and some (e.g. mixers feeding analyzers) skip processing.
    // Same trick as audio-out + faust modules. One per output channel.
    const silences: ConstantSourceNode[] = [];
    for (const g of [gainL, gainR]) {
      const s = ctx.createConstantSource();
      s.offset.value = 0;
      s.start();
      s.connect(g);
      silences.push(s);
    }

    // Current attached source (mutable; null when not yet attached or
    // after detach). The card swaps this via the attach() hook below.
    let attachedSource: MediaStreamAudioSourceNode | null = null;
    let attachedStream: MediaStream | null = null;
    // How the current attachment was wired, so detach() disconnects
    // exactly what attach() connected:
    //   'mono'   → source → gainL + gainR directly (L=R)
    //   'stereo' → source → splitter; ch0→L, ch1→R
    let attachedAs: 'none' | 'mono' | 'stereo' = 'none';

    function detachInternal(): void {
      if (attachedSource) {
        try {
          if (attachedAs === 'mono') {
            attachedSource.disconnect(gainL);
            attachedSource.disconnect(gainR);
          } else if (attachedAs === 'stereo') {
            attachedSource.disconnect(splitter);
          }
        } catch { /* already disconnected */ }
        try { attachedSource.disconnect(); } catch { /* defensive */ }
        attachedSource = null;
      }
      if (attachedAs === 'stereo') {
        try { splitter.disconnect(gainL); } catch { /* defensive */ }
        try { splitter.disconnect(gainR); } catch { /* defensive */ }
      }
      attachedAs = 'none';
      // The card owns the MediaStream lifecycle (it called getUserMedia,
      // it stops the tracks). We just drop our reference.
      attachedStream = null;
    }

    function attachInternal(payload: AudioInAttachPayload): void {
      // Re-attach idempotently: if the same stream is being attached
      // twice (e.g. card re-runs its effect), tear down first.
      detachInternal();
      const { stream, channelCount } = payload;
      attachedStream = stream;
      try {
        attachedSource = ctx.createMediaStreamSource(stream);
      } catch (err) {
        // Construction can throw if the stream has no audio track —
        // surface to the console but don't crash the engine.
        console.warn('[audioIn] createMediaStreamSource failed:', err);
        attachedSource = null;
        attachedStream = null;
        return;
      }
      if (channelCount >= 2) {
        // Stereo source: split → L/R into separate gains.
        attachedSource.connect(splitter);
        splitter.connect(gainL, 0);
        splitter.connect(gainR, 1);
        attachedAs = 'stereo';
      } else {
        // Mono source: fan-out to both L + R.
        attachedSource.connect(gainL);
        attachedSource.connect(gainR);
        attachedAs = 'mono';
      }
    }

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map([
        ['audio_l_out', { node: gainL, output: 0 }],
        ['audio_r_out', { node: gainR, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'gain') {
          // Single gain knob trims both channels symmetrically.
          gainL.gain.setValueAtTime(value, ctx.currentTime);
          gainR.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'gain') return gainL.gain.value;
        return undefined;
      },
      /**
       * The card's only handle into the engine module\'s runtime. Three keys:
       *
       *   'attach'  → payload: AudioInAttachPayload | null
       *               attach a new MediaStream (with channelCount) or
       *               detach the current one. Returns true on success,
       *               false on failure / no-op.
       *   'isAttached' → returns boolean — true when a source is wired in.
       *   'sampleRate' → number — for the card's status display.
       *
       * `read` is used here as a one-way command channel because the
       * AudioDomainNodeHandle has no dedicated mutator for external
       * sources. Mirrors the CAMERA module's `attachExternalSource`
       * pattern, just engine-local instead of going through VideoEngine.
       *
       * The (key, payload) overload of read isn't typed in the engine
       * interface; the card narrows via a typed wrapper.
       */
      read(key) {
        if (key === 'isAttached') return attachedSource !== null;
        if (key === 'sampleRate') return ctx.sampleRate;
        if (key === 'currentStreamId') return attachedStream?.id ?? null;
        return undefined;
      },
      dispose() {
        detachInternal();
        for (const s of silences) {
          try { s.stop(); } catch { /* */ }
          try { s.disconnect(); } catch { /* */ }
        }
        gainL.disconnect();
        gainR.disconnect();
        try { splitter.disconnect(); } catch { /* defensive */ }
      },
      // Expose the attach mutator on the handle itself via an
      // ext-shaped field. We can't widen AudioDomainNodeHandle without
      // ceremony, so the card narrows the handle to read this directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ __audioInAttach: (payload: AudioInAttachPayload | null) => {
        if (payload === null) detachInternal();
        else attachInternal(payload);
      } } as any),
    };
  },
};

/**
 * Card-side accessor for the attach mutator. The engine doesn't widen
 * `AudioDomainNodeHandle` to declare this, so the card narrows via this
 * helper which knows the convention (`__audioInAttach` field on the
 * handle, populated by the factory above).
 *
 * `engine` is the PatchEngine (we walk to the AudioEngine via getDomain).
 * Returns false if the node isn't attached to the engine yet (race
 * window between Yjs add and engine reconcile); the card should retry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function audioInAttach(engine: any, nodeId: string, payload: AudioInAttachPayload | null): boolean {
  try {
    const ae = engine?.getDomain?.('audio');
    if (!ae) return false;
    const handle = ae.nodes?.get?.(nodeId);
    if (!handle) return false;
    const fn = (handle as { __audioInAttach?: (p: AudioInAttachPayload | null) => void }).__audioInAttach;
    if (typeof fn !== 'function') return false;
    fn(payload);
    return true;
  } catch {
    return false;
  }
}
