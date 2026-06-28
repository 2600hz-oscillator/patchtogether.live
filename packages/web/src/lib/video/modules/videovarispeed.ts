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
// 7-SLOT ASSET SELECTOR (asset-selector PR): the card owns up to 7 preloaded
// <video> elements (one per slot) and swaps which one is the ACTIVE source via
// attachExternalSource on a gate-driven slot switch — the factory itself stays
// single-element (it samples whatever element is currently attached). A clip
// player's note/gate output picks the slot (see asset-select.ts for the 7-note
// → slot map); on the gate edge the newly-active video restarts from the
// beginning (currentTime=0) and the audio is re-wired to the new element. The
// per-slot file BYTES stay LOCAL (objectUrl/handle) exactly like the single
// video — only per-slot fileMeta syncs so collaborators can re-link.
//
// Inputs:
//   cv_start / cv_pause / cv_reset / cv_loop_toggle (gate, paramTarget=…):
//     rising-edge transport gates.
//   asset_pitch (pitch, RAW V/oct passthrough): slot-select pitch. NO cvScale
//     so the bridge passes the raw V/oct through; the card reads it on each
//     asset_gate rising edge.
//   asset_gate (gate, paramTarget): rising-edge slot-select trigger.
//   speedCv / startCv / endCv (cv, linear, paramTarget=…): per-param CV displacement.
//
// Outputs:
//   video (video): decoded frames at the user's transport state.
//   audio_l / audio_r (audio): stereo bridges from the ACTIVE slot's audio.
//
// Params:
//   speed (linear 0..1): playback rate (0 = stop, mapped to negative…positive multiplier).
//   start / end (linear 0..1): in-and-out window into the file.
//   speedCv / startCv / endCv (linear -1..1): cached CV values.
//   cv_start / cv_pause / cv_reset / cv_loop_toggle (linear 0..1):
//     cached state from the gate inputs.
//   asset_pitch (raw V/oct cache) / asset_gate (raw gate level; card edge-detects).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import { createKeepAliveRegistry } from '$lib/video/video-keepalive-registry';
import { ASSET_SLOTS } from '$lib/video/asset-select';
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

/** Per-slot file size cap. 7 preloaded <video> elements are memory-heavy, so
 *  each slot's file is capped to keep total resident memory bounded. Documented
 *  in the module's DESCRIPTIONS entry. */
export const VIDEOVARISPEED_MAX_SLOT_BYTES = 100 * 1024 * 1024; // 100 MB

/** Persisted shape on node.data. The card is the only writer. */
export interface VideoVarispeedData {
  /** Metadata about the file the loader picked. Null until a file is picked.
   *  Local-only player, but we keep it on data so it survives reload. This is
   *  the ACTIVE / slot-0 file (back-compat with the single-video model). */
  fileMeta: VideoboxFileMeta | null;
  /** True when the transport is logically playing. */
  isPlaying: boolean;
  /** Transport mode: true = LOOP (jump to START at END), false = ONE-SHOT
   *  (stop at END). Persisted so the loop button + loop_toggle gate flip the
   *  same state across reload. */
  loop: boolean;
  /** 7-slot per-slot file meta (parallel to the asset slots). Each entry
   *  mirrors `fileMeta` so collaborators can re-link their own copy of each
   *  slot's video; the actual bytes stay LOCAL (objectUrl / FileSystemFileHandle)
   *  exactly like the single-video model. null = empty slot. */
  slotMeta?: (VideoboxFileMeta | null)[];
}

/** Default state stamped onto a freshly spawned VIDEOVARISPEED. */
export const VIDEOVARISPEED_DATA_DEFAULTS: VideoVarispeedData = {
  fileMeta: null,
  isPlaying: false,
  loop: true,
  slotMeta: new Array(ASSET_SLOTS).fill(null),
};

/** Handle extras — the card calls these to drive the audio wiring once the
 *  local <video> has loaded its file. Mirrors VIDEOBOX. */
export interface VideoVarispeedHandleExtras {
  /** Wire the ACTIVE element's audio into the graph (after src + metadata).
   *  Idempotent; re-points audio_l/r when the active element changed. */
  wireAudio(): void;
  /** Revert audio_l/r to the silent placeholders (full detach) — does NOT
   *  destroy any element's persistent keep-alive. */
  unwireAudio(): void;
  /** True once the active element's audio is exposed on audio_l/r. */
  isAudioWired(): boolean;
  /** Create (once) a PERSISTENT keep-alive for a loaded slot element that is
   *  NOT the active source, so its decode never throttles to ~1 fps while it
   *  waits to be switched in. Idempotent per element; never torn down on switch
   *  (only on module dispose). The card calls this for every loaded slot so a
   *  random/melodic switch pattern always lands on an already-warm element. */
  keepSlotAlive(el: HTMLVideoElement): void;
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
  // Asset-selector synthetic params. asset_pitch caches the RAW V/oct of the
  // slot-select pitch (NO cvScale ⇒ raw passthrough); asset_gate caches the
  // raw gate level the card edge-detects.
  asset_pitch: number;
  asset_gate: number;
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
  asset_pitch: 0,
  asset_gate: 0,
};

export const videoVarispeedDef: VideoModuleDef = {
  type: 'videovarispeed',
  palette: { top: 'Video modules', sub: 'Sources' },
  card: 'VideoVarispeedCard',
  domain: 'video',
  label: 'videovarispeed',
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
    // --- 7-slot asset selector ---
    // asset_pitch: V/oct slot-select pitch. NO cvScale ⇒ raw passthrough so
    // the card reads the raw V/oct on each gate edge. `pitch`-typed so a clip
    // player's pitch (polyPitchGate → lane 0) can patch in.
    { id: 'asset_pitch', type: 'pitch', paramTarget: 'asset_pitch' },
    // asset_gate: rising-edge slot-select trigger (raw passthrough; card edge-detects).
    { id: 'asset_gate',  type: 'gate', paramTarget: 'asset_gate' },
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
    // Asset-selector synthetic params. asset_pitch carries the raw V/oct (wide
    // range); asset_gate is the 0/1 gate level the card edge-detects.
    { id: 'asset_pitch', label: 'Asset pitch', defaultValue: 0, min: -10, max: 10, curve: 'linear' },
    { id: 'asset_gate',  label: 'Asset gate',  defaultValue: 0, min: 0,   max: 1,  curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "A local-file video player with a performant varispeed transport. Drop or pick a video and it decodes into the VIDEO output (rVFC-driven, so the texture streams at ANY speed without freezing). The SPEED knob is an asymmetric analog-clock face: full-left = -4x (reverse), 12 o'clock = +1x normal, full-right = +4x — forward speeds drive native <video>.playbackRate (audio pitch/tempo-shifts like tape varispeed) while reverse scrubs currentTime at a throttled ~10 Hz (audio muted in reverse). START/END sliders carve a play window into the clip; at the END edge LOOP jumps back to START while ONE-SHOT stops. The source aspect is letterboxed/pillarboxed into the 4:3 FBO so clips never stretch. DOM-only buttons (not patch params) handle file loading and transport: \"Choose video…\" / drag-drop / Chromium re-link, Play/Pause, a seek scrubber, and a LOOP↔1-SHOT toggle. Right-click the card to open the \"Load multiple…\" panel — up to 7 preloaded slots mapped to the C-major scale rows C..B; a clip player or any pitch+gate source can then switch which clip plays via the ASSET ports, each slot running its own virtual playhead so a switch jumps to that clip's live, de-synced position. Use it to scratch, reverse, freeze, and loop-window a clip live, or as a 7-clip melodic video switcher feeding BENTBOX / a CRT chain.",
    inputs: {
      cv_start: "Gate (rising-edge / trigger). On the edge it (re)starts playback from the START window point and begins playing; if the window is empty (START past END) it instead seeks the current spot and stays paused.",
      cv_pause: "Gate (rising-edge / trigger). Each rising edge toggles pause/unpause — it flips the play state on the edge, it is not level-held.",
      cv_reset: "Gate (rising-edge / trigger). On the edge it seeks the playhead back to the START point (or 0 if there is no valid window) without changing play/pause state.",
      cv_loop_toggle: "Gate (rising-edge / trigger). Each rising edge flips the transport between LOOP (jump to START at END) and ONE-SHOT (stop at END), the same state the LOOP button shows.",
      asset_pitch: "Pitch (raw V/oct passthrough, no cvScale). Selects which of 7 asset slots plays: pitch class C=slot1 D E F G A B=slot7 (octave-independent); a black-key class selects no slot. Read on each ASSET GATE rising edge.",
      asset_gate: "Gate (rising-edge / trigger). On the edge it reads ASSET PITCH, maps it to a slot, and if that slot holds a loaded video makes it the active source — jumping the output to that slot's live virtual position (re-triggering the already-active slot restarts it from the window start). Empty or out-of-key selections are ignored.",
      speedCv: "CV (bipolar -1..+1, modulates Speed). Sums into the SPEED knob position before the varispeed map, so +-1 sweeps the full reverse-to-forward span centred on the knob setting.",
      startCv: "CV (bipolar -1..+1, modulates Start). Sums into the START slider only while patched (unpatched normals to 0), shifting the window's start/reset point earlier or later.",
      endCv: "CV (bipolar -1..+1, modulates End). Sums into the END slider only while patched (unpatched normals to full duration); negative CV pulls the window's end point earlier.",
    },
    outputs: {
      video: "Video. The decoded clip at the current transport state (speed, scrub, window), aspect-preserved (letterbox/pillarbox) into the engine FBO; an idle dark gradient before a file loads.",
      audio_l: "Audio (left). Left channel of the ACTIVE slot's audio, tapped from its media-element source; varispeed pitch/tempo-shifts it on forward play and it is muted during reverse.",
      audio_r: "Audio (right). Right channel of the active slot's audio, following the same active slot as audio_l and re-pointed automatically when the asset slot switches.",
    },
    controls: {
      speed: "Speed knob (0..1, default 0.5). Asymmetric varispeed: 0 = -4x reverse, 0.5 = +1x normal forward, 1 = +4x; readout shows the live multiplier. Summed with Speed CV.",
      start: "Start slider (0..1 of duration, default 0). The play-from and reset-to point of the playback window. Summed with Start CV when patched.",
      end: "End slider (0..1 of duration, default 1). The end of the playback window; if START passes END the window is empty and playback halts. Summed with End CV when patched (unpatched normals to full duration).",
      speedCv: "Cached Speed CV value (-1..+1, default 0). Holds the live bipolar sample from the speedCv input, summed into the SPEED knob; not a user-facing control.",
      startCv: "Cached Start CV value (-1..+1, default 0). Holds the live bipolar sample from the startCv input, summed into the START slider while patched; not a user-facing control.",
      endCv: "Cached End CV value (-1..+1, default 0). Holds the live bipolar sample from the endCv input, summed into the END slider only while patched; not a user-facing control.",
      cv_start: "Synthetic Start-gate cache (0..1, default 0). Holds the cv_start gate level the card polls and edge-detects to fire a window-start restart; not shown on the card UI.",
      cv_pause: "Synthetic Pause-gate cache (0..1, default 0). Holds the cv_pause gate level the card edge-detects to toggle pause/unpause; not shown on the card UI.",
      cv_reset: "Synthetic Reset-gate cache (0..1, default 0). Holds the cv_reset gate level the card edge-detects to seek to START; not shown on the card UI.",
      cv_loop_toggle: "Synthetic Loop-gate cache (0..1, default 0). Holds the cv_loop_toggle gate level the card edge-detects to flip LOOP vs ONE-SHOT; not shown on the card UI.",
      asset_pitch: "Synthetic Asset-pitch cache (raw V/oct, default 0, range -10..10). Holds the raw asset_pitch value the card reads on each asset-gate edge to pick a slot; not shown on the card UI.",
      asset_gate: "Synthetic Asset-gate cache (0..1, default 0). Holds the asset_gate level the card edge-detects to trigger a slot switch; not shown on the card UI.",
    },
  },
  // docs-hash-ignore:end
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

    // ---- Audio plumbing (PERSISTENT per-element keep-alive Map) ----
    //
    // The 7-slot asset selector swaps which <video> the engine samples, but the
    // audio keep-alive for EVERY loaded element must persist for the module's
    // whole life — NOT be torn down on a switch. `createMediaElementSource` is
    // permanent + once-per-element (a 2nd call on the same element throws
    // InvalidStateError) and a hidden, non-audio-pulled <video> decode-throttles
    // to ~1 fps. The pre-fix engine kept ONE shared keep-alive it destroyed on
    // every switch, so after one slot cycle every switched-away slot froze on
    // frame 0 and re-select threw + never recovered (the multi-slot stall). We
    // now mirror TOYBOX's identity-guarded persistent per-element Map: each
    // element's keep-alive (createMediaElementSource → gain(0) → destination)
    // is created AT MOST ONCE and lives until dispose, so every loaded slot
    // keeps decoding at full rate and re-select is never cold-re-wired.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let silentLeft: ConstantSourceNode | null = null;
    let silentRight: ConstantSourceNode | null = null;
    // Persistent per-element keep-alive registry — created once per element,
    // never torn down on switch (only on module dispose). Injects the audio
    // plumbing so the identity invariant is unit-testable with a fake create.
    const keepAlives = createKeepAliveRegistry<VideoAudioKeepAlive>((el) =>
      ctx.audioCtx ? createVideoAudioKeepAlive(ctx.audioCtx, el) : null,
    );
    // Per-element splitter (keep-alive.source → splitter) so audio_l / audio_r
    // can re-point to whichever element is ACTIVE without disturbing the others'
    // persistent keep-alives. Keyed by element; built lazily alongside the
    // keep-alive, torn down only on dispose.
    const splitters = new Map<HTMLVideoElement, ChannelSplitterNode>();
    // The element whose splitter audio_l / audio_r currently expose. Lets a
    // repeated wireAudio() detect when the ACTIVE element changed (so it
    // re-points + notifies) vs a redundant call (no-op).
    let wiredEl: HTMLVideoElement | null = null;
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

    /** Lazily build (once) the splitter fed from `el`'s persistent keep-alive
     *  so audio_l / audio_r can tap it. Returns null when the element has no
     *  keep-alive (no AudioContext / createMediaElementSource threw). */
    function ensureSplitter(el: HTMLVideoElement): ChannelSplitterNode | null {
      const existing = splitters.get(el);
      if (existing) return existing;
      if (!ctx.audioCtx) return null;
      const ka = keepAlives.ensure(el);
      if (!ka) return null;
      const split = ctx.audioCtx.createChannelSplitter(2);
      ka.source.connect(split);
      splitters.set(el, split);
      return split;
    }

    // Wire the ACTIVE element's audio into the graph + keep its (and every other
    // loaded element's) decode alive. IDEMPOTENT: a repeated call on the same
    // active element is a no-op; a call after the active element changed
    // re-points audio_l / audio_r to the new element's splitter and re-resolves
    // downstream bridges. The keep-alive itself is created at most once per
    // element (registry identity guard) and is NEVER torn down here — that's
    // what stops a switched-away slot from throttling + re-select from throwing.
    function wireAudio(): void {
      if (!ctx.audioCtx) return;
      if (!videoEl) return;
      // Same active element already exposed → nothing to do.
      if (audioWired && wiredEl === videoEl) return;
      const split = ensureSplitter(videoEl);
      if (!split) {
        // createMediaElementSource failed (e.g. element already has a source
        // after HMR) — stay on the silent CSN fallback so downstream audio
        // patches don't pop.
        console.warn('[videovarispeed] createMediaElementSource failed: keep-alive unavailable for the active element');
        return;
      }
      audioSources.set('audio_l', { node: split, output: 0 });
      audioSources.set('audio_r', { node: split, output: 1 });
      wiredEl = videoEl;
      audioWired = true;
      // The audio_l / audio_r nodes just changed identity (silent ConstantSource
      // → this element's live splitter, or another slot's splitter → this one's
      // on a switch). Any cross-domain audio bridge connected to the previous
      // node is now stale; ask the engine to re-resolve it so the active
      // splitter reaches the destination (audio follows the switched video).
      ctx.notifyAudioSourcesChanged?.(node.id);
    }

    // Revert audio_l / audio_r to the silent placeholders WITHOUT destroying any
    // element's persistent keep-alive (that would re-introduce the throttle + the
    // once-per-element re-create throw on the next select). Used on a full
    // detach (attachExternalSource(null)) where there is no active element to
    // expose; switching BETWEEN loaded slots goes through wireAudio() instead and
    // never lands here. disposeAll() (module dispose) tears the keep-alives down.
    function unwireAudio(): void {
      const wasWired = audioWired;
      audioWired = false;
      wiredEl = null;
      if (silentLeft && silentRight) {
        audioSources.set('audio_l', { node: silentLeft, output: 0 });
        audioSources.set('audio_r', { node: silentRight, output: 0 });
      }
      // Re-resolve any bridge so it tracks the placeholder rather than a now
      // off-air splitter (keeps downstream from popping). The splitters + the
      // keep-alives themselves stay live so the elements keep decoding.
      if (wasWired) ctx.notifyAudioSourcesChanged?.(node.id);
    }

    /** Tear DOWN every persistent keep-alive + splitter (module dispose only). */
    function disposeAudio(): void {
      for (const split of splitters.values()) {
        try { split.disconnect(); } catch { /* */ }
      }
      splitters.clear();
      keepAlives.disposeAll();
      wiredEl = null;
      audioWired = false;
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
        disposeAudio();
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
      keepSlotAlive: (el) => { keepAlives.ensure(el); },
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
        // New ACTIVE element -> move rVFC to it; force a re-spec on the first
        // upload against new dimensions. We do NOT tear down the OUTGOING
        // element's audio keep-alive: it persists in the registry so the
        // switched-away slot keeps decoding at full rate and a later re-select
        // never re-creates its (permanent) MediaElementSource. A full detach
        // (el === null, on destroy / slot-clear) reverts audio_l/r to the
        // silent placeholders; a switch BETWEEN loaded slots leaves audio on
        // the old splitter until the card's wireAudio() re-points it to the new
        // element (so audio never drops to silence mid-switch).
        detachRvfc();
        sourceTexAllocated = false;
        videoEl = (el as HTMLVideoElement) ?? null;
        if (videoEl) {
          attachRvfc();
          // Eagerly create the new element's persistent keep-alive so it never
          // sat throttled before the card wires audio. Idempotent per element.
          keepAlives.ensure(videoEl);
        } else {
          // True detach (no active element): revert to silent placeholders.
          unwireAudio();
        }
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'audioWired') return audioWired;
        // Keep-alive instrumentation: lets the e2e assert the silent
        // gain(0)->destination bridge is live (the thing that stops the
        // <video> decode from throttling when N sources are unpatched). The
        // ACTIVE element always has one when audio is wired; `keepAliveCount`
        // exposes the persistent per-element total so the switch-path e2e can
        // prove every loaded slot stays warm (never torn down on switch).
        if (key === 'hasKeepAlive') return videoEl !== null && keepAlives.has(videoEl);
        if (key === 'keepAliveCount') return keepAlives.size();
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
