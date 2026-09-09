# Bespoke-surface lessons — what seven waves of surface specs actually taught

Distilled reusable judgment from the bespoke face program (waves 1-7, the
face-spec batches and the cut derivations). These are **lessons, not specs**: the
per-module designs shipped, several of them differently from what was specified,
and the specs' own factual frames (legacy cards, a `?shell=legacy` fallback, a
generated migration inventory) are all superseded — `ModuleShell` is the only
module UI. Verify anything load-bearing against the tree before acting on it.

Provenance: git tag `myrobots-preserved-2026-09`, records under
`2026-08-23-bespoke-wave1/` … `2026-08-24-bespoke-wave7/`, `face-specs/`,
`plans/face-specs-*` and `plans/faceplate-queue-*`.

## 1. Test the commissioning premise before you design to it

Wave 7 was commissioned on "these seven modules share one device-binding design
problem." The premise was false at the root, and disproving it was worth more
than seven faceplates: one member had **no device at all** (a meta module with
zero ports, zero params, and no browser device API anywhere — a table of bindings
between modules already in the rack, in the cohort by name only); the other six
used **five distinct transports** with structurally unrelated availability
stories (a poll with no permission prompt, Web MIDI, Web MIDI plus a second
optional WebUSB grant, and a WebSocket to a native helper that HTTPS cannot
reach); and they spanned **three domains**, which matters because the fleet
rulings are scoped by domain — exactly one of the seven was inside the video
screen ruling. Each of those was a one-command check rather than an argument.
"One capability unblocks N" is the assumption these waves kept being sent to
test, and three consecutive waves found it false. **A refuted convergence is a
smaller-sounding and more useful result than a specified one.**

## 2. Run the search before asserting — or refuting — a platform blocker

One wave produced both halves of this in the same week: an ask was **refuted** by
looking for the capability and finding it already reachable
(`getActiveEngine()` in the engine ref returns the full engine from plain `.ts`,
and the shell-cells file says so twice in its own comments), and a different
blocker was **established** by looking and not finding it (a face cell's caption
is `ParamDef.label` and nothing else — there is no node-derived caption anywhere
in the shell, which is a functional-parity loss and therefore never surfaced as
an owner choice). The difference between a real platform blocker and an invented
one is whether anybody ran the search, and both searches must be recorded by file
and line. Two riders: a **correct diagnosis followed by an unnecessary
prescription** is harder to catch than a wrong diagnosis, because everything up
to the last paragraph checks out; and **a warning scoped to one cell shape does
not generalise to another** — a false-blocker warning filed under "actions" was
re-invented independently for selectors by two agents who never reached it.

## 3. A blocker can be a tax rather than a gate — ask which

A migration blocker that reads like a gate is often a lifecycle **tax** that a
module can simply pay. Two modules shipped faces with the media blocker
outstanding, by paying the headless-host tax, before any wave asked whether it
blocked anything. So state per module exactly what tax it pays — a headless host,
a status registry, or nothing at all because the module already owns its state on
the graph — rather than requesting a capability. The discriminator is **"is the
state IN THE GRAPH?"**: graph state and engine-node registries need no
card-status registry, and a device whose poll the engine node owns needs none
either. And keep the two facts apart: **"the last blocked module shipped" and
"the blocker resolved" are different claims, and usually only the first happened.**

## 4. The migration hazard is GREEN-AND-BLIND, not red

The recurring failure was never a red test. It was an assertion whose
**precondition changed underneath it**: specs that reached a module through a
fixture pinned to the surface being replaced kept passing while observing a
surface no user operated — measured once at **all 18 of `gamepad.spec.ts`'s
tests**, every one booting the surface that module's face was about to replace
(`2026-08-24-bespoke-wave7/SURFACES.md:1118`); a spec that names
a module *because* it is un-migrated goes quietly green and blind the moment it
is promoted; an assertion that "the shell renders no real card" stayed true and
silently became a different claim. The general form: **when a spec's subject can
be redefined by the change you are making, it is a candidate, and the failure is
silent by construction.** The two useful moves are to re-point the spec at the
shipping surface in the same PR (a red in the right place is the good half), and
to prefer a spec that parameterises over both states while both exist.

## 5. Choose the extension slot by mechanism, not by taste

The ladder is declarative face → shared shell cell/panel → shell extension
(`tileBody` or `fullViewBody`) → bespoke surface, and each step has a mechanical
entry condition.
`ShellPanelCell` requires a real `minWidth` **number** and a probe vocabulary of
`data`/`data-rev`/`text` — if your surface's width depends on two other modules,
any number is a fiction in a required field, and if its observable is
`patch.edges` between two *other* nodes, the required probe cannot see it; that
is a `fullViewBody`, not a panel. The discriminator that decides it cleanly:
**a panel shows a derived picture; a body does a per-frame engine read.** A
panel is dock-only by lint, because a 280 px SVG selected into a 46 px lane
column is truncated only by coincidence. Never wire `editorSurface` on a module
PR — it is still unwired. And a **control-family key resolves ONE cell for all
instances**, so a family is the wrong tool when the instances must differ.

**The extension step has two wired slots and they are not interchangeable**
(`ui/workflow/shell-extensions.ts:144` wires `glyph`, `fullViewBody`, `tileBody`).
`fullViewBody` is the **dock's** surface; `tileBody` is the **lane tile's**, and
its entry condition is a non-`ParamDef` control a player must reach **without
expanding the module** — cameraInput's device picker, controlSurface's
node-lifetime prune. Putting such a control only in the full view leaves the
module unusable from the lane, which is where it is normally met
(`shell-extensions.ts:81-92`). A `tileBody` is a complement to the face, never a
replacement, and it stays small: the tile is about 192 px wide and the shell
budgets its height. Note the asymmetry with the gates: a `tileBody` takes no
`EXTENSION_BODY_ROLES` entry, so it needs its own named leg (checklist, gate 3).

## 6. Rank against the DSP; `order` is priority and `pages` is function

Let order and pages disagree — the rear is a projection of pages, not of order.
An **enabler ranks above its dependents and never more than one rank apart**, so
that every prefix of `order` is a usable subset. Where a rank is genuinely
arbitrary — symmetric channel strips have no principled ordering — say in the
comment that it is declaration order rather than inventing a justification.
Layout has hard shapes: five symmetric strips of eight are inexpressible in a
flat `face.order`, a matrix is **one band of N clusters** (four bands pack into
two rows of eight and destroy the grid), and seven bands hits
`ui/workflow/dock-tabs-model.ts:DOCK_TAB_MIN_BANDS` so the face becomes a tab rail
**on purpose** — do not "fix" it back to six. Group by lane, never by control
type. Put in the body only what cannot be a cell.

## 7. A face is the first surface obliged to rank every param

Which makes it the first thing that finds **declared-but-inert params**. The
honest answer is to delete them or wire them, not to bury them in
`noUserControl` — a declared control read by nothing must be resolved *before* it
is ranked. Same discipline on the other side: a host-written value must not be a
user `ParamDef`, and a discrete `node.data` setting that behaves like a
parameter is an undeclared `ParamDef` — promote it or keep it off the face.

## 8. A panel READS; it does not own state

There are exactly two honest answers when a surface wants to show something the
model does not own: promote the `node.data` behind it to real `ParamDef`s, or
keep it off the face. Never draw a playhead the worklet does not post back. A
**modal toolbar cannot be face cells**, because cells cannot hold one shared
mode. On an all-`momentary` module a durable-param reader is constant zero (the
shell scrubs every durable write), so a hero panel polls the live engine and a
parity probe must press **and release**. And an `action` cell has no built-in
probe — `toBeEnabled()` plus a click asserts nothing about effect, so every
audition needs its own before/after negative control, shaped like the DSP it
drives (a sustaining envelope wants a held gate, not the shared short pulse).

## 9. Ownership survives the surface, or it dies with it

Ongoing behaviour belongs in the module factory and must work with no UI
mounted; one-shot behaviour belongs in one plain TypeScript action seam so a
second surface is a call rather than a copy. The corollaries the waves added:
**instrument state that no node owns is invisible to every discipline gate**; a
component that *produces* something is invisible to seam-derived producer gates
when its seam is a plain `.ts` bridge (a derived set that enumerates SEAMS is a
filter that redefines the check's subject); and the single-owner rule extends to
engine-side apply — it must not live in a surface that can unmount. When a
renderer has to move, **extract it into one mountable surface first**, rather
than blitting a headless component's frame. The node-owned shape that works:
one surface per node mounted by a node-keyed host, views CLAIM the canvas by DOM
move with ranked claims re-resolved on release, and the host owns the wrapper so
a re-key does not orphan the surface.

## 10. `.data`-resident instruments transact, or they lose undo and multiplayer

The mutation guard is params-shaped and blind to `node.data`, so a module whose
instrument lives there must transact through `mutateNode` with `LOCAL_ORIGIN`
rather than writing the proxy. A bare `ydoc.transact(fn)` with **no origin** is
exactly as un-undoable as a raw proxy write and survives review because it looks
correct. Whole-object `node.data` rewrites are a last-writer-wins defect in
multiplayer — and can be load-bearing for proxy-identity reads, so replacing one
is a two-sided change. SyncedStore nested arrays take `splice`, never index
assignment. Never rebuild a live Y map to "reload" it.

## 11. Device modules: name what owns the device's lifetime

The first question for a device surface is **who owns the device's lifetime — a
graph node, or the machine?** If the machine owns it, the answer is a shared
*arbiter*, never a shared body. If a graph node owns the poll, no status registry
is needed at all. Because a cell caption is `ParamDef.label` only, a module with
N identical slots over a named roster puts the per-node names on a **body slot
board** — that is the template for every device module, not a one-off. And the
"it is only a transient toast" exemption is refused for resting text, because
transience is unbounded.

**Then classify the TRANSPORT, because the class predicts the design.** Ask how
the module learns its hardware is there, and the answer is one of three:
a **PERMISSION** (`requestMIDIAccess`, `getUserMedia`, `navigator.hid`) — the
roster is N-ary and per-machine, the attempt is gesture-gated, the empty state is
*ask*, and a VRT scene is free because the bad state is unreachable without a
click; a **PROCESS** (a socket to a local helper) — the roster is unary, the
attempt is unconditional and eternal, the empty state is *install and run*, and a
VRT scene has to be **earned** by deleting the retry's own animating text, so the
drain is a consequence of that deletion rather than a bet; or **NEITHER** — the
module has no binding at all and is in the device cohort by resemblance only.
One question, read straight off the transport, predicts four independent things —
empty state, roster arity, whether the scene is baselinable, and glyph
availability. §1's count of five distinct transports across one seven-module
cohort is the evidence that the class, not the cohort, is what transfers.

## 12. SCREEN OFF is a screen switch, not a producer kill switch

Every video face carries the screen toggle (shared collapsed state persisted on
the node, corner overlay, paint-only skip). What it must **not** do is stop the
producer: an accumulating source keeps drawing and keeps marking itself watched,
a stateful video DSP that stops blitting ages out of its watch TTL and loses its
state, and the blit is the watch mark. A surface whose body IS the control has to
keep marking watched even while the screen is off. Rendering is a DSP dependency
for these modules, which is exactly why the switch is a *visibility* control. The
seam that discharges this is `ui/meter-frame.ts:onMeterFrame`: the visibility-
gated `onMeterFrame(el, draw)` form is for **paint-only** work, and a loop that
accumulates, captures or marks watched takes `onMeterFrame(null, cb)` so nothing
gates it (checklist, "Costs to predict rather than discover"). Classifying the
loop is the whole difference between a screen switch and a producer kill switch.
Also: previewing an unconnected output port shows a never-written buffer, which
is a reason to refuse a monitor rather than to ship a black rectangle.

## 13. Measured figures reproduce; inferred prescriptions do not

Read every spec as a **hypothesis**: re-measure its load-bearing figures before
building. Across the program the pattern was uniform — measurements held and
prescriptions failed. A recommendation is not an owner ruling. Re-check a
rejection against the **code**, not against the previous index that recorded it:
a refusal can be correct on its date and fully discharged a week later, so
"no face on merit" gets re-litigated from the tree rather than inherited. When a
spec cannot measure something, it says so as a must-verify item with a pass
shape, instead of a confident guess.

## 14. Two gates are blind in the same direction as the bug they guard

Worth stating on its own because it recurs: a gate whose precondition is the
defect cannot fail on the defect, and a def-reading gate cannot see a surface
that widens what the contract allows. So a lane that ranks controls and paints
none, a surface drawn in knob space, a live-resolving glyph with nothing behind
it, and a re-typed bound are all invisible by construction. When you find one,
the durable output is a **named negative leg** pinned in the tree — not a note in
a record — because nothing else records that the blind spot was ever measured.
