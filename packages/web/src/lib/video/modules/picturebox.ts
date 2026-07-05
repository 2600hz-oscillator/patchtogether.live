// packages/web/src/lib/video/modules/picturebox.ts
//
// PICTUREBOX — image-file source. User picks a file in the card UI;
// the file is downscaled to 640x480 + JPEG-encoded + base64-stored in
// `node.data.imageBytes`, which rides the Y.Doc out to all rack-mates.
// On every peer (including the loader), the card decodes those bytes
// back into an ImageBitmap and uploads it into our source texture.
//
// schemaVersion bumped to 2 in PR #-; v1 had no imageBytes field
// (file-picker was local-only). `migrate` here ensures legacy patches
// load without warnings.
//
// schemaVersion bumped to 3 (asset-selector PR): adds `data.assets` — a
// length-7 array of base64 JPEGs (each encoded the SAME way as imageBytes),
// one per asset SLOT. A note/gate output from a clip player switches which
// slot is displayed (see asset-select.ts for the 7-note → slot mapping).
// `imageBytes` is preserved as the CURRENTLY-DISPLAYED image (back-compat +
// render unchanged for single-image use). The migration fills
// `assets = [imageBytes ?? null, null, …]` so a v2 single-image node becomes
// a slot-1-only 7-slot node.
//
// schemaVersion bumped to 4 (animated-gif PR): adds `data.assetMimes` — a
// length-7 array of per-slot MIMEs ('image/jpeg' | 'image/gif' | null) parallel
// to `assets`, plus the single-image `imageMime` may now be 'image/gif'. An
// animated gif is stored BYTE-FOR-BYTE (not JPEG-flattened) so every frame
// survives the sync; the card decodes it (WebCodecs ImageDecoder) into per-frame
// bitmaps and the module steps them on the engine clock (gif-frames.ts). Absent
// `assetMimes` (v3 nodes) reads as all-JPEG — correct, since v3 only stored
// JPEGs. See gif-frames.ts (pure scheduler) + picturebox-encode.ts (decode).
//
// Limits (see lib/multiplayer/picturebox-limits.ts): 2 PICTUREBOX per
// user, 8 per workspace. The 8/workspace cap is mirrored as
// `maxInstances` so the palette greys out the picker at the cap; the
// per-user cap is enforced in Canvas's spawnFromPalette.
//
// File-picker UX lives in PictureboxCard.svelte; this factory exposes
// `setImage(bitmap)` via the handle's `read` channel so the card can
// drive uploads. `setImage(null)` clears. The 7-slot extras
// (`setAssetAtSlot` / `selectSlot` / `slotHasAsset`) let the card
// pre-upload up to 7 textures + switch the active one instantly on a gate.
//
// Inputs:
//   gain (cv, paramTarget=gain): displaces the gain knob.
//   asset_pitch (pitch, RAW V/oct passthrough): the slot-select pitch. NO
//     cvScale hint so the bridge passes the raw V/oct value through; the
//     card reads it on each asset_gate rising edge.
//   asset_gate (gate, rising-edge trigger): on each rising edge the card
//     reads asset_pitch, maps V/oct → slot (asset-select.slotForVOct), and
//     selects that slot if it holds an asset (else ignores the event).
//
// Outputs:
//   out (image): the active slot's image as a video-domain image source.
//
// Params:
//   gain (linear 0..2): output gain (multiplies the image's RGB).
//   asset_pitch (synthetic, raw V/oct cache from the asset_pitch input).
//   asset_gate  (synthetic, raw gate level cache; the card edge-detects).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { ASSET_SLOTS } from '$lib/video/asset-select';
import { frameIndexAtTime, type DecodedGifFrame } from './gif-frames';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasImage;
uniform float uGain;

void main() {
  if (uHasImage < 0.5) {
    // Idle: subtle dark teal so the card reads as "alive but empty"
    // rather than "broken".
    outColor = vec4(0.02, 0.06, 0.08, 1.0);
    return;
  }
  vec3 col = texture(uTex, vUv).rgb * uGain;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

interface PictureboxParams {
  gain: number;
  // --- Asset-selector synthetic params (bridge-written; card reads them).
  //     asset_pitch caches the RAW V/oct value of the slot-select pitch
  //     input (NO cvScale hint ⇒ raw passthrough). asset_gate caches the
  //     raw gate level; the card edge-detects rising edges. ---
  asset_pitch: number;
  asset_gate: number;
}

const DEFAULTS: PictureboxParams = {
  gain: 1.0,
  asset_pitch: 0,
  asset_gate: 0,
};

// We expose a small "read"-channel command surface so the UI card can
// upload an ImageBitmap (or HTMLImageElement) into our source texture
// without reaching directly into GL. The card calls
// `engine.read(nodeId, 'setImage:<token>')` and the handle's read()
// implementation pulls the bitmap from a local registry — but simpler
// for Phase-1: expose `read('imageRef')` that returns the underlying
// uploader function.
export interface PictureboxHandleExtras {
  setImage: (bitmap: ImageBitmap | HTMLImageElement | null) => void;
  /** Filename string, surfaced in the UI. */
  setFilename: (name: string | null) => void;
  /** Currently-loaded filename. */
  filename: () => string | null;
  // --- 7-slot asset selector. The card pre-decodes + pre-uploads up to 7
  //     textures (one per slot) so a gate-driven switch is instant; the
  //     active slot is what the shader samples. ---
  /** Upload a bitmap into slot `i` (0..6), or `null` to clear that slot.
   *  Out-of-range indices are ignored. */
  setAssetAtSlot: (i: number, bitmap: ImageBitmap | HTMLImageElement | null) => void;
  /** True iff slot `i` currently holds an uploaded texture. */
  slotHasAsset: (i: number) => boolean;
  /** Make slot `i` the active (displayed) slot — instant texture swap. A
   *  no-op if the slot is empty or out of range. Returns true on a switch. */
  selectSlot: (i: number) => boolean;
  /** The currently-active slot index (0..6). */
  activeSlot: () => number;
  // --- Animated GIF ---------------------------------------------------------
  /** Install decoded animated-gif frames (bitmap + per-frame duration) into the
   *  ACTIVE slot, or `null` to clear its animation. The module advances the
   *  frames on the engine clock and OWNS the bitmaps (closes them on
   *  replace/clear/dispose). Mirrors setImage (active slot). */
  setAnimatedImage: (frames: DecodedGifFrame[] | null) => void;
  /** Install animated-gif frames into slot `i` (0..6), or `null` to clear.
   *  Mirrors setAssetAtSlot (specific slot). */
  setAnimatedAtSlot: (i: number, frames: DecodedGifFrame[] | null) => void;
}

/** Persisted shape on `node.data` for PICTUREBOX nodes (schemaVersion 4). */
export interface PictureboxData {
  /** base64-encoded image bytes for the CURRENTLY-DISPLAYED image. Usually a
   *  JPEG q=85 downscaled to the engine res (zoom-fit-crop); for an ANIMATED
   *  gif within the size cap it is the ORIGINAL, byte-preserved gif (so every
   *  frame survives the sync) — `imageMime` distinguishes them. null when no
   *  image has been loaded yet. Back-compat with v2 (single-image render path
   *  unchanged). */
  imageBytes: string | null;
  /** MIME of `imageBytes`: 'image/jpeg' (still) or 'image/gif' (animated,
   *  byte-preserved → the card decodes + animates it). */
  imageMime: string;
  /** Human-friendly source filename, surfaced in the card UI. */
  imageName: string | null;
  /** v3: 7-slot asset array. Each entry is a base64 image (JPEG still, or an
   *  original animated gif — see `assetMimes`) or null for an empty slot. A clip
   *  player's note/gate output selects which slot is shown (see
   *  asset-select.ts). Synced (small base64); the DISPLAYED selection is
   *  local render state, never written here per gate event. */
  assets?: (string | null)[];
  /** v3: per-slot source filenames (parallel to `assets`), surfaced in the
   *  "Load multiple…" panel. */
  assetNames?: (string | null)[];
  /** v4: per-slot MIME (parallel to `assets`) — 'image/jpeg' | 'image/gif' |
   *  null (empty). Lets the card pick the animate-vs-static decode path per
   *  slot. Absent on v3 nodes ⇒ every loaded slot is treated as a JPEG still
   *  (correct: v3 only ever stored JPEGs). */
  assetMimes?: (string | null)[];
  /** User id of whoever spawned this node (Canvas writes this on spawn).
   *  Used by the per-user cap. Pre-this-PR nodes have no creatorId; they
   *  count toward the workspace total but not toward any user's cap. */
  creatorId?: string;
}

export const pictureboxDef: VideoModuleDef = {
  type: 'picturebox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'picturebox',
  category: 'sources',
  schemaVersion: 4,
  // Workspace cap (8 per rack). Mirrored from
  // lib/multiplayer/picturebox-limits.ts → PICTUREBOX_LIMITS.perWorkspace.
  // The palette uses this to grey out the option once the cap is hit;
  // Canvas's spawnFromPalette is the secondary gate.
  maxInstances: 8,
  inputs: [
    // paramTarget == port id keeps docs manifest in sync. Bridge uses
    // port id directly so the runtime works either way.
    { id: 'gain', type: 'cv', paramTarget: 'gain', cvScale: { mode: 'linear' } },
    // --- 7-slot asset selector inputs ---
    // asset_pitch: V/oct slot-select pitch. NO cvScale hint ⇒ the cross-
    // domain CV bridge passes the RAW V/oct value straight to setParam
    // (the card reads it on each gate edge + maps it to a slot). Declared
    // `pitch` so a clip player's pitch (polyPitchGate, downcast to lane 0)
    // or any pitch/cv source can patch in.
    { id: 'asset_pitch', type: 'pitch', paramTarget: 'asset_pitch' },
    // asset_gate: rising-edge trigger. Raw gate level passes through; the
    // card edge-detects (mirrors VIDEOVARISPEED's cv_* gate convention).
    { id: 'asset_gate', type: 'gate', paramTarget: 'asset_gate' },
  ],
  outputs: [
    { id: 'out', type: 'image' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
    // Synthetic asset-selector params (hidden from the card UI; the ports
    // render in the PatchPanel). curve:linear so bridge values arrive raw.
    // asset_pitch holds the raw V/oct (range covers a wide pitch span);
    // asset_gate holds the 0/1 gate level the card edge-detects.
    { id: 'asset_pitch', label: 'Asset pitch', defaultValue: 0, min: -10, max: 10, curve: 'linear' },
    { id: 'asset_gate',  label: 'Asset gate',  defaultValue: 0, min: 0,   max: 1,  curve: 'linear' },
  ],


  // docs-hash-ignore:start
  docs: {
    explanation: "An image source for the video graph. You pick an image file in the card (\"Choose image...\"); a still is zoom-fit-cropped to the engine resolution (1024x768, 4:3), JPEG-encoded (q=0.85), and synced across rack-mates so every peer sees the same picture. An ANIMATED gif is kept byte-for-byte (not flattened) and PLAYS — its frames are decoded (WebCodecs ImageDecoder) and stepped on the engine clock, looping with the gif's own per-frame delays; the card preview animates too. Where ImageDecoder is unavailable it falls back to the first frame, and a gif over the sync size cap is stored as a first-frame still (the card hints why). The fragment shader samples the current frame's texture and multiplies its RGB by Gain (idle = a dark teal fill so an empty card reads as alive, not broken). Beyond the single image, picturebox holds a 7-slot asset bank: right-click the card to open the \"Load multiple…\" panel and load one image (or gif) per slot, labelled by the C-major scale degrees C D E F G A B (slots 1-7). Patch a clip player's note/pitch + gate into asset_pitch / asset_gate and each gate edge switches the displayed slot by pitch class (octave-independent; a black key is ignored). Use it as a still backdrop, an animated-gif loop, an album-art frame, or a note-triggered image sampler feeding downstream video benders.",
    inputs: {
      gain: "CV in that modulates Gain (output brightness/RGB multiply); displaces the Gain fader, linear, summed at the param target.",
      asset_pitch: "Pitch (V/oct) in carrying the raw slot-select value; read on each asset_gate rising edge and mapped by pitch class to one of the 7 C-major slots (C..B). No CV scaling — passed through raw.",
      asset_gate: "Gate/trigger in: the card edge-detects the RISING edge (level crosses ~0.5) — on each edge it reads asset_pitch, resolves the slot, and switches to it if that slot holds an image. Acts on edges, not the held level.",
    },
    outputs: {
      out: "Image out — the active slot's image as a video-domain image source (RGB multiplied by Gain), at engine resolution; patch into any video module.",
    },
    controls: {
      gain: "Gain — output brightness; multiplies the image's RGB. Linear 0..2 (1.0 = unity). Also modulatable via the gain CV input.",
      asset_pitch: "Asset pitch — synthetic, hidden param caching the raw V/oct from the asset_pitch input. Not a card knob; the card reads it on each gate edge to choose a slot. Range -10..10.",
      asset_gate: "Asset gate — synthetic, hidden param caching the raw gate level (0..1) from the asset_gate input. Not a card knob; the card edge-detects its rising edge to fire a slot switch.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasImage = gl.getUniformLocation(program, 'uHasImage');
    const uGain     = gl.getUniformLocation(program, 'uGain');

    // Output FBO (where the shader writes); plus a SET of 7 "source"
    // textures (one per asset slot) that the card uploads ImageBitmaps into.
    // The output FBO stays at engine-resolution regardless of the source
    // image dimensions. All 7 slot textures stay resident so a gate-driven
    // slot switch is an instant active-index flip — no re-upload.
    const { fbo, texture } = ctx.createFbo();

    function makeSlotTexture(): WebGLTexture {
      const tex = gl.createTexture();
      if (!tex) throw new Error('PICTUREBOX: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Initialize 1x1 black so the sampler is always bound to something
      // sane before the user picks a file.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    const slotTextures: WebGLTexture[] = Array.from({ length: ASSET_SLOTS }, makeSlotTexture);
    const slotLoaded: boolean[] = new Array(ASSET_SLOTS).fill(false);
    // The active (displayed) slot. Defaults to slot 0 — where the legacy
    // single image lives after migration.
    let activeSlot = 0;
    let filename: string | null = null;

    const params: PictureboxParams = { ...DEFAULTS, ...(node.params as Partial<PictureboxParams>) };

    // --- Animated-GIF playback state (one per slot) --------------------------
    // A slot holding an animated gif keeps its decoded frames resident (as
    // ImageBitmaps the module OWNS + closes) plus a play clock. draw() advances
    // the ACTIVE slot's animation on the engine clock (ctx.time) and re-uploads
    // the current frame into the slot texture only when the frame index changes.
    interface SlotAnim {
      frames: DecodedGifFrame[];
      /** Per-frame durations (ms), parallel to frames — the scheduler input. */
      durations: number[];
      /** Engine-clock second at which this slot's playback (re)started; null
       *  ⇒ seed it on the next draw (so t=0 is the first frame we display). */
      startTime: number | null;
      /** Last frame index uploaded to the slot texture (avoids redundant
       *  texImage2D every draw). */
      lastIndex: number;
    }
    const slotAnim: (SlotAnim | null)[] = new Array(ASSET_SLOTS).fill(null);

    /** Close an ImageBitmap if it supports it (real bitmaps do; test stubs may
     *  not) — frees the decoded frame's backing store. */
    function closeBitmap(b: ImageBitmap): void {
      const c = (b as { close?: () => void }).close;
      if (typeof c === 'function') {
        try { c.call(b); } catch { /* already closed */ }
      }
    }

    /** Drop a slot's animation, closing every frame bitmap (no leak). */
    function clearSlotAnim(i: number): void {
      const a = slotAnim[i];
      if (!a) return;
      for (const f of a.frames) closeBitmap(f.bitmap);
      slotAnim[i] = null;
    }

    /** Upload a bitmap into a slot texture (RGBA, Y-flipped right-side-up). The
     *  low-level path shared by the static + animated upload seams. */
    function glUpload(tex: WebGLTexture, bitmap: ImageBitmap | HTMLImageElement): void {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Image data is RGBA; flip Y so the image renders right-side-up
      // (texImage2D defaults to bottom-up texel layout).
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    /** True iff the active slot currently holds an uploaded image (drives the
     *  card's data-has-image + the shader's idle-vs-image branch). */
    function hasActiveImage(): boolean {
      return slotLoaded[activeSlot] === true;
    }

    function uploadToSlot(i: number, bitmap: ImageBitmap | HTMLImageElement | null): void {
      if (i < 0 || i >= ASSET_SLOTS) return;
      // A new STATIC image replaces any animation this slot was playing.
      clearSlotAnim(i);
      if (!bitmap) {
        slotLoaded[i] = false;
        return;
      }
      glUpload(slotTextures[i]!, bitmap);
      slotLoaded[i] = true;
    }

    /** Install (or clear) an animated gif in a slot. Closes any prior frames
     *  first, uploads frame 0 immediately so the slot shows content before the
     *  scheduler runs, and marks the slot loaded. */
    function setAnimatedFrames(i: number, frames: DecodedGifFrame[] | null): void {
      if (i < 0 || i >= ASSET_SLOTS) return;
      clearSlotAnim(i);
      if (!frames || frames.length === 0) return;
      slotAnim[i] = {
        frames,
        durations: frames.map((f) => f.durationMs),
        startTime: null,
        lastIndex: 0,
      };
      glUpload(slotTextures[i]!, frames[0]!.bitmap);
      slotLoaded[i] = true;
    }

    // Back-compat: setImage uploads into the ACTIVE slot. The single-image
    // card path (Choose image…) drives this; treating it as the active
    // texture keeps the existing render + sync behaviour identical.
    function setImage(bitmap: ImageBitmap | HTMLImageElement | null): void {
      uploadToSlot(activeSlot, bitmap);
    }

    function selectSlot(i: number): boolean {
      if (i < 0 || i >= ASSET_SLOTS) return false;
      if (!slotLoaded[i]) return false;
      activeSlot = i;
      // Restart the newly-active slot's animation from frame 0 so a slot switch
      // "stops old / starts new" cleanly (the old slot's clock simply stops
      // being advanced by draw()).
      const a = slotAnim[i];
      if (a) {
        a.startTime = null;
        a.lastIndex = 0;
        glUpload(slotTextures[i]!, a.frames[0]!.bitmap);
      }
      return true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        // Advance the ACTIVE slot's gif animation (if any) BEFORE sampling its
        // texture: pick the frame for the elapsed engine time (looping) and
        // re-upload only on a frame change. A single-frame "animation" never
        // gets here (frames.length > 1 guard) so a still gif costs nothing.
        const anim = slotAnim[activeSlot];
        if (anim && anim.frames.length > 1) {
          if (anim.startTime == null) anim.startTime = frame.time;
          const elapsedMs = Math.max(0, (frame.time - anim.startTime) * 1000);
          const idx = frameIndexAtTime(anim.durations, elapsedMs);
          if (idx !== anim.lastIndex) {
            glUpload(slotTextures[activeSlot]!, anim.frames[idx]!.bitmap);
            anim.lastIndex = idx;
          }
        }
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, slotTextures[activeSlot]!);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHasImage, hasActiveImage() ? 1.0 : 0.0);
        g.uniform1f(uGain, params.gain);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        // Close every resident gif frame bitmap (all slots) so we never leak
        // decoded frames on module teardown.
        for (let i = 0; i < ASSET_SLOTS; i++) clearSlotAnim(i);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        for (const tex of slotTextures) gl.deleteTexture(tex);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'hasImage') return hasActiveImage();
        if (key === 'filename') return filename;
        if (key === 'activeSlot') return activeSlot;
        // Current animated-gif frame index of the ACTIVE slot (or -1 when the
        // active slot isn't animating). Test/observability hook.
        if (key === 'activeAnimFrame') return slotAnim[activeSlot]?.lastIndex ?? -1;
        if (key === 'extras') {
          const extras: PictureboxHandleExtras = {
            setImage,
            setFilename: (name) => { filename = name; },
            filename: () => filename,
            setAssetAtSlot: uploadToSlot,
            slotHasAsset: (i) => i >= 0 && i < ASSET_SLOTS && slotLoaded[i] === true,
            selectSlot,
            activeSlot: () => activeSlot,
            setAnimatedImage: (frames) => setAnimatedFrames(activeSlot, frames),
            setAnimatedAtSlot: setAnimatedFrames,
          };
          return extras;
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
