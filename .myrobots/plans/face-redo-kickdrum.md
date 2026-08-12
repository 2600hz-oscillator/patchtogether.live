# face re-do — kickdrum · **DELTA ONLY**

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
> PR #1301 **HAS MERGED** (`c6ff9253`) — kickdrum's PF-20 face is on `main`, so read the
> def directly rather than `git show origin/feat/faceplate-platform-v2:…`.
> **THIS DELTA IS NOT APPLIED.** `settles to` is still declared
> (`packages/web/src/lib/audio/modules/kickdrum.ts:387`) and no `kickdrum-sweep-start`
> readout exists. §1 is live backlog.
> ⚠ **§3 IS FALSE.** "`face.title` / `face.hint` — the PAGE header still paints by default"
> — it does not: `facePageHeader()` returns `null` before reading anything unless annotate
> mode is on (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner
> ruled on 2026-08-03 that `face.title` stays annotation-only. §2's verdict ("the face
> survives correction 2 because the sidebar carries the same facts") is UNAFFECTED — the
> sidebar and the PF-9 cluster labels do still paint — but the title/hint line does not.
> PF-21 dock ROW PACKING (`9bf12df7`) landed after this was written and moved kickdrum's
> bands from 5 rows to 4.

**Verdict:** IN FLIGHT — do not re-spec. kickdrum's faceplate is being built on
`feat/faceplate-platform-v2` (PR #1301) as the platform's **reference consumer**, and this file
records only what the **two platform corrections** change about that in-flight design.

Everything below cites the branch, not `main`:
`flox activate -- git show origin/feat/faceplate-platform-v2:packages/web/src/lib/audio/modules/kickdrum.ts`

---

## 0. WHAT IS ALREADY THERE (the baseline this delta modifies)

| field | value on the branch |
|---|---|
| `face.title` | `'Voice'` (`kickdrum.ts:351`) |
| `face.hint` | the three-generators-through-one-bus sentence (`:352`) |
| `face.hero.cell` | `'kickdrum-hero-{n}'` — the envelope + sweep graph (`:364`) |
| `face.hero.control` | `'tune'` (`:365`) |
| `face.hero.action` | `'kickdrum-strike-{n}'` (`:366`) |
| `face.hero.readouts` | `tail` (`valueId: 'kickdrum-tail'`), `sweep` (`paramId: 'pitch_amt'`), `settles to` (`paramId: 'tune'`) (`:384-388`) |
| `face.pages` | FIVE bands, **each carrying a `hint`** (`:324-327`, `:331`) |
| `face.sidebar` | `signal-flow` (`:394`), `custom` → `stereo-crossover` (`:423`), `presets` × 5 (`:437`) |

---

## 1. CORRECTION 1 — the readout row moves BELOW the graphic

**What changes structurally:** nothing in `kickdrum.ts`. `hero.readouts` is a declaration; where
the shell paints it is `ModuleShell.svelte`'s business. The def edit is **zero lines**.

**What changes in the DESIGN, and it is not nothing.** The three readouts were sized for
`.hero-side` — a narrow column beside a 64 px dial and a strike button. As a **full-width strip
under a full-width graph** they are three numbers in a row built for five, and the strip is now
the most-read line on the faceplate. Two consequences:

**(a) `settles to` becomes redundant and should be DROPPED.** It is `{ paramId: 'tune' }`
(`:387`) — the same param as `hero.control` (`:365`), whose dial is now directly above/beside the
strip printing the same number at 17 px (`ModuleShell.svelte`'s `.hero-ctl .readout` rule). Inline
beside the dial that read as a caption; in a wide strip under the graph it reads as *a second,
independent measurement that happens to agree*, which is exactly the "two surfaces disagreeing
about one number" failure the platform's own `readoutText` doc-comment cites — inverted. One
number, one place.

**(b) The freed slots should go to `starts at`, and it is genuinely DERIVED.** The branch already
ships the pure function: `kickdrumSweep(p)` returns `{ startHz, endHz, semitones }`
(`kickdrum-face-model.ts:208-218`), computed as `kickBodyFreqHz(dsp, 1, p.tension * p.body_level, 0)`
— the body layer's frequency **at the strike**, through the worklet's own sweep law.

- **FORMULA:** `startHz = kickBodyFreqHz(toDspParams(p), env=1, tension·body_level, accent=0)`
  (`kickdrum-face-model.ts:216`), i.e. the 909 chirp's origin, which is a function of `tune`,
  `pitch_amt`, `tension` **and `body_level`**.
- **NEGATIVE CONTROL:** hold `tune` and `pitch_amt` fixed and sweep **`body_level`**. A readback of
  either knob is frozen; the derived `starts at` moves, because the tension glide term is
  `p.tension * p.body_level` (`:216`) — the amplitude→pitch coupling the def documents as the
  909 "dooo". Same shape as `kickdrum-tail`'s SUB LEVEL control, on a different input.
- **SECOND LEG (must NOT move):** sweep `sub_decay`. It changes the tail and must leave `starts
  at` frozen — a derivation that tracks everything is not a derivation.
- **COST:** one registry entry in `face-readout-values.ts` (`'kickdrum-sweep-start'`) and one
  assertion pair in `kickdrum-face-model.test.ts`. No new machinery: the function, its unit test
  file and the formatter (`fmtHz`/`kickdrum-format.ts`) all already exist on the branch.

**PROPOSED STRIP (four entries, replacing the three):**

```ts
readouts: [
  { label: 'tail',      valueId: 'kickdrum-tail' },          // unchanged — 398 ms
  { label: 'starts at', valueId: 'kickdrum-sweep-start' },   // NEW, derived
  { label: 'sweep',     paramId: 'pitch_amt' },              // unchanged — +24 st
  { label: 'peak',      text: '−0.5 dBTP ceiling' },         // OPTIONAL, see below
]
```

The fourth is a **taste call with a one-line revert**: `ceiling` is a real knob in band 5, so a
`text` literal asserting a fixed number would be a lie the moment someone turns it. If a fourth
entry is wanted it must be `{ paramId: 'ceiling' }` (honest, and not redundant with the strip's
other entries) or nothing. **Recommendation: ship three — `tail · starts at · sweep` — and leave
the strip short rather than padded.**

---

## 2. CORRECTION 2 — band hints become ANNOTATION, hidden by default

kickdrum is the **most exposed face in the set** to this correction: five bands, five hints
(`:324-327`, `:331`), and two of them carry facts the def's own comments argue are *not
cosmetic*. The test the brief sets — *does this face read correctly with every hint hidden?* — is
answered band by band:

| band | hint (still authored, no longer painted) | does the fact survive? |
|---|---|---|
| `sub` | `depth sine at TUNE — always mono` | **YES.** The mono-below-the-split fact is the `stereo-crossover` sidebar panel's entire subject (`:423-433`, `props: { splitHz: 120 }`). The sidebar paints by default. |
| `body` | `morphable wave an octave up, on the 909 downward sweep` | **PARTLY.** The sweep survives (sidebar stage `BODY · 909 sweep`, `:445`-ish, plus the hero graph draws the chirp). The **octave-up** relationship is lost — and the proposed `starts at` readout in §1 is what restores it, numerically and better: `+24 st → 100 Hz` says the octave without asserting it. |
| `click` | `band-passed noise burst — the leading transient` | **YES.** Sidebar stage `CLICK · noise`. |
| `drive` | `oversampled saturation; HARD picks the character and the rate` | **PARTLY.** Sidebar stage `DRIVE · HARD · saturate` carries the stage; the *oversampling rate changes with HARD* detail is lost. It is a genuine loss and it is acceptable — that detail is what annotation mode is FOR. |
| `dynamics` | `transient → glue → level → width → ceiling, in that order` | **YES, and this is the important one.** The def argues at length (`:300`-ish comment block) that teaching the wrong order makes a producer think raising LEVEL escapes the clipper. The order survives twice over without the hint: the two PF-9 **cluster labels** (`transient · glue` and `level · width · ceiling`, `:333-340`) still paint — clusters are not hints — and the `signal-flow` sidebar's tail stage prints `OUT L · R — level → ceiling`. |

**Verdict on correction 2 for kickdrum: the face survives it, and it survives it because the
sidebar was already carrying the same facts in a form that paints.** That is not luck — it is the
argument for why the sidebar is platform and the hint is annotation. **The one repair worth
making is `body`'s octave, and §1's `starts at` readout is that repair.**

**⚠ DO NOT compensate by rewriting the band LABELS.** `2 · body — the punch` is a name; turning it
into `2 · body — morphable wave an octave up` makes the label a sentence and re-introduces the
prose the correction removed, one layer down.

---

## 3. WHAT IS *NOT* AFFECTED

- `face.title` / `face.hint` (`:351-352`) — the PAGE header still paints by default. Unchanged.
- The `hero.cell` graph, the strike, the sidebar's three blocks, the five presets, the
  `stereo-crossover` panel, the `kickdrum-tail` derivation and its permanent negative control —
  all unchanged.
- **Contract:** ZERO. Every field here is UI metadata (`contract-signature.ts` has no `face`
  branch). Adding a `valueId` id adds no contract line.

---

## 4. COST OF THIS DELTA

| lane | delta |
|---|---|
| contract-lock | **0 lines** |
| unit | `+1` registry entry (`face-readout-values.ts`), `+2` assertions (`kickdrum-face-model.test.ts`: the `body_level` leg moves, the `sub_decay` leg does not). ~0 s. |
| VRT | `face-kickdrum-dock` (darwin + linux) moves anyway for correction 1 — the strip relayout is a whole-hero move, far over `DOCK_MAX_DIFF`. Dropping `settles to` and adding `starts at` is inside that same re-capture; it is **not an additional baseline cost**. `face-kickdrum-compact` must **NOT** move (the compact tier caps at 2 cells and never renders a hero) — a diff there is a finding. |
| e2e | `faces-parity` cell count **unchanged** (readouts are not cells). `faceplate-platform.spec.ts` on the branch asserts hero readouts by `[data-hero-readout]` — the `settles-to`/`starts-at` swap edits that spec's expectations. |
| CI wall-time | **≈ 0.** No new spec, no new scene, no new parity row. |

---

## 5. DEFECTS FOUND

**None new.** The one thing worth flagging is not a defect but a **latent hazard the corrections
make worse**: `face-readout-values.ts` currently registers exactly one id (`'kickdrum-tail'`), and
`FaceReadoutValue` is **params-only** — `(read: (paramId) => number|undefined) => string`. Every
readout the widened strip invites across the other 17 faces has to be expressible in that
signature. Three modules in this batch want the *measured* value (a sounding pitch after a patched
CV, a sample-rate-dependent corner), and none of them can be honest today. The batch-3 index
already prices the widening (`face-specs-batch-3-INDEX.md` §2.1). **The strip correction raises
the value of that widening from "nice" to "the strip's headline entry on three faces".**
