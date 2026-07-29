# BACKDRAFT card restructure — remove the preview, widen, make the controls fit

**Status:** planned, not started · **Owner ask:** *"wider card with no built in preview screen"*
**Blocking:** nothing. #1223 merges without it (owner: *"1223 can go in as it is, we'll fix the card later"*).
**Hash-free:** `BackdraftCard.svelte` uses `getContext('2d')`, so it is NOT in the WebGL attest basis. **No re-attest.**

---

## 1. The problem, measured

BACKDRAFT's card does not fit its own controls once a TV mode is on.

| state | bottom overflow |
|---|---|
| TV MODE **off** (the default) | **0 px** — fits |
| TV MODE **VIRTUAL CAMERA** | **~228.8 scaled px** |
| TV MODE **CRITICAL** | **~235.4 scaled px** |

⚠️ **Those are SCALED pixels, not CSS pixels.** See §3 — the real figure is **~310 CSS px**.

`origin/main` (`e8cbc9e4`, PURE TV + CRITICAL, no camera row) was measured and is **CLEAN in every TV mode**. So the whole overflow is #1223's `VIRTUAL CAMERA ORIENTATION` row (two 72 px `XyPad`s + a fader + a title). This is a new-feature fit problem, **not** a shipped regression.

---

## 2. Why the existing gate never saw it

`card-control-overflow.spec.ts` sweeps every module **at its default params**. BACKDRAFT's default is `tvMode: 0`, and the camera row is `{#if tvOn}`. So the gate **structurally cannot see** the controls being added.

That gate has a real catch to its name — it found a **56.7 px** overflow on this same module hours earlier. A gate with a real catch that cannot see the newest controls is a hole. **Closing it is part of this work** (§6).

---

## 3. ⚠️ THE MEASUREMENT TRAP — read before sizing anything

`measureOverflow` uses **`getBoundingClientRect()`**, and xyflow applies a **CSS transform scale** to the flow pane for viewport zoom. **Every number that spec prints — `cardW`, `cardH`, and all overflow figures — is in viewport-scaled screen pixels.**

Consequences, all of which cost time already:

1. **There is NO rack clamp.** The earlier theory that "the card asks for 720×720 but is clamped to 530×530" was **wrong**. 720 × ~0.736 ≈ 530. The card gets exactly what it asks for. Do not go hunting for a clamp; there isn't one.
2. **The real overflow is ~310 CSS px**, not ~230. Sizing against the printed number under-provisions by ~80 px.
3. **Figures are only comparable at equal zoom.** Two spawns reported card widths of 707 and 530 for the same card — different fit-view zooms, not different cards. Never compare overflow numbers across spawns without checking scale.

**Guardrail:** before resizing, convert. Get the scale in-page and divide:
```js
const el = document.querySelector('.svelte-flow__viewport');
const scale = new DOMMatrixReadOnly(getComputedStyle(el).transform).a;   // ~0.736
```
Or size against `offsetHeight`/`scrollHeight` (unscaled layout px) rather than `getBoundingClientRect()`.

---

## 4. What the preview actually carries

Removing it is **not** deleting a `<canvas>`. It is entangled with:

- the live GL preview draw + `liveEngineAspect` sizing (`innerWidth`/`innerHeight`, `ENGINE_W`/`ENGINE_H`)
- the **corner-drag resize handle** and its `MIN_WIDTH`/`MIN_HEIGHT` clamps
- **persisted `node.data.width` / `node.data.height`** — existing saved racks carry these
- the **right-click menu**: Full Frame / Full Screen / Present-on-another-display
- `node.data.fullFrame` and the `.fullscreen` wrapper state

`DEFAULT_WIDTH = 720`, `DEFAULT_HEIGHT = 720` (raised from 540 during #1214 to absorb the PURE TV row), `MIN_WIDTH = 540`, `MIN_HEIGHT = 360`.

---

## 5. Implementation steps, in order

### Step 0 — decide the preview's fate (owner input if ambiguous)
Two readings of *"no built in preview screen"*:
- **(a) Remove entirely.** Simplest layout; loses in-card monitoring and everything in §4.
- **(b) Keep it optional, default off.** A toggle/right-click item; preserves Full Frame / Full Screen / Present for users who rely on them.

**Recommendation: (a)** — matches the words, and BACKDRAFT's output is monitorable via a patched `videoOut`. **But (a) deletes a shipped, tested feature set**, so confirm before writing code. If unsure, (b) is the reversible choice.

### Step 1 — characterise before changing
Measure current **unscaled** heights of each block with `offsetHeight`: header, preview, mirror/shape/flicker/TV rows, camera row, fader grid. Record them. You need the real budget, not §1's scaled figures.

### Step 2 — remove (or gate) the preview
Delete the preview pane and its sizing. If (a): remove the resize handle, the right-click menu, `fullFrame`, and the `.fullscreen` handling too — **do not leave orphaned state writing to `node.data`**.

### Step 3 — re-size
Card becomes **wider and shorter**. Keep to **whole 180 px rack tiles** — the grid snaps, and a non-tile size makes the rack CSS clamp the corner-resize (#759). Suggested: **1080 × 540** (6u × 3u). Verify against Step 1's real numbers; do not guess.

### Step 4 — reflow the controls
With the preview gone the full width is available. The fader grid can widen well past 5 columns; the camera row's two `XyPad`s + DIST fader can sit inline. **Guardrail:** the fader grid's column count is load-bearing — 17 faders at 5 columns is 4 rows, 21 is 5. Count rows deliberately.

### Step 5 — migration for existing racks
Saved racks carry `node.data.width/height` from the old card. Decide and **state in the PR**: ignore them (always use the new default), clamp them, or migrate. Do not let a stale 720×720 produce a broken layout on someone's saved rack.

---

## 6. Tests — rewrite, don't discover

### Must land, passing
`scratchpad/tvmode-overflow-test.patch` (59 lines) — extends `card-control-overflow` to spawn backdraft in **TV MODE 1 and 2** and assert no overflow. It also asserts `[data-testid="backdraft-cam-row"]` is **visible**, so it cannot silently re-measure the OFF layout. **Land it passing. Do not weaken it, do not `test.fixme` it** — that adds to the `EXEMPT_CONTROL_OVERFLOW` ratchet, which only shrinks.

### Must be rewritten or retired
`e2e/tests/backdraft-full-output.spec.ts` — 5 tests, **all of which test the preview**:
1. right-click opens menu with Full Frame + Full Screen (Present hidden on single screen)
2. Full Frame toggles `node.data.fullFrame` + hides chrome; double-click exits
3. Full Screen enters `.fullscreen`; double-click exits (mutually exclusive)
4. two screens → "Present on \<secondary\>" appears (capability-gated)
5. corner-resize grows the card + persists `node.data.width/height`

Under (a) **all five must be deleted** in the same PR. Under (b) all five need re-pointing at the toggle. **This is scope, not fallout** — a red suite discovered after the layout change is the failure mode to avoid.

### Also check
- `modules-card-map.test.ts` if testids move
- `backdraft.spec.ts` asserts `[data-testid="backdraft-canvas"]` exists → **will break under (a)**
- VRT: backdraft is whole-module exempt, so no baseline to regen

---

## 7. Acceptance criteria

- [ ] `card-control-overflow` green for backdraft in **OFF, VIRTUAL CAMERA, and CRITICAL**, with the camera row asserted visible
- [ ] `backdraft-full-output.spec.ts` deleted or rewritten — **no orphaned failing tests**
- [ ] `backdraft.spec.ts` + `backdraft-render-smoke.spec.ts` still green
- [ ] `flox activate -- task typecheck` → 0 errors
- [ ] Card size is a whole multiple of 180 px in both axes
- [ ] Existing-rack behaviour for stale `data.width/height` decided and stated in the PR body
- [ ] **No re-attest** (card is not in the basis) — if you find yourself re-attesting, you have edited something you did not intend to
- [ ] PR body names the scaled-vs-CSS-pixel trap (§3) so the next reader doesn't re-derive it

---

## 8. Traps, collected

1. **Scaled pixels** (§3). The single most expensive misreading here.
2. **There is no clamp.** Do not go looking for one.
3. **Don't cut the overflow assertion** to make it pass — including via `overflow-y: auto`, which makes clipped children report in-bounds rects. That is widening the assertion by another route.
4. **The default-params sweep is blind to conditional controls.** Any future BACKDRAFT control behind `{#if}` needs the same explicit coverage.
5. **`bezel: 0.4` is no longer the default** — it is `0.5` after the border-fader re-centre. Specs pinning a literal that "used to equal the default" silently drift; pin `DEFAULTS`/`pdef()`.
6. **Card ranges must come from the def.** #1223 shipped `xMin={-1}` on both `XyPad`s while the def said ±0.2/±0.5 — the UI wrote out-of-contract values and every def-reading gate missed it. `V10` now pins the card source; keep it that way.
