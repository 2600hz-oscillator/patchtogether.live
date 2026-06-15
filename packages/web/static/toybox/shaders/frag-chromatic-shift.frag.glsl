// TOYBOX FRAG — chromatic-shift (SHADERTOY single-pass, scene input)
//
// An RGB chromatic-aberration / signal-glitch FX on the composited layers below
// (iChannel0): the three colour channels are sampled with a radial + jittered
// horizontal offset, and occasional horizontal "tear" bands shove whole rows
// sideways for a broken-signal look. Pairs well over any GEN or OBJ layer.
//
// Authored in-house (clean-room) for TOYBOX — original GLSL. Standard per-channel
// UV offset (radial fringe) + hashed row-jitter tears; NO third-party / Shadertoy
// source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params:
//   shift — chromatic-aberration amount (channel separation)
//   tear  — horizontal glitch-tear strength
//   speed — how fast the glitch jitters

float hash11(float x) { return fract(sin(x * 78.233) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float t = iTime * (0.5 + speed);

  // radial direction for the fringe (stronger at the edges)
  vec2 c = uv - 0.5;
  float r = length(c);
  vec2 dir = normalize(c + 1e-5);

  // horizontal tear: per-row hashed offset that flickers in bands
  float row = floor(uv.y * 48.0);
  float band = step(0.86, hash11(row + floor(t * 6.0)));
  float tearAmt = (hash11(row * 1.7 + floor(t * 9.0)) - 0.5) * 0.12 * tear * band;

  vec2 base = uv + vec2(tearAmt, 0.0);

  // chromatic aberration: offset R/B opposite along the radial dir
  float s = shift * 0.012 * (0.4 + r);
  vec3 col;
  col.r = texture(iChannel0, base + dir * s).r;
  col.g = texture(iChannel0, base).g;
  col.b = texture(iChannel0, base - dir * s).b;

  // a faint scanline so the glitch reads as a signal
  col *= 0.9 + 0.1 * sin(uv.y * iResolution.y * 1.6);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
