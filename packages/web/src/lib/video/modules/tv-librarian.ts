// packages/web/src/lib/video/modules/tv-librarian.ts
//
// TV LIBRARIAN — international live-TV source. A country picker (2D world map)
// → channel list → HLS stream → an UNTAINTED video texture + stereo audio.
// Built on the VIDEOBOX pattern (external <video> element → engine FBO texture
// → `video` out + extracted stereo audio); the ONLY difference is the source:
// a remote HLS stream attached via hls.js (in the card) instead of a local
// object-URL file.
//
// Phase-0 spike (validated under the real /r/ COEP require-corp headers): a
// famelack <video crossorigin=anonymous> fed by hls.js (a) plays and (b)
// yields an untainted WebGL2 texture (readPixels with no SecurityError) for
// every sampled stream (6/6 played + untainted, 0 COEP-blocked). So `video`
// out is a genuine downstream-usable texture, not play-only. Streams lacking
// ACAO simply fail to load under COEP → the card marks them "unavailable" and
// auto-skips; they never taint or hang.
//
// The factory is DOM-free + multiplayer-agnostic. The CARD owns hls.js, the
// <video> element, the dataset fetch, the picker UI, and the channel-selection
// writes to node.data (synced to rack-mates). The factory owns the FBO + the
// frame uploader (shared video-frame-upload pump) + the audio splitter + the
// two gate OUTPUT ConstantSourceNodes (channel_changed / stream_online), which
// the card drives via the handle extras.
//
// Inputs (CV, optional — both play-only-safe triggers):
//   next   (gate, edge:'trigger', paramTarget=cv_next):   rising edge → next channel in country.
//   random (gate, edge:'trigger', paramTarget=cv_random): rising edge → random channel.
//
// Outputs:
//   video            (video):  the live frame texture (untainted for streams w/ ACAO).
//   audio_l/audio_r  (audio):  stereo from the stream's audio track (MediaElementSource).
//   channel_changed  (gate, edge:'trigger'): one pulse when a new channel is tuned.
//   stream_online    (gate, edge:'gate'):    high while the stream is actually playing.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoFrameUploader } from '$lib/video/video-frame-upload';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';

// Shader: passthrough of the source texture with a mute-time idle pattern so an
// empty card reads as "alive but empty" (mirrors VIDEOBOX / CAMERA idle look).
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;

void main() {
  if (uHasInput < 0.5) {
    float v = vUv.y * 0.05;
    outColor = vec4(0.05, 0.05, 0.09 + v, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

/** Metadata for a tuned channel, persisted so peers without the dataset loaded
 *  still render an informative label (and tune to the same stream). */
export interface TvChannelMeta {
  nanoid: string;
  name: string;
  /** The HLS stream URL (so a peer can attach hls.js to the same stream). */
  streamUrl: string;
  country: string;
  languages: string[];
}

/** Persisted shape on node.data. The CARD is the only writer (Yjs-CRDT type);
 *  the factory NEVER touches data. */
export interface TvLibrarianData {
  /** Selected country (UPPERCASE ISO-2), or null until the user picks one. */
  countryCode: string | null;
  /** The currently-tuned channel, or null. Carries name + url so peers tune too. */
  channel: TvChannelMeta | null;
}

export const TV_LIBRARIAN_DATA_DEFAULTS: TvLibrarianData = {
  countryCode: null,
  channel: null,
};

/** Handle extras — the card calls these to drive audio + the gate outputs. */
export interface TvLibrarianHandleExtras {
  /** Wire the <video> element's audio into audio_l / audio_r. Call AFTER the
   *  element has a live src (hls attached + first frame). Idempotent. */
  wireAudio(): void;
  /** Tear down the MediaElementSource (channel swap / unmount). */
  unwireAudio(): void;
  isAudioWired(): boolean;
  /** Pulse the channel_changed trigger output (one short rising edge). */
  pulseChannelChanged(): void;
  /** Drive the stream_online gate output high/low (level-sensitive). */
  setStreamOnline(on: boolean): void;
}

interface TvLibrarianParams {
  gain: number;
  /** Synthetic edge-detector params for the two trigger inputs (the bridge
   *  writes the gate level here; the card reads + edge-detects). */
  cv_next: number;
  cv_random: number;
}

const DEFAULTS: TvLibrarianParams = {
  gain: 1.0,
  cv_next: 0,
  cv_random: 0,
};

export const tvLibrarianDef: VideoModuleDef = {
  type: 'tvLibrarian',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'tv librarian',
  category: 'sources',
  schemaVersion: 1,
  // No hard cap — multiple "TVs" tuned to different countries is a legit
  // wall-of-screens use case (like VIDEOBOX).
  inputs: [
    // next / random: gate (trigger) inputs routed through the standard CV
    // bridge as synthetic params so the engine setParam path catches edges
    // (mirrors VIDEOBOX's play_trigger → cv_play_trigger). edge:'trigger'
    // declares the consumer interpretation (fire ONCE per rising edge).
    { id: 'next',   type: 'gate', edge: 'trigger', paramTarget: 'cv_next' },
    { id: 'random', type: 'gate', edge: 'trigger', paramTarget: 'cv_random' },
  ],
  outputs: [
    { id: 'video',   type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
    // channel_changed: a trigger pulse on each tune. stream_online: a held gate
    // (high while playing). edge declares the consumer interpretation.
    { id: 'channel_changed', type: 'gate', edge: 'trigger' },
    { id: 'stream_online',   type: 'gate', edge: 'gate' },
  ],
  params: [
    { id: 'gain',      label: 'Gain',         defaultValue: DEFAULTS.gain,   min: 0, max: 2, curve: 'linear' },
    // Hidden synthetic edge-detector params for the trigger inputs.
    { id: 'cv_next',   label: 'Next',         defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_random', label: 'Random',       defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    const { fbo, texture: outTexture } = ctx.createFbo();

    // rVFC-driven, engine-resolution-downscaled frame pump (shared with
    // VIDEOBOX). Replaces a per-tick full-res texImage2D(<video>) path.
    const uploader = createVideoFrameUploader({
      gl,
      width: ctx.res.width,
      height: ctx.res.height,
    });
    let videoEl: HTMLVideoElement | null = null;

    const params: TvLibrarianParams = { ...DEFAULTS };

    // ---- Audio plumbing (exact VIDEOBOX pattern) ----
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let silentLeft: ConstantSourceNode | null = null;
    let silentRight: ConstantSourceNode | null = null;
    let mediaElSrc: MediaElementAudioSourceNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
    let keepAlive: VideoAudioKeepAlive | null = null;
    let audioWired = false;

    // ---- Gate OUTPUT ConstantSourceNodes (channel_changed / stream_online) ----
    // Created at t=0 + published to audioSources so a cable can anchor to them
    // before the first event (mirrors DOOM's event gates). The card drives them
    // via the extras (pulseChannelChanged / setStreamOnline).
    let chChangedGate: ConstantSourceNode | null = null;
    let onlineGate: ConstantSourceNode | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const t0 = ac.currentTime;
      const l = ac.createConstantSource();
      l.offset.setValueAtTime(0, t0); l.start(); silentLeft = l;
      const r = ac.createConstantSource();
      r.offset.setValueAtTime(0, t0); r.start(); silentRight = r;
      audioSources.set('audio_l', { node: l, output: 0 });
      audioSources.set('audio_r', { node: r, output: 0 });

      const cc = ac.createConstantSource();
      cc.offset.setValueAtTime(0, t0); cc.start(); chChangedGate = cc;
      const og = ac.createConstantSource();
      og.offset.setValueAtTime(0, t0); og.start(); onlineGate = og;
      audioSources.set('channel_changed', { node: cc, output: 0 });
      audioSources.set('stream_online',   { node: og, output: 0 });
    }

    function wireAudio(): void {
      if (audioWired) return;
      if (!ctx.audioCtx) return;
      if (!videoEl) return;
      const ac = ctx.audioCtx;
      try {
        const ka = createVideoAudioKeepAlive(ac, videoEl);
        const split = ac.createChannelSplitter(2);
        ka.source.connect(split);
        keepAlive = ka;
        mediaElSrc = ka.source;
        splitter = split;
        audioSources.set('audio_l', { node: split, output: 0 });
        audioSources.set('audio_r', { node: split, output: 1 });
        audioWired = true;
        ctx.notifyAudioSourcesChanged?.(node.id);
      } catch (err) {
        console.warn('[tvLibrarian] createMediaElementSource failed:', err);
      }
    }

    function unwireAudio(): void {
      if (keepAlive) keepAlive.disconnect();
      if (splitter) try { splitter.disconnect(); } catch { /* */ }
      if (mediaElSrc) try { mediaElSrc.disconnect(); } catch { /* */ }
      keepAlive = null; mediaElSrc = null; splitter = null;
      const wasWired = audioWired;
      audioWired = false;
      if (silentLeft && silentRight) {
        audioSources.set('audio_l', { node: silentLeft, output: 0 });
        audioSources.set('audio_r', { node: silentRight, output: 0 });
      }
      if (wasWired) ctx.notifyAudioSourcesChanged?.(node.id);
    }

    function pulseChannelChanged(): void {
      if (!ctx.audioCtx || !chChangedGate) return;
      const ac = ctx.audioCtx;
      const t = ac.currentTime;
      // Short rising-edge pulse (canonical trigger width); a downstream
      // edge-detector counts exactly one edge.
      chChangedGate.offset.cancelScheduledValues(t);
      chChangedGate.offset.setValueAtTime(1, t);
      chChangedGate.offset.setValueAtTime(0, t + TRIGGER_PULSE_S);
    }

    function setStreamOnline(on: boolean): void {
      if (!ctx.audioCtx || !onlineGate) return;
      const ac = ctx.audioCtx;
      const t = ac.currentTime;
      onlineGate.offset.cancelScheduledValues(t);
      onlineGate.offset.setValueAtTime(on ? 1 : 0, t);
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        const uploaded = uploader.uploadIfReady();
        const sourceTexture = uploader.texture;
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
      resize(w, h) {
        uploader.setSize(w, h);
      },
      dispose() {
        unwireAudio();
        if (silentLeft) try { silentLeft.disconnect(); } catch { /* */ }
        if (silentRight) try { silentRight.disconnect(); } catch { /* */ }
        if (chChangedGate) try { chChangedGate.disconnect(); } catch { /* */ }
        if (onlineGate) try { onlineGate.disconnect(); } catch { /* */ }
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(outTexture);
        uploader.dispose();
        gl.deleteProgram(program);
        videoEl = null;
      },
    };

    const extras: TvLibrarianHandleExtras = {
      wireAudio,
      unwireAudio,
      isAudioWired: () => audioWired,
      pulseChannelChanged,
      setStreamOnline,
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
        // cv_next / cv_random edge detection is owned by the card (it polls
        // readParam + applies "next"/"random" channel selection). We accept the
        // value here so the bridge can route it.
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind !== 'video') return;
        if (videoEl !== el) unwireAudio();
        videoEl = (el as HTMLVideoElement) ?? null;
        if (videoEl) uploader.attach(videoEl);
        else uploader.detach();
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'audioWired') return audioWired;
        if (key === 'hasKeepAlive') return keepAlive !== null;
        if (key === 'uploadCount') return uploader.uploadCount;
        if (key === 'rvfcSupported') return uploader.rvfcSupported;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
