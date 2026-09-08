# FACE SPEC — `wavesculpt`

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **The `signal-flow` sidebar kind was DELETED** (#1468, removed with its twelve
>   adopters). `packages/web/src/lib/graph/types.ts:798` now reads "THERE IS NO
>   `signal-flow` KIND, and re-adding one is the mistake this note prevents."
>   **Any `signal-flow` sidebar block proposed below is VOID** — the surviving
>   kinds are the three in `FaceSidebar.svelte`.
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **The face built from this spec SHIPPED (#1454) and was then REVERTED (#1476)**
>   — "main is red, and it is a SHARD BUDGET collision, not a wavesculpt defect."
>   wavesculpt is NOT in `STRICT_FACES`; the design was not what failed.
> - The `xy` primitive gap this spec runs into is now DECLARED rather than silent
>   (`card-primitive-parity.test.ts:160`), and an `xy` cell kind was in flight at
>   the time of this sweep — check before assuming two independent dials.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


## 0. STATUS

**Authored 2026-08-09.** Every number below was measured or read against this
branch (`docs/face-spec-wavesculpt`, off `a7d06aa9`). **Nothing here is
implemented.** No def, card, DSP or test file is touched by this document.

**Verdict: PROMOTE — blocked on ONE platform prerequisite (a colour cell kind),
and gated on TWO owner decisions (the bentbox duplication, and ~83 s of CI).**
Full statement in §10.

### 0-A. ⚠ THE BRIEF'S COUNTS WERE WRONG, AND THE ERROR MATTERS

The task named **76 params, 26 inputs, 3 outputs**. The pinned contract says
otherwise:

```
$ grep "^wavesculpt " contract-lock.txt | awk '{print $2}' | sort | uniq -c
   1 family      26 in      1 meta      7 out      90 param
```

**90 params, 26 inputs, 7 outputs, 1 control family** — a 125-line contract-lock
block (`contract-lock.txt:3712-3836`). The batch-4 INDEX already had it right
(`face-specs-batch-4-INDEX.md:66` — "`wavesculpt` (90)").

This is not pedantry. **90 vs 76 changes the answer to the central question**,
because the binding constraint turns out to be a per-cell CI cost (§9) that
scales linearly with the param count, and the four "missing" outputs
(`out_red/grn/blu/alp`) are the per-voice taps that make §2-A a shipping defect
rather than a curiosity.

### 0-B. WHERE `wavesculpt` STANDS TODAY

| | |
|---|---|
| `STRICT_DOCS` | **yes** (`strict-docs.ts:296`) — so every doc claim below is gated prose, not a stale comment |
| `STRICT_FACES` | **no** — the def declares no `face`. This is the first one. |
| `RANGE_BOUND_CARDS` | **no** (10 entries, floor 9) — see §7-E |
| `card-control-overflow` | **EXEMPT**, `~282 px past the BOTTOM edge` (`card-control-overflow.spec.ts:101`); cap frozen at 6 |
| `per-module-per-port-behavioral` | **EXEMPT** — `'multi-voice cluster; non-voice1 ports target other voices not visible on L'` (`:406`) |
| VRT | has a scene (`vrt-scenes.ts:371`) with a `__wavesculptVrtFreeze` hook; **`linux/wavesculpt` is an exempt pair** (`vrt-exemptions.ts:1420`) plus **3 `darwin/wavesculpt-blink-*` quarantines** (`:1696-1700`) |
| WebGL attest | `rendersWebGL: true`; def is in `AUDIO_WEBGL_MODULE_DEFS`. Existing `docs`/`controlFamilies` are already wrapped in `docs-hash-ignore` (`wavesculpt.ts:884, 988`) |
| card | `WavesculptCard.svelte`, **3641 lines** — the largest in the repo |

### 0-C. HOW EVERYTHING WAS MEASURED

`distanceGain` and `eyeFromCamera` are **pure exported functions**
(`wavesculpt.ts:295, 326`). They were transcribed verbatim into an offline
harness and swept. **The transcription is negative-controlled against the
module's own test vectors** (`wavesculpt.test.ts:165-185`) — all four reproduce
exactly:

| assertion in `wavesculpt.test.ts` | harness |
|---|---|
| `distanceGain([0,0,0],[1,0,0],[0,0,0]) === 1` | **1** ✓ |
| `distanceGain([1,0,0],[-1,0,0],[2,0,0]) === 0` | **0** ✓ |
| in FRONT is `0 < g <= 1` | **0.500000** ✓ |
| falls off with distance (near > far) | **0.800000 > 0.216920** ✓ |

The shader figures in §2-B are the `BENTBOX_FS` fragment path
(`WavesculptCard.svelte:736-790`) transcribed the same way, evaluated at spawn
defaults (`chroma_phase 0`, `chroma_instability 0`, `wavefold 0`).

⚠ **What the harness is invariant to:** it computes the *gain scalar*, not
rendered audio. It cannot see worklet-side clipping, the ADSR, or the FX slot.
Every claim below is therefore about **the gain the factory writes**
(`wavesculpt.ts:1430-1433`, `envDist.gain = v.env * distG`) — which is exactly
the quantity in dispute, and which multiplies everything downstream including
the four per-voice taps.

---

## 1. WHAT WAVESCULPT IS — one sentence

> **WAVESCULPT is a room you stand inside: four wavetable voices are bolted to
> four walls and aimed at its centre, and ONE camera position is simultaneously
> the viewpoint and the mix desk — where you stand decides what you see and what
> you hear, off a single shared distance number.**

Everything else on the module is a conventional instrument bolted to that idea:
a 4-voice wavetable synth (48 params), a CRT video post-process (12 params), six
video walls (12 params), and a view switcher. **The camera is the only part that
is not available anywhere else in the rack**, and it is 5 params out of 90.

That sentence is also the test the face has to pass. If a player cannot see
*where they are standing* and *what that is doing to the four voices*, the face
has not described this module — it has described a 90-knob mixer.

---

## 2. MEASURE BEFORE YOU DESIGN — the defects

### A. ⚠ THE BLUE OSCILLATOR IS MUTED AT SPAWN. EXACTLY ZERO.

`distanceGain` (`:295-313`) multiplies a `1/(1+d²)` falloff by a **directional**
term, `max(0, dot(emission_vector, direction_to_camera))`. BLUE sits on the
`+Z` wall at `[0, 0, 1]` aiming at `[0, 0, -1]` (`WALL_LAYOUT`, `:185`). At spawn
the eye is at `[0, 0, 2.5]` — **directly behind BLUE**, so the dot is exactly
`-1`, the clamp takes it to `0`, and the gain is `0`.

*Measured, spawn defaults (`pos 0,0,0 · zoom 1 · rot 0`):*

| voice | wall | distGain | dB |
|---|---|---|---|
| RED | +X | 5.3229e-2 | −25.48 |
| GREEN | −X | 4.8029e-2 | −26.37 |
| **BLUE** | **+Z** | **0.0000e+0** | **−inf** |
| ALPHA | −Z | 7.0273e-2 | −23.06 |

Not "small". **Zero.** `envDist.gain` is set to `v.env * distG`
(`:1431-1433`), so gating BLUE produces silence, and because the per-voice tap
`out_blu` is `oscChains[2].panner` (`:1729`) — *downstream* of `envDist` —
**`out_blu` emits digital zero too**, regardless of `gate3`, `pitch_cv3`, the
BLUE ADSR, its wavetable, or its FX slot. One of the module's four voices and
one of its seven outputs are dead on arrival.

**It is not a knife-edge.** Sweeping `rot` alone at default position and zoom,
BLUE is zero across **|rot| < 0.370** — **74 % of the ROT knob's travel**:

```
        rot →   -1   -0.75   -0.5   -0.25     0    0.25    0.5   0.75      1
  zoom 0.3   1.1e-2  9.1e-3 1.7e-3      0     0       0  1.7e-3 9.1e-3 1.1e-2
  zoom 0.5   2.7e-2  2.3e-2 7.3e-3      0     0       0  7.3e-3 2.3e-2 2.7e-2
  zoom 1     7.5e-2  7.2e-2 4.5e-2      0     0       0  4.5e-2 7.2e-2 7.5e-2
  zoom 2     1.6e-1  1.7e-1 1.8e-1 7.3e-2     0  7.3e-2 1.8e-1 1.7e-1 1.6e-1
  zoom 3     2.3e-1  2.4e-1 2.9e-1 3.8e-1 9.7e-1  3.8e-1 2.9e-1 2.4e-1 2.3e-1
```

Over a 40 131-point grid spanning the **entire** reachable camera space
(`pos_x/y/z` × `zoom` × `rot` at their declared ranges):

| voice | silent in | mean gain | max gain |
|---|---|---|---|
| RED | 18.1 % | 7.053e-2 | −2.83 dB |
| GREEN | 25.9 % | 6.739e-2 | −1.00 dB |
| **BLUE** | **28.4 %** | 6.795e-2 | −0.03 dB |
| ALPHA | 29.4 % | 6.607e-2 | −1.00 dB |

So a directional emitter that can be behind you is **the intended design** — all
four voices go silent somewhere, and BLUE is not even the worst. **The defect is
that the shipped DEFAULT sits on one of those zeros**, with nothing in the UI
saying so.

**And the committed VRT baseline sits on it too.** The scene sets
`rot 0.3, pos_z 0.35, zoom 1.3` (`vrt-scenes.ts:380`) → eye `[1.5558, 0, 1.6554]`
→ BLUE `0.0000e+0`. The regression lock for this module pins a frame with a dead
voice in it.

**Why no gate caught it.** `wavesculpt.test.ts:137-162` is the one test that
looks at this. It asserts zoom-max is no quieter than zoom-min **for every
wall** — and it passes for BLUE with an enormous margin:

| | gClose (zoom 3) | gFar (zoom 0.3) | outcome |
|---|---|---|---|
| RED | 2.332e-1 | 2.310e-3 | asserted, passes |
| GREEN | 2.723e-1 | 1.855e-3 | asserted, passes |
| **BLUE** | **9.730e-1** | **0.000e+0** | **asserted, passes (0.973 ≥ 0)** |
| ALPHA | 2.127e-1 | 1.038e-2 | asserted, passes |

At `zoom 3` BLUE is the **loudest** voice on the module. **The test never samples
the default zoom of 1.0**, where it is zero. The `if (gClose < 1e-6 && gFar <
1e-6) continue` guard at `:156` — with a comment rationalising a zero as
"degenerate" — never even fires here. This is the CLAUDE.md blind-gate pattern
exactly: not a wrong assertion, a **wrongly chosen sample set**. Every assertion
it makes is true.

⚠ **CLASSIFICATION: this is a LAYOUT FACT that has become a DEFECT through its
default.** The geometry is deliberate and documented (`WALL_LAYOUT`,
`:150-178` — "all four vectors point at the origin so the wave cones cross at
the centre of the room"). The bug is that the default camera stands where one
cone cannot reach. **Three candidate fixes, and only the third is a face
change:**

1. move the default eye off the `±Z` axis (**def change** — a params default
   edit, contract-lock diff, and it moves every saved patch's spawn sound);
2. floor the directional term (e.g. `0.05 + 0.95·max(0,dot)`) (**DSP/behaviour
   change** — re-pin ART, owner ears);
3. **make it VISIBLE** — a hero that draws the room, the four cones and the
   camera, and a readout that says `3 of 4 voices live`.

**This spec takes (3) and only (3).** ⚠ **Do not fold (1) or (2) into the face
wave.** They are named and scoped in §8-A.

### B. `master_gain`'s VIDEO HALF IS A ~1 % EFFECT, AND AT ZERO IT IS A NO-OP

`docs.controls.master_gain` (`wavesculpt.ts:959`, **in `STRICT_DOCS`**) claims:

> "…AND the composite drive of the CRT post-process on the render. One knob,
> both domains: 1 = unity … above 1 the mix gets louder while the picture
> **overdrives into wavefold/soft-clip white smear**, **0 mutes L/R and blacks
> the composite**."

The audio half is true (`busL/busR.gain` = `master_gain`, `:1068, :1756`). The
video half is not. The shader blends the composite back into luma with weight
`uWavefold * 0.7 + uMasterGain * 0.1` (`WavesculptCard.svelte:758`) — so at
`wavefold 0` the *entire* master-gain path is a **0.1 × gain** blend, and at
`gain 0` the weight is **0**, i.e. the original luma passes through untouched.

*Measured, output luma through the full colour path:*

| swatch | g=0.00 | g=0.50 | g=1.00 | g=1.50 | g=2.00 |
|---|---|---|---|---|---|
| white | 1.0000 | 0.9733 | 0.9778 | 0.9893 | 0.9968 |
| mid grey | 0.5000 | 0.4873 | 0.4966 | 0.5217 | 0.5556 |
| red ribbon | 0.4393 | 0.4194 | 0.4283 | 0.4469 | 0.4633 |
| grn ribbon | 0.6810 | 0.6718 | 0.6796 | 0.6896 | 0.7030 |
| blu ribbon | 0.4971 | 0.4867 | 0.4952 | 0.5162 | 0.5462 |

Three findings in one table:

1. **`g = 0` does not black anything.** Output luma equals input luma to
   `-1.11e-16` (white) and `-5.55e-17` (mid grey) — bit-identical for greys, and
   `~1e-4` for saturated colours (the I/Q round-trip). "Blacks the composite" is
   **false at every swatch**.
2. **`g = 2` is not a white smear.** Mid grey moves 0.4966 → 0.5556, **+11.9 %**.
   Full travel `0 → 2` moves it 0.5000 → 0.5556.
3. **The sense INVERTS over the first half.** Mid grey goes 0.5000 (g=0) →
   **0.4873** (g=0.5) → 0.4966 (g=1.0). Turning the gain **up** from zero makes
   the picture **darker** for the first half of the knob before it recovers.

⚠ **THIS IS NOT A WAVESCULPT BUG — IT IS INHERITED FROM `bentbox`.** The blend
line is **character-identical** in both:

```
bentbox.ts:343      yiq.x = mix(yiq.x, comp - (iq.x + iq.y) * 0.5, uWavefold * 0.7 + uMasterGain * 0.1);
WavesculptCard:758  yiq.x = mix(yiq.x, comp - (iq.x + iq.y) * 0.5, uWavefold * 0.7 + uMasterGain * 0.1);
```

`bentbox`'s own doc is milder but still over-claims ("higher overdrives into
white smear", `bentbox.ts:532`). **Wavesculpt's doc adds the specifically false
"0 … blacks the composite".** A shader fix touches two modules and is a video
behaviour change: **its own PR** (§8-B). The **doc** fix is wavesculpt-local and
cheap.

### C. THE CRT BLOCK IS A VERBATIM DUPLICATE OF `bentbox` — 12 OF 90 PARAMS

Every CRT param wavesculpt declares is **identical in id, range, curve and
default** to one `bentbox` already ships:

```
bentbox param bloom 0..1 linear default=0.4          wavesculpt param bloom 0..1 linear default=0.4
bentbox param chroma_instability 0..1 linear d=0     wavesculpt param chroma_instability 0..1 linear d=0
bentbox param chroma_phase -1..1 linear d=0          wavesculpt param chroma_phase -1..1 linear d=0
bentbox param feedback_delay 0..1 linear d=0         wavesculpt param feedback_delay 0..1 linear d=0
bentbox param feedback_gain 0..1 linear d=0          wavesculpt param feedback_gain 0..1 linear d=0
bentbox param hsync_drift 0..1 linear d=0            wavesculpt param hsync_drift 0..1 linear d=0
bentbox param hsync_loss 0..1 linear d=0             wavesculpt param hsync_loss 0..1 linear d=0
bentbox param master_gain 0..2 linear d=1            wavesculpt param master_gain 0..2 linear d=1
bentbox param noise 0..1 linear default=0.05         wavesculpt param noise 0..1 linear default=0.05
bentbox param scan_wobble 0..1 linear d=0            wavesculpt param scan_wobble 0..1 linear d=0
bentbox param vsync_drift 0..1 linear d=0            wavesculpt param vsync_drift 0..1 linear d=0
bentbox param wavefold 0..1 linear d=0               wavesculpt param wavefold 0..1 linear d=0
```

12 of 12 match; `bentbox` additionally has `mirrorX/Y` + their gates. The shader
is the same shader. **And wavesculpt already has `video_out`**, so
`wavesculpt.video_out → bentbox` is patchable today with no new work.

**This is the strongest CUT evidence in the ledger** — measurably duplicated,
with a live, already-reachable alternative — and it is **13.3 % of the param
count** the whole editorial problem is about. It is a **def** change, so it is
scoped separately (§8-C), but the owner should decide it *before* the face is
built, because it is the difference between a 91-cell face and a 79-cell one.

### D. `scale` IS DEAD IN THE DEFAULT RENDER MODE

`uScale[]` is read only by the SCOPE program (`WavesculptCard.svelte:943`), and
`drawScopes()` is called only when `blinkMode > 0` (`:2232`). `blink_mode`
defaults to **0**. So the SCALE knob — a prominent always-visible control in the
card's right rail (`:3161`) — **does nothing at spawn**, and nothing says so.
The doc is honest ("Applies in SCOPES TRIAL + REALITY BASED COMMUNITY",
`wavesculpt.ts:940`); the **card** is not.

⚠ **LAYOUT FACT, not a defect.** Fix in the face: the band that holds `scale`
also holds `blink_mode`, and its label says which modes it applies to.

### E. `alpha_brightness` IS INERT UNLESS `alpha_in` IS PATCHED

`uAlphaBrightness` is used inside exactly one branch:

```glsl
if (uHasAlphaIn > 0.5 && alphaMaskStrength > 0.001) {          // :785
  vec3 alphaInSample = clamp(texture(uAlphaInTex, vUv).rgb * uAlphaBrightness, 0.0, 1.0);
```

With `alpha_in` unpatched, `uHasAlphaIn` is 0 and the knob is a **complete
no-op** — a permanently visible control that is dead on a freshly spawned module
until a video cable arrives. Same class as §D. **Layout fact; fix in the face**
by banding it with the alpha/wall inputs so its precondition is legible.

### F. `tune2/3/4` ARE OVERRIDDEN IN CHORD MODE

`:1469-1478`: when `chord_mode` is on, every voice's tune is written as
`live.tune1 + CHORD_INTERVALS_SEMITONES[quality][i]`, and the doc confirms
"voices 2-4 ignore their own tune knobs while chord mode is on"
(`:1472-1474`, `docs.controls.chord_mode`). So **three params change meaning
with a toggle**: performance controls in one mode, ignored in the other.

⚠ **DESIGNED, DOCUMENTED, and correctly restored on exit** (`:797`, "restored
from `node.params` when chord mode flips off"). **Layout fact.** The face must
put `chord_mode`/`chord_quality` in the same band as the voice tuning, or a
player will turn TUNE 3 and hear nothing move.

### G. THE FOUR VOICES ARE NOT AT EQUAL LEVEL — AND THE SPREAD IS GEOMETRY

At spawn, across the three **live** voices: **3.31 dB**. Including BLUE it is
unbounded. This is pure wall geometry (different heights, different distances)
and is not a bug — but it means "all four voices at identical settings" never
produces four equal levels, and no readout says so.

### H. EVERY PARAM HAS A PLAY-TIME READER — and the first scan said otherwise

A literal-string reader scan over def + card-script + worklet reported **20
params with no reader anywhere**: `fxType1-4`, `fxAmount1-4`, and all 12
`wall{N}_alpha/_distort`.

**All 20 are false positives.** They are read through **template literals** the
literal scan is structurally blind to:

```
wavesculpt.ts:1458   const fxType = Math.round(live[`fxType${i + 1}`] ?? 0);
WavesculptCard:182   function wallAlpha(n) { return pget(`wall${n}_alpha`); }
```

Recording it because it is the §"VALIDATE THE INSTRUMENT" rule in miniature: a
scan invariant to string interpolation returns a confident, plausible, false
"20 dead params". **Corrected result: 0 of 90 params lack a reader** — which is
genuinely unusual for a module this size and is a point in its favour.

⚠ **Separately, the WORKLET declares 8 AudioParams it never reads.**
`wavesculpt-engine.ts:91, 96` declare `env{1..4}` and `distGain{1..4}`, and
`process()` reads neither — the JS factory applies env/dist on the graph instead
(`:271-272`, "the JS factory applies env+dist+pan+FX-slot AFTER this point").
Harmless (they are not module params and are not in contract-lock) but they are
8 dead descriptors and a misleading comment at `:11-13`. Cleanup, not a defect.

---

## 3. THE PARITY LEDGER — all 90 params + every DOM-only control

### 3-A. ⚠ FIRST, THE CONSTRAINT THAT DECIDES THIS WHOLE SECTION

```
faces-parity.spec.ts:873-882
  const domIds = dockShell.locator('[data-testid^="control-"]') …
  const defIds = spec.params.map((p) => p.id);
  expect([...domIds].sort()).toEqual([...defIds].sort());
```

**EXACT id-multiset equality between the dock's rendered controls and EVERY def
param.** Consequences, and they are absolute:

- **`CUT` is impossible at the face layer.** A param can only leave the face by
  leaving the **def** — a contract change, a `docs:accept`, and a separate PR.
  Every `CUT` below therefore reads **"CUT — RECOMMENDED, blocked on a def PR"**.
- **`MERGE` is likewise a def change** where it means "two params become one".
- **The dock must render all 90 simultaneously.** A mode-switched face that
  *hides* cells fails this assertion. See §4.
- **A `panel` cannot back a param** (`shell-cells.ts:198-203`: a panel must never
  emit `control-<paramId>`), so a drill-down cannot absorb params either.

So `RELOCATE` — which band / which tier — is the **only lever a face-only PR
actually has**, and the ledger is honest about that.

### 3-B. THE LEDGER

Rows are grouped where the group is genuinely homogeneous (`tune1..4` are one
decision, not four). **The `n` column reconciles to 90** — see §3-C.

#### Per-oscillator — 48 params (12 × 4 voices)

| control | n | verdict | where it goes / why |
|---|---|---|---|
| `tune{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N. ⚠ inert for N≥2 in chord mode (§2-F) — banded with `chord_mode` so that is legible |
| `fine{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N, clustered `pitch` with `tune` |
| `morph{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N. The per-voice timbre control and the only per-osc param with its own CV jack |
| `spread{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N. Verified real — `spreadTaps` carries its own measured notes (`wavetable-osc.ts:150-162`) |
| `fold{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N |
| `A/D/S/R{1..4}` | 16 | **KEEP** · RELOCATE | VOICE tab N, in a `clusters` sub-group `envelope` — 4 cells labelled once, ~14 px, vs ~81 px for a page |
| `thickness{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N, cluster `look`. Visual-only; grouping it with the colour says so |
| `fxType{1..4}` | 4 | **REDESIGN** (blocked) | VOICE tab N. Card uses a cycle-button; the face derives `segmented` only from a `ParamDef.options` roster, which this param lacks → it renders as a **detented knob over 0..2**. Adding `options` is a **contract change** (§8-D). Ship the knob or ship the def PR — do not pretend |
| `fxAmount{1..4}` | 4 | **KEEP** · RELOCATE | VOICE tab N, beside its type |

#### Camera — 5 params

| control | n | verdict | where it goes / why |
|---|---|---|---|
| `zoom` | 1 | **KEEP** · **LANE rank 1** | **41.3 dB** of total-gain swing (§5-A) — the largest single control on the module, and one of two that can resurrect BLUE |
| `pos_z` | 1 | **KEEP** · **LANE rank 2** | **27.6 dB** — measured second, and the card buries it in a small "Height" knob between two joysticks (§5-A) |
| `rot` | 1 | **KEEP** · **LANE rank 3** | only 3.2 dB of level, but it is the **voice selector**: 74 % of its travel mutes BLUE (§2-A) |
| `pos_x` | 1 | **KEEP** · **LANE rank 4** | 4.6 dB; drops the audible-voice count to 2 |
| `pos_y` | 1 | **KEEP** · **LANE rank 5** | 5.7 dB; the only camera axis that never changes the audible-voice count |
| — | | **REDESIGN** (all 5) | The card's **two XY pads** have no face primitive (§4-C). The 5 axes render as 5 knobs; **the spatial picture is restored by the `wavesculpt-room-{n}` hero panel**, which is draggable and *is* the pad |

#### Ensemble — 5 params

| control | n | verdict | where it goes / why |
|---|---|---|---|
| `master_gain` | 1 | **KEEP** · **LANE rank 6** | The output trim and the only mute. ⚠ its **video** half is a ~1 % effect and a no-op at 0 (§2-B) — the doc must stop claiming otherwise |
| `unison` | 1 | **KEEP** · RELOCATE | ENSEMBLE tab. Renders as a `toggle` (derived from its 0/1 shape) |
| `detune` | 1 | **KEEP** · RELOCATE | ENSEMBLE tab, beside `unison` — it is meaningless without it |
| `chord_mode` | 1 | **KEEP** · RELOCATE | ENSEMBLE tab |
| `chord_quality` | 1 | **MERGE** — RECOMMENDED, blocked | Two discrete params encoding one 3-state choice (OFF / MAJ / MIN). The card already renders them as one toggle + one radiogroup (`:3179-3206`). Merging = deleting a param = **def PR** (§8-D). **Face-only fallback: a `clusters` sub-group `chord`** — same visual grouping, zero contract cost |

#### View + colour — 9 params

| control | n | verdict | where it goes / why |
|---|---|---|---|
| `video_mode` | 1 | **KEEP** · RELOCATE · REDESIGN (blocked) | VIEW tab. 3-state (PROXIMITY/BIRDSEYE/SPECTROGRAPH); same missing-`options` problem as `fxType` |
| `blink_mode` | 1 | **KEEP** · RELOCATE · REDESIGN (blocked) | VIEW tab, same |
| `scale` | 1 | **KEEP** · RELOCATE | VIEW tab, **banded with `blink_mode`** — because it is dead at `blink_mode 0` (§2-D) and the band label is what makes that legible |
| `wiggle` | 1 | **KEEP** · RELOCATE | VIEW tab. Verified live in **all** blink modes (`:2130-2184` drives the ribbon program too), so the doc is right |
| `alpha_brightness` | 1 | **KEEP** · RELOCATE | VIEW tab, **banded with the alpha/wall block** — inert unless `alpha_in` is patched (§2-E) |
| `lum_depth` | 1 | **KEEP** · RELOCATE | WALLS tab — it is the wall→audio coupling, not a view setting |
| `red_color` | 1 | ⚠ **BLOCKED — no primitive** | VOICE 1 tab. See §4-C: a packed `0xRRGGBB` over `0..16777215` has **no face cell kind**; it would render as a knob sweeping 16.7 M and `faces-parity` would pass it |
| `grn_color` | 1 | ⚠ **BLOCKED — no primitive** | VOICE 2 tab, same |
| `blu_color` | 1 | ⚠ **BLOCKED — no primitive** | VOICE 3 tab, same |

#### CRT post-process — 12 params

| control | n | verdict | where it goes / why |
|---|---|---|---|
| `hsync_drift`, `hsync_loss`, `vsync_drift`, `scan_wobble`, `chroma_phase`, `chroma_instability`, `feedback_gain`, `feedback_delay`, `wavefold`, `bloom`, `noise` | 11 | **CUT** — RECOMMENDED, blocked on a def PR · else KEEP + RELOCATE | **Byte-identical to `bentbox` (§2-C)**, whose shader is the same file's worth of code, and `wavesculpt.video_out → bentbox` already works. Until that PR: CRT tab |
| (`master_gain` counted above under Ensemble) | 0 | — | It is also a bentbox duplicate, but unlike the other 11 it drives the **audio** bus too, so it **cannot** be cut |

#### Video walls — 12 params

| control | n | verdict | where it goes / why |
|---|---|---|---|
| `wall{1..6}_alpha` | 6 | **KEEP** · RELOCATE | WALLS tab, clustered per face with its distort |
| `wall{1..6}_distort` | 6 | **KEEP** · RELOCATE | WALLS tab |

#### DOM-only controls the card hand-builds (NOT params)

| control | card site | verdict | why |
|---|---|---|---|
| `wavesculpt-osc-{n}` — the per-voice wavetable strip (colour swatch + preset `<select>` + factory `<select>` + LOAD `.wav`) | `:2943-3017` | **KEEP** as the declared `controlFamily` | Already declared (`:986`) and doc'd (`:961`). Renders as **one** `family` cell — `faces-parity:885-888` asserts exactly `controlFamilies.length` of them. Put it at the head of each VOICE tab |
| upload status / error text | `:3012-3017` | **KEEP** — inside the family cell | Not a control; it is the family's own feedback |
| `wavesculpt-blink-mode-name` readout | `:3156` | **MERGE** into the `blink_mode` cell | A conditional text label duplicating the cell's own value |
| VIEW cycle button | `:3132-3139` | **REDESIGN** → the `video_mode` cell | The button *is* the param; the face renders the param |
| BLINK cycle button | `:3147-3154` | **REDESIGN** → the `blink_mode` cell | same |
| UNISON / CHORD toggles, MAJ/MIN radiogroup | `:3171-3206` | **REDESIGN** → their param cells | same |
| per-osc FX cycle button | `:3055-3061` | **REDESIGN** → the `fxType{N}` cell | same |
| camera XY pad · zoom/rot XY pad | `:3074-3108` | **REDESIGN** → `wavesculpt-room-{n}` hero panel | §4-C |
| `wavesculpt-resize-handle` | `:3268-3274` | **CUT** | The shell owns tier geometry; a lane tile is a fixed 192×180 and the dock pane is `min(60vh, 680px)`. Nothing to resize. ⚠ This is also what the `~282 px` overflow exemption is about (§7-F) |
| `ModuleTitle` | `:2936` | **RELOCATE** → shell chrome | The shell renders the title bar |

### 3-C. RECONCILIATION AND VERDICT TOTALS

`48 (per-osc) + 5 (camera) + 5 (ensemble) + 9 (view+colour) + 11 (CRT) + 12
(walls) = 90` ✓ — matches `contract-lock`'s 90 exactly.

| verdict | params | note |
|---|---|---|
| **KEEP** (rendered, relocated to a band) | **76** | of which 6 are LANE ranks 1-6 and 70 are dock-only |
| **REDESIGN** — deliverable in the face PR | **5** | the camera axes: 2 XY pads → 5 knobs + the room panel |
| **REDESIGN** — blocked on a def PR (`options`) | **6** | `fxType{1..4}`, `video_mode`, `blink_mode` |
| **MERGE** — recommended, blocked on a def PR | **1** | `chord_quality` into `chord_mode`; face-only fallback = a cluster |
| **CUT** — recommended, blocked on a def PR | **11** | the bentbox CRT duplicate (§2-C) |
| ⚠ **BLOCKED — no primitive exists** | **3** | `red_color`, `grn_color`, `blu_color` (§4-C) |
| **CUT** outright | **0 params** | (2 DOM-only: the resize handle; the title) |

**Nothing vanishes.** Every one of the 90 renders in the dock on day one — the
platform makes that mandatory, not optional. The 11 CUTs and 1 MERGE are
*recommendations to shrink the def*, each with its measurement, each scoped to
its own PR.

---

## 4. THE PARADIGM DECISION

### 4-A. THE DECISION

> **A 9-band TABBED dock face, with a bespoke ROOM-PLAN hero panel, over a lane
> tile that is a DIFFERENT INSTRUMENT: the camera and nothing else.**

### 4-B. WHY — and the part that surprised me

**Tabbing is not a choice on this module. It is derived.** `dockTabPlan()`
engages the rail at `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:57`). Any
honest banding of 90 params exceeds that, so the only real question is *how many
bands*, not *tabs or not*.

**And the documented cost of tabbing does not apply here.** The brief flags that
a tabbed face never row-packs (`dock-row-plan.ts`, `DOCK_ROW_MAX_CONTROLS = 10`).
That is a real cost — for a face that would otherwise have fit. Run the
arithmetic for this one:

- 90 cells, packed **perfectly** at the 10-cell row cap = **9 rows minimum**.
- At the measured `DOCK_BAND_PX = 90` pitch that is **≈810 px**.
- The dock pane ceiling is `min(60vh, 680px)` and chrome costs ~130 px, so the
  tallest content region ever available is **≈550 px**.

**810 > 550 at every window size.** Wavesculpt cannot be read as one scrolling
column *even with packing working perfectly in its favour*. So **the packing
sacrifice costs this face nothing it could have had** — the single strongest
argument for the tabbed paradigm here, and the one that would not hold for a
smaller module.

**The 9 bands**, each a genuinely different idea:

| # | band | cells | why it is its own band |
|---|---|---|---|
| 1 | `room` | 5 | the camera — §1's whole sentence |
| 2 | `red` | 13 | voice 1 + its colour + its wavetable family |
| 3 | `green` | 13 | voice 2 |
| 4 | `blue` | 13 | voice 3 |
| 5 | `alpha` | 12 | voice 4 (no colour param — it is the mask layer) |
| 6 | `ensemble` | 5 | how the four combine: unison/detune/chord + master |
| 7 | `view` | 5 | what the render shows |
| 8 | `walls` | 13 | the six video faces + `lum_depth` |
| 9 | `crt` | 11 | the post-process (the band that should not exist — §2-C) |

`5+13+13+13+12+5+5+13+11 = 90` ✓, plus 1 family cell = **91 cells**.

Four voice tabs is **precedented, not novel**: DX7 ships `GLOBAL + OP1-6`.

### 4-C. ⚠ TWO PLATFORM GAPS THE DECISION RUNS INTO

**1. There is no XY-PAD primitive.** The card's defining affordance is two
joysticks (`:3074-3108`). The face renders params as knobs; `paramCells`
supports only `'grid'`. So the five camera axes become five knobs — **a real
regression in feel** against the card, and unavoidable at the cell layer.

**The hero panel is the answer, and it is a genuine one.** A `panel` cell is
explicitly "a picture you **edit**" (`shell-cells.ts:194`) with a `drag` probe
(`:219`). So `wavesculpt-room-{n}` is not a diagram beside the knobs — **it is
the joystick**, restored, and it can show what neither pad ever could: the four
cones and which of them currently reach you.

**2. ⚠ THREE PARAMS HAVE NO VIABLE PRIMITIVE — AND THE GATE CANNOT SEE IT.**
`red_color` / `grn_color` / `blu_color` are packed `0xRRGGBB` integers over
`0..16777215` (`:841-843`). The five cell kinds are `selector · action · file ·
toggle · panel` (`shell-cells.ts:265-270`) — **no colour cell**. A `panel`
cannot back them (rule 1: no `control-<paramId>` inside a panel). So they render
as **knobs sweeping 16.7 million**, and:

> **`faces-parity` would pass.** It drags the knob and asserts the param moved —
> which it does. A green gate certifying three unusable controls: precisely the
> "green gate certifying a live bug" class CLAUDE.md warns about.

**This is the ONE hard prerequisite for the face** (§8-E): a `ShellColorCell`
kind, ~40 lines, wrapping the `<input type="color">` the card already has at
`:2961-2967`. It is a platform addition, generic, and the second adopter is
already visible (the CHROMA/LUMA keyer cards use the same pattern).

### 4-D. WHAT I REJECTED, AND WHY

**1. A MODE-SWITCHED face** (the face changes with `video_mode` / `blink_mode`).
**Rejected — structurally impossible.** `faces-parity:873-882` demands all 90
`control-*` cells present *simultaneously*. A face that hides cells per mode
fails the multiset assertion outright. Not a preference; a hard block.

**2. HERO + DRILL-DOWN** (6 lane controls, the other 84 behind one panel).
**Rejected — same wall, different brick.** A panel must never emit
`control-<paramId>` (`shell-cells.ts:198`), so the 84 cannot live inside one.
They would have to exist as cells *anyway*, and the panel would be decoration
over a face that already renders everything.

**3. UNTABBED SCROLLING COLUMN.** **Rejected by arithmetic** — 810 px of packed
rows into a 550 px ceiling (§4-B), and ≥7 bands auto-tabs regardless.

**4. FEWER, FATTER BANDS** (e.g. one `voices` band of 51). **Rejected** — it
would drop the count below the tab threshold and hand the face back to the
scrolling column that cannot fit. A 51-cell band is 6 rows on its own.

**5. SPLIT WAVESCULPT INTO TWO MODULES.** The owner invited this, so it gets a
real answer: **no — but a third of the way there is right.**

*The case for:* the CRT block (11) + walls (12) + colours (3) look like a
self-contained video processor, and §2-C proves 12 params are literally
`bentbox`.

*The case against, and it wins:* **the coupling is the module.** `lum_depth`
samples wall luminosity on the main thread and pushes it into the worklet's
per-line band-pass (`wavesculpt.ts:122-146`, `LUMA_REGISTRY` → `lumA{N}/lumB{N}`)
— a cross-domain path with **no cable type that could carry it** between two
modules. `master_gain` drives both domains from one knob. And splitting is a
contract change that breaks every saved patch. §1's sentence is a description of
a *coupling*; a split deletes the thing being described.

*What IS right:* **delete the 11-param CRT duplicate and let players patch
`video_out → bentbox`** (§8-C). That is not a split — it is removing an inlined
copy of a module that already exists. It takes the face from 91 cells to 80,
which is the single largest lever on §9's CI cost.

---

## 5. THE VISUAL SPEC

### 5-A. THE LANE SIX, RANKED ON MEASUREMENT

The card's layout and the measurement **disagree**, which is the finding that
set this ranking. Sweeping each camera axis across its full declared range with
the other four at default:

| axis | total-gain swing | audible-voice count | card gives it |
|---|---|---|---|
| `zoom` | **41.3 dB** | 3..4 | half of a joystick |
| `pos_z` | **27.6 dB** | 3..4 | **a small "Height" knob** |
| `pos_y` | 5.7 dB | 3..3 | half of a joystick |
| `pos_x` | 4.6 dB | 2..3 | half of a joystick |
| `rot` | 3.2 dB | 2..3 | half of a joystick |

**The card gives its two biggest joystick axes to `pos_x` (4.6 dB) and `rot`
(3.2 dB) — the two least consequential controls on the camera — while `pos_z`,
the second most consequential at 27.6 dB, is a small knob wedged between them.**

⚠ **THE TWO METRICS DISAGREE, AND BOTH ARE TRUE.** Total gain is **invariant to
which voice produces it** — so it ranks `rot` last (3.2 dB) even though `rot` is
the control that mutes BLUE across 74 % of its travel. Ranking on total gain
alone would have buried the §2-A finding. **`rot` is therefore ranked 3 on the
second metric, not the first**, and the face states which:

| rank | control | ranked on |
|---|---|---|
| 1 | `zoom` | 41.3 dB — the biggest move on the module, and it reaches all 4 voices |
| 2 | `pos_z` | 27.6 dB — measured second, and the card's most under-weighted control |
| 3 | `rot` | **not level — voice count.** 74 % of its travel mutes BLUE (§2-A) |
| 4 | `pos_x` | 4.6 dB, and it can drop the audible count to 2 |
| 5 | `pos_y` | 5.7 dB, but the only axis that never changes the audible count |
| 6 | `master_gain` | the output trim and the only mute |

**LOSERS, with the reason each lost:**
- **`video_mode` loses rank 6 to `master_gain`.** VIEW is the biggest *visible*
  change on the module and it was my first pick. It lost because a mode switch
  is a decision made once, while an output trim is the one control that must
  never be more than one gesture away — and because the lane tile's glyph
  already shows *which* view is running.
- **`pos_y` beat `video_mode` too**, on the argument that splitting the camera
  across the lane/dock boundary puts half a joystick in a drawer. The five axes
  are one control surface; the face keeps them together.
- **Nothing from a voice tab reaches the lane.** With four symmetric voices,
  promoting `morph1` promotes an arbitrary quarter of the module. The lane tile
  answers "where am I standing", which is the only question with one answer.

### 5-B. LANE — `compact` tier (192×180, 2 cells + glyph)

`faceTierCap('compact', hasGlyph=true)` = **2**.

```
┌────────────────────────────────┐  192 × 180
│ WAVESCULPT                     │
│ ┌────────────────────────────┐ │
│ │                            │ │
│ │      [ glyph: scope ]      │ │  live trace off the summed L/R bus
│ │                            │ │
│ └────────────────────────────┘ │
│   ╭─────╮        ╭─────╮       │
│   │ ZOOM│        │HEIGHT       │  ranks 1-2
│   ╰─────╯        ╰─────╯       │
│    41 dB           28 dB       │
└────────────────────────────────┘
```

⚠ **`glyph: 'scope'` is safe here, and the reason is not obvious.** A scope
glyph on a frozen-graph VRT capture reads zeros for a silent module — the
ordinary case. Wavesculpt is silent unpatched (all four voices need gates), so
the compact capture is a flat trace, which is stable. **It is `blink_mode`/the
3D render that is unstable**, and the glyph does not draw that.

### 5-C. LANE — `full` tier (192×180, 3×2 plate = 6 cells)

`faceTierCap('full', …)` = **6** — the whole camera plus the trim.

```
┌────────────────────────────────┐  192 × 180
│ WAVESCULPT                     │
│ ┌──────┬──────┬──────┐         │
│ │ ZOOM │HEIGHT│ ROT  │         │  1 · 2 · 3
│ │ ╭──╮ │ ╭──╮ │ ╭──╮ │         │
│ │ ╰──╯ │ ╰──╯ │ ╰──╯ │         │
│ ├──────┼──────┼──────┤         │
│ │ POS X│ POS Y│ GAIN │         │  4 · 5 · 6
│ │ ╭──╮ │ ╭──╮ │ ╭──╮ │         │
│ │ ╰──╯ │ ╰──╯ │ ╰──╯ │         │
│ └──────┴──────┴──────┘         │
└────────────────────────────────┘
        (glyph drops — ranked cells outrank it at 'full')
```

**The lane tile is deliberately a different instrument from the dock.** It is a
camera controller. That is the two-tier split the brief lists as an option, and
here it is not a compromise — it is §1's sentence rendered at 192 px.

### 5-D. DOCK — the tabbed faceplate

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  WAVESCULPT                                                            [x]   │
│  Room                                                                        │
│  four voices bolted to four walls; one camera is the viewpoint AND the mix    │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌─── HERO ─────────────────────────────────┐ ┌──── SIDEBAR ────────────────┐ │
│ │  ╔════════════════════════════════════╗  │ │ signal flow                 │ │
│ │  ║   wavesculpt-room-{n}   (panel)    ║  │ │  ┌───────────────┐          │ │
│ │  ║                                    ║  │ │  │ WAVETABLE ×4  │ gen      │ │
│ │  ║        ·GRN                        ║  │ │  └───────┬───────┘          │ │
│ │  ║      ╲     ╱                       ║  │ │  ┌───────┴───────┐          │ │
│ │  ║        ╲ ╱          ·BLU  ✕ dark   ║  │ │  │ LUMA BANDPASS │ bus      │ │
│ │  ║         ◇  ← camera                ║  │ │  └───────┬───────┘  ⇠ walls │ │
│ │  ║        ╱ ╲                         ║  │ │  ┌───────┴───────┐          │ │
│ │  ║      ╱     ╲                       ║  │ │  │ ADSR × 4      │ bus      │ │
│ │  ║   ·RED      ·ALP                   ║  │ │  └───────┬───────┘          │ │
│ │  ║                                    ║  │ │  ┌───────┴───────┐          │ │
│ │  ║  drag ◇ = pos_x/pos_y · wheel=zoom ║  │ │  │ FX SLOT × 4   │ bus      │ │
│ │  ╚════════════════════════════════════╝  │ │  └───────┬───────┘          │ │
│ │                                          │ │  ┌───────┴───────┐          │ │
│ │   ╭──────╮      voices live   3 of 4     │ │  │ DIST GAIN ×4  │ bus      │ │
│ │   │ ZOOM │      quietest      BLUE dark  │ │  └───────┬───────┘  ⇠ camera│ │
│ │   ╰──────╯      voice spread   3.31 dB   │ │  ┌───────┴───────┐          │ │
│ │                                          │ │  │ PAN ×4 → BUS  │ bus      │ │
│ └──────────────────────────────────────────┘ │  └───────┬───────┘          │ │
│                                              │  ┌───────┴───────┐          │ │
│ ┌ room ┬ red ┬ green ┬ blue ┬ alpha ┬────────┤  │ MASTER → L/R  │ bus      │ │
│ │      │     │       │      │       │ ensem… │  └───────────────┘          │ │
│ └──────┴─────┴───────┴──────┴───────┴────────┤ ─────────────────────────── │ │
│   ▲ active                          view ┬ walls ┬ crt                     │ │
│                                          └───────┴─────                    │ │
├──────────────────────────────────────────────────────────────────────────────┤
│  ROOM — where you stand is the mix                                           │
│  the same distance number sets ribbon size AND voice gain                    │
│                                                                              │
│    ╭──────╮   ╭──────╮   ╭──────╮   ╭──────╮   ╭──────╮                      │
│    │ ZOOM │   │HEIGHT│   │ ROT  │   │ POS X│   │ POS Y│                      │
│    ╰──────╯   ╰──────╯   ╰──────╯   ╰──────╯   ╰──────╯                      │
│      41 dB      28 dB      3.2 dB     4.6 dB     5.7 dB                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The `red` tab** (the other three voices are identical bar the colour cell):

```
├──────────────────────────────────────────────────────────────────────────────┤
│  RED — +X wall, floor height, aimed at the centre                            │
│  its own wavetable, envelope and pre-mix FX; gate1 opens it                  │
│                                                                              │
│  ┌ wavesculpt-osc-{n} (family) ──────────┐   ╭──────╮                        │
│  │  [swatch]  [preset ▾]  [factory ▾]    │   │ R.COL│  ← ShellColorCell      │
│  │  [ LOAD .wav ]        sine · 60 frames│   ╰──────╯     (§8-E prerequisite)│
│  └───────────────────────────────────────┘                                   │
│                                                                              │
│   pitch ─────────────────┐  ┌───────────────── envelope ──────────────────┐  │
│    ╭──────╮  ╭──────╮    │  │  ╭────╮  ╭────╮  ╭────╮  ╭────╮             │  │
│    │ TUNE │  │ FINE │    │  │  │ A  │  │ D  │  │ S  │  │ R  │             │  │
│    ╰──────╯  ╰──────╯    │  │  ╰────╯  ╰────╯  ╰────╯  ╰────╯             │  │
│   └──────────────────────┘  └─────────────────────────────────────────────┘  │
│                                                                              │
│    ╭──────╮  ╭──────╮  ╭──────╮   ┌──── fx (pre-mix) ────┐  ┌── look ──┐     │
│    │ MORPH│  │ SPRD │  │ FOLD │   │ ╭────╮   ╭────╮      │  │ ╭──────╮ │     │
│    ╰──────╯  ╰──────╯  ╰──────╯   │ │ FX │   │ AMT│      │  │ │THICK │ │     │
│                                   │ ╰────╯   ╰────╯      │  │ ╰──────╯ │     │
│                                   └──────────────────────┘  └──────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Band structure, and why each band is a band:**

| band | label (chars) | hint | contents |
|---|---|---|---|
| `room` | `ROOM — where you stand is the mix` (33) | the shared distance number | the 5 camera axes |
| `red`/`green`/`blue`/`alpha` | `RED — +X wall, floor height, aimed at the centre` (48) | its own table, envelope, pre-mix FX | family + colour + 12 params, clustered `pitch` / `envelope` / `fx` / `look` |
| `ensemble` | `ENSEMBLE — how the four combine` (31) | unison stacks them, chord harmonises them | `unison`, `detune`, cluster `chord`(`chord_mode`,`chord_quality`), `master_gain` |
| `view` | `VIEW — SCALE only bites in the scope modes` (42) | **carries §2-D** | `video_mode`, `blink_mode`, `scale`, `wiggle`, `alpha_brightness` |
| `walls` | `WALLS — the six faces, and the audio they shape` (47) | **carries §2-E + the luma coupling** | 12 wall params + `lum_depth` |
| `crt` | `CRT — the same post-process BENTBOX ships` (41) | **carries §2-C, honestly** | the 11 duplicates |

⚠ **THE BAND LABELS ARE LOAD-BEARING AND SOME ARE LONG.** Label clipping is
invisible to `faces-parity` (`toHaveText` reads `textContent`; a CSS ellipsis
leaves no trace) — the `LP · H… · B…` and `WAVETABLE 60>53` precedents.
**Character budgets, longest first: 48 · 47 · 42 · 41 · 33 · 31.** Measure the
48-char voice label against the dock's real width **before building**. If it
clips, shorten to `RED — +X wall, aimed at the centre` (34) — **do not move the
fact into the `hint`**, because:

⚠ **`face.hint` AND `face.title` DO NOT PAINT AT REST.** `facePageHeader(def,
annotations = false)` returns `null` before reading anything
(`dock-faceplate-model.ts:90`). Nothing in this spec depends on a hint being
read. Every load-bearing fact is in a **label**, a **readout**, or the **hero
picture**. The band `hint`s above are annotation-only bonuses.

⚠ **A tabbed face renders NO band hints at all** (`ModuleFacePage.hint`: "never
rendered on a TABBED face"). Wavesculpt is tabbed. So the hint column above is
**dead weight on this module specifically** — stated so nobody later "fixes" the
face by moving a fact into one.

### 5-E. THE `face` DECLARATION

```ts
face: {
  title: 'Room',
  hint: 'Four voices bolted to four walls; one camera is the viewpoint AND the mix desk. ' +
        'At the DEFAULT camera the BLUE voice is exactly silent — it faces away from you.',

  order: [
    // ── ranks 1-6: the LANE budget (faceTierCap('full') = 6) ──
    'zoom', 'pos_z', 'rot', 'pos_x', 'pos_y', 'master_gain',
    // ── rank 7+: DOCK-ONLY. First legal rank for a PANEL is 7. ──
    'wavesculpt-room-{n}',
    'wavesculpt-osc-{n}',
    // voices
    'red_color',   'tune1', 'fine1', 'morph1', 'spread1', 'fold1',
                   'A1', 'D1', 'S1', 'R1', 'fxType1', 'fxAmount1', 'thickness1',
    'grn_color',   'tune2', 'fine2', 'morph2', 'spread2', 'fold2',
                   'A2', 'D2', 'S2', 'R2', 'fxType2', 'fxAmount2', 'thickness2',
    'blu_color',   'tune3', 'fine3', 'morph3', 'spread3', 'fold3',
                   'A3', 'D3', 'S3', 'R3', 'fxType3', 'fxAmount3', 'thickness3',
                   'tune4', 'fine4', 'morph4', 'spread4', 'fold4',
                   'A4', 'D4', 'S4', 'R4', 'fxType4', 'fxAmount4', 'thickness4',
    // ensemble / view / walls / crt
    'unison', 'detune', 'chord_mode', 'chord_quality',
    'video_mode', 'blink_mode', 'scale', 'wiggle', 'alpha_brightness',
    'lum_depth',
    'wall1_alpha','wall1_distort','wall2_alpha','wall2_distort','wall3_alpha','wall3_distort',
    'wall4_alpha','wall4_distort','wall5_alpha','wall5_distort','wall6_alpha','wall6_distort',
    'hsync_drift','hsync_loss','vsync_drift','scan_wobble','chroma_phase','chroma_instability',
    'feedback_gain','feedback_delay','wavefold','bloom','noise',
  ],   // ⚠ MUST contain all 90 param ids — faces-parity asserts multiset equality

  pages: [
    { id: 'room',  label: 'ROOM — where you stand is the mix',
      controls: ['wavesculpt-room-{n}', 'zoom', 'pos_z', 'rot', 'pos_x', 'pos_y'] },

    { id: 'red',   label: 'RED — +X wall, floor height, aimed at the centre',
      controls: ['wavesculpt-osc-{n}', 'red_color', 'morph1', 'spread1', 'fold1'],
      clusters: [
        { label: 'pitch',    controls: ['tune1', 'fine1'] },
        { label: 'envelope', controls: ['A1', 'D1', 'S1', 'R1'] },
        { label: 'fx',       controls: ['fxType1', 'fxAmount1'] },
        { label: 'look',     controls: ['thickness1'] },
      ] },
    // green / blue / alpha: identical, minus the colour cell on alpha.

    { id: 'ensemble', label: 'ENSEMBLE — how the four combine',
      controls: ['unison', 'detune', 'master_gain'],
      clusters: [{ label: 'chord', controls: ['chord_mode', 'chord_quality'] }] },

    { id: 'view',  label: 'VIEW — SCALE only bites in the scope modes',
      controls: ['video_mode', 'blink_mode', 'scale', 'wiggle', 'alpha_brightness'] },

    { id: 'walls', label: 'WALLS — the six faces, and the audio they shape',
      controls: ['lum_depth', /* 12 wall params */] },

    { id: 'crt',   label: 'CRT — the same post-process BENTBOX ships',
      controls: [ /* the 11 duplicates */ ] },
  ],

  glyph: 'scope',

  hero: {
    cell:    'wavesculpt-room-{n}',
    control: 'zoom',
    readouts: [
      { label: 'voices live',  valueId: 'wavesculpt-voices-live' },
      { label: 'quietest',     valueId: 'wavesculpt-quietest-voice' },
      { label: 'voice spread', valueId: 'wavesculpt-voice-spread-db' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'WAVETABLE x4',  role: 'generator', note: 'one worklet, 4 phase accumulators' },
      { label: 'LUMA BANDPASS', role: 'bus',       note: 'from the wall video — lum_depth' },
      { label: 'ADSR x4',       role: 'bus',       note: 'JS-side, gate1..4' },
      { label: 'FX SLOT x4',    role: 'bus',       note: 'pre-spatial-mix' },
      { label: 'DIST GAIN x4',  role: 'bus',       note: 'the camera number' },
      { label: 'PER-VOICE TAP', role: 'bus', parallel: true, note: 'out_red/grn/blu/alp' },
      { label: 'PAN x4 -> BUS', role: 'bus' },
      { label: 'MASTER -> L/R', role: 'bus',       note: 'master_gain' },
    ] },
    { kind: 'readouts', label: 'the room', entries: [
      { label: 'RED',   text: '+X wall, y -1.0' },
      { label: 'GREEN', text: '-X wall, y -0.5' },
      { label: 'BLUE',  text: '+Z wall, y  0.0' },
      { label: 'ALPHA', text: '-Z wall, y +0.5' },
      { label: 'note',  text: 'an emitter facing away is SILENT' },
    ] },
  ],
}
```

⚠ **`wavesculpt-room-{n}` is ranked 7, not 6.** `module-face-lint` refuses a
PANEL cell selected at a lane tier, and `faceTierCap('full')` is 6 — so rank 7
is the first legal rank for a panel on **every** face (the rings precedent).
With 91 keys there is no crowding.

⚠ **No `action` cell, deliberately.** Wavesculpt has no audition seam: its
voices are opened by `gate1..4` and there is no `manualTrigger` on the handle.
Declaring an `action` without the factory seam is the sixstrum defect.
**Adding one is a factory change and it is NOT in this face's scope** — noted as
optional follow-up in §8-F. Silence-unpatched is a real weakness here, but
unlike rings the module still *renders* unpatched, so the face is not a
photograph.

### 5-F. REAR CARD

Derivation covers this module well — 26 ports is a lot, but they group cleanly
and the derived plan is one band per `pages` page plus the outputs rail. **One
curation is needed**, because derivation cannot know the wall↔face mapping:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  WAVESCULPT — rear                                                           │
│                                                                              │
│  VOICE                                                                       │
│   ○ gate1   ○ gate2   ○ gate3   ○ gate4        ⚠ all four declare NO `edge`  │
│   ○ pitch_cv1 ○ pitch_cv2 ○ pitch_cv3 ○ pitch_cv4                            │
│   ○ morph1_cv ○ morph2_cv ○ morph3_cv ○ morph4_cv                            │
│                                                                              │
│  ROOM                                                                        │
│   ○ pos_x   ○ pos_y   ○ pos_z   ○ zoom   ○ rot                               │
│                                                                              │
│  VIEW                                                                        │
│   ○ scale   ○ wiggle   ○ alpha_in (video)                                    │
│                                                                              │
│  WALLS — the six faces of the room, seen from inside                         │
│   ○ wall1 FRONT (-Z)   ○ wall2 BACK (+Z)    ○ wall3 LEFT (-X)                │
│   ○ wall4 RIGHT (+X)   ○ wall5 FLOOR (-Y)   ○ wall6 CEILING (+Y)             │
│                                                                              │
│  ─────────────────────────────────── OUTPUTS ─────────────────────────────── │
│   ● L   ● R          ● out_red ● out_grn ● out_blu ● out_alp   ● video_out   │
│                       └─ per-voice, PRE master_gain ─┘                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

```ts
rear: {
  groups: [
    { id: 'walls', label: 'WALLS — the six faces of the room, seen from inside',
      ports: ['wall1','wall2','wall3','wall4','wall5','wall6'] },
  ],
}
```

The wall labels are the payoff: `VIDEO_WALL_FACES` (`wavesculpt.ts:210-222`) is
already the single source of truth for the mapping, and today it is only visible
in the card's tiny `W1 · FRONT` captions.

---

## 6. THE THREE HERO READOUTS — each with its negative control

### A. `wavesculpt-voices-live` — "3 of 4"

Count the voices whose `distanceGain(WALL_LAYOUT[i].src, .vec, eyeFromCamera(…))`
exceeds zero, at the **live** (knob + CV) camera. Prints `3 of 4` at spawn, and
names the dark one under it.

**This is the readout that justifies the face.** Nothing in the UI says a voice
is muted today.

**NEGATIVE CONTROL — `rot`.** A `paramId: 'rot'` readout prints `0.00` at spawn
and `0.30` at the VRT scene's camera — **both of which are BLUE-is-silent
positions** — with no hint that a voice is dead. The knob readback is invariant
to the exact quantity in dispute.
**SECOND CONTROL — `zoom`.** Hold `rot` at 0 and sweep zoom: the readout must go
`3 → 4` somewhere between zoom 2 and 3 (measured: BLUE is `0` at zoom 2, rot 0,
and `9.730e-1` at zoom 3). A derivation that reads only `rot` is falsified on the
spot.
**THIRD CONTROL — the CV jacks.** `pos_x/y/z`, `zoom` and `rot` all have
`paramTarget` CV inputs, so the derivation must read the **live** value
(`engine.readParam` returns intrinsic + tap), not `node.params`.

### B. `wavesculpt-quietest-voice` — "BLUE dark"

The name of the lowest-gain voice, and `dark` rather than a number when that gain
is exactly 0.

**NEGATIVE CONTROL:** it must print a *different* voice as the camera moves —
sweeping `rot` from 0 to 1 at default zoom, the quietest voice changes as the
camera orbits. A readout stuck on `BLUE` would be reading the wall layout, not
the camera.
**SECOND CONTROL:** at a camera where all four are live it must print a real dB
figure, never `dark` — otherwise it is a constant wearing a label.

### C. `wavesculpt-voice-spread-db` — "3.31 dB"

`20·log10(max/min)` over the **live** voices, printing `∞` when any voice is at
zero. Measured 3.31 dB at spawn across the three live voices.

**NEGATIVE CONTROL — `master_gain`.** The spread must **not** move when master
gain does (it is a bus trim applied after the per-voice split). A readout that
tracked it would be measuring output level, not balance.
**SECOND CONTROL — `pos_y`.** It must move by ~5.7 dB across that axis while the
`voices live` readout (A) stays at 3 throughout — the two readouts must be able
to disagree, or one of them is redundant.

⚠ **ALL THREE NEED LIVE, CV-DISPLACED CAMERA VALUES.** `FaceReadoutValue` is
params-only today; a CV-modulated camera is invisible to it — and on this module
**all five camera axes have CV jacks**, so the gap is not hypothetical. Until the
widened `{ read, sampleRate, readLive }` reader lands, **ship the labels as
`knob voices live` / `knob quietest` / `knob spread`** — the honest fallback
batch 3 concluded on, and it still beats printing nothing.

---

## 7. ALREADY-WRONG — the standing list

- **A · `gate1..gate4` declare no `edge`.** `contract-lock.txt:3714-3717` reads
  `wavesculpt in gate1 gate` with no `edge=`, four times. The docs
  (`wavesculpt.ts:898`) say "its per-osc amp ADSR holds open WHILE this gate is
  high and releases on the falling edge" and the factory does exactly that —
  level-compare on both edges (`:1404-1415`). That is textbook `edge: 'gate'`.
  `module-docs-lint` does `if (!p.edge) continue`, so **the vocabulary gate skips
  the four ports whose vocabulary is at stake** (the meowbox/rings finding, on a
  third module). Four-line fix; a contract change (`docs:accept`).
- **B · `docs.controls.master_gain` is measurably false** — §2-B. It claims "0 …
  blacks the composite" (measured delta `1e-16`) and "overdrives into white
  smear" (measured +11.9 % on mid grey at g=2). **In `STRICT_DOCS`.** The doc fix
  is wavesculpt-local and belongs with the face; the *shader* fix does not (§8-B).
- **C · `docs.controls.scale` is right but the CARD is misleading** — §2-D. The
  knob sits permanently in the right rail and does nothing at the default
  `blink_mode`.
- **D · `alpha_brightness` has no precondition anywhere in the UI** — §2-E.
- **E · the card re-types every range as a literal — 31 of them.**
  `WavesculptCard.svelte` has 33 `<Knob>` and **31 `min={` literals**:
  `min={-36} max={36}`, `min={0.001} max={5}`, `min={0} max={100}` … on the same
  screen as `:103-104`, which *correctly* reads
  `wavesculptDef.params.find((p) => p.id === key)!.defaultValue`. So the card
  already imports the def for defaults and re-types the ranges anyway. All 31
  currently agree — **that is the hazard, not the reprieve**, and it is the
  backdraft `xMin={-1}` bug's exact shape. `wavesculpt` is **not** in
  `RANGE_BOUND_CARDS` (10 entries, `RANGE_BOUND_FLOOR = 9`), so **no gate can see
  a divergence across 90 params.** Convert to `paramSpec()` and enrol it — this
  is the single highest-value cleanup on the card and it is independent of the
  face.
- **F · the card overflows its own default height by ~282 px** and is exempt
  (`card-control-overflow.spec.ts:101`), with the registry cap frozen at 6. ⚠ The
  spec reports **viewport-scaled** px, not CSS px, so the real CSS overflow is
  larger at the usual zoom — **do not size anything from 282**. A face makes this
  moot for the faced tiers (the shell owns geometry) but **not for the legacy
  card**, which stays reachable until the face ships and `?shell=1` is default.
- **G · the VRT regression lock pins a dead voice** — §2-A. `vrt-scenes.ts:380`
  sets a camera where BLUE's gain is exactly 0. The scene's stated purpose is an
  "alpha-rotate regression lock", which it still serves; but it should not be
  read as a general render check.
- **H · `linux/wavesculpt` is an exempt baseline pair** (`:1420`) — so the one
  platform CI actually renders on has **no** wavesculpt baseline at all, plus 3
  `darwin/wavesculpt-blink-*` quarantines (`:1696-1700`, "canvas-render timing
  variance flake, tracked as task #202"). **Four of the four VRT declarations on
  this module are gaps.** Any face VRT work must not add a fifth (§9).
- **I · the worklet declares 8 AudioParams it never reads** — §2-H.
- **J · no dead params.** All 90 have a real play-time reader (§2-H). Worth
  stating plainly: for a 3641-line card and a 1978-line def, that is a better
  result than the batch average.

---

## 8. PREREQUISITES AND FOLLOW-UPS — each scoped SEPARATELY

⚠ **None of A-D belongs in the face PR.** Named here so they are not discovered
mid-build.

| id | change | kind | why it is separate |
|---|---|---|---|
| **A** | move the default camera off the `±Z` axis, **or** floor the directional term | **def default** / **DSP** | §2-A. Either changes the sound of every existing patch at spawn. Needs owner ears + an ART re-pin. **The face does not need it** — it makes the fact visible instead |
| **B** | fix the `uWavefold*0.7 + uMasterGain*0.1` blend | **shared shader** | §2-B. Touches `bentbox` **and** wavesculpt; a video behaviour change; moves VRT baselines on both |
| **C** | delete the 11-param CRT duplicate | **def / contract** | §2-C. `contract-lock` −11, `docs:accept`, a migration story for saved patches. **Decide this BEFORE the face** — it is 91 cells vs 80 (§9) |
| **D** | add `options` rosters to `fxType{1..4}`, `video_mode`, `blink_mode`; merge `chord_quality` into `chord_mode` | **def / contract** | §3-B. Turns 6 nonsense knobs into segmented pickers and removes 1 param. Cheap, low-risk, and it makes the face materially better — **the best candidate to land just before it** |
| **E** | ⚠ **`ShellColorCell`** | **platform** | §4-C. **THE ONE HARD BLOCKER.** ~40 lines: a cell kind wrapping `<input type="color">` over a packed-RGB param, emitting `control-<paramId>` so parity sees it. Generic; the CHROMA/LUMA keyer cards are the second adopter. Without it, 3 of 91 cells are knobs sweeping 16.7 M **and every gate stays green** |
| **F** | a `manualTrigger` audition seam | **factory** | §5-E. Optional. Wavesculpt renders unpatched, so unlike rings it is not a photograph without one |
| **G** | enrol the card in `RANGE_BOUND_CARDS` | **card/test** | §7-E. Independent of the face and worth doing regardless |

---

## 9. BUILD COST

| | |
|---|---|
| **contract-lock** | **ZERO from the face.** `face` is deliberately out of `contract-signature.ts` (`types.ts:552-556`). ⚠ **+4 lines if §7-A's `edge: 'gate'` lands**; **−11 if §8-C lands**; **±6 if §8-D lands** |
| **WebGL attest** | **ZERO, if done right.** The def is in `AUDIO_WEBGL_MODULE_DEFS` (`rendersWebGL: true`), so a bare `face:` block **would** churn the GPU hash and force a trusted-machine re-attest. The existing `docs`/`controlFamilies` are already inside `docs-hash-ignore` markers (`:884, :988`) — **the `face` block must go INSIDE the same fence.** Verify with `bash scripts/webgl-attest-hash.sh` before and after; the hash must be unchanged. ⚠ The marker is **WebGL-only** — it does nothing for the collab basis, but wavesculpt is not under a collab root, so that asymmetry does not bite here |
| **docs** | `docs:accept` only if §7-A/§8-C/§8-D land. A face alone needs none |
| **ART** | **none.** No audio path changes. (§8-A would need a re-pin; the face does not) |
| **VRT** | `face-wavesculpt-{compact,dock}` × 2 platforms = **4 new baselines**. ⚠ **Both need the `__wavesculptVrtFreeze` hook** the existing scene already uses (`vrt-scenes.ts:396-403`) — a 3D render is not bit-stable otherwise, which is what the 3 `darwin/wavesculpt-blink-*` quarantines are. ⚠ **Capture BOTH platforms.** `linux/wavesculpt` is already an exempt pair (§7-H); adding two more darwin-only faces would manufacture two fresh undeclared platform gaps and move the `vrt-platform-gaps` ratchet the wrong way |
| **e2e — ⚠ THE REAL COST** | **91 cells** (90 params + 1 family), every one driven by the `faces-parity` per-cell operability loop |

### 9-A. ⚠ THE CI ESTIMATE, AND IT NEEDS SIGN-OFF

`faces-parity.spec.ts:76-84` carries measured constants:

```
real GPU     ~ 1.2s + 0.12s/cell
SwiftShader  ~ 2.0s + 0.19s/cell
CI (derived) ~ 10s  + 0.8s/cell
```

For 91 cells on CI: **10 + 0.8 × 91 ≈ 83 s ≈ 1.4 min**, on one shard.

Context for how large that is:

- **The largest face in the repo today is `cloudseed` at 46 cells.** Wavesculpt
  would be **~2×** it.
- CI run 30190844866 **failed the four biggest faces** — cloudseed (46),
  kickdrum (25), tidyVco (25), snaredrum (22) — always mid-`dragKnob`, always
  still progressing. That failure cutoff is what the `10s + 0.8s/cell` figure was
  derived from. Wavesculpt sits far past every point in that dataset, so **83 s
  is an extrapolation, not an interpolation** — treat it as a floor.
- The **fixed** term is sized off ordinary cards. Wavesculpt's mount is a
  WebGL2 3D scene that `per-module-per-port.spec.ts:937` already calls out as
  "the heavy 3D mount eats the [budget]". The 10 s fixed term is optimistic here.
- The timeout ceiling is fine — `45_000 + 1_800 × 91 = 209 s` — so this is a
  **wall-clock** problem, not a red-test problem.

**Verdict on cost: ~83 s on one shard for ONE module. Under the ~2 min bar, but
it is ~70 % of the entire budget spent on a single face, and it is the largest
single test row in the repo by a factor of two. This needs explicit owner
sign-off** (`ci-walltime-2min-approval`).

**The lever is §8-C.** Deleting the 11 CRT duplicates takes the face from 91
cells to 80: `10 + 0.8 × 80 ≈ 74 s`, a **~9 s** saving and a materially simpler
faceplate. **Landing §8-C before the face is the single best cost decision
available**, and it is justified on duplication grounds alone.

---

## 10. WHAT I COULD NOT DETERMINE

1. **Whether the ~282 px card overflow is still accurate.** The figure is
   viewport-scaled, the exemption predates several card edits, and re-measuring
   needs a real browser run. **Never size anything from that number.**
2. **Whether the 3 `darwin/wavesculpt-blink-*` quarantines would recur on a face
   VRT scene.** They are canvas-timing flakes on the *card*; the face renders the
   same WebGL context, so the freeze hook is probably necessary and probably
   sufficient — but "probably" is doing real work in that sentence, and only a
   `REPEAT=3 task vrt:one` under `E2E_SWIFTSHADER=1` settles it.
3. **The real per-cell CI cost at 91 cells.** §9-A extrapolates from a dataset
   whose largest point is 46. The honest way to close this is to build the face
   behind `STRICT_FACES` and read one CI run before committing to it.
4. **Whether a `ShellColorCell` has other adopters.** I found the CHROMA/LUMA
   keyer pattern referenced in a card comment (`:2947-2952`) but did not verify
   those cards use packed-RGB *params* rather than `node.data`. If they use
   `node.data`, wavesculpt is the only adopter and §8-E is harder to justify as
   platform work.
5. **Whether `pos_z`'s 27.6 dB is perceptually as big as `zoom`'s 41.3 dB.**
   Both are gain-scalar swings; neither is a loudness model. The ranking is
   defensible on the numbers I have, but a listening test could reorder 2 and 3.
6. **The BIRDSEYE and SPECTROGRAPH render paths were not measured.** I verified
   `video_mode` reaches the card (`:2724`) and branches, but did not sweep what
   the other two modes do to the params. If either ignores a param the way
   `blink_mode 0` ignores `scale` (§2-D), there is a §2-D sibling I did not find.

---

## 11. VERDICT

> **PROMOTE — blocked on §8-E (a `ShellColorCell` kind), and gated on two owner
> decisions: whether to delete the 11-param `bentbox` duplicate (§8-C) before
> building, and whether ~83 s of CI on one shard for a single face is acceptable
> (§9-A).**

The module earns a face on merit. It has a genuinely novel idea that no other
module in the rack has — **one number that is simultaneously the viewpoint and
the mix** — and that idea is currently invisible behind 90 knobs and two
unlabelled joysticks. A room-plan hero and a `3 of 4 voices live` readout would
say more about wavesculpt in one glance than the 3641-line card manages at all.

It is also the module where the faceplate work would **pay a real debt**: the
BLUE voice has been silent at the default camera for the module's whole life,
every gate stayed green, and the one test that looks at it passes with a 0.973
margin because it never samples the default. A face does not fix that — §8-A
does — but a face is what makes it impossible to miss.

**Do not start with the face.** Land §8-D (the `options` rosters — cheap, and it
turns 6 nonsense knobs into pickers), decide §8-C, then build.
