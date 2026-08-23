# Batch 24 — CUT A, batch 1: the four plain video faces

`chroma` · `chromakey` · `feedback` · `mandleblot`

Derived 2026-08-23 against `main` at `3cf8ca78c`. Every shape below was read off
the live card and the live contract, not off the previous batch's notes.

Cut A's remaining four (`shapedramps` plus the audio trio `dockscope`,
`joystick`, `samsloop`) are deliberately NOT here: the audio trio consumes the
entire `_face-fixtures` audio pool, so that PR has to re-derive and widen the
pool in the same diff. Banked, not forgotten.

## What each module IS, musically

Every rank below descends from these sentences.

- **chroma** — a single-input COLOUR GRADE: rotate the hue wheel, push or pull
  saturation, then blend a flat tint over the result. It is not a keyer; the
  name is historical (its pre-v3 role) and `chromakey` took the keying job.
- **chromakey** — the two-input COMPOSITOR: pick a key colour, and everywhere
  the foreground matches it within a threshold, show the background instead.
  Softness feathers the matte edge; spill suppression pulls the key colour back
  out of what survives.
- **feedback** — the video-feedback LOOP: the frame is fed back into itself
  through a warp (zoom, rotate, offset) with a decay. It is the camera-pointed-
  at-its-own-monitor instrument, and every control shapes the *trajectory* the
  image takes rather than a static look.
- **mandleblot** — a Mandelbrot EXPLORER: pan to a point, zoom in (up to
  millions of times), and colour the escape-iteration field. The verb is
  *travel*; every control is a coordinate on the journey.

## Card shapes, RE-DERIVED live

Read line by line from the four `*Card.svelte` files, checked against
`contract-lock.txt`.

| module | params | what the card draws | canvas? |
|---|---|---|---|
| `chroma` | 6 | 3 × `NeonFader` (hue, saturation, tintMix) + a native colour `<input>` writing tintR/G/B | no |
| `chromakey` | 6 | 3 × `NeonFader` (threshold, softness, spillSuppress) + a native colour `<input>` writing keyR/G/B | no |
| `feedback` | 6 | 6 × `NeonFader` (wet, decay, zoom, rotate, offsetX, offsetY) | **yes** — live output preview |
| `mandleblot` | 6 | 6 × `Knob` (zoom, iterations, color_cycle, rotation, center_x, center_y) | **yes** — live render |

**So `paramCells: 'fader'` is declared for chroma's, chromakey's and feedback's
fader-drawn params, and for NONE of mandleblot's** — that card draws knobs, and
the shell's default for a continuous param is already a knob. Declaring `fader`
there would be inventing a primitive the module never had.

The six tint/key channel params (`tintR/G/B`, `keyR/G/B`) get no `paramCells`
either: they are `0..1 linear` and the shell's default knob is the honest
rendering of one colour channel.

### Contract facts that decide the ranks

```
chroma      hue -180..180 · saturation 0..2 d=1 · tintMix 0..1 d=0 · tintR/G/B 0..1 d=1,1,1
chromakey   threshold 0..1 d=0.5 · softness 0..0.5 d=0.08 · spillSuppress 0..1 d=0.5
            keyR 0 · keyG 1 · keyB 0   (pure green — the classic key colour, at spawn)
feedback    wet 0..1 d=0.5 · decay 0..2 d=0.95 · zoom 0.9..1.1 d=1.02
            rotate -3.14159..3.14159 d=0.05 · offsetX/Y -1..1 d=0
mandleblot  zoom 0..1 LOG d=0.2 · iterations 50..500 DISCRETE d=150
            color_cycle 0..4 LINEAR d=1 · rotation 0..1 d=0 · center_x -2..2 d=-0.7 · center_y -2..2 d=0
```

Three things checked because they are where this class of module goes wrong:

- **No re-typed range disagrees with its def.** Every literal in all four cards
  matches the contract, including `feedback.rotate`'s `-3.14159..3.14159` — the
  def itself carries the truncated constant, not `Math.PI`, so the card is
  faithful. They are still unguarded literals (the backdraft class), which the
  build addresses below.
- **`mandleblot.color_cycle` is LINEAR, not discrete**, so it needs no `options`
  roster. `iterations` IS discrete but spans 451 states, so a knob reaches them
  all — this is not the `moog962` two-state trap.
- **`mandleblot.iterations` is drawn with `curve="discrete"` on a `<Knob>`**, and
  `Knob.svelte` has no discrete branch, so that prop does nothing today. Noted,
  not "fixed": writing a different word would green nothing and change nothing.

## Two defects found while deriving

Both are fixed in this PR, per the standing direction that a bug found during
planned work is fixed inside it.

### 1. The colour pickers write three params UNTRANSACTED and UNTAGGED (chroma + chromakey)

`ChromaCard.svelte:42-46` and `ChromakeyCard.svelte:41-45` are byte-identical in
shape:

```js
const target = patch.nodes[id];
if (!target) return;
target.params.tintR = r;   // ← three separate bare proxy writes
target.params.tintG = g;
target.params.tintB = b;
```

Every other write on both cards goes through `setNodeParam`, which is
`mutateNode` — `ydoc.transact(fn, origin)`. `mutate.ts` says why that matters in
as many words: it is *"equivalent to the bare proxy assignment but tagged so it
lands on the undo stack"*. So the picker's writes are

- **three transactions, not one** — a collaborator observes two intermediate
  colours on the way to the one that was picked, and an undo unwinds one channel
  at a time rather than one colour pick; and
- **untagged**, so they do not carry `LOCAL_ORIGIN` the way every knob write on
  the same card does.

Fix: one `mutateNode` call setting all three in place, inside one origin-tagged
transaction. Same values, same keys, one atomic pick.

⚠ This is NOT the same defect as the camera one that just landed. That was a
value arriving and being ignored; this is a value being written by a path that
skips the transaction wrapper. They share only the lesson that the second writer
of a shared key is where these hide.

### 2. mandleblot's ZOOM READOUT is deleted by promotion, and it is a real derivation

`MandleblotCard.svelte:149` paints `{zoomLabel}` — `jsZoomFromKnob(zoom)` run
through a formatter that prints `1.5×`, `250×`, `12k×`, `3.4M×`. The knob itself
is a bare `0..1`, so **the readout is the only place the actual magnification
exists**, and the card's own comment says so: *"show the post-mapping factor so
the user can read 'I'm at 1000×' rather than the bare 0..1 knob position."*

Promotion removes the card from both surfaces, and the resting faceplate paints
no derived-state text — so this finding loses its surface. Naming it rather than
letting the coverage lapse, per the standing rule:

> **THE FINDING:** mandleblot's `zoom` knob is a LOG map from `0..1` onto a
> magnification spanning roughly 1× to millions×. Knob position is not
> magnification and the two are not linearly related.

Its home after promotion is `aria-valuetext` on the zoom control (speakable and
assertable, unpainted) plus the `docs.controls.zoom` prose. The arithmetic
itself stays where it already lives, in the module's own model.

## The faces

All four are **one honest band**. Six controls is far below `DOCK_TAB_MIN_BANDS`
(7) and below `DOCK_ROW_MAX_CONTROLS` (10), and none of the four has two
genuinely different ideas in it — a page per idea would be padding, which the
compact ruling forbids.

`glyph: 'none'` on all four: `primaryAudioOutPortId` matches `type: 'audio'` and
a video def has none, so any other glyph literal falls through to a dead
`{kind:'static'}` and reddens module-face-lint. The picture arrives from
`hasVideoSurface(def)` at the lane and the `fullViewBody` extension at the dock.

### chroma — `order: ['hue', 'saturation', 'tintMix', 'tintR', 'tintG', 'tintB']`

HUE first because it is the module's verb: the one control that changes every
pixel's identity rather than its intensity. SATURATION second — the other
whole-frame grade, and the one that can reach a fully grey frame. TINTMIX third
and ahead of the three channels **because it gates them**: at its default of 0
the tint is inaudible no matter what the channels say, so a player who touches a
channel first sees nothing happen. Ranking MIX above the colour it mixes is the
difference between a working face and three inert knobs. The channels then rank
R, G, B in the order the picker's hex reads.

### chromakey — `order: ['threshold', 'softness', 'spillSuppress', 'keyR', 'keyG', 'keyB']`

THRESHOLD first: it is how much of the frame keys at all, so it is the control
between "no composite" and "a composite". SOFTNESS second — the matte edge, and
the difference between a cutout and a blend. SPILLSUPPRESS third: a correction
applied to what already survived, so it is meaningless before the first two are
set. The key colour ranks last **specifically because it is already correct at
spawn** — `keyR/G/B` default to pure green, the colour the module exists to key,
so the common session never touches them.

### feedback — `order: ['wet', 'decay', 'zoom', 'rotate', 'offsetX', 'offsetY']`

WET first: it is the feedback amount, and at 0 the module is a wire. DECAY
second — it sets whether the trail dies or runs away, which is the difference
between an effect and a screaming loop, and its `0..2` range crosses 1.0 where
that changes. Then the WARP, in the order it visibly dominates: ZOOM (the tunnel),
ROTATE (the spiral), then the two OFFSETS (the drift), which are the only pair
here that are one idea in two axes and therefore rank adjacently and last.

### mandleblot — `order: ['zoom', 'center_x', 'center_y', 'iterations', 'color_cycle', 'rotation']`

ZOOM first because the verb is *travel* and zoom is the journey. The two CENTRE
coordinates immediately after it, adjacent because they are one gesture in two
axes and useless apart — and ahead of everything else because at high zoom they
are the only controls that find anything. ITERATIONS fourth: it is the detail
budget, invisible until you are deep enough for the boundary to be complex.
COLOR_CYCLE and ROTATION last as the two pure look controls, which change nothing
about *where* you are.

⚠ `order` and a `pages` split would disagree here (the natural grouping is
*travel* / *render*), which is exactly why there is no `pages`: two bands of
three would each earn a header, and the second one — "iterations, colour,
rotation" — is not a different idea so much as a leftover.

## The SCREEN switch — all four, `fullViewBody`

Per the fleet standard (2026-08-18) every video face carries SCREEN ON/OFF, and
for a FACE the only route is the `face.extension` → `fullViewBody` slot: a toggle
that lived on the card is deleted by the very promotion meant to keep it (#1928).

- `feedback` and `mandleblot` — the switch is a PORT of a preview their cards
  already draw.
- `chroma` and `chromakey` — the switch is an ADDITION. Neither card draws a
  preview at all; the face gains one from `hasVideoSurface`, so it gains the
  control that governs it. This is the `shapes` case exactly.

OFF collapses the picture and reclaims its space while the module **keeps
rendering** — the collapsed branch retains the watch mark, which is the #1720 /
#1721 bug class. State lives on `node.data.previewCollapsed`, never component
`$state`, so it survives dock collapse, LRU eviction, a reload and a
collaborator, and it reuses the key the existing cards use so no saved rack
re-opens a preview it had closed.

## What this PR touches

| file | why |
|---|---|
| the four defs | the `face` block + the `docs.controls` note carrying mandleblot's lost finding |
| `ChromaCard.svelte`, `ChromakeyCard.svelte` | defect 1 — the atomic picker write |
| 4 × `<id>/shell-extension.ts` + `<id>OutputBody.svelte` | the SCREEN switch |
| `strict-faces.ts` | promotion (append) |
| `e2e/vrt/_shell-faces.ts` | four `FACES` rows with a `videoFaceWhy` each |
| `e2e/tests/face-screen-render.spec.ts` | four `SUBJECTS` rows |
| `face-rack-status-source.test.ts` | four `EXTENSION_BODY_ROLES` arguments |
| `contract-lock.txt` | GENERATED — re-run `docs:accept`, never hand-edit |
| `e2e-timings.generated.json` | the standing recost-on-absorb |

**No `sceneWeight` is declared for any of the four.** It is optional and its
fields are all required-if-present, so a weight cannot be written before the
linux capture run that measures it exists. Absent means the 90 s base bound,
which is the correct PENDING state rather than a guessed number.

**Attest: NIL.** A video def's top-level `face` is hash-transparent, and so are
`docs`. The card edits are inside `<script>` blocks (comments and a function
body); the function body IS code, so the two card files change the collab basis
only if they are in it — checked at build time, and handed to the orchestrator if
the hash moves.

## VRT prediction

Eight new baselines — `face-{chroma,chromakey,feedback,mandleblot}-{compact,dock}.png`
— and **zero** changes to existing ones: nothing here edits a shared layout file,
and the four legacy cards keep their own scenes. The dispatch is scoped by branch
diff; four modules will make the scope derivation fall back to the full sweep
loudly rather than guess, which is the correct behaviour and is budgeted for.
Predictions get reconciled by name against what the bot commits — a green
dispatch that commits nothing is a red flag, not a pass.
