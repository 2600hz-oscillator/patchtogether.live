// TOYBOX GEN — metaball-field (gooey merging metaballs, SHADERTOY single-pass)
//
// A field of drifting METABALLS (inverse-square charge sources) summed into a
// smooth scalar and thresholded into glossy merging blobs, with iso-contour
// rings for that liquid-mercury / lava-lamp-cross-section feel. Colour ramps
// with the field strength. Generative, no scene input. (Distinct from the FRAG
// metaballs-overlay, which refracts the layer below — this is a stand-alone GEN.)
//
// === LICENSE / PROVENANCE ===
// Original clean-room TOYBOX shader. Standard metaball summation
// (sum r²/(d²+e)) + smooth threshold + iso-contour fract() banding. No
// third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   count — number of metaballs (2..8)
//   speed — drift rate
//   hue   — palette rotation

vec3 palette(float t) {
  vec3 a = vec3(0.5), b = vec3(0.5);
  vec3 c = vec3(1.0);
  vec3 d = vec3(0.30, 0.10, 0.55);
  return a + b * cos(6.28318 * (c * t + d));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  float t = iTime * (0.3 + speed);

  int n = int(clamp(count, 2.0, 8.0) + 0.5);
  float field = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float fi = float(i);
    // each ball orbits on its own lissajous path.
    vec2 c = vec2(
      0.9 * sin(t * (0.4 + 0.07 * fi) + fi * 1.7),
      0.7 * cos(t * (0.3 + 0.09 * fi) + fi * 2.3)
    );
    float r = 0.22 + 0.08 * sin(t + fi);
    vec2 dvec = uv - c;
    float d2 = dot(dvec, dvec) + 0.002;
    field += r * r / d2;
    grad += -2.0 * r * r * dvec / (d2 * d2); // for fake shading
  }

  float m = smoothstep(0.8, 1.3, field);          // blob mask
  float contour = 0.5 + 0.5 * sin(field * 8.0);    // iso-rings

  vec3 col = palette(field * 0.12 + hue + t * 0.04);
  col *= 0.5 + 0.7 * contour;
  // fake specular from the field gradient.
  float spec = clamp(dot(normalize(grad + 1e-4), vec2(0.6, 0.8)), 0.0, 1.0);
  col += vec3(1.0, 0.95, 0.85) * pow(spec, 4.0) * m * 0.6;
  col *= mix(0.18, 1.0, m);  // dark between the blobs

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
