// TOYBOX FRAG — sdf-tunnel (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: it maps the composited layers below
// (iChannel0) onto the walls of an infinite SQUARE TUNNEL. Each pixel's tunnel
// (angle, depth) coordinate samples iChannel0, with depth scrolling toward the
// viewer + a distance fog — so whatever is beneath becomes the texture wrapping
// the tunnel walls. A pure remap of iChannel0 (clearly a FRAG effect).
//
// Authored in-house (clean-room) for TOYBOX. Standard tunnel-projection
// construction (polar-ish wall coordinate from the chebyshev/square radius +
// 1/r depth) — original GLSL; no third-party source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params: speed (fly-in rate), twist
// (angular swirl with depth), fog (distance fade).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  // Square tunnel: use the chebyshev radius so the cross-section is a square.
  float r = max(abs(p.x), abs(p.y)) + 1e-3;
  float ang = atan(p.y, p.x) / 6.28318530718 + 0.5; // 0..1 around the tunnel

  // Depth coordinate: 1/r scrolls toward the viewer; twist swirls the wall.
  float depth = 0.3 / r + iTime * (0.3 + speed);
  float wallU = ang + twist * depth * 0.15;
  float wallV = fract(depth);

  // Sample the scene as the tunnel-wall texture.
  vec3 wall = texture(iChannel0, vec2(fract(wallU), wallV)).rgb;

  // Distance fade: far down the tunnel (small r) goes dark.
  float shade = mix(1.0, smoothstep(0.0, 0.6, r), clamp(fog, 0.0, 1.0));
  vec3 col = wall * shade;

  fragColor = vec4(col, 1.0);
}
