// TOYBOX GEN — hyperspace (radial star-warp jump, SHADERTOY single-pass)
//
// The "jump to lightspeed" look: hashed stars streak radially outward from the
// screen centre into long motion-blurred light trails, with a hot bloom at the
// vanishing point and a faint nebula tint. Built from several rotated star
// LAYERS at different depths for parallax. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// Original clean-room TOYBOX shader. Standard hashed point-grid stars + radial
// motion-blur accumulation (sample the star field along the radial direction);
// original layering + palette. No third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed   — warp / streak rate
//   density — star count per layer
//   warp    — streak length (motion-blur reach)

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// a single star layer sampled at a radial offset along the warp direction.
float starLayer(vec2 uv, float dens, float seed) {
  vec2 g = uv * dens;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id + seed);
  // only some cells hold a star.
  float on = step(0.72, h);
  // jittered position inside the cell.
  vec2 jit = (vec2(hash21(id + seed + 3.1), hash21(id + seed + 7.7)) - 0.5) * 0.7;
  float d = length(f - jit);
  float star = on * smoothstep(0.06, 0.0, d);
  return star * (0.5 + 0.5 * h);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.4 + speed);

  float r = length(uv);
  vec2 dir = normalize(uv + 1e-5);
  float dens = 8.0 + density * 2.0;
  float reach = 0.05 + warp * 0.12;

  // radial motion blur: accumulate the star field stepped along -dir (toward
  // centre) so each star smears into an outward trail; advance with time.
  vec3 col = vec3(0.0);
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float fi = float(i) / float(N);
    // sample position recedes toward the centre + scrolls in with time.
    float depth = fract(fi + t * 0.5);
    vec2 sp = dir * (r - fi * reach) * (1.0 + depth);
    float s = 0.0;
    s += starLayer(sp, dens, 11.0);
    s += starLayer(sp * 1.7, dens * 0.7, 41.0) * 0.7;
    // fade the tail.
    float fade = 1.0 - fi;
    // tint trails warm→cool with radius.
    vec3 tint = mix(vec3(0.7, 0.85, 1.0), vec3(1.0, 0.8, 0.6), depth);
    col += s * fade * tint;
  }
  col /= float(N) * 0.5;

  // faint nebula + hot bloom at the vanishing point.
  col += vec3(0.10, 0.06, 0.20) * (0.5 + 0.5 * hash21(floor(uv * 6.0) + floor(t)));
  col += vec3(0.9, 0.95, 1.0) * exp(-r * 5.0) * 0.7;

  col = col / (col + 0.8);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
