// packages/web/src/lib/video/modules/recorderbox.ts
//
// RECORDERBOX — a video SINK that records what you patch into it (video + L/R
// audio) to a HIGH-QUALITY, CRASH-RECOVERABLE H.264 MP4.
//
// ── Model ──────────────────────────────────────────────────────────────────
// RECORDERBOX is a monitor-and-record sink, modelled on OUTPUT (video-out.ts):
// it draws its `in` video input into its own per-instance FBO every frame
// (so the card can preview it AND so `out` can pass the video through to
// downstream modules) AND it owns two audio-domain SINK nodes
// (MediaStreamAudioDestinationNode, one per L/R input). When the operator
// arms Record, the card streams the live preview canvas + the merged L/R
// audio into a fragmented MP4 written to OPFS scratch, then Save-As's it to
// disk on stop. See packages/web/src/lib/video/recorderbox-recorder.ts for
// the encoding pipeline and recorderbox-store.ts for the crash-recovery store.
//
// ── Controls (card) ─────────────────────────────────────────────────────────
//   * Filename  — editable text field (node.data.filename); the suggested
//                 name in the Save dialog + baked into the OPFS scratch path.
//                 Synced to rack-mates via Y.Doc.
//   * Record    — ON/OFF toggle styled like every other module button.
//                 ON  = (Chromium) PROMPT for the output location up front via
//                       showSaveFilePicker — the Record press is the user
//                       gesture — then begin streaming frames+audio to OPFS
//                       scratch. Cancelling the picker does NOT start recording
//                       (the toggle reverts). The chosen FileSystemFileHandle is
//                       persisted to the recovery manifest. (Firefox/Safari with
//                       no picker: record straight to OPFS, no prompt.)
//                 OFF = finalize the MP4, then STREAM the OPFS scratch into the
//                       chosen handle in chunks (correct name at the chosen
//                       path; never a full in-memory read). No-handle browsers
//                       download the bytes via <a download> with the right name.
//   * (badge)   — "no H.264 encoder available" when the runtime can't encode
//                 H.264 (headless CI, some OSes); Record is disabled, never
//                 crashes.
//   * Recover   — on mount, if a previous recording was left mid-flight
//                 (tab crash before stop), the card offers "recover unsaved
//                 recording?" — a fragmented MP4 is playable from whatever
//                 fragments reached disk, so the take is not lost. If a
//                 destination handle was persisted at start, Save re-requests
//                 write permission and streams the partial straight back to the
//                 ORIGINAL chosen path with the correct name (no re-picking);
//                 otherwise it falls back to a picker/download with the right
//                 suggested filename.
//
// ── I/O ─────────────────────────────────────────────────────────────────────
//   Inputs:
//     in       (video) — the picture to record + monitor (polymorphic video,
//                        like OUTPUT.in: video / mono-video / image upcast).
//     audio_l  (audio) — left  channel of the soundtrack to record.
//     audio_r  (audio) — right channel of the soundtrack to record.
//   Outputs:
//     out      (video) — pass-through of `in` (input → FBO → out), so you can
//                        chain RECORDERBOX inline without breaking the signal.
//   Params: none (filename + record state live in node.data, not params).
//
// ── How the AUDIO inputs work (the cross-domain primitive this module adds) ──
// `audio_l` / `audio_r` are `audio`-TYPED inputs on a VIDEO module — a new
// cross-domain direction (audio → video audio-input). The PatchEngine's
// addCrossDomainAudioInputBridge looks up the upstream audio source's output
// (AudioEngine.getOutputNode) and connects it straight into the
// MediaStreamAudioDestinationNode this handle publishes via
// `audioInputs` (VideoEngine.getAudioInput). The two dest nodes feed a
// ChannelMergerNode whose MediaStream the card hands to the recorder — so a
// stereo VCO/mixer is captured as the MP4's AAC track, A/V-synced to the
// canvas frames via a shared t0 epoch.
//
// The audio is TAP-ONLY (inaudible): arming Record does NOT monitor the audio
// through your speakers (by design — recording shouldn't suddenly route audio
// to the master bus). Patch the same source into AUDIO OUT separately if you
// want to hear it.
//
// TWO subtleties make patched audio actually land in the MP4 (both were silent
// failure modes — see the factory):
//   1. ENCODABLE-RATE FIX (the reported "audio not recorded" bug). The capture
//      track inherits the AudioContext's sample rate. On a device that pins the
//      context LOW (a Bluetooth/HFP headset → 16 kHz), Mediabunny picks an
//      HE-AAC profile (mp4a.40.29) the browser's AAC encoder can't encode, so
//      addAudioTrack throws + the soundtrack is silently dropped → VIDEO-ONLY
//      MP4. We bridge the capture through a dedicated 48 kHz AudioContext when
//      the app rate ≤ 24 kHz, so the encoder sees AAC-LC (mp4a.40.2).
//   2. ORPHAN-SILENT GUARD (defensive). A MediaStreamAudioDestinationNode is a
//      sink but does NOT terminate the graph at ctx.destination, and some
//      Chromium configs won't pull a subgraph with no path to ctx.destination.
//      A SILENT keep-alive (merger → gain(0) → ctx.destination) makes the chain
//      always get pulled — same pattern as DOOM's audio_l/audio_r keep-alive +
//      video-audio-keepalive.ts. Gain 0 preserves the tap-only contract.
//
// ── Recovery scope ──────────────────────────────────────────────────────────
// OPFS scratch is origin-LOCAL: recovery is this-machine/this-browser only and
// does NOT sync to collaborators (a multi-MB MP4 has no business in the Y.Doc).
// A rack-mate who reloads sees no recover prompt — only the browser that did
// the recording does.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const COPY_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasInput;

void main() {
  if (uHasInput < 0.5) {
    // Idle pattern — a slow vertical sweep on dark crimson so the operator
    // can see the RECORDERBOX card is alive even with nothing patched in.
    // (Distinct hue from OUTPUT's navy so the two read differently on a rack.)
    float v = vUv.y * 0.05;
    outColor = vec4(0.10 + v, 0.04, 0.06, 1.0);
    return;
  }
  outColor = texture(uTex, vUv);
}`;

export const recorderboxDef: VideoModuleDef = {
  type: 'recorderbox',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'recorderbox',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    { id: 'in', type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(COPY_FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    // Per-instance FBO — same pattern as OUTPUT. The card blits this into the
    // engine drawing buffer (engine.blitOutputToDrawingBuffer) for its preview
    // AND draws it into the hidden capture canvas the recorder encodes.
    const { fbo, texture } = ctx.createFbo();

    let lastInputTexture: WebGLTexture | null = null;

    // ── Audio capture sinks ──────────────────────────────────────────────
    // One MediaStreamAudioDestinationNode per L/R input port; a ChannelMerger
    // sums them into a 2-channel stream the card's recorder consumes. Guard on
    // ctx.audioCtx: a video engine registered without an AudioContext (jsdom
    // tests, audio-off racks) records video only (silent) — never crashes.
    let audioInputs: Map<string, { node: AudioNode; input: number }> | undefined;
    let merger: ChannelMergerNode | null = null;
    let destL: MediaStreamAudioDestinationNode | null = null;
    let destR: MediaStreamAudioDestinationNode | null = null;
    let captureStream: MediaStream | null = null;
    // Silent keep-alive (merger → gain(0) → ctx.destination). Held so dispose()
    // can tear it down. See the ORPHAN-SILENT GUARD block below.
    let keepAlive: GainNode | null = null;
    // Optional dedicated 48 kHz resample context — built ONLY when the app's
    // AudioContext runs at a low rate (≤24 kHz, e.g. a Bluetooth/HFP output
    // device). See the ENCODABLE-RATE FIX block. Held so dispose() tears it down.
    let resampleCtx: AudioContext | null = null;
    let resampleSrc: MediaStreamAudioSourceNode | null = null;
    let resampleKeepAlive: GainNode | null = null;
    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      // The bridge connects each upstream source into gainL/gainR. We route each
      // input through a GainNode into a 2-in ChannelMerger, and expose the GAINS
      // as the audioInputs sinks; the merger output drives a single
      // MediaStreamAudioDestinationNode whose stream the recorder reads.
      const gainL = ac.createGain();
      const gainR = ac.createGain();
      merger = ac.createChannelMerger(2);
      gainL.connect(merger, 0, 0); // left input  → merger channel 0
      gainR.connect(merger, 0, 1); // right input → merger channel 1
      const dest = ac.createMediaStreamDestination();
      dest.channelCount = 2;
      merger.connect(dest);
      destL = dest; // (single dest; kept refs named for dispose symmetry)
      destR = dest;

      // ── ORPHAN-SILENT GUARD (defensive) ──────────────────────────────────
      // A MediaStreamAudioDestinationNode is a sink, but it does NOT terminate
      // the graph at ctx.destination, and on some Chromium configs a subgraph
      // with NO path to ctx.destination is treated as orphan + never pulled (the
      // upstream worklet's process() never runs → silent capture). Same class as
      // the DOOM audio_l/audio_r keep-alive (doom.ts) + the video-audio-keepalive
      // decode keep-alive. A parallel SILENT tap merger → gain(0) → destination
      // gives the chain a real path to ctx.destination so it's always pulled.
      // Gain 0 = nothing audible (the documented tap-only contract is preserved:
      // arming Record must not monitor through the speakers).
      keepAlive = ac.createGain();
      keepAlive.gain.value = 0;
      merger.connect(keepAlive);
      try {
        keepAlive.connect(ac.destination);
      } catch {
        // No real destination (offline/test ctx) — nothing to keep alive.
      }
      // A suspended context pulls nothing. Resume best-effort; the audio-gate's
      // user-gesture resume is the backstop.
      if (ac.state === 'suspended') {
        void ac.resume?.().catch(() => { /* best-effort */ });
      }

      // ── ENCODABLE-RATE FIX (the patched-audio-absent-from-MP4 root cause) ──
      // The MediaStreamAudioDestinationNode's track inherits the AudioContext's
      // sample rate. On a machine whose output device forces a LOW rate — a
      // Bluetooth/HFP headset commonly pins the AudioContext to 16 kHz — the
      // capture track is 2-channel @ 16 kHz. Mediabunny's AAC codec picker
      // chooses the AAC PROFILE purely from (channels, sampleRate):
      //     channels ≥ 2 && rate ≤ 24000  → mp4a.40.29  (HE-AAC v2)
      //                     rate ≤ 24000  → mp4a.40.5   (HE-AAC v1)
      //                     otherwise     → mp4a.40.2   (AAC-LC)
      // Chrome's AAC ENCODER supports only AAC-LC, so a low-rate capture makes
      // addAudioTrack() throw ("mp4a.40.29 … not supported"), the recorder's
      // try/catch swallows it, and the MP4 is recorded VIDEO-ONLY (silent) —
      // exactly the reported bug. (At the normal 44.1/48 kHz this never triggers,
      // which is why it wasn't caught earlier.)
      //
      // Fix: when ac.sampleRate ≤ 24 kHz, bridge the capture stream through a
      // DEDICATED 48 kHz AudioContext (MediaStreamAudioSourceNode → 48 kHz
      // MediaStreamAudioDestinationNode). The browser resamples 16 k → 48 k at
      // the MediaStream boundary, so the track the recorder reads is 48 kHz →
      // Mediabunny picks AAC-LC → the soundtrack encodes. At normal rates we use
      // the direct dest stream (no second context).
      const LOW_RATE_THRESHOLD = 24_000;
      if (ac.sampleRate <= LOW_RATE_THRESHOLD) {
        try {
          const RC = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
          if (RC) {
            resampleCtx = new RC({ sampleRate: 48_000 });
            if (resampleCtx.state === 'suspended') void resampleCtx.resume?.().catch(() => { /* */ });
            resampleSrc = resampleCtx.createMediaStreamSource(dest.stream);
            const rDest = resampleCtx.createMediaStreamDestination();
            rDest.channelCount = 2;
            resampleSrc.connect(rDest);
            // Keep-alive on the resample ctx too (same orphan-silent reasoning).
            resampleKeepAlive = resampleCtx.createGain();
            resampleKeepAlive.gain.value = 0;
            resampleSrc.connect(resampleKeepAlive);
            try { resampleKeepAlive.connect(resampleCtx.destination); } catch { /* */ }
            captureStream = rDest.stream;
          } else {
            captureStream = dest.stream; // no AudioContext ctor — best-effort.
          }
        } catch {
          // Resample bridge failed — fall back to the direct stream (audio may
          // be dropped at encode time, but never crash the recording).
          captureStream = dest.stream;
        }
      } else {
        captureStream = dest.stream;
      }

      // Publish the per-port AudioNode SINKS for the cross-domain
      // audio→video audio-input bridge (VideoEngine.getAudioInput).
      audioInputs = new Map<string, { node: AudioNode; input: number }>([
        ['audio_l', { node: gainL, input: 0 }],
        ['audio_r', { node: gainR, input: 0 }],
      ]);
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        lastInputTexture = inputTex;
        // Render input (or idle pattern) into our own FBO — passthrough for
        // `out` + source for the card's preview/capture blit.
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }
        ctx.drawFullscreenQuad();
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      audioInputs,
      setParam(_p, _v) { /* no params */ },
      readParam(_p) { return undefined; },
      read(key) {
        if (key === 'hasInput') return lastInputTexture !== null;
        if (key === 'fboTexture') return texture;
        // The card pulls the live capture MediaStream from here to feed the
        // recorder (or null when no audio context — record video only).
        if (key === 'audioStream') return captureStream;
        if (key === 'hasAudio') return captureStream !== null;
        return undefined;
      },
      dispose() {
        surface.dispose();
        // Tear down the audio capture graph. Disconnect is idempotent-safe.
        try { keepAlive?.disconnect(); } catch { /* */ }
        try { merger?.disconnect(); } catch { /* */ }
        try { destL?.disconnect(); } catch { /* */ }
        if (destR && destR !== destL) {
          try { destR.disconnect(); } catch { /* */ }
        }
        // Tear down the dedicated 48 kHz resample bridge (low-rate machines).
        try { resampleKeepAlive?.disconnect(); } catch { /* */ }
        try { resampleSrc?.disconnect(); } catch { /* */ }
        try { void resampleCtx?.close?.(); } catch { /* */ }
        // Stop the capture stream tracks so the recorder (if still attached)
        // sees end-of-stream.
        try { captureStream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      },
    };
  },
};
