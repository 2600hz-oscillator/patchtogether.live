// TOYBOX FRAG — ascii (SHADERTOY single-pass, scene input)
//
// A TEXT-MODE / ASCII-art renderer on the composited layers below (iChannel0):
// the image is binned into character cells, each cell's average brightness picks
// a glyph from a dark→light ramp, and the glyph is drawn PROCEDURALLY (no font
// atlas) as a small set of strokes whose coverage rises with brightness — so
// dark cells are blank, mid cells get sparse strokes, bright cells get dense
// blocks. Optionally tinted by the cell's source colour (phosphor terminal look).
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Cell-binning + brightness→glyph-
// density mapping with PROCEDURAL strokes (no copied font/glyph atlas data). No
// third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:scene. Params:
//   cells  — character cells across the screen
//   gamma  — brightness response (contrast of the ramp)
//   tint   — 0 green-terminal monochrome ↔ 1 keep source colour

// procedural glyph coverage for a cell, given local glyph-uv (0..1) and a
// brightness level 0..1. Builds up strokes as level rises (., -, +, #, █).
float glyph(vec2 g, float level) {
  float cov = 0.0;
  // central dot (appears first).
  cov = max(cov, smoothstep(0.30, 0.22, length(g - 0.5)) * step(0.15, level));
  // horizontal bar.
  cov = max(cov, step(0.40, level) * step(abs(g.y - 0.5), 0.12) * step(0.15, g.x) * step(g.x, 0.85));
  // vertical bar (a cross / plus).
  cov = max(cov, step(0.55, level) * step(abs(g.x - 0.5), 0.12) * step(0.15, g.y) * step(g.y, 0.85));
  // diagonal hash.
  cov = max(cov, step(0.70, level) * step(abs(g.x - g.y), 0.14));
  // near-solid block.
  cov = max(cov, step(0.88, level) * step(0.08, min(min(g.x, g.y), min(1.0 - g.x, 1.0 - g.y))));
  return cov;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float aspect = iResolution.x / iResolution.y;

  // cell grid (keep cells roughly square).
  float nx = max(16.0, cells);
  float ny = max(8.0, nx / aspect);
  vec2 grid = vec2(nx, ny);
  vec2 cell = floor(uv * grid);
  vec2 cuv = (cell + 0.5) / grid;        // cell centre
  vec2 g = fract(uv * grid);             // local glyph uv

  vec3 src = texture(iChannel0, cuv).rgb;
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  float level = pow(clamp(luma, 0.0, 1.0), mix(0.5, 2.0, clamp(gamma, 0.0, 1.0)));

  float cov = glyph(g, level);

  vec3 term = vec3(0.25, 1.0, 0.45);     // classic green phosphor
  vec3 ink = mix(term * level, src, clamp(tint, 0.0, 1.0));
  vec3 col = ink * cov;                   // dark background, lit glyphs

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
