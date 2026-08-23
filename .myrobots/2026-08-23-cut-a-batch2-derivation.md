# Cut A batch 2 — the re-derivation, and what it moved

Written 2026-08-23 against `main` at `3cf8ca78c`. **Evidence, not instruction.**
Every claim below is a read site you can open, and every number is a command you
can re-run.

The batch was assigned four modules from the Cut A "plain" set — `shapedramps`,
`joystick`, `dockscope`, `samsloop` — with the instruction to re-derive each card
shape live rather than trust the table. That instruction is the whole story of
this document: **three of the four are not what the table says they are.**

## What shipped

| module | Cut A said | what it IS | outcome |
|---|---|---|---|
| `shapedramps` | PLAIN | PLAIN — 8 continuous params, no switches, no rosters | **FACED** |
| `dockscope` | PLAIN, "the trace IS the `scope` glyph" | needs a `fullViewBody`; the glyph would paint a FAKE trace | **FACED**, with the glyph refused |
| `joystick` | PLAIN, "migrate onto the shared `xy` cell" | its lane tile would be EMPTY | **REFUSED**, and the refusal is now enforced |
| `samsloop` | PLAIN, "every cell it needs already ships" | 3 of its 8 affordances are not params at all | **REPORTED OUT** — a future solo |

Also in this PR, because the batch could not land without it: the audio
legacy-fallback **fixture is redesigned for the end state**, and the zero-lane
refusal is **converted from a comment into a gate**.

---

## 1. The fixture — the batch's blocking dependency

`dockscope` and `samsloop` were the ENTIRE remaining `_face-fixtures` audio pool.
Facing them empties it, and an empty pool with un-promoted modules still present
returned `kind: 'no-candidate'` — RED, "fixture defect".

**Measured before the change** (`e2e/tests/_face-fixtures.ts`, probed directly):

```
AUDIO   pool = [dockscope, samsloop]   pick = dockscope   unpromoted = 38
```

### The root cause was not scarcity

Of the 38 un-promoted audio modules, **31 were rejected by one predicate** —
`rendersAudioFaceplate`, "its cable types put it in another domain class". That
predicate existed for exactly one reason: `workflow-shell.spec.ts:266` hard-coded
`.faceplate.audio`. **An assertion's hard-coding wearing a fitness check's
clothes.**

### Three changes

**(a) Split by requirement.** One fixture served three legs, so its predicates
were the UNION of their requirements. Only the operability leg drives
`.fader-wrap .track` or reads the plate's domain class; the two EXPAND-pill legs
(`workflow-shell.spec.ts:806`, `workflow-dock-ux.spec.ts:105`) need a module that
renders a placeholder and nothing more.

**(b) Derive the domain class instead of requiring one.** The class is now read
off the golden and asserted. This is **stricter, not looser** — the leg now
proves the plate carries the RIGHT class for whatever subject it was handed. And
it immediately changed the answer: the new operable pick is `modtris`, whose
class is `gate`. `.faceplate.audio` was about to be *wrong*, not merely narrow.

**(c) "Blind predicate" and "finished migration" stopped being the same value.**
Both produced an empty pool and both resolved to RED. Worse, the arm meant to be
the designed end state fired only when NOTHING in the domain was un-promoted — a
state audio will never reach, because a dozen games and MIDI surfaces are
`bespoke-surface` and were never queued for a face. **The reachable outcome was
the wrong one.** The fitness predicate now also runs over the WHOLE population:
accepts nothing anywhere ⇒ the instrument went blind (RED, still catching the
`<Fader>` → `<NeonFader>` rename class); accepts plenty but all promoted ⇒
subject-less by design (the existing named skip).

**Measured after:**

```
AUDIO_PLACEHOLDER  pool = 34  eligible = 121  pick = clockedRunner
AUDIO_OPERABLE     pool =  4  eligible =  40  pick = modtris (class=gate)
VIDEO / VIDEO_SINK unchanged, both healthy
```

### The slack floor is deleted

`pool.length <= 1` was a population threshold sitting with **zero slack** against
the live pool (two members, tripping at one) — the "floor sitting exactly ON the
population" hazard. And what it protected, "a promotion from here is survivable",
became unconditionally true once emptying degrades to a named skip. Replaced by
the unconditional check plus a **permanent negative control calling the same
predicate in both directions**: it accepts something, and it still refuses a
snowflake and an unknown type by name.

⚠ One predicate had to be ADDED, not just removed: `rendersPlaceholderTile`
(a resolvable card, and not a `NON_SHELL_LANE_TYPES` snowflake). The audio side
never had it and was only accidentally safe — the domain filter happened to
exclude `clipplayer`/`controlSurface`/`electraControl`, which render their
verbatim legacy card and no placeholder at all.

---

## 2. `joystick` — REFUSED, and the refusal is now enforced

The refusal exists in three live comments (`strict-faces.ts`, `types.ts`,
`quadralogical.ts`). **It is real, and it was enforced by nothing.**

**The mechanism, verified live.** `curated-face.ts:131-143` `laneOrder` deletes
every `pad.x` from the lane order; `foldedOrder` (`:156-161`) removes the partner
`y` at every tier. joystick declares exactly two params and both are the pad's
axes, so its lane roster is `[]`. There is no glyph to fall back on either:
`glyphBinding` reaches a live trace only through a primary AUDIO output, and
joystick declares four `cv` outputs and no audio, so every glyph literal resolves
`{ kind: 'static' }` — refused by name by the dead-glyph clause. The tile would
be a title bar and a jack rail with nothing between them: **worse than the
placeholder it replaces.** `curated-face.test.ts:414-433` already builds this
exact shape and asserts zero controls.

**Nothing failed on it.** The cap-vs-fit-plan clause asserts
`rendered === face.controls.length`, which for a pad-only face is `0 === 0` and
green. `param-cell-coverage` counts primitive kinds. No e2e asserts occupancy.
The only executable assertion was `quadralogical-face-model.test.ts:140-154`,
scoped to one def. **A joystick face would have shipped GREEN with a blank tile.**

### Two stale comments, corrected in this PR

- `JoystickCard.svelte:4` claimed *"joystick is in STRICT_FACES (queue Q43), so
  … this card only paints under `?shell=legacy`"*. **False** — joystick declares
  no `face` and is not in `STRICT_FACES`. That card is the live dock surface.
- `joystick.ts:99-130` tells a different blocker story entirely (an `XyPad`
  readout), declares all three of its sub-blockers cleared, concludes *"Q43 is
  now UNBLOCKED"*, and **never mentions the zero-lane problem**. Both bullets are
  true and the conclusion is wrong.

### The gate that replaces the lore

`module-face-lint.test.ts` now denies a promoted face that RANKS controls and
resolves to none of them at a lane tier.

⚠ **The first draft got the predicate wrong, and the tree corrected it on the
first run.** Written as "the tile must paint something", it failed `flipper` — a
promoted, deliberate, documented face declaring `params: []` because the module
genuinely has no controls (*"ONE BAND WOULD BE ONE BAND TOO MANY … the faceplate
IS the jack field"*). `videoOut` is the same shape from the other end.

So **emptiness is not the defect. The defect is a lane that promises controls and
paints none.** flipper drops nothing; joystick drops everything it has. Framing
it as the DROP also removed the exemption flipper would otherwise have needed.

Four permanent legs: the sweep, an anchor, a vacuity control, and three negative
controls — the joystick shape caught at all three lane tiers *with its pad still
reachable at the dock* (so it is a lane problem, not a dead control); one ranked
control clears it; and the "ranks nothing" exclusion pinned to flipper's real
shape so it cannot become a blanket escape reachable by emptying `order`.

**The paths forward are platform work**, not face work: a glyph binding that can
paint a pad's position (`types.ts:818-821` already prescribes the shape), or
lifting the pad-in-lane restriction (`LANE_CELL_H.xy` is already carried at its
real 96 px against that day). Both move all four pad-bearing faces' lane tiles
and baselines.

---

## 3. `dockscope` — FACED, with the recommended glyph refused

The inventory note says *"the trace IS the `scope` glyph (analogVco is the
precedent)"*. **Verified false.**

`glyphBinding` (`shell-glyph-live.ts:112-171`) has no `'scope'` branch. A `scope`
glyph falls through to `:156`, which requires `primaryAudioOutPortId` — the first
declared `audio` OUTPUT. **`dockscope` declares `outputs: []`**; it is a terminal
visualiser that observes and never passes through. So the binding resolves
`{ kind: 'static' }`: the deterministic placeholder waveform.

`glyph: 'scope'` would have **compiled, passed `VALID_GLYPHS`, and painted a
picture that is not this module's signal** — a green gate certifying a dead
display. analogVco reaches the live branch only because it declares six audio
outputs. (analogVco is in fact a precedent for the *opposite* reading:
`shell-cells.ts:545-552` records the glyph as a defect there too, which is why it
uses a registered panel for its real picture.)

The samples are reachable through exactly one seam — the engine handle's
`read('snapshot')` key — and no glyph path calls `engine.read`. So the trace goes
through a `fullViewBody`, hosting a canvas over the **card's own pure
`drawDockscope`**, which is what stops the two surfaces drifting.

Other findings:

- **`range` is LATCHING**, classified at the read site: `dockscope-draw.ts:68-69`
  compares `params.range >= 0.5` every redraw. No edge detector anywhere, and the
  def declares no gate input. → `ACKNOWLEDGED_LATCHING`, never `face.momentary`.
- **`range` gains an `options` roster** (`AUDIO` / `CV`) by owner ruling. The
  names are **promoted, not invented** — they are the strings the card's button
  has always painted, and `drawDockscope` already annotates the trace `±1.0` /
  `±5V` from the same branch. Unnamed, a 2-state toggle announces
  pressed/unpressed (enable-and-absence) while the display shows two MODES.
- **NO SCREEN switch**, by derivation. The fleet standard covers VIDEO defs and
  `video-face-screen-source.test.ts` does not reach an audio def, so no exemption
  is owed — but the substantive reason is `videoOut`'s, the one module that gate
  DOES exempt: when the picture IS the module, a switch collapsing it deletes the
  product. dockscope has no outputs at all.
- **NO watch mark**, and its absence is derived rather than copied: `markWatched`
  is a VideoEngine pull-set concept, and this module's `AnalyserNode` is fed by
  the Web Audio graph, which runs whether or not anyone is looking.
- The trace is the **width-earner**, one the ruling names outright ("a live
  picture, a scope trace"). Nothing else on the plate claims width.

---

## 4. `shapedramps` — FACED, the straightforward one

8 params, all continuous linear, **all drawn as `<NeonFader>`**, no switches, no
rosters, no non-param affordances, **no readouts to delete** (unusually — most
faces in this programme had to remove something). Counts verified against both
the def and `contract-lock.txt`: 8 params / 12 inputs / 6 outputs.

- **Ranked by what moves the picture**, not by the card's grid order: shapes lead
  (they change what KIND of gradient comes out), then freq, then phase. **Both
  mixes rank last because they are inert on an unpatched instance** — they
  crossfade `mix{N}_a`/`mix{N}_b`, which are patched inputs, not this module's
  own output. That is asserted from the PORTS rather than argued.
- **NO `paramCells`, deliberately** — and this is the one place the batch
  departs from what the card would literally suggest. `shell-control-kind.ts:96-105`
  records that **23 faced modules rank 121 fader-drawn params as knobs**, `noise`
  is the only declarer, and converting them is a LOOK RULING WITH REAL COST that
  is **with the owner**. Declaring it here would also halve the lane plate
  (`LANE_CELL_H.fader` 96 px against a 42 px row), spending the whole budget the
  ranking is built around. The face follows the twenty-three and says so.
- ⚠ **H/V SHAPE ARE NOT SELECTORS.** They read like four-position switches —
  linear / triangle / soft-fold / radial — and the shader blends LINEARLY between
  adjacent shapes. Those are landmarks on a continuous morph. A roster would tell
  the player the in-between values are unreachable when they are the point.
- **SCREEN body is an ADDITION**, not a port: the card mounts zero canvases. This
  is the first surface on which what the module emits is visible without patching
  it into an OUTPUT.
- **The watch-mark argument is the widest-tap form in the fleet**: six outputs,
  four of them pure functions of `vUv` with no input, and **the preview shows only
  `h_out`** — five of six are invisible on the very surface whose switch would
  mute them. The two identity ramps are invariant to every knob and CV, so if they
  went dark nothing on the plate would move to say why. Copied from
  `ShapegenOutputBody`, **not** `SpirographsOutputBody`, which tears its rAF loop
  down while collapsed and never marks the node watched.

---

## 5. `samsloop` — REPORTED OUT, and the trap the next lane must not step in

Both substantive clauses of the Cut A note are false.

- *"rec channels/bits/rate → discrete params"* — **there are exactly FOUR
  ParamDefs** (`rate`, `mode`, `start`, `end`). `recChannels`/`recBits`/`recRate`
  are `node.data` fields (`samsloop.ts:218-223`) written by `pushRecSetting`.
  Making them params is an I/O contract change.
- *"the sample waveform is the `waveform` glyph"* — the waveform branch needs
  `shape1`/`pw`/`mix` params it does not have, so it falls to a **live-audio tap
  on the OUTPUT**. samsloop is idle-by-default (`playing = false` until
  triggered), so **the trace is a flatline at rest** and after every one-shot.
  That is not the loaded sample. No engine read key returns sample data at all.

### ⚠ THE PARITY TRAP — read this before touching samsloop's `rate`

**The `rate` fader does not render the param.** It renders **knob space 0..1**
and converts at the boundary with a piecewise map (`samsloop-rate.ts:43-64`):

```
k <= 0.5  →  rate = -2 + 6k      (slope 6)
k >  0.5  →  rate =  1 + 2(k-0.5) (slope 2)
```

So the fader's **geometric midpoint is rate = +1 (unity forward)**, and five
`ticks` name the landmarks (`-200% / -100% / 0% / Norm / +200%`).

A generic `paramCells: 'fader'` over the raw `-2..+2` would drive it **linearly**:
unity moves from the midpoint to the **three-quarter** position and every tick
landmark disappears. That is a **functional-parity break, not a look change**, and
it would pass every gate — `card-def-agreement` cannot see it either, because its
tag regex cannot cross the `>` inside the tag's own arrow functions.

`start`/`end` carry a related trap: the card binds `max` to
`Math.max(1, sampleLength)` from `node.data`, **not** the def's declared
`max: 1e6`. A cell driven off the ParamDef gives both faders a 1,000,000-frame
throw regardless of the loaded buffer.

### What a samsloop face actually needs

`controlFamilies` entries (it declares none) plus new `SHELL_CELLS` specs for: a
file cell, a **trigger action cell with an AUDITION probe** (the trigger posts a
worklet message and writes nothing to the graph, so `readParam`/`readData` are
structurally blind to it), and three selector rosters over `node.data`; plus a
waveform panel that owns its own decode; plus ~10 derived-text readouts to remove,
**two of which carry real findings** — that the RATE switch is a REQUEST integer
decimation may not honour, and which of three caps is binding on take length.

---

## 6. `scope` — checked as the designated replacement, and it is NOT cheap

The one-hour check the Cut B section calls for: **does the `scope` glyph carry two
channels?** **No.**

`GlyphBinding` is `{ kind: 'live-audio'; portId: string }` — **one** port,
resolved by `primaryAudioOutPortId`'s `.find(…)` to `ch1_out` alone. The renderer
is a single `<ScopeScreen>` whose mode union is `'waveform' | 'envelope' | 'wave'`
— **no XY member** — and whose `paint()` strokes one path. `kind: 'dual'` is not
an escape: it also carries one `portId`, its second pane is param-derived, and it
is gated on params scope does not have.

But scope's screen **is** two channels: `drawSplit` paints ch1 and ch2, and
`drawXY` plots ch1 against ch2 — the Lissajous mode IS the two channels. So a
`glyph: 'scope'` here would paint a single-trace ch1 waveform: correct-looking,
silently half the module, blind to `mode`, `ch2*`, `intensity` and `timeMs`.

**scope stays in Cut B.** It also carries a card-producer risk
(`CARD_PRODUCER_LANE_TYPES`) — already mitigated by `HeadlessSourceHost`, and the
membership is derived, so a face rewrite dropping its `eng.write(node,
'cvCombined', …)` seam would redden `dom-source-modules.test.ts` by name.

---

## 7. Things checked so nobody re-checks them

- **ZERO ATTEST for this batch**, measured not assumed. `task webgl:attest:check`
  reports the content hash unchanged with a matching attestation on disk.
  Negative-controlled both ways: `dockscope.ts` is **not in the basis at all**
  (`webgl-attest-lib.ts` auto-sweeps `lib/video/**` plus exactly two named audio
  files, `cube.ts` and `wavesculpt.ts`), and `shapedramps.ts` **is** in the basis
  yet the hash still did not move, because it only gained a `face:`, which
  `attest-code-basis.ts` strips. ⚠ **"params moves the WebGL basis" is a VIDEO-def
  rule** and does not generalise to audio defs.
- **`docs:accept` moved ZERO contract-lock lines** despite adding an `options`
  roster — independently confirming that `contract-signature` projects
  id/min/max/curve/default/units only.
- **`vrt-exemptions.ts:67` is NOT stale.** Its "confirmed 0 canvases each" claim
  is scoped to the `*Card.svelte` files, and both new canvases live in new
  `*OutputBody.svelte` files. `grep -c canvas ShapedrampsCard.svelte` is still 0.
  Left untouched deliberately: it is a hot conflict surface and there is no
  functional reason to edit it.
- **VRT capture predicts exactly FOUR baselines**: `face-dockscope-compact.png`,
  `face-dockscope-dock.png`, `face-shapedramps-compact.png`,
  `face-shapedramps-dock.png`.
- **Both faces are baselinable, for different reasons.** shapedramps needs no
  determinism seam at all (pure per-pixel programs, no time uniform / ping-pong /
  RNG — the `shapes` argument). dockscope needs one and already had it: the
  faceplate body reads the **same** `__dockscopeVrtSeed` global the card does,
  which is what lets the FACE be pinned and not only the card.
