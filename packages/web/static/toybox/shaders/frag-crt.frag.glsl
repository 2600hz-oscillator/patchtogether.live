// TOYBOX FRAG — crt (SHADERTOY single-pass, scene input)
//
// An old CRT / arcade-monitor look on the composited layers below (iChannel0):
// barrel (fisheye) screen curvature, an RGB aperture-grille phosphor mask,
// horizontal scanlines, a rolling brightness bar and a soft vignette. Turns any
// layer into "shot off a tube TV".
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Standard CRT recipe (barrel UV warp,
// per-column RGB phosphor mask, sin scanlines, vignette). No third-party /
// Shadertoy source text copied.
//
// Manifest: shadertoy:true, input:scene. Params:
//   curve — screen curvature (barrel amount)
//   scan  — scanline depth
//   mask  — aperture-grille (phosphor) strength

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // barrel distortion (curve the screen).
  vec2 c = uv * 2.0 - 1.0;
  float k = curve * 0.25;
  c *= 1.0 + k * dot(c, c);
  vec2 wuv = c * 0.5 + 0.5;

  // off-screen (past the curved edge) → black bezel.
  if (wuv.x < 0.0 || wuv.x > 1.0 || wuv.y < 0.0 || wuv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 col = texture(iChannel0, wuv).rgb;

  // aperture-grille RGB phosphor mask (per-pixel-column tint).
  float colx = mod(fragCoord.x, 3.0);
  vec3 phosphor = vec3(
    colx < 1.0 ? 1.0 : 0.35,
    (colx >= 1.0 && colx < 2.0) ? 1.0 : 0.35,
    colx >= 2.0 ? 1.0 : 0.35
  );
  col *= mix(vec3(1.0), phosphor, clamp(mask, 0.0, 1.0));

  // horizontal scanlines + a slow rolling bright bar.
  float sl = 0.5 + 0.5 * sin(wuv.y * iResolution.y * 3.14159);
  col *= 1.0 - scan * (1.0 - sl);
  float roll = 0.5 + 0.5 * sin(wuv.y * 6.0 - iTime * 3.0);
  col *= 0.92 + 0.08 * roll;

  // boost a bit to compensate for the mask darkening, then vignette.
  col *= 1.0 + 0.4 * mask;
  float vig = smoothstep(1.3, 0.3, length(uv * 2.0 - 1.0));
  col *= mix(0.5, 1.0, vig);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
