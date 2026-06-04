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
