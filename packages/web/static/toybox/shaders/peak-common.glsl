// TOYBOX multi-buffer COMMON — peak-grow (shared GLSL)
//
// Shared helpers for the ORIGINAL "GROWING PEAK" multi-buffer project: a
// growable heightmap (Buffer A, ping-pong feedback) raymarched into a weather
// sky (Image). Authored clean-room for TOYBOX — standard hash/value-noise/fBm
// only, no third-party source text. See peak-bufferA.glsl + peak-image.glsl.

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Ridge fBm target shape for the heightmap — the "ideal" mountain the buffer
// grows TOWARD over many frames.
float ridgeTarget(vec2 q) {
  // q in 0..1 buffer-uv space; centre the peak.
  vec2 d = q - 0.5;
  float r = length(d);
  float peak = exp(-r * r * 7.0);
  float sum = 0.0, amp = 0.55, freq = 4.0;
  vec2 p = q * 4.0;
  vec2 w = vec2(vnoise(p * 0.8), vnoise(p * 0.8 + 3.1));
  p += (w - 0.5) * 1.2;
  for (int i = 0; i < 4; i++) {
    float n = vnoise(p * (freq / 4.0));
    n = 1.0 - abs(2.0 * n - 1.0);
    sum += amp * n * n;
    amp *= 0.5;
    freq *= 1.9;
  }
  return sum * peak;
}
