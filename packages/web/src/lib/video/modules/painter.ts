// packages/web/src/lib/video/modules/painter.ts
//
// PAINTER — an MS-Paint-style drawing surface as a video SOURCE.
//
// The faceplate is a tiny Windows-95 Paint: a toolbar (pencil / brush / line /
// rect / ellipse / fill / eraser / eyedropper / text), the 28-colour palette,
// and an engine-resolution drawing canvas. Whatever the user paints appears, in
// real time, on this module's single video OUTPUT — a 1:1 mapping (the drawing
// canvas IS the frame).
//
// ── ARCHITECTURE (the extras-channel source pattern, same as TEXTMARQUEE /
// PICTUREBOX). The factory is DOM-free-testable: it owns the OUTPUT FBO + an
// "upload texture" and a passthrough blit shader. Some surface hands it a 2-D
// canvas through `read('extras').setPaintCanvas(canvas)`; the factory uploads it
// into the texture each frame and blits it 1:1 into the FBO. Until something
// pushes a canvas, the factory paints a WHITE placeholder (MS-Paint's default
// blank page) so a freshly-spawned node is never a dead black frame — this also
// satisfies the per-port output-emit sweep.
//
// ⚠ WHO PUSHES, AND WHY IT IS NOT A UI QUESTION. The node's picture is the
// deterministic replay of `node.data.ops`, so `$lib/ui/media/extras-producers`
// replays it onto a NODE-owned canvas on NODE lifetime and binds that (#1720) —
// which is what makes a saved rack render the drawing rather than a blank page
// with nothing opened. While the DRAWING SURFACE is mounted (the faceplate's
// `fullViewBody`) it CLAIMS the binding and pushes its own canvas instead,
// because an in-progress stroke must show on OUT before the op commits. Both
// canvases replay the same log, so the lease changes WHICH canvas is bound and
// never WHAT is on it.
//
// The drawing model (the PaintOp log, deterministic apply, flood fill, the
// palette) is pure + unit-tested in painter-draw.ts. This file owns ONLY the GL
// plumbing + the canvas→texture upload + the default placeholder paint.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { PAINT_BG } from './painter-draw';

/** Handle extras a surface (or the node-lifetime producer) resolves via
 *  `engine.read(id, 'extras')` to feed a rendered paint canvas to the engine
 *  module. Mirrors TEXTMARQUEE. */
export interface PainterHandleExtras {
  /** Bind a live paint canvas (engine-resolution, top-left origin, bg already
   *  filled). The factory uploads it each frame. `null` reverts to the white
   *  placeholder — which is why no surface teardown calls it: handing the
   *  binding back to the node-lifetime producer is a `release()`, not a null
   *  push. */
  setPaintCanvas: (canvas: HTMLCanvasElement | OffscreenCanvas | null) => void;
}

// Full-frame passthrough. The paint canvas is engine-resolution + top-left
// origin; GL UV is bottom-left, so flip y in-shader (matches TEXTMARQUEE's
// orientation convention). Outside any uploaded canvas → opaque white (blank
// page), never black.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasCanvas;
void main() {
  if (uHasCanvas < 0.5) { outColor = vec4(1.0, 1.0, 1.0, 1.0); return; }
  outColor = vec4(texture(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb, 1.0);
}`;

export const painterDef: VideoModuleDef = {
  type: 'painter',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'painter',
  category: 'sources',
  inputs: [],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [],

  face: {
    // ⚠ RANKS NOTHING BECAUSE THERE IS NOTHING TO RANK — the flipper/videoOut
    // shape, not an empty declaration. This def carries `params: []` and
    // `inputs: []`; every affordance the module has is either per-collaborator
    // LOCAL tool state (a cell would paint another peer's active tool out from
    // under them mid-stroke) or an op-log ACTION, and neither is a param cell.
    // `module-face-lint`'s empty-lane clause skips exactly this case and
    // negative-controls the skip against `flipper`, so the exclusion is a
    // judgement about the module rather than a hole a face can reach by
    // emptying `order`.
    order: [],

    // ⚠ MECHANICALLY FORCED, not a taste call. This def declares ONE output and
    // it is `video`, so `primaryAudioOutPortId` is null; with no ADSR quartet,
    // no `algorithm` and no `shape` morph, every other literal falls through
    // `glyphBinding` to `{ kind: 'static' }` — a dead deterministic squiggle —
    // which the dead-glyph clause refuses outright. The tile's picture comes
    // from `hasVideoSurface` (the generic `VideoTileThumb`), and for this
    // module that thumbnail IS the drawing.
    glyph: 'none',

    // The dock body — see $lib/ui/modules/painter/. It is not a preview being
    // rescued: it is the nine tools, the palette, the text stamp, UNDO/CLEAR
    // and the canvas whose pixels are this module's video output. See the
    // extension's own header.
    extension: 'painter',
  },

  docs: {
    explanation: `painter is an interactive MS-Paint-style drawing SURFACE that acts as a pure video SOURCE — there is no video input, and no knobs: the pointer IS the instrument. Open its faceplate and you get a tiny Windows-95 Paint: a 9-tool row (pencil, brush, eraser, fill, pick/eyedropper, line, rect, ellipse, text), the classic Win95 swatch grid of 28 colours (2 rows x 14), a SIZE slider, a FILL toggle, a text-stamp field, UNDO/CLEAR, and an engine-resolution drawing canvas. The tools work the MS-Paint way — pencil draws a hard 1px stroke; brush/line/rect/ellipse draw at the SIZE width; FILL toggles a filled vs outlined interior for rect/ellipse; fill flood-fills under the click with the FOREGROUND colour; pick (eyedropper) samples a pixel's colour; and text stamps the typed string. Left-click a swatch sets the FOREGROUND (strokes/text/fill), RIGHT-click sets the BACKGROUND, which is what the eraser paints with and what a filled shape's interior is filled with; tool and colour choices stay LOCAL per collaborator. UNDO removes the last committed op and CLEAR empties the canvas back to a blank white page. Whatever you paint appears in real time on the single video output, 1:1 — the live drawing canvas is bound to the module and the engine uploads + blits it into the output FBO every frame (the drawing buffer is 1024x768, letterboxed by the shader when the engine is running 16:9). Until you draw anything the output is a flat opaque WHITE page (MS-Paint's default blank page), never a dead black frame — the shader returns solid white when no canvas is bound. The drawing is stored as a Y.Doc-synced ordered op log (node.data.ops): each committed stroke/shape/fill/text appends one PaintOp and the log is deterministically replayed on load and on every remote edit, so every collaborator sees the same picture — and the replay is owned by the NODE, not by any surface, so a saved rack shows your drawing on its OUT the moment it loads, with nothing opened. SCREEN ON/OFF puts the whole paint set away and reclaims its space; the module goes on rendering the drawing while it is off, and the switch stays reachable so any collaborator can bring the editor back. Usage: spawn it, pick a tool and colour, draw, and patch OUT (on the yellow drill-down patch panel) into any video destination (mixer, keyer, effect, output) to use your sketch as a live source or hand-drawn matte.`,
    outputs: {
      out: 'Video output carrying the painted canvas at the engine output resolution, blitted 1:1 from the live drawing surface every frame (a flat opaque white page before you draw anything). This is the module\'s only port.',
    },
  },
  factory(ctx, node): VideoNodeHandle {
    void node;
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasCanvas = gl.getUniformLocation(program, 'uHasCanvas');

    const { fbo, texture } = ctx.createFbo();

    // The uploaded paint texture (the bound drawing canvas, or the placeholder).
    const paintTex = gl.createTexture();
    if (!paintTex) throw new Error('PAINTER: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, paintTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let cardCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
    let hasCanvas = false;
    let lastTime = 0;

    /** The factory's own white placeholder canvas (a blank MS-Paint page) so a
     *  fresh node renders non-black before anything binds a canvas. No-ops in a
     *  headless node test where no 2D canvas exists (the unit suite covers the
     *  draw math directly). */
    function paintPlaceholder(): void {
      let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(64, 48);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = 64; c.height = 48; canvas = c;
        }
      } catch { canvas = null; }
      const c2d = canvas
        ? (canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
        : null;
      if (!canvas || !c2d) return;
      c2d.fillStyle = PAINT_BG;
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      cardCanvas = canvas;
      hasCanvas = true;
    }
    paintPlaceholder();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        lastTime = frame.time;

        // Upload the current paint canvas into paintTex (no flip on upload; the
        // shader flips y). Skip if the canvas has zero size (not yet laid out).
        if (cardCanvas && (cardCanvas.width | 0) > 0 && (cardCanvas.height | 0) > 0) {
          g.bindTexture(g.TEXTURE_2D, paintTex);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
          g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, cardCanvas as unknown as TexImageSource);
        }

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.uniform1f(uHasCanvas, hasCanvas ? 1.0 : 0.0);
        if (hasCanvas) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, paintTex);
          g.uniform1i(uTex, 0);
        }
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(paintTex);
        gl.deleteProgram(program);
      },
    };

    const extras: PainterHandleExtras = {
      setPaintCanvas(canvas) {
        if (!canvas) {
          paintPlaceholder();
          return;
        }
        cardCanvas = canvas;
        hasCanvas = true;
      },
    };

    return {
      domain: 'video',
      surface,
      // PAINTER has no engine params (tools/colours are card-local UI state) —
      // these satisfy the VideoNodeHandle contract as no-ops.
      setParam() {},
      readParam() { return undefined; },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'hasCanvas') return hasCanvas;
        if (key === 'lastTime') return lastTime;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
