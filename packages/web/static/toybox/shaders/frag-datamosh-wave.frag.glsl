// TOYBOX FRAG — datamosh-wave (SHADERTOY single-pass, scene input)
//
// A COLORFUL datamosh / VHS-corruption rainbow-wave glitch on the composited
// layers below (iChannel0): wavy per-row horizontal displacement (a stack of
// sines so the picture ripples like corrupted P-frames), heavy RGB / chroma
// split, a rainbow hue bleed that washes across the frame, block + line tearing,
// and an oversaturated finish.
//
// Authored in-house (clean-room) for TOYBOX — original GLSL. Standard datamosh
// construction (stacked-sine row warp + per-channel chroma offset + hue add +
// block tear); NO third-party / Shadertoy source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params:
//   wave   — per-row sine displacement amount (the wavy ripple)
//   split  — RGB/chroma split distance
//   rainbow— rainbow hue-bleed + saturation amount

float hash11(float x) { return fract(sin(x * 91.345) * 47453.5453); }

// branchless HSV->RGB for the rainbow bleed.
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float t = iTime;

  // Stacked-sine per-row horizontal displacement — the wavy datamosh ripple.
  float w = 0.0;
  w += sin(uv.y * 11.0 + t * 2.0) * 0.5;
  w += sin(uv.y * 27.0 - t * 3.3) * 0.3;
  w += sin(uv.y * 53.0 + t * 1.1) * 0.2;
  float disp = w * wave * 0.04;

  // Block / line tearing: occasional rows jump by a hashed amount.
  float row = floor(uv.y * 90.0);
  float tear = (hash11(row + floor(t * 8.0)) > 0.9)
    ? (hash11(row * 1.7) - 0.5) * 0.25 : 0.0;

  vec2 wuv = vec2(uv.x + disp + tear, uv.y);

  // Heavy RGB / chroma split: sample each channel at a growing horizontal offset.
  float s = split / iResolution.x * 6.0;
  vec3 col;
  col.r = texture(iChannel0, wuv + vec2(s, 0.0)).r;
  col.g = texture(iChannel0, wuv).g;
  col.b = texture(iChannel0, wuv - vec2(s, 0.0)).b;

  // Rainbow hue bleed: add a slow hue sweep across the frame, scaled by luma so
  // it bleeds out of the bright structure.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 bleed = hsv2rgb(vec3(fract(uv.x * 0.8 + uv.y * 0.3 + t * 0.15), 0.9, 1.0));
  col = mix(col, col + bleed * luma, rainbow * 0.6);

  // Oversaturate.
  vec3 g = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
  col = mix(g, col, 1.0 + rainbow * 1.2);

  // Faint horizontal scan grain so it reads as tape.
  col += (hash11(uv.x * 211.0 + row + t) - 0.5) * 0.04;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
