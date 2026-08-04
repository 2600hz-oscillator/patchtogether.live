# VideoCube REDESIGN — volumetric 3D spatial video (owner-rejected the flat v1)

> **TRIAGE 2026-08-04 — BUILT. Kept for the OWNER DECISIONS, which are the only
> record of why VIDEOCUBE looks the way it does.**
> The redesign shipped: `packages/web/src/lib/video/modules/videocube.ts` now
> carries the ray-march (`:29` "The picture ray-march (COMBINE_FRAG) is a 1:1
> GLSL" mirror), the orbit camera params `view_zoom / view_rot_x / view_rot_y /
> view_rot_z` (`:158-161, :192-193`), the `screen_on` perf gate (`:165`), and the
> `cube-dsp.fieldFromHeights` unified field (`:13, :32, :441`). The Z-collapse
> root cause named below (`z = (lA+lB+lC)/3`) is gone.
> **The three locked owner decisions of 2026-07-20** — (1) `video_out` is a
> VOLUMETRIC RENDER, not a flat composite; (2) RAY-MARCH over slice-stack, with
> the GPU cost accepted because the pixel-truth test is the local-GPU WebGL attest
> rather than CI SwiftShader; (3) UNIFIED FIELD so audio and video read the SAME
> 3D field — are what this file is preserved for. It also went on to gain SCAN
> (the FrameTable MORPH partner to SPREAD), which post-dates this plan.

Owner reviewed VideoCube #1136 (2026-07-20): "most controls do nothing; no cube-slice /
volumetric visualization; NOT generating volumetric 3D spatial video data based on the source
data connecting to each other through space. Needs to work the same way Cube works for audio.
Seems like it needs a redesign." Root-cause + redesign via workflow wf_93c6a00e-165 (audio-Cube
arch map + redesign proposal), decisions locked by owner AskUserQuestion.

## ROOT CAUSE (verified in code)

The engine collapses the Z axis: it sets occupancy depth `z = (lumaA+lumaB+lumaC)/3` — the average
luma of the 3 source pixels AT THAT SAME (x,y) — so `occ()` is evaluated at exactly ONE point per
pixel. Confirmed in BOTH the shader (`videocube.ts:371 float z=(lA+lB+lC)/3.0`) and the CPU mirror
(`videocube-core.ts:192`). There is no third spatial axis → no volume, no depth, no real slice, and
nothing for the spatial/view controls to act on. It's a flat 2D blend with occ() math on top —
exactly the "flat 2D blend" the owner rejected. Every symptom (dead spatial controls, MORPH bleeds
the wall, slice Y/ROT only shear the temporal read-lag, SPACE DIFFUSE = fixed-corner smear, view
controls ABSENT (0 matches), no volumetric viz) traces to that one collapse.

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

## FILE PLAN (build on branch `feat/videocube-2026-07-19`, PR #1136)

- **videocube-core.ts** — REBUILD. KEEP luma/posterize/warpCoord/stripToHeightfield/constants. DELETE
  `videoField()` (fake shear) + `combinePixel()` (collapsed-z blend). ADD: field-sample helper
  (columnHeights+fieldFromHeights over F(x,y,z)); per-voxel dominant/occupancy-weighted source-colour;
  spatial ring→heightfield reduction (rows×256 luma) SHARED with audio; lowestInfoFace diffuse target.
- **videocube.ts** — REWRITE COMBINE_FRAG flat-blend → ray-march volumetric render (field + march +
  cutting plane + wireframe + orbit camera). ADD view_zoom/view_rot_x/y/z params + camera uniforms;
  renderer-gate march steps. Point `reduceRing` at the new shared spatial reduction; update AUDIO_PARAMS
  /sliceSig for the shared field. KEEP ring capture, detilePending file-load, ensureAudio/recomputeSlice
  seam, mandelbulb-osc.
- **VideocubeCard.svelte** — ADD a VIEW section (ZOOM / X / Y / Z) to the KNOBS bank so the layout
  matches Cube; existing video_out blit shows the volume for free. Optional Canvas2D slice-cross-section
  overlay. KEEP 3 slot pickers, reader/freeze/live rows, toggles, `videocube-*` testids.
- **frametable-ring.ts, cube-dsp.ts, mandelbulb-osc.ts** — UNCHANGED (all reused verbatim).
- **Tests:** rewrite videocube-core.test.ts (field-sample/dominant-colour/spatial-reduction/
  lowestInfoFace CPU mirror); videocube.test.ts factory smoke (volume render + view params);
  videocube.spec.ts e2e — non-black VOLUME frame that CHANGES with view_rot/zoom AND slice Y + audio
  RMS>0, renderer-gated pixel asserts. REPEAT=3 + typecheck before CI.
- **strict-docs.ts** — rewrite co-located docs for the new controls, wrapped in docs-hash-ignore
  markers; `task docs:accept`. rack-sizes videocube stays 3u/hp4.

## MERGE DISCIPLINE

Shader changed → one-time WebGL RE-ATTEST on trusted GPU (kill 5173/4173 + clear node_modules/.vite
first; stale bundle = false refusal). Look-affecting → HOLD for owner VISUAL PREVIEW, NO auto-merge.
Rebase onto main FIRST (picks up #1134/#1135/#1137), attest LAST. See [[frametable-and-videocube]],
[[webgl-attest-hash-test-transparent]], [[webgl-attest-reuses-stale-dev-server]], [[cube-architecture-findings]].
