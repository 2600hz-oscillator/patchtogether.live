// TOYBOX FRAG — zoom-warp (SHADERTOY single-pass, scene input)
//
// A radial zoom + swirl warp of the composited layers below (iChannel0): the
// image is sampled along a spiral remap (zoom toward/away from a centre plus a
// radius-dependent rotation), with a subtle per-radius chroma offset so the
// warped edges fringe. Pairs naturally with a FEEDBACK combine node for endless
// droste-zoom trails, but stands alone as a swirl FX too.
//
// Authored in-house (clean-room) for TOYBOX — original GLSL. Standard polar
// remap (centre, zoom, radius·twist rotation) + chroma offset; NO third-party /
// Shadertoy source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params:
//   zoom   — radial zoom amount (>0 zoom in, <0 out — centred at 0.5)
//   twist  — radius-dependent rotation (swirl)
//   fringe — per-radius chroma offset (edge fringing)

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  // aspect-correct, centred coordinates.
  float aspect = iResolution.x / iResolution.y;
  vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(c);
  float a = atan(c.y, c.x);

  // radial zoom + swirl: shrink the radius (zoom in) and rotate by r·twist.
  float z = 1.0 - zoom * 0.15;
  a += r * twist - iTime * 0.05;
  float rr = r * z;
  vec2 wc = vec2(cos(a), sin(a)) * rr;
  vec2 wuv = wc / vec2(aspect, 1.0) + 0.5;

  // per-radius chroma offset so the warp fringes.
  float f = fringe * 0.01 * (0.5 + r);
  vec2 dir = normalize(c + 1e-5);
  vec3 col;
  col.r = texture(iChannel0, wuv + dir * f).r;
  col.g = texture(iChannel0, wuv).g;
  col.b = texture(iChannel0, wuv - dir * f).b;

  // vignette so the swirl reads as a lens.
  col *= mix(0.7, 1.0, smoothstep(1.2, 0.2, r));

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
