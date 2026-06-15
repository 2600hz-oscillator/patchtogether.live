// TOYBOX GEN — lava-lamp (rising metaball blobs, SHADERTOY single-pass)
//
// Warm wax blobs rise and merge in a backlit lava lamp: a handful of moving
// metaballs sum into a smooth field, thresholded into glossy gradient-shaded
// blobs over a heat-tinted background. Generative, no scene input.
//
// Authored clean-room for TOYBOX — original GLSL. Standard inverse-square
// metaball summation + a smooth threshold; no third-party source text pasted.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed — rise rate of the blobs
//   blobs — number of blobs (1..6)
//   heat  — palette warmth (0 cool lamp → 1 hot magma)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.3 + speed);

  int n = int(clamp(blobs, 1.0, 6.0) + 0.5);
  float field = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    float fi = float(i);
    // each blob bobs vertically + sways horizontally on its own phase
    float y = mod(t * (0.4 + 0.12 * fi) + fi * 0.7, 2.4) - 1.2;
    float x = 0.6 * sin(t * (0.3 + 0.1 * fi) + fi * 2.1);
    float r = 0.22 + 0.10 * sin(t * 0.7 + fi);
    vec2 c = vec2(x, y);
    float d = length(uv - c);
    field += r * r / (d * d + 0.001);
  }

  // smooth threshold → blob mask
  float m = smoothstep(0.9, 1.4, field);

  // heat-tinted background (dark at edges, glowing core)
  vec3 bgCool = vec3(0.06, 0.02, 0.10);
  vec3 bgHot  = vec3(0.18, 0.03, 0.04);
  vec3 bg = mix(bgCool, bgHot, clamp(heat, 0.0, 1.0));
  bg *= mix(0.5, 1.2, smoothstep(1.4, 0.0, length(uv)));

  // blob colour ramps from amber to bright yellow with the field strength
  vec3 amber = mix(vec3(0.9, 0.35, 0.05), vec3(1.0, 0.2, 0.4), clamp(heat, 0.0, 1.0));
  vec3 bright = vec3(1.0, 0.85, 0.4);
  vec3 blob = mix(amber, bright, clamp((field - 1.0) * 0.6, 0.0, 1.0));
  // fake specular highlight near the field gradient peak
  blob += vec3(1.0) * smoothstep(2.2, 3.0, field) * 0.4;

  vec3 col = mix(bg, blob, m);
  col = col / (col + 0.7);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.9));
  fragColor = vec4(col, 1.0);
}
