# face re-do — mixer

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **The claim that "the summing law is
> in `face.hint` (which still paints)" is FALSE** — the +12.04 dB headline needs a surface
> that paints at rest (the readout strip), not the hint. PF-21 dock ROW PACKING
> (`9bf12df7`) also landed after this was written. **This re-do is NOT built** — the
> shipped `face` still declares no `hero` and no `sidebar`. Live backlog.

**Verdict: REAL REWORK — but a SHORT one.** The ranking and the rear are already right and are
NOT touched; what the face is missing is the whole PF-20 layer (no title, no hint, no hero, no
sidebar) plus the one number this module genuinely owns and no knob can print — the **summed bus
gain**, `(ch1+ch2+ch3+ch4) × master`, which is `×4.00 / +12.04 dB` at spawn and is the module's
entire documented hazard, currently stated only in prose.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**The DSP is five lines and there is nothing hidden in it.** `packages/dsp/src/mixer.dsp:12-17`:

```
process(in1, in2, in3, in4) =
  (in1 * (ch1Knob : si.smoo) + in2 * (ch2Knob : si.smoo)
 + in3 * (ch3Knob : si.smoo) + in4 * (ch4Knob : si.smoo))
  * (master : si.smoo);
```

Answering the four questions this brief asks, each against that line:

- **Is the summing law gain-compensated?** **NO.** It is a bare weighted sum — no `/4`, no
  `tanh`, no clamp, no limiter, no soft-clip anywhere in the file. `mixer.dsp` declares exactly
  five `hslider`s (`:6-10`) and uses each exactly once. **Four unity channels carrying correlated
  full-scale audio leave this module at 4× full scale (+12.04 dB)** and clip at whatever
  downstream stage clamps — never here.
- **Is there a master?** Yes, `master`, applied to the SUM (`:17`), so it is downstream of the mix
  and cannot change balance. Its declared range is `0..1` (`mixer.ts:76`, `contract-lock.txt:1810`,
  `mixer.dsp:10`) — **it can only attenuate; there is no make-up gain anywhere in the module.**
  It is therefore the module's *only* headroom control.
- **Linear or dB?** **LINEAR AMPLITUDE**, all five, `curve: 'linear'`, `0..1`, default `1`
  (`mixer.ts:72-76`). So half travel is −6.02 dB, a quarter is −12.04 dB, and everything under
  −20 dB is squeezed into the bottom tenth of the throw. **Every real fade lives in the bottom
  third of the control** and the top half is a small loudness change. That is a fact about the
  *control*, not the sound, and it is the single most useful thing to say about a mixer knob.
- **What does the level meter measure and where does it tap?** `face.glyph: 'meter'`
  (`mixer.ts:120`) → `glyphBinding` falls through to `if (audioOut) return { kind: 'live-audio',
  portId: audioOut }` (`shell-glyph-live.ts:156`), which taps `audio.getOutputNode(nodeId,
  'audio')` (`shell-glyph-live.ts:323`) — i.e. the Faust node itself (`mixer.ts:187`), **upstream
  of any destination clamp.** The value it reports is `rmsUnit(buf)` over a 2048-sample analyser
  window (~43 ms), and `rmsUnit` **CLAMPS to [0,1]** (`level-meter.ts:24`). `VuMeter.toUnit`
  clamps again (`VuMeter.svelte:67`) and `dbfsToUnit` returns `1` for any `db >= 0`
  (`vu-meter-model.ts:27`). **⚠ So the meter is structurally incapable of reporting an over —
  see §9 DEFECT 1.**

**Smoothing.** Every gain runs through `si.smoo` (`mixer.dsp:13-17`). The def states it verified
the generated C++ emits the one-pole coefficient as `44.1/sampleRate` (`mixer.ts:14-18`); I did
not re-run `faust -lang cpp` (no `packages/dsp/dist` in this worktree), but the arithmetic checks:
τ = 1/44.1 s = **22.7 ms**, sample-rate independent, and `1 − 44.1/fs` is exactly Faust's classic
`si.smoo = smooth(0.999)` normalised off 44.1 kHz. Two consequences: knob and MIDI writes de-zip,
and the levels are **CONTROL-rate** — MIXER is never a VCA or a ring modulator.

**Load-bearing vs incidental vs inert.** All five controls are load-bearing and **none is inert at
spawn** — every one multiplies on sample 1. That is unusual and worth stating, because the whole
`face` ranking vocabulary ("check every hero candidate for inertness at spawn") has nothing to
bite on here. What it *does* have is the module's real asymmetry: **four of the five controls are
interchangeable and one is not.** `ch1..ch4` are peers whose meaning depends entirely on which of
four identical jacks you happened to patch; `master` is the only control whose meaning is
patch-independent, and the only one that can pull the sum back under full scale.

**Un-exposed DSP capability: ZERO.** `mixer.dsp` declares five `hslider`s; `mixerDef.params`
declares those exact five. 1:1 — a finding, not a shortfall (recipe Step 8).

**The card.** `MixerCard.svelte` is 45 lines: `ModuleTitle` + `PatchPanel` + five `<Fader>`
(`:33-37`) and nothing else. The committed legacy baseline
(`e2e/vrt/__screenshots__/vrt.spec.ts/darwin/mixer.png`) confirms it: five vertical faders labelled
CH1…MASTER and two collapsed PatchPanel drill-down buttons — **no port names are painted on that
scene at all.** That matters in §8.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

Look at `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-mixer-dock.png`: a
1220 px-wide faceplate carrying a 210 px meter strip, four knobs, a rule, and one more knob.
**Roughly 80 % of the pane is empty.** That is not a fold problem; it is the absence of everything
PF-20 added.

1. **No `title`, no `hint`.** The face states nothing about itself. `facePageHeader` returns `null`
   for a face declaring neither (`dock-faceplate-model.ts`), so the header row simply does not
   paint.
2. **No hero.** `master` renders as one more 46 px knob, indistinguishable from `ch3`, in a
   separate band below the four it governs.
3. **No readouts, and this is the real gap.** The def's own header (`mixer.ts:26-31`), its
   `docs.explanation` (`:149`) and `DESCRIPTIONS` (`module-manifest.ts:223`) all assert the
   `+12 dB` hazard **in prose the faceplate never shows.** The number is computable from the live
   params on every frame and it was nowhere on the panel.
4. **No sidebar**, on the emptiest dock face in the promoted set.
5. **The `bus` band is a one-control band** — an ~81 px rule + header for a single knob, which
   PF-9's own guidance calls out ("a page earns a header only if it groups ≥2 controls or the lone
   control is the module's identity"). It survives today only because `master` had nowhere better
   to go. **With PF-20 it does have somewhere better: the hero.**
6. **Def comment drift.** `mixer.ts:99` describes the compact tile as reading "SOURCE · BUS ·
   LEVEL" from `master + ch1`, three roles for two knobs, and privileges `ch1` eleven lines after
   arguing (`:88-90`) that privileging any one channel is arbitrary. The honest rank-2 sentence is
   "the ladder must emit a second control, the four are interchangeable, so it emits the first in
   jack order."

**What is already RIGHT and must not be churned:** the `order` (`master` first — the headroom
argument at `mixer.ts:91-93` is correct and it is the only argument that would be *wrong* for a
different module); the decision to let `order` and `pages` disagree (`:110-113`); the `meter`
glyph choice; and the rear curation (`:136-144`) including its deliberate empty `audioRate` — the
`vca` precedent it cites is real (`vca.ts:183-186` re-checked the tick and correctly left it off).

---

## 3. THE CONTROLS THAT MATTER

**This module has FIVE params, not eight — every one is ranked and every one reaches the dock.**
`order` is UNCHANGED. The table is the defence, not a proposal.

| rank | key | why it earns the rank (an argument that is WRONG for another module) | what it costs below |
|---|---|---|---|
| 1 | `master` | The only control whose meaning does not depend on which of four identical jacks you patched, **and the module's only headroom control** — it cannot boost (`mixer.dsp:10`, max 1.0) while the sum is unbounded (`:12-17`). On a compressor or a filter, "the one downstream trim" would be the *least* interesting knob; here the summing law makes it the only one that can undo the module's one failure mode. Mini = MASTER + meter is literally the clip-management pair. | denies rank 1 to a channel — correct, because **one channel fader in isolation is useless**: you cannot balance with one knob. |
| 2 | `ch1` | **Arbitrary, and stated as arbitrary.** The tier ladder must emit a second cell; the four channels are interchangeable by construction; so it emits the first in jack order. No platform mechanism can make this non-arbitrary (see §3 LOSERS). | nothing — ranks 3-5 are its own peers. |
| 3-5 | `ch2`, `ch3`, `ch4` | Jack order, for the same reason. | — |

**THE LOSERS, NAMED.** There are none — five params, five ranks, all inside the 6-rank lane budget
(`curated-face.ts:46,65`). The interesting loss is **structural, not a ranking call**:

> **The four channel levels CANNOT be collapsed into one "balance" cell.** A `family` or `panel`
> cell drawing four faders would have to emit `control-ch1..control-ch4`, while `STRICT_FACES`
> completeness forces `ch1..ch4` to be ranked as params — and faces-parity asserts **exact
> multiset equality** between the dock's `control-*` testids and the def's param ids
> (`faces-parity.spec.ts:636-645`), so the duplicates fail. A `panel` is additionally forbidden
> from emitting `control-<paramId>` at all (`shell-cells.ts`). This is why the compact tile is
> master + one arbitrary channel, and no amount of face authoring fixes it.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

**2 pages → 1, and the argument is structural, not a fold budget.** `face.hero.control` PROMOTES
`master` out of its band (`heroFacePlan`, `dock-faceplate-model.ts`) — it does not copy it. The
`bus` band's only member therefore leaves, and `ModuleShell` guards the control row with
`{#if band.controls.length}` while rendering the `<section>` and `<h4 class="page-label">`
unconditionally. **Keeping two pages would ship a headed, empty band.** That is a consequence of
this face's own hero decision, measurable in the model without a browser.

`master` is still LISTED in the page (HARD RULE 2 — a hero can only move a key some band claims;
an unlisted key falls into the defensive `__unpaged` band). It is listed LAST so that reverting the
hero in one line yields signal order — sources, then the sum.

```ts
pages: [
  {
    id: 'channels',
    label: 'channel levels',
    hint:
      'each input times its own level, then all four are added — a plain sum, ' +
      'nothing here divides by four. Linear amplitude, so half travel is −6 dB ' +
      'and every real fade lives in the bottom third of the throw.',
    controls: ['ch1', 'ch2', 'ch3', 'ch4', 'master'],
  },
],
```

**Page id stays `channels`.** It matches the curated rear group id (`mixer.ts:138`), which is the
SAFE case, not the dx7 double-band bug: `rear-card-model.ts` gives the leading slot only to a
group id of `voice`/`signal`, and `channels` is claimed exactly once by the page loop. Renaming
either half alone desyncs the rear band — rename both or neither.

**Band label `channel levels` is unchanged and that is now MORE right than it was.** Round 2
proposed `channel levels → master`; with `master` in the hero that arrow would point at a knob
that is no longer in the row. The shipped string is correct as-is.

**Does the face read with EVERY hint hidden?** Yes, and the check is concrete. With annotation off
the dock paints: **`Bus`** / the module sentence / a big **MASTER** dial beside the live meter / a
readout strip reading `bus gain ×4.00 · +12.0 dB` and `unity at master 0.25` / a band headed
`channel levels` holding CH1–CH4 / a signal-flow column. Nothing load-bearing is in a hint: the
summing law is in `face.hint` (which still paints), the headroom number is in the readout strip,
and the "no limiter" fact is in the sidebar chain. The band hint carries only the linear-taper
teaching — genuinely annotation-tier.

---

## 5. THE HERO + THE READOUT STRIP

### `hero.cell` — **NONE. The channel-strip picture is the demoted `levels` glyph wearing a hat.**

The design program demoted a `levels` glyph for mixer (§2 DEMOTED table, "levels glyph (mixer)…
same class"). Deciding independently, as asked: **reject a bespoke `hero.cell` too**, on two
grounds that are stronger than the program's.

1. **A `cell` SUPPRESSES the meter.** `heroGlyph = hasGlyph && !(view === 'dock-full' &&
   hero?.cell)` (platform `ModuleShell.svelte:353`). Declaring a picture would trade the face's
   **only live measurement of the real bus** for a drawing. On the one module whose documented
   failure mode is a level, that is strictly worse.
2. **The only picture a mixer wants is per-channel POST-FADER levels, and it is not
   observable.** The gains live *inside* the Faust node (`mixer.dsp:13-16`); the `ChannelMerger`
   inputs (`mixer.ts:181-186`) are PRE-fader; `createShellGlyphTap` resolves taps only through
   `getOutputNode(nodeId, portId)` (`shell-glyph-live.ts:323`) — there is no input-tap seam. The
   sibling that *has* this picture built it a real seam: `mixmstrs` splits per-channel post-fader
   `GainNode`s into `AnalyserNode`s and exposes `read('levels')` (`mixmstrs.ts:298-306,398-403`).
   Giving mixer the same would be a factory rebuild (or a DSP change), i.e. **its own PR** — and
   a main-thread shadow gain would not match the ≈23 ms `si.smoo`, so the meter would lead the
   audio during every knob move.
3. And a picture drawn from *params only* is five knob values redrawn as bars, three inches from
   the five knobs. That is the wall of knobs with a graph on it.

So mixer keeps the generic `meter` glyph in the dock hero, and the picture question is closed.

### `hero.control` = `master` · `hero.action` = **NONE**

`master` for the rank-1 argument, unchanged: it is the only patch-independent control and the only
headroom control, and putting the big dial beside the live bus meter makes the top of the faceplate
read *"this submix, how loud it is, and the one knob that can pull it down."*

**No action.** MIXER is a pure processor with no voice — there is nothing to audition. (Contrast
kickdrum, which makes no sound at all until struck, which is why its strike is in the hero.) Stated
explicitly so the next author does not invent one; `getActiveEngine()` (`engine-ref.ts`) is
reachable and is *not* the blocker — there is simply nothing to trigger.

### THE READOUT STRIP — two entries, both DERIVED, from one DSP line

Correction 1 puts these in a full-width strip under the hero. **Both are `valueId`, and both are
new registry entries in `face-readout-values.ts`.**

```ts
hero: {
  control: 'master',
  readouts: [
    { label: 'bus gain', valueId: 'mixer-bus-gain' },
    { label: 'unity at', valueId: 'mixer-unity-master' },
  ],
},
```

**`mixer-bus-gain` — the FORMULA, traced.** From `mixer.dsp:12-17`, by the triangle inequality
`|out| ≤ (g1+g2+g3+g4)·gm · maxᵢ|inᵢ|`, tight when the four inputs are equal and in phase:

```
G = (ch1 + ch2 + ch3 + ch4) × master        →  print  `×G (±X dB)`,  X = 20·log10(G)
```

At the def defaults (`mixer.ts:72-76`, all five = 1.0): **G = 4.00 → +12.04 dB** — exactly the
number `mixer.ts:26-30`, `docs.explanation` (`:149`) and `DESCRIPTIONS` (`module-manifest.ts:223`)
already assert in prose. The readout prints the claim the docs make, live, and it moves when you
fix it. **TOTAL by construction**: `G <= 0` prints `silent` rather than `−∞ dB` (`readoutText`
runs on every frame of a drag).

**`mixer-unity-master` — a genuinely DIFFERENT function**, not the same number negated:

```
M = min(1, 1 / (ch1 + ch2 + ch3 + ch4))     →  print  `master M`     (Σ ≤ 0 → 1.00)
```

It is **invariant to `master`** where the first is not, and it is *actionable*: it names where to
put the dial directly above it. Set master to M and `bus gain` reads `×1.00 (0.0 dB)`. The two
readouts close the loop on the module's only hazard using its only headroom control.

**THE NEGATIVE CONTROLS — permanent, in a new `packages/web/src/lib/ui/modules/mixer-face-model.test.ts`**
(the `kickdrum-face-model.test.ts` precedent):

| leg | perturbation | `bus gain` | `unity at` | what it catches |
|---|---|---|---|---|
| **A** (the trap leg) | `ch3` 1.0 → 0.5 | +12.04 → **+10.88 dB** | 0.25 → **0.286** | **no single-param readback moves at all** — `master` still prints 1.00, `ch1` still prints 1.00. This is the leg that distinguishes a derived value from a relabelled knob. |
| **B** (must NOT move) | exchange `ch1`=0.4/`ch2`=1.0 → `ch1`=1.0/`ch2`=0.4 | **unchanged** | **unchanged** | catches an implementation that read one channel and multiplied by four; proves the metric is a function of the SUM, not of a privileged channel. |
| **C** (separates the two) | `master` 1.0 → 0.5 | +12.04 → **+6.02 dB** | **unchanged (0.25)** | proves the two readouts are different functions, and that `master` participates in one and not the other. Without C, one could be a copy of the other. |

**WHAT THESE READOUTS ARE BLIND TO — stated up front, because that is the discipline.**
`FaceReadoutValue` is `(read: (paramId) => number|undefined) => string` (`face-readout-values.ts`)
— params only, no engine, no store, no edge list. So the figure **cannot know which inputs are
patched** (an unpatched channel contributes silence but its gain still counts in Σ), how loud the
sources are, or whether they are correlated (four *uncorrelated* sources sum at +6 dB, not +12).
**The label carries the correctness**: `bus gain` is a statement about the SETTINGS — "this mixer
multiplies the worst case by 4" — which is true whatever is patched. It would be a lie if labelled
`output` or `peak`. Do not relabel it. Also: the printed value is the STEADY-STATE coefficient, so
during a ≈23 ms `si.smoo` glide it leads the audio by up to one time constant.

**Why not a third entry.** `master` would repeat the hero dial's own readout; per-channel dB values
are four knob readbacks; a count of open channels is visible on the knobs and is patch-blind too;
`text: '≈ 23 ms'` is dead in a live strip and already in `face.hint`. **Two live entries that both
earn their place beat four where two are noise.**

### `title` / `hint` (these still paint)

```ts
title: 'Bus',
hint:
  'Four mono inputs, each at its own level, added into one bus — a plain sum with ' +
  'no limiter and no headroom compensation, and MASTER can only attenuate.',
```

---

## 6. THE SIDEBAR — one `signal-flow` block

```ts
sidebar: [
  {
    kind: 'signal-flow',
    label: 'signal flow',
    stages: [
      { label: 'IN 1-4 × CH 1-4', role: 'bus', note: 'four peers, one law' },
      { label: 'SUM',             role: 'bus', note: 'plain add — no limiter' },
      { label: 'MASTER',          role: 'bus', note: 'attenuate only (≤ 1.0)' },
      { label: 'OUT',             role: 'bus', note: 'mono' },
    ],
  },
],
```

**Why `signal-flow` and not the other three.** It is the DSP's real order (`mixer.dsp:12-17`) and
it states permanently, on a clean face, the two things users get wrong: **nothing follows the sum**,
and **MASTER is downstream of it** (so it cannot fix balance, only level). No stage carries
`role: 'generator'` — correct, mixer generates nothing — and the renderer only prints the
generator/bus legend when a generator exists (`FaceSidebar.svelte`), so the block does not
advertise a swatch it never draws.

**⚠ The four channels are ONE stage on purpose.** The renderer is an `<ol>` — a linear chain — and
its only device for "off the spine" is `parallel`. Marking ch2-4 `parallel` against a ch1 spine
would **teach a false asymmetry on the one module whose entire design tension is that the four
channels are peers**, and a diagram that teaches the wrong chain is worse than none (the platform's
own words). Collapsing them to `IN 1-4 × CH 1-4` is honest: they are identical, and the note says so.

**Rejected, with reasons.** `presets`: a preset is a FULL recall, and on a mixer a full recall
replaces a *balance you tuned by ear against four live sources* — and any roster that sets ch3/ch4
to 0 privileges ch1/ch2 on a symmetric bank. A one-key `{ master: 0.25 }` entry avoids that but
breaks `activePresetId`, which matches on declared keys only and would light "safe" whenever master
happens to sit at 0.25 regardless of the channels — a false "this preset is loaded".
`readouts`: per-channel dB is four knob readbacks; an all-`text` spec sheet duplicates the doc page
and the flow block. `custom`: the only registered panel is `stereo-crossover`, and the panel mixer
would want is the rejected §5 picture.

**One-line revert if the owner disagrees:** delete the `sidebar` array. `sidebarPlan` returns
`null` and `DockFullView` drops the `.page.has-sidebar` column, restoring the full-width editor.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**No `ParamDef` range, curve, `options`, `landmarks` or `format` change.** A continuous linear
amplitude has no named detents and no waypoints, and `face.paramCells` requires a DISCRETE param —
all five are `curve: 'linear'` over 0..1, so no `'grid'` cell and no `momentary` entry is legal or
wanted.

**PF-4 port labels — ADD to the def, DELETE from the card (one source of truth).** The shell calls
`portsFromDef(def.inputs ?? [])` with **no** labels map, so on every migrated surface (the rear
card, the drill-down) mixer's holes read `IN1..IN4` / `AUDIO` from id derivation, while the legacy
card reads `INPUT 1..4` / `OUT` from its own map (`MixerCard.svelte:21-24`). Adopt the card's
EXISTING vocabulary onto the def — `in1..in4` → `'INPUT 1'..'INPUT 4'`, `audio` → `'OUT'` — then
delete both maps from the card so `labels[p.id] ?? p.label` (`card-kit.ts:62`) has one source.
Precedent: `vca.ts:61-70` already does exactly this. **Do NOT rename `OUT` to `MIX`** — the design
program warns against inventing vocabulary (§4), and round-2's `DIRECTION_SUFFIX` argument for the
rename is wrong (that regex strips a trailing `_in`/`_out` from a *compound* id; it can never match
the bare id `audio`, and the same file maps `out: 'OUT'` deliberately).

**RE-TYPED RANGES IN THE CARD — reported per the standard.** `MixerCard.svelte:33-37` re-types
`min={0} max={1} defaultValue={1} curve="linear"` on all five `<Fader>`s, duplicating
`mixer.ts:72-76`. **They AGREE today**, so this is a latent hazard, not a live bug — but it is the
exact single-source class CLAUDE.md is written about, and it is invisible to every def-reading gate.
It is *not* fixed by this PR (the fix is promoting `Fader` into the shell as a param-cell kind, a
platform PR). Flagging it so nobody records the audit as closed: round 2 did, off a grep pattern
that cannot see numeric literals.

---

## 8. COST

**Contract-lock: ZERO lines.** `serializeModuleContract` has no `face` or `docs` branch
(`contract-signature.ts:90+`), and `ContractPortLike` (`:55-63`) has no `label` field — `portLine`
(`:76-88`) emits id, type, paramTarget, cvScale, accepts, edge, adopts and nothing else.
**CHECKABLE PREDICTION:** `flox activate -- task docs:accept` must produce a **zero-line diff** in
`contract-lock.txt` (mixer's block is `:1800-1810`, 11 lines). If it moves, something in the change
is not contract-transparent — **stop and find out what; do not accept the diff.**

**ART: NIL.** `art/scenarios/mixer/profile.test.ts:83` pins `dspSourceSha('mixer.dsp')`, not a
def-source sha, so a face/docs/label edit cannot move the `.f32` or the `.sha`. **Attest: NIL** —
mixer is an audio def, not in the WebGL basis; no `docs-hash-ignore` markers needed.

**VRT.** Four mixer baseline PAIRS exist, not two — round 2's ledger named one of the two it missed:

| scene | verdict |
|---|---|
| `workflow-shell-faces.spec.ts/{darwin,linux}/face-mixer-dock.png` | **MOVES.** Header rows + hero rail + readout strip + one band instead of two + the `.page.has-sidebar` grid. This is a **dimension** change, so Playwright hard-fails on size before computing a ratio — NOT the A2 passing-but-stale hole. Belt and braces: `git rm` both, then dispatch (Playwright always writes a *missing* snapshot). |
| `workflow-shell-faces.spec.ts/{darwin,linux}/face-mixer-compact.png` | **MUST NOT MOVE.** Every PF-20 field is dock-only (the hero rail is inside `{#if dockBands}`) and `order` is unchanged. **A diff here is a FINDING, not a re-pin.** |
| `vrt.spec.ts/{darwin,linux}/mixer.png` — the legacy card, and it is in `STRICT_VRT_MODULES` (`vrt-exemptions.ts:886`), i.e. the **REQUIRED `vrt-strict` context** | **MUST NOT MOVE.** The card edit only deletes two label maps whose strings are byte-identical to the `PortDef.label`s being added, and the committed baseline shows the PatchPanel collapsed to two drill-down buttons — no port names are painted on that scene at all. **A diff here is a FINDING.** |
| `vrt-composite.spec.ts/{darwin,linux}/mixer-cv-sum.png` — SEQUENCER→MIXER→SCOPE summing (`vrt-composite-scenes.ts:1038-1049`) | **MUST NOT MOVE.** It shoots LANE cards, not the dock. **Round 2's ledger missed this scene entirely** ("VRT runs the same two mixer scenes"); its own MAJOR defect caught `vrt.spec` but not this one. |
| rear-card scene | none exists — `workflow-rear-card.spec.ts` has no mixer PNG (verified by `find`). |

**EXEMPTION DRAINS: NONE.** mixer has zero entries in `EXEMPT_BASELINE_PAIRS`; the vrt-meta linux
ratchet does **not** move. Procedure: regenerate darwin locally, then
`flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux` **UNSCOPED**
(a `-f grep=…` dies as `startup_failure`), then **approve** the follow-on runs — the bot's push
lands them in `action_required`, not `queued`.

**STRUCTURAL GATE, same commit:** `e2e/vrt/workflow-shell-faces.spec.ts:61`
`{ type: 'mixer', pages: 2 }` → `pages: 1`. The count assert it feeds is at `:227`. *(⚠ Round 2
told you to edit `:47` — that is adsr's row — and "corrected" the assert to `:222`. Both are wrong
against the current file. Grep the symbol.)*

**e2e:** faces-parity cell delta **0** — 5 params + 0 families before and after; the hero MOVES a
cell, it does not add one, and `heroFacePlanIsTotal` is what guarantees that. The sidebar renders
outside the `module-shell` subtree the gate scopes to, so it adds no cells. No new spec.

**Unit:** +1 file (`mixer-face-model.test.ts`, ~4 pure assertions) and +2 registry entries.

**CI wall-time: ≈ +0.1 s.** Arithmetic: 0 new faces-parity cells × ~0.8 s = 0 s; 0 new VRT scenes;
one pure-unit file with no DOM ≈ +0.05 s; the dock test does the same work with one band instead of
two. Nowhere near the ~2 min sign-off threshold — state the figure in the PR body anyway.

---

## 9. DEFECTS FOUND IN SHIPPED CODE

**DEFECT 1 — the level meter cannot show the event the docs tell users to watch it for.** MEDIUM.
- *What:* `docs.explanation` (`mixer.ts:149`) tells the user, of four unity channels clipping:
  *"watch the face's level meter (it reads the real bus, live) to see it happen."* It cannot. The
  tap returns `rmsUnit(buf)`, **clamped to [0,1]** at `level-meter.ts:24`; `VuMeter.toUnit` clamps
  again at `VuMeter.svelte:67`; `dbfsToUnit` returns `1` for any `db >= 0` at
  `vu-meter-model.ts:27`. A bus at exactly 0 dBFS and a bus at +12 dBFS render an **identical full
  meter**. Independently, RMS over a 2048-sample (~43 ms) window is not a peak detector — a sparse
  percussive sum peaking at 1.5 can read an RMS of ~0.15, i.e. a meter at 15 % **while clipping**.
  The def's glyph rationale (`mixer.ts:104-108`) rests on the same assumption.
- *Cost:* the module's headline hazard has no panel indication at all, and the docs actively point
  the user at an instrument that is invariant to the dimension under test — CLAUDE.md's
  "VALIDATE THE INSTRUMENT" failure, shipped as documentation.
- *Could a test catch it?* Not today; nothing asserts anything about what the meter reports at
  over-unity input. A test *can*: feed `rmsUnit` a ±1.5 buffer and assert the reported value is
  distinguishable from a ±1.0 buffer. It is not.
- *Fix (a SEPARATE PR, not this face):* PF-18 — add `getPeak()` to `ShellGlyphTap` as `max(|s|)`
  over the same buffer, **UNCLAMPED** (it genuinely sees >1: the analyser attaches to the Faust
  node itself, `mixer.ts:187`, upstream of any destination clamp), plus an `over?: () => boolean`
  OVER lamp on `VuMeter` that is render-inert when false. It **must** ship with a two-legged
  negative control (drive 1.5 → lamp lights; drive 0.9 → it does not). ⚠ `VuMeter` is shared by
  every `glyph: 'meter'` face plus the moog914 card family, so it moves all their baselines and
  needs its own VRT pass. **Do not fold it into this face wave.**
- *Meanwhile:* this spec's `bus gain` readout is the honest, zero-platform-cost substitute — it
  says the thing the meter cannot, from the params, and it is negative-controlled.

**DEFECT 2 — `mixer.ts:99` self-contradicts eleven lines after the argument it breaks.** MINOR /
comment-only. The compact tile is described as reading "SOURCE · BUS · LEVEL" (three roles for two
knobs), and it names `ch1` as the source right after `:88-90` argues that picking `ch1` over
`ch2/3/4` is arbitrary. No test can catch a comment; the fix is the honest sentence in §3.

**No audio or wiring defect found.** Specifically checked and CLEAR: the `ChannelMerger(4) →
FaustMonoAudioWorkletNode` wiring (`mixer.ts:181-186`, `faust-runtime.ts:59-66`) — the node is
built from the DSP factory's own metadata, so all four merger channels reach the DSP, and mixer
carries no entry in either `per-module-per-port` exemption map (grep), so the registry-driven
sweep drives all four inputs (inference from absence). The card re-types the def's ranges but they
AGREE — reported in §7 as a latent hazard, not counted here as a bug.

---

## 10. VERIFICATION GATE

In order. Every row is a real command; none of it was run while writing this spec.

```sh
# 1. THE NEGATIVE CONTROLS FIRST — if these do not hold, the readouts are knob readbacks.
REPEAT=3 flox activate -- task test:one -- mixer-face-model
#    legs A (ch3 moves the derived, no knob readback moves), B (an exchange must NOT move it),
#    C (master moves `bus gain` and must NOT move `unity at`).

# 2. The declaration gates.
flox activate -- task test:one -- module-face-lint      # valueId registered, hero ranked, sidebar non-empty
flox activate -- task test:one -- dock-faceplate-model  # heroFacePlanIsTotal over every faced module
flox activate -- task test:one -- contract-lock         # must be UNCHANGED
flox activate -- task docs:accept && flox activate -- git diff --stat packages/web/src/lib/docs/contract-lock.txt
#    → MUST be zero lines. A diff here means something is not contract-transparent: STOP.

flox activate -- task typecheck

# 3. Parity + the structural gate.
flox activate -- task e2e:serve
flox activate -- task e2e:one -- "faces render-parity" # 5 control-* testids, exact multiset
flox activate -- task e2e:one -- tests/workflow-shell-faces.spec.ts

# 4. VRT — the two that MUST NOT move, before the one that must.
flox activate -- task vrt:one -- mixer            # legacy card + compact: expect PASS, untouched
#    a diff on vrt.spec.ts mixer.png or face-mixer-compact.png is a FINDING — investigate, do not re-pin.
flox activate -- git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/{darwin,linux}/face-mixer-dock.png
#    then regenerate darwin locally and dispatch linux UNSCOPED:
flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux
#    the bot's push lands the follow-on runs in `action_required` — APPROVE them.

flox activate -- task e2e:stop
```
