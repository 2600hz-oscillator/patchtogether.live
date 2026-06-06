// TOYBOX FRAG — kaleido (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: it SAMPLES the composited layers below as
// iChannel0 through a KALEIDOSCOPE fold — polar coords with the angle mirrored
// into N wedges and slowly rotated — so whatever is beneath becomes a spinning
// mandala. A pure displacement/remap of iChannel0 (no recolour), so it reads as
// a clearly FRAG effect on the layers underneath.
//
// Authored in-house (clean-room) for TOYBOX. Standard polar-fold kaleidoscope
// construction (mod the angle into a wedge, mirror, sample) — original GLSL; no
// third-party source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params: segments (wedge count), spin
// (rotation rate), zoom (radial scale).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  // Centre + aspect-correct.
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  float r = length(p);
  float a = atan(p.y, p.x);

  // Fold the angle into N mirrored wedges.
  float n = max(2.0, floor(segments + 0.5));
  float wedge = 6.28318530718 / n;
  a = mod(a, wedge);
  a = abs(a - 0.5 * wedge);   // mirror within the wedge
  a += iTime * spin * 0.5;    // slow rotation

  // Back to cartesian, scaled by zoom, re-centred to sample iChannel0.
  float rr = r / max(0.2, zoom);
  vec2 sp = vec2(cos(a), sin(a)) * rr + 0.5;

  // Sample the layers below through the kaleidoscope fold.
  vec3 col = texture(iChannel0, fract(sp)).rgb;
  fragColor = vec4(col, 1.0);
}
