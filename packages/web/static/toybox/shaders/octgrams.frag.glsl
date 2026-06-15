// TOYBOX GEN — octgrams (glowing octahedral grid descent, SHADERTOY single-pass)
//
// A neon "shape descent": a repeated lattice of thin octahedron frames glides
// toward the camera through a dark tunnel, glowing along their edges with an
// additive accumulation so the structure reads as a luminous wireframe falling
// past the viewer. The classic "Octgrams" demo look.
//
// /* SHADERDATA
// {
//   "title": "octgrams (toybox clean-room)",
//   "description": "Descending neon octahedron lattice — glowing edge accumulation through a dark tunnel.",
//   "model": "person"
// }
// SHADERDATA */
//
// === LICENSE / PROVENANCE ===
// Inspired by the Shadertoy demo "Octgrams". This is an ORIGINAL, clean-room
// implementation authored for TOYBOX: an octahedron SDF (the standard
// (|x|+|y|+|z|-s)/sqrt(3) form), domain-repetition (opRep), a glow-accumulating
// fixed-step raymarch and a rotation matrix — all standard, widely-documented
// techniques. No third-party source text was copied. Octahedron SDF reference:
// iquilezles.org/articles/distfunctions.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed — descent / rotation rate
//   glow  — edge-glow intensity (additive accumulation gain)
//   scale — lattice cell size

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Octahedron-frame distance: an octahedron shell (abs of solid SDF) so we trace
// the thin EDGES, giving the wireframe look.
float sdOcta(vec3 p, float s) {
  p = abs(p);
  float d = (p.x + p.y + p.z - s) * 0.57735027; // /sqrt(3)
  return d;
}

float box(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Scene: a repeated lattice of octahedron frames, rotating + descending.
float map(vec3 p, float t) {
  // descend the tunnel
  p.z += t * 2.0;
  // slow global twist
  p.xy *= rot(t * 0.2);
  p.xz *= rot(t * 0.15);
  float cell = max(0.6, scale);
  vec3 q = mod(p, cell) - 0.5 * cell;
  // octahedron shell (thin frame)
  float oct = abs(sdOcta(q, cell * 0.34)) - 0.012;
  // a thin box cage interleaved with the octahedra so the lattice reads as
  // struts, not solids — union the two thin shells.
  float cage = abs(box(q, vec3(cell * 0.32))) - 0.015;
  return min(oct, cage);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.6 + speed);

  vec3 ro = vec3(0.0, 0.0, -3.0);
  vec3 rd = normalize(vec3(uv, 1.4));
  rd.xy *= rot(sin(t * 0.1) * 0.2);

  float tt = 0.0;
  float acc = 0.0;          // glow accumulator
  vec3 glowCol = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    vec3 pos = ro + rd * tt;
    float d = map(pos, t);
    // additive glow: brighter the closer the ray passes an edge
    float g = 0.015 / (abs(d) + 0.02);
    acc += g;
    // hue cycles with depth for the neon shimmer
    float hue = fract(0.55 + tt * 0.03 + t * 0.05);
    vec3 c = 0.5 + 0.5 * cos(6.2831853 * (hue + vec3(0.0, 0.33, 0.66)));
    glowCol += c * g;
    tt += max(0.02, abs(d) * 0.7);
    if (tt > 18.0) break;
  }

  float gw = max(0.0, glow);
  vec3 col = glowCol * 0.06 * (0.6 + gw);
  col = col / (col + 1.0);              // soft tonemap of the accumulation
  col = pow(clamp(col, 0.0, 1.0), vec3(0.85));
  // subtle dark vignette so the lattice pops from the void
  col *= mix(0.55, 1.0, smoothstep(1.6, 0.2, length(uv)));
  fragColor = vec4(col, 1.0);
}
