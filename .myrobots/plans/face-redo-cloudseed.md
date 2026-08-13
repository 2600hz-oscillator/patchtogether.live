# face re-do — cloudseed

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
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **Any argument below that parks a
> load-bearing fact in `face.hint` because it "still paints" is VOID.** PF-21 dock ROW
> PACKING (`9bf12df7`) also landed after this was written. **This re-do is NOT built** —
> the module's shipped `face` still declares no `hero` and no `sidebar`. Live backlog.

**Verdict: REAL REWORK, ADDITIVE ONLY.** The 47-key ranking, the eight-band paging and the tab
rail are right and must not move; what is missing is the whole PF-20 layer — and cloudseed is the
ONE face where a hero is not a nicety, because the tab rail hides seven of eight bands and the
hero rail is the only part of the faceplate on screen at all times.

---

## 1. WHAT THE MODULE ACTUALLY DOES

An exact port of Ghost Note Audio's CloudSeed (`packages/dsp/src/cloudseed.ts:1-27`;
`ossAttribution` `packages/web/src/lib/audio/modules/cloudseed.ts:496`). All 45 C++ params are
declared 1:1 — 7 AudioParam macros, 38 message-port (`cloudseed.ts:424-476`) — plus
`preset_index` (`:556-560`). Zero un-exposed DSP capability; the module's problem was entirely
presentation.

**Signal path, in the DSP's real order** (`packages/dsp/src/cloudseed.ts`):

1. **Cross-feed** (`:1327-1338`) — `tmpL = inL(1−cm) + inR·cm`, `cm = INPUT MIX × 0.5`. First
   stage, so each channel's ENTIRE path — dry tap included — hears it.
2. **LOW CUT** (`:1222`) → **HIGH CUT** (`:1223`), both gated, wet path only.
3. **PRE-DELAY** (`:1229`) — **UNCONDITIONAL**, not gated by `tap_enabled` despite being
   `CloudseedParam.TapPredelay`. This is what makes the face's rank-6 promotion DSP-correct.
4. **TAPS** (`:1230`, gated) → **EARLY DIFFUSION** (`:1231`, gated).
5. **LATE TANK** (`:1234-1238`) — `lineCount` parallel `DelayLine`s summed × `1/√lineCount`.
6. **Blend** (`:1241-1243`): `dryOut·input + earlyOut·early + lineOut·lineSum`, where `input` is
   the cross-fed **pre-filter** signal. DRY and EARLY are *taps*, not inline stages.

**Inside every tank line's loop** (`:834-842`): `in + fb·feedback` → delay → [diffuser `:839`] →
[low shelf `:840`] → [high shelf `:841`] → [1-pole LP `:842`] → ring. `late_mode`
(`tapPostDiffuser`) only moves where the output is TAPPED (`:836-838` vs `:850-852`); the loop
contents are identical either way.

**The decay law, and the fact worth printing.** `updateLines` (`:1264-1276`) sets each line's
feedback as `dbAfter1Iter = (delaySamples/(DECAY·sr))·−60`, `gain = 10^(db/20)` (`:1270-1271`) —
so DECAY is an RT60 *by construction*, **for the line alone**. The shelves and lowpass sit in
that same loop, so their cut compounds on every recirculation. At the def's defaults
(`late_line_decay` 0.63 → 4.65 s — confirmed against the committed baseline PNG, which prints
`4.65 SEC`; high shelf ON at −4.6 dB; `late_line_size` 0.47 → 96 ms) the 8 kHz tail is **≈1.0 s**.
Nothing on the faceplate says so. That is §5's readout.

**Line lengths** are `(0.5 + seed)×SIZE` (`:1268`) — the tank spans 0.5×–1.5× SIZE, seeded by
`seed_delay` and blended toward the other channel by CROSS SEED (`:1181-1187`).

**INERT AT SPAWN — 12 of 46 controls.** `tap_enabled`=0 kills `tap_count`/`tap_decay`/
`tap_length`; `early_diffuse_enabled`=0 kills its five knobs; `high_cut_enabled`=0 kills
`high_cut`; `eq_low_shelf_enabled`=0 kills `eq_low_freq`/`eq_low_gain`; `eq_lowpass_enabled`=0
kills `eq_cutoff`. `early_out`=0 (MUTED) additionally silences the tap those diffusion knobs
feed. **This is the single largest thing the current faceplate fails to say** — the argument for
§6's sidebar.

**The card** (`CloudseedCard.svelte`) is clean: every range/default/curve reads off the def via
`P()/pmin/pmax/pdef/pcurve` (`:54-62`). Preset recall is shared with the dock through
`cloudseed-preset-actions.ts` and is ONE `mutateNode` of all 46 values (`:100-111`).

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

Largely right — round 2 executed BATCH C in full (`order` `:692-750`, 8 signal-order pages
`:764-773`, `rear` `:797-800`, the `cloudseed-clear` family `:569-571`, `format` on all 46 params
`:530-561`, PF-13 override in `shell-param-writes.ts:77-84`). Do not re-rank it. The real gaps:

- **No `title`, `hint`, `hero` or `sidebar`.** All four postdate the face. The shipped dock
  (`e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-cloudseed-dock.png`,
  **1220×329**) is a tab rail, an unlit 16 px VU strip, one band, an OSS credit — and ~400 px of
  dead space right of the knobs.
- **The rail hides 41 of 46 controls and nothing survives the flip.** From `tail eq` you cannot
  see DECAY, cannot see whether TAPS is on, and cannot stop a 42 s tail — `cloudseed-clear-{n}`
  is the last cell of band 1 (`:765`), i.e. tab 1 only.
- **No page `hint`s at all** (`:764-773` declare only `id`/`label`/`controls`).
- The `meter` glyph flatlines on a silent rack (visible in the baseline) — still the honest
  generic for a stereo insert FX; keep it (§5).
- *Not wrong:* band labels are short **on purpose** — they are tab captions sharing one 1220 px
  rail (`:751-763`). Correction 2 must not be answered by lengthening them.

**Correction 2 is a structural NO-OP here — and that is a platform finding.** `ModuleShell`
suppresses the band header, label *and* hint, on any tabbed face
(`origin/feat/faceplate-platform-v2:packages/web/src/lib/ui/modules/ModuleShell.svelte:955-967`);
`ModuleFacePage.hint`'s own doc says it is "never rendered on a TABBED face". cloudseed is the
only tabbed face in the repo (`dock-tabs-model.test.ts:97-124` asserts exactly that). So the
eight hints authored in §4 paint **nowhere, ever — including with annotation ON** — unless the
correction-2 work adds a tabbed-face path. **Recommendation:** with annotation on, paint the
ACTIVE band's hint as a row between the rail and the band. Otherwise this module's living-docs
prose is dead on arrival. (Reported, not fixed here.)

---

## 3. THE ~8 CONTROLS THAT MATTER

Ranks UNCHANGED from `cloudseed.ts:692-750`; restated because §5's hero descends from them.

| # | key | why it earns the rank (wrong for another module) | what it costs below |
|---|---|---|---|
| 1 | `preset_index` | On a **constructive** reverb the first decision is never a fader: the other 45 controls are trims on a space you already chose, and the four spaces are ~40 s apart in tail. A filter's first decision *is* a fader. | LATE loses mini |
| 2 | `late_out` | "How much reverb" — the one control a player rides. | DECAY loses compact |
| 3 | `late_line_decay` | The identity, and the only number the other seven tabs are judged *against*: a 0.3 s tail hides everything the diffusion and EQ tabs do. | DRY loses rank 3 |
| 4 | `dry_out` | An insert FX must A/B against itself; also the only fader whose tap is pre-filter (`:1241`). | SIZE |
| 5 | `late_line_size` | The perceived room. Below DECAY because a wrong SIZE at the right DECAY is still usable; the converse is not. | PRE-DELAY |
| 6 | `tap_predelay` | The program's biggest re-rank (C++ index 12 → 6) and **DSP-verified**: `preDelay.process` at `dsp/cloudseed.ts:1229` is unconditional, so it is not a tap control. **The lane budget ends here.** | — |
| 7 | `early_out` | The third fader, but `defaultValue: 0` = MUTED (`:533`) — inert at spawn, which is what drops it out of the lane. | — |
| 8 | `high_cut` | The wet-path trim you reach for first, but `high_cut_enabled`=0 at spawn — inert until a toggle two cells away moves. | — |

**THE LOSERS, NAMED** — 38 controls, five groups:
**input stage** (`low_cut`, both cut enables, `input_mix`, 9-12) set-and-forget corners plus a
stereo-imaging decision made once. **tank knobs** (`late_line_count`, `late_mode`,
`late_line_mod_amt/rate`, 13-16) change the *texture* of a decay whose *length* already ranks 3rd;
a texture control cannot outrank the parameter deciding whether the texture is audible.
**in-loop diffusers + `interpolation`** (17-23) — an all-pass is unity-magnitude, so the whole
group smooths the tail without changing its length or level. **TAPS (24-27) + EARLY DIFFUSION
(28-33)** — both stages switched OUT by default; ten controls that do nothing until a toggle
moves, and inertness at spawn is the entire argument. **tail EQ (34-41), stereo + seeds (42-46),
CLEAR TAIL (47)** — a per-pass trim, four layout re-rolls, and a panic button that is not a
performance control.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

Membership, ids, labels and order **UNCHANGED**; the only edit is `hint`. ⚠ `heroFacePlan` (§5)
removes `late_line_decay` and `cloudseed-clear-{n}` at render time — they stay declared here,
which is required (`heroProblems` clause (a), `module-face-lint.test.ts`).

```ts
pages: [
  { id: 'space',    label: 'space · blend',     controls: ['preset_index','late_out','late_line_decay','dry_out','early_out','late_line_size','cloudseed-clear-{n}'],
    hint: 'the recall and the output blend — DRY is tapped before the cut filters, EARLY just before the tank, LATE is the tank sum' },
  { id: 'input',    label: 'input · pre-delay', controls: ['input_mix','tap_predelay','low_cut_enabled','low_cut','high_cut_enabled','high_cut'],
    hint: 'the front of the wet path: the cross-feed every stage hears (the dry tap included), the pre-delay ahead of taps AND tank, and the two cut corners — which the dry path never sees' },
  { id: 'taps',     label: 'taps',              controls: ['tap_enabled','tap_count','tap_length','tap_decay'],
    hint: 'a seeded multitap layer of sparse early echoes — switched OUT by default; when on it colours both the EARLY tap and what reaches the tank' },
  { id: 'early',    label: 'early diffusion',   controls: ['early_diffuse_enabled','early_diffuse_count','early_diffuse_delay','early_diffuse_feedback','early_diffuse_mod_amt','early_diffuse_mod_rate'],
    hint: 'cascaded all-passes that smear the taps into a cloud — switched OUT by default; MOD AMT engages only above ~0.5 ms of depth (see defect D3)' },
  { id: 'lines',    label: 'late tank',         controls: ['late_mode','late_line_count','late_line_mod_amt','late_line_mod_rate'],
    hint: 'the tank itself — up to 12 parallel delay lines, each a seeded 0.5×–1.5× of SIZE; MODE picks whether a line is tapped before or after its own diffuser and EQ' },
  { id: 'latediff', label: 'late diffusion',    controls: ['late_diffuse_enabled','late_diffuse_count','late_diffuse_delay','late_diffuse_feedback','late_diffuse_mod_amt','late_diffuse_mod_rate','interpolation'],
    hint: 'the all-pass diffuser inside every tank line’s feedback loop — an all-pass is unity gain, so this smooths each recirculation without shortening the tail' },
  { id: 'eq',       label: 'tail eq',           controls: ['eq_low_shelf_enabled','eq_low_freq','eq_low_gain','eq_high_shelf_enabled','eq_high_freq','eq_high_gain','eq_lowpass_enabled','eq_cutoff'],
    hint: 'cut-only shelves and a lowpass INSIDE the loop, so every cut compounds on every pass — this is why the tail you hear is shorter than the DECAY dial reads' },
  { id: 'seeds',    label: 'stereo · seeds',    controls: ['cross_seed','seed_tap','seed_diffusion','seed_delay','seed_post_diffusion'],
    hint: 'the random layout every stage is rolled from; CROSS SEED slides the L and R tanks from fully independent (0 = widest) to identical' },
]
```

**Does the face read with every hint hidden?** Yes — *by construction*, not by luck. This face has
never painted a band header: the rail names the band ~14 px above it. Its legibility rests on the
tab captions, the hero rail and the readout strip, none of which is prose. cloudseed is the one
module in the wave where correction 2 changes nothing. The cost is the inverse problem in §2.

---

## 5. THE HERO + THE READOUT STRIP

**`hero.cell`: NONE.** No bespoke picture; the generic glyph stays `meter` (`:774`) and is NOT
suppressed (`heroGlyph = hasGlyph && !(dock && hero?.cell)`, ModuleShell:353). For a stereo insert
the one thing a hero picture says generically is "is signal arriving and how loud is it coming
back" — which the VU already is. The module-specific picture cloudseed genuinely needs — *which
stages are in circuit* — is a **vertical list of nine rows**: wrong shape for a wide hero bay,
right shape for the sidebar (§6). A `hero.cell` would also cost a `controlFamily` (+1 contract
line), a panel probe and a faces-parity cell, and would suppress the meter for a picture that is
not a picture of the output.

**`hero.control: 'late_line_decay'`.** The argument that would be wrong for another module: every
one of the seven non-blend tabs changes the TEXTURE of a tail whose LENGTH is set on tab 1 — and
the length decides whether the texture is audible at all. Promoting DECAY lets you set the canvas
from inside the tab where you are painting. `late_out` loses because it is a *monitor* level and
the dock already carries a live VU for "am I hearing it"; a second monitor affordance is redundant
where a second *time* affordance is not. *Taste call — one-line revert:* `control: 'late_out'`,
nothing else moves.

**`hero.action: 'cloudseed-clear-{n}'`.** Unambiguous: INFINITE PAD's DECAY is 0.95 → **42.5 s**
(`scaleParam`, `cloudseed.ts:177`), and the control that stops it currently lives on tab 1 only. It
is already a wired `action` cell (`shell-cells.ts`, `cloudseed.'cloudseed-clear-{n}'`) — no new
plumbing.

Band 1 keeps 5 cells after promotion (`preset_index, late_out, dry_out, early_out,
late_line_size`), and the rail is unaffected: `dockTabPlan` reads band COUNT (still 8) on both
sides (`DockFullView:121` pre-hero, `ModuleShell:376` post-hero).

### THE READOUT STRIP (correction 1) — 4 entries, full width under the hero

```ts
readouts: [
  { label: 'pre-delay', paramId: 'tap_predelay' },      // '0 ms'   — knob on tab 2
  { label: 'size',      paramId: 'late_line_size' },    // '96 ms'
  { label: 'tail 8k',   valueId: 'cloudseed-tail-8k' }, // '≈1.0 s' — DERIVED
  { label: 'x-seed',    paramId: 'cross_seed' },        // '0%'     — knob on tab 8
]
```

Reads as a sentence: *0 ms in front, a 96 ms room, ringing 1.0 s at 8 k, fully de-correlated* —
four dimensions of one space, three of them on tabs you cannot see. Accepted cost: `size`
duplicates a band-1 knob **on tab 1 only**. *Revert if that reads badly:* swap to
`{ label:'lines', paramId:'late_line_count' }`.

**The derived one — `cloudseed-tail-8k`.** FORMULA, mirroring `dsp/cloudseed.ts:1270-1271` with
the in-loop EQ counted:

```
T    = scaleParam(late_line_decay, LateLineDecay)         // s  — the DECAY dial
D    = scaleParam(late_line_size,  LateLineSize)/1000     // s  — E[line delay]; :1268 seeds ~U[0,1) ⇒ mean = SIZE
A    = Σ over ENABLED in-loop stages of −20·log10|H(8 kHz)|          // dB cut per pass, ≥ 0
         eq_low_shelf_enabled  → biquadLowShelfCoeffs (eq_low_freq,  fs, eq_low_gain)   [dsp :840]
         eq_high_shelf_enabled → biquadHighShelfCoeffs(eq_high_freq, fs, eq_high_gain)  [dsp :841]
         eq_lowpass_enabled    → onePoleCoeffs        (eq_cutoff,    fs)                [dsp :842]
TAIL = 60·D·T / (60·D + A·T)        // A = 0 ⇒ TAIL = T, exactly the dial
```

All three coefficient functions are **already exported from the def** (`cloudseed.ts:917`, `:938`,
`:961`) — the model imports them, never re-derives them. `fs` is nominal 48 000, stated in the
model's doc comment and pinned by a test leg (44.1 vs 48 kHz must move it < 0.05 s).

*SCOPE, stated honestly:* the model counts the loop period as the LINE delay only — exactly what
the DSP's own law at `:1270` does. The in-loop diffuser (`:839`) adds real loop period that
neither counts, so DECAY and TAIL share one assumption and the difference between them is
*precisely* the in-loop damping. (The diffuser question is filed as F1 in §9.)

*NEGATIVE CONTROLS — permanent, in `packages/web/src/lib/ui/modules/cloudseed-face-model.test.ts`:*
1. **MUST MOVE** — `eq_high_gain` 0.77 → 1.0 (0 dB): TAIL rises to ≈ T. **This is the leg a
   `paramId:'late_line_decay'` readback cannot pass** — it is invariant to it.
2. **MUST MOVE** — `eq_high_shelf_enabled` 1 → 0: same result, proving the enable is read too.
3. **MUST NOT MOVE** — `dry_out` → 0 and `late_out` → 0. The blend is OUTSIDE the loop
   (`:1241-1243`); a metric that moved here would be measuring the output envelope.
4. **MUST MOVE** — `late_line_decay`, `late_line_size` (sanity legs).
5. **INDEPENDENT INSTRUMENT** — with `late_diffuse_enabled: 0` (exactly the scope the repo's own
   pure renderer models), `cloudseedTailSeconds` must agree with
   `measureRt60(cloudseedImpulseResponse(...))` (`cloudseed.ts:1029`, `:1161`) within ±20 % on two
   synthetic param sets. This validates the FORMULA, not just its sensitivity.

Registration: one line in `packages/web/src/lib/ui/workflow/face-readout-values.ts`, mirroring
`kickdrum-tail`.

---

## 6. THE SIDEBAR

**ONE block: `{ kind: 'custom', label: 'signal path', panelId: 'cloudseed-chain' }`.**

*Why `custom` and not `signal-flow`.* `FaceFlowStage[]` is static authored data, and at the def's
defaults **four of nine stages are switched OUT** (high cut, taps, early diffusion, low shelf,
lowpass — with low cut, late diffusion and high shelf in). A static chain would assert a path the
module is not on; the brief's own rule is that a diagram teaching the wrong chain is worse than
none. The panel reads the eight enables live and dims what is bypassed. Rows, in the DSP's real
order: `input mix` (always, live %) · `low cut` (gated, Hz) · `high cut` (gated, Hz) ·
**`pre-delay` (always** — the row that kills the "pre-delay is a tap control" misreading) ·
`taps` (gated, count) · `early diffusion` (gated, stages) · `late tank` (always, `n lines × SIZE`)
with four INDENTED in-loop rows (`late diffusion`, `low shelf`, `high shelf`, `lowpass`), then a
three-row tap legend: **DRY** ∥ tapped after `input mix`, **EARLY** ∥ tapped after early
diffusion, **LATE** = the tank sum, with live dB. The two ∥ rows are the `parallel` idea — taps
off the spine, not links in it.

*Cost, stated:* `workflow/panels/CloudseedChainPanel.svelte` (~150 LOC) + `panels/
cloudseed-chain-model.ts` (~60 LOC pure) + one line in `sidebar-panels.ts` + a unit test. It must
resolve **def defaults** for untouched params (the documented `StereoCrossoverPanel` sparse-
overlay trap) and emit no `control-*` testid. *Cheaper revert:* a `signal-flow` block listing only
the four unconditional stages — honest, and it says almost nothing.

**REJECTED: the platform `presets` sidebar block.** Three reasons, any one fatal:

1. **It would light nothing on a fresh spawn.** `activePresetId` matches at
   `PRESET_MATCH_REL = 1e-3` relative (`dock-faceplate-model.ts`), and the def's defaults are
   ROUNDED copies of DARK_PLATE's: `late_line_decay` 0.63 vs 0.6346, `late_out` 0.66 vs 0.6614,
   `tap_count` 0.2 vs 0.196, `eq_high_gain` 0.77 vs 0.768, `eq_low_gain` 0.56 vs 0.556,
   `early_diffuse_mod_amt` 0.14 vs 0.1439 — at least six exceed tolerance. The sidebar would show
   NO preset lit beside a `preset_index` row showing slot 0 lit: two surfaces contradicting each
   other about one fact.
2. **It writes 46 separate transactions.** `FaceSidebar.applyPreset` loops `setNodeParam`, which is
   one `mutateNode` each (`graph/mutate.ts:99-112`) — 46 undo steps and 46 collab updates against
   `applyCloudseedPreset`'s single transaction (`cloudseed-preset-actions.ts:100-111`). A straight
   regression of the state-consistency work BATCH C landed.
3. **It duplicates `face.order[0]`.** `preset_index` is rank 1 and already renders as a named
   segment row behind the PF-13 storm-guarded write override.

**Answer to the brief's question:** the platform block does **not** replace cloudseed's machinery —
cloudseed's is strictly better and already reaches both surfaces. If the platform wants this
adopter, the right move is the reverse: give `FacePreset` an optional single-transaction commit
seam, in the platform's own PR.

`face.title: 'Space'` · `face.hint: 'a constructive reverb: eight switchable stages around a
12-line modulated tank, blended as dry · early · late'`.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

- **None required.** All 46 params already declare `format` (the module's own `formatParameter`,
  `:530-561`) or `options` (`late_mode` `:446-452`, `preset_index` `:556-560`). That is also why
  PF-20's `KnobConic.persistentReadout` moved 12 other dock baselines and **not** cloudseed's:
  `knobReadout` already returned a string for every dial here.
- **Card grep for re-typed ranges: ZERO.** `CloudseedCard.svelte:54-62` reads
  `min/max/defaultValue/curve` off the def at all 45 knob/fader sites; the 29 hand-typed ones were
  deleted (`:44-53`). No hazard, no bug.
- Two re-typed *thresholds* that currently AGREE: `CloudseedCard.svelte:65` and `:106-114` use
  `>= 0.5`, matching `scaleParam`'s `val < 0.5 ? 0 : 1` (`cloudseed.ts:146`). Hazard only; a shared
  exported constant would close it. Not worth a PR alone.
- One `format` change is a DEFECT fix, not a design change — D2 in §9.

---

## 8. COST

- **contract-lock: ZERO.** `contract-signature.ts` projects ports, params and `controlFamilies`
  only — no `face` branch (`:35-53`, `:108-124`). No new `ParamDef`/`PortDef`/`ControlFamily`.
- **VRT — MOVES:** `face-cloudseed-dock` on **both** platforms (face-head row + hero rail +
  readout strip + `.page.has-sidebar` narrowing the editor column). Growth ≈ +140 px over the
  shipped 1220×329 by arithmetic over the platform's own row heights — an ESTIMATE to confirm by
  *looking at* the regenerated PNG, never a reason to merge bands. Dimensions change, so Playwright
  hard-fails before computing a ratio: **`git rm` both dock PNGs first, then dispatch.** Neither
  pair is in `EXEMPT_BASELINE_PAIRS` (the only cloudseed entry there is `EXEMPT_FROM_VRT` for the
  legacy card, `:484`), so no exemption or ratchet moves.
- **VRT — MUST NOT MOVE:** `face-cloudseed-compact` (every PF-20 field is gated on
  `view === 'dock-full'`; `allDockBands` is null at lane tiers, ModuleShell:324) and the legacy
  `vrt.spec.ts` scene (cloudseed is `EXEMPT_FROM_VRT`; the card is untouched). A diff on either is
  a **finding, not a re-pin**.
  ⚠ **Coverage gap:** the dock scene captures only the ACTIVE tab, so 41 of 46 controls are
  `hidden` and pixel-invisible. cloudseed's dock VRT covers 5 controls.
- **e2e:** faces-parity cell count **UNCHANGED** — the hero PROMOTES, it does not add
  (`heroFacePlanIsTotal`). `cloudseed-face.spec.ts` needs **no assertion edits** (the hero rail is
  inside `module-shell`, so the 46-control count and the CLEAR-TAIL `toBeVisible` both hold); two
  comments go stale. New: cloudseed becomes an adopter row in `faceplate-platform.spec.ts`'s
  registry-driven sidebar sweep = one extra dock spawn.
- **CI wall-time: ≈ +5–8 s** — one dock boot in the sidebar sweep (`faces-parity.spec.ts:75-78`
  gives ~2.0 s + 0.19 s/cell on SwiftShader; the sweep only reads the sidebar, so it is the boot
  cost) plus two new unit files (~0 s). Far under the 2-min flag.
- **ART: NIL.** `art/scenarios/cloudseed/impulse-response.test.ts` imports only pure-math exports
  and carries **no `.sha` pin** (grep-verified). A `face` edit cannot reach it.
- **Attest: NIL, verified.** No cloudseed path in `scripts/collab-attest-lib.ts` or
  `scripts/grand-attest-lib.ts`; audio defs are not in the WebGL basis, so no
  `docs-hash-ignore` markers.

---

## 9. DEFECTS FOUND IN SHIPPED CODE — follow-ups, NOT spec content

**D1 — the worklet re-seeds the entire reverb EVERY 128-SAMPLE BLOCK (performance, P1).**
`CloudseedProcessor.process` pushes all seven macros unconditionally every block
(`packages/dsp/src/cloudseed.ts:1428-1443`) and `ReverbController.setParameter` has **no dedupe**
(`:1316-1321`), so the comment at `:1428` ("Values that don't move trigger no re-derivation") is
false. The expensive one is `Param.EqCrossSeed` (`:1181-1187`), which per channel runs
`multitap.setCrossSeed` → `updateSeeds` (`:740-743`: a 768-value cross-seeded LCG buffer + a
256-iteration `Math.pow` loop), `diffuser.setCrossSeed` (`:651-654`), `updateLines` (`:1264`) and
`updatePostDiffusion` (`:1281-1285` — twelve lines × `setSeed` **and** `setCrossSeed`, each a full
`updateSeeds`). Order of **~6 800 BigInt LCG iterations, ~1 100 `Math.pow` and ~50 `Float32Array`
allocations per block** — ~2.6 M LCG iterations/s at 48 kHz — on the audio thread, for a reverb
sitting completely still. **Cost:** audio-thread CPU + GC churn on a module that should be nearly
free when idle; the output-underrun class this repo has hit before. **Sound-transparent when
fixed** — every re-derivation recomputes identical values from identical seeds, so no ART re-pin
and no owner audition. **Fix:** guard the seven macro pushes in the processor against their
last-sent value (safest — it is where the false comment lives), or
`if (this.parameters[id] === value) return;` in `ReverbController.setParameter` (⚠ that variant
must not swallow a legitimate first write of 0). **Catchable:** yes — a DSP unit test counting
`updateSeeds` invocations across N unchanged `process()` calls; needs a small counter seam.

**D2 — three MOD AMT dials print a meaningless percentage.** `formatParameter`'s `%` branch
(`packages/web/src/lib/audio/modules/cloudseed.ts:243-246`) applies `Math.round(s*100)+'%'` to
`EarlyDiffuseModAmount`/`LateLineModAmount`/`LateDiffuseModAmount`, whose `scaleParam` is
`val × 2.5` **milliseconds** (`:168`, `:174`, `:176`). A knob at 100 % prints **`250%`**; the
defaults print `35%` / `68%` / `38%`. The branch was written for the identity-scaled params
(`InputMix`, `TapDecay`, both feedbacks, `EqCrossSeed`) and the three ×2.5 ones were filed with
them. **Cost:** three of the 46 readouts PF-3 exists to fix are still wrong, one of them exceeding
100 % of nothing. **Fix:** `` return `${s.toFixed(2)} ms` `` — the unit the DSP uses.
**Catchable** in a pure unit test on `formatParameter`. **VRT-invisible** (hidden tabs), which is
why it survived.

**D3 — EARLY DIFFUSION MOD AMT is dead for the bottom 20 % of its travel, including at its own
default.** `ReverbChannel.setParameter` enables early-diffusion modulation with
`setModulationEnabled(scaled > 0.5)` where `scaled` is in **milliseconds** (0…2.5), while the very
next line converts to samples (`dsp/cloudseed.ts:1125-1129`); the late-line diffuser uses `a > 0`
on a **samples** value for the same concept (`:814-816`). The def default is 0.14 → 0.35 ms and
DARK_PLATE's is 0.1439 → 0.36 ms, so **modulation is OFF at both**, and `ModulatedAllpass` fully
gates on the flag (`:428`). **Cost:** a knob whose docs promise "chorusing/shimmer" does nothing
until ~20 %. **Fix unclear without the C++** (the referenced `…/workspace/CloudSeedCore/` is not
present on this machine): either the threshold should be `> 0` like its sibling, or it should
compare samples. **Owner call — it CHANGES THE SOUND**, so its own audition PR.

**D4 — two prose figures about the longest tail are wrong.** `cloudseed.ts:567` says "a preset
whose tail runs ~30 s" and `docs.controls['cloudseed-clear-{n}']` (`:604`) says the max "runs ~60
seconds, and INFINITE PAD parks near it". INFINITE PAD's `LateLineDecay` is 0.95 →
`0.05 + resp3dec(0.95)·59.95` = **42.5 s**. The 60 s maximum is right; "parks near it" is not.
**Catchable only by a human** — the docs fact-check validates identifiers, not arithmetic.

**F1 — open question, not a defect.** The in-loop diffuser (`:839`) adds loop period the feedback
law at `:1270` does not count, so the true broadband RT60 is LONGER than the DECAY dial whenever
late diffusion is on (roughly +50 % at the defaults: 4 stages × ~12 ms mean allpass delay against
a 96 ms line). Inherited from the C++ and a *design* question (is DECAY the line's RT60 or the
tank's?), not a port bug — owner ear before anyone "fixes" it. §5's readout deliberately shares
the DSP's assumption rather than second-guessing it.

---

## 10. VERIFICATION GATE

```sh
flox activate -- task test:one -- module-face-lint        # hero ranked/unclaimed/not-a-param; panelId + valueId registered
flox activate -- task test:one -- dock-faceplate-model    # heroFacePlanIsTotal over every faced module
flox activate -- task test:one -- dock-tabs-model         # cloudseed still the ONLY tabbed face; still 8 bands
flox activate -- task test:one -- rear-card-model -t cloudseed     # bands ['signal','space','input','seeds'] unchanged
flox activate -- task test:one -- contract-lock           # must be UNCHANGED — a diff means something is not UI metadata
flox activate -- task test:one -- cloudseed-face-model    # NEW: the derived readout + all five negative-control legs
flox activate -- task test:one -- cloudseed-chain-model   # NEW: the sidebar panel's pure row projection
REPEAT=3 flox activate -- task test:one -- cloudseed-face-model
REPEAT=3 flox activate -- task test:one -- cloudseed-chain-model
flox activate -- task typecheck

flox activate -- task e2e:serve
flox activate -- task e2e:one -- tests/cloudseed-face.spec.ts       # tab rail + 46 controls + preset recall, unchanged
flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts   # cloudseed now an adopter of the sidebar sweep
flox activate -- npx --workspace e2e playwright test faces-parity --grep cloudseed
flox activate -- task vrt:one -- cloudseed                          # EXPECT dock RED (dimension change), compact GREEN
flox activate -- task e2e:stop
```

**VRT re-pin, in this order** (the baseline is stale-by-dimension, so removal is mandatory):
1. `git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/{darwin,linux}/face-cloudseed-dock.png`
2. capture darwin locally (`task vrt:one -- cloudseed`, 3× stable) and **look at the PNG** — the
   hero rail, the readout strip and the sidebar column all painted, eight tabs still on the rail.
3. `flox activate -- gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux` — unscoped,
   never `-f grep=…`; then approve the `action_required` follow-on run.
4. Confirm `face-cloudseed-compact` did **not** move. If it did, stop — that is a finding.
