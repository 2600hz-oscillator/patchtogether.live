# FACE SPEC — `cube` (batch 3) — **MY ADDITION TO REACH 12 · RECOMMENDATION: SWAP IT OUT**

> ⚠ **STATUS CORRECTED 2026-08-04.** PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`) — read
> the def on `main`. cube is **UNBUILT and this spec's own verdict is SWAP OUT (do not
> face)**, so it stays as an AUDIT, not as backlog. **But its headline measurement is now
> out of date:**
> - ✅ **MORPH is no longer a bit-exact no-op at spawn** — **FIXED in #1314** (`e8585fd9`),
>   "MORPH was a BIT-EXACT no-op on every freshly spawned module". §2's "the reason is one
>   line of default data" and the `field` band hint at §4 ("MORPH is inert while both tables
>   are the same") **no longer describe shipping code.**
> - ✅ **The amp ADSR did nothing at the shipped default** — fixed in **#1360**
>   (`91e14cc0`; ⚠ owner audio preview + GPU re-attest).
> - ⚠ The rest of "7 of 24 knobs do not survive measurement" (including `view_rot_z`) was
>   **not re-verified** on 2026-08-04. **Re-measure before citing any number in here.**

**Status:** SPEC + MOCKUP ONLY — **UNBUILT, verdict SWAP OUT.** PF-20 platform (PR #1301 — MERGED, `c6ff9253`). Citations file:line.

⚠ **The owner named ten modules. `cube` and `twotracks` are MY additions to reach twelve, and
both are flagged as swappable.** After the investigation I am recommending **both be swapped
out** — for cube, because seven of its twenty-four knobs do not survive measurement, and a
curated face would be curating a control surface that is measurably lying.

**Verdict: DO NOT FACE YET. Open a DSP-fix PR first; it would be an excellent face afterwards.**

---

## 0. AUDIO OR VIDEO — the answer is "audio, and it is in the WebGL attest basis anyway"

`domain: 'audio'` (`packages/web/src/lib/audio/modules/cube.ts:157`), `category: 'sources'`
(`:159`), ports are `cv`/`audio` (`:168, :201-208`), and contract-lock pins
`cube meta domain=audio` (`contract-lock.txt:729`). **However** it declares `rendersWebGL: true`
(`cube.ts:164`) and is listed literally in `AUDIO_WEBGL_MODULE_DEFS`
(`scripts/webgl-attest-lib.ts:67`) — **so editing this def churns the GPU attest hash**, and its
`docs` block is already wrapped in `docs-hash-ignore` markers (`cube.ts:274, :353`) for exactly
that reason. **Practical consequence for a face: `face:` is UI metadata but it lives in a file in
the WebGL basis, so it must go inside `docs-hash-ignore` markers too, or the face costs a GPU
re-attest.** That is a real, citable cost the other eleven modules do not have.

---

## 1. WHAT IT ACTUALLY DOES — and my model of it going in was wrong

**It is not a rotating polytope whose projected vertices drive audio.** There are no vertices and
nothing rotates over time. It is a **static 3D scalar field ray-marched by a static plane.**

1. Three e352 wavetables (64×256) read as 2D heightfields, bilinear
   (`packages/dsp/src/lib/cube-dsp.ts:115-142`), mapped to [0,1] (`:145-151`).
2. Occupancy: `dF = occ(z; floorH, wallH)`, `dC = occ(z; ceilH, wallH)`; between the two heights
   `occ` blends a half-ellipse `√(1−t²)` (CONNECT 0) with a linear ramp `1−t` (CONNECT 1)
   (`:179-213`). `f3 = (1−m)·dF + m·dC` (`:295`); HARD thresholds at 0.5 (`:301`).
3. Slice geometry: for readout index `n ∈ [0,256)`, `px = n/256 − 0.5`; the scan offset and the
   normal are Euler-rotated X→Y→Z by `slice_rx/ry/rz` (`:612-636, 656-665`).
4. **96 ray-march steps over `t ∈ [−√3/2, +√3/2]` ALONG THE NORMAL**, accumulating field density,
   normalised by `CUBE_RAY_STEPS` (`:683-743`).
5. `out[n] = clamp(crush(depth,k)·2 − 1, −1, 1)` (`:789`). **That 256-sample array IS one cycle.**
6. Playback is a plain wavetable oscillator: `freq = clamp(261.626·2^(pitch + tune/12 +
   fine/1200), 1, sr/2)`, linear interp over the fixed 256-sample table
   (`packages/dsp/src/cube.ts:128, 185-190, 608, 668-676`) — **no band-limiting.**

Steps 1-5 (~256 × 96 field reads × 3) run **on the main thread** in the factory
(`cube.ts:481-524`); the worklet only phase-accumulates and posts `paramsChanged` when a
1/512-quantised signature moves (`packages/dsp/src/cube.ts:458-486`).

---

## 2. WHY IT SHOULD NOT BE FACED YET — the control set does not survive measurement

27 params; contract-lock block = **47 lines** (`contract-lock.txt:729-775`: 1 meta + 15 in +
4 out + 27 param). `rmsΔ` below = the RMS change in the 256-sample slice versus spawn defaults,
from a verbatim port of `cube-dsp.ts` run against the real procedurally-generated factory tables.

| control | measured behaviour | verdict |
|---|---|---|
| `morph_fc` | **rmsΔ = 0.00000 across its entire range** | **BIT-EXACTLY DEAD at spawn** |
| `spread` | **−36.2 dB side/mid at maximum**, corr(L,R) = 0.999979 | inaudible |
| `space_crush` | max rmsΔ **0.072** | near-inert |
| `crush` | rmsΔ 0.078 at k = 0.95, **0.716 at 1.00** | dead over 95 % of travel |
| `space_diffuse` | peaks 0.568 at 0.95, **falls to 0.385 at 1.00** | non-monotonic |
| `slice_y` | rmsΔ ≤ 0.022 for y ∈ [0, 0.9] | near-inert |
| `view_rot_z` | never read by the renderer | **DEAD** |

**That is 7 of 24 knobs a face would have to either fix or hide**, and **there is a shared
architectural cause**: `rayDepth` integrates over a **fixed ±√3/2 window centred on the ray
origin** (`cube-dsp.ts:709-713`), so **translating the plane along its own normal — which is
exactly what both `slice_y` (unrotated) and `spread` do — is very nearly a no-op.**

**MORPH is the worst of them and the reason is one line of default data.**
`CUBE_DEFAULT_TABLES` sets `floor: 'basic-shapes'` **and** `ceiling: 'basic-shapes'`
(`cube.ts:95-99`). Therefore `floorH ≡ ceilH`, so `dF ≡ dC` and
`f3 = (1−m)·dF + m·dC = dF` for **every** `m` (`cube-dsp.ts:293-295`). Measured `rmsΔ = 0.000e+0`
at m = 0, 0.25, 0.5, 0.75, 1.0. Swap CEILING to HARMONIC SWEEP and it comes alive (rmsΔ 0.141 at
m = 1). **The module's headline knob, its CV jack and its docs sentence
(`cube.ts:282`, "MORPH cross-fades the floor↔ceiling layers") do literally nothing on a fresh
spawn.**

**A curated face cannot paper over any of this**, and a face that ranked MORPH first — which
every reading of the def says it should — would rank a bit-exact no-op at rank 1.

**THE CASE FOR, stated fairly.** cube is the most visually distinctive module in the batch: a real
WebGL2 volume render whose cut plane is **provably** the plane the audio reads (`eulerMat` is
explicitly built to match `cube-dsp.rotate()`, `CubeCard.svelte:311-327` vs
`cube-dsp.ts:656-665`). Its three card visualisers are excellent and correct. It has nine honest
derived readouts (§3), four with knob-invisible negative controls. And it is the **one card in
the batch that does NOT re-type ranges** — `min={minFor(k.pid)} max={maxFor(k.pid)}
defaultValue={defaultFor(k.pid)}` all resolve from `cubeDef.params` (`CubeCard.svelte:65-68,
1168-1170`), which is exactly the pattern CLAUDE.md asks for. (Curves *are* re-typed in three
places — `:1173`, `:1215`, `:1036-1039` — and all three agree today.)

**The DSP-fix PR this asks for instead:** fix the normal-translation degeneracy, re-taper CRUSH,
default CEILING to a different table so MORPH works, and implement or delete `view_rot_z`. Then
face it.

---

## 3. IF THE OWNER OVERRULES — the face, and it is a good one

```ts
face: {
  title: 'Field oscillator',
  hint:
    'A static 3D scalar field, ray-marched by one movable plane. The 256 samples that plane reads ' +
    'ARE the waveform — so the rotation knobs are the timbre controls, and the pitch knobs only ' +
    'decide how fast that cycle is replayed.',
  order: [
    'slice_ry','slice_rx','slice_rz','wrap','fold','tune',        // 1-6 lane budget: the STRONGEST controls
    'cube-field-{n}',
    'fine','material','crush','morph_fc','connect','connect_strength',
    'space_diffuse','space_crush','spread','slice_y',
    'level','base_vol','attack','decay','sustain','release',
    'view_zoom','view_rot_x','view_rot_y','view_rot_z','screen_on',
  ],
  pages: [
    { id: 'slice', label: '1 · the plane', hint: 'rotating the scan axis is what changes the timbre — these are the module\'s strongest controls by a wide margin',
      controls: ['cube-field-{n}','slice_ry','slice_rx','slice_rz','slice_y'] },
    { id: 'field', label: '2 · the field', hint: 'two stacked heightfields and the connector between them — MORPH is inert while both tables are the same',
      controls: ['morph_fc','connect','connect_strength','material','wrap'] },
    { id: 'shape', label: '3 · shaping', hint: 'fold, then two independent quantisers — one on the value, one on the lookup coordinates',
      controls: ['fold','crush','space_crush','space_diffuse'] },
    { id: 'pitch', label: '4 · pitch · out', hint: 'the table is always 256 samples, so this is a plain wavetable oscillator with no band-limiting',
      controls: ['tune','fine','spread','level','base_vol'] },
    { id: 'env',   label: '5 · envelope', hint: 'inert unless POLY or TRIGGER is patched — unpatched, BASE is the gain',
      controls: ['attack','decay','sustain','release'] },
    { id: 'view',  label: 'view', hint: 'camera only — none of these touch a sample',
      controls: ['view_zoom','view_rot_x','view_rot_y','view_rot_z','screen_on'] },
  ],
  glyph: 'scope',
  hero: { cell: 'cube-field-{n}', control: 'slice_ry',
    readouts: [ { label: 'solid', valueId: 'cube-solid-pct' }, { label: 'DC', valueId: 'cube-dc' }, { label: 'turning points', valueId: 'cube-turning-points' } ] },
  sidebar: [ /* signal-flow + a `readouts` block carrying §4 */ ],
}
```

⚠ **Six bands is one short of `DOCK_TAB_MIN_BANDS = 7`** (`dock-tabs-model.ts:46`) — deliberately,
so the faceplate stays a scrolling page rather than a tab rail. Adding a seventh band later flips
the whole layout; say so in the face comment.

---

## 4. DERIVED READOUTS — nine honest ones, and one that must NOT be built

| readout | formula | negative control a knob readback fails |
|---|---|---|
| `cube-f0-hz` | `clamp(261.626·2^(pitchV + tune/12 + fine/1200), 1, sr/2)` (`packages/dsp/src/cube.ts:128, 608, 668-672`) | patch V/oct: F0 moves with TUNE/FINE frozen. Also exposes the **silent clamp** — pitch 4 V + tune 36 + fine 100 gives raw **35 479 Hz displayed as 24 000 Hz** (measured). |
| `cube-harmonics` | `floor(sr/2/F0)`; `readFrame` is bare linear interp (`:185-190`) | measured 91 @C4, 45 @C5, 11 @C7, **1** at the clamp. Moves on pitch CV only. |
| `cube-solid-pct` | `(mean(wave)+1)/2` = mean over 256 rays of `(1/96)·Σ field` (`cube-dsp.ts:712-742, 789`) | rotate `slice_rx` 0 → 1.2 with everything else fixed: −0.374 → −0.339. **WRAP off → on: −0.374 → +0.121.** No knob shows this. |
| `cube-dc` | `mean(wave)·base_vol·level` (`packages/dsp/src/cube.ts:753-754`) | **measured −0.3744 at spawn, \|DC\|/acRMS = 1.07×** — *the ports carry more DC than signal.* A defect readout no control exposes. |
| `cube-turning-points` | sign changes of the posted centre wave, already on the main thread (`cube.ts:517-518`, exposed `:615`) | MATERIAL SMOOTH → HARD moves turning points **28 → 50** while rmsΔ is only 0.021 — **the count sees a timbral change RMS misses.** rx = π/2 → **2**. |
| `cube-width-db` | `20·log10( rms((L−R)/2) / rms((L+R)/2) )` from the ∓`0.18·spread` pair (`cube-dsp.ts:72-75`; `cube.ts:504-507`) | **the killer.** SPREAD at 1.00 reads "100 %" while measured width is **−36.2 dB**. Ladder: −∞ / −57.0 / −49.9 / −46.9 / −36.2 dB. |
| `cube-crush-levels` | `max(2, round(256 − 254k))` etc. (`cube-dsp.ts:341-353, 397-400`) | monotone in one knob (a weak control), but it exposes the **cliff**: k = 0.95 → 15 levels (rmsΔ 0.078), k = 1.00 → **2 levels** (rmsΔ 0.716). |
| `cube-folds` | drive `= 1+4k` (`:535, 556`); the fold count depends on the slice **peak**, not the knob | fold = 1.0: default peak 0.845 → **2** fold-overs; rx = 1.2 peak 1.000 → **3**, with FOLD untouched. |
| `cube-voices` | `1/√N`, N counts `env.value > 1e-4` (`poly-osc-sum.ts:29, 161`) | a *releasing* voice still counts — a gate-counting readout would disagree. |

**⚠ DO NOT BUILD: a "beat frequency between two rotation planes".** `rx/ry/rz` are **static Euler
angles evaluated once per slice render** (`cube-dsp.ts:656-665`). There is no angular velocity, no
time term, nothing rotating. Any beating would belong to two external LFOs, not to cube. I am
naming this because it is the obvious readout for a module called "cube" and it would be an
invention.

---

## 5. ALREADY-WRONG

- **A · SPREAD is documented as ±5 % and is actually ±18 %.** `CUBE_SPREAD_DEPTH = 0.18`
  (`cube-dsp.ts:67`), but the **STRICT_DOCS-gated authored prose** says "±5 %" in four places
  (`cube.ts:9, :282, :316-317, :333`) and the DSP's own comments repeat it (`cube-dsp.ts:650,
  :753-754`). `DESCRIPTIONS` has it right ("±18 %", `module-manifest.ts:381`) — **so the gated
  doc is the wrong one.**
- **B · "±0.18 is clearly audible" (`cube-dsp.ts:66`) is false** — measured −36.2 dB side/mid,
  corr 0.999979 at spread 1. An unmeasured assertion in a comment.
- **C · the NO-SILENCE-ON-SWEEP guard is dead code for its documented trigger.** The header says a
  slice swept fully outside the cube with WRAP off yields an all-zero wave that `adoptWave` will
  reject (`packages/dsp/src/cube.ts:31-35, 435-447`). **Measured: a fully-outside slice returns
  all exactly −1**, because `out = depth·2 − 1` and depth = 0 (`cube-dsp.ts:789`). `isSilentWave`
  (`:81-86`) therefore returns **false**, the guard never fires, and the real behaviour is a
  **full-scale −1 DC step**, not preserved audio. Verified: `all|v| ≤ 1e-6 = false; all == −1 = true`.
- **D · `view_rot_z` is a dead control.** A def param (`cube.ts:265`), a card knob
  (`CubeCard.svelte:1030`), documented as "orbits the 3D view" (`cube.ts:349`) — but `renderGl`
  reads only `view_zoom`/`view_rot_x`/`view_rot_y` (`:577-578`), the eye vector uses only
  `vrx`/`vry` (`:618-620`), and `sceneSig` omits it (`:587-589`). **The sibling implements roll**
  (`packages/web/src/lib/video/modules/videocube.ts:1567`), so this is a cube-specific omission.
- **E · `module-manifest.ts:381` says "v1 is audio-only; a cross-domain viz_out video raster is a
  planned follow-up"** — `video_out` shipped (`cube.ts:213`) and is fully wired (`:588-606`).
- **F · "distinct range from crushGridSteps (256→4) so the two crushers read differently when
  stacked"** (`cube-dsp.ts:394-396`) — measured, they are within 1–2 grid cells of each other over
  the whole range (231/231, 193/194, 130/131, 67/69) and diverge only at k = 1 (4 vs 6). The claim
  is essentially false.
- **G · the `trigger` port declares no `edge:`** while the worklet reads it as a **level gate on
  both edges** (`packages/dsp/src/cube.ts:631, 644-646`) — so the correct annotation is
  `edge: 'gate'` and **the port's NAME is misleading under the repo's own taxonomy.**
- **H · hypercube did not inherit cube's two fixes.** `packages/dsp/src/hypercube.ts:165-174`
  still builds smoothers against `sampleRate` instead of block rate (cube's own comment at
  `packages/dsp/src/cube.ts:282-294` calls that "128× too slow"), and `hypercube.ts:359` still
  bails on `!outL` — the exact bug cube fixed at `packages/dsp/src/cube.ts:541-544`. Not cube's
  bug, but it is cube's shared library.

---

## 6. COST — if it ships anyway

| | |
|---|---|
| **contract-lock** | +1 line (`cube family cube-field kind=cell prefix=cube-field`); **+1 modified** if `edge: 'gate'` lands. 47 → 48. |
| **⚠ WebGL attest** | **the face block must be wrapped in `docs-hash-ignore` markers** (`cube.ts:274, :353` already do this for `docs`) or the edit churns the GPU attest hash and forces a re-attest on a trusted machine. **No other module in this batch has this cost.** |
| **VRT** | `darwin/cube.png` plus a composite `darwin/cube-adsr-midilane.png` (`e2e/vrt/cube-adsr-composite.spec.ts:83`, which spawns with `screen_on: 0`). **`'linux/cube'` is in `EXEMPT_BASELINE_PAIRS`** (`vrt-exemptions.ts:1267`) — **so on CI, which renders linux, cube has ZERO VRT protection today.** Not in `STRICT_VRT_MODULES`, so it never gates a merge. |
| **e2e** | +1 `faces-parity` row (**28 cells** — the second most expensive in the batch after pentemelodica). |
