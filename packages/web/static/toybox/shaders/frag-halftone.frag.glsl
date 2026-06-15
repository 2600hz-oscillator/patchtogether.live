// TOYBOX FRAG — halftone (SHADERTOY single-pass, scene input)
//
// A newsprint / comic-book HALFTONE screen on the composited layers below
// (iChannel0): the image is reproduced as a grid of dots whose RADIUS tracks
// local darkness, on a rotated screen angle (the classic CMYK rosette feel via a
// single angled dot screen). DUOTONE control collapses it to two-ink print.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard angled dot-screen halftone
// (rotate UV → cell grid → dot radius from luma → coverage). No third-party /
// Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:scene. Params:
//   cells   — dot screen frequency (dots across)
//   angle   — screen rotation (radians-ish, scaled)
//   duotone — 0 keep colour ↔ 1 two-ink (ink over paper)

vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float aspect = iResolution.x / iResolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec3 src = texture(iChannel0, uv).rgb;
  float luma = dot(src, vec3(0.299, 0.587, 0.114));

  // rotated dot-screen grid.
  float freq = 20.0 + cells * 6.0;
  vec2 g = rot(p, angle * 0.7) * freq;
  vec2 cell = fract(g) - 0.5;
  float d = length(cell);

  // dot radius grows as the image gets DARKER (more ink).
  float ink = 1.0 - luma;
  float radius = sqrt(ink) * 0.72;
  float dot = smoothstep(radius, radius - 0.08, d);  // 1 inside the dot

  // colour mode: tint the dots with the source colour; duotone collapses to
  // an ink colour over a paper colour.
  vec3 paper = vec3(0.96, 0.94, 0.88);
  vec3 inkCol = vec3(0.06, 0.05, 0.10);
  vec3 duo = mix(paper, inkCol, dot);
  vec3 chroma = mix(paper, src * 1.1, dot);
  vec3 col = mix(chroma, duo, clamp(duotone, 0.0, 1.0));

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
