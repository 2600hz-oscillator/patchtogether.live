// packages/web/src/lib/video/modules/videovarispeed.ts
//
// VIDEOVARISPEED — local-file video player with a performant varispeed
// transport (speed knob / START-END window / loop-vs-one-shot / CV gates).
//
// This is the PERFORMANT redo of the transport features that were rolled back
// out of VIDEOBOX (PR #291). #291 broke in two ways:
//
//   1. Reverse playback scrubbed <video>.currentTime EVERY animation frame.
//      Each seek triggers a decode / keyframe seek — at 60 fps that floods
//      the decode pipeline + stalls the main thread ("atrocious" perf).
//
//   2. Non-1x playback STOPPED streaming downstream. #291 inherited the
//      per-frame texImage2D upload that uploads "if readyState >= 2", but the
//      per-frame currentTime scrub leaves the element mid-seek (readyState
//      drops below HAVE_CURRENT_DATA), so the upload was skipped and the
//      downstream VIDEO-OUT / BENTBOX texture froze / went black at any speed
//      that involved scrubbing. The texture cadence was coupled to the
//      element's seek state.
//
// VIDEOVARISPEED avoids both:
//
//   * The output texture is driven by requestVideoFrameCallback (rVFC) — the
//     same proven pattern CAMERA-INPUT uses. rVFC fires whenever the <video>
//     produces a NEW frame, which is the element's OWN decode cadence and is
//     completely INDEPENDENT of playbackRate. At 2x rVFC fires ~twice as
//     fast, at 0.5x ~half as fast, in reverse it fires after each scrub-seek
//     settles — but it ALWAYS fires on a genuinely fresh, fully-decoded
//     frame. The upload is therefore never gated on a state that non-1x
//     playback fails. (Falls back to per-engine-rAF upload gated on
//     readyState >= HAVE_CURRENT_DATA where rVFC is unavailable.)
//
//   * Forward varispeed uses <video>.playbackRate (native, cheap, audio
//     pitch/tempo-shifts = the varispeed distortion). Reverse scrubs
//     currentTime at a THROTTLED ~10 Hz cadence (see
//     videovarispeed-transport.ts reverseScrubStep) so the decoder keeps up.
//
// File-load + <video> + the per-frame-upload output pattern is reused from
// VIDEOBOX (that part works); the transport math lives in
// videovarispeed-transport.ts. The card drives playbackRate / scrub / window;
// the factory stores params + samples the element into its FBO.
//
// Inputs:
//   cv_start / cv_pause / cv_reset / cv_loop_toggle (gate, paramTarget=…):
//     rising-edge transport gates.
//   speedCv / startCv / endCv (cv, linear, paramTarget=…): per-param CV displacement.
//
// Outputs:
//   video (video): decoded frames at the user's transport state.
//   audio_l / audio_r (audio): stereo bridges from the file's audio track.
//
// Params:
//   speed (linear 0..1): playback rate (0 = stop, mapped to negative…positive multiplier).
//   start / end (linear 0..1): in-and-out window into the file.
//   speedCv / startCv / endCv (linear -1..1): cached CV values.
//   cv_start / cv_pause / cv_reset / cv_loop_toggle (linear 0..1):
//     cached state from the gate inputs.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import type { VideoboxFileMeta } from './videobox-sync';

// Passthrough sample of the source texture, with an idle pattern so an empty
// card reads as "alive but empty" rather than "broken" (mirrors VIDEOBOX /
// CAMERA so the file-input modules look consistent).
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
// (sx, sy) — UV scale that fits the SOURCE aspect into the engine FBO
// without stretching. (1,1) = source already matches FBO aspect. The
// FBO is currently 4:3, so a 16:9 clip gets sy<1 (letterbox bars
// top/bottom); a square source gets sx<1 (pillarbox bars left/right).
// Computed adaptively per ctx.res from the <video> element dimensions.
uniform vec2 uLetterbox;

void main() {
  if (uHasInput < 0.5) {
    float v = vUv.y * 0.05;
    outColor = vec4(0.05, 0.05, 0.08 + v, 1.0);
    return;
  }
  // Centre + scale the active region so the source keeps its native aspect
  // inside the engine FBO; outside the active region renders pure black bars.
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, centered).rgb, 1.0);
}`;

/** Persisted shape on node.data. The card is the only writer. */
export interface VideoVarispeedData {
  /** Metadata about the file the loader picked. Null until a file is picked.
   *  Local-only player, but we keep it on data so it survives reload. */
  fileMeta: VideoboxFileMeta | null;
  /** True when the transport is logically playing. */
  isPlaying: boolean;
  /** Transport mode: true = LOOP (jump to START at END), false = ONE-SHOT
   *  (stop at END). Persisted so the loop button + loop_toggle gate flip the
   *  same state across reload. */
  loop: boolean;
}

/** Default state stamped onto a freshly spawned VIDEOVARISPEED. */
export const VIDEOVARISPEED_DATA_DEFAULTS: VideoVarispeedData = {
  fileMeta: null,
  isPlaying: false,
  loop: true,
};

/** Handle extras — the card calls these to drive the audio wiring once the
 *  local <video> has loaded its file. Mirrors VIDEOBOX. */
export interface VideoVarispeedHandleExtras {
  /** Wire the element's audio into the graph (after src + metadata). */
  wireAudio(): void;
  /** Tear down the MediaElementSource (on file swap / destroy). */
  unwireAudio(): void;
  /** True once wireAudio has succeeded. */
  isAudioWired(): boolean;
}

interface VideoVarispeedParams {
  /** Varispeed knob, normalized 0..1. 0=-4x, 0.5=+1x, 1=+4x. Default 0.5. */
  speed: number;
  /** START slider, fraction of duration 0..1. Default 0 = beginning. */
  start: number;
  /** END slider, fraction of duration 0..1. Default 1 = end of video. */
  end: number;
  // CV inputs (bipolar -1..+1), separate from the knob/slider params so the
  // cross-domain CV bridge's raw-sample write doesn't clobber the user's
  // setting; the card reads both + combines them.
  speedCv: number;
  startCv: number;
  endCv: number;
  // Gate edge-detector params (synthetic; the bridge writes the gate level
  // here, the card edge-detects).
  cv_start: number;
  cv_pause: number;
  cv_reset: number;
  cv_loop_toggle: number;
}

const DEFAULTS: VideoVarispeedParams = {
  speed: 0.5,
  start: 0,
  end: 1,
  speedCv: 0,
  startCv: 0,
  endCv: 0,
  cv_start: 0,
  cv_pause: 0,
  cv_reset: 0,
  cv_loop_toggle: 0,
};

export const videoVarispeedDef: VideoModuleDef = {
  type: 'videovarispeed',
  domain: 'video',
  label: 'VIDEOVARISPEED',
  category: 'sources',
  schemaVersion: 1,
  // No cap — files are user-supplied; multiple cards is a legit use case.
  inputs: [
    // --- Gate inputs (rising-edge). Each routes through the standard CV
    //     bridge into a synthetic cv_<x> param; the card polls + edge-detects
    //     (mirrors DOOM / VIDEOBOX). port id == paramTarget per PR #264. ---
    // start: (re)start playback from the START point.
    { id: 'cv_start',       type: 'gate', paramTarget: 'cv_start' },
    // pause: toggle pause / unpause.
    { id: 'cv_pause',       type: 'gate', paramTarget: 'cv_pause' },
    // reset: seek to the START point.
    { id: 'cv_reset',       type: 'gate', paramTarget: 'cv_reset' },
    // loop_toggle: flip LOOP <-> ONE-SHOT on rising edge.
    { id: 'cv_loop_toggle', type: 'gate', paramTarget: 'cv_loop_toggle' },
    // --- CV inputs (bipolar -1..+1), separate paramTargets from the
    //     knob/slider params; the card sums them. ---
    { id: 'speedCv', type: 'cv', paramTarget: 'speedCv', cvScale: { mode: 'linear' } },
    { id: 'startCv', type: 'cv', paramTarget: 'startCv', cvScale: { mode: 'linear' } },
    { id: 'endCv',   type: 'cv', paramTarget: 'endCv',   cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'video',   type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  params: [
    // Transport user params. speed: 0..1 normalized knob (0.5 = +1x).
    { id: 'speed', label: 'Speed', defaultValue: DEFAULTS.speed, min: 0, max: 1, curve: 'linear' },
    { id: 'start', label: 'Start', defaultValue: DEFAULTS.start, min: 0, max: 1, curve: 'linear' },
    { id: 'end',   label: 'End',   defaultValue: DEFAULTS.end,   min: 0, max: 1, curve: 'linear' },
    // CV target params (bipolar). curve:linear so setParam values arrive raw.
    { id: 'speedCv', label: 'Speed CV', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'startCv', label: 'Start CV', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'endCv',   label: 'End CV',   defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    // Edge-detector params for the gate inputs. Hidden from the card UI (the
    // ports render as gate handles). curve:linear so values arrive raw.
    { id: 'cv_start',        label: 'Start gate', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_pause',        label: 'Pause gate', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_reset',        label: 'Reset gate', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_loop_toggle',  label: 'Loop gate',  defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    const { fbo, texture: outTexture } = ctx.createFbo();

    let sourceTexture: WebGLTexture | null = null;
    let sourceTexAllocated = false;
    let videoEl: HTMLVideoElement | null = null;

    // rVFC drives the upload cadence off the <video>'s OWN frame production,
    // which is independent of playbackRate. This is THE fix for the #291
    // non-1x-no-stream bug: the upload never depends on the playback speed or
    // on the element's seek state. `frameDirty` is set on each rVFC tick; we
    // upload only when a fresh frame is queued (after the first upload).
    let frameDirty = false;
    let rvfcId: number | null = null;
    let rvfcSupported = false;
    // Count of actual texImage2D uploads. Engine-internal liveness signal so
    // e2e can prove this source's decode->upload path is live WITHOUT sampling
    // rendered pixels on software-GL (which flakes under CI rAF throttling).
    // Mirrors VIDEOBOX's uploader.uploadCount.
    let uploadCount = 0;

    const params: VideoVarispeedParams = { ...DEFAULTS };

    // ---- Audio plumbing (mirrors VIDEOBOX) ----
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let silentLeft: ConstantSourceNode | null = null;
    let silentRight: ConstantSourceNode | null = null;
    let mediaElSrc: MediaElementAudioSourceNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
    // Silent keep-alive (src -> gain(0) -> destination) so the AudioContext
    // pulls this element in real time and Chromium doesn't throttle its decode
    // to ~1 fps when no audio is patched. WITHOUT this, multiple VIDEOVARISPEED
    // sources all throttle except one -> "only one video plays at a time".
    // Shared with VIDEOBOX / CAMERA via video-audio-keepalive.ts.
    let keepAlive: VideoAudioKeepAlive | null = null;
    let audioWired = false;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const l = ac.createConstantSource();
      l.offset.setValueAtTime(0, ac.currentTime);
      l.start();
      silentLeft = l;
      const r = ac.createConstantSource();
      r.offset.setValueAtTime(0, ac.currentTime);
      r.start();
      silentRight = r;
      audioSources.set('audio_l', { node: l, output: 0 });
      audioSources.set('audio_r', { node: r, output: 0 });
    }

    function attachRvfc(): void {
      if (!videoEl) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = videoEl as any;
      if (typeof v.requestVideoFrameCallback !== 'function') {
        rvfcSupported = false;
        return;
      }
      rvfcSupported = true;
      const tick = (): void => {
        frameDirty = true;
        if (videoEl) rvfcId = v.requestVideoFrameCallback(tick);
      };
      rvfcId = v.requestVideoFrameCallback(tick);
    }

    function detachRvfc(): void {
      if (rvfcId === null || !videoEl) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = videoEl as any;
      if (typeof v.cancelVideoFrameCallback === 'function') {
        v.cancelVideoFrameCallback(rvfcId);
      }
      rvfcId = null;
    }

    function ensureSourceTexture(): WebGLTexture {
      if (sourceTexture) return sourceTexture;
      const tex = gl.createTexture();
      if (!tex) throw new Error('VIDEOVARISPEED: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sourceTexture = tex;
      return tex;
    }

    /** Upload the current <video> frame into the source texture. Returns true
     *  if the texture holds a sampleable frame. CRITICAL: this is NOT gated on
     *  playbackRate. We gate only on readyState >= HAVE_CURRENT_DATA (a frame
     *  exists) + skip redundant uploads when rVFC says no new frame is ready
     *  — so the upload cadence tracks the element's decode cadence at ANY
     *  speed (the #291 fix). The first upload always runs so a paused
     *  element still streams its first decoded frame downstream. */
    function uploadIfReady(): boolean {
      if (!videoEl) return false;
      if (videoEl.readyState < 2) return false; // HAVE_CURRENT_DATA
      if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return false;

      // rVFC wired + already uploaded once + no new frame queued -> the
      // texture already holds the latest frame; skip the GPU upload (cheap).
      // We do NOT consult playbackRate here at all.
      if (rvfcSupported && !frameDirty && sourceTexAllocated) return true;
      frameDirty = false;

      const tex = ensureSourceTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        // Full texImage2D (re-spec) each upload rather than texSubImage2D —
        // the object-URL <video> path raised GL_INVALID_OPERATION on
        // texSubImage2D in this WebGL2 context (see VIDEOBOX #288), freezing
        // the texture at its first black upload. A same-size re-spec is a
        // cheap in-place driver update; correctness wins for a file player.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
        sourceTexAllocated = true;
        uploadCount++;
      } catch (err) {
        console.warn('[videovarispeed] texImage2D failed:', err);
        return false;
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      return true;
    }

    function wireAudio(): void {
      if (audioWired) return;
      if (!ctx.audioCtx) return;
      if (!videoEl) return;
      const ac = ctx.audioCtx;
      try {
        // Build the silent keep-alive (src -> gain(0) -> destination + resume
        // a suspended context). It also hands back the MediaElementSource so we
        // fan it into our splitter for audio_l / audio_r. The keep-alive is THE
        // fix for the multi-video throttle: without a path to the destination
        // the element is never pulled and Chromium drops its decode to ~1 fps.
        const ka = createVideoAudioKeepAlive(ac, videoEl);
        const split = ac.createChannelSplitter(2);
        ka.source.connect(split);
        keepAlive = ka;
        mediaElSrc = ka.source;
        splitter = split;
        audioSources.set('audio_l', { node: split, output: 0 });
        audioSources.set('audio_r', { node: split, output: 1 });
        audioWired = true;
        // The audio_l / audio_r nodes just changed identity (silent
        // ConstantSource -> live splitter). Any cross-domain audio bridge that
        // was connected to the placeholder before this swap (e.g. a saved patch
        // where audio_l -> AUDIO OUT predates the file load) is now stale; ask
        // the engine to re-resolve it so the splitter reaches the destination.
        ctx.notifyAudioSourcesChanged?.(node.id);
      } catch (err) {
        // InvalidStateError: the element already has a MediaElementSource (card
        // hot-reload). Stay on the silent CSN fallback so downstream audio
        // patches don't pop.
        console.warn('[videovarispeed] createMediaElementSource failed:', err);
      }
    }

    function unwireAudio(): void {
      if (keepAlive) keepAlive.disconnect();
      if (splitter) try { splitter.disconnect(); } catch { /* */ }
      if (mediaElSrc) try { mediaElSrc.disconnect(); } catch { /* */ }
      keepAlive = null;
      mediaElSrc = null;
      splitter = null;
      const wasWired = audioWired;
      audioWired = false;
      if (silentLeft && silentRight) {
        audioSources.set('audio_l', { node: silentLeft, output: 0 });
        audioSources.set('audio_r', { node: silentRight, output: 0 });
      }
      // Reverted audio_l / audio_r back to the silent placeholders; re-resolve
      // any bridge so it tracks the placeholder rather than the now-disconnected
      // splitter (keeps downstream from popping on a dangling node).
      if (wasWired) ctx.notifyAudioSourcesChanged?.(node.id);
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        const uploaded = uploadIfReady();

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasInput, uploaded ? 1.0 : 0.0);

        // Aspect-preserving letterbox: fit the source's native aspect into
        // the engine FBO (currently 4:3) so a non-matching clip isn't
        // stretched. sx/sy <= 1; the shorter axis gets bars. Defaults to
        // (1,1) when dimensions are unknown (idle / pre-metadata).
        let lbX = 1.0;
        let lbY = 1.0;
        if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
          const fboAspect = ctx.res.width / ctx.res.height;
          const srcAspect = videoEl.videoWidth / videoEl.videoHeight;
          // Wider source than FBO -> shrink height (letterbox top/bottom).
          // Narrower source -> shrink width (pillarbox left/right).
          lbX = Math.min(1.0, srcAspect / fboAspect);
          lbY = Math.min(1.0, fboAspect / srcAspect);
        }
        g.uniform2f(uLetterbox, lbX, lbY);

        if (uploaded && sourceTexture) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, sourceTexture);
          g.uniform1i(uTex, 0);
        }

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        detachRvfc();
        unwireAudio();
        if (silentLeft) try { silentLeft.disconnect(); } catch { /* */ }
        if (silentRight) try { silentRight.disconnect(); } catch { /* */ }
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(outTexture);
        if (sourceTexture) gl.deleteTexture(sourceTexture);
        gl.deleteProgram(program);
        sourceTexture = null;
        sourceTexAllocated = false;
        videoEl = null;
      },
    };

    const extras: VideoVarispeedHandleExtras = {
      wireAudio,
      unwireAudio,
      isAudioWired: () => audioWired,
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
        // Gate edge-detection is owned by the card (it polls readParam).
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind !== 'video') return;
        // New element -> tear down rVFC + audio so the old element doesn't
        // linger; force a re-spec on the first upload against new dimensions.
        detachRvfc();
        if (videoEl !== el) unwireAudio();
        sourceTexAllocated = false;
        videoEl = (el as HTMLVideoElement) ?? null;
        if (videoEl) attachRvfc();
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'audioWired') return audioWired;
        // Keep-alive instrumentation: lets the e2e assert the silent
        // gain(0)->destination bridge is live (the thing that stops the
        // <video> decode from throttling when N sources are unpatched).
        if (key === 'hasKeepAlive') return keepAlive !== null;
        if (key === 'rvfcSupported') return rvfcSupported;
        // Engine-internal liveness for e2e: how many real frame uploads this
        // source has done. Sampling this over a step()-driven window proves the
        // decode->upload path is alive deterministically, without reading
        // software-GL framebuffer pixels.
        if (key === 'uploadCount') return uploadCount;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
