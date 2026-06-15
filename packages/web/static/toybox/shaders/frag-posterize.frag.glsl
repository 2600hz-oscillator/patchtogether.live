// TOYBOX FRAG — posterize (SHADERTOY single-pass, scene input)
//
// A poster / screen-print FX on the composited layers below (iChannel0): each
// colour channel is quantised to a small number of LEVELS with an ordered
// (Bayer) dither so the banding stipples instead of hard-stepping, optionally
// pushed toward a duotone ink. Turns any underlying content into a flat, graphic,
// silk-screen look.
//
// Authored in-house (clean-room) for TOYBOX — original GLSL. Standard channel
// quantisation + a 4×4 Bayer ordered-dither matrix + a luma→duotone mix; NO
// third-party / Shadertoy source text pasted.
//
// Manifest: shadertoy:true, input:scene. Params:
//   levels — colour levels per channel (2..8)
//   dither — ordered-dither strength (0 hard bands → 1 stippled)
//   duotone — push toward a 2-ink duotone (0 colour → 1 duotone)

// 4×4 Bayer ordered-dither threshold (0..1) for the pixel.
float bayer(vec2 fc) {
  int x = int(mod(fc.x, 4.0));
  int y = int(mod(fc.y, 4.0));
  int i = x + y * 4;
  // canonical 4×4 Bayer matrix / 16
  float m[16];
  m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
  m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
  m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
  m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
  return m[i] / 16.0 - 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 src = texture(iChannel0, uv).rgb;

  float lv = clamp(levels, 2.0, 8.0);
  float d = bayer(fragCoord) * dither / lv;

  // quantise each channel with the ordered-dither offset
  vec3 q = floor(src * lv + 0.5 + d) / lv;

  // optional duotone: map luma onto a dark-ink → light-paper ramp
  float luma = dot(q, vec3(0.299, 0.587, 0.114));
  vec3 ink = vec3(0.10, 0.08, 0.22);
  vec3 paper = vec3(0.95, 0.92, 0.80);
  vec3 duo = mix(ink, paper, luma);

  vec3 col = mix(q, duo, clamp(duotone, 0.0, 1.0));
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
