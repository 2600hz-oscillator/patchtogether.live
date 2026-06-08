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
// The audio is TAP-ONLY: a MediaStreamAudioDestinationNode does NOT reach
// ctx.destination, so arming Record does not monitor the audio through your
// speakers (by design — recording shouldn't suddenly route audio to the
// master bus). Patch the same source into AUDIO OUT separately if you want to
// hear it.
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
  label: 'RECORDERBOX',
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
    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      // The bridge connects each upstream source into destL/destR. We then
      // tap destL/destR's stream tracks' source nodes back into a merger so
      // the recorder gets a single stereo stream. Simpler + robust: route
      // each input through a GainNode into a 2-in ChannelMerger, and expose
      // the GAINS as the audioInputs sinks; the merger output drives a single
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
      captureStream = dest.stream;
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
        try { merger?.disconnect(); } catch { /* */ }
        try { destL?.disconnect(); } catch { /* */ }
        if (destR && destR !== destL) {
          try { destR.disconnect(); } catch { /* */ }
        }
        // Stop the capture stream tracks so the recorder (if still attached)
        // sees end-of-stream.
        try { captureStream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      },
    };
  },
};
