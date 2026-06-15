#version 300 es
// TOYBOX GEN — aurora-curtains
//
// Northern-lights curtains: vertical ribbons of green/violet light ripple across
// a starry night sky, brightening and folding as they drift. Single-pass +
// generative (no scene input).
//
// Authored clean-room for TOYBOX — original GLSL. Standard value-noise + a
// curtain function (a moving, height-attenuated noise band) + a hashed star
// field; no third-party source text pasted.
//
// Uniforms: iTime, iResolution, plus declared floats: speed, intensity, hue.

precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float iTime;
uniform vec2  iResolution;

uniform float speed;     // drift / ripple rate
uniform float intensity; // overall aurora brightness
uniform float hue;       // colour push (0 green ↔ 1 violet)

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return s;
}

void main() {
  vec2 uv = vUv;
  float t = iTime * (0.3 + speed);

  // night sky gradient
  vec3 col = mix(vec3(0.01, 0.02, 0.06), vec3(0.03, 0.05, 0.12), uv.y);

  // stars (hashed, twinkling, only up high)
  float star = step(0.997, hash21(floor(uv * iResolution.xy * 0.5)));
  col += star * smoothstep(0.2, 1.0, uv.y) * (0.5 + 0.5 * sin(t * 3.0 + hash21(floor(uv * 50.0)) * 30.0));

  // aurora curtains: several horizontally-drifting noise bands that fold upward.
  float aur = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    // each curtain's horizontal wander
    float wander = fbm(vec2(uv.x * 2.5 + fk * 7.0, t * 0.4 + fk)) - 0.5;
    float band = uv.x + wander * 0.6;
    // vertical falloff (curtains hang from the top, fade toward the horizon)
    float h = smoothstep(0.15, 0.85, uv.y) * (1.0 - smoothstep(0.85, 1.0, uv.y));
    // ripple along the curtain
    float ripple = fbm(vec2(band * 6.0, uv.y * 3.0 - t * 0.8 + fk * 4.0));
    float strip = exp(-pow((fract(band * 3.0 + fk * 0.33) - 0.5) * 6.0, 2.0));
    aur += strip * h * ripple;
  }
  aur *= (0.5 + intensity);

  // green ↔ violet aurora palette
  vec3 green = vec3(0.15, 0.95, 0.45);
  vec3 violet = vec3(0.65, 0.30, 0.95);
  vec3 aurCol = mix(green, violet, clamp(hue, 0.0, 1.0));
  col += aurCol * aur;
  // a touch of red fringe at the curtain bases
  col += vec3(0.6, 0.1, 0.3) * aur * aur * 0.2;

  col = col / (col + 0.8);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
