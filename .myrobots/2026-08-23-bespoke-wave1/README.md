# BESPOKE FACE PROGRAM — WAVE 1

Four DX7-grade spec packages, chosen for range across the bespoke classes rather than for
ease. Each is `spec.md` plus two browsable, self-contained HTML mocks.

**Method, per the owner's directive:** analyse what the module is FOR first, then author the
spec, then build from the spec. These are the analysis and the spec. **Nothing here is
implemented.**

| module | class | verdict | risk | est. |
|---|---|---|---|---|
| [`lushgarden`](lushgarden/spec.md) | generative video source | **PROMOTE** — fix-plus-face in one PR | LOW-MED | ≈ 12.5 h |
| [`timelorde`](timelorde/spec.md) | the transport / clock brain | **PROMOTE** — one platform escalation | MEDIUM | ≈ 11 h |
| [`pong`](pong/spec.md) | game | **PROMOTE** — a determinism PR wearing a faceplate | MED-HIGH | ≈ 17 h |
| [`electraControl`](electraControl/spec.md) | control surface | **BLOCKED — two platform PRs first** | HIGH | ≈ 19 h / 2 PRs |

## The mocks

* `timelorde/dock.html` · `timelorde/dock-monitor.html`
* `lushgarden/dock-screen-on.html` · `lushgarden/dock-screen-off.html`
* `pong/dock.html` · `pong/lane-tiers.html`
* `electraControl/drawer.html` · `electraControl/drawer-renaming.html`

Open them in a browser. House tokens, no external assets, no scripts.

---

## What the four have in common, and what they do not

Every package follows the same spine — module analysis, STOP 1 (parity), STOP 2 (the data-in
grep), the constraint map, the rank with its argument and its named losers, the band
structure, the control inventory with each primitive decision argued, a state matrix, the
ARIA contract, the determinism plan, the cost with a **verified** attest expectation, a
defect ledger, taste calls with reverts, a MUST-VERIFY list and a verification gate.

Two sections the DX7 exemplar carries are **deliberately absent from all four**: the HERO
READOUT STRIP and the SIDEBAR. Both mechanisms were deleted fleet-wide on 2026-08-19; there
is nothing to migrate to. Where a deleted readout carried a real FINDING, the package names
which finding lost its surface and where the value went instead.

## Three findings that are LARGER than any single module

**1 · An AUDIO-domain module with a card-drawn picture has NO LANE SURFACE.**
`hasVideoSurface(def)` is `domain === 'video'`, and a def with no `audio` output port makes
every glyph literal but `'none'` resolve to a dead static glyph. `ShellExtension.glyph` exists
but renders only under the `'algorithm'` binding, which requires an `algorithm` param.
**Affected: `timelorde`, `pong`, `scope`, `rasterize`, `wavesculpt`** — every card-drawn
picture on an audio def, two of them in this wave. The widening is already prescribed by
`shell-glyph-live.ts`'s own comment (*"do NOT add a third glyph literal: widen THIS branch to
carry a layout-source id"*). **One platform PR, not five module notes.**

**2 · The SCREEN-ON/OFF ruling is unenforceable for exactly the modules in finding 1.**
`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs()`, so an audio-domain module
with a `fullViewBody` is structurally invisible to it. The mechanically-derived population
already exists (`face-rack-status-source.test.ts`'s `extensionsWithBody()`). Widening the
sweep would red existing modules, so it needs its own PR.

**3 · There is no PROBE SHAPE for a hardware-egress action.** `ShellActionCell.probe`
supports `audition` (the engine ledger), `param`, `data` and `text` — none of which can
observe *a SysEx preset reached a MIDI device*. `electraControl`, `launchpadControl` and
`controlSurface` all have such an action, so it gates the rest of the bespoke-surface cohort.

## The per-module defect ledgers

Twenty-eight defects are recorded across the four packages, each with evidence and a severity
call (fold into the face PR / report / owner decision). The ones that are **live on `main`
today and independent of any face**:

* **lushgarden** — three synthetic params with no `noUserControl` declaration are reachable on
  the Push 2 and the group instrument bar; turning one **permanently disables the RATE knob**
  with no signal, and turning another stops the module rendering.
* **pong** — a rank-1-worthy control that does nothing until the ball goes out (and can be
  permanently inert); an unbounded velocity accumulator with no clamp; a court rendering at
  half its documented size; and `vizPassthrough: true` advertising a portal that finds
  nothing.
* **timelorde** — an external clock lock **overwrites** the stored BPM with no undo marker;
  a 12-state param whose names live only in a card-local array.
* **electraControl** — only the FIRST board ever reaches the hardware, and in workflow mode
  the pinned instance sorts first, so the canvas board a user is looking at is the one
  silently ignored; a slot can hold a binding the user can neither see nor remove.

Every one is reported to the orchestrator for routing. **None is fixed in this docs PR.**

## One correction to an existing record

`face-migration-inventory.ts` records `needs-note-entry-cell` as `electraControl`'s blocker.
Reading the blocker's own definition and probe: it is about a **face CELL** painted by
`ModuleShell`. The rename field in this design lives inside a module-owned `fullViewBody`
that `ModuleShell` never paints, so the blocker does not apply to this route. It remains real
for `vstInstrument` and `vstFx`, whose typed field must be a ranked control — so the blocker
survives and only this membership changes. **A stale scoping claim produces no failure, only
absent work.**

## Build order recommendation

**`lushgarden` first.** It is the only one of the four whose face PR pays a live P1 defect on
two surfaces nobody is watching, its determinism story is the strongest in the wave (the seed
hook makes the surface time-invariant rather than merely phase-pinned), and the whole package
lands at **zero WebGL attest** provided nothing touches a param. It also has no platform
dependency: every mechanism it needs already ships and is already adopted elsewhere.
