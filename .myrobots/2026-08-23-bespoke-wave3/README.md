# BESPOKE FACE PROGRAM — WAVE 3 (the rack's TERMINAL, its GRID, and its TAPE)

Three spec packages for bespoke-surface modules chosen off the live roster
(`docs/design/face-migration.generated.md`, the `bespoke-surface` table on `main`).
Each is `spec.md` plus two browsable, self-contained HTML mocks.

**Method, per the owner's directive:** analyse what the module is FOR first, then author
the spec, then build from the spec. These are the analysis and the spec.
**Nothing here is implemented.**

| module | class | verdict | risk | est. |
|---|---|---|---|---|
| [`audioOut`](audioOut/spec.md) | the rack's TERMINAL — every patch ends here | **BLOCKED on one four-line precursor**, then PROMOTE | LOW / MED | ≈ 9 h / 2 PRs |
| [`kria`](kria/spec.md) | 4-track grid step-sequencer | **PROMOTE** — a fix-plus-face PR, zero attest | MEDIUM | ≈ 15 h |
| [`twotracks`](twotracks/spec.md) | 2-reel tape-loop emulator | **PROMOTE** — the wave's only genuine TAB-RAIL earner | MED-HIGH | ≈ 18 h |

## The mocks

* `audioOut/dock.html` · `audioOut/io-panel.html`
* `kria/dock.html` · `kria/dock-patterns.html`
* `twotracks/dock-tabs.html` · `twotracks/dock-reel-b.html`

House tokens, no external assets, no scripts.

---

## WHY THESE THREE

The brief asked for value = user-facing prominence × defect richness × unblocking power,
and excluded the already-specced (`electraControl`, `wavesculpt`), anything DOOM, the
note-entry-blocked VST pair, and the hardware-egress pair. What remained was ranked on
one question: **which module's face answers a question the fleet cannot currently
answer?**

* **`audioOut` — prominence, uncontested.** It is the rack's terminal sink: every patch
  in the product ends at it, and `workflow-pins.ts:126-127` spawns one into *every*
  workflow rackspace automatically. Nothing else on the roster is on screen for
  every user in every session. It is also the smallest surface in the wave, which
  makes it the cheapest possible test of a question nothing else asks: **what happens
  when you promote a module whose only surface is not the lane and not the dock?**
* **`kria` — unblocking power.** The `needs-note-entry-cell` blocker gates most of the
  sequencer half of the roster, and its own registry text says why: *"their step
  rosters are typed, not turned"* (`face-migration-inventory.ts:180-181`). **kria's
  step roster is neither typed nor turned — it is CLICKED**, which is exactly why the
  roster gives it no blocker. It is therefore the one member of the sequencer class
  buildable today, and building it settles the shape for the rest by demonstration
  instead of by argument.
* **`twotracks` — defect richness, and the wave's only honest tab rail.** It carries
  by far the most declared params of the three, a real two-canvas picture with
  draggable transport markers, and a documented four-phase roadmap whose later phases
  **already shipped without the description being updated**. It is also the only
  module in the wave that reaches `DOCK_TAB_MIN_BANDS` on its own honest structure,
  so it is where the control-heavy ruling gets tested without anyone padding pages.

The three are deliberately different SHAPES, and the difference is the point: `audioOut`
has one param and a surface problem, `kria` has two params and an entire instrument
living outside the param system, `twotracks` has a large disciplined param set and a
cost problem. A wave of three variations on one shape would have proved one thing.

**Attest position, measured not assumed** — `bash scripts/webgl-attest-hash.sh --list`
returns no path under `audio/modules/audio-out.ts`, `audio/modules/kria.ts`,
`audio/modules/twotracks.ts`, `AudioOutCard.svelte`, `KriaCard.svelte` or
`TwotracksCard.svelte`. **All three are outside the WebGL attest basis: zero GPU cost
for the whole wave.** Each spec restates the command and the result, and each warns
that a body written against a WebGL context would enter the basis automatically,
because rule (2) is derived from CONTENT.

---

## THE FINDING THAT IS LARGER THAN ANY OF THE THREE

**The fleet's raw-write discipline is a `params`-shaped gate, and the bespoke-surface
cohort keeps its instrument in `data`.**

`mutate.guard.test.ts` is a model gate: it was itself caught blind once, widened, and
now carries a named deny-by-default ledger (`raw-write-ledger.ts`) anchored in both
directions with its blind spots stated inside itself. Its subject is a regex whose
literal anchor is the token `.params`:

```
mutate.guard.test.ts:94
/\.params(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*(?:\*\*|\?\?|\|\||&&|<<|>>>?|[-+*/%|&^])?=(?![=>])/
```

**A write to `.data` matches nothing.** There is no sibling ledger: no
`RAW_DATA_LEDGER`, no data-write guard, nothing under `packages/web/src` or `e2e`
that reads `node.data` assignments the way this reads `node.params` assignments.

That would be a footnote if `data` were a backwater. It is the opposite. **`data` is
where a bespoke surface keeps the thing that makes it bespoke** — which is the
definition of the cohort this whole program is working through:

| module | what lives in `node.data` | undoable? |
|---|---|---|
| `kria` | the ENTIRE sequencer — four tracks × seven per-step lanes × sixteen steps, the pattern bank, the active + cued slot | **NO** |
| `audioOut` | the chosen output device (`outputDeviceId`) | **NO** |
| `twotracks` | the recorded tape length (`bufLenA`) — engine-owned, correctly | n/a (not a user edit) |

And the consequence is not theoretical. `mutate.ts:12-15` states the rule and
`store.ts:70` implements it:

```
createUndoManager: trackedOrigins: new Set<unknown>([LOCAL_ORIGIN])
```

An edit is undoable **only** if its transaction carried `LOCAL_ORIGIN`.

* `KriaCard.svelte:118` — `ydoc.transact(() => { … })`, **no origin argument**. The
  transaction origin is `null`, which is not in the tracked set. **Every step you click
  into kria, every pattern you cue, every empty slot you seed is outside Cmd-Z.**
* `AudioOutCard.svelte:63-69` — `target.data['outputDeviceId'] = deviceId`, a bare
  proxy write **outside any transaction at all**.

Both sit beside controls that are correctly routed: kria's BPM knob and RUN button both
go through `setNodeParam`, three lines from the grid that does not. So this is not a
module that forgot the seam — it is a module that used the seam **everywhere the seam
covers**, and the seam does not cover its instrument.

**The routing call, and it is deliberately not one PR.** The two module-level fixes are
small and ride their own face PRs (each spec budgets its own). The platform question —
whether `data` gets an origin-tagged seam and a ledger of its own — is a separate,
owner-facing decision, because the answer changes what "undo" means for every bespoke
module still ahead of us on the roster. **This wave reports it; it does not build it,
and no spec here assumes it lands.** Each spec's fix is written to be correct on its
own: pass `LOCAL_ORIGIN`, which is one argument.

⚠ **And note which direction the blindness runs.** A green `mutate.guard` run today
reads as *"no unledgered raw writes exist"*. What it actually establishes is *"no
unledgered raw **param** writes exist"* — and for the modules this program is about,
that is close to a statement about the empty set. The ledger's own header is a model of
stating what it cannot see; this is the one thing it does not say.

---

## THE LANE-PICTURE DECISION, THREE MORE TIMES, THREE MORE MECHANISMS

Wave 2 established the shape of this question and answered it for its three: **#2160
removed a refusal, it did not add a data path**, so a layout-source glyph is a CONSTANT
picture — `ShellExtensionGlyphProps` (`shell-extensions.ts:72-74`) still carries no
`nodeId`, so **every instance of a module would draw a byte-identical picture.**
Re-verified on this tree, not inherited.

All three of this wave refuse a lane picture, and — as in wave 2 — the test of whether
each is an argument rather than a copy is that the three refusals have three different
mechanisms. Measured against `primaryAudioOutPortId` (`shell-glyph-live.ts:111-113`),
which is `def.outputs.find(o => o.type === 'audio')`:

| module | outputs | resolves | why the glyph is refused |
|---|---|---|---|
| `audioOut` | **none at all** (terminal sink) | every literal → dead static | **Mechanically protected**, like `dockscope`. An author who never thought about it ships the right thing. ⚠ And this is the module where a picture is most WANTED and least reachable — see below |
| `kria` | `pitch*` / `gate*`, no `audio` | every literal → dead static | Also mechanically protected. The picture kria would want is the playhead over sixteen steps — which is per-node AND per-selected-track, so it needs strictly more than the missing `nodeId` |
| `twotracks` | `out_l`, `out_r`, **both `type:'audio'`** | **LIVE on `out_l`** | ⚠ **Unprotected — scope's trap class.** A literal is legal, live, green on every gate. Refused because *"stopped", "empty" and "monitoring silence" are the same flat picture*, and the thing a player wants at a glance — is there tape, where is the playhead — is in none of them |

**The escalation, restated with a stronger candidate than wave 2 had, and a caveat that
weakens it.** Wave 2 nominated `scope` as the fleet's best adopter for a `nodeId` on
`ShellExtensionGlyphProps`. `audioOut` is a better *argument*: its picture would be the
terminal L/R level, which is (a) not a passthrough lie — it is measured after the master
gain and the limiter, at the same node that feeds `ctx.destination`; (b) already tapped
and already negative-controlled in both directions on every run by
`art/scenarios/audio-out/per-channel-taps.test.ts`; and (c) the single most useful thing
a rack-wide glance could carry, since **the module every patch terminates at currently
cannot tell you whether it is clipping.**

⚠ **But `audioOut` is a worse *adopter*, and the spec says so rather than overselling
it:** the pinned instance is canvas-hidden, so it has **no lane tile to paint a glyph
on**. The picture would reach only user-ADDED instances, which are the minority case.
`scope` remains the right first adopter; `audioOut` is the best argument for why the
prop is worth adding.

---

## THE PER-MODULE DEFECT LEDGERS

Each spec carries its own, with evidence and a routing call. The items **live on `main`
today and independent of any face**:

* **`audioOut`** — `formatDeviceLabel` (`audio/devices.ts:149-155`) is shared by the
  AUDIO IN and AUDIO OUT cards and unconditionally returns **`Input #N`**, so the
  OUTPUT picker lists speakers as inputs; its own unit test
  (`devices.test.ts:128-133`) pins `'Input #1'` and is direction-blind, so **a green
  gate certifies the live bug**. The device pick is un-undoable and untransacted. The
  `<select>` disables itself with no explanation when the browser supports `setSinkId`
  but enumeration returned nothing. And the `onMount` device-detect `setInterval`
  (`:146-165`) is never cleared on destroy — it can outlive the card by up to its full
  retry window and write `$state` after unmount, which is the
  card-unmount-kills-node-resources class from the other side.
* **`kria`** — the card can edit **four** of the module's per-step lanes and none of its
  per-track ones. `ratchet`, `probability`, `glide`, `loopStart`, `loopLength`,
  `timeDivision`, `direction`, `muted`, `scale` and `root` are all documented in the
  def's own `docs.explanation`, all implemented in the engine (glide `kria.ts:253-260`,
  probability `:267-268`, ratchet `:277-285`), and **all unreachable from the card** —
  only an attached monome grid over WebSerial reaches them, while
  `module-manifest.ts:290` says the module is *"FULLY usable from the card with a
  mouse."* Plus: OCT-page row 0 is click-responsive and can never light (two rows alias
  to the same value); every cell's accessible name is a bare grid coordinate that never
  says what the cell means on the current page; `onMeterFrame` is imported and never
  used, beside a hand-rolled uncapped rAF that is the thing it exists to replace; and
  every cell click rewrites the **whole pattern object**, so two collaborators editing
  different tracks of one pattern overwrite each other.
* **`twotracks`** — `DESCRIPTIONS.twotracks` (`module-manifest.ts:429`) says *"Phase 1
  ships reel A … Phase 2 adds reel B, EQ, and filter; Phase 3 adds Lofi saturation;
  Phase 4 adds CV ins"* while the def ships reel B, all three EQ bands, the filter,
  `lofi`, and the `rate_cv_a`/`rate_cv_b` CV inputs. **The user-facing description is
  three phases stale**, and the docs gate checks presence and quality rather than truth
  — the same class as wave 2's `scope` header. Its VRT exemption's exit condition
  (`vrt-exemptions.ts:1062`) is written in the retired two-platform vocabulary and so
  can never be discharged as worded.

⚠ **One thing checked and NOT reported as a defect.** `ALLOWED_PERMANENT_EXEMPT`
listing `twotracks` beside an `EXEMPT_FROM_VRT` reason that promises promotion looked
like a contradiction. Reading the list's own header (`vrt-exemptions.ts:1122-1129`)
refutes it by name: *"NOT AN ENDORSEMENT … Many entries are mechanical ('no baseline
captured yet') rather than permanent."* It is a brake, not a permanence claim. Recorded
because the wrong version of this was one edit away from being written down as a
finding.

---

## THE #2166 CLASS — CHECKED FOR ALL THREE, AND TWO ARE ALREADY NAMED

The brief asked for a sweep for "conveniently un-faced fixture" uses. The result is
better than expected in one direction and worse in another.

**Better:** `e2e/tests/_face-fixtures.ts` already carries a `DENIED` map — deny-by-default,
one reason per entry, explicitly *"anchored by the consuming specs, so an entry naming
a module the golden does not know is RED instead of quietly decorative"* — and **two of
this wave's three are already in it**, with reasons that are hard measured facts rather
than guesses:

* `audioOut` (`:70-73`) — *"the rack MASTER OUTPUT: `AudioIoSurface.svelte` hosts it
  (and audioIn) in a dedicated I/O drawer via DockCardHost, so it **never renders the
  lane tile + dock full view the bridge specs assert on**."*
* `twotracks` (`:74-77`) — *"it mounts, but the bridge test **timed out at 30 s in
  `boundingBox`** waiting for it."*

Neither is the #2166 failure mode. Both are the CURE for it: a named exclusion carrying
its evidence, which is what the class asks for.

**Worse:** the `audioOut` entry is not merely a test note — **it is the promotion
blocker, stated by someone who was not thinking about promotion.** See below.

`kria` has no such entry and none of the un-faced-fixture comments
(`workflow-rear-card.spec.ts:672`, `midi-binding-node-lifetime.spec.ts`,
`extras-producer-lifetime.spec.ts`, `workflow-shell.spec.ts:270`) names it; the ones
that pick a subject derive it from `STRICT_FACES` rather than hard-coding, which is the
repaired form.

---

## ⚠ THE `audioOut` BLOCKER, AND WHY IT IS THE MOST INTERESTING THING IN THE WAVE

**A pure rule exists, is correct, and has a caller that does not call it.**

`legacy-fallback.ts:229-231` is three lines:

```ts
export function dockRailRendersFace(i: DockRailRenderInput): boolean {
  return i.shellFaces && i.pinned && i.migrated;
}
```

Its header (`:186-188`) states the reasoning exactly: *"a PINNED occupant is
canvas-hidden … so it has NO lane tile, NO EXPAND pill and no route to `DockFullView`.
**The tray is its ONLY surface, and it is therefore the only place its face can
appear.**"* `Canvas.svelte:2043` calls it for the drawer rail.

**`AudioIoSurface.svelte` never calls it.** Both of its `DockCardHost` mounts
(`:171-179` and `:207-215`) pass `node`, `nodeTypes`, `rackSize`, `scale`, `title` and
two scale callbacks — **and no `face` prop**. `DockCardHost.svelte:71` defaults it
`face = false`. So the pinned AUDIO OUT renders `nodeTypes[node.type]`, the verbatim
legacy card, unconditionally and forever.

Combine that with the `DENIED` entry above — the pinned instance has no lane tile and
no dock full view — and the conclusion is not "a cosmetic split":

> **Promote `audioOut` today and the face renders on user-ADDED instances only. On the
> pinned one — the one auto-spawned into every workflow rackspace, the one the 🎧 panel
> exists to house — nothing changes at all.**

And **two independent mechanisms would hide it.** The one VRT scene covering that panel,
`e2e/vrt/workflow-audio-io-composite.spec.ts` — written for an owner-reported breakage
of exactly these two hosted cards, *"this should have been caught with vrt analysis"* —
drives `/rack?shell=legacy` at `:53`. Under `?shell=legacy`, `shellFaces` is false, so
`dockRailRendersFace` is false regardless of the missing prop. **That scene is
structurally incapable of ever showing a face in that panel**, and would stay green
through the whole promotion.

This is the CLAUDE.md precondition class, and the tree already named it **for the
neighbouring surface**: `legacy-fallback.ts:200-204` warns that *"THE THREE SHIPPED
DRAWER SPECS CANNOT SEE THIS CHANGE — `workflow-dock.spec.ts` and `workflow-mode.spec.ts`
both drive `/rack?shell=legacy`, so they exercise the `false` arm forever."* The audio
I/O panel has the identical condition and no such warning.

**The precursor is four lines** (thread `shellFaces` + `migrated` into `AudioIoSurface`
and call the existing pure rule twice) plus a default-shell scene that can actually
fail. It is its own PR because it flips the pinned AUDIO IN at the same time, and
`audioIn` carries a `getUserMedia` capability dependency that a face PR should not be
holding when it goes red on CI. §0 of `audioOut/spec.md` specifies it.

---

## THE `editorSurface` NOTE — the slot named for this cohort still has no render site

`WIRED_SHELL_EXTENSION_SLOTS` (`shell-extensions.ts:124`) is `['glyph', 'fullViewBody']`.
`editorSurface` is declared and **unwired**, described (`:75-79`) as *"a bespoke EDITOR
SURFACE for controls that are not cell-shaped at all (a clip arranger, **a pad matrix**)"*
— and kria's step editor is a pad matrix by that definition.

**No spec here reaches for it.** All three route through `fullViewBody`, which is wired,
dock-only, paints above the bands, replaces the hero glyph, and — the load-bearing half —
**leaves every param cell intact** (`:85-87`), so face completeness, dock render-plan
parity and `faces-parity` still apply. That is the `rasterize` / `pong` / `timelorde`
precedent and it needs no platform change. Recorded because "the slot for this exact
thing exists and does not render" is worth knowing before someone wires it speculatively
for a module that did not need it.

---

## BUILD ORDER RECOMMENDATION

**`kria` first.** It is the only one of the three with no precursor and no cost problem:
zero attest (measured), no pinned-surface complication, no tab-rail question, and its
face PR pays a defect list that is live today on a module whose own manifest oversells
it. It is also the one whose result the roster is waiting on — a clicked step grid on a
faceplate settles the shape for the sequencer cohort, and settling it by a merged face
is worth more than settling it by three more specs.

**`audioOut` second, as TWO PRs.** PR 1 is the four-line `AudioIoSurface` wiring plus a
default-shell scene, and it should land alone and be looked at, because it changes what
the 🎧 panel shows for the pinned AUDIO IN as well. PR 2 is then an ordinary
one-param face. ⚠ Doing PR 2 without PR 1 produces a face nobody can see, which is the
single most expensive mistake available in this wave — it would merge green, satisfy
every gate, and change nothing a user can reach.

**`twotracks` last.** It is the largest, it is the only tab-rail case, and its mount cost
is a measured problem (`HEAVY_MOUNT_TIMEOUT = 30_000`, a 30 s `boundingBox` timeout in
the fixture bridge, `io-spec-consistency.spec.ts:173-175` naming the 580 px card by
name) rather than a suspicion. The tab rail is the remedy as well as the requirement,
which makes it the one face in the wave whose success has a number attached — and that
number should be measured against a `main` baseline before and after, not asserted.
