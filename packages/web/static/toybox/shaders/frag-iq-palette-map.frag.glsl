// TOYBOX FRAG — iq-palette-map (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: it READS the composited layers below as
// iChannel0 and RE-COLOURS them through an Iñigo-Quílez cosine palette keyed on
// the source LUMA. Bright/dark regions of whatever is beneath become positions
// along a smooth multi-hue ramp, so any underlying content is "thermal-mapped"
// into the palette. Uses iChannel0 (recolour) → meaningfully a FRAG (not GEN).
//
// Re-authored (clean-room, MIT) from:
//   * Iñigo Quílez cosine palette: a + b*cos(2pi*(c*t+d)).
//     https://iquilezles.org/articles/palettes/  (technique, MIT)
// Original GLSL; no third-party source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params: amount (mix), shift (palette
// rotation), spread (how much luma range the ramp covers).

vec3 palette(float t) {
  // Warm/cool IQ palette.
  vec3 a = vec3(0.5, 0.5, 0.5);
  vec3 b = vec3(0.5, 0.5, 0.5);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.0, 0.10, 0.20);
  return a + b * cos(6.28318530718 * (c * t + d));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 src = texture(iChannel0, uv).rgb;

  // Key the palette on the source luma (+ a slow time drift so the mapping
  // breathes), scaled by `spread` and rotated by `shift`.
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  float t = luma * max(0.1, spread) + shift + iTime * 0.05;
  vec3 mapped = palette(t);

  // Mix the recoloured result over the original by `amount`.
  vec3 col = mix(src, mapped, clamp(amount, 0.0, 1.0));
  fragColor = vec4(col, 1.0);
}
