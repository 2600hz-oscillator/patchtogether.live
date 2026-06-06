// packages/web/src/lib/video/modules/shapes.ts
//
// SHAPES — geometry source. Mirrors LINES's structure: a single procedural
// fragment shader writes a mono-video stream into the module's FBO.
// Renders one of three primitive shapes (circle, square, triangle), with
// optional tiling across the canvas, plus rotation and zoom.
//
// CV inputs are wired one-per-modulatable-param so the cross-domain CV
// bridge in PatchEngine can drive each via setParam(portId).
//
// Inputs:
//   shape / tile / rotate / zoom (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (mono-video): the rendered shape pattern.
//
// Params:
//   shape (linear 0..2): shape picker (0=circle, 1=square, 2=triangle; lerps between).
//   tile (linear 0..1): tile-blend amount (0 = single shape, 1 = tiled grid).
//   tileN (linear 1..16): grid count when tiled.
//   rotate (linear -π..π): global rotation.
//   zoom (log 0.05..10): scale factor.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uShape;    // 0 = circle, 1 = square, 2 = triangle (rounded toward nearest int)
uniform float uTile;     // 0 = single centered, >=0.5 = repeat across the frame
uniform float uTileN;    // tile count along each axis when tiling on
uniform float uRotate;   // -π..π
uniform float uZoom;     // tiny..large; size of the shape relative to the cell

float sdfCircle(vec2 p, float r) {
  return length(p) - r;
}
float sdfSquare(vec2 p, float r) {
  vec2 d = abs(p) - vec2(r);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
float sdfTriangle(vec2 p, float r) {
  // Equilateral triangle pointing up, inscribed in a circle of radius r.
  // Standard SDF (iquilezles).
  const float k = 1.7320508; // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

void main() {
  // 1. Resolve cell coordinates. When tiling is on, the canvas is
  //    repeated into uTileN×uTileN cells; each cell gets its own copy
  //    of the shape centered at (0,0) in cell-local space ranging from
  //    -0.5..0.5. When tiling is off, the whole frame is one cell.
  vec2 uv = vUv;
  float n = uTile >= 0.5 ? max(1.0, floor(uTileN + 0.5)) : 1.0;
  vec2 cell = fract(uv * n) - 0.5;

  // 2. Rotate + scale. Larger uZoom → larger shape (smaller divisor).
  float cs = cos(uRotate);
  float sn = sin(uRotate);
  vec2 rp = vec2(cell.x * cs - cell.y * sn, cell.x * sn + cell.y * cs);
  // uZoom in (0, ~10]: 1.0 = "fits cell with some room"; smaller = tiny;
  // larger = overflows the cell. Divide so growing zoom shrinks the
  // SDF coordinates → the implicit shape footprint grows.
  float z = max(0.001, uZoom);
  vec2 p = rp / z;

  // Reference radius for each SDF: ~0.4 of cell extent so an unscaled
  // shape sits comfortably with margin.
  float r = 0.4;

  int shape = int(floor(uShape + 0.5));
  float d;
  if (shape <= 0) {
    d = sdfCircle(p, r);
  } else if (shape == 1) {
    d = sdfSquare(p, r);
  } else {
    d = sdfTriangle(p, r);
  }

  // Soft-edge antialiasing band. Scale by 1/zoom so larger zooms keep
  // the edge crisp (avoids the shape going fuzzy when filling the frame).
  float edge = 0.005 / z;
  float band = 1.0 - smoothstep(-edge, edge, d);

  outColor = vec4(band, band, band, 1.0);
}`;

interface ShapesParams {
  shape: number;   // 0..2
  tile: number;    // 0 / 1 toggle
  tileN: number;   // grid count when tiling
  rotate: number;  // -π..π
  zoom: number;    // 0.05..10
}

const DEFAULTS: ShapesParams = {
  shape: 0,    // circle
  tile: 0,     // single centered shape
  tileN: 4,    // 4×4 grid when tiling on
  rotate: 0,
  zoom: 1.0,
};

export const shapesDef: VideoModuleDef = {
  type: 'shapes',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'SHAPES',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // Per-param CV inputs. Mirrors LINES (PR-65): port id == param id so
    // the cross-domain CV bridge in PatchEngine routes audio-side cv
    // signals to setParam(portId).
    { id: 'shape',  type: 'cv', paramTarget: 'shape'  },
    { id: 'tile',   type: 'cv', paramTarget: 'tile'   },
    { id: 'rotate', type: 'cv', paramTarget: 'rotate' },
    { id: 'zoom',   type: 'cv', paramTarget: 'zoom'   },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'shape',  label: 'Shape',  defaultValue: DEFAULTS.shape,  min: 0,    max: 2,         curve: 'linear' },
    { id: 'tile',   label: 'Tile',   defaultValue: DEFAULTS.tile,   min: 0,    max: 1,         curve: 'linear' },
    { id: 'tileN',  label: 'Grid',   defaultValue: DEFAULTS.tileN,  min: 1,    max: 16,        curve: 'linear' },
    { id: 'rotate', label: 'Rotate', defaultValue: DEFAULTS.rotate, min: -3.14159, max: 3.14159, curve: 'linear' },
    { id: 'zoom',   label: 'Zoom',   defaultValue: DEFAULTS.zoom,   min: 0.05, max: 10,        curve: 'log' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uShape  = gl.getUniformLocation(program, 'uShape');
    const uTile   = gl.getUniformLocation(program, 'uTile');
    const uTileN  = gl.getUniformLocation(program, 'uTileN');
    const uRotate = gl.getUniformLocation(program, 'uRotate');
    const uZoom   = gl.getUniformLocation(program, 'uZoom');

    const { fbo, texture } = ctx.createFbo();

    const params: ShapesParams = { ...DEFAULTS, ...(node.params as Partial<ShapesParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.uniform1f(uShape,  params.shape);
        g.uniform1f(uTile,   params.tile);
        g.uniform1f(uTileN,  params.tileN);
        g.uniform1f(uRotate, params.rotate);
        g.uniform1f(uZoom,   params.zoom);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
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
      dispose() { surface.dispose(); },
    };
  },
};
