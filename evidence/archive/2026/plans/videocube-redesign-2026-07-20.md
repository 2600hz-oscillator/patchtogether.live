# VideoCube REDESIGN — volumetric 3D spatial video (owner-rejected the flat v1)

> **BUILT. Kept for the ROOT CAUSE and the OWNER DECISIONS, which are the only
> record of why VIDEOCUBE looks the way it does.**
> The redesign shipped: `packages/web/src/lib/video/modules/videocube.ts` carries
> the ray-march under an orbitable camera, the orbit-camera params
> (`view_zoom` / `view_rot_x` / `view_rot_y` / `view_rot_z`), the `screen_on`
> perf gate, and the `cube-dsp.fieldFromHeights` unified field. The Z-collapse
> root cause named below is gone. It later gained **SCAN** (the FrameTable MORPH
> partner to SPREAD), which post-dates this plan.
> No outstanding work: "SPREAD + FOLD stay AUDIO-ONLY for v1" was a scoping
> decision, and the Canvas2D slice-cross-section overlay was marked optional and
> never wanted.

Owner reviewed VideoCube #1136 (2026-07-20):

> "most controls do nothing; no cube-slice / volumetric visualization; NOT
> generating volumetric 3D spatial video data based on the source data
> connecting to each other through space. Needs to work the same way Cube works
> for audio. Seems like it needs a redesign."

## ROOT CAUSE (verified in code)

The engine collapsed the Z axis: it set occupancy depth `z = (lumaA+lumaB+lumaC)/3`
— the average luma of the 3 source pixels **AT THAT SAME (x,y)** — so `occ()` was
evaluated at exactly ONE point per pixel. Confirmed in BOTH the shader
(`videocube.ts:371` `float z=(lA+lB+lC)/3.0`) and the CPU mirror
(`videocube-core.ts:192`). There was no third spatial axis → no volume, no depth,
no real slice, and nothing for the spatial/view controls to act on. It was a flat
2D blend with occ() math on top — exactly the "flat 2D blend" the owner rejected.

**Every symptom** — dead spatial controls, MORPH bleeding the wall, slice Y/ROT
only shearing the temporal read-lag, SPACE DIFFUSE as a fixed-corner smear, view
controls ABSENT (0 matches), no volumetric viz — **traces to that one collapse.**

## OWNER DECISIONS (locked 2026-07-20)

1. **video_out = VOLUMETRIC RENDER** of the 3D occupancy solid, textured by the 3 source videos —
   an orbitable camera looking THROUGH the three videos joined across a real depth axis. (Rejects the
   flat composite. The card viz IS this same render.)
2. **RAY-MARCH (solid look)**, not slice-stack. Owner accepts the GPU/CI cost because the heavy
   render tests go through the **WebGL attest on the local trusted GPU**, NOT the CI SwiftShader
   shards (standard attest workflow). So CI stays cheap; the pixel-truth test is the attest.
3. **UNIFIED FIELD** — audio + video read the SAME 3D spatial field, so slice Y / rotation drive ONE
   plane in both domains (tightest "works like Cube" isomorphism). Audio becomes a bit less
   time-evolving than the current 60-frame temporal reduction — accepted.

Parent-set Cube-parity defaults (not asked, sensible): real Z-roll camera (view_rot_z gets a genuine
roll, not Cube's dead-Z); SPREAD + FOLD stay AUDIO-ONLY for v1; ONE GLOBAL reader (no per-slot).

## THE ISOMORPH (audio Cube → VideoCube), from cube-dsp.ts

Audio Cube = stack 3 wavetables into a 3D solid, fly a plane through it, read the plane's
intersection-depth as a 256-sample wave. VideoCube = **same field, sourced from 3 video-luma
surfaces instead of 3 wavetables**, output = a render of the solid instead of a 1-D scan.

- **FIELD:** per frame the reader selects one frame from each 60-frame ring → 3 luma SURFACES
  S_A/S_B/S_C(x,y) = FLOOR/WALL/CEILING heightfields (keep their RGB for texturing). The scalar field
  is `cube-dsp.fieldFromHeights(z; S_A,S_B,S_C, morph, connect, connectStrength, material)` over
  (x,y,z)∈[0,1]³. `z` is a GENUINE synthetic connecting depth: `occ()` fills solid density BETWEEN
  S_A↔S_B and S_B↔S_C; MORPH crossfades the two fills; CONNECT/STRENGTH shape the vertical connector;
  SMOOTH=continuous, HARD=binary. Byte-for-byte cube-dsp's field, luma-sourced.
- **RENDER (ray-march):** cast a camera ray per output pixel, march K steps (renderer-gate: ~32 soft /
  64 GPU) through [0,1]³ under the orbit camera; at each step apply SPACE CRUSH (`spaceCrushCoord`) →
  SPACE DIFFUSE (`diffusePull` toward `lowestInfoFace`) → WRAP (`wrapFold`) to (x,y); read S_A/S_B/S_C
  RGB+luma; `F = fieldFromHeights(z;…)`; front-to-back composite the occupancy-weighted source RGB
  (SMOOTH = weighted blend of A/B/C, HARD = max-weight source) with alpha ∝ F (posterized by CRUSH),
  early-terminate on alpha saturation. Plus draw the CUTTING SLICE PLANE (`cube-dsp.rotate(sliceY,
  rx,ry,rz)`) tinted by the density it cuts — the exact plane the audio reads — and a 12-edge
  wireframe for orientation. Camera: `dist=2.6/view_zoom`, eye from view_rot_x (elev) / view_rot_y
  (azim), view_rot_z = roll; lookAt origin.
- **AUDIO (unified):** point `reduceRing` at the SAME spatial ring→heightfield reduction; the derived
  audio slice = `cube-dsp.sampleSlice()` through the SAME field along the SAME plane (slice Y/ROT),
  → 256-sample `setWave` to `mandelbulb-osc`. FOLD/SPREAD/TUNE/FINE/LEVEL audio-only, as Cube.

## CONTROL MAP (every control now LIVE, isomorphic to Cube)

MORPH=3D fill crossfade A→C thru B; CONNECT=connector profile (ellipse↔V); CONNECT STRENGTH=interior
swell; CRUSH=amplitude/colour posterize + spatial coord-snap; SPACE CRUSH=voxelize field lookup;
SPACE DIFFUSE=pull toward field-latched lowestInfoFace; MATERIAL=SMOOTH translucent↔HARD blocky; WRAP=
clamp↔mirror-fold; Y=cutting-plane height; ROT X/Y/Z=Euler tilt of the plane; VIEW ZOOM/X/Y/Z=NEW orbit
camera (shapes the OUTPUT, deliberate divergence from Cube's viz-only view); FOLD/SPREAD/TUNE/FINE/
LEVEL=audio-only; READER(SMOOTH/MORPH/CHAOS)/FREEZE/LIVE=frametable ingest (no Cube analog); SCREEN=
perf gate (skip render when off && video_out unpatched).
