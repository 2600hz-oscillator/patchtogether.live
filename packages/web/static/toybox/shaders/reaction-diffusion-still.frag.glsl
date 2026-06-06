#version 300 es
// TOYBOX GEN — reaction-diffusion-still
//
// A reaction-diffusion-STYLE labyrinth/coral pattern synthesized ANALYTICALLY
// (no feedback buffers): a domain-warped, thresholded multi-octave field shaped
// into the maze-of-stripes look that a Gray-Scott reaction-diffusion settles
// into, with a slow breathing animation. Single-pass + deterministic (no
// iChannel feedback) — the "still" in the name distinguishes it from a true
// multi-buffer RD sim (which the growing-mountain preset shows is possible via
// the same ping-pong feedback infra).
//
// Re-authored (clean-room, MIT) from:
//   * value-noise + domain-warp shaping (the analytic RD-look technique:
//     warp a noise field then threshold to stripes). Original GLSL ES 300
//     implementation; no third-party source text pasted. The simplex-free
//     value noise + warp + ramp are this project's own.
//
// Uniforms: iTime, iResolution, plus declared floats: scale, contrast, drift.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float scale;    // feature scale of the labyrinth
uniform float contrast; // stripe sharpness (how "settled" the RD looks)
uniform float drift;    // slow breathing/animation rate

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Smooth value noise (quintic-faded bilinear of corner hashes).
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0, amp = 0.5, freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime * (0.05 + drift * 0.25);
  vec2 p = uv * max(0.5, scale) * 3.0;

  // Domain warp the field by a slow secondary FBM (this gives the coral/maze
  // meandering RD-like channels rather than blobby noise).
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(3.7, -t)));
  float n = fbm(p + 2.5 * q);

  // Threshold into RD-style stripes: a triangle wave of the field, sharpened by
  // `contrast` → the labyrinth of channels a Gray-Scott sim settles into.
  float bands = abs(fract(n * 4.0) - 0.5) * 2.0;
  float k = clamp(1.0 + contrast * 6.0, 1.0, 12.0);
  float stripes = pow(bands, k);

  // Coral colouring: dark substrate, warm ridges, a cool edge sheen.
  vec3 substrate = vec3(0.04, 0.02, 0.05);
  vec3 ridge     = vec3(0.95, 0.45, 0.20);
  vec3 sheen     = vec3(0.30, 0.55, 0.65);
  vec3 col = mix(substrate, ridge, 1.0 - stripes);
  col += sheen * smoothstep(0.45, 0.5, bands) * (1.0 - stripes) * 0.6;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
