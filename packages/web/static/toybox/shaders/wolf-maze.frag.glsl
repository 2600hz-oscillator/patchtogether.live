// TOYBOX GEN — wolf-maze (first-person brick corridor, SHADERTOY single-pass)
//
// A flat-shaded first-person CORRIDOR rushing forward — the look of an early-90s
// raycaster maze shooter (grey/brown brick walls, lit ceiling, stone floor). Built
// as a rectangular box-tunnel projection (v = 1/distance to each wall), with a
// scrolling brick texture and per-wall flat shading + distance fog, so it reads as
// walking down an endless dungeon hall. Occasional coloured "door" panels slide by.
// Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard demoscene rectangular-tunnel
// projection + procedural brick pattern. Aesthetic HOMAGE only; no copyrighted
// textures, sprites, level data or source text used.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed — forward walk rate
//   fov   — corridor width / wall spread (field of view)
//   bright — overall light level

float hash11(float n) { return fract(sin(n * 78.233) * 43758.5453); }

// brick pattern over (along-corridor u, around v); returns brightness 0.55..1.0
float bricks(vec2 p) {
  p.x += step(0.5, fract(p.y)) * 0.5;       // offset alternate rows
  vec2 f = fract(p);
  float mortar = smoothstep(0.0, 0.06, f.x) * smoothstep(0.0, 0.06, f.y)
               * smoothstep(0.0, 0.06, 1.0 - f.x) * smoothstep(0.0, 0.06, 1.0 - f.y);
  float shade = 0.78 + 0.22 * hash11(floor(p.x) * 13.0 + floor(p.y) * 71.0);
  return mix(0.45, shade, mortar);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y; // centered
  float t = iTime * (0.6 + speed) * 1.5;
  float halfW = 0.45 + fov * 0.5;             // corridor half-width

  vec3 col;
  float ax = abs(uv.x), ay = abs(uv.y);

  if (ax > ay) {
    // --- left / right brick WALL ---
    float dist = halfW / max(ax, 1e-3);       // depth to the wall at this column
    float along = dist + t;                  // scroll forward
    float around = (uv.y * dist) * 1.2 + 0.5;
    vec3 wallCol = vec3(0.55, 0.42, 0.30);   // brown stone
    float b = bricks(vec2(along * 1.5, around * 3.0));
    // sliding coloured door panels.
    float door = step(0.93, fract(along * 0.25 + hash11(floor(along * 0.25))));
    wallCol = mix(wallCol, vec3(0.20, 0.30, 0.55), door * 0.7);
    col = wallCol * b * (uv.x < 0.0 ? 0.8 : 1.0); // shade one side
    float fog = clamp(dist * 0.35, 0.0, 1.0);
    col = mix(col, vec3(0.05, 0.05, 0.07), fog);
  } else if (uv.y > 0.0) {
    // --- ceiling ---
    float dist = halfW / max(ay, 1e-3);
    float fog = clamp(dist * 0.4, 0.0, 1.0);
    col = mix(vec3(0.42, 0.43, 0.48), vec3(0.05, 0.05, 0.07), fog);
  } else {
    // --- stone floor ---
    float dist = halfW / max(ay, 1e-3);
    float along = dist + t;
    float tile = bricks(vec2((uv.x * dist) * 2.0 + 4.0, along * 1.2));
    col = vec3(0.30, 0.27, 0.24) * tile;
    float fog = clamp(dist * 0.4, 0.0, 1.0);
    col = mix(col, vec3(0.05, 0.05, 0.07), fog);
  }

  col *= 0.6 + bright * 0.9;
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
