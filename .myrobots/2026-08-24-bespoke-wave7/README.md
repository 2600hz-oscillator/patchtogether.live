# BESPOKE FACE PROGRAM — WAVE 7 (the HARDWARE CONTROL SURFACES, and the cohort that turned out not to be one)

Seven specs, one nominal cohort: **`controlSurface`, `gamepad`,
`launchpadControlLeft`, `push2Control`, `outToLaunch`, `es9`, `midiLane`.**

The wave was commissioned on a stated shared design problem: *"a PHYSICAL DEVICE is
the interaction. The roster of devices lives behind a browser API and is READ from
the engine; mapping/assignment is the primary surface, not a knob list."*

**That sentence is false of this cohort, and disproving it produced something more
useful than seven faceplates.** The shared reasoning lives in
[`SURFACES.md`](SURFACES.md); this file is the wave's entry point, its verdict
index, and the two things that need to leave this wave and go somewhere else.

Nothing here is implemented. This is a spec. Measured against `origin/main`
@ `99a961b08`.

---

## 0. THE TWO HEADLINES

### 0.1 THE COHORT DOES NOT SHARE ONE DEVICE-BINDING SHAPE — disproved four ways, not argued

Every one of these is a one-command check. [`SURFACES.md §0`](SURFACES.md) carries
them in full.

1. ⚠ **One member has no device at all.** `controlSurface` is `domain: 'meta'`,
   zero ports, zero params, no `docs`, and no browser device API anywhere in its
   def, card or graph module. It is a **table of bindings between modules already
   in the rack**, and it is in this cohort **by NAME ONLY**.
2. ⚠ **The other six use FIVE distinct transports** — a poll-based Gamepad API with
   no permission prompt at all (`gamepad`), Web MIDI (`midiLane`,
   `launchpadControlLeft`, `outToLaunch`), Web MIDI **plus** a second independent
   WebUSB grant (`push2Control`), and **a WebSocket to a native helper process**
   (`es9`, which has no browser permission flow and cannot be reached from HTTPS at
   all).
3. ⚠ **Three domains** — `meta`, `audio`, `video` — and the fleet rulings are scoped
   by domain, so exactly one of the seven is inside the SCREEN ON/OFF ruling.
4. ⚠ **The lane is already split by a shipped carve-out** that nobody has been
   reading: `controlSurface` and `launchpadControlLeft` are in
   `NON_SHELL_LANE_TYPES` and the other five are not — so **promotion means two
   different things** inside one cohort (§2).

**A convergence would have been a smaller result.** "One capability unblocks N" is
the assumption these waves keep being sent to test, and this is the third
consecutive wave to find it false — wave 5 on the platform ask, wave 6 on the media
controller, wave 7 on the premise itself.

### 0.2 ⚠⚠ THE BLOCKING FINDING — a `face` on a card that mounts TYPED ENTRY reddens a gate no wave has listed, and it hits FIVE modules including all THREE that wave 6 scheduled

This is the wave's most consequential output and it is a live, mechanical,
reproducible red — not a design opinion. [`SURFACES.md §2`](SURFACES.md) has the
full chain; the short form:

* Authoring a `face` **forces** `disposition: 'generic-face'`
  (`face-migration-inventory.test.ts:229`), which **forces** an empty `blockers`
  array (`:268`), which trips the TYPED-ENTRY leg (`:509-528`) if the module's
  **legacy card** mounts `<input type="text"|"number"|…>`, `<textarea>`,
  `contenteditable` or `<NoteEntry>`.
* ⚠ **Wave 6 §5.2's prescription — "drop `needs-note-entry-cell` from the blockers
  array" — is necessary and does NOT fix it.** The offending branch fires on the
  DISPOSITION and `continue`s **before** the code ever reads the blockers array.
* **Measured, instrument negative-controlled:** it hits **`controlSurface`** and
  **`midiLane`** here, and **`archivist`, `peertube` and `recorderbox`** — all three
  of wave 6's recommendation targets.
* **The reason it has never fired:** the only three modules promoted since `#1512`
  shipped the extension slot — `midiclock`, `kria`, `matrixmix` — all have clean
  cards.

⚠ **The sharpest form: ONE FILE uses TWO subjects for one concept, and both are
individually defensible.** `:346` makes the blocker's own liveness probe read
`ModuleShell.svelte`, *"the ONE renderer every face cell is painted by"*; `:512`
makes the disposition leg read the legacy CARD; and a `fullViewBody` is **neither**.
The probe correctly reads FALSE — the shell genuinely has no text CELL, so the
blocker is live and must not be deleted — while a body carrying an `<input>` is
perfectly legal and invisible to it. **That is CLAUDE.md's blind-gate shape verbatim:
the subject was quietly redefined when a feature shipped underneath it, and neither
leg was revisited.**

**It is escalated, with two concrete forms rather than a direction** — see §6.

---

## 1. THE ONE GENUINE CONVERGENCE — seven "permanent" VRT exemptions, and a drain that landed today

**7 of 7 are in `EXEMPT_FROM_VRT` AND on `ALLOWED_PERMANENT_EXEMPT`**
(`e2e/vrt/vrt-exemptions.ts:450, 457, 639, 686, 687, 774, 868`; the permanent set at
`:1205-1226`), under one rationale written seven ways: *the card's content depends on
a device that is not present in CI.*

**It was falsified hours before this wave started.** `midiclock` was on that list,
carried that rationale, shipped a face as `#2187`, and was drained on 2026-08-24 —
*"the second drain, after `cvBuddy` above, and the first in the MIDI-binder block"*
(`:1216-1222`). **So "permanent" is not a claim about these modules. It is a record
of which ones nobody has drained yet.**

**Every spec in this wave therefore answers one question in one marked line: what
would make ITS module drainable?** That converts a shared excuse into seven
separate, checkable claims, and it is the wave's most useful output for whoever
drains the third one. Several of the exemptions concede the answer in their own
words — `controlSurface`'s says *"empty state is a blank square"*, `es9`'s says
*"card is static chrome"*, which is not a device-dependence claim at all.

⚠ **And the cost every spec predicts rather than discovers: a drain is THREE files,
not two.** `vrt.spec.ts:52` builds `COVERED_MODULES` as
`REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`, so draining also enrols the
LEGACY CARD. Verified against the shipped drain: `midiclock` has exactly three
committed PNGs, and its own spec had predicted 2.

---

## 2. ⚠ THE LANE CARVE-OUT SPLITS THE COHORT, AND EVERY SPEC SAYS WHICH SIDE IT IS ON

`legacy-fallback.ts:110-129`, `NON_SHELL_LANE_TYPES`:

| side | members | `laneRenderKind` | what a face MEANS |
|---|---|---|---|
| **INSIDE** | `controlSurface`, `launchpadControlLeft` | `'legacy'` — the verbatim card | **no shell lane tile exists.** A face is DOCK-ONLY, and promotion means removing the module from the set |
| **OUTSIDE** | `push2Control`, `gamepad`, `es9`, `midiLane`, `outToLaunch` | `'placeholder'` | a RACKLINE tile exists and is EMPTY; a face fills it |

⚠ **The compact-by-default reasoning differs on the two sides.** A module with no
lane tile has no section-heading-versus-caption tradeoff to make — which is exactly
why `face.bareCells` is dock-only. Each spec states its side before it argues width.

⚠ **`push2Control` is on the "outside" by OMISSION, not by design**, and the
consequence is user-visible today. Its own header says *"Modeled on ElectraControl /
LaunchpadControl"* (`push2-control.ts:41-43`) and **both models are in the set while
it is not** — so at plain `/rack` it is a name, a badge and an empty jack rail, and
the one gesture without which it does nothing is dock-only. ⚠ **The fix is the FACE,
not adding it to the set**: `cameraInput`'s removal from that set on promotion is
the shipped direction of travel.

**And `main` already asserts this in CI, for a different reason.**
`launchpad-monitor-survives-card-collapse.spec.ts:154-159` spawns `outToLaunch` at
the DEFAULT shell and asserts, in its own words, *"Un-migrated (`bespoke-surface`)
module under the shell: no real card in the lane at all. **Its card exists ONLY
inside the dock full-view.**"* A derivation and a shipped assertion agreeing is much
stronger evidence than either alone.

---

## 3. THE GATES — five, plus the sixth that will actually stop a PR

Full text with citations in [`SURFACES.md §5`](SURFACES.md). In brief:

1. **the face lints / `STRICT_FACES` anchor** — `module-face-lint.test.ts`; the set
   is asserted EQUAL to the defs declaring a `face`, both directions, so authoring
   the `face` IS the promotion.
2. **the VRT baselines (compact + dock)** — ⚠ **dispatch `GREP=<module> task
   vrt:commit`**, never bare (§5).
3. **`EXTENSION_BODY_ROLES`** — ⚠ **THREE roles now**, not two:
   `'picture' | 'status-primitive' | 'control-grid'`
   (`face-rack-status-source.test.ts:143`). Wave 6's README explicitly records
   `control-grid` as non-existent because at the time it lived only on an open PR;
   **it has merged**, and the role anchor changed shape too — `:805-825` is now a
   SET IDENTITY against `ROLE_PREDICATE`'s keys, not a hand-typed pair.
4. **`module-docs-lint`'s FAMILY↔CARD leg** — `module-docs-lint.test.ts:359-375`,
   PRESENCE-ONLY by its own comment. ⚠ The honest fix is ADDING the testid to the
   card, never dropping the family.
5. **the `optionsExhaustive` SNAP contract** — `param-vocabulary.test.ts:130-203`.
   ONE implementation: `snapToOptions`.

**And the sixth: `face-migration-inventory.test.ts`'s three interlocking legs**
(§0.2). It is not on any prior wave's list and it is the one that reddens.

---

## 4. COHORT-WIDE COSTS, measured once so no spec re-derives them

| cost | who pays |
|---|---|
| **WebGL attest** | ⚠ **`outToLaunch` ONLY.** `resolveWebglBasis()` (`webgl-attest-lib.ts:259-263`) walks **all** of `packages/web/src/lib/video` excluding `*.test.ts`, so `out-to-launch.ts` is in-basis by whole-dir inclusion. The other six are **ZERO** |
| **a face BODY entering the attest basis** | ⚠ possible for any of them: `:267-272` walks **all** of `lib/ui/modules` and enrols any `.svelte` whose comment-stripped source matches ``WEBGL_CONTEXT_RE = /getContext\(\s*['"`]webgl2?['"`]/`` (`:40`). **A 2-D canvas body is free; a WebGL one is not.** Belongs in each body's `EXTENSION_BODY_ROLES` `why`, where the next author reads it before reaching for a shader |
| **ART** | ZERO for all seven — `controlSurface` and `push2Control` have no ports at all, `outToLaunch` is a video sink, and no member has an audio output path a baseline could pin |
| **Push 2 card** | ⚠ **ZERO, and verified**: no cohort member has a `PUSH_CARD_CONTROLS` override (`grep` over `push-card-config.ts` returns nothing), so none can be re-ranked by a face and none should be pinned — `midiclock`'s face argues why (`midiclock.ts:270-278`: an override REPLACES rather than merges, so pinning silently keeps a future param off the hardware forever) |
| **`contract-lock`** | unchanged wherever no port or param moves — `face` is contract-transparent |
| **docs / `STRICT_DOCS`** | ⚠ **three of seven are BEHIND the ratchet**: `controlSurface`, `push2Control` and `launchpadControlLeft` have no `docs` field and are absent from `STRICT_DOCS`, while `es9` (`:29`), `midiLane` (`:226`), `gamepad` (`:229`) and `outToLaunch` (`:460`) are all in. A face PR is the module's own PR, so it owes the co-located `docs` + the `STRICT_DOCS` entry + `task docs:accept`. Docs are hash-transparent by design, so this costs nothing even on a basis file |
| **`_face-fixtures.ts`** | ⚠ **nothing to delete** — no cohort member has an entry, so wave 6's ledger item 6 (a `DENIED` entry going INVISIBLE rather than red on promotion) does not apply here. Stated as a checked negative, because that class is invisible by construction |

---

## 5. ⚠ A PER-PR COST EVERY FACE WAVE IS CURRENTLY PAYING — `GREP=` on the VRT dispatch

Recorded here rather than in a spec, because it applies to **every** face PR in
every wave and this wave found it by re-reading rather than assuming.

CLAUDE.md's VRT section: the scope derivation **"reads PATHS ONLY"** — the
diff-content tokenizer was **deleted 2026-08-23** because it inferred module names
from prose and from ordinary identifiers, and forced full sweeps on single-module
PRs three times in one week.

⚠ **Every face PR touches a shared roster file whose path names no module. So a bare
`task vrt:commit` on a face PR DERIVES FULL** — measured **41-56 min unscoped
against ~3 min scoped** (#1795).

**Always dispatch `GREP=<module> flox activate -- task vrt:commit`.** It is safe
because scoping cannot silently under-capture where it gates: `vrt-strict` reddens on
the next CI run and names the file.

---

## 6. WHAT NEEDS AN OWNER DECISION

**One**, and it reaches beyond this cohort. Full text in
[`SURFACES.md §9.1`](SURFACES.md), with **two concrete forms** in §9.1.1 so the
choice is between options rather than a direction.

**How does a face land on a module whose LEGACY CARD mounts typed entry?** (§0.2.)
Three routes, each costing something a standing ruling protects:

| route | cost |
|---|---|
| **(a) strip the `<input>` from the legacy card** | ⚠ a **functional-parity** cost on `?shell=legacy`, and *"we would lose X is never an owner choice to surface"* points away from it |
| **(b) correct the gate's subject** | ⚠ the **no-CI-changes ruling (2026-08-23)**. Nothing is being added, weakened or exempted — an existing gate's subject went stale when `#1512` shipped underneath it — but the ruling is broad and the interpretation is the owner's |
| **(c) don't promote the five** | ⚠ costs two modules here plus three wave 6 already scheduled |

A **fourth** route is named in order to be refused: the leg skips
`organizational-native` (`:522`), so re-dispositioning a module into that bucket to
dodge it would be a green gate certifying nothing.

⚠ **Route (b) resolves into TWO forms, and the argument that decides between them is
a refusal rather than a preference:**

> **The obvious form of (b) — "have the gate read what the face actually RENDERS" —
> would be BLIND ON EXACTLY THE COHORT IT IS MEANT TO COVER.** A device-picker body
> renders its `<input>` only after a grant, and **CI has no device**, so the scan
> reads *"no typed entry"* and the gate passes **FOR THE WRONG REASON**. That is
> *"a gate whose PRECONDITION is the defect cannot fail on the defect"* in its
> purest form: the measured condition made true by absent hardware rather than by
> correct code.

So the conditional-body case decides **for** a SOURCE scan rather than against one —
a source scan sees a conditional `<input>` whatever branch it is in, and a runtime
scan does not:

* **(b1) THE PARITY FORM** — *a `generic-face` module whose card mounts typed entry
  is an offender UNLESS its face declares an `extension` whose `fullViewBody` also
  mounts typed entry.* Deny-by-default with **no list**, anchored both directions,
  ~10 lines, same tier, and every helper it needs already exists and is already
  exported. ⚠ **Strictly STRONGER than today's leg** — it adds a parity requirement
  where today there is a flat prohibition — and it leaves the blocker untouched.
* **(b2) THE RENDER FORM** — a DOM oracle over the promoted face. **Refused**: wrong
  tier (a source scan becomes an e2e), and ⚠ **blind on exactly this cohort** —
  a device-picker body renders its `<input>` only after a grant and CI has no
  device, so the scan would read "no typed entry" and pass **for the wrong reason**.
  That is *"a gate whose PRECONDITION is the defect cannot fail on the defect"* in
  its purest form.

**Nothing is blocked on the answer.** All five affected specs are written so the
face DESIGN is identical either way; only the PR's file list changes.

---

## 7. THE VERDICTS

Per-module reasoning lives in each `spec.md`; [`SURFACES.md §8`](SURFACES.md) is the
same index with the body roles.

| module | spec | side of the carve-out | typed-entry blocked? |
|---|---|---|---|
| `push2Control` | [`push2Control/spec.md`](push2Control/spec.md) — **PROMOTE, no precursor** | outside | no |
| `launchpadControlLeft` | [`launchpadControlLeft/spec.md`](launchpadControlLeft/spec.md) | **inside** — dock-only face | no |
| `outToLaunch` | [`outToLaunch/spec.md`](outToLaunch/spec.md) | outside | no |
| `controlSurface` | [`controlSurface/spec.md`](controlSurface/spec.md) | **inside** — dock-only face | ⚠ **YES** (§0.2) |
| `gamepad` | [`gamepad/spec.md`](gamepad/spec.md) | outside | no |
| `es9` | [`es9/spec.md`](es9/spec.md) | outside | no |
| `midiLane` | [`midiLane/spec.md`](midiLane/spec.md) | outside | ⚠ **YES** (§0.2) |

---

## 8. STANDING CORRECTIONS TO THE PRIOR WAVES

Each was believed on entry and each was checked. Full text in
[`SURFACES.md §10`](SURFACES.md).

1. ⚠ **`EXTENSION_BODY_ROLES` has THREE roles, not two.** Wave 6's README calls
   `control-grid` non-existent; it has merged, and the role anchor changed shape as
   well. **Wave 6's own lesson applied to wave 6**: an unmerged PR's contents read
   exactly like merged tree state, and nothing but going and looking distinguishes
   them.
2. ⚠ **Wave 6 §5.2's `needs-note-entry-cell` prescription is insufficient** — its
   reasoning is right and its remedy is aimed one layer off (§0.2).
3. ⚠ **Wave 5 `BINDERS.md §6`'s "decide the inherited rationale once at the root"
   HAS HAPPENED**, in the direction of draining (§1). Two `"same rationale as
   midiCvBuddy"` references remain (`vrt-exemptions.ts:746`, `:769`).
4. ⚠ **The `env`-for-selectors ask now has THREE independent refutations on three
   different axes** — CAPABILITY (wave 5: `ShellCellEnv.engine` is `{ write }` with
   no `read`), REACH (wave 6: a roster on `raw.githubusercontent.com`), and now
   **OWNERSHIP** (`push2Control`: a roster in `localStorage`, which no engine handle
   of any shape reaches, and moving it into the Y.Doc would be a multiplayer
   regression). Not re-proposed anywhere in this wave.
5. ⚠ **`task vrt:commit` no longer scopes from diff CONTENT** (§5) — a stale claim
   this wave was carrying itself, caught by re-reading rather than by a gate.
6. **A grep is not the gate.** ⚠ A line-based `git grep` of a whole-file predicate
   returned a clean, plausible, **empty** answer across 14 cards, because every one
   of those tags is written multi-line. **The gate's own four named positive
   controls are what caught it.** Had the first scan shipped, the conclusion would
   have been "nobody is affected" and five modules would have hit it one at a time.
   The corrected instrument is inlined in [`SURFACES.md §10`](SURFACES.md) so the
   scan can be re-run without trusting this document.

---

## 9. THE FAN-OUT

Paired by shared design problem, with the two most similar members put **together**
so a convergence claim would have been falsifiable rather than assumed — wave 6's
method, applied to a cohort where it produced the opposite answer.

| agent | modules | why paired |
|---|---|---|
| A | `launchpadControlLeft`, `outToLaunch` | ⚠ **the same physical device, driven in OPPOSITE directions** — pads → rack, and rack → the same pads as a 9×9 RGB monitor. If one binding shape existed anywhere in the cohort, it would be here |
| B | `controlSurface`, `gamepad` | **tables of OTHER things** — neither has params of its own; both are `control-grid` candidates against the `matrixMix` precedent |
| C | `es9`, `midiLane` | **the two BRIDGES**, at opposite ends of wave 5's "how much of the module is the binding" axis — `es9` is the cohort's only member with real params, `midiLane` its purest zero-param binder |
| orchestrator | `push2Control` + [`SURFACES.md`](SURFACES.md) + this file | the member on the wrong side of the lane carve-out, and the one whose state is in neither `params` nor `node.data` |
