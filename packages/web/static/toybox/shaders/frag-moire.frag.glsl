// TOYBOX FRAG — moire (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: it displaces the lookup into the composited
// layers below (iChannel0) by two interfering concentric ring gratings, then
// MODULATES the sampled scene brightness by the moiré interference pattern.
// Whatever is beneath ripples + shimmers through the beating rings. Reads +
// transforms iChannel0 (genuine FRAG effect).
//
// Authored in-house (clean-room) for TOYBOX. Standard moiré construction (two
// ring gratings of slightly different scale; their product/sum beats) —
// original GLSL; no third-party source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params: freq (ring frequency), beat
// (scale offset between the two gratings → beat period), displace (UV ripple).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  float t = iTime;
  float f = max(2.0, freq);

  // Two concentric ring gratings, centres drifting in opposite directions.
  vec2 c1 = 0.18 * vec2(sin(t * 0.3), cos(t * 0.27));
  vec2 c2 = -c1;
  float r1 = length(p - c1);
  float r2 = length(p - c2);
  float g1 = sin(r1 * f * 6.2831853 - t);
  float g2 = sin(r2 * f * (1.0 + beat) * 6.2831853 + t);

  // Moiré interference (the low-frequency beat of the two gratings).
  float m = g1 * g2;                 // product → moiré fringes
  float fringe = 0.5 + 0.5 * m;

  // Ripple the scene UV by the local grating gradient, then sample.
  vec2 ruv = uv + displace * 0.02 * vec2(g1, g2);
  vec3 scene = texture(iChannel0, clamp(ruv, 0.0, 1.0)).rgb;

  // Modulate scene brightness by the moiré pattern + a faint cool sheen.
  vec3 col = scene * (0.55 + 0.55 * fringe);
  col += vec3(0.05, 0.10, 0.14) * fringe;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
