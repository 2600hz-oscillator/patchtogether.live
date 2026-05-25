// packages/web/src/lib/video/modules/videobox.ts
//
// VIDEOBOX — local-file video player with multiplayer playhead sync.
//
// The factory owns NO file decoding. The card UI handles the file
// picker + assigns the picked File to a card-owned HTMLVideoElement
// (object-URL). It hands that element to the engine module via
// `attachExternalSource('video', el)` — same pattern as CAMERA —
// after which the engine samples the element each frame into the
// output FBO + (if an AudioContext is present) wires a
// MediaElementAudioSourceNode → ChannelSplitter into the cross-domain
// audio bridge so audio_l / audio_r emit the file's audio track.
//
// Multiplayer: the playhead state (isPlaying / lastSyncTime /
// lastSyncPosition) lives on `node.data` and is written by whichever
// peer takes a play/pause/seek action. All peers read the same fields
// and run videobox-sync.ts's decideDriftCorrection to seek their local
// element. See the card for the wiring; the factory is multiplayer-
// agnostic.
//
// File metadata (name + duration) also lives on `data.fileMeta` so
// peers without a local copy can render an informative "{user} loaded
// {filename} — pick your own copy" message + a seekbar with the right
// duration.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import type { VideoboxFileMeta, VideoboxSyncState } from './videobox-sync';

// Shader: passthrough sample of the source texture, with a mute-time
// idle pattern so an empty card reads as "alive but empty" instead of
// "broken". Mirrors CAMERA's idle look so the two file-input modules
// are visually consistent.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;

void main() {
  if (uHasInput < 0.5) {
    float v = vUv.y * 0.05;
    outColor = vec4(0.05, 0.05, 0.08 + v, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

/** Persisted shape on node.data. The card is the only writer; the engine
 *  factory NEVER touches data (it's a Yjs-CRDT type that the card walks
 *  via the synced-store reactive proxy). */
export interface VideoboxData extends VideoboxSyncState {
  /** Metadata about the file the loader picked. Null until a peer picks
   *  a file. Peers without a local copy still display this. */
  fileMeta: VideoboxFileMeta | null;
  /** Transport mode: true = LOOP (jump to START at END), false = ONE-SHOT
   *  (stop at END). Shared across peers so the loop button + loop_toggle
   *  gate flip the same multiplayer-visible state. v2 schema field. */
  loop: boolean;
}

/** Default state stamped onto a freshly spawned VIDEOBOX. The schema
 *  migrate fills these in for any pre-migration (v1) nodes. */
export const VIDEOBOX_DATA_DEFAULTS: VideoboxData = {
  isPlaying: false,
  lastSyncTime: 0,
  lastSyncPosition: 0,
  fileMeta: null,
  loop: true,
};

/** Handle extras — the card calls these to drive the audio wiring once
 *  it knows the file is loaded into the <video> element. */
export interface VideoboxHandleExtras {
  /** Card invokes after the local <video> has loaded metadata + audio is
   *  actually present. Spinning up a MediaElementAudioSourceNode BEFORE
   *  the element has src set leaves a node that won't ever produce
   *  audio (the element's audio output is finalised at first load). */
  wireAudio(): void;
  /** Card invokes on file unload (user picked a new file, or component
   *  destroy). Tears down the MediaElementSource so the next wireAudio
   *  call against a new <video> element doesn't collide with the old
   *  graph. */
  unwireAudio(): void;
  /** True once wireAudio has succeeded (or fallen back to silent CSN). */
  isAudioWired(): boolean;
}

interface VideoboxParams {
  /** Reserved for future CV control; not consumed in v1. */
  gain: number;
  // ---- Transport (driven by the card; the factory only stores them so
  //      the engine setParam path + readParam round-trip works). ----
  /** Varispeed knob, normalized 0..1. 0=-4×, 0.5=+1×, 1=+4×. Default 0.5. */
  speed: number;
  /** START slider, fraction of duration 0..1. Default 0 = beginning. */
  start: number;
  /** END slider, fraction of duration 0..1. Default 1 = end of video. */
  end: number;
  // ---- CV inputs (bipolar -1..+1), kept SEPARATE from the knob/slider
  //      params so the cross-domain CV bridge (which writes the raw sample
  //      into setParam(paramTarget)) does not clobber the user's knob.
  //      The card reads both + combines them. ----
  speedCv: number;
  startCv: number;
  endCv: number;
  // ---- Gate edge-detector params (synthetic; the bridge writes the gate
  //      level here, the card edge-detects). ----
  cv_play_trigger: number;
  cv_start: number;
  cv_pause: number;
  cv_reset: number;
  cv_loop_toggle: number;
}

const DEFAULTS: VideoboxParams = {
  gain: 1.0,
  speed: 0.5,
  start: 0,
  end: 1,
  speedCv: 0,
  startCv: 0,
  endCv: 0,
  cv_play_trigger: 0,
  cv_start: 0,
  cv_pause: 0,
  cv_reset: 0,
  cv_loop_toggle: 0,
};

/** Schema migrate. v1 → v2 adds the transport fields. Old node.data lacked
 *  `loop`; default it to true (loop on) so legacy patches keep looping —
 *  the prior behavior let the element run to its native end + stop, but
 *  loop=true is the friendlier default for the new window. We only touch
 *  data we own; unknown keys pass through. Param values themselves are
 *  filled by the factory's DEFAULTS spread, so no param migration is
 *  needed (play_trigger is unchanged — existing patches keep working). */
export function migrateVideobox(data: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2) return data;
  if (!data || typeof data !== 'object') return data;
  const obj = data as Record<string, unknown>;
  if (typeof obj.loop !== 'boolean') obj.loop = true;
  return obj;
}

export const videoboxDef: VideoModuleDef = {
  type: 'videobox',
  domain: 'video',
  label: 'VIDEOBOX',
  category: 'sources',
  schemaVersion: 2,
  migrate: migrateVideobox,
  // No cap — files are user-supplied + sized; multiple cards on one rack
  // are a legitimate "switcher" use case.
  inputs: [
    // --- Gate inputs (rising-edge). Each routes through the standard CV
    //     bridge into a synthetic cv_<x> param; the card polls + edge-
    //     detects (mirrors DOOM's cv-gate plumbing). port id == paramTarget
    //     per the PR #264 convention. ---
    // play_trigger: legacy toggle-play gate (kept so existing patches keep
    // working — DON'T rename).
    { id: 'play_trigger',  type: 'gate', paramTarget: 'cv_play_trigger' },
    // start: (re)start playback from the START point.
    { id: 'cv_start',       type: 'gate', paramTarget: 'cv_start' },
    // pause: toggle pause / unpause.
    { id: 'cv_pause',       type: 'gate', paramTarget: 'cv_pause' },
    // reset: seek to the START point (= the reset-to position).
    { id: 'cv_reset',       type: 'gate', paramTarget: 'cv_reset' },
    // loop_toggle: flip LOOP <-> ONE-SHOT on rising edge.
    { id: 'cv_loop_toggle', type: 'gate', paramTarget: 'cv_loop_toggle' },
    // --- CV inputs (bipolar -1..+1). Separate paramTargets from the
    //     knob/slider params so the bridge's raw-sample write doesn't
    //     clobber the user's setting; the card sums them. ---
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
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
    // Transport user params. speed: 0..1 normalized knob (0.5 = +1×).
    // start/end: fraction of duration 0..1 (start default 0, end default 1).
    { id: 'speed', label: 'Speed', defaultValue: DEFAULTS.speed, min: 0, max: 1, curve: 'linear' },
    { id: 'start', label: 'Start', defaultValue: DEFAULTS.start, min: 0, max: 1, curve: 'linear' },
    { id: 'end',   label: 'End',   defaultValue: DEFAULTS.end,   min: 0, max: 1, curve: 'linear' },
    // CV target params (bipolar). curve:linear so setParam values arrive raw.
    { id: 'speedCv', label: 'Speed CV', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'startCv', label: 'Start CV', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'endCv',   label: 'End CV',   defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    // Edge-detector params for the gate inputs. Hidden from the card UI
    // (the ports render as gate handles). curve:linear so values arrive raw.
    { id: 'cv_play_trigger', label: 'Play trigger', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_start',        label: 'Start gate',   defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_pause',        label: 'Pause gate',   defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_reset',        label: 'Reset gate',   defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_loop_toggle',  label: 'Loop gate',    defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, _node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    const { fbo, texture: outTexture } = ctx.createFbo();

    let sourceTexture: WebGLTexture | null = null;
    let videoEl: HTMLVideoElement | null = null;

    const params: VideoboxParams = { ...DEFAULTS };

    // ---- Audio plumbing ----
    //
    // Default state: silent ConstantSourceNodes on both audio_l / audio_r
    // so the per-module output-alive smoke can resolve to SOMETHING (even
    // if it's a flat zero — the smoke explicitly skips VIDEOBOX, but
    // silence is the right invariant for downstream patching: a freshly
    // spawned card connected to AUDIO-OUT shouldn't blow up the graph).
    //
    // wireAudio() (called by the card after the <video> element has a
    // src + loaded metadata) swaps these for a MediaElementAudioSourceNode
    // → ChannelSplitter pair, so audio_l / audio_r emit the file's L/R
    // channels respectively. We DON'T spin up the MediaElementSource here
    // because creating it from an empty <video> element gives a graph
    // node that never emits audio even after src is later set — the spec
    // freezes the audio output at first call.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let silentLeft: ConstantSourceNode | null = null;
    let silentRight: ConstantSourceNode | null = null;
    let mediaElSrc: MediaElementAudioSourceNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
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

    function ensureSourceTexture(): WebGLTexture {
      if (sourceTexture) return sourceTexture;
      const tex = gl.createTexture();
      if (!tex) throw new Error('VIDEOBOX: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sourceTexture = tex;
      return tex;
    }

    function uploadIfReady(): boolean {
      if (!videoEl) return false;
      if (videoEl.readyState < 2) return false; // HAVE_CURRENT_DATA
      if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return false;

      const tex = ensureSourceTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        // Full texImage2D (re-spec) every frame rather than allocate-once
        // + texSubImage2D. The sub-image path raised GL_INVALID_OPERATION
        // on every update here (Chromium + this WebGL2 context), so the
        // texture stayed frozen at its first — black — upload and the
        // output read as black downstream even while the card's own
        // <video> kept playing. A `<video>` frame is the same size each
        // tick, so the driver treats a same-dimension re-spec as a cheap
        // in-place update; correctness wins over the marginal sub-image
        // saving for a file player. (CAMERA's webcam stream happens to
        // tolerate texSubImage2D; the file path does not — we don't rely
        // on that quirk.)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
      } catch (err) {
        // texImage2D on a same-origin object-URL video shouldn't tripwire
        // CORS, but log + skip if something else fails (mid-stream pause
        // can briefly null out the source).
        console.warn('[videobox] texImage2D failed:', err);
        return false;
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      return true;
    }

    function wireAudio(): void {
      if (audioWired) return;
      if (!ctx.audioCtx) return;        // no audio engine; stay silent
      if (!videoEl) return;             // need an element first
      const ac = ctx.audioCtx;
      try {
        // MediaElementAudioSourceNode freezes its output at construction
        // — the video element's audio is hijacked into the Web Audio
        // graph + does NOT play through the element's own native output.
        // That's what we want: the file's audio flows ONLY through our
        // audio_l / audio_r → downstream patching.
        const src = ac.createMediaElementSource(videoEl);
        const split = ac.createChannelSplitter(2);
        src.connect(split);
        mediaElSrc = src;
        splitter = split;
        audioSources.set('audio_l', { node: split, output: 0 });
        audioSources.set('audio_r', { node: split, output: 1 });
        audioWired = true;
      } catch (err) {
        // InvalidStateError: this video element already has a MediaElement
        // source attached (happens if the card hot-reloads). Stay on the
        // silent CSN fallback so downstream audio patches don't pop.
        console.warn('[videobox] createMediaElementSource failed:', err);
      }
    }

    function unwireAudio(): void {
      if (splitter) try { splitter.disconnect(); } catch { /* */ }
      if (mediaElSrc) try { mediaElSrc.disconnect(); } catch { /* */ }
      mediaElSrc = null;
      splitter = null;
      audioWired = false;
      // Reinstate the silent fallback so audio_l / audio_r still resolve
      // to a live node for any cables wired after the unwire.
      if (silentLeft && silentRight) {
        audioSources.set('audio_l', { node: silentLeft, output: 0 });
        audioSources.set('audio_r', { node: silentRight, output: 0 });
      }
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

        if (uploaded && sourceTexture) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, sourceTexture);
          g.uniform1i(uTex, 0);
        }

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        unwireAudio();
        if (silentLeft) try { silentLeft.disconnect(); } catch { /* */ }
        if (silentRight) try { silentRight.disconnect(); } catch { /* */ }
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(outTexture);
        if (sourceTexture) gl.deleteTexture(sourceTexture);
        gl.deleteProgram(program);
        sourceTexture = null;
        videoEl = null;
      },
    };

    const extras: VideoboxHandleExtras = {
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
        // cv_play_trigger edge detection is owned by the card (it watches
        // the param via readParam + applies the toggle to data.isPlaying).
        // We accept the value here so the bridge can route it, but the
        // factory doesn't need to act on it — the card already drives
        // play/pause through the data write path.
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind !== 'video') return;
        // New element → tear down the audio graph so the old element's
        // MediaElementSource doesn't linger. The per-frame texImage2D
        // re-specs the texture against the live element's dimensions, so
        // there's no allocation flag to reset.
        if (videoEl !== el) unwireAudio();
        videoEl = (el as HTMLVideoElement) ?? null;
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'audioWired') return audioWired;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
