// TOYBOX FRAG — metaballs-overlay (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: it computes an animated METABALL field and
// uses it to DISTORT + TINT the composited layers below (iChannel0). Inside the
// blobs the scene is refracted (UV pushed along the field gradient) and given a
// neon rim; outside, the scene passes through. Reads + transforms iChannel0, so
// it is a genuine FRAG effect on the layers beneath (not a standalone GEN).
//
// Authored in-house (clean-room) for TOYBOX. Standard metaball construction
// (sum of inverse-square potentials, isosurface threshold) — original GLSL; no
// third-party source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params: count (blob count 1..6),
// radius (blob size), refract (UV-push amount).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  float t = iTime;
  float n = clamp(floor(count + 0.5), 1.0, 6.0);
  float rad = max(0.05, radius);

  // Accumulate the metaball potential + its gradient (for refraction).
  float field = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    if (float(i) >= n) break;
    float fi = float(i);
    // Each blob orbits on its own Lissajous path.
    vec2 c = 0.55 * vec2(
      sin(t * (0.5 + 0.13 * fi) + fi * 1.7),
      cos(t * (0.4 + 0.11 * fi) + fi * 2.3));
    vec2 d = p - c;
    float dd = dot(d, d) + 1e-3;
    float w = (rad * rad) / dd;     // inverse-square potential
    field += w;
    grad += -2.0 * w / dd * d;      // d(field)/d(p)
  }

  // Isosurface mask of the blob interior.
  float inside = smoothstep(0.8, 1.4, field);

  // Refract the scene UV along the field gradient inside the blobs.
  vec2 suv = uv - clamp(refract, 0.0, 1.0) * 0.08 * grad * inside;
  vec3 scene = texture(iChannel0, clamp(suv, 0.0, 1.0)).rgb;

  // Neon rim where the isosurface crosses, plus a cool tint inside.
  float rim = smoothstep(0.9, 1.1, field) * (1.0 - smoothstep(1.1, 1.5, field));
  vec3 tint = mix(scene, scene * vec3(0.6, 0.9, 1.2) + 0.05, inside * 0.6);
  vec3 col = tint + vec3(0.2, 0.8, 1.0) * rim;

  fragColor = vec4(col, 1.0);
}
