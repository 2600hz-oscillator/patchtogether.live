# CELLSHADE rebuild — adversarial review + engine redesign (2026-07-11)

Phases 1+2 of the cellshade program. Phase 3 = fresh-eyes adversarial review of
THIS design; phase 4 = the build (PR held for owner review + look preview —
nothing auto-merges; video-look changes always get owner preview material).

Owner directive (near-verbatim): cellshade probably needs a "total rebuild of
the cellshade engine because I don't think that module really looks anything
like actual cel shading."

**VERDICT: CONFIRMED — rebuild required.** Detail in §2/§3; one-line version:
at its DEFAULT setting the module renders the entire hue wheel as {red, cyan},
erases all moderate chroma (a skin tone emerges pure gray), bands on
max(R,G,B) instead of luminance (a saturated blue lands in the BRIGHTEST
band), has zero spatial abstraction (no smoothing stage), and hard-floors its
bands. Only the Sobel ink pass behaves like the cel literature says it should.

## 1. What cel/toon shading of live video actually is

Canonical reference: **Winnemöller, Olsen & Gooch, "Real-Time Video
Abstraction", SIGGRAPH 2006 (ACM TOG 25(3) 1221–1226)**
(https://dl.acm.org/doi/10.1145/1179352.1142018; overview:
https://history.siggraph.org/learning/real-time-video-abstraction-by-winnemoller-olsen-and-gooch/;
reference reimplementation:
https://github.com/BumbleBee0819/Real_time_video_abstraction). Pipeline:

1. **Edge-preserving smoothing** — an ITERATED (separable-approximation)
   bilateral filter, in CIELab, flattens low-contrast regions while keeping
   contours → the large flat color regions that read as "hand-painted".
2. **SOFT LUMINANCE QUANTIZATION** — the LUMINANCE channel alone is stepped
   into a small number of bands with a smooth (tanh) transition width
   (their Eq: q(f) = q_nearest + Δq/2 · tanh(φ_q·(f − q_nearest))). CHROMA
   IS NEVER QUANTIZED — hue/saturation ride through, so a band is a flat
   TONAL step of consistent hue. The soft transition is what keeps live
   video from shimmering at band boundaries.
3. **DoG (difference-of-Gaussians) edge lines** composited as dark outlines
   over the quantized color.

Successors sharpen each stage but keep the architecture: anisotropic
Kuwahara filtering for the abstraction stage (Kyprianidis & Döllner /
Kyprianidis et al., PG 2009 — https://www.kyprianidis.com/p/pg2009/index.html,
GPU implementation https://www.kyprianidis.com/p/gpupro/), XDoG for the line
stage (Winnemöller, Kyprianidis & Olsen, CAG 2012 —
https://semanticscholar.org/paper/b5062bbbee3ed3df984649a00872ac145e8c8aa3).

Game-style toon shading (the other lineage — Lake et al. 2000, "Stylized
Rendering Techniques for Scalable Real-Time 3D Animation"; surveyed at
https://en.wikipedia.org/wiki/Cel_shading and
https://en.wikibooks.org/wiki/GLSL_Programming/Unity/Toon_Shading; post-process
recipes e.g.
https://www.artstation.com/blogs/martinwiddowson/2Kpy/a-guide-to-screen-space-halftones-cel-shading-and-toon-shading-for-post-processing-in-unreal-engine-4203)
agrees on the invariant: quantize the LIGHTING/LUMINANCE axis into 2–4 bands
(often via a 1D ramp), draw dark outlines (Sobel/depth-normal). Nobody
quantizes the hue axis.

**The visual signatures of "cel":** large flat regions; discrete BRIGHTNESS
bands whose ordering follows perceived luminance; hue held constant within and
across bands; dark contour lines. **The tell-tale failure of a per-channel RGB
posterizer:** hue shifts at band boundaries and neutral grays acquire tints.

## 2. What cellshade.ts actually computes (adversarial derivation)

`packages/web/src/lib/video/modules/cellshade.ts` (shipped PR #695). Single
fragment pass, per pixel:

1. `quantizeColor(src)` — three regimes keyed off `uColors` (the BITS knob):
   * **1/2-bit (2/4 "colours")**: RGB→HSV; quantize **V = max(R,G,B)** to 2/4
     bands via `floor(v·n)/(n−1)`; H and S pass through; back to RGB.
   * **4-bit DEFAULT (16 "colours")**: same, PLUS `quant(H, 3)` and
     `quant(S, 2)` — a LINEAR endpoint quantizer applied to a CIRCULAR hue
     (outputs H ∈ {0, ½, 1}; 0 and 1 are both red) and a saturation
     binarizer (S ∈ {0, 1}).
   * **8/16-bit**: per-channel RGB floor at 3-3-2 / 5-6-5 level counts.
2. A 3×3 **Sobel on the RAW INPUT's Rec.601 luma** (verbatim from EDGES),
   hard-thresholded, dilated ≤8px, composited as black.

It is NOT a naive RGB posterizer at low depths — PR #695 genuinely tried to
implement luma-band quantization ("the craft — done WELL, not a naive
per-channel RGB floor"). But the execution has three fatal math errors at the
default step, and the architecture is missing the abstraction stage entirely.
The unit suite (36 tests) is a CPU mirror of the same math, so it validated
the implementation against itself; its one hue-preservation test used bits=0
(where hue is a passthrough) and a RED input — hue 0, the exact fixed point of
the default step's hue collapse.

## 3. Findings

Verified twice: through the module's own exported CPU mirror
(`cellshadeQuantize`) AND live against the real GLSL via
`e2e/tests/cellshade-functional.spec.ts` (byte-identical results).

| ID | Severity | Finding | Evidence (live GLSL) |
|----|----------|---------|----------------------|
| F-CS1 | FATAL (default setting) | Hue wheel collapses to {red, cyan}: `quant(H,3)` maps a circular quantity onto 3 linear endpoints {0,½,1}; 0≡1≡red. | yellow (255,255,0) → **(255,0,0)**; magenta → **(255,0,0)**; blue → **(255,0,0)**; green → (0,255,255). Blue's hue (2/3) lands EXACTLY on a float boundary → red-or-cyan per renderer. |
| F-CS2 | FATAL (default setting) | Saturation binarized at 0.5: all moderate chroma erased. Theory: chroma is never quantized. | skin tone (0.8,0.6,0.5), s=0.375 → **(204,204,204) pure gray**; pastel blue s=0.45 → pure white. Faces are colourless at the default. |
| F-CS3 | FATAL (all low depths) | Bands follow HSV **V = max(R,G,B)**, not luminance: tonal (shadow/light) structure destroyed for saturated colors. | saturated blue, Rec.601 luma **0.114** (near-black to the eye) → **(0,0,255) TOP band** at 1-bit. The module's own Sobel pass uses Rec.601 luma — the two stages disagree about what "brightness" is. |
| F-CS4 | major | Hard `floor()` quantization, zero transition width → spatial aliasing + temporal shimmer at band boundaries on live video. Winnemöller's quantization is explicitly SOFT. | ±0.02 luma straddle of the 0.5 boundary: 85 → 170, the full band step. |
| F-CS5 | by-design, but not cel | 8/16-bit steps are per-channel RGB posterize with UNEQUAL per-channel level counts → NEUTRAL grays acquire hue tints (the per-channel tell). Documented retro-console intent; it is posterization wearing the cel label. | gray 0.2 → (36,36,**0**) yellow-tinted; gray 0.45 → (109,109,**85**). Pinned by a PASSING characterization test. |
| F-CS6 | architectural | NO edge-preserving smoothing/abstraction stage exists (Winnemöller step 1 absent). Quantization is per-pixel on raw input: sensor noise/texture fracture bands into speckle and drive Sobel ink speckle. | Code-derived: the only neighborhood taps in FRAG_SRC are the Sobel/dilation reads; quantization samples exactly 1 texel. |
| F-CS7 | semantic | The "total colour budget" model is false at low depths: at "4 colours", H/S pass through, so the palette is unbounded (every input hue × 4 V-bands). The knob conflates two unrelated effects (cel banding vs retro palette). | Code-derived; e.g. blue and white both survive 1-bit ("2 colours") intact alongside 4 gray ramp bands. |

**What already works (pinned by 3 PASSING tests, must survive the rebuild):**
neutral-ramp banding is discrete/monotone/neutral at the 2-bit step; a
high-contrast boundary inks a black contour whose gate (threshold) behaves
exactly like EDGES; flat regions never ink.

**Classification: rebuild-required, not fixable-in-place.** Fixing F-CS1/2/3
means replacing the entire transfer function (HSV out, luminance-domain in);
fixing F-CS6 requires a multi-pass architecture (smoothing needs its own
FBO-to-FBO passes); F-CS4 changes the quantizer's shape. What survives: the
Sobel/threshold/thickness ink machinery (shared with EDGES), the def plumbing,
card, CV wiring, and the fixture/test harness.

## 4. Rebuild architecture

Multi-pass is precedented in-module: FADER runs 2 passes (mix→FBO, then
dry/wet), B3NTB0X runs 4 (EncodeComposite → BendCircuit → …). The engine's
factory contract allows N `ctx.compileFragment` programs + N `ctx.createFbo()`
targets chained inside `draw()`. **Decision: single-module 4-pass chain**
(not "single pass with taps" — the bilateral must feed BOTH the quantizer and
the edge pass, which per-pixel taps cannot do without recomputing the filter
per consumer; not a cross-module chain — users shouldn't need to patch 3
modules to get "cel").

```
in ──► P1 bilateralH ──► P2 bilateralV ──► P3 quantize ──► P4 ink ──► out
         (fboA)             (fboB)            (fboC)      (own fbo)
                              │                              ▲
                              └── smoothed luma for Sobel ───┘
```

* **P1/P2 — separable bilateral approximation** (Winnemöller §3.1 uses exactly
  this separated-kernel approximation for real time; alternative anisotropic
  Kuwahara rejected: needs a structure-tensor pass + 8-sector accumulation,
  ~3× the taps — wrong cost profile for SwiftShader CI). Radius 3 (7 taps per
  axis), fixed spatial σ_d ≈ 2.0 px; range weight on Rec.601 luma difference,
  σ_r = mix(0.03, 0.4, smooth). `smooth = 0` degenerates to identity (range
  weight → only center tap survives — a true bypass). One iteration (2 passes);
  a second iteration is a phase-4 quality/perf call on SwiftShader numbers,
  behind a compile-time constant, default 1.

```glsl
// P1 (horizontal; P2 identical with uDir=(0,1))
float wsum = 0.0; vec3 acc = vec3(0.0);
float lc = luma(texture(uTex, vUv).rgb);
for (int i = -3; i <= 3; i++) {
  vec2 off = uTexel * uDir * float(i);
  vec3 c = texture(uTex, vUv + off).rgb;
  float w = exp(-float(i*i) / (2.0*SIGMA_D*SIGMA_D))
          * exp(-pow(luma(c) - lc, 2.0) / (2.0*uSigmaR*uSigmaR));
  acc += c * w; wsum += w;
}
outColor = vec4(acc / wsum, 1.0);
```

* **P3 — luminance-domain SOFT quantization** (kills F-CS1/2/3/4 by
  construction: Y from the SAME Rec.601 weights the ink pass uses; Cb/Cr pass
  through untouched — hue and saturation are never quantized):

```glsl
vec3  c  = texture(uTex, vUv).rgb;            // smoothed (fboB)
float Y  = dot(c, LUMA);                      // Rec.601
float n  = uBands;                            // 2..8 (see params)
float x  = Y * n;                             // thresholds at integers 1..n-1
float b  = clamp(round(x), 1.0, n - 1.0);     // nearest threshold
float w  = mix(1e-3, 0.5, uSoftness);         // soft half-width (band units)
float t  = smoothstep(-w, w, x - b);          // soft step across the threshold
float Yq = (b - 1.0 + t) / (n - 1.0);         // levels i/(n-1)
vec3 outc = clamp(c + (Yq - Y) * vec3(1.0), 0.0, 1.0);   // shift luma, keep chroma
```

  Degenerate checks (regression anchors): at `softness=0` this reproduces
  TODAY's `floor(Y·n)/(n−1)` band values and thresholds i/n exactly — the
  passing neutral-ramp test keeps passing with `softness: 0` pinned; at
  `softness=1` it approaches a continuous (piecewise-linear) transfer — no
  dead zone anywhere on the knob. Chroma reconstruction is the additive
  luma-shift (equivalent to YCbCr Y-replacement with BT.601, clamped);
  out-of-gamut clamps on extreme band jumps are standard and acceptable.
  Exact CPU mirror (`cellshadeQuantizeY`) is the phase-4 source of truth.

* **P4 — ink**: the EXISTING Sobel + threshold + ≤8px dilation, unchanged
  semantics, with two changes: it reads the SMOOTHED image (fboB) instead of
  the raw input (noise no longer inks — completes F-CS6), and the composite
  gains a strength: `col = mix(quantized, vec3(0.0), edge * uInk)`.
  DoG/XDoG rejected for now: Sobel+dilate is the family look already shipped
  and CPU-mirrored in EDGES, is cheaper (8 taps vs 2 Gaussian chains), and
  reads on SwiftShader; XDoG is listed as a future upgrade with the same seam.

Per-pixel tap budget: P1 7 + P2 7 + P3 1 + P4 (9-tap Sobel × dilation window,
early-out — same as today) + 1 composite ≈ today's cost + ~15 taps. The
current shader already pays 8 luma taps × up to 15×15 dilation worst-case, so
the rebuild is a small constant on top — NOT a new heavy class.

## 5. Param table

| id | status | range/curve | semantics |
|----|--------|-------------|-----------|
| `threshold` | KEPT (id, range, default 0.2) | 0..1 linear | ink gate — normalized Sobel magnitude, EDGES semantics, now measured on the smoothed image |
| `thickness` | KEPT (id, range, default 2) | 1..8 px linear | ink dilation width, EDGES semantics |
| `bits` | KEPT id, RE-LABELED "Bands" | discrete 0..4 (unchanged) | band-count step index → {2, 3, 4, 6, 8} luminance bands (was {2,4,16,256,65536} "colours"). Same id + range + discrete curve ⇒ existing patches and CV cables load with NO migration code; card readout becomes "N BANDS" |
| `softness` | NEW | 0..1 linear, default 0.25 | band-transition half-width; 0 = hard (today's look), 1 = near-continuous |
| `smooth` | NEW | 0..1 linear, default 0.35 | bilateral range sigma; 0 = off (true bypass), 1 = heavy flattening |
| `ink` | NEW | 0..1 linear, default 1 | outline darkness; 0 = no lines, 1 = solid black |

All six get per-param CV inputs (port id == param id; `bits` keeps its
discrete cvScale). Every control is VISUALLY dynamic across its full range —
5-point range proofs planned per param (§6): bands changes the countable band
number; softness changes the measured boundary-jump width monotonically;
smooth changes output variance on a textured fixture; threshold/thickness as
today; ink interpolates the boundary probe black→none linearly.

Dropped: the 8/16-bit per-channel retro modes (F-CS5/F-CS7 — they are a
POSTERIZER, a different instrument). If the owner wants that look back it
should be a separate ~80-line single-pass POSTERBOX module (non-goal here;
the F-CS5 characterization test retires with a pointer when that ships, or
flips to POSTERBOX). Flagged as an explicit OWNER DECISION on the phase-4 PR.

## 6. Test plan

* **`e2e/tests/cellshade-functional.spec.ts`** (this branch, phase 1): the 4
  fixme findings tests FLIP to hard assertions — yellow stays yellow, skin
  stays warm, saturated blue lands in the dark band, boundary straddle is
  smooth at default softness. The neutral-ramp band test gains explicit
  `softness: 0` (hard-degenerate anchor = today's exact band values). The ink
  test keeps passing untouched (gate semantics preserved by design).
* **Range proofs** (5-point, per new param, same DRS fixtures): softness
  0/0.25/0.5/0.75/1 → boundary-jump magnitude strictly decreasing; smooth
  swept on a fine SHAPEDRAMPS-derived texture (h_out freq-wrapped zigzag) →
  ink-pixel count / variance decreasing; ink 0..1 → boundary probe channel
  rises linearly from 0.
* **Unit** — `cellshade.test.ts` rewritten around the new CPU mirrors
  (`cellshadeSmoothWeights`, `cellshadeQuantizeY`, ink composite); the
  EDGES-mirror tests carry over. The hue-preservation test becomes exhaustive:
  EVERY 15° hue × {default + all band steps} asserts hue error < 2° (the
  exact blind spot that let F-CS1 ship).
* **VRT** — card sweep stays masked (`cellshade: [{selector:'canvas'}]`,
  unchanged). NEW `e2e/vrt/cellshade-composite.spec.ts` (pattern:
  cube-adsr-composite): 3 DRS-frozen UNMASKED scenes — (a) bands-only on a
  colored ramp (soft vs hard), (b) ink-only over the split fixture, (c) full
  pipeline on a composite fixture — small captures, darwin + linux pinned via
  the vrt-update workflow. Deterministic pure-UV fixtures + flat quantized
  regions = renderer-tolerant baselines.
* **Owner preview** (pre-merge look review, per the video-look standard): the
  phase-4 PR attaches full-res PNGs of the 3 VRT scenes + a camera/ACIDWARP
  before/after pair, plus dev-deploy drive steps.
* **Sweeps**: 3 new CV ports auto-enroll in per-module-per-port handle/emit —
  budget the hand-maintained per-port list rows; behavioral stays SKIPPED for
  cellshade (VIDEO_SINK_SWIFTSHADER_NOTE class — unchanged).
* All new/changed tests: REPEAT=3 locally before MR (repo standard).

## 7. Attest / VRT / CI cost

* **WebGL attest**: `cellshade.ts` is in the WebGL basis; FRAG_SRC replacement
  is a legitimate contract change → ONE batched re-attest in phase 4
  (coordinate with keyer phase 4 if concurrent — single batch). Local
  `task webgl:attest` is currently blocked by the unrelated video-orientation
  camera failures — the coordinator owns that; CI hash-verify is unaffected.
  New docs prose stays inside `docs-hash-ignore` markers (already the file's
  pattern) so doc edits never churn the hash.
* **VRT**: +3 composite scenes ≈ +20–40 s CI; card baseline unchanged (masked
  canvas); linux/cellshade EXEMPT_BASELINE_PAIRS entry retires when the
  composite scenes pin linux.
* **CI wall-time**: functional spec today = 7.3 s local (4 tests); with
  fixmes flipped + range proofs ≈ 12–14 tests, single-spawn each ≈ 25 s local
  → est. 60–90 s on SwiftShader. Total PR delta ≈ **1–1.5 min** — under the
  2-min flag threshold, stated in the PR body regardless. Timeouts scale by
  spawn count (120 s per test, HEAVY_MOUNT 30 s — the established cellshade
  class), never flat-90s.
* **Perf of the module itself**: ~+15 taps/pixel over today (§4) — no new
  SwiftShader heavy class; the bespoke spec's existing budget holds.

## 8. Migration

None required in code: param ids/ranges for `threshold`/`thickness`/`bits`
are unchanged (factory default-merges missing params, so old saved patches
load; new params take defaults). The LOOK of every existing cellshade patch
changes — that is the point of an owner-directed rebuild — with the biggest
delta on patches saved at bits idx 3/4 (retro posterize → 6/8-band cel).
Called out in the phase-4 PR body for the owner's preview pass. Contract
lock + docs: `task docs:accept` after the def change (label "Bands", new
params, rewritten docs prose); cellshade stays in STRICT_DOCS.

## 9. Coordination

* **keyer program** (feat/keyer-framework): its phase 4 proposes
  `lib/video/keying-core.ts` with `KEY_LUMA_WEIGHTS` (Rec.601) as the
  app-wide constant. Not a hard dependency: the rebuild keeps importing
  `EDGES_LUMA_WEIGHTS` from edges.ts (identical values, already shared);
  when keying-core lands, cellshade+edges migrate to it in that PR's sweep.
  Rec.601 stays the app-wide luma flavor (their doc, §2 row "Rec.601
  everywhere") — the rebuild's Y uses the same weights, so the two programs
  cannot diverge on "what is luminance".
* **probe-helper duplication**: `stepAndSample`/`setNodeParam`/fixture
  builders are intentionally duplicated between keyer-functional.spec.ts and
  cellshade-functional.spec.ts (unmerged sibling branches). Whichever lands
  second extracts `e2e/tests/_video-probe.ts` and both specs import it.
* Phase-4 touches hand-maintained conflict files (per-port lists,
  vrt-exemptions, strict-docs): run `task pr:conflict-sweep` after merges.

## 10. Non-goals

* Retro RGB posterize (3-3-2/5-6-5) — separate future POSTERBOX module.
* XDoG / flow-based DoG / anisotropic-Kuwahara upgrades (documented seam: P4
  swaps behind the same threshold/thickness/ink params).
* Ink color param (black only, as the cel literature's default).
* Temporal coherence machinery beyond per-frame determinism (Winnemöller's
  soft quantization already addresses band-edge shimmer, the visible artifact).
* Video-domain doc pages (known app-wide follow-up).
* Any module code changes in phases 1–2 (this branch is spec + doc only).

## 11. Open questions for the owner (phase-4 PR)

1. Drop the retro 8/16-bit modes entirely (recommended), or ship POSTERBOX in
   the same wave?
2. Default band count: proposal 4 bands (idx 2 stays the default position).
3. `smooth` default 0.35 — final value set by eye on the preview material.
