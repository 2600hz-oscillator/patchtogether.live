# FACE RE-DO — the shipped faces against the PF-20 platform · THE INDEX

## 0. TWO OWNER RULINGS VOID LARGE PARTS OF EVERY SPEC BELOW

Both landed 2026-08-11, both after these specs were written, and between them
they delete the `hint` half and the `signal-flow` half of every per-module file
in this batch. **Read them before reading any spec.**

**THE NO-PROSE RULING** — owner, on the shipped clouds faceplate (verbatim,
`strict-faces.ts:402-406`):

> *"i really don't like any of this text… we should prefer almost zero AI
> authored text, and all future faceplate work should reflect that. our old
> faces are pretty self explanatory. i want to lose all the ai text, and bring
> back right click → annotate based on authored docs."*

So a face declares **no `face.title`, no `face.hint`, no page `hint`, no
editorial band caption** — plain labels, a picture, bare values. Everything
explanatory lives in the def's `docs`, which is what right-click → annotate
already reads. `marbles` (#1467) and `resofilter` (#1470) are the two worked
examples, authored concurrently on separate branches and converging on the same
shape. **Every `title:` / `hint:` block written out in the specs below is dead
content** — the platform still supports the fields, the ruling says do not
author them.

**THE SIGNAL-FLOW RULING** — owner, looking at analogVco's block (verbatim,
`strict-faces.ts:462`, `#1468`):

> *"this really isn't accurate. lets stop doing these and clean up the existing
> ones, get rid of them. lose the signal flow diagrams."*

The **kind itself is deleted** — `FaceFlowStage` and the `signal-flow` arm of
`FaceSidebarBlock` are gone from `graph/types.ts`, along with the renderer, the
CSS and the `side-flow` testid; `faceplate-platform` keeps a permanent negative
control asserting `side-flow` count 0. Twelve modules' blocks went with it. The
standing note at `graph/types.ts:798` carries the reason: *nothing verified a
hand-authored stage list against the DSP* — not contract-lock, not
module-face-lint, not ART — so they were prose in a diagram's clothes, free to
drift the moment a worklet changed. **A future chain picture must be DERIVED
from something the build can check, or it must not exist.**

The surviving sidebar kinds are `presets`, `readouts` and `custom`. An empty
sidebar is reported as empty, never padded — seven faces already ship that way.

**Also true, and load-bearing for reading the specs:** `facePageHeader()`
returns `null` unless annotate mode is on (`dock-faceplate-model.ts:86-94`), and
the owner ruled on 2026-08-03 that `face.title` stays annotation-only (*"two
names on one panel was the actual complaint"*). Eight specs park a load-bearing
fact in `face.hint` and justify it with *"which still paints"*. That premise was
already false in August 2026 and the no-prose ruling has since removed the
surface entirely. **Where a spec moves a fact into prose, the fact still needs a
home — and the only legal homes now are a readout, a value, a picture, or
`docs`.**

⚠ **The faceplate pipeline is PAUSED by owner directive.** These are specs for
unbuilt work, not a queue to pick up.

- **Mockup gallery:** `.myrobots/mockups/face-redo-gallery.html` — this index is
  its only referrer. It predates PF-21 row packing, draws the page header as if
  it painted at rest, and draws prose the no-prose ruling bans. Read it for
  layout, never for content.
- **Per-module specs:** `.myrobots/plans/face-redo-<module>.md` — delay, lfo,
  reverb, snaredrum. (sixstrum's delta shipped in #1332 and its file was deleted
  2026-08-04; vca shipped as #1429 and its file was deleted 2026-08-12.)
- **Quality bar:** `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md`
  (§7 "THE RECIPE"). **Format:** `.myrobots/plans/face-specs-batch-3-*.md`.

---

## 1. THE READOUT-STRIP CORRECTION

**The readout row is a FULL-WIDTH STRIP BELOW the hero graphic**, not a
`<dl class="hero-readouts">` column beside it. It is not a cosmetic move, and
three specs changed because of it:

- **kickdrum** must DROP `settles to` (`{ paramId: 'tune' }`). Inline beside the
  TUNE dial it read as a caption; in a wide strip under the graph it reads as *a
  second, independent measurement that happens to agree*. One number, one place.
  **Still not applied — `kickdrum.ts` still declares `settles to`.**
- **tidyVco** and **delay** carry **zero** `paramId` readouts for the same
  reason: PF-20's `persistentReadout` already prints every dock dial's value
  under it, so a `paramId` entry beside a dial is literally the same string
  twice.
- **sixstrum** is the only face with TWO readout surfaces (the strip and a
  sidebar `readouts` block), and the correction forces a rule that did not
  previously need stating: **the strip is what you read WHILE PLAYING; the
  sidebar block is REFERENCE.** A strip entry must change under the hand.
  (Shipped verbatim at `sixstrum.ts:256-257`.)

**adsr is the module that makes the correction obviously right:** it declares no
`cell`, no `control` and no `action`, so under the old layout its three readouts
render as a dangling list floating to the right of a 214 px graph on an
~85 %-empty faceplate.

---

## 2. THE VERDICTS

⚠ Every row's `hint` / `title` / `signal-flow` content is void per §0. What
survives a row is its ranking argument, its derived readouts, its picture and
its refusals.

| module | verdict | the one-line proposal |
|---|---|---|
| **adsr** | REWORK (declaration-only) | An ~85 %-empty faceplate that never says *gate, not trigger*. Strip = `note 405 ms · gate to sustain 105 ms · from a trigger 2.5 ms high`; a 5-shape preset roster that **hand-negative-controls the strip on the shipped surface**. No hero picture — the `envelope` glyph already is one. |
| **karplus** | REWORK | The audition DOES reach the shell (checked, unlike sixstrum). Hero = a **PARTIAL LADDER** — the four knobs a time-domain scope structurally cannot show. Strip = ring · damping · exciter, all derived. |
| **tomtom** | REWORK (small version) | Takes the drum grammar's DATA half (title, bands, strip, presets) and declines its CODE half. 4 bands → 2. `ring` is honestly `paramId: 'decay'` — the kickdrum trap **does not reproduce** here and the spec says so. |
| **snaredrum** | REWORK (structural) | Does **not** mirror kickdrum: `hero.action` takes ONE key and this module has TWO auditions. HIT to the hero, ROLL down into the roll band — which fixes a defect the shipped face had on day one. Hero = a ROLL GRID over the wire-bed envelope. |
| **reverb** | REWORK (small) | `diffusion` **rejected out of the wave** (a Faust rebuild + ART re-pin never belongs in a face PR). RT60 survives as a derived readout **per band, not as one broadband scalar** — and the spec refuses to invent the scalar. Two `format` functions make SIZE and DAMP print physics. |
| **shimmershine** | REWORK | 3 declaration-order bands → ONE honest `tank`. ⚠ **Read its defects section first:** the DC-rail half is fixed (#1313) but **the self-sustain threshold MOVED with the fix** (default tank ~0.75, was ~0.39), so every regeneration-boundary figure in that spec needs re-measuring, and its `damp === 1` freeze (row 14) is still open. |
| **qbrt** | REWORK | Two instruments sharing four knobs, and **the second is unreachable from every surface in the repo**. Adds the PING audition + a ring/peak strip. Round-2's BLOCKER on this module was false. |
| **cloudseed** | REWORK (additive only) | The 47-key ranking and the tab rail are right. The hero rail is **the only part of the faceplate on screen at all times**, so three of four strip entries print values that live on tabs you cannot see. Rejects the platform `presets` block, three ways. |
| **mixer** | REWORK (short) | A plain uncompensated sum: four unity channels leave at **+12.04 dB**, and the panel has never shown it. 2 pages → 1, because promoting `master` **empties** the `bus` band. |
| **dx7** | REWORK (structural) | The operator map becomes the hero picture — which **deletes a duplicate diagram the dock paints twice today**. 4 pages → 3. Strip constrained by a real platform limit: readouts read params only, so `node.data.voice` is unreachable. |
| **delay** | MECHANICAL ONLY | Control surface untouched. Strip = tail · build-up · floor, both derived entries carrying must-NOT-move legs. |
| **lfo** | MECHANICAL ONLY | Already *is* the program's BATCH B entry, better argued. **No strip and no sidebar, both by argument:** every derived candidate is a single-input alias, and a `hero.cell` would suppress a `waveform` glyph that never flatlines. |
| **ringback** | MECHANICAL ONLY | The one face whose ranges already live in ONE model module. Gains the best-earned strip in the batch: the FEEDBACK dial's `6 LAPS` is the kickdrum trap **already shipped on this module's own dial**. |
| **tidyVco** | MECHANICAL ONLY | Not a VCO — the rack's one complete subtractive VOICE, silent until gated. Gains the whole PF-20 surface + the HOLD audition in the hero. |
| **filter** | ✅ SHIPPED (#1430) | Three derived readouts, none of them a knob on the panel; the magnitude curve went in the **SIDEBAR**. |
| **vca** | ✅ SHIPPED (#1429) | The derived strip and the four statements #1313 falsified. Its sidebar was the batch's only `signal-flow` block and was removed with the kind. |
| **kickdrum** | face SHIPPED, **DELTA STILL OPEN** | Delta: drop `settles to`, add a derived `starts at` (the function already exists). Not applied. |
| **sixstrum** | ✅ SHIPPED (#1332) | The strip-vs-sidebar rule shipped with it. Only the FACE half shipped — see §3 row 35 for what is still open. |

---

## 3. THE DEFECT LEDGER — shipped-code bugs found while reading

**None of these is spec content. Every one is its own follow-up PR**, and the
DSP ones are owner-audition PRs. Ranked by how much they hurt.

> ⚠ **THE ROW NUMBERS BELOW ARE CITED FROM LIVE SOURCE** — `shell-cells.ts:651`
> and `audition-ledger.ts:25` both say "face-redo ledger defect #22";
> `mutate.guard.test.ts:26` says "#7"; `card-def-agreement.test.ts:170` cites
> the ledger generically for row 34. **Never renumber this table.**
>
> **CLOSED, verified against the tree (evidence in the PR, not in this doc):**
>
> | # | module | closed by |
> |---|---|---|
> | 1 | shimmershine — the "crystalline drone" is a pure DC rail | **#1313** — 20 Hz DC blocker in the loop and on the wet send. ⚠ The self-sustain threshold MOVED (default tank ~0.75, was ~0.39). |
> | 2 | cloudseed — the worklet re-seeds every 128-sample block | **FIXED** — `CloudseedProcessor.setParameter` now dedupes (`cloudseed.ts:1404-1431`), and the skip is sound-transparent only because `ReverbChannel.setParameter` was made idempotent first. Verified byte-exact over a 600-block render per preset. |
> | 3 | vca — `si.smoo` lowpassed the CV | **#1313** — per-slider smoothing (`vca.dsp`), 1 ms → 1.02 ms, 5 ms → 4.02 ms (was 49.79 ms for both). |
> | 4 | tomtom — `strike` stuck at 1 masks `trigger_in` forever | **#1316**. |
> | 5 | adsr — the ART lane is green about a different synth | **#1313** — re-pointed at `renderFaustOffline`. |
> | 6 | ringback — `out_l`/`out_r` both map to output 0 | **#1313** — `ChannelSplitter(2)`. |
> | 7 | filter — `t.params.mode = m` is an origin-less raw write | fixed 2026-08-02. The `RAW_PARAM_WRITE` bracket-only blindness is fixed too (`mutate.guard.test.ts:26`). |
> | 12 | qbrt — `ping` declares no `edge:` | **CLOSED** — `qbrt.ts:73` now declares `{ id: 'ping', type: 'gate', edge: 'trigger' }`, and `undeclared-edge-ledger.ts` no longer exists (the 299-port ledger was paid off in #1442). |
> | 16 | cloudseed — early-diffusion modulation gated on the wrong unit | **#1412** — "cloudseed's early-mod gate read ms against a samples threshold". |
> | 19 | filter — the `mode` tooltips claim 12 dB/oct for HP and BP | **#1430** — `filter.ts:133-135` now read 12 / 6 / 6 dB/oct, with the derivation above them. |
> | 22 | karplus — the dock PLUCK animates when nothing was plucked | `ShellActionCell.probe` is now **REQUIRED** and the audition ledger records `delivered: false`. |
> | 25 | snaredrum — the roll's sizzle pans to the wrong side | **#1328** — one shared `panSideGain` helper (`snaredrum-dsp.ts:596`). |
> | 33 | vca — the ART comment "a VCA attenuates, never boosts" | **#1313**. |
> | 35 | sixstrum — the shipped face cannot play the instrument | **#1332**. ⚠ **Only the face half.** The BASS-preset `F0_MIN` collapse, the inert `ENV DECAY`/`RELEASE` and `tuning` writing 14 params while advertising one are all **STILL OPEN**. |
>
> **Everything not listed above was still open when last checked (2026-08-12).**

| # | module | defect | why nothing caught it |
|---|---|---|---|
| 8 | **lfo** | **`LfoCard` never passes `formatValue={p.format}`**, so the legacy card prints `0.50` for DEPTH where the dock prints `±1.00` — **at the shipped default, with no knob moved.** RATE diverges at the low end too. (`LfoCard.svelte:81-83` — still no `formatValue` prop.) | the private duplicate guard inside `lfo-face-model.test.ts` predates the format clause |
| 9 | **snaredrum** | **`accent_in`'s velocity term is inert on every PRIMARY stroke** — `clamp(1·(1+0.5·acc),0,1) ≡ 1` (`snaredrum-dsp.ts:512`) — so a sequencer velocity lane into `trigger_in` yields no dynamics at all. | nothing asserts a level difference between two accents |
| 10 | **karplus** | **`docs.controls.stiffness` claims "a perfectly harmonic string"** at STIFF 0 — modelled, partial 8 is **+114 ¢ sharp** at BRIGHT 0 and −13 ¢ flat at the default. | the sonic-range test never checks the STIFF = 0 baseline |
| 11 | **mixer** | **`docs.explanation` tells users to watch the level meter to see the sum clip. It cannot** — three separate clamps on the way to the pixel, and a 43 ms RMS is not a peak detector, so 0 dBFS and +12 dBFS paint an identical full meter. | no test asserts the meter distinguishes them |
| 13 | **reverb** | **DAMP's tone is sample-rate dependent** while the tank's timing is SR-adapted — the same rack is brighter at 96 kHz. (`reverb.dsp` still feeds `damp` in as a raw one-pole coefficient.) | no cross-rate assertion anywhere |
| 14 | **shimmershine** | At `damp === 1`, `fbStore = fbStore` freezes at its **live** value, not zero: a persistent, arbitrary-signed DC residue that does not clear when DAMP returns. Two shipped comments claim "freezes at zero" — true only from a cold spawn. | the tests spawn cold |
| 15 | **cloudseed** | Three MOD AMT dials print `round(s×100)+'%'` on a ×2.5-**millisecond** value — full travel prints `250%`. | the dock VRT scene captures only the ACTIVE tab, so most controls are pixel-invisible |
| 17 | **dx7** | The dock renders the topology **twice** from the same geometry — a 64 px glyph and a 280 px map. | nothing counts diagrams |
| 18 | **karplus** | BRIGHT's top travel is **dead above ~1 kHz** (the `0.45·sr` cap): at A6, B > 0.567 does nothing at 48 kHz. The docs say the knob "means the same thing at every pitch". | no per-pitch sweep |
| 20 | **lfo** | `module-manifest.ts:563` publishes *"External clock — locks LFO rate to incoming pulses"* on the public docs site. **It does not lock the rate** — it re-zeroes phase. Contradicted by the worklet, the def header and the def's own authored `docs.inputs.clock`. `DESCRIPTIONS[lfo]` (`:247`) inherits the half-truth. | `PORT_NOTES` is not cross-checked against authored docs |
| 21 | **tidyVco** | The `oct2` lane-plate readout overflow the def comment reports is **still live** — 42 px rows, `overflow:hidden`, an unconditional 9 px readout. | the `full` lane tier has **no VRT scene at all** |
| 23 | **lfo** | The MORPH law has **three independent implementations** — `morph()` (`dsp/src/lfo.ts:232-243`), `morphLfo()` (`lfo-state.ts:46`) and `triMorphWaveSample()` (`scope-screen-model.ts`) — and no cross-check, sitting beside a DEPTH law that has one and is rigorously cross-gated. | see left |
| 24 | **reverb** | `reverb.dsp`'s `spread = 0.5` is a **no-op** — truncated by the integer delay index. (This makes the design program's `room`/`spread` rejection *stronger* than it was argued.) | nothing asserts it does anything |
| 26 | **adsr** | The `face.order` rank-1 comment's arithmetic is wrong: `fireTrigger` is a triangle above `GATE_HI` for only 2.5 ms and `en.adsr` resets on every rising sample, so CLOCK → ADSR gives a **quarter-height** envelope, not a full one. The conclusion (release outranks attack) survives and is strengthened. | comments are not gated |
| 27 | **cloudseed** | Two docs figures say ~30 s / "near 60 s" for INFINITE PAD's tail. It is **42.5 s**. (`cloudseed.ts:568,605` still carry both figures.) | — |
| 28 | **qbrt** | `docs.inputs.ping` overstates the click decay ~7× (1.03 ms is τ, not the length); `qbrt.dsp`'s `declare description` is wrong twice and ships in `qbrt.json`. | — |
| 29 | **dx7** | `topologyLabel` prints a bare `5` where the picker chip reads `ALGORITHM 05` — `algorithm` declares no `format`/`options`. | — |
| 30 | **delay** | `docs.controls.time`'s "smooth swoop" understates a 0.25 → 1.5 s jump, which starts at `dt/dτ = 125` — the read head runs **backward at ~124×**. *(Inference from the `setTargetAtTime` law at `delay.ts:385`, labelled as such.)* | the 498 Hz varispeed probe has **no artifact in the tree** and is not ART-reproducible |
| 31 | **filter** | The rear card prints `AUDIO` on **both** jacks (no label override passed). | — |
| 32 | **tidyVco** | A DSP comment says "frozen 23-param contract" over a **25**-row `PARAM_TABLE`. | — |
| 34 | **—** | **Range/label re-typing in cards, still.** qbrt (12 numbers + **positional** param indexing), reverb (18 def facts — `ReverbCard.svelte:29-31`), filter (ranges + positional indexing + a second `MODES` vocabulary), adsr (labels), karplus (converted to `paramSpec` but never enrolled in the guard lists). All currently AGREE. ⚠ **Partly mitigated:** `card-def-agreement.test.ts` is now tree-wide deny-by-default over all 193 cards keyed on `(card, param, field)`, so a re-typed fact that goes on to *disagree* is RED. The re-typing itself is still unconverted, and `card-range-source`'s stronger "is the divergence unrepresentable?" question is still opt-in by filename. | the stronger guard is opt-in by file list |
| 35 | **sixstrum** *(face half closed — see above)* | The **BASS preset collapses three of six strings** onto one pitch; `ENV DECAY` and `RELEASE` are inert at the shipped defaults; `tuning` writes **14 params while advertising one**. | — |

### Two meta-findings worth more than any single row

- **A gate blind in the same direction as the bug it guards.** filter's undo hole
  (#7), lfo's format divergence (#8) and qbrt's missing `edge` (#12) are all this
  shape: `RAW_PARAM_WRITE` was bracket-only, `RANGE_BOUND_CARDS` is opt-in by
  filename, and `if (!p.edge) continue` skipped exactly the ports nobody
  declared. **Each gate was green because it could not see the case.** Three of
  the four have since been inverted; the `RANGE_BOUND_CARDS` opt-in has not.
- **The `action` cell had no probe.** `faces-parity`'s `action` branch asserted
  `toBeEnabled()` then clicked — **it asserted no effect**, so a dead audition
  passed the whole face green. That is why karplus #22 survived. **Closed:**
  `ShellActionCell.probe` is now required and the audition ledger records
  `delivered: false`.

---

## 4. THREE PLATFORM FINDINGS — all now CLOSED

Recorded because each was found independently while designing against the
platform, and each is the kind of hole that is invisible until a second module
adopts a field.

1. **On a TABBED face an annotation hint could never paint.** Moot — the
   no-prose ruling removes authored hints entirely, and
   `bandHeaderPlan`/`facePageHeader` were decoupled from `dockTabs` so the
   remaining prose surface enrols tabbed adopters instead of forbidding them
   (`dock-faceplate-model.ts:111-124`).
2. **`heroFacePlan` dropped an emptied CLUSTER but not an emptied BAND**, so
   promoting a whole band's contents into the hero rendered a labelled void.
   **FIXED** — `dock-faceplate-model.ts:306,321-322` now filters bands with no
   controls and no clusters.
3. **No module with ≤ 6 controls could ever declare a hero picture** — a panel's
   first legal rank was 7 on every face, always, because `face.order` was both
   the priority ranking and the lane budget selector. **FIXED by PF-22**
   (#1480): `laneOrder(face)` drops `face.hero.cell` from the ranking a LANE tier
   sees, so a panel may now rank FIRST and still cannot reach a 46 px knob
   column. Measured across the live registry: 0 of 11 hero-cell faces changed a
   single lane cell. **The `custom` SIDEBAR workaround adsr / filter / qbrt were
   pushed into is no longer forced.**

---

## 5. WHAT SHOULD BE DROPPED FROM `STRICT_FACES`

**Nothing.** The question was asked of the two candidates and both come back
keeps:

- **vca** (2 params) — `STRICT_FACES` **is** the migration switch (`migrated()`
  reads it), so dropping it un-migrates the module to a placeholder tile with no
  in-lane controls, and `vca-gain-model.test.ts` already fails with *"it was
  un-migrated"*. Unlike `noise` — which the batch-3 pass correctly recommended
  against on merit — vca's tiers do **not** collapse: mini shows 1 cell and
  compact/full/dock show 2, so `order` decides a real thing.
- **qbrt** (4 params) — the opposite of a drop candidate. It is the module in the
  set whose face is furthest from what the module actually is.

**One thing worth the owner's decision instead of a drop:** *snaredrum's* hero +
strip make the dock face substantially taller, so a fixed-height pixel gate
covers proportionally less of it after the rework than before. That is a real
coverage trade for a real design win and should be an explicit choice rather
than a side effect. (The old 425 px dock clamp that made this acute was itself a
bug and was fixed in #1413.)

---

## 6. THE RULES THESE WERE WRITTEN UNDER

1. **A derived readout must name the perturbation that distinguishes it from a
   knob readback** — and, where possible, a second leg that must **not** move.
   Several specs refused a readout on this basis (lfo's three single-input
   aliases; tomtom's `ring`, where the trap measurably does not reproduce;
   qbrt's ring *frequency*, which is `cutoff` wearing a formula; karplus's
   clamped pitch, which is mathematically unreachable). **Refusing is the right
   answer more often than inventing.**
2. **A control's range comes from ONE place: the def, imported by the card,
   never re-typed.**
3. **A bespoke visualiser cell is legitimate; a bespoke readout mechanism is
   not** — and after the two §0 rulings, neither is authored prose in any slot.
4. **`hero.cell` SUPPRESSES the dock glyph** (`ModuleShell.svelte:403`). On dx7
   that is the point. On nine others it would be a downgrade — a live picture
   traded for a static one.
5. **Never fold a DSP change into a face wave.** Every entry in §3 is its own PR.
6. **Where an agent inferred rather than read, the spec says so.**
