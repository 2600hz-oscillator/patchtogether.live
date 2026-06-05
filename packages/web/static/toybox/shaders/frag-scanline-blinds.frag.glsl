// TOYBOX FRAG — scanline-blinds (SHADERTOY single-pass, scene input)
//
// A GREYSCALE horizontal-hold / venetian-blind TV glitch on the composited
// layers below (iChannel0): strong horizontal scanline banding splits the image
// into bright bands separated by dark gaps, each band gets its OWN horizontal
// tear/displacement (the picture "slips" sideways per band), highlights bloom
// toward a hot centre, and the whole thing desaturates to a blown-out monochrome
// TV look.
//
// Authored in-house (clean-room) for TOYBOX — original GLSL. Standard glitch
// construction (banded horizontal tear + scanline modulation + radial bloom +
// luma desaturation); NO third-party / Shadertoy source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params:
//   bands  — number of horizontal blind bands (more = finer blinds)
//   tear   — per-band horizontal displacement amount
//   bloom  — highlight bloom toward the hot centre

float hash11(float x) { return fract(sin(x * 78.233) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float t = iTime;

  // Quantise rows into bands; each band shifts horizontally by a per-band amount
  // that wobbles over time (the venetian-blind "slip").
  float nb = max(2.0, bands);
  float band = floor(uv.y * nb);
  float bn = hash11(band + floor(t * 6.0) * 0.31);
  float shift = (bn - 0.5) * tear * 0.12 * (0.5 + 0.5 * sin(t * 2.0 + band));
  vec2 suv = vec2(uv.x + shift, uv.y);

  vec3 src = texture(iChannel0, suv).rgb;

  // Desaturate to greyscale (horizontal-hold sets are monochrome).
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  vec3 grey = vec3(luma);

  // Venetian-blind banding: bright bands, dark gaps. A sharp triangle profile
  // across each band so the blinds read as hard horizontal slats.
  float within = fract(uv.y * nb);
  float slat = smoothstep(0.0, 0.12, within) * smoothstep(1.0, 0.55, within);
  // Fast scanline modulation on top of the slats.
  float scan = 0.6 + 0.4 * sin(uv.y * iResolution.y * 3.14159);
  vec3 col = grey * (0.25 + 0.95 * slat) * scan;

  // Blown-out highlight bloom toward a hot centre.
  float d = distance(uv, vec2(0.5));
  float hot = smoothstep(0.7, 0.0, d);
  col += vec3(1.0) * pow(luma, 2.0) * hot * bloom;
  // Hard clip the brightest parts to white (blown-out highlights).
  col = mix(col, vec3(1.0), smoothstep(0.85, 1.05, max(col.r, max(col.g, col.b))));

  // Faint horizontal noise grain per scanline.
  col += (hash11(uv.x * 311.0 + band + t) - 0.5) * 0.03;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
