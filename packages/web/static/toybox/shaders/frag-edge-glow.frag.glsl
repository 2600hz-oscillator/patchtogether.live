// TOYBOX FRAG — edge-glow (SHADERTOY single-pass, scene input)
//
// A neon edge-detector on the composited layers below (iChannel0): a Sobel-style
// luma gradient finds the edges, which are tinted with a hue-cycling neon glow
// and composited back over a darkened copy of the source — the classic "glowing
// outline" / contour look. Reads + transforms iChannel0 throughout.
//
// Authored in-house (clean-room) for TOYBOX — original GLSL. Standard Sobel
// 3×3 luma gradient + additive neon tint; NO third-party / Shadertoy source
// text pasted.
//
// Manifest: shadertoy:true, input:scene. Params:
//   thresh — edge threshold (higher = only the strongest edges glow)
//   glow   — neon edge brightness
//   dark   — how much the underlying image is darkened behind the edges

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

float lumaAt(vec2 uv) {
  return dot(texture(iChannel0, uv).rgb, vec3(0.299, 0.587, 0.114));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 px = 1.0 / iResolution.xy;

  // Sobel 3×3 on luma.
  float tl = lumaAt(uv + px * vec2(-1.0,  1.0));
  float tc = lumaAt(uv + px * vec2( 0.0,  1.0));
  float tr = lumaAt(uv + px * vec2( 1.0,  1.0));
  float ml = lumaAt(uv + px * vec2(-1.0,  0.0));
  float mr = lumaAt(uv + px * vec2( 1.0,  0.0));
  float bl = lumaAt(uv + px * vec2(-1.0, -1.0));
  float bc = lumaAt(uv + px * vec2( 0.0, -1.0));
  float br = lumaAt(uv + px * vec2( 1.0, -1.0));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  float edge = length(vec2(gx, gy));

  // threshold + soften the edge.
  float e = smoothstep(thresh, thresh + 0.3, edge);

  // neon hue cycles over time + edge direction.
  float ang = atan(gy, gx);
  vec3 neon = hsv2rgb(vec3(fract(ang / 6.2831853 + iTime * 0.1), 0.9, 1.0));

  // darkened source behind the glowing edges.
  vec3 src = texture(iChannel0, uv).rgb;
  vec3 col = src * (1.0 - dark) + neon * e * glow;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
