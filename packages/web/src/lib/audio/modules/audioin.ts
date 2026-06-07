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
//   audio_l_out (audio): left channel from the attached input device.
//   audio_r_out (audio): right channel — duplicated from L if the source
//     is mono.
//
// Params:
//   gain (linear 0..2, default 1.0): post-source gain. Useful for hot
//     line-ins (turn down) + quiet condenser mics (turn up). Symmetric
//     on L+R; we don't expose per-channel trim.

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
  schemaVersion: 1,

  // NOT singleton — users may want multiple AUDIO IN cards on different
  // physical inputs (mic + line-in + USB interface). The card-side
  // dropdown filters out devices already in use by another AUDIO IN
  // instance to nudge the user away from double-allocating the same
  // physical input; if they pick the same device anyway, the second
  // getUserMedia call typically fails with NotReadableError, which the
  // card surfaces in its status LED.
  inputs: [],
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

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---------- Per-instance audio graph ----------
    //
    //   sourceNode (MediaStreamSource)            ← attached lazily by card
    //        │
    //   ┌────┴─────┐ (mono path: same node → both gains)
    //   │          │
    //   │   ┌──────┴─ splitter (only used when source is stereo)
    //   │   │     │
    //   gainL    gainR
    //   │         │
    //  audio_l    audio_r   (the two declared output ports)
    //
    // gainL/R + splitter are PERSISTENT (built once at factory time).
    // The source node is swapped on each attach() — connections from
    // gain → outputs never move.
    const initialGain = (node.params ?? {}).gain ?? 1.0;

    const gainL = ctx.createGain();
    gainL.gain.value = initialGain;
    const gainR = ctx.createGain();
    gainR.gain.value = initialGain;
    const splitter = ctx.createChannelSplitter(2);

    // Keep the output gain nodes in the active graph even when no
    // stream is attached yet. Without this, downstream modules see no
    // audio activity at all and some (e.g. mixers feeding into
    // analyzers) skip processing. Same trick as audio-out + faust modules.
    const silenceL = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceL.start();
    silenceL.connect(gainL);
    const silenceR = ctx.createConstantSource();
    silenceR.offset.value = 0;
    silenceR.start();
    silenceR.connect(gainR);

    // Current attached source (mutable; null when not yet attached or
    // after detach). The card swaps this via the attach() hook below.
    let attachedSource: MediaStreamAudioSourceNode | null = null;
    let attachedStream: MediaStream | null = null;
    // Whether the current attachment used the splitter (true = stereo)
    // or fed mono to both gains directly (false = mono). Tracked so
    // detach() disconnects exactly the connections we made.
    let attachedAsStereo = false;

    function detachInternal(): void {
      if (attachedSource) {
        try {
          if (attachedAsStereo) {
            attachedSource.disconnect(splitter);
          } else {
            attachedSource.disconnect(gainL);
            attachedSource.disconnect(gainR);
          }
        } catch { /* already disconnected */ }
        try { attachedSource.disconnect(); } catch { /* defensive */ }
        attachedSource = null;
      }
      if (attachedAsStereo) {
        try { splitter.disconnect(gainL); } catch { /* defensive */ }
        try { splitter.disconnect(gainR); } catch { /* defensive */ }
      }
      attachedAsStereo = false;
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
        attachedAsStereo = true;
      } else {
        // Mono source: fan-out to both L + R.
        attachedSource.connect(gainL);
        attachedSource.connect(gainR);
        attachedAsStereo = false;
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
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
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
