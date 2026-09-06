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
//
// Inputs:
//   play_trigger (gate, paramTarget=cv_play_trigger): rising edge toggles play / pause.
//
// Outputs:
//   video (video): the decoded video frames.
//   audio_l / audio_r (audio): stereo audio extracted from the file's audio track.
//
// Params:
//   gain (linear 0..2): output gain.
//   cv_play_trigger (linear 0..1): rising edge mirrors the play_trigger gate input.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoFrameUploader } from '$lib/video/video-frame-upload';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
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
uniform float uGain;       // post-multiplier on RGB

void main() {
  if (uHasInput < 0.5) {
    float v = vUv.y * 0.05;
    outColor = vec4(0.05, 0.05, 0.08 + v, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, vUv).rgb * uGain, 1.0);
}`;

/** Persisted shape on node.data. The card is the only writer; the engine
 *  factory NEVER touches data (it's a Yjs-CRDT type that the card walks
 *  via the synced-store reactive proxy). */
export interface VideoboxData extends VideoboxSyncState {
  /** Metadata about the file the loader picked. Null until a peer picks
   *  a file. Peers without a local copy still display this. */
  fileMeta: VideoboxFileMeta | null;
}

/** Default state stamped onto a freshly spawned VIDEOBOX. The schema
 *  migrate fills these in for any pre-migration nodes (none exist yet —
 *  this is the v1 schema). */
export const VIDEOBOX_DATA_DEFAULTS: VideoboxData = {
  isPlaying: false,
  lastSyncTime: 0,
  lastSyncPosition: 0,
  fileMeta: null,
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
  /** Output gain — the uGain post-multiplier on the sampled RGB. 1.0 = identity. */
  gain: number;
  /** Edge-detector param for the play_trigger gate (synthetic; the bridge
   *  writes the gate level here, the card edge-detects). */
  cv_play_trigger: number;
}

const DEFAULTS: VideoboxParams = {
  gain: 1.0,
  cv_play_trigger: 0,
};

export const videoboxDef: VideoModuleDef = {
  type: 'videobox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'videobox',
  category: 'sources',
  // No cap — files are user-supplied + sized; multiple cards on one rack
  // are a legitimate "switcher" use case.
  inputs: [
    // play_trigger: gate input — pulse to toggle play/pause. Routed
    // through the standard CV bridge as a synthetic param so the
    // engine setParam path catches edges (mirrors DOOM's cv-gate
    // plumbing).
    { id: 'play_trigger', type: 'gate', edge: 'trigger', paramTarget: 'cv_play_trigger' },
  ],
  outputs: [
    { id: 'video',   type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
    // Edge-detector param for the play_trigger gate. Hidden from the
    // card UI (the port renders as a gate handle via the standard port
    // row). curve:linear so setParam values arrive raw.
    { id: 'cv_play_trigger', label: 'Play trigger', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation: "videobox is a local-file VIDEO PLAYER: you drop (or pick) a video file from disk and it decodes the file each frame into the module's video output, while the file's stereo audio track is split out to the audio_l / audio_r jacks for patching back into the audio domain. The NODE owns the actual HTMLVideoElement and object-URL (a node-scoped controller created with the graph — the file keeps playing with no surface mounted at all); the engine samples that element through a decode-rate frame uploader (only re-uploading when a genuinely new frame lands, downscaled to the engine resolution) so playback stays smooth even at 1080p. Behind the file picker the surface uses File System Access handles (Chromium) to remember your pick and one-click-reload it next session; other browsers and other peers fall back to a \"Re-link: drop <name>\" prompt. The playhead is multiplayer-synced: play, pause and seek write a shared (isPlaying / lastSyncTime / lastSyncPosition) triple to the node so every peer's local copy follows, drift-correcting whenever it slips more than ~0.5s off the expected position. The picture well is drag-resizable from the bottom-right corner (default and minimum 360x360) so several videoboxes can be tiled into a wall of TVs; size persists on the node and syncs to peers. Right-click the picture for Fullscreen (a LOCAL per-peer state, NOT multiplayer-synced) or Full Frame (in-app, the video consumes the whole surface, hiding the picker/transport/seekbar; double-click to exit), where ONLY Full Frame is synced to peers. The faceplate also carries a SCREEN ON/OFF switch: OFF collapses the preview and reclaims its space while the file KEEPS PLAYING and keeps feeding the video and audio outs. Usage: drop a clip, hit Play, and patch video into a mixer/output and audio_l/audio_r into your audio chain; pulse the TRIG input from a clock or button to toggle play/pause hands-free. Idle (no file) shows a faint blue gradient so an empty module reads as alive-but-empty.",
    inputs: {
      play_trigger: "TRIG (gate cable, edge: trigger). A rising edge across the gate threshold toggles play/pause — it does NOT hold; only the moment the level crosses high fires the toggle, so a clock or button pulse flips between Play and Pause. Routed through the CV bridge as the synthetic cv_play_trigger param, which the node's source controller edge-detects and writes into the shared multiplayer play state.",
    },
    outputs: {
      video: "VID (video cable) — the decoded video frames of the loaded file, sampled into the output at the engine resolution. Shows the faint blue idle gradient until a file is loaded and a frame has uploaded.",
      audio_l: "A-L (audio cable) — the LEFT channel of the loaded file's audio track, split out of a MediaElementSource once a file is loaded. Emits silence (a flat ConstantSource placeholder) before any file is loaded or if audio wiring fails.",
      audio_r: "A-R (audio cable) — the RIGHT channel of the file's audio track. Same silent placeholder until a file is loaded; a mono file effectively feeds the same content to both channels via the splitter.",
    },
    controls: {
      gain: "Gain (linear, 0 to 2, default 1.0). Output level for the picture: the passthrough shader multiplies the sampled RGB by this (the uGain uniform), so 0 blacks the output, 1.0 is the identity and 2 doubles it (clipped at full scale by the 8-bit framebuffer). It scales the VIDEO only — the audio outs are unaffected.",
      cv_play_trigger: "Play trigger (linear, 0 to 1, default 0). Synthetic hidden param — not a visible control. It is the bridge target for the play_trigger gate input: the CV bridge writes the gate level here and the node's source controller polls it for a rising edge across 0.5 to toggle play/pause. Has no on-screen UI.",
    },
  },

  // ── THE FACE (wave-3 promotion) ───────────────────────────────────────────
  face: {
    // ⚠ A REAL CHOICE HERE, NOT A FORCED ONE — the tvLibrarian precedent, on
    // the def tvLibrarian's own audio plumbing was copied from. `glyphBinding()`
    // short-circuits on the first `type: 'audio'` OUTPUT and this def HAS two
    // (audio_l / audio_r) — so a glyph literal would resolve to a LIVE
    // `live-audio` binding and the dead-glyph clause would NOT catch it. It is
    // 'none' because it would paint a VU of the film's SOUNDTRACK where the
    // module's own picture belongs: for a video module the picture IS its
    // identity in a rack (#1785). The tile picture arrives from
    // `hasVideoSurface(def)` — `domain === 'video'` and nothing else — so it is
    // free, per-node, and needs no glyph at all.
    glyph: 'none',

    // The player body — see $lib/ui/modules/videobox/. Promotion stops BOTH
    // default surfaces rendering `VideoboxCard.svelte`, and videobox left
    // `DOM_SOURCE_LANE_TYPES` in LEG-02 P1 (#1511), so under the shell NO card
    // is mounted anywhere: without this file a promoted videobox could not
    // pick a file, re-allow a remembered handle, or operate its transport.
    extension: 'videobox',

    // One ranked key, because the module has one control a player turns.
    // `gain` scales the picture the module hands downstream; the synthetic
    // param below is a bridge cache and is declared out of the ranking rather
    // than ranked.
    order: ['gain'],

    // A linear 0..2 output level whose landmark is unity at the MIDDLE of the
    // throw — the reading a fader gives for free and a rotary does not. No
    // card choice is preserved or overturned: the card never exposed `gain`.
    paramCells: { gain: 'fader' },
  },

  // ⚠ WITHOUT THIS THE FACE PAINTS A CONTINUOUS ROTARY OVER A RAW GATE LEVEL.
  // `cv_play_trigger` is a bridge-written cache, not a setting, and face
  // completeness is unconditional for a promoted def — so it is declared out
  // rather than left to be ranked. `'cv-port'` is the only legal writer
  // (`play_trigger` declares `paramTarget`, so `'internal'` is RED at
  // no-user-control.ts) and it is also the TRUE one.
  //
  // ⚠ NOT COSMETIC BEYOND THE FACEPLATE: `exposable-controls.ts` drops a
  // `noUserControl` param from `listExposableControls` and `push-card-schema`
  // drops it from the Push 2 card, which re-ranks itself from two params to
  // one — an improvement (a raw gate cache should never have been on a
  // hardware controller), but a behaviour change outside the face.
  noUserControl: [
    {
      param: 'cv_play_trigger',
      writer: 'cv-port',
      why:
        'written by the `play_trigger` gate bridge as a raw level (0..1). It is a CACHE, not a '
        + 'setting: the node-owned source controller polls it and edge-detects a rising edge to '
        + 'toggle play/pause, so a player turning a dial here would be overwritten by the next '
        + 'bridge write.',
    },
  ],
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uGain     = gl.getUniformLocation(program, 'uGain');

    const { fbo, texture: outTexture } = ctx.createFbo();

    // rVFC-driven, engine-resolution-downscaled frame pump. Replaces the
    // per-engine-tick full-res texImage2D(<video>) path that caused the
    // few-FPS output regression (see video-frame-upload.ts for the why).
    const uploader = createVideoFrameUploader({
      gl,
      width: ctx.res.width,
      height: ctx.res.height,
    });
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
    // Silent keep-alive (src -> gain(0) -> destination) so the AudioContext
    // pulls this element in real time and Chromium doesn't throttle its decode
    // to ~1 fps when no audio is patched — and so multiple video sources all
    // decode at once instead of only one. Shared with VIDEOVARISPEED / CAMERA
    // via video-audio-keepalive.ts (factored out of #301's inline version).
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
        //
        // createVideoAudioKeepAlive builds src -> gain(0) -> destination (the
        // silent keep-alive that stops the decode throttling to ~1 fps when no
        // audio is patched) + resumes a suspended context, then hands back the
        // MediaElementSource we fan into our splitter. Shared with
        // VIDEOVARISPEED / CAMERA. The user's audio patches run in parallel off
        // the splitter and are audible as before.
        const ka = createVideoAudioKeepAlive(ac, videoEl);
        const split = ac.createChannelSplitter(2);
        ka.source.connect(split);
        keepAlive = ka;
        mediaElSrc = ka.source;
        splitter = split;
        audioSources.set('audio_l', { node: split, output: 0 });
        audioSources.set('audio_r', { node: split, output: 1 });

        audioWired = true;
        // audio_l / audio_r just changed identity (silent ConstantSource ->
        // live splitter). Re-resolve any cross-domain audio bridge that was
        // connected to the placeholder before this swap (saved-patch order:
        // audio_l -> AUDIO OUT predates the file load) so the splitter actually
        // reaches the destination instead of the dead placeholder.
        ctx.notifyAudioSourcesChanged?.(node.id);
      } catch (err) {
        // InvalidStateError: this video element already has a MediaElement
        // source attached (happens if the card hot-reloads). Stay on the
        // silent CSN fallback so downstream audio patches don't pop.
        console.warn('[videobox] createMediaElementSource failed:', err);
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
      // Reinstate the silent fallback so audio_l / audio_r still resolve
      // to a live node for any cables wired after the unwire.
      if (silentLeft && silentRight) {
        audioSources.set('audio_l', { node: silentLeft, output: 0 });
        audioSources.set('audio_r', { node: silentRight, output: 0 });
      }
      // Re-resolve any bridge so it tracks the placeholder rather than the
      // now-disconnected splitter.
      if (wasWired) ctx.notifyAudioSourcesChanged?.(node.id);
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        // The actual GPU upload only happens here when rVFC reports a new
        // decoded frame (or, on the fallback path, currentTime advanced).
        // On the other ~60-fps ticks this just rebinds the existing texture.
        const uploaded = uploader.uploadIfReady();
        const sourceTexture = uploader.texture;

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasInput, uploaded ? 1.0 : 0.0);
        g.uniform1f(uGain, params.gain);

        if (uploaded && sourceTexture) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, sourceTexture);
          g.uniform1i(uTex, 0);
        }

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      resize(w, h) {
        // OUTPUT aspect switch: the output FBO is engine-managed (auto-resized);
        // we just re-target the frame uploader so a loaded clip uploads at the
        // new res — 16:9 stays sharp, not a 4:3 upscale. Capped at the source's
        // own res inside the uploader.
        uploader.setSize(w, h);
      },
      dispose() {
        unwireAudio();
        if (silentLeft) try { silentLeft.disconnect(); } catch { /* */ }
        if (silentRight) try { silentRight.disconnect(); } catch { /* */ }
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(outTexture);
        uploader.dispose();
        gl.deleteProgram(program);
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
        // cv_play_trigger edge detection is owned by the node's source
        // controller ($lib/ui/media/node-video-source-registry — it watches
        // the param via readParam + applies the toggle to data.isPlaying).
        // We accept the value here so the bridge can route it, but the
        // factory doesn't need to act on it — the controller already drives
        // play/pause through the data write path.
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind !== 'video') return;
        // New element → tear down the audio graph so the old element's
        // MediaElementSource doesn't linger, and re-point the frame pump at
        // the new element (which re-subscribes rVFC + forces a first upload
        // against the new dimensions).
        if (videoEl !== el) unwireAudio();
        videoEl = (el as HTMLVideoElement) ?? null;
        if (videoEl) uploader.attach(videoEl);
        else uploader.detach();
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'audioWired') return audioWired;
        // Keep-alive instrumentation: lets tests/e2e assert the silent
        // gain(0)->destination bridge is live (the thing that stops the
        // <video> decode from throttling to ~1 fps when unpatched).
        if (key === 'hasKeepAlive') return keepAlive !== null;
        // Instrumentation hooks for the perf e2e: uploads/sec is derived by
        // sampling uploadCount over a window; rvfcSupported confirms the
        // decode-cadence path (vs the Firefox currentTime fallback) is live.
        if (key === 'uploadCount') return uploader.uploadCount;
        if (key === 'rvfcSupported') return uploader.rvfcSupported;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
