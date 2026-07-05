// packages/web/src/lib/video/modules/textmarquee.ts
//
// TEXTMARQUEE — a rich-text MARQUEE video generator (source).
//
// The user types a styled paragraph in the card's tiny rich-text editor
// (system fonts, per-char colour, bold/italic/underline, paragraph align, a
// layer fg + bg). That serialized RICH-TEXT MODEL is rendered to an OFFSCREEN
// 2D canvas (system-font glyphs — the clean way to get real fonts; you cannot
// rasterize system glyphs in GLSL), uploaded as a WebGL texture, and drawn into
// this module's FBO at a SCROLL offset + screen POSITION. A 90s-screensaver
// marquee: scrollX/scrollY crawl the ribbon (wrapping/re-entering from the
// opposite edge); posX/posY place it (calibrated so a bipolar LFO sweeps it
// fully off one edge → off the other → back).
//
// ── ARCHITECTURE (matches PICTUREBOX's card-owned-source pattern) ──────────
// The factory is DOM-free-testable: it owns the OUTPUT FBO + a "text texture"
// and the scroll/position math (the pure helper in textmarquee-layout.ts). The
// CARD renders the rich-text model → an offscreen canvas and pushes it in via
// `read('extras').setTextCanvas(canvas, w, h)`; the factory uploads it into the
// text texture. Until the card pushes a canvas, the factory renders its OWN
// default placeholder canvas (so a freshly-spawned node is never a dead black
// frame — this also satisfies the per-port output-emit sweep).
//
// ── Inputs / CV ──
//   scrollX / scrollY (cv): horizontal / vertical scroll SPEED (bipolar;
//     knob 0.5 = static). port id == param id, linear cvScale → ±1 sweeps the
//     full speed range centred on the knob.
//   posX / posY (cv): raw screen position (0..1). Calibrated so a default-
//     centred ±1 LFO sweeps the text fully off one edge → off the other → back.
//
// ── Output ──
//   out (video): the rendered + scrolled text layer.
//
// All scroll/position/wrap math is in textmarquee-layout.ts (pure, unit-tested).
// This file owns ONLY GL plumbing + the canvas→texture upload + the default
// placeholder paint.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  computeDrawOffset,
  type RichTextModel,
} from './textmarquee-layout';

/** The handle extras the card resolves via `engine.read(id, 'extras')` to feed
 *  the card-rendered text canvas to the engine module. Mirrors PICTUREBOX's
 *  PictureboxHandleExtras shape. */
export interface TextmarqueeHandleExtras {
  /** Upload the card's freshly-rendered text canvas (system-font glyphs already
   *  drawn, top-left origin, bg filled) + its content pixel size. `null` clears
   *  back to the default placeholder. */
  setTextCanvas: (
    canvas: HTMLCanvasElement | OffscreenCanvas | null,
    contentWidth: number,
    contentHeight: number,
  ) => void;
}

export interface TextmarqueeParams {
  /** Horizontal scroll speed, bipolar 0..1 (0.5 = static). */
  scrollX: number;
  /** Vertical scroll speed, bipolar 0..1 (0.5 = static). */
  scrollY: number;
  /** Raw X position 0..1 (0 = fully off left, 1 = fully off right, 0.5 = centred). */
  posX: number;
  /** Raw Y position 0..1 (0 = fully off top, 1 = fully off bottom, 0.5 = centred). */
  posY: number;
}

export const TEXTMARQUEE_DEFAULTS: TextmarqueeParams = {
  scrollX: 0.5, // static by default — the card-typed text sits where posX/posY put it
  scrollY: 0.5,
  posX: 0.5,    // centred (so the default ±1 LFO sweeps the full off-left→off-right range)
  posY: 0.5,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(TEXTMARQUEE_DEFAULTS));

// Fullscreen-quad shader: draw the (top-left-origin) text texture into the FBO
// at a normalized destination rectangle [uOrigin, uOrigin+uSize) in UV space,
// transparent (black) outside it. The text canvas already carries the bg fill
// over the text block, so outside-the-block reads as the engine-black layer.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uText;   // card-rendered text canvas (top-left origin)
uniform vec2 uOrigin;      // text block top-left in UV (0..1, top-left origin)
uniform vec2 uSize;        // text block size in UV (0..1)
uniform float uHasText;    // 1 when a text canvas is bound, else 0
void main() {
  if (uHasText < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // GL UV is bottom-left origin; the canvas is top-left origin. Work in a
  // top-left UV (flip y) so the destination rect + the sample line up.
  vec2 uvTL = vec2(vUv.x, 1.0 - vUv.y);
  vec2 local = (uvTL - uOrigin) / uSize;       // 0..1 inside the block
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);        // outside the block → layer black
    return;
  }
  outColor = vec4(texture(uText, local).rgb, 1.0);
}`;

/** Default placeholder text rendered into the factory's own canvas before the
 *  card pushes a real model — keeps a fresh node visibly alive. */
const PLACEHOLDER_TEXT = 'textmarquee';

export const textmarqueeDef: VideoModuleDef = {
  type: 'textmarquee',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'textmarquee',
  category: 'sources',
  inputs: [
    // Per-param CV — port id == param id (the cross-domain CV bridge routes
    // onto setParam(portId)). Each carries a linear cvScale so a bipolar ±1
    // source sweeps the param's full range centred on the knob (cv-bridge-map).
    { id: 'scrollX', type: 'cv', paramTarget: 'scrollX', cvScale: { mode: 'linear' } },
    { id: 'scrollY', type: 'cv', paramTarget: 'scrollY', cvScale: { mode: 'linear' } },
    { id: 'posX',    type: 'cv', paramTarget: 'posX',    cvScale: { mode: 'linear' } },
    { id: 'posY',    type: 'cv', paramTarget: 'posY',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'scrollX', label: 'ScrlX', defaultValue: TEXTMARQUEE_DEFAULTS.scrollX, min: 0, max: 1, curve: 'linear' },
    { id: 'scrollY', label: 'ScrlY', defaultValue: TEXTMARQUEE_DEFAULTS.scrollY, min: 0, max: 1, curve: 'linear' },
    { id: 'posX',    label: 'PosX',  defaultValue: TEXTMARQUEE_DEFAULTS.posX,    min: 0, max: 1, curve: 'linear' },
    { id: 'posY',    label: 'PosY',  defaultValue: TEXTMARQUEE_DEFAULTS.posY,    min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `A rich-text MARQUEE video SOURCE — it generates its own picture from text you type, with no video input. You author a styled paragraph in the card's tiny editor (system fonts, per-selection text colour, bold/italic/underline, paragraph align, font family + size, and one layer background fill); that model is rasterized to an offscreen canvas of real system glyphs, uploaded as a texture, and painted into the output frame as a single ribbon. The four knobs only move that ribbon: PosX/PosY place its top-left on screen, and ScrlX/ScrlY crawl it continuously, wrapping back in from the opposite edge once it has fully left — a 90s-screensaver text scroller. Background fills the block's bounding box; everything outside the block reads as layer black. A freshly-spawned node shows a built-in "textmarquee" placeholder until you type. Usage: type a short word at a big SIZE for a screen-filling banner, set a bipolar LFO into ScrlX for a classic side-scroll, or sweep PosX/PosY with an LFO to fly the whole banner fully off one edge, across, and back.`,
    inputs: {
      scrollX: "CV modulating ScrlX — horizontal scroll speed. Bipolar around the knob (0.5 = static): a ±1 source sweeps the full crawl-speed range, scrolling left below centre and right above, with the ribbon wrapping in from the opposite edge.",
      scrollY: "CV modulating ScrlY — vertical scroll speed. Bipolar around the knob (0.5 = static): a ±1 source sweeps the full speed range, crawling the ribbon up or down and wrapping it back in from the opposite edge.",
      posX: "CV modulating PosX — the ribbon's raw horizontal position. Calibrated so a default-centred ±1 LFO drives it fully off the left edge, through centre, to fully off the right edge, and back (a complete margin-to-margin sweep).",
      posY: "CV modulating PosY — the ribbon's raw vertical position. Calibrated so a default-centred ±1 LFO drives it fully off the top, through centre, to fully off the bottom, and back.",
    },
    outputs: {
      out: "The rendered text layer: the styled ribbon drawn at its scrolled position over its background-filled block, with the rest of the frame as layer black.",
    },
    controls: {
      scrollX: "ScrlX — horizontal scroll speed, bipolar 0..1. 0.5 is static (the text sits where PosX/PosY put it); below 0.5 scrolls one way, above 0.5 the other, faster toward the extremes. The ribbon wraps continuously, re-entering from the opposite edge.",
      scrollY: "ScrlY — vertical scroll speed, bipolar 0..1. 0.5 is static; below 0.5 crawls up, above 0.5 crawls down (or vice-versa), faster toward the extremes, wrapping the ribbon back in from the opposite edge.",
      posX: "PosX — raw horizontal position, 0..1. 0 places the ribbon fully off the left edge, 1 fully off the right, 0.5 centred. Combined additively with the ScrlX scroll offset.",
      posY: "PosY — raw vertical position, 0..1. 0 places the ribbon fully off the top, 1 fully off the bottom, 0.5 centred. Combined additively with the ScrlY scroll offset.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uText    = gl.getUniformLocation(program, 'uText');
    const uOrigin  = gl.getUniformLocation(program, 'uOrigin');
    const uSize    = gl.getUniformLocation(program, 'uSize');
    const uHasText = gl.getUniformLocation(program, 'uHasText');

    const { fbo, texture } = ctx.createFbo();

    // The uploaded text texture (the card's rendered canvas, or the placeholder).
    const textTex = gl.createTexture();
    if (!textTex) throw new Error('TEXTMARQUEE: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, textTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: TextmarqueeParams = { ...TEXTMARQUEE_DEFAULTS, ...(filtered as Partial<TextmarqueeParams>) };

    // Current text-block CONTENT size (px) — drives the scroll/wrap span + the
    // destination rectangle. Set when a canvas is uploaded.
    let textW = 0;
    let textH = 0;
    let hasText = false;
    // Whether the bound texture is the card's canvas (true) or the factory
    // placeholder (false). The card always overrides the placeholder on mount.
    let usingCardCanvas = false;

    function uploadCanvas(
      canvas: HTMLCanvasElement | OffscreenCanvas,
      contentWidth: number,
      contentHeight: number,
    ): void {
      gl.bindTexture(gl.TEXTURE_2D, textTex!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // top-left-origin canvas, no flip
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as unknown as TexImageSource);
      textW = Math.max(1, Math.round(contentWidth));
      textH = Math.max(1, Math.round(contentHeight));
      hasText = true;
    }

    // ── Default placeholder paint ──────────────────────────────────────────
    // Render PLACEHOLDER_TEXT into the factory's own offscreen canvas so a
    // freshly-spawned node renders something (and the per-port emit sweep sees
    // a non-black frame). No-ops gracefully in a headless node test where no 2D
    // canvas is available — the unit suite covers the math directly.
    function paintPlaceholder(): void {
      let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(512, 96);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = 512; c.height = 96; canvas = c;
        }
      } catch { canvas = null; }
      const c2d = canvas
        ? (canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
        : null;
      if (!canvas || !c2d) return;
      c2d.fillStyle = '#000000';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      c2d.fillStyle = '#ffffff';
      c2d.font = '64px sans-serif';
      c2d.textBaseline = 'top';
      c2d.fillText(PLACEHOLDER_TEXT, 8, 12);
      uploadCanvas(canvas, canvas.width, canvas.height);
      usingCardCanvas = false;
    }
    paintPlaceholder();

    let lastTime = 0;

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        lastTime = frame.time;

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.uniform1f(uHasText, hasText ? 1.0 : 0.0);
        if (hasText) {
          // Pure scroll/position math → the block's top-left in screen px.
          const { x, y } = computeDrawOffset({
            posX: params.posX,
            posY: params.posY,
            scrollX: params.scrollX,
            scrollY: params.scrollY,
            time: frame.time,
            textWidth: textW,
            textHeight: textH,
            screenW: ctx.res.width,
            screenH: ctx.res.height,
          });
          // Screen px → UV (top-left origin). The shader flips to top-left UV.
          g.uniform2f(uOrigin, x / ctx.res.width, y / ctx.res.height);
          g.uniform2f(uSize, textW / ctx.res.width, textH / ctx.res.height);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, textTex);
          g.uniform1i(uText, 0);
        }

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(textTex);
        gl.deleteProgram(program);
      },
    };

    const extras: TextmarqueeHandleExtras = {
      setTextCanvas(canvas, contentWidth, contentHeight) {
        if (!canvas || contentWidth <= 0 || contentHeight <= 0) {
          // Cleared → fall back to the placeholder so the node never goes black.
          paintPlaceholder();
          return;
        }
        uploadCanvas(canvas, contentWidth, contentHeight);
        usingCardCanvas = true;
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
        if (key === 'extras') return extras;
        // Telemetry / test hooks.
        if (key === 'hasText') return hasText;
        if (key === 'usingCardCanvas') return usingCardCanvas;
        if (key === 'textWidth') return textW;
        if (key === 'textHeight') return textH;
        if (key === 'lastTime') return lastTime;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

// Re-export the model type so the card imports both from one place.
export type { RichTextModel };
