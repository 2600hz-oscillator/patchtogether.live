# Keyer framework — findings, divergence survey, common-core design

Date: 2026-07-11 · Phase 1+2 of the 4-phase keyer program
(1 = adversarial review + functional validation, **this doc**; 2 = divergence
survey + framework design, **this doc**; 3 = adversarial design review by a
separate agent; 4 = the build + ONE batched re-attest + owner-reviewed PR).

Validation spec: `e2e/tests/keyer-functional.spec.ts` (theory-derived pixel
assertions; 6 passing, 4 `test.fixme` = live findings). All spawned through the
DRS harness (frozen clock, paused rAF, gl.readPixels off the module's own FBO,
SwiftShader-tolerant ±14/255 bands).

## 1. How keying SHOULD work (theory, with sources)

- **Luma key**: alpha = a soft ramp (smoothstep) around a threshold applied to
  the foreground's luma Y′. Y′ is a weighted sum of gamma-encoded R′G′B′ —
  Rec.601 weights (0.299/0.587/0.114) for SD-flavored pipelines, Rec.709
  (0.2126/0.7152/0.0722) for HD; using one consistently matters more than the
  choice, and the choice should be documented (Glenn Chan, "Rec. 709 vs
  Rec. 601 luma coefficients", glennchan.info; Wikipedia "Luma (video)").
  Invert flips the matte. Softness feathers a window around the threshold.
- **Chroma key**: the industry metric is DISTANCE IN THE CHROMA PLANE
  (Cb,Cr) between pixel and key color — not hue angle alone — with a
  tolerance/softness pair shaping alpha over that distance (Grokipedia
  "Chroma key"; MIT 6.111 chroma-key FPGA proposal; the standard GLSL
  green-screen shader on godotshaders.com does exactly rgb→UV distance +
  similarity/smoothness smoothstep). A low-chroma (grayish) pixel is FAR from
  a saturated key in the chroma plane, so shadows/highlights survive without a
  bolted-on saturation gate.
- **Spill suppression**: acts on KEPT foreground pixels — limiting the key's
  dominant channel, e.g. for green: `g′ = min(g, f(r,b))` with f = max or
  average (Ben McEwan, "Deconstructing Despill Algorithms",
  benmcewan.com/blog; Nuke/Ultimatte spill controls, learn.foundry.com).
  Desaturating only the matte's soft EDGE is not spill suppression — spill
  lives on the subject (alpha = 1), exactly where edge-scaled logic does
  nothing.
- **Composite**: `out = mix(bg, fg, alpha)` with alpha = fg opacity. In this
  app every video surface is opaque RGB (alpha forced 1.0 in every module
  FRAG), so straight (non-premultiplied) mixing is correct by construction;
  premultiplication only becomes a concern if translucent surfaces are ever
  introduced. An unpatched bg must be a DEFINED fallback (opaque black / pass
  bg through), never garbage — all four modules honor this today.

## 2. Findings (theory vs actual)

Empirically confirmed: each F-row has a `test.fixme` in
`keyer-functional.spec.ts` that FAILS when un-fixme'd (verified in this
worktree), plus the passing tests pin the correct parts.

| # | Module | Finding | Theory vs actual | Severity | Class |
|---|--------|---------|------------------|----------|-------|
| F-L1 | LUMA | "Gamma" is the inverse (Photoshop-Levels) convention | Theory (display-gamma, the prompt's example): 0.5 gray at gamma=2 → 0.5²≈0.25. Actual: `pow(l, 1/gamma)` → 0.71 → posterized 0.733 (187/255). Self-consistently documented in `docs.controls`. | low | doc-bug (defensible; make the convention explicit: "Levels-style, >1 brightens") |
| F-L2 | LUMA | Defaults are NOT identity; posterize has no bypass | Docs claim "defaults pass the picture through essentially untouched". Actual: `floor(l·16)/15` at default `posterizeLevels=16` crushes l ≥ 15/16 to white (242→255), l < 1/16 to black (15→0), ±6% mid-scale. | med | real-bug (design: no bypass exists at any knob setting) |
| F-C1 | CHROMAKEY | Mask metric is hue-angle-only + fixed sat gate | Theory: chroma-plane (CbCr) distance keeps low-chroma subject pixels. Actual: (0.6,0.75,0.55) — mild green cast, sat 0.27 — is INSIDE the default key band (hue 0.291 vs key 0.333, hd 0.042 < 0.075) and satGate(0.04..0.18) is fully open → alpha=0 → subject replaced by bg. Also: sat 0.04..0.18 grays go semi-TRANSPARENT (alpha = mix(1, 0, satGate)) instead of staying opaque. | high | real-bug (wrong metric family) |
| F-C2 | CHROMAKEY | Spill suppression cannot act where spill is visible | Theory: despill green-limits KEPT pixels. Actual: desat scaled by `(1-alpha)` → alpha=1 pixels untouched at ANY spillSuppress; verified bit-identical (204,230,76)→(204,230,76) for spill 0→1 on a kept green-contaminated fg. Where it DOES act (alpha→0) the fg is invisible anyway. Effect ≈ only inside the softness band. | high | real-bug (control is a near-no-op) |
| F-C3 | CHROMAKEY | No invert, no matte output, no choke | LUMAKEY has invert; QUADRALOGICAL's CHROMA edge-fx has invert; CHROMAKEY has none. No module exports its matte as mono-video (LZX keyers do; MAPPER consumes mattes, nothing produces one from a keyer). No edge choke anywhere. | med | design-gap |
| F-F1 | FADER | Factory ignores `node.params` | Reconciler pushes params only on CHANGE (`reconciler.ts` §5: `if (!prev) continue`), so initial values must be read by the factory. chroma/chromakey/luma/lumakey/mixer/mapper/quad all spread `node.params`; FADER initializes literals (0.5/0/0/0) → persisted fader/dryWet/transition positions silently reset on patch reload until touched. Confirmed at code level; the spec works around it via post-spawn setNodeParam. | med | real-bug (trivially separable, but fader.ts is attest basis → batch with the framework's one re-attest) |
| — | CHROMA | HSV value-desaturation | `saturation=0` turns red into WHITE (HSV v-gray), not its luma gray. Documented as HSV; characterization test passes. Perceptually surprising but a legitimate synth choice. | info | none (doc note) |
| — | all | Rec.601 luma on sRGB-primary content | 601 weights everywhere (12+ modules, consistent!). Technically 709 matches the primaries; 601 is the app-wide retro/NTSC flavor and is documented per-module. Keep 601, centralize the constant. | info | doc-note |

## 3. Divergence survey (the 4 keyers + compositor family)

| Aspect | CHROMA | CHROMAKEY | LUMA | LUMAKEY | MAPPER | V-MIXER | FADER | QUADRALOGICAL | TOYBOX ops |
|---|---|---|---|---|---|---|---|---|---|
| Role | hue-shift/tint processor | 2-in chroma keyer | luma processor | 2-in luma keyer | video×matte gate | 4-in additive | 2-in crossfade + send/return | 4-in joystick, 8 edge blend fx (incl. CHROMA/LUMA keys) | in-card combine graph (lumakey/chromakey/map/over…) |
| Mask metric | — | HSV hue distance + satGate(0.04,0.18) | — | Rec.601 luma | Rec.601 luma | — | — | same hue+satGate (CHROMA fx), same luma (LUMA fx) — inline copies | chromakey "ported verbatim" from module; lumakey same shape |
| Softness window | — | one-sided `[tol, tol+soft]`, soft 0..0.5, hue-halved | — | centered `±soft`, 0..0.5 | fixed ±0.03 | — | wipe edge fixed ±0.02 | CHROMA one-sided (param·0.5), LUMA centered (param 0..1 — 2× lumakey's range) | lumakey centered (`soft ≥ 0` unclamped hi), chromakey one-sided (0..0.5) |
| Threshold naming | — | `threshold` | — | `threshold` | `threshold` | — | — | `edge{N}_amount` | `amount` |
| Invert | — | ✗ | — | `invert` param | ✗ | — | — | GLOBAL `invert` (both fx) | lumakey only (`uInvert`) |
| Spill | — | edge-desat (defective, F-C2) | — | — | — | — | — | none | none |
| Key color | tint (tintR/G/B) | keyR/G/B params | — | — | — | — | — | SHARED keyR/G/B for all 4 edges | per-op keyR/G/B channels |
| Alpha of inputs | ignored (out a=1) | ignored | ignored | ignored | ignored | ignored | ignored | ignored | RESPECTED (`keep *= t.a`, premult OVER) |
| Unpatched fallback | black | no fg → pass bg | black | no fg → pass bg | either missing → black | contributes black | reads black | Eurorack normalling (falls to lower input; self-blend) | n/a (internal) |
| Initial params | factory reads (filtered) | factory reads | factory reads (filtered) | factory reads | factory reads (filtered) | factory reads | **IGNORED (F-F1)** | factory reads | n/a |
| Matte output | — | ✗ | — | ✗ | ✗ (only video·mask) | — | — | ✗ | ✗ |
| Docs | co-located, markers ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |

Duplication inventory: `rgbToHsv`/`hsvToRgb` GLSL appears verbatim in
chroma.ts, chromakey.ts, toybox.ts, quadralogical (TS mirror + inline GLSL);
`hueDistance` in 3 places; Rec.601 luma dot() in 12+ files (mapper, edges,
freezeframe export their own constants). The chroma/luma pair DID go through
the same split as luma/lumakey (headers + v2/v3 param migrations confirm);
no archaic mask-params remain — both filter legacy keys defensively.

## 4. Proposed architecture — shared keying core, thin defs

One new file, **`packages/web/src/lib/video/keying-core.ts`** — GLSL snippet
constants + pure TS mirrors (the proven `mapper.ts` pattern: the TS mirror is
the unit-tested source of truth; the GLSL is a line-for-line port interpolated
into each module's FRAG_SRC). No engine, registry, or card changes. The file
sits under `lib/video/**` so it is auto-included in the WebGL attest basis —
no coverage-guard edits.

```ts
// keying-core.ts (sketch)
export const KEY_LUMA_WEIGHTS = [0.299, 0.587, 0.114] as const;  // Rec.601 — app-wide
export const GLSL_KEY_HELPERS = /* glsl */ `
const vec3 KC_LUMA_W = vec3(0.299, 0.587, 0.114);
float kcLuma(vec3 c) { return dot(c, KC_LUMA_W); }

// Full-swing Rec.601 chroma coordinates of an R'G'B' triple.
vec2 kcChroma(vec3 c) {
  float y = kcLuma(c);
  return vec2((c.b - y) * 0.564, (c.r - y) * 0.713);   // (Cb, Cr)
}

// LUMA MASK — canonical centered window. invert flips.
float kcLumaMask(float luma, float thr, float soft, float invert) {
  float s = max(soft, 0.001);
  float a = smoothstep(thr - s, thr + s, luma);
  return invert > 0.5 ? 1.0 - a : a;
}

// CHROMA MASK — chroma-plane distance, key-relative (Vlahos-style):
// 0 at the key color, 1 for anything chromatically far from it. Low-chroma
// pixels are inherently far from a saturated key → no satGate needed.
float kcChromaMask(vec3 c, vec3 key, float thr, float soft, float invert) {
  vec2 kc = kcChroma(key);
  float d = distance(kcChroma(c), kc) / max(length(kc), 0.05);
  float a = smoothstep(thr, thr + max(soft, 0.001), d);
  return invert > 0.5 ? 1.0 - a : a;
}

// DESPILL — limit the key's dominant channel on KEPT pixels.
// amount 0..1; returns the de-spilled color. Green key ⇒ g' = min(g, lim).
vec3 kcDespill(vec3 c, vec3 key, float amount) {
  // dominant channel of the key (compile-time constant folding for pure keys)
  if (key.g >= key.r && key.g >= key.b) {
    float lim = max(c.r, c.b);
    return vec3(c.r, mix(c.g, min(c.g, lim), amount), c.b);
  } else if (key.b >= key.r) {
    float lim = max(c.r, c.g);
    return vec3(c.r, c.g, mix(c.b, min(c.b, lim), amount));
  }
  float lim = max(c.g, c.b);
  return vec3(mix(c.r, min(c.r, lim), amount), c.g, c.b);
}

// COMPOSITE — alpha = fg opacity. The one blessed compositing line.
vec3 kcComposite(vec3 bg, vec3 fg, float alpha) { return mix(bg, fg, alpha); }
`;
// + pure TS mirrors: kcLuma / kcChroma / kcLumaMask / kcChromaMask /
//   kcDespill / kcComposite — unit-tested in keying-core.test.ts, and the
//   existing exports (MAPPER_LUMA_WEIGHTS, EDGES_LUMA_WEIGHTS, …) can later
//   re-export KEY_LUMA_WEIGHTS instead of re-declaring.
```

New CHROMAKEY main() (sketch — params unchanged):

```glsl
float alpha = kcChromaMask(fg, key, uThreshold, uSoftness, 0.0);
fg = kcDespill(fg, key, uSpillSuppress * (0.5 + 0.5 * alpha)); // full on kept px
outColor = vec4(kcComposite(bg, fg, alpha), 1.0);
```

LUMA posterize bypass (F-L2): `if (uPosterizeLevels >= 16.0) posterLuma =
contrastLuma; else …` — 16 (the default AND max) becomes a true "off",
matching the existing doc claim; 2..15 keep today's banding behavior.

### Why a GLSL-snippet core and not a shared program / engine stage

Every module in this family compiles ONE bespoke fragment program via
`ctx.compileFragment` and draws a fullscreen quad into its own FBO; the engine
has no notion of shader stages or includes. The lightest common denominator
that removes the duplication AND fixes the math is string-composed GLSL with
pure TS mirrors — exactly how mapper.ts (constants), fader.ts
(fader-transitions.ts), and quadralogical (blend2 reference) already work.
A runtime "keyer megashader" or engine-level include system would churn the
engine for zero user value.

## 5. Migration table (zero patch breakage)

| Module | Param ids/ranges | Behavior change | Migration |
|---|---|---|---|
| LUMAKEY | unchanged (`threshold` 0..1, `softness` 0..0.5, `invert` 0/1) | none (swap to kcLuma/kcLumaMask/kcComposite is identity — centered window IS the canonical form) | none |
| CHROMAKEY | unchanged ids+ranges (`keyR/G/B`, `threshold` 0..1, `softness` 0..0.5, `spillSuppress` 0..1) | mask metric hue→chroma-plane; despill now reaches kept pixels. LOOK CHANGES on existing patches (better keys; thresholds re-tuned so defaults key a green screen equivalently — calibrate so pure key @ default thr → alpha 0, red/blue → alpha 1; pin with the e2e). | no schema migration; docs re-authored; **owner preview required** (video-look rule) |
| LUMA | unchanged (`gamma`, `contrast`, `posterizeLevels` 2..16, `bias`) | posterize=16 becomes true bypass (defaults now identity); gamma convention KEPT as pow(l, 1/γ), docs state "Levels-style: >1 brightens" (resolves F-L1 as documentation) | none |
| CHROMA | unchanged | none (only dedupe: import shared HSV helpers) | none |
| FADER | unchanged | F-F1: factory reads `node.params` at construction (persisted positions survive reload) | none |
| optional, phase-4b | +`matte` mono-video OUTPUT on both keyers (F-C3, LZX-style) | additive only | contract change: contract-lock re-pin, per-port sweep rows, docs; defer if phase 3 says scope-cut |

Invert on CHROMAKEY (F-C3): additive `invert` param defaulting 0 — additive
param = no patch breakage, but it IS a contract-lock diff; bundle with the
matte-output decision in phase 3.

## 6. Test plan

- **Unit** (`keying-core.test.ts`, unit lane, ~0 CI cost): TS mirrors —
  mask windows (edge cases: soft=0, thr=0/1, invert), chroma-plane distances
  (pure key → 0; gray → ≈1 for saturated keys; the F-C1 pixel (0.6,0.75,0.55)
  → kept), despill (green-dominant reduced to max(r,b); yellow untouched;
  amount lerp), GLSL↔TS lockstep via string containment of shared constants.
- **E2E** (`e2e/tests/keyer-functional.spec.ts`, already on this branch):
  6 passing tests keep pinning correct behavior through the build; the fixmes
  flip to hard asserts as each finding is fixed (F-L2, F-C1, F-C2). F-L1's
  fixme is DELETED (resolved as docs — the passing "documented transfer" test
  already pins the convention). Add: fader-persistence e2e for F-F1 (spawn
  WITH params, assert the split without setNodeParam). 3× flake-check each.
- **VRT**: all four keyer cards are currently VRT-EXEMPT ("baseline pending"
  debt in vrt-exemptions.ts) → zero baseline churn. No card UI changes
  planned. (Capturing the pending baselines is separate backlog per
  reconcile-means-fix-or-delete; not this program.) Composite-scene VRTs
  (#1063) don't render keyer output; re-verify at phase-4 rebase.
- **ART**: none — video-only, no audio basis files touched.
- **Docs gates**: docs edits stay inside the existing `docs-hash-ignore`
  markers (hash-transparent). `task docs:accept` + review the diff; contract-
  lock only changes if the optional matte/invert ports land.

## 7. Attest + CI cost

- **WebGL attest**: chroma.ts, chromakey.ts, luma.ts, lumakey.ts, fader.ts and
  the new keying-core.ts are all in the auto-included `lib/video/**` basis —
  ANY shader edit churns the hash. Therefore ALL shader changes (F-L2, F-C1,
  F-C2, F-F1, dedupe) land in ONE phase-4 PR = ONE re-attest. Local
  `task webgl:attest` is currently BLOCKED by 2 unrelated video-orientation
  cameraInput failures (memory: webgl-attest-video-orientation-camera-fail;
  the coordinator owns that) — phase 4 must rebase onto the fix before the
  final attest (attest-treadmill lesson: re-base onto target main BEFORE the
  final attest).
- **CI wall-time**: keyer-functional.spec.ts measured 11.8s for the full file
  locally (real GPU; 6 active tests, tiny 2–6-node patches, 4-step frozen
  bursts, no video decode). Even at SwiftShader's typical 2–3× ≈ 30–40s —
  well under the 2-min sign-off threshold. keying-core.test.ts is pure unit
  (~0).

## 8. What the rest of the family can adopt LATER (not forced now)

- QUADRALOGICAL: its CHROMA/LUMA edge-fx GLSL + blend2() TS are line-identical
  copies of the module keyers — mechanical swap to kcChromaMask/kcLumaMask
  (keeps its global invert + per-edge t-crossfade wrappers). Deferred: it
  drags in quad's own VRT/behavioral surfaces and the card's live-dot math.
- TOYBOX combine ops: same swap for uOp 1/2; keeps its alpha-aware `keep *=
  t.a` (the one alpha-respecting consumer — the core returns scalar masks, so
  it composes cleanly).
- MAPPER/EDGES/FREEZEFRAME/CELLSHADE/…: re-export KEY_LUMA_WEIGHTS instead of
  private copies (pure dedupe, zero behavior).
- A future `keyer` matte-only utility (mono-video matte out) becomes ~40 lines
  on the core.

## 9. Non-goals (explicit)

- NO engine/module-registry/cable-type changes; no new shader-include system.
- NO YCbCr studio-swing / colorspace UI (COLOUROFMAGIC owns colorspace play).
- NO switch to Rec.709 luma — 601 stays the app-wide documented flavor.
- NO change to CHROMA's HSV semantics (value-desat stays; docs note it).
- NO quadralogical/toybox/mapper migration in phase 4 (see §8).
- NO VRT baseline capture for the four cards (separate debt).
- NO edge choke / matte blur (candidate for a later matte-tools pass).

## 10. Phase-4 execution order (for the builder)

1. `keying-core.ts` + `keying-core.test.ts` (pure, land-safe).
2. FADER F-F1 factory fix + fader-persistence e2e.
3. LUMA posterize bypass (F-L2) + docs wording (F-L1) → flip/delete fixmes.
4. CHROMAKEY rebuild on the core (F-C1/F-C2) + docs → flip fixmes; calibrate
   defaults against the passing green-screen e2e.
5. LUMAKEY/CHROMA dedupe swaps (behavior-identity; the passing e2e pins it).
6. `task docs:accept`; typecheck; 3× flake-checks; ONE re-attest (post-rebase);
   owner preview of the chromakey look change; PR.

## 11. Phase-3 adversarial design review (2026-07-11) — verdict + required changes

**Verdict: GO-WITH-CHANGES.** Independently verified sound: the metric family
(key-relative CbCr distance fixes F-C1 — the finding pixel lands at normalized
d=0.828 vs default thr 0.15 + soft 0.08 → kept; any neutral gray sits at
EXACTLY d=1.0 for every saturated key; blue-screen symmetric d=0 at key);
kcDespill (standard min-limit family, exact identity at amount=0); the
LUMAKEY/LUMA swaps ARE coefficient-exact (both already Rec.601, same smoothstep
form → bit-identical for in-range params); zero-migration (all five cards
persist params only — no `node.data`; the curated examples Glitches / Media
Burn / gibribbon contain NO keyer/fader nodes, verified by decoding the Yjs
envelopes); the VRT-exempt claim (all four keyers + FADER "baseline pending" on
this branch AND current origin/main — the 13-pair drain didn't touch them);
attest scope (edited files all inside the `lib/video/**` dir-walk basis, e2e
spec edits hash-transparent; reconciler.ts is UNTOUCHED by this design and in
NEITHER basis — the F-F1 fix is fader.ts-factory-side, so no collab attest);
existing e2e survive the new metric (video-controls' orange-key flip: red d=0.60
→ kept at thr 0, keyed at 0.9; orientation triangles are neutral → d=1 → kept).
`keyer-functional.spec.ts` re-run on this branch: 6 passed / 4 fixme, 11.8s.

**Required changes for phase 4, by severity:**

1. **[blocks step 4] The F-C1 fixme CANNOT flip green as written.** The kept
   subject (0.6,0.75,0.55) composited at alpha=1 has B=140 (its OWN blue), but
   the test asserts `B ≤ 120`. Post-fix output is (153,172,140) at
   spillSuppress 0.5. Rewrite the assertion when flipping the fixme:
   band-assert the kept color (R≈153±TOL, B≈140±TOL, and G below ~180 to prove
   despill acted) — "no bg flood" means B far below 255, not below the
   subject's own channel.
2. **[HIGH, look-quality] The default-threshold calibration criterion is too
   weak.** "Pure key → 0, red/blue → 1" already holds at thr=0.15, but a
   REALISTIC screen pixel (0.2,0.8,0.3) sits at d=0.454 and half-brightness
   key-green (0,0.5,0) at d=0.500 — both KEPT at defaults, both keyed by the
   OLD hue metric. Chroma-plane distance conflates shading variation with hue
   distance. Either re-tune the default (thr≈0.5 keys both probes while the
   F-C1 subject at 0.828 still survives — note a defaultValue change is a
   contract-lock diff) or explicitly accept "defaults key only near-pure keys"
   (fine for this app's synthetic sources). PIN the decision: add the three
   probe colors to keying-core.test.ts + one realistic-screen e2e row, and put
   the default choice in the owner-preview loop.
3. **[MED] HSV inconsistency / CHROMA scope.** The §4 core sketch has no HSV
   helpers, yet §5/§10 have CHROMA "import shared HSV helpers" — and the NEW
   chromakey needs no HSV at all. Recommended: DROP chroma.ts from phase 4
   (zero functional change there; HSV dedupe moves to the §8 quad/toybox pass).
   Alternative: add GLSL_HSV_HELPERS + TS mirrors + tests to the core now.
   Basis-edit count becomes four + the new core either way; still ONE re-attest.
4. **[MED] Keep the defensive in-shader clamps.** ydoc params are NOT
   range-validated (only CV writes are clamped, by scaleCv); today's shaders
   clamp thr/soft/gamma as the last line of defense (luma.ts says so
   explicitly). kcLumaMask/kcChromaMask must clamp to the declared ranges to
   preserve exact current semantics.
5. **[MED] Interpolate shared constants into the GLSL** (the mapper.ts
   pattern): the sketch hardcodes 0.299/0.587/0.114 and 0.564/0.713 in BOTH the
   GLSL string and TS. Template-interpolate from KEY_LUMA_WEIGHTS etc. so
   GLSL↔TS lockstep holds by construction, not by a string-containment test.
6. **[MED, CI hygiene] keyer-functional.spec.ts matches NO WEBGL_HEAVY_GLOBS
   entry** → this readPixels DRS spec runs on the sharded SwiftShader matrix
   (the documented contention-flake class, #621/#1016). Add a glob entry in the
   phase-4 PR (webgl-heavy-globs.ts is in the attest basis — free inside the
   already-planned single re-attest), or rename to match
   `**/*-render-smoke.spec.ts` to auto-enroll.
7. **Minor:** (a) posterize bypass must test the ROUNDED level
   (`levels >= 16.0` after `floor(x+0.5)`), not the raw uniform, so CV 15.7
   doesn't band harder than 16.0; (b) drop the unexplained `(0.5 + 0.5·alpha)`
   despill scale — plain `uSpillSuppress` matches the cited literature and no
   test distinguishes them (if kept, justify it); (c) the owner-preview note
   must mention LUMA-at-defaults also changes look (banding removed), not just
   CHROMAKEY; (d) toybox-chromakey-shader.test.ts's premise ("ports the
   standalone chromakey.ts verbatim") inverts after the rebuild — update its
   header to "pins toybox's LEGACY hue+satGate keying (module moved to
   chroma-plane; toybox migration deferred, §8)"; (e) the §4 main() sketch
   omits the uHasFg/uHasBg fallbacks — keep them; (f) document that an
   achromatic key (length(kc) floored at 0.05) keys ALL neutrals regardless of
   luma — point black/white-backdrop users at LUMAKEY.

**Phase-4b (matte output + invert): DEFER.** Neither HIGH finding needs it; it
adds contract-lock churn + per-port sweep enrollment for a med design-gap.
Ship the core fixes first; matte-out rides the §8 follow-up.

**Scope judgment (simpler-alternative test):** a chromakey.ts-only fix would
close F-C1/F-C2 but costs the SAME one re-attest (any basis edit churns the
hash) and leaves the four-way mask/composite duplication + the F-L2/F-F1 fixes
un-batched. The shared core earns its surface via the proven mapper/
fader-transitions TS-mirror pattern and the §8 adopters — minus chroma.ts,
which adds identity-risk for zero immediate dedupe (change 3).
