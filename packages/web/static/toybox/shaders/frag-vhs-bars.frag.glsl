// TOYBOX FRAG — vhs-bars (SHADERTOY single-pass, scene input)
//
// A FRAG-family Shadertoy shader: an analog-VHS degrade of the composited
// layers below (iChannel0). Horizontal jitter (per-scanline tracking error),
// a rolling tracking BAR that smears + desaturates a band, chroma bleed
// (R/B sampled at a small horizontal offset), and scanline darkening. Reads +
// transforms iChannel0 throughout (a genuine FRAG effect on the layers below).
//
// Authored in-house (clean-room) for TOYBOX. Standard VHS-glitch construction
// (line-jitter from hashed noise + a moving tracking band + chroma offset +
// scanlines) — original GLSL; no third-party source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params: jitter (line-jitter amount),
// bleed (chroma offset px), bar (rolling-bar intensity).

float hash11(float x) { return fract(sin(x * 91.3458) * 47453.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float t = iTime;

  // Per-scanline horizontal jitter (tracking error), strongest on noisy lines.
  float line = floor(uv.y * iResolution.y);
  float n = hash11(line + floor(t * 24.0));
  float jit = (n - 0.5) * jitter * 0.04 * step(0.85, n); // only on some lines
  vec2 juv = vec2(uv.x + jit, uv.y);

  // Rolling tracking bar sweeping up the frame.
  float barPos = fract(-t * 0.12);
  float band = smoothstep(0.06, 0.0, abs(uv.y - barPos));
  // Inside the bar: extra smear + brightness lift.
  juv.x += band * 0.03 * bar;

  // Chroma bleed: sample R/B at a small horizontal offset.
  float px = bleed / iResolution.x;
  vec3 col;
  col.r = texture(iChannel0, juv + vec2(px, 0.0)).r;
  col.g = texture(iChannel0, juv).g;
  col.b = texture(iChannel0, juv - vec2(px, 0.0)).b;

  // Bar desaturates + brightens its band.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma) * 1.2, band * bar * 0.7);

  // Scanline darkening + faint vertical noise grain.
  float scan = 0.85 + 0.15 * sin(uv.y * iResolution.y * 3.14159);
  col *= scan;
  col += (hash11(uv.x * 311.0 + line + t) - 0.5) * 0.04;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
