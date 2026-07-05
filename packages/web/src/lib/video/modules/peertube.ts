// packages/web/src/lib/video/modules/peertube.ts
//
// PEERTUBE — federated-video SOURCE. Search the PeerTube fediverse (via Sepia
// Search) → pick a video → its per-instance HLS master playlist (.m3u8) is
// attached (by the card, via hls.js) to a card-owned <video crossorigin=anonymous>
// → the engine samples it into the FBO (a CLEAN `video` texture) AND extracts
// stereo audio (audio_l / audio_r via MediaElementSource → ChannelSplitter).
//
// WHY THE VIDEO TEXTURE IS CLEAN (unlike ARCHIVIST's archive.org video — verified
// research GREEN): PeerTube sends `Access-Control-Allow-Origin: *` on the FINAL
// media hop (master .m3u8 + fragmented-mp4 / mpeg-ts segments) under a favorable
// `credentialless` COEP posture, so a crossorigin <video> fed by hls.js both
// PLAYS and yields an UNTAINTED WebGL2 texture (+ analysable WebAudio). ~1/6
// instances misconfigure CORS (raw S3, no ACAO) → the element taints / fails to
// load; the CARD degrades to "display unavailable" + auto-skips (never taints the
// texture or hangs). This factory is the VIDEOBOX/TV-LIBRARIAN texture+audio
// pattern; the SEARCH/PICK/HLS-attach + transport live in the card.
//
// The factory is DOM-free + multiplayer-agnostic. The CARD owns hls.js, the
// <video> element, the Sepia search, the results UI, transport, and the
// node.data writes (synced to rack-mates). The factory owns the FBO + the frame
// uploader (shared video-frame-upload pump) + the audio splitter + the gate/CV
// OUTPUT ConstantSourceNodes, which the card drives via the handle extras.
//
// Inputs (gate, edge:'trigger', paramTarget — main-thread edge-detect in the
// card via $lib/audio/edge-detect createEdgeCounter; NEVER whole-buffer rescan):
//   play_trigger (cv_play_trigger): rising edge toggles play/pause.
//   next_trigger (cv_next_trigger): rising edge loads the next search result.
//
// Outputs:
//   video            (video): the live frame texture (untainted for ACAO streams).
//   audio_l/audio_r  (audio): stereo from the stream's audio track (MediaElementSource;
//                             silent ConstantSource placeholders until a stream attaches).
//   loaded  (gate, edge=trigger): one pulse when a new video finishes loading.
//   ended   (gate, edge=trigger): one pulse when the video reaches its end.
//   playing (gate, edge=gate):    HIGH while the video is actually playing.
//   playhead (cv):                0..1 normalized playhead position.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoFrameUploader } from '$lib/video/video-frame-upload';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';

// Passthrough shader with an idle pattern for an empty card — mirrors
// VIDEOBOX / TV-LIBRARIAN / ARCHIVIST so the source modules read consistently.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;

void main() {
  if (uHasInput < 0.5) {
    float v = vUv.y * 0.06;
    outColor = vec4(0.05, 0.04, 0.09 + v, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

/** Handle extras — the card drives audio wiring + gate/CV outputs through these. */
export interface PeerTubeHandleExtras {
  /** Wire the <video> element's audio into audio_l / audio_r. Call AFTER the
   *  element has a live src (hls attached + first frame). Idempotent. */
  wireAudio(): void;
  /** Tear down the MediaElementSource (stream swap / unmount). */
  unwireAudio(): void;
  isAudioWired(): boolean;
  /** Fire the `loaded` trigger output (one short rising-edge pulse). */
  fireLoaded(): void;
  /** Fire the `ended` trigger output. */
  fireEnded(): void;
  /** Set the `playing` gate output level (HIGH while playing). */
  setPlaying(on: boolean): void;
  /** Set the `playhead` CV output (0..1). */
  setPlayhead(frac01: number): void;
}

interface PeerTubeParams {
  gain: number;
  /** Synthetic edge-detector params for the two trigger inputs (the CV bridge
   *  writes the gate level here; the card reads + edge-detects). */
  cv_play_trigger: number;
  cv_next_trigger: number;
}

const DEFAULTS: PeerTubeParams = {
  gain: 1.0,
  cv_play_trigger: 0,
  cv_next_trigger: 0,
};

export const peertubeDef: VideoModuleDef = {
  type: 'peertube',
  // Explicit card override: the convention PascalCase('peertube') = 'PeertubeCard'
  // would lower-case the 'T'; the card file keeps the brand casing 'PeerTube', so
  // we name it here (lives on this def — zero shared-file edits).
  card: 'PeerTubeCard',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'peertube',
  category: 'sources',
  // No hard cap — a wall of federated screens is a legit use case (like VIDEOBOX
  // / TV-LIBRARIAN).
  inputs: [
    // play_trigger / next_trigger: gate (trigger) inputs routed through the
    // standard CV bridge as synthetic params so the engine setParam path catches
    // edges (mirrors VIDEOBOX play_trigger → cv_play_trigger + TV-LIBRARIAN
    // next/random). edge:'trigger' declares the consumer interpretation: fire
    // ONCE per rising edge (the card edge-detects via createEdgeCounter).
    { id: 'play_trigger', type: 'gate', edge: 'trigger', paramTarget: 'cv_play_trigger' },
    { id: 'next_trigger', type: 'gate', edge: 'trigger', paramTarget: 'cv_next_trigger' },
  ],
  outputs: [
    { id: 'video',   type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
    // loaded/ended fire ONCE per event (rising edge) → triggers.
    { id: 'loaded',  type: 'gate', edge: 'trigger' },
    { id: 'ended',   type: 'gate', edge: 'trigger' },
    // playing is level-sensitive (held while playing) → gate.
    { id: 'playing', type: 'gate', edge: 'gate' },
    // normalized playhead position.
    { id: 'playhead', type: 'cv' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
    // Hidden synthetic edge-detector params for the trigger inputs.
    { id: 'cv_play_trigger', label: 'Play trigger', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'cv_next_trigger', label: 'Next trigger', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `A federated-video SOURCE that streams public videos from the PeerTube fediverse. Type a term into the search box (debounced ~350ms, rate-limited to ~50 calls / 10s, optionally scoped to one instance) and the card queries Sepia Search — the CORS-open meta-index of the PeerTube federation — for a results list (title, channel@host, duration, thumbnail). Click a result and the card hits that instance's video-details API to resolve the HLS master playlist (.m3u8), then attaches it via hls.js (or progressive MP4 / Safari-native HLS) to a card-owned crossorigin video element. The engine samples that element into a WebGL framebuffer; the fragment shader is a straight passthrough of the live frame (and draws a dim near-black idle gradient when nothing is loaded), so the video out is a genuine downstream-usable texture, not play-only. Unlike ARCHIVIST (which is VIDEO-ONLY because archive.org's final media hop is CORS-tainted, so its audio jacks are dead), PeerTube sends Access-Control-Allow-Origin:* on the master playlist + segments, so the texture is UNTAINTED and the stereo audio track is fully extractable and patchable on audio_l/audio_r (split from a MediaElementSource via a 2-channel splitter, with a silent gain-0 keep-alive bridged to the destination that keeps the element decoding at full rate even when audio isn't patched). Frames upload at the source's decode cadence (requestVideoFrameCallback; Firefox falls back to a currentTime-advance check) downscaled to the engine resolution so a high-bitrate stream doesn't flood GPU texture traffic. Only the selection (selected host, video uuid, name) plus the last search term and optional instance host are persisted to the node so rack-mates resolve the SAME stream; ~1/6 instances misconfigure CORS (raw S3, no ACAO) and a stream that taints, errors, or stalls past a 14s timeout is marked "display unavailable" and auto-skips to the next result after a short beat rather than hanging. The card UI (none of these are module params) is: a search input + optional instance-host input, a "↻ next" button, the resizable 16:9 preview screen, a now-playing label with an attribution link to the watch page, a Play/Pause transport button with a playhead progress bar, a scrollable results list, and a Sepia Search / PeerTube attribution disclaimer. The card has a resizable 16:9 preview screen (bottom-right corner-drag handle, persisted size; default 360x540, min 360x360). Usage: drop it as a video source and feed its output into a mixer or any video module; patch a clock into next_trigger to channel-surf the results hands-free, and patch the loaded/ended event outs or playhead CV downstream to sequence around the playback.`,
    inputs: {
      play_trigger: "Trigger (gate cable, edge:'trigger'): a rising edge toggles the current video between play and pause. Routed through the CV bridge as the synthetic cv_play_trigger param, which the card polls + edge-detects (<0.5 -> >=0.5); it fires once per rising edge, not while held. Patch a clock or any gate here for hands-free transport.",
      next_trigger: "Trigger (gate cable, edge:'trigger'): a rising edge advances to the NEXT result in the search list (wrapping to the first; if the list is empty it re-runs the last search). Routed through the CV bridge as the synthetic cv_next_trigger param and edge-detected by the card; fires once per rising edge, not while held. Patch a clock here to channel-surf the results in time.",
    },
    outputs: {
      video: "The loaded stream's live frame as a video texture — untainted and downstream-usable because PeerTube sends CORS/ACAO on its media. Dim near-black idle gradient when nothing is loaded; goes to the auto-skip 'unavailable' fallback for a CORS-misconfigured instance.",
      audio_l: "Left channel of the stream's stereo audio (output 0 of the channel splitter fed by the video element's MediaElementSource — working audio, unlike ARCHIVIST). A silent ConstantSource (offset 0) placeholder until a stream attaches and the audio tap is wired.",
      audio_r: "Right channel of the stream's stereo audio (output 1 of the same channel splitter). A silent ConstantSource (offset 0) placeholder until a stream attaches and the audio tap is wired.",
      loaded: "Trigger out (gate cable, edge:'trigger'): one short ~5ms rising-edge pulse each time a newly selected video finishes loading and its audio is wired. Patch into a downstream clock/reset/sample-and-hold to react to a track change.",
      ended: "Trigger out (gate cable, edge:'trigger'): one short ~5ms rising-edge pulse when the playing video reaches its end. Patch into next_trigger (self or another source) to auto-advance, or into any downstream trigger consumer.",
      playing: "Gate out (gate cable, edge:'gate'): held HIGH while the video is actually playing, LOW while paused, loading, idle, or unavailable. Use as a run/transport gate for downstream modules.",
      playhead: "CV out: the normalized playback position, 0..1 (currentTime / duration), updated as the video plays. Patch into any CV destination to scrub or modulate downstream gear in sync with the video timeline.",
    },
    controls: {
      gain: "Gain — declared output-level param (0 to 2, linear; default 1.0). NOTE: like TV-LIBRARIAN, the passthrough shader has no uGain uniform and draw() never applies it, so the param is carried on the module but currently inert — it does not yet brighten or scale the video output.",
      cv_play_trigger: "Play trigger (hidden synthetic param, 0 to 1, default 0): the CV bridge writes the play_trigger input's gate level here; the card polls readParam and edge-detects a rising edge (<0.5 -> >=0.5) to toggle play/pause. Not a user-facing knob.",
      cv_next_trigger: "Next trigger (hidden synthetic param, 0 to 1, default 0): the CV bridge writes the next_trigger input's gate level here; the card polls readParam and edge-detects a rising edge to load the next search result. Not a user-facing knob.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    const { fbo, texture: outTexture } = ctx.createFbo();

    // rVFC-driven, engine-resolution-downscaled frame pump (shared with
    // VIDEOBOX / TV-LIBRARIAN). PeerTube streams carry ACAO, so the attached
    // <video> is UNTAINTED and yields a clean texture — we DO uploader.attach().
    const uploader = createVideoFrameUploader({
      gl,
      width: ctx.res.width,
      height: ctx.res.height,
    });
    let videoEl: HTMLVideoElement | null = null;

    const params: PeerTubeParams = { ...DEFAULTS };

    // ---- Audio plumbing (exact VIDEOBOX / TV-LIBRARIAN pattern) ----
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let silentLeft: ConstantSourceNode | null = null;
    let silentRight: ConstantSourceNode | null = null;
    let mediaElSrc: MediaElementAudioSourceNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
    let keepAlive: VideoAudioKeepAlive | null = null;
    let audioWired = false;

    // ---- Gate / CV OUTPUT ConstantSourceNodes ----
    // Created at t=0 + published to audioSources so a cable can anchor to them
    // before the first event (mirrors ARCHIVIST / TV-LIBRARIAN event gates). The
    // card drives them via the extras.
    let loadedSrc: ConstantSourceNode | null = null;
    let endedSrc: ConstantSourceNode | null = null;
    let playingSrc: ConstantSourceNode | null = null;
    let playheadSrc: ConstantSourceNode | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const mk = (): ConstantSourceNode => {
        const n = ac.createConstantSource();
        n.offset.setValueAtTime(0, ac.currentTime);
        n.start();
        return n;
      };
      const l = mk();
      const r = mk();
      silentLeft = l;
      silentRight = r;
      audioSources.set('audio_l', { node: l, output: 0 });
      audioSources.set('audio_r', { node: r, output: 0 });

      loadedSrc = mk();
      endedSrc = mk();
      playingSrc = mk();
      playheadSrc = mk();
      audioSources.set('loaded', { node: loadedSrc, output: 0 });
      audioSources.set('ended', { node: endedSrc, output: 0 });
      audioSources.set('playing', { node: playingSrc, output: 0 });
      audioSources.set('playhead', { node: playheadSrc, output: 0 });
    }

    /** Emit a short rising-edge pulse on a ConstantSource (canonical trigger
     *  width); a downstream edge-detector counts exactly one edge. */
    function pulse(src: ConstantSourceNode | null): void {
      if (!src || !ctx.audioCtx) return;
      const t = ctx.audioCtx.currentTime;
      src.offset.cancelScheduledValues(t);
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + TRIGGER_PULSE_S);
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
        console.warn('[peertube] createMediaElementSource failed:', err);
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
      if (wasWired) ctx.notifyAudioSourcesChanged?.(node.id);
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
        // Unbind before detaching the FBO so the downstream/preview pass that
        // samples THIS node's outTexture can't form a feedback loop.
        g.bindTexture(g.TEXTURE_2D, null);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      resize(w, h) {
        uploader.setSize(w, h);
      },
      dispose() {
        unwireAudio();
        if (silentLeft) try { silentLeft.disconnect(); } catch { /* */ }
        if (silentRight) try { silentRight.disconnect(); } catch { /* */ }
        if (loadedSrc) try { loadedSrc.disconnect(); } catch { /* */ }
        if (endedSrc) try { endedSrc.disconnect(); } catch { /* */ }
        if (playingSrc) try { playingSrc.disconnect(); } catch { /* */ }
        if (playheadSrc) try { playheadSrc.disconnect(); } catch { /* */ }
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(outTexture);
        uploader.dispose();
        gl.deleteProgram(program);
        videoEl = null;
      },
    };

    const extras: PeerTubeHandleExtras = {
      wireAudio,
      unwireAudio,
      isAudioWired: () => audioWired,
      fireLoaded: () => pulse(loadedSrc),
      fireEnded: () => pulse(endedSrc),
      setPlaying: (on) => {
        if (!playingSrc || !ctx.audioCtx) return;
        playingSrc.offset.setValueAtTime(on ? 1 : 0, ctx.audioCtx.currentTime);
      },
      setPlayhead: (frac01) => {
        if (!playheadSrc || !ctx.audioCtx) return;
        const v = Math.min(1, Math.max(0, Number.isFinite(frac01) ? frac01 : 0));
        playheadSrc.offset.setValueAtTime(v, ctx.audioCtx.currentTime);
      },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
        // cv_play_trigger / cv_next_trigger edge detection is owned by the card
        // (it polls readParam + applies play-toggle / next-result). We accept
        // the value here so the bridge can route it.
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
