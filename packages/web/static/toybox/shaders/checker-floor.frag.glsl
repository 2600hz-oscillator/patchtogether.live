// TOYBOX GEN — checker-floor (perspective rotating checkerboard, SHADERTOY single-pass)
//
// A receding CHECKERBOARD plane under a gradient sky — the rushing ground / "special
// stage" floor of an early-90s mascot platformer (Green Hill / half-pipe vibe). The
// floor rotates about the view axis (`rot`) so it doubles as a rotating special-stage
// maze, scrolls toward the horizon (`speed`), and its tile size is set by `scale`.
// Emerald-green + sky-blue palette. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard perspective-floor projection
// (v = horizon / (y)) + parity checkerboard. Aesthetic HOMAGE only; no copyrighted
// sprites, tiles, logos or source text used.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed — scroll rate toward the horizon
//   rot   — floor rotation about the view axis (special-stage spin)
//   scale — checker tile frequency

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y; // centered, y up
  float t = iTime * (0.4 + speed);

  // rotate the whole field (special-stage rotation).
  float a = rot * t * 0.15 + rot; // rot also biases a static tilt
  float ca = cos(a), sa = sin(a);
  uv = mat2(ca, -sa, sa, ca) * uv;

  vec3 col;
  float horizon = 0.0;
  if (uv.y < horizon - 0.001) {
    // --- floor plane: project screen y → ground depth ---
    float depth = 0.35 / (horizon - uv.y);     // far = small, near = large
    float gx = uv.x * depth;                    // perspective-divided X
    float gz = depth + t;                       // scroll forward
    float f = 2.0 + scale * 8.0;                // tile frequency
    float chk = mod(floor(gx * f) + floor(gz * f), 2.0);
    vec3 a1 = vec3(0.10, 0.55, 0.20);           // emerald
    vec3 a2 = vec3(0.92, 0.96, 0.85);           // pale lime-white
    col = mix(a1, a2, chk);
    // distance fog into the sky colour.
    float fog = clamp(depth * 0.7, 0.0, 1.0);
    col = mix(vec3(0.35, 0.75, 1.0), col, fog);
    // a glinting checker highlight that travels with the scroll.
    col += 0.15 * chk * smoothstep(0.7, 1.0, sin(gz * 3.0) * 0.5 + 0.5);
  } else {
    // --- sky: blue gradient with a soft sun glow ---
    float sky = clamp(uv.y * 1.2, 0.0, 1.0);
    col = mix(vec3(0.55, 0.85, 1.0), vec3(0.12, 0.35, 0.85), sky);
    float sun = smoothstep(0.4, 0.0, length(uv - vec2(0.0, 0.35)));
    col += vec3(1.0, 0.95, 0.7) * sun * 0.6;
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
