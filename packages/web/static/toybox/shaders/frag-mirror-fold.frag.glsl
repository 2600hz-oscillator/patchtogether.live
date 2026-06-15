// TOYBOX FRAG — mirror-fold (SHADERTOY single-pass, scene input)
//
// A RECTANGULAR mirror-kaleidoscope on the composited layers below (iChannel0):
// the UV plane is repeatedly folded across mirror lines (triangle-wave / abs
// reflection) and recentred, so the layer below tiles into a seamless mirrored
// quilt. A slow drift + rotation of the fold origin makes the quilt breathe.
// Distinct from FRAG KALEIDO (polar wedge fold) — this is a planar mirror tile.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard triangle-wave mirror folding
// (abs(fract*2-1)) iterated for a kaleidoscopic tile; original drift/rotation. No
// third-party / Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:scene. Params:
//   folds — number of mirror folds (tile density)
//   spin  — fold-frame rotation rate
//   drift — pan speed of the fold origin

vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
  float t = iTime;

  // rotate + drift the fold frame.
  p = rot(p, t * spin * 0.3);
  p += vec2(sin(t * drift * 0.4), cos(t * drift * 0.3)) * 0.3;

  // repeated mirror folds (triangle wave) → kaleidoscopic tiling.
  float n = max(1.0, floor(folds + 0.5));
  vec2 q = p * n;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= n) break;
    q = abs(fract(q * 0.5) * 2.0 - 1.0);  // mirror fold into [0,1]
    q = rot(q - 0.5, 0.2) + 0.5;          // slight twist between folds
  }

  // sample the layer below through the folded coordinate.
  vec2 sp = fract(q * 0.5 + 0.25);
  vec3 col = texture(iChannel0, sp).rgb;

  // mirror-seam shimmer for the kaleidoscope read.
  float seam = abs(q.x - 0.5) + abs(q.y - 0.5);
  col *= 0.85 + 0.15 * sin(seam * 12.0 - t);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
