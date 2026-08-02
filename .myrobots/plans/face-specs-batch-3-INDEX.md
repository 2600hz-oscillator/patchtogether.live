# FACE SPECS — BATCH 3 · the index

**SPEC AND MOCKUP ONLY. Nothing here is implemented, no module def is touched.** The owner
reviews these and the gallery before any building starts.

- **Mockup gallery (one file, self-contained):** `.myrobots/mockups/face-batch-3-gallery.html`
- **Per-module specs:** `.myrobots/plans/face-specs-batch-3-<module>.md` (twelve files)
- **Designed against:** the PF-20 faceplate platform on `feat/faceplate-platform-v2`
  (**PR #1301, NOT yet merged**) — `face.title` / `face.hint`, per-band `hint`,
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
| **macrooscillator** | PROMOTE — **PARTIAL REWRITE** | Adds three params (`strike_decay`, `strike_colour`, `aux_level`) and a patched-sensing strike gate; puts the 14 engine names in the def as `ParamDef.options`; hero readout says **what HARMONICS means in THIS engine**. |
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
   still always paints: it is the panel's name, not a note about it.

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
| 7 | **analogVco** | The card passes `min={0}` for two params the def declares `−1..1`. **The entire negative half of both modulation-depth controls has no user interface**, and the feature it disables is unit-tested. |
| 8 | **macrooscillator** | MODAL (engine 7) is **inaudible** (−79.9 dBFS) and TIMBRE makes it *quieter*; WAVETABLE's MORPH 0..0.5 is a bit-exact no-op; four engines exceed full scale and the "bounded" test probes the quietest corner. |
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
