# P0 · the CAMERA face lost its source picker, and a docked module lost its face

2026-09-04 · branch `fix/camera-face-and-dock-face` · measured from `origin/main`
@ `5485f3d54b` and against **live dev** (`https://dev.patchtogether.live`), never
from the primary checkout.

---

## TL;DR

| | root cause | where |
|---|---|---|
| **Bug 1** | The camera dock faceplate renders its source controls **after** a fixed 480×360 preview, so at any ordinary window height they land ~300 px below the fold of the faceplate's own scroll region and, at 1280×720, 69 px below the browser window. Nothing is clipped and nothing throws — the controls are simply painted past the bottom of the surface that carries them. | `CameraInputOutputBody.svelte` |
| **Bug 2** | `dockRailRendersFace = shellFaces && pinned && migrated`, and `Canvas.railCards` passes `pinned: false` for every user-docked node — so docking a promoted module on the default shell swapped it back to its pre-promotion legacy card. | `legacy-fallback.ts` |
| **Why the e2e was green** | `e2e/tests/camera-input.spec.ts:437` asserts `expect(select).toBeVisible()`. Playwright's `toBeVisible()` is `display`/`visibility`/`opacity` + a non-empty bounding box. It has **no viewport requirement and no scroll-position requirement**. An element at document y=789 in a 720 px window is "visible" to it. The spec runs at `devices['Desktop Chrome']` = **1280×720** — i.e. it has been running in the broken configuration and reporting green. | — |

Bug 2 is **not** the cause of bug 1: established, not assumed — see §4.

---

## 1 · Bug 1 — the measurement

Reproduced on **live dev** with a freshly-spawned `cameraInput`, and identically
on a local build of `origin/main`. Ancestor chain of
`[data-testid="cameraInput-face-device-select"]` in the dock full view at
1280×720:

```
.dock-faceplate       t=231 b=655 h=424   max-height min(60vh,680px)  ← correctly bounded
  .faceplate            overflow-y: hidden
    .faceplate-scroll   t=299 b=651 h=352  overflow-y: auto  clientH=352  scrollH=648   ← the scroller
      .faceplate-body   t=299 b=947 h=648                                              ← 296 px past the fold
        …
          .module-shell.rl-tile.dock-full   t=361 b=925
            .dock-ext-body                  t=401 b=809
              .camera-output                t=405 b=809
                canvas 480×360              t=411 b=771                                 ← FIXED, does not shrink
                p.local-only
                .picker-row                 t=789 b=807                                 ← lamp + select + ACQUIRE
        [data-cell-key] enabled/mirror/gain/fillMode   t=932…1026                        ← all four, further out
```

Window height is 720. The picker row is at **789–807**. `elementFromPoint` at its
centre returns `NONE` (outside the viewport) at 760/820 px and `FOOTER` at 900 px.
`.dock-faceplate`'s `max-height` is doing its job; the content simply exceeds it,
and everything the module needs to be *started* is the part that overflows.

What the player sees on a laptop: the band headed **SOURCES** and a picture that
runs off the bottom of the screen. No dropdown, no lamp, no REQUEST ACCESS, and
no ON/MIRROR/GAIN/FILL either. That is the owner's screenshot.

**The lane tile is fine** — measured at every LOD tier (`mini` → `full`,
`scrollHeight === clientHeight === 178` in a 180 px tile). The tile picker #2242
added is present and unclipped. So the defect is specific to the dock faceplate.

### The fix

`CameraSourceControls` moves to the **top** of `.camera-output`, above the
preview. Verified at 720 / 800 / 1000 px: all three controls in-viewport,
unclipped by every scrolling ancestor, and hit-testing to themselves.

The invariant this encodes, stated in the file: **the controls go above the
picture**, because the picture is the one element on this body whose height is
fixed and large. Anything appended after it inherits this bug. A viewport-relative
cap on the canvas was rejected — it would make a VRT-baselined face's appearance
a function of the capture viewport and would leave the ordering that produced
the defect in place.

---

## 2 · Bug 1 — how it broke *again*, which is the owner's actual question

This is the **third** occurrence of one class: *the camera's non-param controls
end up somewhere other than the surface the player is looking at.*

| # | occurrence | what "fixed" it |
|---|---|---|
| #2148 | promotion put the picker in `fullViewBody` only — the lane tile could neither choose a camera nor start one | shipped as-is |
| #2242 | owner: *"the card has no way to pick sources"* | a `tileBody` slot, so the **lane tile** gets its own copy |
| **now** | the **dock full view's** copy is painted below its own fold | this PR: the controls go first |

Each fix was scoped to *the surface that was reported*. None of them stated the
property that would have covered the next one. #2242's own header says the
controls exist because they "were reachable only when expanded" — a statement
about *which component mounts them*, not about *whether a player can see them*.
Both #2148 and #2242 were satisfied by "the testid exists in this host", and so
were the tests written for them.

**No code change caused this.** `git log` on
`packages/web/src/lib/ui/modules/cameraInput/` shows nothing since #2242
(2026-08-29), and the `ModuleShell` diff since then is the rename label and the
param-override badge — neither touches the extension slots. The dock body has
carried a fixed 480×360 canvas with the controls after it since the face was
promoted. **It was broken at every viewport shorter than ~1000 px from the day
it shipped**, and the shipped test could not see that, so nothing ever said so.

---

## 3 · Why the existing e2e is green — the most valuable finding

`e2e/tests/camera-input.spec.ts` line 437:

```ts
const select = dock.locator('[data-testid="cameraInput-face-device-select"]');
await expect(select, 'device picker usable on the faceplate').toBeVisible({ timeout: 15_000 });
```

It is **running** (the `chromium-camera` project's `testMatch` is
`**/camera-input.spec.ts`; nothing grep-inverts `@camera-integration` outside
the WebGL attest's Pass C), and it is **not vacuous** — the element exists and
is enabled. It asserts something *different from what the owner sees*:

* `toBeVisible()` = attached + `visibility !== hidden` + non-empty bounding box.
  There is **no viewport check** and **no scroll-position check**. An element
  below the window, below an inner scroller's fold, or underneath the footer all
  pass.
* The spec's viewport is `devices['Desktop Chrome']` → **1280×720** — the exact
  configuration in which the control sits 69 px below the window. The gate has
  been running inside the defect.
* `.click()` would have passed too, and for the same reason: Playwright
  auto-scrolls before clicking, so the one gesture that could have revealed the
  problem is the gesture that hides it.

There is also, separately, **no assertion anywhere on the LANE TILE picker** —
the surface a player normally meets the module on, and the exact thing #2242
added.

### The class of gate that would catch it

Not a new lane and not a new kind of gate (2026-08-25 ruling): the same
Playwright assertion, asking the product's question instead of the DOM's —

> is the control inside the viewport, inside the visible box of **every**
> scrolling/clipping ancestor, and does a hit test at its centre land on the
> control itself?

That is `onScreenReport()` in `camera-input.spec.ts`, applied to the lamp, the
select and REQUEST ACCESS on **both** surfaces. It is the smallest predicate
that could have gone red.

The generalisable rule, offered for discussion rather than built as a gate:
**`toBeVisible()` is not a reachability assertion.** Any surface with a bounded
scroll region and a fixed-size picture in it has this hole today — `blood`,
`doom`, `nibbles`, `gibribbon`, `milkdrop`, `videoOut` and every other
`fullViewBody` that paints a canvas above its controls. Making the on-screen
predicate a shared e2e helper (not a new job, not a new lane) would let a face
spec opt into it in one line.

---

## 4 · Bug 2 — and whether it caused bug 1

**It did not, and that is measured.** With bug 2 active on live dev, the camera
face still renders `CameraSourceControls` on both surfaces with the correct
registry state; the picker is in the DOM and enabled. The two bugs are
independent:

* bug 1 is a layout ordering problem inside the extension body;
* bug 2 is a render-decision term in a pure predicate.

Two further facts that settle it:

* **`cameraInput` is not in `DOCKABLE_TYPES`.** A camera can never take a dock
  rail slot at all, so `dockRailRendersFace` cannot be what the owner saw in the
  "top camera area".
* The surface that *is* in the top camera area is the workflow topbar's **📷
  camera manager**, `$lib/ui/workflow/CameraSurface.svelte`. It keeps one
  always-mounted `<SvelteFlow nodeTypes={…}>` per mapped camera and therefore
  paints the **verbatim `CameraInputCard`** — old chrome, its own device
  dropdown, "streaming" lamp, Pause / Mirror / Fit:Fill, GAIN slider — on every
  shell. That matches the owner's second screenshot exactly.

  ⚠ **It is deliberately the card and must stay one for now.** A `hiddenCard`
  camera has no canvas node and no `<HeadlessSourceHost>`, so this host is the
  module's ONLY mount and therefore the sole owner of `getUserMedia`, the
  MediaStream and the permission state machine. Swapping the component for a
  face without first moving that ownership would stop every mapped camera dead.
  **Facing it needs a headless owner first — flagged for the owner, not done
  here.** Recorded in `legacy-fallback.ts`'s header beside the "fourth host"
  warning, which did not catch it because this host is not a `DockCardHost` at
  all.

So the owner's "top camera area" workaround is the camera manager; the
`dockRailRendersFace` defect is a **real sibling of the same class** on the dock
rail, found by the legacy-removal branch, and it is what this PR fixes on `main`.

### Bug 2 — the fix, and the cost the old note priced

`dockRailRendersFace` drops `pinned`; the field is removed from
`DockRailRenderInput` and from all four call sites.

The old header said widening would MOVE `workflow-dock.spec.ts` (docks `mixer`,
asserts `.mod-card`) and the `workflow-dock-composite` VRT baseline (docks
`vca`). **Neither is paid**, checked against the spec sources before the term
was removed:

* `workflow-dock.spec.ts` drives `/rack?shell=legacy` → the `shellFaces` arm →
  keeps the legacy card.
* `workflow-dock-composite.spec.ts`'s first scene is also `?shell=legacy`; its
  second scene drives the default shell but **EXPANDS** a `vca` into a full-view
  pane rather than docking it to a rail, so it never reaches this rule.

The old note's own justification — *"its face is already reachable [from the
lane stub], so the rail card is the second surface, not the only one"* — is true
and is not a reason. It answers a **completeness** question; a rail occupant is
a surface a player **looks at**, and the result was two different instruments
for one node on the default shell. That is precisely the split-brain
`NON_SHELL_LANE_TYPES` records as the thing to close *in the same diff as a
promotion*, arriving through a different door.

---

## 5 · What shipped

**Fixes**
* `packages/web/src/lib/ui/modules/cameraInput/CameraInputOutputBody.svelte` —
  source controls above the preview.
* `packages/web/src/lib/ui/workflow/legacy-fallback.ts` — `dockRailRendersFace`
  drops `pinned`; `DockRailRenderInput.pinned` removed.
* `packages/web/src/lib/ui/Canvas.svelte` — four call sites.
* Stale prose corrected where it asserted the old behaviour: `strict-faces.ts`
  ×2, `face-migration-inventory.ts`, `AudioIoSurface.svelte`,
  `DockRail.svelte`, `DockCardHost.svelte`,
  `controlSurface/shell-extension.ts`.

**Regression tests — each verified to FAIL on the unfixed product**
* `e2e/tests/camera-input.spec.ts` — new `@camera-integration` describe:
  the lamp / picker / ACQUIRE are **on screen** on the **lane tile** and on the
  **dock faceplate**, plus an **in-test positive control** that rebuilds the
  pre-fix DOM order and asserts the same predicate reports it off-screen (and
  that `toBeVisible()` still passes in that arrangement — the finding pinned as
  an assertion). *Negative control run: reverting the source fix makes it red.*
* `e2e/tests/workflow-drawer-face.spec.ts` — new describe: docking a migrated
  module on the **default shell** mounts `ModuleShell view='drawer'` and **zero**
  `.mod-card`; plus the `?shell=legacy` half asserting the escape hatch still
  gets the verbatim card. *Negative control run: forcing `dockRailRendersFace`
  to `false` makes the first red.* The file's own blind-spot list is corrected —
  the entry that read "a USER-DOCKED promoted module … deliberately still
  renders its legacy card" **was this P0, written down before it was reported.**
* `legacy-fallback.test.ts` — truth table re-derived over two flags; the
  user-docked leg is inverted (it used to assert `.toBe(false)` with a comment
  explaining why that was deliberate — a decision recorded as an invariant,
  which is what kept the defect green); plus a `cameraInput` leg.
* `controlsurface-face-model.test.ts`, `electracontrol-face-model.test.ts`
  updated with the same correction.

**Gates run locally**
`task typecheck` 0/0 · full `task test` 19,369 web + 654 scripts + server, all
green · `task face:inventory` · `task docs:check` · `task webgl:attest:check`
(hash unchanged, existing attestation matches) · both new e2e specs, with
negative controls in both directions.

**Outstanding**
* `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-cameraInput-dock.png`
  **will move** — the dock body's layout deliberately changed. Linux CI authors
  the baseline; accept with `GREP=cameraInput` scoped `task vrt:commit` after the
  PR run and review the bot's exact diff. `face-cameraInput-compact.png` (the
  lane tile) should be byte-identical.
* Flake-check the two new specs `REPEAT=3` on the branch.
* The 📷 camera-manager host (§4) — needs a headless owner before it can be
  faced. **Owner decision, not done here.**
