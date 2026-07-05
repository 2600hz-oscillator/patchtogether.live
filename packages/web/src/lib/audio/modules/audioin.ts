// packages/web/src/lib/audio/modules/audioin.ts
//
// AUDIO IN — system audio input source. Streams from a user-selected
// audioinput device (mic / line-in / aggregate) via `getUserMedia` +
// `createMediaStreamSource`, exposing L + R audio outputs for downstream
// patching.
//
// Split of responsibility (mirrors CAMERA's design):
//
//   - This factory is DOM-free. It builds the per-instance audio graph
//     (gain knob + stereo splitter + L/R output gain nodes + a silent
//     constant-source keep-alive on each output) and exposes a single
//     module-runtime hook — `read('attach', stream | null)` — which the
//     card calls to swap a live MediaStream in (or out).
//
//   - The CARD (AudioinCard.svelte) owns the `getUserMedia` permission
//     flow, the device dropdown, the `devicechange` subscription, the
//     status LED, and the lifecycle of the MediaStream. When the user
//     grants permission OR picks a new device, the card tears the old
//     stream down + creates a new MediaStreamSource + hands the source
//     node across via the attach hook.
//
// Why this seam: engine code stays jsdom-testable (no MediaStream / mic
// permission shims) and the permission UX lives where it belongs (the
// rendered card, mounted only when the user actually wants AUDIO IN).
//
// Stereo handling:
//
//   The engine graph always exposes BOTH 'audio_l_out' + 'audio_r_out'.
//   When the attached MediaStream is mono, the same source feeds both
//   sides (the source's single channel is wired to both L + R gains via
//   parallel .connect()s). When stereo, a ChannelSplitterNode separates
//   the two channels. The card decides which by inspecting
//   `stream.getAudioTracks()[0].getSettings().channelCount` when
//   attaching; we don't need to expose a knob since the upstream device
//   tells us.
//
//   The card REQUESTS a 2-channel capture (getUserMedia
//   `channelCount: 2`, via devices.buildAudioInConstraints) so a
//   multichannel USB interface (e.g. Expert Sleepers ES-9) hands us a
//   true L/R pair instead of a browser-downmixed mono signal. This gives
//   the device's FIRST stereo pair (inputs 1/2). EMPIRICAL FINDING
//   (DevTools console probe vs. a real ES-9 in Chrome): the browser caps
//   ES-9 capture at 2 channels — `track.getCapabilities().channelCount`
//   returns `{ max: 2, min: 1 }` and `getUserMedia({ channelCount:
//   { exact: 4 } })` throws OverconstrainedError. So 4-in / per-channel
//   (3/4, 5/6, …) is NOT reachable in-browser — that's the native track
//   (`patchtogether.es9`); see .myrobots/plans/es9-stereo-io.md. The WIRING decision still
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
//   permission is requested ONLY when the card mounts AND the user has
//   either clicked "enable" or a prior grant is still in effect. The
//   factory just wires up the graph + waits for an attach call. If the
//   card never attaches (user denies permission), the module just emits
//   silence — same as a patched-but-unsourced input.
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
//   could never carry signal) and were removed. See
//   .myrobots/plans/es9-stereo-io.md.
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
  card: 'AudioinCard',
  domain: 'audio',
  label: 'audio in',
  category: 'sources',

  // NOT singleton — users may want multiple AUDIO IN cards on different
  // physical inputs (mic + line-in + USB interface). The card-side
  // dropdown filters out devices already in use by another AUDIO IN
  // instance to nudge the user away from double-allocating the same
  // physical input; if they pick the same device anyway, the second
  // getUserMedia call typically fails with NotReadableError, which the
  // card surfaces in its status LED.
  inputs: [],
  // The stereo pair (L/R = device channels 1/2) — the hard browser ceiling
  // for ES-9 capture (getCapabilities().channelCount max=2; an exact:4
  // request throws OverconstrainedError). >2-in / per-channel is native-
  // only (patchtogether.es9); see .myrobots/plans/es9-stereo-io.md.
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

  docs: {
    explanation:
      "Brings system audio INTO the patch: it streams from a microphone, line-in, or USB interface you pick on the card and exposes the signal as a stereo L/R pair you can patch into the rack. Mental model: a live external source — sing, plug in a guitar/synth, or capture another app — and treat it like any oscillator output, sending it through filters, effects, and out to AUDIO OUT. The card owns the permission flow and the device dropdown; permission is requested only when you enable it, not on patch load, so loading a patch never pops a mic prompt. Stereo handling is automatic: a stereo device feeds L and R separately, a mono source is duplicated to both sides. (Browser capture caps at a stereo pair — more than two channels per device is native-only — so only L/R are exposed.)",
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
    // is native-only (the native track; see .myrobots/plans/es9-stereo-io.md).
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
       * The card's only handle into the engine module's runtime. Three keys:
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
