# TOYBOX shader bank — licenses

Every shader in `shaders/` is **original code, re-authored clean-room** from
the named MIT reference function modules below. No ShaderToy / CC-BY-NC code
was copied. The helper functions (simplex noise, FBM octave-sum, Worley
neighbour-scan, HSV→RGB, IQ cosine-palette) are standard, widely-published
formulations transcribed into GLSL ES 300; the driving fields and colour
ramps are this project's own. The whole bank is therefore unambiguously MIT
and compatible with this repository's licensing.

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

Built-in primitives (no asset file) — procedurally generated, this project's
own code (`packages/web/src/lib/video/primitives.ts`), ZERO copied-asset
license surface: `cube`, `sphere`, `torus`, `hypercube`, `tetrahedron`,
`octahedron`, `icosahedron`, `cylinder`, `cone`, `torus-knot`.
