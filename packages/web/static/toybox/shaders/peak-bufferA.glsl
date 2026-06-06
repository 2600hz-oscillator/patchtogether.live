// TOYBOX multi-buffer BUFFER A — peak-grow heightmap (RGBA32F, self-feedback)
//
// The GROWABLE heightmap. Each fragment stores the current terrain height in .r.
// Every frame the stored height eases TOWARD the ridgeTarget() shape (so the
// mountain visibly GROWS out of flat ground over many frames), and an iMouse
// click RAISES the height under the cursor (click-to-grow). The Image pass
// raymarches this buffer.
//
// Self-feedback: iChannel0 is THIS pass's previous frame (ping-pong). Authored
// clean-room for TOYBOX — original growth/erode logic; no third-party source.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // Previous height (0 on the very first frame — flat ground).
  float prev = texture(iChannel0, uv).r;

  // Grow toward the ideal ridge shape: a slow exponential ease so the peak
  // rises over ~a couple seconds of frames rather than popping in.
  float target = ridgeTarget(uv);
  float grown = mix(prev, target, 0.04);

  // iMouse click-to-grow: raise a soft bump under the cursor while the button is
  // held (iMouse.z > 0). iMouse is bottom-origin engine px; convert to buffer uv.
  if (iMouse.z > 0.0) {
    vec2 m = iMouse.xy / iResolution.xy;
    float d = distance(uv, m);
    float bump = exp(-d * d * 60.0) * 0.06;
    grown += bump;
  }

  // Gentle settle so nothing runs away unbounded.
  grown = clamp(grown, 0.0, 2.0);

  fragColor = vec4(grown, target, 0.0, 1.0);
}
