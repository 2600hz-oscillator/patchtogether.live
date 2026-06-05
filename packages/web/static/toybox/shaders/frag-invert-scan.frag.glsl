// TOYBOX FRAG — invert-scan (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: it receives the COMPOSITED LAYERS BELOW as
// iChannel0 and visibly transforms them (colour-inverts, with a moving scanline
// and a subtle horizontal RGB-split). Proves the FRAG model — a fragment shader
// that recolours/displaces the composite beneath it — distinct from GEN (which
// gets no scene input).
//
// Authored in-house (clean-room) for TOYBOX. Manifest: shadertoy:true,
// input:scene. Params: amount (invert/scan mix), split (RGB-split px).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // RGB split: sample iChannel0 at a small horizontal offset per channel,
  // scaled by `split` (declared float uniform) so the effect is dial-able.
  float px = split / iResolution.x;
  vec3 src;
  src.r = texture(iChannel0, uv + vec2(px, 0.0)).r;
  src.g = texture(iChannel0, uv).g;
  src.b = texture(iChannel0, uv - vec2(px, 0.0)).b;

  // Colour invert, mixed by `amount`.
  vec3 inverted = vec3(1.0) - src;
  vec3 col = mix(src, inverted, clamp(amount, 0.0, 1.0));

  // A moving scanline band (animated by iTime) darkens a sweeping row.
  float scan = smoothstep(0.02, 0.0, abs(fract(uv.y * 1.0 - iTime * 0.15) - 0.5) - 0.46);
  col *= 1.0 - 0.5 * scan * clamp(amount, 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}
