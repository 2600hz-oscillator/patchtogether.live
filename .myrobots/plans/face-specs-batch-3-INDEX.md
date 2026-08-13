# FACE SPECS — BATCH 3 · the index

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


## 0. STATUS — CORRECTED 2026-08-04 (verified against `main`, not against this doc)

### UPDATE (2026-08-12): TEN of the twelve are BUILT; TWO remain

Ground truth is `STRICT_FACES` (`packages/web/src/lib/ui/workflow/strict-faces.ts`)
plus the `face` declarations in the defs — not the status lines in these files, and
not the table below, which is kept only for its per-module notes.

**BUILT (10):** clap · drummergirl · pentemelodica · sixstrum (#1332) · analogVco
(#1416) · meowbox (#1417) · bluebox (#1431) · macrooscillator (#1432) · cube (#1452)
· noise (#1464).

**UNBUILT (2):** **samsloop** and **twotracks**.

Two verdicts in the table below were OVERRULED by what shipped, and that is the
interesting part of this file:

- **noise's spec says "NO CURATED FACE ON MERIT"** and one shipped anyway — #1464,
  "the smallest face in the registry, and the three facts one knob cannot say".
  The spec's real yield, its eight defects, has since been paid in full: every one
  is now either fixed or documented in `noise.ts` / `noise-dsp.ts` / `noise.test.ts`,
  which is why **that spec file was deleted in this sweep**.
- **cube's spec was a decline** and cube shipped in #1452, rebuilt from
  `face-spec-cube-rebuild-2026-08-09.md` after re-measurement found the blocker was
  a DC fault rather than MORPH.

| module | this doc's verdict | what happened |
|---|---|---|
| **clap** | PROMOTE | **SHIPPED** — **#1332** (`2d111616`), in `STRICT_FACES`. |
| **drummergirl** | PROMOTE | **SHIPPED** — **#1332**. |
| **pentemelodica** | PROMOTE | **SHIPPED** — **#1332**. |
| **sixstrum** | RE-DO | **SHIPPED** — **#1332**; the re-do fixed the "cannot play the instrument" defect. |
| **analogVco** | ✅ **SHIPPED** (`face/analogvco`, 2026-08-08) | RECOVERED from `b5843cf4` rather than re-authored — the drop in `897b6515` was purely the VRT scene, and that is now fixed. RE-DERIVED under the corrected instrument (10 SEPARATE processes, not `--repeat-each`): **1/10 PASS unmasked** (227–322 px vs a 72 px budget), **10/10 PASS with the mask** as the control. Ships the registry's first face entry — `VRT_LIVE_SURFACES['face-analogVco-compact']`, masking **8.7 % of the tile** (the cheapest entry in the file) with a measured companion + per-run negative control. The false "already carries a measured companion" claim in `vrt-exemptions.ts` is corrected (the mask was **deleted**, not migrated). Two live defects the spec flagged were already fixed on main before it landed: the card/def bipolar range (#1311) and the impossible `pw` doc. **Still open, deliberately: §7-D** (the `shape` CV jack reaches only 0…0.5, so the morph never gets past sine — a contract change, its own PR). |
| **macrooscillator** | PROMOTE — PARTIAL REWRITE | ✅ **SHIPPED as a FACE ONLY** (`face/macrooscillator`, 2026-08-09). §2's three new params + patched-sensing strike gate were **NOT built**: §2.3 is unbuildable as written (an audition keep-alive makes `inputs[1]` permanently non-empty, the `sixstrum` failure in-tree) *and* it is a DSP change, so INDEX rule 5 applies twice over. Four measured defects are **documented on the face rather than fixed** — WAVETABLE's morph is dead over its bottom half, GRANULAR's morph is a 3-position switch, MODAL's timbre runs backwards, and OUT spans **76.6 dB** across engines. Two spec numbers corrected: HARMONICS quantises in **FOUR** engines, not five (WAVETABLE is a genuine blend), and the spread is 76.6 dB not 75. Second free-running face, so the second real test of #1420's freeze. |
| **bluebox · noise · cube · samsloop · twotracks** | 1 promote / 3 decline | **UNBUILT.** Live backlog — but read the per-file 2026-08-04 banners first: several of the defects these specs are built around **have since been fixed**, which changes the argument. |
| **bluebox** | PROMOTE (with a caveat) | ✅ **SHIPPED** (`face/bluebox`, PR #1431, 2026-08-09). The caveat is ANSWERED: `face.order` ranks by **LAYOUT**, derived from `BLUEBOX_BUTTON_NAMES`, because every PREFIX of that ranking is still a recognisable keypad fragment — and the minimal bank cover `{1,5,9,0,BLUEBOX,REDBOX}` (the genuinely principled subset) reads as a broken phone in a lane tile. Two findings the spec could not have had: a durable-param reader on this module is **constant zero forever** (ModuleShell's `clearStuckMomentaryParams` `$effect` scrubs every durable write), so the hero panel polls the LIVE ENGINE and owns the numbers with **no `hero.readouts`**; and `curve: 'discrete'` blanked the Push 2 card, exposing two push-card assertions that were describing the wrong predicate. No DSP change, no ART re-pin. |
| **meowbox** | PROMOTE | ✅ **SHIPPED** (PR #1417, 2026-08-09). A press-and-HOLD audition, not a one-shot — the def's own `gate` doc was wrong about its edge semantics (`edge: 'gate'` now declared; contract re-pinned). The spec file is the as-shipped record. |
| **macrooscillator** | PROMOTE — PARTIAL REWRITE | 🔄 **IN FLIGHT — PR #1432 open** (2026-08-09), rebuilt from `macrooscillator-face-measurements-2026-08-08.md`. |
| **noise · cube · samsloop · twotracks** | 1 no-face-on-merit / 3 not-yet | **UNBUILT.** Live backlog — but read the per-file banners first: several of the defects these specs are built around **have since been fixed** (samsloop most of all), which changes the argument. |

Other status lines that have gone stale everywhere in this batch:

- PF-20 is **PR #1301 — MERGED** (`c6ff9253`). Every "unmerged branch" citation resolves on
  `main`; read the def, not `origin/feat/faceplate-platform-v2`.
- These twelve specs are **PR #1304 — MERGED** (`6b4a8968`).
- **PF-21 dock ROW PACKING** landed after they were written (`9bf12df7`): consecutive
  packable bands share a row, ≤ 10 cells, and a tabbed face never packs. Layout arguments
  about vertical sprawl are already answered by the platform.
- The **dock VRT scene captures only the top ~425 px** (`71909ed0`) — a green dock baseline
  is not evidence a band-level change was a no-op on a tall face.

### ⚠ ONE CLAIM IN §1.1 IS FALSE

§1.1 ends "**The `face.title` still always paints**". It does not.
`facePageHeader(def, annotations = false)` returns `null` before it reads anything — title
included (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`). The owner ruled on
**2026-08-03** that `face.title` **stays annotation-only** ("two names on one panel was the
actual complaint" — the dock title bar already paints the module NAME), so this is a settled
decision, not a bug to file. Anything below that relies on the title carrying a fact at rest
needs re-deriving.

---

**SPEC AND MOCKUP ONLY. Nothing here is implemented, no module def is touched.** The owner
reviews these and the gallery before any building starts.

- **Mockup gallery (one file, self-contained):** `.myrobots/mockups/face-batch-3-gallery.html`
  — **KEPT** (this index is its only referrer). Seven of its twelve tiles are still unbuilt,
  so it stays the live visual reference for them; the clap / drummergirl / pentemelodica /
  sixstrum tiles are now history — compare against the shipped dock, not against these.
  ⚠ It predates PF-21 row packing and it draws the page header as if it painted at rest.
- **Per-module specs:** `.myrobots/plans/face-specs-batch-3-<module>.md` (twelve files)
- **Designed against:** the PF-20 faceplate platform on `feat/faceplate-platform-v2`
  (**PR #1301 — MERGED 2026-08-02 as `c6ff9253`; read `main`**) — `face.title` / `face.hint`, per-band `hint`,
  `ModuleFaceHero` (`cell` / `control` / `action` / `readouts`),
  `FaceSidebarBlock[]` (`signal-flow` | `presets` | `readouts` | `custom`), and
  `FaceReadout.valueId` resolved through `face-readout-values.ts`.
- **Two owner layout decisions (2026-08-02) landed on that branch after these specs
  were written — see §1.1. Neither changes a single declaration below**; both are
  platform behaviour, and the gallery is re-drawn to match.
- **Quality bar:** `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md`.
- **Defect checklist:** `.myrobots/plans/face-specs-round-2-2026-08-01.md` — its 71 defects were
  read as a list of what goes wrong, not as a design.

---

## 1. THE TWELVE, AND WHAT I PROPOSE

| module | verdict | the one-line proposal |
|---|---|---|
| **analogVco** | PROMOTE | Three bands that say **which of the six outputs each knob addresses** — because SHAPE and PW touch only the MORPH tap and nothing says so today. Hero = the single-cycle scope the card already draws, all five taps at once. |
| **bluebox** | PROMOTE (with a caveat) | A **keypad**, not a knob rank. Hero = the ten-slot tone bank, so the `+=` that makes `{1,4}` 1.8 dB louder than `{1,5}` becomes visible. ⚠ Its `face.order` is declaration order and **says so** — a telephone keypad has no principled priority ranking. |
| **clap** | PROMOTE — strongest in the batch | Four bands = the four DSP stages, and a hero envelope graph showing **two** envelopes: the burst train and a room tail that starts at the *last* onset, not at the strike. |
| **drummergirl** | PROMOTE | The face's whole job is to **unbundle SHAPE**, one fader that moves five independent quantities — and to say that the pitch sweep is **zero at the shipped default**. |
| **macrooscillator** | ~~PROMOTE — **PARTIAL REWRITE**~~ → **FACE ONLY, SHIPPED** | Puts the 14 engine names in the def as `ParamDef.options`; hero readout says **what HARMONICS means in THIS engine**. ⚠ The three new params + strike gate were dropped — see §0. |
| **meowbox** | PROMOTE | Hero = the three resonance peaks over the four source partials. Headline readout: **the note settles 1.8 semitones sharp of what you asked for**, and MORPH is what decides by how much. |
| **noise** | **NO FACE ON MERIT** | One param, zero inputs, zero modes — all four face tiers would be identical. Contingency face included, clearly marked. The real yield here is five wrong comments and one **vacuous test**. |
| **pentemelodica** | PROMOTE — hardest layout | Not a sequencer: a 5-voice poly *voice*. Six bands ⇒ **the dock tab rail**, deliberately, because five symmetric strips are the one shape `face.order` cannot express. |
| **samsloop** | PROMOTE — **blocked** | Needs three `node.data` switches promoted to ParamDefs first, **and a P0 fix: a recorded sample never plays.** |
| **sixstrum** | **RE-DO** | The shipped face **cannot play the instrument** — the audition never made it into the shell. Re-ranked on one test: *does it move a ringing string?* |
| **cube** | **SWAP OUT** (my addition) | 7 of 24 knobs do not survive measurement — MORPH is bit-exactly dead at spawn. Fix the DSP first. |
| **twotracks** | **SWAP OUT** (my addition) | 31 params, 12 inert until a take exists, the transport is not params at all, and reel B's ECHOES knob is a permanent no-op. |

**Modules I think should NOT get a face: `noise` (on merit), `cube` and `twotracks` (not yet).**
That leaves **nine** to build, which is a healthier batch than twelve.

### 1.1 TWO OWNER LAYOUT DECISIONS THE PLATFORM NOW MAKES FOR EVERY FACE

Both landed on `feat/faceplate-platform-v2` on 2026-08-02, after these twelve specs were
written. **Neither requires an edit to any declaration in them** — that is the point of a
platform: the specs say what a face *declares*, the platform says how a faceplate *reads*.

1. **The derived-readout row sits BELOW the hero graphic**, as a full-width strip, not
   inline beside the hero control. Every spec below that declares `hero.readouts` gets this
   for free, and the change is worth knowing when you read the mockups: the picture now has
   the whole editor width, so a spec that argued its graph was cramped beside three readouts
   (clap, meowbox, drummergirl all do) is arguing about a layout that no longer exists.

2. **`face.hint` and every band `hint` are ANNOTATION, and OFF by default.** The prose is
   still authored on the def — it is living-docs content and the specs' `hint:` strings stand
   exactly as written — but the CARD only paints it when the viewer turns annotations on
   from the dock title bar (per-viewer, not `node.data`, not the Y.Doc). The `face.title`
   ~~still always paints: it is the panel's name, not a note about it.~~
   ⚠ **FALSE — corrected 2026-08-04, see §0.** `face.title` is ANNOTATION-ONLY too
   (`dock-faceplate-model.ts:90`; owner decision 2026-08-03).

   ⚠ **This raises the bar on a band LABEL, and lowers it on a band HINT.** At rest the label
   is the *only* thing naming the band, so `1 · burst — the hands` has to carry the idea on
   its own; a label that leans on its hint to make sense now reads as a bare word. Conversely
   the hint is free to be longer and more technical than a card could otherwise afford,
   because nobody pays for it until they ask. Read every `label` in these twelve specs
   against that test before building.

---

## 2. THE PLATFORM GAPS THESE TWELVE FOUND

Four things the specs need that PF-20 as written does not provide. **None is a blocker for the
nine; all four are cheap.**

### 2.1 `FaceReadoutValue` is params-only, and three modules need more

```ts
// today, face-readout-values.ts
export type FaceReadoutValue = (read: (paramId: string) => number | undefined) => string;
```

It cannot read the engine, the analyser, the sample rate or a patched input. That rules out the
single most valuable readout on `analogVco` (the *measured* sounding pitch, which the card already
computes and discards — `packages/web/src/lib/audio/analog-vco-scope.ts:82-85`), the sample-rate
leg of `noise`'s brown-corner readout, and the pitch leg of `macrooscillator`'s strike time.
Minimal widening:

```ts
export type FaceReadoutValue = (ctx: {
  read: (paramId: string) => number | undefined;
  sampleRate: number;
  readLive?: (paramId: string) => number;   // engine.readParam = intrinsic + modulator tap
}) => string;
```

`engine.readParam` already returns intrinsic + tap (`packages/web/src/lib/audio/engine.ts:737-747`),
so the CV-aware half is wiring, not new machinery. **Until it lands, every affected readout ships
with its blindness in its LABEL** (`knob pitch`, not `pitch`) — which is the honest fallback, not
a workaround.

### 2.2 A sidebar block that WRITES `node.data`

`sidebar-panels.ts` states the rule: *"A panel READS; it does not own state."* The `presets` block
writes **params**. `samsloop`'s recorder settings and `twotracks`' transport are neither. Two of
the three affected modules are already deferred; `samsloop`'s answer is to **promote the three
settings to ParamDefs** rather than to widen the platform, which is the smaller change and buys
MIDI-learn and undo for free.

### 2.3 The `action` cell has no probe, and faces-parity cannot fail on a dead button

`e2e/tests/faces-parity.spec.ts:506-511` asserts `toBeEnabled()` then `click()` — **it asserts no
effect.** That is precisely the revision-only-probe pathology `shell-cells.ts` outlaws for PANEL
cells, and the `action` kind has **no probe at all.** **Consequence for every audition in this
batch (clap, drummergirl, macrooscillator, meowbox, samsloop, sixstrum): the bespoke audition spec
with a before/after negative control is MANDATORY, not a nicety.** Follow-up, its own PR: give
`ShellActionCell` an optional `probe` mirroring `ShellPanelProbe`.

⚠ **And the false blocker round 2 invented twice, so a third agent does not invent it again:**
an `action` cell **can** reach the engine today.
`packages/web/src/lib/audio/engine-ref.ts:23` exports `getActiveEngine()` for exactly this, its
header says so verbatim, and it is already called from plain `.ts` modules (`clipplayer.ts`,
`push2-control.svelte.ts`). No platform PR is required for an audition.

### 2.4 `panel` cells cannot be ranked inside the lane budget

`module-face-lint` refuses a `panel` cell SELECTED at a lane tier, and the lane budget is six
(`curated-face.ts:46, 65`) — **so a panel's first legal rank is 7**, on every face, always. Three
of my drafts ranked a hero picture 6th before I caught it. It is worth a one-line comment in the
`ModuleFaceHero` doc so the next author does not.

---

## 3. THE DEFECTS THIS INVESTIGATION FOUND IN SHIPPED CODE

Ranked by how much they hurt. Every one is cited in the per-module spec.

| # | module | defect |
|---|---|---|
| 1 | **samsloop** | **A recorded sample never plays.** `pushSampleIfChanged` reads `d.fileBytesB64` then `d.samples`; the record path writes `d.sample.bytesB64`. REC persists, redraws, round-trips and downloads — and the module stays silent. No test asserts audio from a recording. |
| 2 | **sixstrum** | **The shipped face cannot play the instrument.** The STRUM audition never made it into `SHELL_CELLS`, and two comments in the repo assert that it did. |
| 3 | **bluebox** | `OUTPUT_NORM = 1.0` against three comments promising `/4`. **Two digits is exactly 0 dBFS; three clips; all twelve is +14.51 dBFS.** |
| 4 | **cube** | MORPH is **bit-exactly dead at spawn** (`floor` and `ceiling` default to the same table), plus SPREAD at max is −36.2 dB and `view_rot_z` is never read. |
| 5 | **clap** | WIDTH's loudness compensation has **the wrong sign** — 18.06 dB of level on a control documented as "shape, not volume" — **and its unit test is an amplitude window that cannot fail on it.** |
| 6 | **twotracks** | `echoes_b` is not a declared AudioParam. **Reel B's ECHOES knob does nothing, ever**, and the sweep exemptions that would have caught it cite tests for 186 lines of dead code. |
| 7 | **analogVco** | ~~The card passes `min={0}` for two params the def declares `−1..1`.~~ **FIXED 2026-08-08 in `de2c956b` (#1311)** — all six faders now bind through `paramSpec()`, gated at source level by `dead-control-fixes.test.ts`. |
| 8 | **macrooscillator** | MODAL (engine 7) is **inaudible** (−81.6 dBFS re-measured) and TIMBRE makes it *quieter*; WAVETABLE's MORPH 0..0.5 is a bit-exact no-op; **GRANULAR's MORPH is a 3-position switch** (found during the build, in no spec); four engines exceed full scale and the "bounded" test probes the quietest corner. ⚠ All still OPEN — the face DOCUMENTS them, it does not fix them. |
| 9 | **pentemelodica** | The MODE-1 tap is `x − bp` where the SVF notch is `x − k·bp`. At resonance 0.99 the "notch" is a **+33.8 dB resonant boost on the master bus.** |
| 10 | **drummergirl** | **TONE and SHAPE are swapped in every doc string, with the polarity also reversed.** The sentence a user reads first is wrong twice over. |
| 11 | **meowbox** | The `gate` doc says "responds to the edge, not how long the level stays up" — it is an ADSR sustaining at 0.4. **A gate at level 0.5 runs the attack at half speed.** |
| 12 | **noise** | `noise.test.ts:110-119` asserts pink noise "can briefly exceed ±1". It is **hard-bounded by 1 by construction**, so the assertion **cannot fail for the stated reason** — a decorative gate in the unit lane. |
| 13 | **sixstrum** | The **BASS preset** puts strings 1-3 below `KARPLUS_F0_MIN = 30 Hz`, so the clamp collapses **three of six strings onto one pitch.** |
| 14 | — | **Eight modules re-type their def's ranges in the card**, and only `cube` reads them from the def. Two of the eight already disagree (`analogVco`'s min, `twotracks`' curve) and one binds MIDI in the wrong units (`samsloop`'s rate). |
| 15 | — | **Nine modules declare gate/trigger ports with no `edge:`**, and `module-docs-lint.test.ts:217` does `if (!p.edge) continue` — **so the vocabulary gate is skipped entirely on exactly the modules whose prose is wrong about it.** |

---

## 4. CI WALL-TIME — the honest arithmetic for twelve faces

Each face adds **exactly two VRT scenes per platform** (`face-<type>-compact`,
`face-<type>-dock`, `e2e/vrt/workflow-shell-faces.spec.ts`) and **one `faces-parity` row** per
module (`e2e/tests/faces-parity.spec.ts:619-621`, registry-driven off `STRICT_FACES`).

**The required gate does NOT move.** `vrt-strict` narrows `testMatch` to `['vrt.spec.ts']` only
(`e2e/vrt/vrt.config.ts:32-37, 97`), and `workflow-shell-faces.spec.ts` is in `FULL_MATCH`
(`:59`) — the **informational** `vrt` job, which is `continue-on-error: true` and not in the `ci`
umbrella's `needs` (`.github/workflows/ci.yml:2262-2276`). So none of the 24 new scenes can block
a merge.

**Measured baseline, from a green main run** (run 30742314468, 2026-08-02): the informational
`vrt` job ran **13 min 5 s** wall, of which the `Run VRT` step was **621 s** at `workers: 1`
(`e2e/vrt/vrt.config.ts:107-108`), with a 20-minute job timeout. Today **26 of the 36 face scenes
actually run on linux** (36 committed darwin baselines, 10 `linux/face-*` pairs still exempt).

| lane | delta | gating? |
|---|---|---|
| **`vrt` (informational)** | **+24 scenes.** Each is a full `?shell=1` boot + palette spawn + viewport settle + screenshot — the same shape as the 26 already there. **Estimate +3 to +4 min on a 621 s single-worker step (~+30 %).** ⚠ **This is an ESTIMATE, not a measurement** — the per-scene cost is dominated by the page boot and I could not isolate it from CI data (the uploaded Playwright report is a shell with no results embedded). The way to settle it is to land ONE face and difference the `Run VRT` step. | **no** — `continue-on-error`, not in `needs` |
| **`vrt-strict` (REQUIRED)** | **+0 scenes.** But **three of the twelve are in `STRICT_VRT_MODULES`** — `drummergirl` (`vrt-exemptions.ts:880`), `meowbox` (`:885`) and `noise` (`:888`) — so **any legacy-card change on those three re-captures a REQUIRED baseline on both platforms.** clap additionally has **three composite scenes** on both platforms (`e2e/vrt/vrt-clap.spec.ts:48-61`), i.e. **8 PNGs** for a card change. | **yes, if the card moves** |
| **`e2e` (REQUIRED, 10 shards)** | +12 `faces-parity` rows. Cell counts: pentemelodica **49**, twotracks 32, cube 28, sixstrum 22, macrooscillator 11, clap 11, samsloop 10, bluebox 13, analogVco 7, drummergirl 7, meowbox 6, noise 2 = **198 driven cells**. At the ~0.8 s/cell the round-2 specs measured on the SwiftShader runner, plus ~8 s of boot per row, that is **≈ +260 s total ≈ +26 s per shard**. **Under the 2-minute bar per shard, but pentemelodica alone is ≈ +47 s on one shard** and is the row to watch. | **yes** |
| **darwin baselines** | 24 new PNGs captured locally; **24 linux PNGs need `vrt-update.yml` dispatches**, and each drain must lower the vrt-meta linux-deficit ratchet **in the same commit**. | — |

**Recommendation on cost:** ship the nine in **three PRs of three**, not one PR of nine. Each PR
is then one dispatch, three ratchet decrements and a differenceable `Run VRT` step — which turns
the estimate above into a measurement by the second PR. Dropping `noise`, `cube` and `twotracks`
also removes the two most expensive parity rows after pentemelodica (32 and 28 cells).

---

## 5. THE RULES THESE SPECS WERE WRITTEN UNDER

1. **A derived readout must name the perturbation that distinguishes it from a knob readback.**
   This was the most-repeated defect in round 2, so every `valueId` in these twelve files carries
   its negative control inline, and several carry a *second* leg that must **not** move — because
   a one-sided control passes on a readout that simply tracks everything.
2. **A control's range comes from ONE place: the def, imported by the card, never re-typed.**
   Eight of the twelve violate this today; §3-14 lists them.
3. **A bespoke visualiser cell is legitimate; a bespoke title, hint, sidebar or readout mechanism
   is not.** Every module here gets exactly one panel (its picture) and zero bespoke sidebars.
4. **`order` is a PRIORITY ranking for tiers that show a subset; `pages` is FUNCTION order for the
   tier that shows everything.** They disagree on purpose in several of these files, and each says
   so in its own comment.
5. **Never fold a DSP change into a face wave.** Six real audio fixes surfaced here (clap's WIDTH
   sign, pentemelodica's notch, macrooscillator's engine levels, cube's normal-translation
   degeneracy, samsloop's silent recording, sixstrum's BASS preset). **Every one is its own
   owner-audition PR.**
6. **Where I inferred rather than read, the spec says so.**
