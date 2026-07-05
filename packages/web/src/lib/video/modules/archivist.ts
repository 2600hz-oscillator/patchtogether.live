// packages/web/src/lib/video/modules/archivist.ts
//
// ARCHIVIST — universal Internet Archive (archive.org) media source.
//
// Searches archive.org and streams a RANDOM matching item — image, audio,
// OR video — with scrubbing/seeking for time-based media. Modeled on
// VIDEOBOX (a VIDEO-domain module that already supports a cross-domain audio
// bridge + a <video>/<img> element attached via attachExternalSource + a
// WebGL FBO texture output), but the source is a URL chosen from a search
// instead of a local file.
//
// PER-TYPE CORS-FOR-USE (verified 2026-06-14, see
// .myrobots/plans/archivist-module-2026-06-14.md):
//   image → CORS-clean served file → crossorigin=anonymous <img> → UNTAINTED
//           WebGL texture → real `image` output.
//   audio → CORS-clean served file → crossorigin=anonymous MediaElementSource
//           → UNTAINTED Web-Audio analysis + routing → real audio output.
//   video → served file LACKS CORS on the final hop → a crossorigin <video>
//           fails CORS → texImage2D(<video>) taints → NO clean `video`
//           output. We PLAY + SCRUB it in the preview only; the texture
//           output stays the idle pattern and the card documents the limit.
//
// Search + metadata are CORS-open, so the card fetches them directly (no
// proxy). All query/parse/file-pick logic is in archivist-query.ts (pure).
//
// PLAYABLE-FILE PICKER: for VIDEO the picker (archivist-query.ts pickBestFile)
// ranks by the metadata `format` token, NOT just the container ext — an h.264
// derivative or a theora `.ogv` is chosen over an un-decodable MPEG-4-Part-2 /
// HEVC `.mp4` original, and items whose ONLY video is a non-HTML5 container
// (.mpeg/.avi/.mov/…) resolve to null so the card SKIPS them. Combined with the
// card's `waitForMeta` error+timeout + auto-advance, the card always lands on a
// playable item instead of hanging on "Loading" (the original v1 bug).
//
// CARD CHROME: the card uses the shared yellow drill-down PatchPanel (NO raw
// side handles — the #767 project-wide standard); every port below renders as a
// PatchPanel row with a byte-identical `id`.
//
// Inputs:
//   play_trigger (gate, paramTarget=cv_play_trigger): rising edge toggles
//       play/pause for time-media (no-op for an image).
//
// Outputs:
//   image   (image): the loaded still image as a texture (image type only).
//   video   (video): the loaded clip as a texture — DELIVERED ONLY when the
//       served file is CORS-clean. archive.org video is NOT, so for a loaded
//       VIDEO item this output stays idle (play-only); an IMAGE upcasts to
//       video (image→video is a free upcast) so it can drive video inputs.
//   audio_l / audio_r (audio): stereo audio from an AUDIO (or video) item,
//       routed via the cross-domain bridge. Clean for audio items.
//   loaded  (gate, edge=trigger): pulse when a new item finishes loading.
//   ended   (gate, edge=trigger): pulse when a time-media item reaches its end.
//   playing (gate, edge=gate): HIGH while a time-media item is playing.
//   playhead (cv): 0..1 normalized playhead position of time-media.
//
// Params:
//   gain (linear 0..2): reserved output gain (not consumed in v1).
//   cv_play_trigger (linear 0..1): synthetic edge-detector param mirroring
//       the play_trigger gate input (card edge-detects, like VIDEOBOX).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoFrameUploader } from '$lib/video/video-frame-upload';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';
import type { ArchivistMediaType } from './archivist-query';

// Passthrough shader with an idle pattern for an empty / play-only card —
// mirrors VIDEOBOX/CAMERA so the three source modules read consistently.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;

void main() {
  if (uHasInput < 0.5) {
    float v = vUv.y * 0.06;
    outColor = vec4(0.04, 0.05, 0.09 + v, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

/** Metadata about the currently-loaded item, mirrored on node.data so peers
 *  (and a reopened patch) can render the title/attribution + seekbar even
 *  without having re-fetched. The card is the only writer. */
export interface ArchivistItemMeta {
  /** archive.org identifier. */
  identifier: string;
  /** Display title. */
  title: string;
  /** Concrete media type actually loaded. */
  type: Exclude<ArchivistMediaType, 'any'>;
  /** The chosen file URL (CDN / download). */
  fileUrl: string;
  /** Duration in seconds (0 for images / unknown). */
  duration: number;
  /** Whether this type can deliver a clean downstream output. */
  cleanOutput: boolean;
}

/** Persisted shape on node.data (Yjs-CRDT). */
export interface ArchivistData {
  /** Last search term (so a reopened card shows what was searched). */
  searchTerm: string;
  /** Selected media-type filter. */
  mediaType: ArchivistMediaType;
  /** Year range (null = open). */
  yearFrom: number | null;
  yearTo: number | null;
  /** Currently-loaded item (null until something loads). */
  item: ArchivistItemMeta | null;
  /** Shared play state (multiplayer, mirrors VIDEOBOX). */
  isPlaying: boolean;
  /** Card size. */
  width?: number;
  height?: number;
}

export const ARCHIVIST_DATA_DEFAULTS: ArchivistData = {
  searchTerm: '',
  mediaType: 'video',
  yearFrom: null,
  yearTo: null,
  item: null,
  isPlaying: false,
};

/** Handle extras — the card drives audio wiring + gate firing through these. */
export interface ArchivistHandleExtras {
  /** Wire a freshly-loaded <audio>/<video> element's audio into the bridge. */
  wireAudio(): void;
  /** Tear the audio graph down (item unloaded / element swapped). */
  unwireAudio(): void;
  isAudioWired(): boolean;
  /** Fire the `loaded` trigger (a short pulse). Card calls on each new item. */
  fireLoaded(): void;
  /** Fire the `ended` trigger. Card calls on the element's `ended` event. */
  fireEnded(): void;
  /** Set the `playing` gate level (HIGH while time-media plays). */
  setPlaying(on: boolean): void;
  /** Set the `playhead` CV (0..1). Card updates each frame while playing. */
  setPlayhead(frac01: number): void;
}

interface ArchivistParams {
  gain: number;
  cv_play_trigger: number;
}

const DEFAULTS: ArchivistParams = { gain: 1.0, cv_play_trigger: 0 };

export const archivistDef: VideoModuleDef = {
  type: 'archivist',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'archivist',
  category: 'sources',
  inputs: [
    // Rising edge toggles play/pause (mirrors VIDEOBOX's synthetic-param path).
    { id: 'play_trigger', type: 'gate', paramTarget: 'cv_play_trigger', edge: 'gate' },
  ],
  outputs: [
    { id: 'image',    type: 'image' },
    { id: 'video',    type: 'video' },
    { id: 'audio_l',  type: 'audio' },
    { id: 'audio_r',  type: 'audio' },
    // loaded/ended fire ONCE per event (rising edge) → triggers.
    { id: 'loaded',   type: 'gate', edge: 'trigger' },
    { id: 'ended',    type: 'gate', edge: 'trigger' },
    // playing is level-sensitive (held while playing) → gate.
    { id: 'playing',  type: 'gate', edge: 'gate' },
    // normalized playhead position.
    { id: 'playhead', type: 'cv' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
    { id: 'cv_play_trigger', label: 'Play trigger', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "ARCHIVIST is a universal Internet Archive (archive.org) media source for the VIDEO domain. You pick a media type (image / audio / video / any) and a search term (plus an optional year-from/year-to range), and the card runs an archive.org advancedsearch query, picks a RANDOM matching public item, and loads it into a resizable preview. Restricted/lending items are always excluded from the query, and the file picker only chooses HTML5-playable derivatives (jpg/png/gif/webp for images; mp3/ogg/m4a/flac/wav for audio; h.264/theora/webm-class video, rejecting bare MPEG-4-Part-2 / HEVC), auto-advancing to another random match if a chosen derivative will not decode — so it lands on something that plays instead of hanging on \"Loading\". CORS BEHAVIOR IS PER-TYPE: only IMAGE and AUDIO items are CORS-clean and deliver real downstream signal — an image becomes a clean WebGL texture on the `image` output (and free-upcasts to `video` so it can drive video inputs), and an audio item routes clean stereo to `audio_l`/`audio_r` via the cross-domain audio bridge. VIDEO items are PLAY-ONLY: archive.org video lacks CORS on the served file, so the texture is tainted and the `video` output stays the idle pattern (the card shows a \"play-only (no clean output)\" warning), and a video item's audio track is likewise CORS-tainted so its audio jacks are effectively dead. So archivist is video-output-only for VIDEO items, but its audio jacks ARE live and clean for genuine AUDIO items. Search and metadata are CORS-open and fetched directly with no proxy. Usage: choose \"image\" to feed clean stills into the video graph, or \"audio\" to pull found-sound stereo into the audio graph; use \"video\" only for in-card preview/scrubbing. Multiplayer-aware: the loaded item, search inputs, and play state mirror on the node so peers see and drive the same item. The card is corner-drag resizable (handle bottom-right, min 360x360, default 360x540), with a 16:9 preview screen inside showing the loaded image, the playing video, or a cover-art placeholder for audio items.",
    inputs: {
      play_trigger: "Gate input (declared edge=gate, routed on the gate cable): the card reads its level and toggles play/pause for the loaded time-media item (audio or video) when the level crosses above mid-scale (high). No-op for an image item. It targets the cv_play_trigger param internally, so the same toggle can be driven from that synthetic param.",
    },
    outputs: {
      image: "Image-type texture output carrying the loaded still image as a clean WebGL texture. Live only for IMAGE items (archive.org images are CORS-clean); idle pattern otherwise.",
      video: "Video-type texture output. An IMAGE item free-upcasts here to drive video inputs. For an actual VIDEO item this stays the idle pattern because archive.org video is CORS-tainted (play-only, no clean texture).",
      audio_l: "Left channel of stereo audio, routed via the cross-domain audio bridge (channel splitter on a MediaElementSource). Live and clean for AUDIO items; for VIDEO items the audio track is CORS-tainted so it is best-effort / typically dead; silent for images.",
      audio_r: "Right channel of stereo audio (same bridge/splitter as audio_l, output 1). Live and clean for AUDIO items only; dead for video items and images.",
      loaded: "Trigger out (edge=trigger): a short rising-edge pulse fired once each time a new item finishes loading and attaching.",
      ended: "Trigger out (edge=trigger): a short rising-edge pulse fired once when a time-media item plays through to its `ended` event.",
      playing: "Gate out (edge=gate): held HIGH while a time-media item is actively playing (not paused, not ended); LOW otherwise.",
      playhead: "CV out: the normalized 0..1 playback position of the loaded time-media item, updated each frame while playing/seeking.",
    },
    controls: {
      gain: "Output gain, linear 0..2 (default 1). Reserved in v1 — declared on the module but not yet consumed in the signal path.",
      cv_play_trigger: "Synthetic edge-detector param (linear 0..1, default 0) mirroring the play_trigger gate input; the card polls it and edge-detects a rising crossing of mid-scale (0.5) to toggle play/pause. Normally driven through the play_trigger jack rather than directly.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    const { fbo, texture: outTexture } = ctx.createFbo();

    // VIDEO frame pump (rVFC-driven, downscaled). Only attached for a loaded
    // VIDEO element whose source is CORS-CLEAN — which archive.org video is
    // NOT, so in practice the video texture stays idle for archive video.
    // (We keep the uploader so a future clean-video path / proxy can use it.)
    const uploader = createVideoFrameUploader({
      gl,
      width: ctx.res.width,
      height: ctx.res.height,
    });
    let videoEl: HTMLVideoElement | null = null;

    // IMAGE: a one-shot texture uploaded from an <img> when attached. Used as
    // the sampled source whenever an image is loaded (CORS-clean).
    let imageTex: WebGLTexture | null = null;
    let imageReady = false;

    const params: ArchivistParams = { ...DEFAULTS };

    // ---- Audio plumbing (mirrors VIDEOBOX) ----
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let silentLeft: ConstantSourceNode | null = null;
    let silentRight: ConstantSourceNode | null = null;
    let mediaElSrc: MediaElementAudioSourceNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
    let keepAlive: VideoAudioKeepAlive | null = null;
    let audioWired = false;
    // The media element whose audio we wire — for archivist this is the SAME
    // element the card plays (an <audio> for audio items, a <video> for video).
    let mediaEl: HTMLMediaElement | null = null;

    // ---- Gate / CV outputs (ConstantSourceNodes, mirrors DRUMSEQZ) ----
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

    /** Emit a short rising-edge pulse on a ConstantSource (trigger). */
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
      if (!mediaEl) return;
      const ac = ctx.audioCtx;
      try {
        // createVideoAudioKeepAlive is typed for HTMLVideoElement, but the
        // underlying createMediaElementSource accepts ANY HTMLMediaElement
        // (an <audio> element works identically). For audio items mediaEl is
        // an <audio>; the cast is runtime-safe.
        const ka = createVideoAudioKeepAlive(ac, mediaEl as HTMLVideoElement);
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
        console.warn('[archivist] createMediaElementSource failed:', err);
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

    /** Upload an <img> to imageTex (one-shot). Tolerates a tainted image by
     *  catching the SecurityError — archive.org images are CORS-clean so this
     *  succeeds; the catch is defensive for any future non-CORS image source. */
    function uploadImage(img: HTMLImageElement): void {
      if (!imageTex) {
        imageTex = gl.createTexture();
      }
      if (!imageTex) return;
      try {
        gl.bindTexture(gl.TEXTURE_2D, imageTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.bindTexture(gl.TEXTURE_2D, null);
        imageReady = true;
      } catch (err) {
        // SecurityError on a tainted image — leave imageReady false so the
        // output stays the idle pattern instead of throwing.
        console.warn('[archivist] image texture upload failed (tainted?):', err);
        imageReady = false;
      }
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        // Prefer an image texture (clean), else a clean video frame (rare for
        // archive video). Video is play-only, so uploadIfReady stays idle for
        // a tainted element (the card never attaches a tainted video here).
        let haveTex = false;
        let texToBind: WebGLTexture | null = null;
        if (imageReady && imageTex) {
          haveTex = true;
          texToBind = imageTex;
        } else {
          const uploaded = uploader.uploadIfReady();
          if (uploaded && uploader.texture) {
            haveTex = true;
            texToBind = uploader.texture;
          }
        }

        g.uniform1f(uHasInput, haveTex ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE0);
        if (haveTex && texToBind) {
          g.bindTexture(g.TEXTURE_2D, texToBind);
          g.uniform1i(uTex, 0);
        }
        ctx.drawFullscreenQuad();
        // Unbind the sampled texture from the unit BEFORE detaching the FBO so
        // the engine's downstream/preview pass — which samples THIS node's
        // outTexture — can't form a framebuffer↔active-texture feedback loop
        // (the "Feedback loop formed" GL_INVALID_OPERATION spam).
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
        if (imageTex) gl.deleteTexture(imageTex);
        uploader.dispose();
        gl.deleteProgram(program);
        videoEl = null;
        mediaEl = null;
      },
    };

    const extras: ArchivistHandleExtras = {
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
        // cv_play_trigger edge detection is owned by the card (mirrors VIDEOBOX).
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind === 'image') {
          // Reset the video path; image is the active source.
          if (videoEl) { uploader.detach(); videoEl = null; }
          if (mediaEl !== el) unwireAudio();
          mediaEl = null; // images have no audio track
          const img = (el as HTMLImageElement) ?? null;
          imageReady = false;
          if (img) {
            // The element may already be decoded (complete) or fire `load`
            // later; the card calls attach AFTER load, so upload immediately
            // if complete, else the card re-attaches on load.
            if (img.complete && img.naturalWidth > 0) uploadImage(img);
          }
          return;
        }
        if (kind === 'video') {
          // NOTE: archive.org video is CORS-tainted, so the card attaches the
          // <video> for PLAYBACK + audio only — NOT for texturing. It passes
          // the element here so we can wire its audio track (video items have
          // audio). We do NOT uploader.attach() a tainted element (that would
          // throw a SecurityError on texImage2D). A future clean-video/proxy
          // path would call attachVideoTexture below.
          imageReady = false;
          if (imageTex) { /* keep allocated; just stop sampling it */ }
          const vid = (el as HTMLVideoElement) ?? null;
          if (mediaEl !== vid) unwireAudio();
          videoEl = null; // not textured
          mediaEl = vid;
          return;
        }
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasImage') return imageReady;
        if (key === 'hasMediaElement') return mediaEl !== null;
        if (key === 'audioWired') return audioWired;
        if (key === 'hasKeepAlive') return keepAlive !== null;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
