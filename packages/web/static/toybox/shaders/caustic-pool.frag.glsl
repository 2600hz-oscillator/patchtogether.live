// TOYBOX GEN — caustic-pool (underwater light caustics, SHADERTOY single-pass)
//
// The dancing CAUSTIC net you see on a pool floor: layered, time-warped
// trigonometric ripples folded with abs() into bright filament lines, summed
// over a few octaves and tinted aqua→white. A slow domain drift makes the net
// breathe. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// Original clean-room TOYBOX shader. The "sum of folded sine ripples → caustic
// filaments" approach is a standard, widely-published technique; the field,
// octave mix and palette are original. No third-party / Shadertoy source text
// copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   scale — ripple frequency
//   speed — ripple animation rate
//   bright — caustic brightness / contrast

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime * (0.3 + speed);
  float s = 4.0 + scale * 6.0;

  vec2 q = p * s;
  float caustic = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    // two interfering rippling wavefronts, folded into filaments with abs().
    float w1 = sin(q.x * 1.3 + t * 1.1 + fi) + sin(q.y * 1.1 - t * 0.9 + fi * 1.7);
    float w2 = sin((q.x + q.y) * 0.9 + t + fi) + sin((q.x - q.y) * 1.05 - t * 1.2 + fi);
    float fold = 1.0 - abs(sin(w1 + w2));
    caustic += amp * pow(fold, 3.0);
    // rotate + scale the domain for the next octave.
    q = mat2(0.8, -0.6, 0.6, 0.8) * q * 1.8 + 1.3;
    amp *= 0.55;
  }
  caustic *= (0.6 + bright);

  // aqua water bed → bright caustic lines.
  vec3 water = vec3(0.02, 0.18, 0.28);
  vec3 light = vec3(0.6, 0.95, 1.0);
  vec3 col = water + light * caustic;
  // a touch of white on the brightest crossings.
  col += vec3(1.0) * smoothstep(1.2, 2.2, caustic) * 0.5;

  col = col / (col + 0.8);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
