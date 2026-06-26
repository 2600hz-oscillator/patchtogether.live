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
//   * Filename  — editable text field (node.data.filename). Used DIRECTLY as the
//                 base of the saved file name — NO per-save "Save As" prompt.
//                 Synced to rack-mates via Y.Doc.
//   * Record    — ON/OFF toggle styled like every other module button.
//                 ON  = (Chromium) pick a destination FOLDER once via
//                       showDirectoryPicker (the Record press is the user
//                       gesture), then stream frames+audio to OPFS scratch and
//                       AUTO-write the finished file(s) into that folder using the
//                       Filename box — no per-save prompt. The folder is
//                       remembered, so the next record needs no prompt. The ONLY
//                       prompt is an OVERWRITE confirm if a file with the target
//                       name already exists. Cancelling the folder picker does NOT
//                       start recording. (Firefox/Safari with no directory picker:
//                       record to OPFS, then per-chunk <a download>.)
//                 OFF = finalize the current chunk → remux to a flat (moov-based)
//                       MP4 → write it into the folder under its chunk name.
//   * Chunking  — a long take ROLLS to a NEW file every ~10 min, with a 5 s AUDIO
//                 OVERLAP between consecutive chunks (the last 5 s of chunk N is
//                 duplicated as the start of chunk N+1). Chunks are named
//                 FILENAME-CHUNK#-DATETIME.mp4 (RECORDING-001-…, RECORDING-002-…),
//                 unique + Finder-sortable. A take under ~10 min is a single
//                 RECORDING-001-<datetime>.mp4.
//   * Timing    — video frames are encoded at a CONSTANT frame rate (PTS on an
//                 even index/fps grid), not off jittery wall-clock time. This
//                 fixes the macOS Preview/QuickTime "slow-motion" artifact that an
//                 irregular (variable-rate) PTS stream produced.
//   * (badge)   — "no H.264 encoder available" when the runtime can't encode
//                 H.264 (headless CI, some OSes); Record is disabled, never
//                 crashes.
//   * Recover   — on mount, if a previous recording was left mid-flight
//                 (tab crash before stop), the card offers "recover unsaved
//                 recording?" — a fragmented MP4 is playable from whatever
//                 fragments reached disk, so the take is not lost. If the
//                 destination FOLDER was persisted at start, Save re-requests
//                 write permission and streams the partial straight back into it
//                 under the chunk's FILENAME-CHUNK#-DATETIME name (no re-picking);
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
// SAMPLE-ACCURATE CAPTURE TAP worklet (the clicks/pops fix). Runs on the AUDIO
// THREAD: while ARMED it batches 1024 stereo frames and POSTS planar f32 to the
// main thread via its port (the port BUFFERS under load → the audio thread never
// drops a sample). The recorder drains those posts through mediabunny's
// BACKPRESSURED AudioSampleSource.add() → lossless. See recorderbox-capture.ts +
// recorderbox-capture-drain.ts. The `?url` import resolves the pre-built
// dist/recorderbox-capture.js (task dsp:build) — same pattern as MANDELBULB's
// mandelbulb-osc worklet.
import captureWorkletUrl from '@patchtogether.live/dsp/dist/recorderbox-capture.js?url';

/** What `read('audioCapture')` resolves to: the worklet's MessagePort (the
 *  drain reads planar f32 chunks off it) + the ENCODABLE capture sample rate
 *  (44.1/48k — post the low-rate→48k bridge), or null when there's no
 *  AudioContext / the worklet couldn't load (then the recorder falls back to the
 *  MediaStreamAudioTrackSource path via `audioStream`). */
export interface RecorderboxAudioCaptureTap {
  port: MessagePort;
  sampleRate: number;
}

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

  // docs-hash-ignore:start
  docs: {
    explanation: `RECORDERBOX is a video-domain SINK that records whatever you patch into it — picture plus a left/right soundtrack — to a high-quality, crash-recoverable H.264/HEVC MP4. Modelled on OUTPUT, it draws its \`in\` video into a per-instance framebuffer every frame so the card can show a live preview AND so \`out\` can pass the picture through unbroken; meanwhile each audio input feeds a gain into a stereo channel-merger that drives a MediaStreamAudioDestinationNode, and a sample-accurate audio-thread worklet taps that stereo signal so the recorder muxes it as the MP4's AAC track, A/V-synced to the captured frames. Arm recording with the on-card RECORD/STOP button: on Chromium the first press asks you to pick a destination FOLDER once (then every take and rolling chunk auto-writes into it with no further Save-As prompt — the only prompt is an overwrite confirm), while Firefox/Safari fall back to a per-chunk download. Typical use: chain it inline anywhere in a video patch (preview on the card, signal continues to \`out\`), patch your stereo mix into A·L/A·R, type a base FILE name, pick a SIZE tier (HIGH = original ~14 Mbps H.264; BALANCED/SMALL prefer hardware HEVC), and hit RECORD. The audio is TAP-ONLY and inaudible — it is captured (via a silent gain-0 keep-alive that never reaches your speakers) but NOT monitored, so route the same source to AUDIO OUT separately if you want to hear it. Long takes auto-roll to a new FILENAME-CHUNK#-DATETIME.mp4 every ~10 min (with a 5 s audio overlap), and a take left mid-flight by a crash can be recovered on reload.`,
    inputs: {
      in: "The picture to record and monitor — a polymorphic video input (video / mono-video / image are upcast, like OUTPUT.in). It is drawn into the card's preview, into the hidden full-resolution capture canvas the encoder reads, and passed through unchanged to the `out` jack. With nothing patched the card shows a slow dark-crimson idle sweep.",
      audio_l: "Left channel of the soundtrack to record. An audio-typed input on a video module (the cross-domain audio→video bridge): the upstream audio source feeds a gain that is summed into channel 0 of a stereo merger, captured as the left side of the AAC track. Capture is tap-only/inaudible — recorded but not monitored to the speakers.",
      audio_r: "Right channel of the soundtrack to record. Like audio_l but summed into channel 1 of the merger (the right side of the stereo AAC track the recorder encodes). Patch a stereo mixer/VCO across A·L and A·R for a stereo MP4; tap-only, so route the source to AUDIO OUT separately to hear it.",
    },
    outputs: {
      out: "Pass-through of the `in` picture (input → framebuffer → out), so RECORDERBOX can be chained inline anywhere in a video patch without breaking the downstream signal — it monitors and records while the video keeps flowing.",
    },
    controls: {},
  },
  // docs-hash-ignore:end
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
    // ── SAMPLE-ACCURATE CAPTURE TAP (the clicks/pops fix) ──
    // An AudioWorkletNode ('recorderbox-capture') tapped off the merged stereo
    // signal IN THE ENCODABLE-RATE CONTEXT (the main ctx at normal rates; the
    // dedicated 48 kHz resample ctx on a low-rate device — reusing the same
    // 48k-bridge decision so the captured rate is always AAC-LC-encodable). While
    // ARMED it posts planar f32 chunks to the main thread; the recorder drains
    // them through mediabunny's backpressured AudioSampleSource.add() → lossless,
    // no dropped samples → no silence-pad → no click. Loaded ASYNC (addModule),
    // so the tap is published via a Promise (read('audioCapture')). Held so
    // dispose() tears it down. A gain(0)→destination keep-alive makes Chromium
    // actually run the worklet's process() (an orphan subgraph is never pulled).
    let captureNode: AudioWorkletNode | null = null;
    let captureKeepAlive: GainNode | null = null;
    // The encodable-rate context the capture node lives in + the source node we
    // tap (the merger at normal rates, the resampleSrc on a low-rate device).
    // Resolved synchronously below; the worklet load (async) reads them.
    let captureAc: BaseAudioContext | null = null;
    let captureTapSource: AudioNode | null = null;
    let captureSampleRate = 0;
    // The published tap Promise — resolved once addModule + node creation
    // complete (or with null on no-AudioContext / load failure). read() returns
    // this so the card can `await` it at record start.
    let captureTap: Promise<RecorderboxAudioCaptureTap | null> = Promise.resolve(null);
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
            // The sample-accurate tap lives in the 48 kHz resample ctx (the
            // encodable rate), tapped off the resampled stereo source.
            captureAc = resampleCtx;
            captureTapSource = resampleSrc;
            captureSampleRate = resampleCtx.sampleRate; // 48000
          } else {
            captureStream = dest.stream; // no AudioContext ctor — best-effort.
            // No second context — tap the main ctx merger directly (still
            // ≤24 kHz here, but the worklet path itself never drops; the rate
            // gate is the MediaStreamAudioTrackSource fallback's problem).
            captureAc = ac;
            captureTapSource = merger;
            captureSampleRate = ac.sampleRate;
          }
        } catch {
          // Resample bridge failed — fall back to the direct stream (audio may
          // be dropped at encode time, but never crash the recording).
          captureStream = dest.stream;
          captureAc = ac;
          captureTapSource = merger;
          captureSampleRate = ac.sampleRate;
        }
      } else {
        captureStream = dest.stream;
        // Normal rate (44.1/48k): tap the main ctx merger directly — already an
        // AAC-LC-encodable rate, so no second context is needed.
        captureAc = ac;
        captureTapSource = merger;
        captureSampleRate = ac.sampleRate;
      }

      // ── Kick off the async capture-worklet load (the sample-accurate tap) ──
      // Same async-in-factory pattern as MANDELBULB's mandelbulb-osc: load the
      // module, build the node, connect the encodable-rate source → capture →
      // gain(0)→destination keep-alive (so Chromium runs its process()). Publish
      // the {port, sampleRate} tap via a Promise the card awaits at record start.
      // On any failure resolve null → the recorder uses the audioStream fallback.
      const tapAc = captureAc;
      const tapSrc = captureTapSource;
      const tapRate = captureSampleRate;
      if (tapAc && tapSrc && tapRate > 0) {
        captureTap = (async (): Promise<RecorderboxAudioCaptureTap | null> => {
          try {
            await tapAc.audioWorklet.addModule(captureWorkletUrl);
            const cap = new AudioWorkletNode(tapAc, 'recorderbox-capture', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              channelCount: 2,
              channelCountMode: 'explicit',
            });
            captureNode = cap;
            tapSrc.connect(cap);
            // Keep-alive: an AudioWorkletNode with no path to destination is an
            // orphan subgraph Chromium won't pull → its process() never runs.
            // gain(0) keeps the tap-only/inaudible contract.
            captureKeepAlive = tapAc.createGain();
            captureKeepAlive.gain.value = 0;
            cap.connect(captureKeepAlive);
            if ('destination' in tapAc && tapAc.destination) {
              try { captureKeepAlive.connect(tapAc.destination); } catch { /* */ }
            }
            return { port: cap.port, sampleRate: tapRate };
          } catch {
            // Worklet load failed (CSP / missing dist / no AudioWorklet) — the
            // recorder falls back to the MediaStreamAudioTrackSource path.
            return null;
          }
        })();
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
        // The sample-accurate capture tap (PREFERRED). A Promise resolving to
        // { port, sampleRate } once the worklet has loaded, or null if there's
        // no AudioContext / the worklet failed to load (→ audioStream fallback).
        if (key === 'audioCapture') return captureTap;
        return undefined;
      },
      dispose() {
        surface.dispose();
        // Tear down the sample-accurate capture tap + its keep-alive.
        try { captureNode?.disconnect(); } catch { /* */ }
        try { captureKeepAlive?.disconnect(); } catch { /* */ }
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
