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

Note: "re-authored" means the algorithm/technique was reimplemented from the
public mathematical formulation, not pasted from the upstream file. All four
upstream reference modules are themselves MIT-licensed.

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

Built-in primitives (no asset file): `cube`, `sphere`, `torus`, `hypercube`
— procedurally generated, this project's own code.
