// TOYBOX FRAG — bloom (SHADERTOY single-pass, scene input)
//
// A light-BLOOM / soft-glow on the composited layers below (iChannel0): the
// bright areas are extracted by a luma threshold and smeared with a small
// multi-tap radial blur, then added back over the original — turning highlights
// into dreamy halos. A single-pass approximation of a threshold→blur→add bloom.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard bloom recipe (luma-threshold
// the bright pass, multi-tap Gaussian-ish blur, additive composite). No
// third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:scene. Params:
//   thresh — brightness cutoff for what blooms
//   glow   — bloom intensity (how much halo is added)
//   radius — blur reach

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 px = 1.0 / iResolution.xy;

  vec3 base = texture(iChannel0, uv).rgb;

  // multi-tap blur of the BRIGHT pass (luma above thresh).
  vec3 bloom = vec3(0.0);
  float wsum = 0.0;
  float rad = 1.0 + radius * 3.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 o = vec2(float(x), float(y));
      float w = exp(-dot(o, o) * 0.15);            // gaussian weight
      vec3 s = texture(iChannel0, uv + o * px * rad).rgb;
      float luma = dot(s, vec3(0.299, 0.587, 0.114));
      vec3 bright = s * smoothstep(thresh, thresh + 0.25, luma);
      bloom += bright * w;
      wsum += w;
    }
  }
  bloom /= max(wsum, 1e-3);

  vec3 col = base + bloom * (glow * 1.5);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
