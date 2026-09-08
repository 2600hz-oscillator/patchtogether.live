# cube — face rebuild: the MEASUREMENTS, and what is still open

**The face SHIPPED 2026-08-10** (cube is in `strict-faces.ts:165`). The visual spec, the parity
ledger and the paradigm argument that used to occupy most of this file are now the def itself
(`packages/web/src/lib/audio/modules/cube.ts:375+`) and have been deleted from here. What remains
is the measurement record, the shipped-vs-proposed delta, and the ledger of what is still open.

All measurements dated **2026-08-09** against `main` @ `2af79daf`, through a verbatim harness over
the REAL `packages/dsp/src/lib/cube-dsp.ts` and the REAL factory tables. Citations are `file:line`.

---

## 0 · SHIPPED vs PROPOSED

**Matching the spec exactly:** `hero.cell: 'cube-view-{n}'`, `hero.control: 'slice_ry'`, all four
readouts `cut` / `Y` / `levels` / `width` with the same valueIds, `glyph: 'scope'`, six pages,
`rear: { audioRate: ['pitch'] }`, the two `controlFamilies` panels ranked last, and the six-bands-is-
load-bearing warning (`DOCK_TAB_MIN_BANDS` is 7).

**Did NOT ship, and each difference is deliberate:**

| proposed | shipped | note |
|---|---|---|
| a `signal-flow` sidebar block | **nothing** — zero `signal-flow` occurrences in `cube.ts` | struck by the 2026-08-11 owner ruling (below) |
| page id `cut` | `slice` | and the label carries the idea: `'1 · the slice — this is the timbre'` |
| `title: 'Solid & cut'` | `'Solid & slice'` | annotation-only either way |
| lane ranks 4-6 `morph_fc · fold · wrap` | **`wrap · morph_fc · fold`** | `wrap` promoted over both |
| sidebar `readouts` roster incl. `spread` | `spread` dropped, **band-limiting added** | |

⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
`:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work should
reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of them. lose the
signal flow diagrams."* cube shipped without a flow diagram already; the page `hint`s it does carry
are annotation-gated and are candidates for the clean-up sweep.

### Three numbers in the original brief were wrong — corrected

| brief said | actual | where |
|---|---|---|
| "**46 params**" | **27 params** | `cube.ts:230-297`. 46 is the *contract-lock row count*: 1 meta + 15 in + 4 out + 27 param = 47 lines, of which 46 are ports+params. |
| "CubeCard.svelte — 1284 lines" | **1285** | trivial, noted only because the brief said not to trust it. |
| batch-3: "24 knobs" | **24 knobs + 3 toggles + 9 DOM-only = 36 controls** | the 9 wavetable controls (3 selects, 3 preset selects, 3 file loaders, `CubeCard.svelte:1092-1136`) were never counted. |

---

## 1 · The instrument, in one paragraph

cube is **a solid and a cut**. Three e352 wavetables are read as 2-D heightfields and stacked into a
3-D scalar density field (`cube-dsp.ts:286-313`); a unit square plane is positioned by `slice_y` and
Euler-rotated by `slice_rx/ry/rz` (`cube-dsp.ts:656-665`); for each of 256 positions along the
plane's scan axis a ray is marched **96 steps along the plane's normal** over a fixed `±√3/2` window
and the accumulated density becomes one sample (`cube-dsp.ts:683-743`). That 256-sample array **is
one cycle of the waveform** (`:789`), replayed by a plain wavetable oscillator at the V/oct
frequency, with no band-limiting (`packages/dsp/src/cube.ts:185-190, 686-695`). Nothing rotates over
time — the angles are static Euler angles evaluated once per slice render.

**Steps 1–5 run on the MAIN thread**, in the factory, not the worklet (`cube.ts:505-548`); the
worklet posts `paramsChanged` and phase-accumulates through the returned wave
(`packages/dsp/src/cube.ts:492-506`).

---

## 2 · MEASUREMENT

Harness: a standalone `tsx` script importing the real `cube-dsp.ts` and the two real factory tables
reproduced verbatim from `wavetable-factory-tables.ts:30-92`. Spawn state =
`floor: basic-shapes, wall: harmonic-sweep, ceiling: harmonic-sweep` (the defaults **of the day** —
see §2.3; the shipped defaults are now three distinct tables), all params at `defaultValue`.

**Instrument validated first.** Two identical renders → `maxAbsDiff = 0.00e+0` (deterministic). A
1e-3 nudge on `ry` → `rmsΔ = 3.514e-2` (the metric *moves*). A pure ×0.5 level change →
`rmsΔ = 0.25589` (rmsΔ is **not** level-invariant, so it cannot hide a gain change the way a
correlation would). And where a sweep looked periodic I **re-sampled at 23 prime-strided offsets**
rather than an even 21-grid — the `slice_y` ripple survived, so it is real structure and not my grid
aliasing against the 96-step ray march.

### 2.1 · The authority league table

Max `rmsΔ` versus the spawn wave, over each control's **full declared travel**:

```
  slice_ry           0.79829  ████████████████████████████████
  crush              0.71639  █████████████████████████████     ← but see 2.2
  slice_rz           0.69973  ████████████████████████████
  space_diffuse      0.57197  ███████████████████████           ← but see 2.2
  wrap (0→1)         0.54037  ██████████████████████
  slice_rx           0.31972  █████████████
  morph_fc           0.14114  ██████
  slice_y            0.13346  █████                             ← but see 2.4
  space_crush        0.07209  ███
  connect            0.06990  ███
  connect_strength   0.04799  ██
  material (0→1)     0.02069  █                                 ← but see 2.7
  spread             0.01922  █
  fold               1.12042  (post-slice; measured separately, peaks at k=0.75)
```

⚠ **Re-measured on the SHIPPED three-table defaults** (`cube.ts:370`) the ladder moves but does not
re-order: `slice_ry` 0.885, `slice_rz` 0.877, `slice_rx` 0.403, `morph_fc` 0.178, `slice_y` **0.115
flat → 0.759 at rx 0.8**. Use the shipped figures when arguing rank; the table above is the
two-table measurement the design was derived from.

### 2.2 · TWO controls emitted PURE DC at their maximum — the historical blocker

Batch-3 called CRUSH "dead over 95 % of travel" and SPACE DIFFUSE "non-monotonic". Both descriptions
were true and both **understated what happened at the endpoint.** Splitting rms into its DC and AC
parts is what exposes it — a plain rmsΔ reads the collapse as a *large change*, which looks like a
strong control:

```
  k       levels  uniqueVals  acRms(the AUDIO)   DC        verdict
  0.900       27           9          0.354716    -0.3699   audio
  0.950       15           5          0.351914    -0.3934   audio
  0.980        7           2          0.331334    -0.3698   audio
  0.995        3           2          0.490371    -0.5977   audio
  0.999        2           1          0.000000    -1.0000   *** SILENT (pure DC) ***
  1.000        2           1          0.000000    -1.0000   *** SILENT (pure DC) ***

   space_crush=1          acRms=0.333564  DC=-0.3907  uniq=6      (fine — control)
   space_diffuse=1        acRms=0.000000  DC=-0.2125  uniq=1   *** SILENT (pure DC) ***
   space_diffuse=0.95     acRms=0.071570  DC=-0.7907  uniq=230
   wrap ON + crush=1      acRms=1.000000  DC= 0.0000  uniq=2      (a hard square — WRAP rescues it)
```

* **`crush ≥ 0.999` (WRAP off) → the waveform is a constant −1.** `crushLevels(1) = 2`, every depth
  rounds to level 0, and `out[n] = clamp(0·2 − 1) = −1` (`:789`). Output = a full-scale DC step ×
  `level`, into `L` and `R` both.
* **`space_diffuse = 1.0` → the waveform is a constant −0.2125.** `diffusePull` at `k=1` is
  `c + (target − c)·1 = target` — every marched sample collapses onto the same face coordinate, so
  all 256 rays read the identical column.
* **Both were reachable by knob AND by CV** — `cvScale: {mode:'linear'}` onto a `0..1` AudioParam
  (`cube.ts:203, 205`).
* **The no-dropout guard was structurally blind to both.** `isSilentWave` tested `all |v| ≤ 1e-6`; a
  constant −1 fails that test, so `adoptWave` happily adopted it. Batch-3's finding **C** said the
  guard is dead code for its documented trigger; the measurement says it was dead code for **the two
  cases that actually occur.**

✅ **All three are FIXED — see the ledger.** Post-fix the def re-measures `acRms` **0.5528** (crush)
and **0.2450** (space diffuse) at maximum.

### 2.3 · THE PIGEONHOLE — #1314 did not fix the class, it MOVED the collision

Batch-3's headline was "MORPH is bit-exactly dead at spawn", caused by `ceiling === floor`. #1314
changed the default ceiling to `harmonic-sweep`. **MORPH became alive** — a clean linear ladder,
`rmsΔ = 0.141` at m=1 (`0.000000 / 0.070569 / 0.141138` at m = 0 / 0.5 / 1).

But `harmonic-sweep` **was also the WALL**. `occ(z, ceilH, wallH)` with `ceilH ≡ wallH` hits the
degenerate branch `if (span <= 1e-9) return zz < hi ? 1 : 0` (`cube-dsp.ts:192`) — a hard step, not
a connector. So CONNECT and CONNECT STRENGTH became **bit-exactly dead on the ceiling term**:
`maxAbsDiff` **0.000e+0** for connect 0.5 and 1, and for cnctStr 0.5 and 1, all at morph = 1.

There were only TWO factory tables and three slots. MORPH needs `floor ≠ ceiling`; the floor
connector needs `floor ≠ wall`; the ceiling connector needs `ceiling ≠ wall`. **By pigeonhole at
least one pair must collide.** Every possible assignment, measured:

```
  floor / wall / ceiling            MORPH 0→1  CONNECT@m=0  CONNECT@m=1  collision
  BASIC / HARM / HARM  ← then-SHIPPED 0.14114      0.06990      0.00000✗  ceiling == wall
  BASIC / HARM / BASIC ← pre-#1314    0.00000✗     0.06990      0.06990   floor == ceiling
  BASIC / BASIC / HARM                0.14070      0.00000✗     0.06990   floor == wall
  HARM / BASIC / BASIC                0.14070      0.06990      0.00000✗  ceiling == wall
  HARM / BASIC / HARM                 0.00000✗     0.06990      0.06990   floor == ceiling
  HARM / HARM / BASIC                 0.14114      0.00000✗     0.06990   floor == wall
  BASIC / PWM* / HARM  ← 3 DISTINCT   0.17786      0.13848      0.12141   NONE
```

`* PWM was hypothetical, written for this measurement only.` ✅ **It is now real** —
`wavetable-factory-tables.ts:143` ships `pwm-sweep`, and cube defaults to
`floor: basic-shapes / wall: pwm-sweep / ceiling: harmonic-sweep` (`cube.ts:141-143`). The
pigeonhole is closed and CONNECT's authority roughly doubled, exactly as the last row predicted.

### 2.4 · THE DESIGN FINDING — `slice_y` is dead in exactly ONE state: the SPAWN state

Batch-3 listed `slice_y` as "near-inert, rmsΔ ≤ 0.022 for y ∈ [0, 0.9]". True at spawn — and
**completely wrong as a description of the control.** Y's authority is a function of the plane's
ORIENTATION:

```
  rx      ry      max rmsΔ across y∈[0,1]
   0.000   0.000     0.13346   ← THE SPAWN STATE
   0.400   0.000     0.33299
   0.800   0.000     0.74877
   1.200   0.000     0.76807
   1.571   0.000     0.79371   ← 5.9× the spawn figure; ties slice_ry for #1
   0.000   0.400     0.32630
   0.000   1.571     0.70176
   0.800   0.800     0.63270
```

(On the shipped three-table defaults the same shape re-measures **0.115 flat → 0.759 at rx 0.8**.)

**Mechanism:** `rayDepth` integrates over a fixed `±√3/2` window *centred on the ray origin*
(`cube-dsp.ts:709-713`). Sliding the plane **along its own normal** therefore moves the window and
its contents together — very nearly a no-op. At spawn the normal IS the z axis and `slice_y`
translates along z, so Y is sliding along the one direction that does nothing. Tilt the plane and Y
stops being a normal-translation.

**This is the single most important fact about cube's user experience.** It is what the shipped
`cube-y-live` readout (`asleep` / `live`) and the `set the plane` preset block exist to expose, at
zero DSP cost.

### 2.5 · `slice_rx` is bit-exactly π-periodic — half its declared travel is a duplicate

```
   a        rmsΔ(a vs a−π)
   0.3      0.000e+0        1.1      0.000e+0        2.5      0.000e+0
   0.7      0.000e+0        1.5      0.000e+0        3.0      0.000e+0
   CONTROL — the same test on ROT Y (must be large, else the test is vacuous):
   0.7      0.24223         1.5      0.53891         2.5      0.83687
```

`f(rx) ≡ f(rx ± π)`, **bit-exactly**, at `depthOffset = 0`. Mechanism: the scan offset is
`rotate(px, 0, 0, rx, ry, rz)` and the X rotation is applied first to a vector with `y = z = 0`, so
**the scan offset never depends on `rx` at all** (`cube-dsp.ts:620-635, 659`). ROT X's only effect
is on the normal — and `rx + π` negates the normal, while the march window is **symmetric** about
the origin, so it visits the identical sample set in reverse and sums to the same number. (At
`spread > 0` the ±`depthOffset` rides the normal, so `rx + π` swaps L and R instead of being a true
identity.)

The declared range is `±3.1416` = 2π wide. **Exactly half of it is redundant.** `rx` is NOT even,
though — `f(a) ≠ f(−a)` (`rmsΔ` 0.117–0.157), measured rather than assumed after reasoning my way to
the wrong answer.

### 2.6 · The output is more DC than signal

```
  spawn:  rms=0.511773  DC=-0.374351  acRms=0.348960  |DC|/acRms=1.073  peak=0.8454
  wrap ON: DC=+0.121  |DC|/acRms=0.215     ry=1.2: |DC|/acRms=2.830
```

`out[n] = depth·2 − 1` with `depth ∈ [0,1]` and a spawn mean depth of ~0.31, so the wave sits at
−0.374 (`cube-dsp.ts:789`). **The L and R ports carry more DC than audio**, and WRAP is the only
control that meaningfully re-centres it.

### 2.7 · Where RMS is the wrong instrument: MATERIAL

```
  material HARD   rmsΔ=0.02069  (13th of 13 — looks like the weakest control on the module)
                  turningPoints 26 → 8      uniqueVals 250 → 34
```

MATERIAL barely moves RMS and **halves the waveform's structure**. A face that ranked by RMS alone
would bury it. The turning-point count is the instrument that sees it.

### 2.8 · Remaining confirmations and three new asymmetries

| # | finding | measured |
|---|---|---|
| **A** | **SPREAD is documented as ±5 % and is ±18 %.** `CUBE_SPREAD_DEPTH = 0.18` (`cube-dsp.ts:67`); the STRICT_DOCS-gated prose said ±5 % in **five** places (`cube.ts:9, 306, 340, 341, 357`). `DESCRIPTIONS` had it right (`module-manifest.ts:390`) — **the gated doc was the wrong one.** | CONFIRMED |
| **B** | **"±0.18 is clearly audible" (`cube-dsp.ts:65-66`) is false.** | side/mid ladder −234 / −57.0 / −49.9 / −46.9 / **−36.2 dB**; corr(L,R) = 0.999979 at spread 1 |
| **C** | **The no-silence guard never fires; the real behaviour is a full-scale −1 DC step.** | fully-outside slice: `isSilentWave = false`, `all == −1: true`, rms 1.0, DC −1.0 |
| **D** | **`view_rot_z` is a dead control** — a def param, a card knob, documented as "orbits the 3D view", and read by no renderer. | CONFIRMED 2026-08-09 |
| **E** | `DESCRIPTIONS` still said "v1 is audio-only; a cross-domain viz_out video raster is a planned follow-up" — `video_out` shipped (`cube.ts:227`) and is fully wired. | CONFIRMED |
| **F** | **"distinct range from crushGridSteps … so the two crushers read differently when stacked" is essentially false.** | 193/194, 130/131, 67/69, 29/31, 17/19, 7/9 — within 1–2 cells over the whole range; they diverge only at k=1 (4 vs 6) |
| **G** | **`trigger` declares no `edge:`** while the worklet reads both edges. Triaged as `edge: 'gate'`, CLEAR. | owned by the edge PR |
| **H** | **SYNC is 6.13 dB hotter than the audio, and LEVEL does not touch it.** SYNC is `sin(2π·phase)`, rms 0.7071 (−3.01 dBFS), never multiplied by `level` (`packages/dsp/src/cube.ts:744, 761, 787`); L/R acRms is 0.3490 (−9.14 dBFS). Patching SYNC to a mixer alongside L/R is a +6 dB surprise. | NEW |
| **I** | **Only `pitch` is audio-rate.** Every other CV input is summed into an AudioParam the worklet reads **once per block** via `aval` (`packages/dsp/src/cube.ts:445-449`), quantised to 1/512 of range (`:481`) and smoothed at an 80 Hz corner against the ~375 Hz block rate. The CV jacks are **control-rate**; an audio-rate LFO into `morph_fc` will alias, not FM. | NEW — now carried by `rear: { audioRate: ['pitch'] }` |
| **J** | **L/R are not level-matched at spread.** At spread 1: rmsL −6.04 dB, rmsR −5.85 dB, **ΔL−R = −0.192 dB**; DC_L −0.3562 vs DC_R −0.3717. | NEW |
| **K** | **Exact quarter turns collapse the waveform's structure.** `rx=±π/2 → turningPoints 0–1`; `ry=+π/2 → 0`. The collapse is razor-thin (±0.01 rad restores tp to 11–15), so it is a knife-edge, not a dead zone. | NEW |

### 2.9 · Two readouts that must NOT be built, and why

* **"beat frequency between two rotation planes."** `rx/ry/rz` are static Euler angles evaluated
  once per slice render (`cube-dsp.ts:656-665`). There is no angular velocity and no time term. Any
  beating belongs to two external LFOs, not to cube. Named because it is the obvious readout for a
  module called "cube" and it would be an invention.
* **A stereo-width readout in dB.** It needs both rendered channels, so it is not a `valueId`; and
  putting `−36.2 dB` on the faceplate reports a DSP weakness as if it were a setting.
  `cube-spread-depth` states the **depth offset**, which is what the knob actually commands.

⚠ **The platform constraint behind that split.** `FaceReadoutValue` is a pure function of live
PARAMS (`face-readout-values.ts:123`) — it cannot read `node.data` (which wavetable is loaded) and
it cannot read the engine snapshot (the rendered wave). Batch-3 proposed nine derived readouts and
**six were unbuildable as written** (`cube-solid-pct`, `cube-dc`, `cube-turning-points`,
`cube-width-db`, `cube-folds`, `cube-voices`). Wave-derived numbers belong in the hero panel's own
caption, which receives the nodeId and can call `useEngine()`.

---

## 3 · DEFECT LEDGER — the companion DSP PR, item by item

| # | item | verdict |
|---|---|---|
| **1** | `crushLevels` floor 2 → 3 | ✅ **FIXED, and further** — `CUBE_CRUSH_MIN_LEVELS = 4` (`packages/dsp/src/lib/cube-dsp.ts:379`) |
| **2** | `diffusePull` ease so `k=1` cannot collapse every sample onto one coordinate | ✅ **FIXED** — `Math.min(kk*kk, CUBE_DIFFUSE_MAX_PULL)` (`cube-dsp.ts:588`) |
| **3** | a THIRD factory table so no pair of slots collides | ✅ **FIXED** — `pwm-sweep` ships (`wavetable-factory-tables.ts:143`) and cube defaults to three distinct tables (`cube.ts:141-143`) |
| **4** | `isSilentWave` → a "degenerate wave" test (`acRms < ε`, not `all |v| < ε`) | ✅ **FIXED** — `cube-dsp.ts:90-102` + `cube-degenerate-wave.test.ts` |
| **5** | `view_rot_z`: implement OR delete | ✅ **RESOLVED AS DELETE** — `cube.ts:317-322` now reads *"There is no `view_rot_z`."* ⚠ Note the spec recommended **implement** (the sibling `video/modules/videocube.ts:1567` has a real camera roll) and the owner went the other way. |
| **6** | `slice_rx` range `±π → 0..π` | ⛔ **STILL OPEN** — `cube.ts:282` is still `min: -3.1416, max: 3.1416`. Half the declared travel is bit-exactly redundant (§2.5). A `ParamDef` range edit ⇒ contract-lock + re-attest. |
| **7** | *optional* — a `manualTrigger` read key so the face could have a real audition | **NOT SHIPPED.** `cube.ts:414-418` re-argues the refusal: the handle exposes only `snapshot`/`live`/`tableLabels`/`frames`, so a hero button would be a `toBeEnabled()`-passing dead control — the class `ShellActionCell.probe` is required for. |
| **8** | the prose fixes (five `±5 %` strings, the false "clearly audible" and "distinct range" comments, the stale "v1 is audio-only") | rode the face PR |

### Still-open hazards that are not DSP

* ⚠ **LABEL CLIPPING IS INVISIBLE TO `faces-parity`** (`toHaveText` reads `textContent`). A knob
  column measures **40–68.8 px** (`dock-row-plan.ts:82`); at the shell's 9–10 px mono caption that
  is **~7–8 characters**. `'Space Diffuse'` (13) and `'Space Crush'` (11) **will** clip, silently.
  The face must not rename them — a `ParamDef.label` change is a contract-lock diff — so the budget
  is: any cell in a packed row gets ≤ 8 characters, and the two that exceed it are called out here
  so a reviewer **looks at the render** instead of trusting the green gate.
* ⚠ **`cube` is in `AUDIO_WEBGL_MODULE_DEFS`, and so is any `.svelte` under `lib/ui/modules` whose
  source creates a WebGL context** (`webgl-attest-lib.ts:236-242`, auto-enrolment). A WebGL hero
  panel would enrol itself in the basis and force a trusted-machine GPU re-attest;
  `docs-hash-ignore` does nothing here, because it strips doc regions, not files. The cheaper route
  is a 2-D canvas panel blitting a frame the existing card renderer produces — see §4 item 2.
* **Curves are re-typed in `CubeCard.svelte` in three places** (`:1175` `curve="linear"`, `:1196`
  `curve={k.curve}`, `:1217` the view ternary). Ranges were already def-bound; the card is now in
  both `RANGE_BOUND_CARDS` and `MAPPING_BOUND_CARDS` (`card-range-source.test.ts`), which closed
  this.
* **VRT: RE-CHECK.** The old note here said `'linux/cube'` sat in `EXEMPT_BASELINE_PAIRS` so cube
  had zero VRT protection on CI. **That mechanism no longer exists** — there is ONE baseline set,
  authored by the linux capture job. cube now has real coverage on disk:
  `vrt.spec.ts/cube.png`, `workflow-shell-faces.spec.ts/face-cube-{dock,compact}.png` and
  `cube-adsr-composite.spec.ts/cube-adsr-midilane.png`. Confirm those four are actually being
  compared (not masked) before treating cube as protected.

---

## 4 · WHAT COULD NOT BE DETERMINED — still open

1. **The faces-parity wall-time for a 29-cell face.** Extrapolated from pentemelodica's 28 cells
   being "the most expensive in the batch" **without a measured per-cell figure**. If the sweep is
   ~1.5 s/cell rather than ~1 s, this face alone is ~45 s. **Measure one existing face's parity row**,
   rather than extrapolating again.
2. **Whether a 2-D hero panel can show the solid legibly.** Route ② (2-D canvas, no attest churn)
   was recommended on cost grounds and **never prototyped**. The legacy card's picture is a real
   WebGL volume render (28 alpha-blended Z-slices, `CubeCard.svelte:643-653`); a 2-D reduction may or
   may not read. The one design decision here that wants a mockup.
3. **Whether `slice_y`'s degeneracy is worth a real DSP fix.** Marching the ray over the cube's
   actual entry/exit interval instead of a fixed `±√3/2` window would make Y live everywhere — and
   would move **every** cube ART baseline and the VRT scene. Scoped OUT deliberately; whether it
   earns its own PR is an owner call measurement cannot make.
4. **The audible threshold for the L/R asymmetry (§2.8 J).** 0.192 dB is below any figure I can
   cite; it was called a layout fact rather than a defect on that basis, **not verified against a
   reference.**
5. **Whether the owner wants `view_rot_z` implemented or deleted** — *settled since:* deleted
   (ledger item 5). Recorded because the ledger recommended the opposite and the measurement did not
   decide it.
6. **The `screen_on` × hero-panel interaction.** `screen_on` gates the card's rAF loop
   (`CubeCard.svelte:906-933`). If the hero panel is a second live surface, `screen_on` must gate it
   too or the perf win is lost — **never traced** whether `ModuleShell` mounts a panel when the
   module is off-screen.
