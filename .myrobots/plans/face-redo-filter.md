# face re-do — filter

> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID.** PF-21 dock ROW
> PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built** —
> the module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.
> ✅ The re-do ledger's filter defect (#7, `FilterCard`'s origin-less `t.params.mode = m`)
> **is FIXED** — see `FilterCard.svelte:21`.

**Verdict: REAL REWORK — but STRICTLY ADDITIVE.** `order`, `pages` membership, `glyph` and `rear`
are correct today and stay **byte-identical**; the rework is the PF-20 surface this face predates —
a `title`/`hint`, a hero strip of **three genuinely derived readouts** (the two CV-jack REACH
windows and the resonant PEAK, none of which is any knob on the panel), and a **`custom` sidebar
MAGNITUDE-RESPONSE panel** that draws the one picture a VCF is, and that — unlike the shipped
`scope` glyph, which is a flat line in both committed baselines — is alive on a silent rack.

Written against `origin/feat/faceplate-platform-v2` (PR #1301 — **MERGED**, `c6ff9253`) + the two owner
corrections (readouts BELOW the graphic as a strip; band hints are ANNOTATION-only).
Every `file:line` below was re-grepped in this worktree, not copied from a plan.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**Signal path** (`packages/dsp/src/filter.dsp`, 21 lines): `audio` fans into `fi.resonlp` /
`fi.resonhp` / `fi.resonbp`, all three running **continuously** (`:18-20`), and `ba.selectn(3,
int(modeKnob))` picks exactly one (`:10`). Branch order `(lp, hp, bp)` ⇒ mode 0 = LP, 1 = HP,
2 = BP, which the def's `options` roster agrees with (`filter.ts:113-117`).

**The two derived quantities** (`filter.dsp:13-16`):
`fc = (cutoffKnob · 2^(5·cutoffCv)) : max(20) : min(20000) : si.smoo` — the CV is **exponential,
±5 octaves at full scale**, and the **clamp lands BEFORE the smoother**;
`q = (resKnob + resCv) : max(0) : min(0.99) : si.smoo`, then **`Q = q·20 + 0.7`**.

**`si.smoo` is exactly 7 Hz and sample-rate independent.** `signals.lib:213` defines
`smoo = si.smooth(1 - 44.1/ma.SR)` ⇒ corner `44.1/(2π) = 7.02 Hz`, τ ≈ 22.7 ms, at any SR. The def's
"~7 Hz one-pole" claim (`filter.ts:16-19`) is **exact**, and it is why neither jack is FM-able and
why `face.rear` correctly declares **no `audioRate` ticks**.

**The transfer functions, read from the actual library** (Faust 2.85.5 `filters.lib`, at
`/nix/store/…-faust-2.85.5/share/faust/filters.lib` — NOT vendored in the repo, which is why round-2
called this unverifiable; it is verifiable, the file is on the box the DSP compiles on):

| mode | `filters.lib` | H(s), normalised s = jω/ω_c |
|---|---|---|
| LP | `:2185-2194` `tf2s(0,0,gain, 1/Q,1, ωc)` | `1 / (s² + s/Q + 1)` |
| HP | **`:2228` `resonhp(fc,Q,gain,x) = gain*x - resonlp(fc,Q,gain,x)`** | `s(s + 1/Q) / (s² + s/Q + 1)` |
| BP | `:2263-2272` `tf2s(0,gain,0, 1/Q,1, ωc)` | `s / (s² + s/Q + 1)` |

Four facts fall out of that table, and **two of them contradict what the module ships as prose**
(→ §9):

1. **The HP is literally input-minus-lowpass.** Its numerator carries a second zero at `ω = 1/Q`,
   i.e. `f = fc/Q`. Above that break it is 12 dB/oct; **below it the stopband tapers at only
   6 dB/oct.** At the shipped resonance default (0.1 ⇒ Q 2.7) the break is `1000/2.7 = 370 Hz`;
   at `resonance = 0` (Q 0.7) it is `1429 Hz` — **above the corner**, so a zero-resonance highpass
   is a ~6 dB/oct filter across its entire audible stopband. **The HP's bass rejection is a function
   of RESONANCE**, which no label on the panel says.
2. **The BP has 6 dB/oct skirts**, not 12 — a single-zero, two-pole bandpass.
3. **Nothing is gain-compensated.** LP/HP passbands sit at unity as Q rises, so the corner peak is a
   real level increase into the next stage; the **BP's whole output scales with Q**, so at
   `resonance = 0` it is 3.1 dB *down* at its own centre and reaches unity only at Q = 1
   (`resonance = 0.015`).
4. **It cannot self-oscillate.** `a1 = 1/Q > 0` for every reachable Q (min 0.7) ⇒ ζ = 1/(2Q) ≥ 0.024,
   so the poles never reach the imaginary axis. The def says this correctly (`filter.ts:204`).

**Peak magnitude, computed from the table above** (the number the readout strip prints):

| `resonance` | Q | LP | HP | BP |
|---|---|---|---|---|
| 0 | 0.70 | 0.00 dB (no peak — Q < 1/√2) | +2.06 dB | −3.10 dB |
| **0.1 (default)** | 2.70 | +8.78 dB | +9.30 dB | +8.63 dB |
| 0.99 | 20.50 | +26.24 dB | +26.24 dB | +26.24 dB |

The three modes **converge above ~Q 5 and diverge by 5.2 dB at Q 0.7** — exactly the perturbation
the derived readout's negative control needs (§5).

**LOAD-BEARING vs INERT AT SPAWN.** `cutoff`, `resonance` and `mode` are live and audible on any
input the moment the module spawns. **`cutoff_cv_amt` and `res_cv_amt` are completely inert at
spawn** — structurally, not by default-value accident: each is an engine-graph `GainNode`
(`filter.ts:229-236`) whose **input is the CV jack itself** (`:254-258`), so with nothing patched
the node has no input, outputs zero, and the merger channel reads 0 regardless of the gain. Turning
either knob on a fresh spawn does *literally nothing* until a cable lands. **Two of the face's five
ranked controls are dead until patched**, and no surface says so — the strongest single argument for
the readout strip in §5.

**The measurable fact worth printing.** From the 1000 Hz default at depth +1, a full-scale CV
reaches `1000 · 2^±5` = **31.25 Hz … 32 000 Hz, clamped to 20 000** — 5.00 octaves down but only
**4.32 up**, because the ceiling bites. That clamp is the module's headline hazard (a plain 0..1
envelope at the shipped default pins the corner at 20 kHz) and it is invisible on every surface.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

**The ranking, the two bands, the rear curation and the glyph CHOICE are right, and I am not
touching them.** The design program's Batch-D entry already reached that conclusion
(`dx7-and-faces-design-program-2026-07-27.md:919-936`) and the PF-1 `options` remedy it listed as
the one open item **already landed** (`filter.ts:112-117`, pinned end-to-end by
`e2e/tests/faces-parity.spec.ts:728-786`). Inventing a re-ranking here would be the program's own
§7 anti-pattern. The genuine gaps are all PF-20-shaped, plus two that predate it:

1. **No `title`, no `hint`.** `facePageHeader` returns `null` for this face
   (`dock-faceplate-model.ts:70-76`), so the faceplate opens with no statement of what the module
   is. Confirmed on the shipped baseline `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/
   darwin/face-filter-dock.png`: the page goes straight from the `FILTER / FILTERS` chrome to the
   glyph box.
2. **THE HERO GRAPHIC IS A FLAT LINE, in both committed baselines.** `glyph: 'scope'`
   (`filter.ts:165`) binds to the module's own audio output, and the dock scene spawns filter with
   nothing patched — so the shipped `face-filter-dock.png` shows a 214 px black box
   (`--dock-hero-glyph-w`, `ModuleShell.svelte:1223`) with one horizontal line through it, and
   `face-filter-compact.png` shows the same at tile size. The glyph is not *wrong* — it is
   genuinely the best live trace for a filter — but the face has **no picture that is alive when
   the rack is silent**, which is most of the time a player is looking at it.
3. **The glyph does not render at the `full` lane tier at all.** `laneBodyPlan(5, true, 'full')`
   → `rows = ceil(5/3) = 2` → `glyph: false` (`module-shell-model.ts:331-345`). So the face's only
   picture exists at mini/compact/dock and is absent at the tier the lane parks on after a spawn
   reveal (`faces-parity.spec.ts:737`). That is the price of ranks 4 and 5, it is already paid, and
   it is another reason the picture should not be the glyph alone.
4. **Two ranked controls are inert at spawn and nothing says so** (§1). Band 2 is labelled
   `cv depth` — a name, not a statement that both knobs are no-ops until a jack is patched.
5. **The dock rear card prints `AUDIO` on both the input hole and the output hole.**
   `ModuleShell.svelte:471` calls `portsFromDef(def.outputs ?? [])` with **no** overrides map;
   the legacy card passes `{ audio: 'OUT' }` (`FilterCard.svelte:26`). With no `PortDef.label`,
   `expandStem` falls to `ABBREV_TO_VERBOSE.audio = 'AUDIO'`
   (`packages/web/src/lib/ui/patch-panel-labels.ts:106`), so the migrated rear says AUDIO twice,
   disambiguated only by rail side. One-line fix, contract-transparent (§7).
6. **The `12 dB/oct` claim is wrong for HP and BP** in the two `options` tooltips a player actually
   hovers (`filter.ts:115`, `:116`) — see §9.

---

## 3. THE ~8 CONTROLS THAT MATTER — filter has FIVE

| rank | key | why it earns this rank (an argument that is WRONG for another module) | what it costs the ranks below |
|---|---|---|---|
| 1 | `cutoff` | The hero, and it survives the inertness test: live at 1000 Hz, mid-travel on a log taper, audible on ANY input regardless of every other setting. On a filter that **could self-oscillate**, `resonance` would compete for the single-knob mini slot because the module would make sound with nothing patched — this one demonstrably cannot (§1 fact 4), so it does not. | takes the mini tier outright. |
| 2 | `resonance` | The second hand, live at 0.1 (Q 2.7 — already an +8.8 dB peak, not a token default), and independently audible. `cutoff` + `resonance` + the trace IS the compact tile. | fills the 2-cell `compact` cap (`faceTierCap('compact', true) = 2`, `curated-face.ts:77`). |
| 3 | `mode` | It **re-frames what the hero MEANS** — dark vs thin vs narrow — so a lane tile must answer it at a glance. Ranked below `resonance` and not above it because it is a set-once switch, not a performance control: no player's hand rides LP→BP. | third plate cell. |
| 4 | `cutoff_cv_amt` | EG → cutoff is the most common patch in any rack, and the mapping is **±5 octaves per full-scale CV** (`filter.dsp:13`), so a plain 0..1 envelope at the +1 default pins the corner at the 20 kHz ceiling. This is the knob you reach for *immediately after patching*, before you touch anything else. | — |
| 5 | `res_cv_amt` | The same trim on the resonance scale, but a refinement rather than a rescue: an un-trimmed res CV saturates at 0.99 and sounds *loud*, not broken. Kept **adjacent** to rank 4 because they read as one modulation stage. | fills the 6-cell `full` plate with one slot spare. |

**THE LOSERS, NAMED.** There are none — the module has exactly five params and all five are ranked
(`filter.ts:147`), which `module-face-lint`'s completeness clause requires of every `STRICT_FACES`
member (`strict-faces.ts:59`). **That is a finding, not a shortfall:** `filter.dsp` declares exactly
three UI elements (`:6` `hslider`, `:7` `hslider`, `:8` `nentry`) and the def's other two params are
engine-graph gains, so **the def is a strict superset of the DSP — there is zero un-exposed DSP
capability to promote.**

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

Membership and ids are **UNCHANGED** from `filter.ts:156-159`. Only the `hint`s are new, and they
paint **only in annotate mode** (`annotate-mode.svelte.ts`), so they are enrichment, never load-bearing.

```ts
pages: [
  {
    id: 'response',
    label: 'response · type',
    controls: ['cutoff', 'resonance', 'mode'],
    hint:
      'three two-pole sections run in parallel on the input and MODE picks one — the switch is ' +
      'instantaneous and un-crossfaded, so it can click under a loud signal. RES maps to ' +
      'Q = res × 20 + 0.7 and is NOT gain-compensated: the peak adds up to +26 dB on top of an ' +
      'unchanged passband. It rings; it never self-oscillates.',
  },
  {
    id: 'modulation',
    label: 'cv depth',
    controls: ['cutoff_cv_amt', 'res_cv_amt'],
    hint:
      'attenuverters on the two CV jacks — and they are ENGINE gains on the jacks themselves, so ' +
      'with nothing patched both knobs do nothing at all. Full scale on CUTOFF CV is ±5 octaves; ' +
      'negative inverts. Both paths are smoothed at 7 Hz, so these are modulation inputs, not FM.',
  },
],
```

**⚠ The page ids must NEVER become `signal` or `voice`.** `face.rear.groups[0].id` is `signal`
(`filter.ts:180`); a page id colliding with the LEADING rear group renders that band twice
(`rear-card-model.ts` consumes the leading group before the page loop re-finds it — the dx7 bug).
`modulation` colliding with the *non*-leading rear group `modulation` (`filter.ts:181`) is the
INTENDED claim path and is safe. State this in the face comment; nothing enforces it.

**Does the face read correctly with every hint hidden? Yes.** `response · type` over three cells
where the third is a `LP | HP | BP` Segmented is self-describing; `cv depth` over two cells named
`CUTOFF CV` / `RES CV` is self-describing. The one fact the hints carry that a player genuinely
needs — *these two knobs are dead until you patch something* — is **not** left to the hint: it is in
the readout strip, where `CV REACH` collapses to a single frequency the moment depth hits 0. No
band label is asked to be a sentence.

---

## 5. THE HERO + THE READOUT STRIP

### 5a. Does filter need a bespoke `hero.cell` PICTURE? **NO — and the reason is structural, not aesthetic.**

The design program demoted a generic **`response` GLYPH KIND** for a generalisation argument
(`dx7-and-faces-design-program-2026-07-27.md:118`: "the reuse justification fails on 5 of the 6
modules it names"). That argument does **not** transfer to a bespoke `hero.cell` — a PF-14 panel is
per-module by construction (`graph/types.ts`, `ModuleFaceHero.cell`: "THE PICTURE IS THE ONE HALF OF
A FACEPLATE THAT CANNOT BE PLATFORM"). So I answered it on the merits, and the merits say the
picture is right but **the hero slot is the wrong place to put it on this module**:

- **A `hero.cell` is a RANKED cell and its first legal rank is 7** (`module-face-lint.test.ts`
  `panelTierProblems`, negative-controlled at `:658-682`: rank 7 passes, any lane-selected rank
  fails). filter has **five** params, so a panel would land at **rank 6** — inside
  `faceTierCap('full') = LANE_PLATE_MAX_CELLS = 6` (`curated-face.ts:46,65`) — and **fail the lint
  outright.** The only escape is a 6th ranked non-param cell; the natural one, an audition, would
  have to synthesise a test signal (a DSP change) on a module that is an insert with no voice of its
  own. **Inventing an audition to satisfy a rank constraint is the wrong reason to add a control.**
- A `hero.cell` also **suppresses the dock glyph** (`ModuleShell.svelte:353`
  `heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)`), so it trades the live trace away
  rather than adding to it.
- The road not taken, costed: 1 `ControlFamily` = **+1 contract-lock line**
  (`contract-signature.ts:124-126`), 1 `shell-cells.ts` panel entry with a mandatory operability
  probe, 1 component, 1 `docs.controls` key. **A `custom` SIDEBAR panel gets the same picture for
  ZERO contract lines and no probe** (`sidebar-panels.ts` rule 2: "A panel READS; it does not own
  state") in a 288 px column (`_dock-faceplate.css:45,312-313`) — ~258 px of content, ample for a
  magnitude curve. **→ §6.**

**`hero.control: 'cutoff'`.** Rank 1, the one knob a hand rides, and the only control whose value a
player wants big enough to read across a room. **`hero.action`: NONE — declared absent, not
forgotten.** A filter is an insert; there is nothing to audition without an input, and
`getActiveEngine()` (`packages/web/src/lib/audio/engine-ref.ts`) being reachable from plain `.ts`
does not make an audition *musically* correct here. (Naming this explicitly because two round-2
agents invented a platform blocker around that exact seam.)

The hero graphic therefore stays the **`scope` glyph** — and the readout strip sits **full-width
directly beneath it** (owner correction 1), not inline in `.hero-side` as `ModuleShell.svelte:917`
renders it today.

### 5b. THE READOUT STRIP — three entries, all three genuinely DERIVED

```ts
hero: {
  control: 'cutoff',
  readouts: [
    { label: 'peak',      valueId: 'filter-peak-db' },
    { label: 'cv reach',  valueId: 'filter-cutoff-reach' },
    { label: 'res reach', valueId: 'filter-res-reach' },
  ],
},
```

**Nothing here repeats a knob.** `cutoff` is the hero dial (it prints its own value), `resonance`
and `mode` are cells in band 1, and none of the three strings below is any param's value.

**(1) `filter-peak-db` — "+8.8 dB".** The gain the corner adds into whatever comes next.

- **FORMULA**, mirroring `filter.dsp:16` and the closed forms of `fi.reson{lp,hp,bp}`
  (`filters.lib:2185-2194`, `:2228`, `:2263-2272`):
  `Q = 20·resonance + 0.7`; then
  LP → `Q ≤ 1/√2 ? 0 dB : 20·log10(Q / √(1 − 1/(4Q²)))`;
  BP → `20·log10(Q)`;
  HP → `20·log10(max_ω |jω(jω + 1/Q) / (1 − ω² + jω/Q)|)` (closed form; a 200-point ω scan is the
  acceptable implementation and is what the model module should do, so the code cannot drift from
  the algebra).
- **NEGATIVE CONTROL (permanent):** hold `resonance = 0` and flip `mode` 0 → 2. The printed value
  moves **0.00 dB → −3.10 dB**; a `resonance` readback is completely invariant to it. Flip 0 → 1 and
  it moves to **+2.06 dB**. The perturbation point matters and the test must pin it: the three modes
  **converge above ~Q 5** (all three read +26.24 dB at `resonance = 0.99`), so a negative control run
  at max resonance would pass on a `resonance`-only model. *That convergence is itself the fact the
  readout teaches.*
- **SECOND LEG THAT MUST NOT MOVE:** perturb `cutoff` 1000 → 8000, and `cutoff_cv_amt` 1 → 0.2. The
  peak must not change by one digit — the magnitude response is frequency-scale-invariant. A model
  that accidentally reads a frequency fails this leg.

**(2) `filter-cutoff-reach` — "31 Hz – 20 kHz".** Where a full-scale CV can throw the corner. This
is the module's headline hazard made visible.

- **FORMULA**, mirroring `filter.dsp:13` **including its clamp order** (clamp, then smooth — the
  smoother is irrelevant to the endpoints):
  `lo = clamp(cutoff · 2^(−5·|cutoff_cv_amt|), 20, 20000)`,
  `hi = clamp(cutoff · 2^(+5·|cutoff_cv_amt|), 20, 20000)`. `|·|` because a negative depth inverts
  the direction but reaches the same two endpoints. At depth 0 the window degenerates to the knob
  and the readout prints `1.0 kHz · muted` — which is the honest thing to say about an inert knob.
- **NEGATIVE CONTROL (permanent):** hold `cutoff_cv_amt = 1` and move `cutoff` 1000 → 8000. The
  string moves **"31 Hz – 20 kHz" → "250 Hz – 20 kHz"** and the reachable span collapses from
  **9.32 to 6.32 octaves** — because the 20 kHz ceiling (`filter.dsp:13` `min(20000)`) eats the top.
  A `cutoff_cv_amt` readback prints `1.00` in both cases. **This is the leg that proves the readout
  models the CLAMP and not the knob.**
- **SECOND LEG THAT MUST NOT MOVE:** perturb `resonance` and `mode` — the window is unchanged.

**(3) `filter-res-reach` — "0.00 – 0.30".** The travel a patched modulator actually has on the
resonance scale. The weakest of the three; if review wants a two-entry strip, **cut this one**.

- **FORMULA**, mirroring `filter.dsp:14`: `lo = clamp(resonance − |res_cv_amt|, 0, 0.99)`,
  `hi = clamp(resonance + |res_cv_amt|, 0, 0.99)` — additive on the 0..0.99 scale, not exponential.
- **NEGATIVE CONTROL (permanent):** at `res_cv_amt = 0.2`, move `resonance` 0.1 → 0.9. The string
  moves **"0.00 – 0.30" → "0.70 – 0.99"**, and the *upward* travel silently shrinks from 0.20 to
  **0.09** because the 0.99 ceiling clamps. The depth knob reads `0.20` throughout.
  ⚠ The test must NOT use the shipped depth default of 1.0: at depth 1 both ends saturate and the
  string is `"0.00 – 0.99"` for every resonance — the readout is genuinely constant there, so a
  negative control run at the default would fail for a correct model. Pin the perturbation.
- **SECOND LEG THAT MUST NOT MOVE:** perturb `cutoff` and `mode`.

**Where the negative controls live permanently:**
`packages/web/src/lib/audio/modules/filter-face-model.test.ts` (the `kickdrum-face-model.test.ts`
precedent), driving `packages/web/src/lib/ui/modules/filter-face-model.ts`, with the three ids
registered in `packages/web/src/lib/ui/workflow/face-readout-values.ts`. Pure arithmetic, no DOM,
no engine — unit lane, ~0 CI cost.

**What I am NOT proposing, and why.** A **`Q` readout**. It is tempting (the knob prints `0.10`, the
DSP uses `2.7`) but `Q = 20·res + 0.7` is invariant to *everything except* `resonance` — I cannot
name a perturbation that moves it while a `resonance` readback stays put, so by the platform's own
bar (`face-readout-values.ts` header: "negative-controlled on the input a knob readback would be
BLIND to") **it is a unit conversion, not a derivation, and it does not belong in the registry.**
The Q law goes in the band-1 annotation hint and on the sidebar plot's axis instead. Declaring it as
a `valueId` with a fabricated negative-control story would be the exact defect this section exists
to prevent.

---

## 6. THE SIDEBAR — one `custom` block + one `presets` block

```ts
sidebar: [
  { kind: 'custom', label: 'response', panelId: 'filter-response',
    props: { cutoffParam: 'cutoff', resParam: 'resonance', modeParam: 'mode',
             depthParam: 'cutoff_cv_amt' } },
  { kind: 'presets', label: 'starting points', entries: [ /* below */ ] },
],
```

**`custom` / `filter-response` — the magnitude curve.** This is where the picture from §5a lives.
A log-frequency plot, 20 Hz–20 kHz, of the **selected mode's actual transfer function** at the live
`cutoff`/`resonance`, with a **shaded band showing the CV REACH window** so the picture and the
strip's first readout are the same fact drawn twice. It is param-derived, so it is **alive on a
silent rack** — the one thing the `scope` glyph structurally cannot be — and it makes the three
facts §1 lists visible rather than merely true: the HP's 6 dB/oct tail below `fc/Q`, the BP's
3 dB centre dip at zero resonance, and the uncompensated peak riding on an unmoved passband.
**COST, stated per §1 rule 9: one component + one line in `sidebar-panels.ts`. ZERO contract lines,
no `ControlFamily`, no operability probe** (sidebar panels render outside the ModuleShell subtree
and own no state). It must reuse the SAME arithmetic module as `filter-peak-db`, not re-derive it —
one source of truth for the response law.
*Inference, labelled:* I have not measured the rendered curve; the claim it fits is arithmetic on
the 288 px column (`_dock-faceplate.css:45`) less 30 px padding.

**`presets` — four COMPLETE recalls.** filter has five params, so "complete param set" is trivially
achievable here and there is no excuse for a partial recall. Every value re-checked against
`filter.ts:94-119` ranges; every entry writes **all five**:

```ts
entries: [
  { id: 'gentle',   label: 'gentle lp',   note: '12 dB/oct',
    values: { cutoff: 1200, resonance: 0.05, mode: 0, cutoff_cv_amt: 1,   res_cv_amt: 1 } },
  { id: 'squelch',  label: 'squelch',     note: '+24 dB peak',
    values: { cutoff: 400,  resonance: 0.85, mode: 0, cutoff_cv_amt: 0.4, res_cv_amt: 0.3 } },
  { id: 'rumble',   label: 'rumble cut',  note: 'hp @ 120',
    values: { cutoff: 120,  resonance: 0.30, mode: 1, cutoff_cv_amt: 0,   res_cv_amt: 0 } },
  { id: 'eg-ready', label: 'eg sweep',    note: '±1 oct',
    values: { cutoff: 500,  resonance: 0.45, mode: 0, cutoff_cv_amt: 0.2, res_cv_amt: 0 } },
]
```

`eg-ready` is the one that earns the block: **`cutoff_cv_amt: 0.2` is exactly the ±1-octave trim**
(`2^(5·0.2) = 2`) that the module's headline hazard needs, and a roster entry teaches it in one
click where three paragraphs of docs have not. `rumble` deliberately zeroes both depths, so
selecting it demonstrates the strip collapsing to `120 Hz · muted`.

**Why not `signal-flow`.** filter's chain is one stage. The three sections are **selected among**,
not chained, and `FaceFlowStage.parallel` means "taps the bus earlier and rejoins it further down"
(`graph/types.ts`) — which is not what `ba.selectn` does. A diagram that teaches the wrong topology
is worse than none (the platform's own words). **Why not `readouts`.** Redundant with §5b.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**Proposed, all contract-transparent:**

1. **`{ id: 'audio', type: 'audio', label: 'out' }`** on `filterDef.outputs` (`filter.ts:92`). Fixes
   the AUDIO/AUDIO rear card (§2.5). `portLine` (`contract-signature.ts:78-88`) has no label branch;
   `PortDef.label` documents itself as contract-transparent (`graph/types.ts:245-268`) and both
   consumers honour it. **0 contract lines.**
2. **Correct the two wrong `options` tooltips** (`filter.ts:115`, `:116`) — see §9 defect A. `title`
   is asserted **nowhere**; `faces-parity.spec.ts:776` pins only `toHaveText(['LP','HP','BP'])`, so
   this costs zero test churn. `contract-signature.ts:108-111` emits id/min/max/curve/default/units
   and nothing else, so the roster is already contract-transparent (line 1120 of `contract-lock.txt`
   still reads `filter param mode 0..2 discrete default=0`).

**Rejected:** a `format` on `resonance` that prints Q — the knob must print what it *writes*
(0..0.99), and re-labelling it would put the panel and the contract into disagreement.
**Rejected:** a `mode` MORPH param and a 24 dB/oct `slope` param — both are real DSP + a contract
line + an ART re-pin, and the morph would additionally break the Segmented render (a crossfade has
real in-between states ⇒ `landmarks` vocabulary, not `options`). Never fold a DSP change into a face
wave.

**Re-typed ranges in the card — grepped, all reported:**

| `FilterCard.svelte` | re-typed | vs def | status |
|---|---|---|---|
| `:35` | `min={20} max={20000} defaultValue={1000} units="Hz" curve="log"` | `filter.ts:94` | **AGREES — hazard, not a live bug** |
| `:36` | `min={0} max={0.99} defaultValue={0.1} curve="linear"` | `filter.ts:95` | **AGREES — hazard** |
| `:15-16` | `filterDef.params[0]!` / `[1]!` — **positional** indexing | — | reordering `params` silently rebinds both defaults |
| `:20` | `const MODES = ['LP','HP','BP']` | `filter.ts:113-117` | **second source of truth** for the vocabulary the def now declares |

None diverges *today*, so this is the backdraft class one edit before it bites, and every def-reading
gate is blind to it. **Fix by importing from `filterDef.params.find(p => p.id === …)`, not by adding
controls.** Do **NOT** "fix" the card's bigger hole — it exposes only 3 of the 5 params
(`cutoff_cv_amt` / `res_cv_amt` have no control there at all) — by adding two faders: the card is the
surface being retired, and the FACE is what closes that gap.

---

## 8. COST

- **contract-lock: ZERO lines.** `filter`'s block is `contract-lock.txt:1113-1122` (1 meta + 3 in +
  1 out + 5 param) and stays byte-identical. Three independent reasons, each checked against the
  projector: (a) no new param/port/`ControlFamily` — and the response picture is a **sidebar** panel
  precisely so it needs no family (`contract-signature.ts:124-126` is the only family branch);
  (b) `face.*` is never projected at all; (c) `PortDef.label` and `options.title` have no branch.
  **`task docs:accept` must produce an EMPTY contract diff** — a non-empty one means something
  unintended moved. Stop and read it; do not re-pin.
- **VRT — THREE baseline pairs exist for filter, not two:**
  - `workflow-shell-faces.spec.ts/{darwin,linux}/face-filter-dock.png` — **MOVE** (title + hint rows,
    the readout strip, the 288 px sidebar column). Well over `DOCK_MAX_DIFF = 1500`
    (`workflow-shell-faces.spec.ts:79`) — a whole new column cannot hide under it.
  - `workflow-shell-faces.spec.ts/{darwin,linux}/face-filter-compact.png` — **MUST NOT MOVE.** Every
    PF-20 field is dock-only; the compact tile holds 2 cells + the glyph. **A diff here is a finding,
    not a re-pin.**
  - `vrt.spec.ts/{darwin,linux}/filter.png` — the LEGACY card, and **`filter` is in
    `STRICT_VRT_MODULES` (`e2e/vrt/vrt-exemptions.ts:883`), i.e. the REQUIRED `vrt-strict` lane.**
    The §7 card fixes (import ranges, route the mode write) are pixel-neutral, so this **MUST NOT
    MOVE** either — a diff is a finding.
  - ⚠ **`git rm` the two `face-filter-dock.png` files BEFORE dispatching `vrt-update.yml`.** filter
    is where the sub-tolerance trap was *set*: A2/#1213's knob→Segmented swap moved this exact scene
    865 px — under the 1500 px gate — and `--update-snapshots` committed zero files, twice.
  - No `EXEMPT_BASELINE_PAIRS` drain: neither `linux/face-filter-*` pair is listed, and the
    linux-deficit ratchet does not move.
  - Structural gate: `workflow-shell-faces.spec.ts:60` stays `{ type: 'filter', pages: 2 }`.
- **e2e:** faces-parity cell-count delta **0** (5 params, 0 families, before and after). No new
  bespoke spec — `faces-parity.spec.ts:728-786` already covers `mode` end-to-end, and the sidebar +
  readouts are covered generically by `e2e/tests/faceplate-platform.spec.ts` on the platform branch.
- **CI wall-time: ≈ +0.3 s.** Arithmetic: 0 new faces-parity cells × ~0.8 s = 0; 0 new VRT scenes;
  one new pure unit file (`filter-face-model.test.ts`, ~10 assertions, no DOM) ≈ 0.3 s in the unit
  lane. Far under the 2-minute sign-off threshold — state it in the PR body anyway.
- **ART: NIL, confirmed not assumed.** `art/scenarios/filter/profile.test.ts` pins the DSP through
  `dspSourceSha`; no `.dsp` byte changes, so no baseline and no fingerprint-manifest entry moves.
- **WebGL attest: NIL.** `filter` is an AUDIO def and is not in the WebGL basis, so no
  `docs-hash-ignore` markers are needed for any of this.
- **`push-card-config.ts`: check it.** filter has no explicit entry, so its Push card is resolved
  from the live def. This PR adds **no param**, so the card cannot re-rank — but confirm rather than
  assume (`push-card-schema.test.ts` goldens are an accept loop).

---

## 9. DEFECTS FOUND IN SHIPPED CODE — follow-up bugs, NOT spec content

**A. [MAJOR] The def states the wrong filter slope for TWO of its three modes, in the tooltips a
player hovers.** `filter.ts:115` — *"Highpass … (12 dB/oct)"* — and `filter.ts:116` — *"Bandpass —
keeps only a slice around cutoff (12 dB/oct)"*. Neither is true. `filters.lib:2228` defines
`resonhp = gain*x − resonlp`, which puts a second numerator zero at `f = fc/Q`, so the HP's deep
stopband tapers at **6 dB/oct** (and at `resonance = 0`, Q = 0.7, that break sits at 1429 Hz —
*above* the corner, so the whole audible stopband is 6 dB/oct). `filters.lib:2263-2272` gives BP a
single `s` numerator ⇒ **6 dB/oct skirts both sides**. `filter.ts:205` (`docs.controls.mode`) states
both facts **correctly** — so the def contradicts itself, and the docs ratchet is about to cement
the contradiction. (The "three two-pole sections" framing at `filter.ts:6-7` and `:188` is *correct*
— they are genuinely 2-pole; what is wrong is inferring a 12 dB/oct **stopband/skirt** from it for
HP and BP, which is what the two tooltips do.)
*Cost to a user:* they patch HP at low resonance expecting −12 dB/oct of bass removal, get −6 (half
the rejection), and reach for a second filter. *Can a test catch it?* Not today — `module-docs-lint`
checks orphaned keys and vocabulary coherence, not physics. The ART harness already renders filter
offline (`art/scenarios/filter/profile.test.ts`), so a slope assertion at mode 1 / mode 2 is cheap
and would pin it permanently. **Fix the two `title` strings; `title` is asserted nowhere, so it
costs zero test churn.**

**B. [MAJOR] Changing the filter MODE is not undoable, and the guard that exists to catch it is
structurally blind.** `FilterCard.svelte:22`: `const t = patch.nodes[id]; if (t) t.params.mode = m;`
— a raw SyncedStore write with no origin, while the UndoManager tracks only `LOCAL_ORIGIN`. Cutoff
and resonance route through `cardParams` `set()` → `setNodeParam` and *are* undoable, so Cmd-Z
silently skips exactly one of the card's three controls. **The guard cannot see it:**
`packages/web/src/lib/graph/mutate.guard.test.ts` defines `RAW_PARAM_WRITE =
/\.params\[[^\]]+\]\s*=(?![=>])/` — **bracket-indexed only** — and `t.params.mode = m` is dot
notation. Its self-test exercises only the bracket form, so the negative control is blind in the
same direction as the gate. *Fix:* `setNodeParam(id, 'mode', m)` (one line, boy-scout).
*Separately, and NOT in the face wave:* widen the regex to
`/\.params(\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*=(?![=>])/`, add the dot form to the self-test, and
triage the offenders it exposes — that will red the lane across many files and needs its own PR.

**C. [MINOR] The rear card prints `AUDIO` on both the input and the output hole.** Detailed in §2.5;
remedy in §7.1. *Cost:* a player reading the rear cannot name the output jack.
*Test:* nothing covers it — there is no `workflow-rear-card.spec.ts` baseline for filter (only
`rear-{dx7,sixstrum,tidyVco,vca}.png` exist).

**D. [MINOR] Stale in-source justification.** `filter.ts:148-155` defends the 2-band split partly on
*"pushed 'cv depth' below the fold at the 720p dock height — verified against the captured
baseline"*. The measurement was honest, but a fold budget is not a legitimate justification for a
band merge (the shot is the `dock-full-view` **element** in Chromium's default window, not a design
constraint), and the design program already measured ~15 px of spare. Rewrite the comment to defend
the split on **grouping semantics** alone; keep the measurement discipline it demonstrates.

*(Line numbers cited by the round-2 spec have drifted: `strict-faces.ts` `'filter'` is at **:59**,
not :51; the `contract-lock.txt` block is **1113-1122**, not 1112-1121; `DOCK_MAX_DIFF` is at
`workflow-shell-faces.spec.ts:79`; the FACES row is **:60**. All re-grepped for this spec.)*

---

## 10. VERIFICATION GATE — the rows a builder runs, in order

```sh
# 1. The derived readouts + their PERMANENT negative controls. Run FIRST.
REPEAT=3 flox activate -- task test:one -- filter-face-model
#   must fail without: (a) mode 0→2 at resonance=0 moves peak 0.00 → −3.10 dB; (b) cutoff
#   1000→8000 at depth 1 moves cv-reach "31 Hz – 20 kHz" → "250 Hz – 20 kHz"; (c) resonance
#   0.1→0.9 at res depth 0.2 moves res-reach "0.00 – 0.30" → "0.70 – 0.99"; (d) MUST-NOT-MOVE:
#   cutoff/cutoff_cv_amt do not change peak; resonance/mode do not change cv-reach.

# 2. The declaration — hero keys ranked, readout ids registered, preset values in range,
#    sidebar panelId registered, no empty block, heroFacePlan totality.
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-faceplate-model

# 3. The contract must NOT move. A non-empty diff here is a STOP, not a re-pin.
flox activate -- task docs:check && flox activate -- task test:one -- contract-lock

# 4. The card boy-scout is pixel-neutral. filter ∈ STRICT_VRT_MODULES → REQUIRED lane.
REPEAT=3 flox activate -- task vrt:one -- filter

# 5. The dock face. EXPECT FAIL on face-filter-dock, EXPECT PASS on face-filter-compact
#    (PF-20 is dock-only — a compact diff is a FINDING, not a re-pin).
flox activate -- task e2e:serve && flox activate -- task vrt:one -- face-filter

# 6. Parity: the dock's control-* multiset still equals the 5 params (the hero PROMOTES
#    cutoff, it must not duplicate it); mode is still Segmented/dial-in-lane.
flox activate -- task e2e:one -- tests/faces-parity.spec.ts
flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts

# 7. svelte-check is stricter than vitest. Then tear the server down.
flox activate -- task typecheck && flox activate -- task e2e:stop
```

**Then, and only then, the baseline regen — in this order:**
`git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/{darwin,linux}/face-filter-dock.png`
**first** (Playwright always writes a *missing* snapshot but will not rewrite a passing-but-stale
one), commit, **then** `flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f
platform=linux` — unscoped, never with `-f grep=…`. A green dispatch that committed nothing is a RED
FLAG on this module specifically; it has already happened here twice.
