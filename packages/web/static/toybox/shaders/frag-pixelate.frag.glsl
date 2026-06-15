// TOYBOX FRAG — pixelate (SHADERTOY single-pass, scene input)
//
// A lo-fi MOSAIC / pixel-sort-ish block effect on the composited layers below
// (iChannel0): the frame is snapped to a coarse pixel grid (mosaic), the colour
// is colour-quantised to a low bit-depth, and a time-varying horizontal SMEAR
// shoves bright blocks sideways for a "datamosh / block-corruption" feel.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard mosaic (floor UV to a grid)
// + colour quantisation + hashed per-row block smear. No third-party /
// Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:scene. Params:
//   blocks — mosaic resolution (blocks across; lower = chunkier)
//   bits   — colour quantisation (low = posterised)
//   smear  — horizontal block-corruption strength

float hash11(float x) { return fract(sin(x * 91.345) * 47453.13); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // mosaic grid.
  float n = max(8.0, blocks);
  vec2 grid = vec2(n, n / (iResolution.x / iResolution.y));
  vec2 cell = floor(uv * grid);
  vec2 muv = (cell + 0.5) / grid;

  // horizontal block smear: per-row hashed offset, flickering in time.
  float row = cell.y;
  float band = step(0.80, hash11(row * 1.3 + floor(iTime * 5.0)));
  float off = (hash11(row + floor(iTime * 8.0)) - 0.5) * 0.15 * smear * band;
  muv.x = fract(muv.x + off);

  vec3 col = texture(iChannel0, muv).rgb;

  // colour quantisation (low bit-depth posterise).
  float levels = max(2.0, floor(bits + 0.5));
  col = floor(col * levels + 0.5) / levels;

  // tint corrupted bands slightly toward magenta/green for the glitch read.
  col = mix(col, col.gbr, band * smear * 0.25);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
