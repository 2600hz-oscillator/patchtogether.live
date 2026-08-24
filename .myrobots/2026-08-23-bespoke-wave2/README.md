# BESPOKE FACE PROGRAM — WAVE 2 (the card-drawn-picture family)

Three spec packages for the modules whose picture is drawn by their CARD, chosen as the
remainder of the five-module cohort `shell-glyph-live.ts` names by hand. Each is `spec.md`
plus two browsable, self-contained HTML mocks.

**Method, per the owner's directive:** analyse what the module is FOR first, then author
the spec, then build from the spec. These are the analysis and the spec.
**Nothing here is implemented.**

| module | class | verdict | risk | est. |
|---|---|---|---|---|
| [`scope`](scope/spec.md) | the rack's two-channel probe | **PROMOTE** — one PR, zero attest | LOW-MED | ≈ 11 h |
| [`rasterize`](rasterize/spec.md) | audio → picture bridge | **ALREADY FACED (#2001).** The open question is the LANE GLYPH; answered NO, with a new argument | LOW | ≈ 4.25 h |
| [`wavesculpt`](wavesculpt/spec.md) | 4-voice 3D video synth | **BLOCKED on one precursor PR**, then PROMOTE | HIGH | ≈ 26 h / 2 PRs |

## The mocks

* `scope/dock.html` · `scope/dock-xy.html`
* `rasterize/lane-decision.html` · `rasterize/dock-audit.html`
* `wavesculpt/dock-tabs.html` · `wavesculpt/dock-monitor.html`

House tokens, no external assets, no scripts.

---

## ⚠ ONE PREMISE IN THE BRIEF WAS STALE, AND CORRECTING IT RESHAPED A THIRD OF THE WORK

The wave was commissioned on the understanding that all three modules were unfaced.
**`rasterize` has been faced since #2001 (merged as #2018).** MEASURED: `rasterizeDef.face`
at `rasterize.ts:208-223`, `'rasterize'` in `STRICT_FACES`, a shipped
`shell-extension.ts` + `RasterizeOutputBody.svelte`, a ten-block
`rasterize-face-model.test.ts`, two committed dock baselines, and a `DONE (#2001)` entry
in the migration inventory.

So its package answers the question that IS open — the one #2160 created yesterday — and
audits the shipped face instead of proposing one. That turned out to be the most useful of
the three, because `rasterize` is the only member of the five-module cohort already faced,
which makes the glyph question a one-word experiment rather than a whole promotion.

---

## THE FINDING THAT IS LARGER THAN ANY OF THE THREE

**#2160 removed a refusal; it did not add a data path. A layout-source glyph is a
CONSTANT PICTURE.**

The widening lets a module declare `glyph: 'algorithm'` with a `face.extension` and get
`{ kind: 'algorithm', layoutSource: <ext>, paramId: null }` — live-kind, green on the
dead-glyph clause. But:

* `ModuleShell.svelte:462` is `if (b.paramId === null) return 0;` — `topologyValue` is
  **hardcoded 0** for every node, forever;
* `:473` returns `''` for the caption;
* `ShellExtensionGlyphProps` (`shell-extensions.ts:44-51`) is `{ num, numbers?, testid? }`
  — **no `nodeId`, no engine, no store**, in deliberate contrast to
  `ShellExtensionFullViewBodyProps`, which is `{ nodeId }`;
* and `laneGlyphFor` (`module-shell-model.ts:237-240`) ranks it `'trace'`, whose
  precedence is tier-dependent: at `'full'` it renders *"only when a whole strip-row still
  fits UNDER the cell rows"* (`:767-786`) and is dropped from a busy plate, while at
  `'compact'` it paints unconditionally and takes space from the ranked cells. Only
  `'picture'` gets the inverted precedence, and `'picture'` requires `domain === 'video'`.

So the picture cannot vary per node or over time, and it is absent where detail is wanted
and present where the tile can least afford it. **All three modules refuse a lane picture,
and the three refusals
have three different mechanisms** — that is the test of whether each is an argument rather
than a copy:

| module | why the obvious glyph fails |
|---|---|
| `scope` | it has `type:'audio'` outputs, so any literal resolves **live** on `ch1_out` — which IS `gain1`, bit-exactly the module's input. **Invariant to all nine controls**, and specifically claims to be the thing the module exists to draw. Green on every gate |
| `rasterize` | same live-but-blind shape on `thru`; the def already recorded it. The NEW option (`algorithm`) is the constant above |
| `wavesculpt` | ⚠ **the one case where a live glyph would be HONEST** — `L` is the summed mix, not a passthrough, and it moves with the controls. Refused anyway: it asserts the audio half of a module whose whole claim is that the sound and the picture are one field, and a player would read the tile as "an oscillator" |

**The escalation, and it is one prop:** give `ShellExtensionGlyphProps` a `nodeId`.
`scope` is the fleet's best adopter — it already owns a pure, tested, resolution-
independent draw function and a live engine seam. **Platform PR, not a face PR.**

---

## THE MISTAKE THIS WAVE NEARLY MADE, AND WHY IT IS IN ALL THREE SPECS

The first draft of two of these packages reported the un-undoable bare-proxy param write
on `ScopeCard` and `RasterizeCard` as a NEW defect, and wrote *"promotion fixes it for
free."*

Both halves were wrong, and the tree already says so. The writes are **named, classified
entries in `graph/raw-write-ledger.ts`** (`ScopeCard` `keys:['mode']`, `RasterizeCard`
`keys:['wrap']`, `WavesculptCard` `keys:['pos_x','pos_y','zoom','rot']`, all
`kind: 'debt'`), deny-by-default in both directions. And `:202-210` refutes the "free"
claim by name, filed against #2025 for making it:

> *"A face does not pay a card's debt; editing the card does."*

A face gives faced users the fixed control and leaves `?shell=legacy` users the broken
one. Each spec now budgets the actual payment — edit the card **and** delete the ledger
entry, both or neither — with `GatemaidenCard` (Q53) and `JoystickCard` (Q43) as the two
worked precedents.

---

## THE PER-MODULE DEFECT LEDGERS

Fourteen items across the three packages, each with evidence and a routing call. The ones
**live on `main` today and independent of any face**:

* **`scope`** — the file header calls the CV range *"unipolar 0..1"* when
  `pixelFromSample` is bipolar ±5 (and `docs.controls` contradicts itself in the same
  sentence); the XY toggle's ledgered raw write is outstanding; and **the fleet has no
  pitch assertion that runs** — `scope-tuner.spec.ts:18` is `test.fixme`'d under flake
  park #1847, so the only live leg checks the em-dash placeholder on the legacy card.
  The face's `aria-label` route is the deterministic assertion that park wanted.
* **`rasterize`** — the SCREEN switch is correctly built and **structurally invisible to
  its own gate** (`video-face-screen-source.test.ts` sweeps `listVideoModuleDefs()`; this
  is an audio def), so deleting it tomorrow goes green; the legacy card's redraw is an
  ungated rAF paying a 786 432-pixel `ImageData` allocation per frame off-screen;
  `read('cursor')` has **zero consumers** (measured) and must be KEPT rather than swept,
  because it is the observable a #2000 fix would assert against; three stale records,
  including the def's own *"matches no glyph kind"*.
* **`wavesculpt`** — the VIEW button's caption (`3D` / `SPECTRO`) disagrees with
  `VIDEO_MODE_OPTIONS` (`PROXIMITY` / `SPECTROGRAPH`) **and with its own `title`
  attribute, on the same element**, in the file whose comment says the rosters exist to
  prevent exactly that; the roster label `RIBBONS` appears on no surface at the shipped
  default; the two pads' drag writes are outstanding ledger debt.

⚠ **`readCamShadow` is owner-listed and was NOT touched, read around, or reasoned from.**
It appears once, in the wavesculpt ledger, marked as such.

---

## THE GATE HOLE ALL THREE SHARE

`video-face-screen-source.test.ts:71-76` builds its subject as
`listVideoModuleDefs().filter(d => STRICT_FACES.has(d.type))`. **Every module in this wave
is `domain: 'audio'` with a `fullViewBody`, so all three are out of that gate's scope by
construction.** `rasterize` proves it today: it ships the fleet-standard switch and
nothing certifies it.

The fix is mechanical and already exists as a predicate —
`face-rack-status-source.test.ts:106-115`'s `extensionsWithBody()` reads the DIRECTORY, so
it is domain-blind by construction. ⚠ **It cannot ride a face PR**: widening reddens audio
bodies that legitimately have no switch (`dockscope` and `samsloop` both carry recorded
derivations for why they do not), so each needs a named `(type, why)` exemption first.
**Its own PR, and it must add exemptions with reasons rather than a domain filter — a
filter would re-create the hole one layer down.**

---

## BUILD ORDER RECOMMENDATION

**`rasterize` first.** It is ≈ 4 h, needs no platform change, pays two live defects and
one dead-seam correction, and — most usefully — **it is the cheapest possible test of
whether #2160 has a useful adopter.** Doing it first means the `scope` and `wavesculpt`
glyph sections are settled by a merged experiment rather than by three parallel readings
of the same source.

**`scope` second.** The `dockscope` precedent is exact, the attest is measured at zero,
and the one owner-visible call (the tuner — §5 of its spec) benefits from being asked
early rather than at merge.

**`wavesculpt` last, and never as one PR.** PR 1 extracts the WebGL renderer out of the
3 644-line card into a mountable surface (the `cube` shape) and carries the one `params`
edit, so the two hash-moving changes pay **one** GPU attest instead of two. PR 2 is then a
zero-attest face. ⚠ **Neither may self-merge** — `wavesculpt` is on the owner's
manual-review list.
