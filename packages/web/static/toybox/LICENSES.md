# TOYBOX shader bank — licenses

Most shaders in `shaders/` are **original code, re-authored clean-room** from
the named MIT reference function modules below (the MIT table). The EXCEPTIONS
are the explicitly-attributed **Shadertoy ports under CC BY 3.0** listed in the
separate CC-BY table further down — those are verbatim ports kept under their
original CC BY 3.0 attribution licence. **No CC-BY-NC / non-commercial code is
used anywhere.** For the MIT bank: the helper functions (simplex noise, FBM
octave-sum, Worley neighbour-scan, HSV→RGB, IQ cosine-palette) are standard,
widely-published formulations transcribed into GLSL ES 300; the driving fields
and colour ramps are this project's own — unambiguously MIT and compatible with
this repository's licensing.

| Asset | SPDX | Re-authored from (source) | URL |
| --- | --- | --- | --- |
| `shaders/noise-fbm.frag.glsl` | MIT | stegu / webgl-noise (Ashima 2D simplex) + glsl-fbm (octave sum) | https://github.com/stegu/webgl-noise , https://github.com/yiwenl/glsl-fbm |
| `shaders/worley-cells.frag.glsl` | MIT | glsl-worley (3×3 F1/F2 cellular search) | https://github.com/Erkaman/glsl-worley |
| `shaders/hsv-plasma.frag.glsl` | MIT | glsl-hsv2rgb (branchless HSV→RGB) | https://github.com/hughsk/glsl-hsv2rgb |
| `shaders/cos-gradient.frag.glsl` | MIT | glsl-cos-palette (IQ cosine-palette technique) | https://github.com/Jam3/glsl-cos-palette |
| `shaders/voronoi-edges.frag.glsl` | MIT | Iñigo Quílez — "Voronoi - distances" edge-distance technique | https://iquilezles.org/articles/voronoilines/ |
| `shaders/gradient-noise.frag.glsl` | MIT | Iñigo Quílez — 2D gradient noise (hash-gradient dot + quintic fade) | https://iquilezles.org/articles/gradientnoise/ |
| `shaders/hex-grid.frag.glsl` | MIT | Original — public hex-lattice nearest-cell construction (Red Blob Games / IQ hex tutorials) | https://www.redblobgames.com/grids/hexagons/ |
| `shaders/truchet.frag.glsl` | MIT | Original — classic Truchet (Smith) tile construction (per-cell coin-flip quarter arcs) | https://en.wikipedia.org/wiki/Truchet_tiles |
| `shaders/star-field.frag.glsl` | MIT | Original — standard layered hashed-grid parallax starfield | (this project) |
| `shaders/reaction-diffusion-still.frag.glsl` | MIT | Original — analytic RD-look (domain-warped value noise thresholded to labyrinth stripes) | (this project) |
| `shaders/frag-iq-palette-map.frag.glsl` | MIT | Iñigo Quílez — cosine palette (luma → palette recolour of iChannel0) | https://iquilezles.org/articles/palettes/ |
| `shaders/frag-kaleido.frag.glsl` | MIT | Original — standard polar-fold kaleidoscope remap of iChannel0 | (this project) |
| `shaders/frag-metaballs-overlay.frag.glsl` | MIT | Original — inverse-square metaball field refracts/tints iChannel0 | (this project) |
| `shaders/frag-sdf-tunnel.frag.glsl` | MIT | Original — square-tunnel projection mapping iChannel0 onto the walls | (this project) |
| `shaders/frag-moire.frag.glsl` | MIT | Original — two interfering ring gratings modulate/ripple iChannel0 | (this project) |
| `shaders/frag-vhs-bars.frag.glsl` | MIT | Original — analog-VHS degrade (line jitter + tracking bar + chroma bleed + scanlines) of iChannel0 | (this project) |
| `shaders/growing-mountain.frag.glsl` | MIT | Original — single-pass raymarched GROWING peak (ridge-fBm heightmap + growth envelope) under weather (day/night sky, drifting clouds, fog, rain, lightning), click-to-grow via iMouse | (this project) |
| `shaders/peak-common.glsl` | MIT | Original — shared hash/value-noise/ridge-target helpers for the GROWING PEAK multi-buffer project | (this project) |
| `shaders/peak-bufferA.glsl` | MIT | Original — growable self-feedback heightmap buffer (RGBA32F ping-pong easing toward a ridge target; iMouse click-to-raise) | (this project) |
| `shaders/peak-image.glsl` | MIT | Original — fixed-step height-field raymarch of peak-bufferA into a weather sky | (this project) |
| `shaders/flow-field.frag.glsl` | MIT | Original — curl-of-scalar-potential flow field, streamline-integrated + speed-ramped | (this project) |
| `shaders/interference.frag.glsl` | MIT | Original — superposition of moving point-source circular wavefronts (moiré interference), hue-cycled | (this project) |
| `shaders/spiral-bloom.frag.glsl` | MIT | Original — log-spiral polar petals, pulsing + hue-cycled (feedback-friendly mandala) | (this project) |
| `shaders/frag-scanline-blinds.frag.glsl` | MIT | Original — greyscale horizontal-hold / venetian-blind glitch (banded horizontal tear + scanline modulation + radial highlight bloom + desaturation) of iChannel0 | (this project) |
| `shaders/frag-datamosh-wave.frag.glsl` | MIT | Original — colourful datamosh (stacked-sine per-row warp + RGB/chroma split + rainbow hue bleed + block/line tearing + oversaturation) of iChannel0 | (this project) |
| `shaders/frag-zoom-warp.frag.glsl` | MIT | Original — radial zoom + swirl polar remap with per-radius chroma fringe of iChannel0 (feedback-friendly) | (this project) |
| `shaders/frag-edge-glow.frag.glsl` | MIT | Original — Sobel luma-gradient edge detector tinted with a hue-cycling neon glow over a darkened iChannel0 | (this project) |
| `shaders/seascape.frag.glsl` | MIT | Original clean-room — animated ocean (sum-of-octaves heightfield + analytic normals + Fresnel sky/water mix). Titled after TDM's "Seascape" (Shadertoy `Ms2SD1`), which is **CC BY-NC-SA 3.0 / non-commercial** — NOT used; this is a from-technique reimplementation. | (this project) |
| `shaders/octgrams.frag.glsl` | MIT | Original clean-room — neon octahedron-lattice "descent" (folded-space SDF box frame raymarch + glow). Inspired by the "octgrams" Shadertoy look; no source text copied. | (this project) |
| `shaders/vangogh-sunset.frag.glsl` | MIT | Original clean-room — Van Gogh "Starry Night" swirling sky (curl-of-scalar-potential flow + domain-warped fBm + directional brush-stroke modulation + haloed stars/moon). Titled after Vincent van Gogh's public-domain painting; no image asset / source text used. | (this project) |
| `shaders/raymarch-primitives.frag.glsl` | MIT | Original clean-room — SDF-primitive gallery (sphere/box/torus/etc. sphere-tracing + soft shadows + AO), AA fixed at 1 for CI. Titled after IQ "Raymarching - Primitives" (`Xds3zN`), whose canonical page badge is **CC BY-NC-SA 3.0 / non-commercial** — NOT used; standard public SDF formulae only. | (this project) |
| `shaders/lava-lamp.frag.glsl` | MIT | Original clean-room — rising/merging metaball wax blobs (inverse-square field + smooth threshold + heat palette) | (this project) |
| `shaders/circuit-bloom.frag.glsl` | MIT | Original clean-room — glowing circuit-board traces (grid-cell wire routing + pulsing data packets) | (this project) |
| `shaders/frag-chromatic-shift.frag.glsl` | MIT | Original — RGB chromatic-aberration + hashed horizontal-tear glitch of iChannel0 | (this project) |
| `shaders/frag-posterize.frag.glsl` | MIT | Original — colour quantisation + ordered (Bayer) dither + optional duotone of iChannel0 | (this project) |
| `shaders/plasma-flow.frag.glsl` | MIT | Original — demoscene sine-plasma (sum of axis/radial/moving-centre sines) + IQ cosine palette | (this project) |
| `shaders/kaleido-bloom.frag.glsl` | MIT | Original — generative kaleidoscope mandala (polar wedge fold + radial petal/ring pattern), distinct from the FRAG kaleido (which folds the layer below) | (this project) |
| `shaders/warp-tunnel.frag.glsl` | MIT | Original — demoscene polar tunnel (u=angle, v=1/r) with a procedural wall pattern + distance fog | (this project) |
| `shaders/metaball-field.frag.glsl` | MIT | Original — generative metaballs (inverse-square field + iso-contours + gradient specular), distinct from the FRAG metaballs-overlay | (this project) |
| `shaders/warp-terrain.frag.glsl` | MIT | Original — scrolling top-down fBm terrain (domain-warp + elevation contour bands + height-ramp palette + gradient shading) | (this project) |
| `shaders/gyroid-slice.frag.glsl` | MIT | Original — animated 2D slice through a 3D gyroid (standard public minimal-surface formula) with iso-contour shading | (this project) |
| `shaders/hyperspace.frag.glsl` | MIT | Original — radial star-warp "jump to lightspeed" (hashed star layers + radial motion-blur accumulation) | (this project) |
| `shaders/caustic-pool.frag.glsl` | MIT | Original — underwater light caustics (octave-summed folded-sine ripple filaments + aqua palette) | (this project) |
| `shaders/frag-bloom.frag.glsl` | MIT | Original — light-bloom (luma-threshold bright pass + multi-tap gaussian blur + additive composite) of iChannel0 | (this project) |
| `shaders/frag-crt.frag.glsl` | MIT | Original — CRT/tube-monitor look (barrel UV warp + RGB aperture-grille mask + scanlines + vignette) of iChannel0 | (this project) |
| `shaders/frag-halftone.frag.glsl` | MIT | Original — angled dot-screen halftone (rotate UV → cell grid → dot radius from luma) + duotone of iChannel0 | (this project) |
| `shaders/frag-pixelate.frag.glsl` | MIT | Original — lo-fi mosaic (grid-snapped UV) + colour quantisation + hashed block-smear corruption of iChannel0 | (this project) |
| `shaders/frag-ascii.frag.glsl` | MIT | Original — ASCII text-mode renderer (cell-bin + brightness→procedural-glyph-density, NO font atlas) of iChannel0 | (this project) |
| `shaders/frag-mirror-fold.frag.glsl` | MIT | Original — planar triangle-wave mirror-kaleidoscope tiling of iChannel0 (distinct from the polar FRAG kaleido) | (this project) |
| `shaders/doom-spectrum.frag.glsl` | MIT | Original clean-room — audio-reactive spectrum bars (band1..band6) over a value-noise fire field + hell heat ramp. Aesthetic homage to the local `doom_viz` SPECTRUM-mode visualiser idea; NO game source/shaders/sprites copied (doom_viz ships none) | (this project) |
| `shaders/checker-floor.frag.glsl` | MIT | Original clean-room — perspective rotating checkerboard floor (v = horizon/y projection) + sky gradient; 90s-mascot-platformer HOMAGE, no copyrighted sprites/tiles/logos | (this project) |
| `shaders/wolf-maze.frag.glsl` | MIT | Original clean-room — first-person brick corridor (rectangular box-tunnel projection + procedural brick pattern + fog); 90s-raycaster HOMAGE, no copyrighted textures/level data | (this project) |
| `shaders/block-cascade.frag.glsl` | MIT | Original clean-room — falling-blocks well (per-column hashed fall + bevelled cells + tetromino palette); falling-blocks-puzzler HOMAGE, no copyrighted shapes/logos | (this project) |

> NOTE on Seascape / Raymarching-Primitives: the canonical Shadertoy shaders of
> those names are **CC BY-NC-SA 3.0 (non-commercial)** and are NOT compatible
> with this permissive-only bank. The files above are **original clean-room**
> reimplementations from standard, individually-public techniques (octave-summed
> ocean heightfields, SDF primitive formulae, sphere tracing, soft shadows/AO) —
> no NC source text was copied. See PR #794 for the license decision.

## Shadertoy ports — CC BY 3.0 (attribution required)

These are verbatim Shadertoy ports run through TOYBOX's Shadertoy shim
(`mainImage`→`main`). They are licensed **CC BY 3.0** and are used here under
attribution to their original authors (the file headers carry the same notice).
CC BY 3.0 permits commercial use + modification with attribution; it is NOT
non-commercial.

| Asset | SPDX | Author | Title |
| --- | --- | --- | --- |
| `shaders/synthwave-sunset.frag.glsl` | CC-BY-3.0 | Jan Mróz (jaszunio15) | "Synthwave sunset" |

> Note: the "Cyber Fuji 2020" GEN port and the 5-file "Eroded Terrain Island"
> multi-buffer port were REMOVED (they were improperly bundled Shadertoy ports).
> The multi-buffer runtime is now demonstrated by the ORIGINAL clean-room
> `growing-peak` preset (peak-common/peak-bufferA/peak-image, MIT, above), and
> the growing-terrain niche by the original single-pass `growing-mountain` GEN.

---

Note: "re-authored" means the algorithm/technique was reimplemented from the
public mathematical formulation, not pasted from the upstream file. The named
upstream reference modules are themselves MIT-licensed; the IQ articles describe
techniques (formulae), not copied source. Entries marked "(this project)" are
original constructions from standard, widely-published techniques. The GEN
shaders use the engine-native `void main()` convention (iTime + iResolution
vec2 + their declared float params, NO scene input); the FRAG shaders use the
Shadertoy `void mainImage(out vec4, in vec2)` convention (the runtime's shim
provides iResolution vec3 + the full iTime/iMouse/iChannel0-3 set) and every
FRAG shader READS the composited layer below as `iChannel0` (recolour /
displace / mix) so they are meaningfully distinct from GEN.

---

# TOYBOX model bank — licenses (Phase 3 OBJ layer)

Every mesh in `models/` is **CC0 1.0 / public-domain**, fetched + license-
verified from its named source. No attribution is legally required; the
provenance is recorded here as good practice. The built-in primitives
(CUBE / SPHERE / TORUS / HYPERCUBE) are generated procedurally in-house
(`packages/web/src/lib/video/primitives.ts`) and ship no asset file. The OBJ
**parser** and the **matcap shader** are this project's own code, and the
matcap is synthesized procedurally in-shader (no matcap image asset), so the
entire OBJ layer has zero copied-asset license surface.

| Asset | SPDX | Source | URL |
| --- | --- | --- | --- |
| `models/spot.obj` (Spot the cow, control mesh) | CC0-1.0 (public domain) | Keenan Crane — 3D Model Repository (`spot.zip`); README: "As the sole author of this data, I hereby release it into the public domain." | https://www.cs.cmu.edu/~kmcrane/Projects/ModelRepository/ |
| `models/teapot.obj` (Utah-teapot, low-poly) | CC0-1.0 | drummyfish — "32 Low Poly Models"; file header: "by drummyfish, released under CC0 1.0, public domain" | https://opengameart.org/content/32-low-poly-models |
| `models/chess-pawn.obj` (chess pawn prop) | CC0-1.0 | drummyfish — "32 Low Poly Models"; file header: "by drummyfish, released under CC0 1.0, public domain" | https://opengameart.org/content/32-low-poly-models |
| `models/banana.obj` (low-poly banana) | CC0-1.0 | drummyfish — "32 Low Poly Models"; file header: "by drummyfish, released under CC0 1.0, public domain" | https://opengameart.org/content/32-low-poly-models |
| `models/snowman.obj` (low-poly snowman) | CC0-1.0 | drummyfish — "32 Low Poly Models"; file header: "by drummyfish, released under CC0 1.0, public domain" | https://opengameart.org/content/32-low-poly-models |
| `models/star.obj` (3D 5-point star) | CC0-1.0 (public domain) | Original — this project; procedurally generated (10-point star rim bipyramid), no third-party asset | (this project) |

Built-in primitives (no asset file) — procedurally generated, this project's
own code (`packages/web/src/lib/video/primitives.ts`), ZERO copied-asset
license surface: `cube`, `sphere`, `torus`, `hypercube`, `tetrahedron`,
`octahedron`, `icosahedron`, `cylinder`, `cone`, `torus-knot`.

---

# CAT FEEDBACK preset — media provenance

The bundled `cat-feedback` preset is the OBJ-surface-mapped-video → multi-feedback
DEMO WIRING. It bundles **NO new media**: a verifiable-CC0 cat OBJ / cat video /
cat photo could not be sourced + license-verified clean-room, so per the
no-fabricated-provenance discipline NOTHING unverified is shipped. Instead the
preset is wired so the media is **user-supplied** and the deliverable is the
correct routing:

- **OBJ mesh** = `models/spot.obj` (the CC0 Spot the cow above) as a recognizable
  animal-mesh STAND-IN. Drop a CC0 cat OBJ onto the layer to swap it.
- **Cat video** (the OBJ surface) = layer 1, `kind: 'video'`, `videoSource: 'file'`,
  `videoMeta.name: null`, `contentId: null` → **user drops their own cat video**.
  It is `material.surfaceSource`-mapped (=1) onto the OBJ so it textures the mesh.
- **Background** = layer 2, `kind: 'image'`, `imageBytes: null` → **user drops
  their own cat photo / background**.
- The surface-mapped OBJ runs through **two FEEDBACK combine nodes in different
  modes** (fb1 = TUNNEL droste-zoom, fb2 = ADDITIVE glow trails), lumakeyed over
  the background.

No copied-asset license surface: the only bundled asset is the already-CC0 Spot
mesh; the cat video + photo are local user files (the video bytes never ride the
Y.Doc — VIDEOBOX behaviour — and the image is blank until the user picks one).
