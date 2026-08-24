# FACEPLATE BUILD SPEC — `outToLaunch` (video, the LAUNCHPAD MONITOR SINK)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-bound.html`](dock-bound.html).

Every claim carries the `file:line` it was measured from. Claims that came back
**different from the brief that commissioned this spec** are marked ⚠ and kept
rather than quietly corrected — the correction is the finding.

Measured on `99a961b08` (`git rev-parse origin/main`, verified equal to this
worktree's HEAD).

Sibling spec: [`../launchpadControlLeft/spec.md`](../launchpadControlLeft/spec.md).
The two modules bind **the same physical device in opposite directions**; the
cohort answer is §14.

---

## 0. THE HEADLINE — ⚠ **THIS MODULE'S LANE TILE ALREADY PAINTS ANOTHER MODULE'S PICTURE**, ON `main`, TODAY

Not a face question. A live defect that promotion would *inherit and amplify*,
found by checking the brief's item 2 — *"it has `outputs: []`, so check what
`laneGlyphFor` / `primaryAudioOutPortId` / `hasVideoSurface` actually do for it
rather than assuming"* — instead of assuming.

### 0.1 THE CHAIN, AT THE LINES

```ts
// module-shell-model.ts:177-179
export function hasVideoSurface(def: ShellDefLike | undefined): boolean {
  return def?.domain === 'video';
}

// module-shell-model.ts:237-240
export function laneGlyphFor(def: LaneGlyphDefLike | undefined): LaneGlyph {
  if (hasVideoSurface(def)) return 'picture';
  return (def?.face?.glyph ?? 'none') !== 'none' ? 'trace' : 'none';
}
```

`outToLaunch` is `domain: 'video'` (`out-to-launch.ts:97`) ⇒ `hasVideoSurface`
is **true** ⇒ both shell components mount the live thumbnail:

* `ModuleShellPlaceholder.svelte:73`, `:135-137` — `let videoThumb = $derived(hasVideoSurface(def))` → `<VideoTileThumb nodeId={id} />`
* `ModuleShell.svelte:321`, `:1345-1348` — `let videoThumb = $derived(laneGlyph === 'picture')` → same

**`outToLaunch` is un-promoted, so its lane render kind is `'placeholder'`
today** — which means the FIRST of those two is live on `main` right now.

`VideoTileThumb.svelte:74-90` does:

```ts
videoEngine.blitOutputToDrawingBuffer(nodeId);
const ctx2d = el.getContext('2d', { alpha: false });
if (ctx2d) {
  ctx2d.fillStyle = '#050608'; ctx2d.fillRect(0, 0, el.width, el.height);
  const src = videoEngine.canvas as CanvasImageSource;
  …
  drawPreviewDownscaled(ctx2d, src, r.x, r.y, r.w, r.h);
}
```

and `blitOutputToDrawingBuffer` (`engine.ts:1751-1767`) ends:

```ts
const tex = handle.surface.texture;
if (!tex) return;
this.blitTexToDrawingBuffer(tex);
```

**`outToLaunch`'s handle has `texture: null`.** `out-to-launch.ts:165-167`:

```ts
const surface: VideoNodeSurface = {
  fbo: null,
  texture: null,
```

with the def's own comment saying why (`:131-133`): *"A sink has no output
surface (fbo/texture null); we allocate our OWN tiny 9×9 read FBO to downsample
into + readPixels off."*

**So the blit is a no-op, and the `drawImage` runs anyway.** The thumb paints
whatever the shared engine drawing buffer last held — i.e. **the picture of the
last node that DID blit** — scaled into this module's tile.

### 0.2 ⚠ `hasVideoSurface`'S OWN DOC COMMENT STATES THE PREMISE, AND IT IS FALSE HERE

`module-shell-model.ts:168-176`:

> *"exactly the VIDEO-domain defs — the ones the VideoEngine registers a per-node
> surface FBO for … **so `blitOutputToDrawingBuffer` has something real to
> show**. An AUDIO-domain module with video-family PORTS … has NO engine surface
> — **blitting it would show a stale/black well** — so it keeps the static domain
> glyph."*

The author identified the exact failure mode, named it, and guarded against it in
the direction it was expected from (audio defs with video ports). **They did not
consider a VIDEO-domain def with no output surface**, and there is exactly one.

This is **wave 6's defect-ledger item 8, one level worse.** There,
`strict-faces.ts:835-837` and `picturebox.ts:309` reached the *right* conclusion
from a false premise. Here the false premise produces the *wrong* conclusion, and
the wrong conclusion is on screen.

### 0.3 THE POPULATION, AND HOW THE INSTRUMENT WAS VALIDATED

```
grep -rn "outputs: \[\]" packages/web/src/lib/video/modules/*.ts
  → packages/web/src/lib/video/modules/out-to-launch.ts:103

grep -rln "fbo: null" packages/web/src/lib/video/modules/
  → packages/web/src/lib/video/modules/out-to-launch.ts
```

Two independent greps, on two different properties (the DECLARATION and the
IMPLEMENTATION), agreeing on one file.

⚠ **What that instrument is invariant to, stated because CLAUDE.md requires it:**
a def whose `outputs` array is built by a helper or a spread rather than written
inline is invisible to the first grep, and a factory that assigns
`surface.texture = null` in a branch rather than in the literal is invisible to
the second. A first attempt at inverting the first grep
(`grep -L "outputs: \[$\|outputs: \[{"`) returned 20+ files and was **wrong** —
it was matching on formatting, not on emptiness, exactly the "a filter applied
before the check that quietly redefines the check's subject" shape. **The
authoritative form is a build-time read, and it is what the precursor's own test
must assert:**

```ts
expect(listVideoModuleDefs().filter((d) => d.outputs.length === 0).map((d) => d.type))
  .toEqual(['outToLaunch']);
```

That is a **derived membership** assertion, not a count — and it is the permanent
negative control for the fix, because the day a second surface-less video module
lands, it reddens and names it.

### 0.4 THE FIX — **A PRECURSOR, AND IT IS ATTEST-ZERO**

```ts
// module-shell-model.ts — the ONE-LINE change
export function hasVideoSurface(def: ShellDefLike | undefined): boolean {
  return def?.domain === 'video' && (def.outputs?.length ?? 0) > 0;
}
```

with `LaneGlyphDefLike` (`:219-222`) widened by one optional field, and the
existing unit legs (`module-shell-model.test.ts:406-411`, `:463-467`) extended
with the sink case in both directions.

**Why this shape and not the other two:**

| candidate | verdict |
|---|---|
| give `blitOutputToDrawingBuffer` a boolean return and have the thumb skip its `drawImage` | ⛔ **`packages/web/src/lib/video/engine.ts` is in the WebGL attest basis** (`webgl-attest-lib.ts:261` walks all of `lib/video`), so it costs a GPU re-attest window to buy a one-line guard |
| switch `VideoTileThumb` to `blitOutputForPreview`, which already returns `false` on `!tex` (`engine.ts:1660-1682`) and whose doc says *"A card previewing ITS OWN node calls this and SKIPS its `drawImage` when it returns false"* | ⚠ **tempting and wrong.** It is not a drop-in: `previewDecision` consults `this.cardVisible.get(nodeId)` and the render leases, which is a DIFFERENT visibility notion from the thumb's own `IntersectionObserver`. Thumbs would go dark for nodes whose *card* is not registered visible. `card-preview-gate.test.ts` also asserts which callers use which method, so the swap is a gate edit as well |
| **widen `hasVideoSurface`** | ✅ **CHOSEN.** `lib/ui/workflow/module-shell-model.ts` is in **no** attest clause (the basis takes from `lib/ui/modules` only `.svelte` files that create a WebGL context, `webgl-attest-lib.ts:266-272`); it fixes the class for any future surface-less video def, not just this one; and the predicate stays PURE and derived from the def |

⚠ **It is a precursor and not part of the face PR**, for the reason wave 6 gave
about `peertube`: a face PR that is simultaneously the cause and the cure of a
visible change is not a reviewable change. Here the face makes it *worse* —
`laneGlyphFor` returning `'picture'` means the picture **OUTRANKS ranked
controls** in `laneBodyPlan` (#1785, `module-shell-model.ts:198-215`), so a
promoted `outToLaunch` would evict `BRIGHT` and `GAMMA` from its lane tile in
favour of a well showing some other module's video.

⚠ **AND AFTER THE FIX, `laneGlyphFor` RETURNS `'none'` FOR THIS MODULE** — the
only video module in the fleet with no lane picture. §5 is written against the
fixed world and says what the tile shows instead.

---

## 1. THE CONSTRAINT MAP, READ FIRST

| constraint | this module's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** — promotion is purely additive | `legacy-fallback.ts:110-129` |
| lane render kind today | `'placeholder'` — a RACKLINE tile whose real card is reachable only through the dock full view | `legacy-fallback.ts:158-162` |
| `HEADLESS_MOUNT_LANE_TYPES` | **NOT a member**, and the registry says so in its own header: *"`outToLaunch` is `bespoke-surface` and is not a `HEADLESS_MOUNT_LANE_TYPE`, so under the default shell its card exists ONLY inside the dock full-view"* | `node-launchpad-monitor-registry.svelte.ts:15-18` |
| domain / ports | `video`; `inputs: [{id:'in', type:'video'}]`, **`outputs: []`** — the fleet's only video SINK with no output surface | `out-to-launch.ts:97,100-103` |
| params | **TWO, and both are ALIVE** — but not where you would look (§2) | `out-to-launch.ts:104-107` |
| lane picture | ⚠ **BROKEN TODAY** (§0); `'none'` after the precursor | `module-shell-model.ts:177-179` |
| glyph | `'none'`, **mechanically forced** (§5) | `shell-glyph-live.ts:111-113` |
| `pullExempt` | `true` — the engine keeps drawing it with no observer | `out-to-launch.ts:110` |
| WebGL attest — the DEF | ⚠ **IN THE BASIS** (`lib/video/**`) — but `face`/`controlFamilies`/`docs` are STRIPPED, so the face itself is hash-transparent (§12) | `webgl-attest-lib.ts:261`; `attest-code-basis.ts:53-61,97-99` |
| ART | **ZERO** — video domain, outside the audio profile gate | — |
| `contract-lock` | ⚠ **MOVES** — a declared family is projected | `contract-signature.ts:237-241`; `contract-lock.txt:2435-2438` |
| `STRICT_DOCS` | **already a member** — and that makes a new family COST a doc entry (§12) | `strict-docs.ts:460` |
| `DESCRIPTIONS` | **already present**, and it is one of the longest in the file | `module-manifest.ts:164-165` |
| Push 2 card | **unchanged** unless a param is added; no explicit override exists | `push-card-config.ts` (no entry) |
| shell extension slot | `fullViewBody` — and **REQUIRED**, not optional (§6.3) | `video-face-screen-source.test.ts:104-118` |
| SCREEN ON/OFF ruling | ⚠ **APPLIES** — `STRICT_FACES ∩ video defs`, no exemption warranted (§6.3) | `video-face-screen-source.test.ts:53-68` |
| tab rail | **NO** — one band against `DOCK_TAB_MIN_BANDS = 7` | `strict-faces.ts:802` |
| `.data` writes | **ZERO call sites today**; the face adds exactly **ONE** (§7) | `grep -n "\.data" OutToLaunchCard.svelte` → no match |
| VRT | `EXEMPT_FROM_VRT` **and** `ALLOWED_PERMANENT_EXEMPT` | `vrt-exemptions.ts:450`, `:1205` |
| e2e coverage of the CARD | ⚠ **A P0 SPEC DRIVES IT END TO END, AND PROMOTION BREAKS IT** (§8) | `launchpad-monitor-survives-card-collapse.spec.ts` |

### 1.1 ⚠ THE TWO ONE-LINE ANSWERS THE WAVE ASKED FOR

> ### **WHICH SIDE OF THE `NON_SHELL_LANE_TYPES` SPLIT:**
> **`outToLaunch` is NOT in the set**, so `hasCard` is true and `migrated` is
> false, and it renders as **`'placeholder'`** today (`legacy-fallback.ts:158-162`)
> — a RACKLINE tile with no ranked controls whose real card is reachable only
> through the dock full view. **Promotion is purely additive**: the entry
> `'placeholder'` → `'shell'` needs no deletion anywhere, which is the exact
> opposite of its sibling.

> ### **WHAT WOULD MAKE IT DRAINABLE FROM `ALLOWED_PERMANENT_EXEMPT`:**
> **BOTH halves of its stated reason are falsifiable, and the argument is
> midiclock's twice over** — (a) the *"Web-MIDI device list"* does not exist
> pre-Connect, because `connectAndList()` (`OutToLaunchCard.svelte:179-185`) is
> the only caller of `deviceConnect()` and the VRT suite presses nothing, so
> `ports` is `[]` and the picker branch never renders; and (b) the *"live 9×9
> monitor preview"* on a **solo spawn has no input**, so the fragment shader takes
> its `uHasInput < 0.5` branch (`out-to-launch.ts:65-68`) and writes solid black
> into the 9×9 FBO — the preview is 81 unlit `#131318` sockets over `#060608`, a
> pure function of the code. **Drainable. Recommend the drain; no
> `FACES_WITHOUT_SCENES` entry** — but §10.3 names the one real hazard (a
> first-paint race the scene must settle in frames, never in ms).

⚠ **The compact-by-default argument is scoped by that first line.** This module
DOES get a lane tile, so the section-heading-versus-caption tradeoff is live for
it — and `face.bareCells` is still **not** declared, because `BRIGHT` and `GAMMA`
are not otherwise-identical controls and no section heading above them says what
either does.

---

## 2. THE TWO PARAMS ARE **ALIVE** — BUT THE SHADER NEVER READS THEM

Wave 6's headline shared finding was that `gain` is **declared-but-dead** on four
of its six modules (README §5.1), and the brief asks whether this pair has the
same problem. **It does not, and the reason is worth stating precisely, because a
grep for the uniform would have concluded the opposite.**

`FRAG_SRC` (`out-to-launch.ts:51-78`) declares exactly two uniforms — `uTex` and
`uHasInput`. There is no `uBright`, no `uGamma`, and `surface.draw`
(`:168-189`) never touches the `params` object. **Grepping the shader says
DEAD.**

They are alive, on the CPU, in two places:

| consumer | at | what it does |
|---|---|---|
| the **LED pump** (hardware) | `node-launchpad-monitor-registry.svelte.ts:262-266` | `const bright = ve.readParam(id, 'bright') ?? OUT_TO_LAUNCH_DEFAULTS.bright;` … `setMonitorFrame(id, { leds: monitorGridToLeds(grid, { bright, gamma }) })` |
| the **on-card preview** | `OutToLaunchCard.svelte:99-103`, `:160` | `disp(v8, bright, gamma)` → `rgb8ToLp(v8, bright, gamma)` (`launchpad-sysex.ts:368-375`) |

`readParam` on the handle (`out-to-launch.ts:203-205`) reads the `params` object
that `setParam` (`:200-202`) writes, so the engine seam is real and live.

**So the correct statement is: the GPU pass is a pure box-average downsample and
knows nothing about look; BRIGHT and GAMMA are applied AFTER the readback, on the
81 CPU bytes, identically to the LEDs and to the preview.** The def's own docs
say so at `:120-121` (*"Applied identically to the on-card preview"*) and the
`DESCRIPTIONS` entry repeats it (`module-manifest.ts:165`).

**Three consequences a face must honour:**

1. **The face's body MUST apply the same transform to its own preview**, through
   the same `rgb8ToLp` from `$lib/control/launchpad/launchpad-sysex`. Any
   re-derivation is CLAUDE.md's *"a card can silently disagree with its def"*
   class. The registry already states the rule for exactly this pair of numbers
   (`node-launchpad-monitor-registry.svelte.ts:108-115`): *"`monitorGridToLeds`
   defaults gamma to 1 for an omitted option, but the module's declared default is
   2.2 — so falling through to the helper's default would silently render a
   DIFFERENT picture than the card does. Import rather than re-type."*
2. **A face cell writing `bright`/`gamma` reaches the hardware through the engine,
   with no card mounted.** The pump reads off the engine (`ve.readParam`), never
   off a card's props, *"the card is the thing that may not exist"*
   (`:255-257`). So the two knobs work on a promoted module by construction.
3. ⚠ **The knobs are the ONLY controls in this pair that a lane tile can carry**,
   and after §0.4's precursor the lane tile is exactly them (§5).

### 2.1 ⚠ THE LEGACY CARD RE-TYPES BOTH RANGES

`OutToLaunchCard.svelte:216` passes `min={0} max={1}` and `:224` passes
`min={0.5} max={3}` as bare numeric literals, while the def declares the same
four numbers at `:105-106`. They agree today. That is the backdraft class
verbatim — *"a control's range must come from ONE place"* — and no gate sees it,
because `card-range-source.test.ts` is opt-in per card (`RANGE_BOUND_CARDS`) and
this card is not enrolled.

**Boy-scout it in the face PR:** replace both with `paramSpec(outToLaunchDef,
'bright')` / `paramSpec(outToLaunchDef, 'gamma')` (`card-kit.ts:84`) and add
`OutToLaunchCard.svelte` to `RANGE_BOUND_CARDS`.

⚠ **`paramSpec` is also the ONLY correct route here for a second reason** (#2186):
`out-to-launch.ts` is in the WebGL attest basis, so a new
`export const OUT_TO_LAUNCH_BRIGHT_RANGE` would be ordinary code and would move
the hash. `paramSpec` reads the `ParamDef` the def already declares and costs
zero.

---

## 3. EVERY READOUT THE CARD PAINTS TODAY, AND ITS VERDICT

| # | what it is | where | verdict | what replaces it |
|---|---|---|---|---|
| 1 | **`MONITOR ACTIVE` — this Launchpad's LEDs mirror the video. It can't be used for control while bound.** | `:206-210` | ⛔ **REMOVED — §3.1** | a `StatusLed caption="MONITOR"` whose `lit` is the bind; the sentence relocates (§3.1) |
| 2 | `Bound to <code>{boundOut}</code>.` | `:237` | ⛔ **REMOVED** — a derived device-port id painted outside every control | the `MONITOR` lamp's `detail` → `aria-label`; **and the port NAME survives painted inside the picker**, which is where an option name is permitted |
| 3 | `Connect Launchpad` / `Connecting…` | `:242-244` | ✅ **KEPT** — a control caption naming the action, and the two names are two states of one gesture (`../launchpadControlLeft/spec.md` §3.4) | ⚠ but see §6.2: a ranked `ShellActionCell.label` is a fixed `string`, so the `Connecting…` variant survives only in the BODY |
| 4 | `Unbind Launchpad` | `:238-240` | ✅ **KEPT** — a control caption | body |
| 5 | the picker's `{p.name}` per port | `:259` | ✅ **KEPT** — an option NAME inside the control that SELECTS it. The settled discriminator, and `cameraInput`'s device-name precedent | unchanged |
| 6 | `(in use)` suffix + `title="Already in use by another binding"` | `:255-259` | ⚠ **KEPT as a DISABLED STATE, text trimmed — §3.2** | the `disabled` attribute is the signal; the sentence moves to `aria-disabled` + the accessible name |
| 7 | `Web MIDI isn't available in this browser — open in Chrome/Edge to drive a Launchpad.` | `:233-235` | ✅ **KEPT** — an ERROR, absent whenever nothing is wrong | midiclock's precedent (`MidiclockDeviceBody.svelte:22-28`) |
| 8 | `No Launchpad detected. Plug one in (it shows up as a "… MIDI" port) and Connect again.` | `:246-248` | ✅ **KEPT** — an ERROR | same |
| 9 | the 9×9 preview canvas | `:203` | ✅ **KEPT — it is the module's own artwork** | unchanged, plus a SCREEN switch (§6.3) |

### 3.1 THE `MONITOR ACTIVE` BANNER — **DECIDED: DELETE**, and it IS a relocation

The brief flags this one: the inventory `why` calls out *"a warning that the
bound surface can no longer be used for control"*, and asks whether wave 5 §2.3's
narrow ground (the text survives verbatim in the def's authored `docs`) holds
here.

**It holds, and better than it did for `chromaconsole`.** `out-to-launch.ts:114`,
in `docs.explanation`:

> *"Bind a device from the card (Connect, then pick a Launchpad); **once bound it
> becomes a screen and its LEDs are driven by the video, so it can't be used for
> control at the same time (out to launch takes it over).**"*

That is the banner's sentence, longer and with the mechanism attached. It is
reachable by right-click → **Annotate** — and unlike its sibling, this module
**has** an Annotate entry, because `MODULE_DOCS['outToLaunch']` exists
(`ctxMenuHasDocs`, `Canvas.svelte:5302-5305`) and a **Docs** page is generated at
`/docs/modules/outToLaunch` from the same `docs` field. `DESCRIPTIONS`
(`module-manifest.ts:165`) says it a third time, in capitals: *"a bound Launchpad
CANNOT be used for control at the same time"*.

**So the deletion is a RELOCATION to three surviving surfaces, not a coverage
loss.** The signal that a device is taken over survives on the plate as the
`MONITOR` lamp — a picture, lit or dark, with the port id in `detail` →
`aria-label`. Nothing anywhere adds a reassuring word.

⚠ **And the banner's `<b>MONITOR ACTIVE</b>` is exactly the shape `StatusLed`
was built to make inexpressible**: a caption that only exists in one state.
`status-led-source.test.ts` denies `lit ? 'X' : 'Y'` at the call site; the honest
form is a lamp that is always captioned `MONITOR` and is lit or dark.

### 3.2 THE `(in use)` SUFFIX — KEPT AS STATE, TRIMMED AS TEXT

`isClaimedByOther(p)` (`:194`) is `isOutputClaimed(port.outputId, id)` — the
one arbiter both modules in this pair share (§14). A port already held by a
LAUNCHPAD CONTROL unit, or by another monitor, cannot be bound.

The `disabled` attribute (`:255`) already carries it non-textually, and a
disabled option is a *position of the control*, not a measurement — so the state
survives. The suffix `' (in use)'` appended to the option name is a **derived
word appended to a name**, which is the one thing an option name may not become,
and `title=` is *"there but hidden"*, refused by name. Both go; the sentence
becomes the option's accessible name.

⚠ **The finding that loses its painted surface**, named as CLAUDE.md requires:
*"the other launchpad module has this device"* — the only place in the product
that says the two siblings contend for one surface. It survives as the
`disabled` state plus the accessible name, and it is the thing a
face e2e should assert (§8).

⚠ **In-canvas text is a different object and the ruling is already made**
(wave 5 `GAMES.md:59-65`): pixels the MODULE renders into its own surface are its
artwork, not the face's chrome. The 9×9 preview draws no text at all
(`drawPreview`, `:112-135`, is `fillRect` + `roundRect`/`arc` only), so this
module does not even reach that question — stated so a reviewer does not have to
check.

---

## 4. WHAT MAKES IT BESPOKE, AND WHAT IT IS NOT

**The primary interaction is BINDING A PHYSICAL SURFACE AS A SCREEN.** The two
knobs are real and alive (§2) but they are look controls on a monitor; nothing
about them is bespoke, and a generic face would rank them fine.

What a generic face cannot do is the roster: `enumerateLaunchpadPorts()` returns
a per-machine list behind `requestMIDIAccess`, so it is neither a `ParamDef` nor
an `options` roster. `legacy-fallback.ts:75-88` states the constraint in its
corrected form — *"a runtime roster cannot be a `ParamDef`'s `options` (a roster
is a fixed set known when the def is authored, and this one differs per machine),
so it needs a SURFACE rather than a cell"* — and names the two shipped answers,
`cameraInput`'s and `midiclock`'s, both `fullViewBody`.

**And the 9×9 preview is the second bespoke half**: it is a picture no
`ParamCellKind` mounts, and it is the module's only feedback with no hardware
present (`out-to-launch.ts:20-21`: *"It also draws the same grid as an on-card
preview so you can see the monitor with no hardware"*).

⚠ **The device roster does NOT need a platform capability, and this spec does not
ask for one.** Wave 5 `BINDERS.md` §1 disproved the `env`-for-selectors ask
(`ShellCellEnv.engine` is `{ write }` with no `read`), and the route that works
is `getActiveEngine()` from plain `.ts` — except that here even that is
unnecessary, because a `fullViewBody` is an ordinary Svelte component that can
call `enumerateLaunchpadPorts()` directly, exactly as the card does at `:183`.

---

## 5. THE LANE TILE — AFTER THE PRECURSOR, TWO KNOBS AND NO PICTURE

With §0.4's fix, `hasVideoSurface(outToLaunchDef)` is **false**, so
`laneGlyphFor` falls through to the declared glyph.

`glyphBinding` (`shell-glyph-live.ts:129-201`) with `outputs: []`:
`primaryAudioOutPortId` returns **null** (`:111-113`), there are no
`attack/decay/sustain/release` params, and every remaining literal falls to
`{kind:'static'}` — the #1692 dead-glyph shape `module-face-lint` refuses by
name. ⚠ The one literal that *would* bind is `'algorithm'`, via the
`face.extension` branch (`:154-159`), and taking it would mean authoring a
`ShellExtensionGlyphProps` component. **Refused**, because that props interface
carries no `nodeId` (`shell-extensions.ts:44-51`) — so a glyph is a pure function
of a discrete param value and **every instance of the module would draw an
identical picture**, which is the opposite of what a per-node 9×9 monitor means.

**So `glyph: 'none'`, forced.** Assert it in the module's face-model test with a
negative control, not in a comment.

**What the tile shows at 1/8 size:** the RACKLINE frame, `OUT TO LAUNCH`, and the
top-3 glyph-less ranked cells — `BRIGHT`, `GAMMA`, and the CONNECT action cell
(§6.2). That is strictly more than today's placeholder, and — after the precursor
— strictly more *honest* than today's borrowed picture.

⚠ **This makes `outToLaunch` the only video-domain module in the fleet with no
lane picture, and the reason must be recorded on the def**, because "a video
module with `glyph:'none'` and no thumbnail" is otherwise indistinguishable from
a bug. The sentence is: *it is a SINK with no output surface; there is no picture
of this node to show, and the picture it USED to show was another node's.*

---

## 6. THE FACE

### 6.1 THE CONTROL CENSUS, AND WHY THE RAIL IS REFUSED

Two params of one shape (`0..1 linear`, `0.5..3 linear`), one connect gesture, one
picker, one unbind, one screen switch. `DOCK_TAB_MIN_BANDS = 7`
(`strict-faces.ts:802`); this face declares **one** page. The 2026-08-18
control-heavy ruling asks for *"many controls of DIFFERENT types"*; this is two
knobs and some buttons. **No rail**, and nothing is padded to reach one.

### 6.2 THE DECLARATION, AS IT WOULD BE COMMITTED

```ts
// out-to-launch.ts
controlFamilies: [
  { id: 'out-to-launch-connect', label: 'Connect', kind: 'other', testidPrefix: 'out-to-launch-connect' },
],

face: {
  glyph: 'none',
  order: ['bright', 'gamma', 'out-to-launch-connect-{n}'],
  extension: 'outToLaunch',
},
```

**CONNECT is a ranked ACTION cell for midiclock's stated reason**
(`shell-cells.ts:2051-2062`): Web MIDI shows no device until the browser consents,
so before that press the module has *"no stream, no device roster"* and looks
broken — *"An `action` cell is not dock-restricted (only `panel` is, by
`panelCellKeys`), so ranking this key puts the gesture on the lane tile where the
module is met."* Exactly the same is true here: an unbound `outToLaunch` is a
black grid.

Its probe is an **audition**, for midiclock's stated reason verbatim
(`:2076-2083`): `connected` can never flip on a CI runner with no MIDI device, so
a state probe would be RED on a perfectly live control. `probe: { effect: { kind:
'audition', seam: 'engine-message' } }`.

**NOT ranked:** the picker (a runtime roster — §4), UNBIND (it is meaningful only
while bound, and `ShellActionCell` has no `disabled` and no node-dependent label,
`shell-cells.ts:312-327`), and the SCREEN switch (§6.3 — it is a body control by
the gate's own construction).

### 6.3 THE `fullViewBody` — REQUIRED BY A GATE, NOT CHOSEN

⚠ **The brief asks whether the SCREEN ON/OFF ruling applies. It does, and it is
not optional.** `video-face-screen-source.test.ts` runs over
`listVideoModuleDefs().filter(d => STRICT_FACES.has(d.type))` (`:71-76`), and
`NO_SCREEN_SWITCH` holds exactly one entry — `videoOut`, exempt because *"videoOut
IS the screen"* (`:57-68`). A promoted `outToLaunch` is in scope, and the gate has
three legs (`:145-156`): the body must **read** `previewCollapsed`, must **write**
`.data.previewCollapsed =`, and must expose a `<button>`.

**And it deserves no exemption.** `videoOut`'s ground is that collapsing it would
*"collapse the module's entire reason to exist"*. `outToLaunch`'s reason to exist
is **the LEDs on the hardware**; the 9×9 canvas is explicitly the fallback for
*"no hardware"* (`out-to-launch.ts:20-21`). It is a preview that sits NEXT TO the
module's controls — the ruling's own words for what it is about.

⚠ **AND THIS MODULE SATISFIES WAVE 6 §4.3'S SHARPEST EDGE BY CONSTRUCTION.** That
section warns: *"SCREEN OFF must never stop an ENCODE or a CAPTURE."* Here the
equivalent is *SCREEN OFF must never stop the LED push*, and it structurally
cannot — the pump lives in `node-launchpad-monitor-registry`, whose whole reason
for existing (#1728) is that it is **not** on the card. The preview rAF
(`OutToLaunchCard.svelte:153-162`) *"paints the on-card canvas and nothing
else"*. Collapsing the screen skips a `drawPreview`; the hardware never notices.

⚠ **The watch mark (`markWatched` / `pullExempt`, #2015) is a non-issue here**,
and for a reason rather than by luck: `pullExempt: true` (`out-to-launch.ts:110`)
means the engine keeps drawing this node with no observer, and the body never
calls a blit at all — it reads `read(id, 'grid9x9')`. There is no watch to lapse.

**Body contents, in order:**

1. **the 9×9 preview `<canvas>`**, `CANVAS_PX = 236` square (§6.4), painting
   through `rgb8ToLp(v8, bright, gamma)` imported from `launchpad-sysex` — never
   re-derived (§2.1);
2. **the SCREEN switch** — a real `<button>` over `node.data.previewCollapsed`,
   backdraft's shared key;
3. **the device picker** — `<button>` per `LaunchpadPort`, `disabled` on
   `isOutputClaimed` (§3.2);
4. **UNBIND**, when bound;
5. **one `StatusLed caption="MONITOR"`**, `lit={bound}`, `detail` = the port id
   and the takeover sentence;
6. **the two error branches** (rows 7-8 of §3).

### 6.4 WIDTH — THE PICTURE DEFINES THE PLATE, AND IT IS 236 px

The gate is `bodyW - contentW <= FACE_WIDTH_SLACK_MAX_PX (40)` with a NAMED
`FACE_WIDTH_EXEMPTIONS` entry otherwise
(`workflow-shell-faces.spec.ts:209-224`, `:264`).

**The measurement, derived from the card's own constants**
(`OutToLaunchCard.svelte:94-97`):

```
CELL = 22, GAP = 3, PAD = 7, LP_MONITOR_COLS = 9
CANVAS_PX = 9*22 + 8*3 + 2*7 = 198 + 24 + 14 = 236  (square)
```

Against that, the two knob cells in one band are roughly two hero-rail widths
plus a gutter — well under 236 — and `OUT TO LAUNCH` is a 13-character name row.
The legacy card is `width: 300px` (`:271`) precisely because the 236 px canvas
plus its `margin: 8px auto` and border sits inside it.

**So the plate is defined by a LIVE PICTURE, which is the ruling's first named
earner** — *"A genuine earner is a live picture, a scope trace, a video preview,
an XY pad"*. But it earns only **236 px**, which is narrower than most faces in
the fleet. **The honest conclusion is that this face is COMPACT BY MEASUREMENT,
not compact by claim, and no `FACE_WIDTH_EXEMPTIONS` entry is needed.**

⚠ **Do NOT scale the preview up to "use the space".** There is no space; the
plate shrink-wraps. And the grid is nine cells across — enlarging it buys
resolution the source does not have.

---

## 7. WHERE STATE LIVES — ZERO `.data` WRITES TODAY, EXACTLY ONE AFTER

```
grep -n "\.data" packages/web/src/lib/ui/modules/OutToLaunchCard.svelte
  → (no match)
```

| state | where | synced? | undoable? | survives reload? |
|---|---|---|---|---|
| `bright`, `gamma` | `node.params`, via `cardParams(...).set` (`:56`) | ✓ | ✓ | ✓ |
| the device claim + programmer mode | the **DEVICE**, `launchpad-device.svelte.ts` | n/a | n/a | ✗ |
| the bind + the 30 fps pump | `nodeLaunchpadMonitor`, a **module-scope registry** | ✗ | ✗ | ⚠ **✗ — nothing is persisted at all** |
| the preview rAF | the card, correctly (`:20-23`) | ✗ | n/a | ✗ |

⚠ **The bind does not survive a reload, and the e2e says so in its own header**
(`launchpad-monitor-survives-card-collapse.spec.ts:17-18`): *"`bindMonitor`
persists nothing to `node.data`, so nothing re-establishes it on remount."* That
was written as a description of the #1728 defect's mechanism, but the clause is
still true of `main`: the registry survives a **card unmount** and does not
survive a **page load**.

This is the sharpest state-model divergence in the pair. The sibling persists
four keys to `localStorage` and auto-restores on mount
(`launchpad-control.svelte.ts:1081`, `:1094`, and `LaunchpadControlCard.svelte:51`);
this module persists nothing and must be re-bound by hand every session. **Same
device, opposite policy** (§14).

⚠ **Not proposed as a face-PR fix.** Persisting a per-machine binding is a design
decision with a multiplayer edge (a synced `node.data.boundOutputId` would let one
collaborator's port id reach another's browser), and the sibling's version of it
is itself a defect (`../launchpadControlLeft/spec.md` D2). Recorded as **D3**.

### 7.1 ⚠ THE FACE ADDS THIS MODULE'S FIRST `node.data` WRITE — GET IT RIGHT ON DAY ONE

The SCREEN switch (§6.3) is required by a gate whose write leg is literally
`/\.data\.previewCollapsed\s*=/`. So the face introduces exactly one `.data`
call site into a module that has none.

**It must be `mutateNode` with `LOCAL_ORIGIN` from the first commit**, not a bare
SyncedStore proxy write. `mutate.ts:13-18` gives the consequence: an untagged
write *"is silently NOT undoable"*, because `store.ts:70` configures
`trackedOrigins: new Set([LOCAL_ORIGIN])`. `MidiclockDeviceBody.svelte:115-122`
is the shipped shape, with the reason attached:

> *"⚠ ORIGIN-TAGGED. The legacy card wrote this key with a bare SyncedStore proxy
> write … so picking a device synced to collaborators but never reached the
> UndoManager, i.e. it was silently outside Cmd-Z. `mutateNode` is the sanctioned
> seam."*

⚠ `mutate.guard.test.ts` **cannot see this** — its three patterns all anchor on
the literal token `.params`, so `.data` is invisible to it (wave 4's finding,
re-verified). The only thing that will catch a bare write here is review.

**This is the one place a wave-6/wave-5 defect can be prevented rather than
inherited**, and it is worth naming as such: four `.data` census entries across
three waves were all "a bare proxy write copied from a sibling". This module has
no sibling to copy from — it has no `.data` write at all — so the first one can
be correct.

---

## 8. ⚠ PROMOTION BREAKS A **P0** SPEC, AND ONE OF ITS LEGS GOES **GREEN AND BLIND**

`e2e/tests/launchpad-monitor-survives-card-collapse.spec.ts` is the guard for
#1728 — *"OUT TO LAUNCH must keep driving its Launchpad when its card goes
away"* — and it is the only e2e in the tree that touches this module.

⚠ **It boots the DEFAULT shell**, not `?shell=legacy` (`:139-141`): *"DEFAULT
shell (faceplates) — the configuration the bug needs. Under `?shell=legacy` the
card sits in the lane forever and never unmounts."* So unlike the sibling's four
specs, it is **not** insulated from promotion.

What it does, and what promotion does to each step:

| step | at | after promotion |
|---|---|---|
| `expect(page.locator('[data-testid="out-to-launch-card"]')).toHaveCount(0)` with the message *"the shell renders a placeholder tile, not the real card"* | `:155-158` | ⚠ **STILL PASSES — AND ITS MESSAGE BECOMES FALSE.** The shell renders a FACE, not a placeholder. A leg that is green while its stated subject no longer exists |
| `openFullView(page)` then `expect(…out-to-launch-card).toHaveCount(1)` — *"real card mounted in the dock full-view"* | `:172-175` | ⛔ **RED.** `DockFullView.svelte:136`, `:334` mount `<ModuleShell view="dock-full">` on `migrated`; the card mounts nowhere |
| `getByTestId('out-to-launch-connect').click()` | `:179` | ⛔ RED — the testid is on the card |
| `getByTestId('out-to-launch-picker')` → first `button` click | `:180-183` | ⛔ RED |
| `getByTestId('out-to-launch-active')` — *"the card reports MONITOR ACTIVE"* | `:184` | ⛔ RED — and §3.1 **deletes that banner**, so the assertion has to change subject as well as selector |
| the probe legs, the positive control, the collapse, and the three post-collapse assertions | `:186-260` | ✅ all node/device-side; untouched |

**The first row is the interesting one.** It is CLAUDE.md's *"a gate whose
PRECONDITION is the defect cannot fail on the defect"* class arriving sideways:
after promotion that assertion is true for a reason unrelated to what it says, so
it silently stops distinguishing "the shell paints a placeholder" from "the shell
paints a face" from "the shell paints nothing at all". **The green failure fires
first and hides nothing — the red ones are loud — but the repaired spec must fix
the SUBJECT, not the selector**: assert `moduleShell` for this node's lane tile,
which is a positive statement about the world after promotion.

**So the face PR owns repairing this spec**, and the repair makes it strictly
stronger: it drives the **face's** Connect / picker / Unbind, which is the surface
a user will actually have, over the same simulated device, with every node-side
and hardware-side assertion unchanged.

⚠ **Its `test.describe.configure({ timeout: 120_000 })`** (`:133`) and the note
above it — *"a generous BOUNDED-FAILURE cap, not a budget … CI's SwiftShader runs
the video lane an order of magnitude slower than a GPU — every assertion below is
an auto-retrying poll on the real subject, never a wall-clock wait"* — must
survive the repair verbatim. Do not convert any of it to `waitForTimeout`, and do
not tighten the cap because the local run was fast.

### 8.1 ⚠ THIS SPEC IS INDEPENDENT CORROBORATION OF THE COHORT'S HEADLINE

Worth a paragraph rather than a footnote, because a derivation and a shipped
assertion agreeing is much stronger evidence than either alone.

The cohort-level claim is derived from `laneRenderKind` (`legacy-fallback.ts:158-162`):
the non-carve-out members render as `'placeholder'`, so their real card is
reachable **only** through the dock full view. **This spec asserts that live, in
CI, in its own words, and it was written months earlier for an unrelated bug**
(`:154-156`):

> *"Un-migrated (`bespoke-surface`) module under the shell: no real card in the
> lane at all. **Its card exists ONLY inside the dock full-view.**"*

⚠ **And the coverage asymmetry inside this pair is total.** Of the 16 e2e specs
covering the seven-module cohort, **14 run only under `?shell=legacy`** via the
`rack` fixture (`_fixtures.ts:91-93`). The two exceptions are **this spec**
(default-shell only) and `es9-shell-lifetime.spec.ts:56` (parameterised over
both). So `outToLaunch` has the **best** default-shell coverage in the cohort and
its sibling has **none** — all five `launchpadControlLeft` specs are `rack`-fixture
(`../launchpadControlLeft/spec.md` §2).

**That inverts the usual risk reading of the two modules.** The module with a
real spec is the one whose promotion breaks something; the module with none is
the one whose promotion cannot break anything *and* cannot be verified. Neither
is the safer choice for the reason it looks like.

**Other suites:** `out-to-launch.test.ts` (165 lines, def + fake-GL factory
contract), `launchpad-monitor.test.ts` (238 lines, the pure colour mapping),
`launchpad-device.test.ts` (212 lines, bind/claim/diff/unbind) and
`node-launchpad-monitor-registry.test.ts` all read models, not surfaces.
**None breaks.**

---

## 9. `EXTENSION_BODY_ROLES` — **`picture`**

⚠ The brief warned the role set moved. **Verified on the merged file:**
`face-rack-status-source.test.ts:142` is `'picture' | 'status-primitive' |
'control-grid'`, and the anchor at `:808-827` is a SET IDENTITY against
`ROLE_PREDICATE`'s keys in both directions.

The `picture` predicate is `paintsCanvas(src, extId)` (`:560-566`) — *"mounts a
`<canvas>`, directly or through a surface component it renders"*. The body mounts
one directly. ✅

⚠ **The roles are ordered by the canvas test and are not exclusive by intent**
(the file says so at `:38-43`), so a body that keeps a preview canvas **and** uses
`StatusLed` is legally `picture`. This body does both, and `picture` is correct:
the 9×9 IS the surface.

**The entry, as it would be committed:**

```ts
outToLaunch: {
  role: 'picture',
  why:
    "the LAUNCHPAD MONITOR — a 236 px 9x9 canvas that is a pixel-for-pixel model of the bound "
    + "device's LEDs (rounded squares for the 8x8 pads, circles for the top CC row, right scene "
    + "column and corner logo), painted from the module's own GPU readback through the SAME "
    + "rgb8ToLp(bright, gamma) the hardware push uses, so the preview and the LEDs cannot "
    + "disagree. ⚠ IT DRAWS NO TEXT AT ALL — fillRect, roundRect and arc only — so it does not "
    + "reach the in-canvas-text question this file's header names as its blind spot. Beside it: "
    + "the SCREEN switch over the shared previewCollapsed key, the runtime Launchpad-output "
    + "picker (a per-machine roster behind requestMIDIAccess, so never a ParamDef and never an "
    + "options list), UNBIND, and one StatusLed captioned MONITOR whose detail carries the bound "
    + "port id and the takeover warning. ⚠ SCREEN OFF SKIPS THE PAINT AND NOTHING ELSE: the "
    + "30 fps LED pump lives on node-launchpad-monitor-registry, not here, which is #1728's "
    + "whole point — collapsing this canvas cannot darken a performer's hardware.",
},
```

---

## 10. VRT — THE DRAIN

### 10.1 THE PREDICTION: **THREE PNGs**, plus two deletions and **no** `vrt-cable-stripe` edit

| file | authored by |
|---|---|
| `e2e/vrt/__screenshots__/vrt.spec.ts/outToLaunch.png` | the drain from `EXEMPT_FROM_VRT` (`vrt.spec.ts:52-55`) |
| `…/workflow-shell-faces.spec.ts/face-outToLaunch-compact.png` | the `FACES` roster entry (`:325`) |
| `…/workflow-shell-faces.spec.ts/face-outToLaunch-dock.png` | same (`:372`) |

Plus, in source: delete `outToLaunch` from `EXEMPT_FROM_VRT`
(`vrt-exemptions.ts:450`) **and its comment block** (`:441-450`), and delete
`'outToLaunch'` from `ALLOWED_PERMANENT_EXEMPT` (`:1205`) — anchored in both
directions (`:1197-1199`), so leaving the name is RED.

⚠ **`vrt-cable-stripe.test.ts` needs NO edit here, and the sibling's needs one.**
That gate's `NOT_TOKEN_PINNED_SCENES` is an EXACT SET derived from the committed
baselines (`:684-699`). `OutToLaunchCard.svelte:198` renders
`<div class="stripe" style="background: var(--cable-video);">` — a token-pinned
stripe — so the new baseline joins the **checked** population rather than the
excused one. ⚠ That means the new `outToLaunch.png` is immediately subject to the
palette-drift assertion, which is a *gain*, and it is worth predicting so a
first-run failure there is read as real drift rather than as noise.

⚠ Use `GREP=outToLaunch task vrt:commit`. A bare dispatch on a face PR derives
**FULL**, because face PRs touch shared roster files whose paths name no module
(CLAUDE.md, VRT section).

### 10.2 THE DRAIN ARGUMENT — BOTH HALVES OF THE STATED REASON ARE FALSIFIABLE

`vrt-exemptions.ts:450` says: *"live 9×9 monitor preview + Web-MIDI device list
are non-deterministic."*

* **The device list.** `connectAndList()` (`OutToLaunchCard.svelte:179-185`) is
  the only caller of `deviceConnect()`, and it fires only on the Connect button.
  The VRT suite presses nothing, so `ports` stays `[]` and the `.otl-picker`
  branch never renders. Structurally unreachable, not merely empty — midiclock's
  argument, verbatim (`_shell-faces.ts:3364-3376`).
* **The preview.** A solo spawn has nothing patched, so
  `frame.getInputTexture(node.id,'in')` is null, `uHasInput` is 0, and the shader
  writes `vec4(0,0,0,1)` into every one of the 81 texels
  (`out-to-launch.ts:65-68`). `drawPreview` then paints 81 unlit `#131318`
  sockets over a `#060608` field and takes the `r+g+b > 0` branch zero times
  (`OutToLaunchCard.svelte:129-132`). Every pixel is a function of the code.

⚠ **THE ONE REAL HAZARD, and it is not device-dependence: a FIRST-PAINT RACE.**
The preview is painted by a card-lifetime rAF (`:156-170`), so a capture taken
before the first `tick()` sees an *unpainted* canvas, which is not the same
picture as a painted-but-black one. **The scene must settle in FRAMES, never in
milliseconds** — `waitFrames` from `e2e/_helpers/frames.ts`, per the standing
rule, because SwiftShader runs the video lane at ~7.9 fps against ~60 on a GPU.
The scene is also self-evidencing if it asserts the canvas element is present
before comparing, the way matrixMix's `matrixmix-empty` leg does
(`_shell-faces.ts:3336-3338`).

### 10.3 THE FACES ROSTER ENTRY

```ts
{
  type: 'outToLaunch',
  pages: 1,
  videoFaceWhy:
    'a VIDEO module, so it must boot into the video zone rather than a mixer channel column — '
    + 'without this field bootWithFace waits out the full 90 s test timeout for a column '
    + 'membership a video node never acquires. ⚠ THE FREEZE HALF IS INERT HERE AND THAT IS FINE, '
    + 'STRUCTURALLY: FRAG_SRC declares exactly two uniforms (uTex, uHasInput) and the factory '
    + 'reads no clock — uTime, frame.time, frame.frameIndex, Date.now, performance.now and '
    + 'Math.random occur ZERO times in out-to-launch.ts — so with nothing patched the 9x9 is '
    + 'solid black on every frame. ⚠ DO NOT add a freeze param to "fix" that: it would be a '
    + 'params edit on a def in the WebGL attest basis, buying an assertion that already holds '
    + '(the 4plexvid ruling, _shell-faces.ts:1479-1486).',
}
```

⚠ **`videoFaceWhy` is the VIDEO-ZONE BOOT SELECTOR first and the freeze opt-in
second**, and `_shell-faces.ts:1433-1470` records at length that the first entry
to reason from the freeze half alone shipped without it and hung for 90 seconds.
*"A VIDEO FACE ALWAYS DECLARES THIS. There is no such thing as a video face that
opts out."*

**No `simPin`** — nothing here is a stateful sim whose frozen frame depends on
elapsed time.

---

## 11. THE FOUR GATES A FACE PR MUST SATISFY — VERIFIED AGAINST THE TREE

### GATE 1 — the face lints / `STRICT_FACES` promotion anchor
`module-face-lint.test.ts`; `strict-faces.ts` asserts the set EQUAL to the set of
defs declaring a `face`, both directions. Authoring the `face` IS the promotion.

### GATE 2 — the VRT baselines
§10. Three files, two deletions, no cable-stripe edit.

### GATE 3 — `EXTENSION_BODY_ROLES`
§9. Role `picture`; predicate confirmed (the body mounts a `<canvas>`).

### GATE 4 — `module-docs-lint`'s FAMILY↔CARD leg
`module-docs-lint.test.ts:359-376`. The declared prefix `out-to-launch-connect` is
**already emitted by the legacy card** at `:242`. **Zero card edits.** The card
file survives promotion (`modules-card-map.test.ts:51` still lists the type;
`?shell=legacy` still renders it).

⚠ **BUT THIS MODULE IS IN `STRICT_DOCS`, SO A FAMILY COSTS A DOC ENTRY.**
`module-docs-lint.test.ts:157`, `:418` — a promoted module must document
*every* port, param **and control family**, keyed
`ctrlDocs[`${f.id}-{n}`]`. So `docs.controls['out-to-launch-connect-{n}']` is
**required**, and it is the first thing a build agent will forget. midiclock's is
the model (`midiclock.ts:347-349`). ⚠ Its sibling owes nothing equivalent —
`MetaModuleDef` has no `docs` field at all.

### PLUS — the `optionsExhaustive` SNAP contract
`param-vocabulary.test.ts`. **Not applicable:** neither `bright` nor `gamma`
declares `options`, and neither should — they are continuous. The port picker is
a body control, not a cell, so `paramCellKind`'s off-dock `'knob'` fall-through
never sees it.

### ⚠ GATE 5, WHICH THE BRIEF DID NOT LIST
`face-migration-inventory.test.ts:213-226` — *"the DONE set IS STRICT_FACES —
both directions"*. **The entry must be re-dispositioned `bespoke-surface` →
`generic-face` with a `note:` in the same PR**, or the gate reddens. That is what
retires the current `why`'s *"a warning that the bound surface can no longer be
used for control"* by construction, once §3.1 deletes the warning.

---

## 12. THE COST TABLE

| cost | this module | measured at |
|---|---|---|
| **WebGL attest** | ⚠ **ZERO — but only because of what the normalizer strips, and the margin is thin.** `out-to-launch.ts` IS in the basis (`walk('packages/web/src/lib/video', p => p.endsWith('.test.ts'))`), and `attest-code-basis.ts` drops a def's own top-level `docs`, `controlFamilies`, `face` and `noUserControl` (`:53-61`, `:97-105`). **So `face:` + `controlFamilies:` + a new `docs.controls` entry are all hash-transparent.** ⚠ A new PARAM, a new `export const`, or any factory edit is NOT | `webgl-attest-lib.ts:261`; `attest-code-basis.ts:97-105` |
| **the BODY's attest status** | **ZERO**, conditionally: the basis takes `.svelte` under `lib/ui/modules` **only if `sourceCreatesWebglContext`** (`webgl-attest-lib.ts:266-272`). A Canvas2D body is out. ⚠ **A WebGL body would enrol the face in the GPU attest** — do not reach for WebGL to draw 81 rounded rectangles | `webgl-attest-lib.ts:266-272` |
| **the PRECURSOR's attest status** | **ZERO** — `lib/ui/workflow/module-shell-model.ts` is in no clause | §0.4 |
| **ART** | **ZERO** — video domain | — |
| **`contract-lock`** | ⚠ **MOVES** — one new line, `outToLaunch family out-to-launch-connect kind=other prefix=out-to-launch-connect`, beside the four at `:2435-2438`. `task docs:accept`; on conflict take main + re-run | `contract-signature.ts:237-241` |
| **Push 2 card** | **unchanged** — no param is added or renamed, and there is no explicit `PUSH_CARD_CONTROLS` override to drift. ⚠ If a future PR adds a param the card re-ranks silently (CLAUDE.md); give it an explicit entry then | `push-card-config.ts` |
| **docs / `STRICT_DOCS`** | **already strict** (`:460`), with a real `docs.explanation`, both control entries and the `in` port documented (`out-to-launch.ts:112-123`). ⚠ **The new family adds a required entry** (Gate 4) | `strict-docs.ts:460` |
| **`DESCRIPTIONS`** | **already present**, and it already describes the face's own design accurately | `module-manifest.ts:164-165` |
| **VRT** | 3 PNGs; 2 exemption deletions; the new card baseline joins the cable-stripe checked set | §10 |
| **e2e repair** | ⚠ **one P0 spec, substantially rewritten** (§8) | `launchpad-monitor-survives-card-collapse.spec.ts` |
| **shared-file conflict surface** | `strict-faces.ts`, `_shell-faces.ts`, `vrt-exemptions.ts` ×2, `face-migration-inventory.ts`, `contract-lock.txt`, `module-shell-model.ts` (precursor), plus the e2e — **eight** files | CLAUDE.md |

---

## 13. DEFECT LEDGER — live on `main`, independent of any face

**D1. ⚠⚠ `outToLaunch`'s lane tile paints another module's picture.** §0. The
placeholder tile mounts `VideoTileThumb` because `hasVideoSurface` is
`domain === 'video'`; the blit is a no-op because `surface.texture` is null; the
`drawImage` runs anyway and copies the shared engine drawing buffer. **This is
live now**, it is the only surface-less video def in the fleet, and the fix is
one line in a file outside every attest basis. ⚠ It also makes the module's
`hasVideoSurface` doc comment (`module-shell-model.ts:168-176`) false about the
one module it is false about.

**D2. The card re-types both param ranges** (`OutToLaunchCard.svelte:216`, `:224`)
while the def declares them (`out-to-launch.ts:105-106`). They agree today; no
gate compares them, because `card-range-source.test.ts` is opt-in and this card is
not enrolled. §2.1. **Fixed in the face PR** with `paramSpec` + enrolment.

**D3. The monitor binding does not survive a page load**, and nothing tells the
user. The registry is module-scope in-memory (`node-launchpad-monitor-registry.svelte.ts:325-327`)
and `bindMonitor` persists nothing (the e2e header says so, `:17-18`). Contrast
the sibling, which auto-restores from `localStorage`. §7. **Routed OUT of the
face PR** — it is a design decision with a multiplayer edge.

**D4. Two `EXEMPT_FROM_VRT` comment blocks in this file describe surfaces that
are unreachable without a gesture the suite never makes** — this module's
(`:441-450`) and the sibling's (`:667-686`). Both are drained by this wave;
recorded because the *shared* rationale in that block is the wave's thesis
(`../launchpadControlLeft/spec.md` §1.1).

**D5. `docs.explanation` describes a card UI the promoted module will not have** —
*"Bind a device **from the card** (Connect, then pick a Launchpad)"* and *"The
**on-card** 9x9 preview"* (`out-to-launch.ts:114`). Wave 6 found the identical
class on `archivist` and `peertube`. **Fixed in the face PR** (it is a `docs` edit,
so hash-transparent — §12); `DESCRIPTIONS` (`module-manifest.ts:165`) says
*"BIND from the card"* too and gets the same edit.

**D6. `module-docs-lint`'s FAMILY↔CARD leg is a GLOBAL substring check.**
`allCardSource()` (`:82-94`) walks all of `lib/ui/` and `join`s it into one
string, so a `testidPrefix` present in *any* `.svelte` — including a face body —
satisfies the leg for *any* def. `ModuleShell.svelte:838-842` compensates on the
other side but the gate itself cannot tell the two apart. Reported; no gate change
proposed (standing ruling).

---

## 14. ⚠ THE COHORT QUESTION — **NO SHARED SHAPE. ONE SHARED FUNCTION.**

The wave was commissioned on the premise that its seven members share one
device-binding shape, and **this pair is the strongest available test of it**:
the same physical Novation Launchpad Mini Mk3, the same `MIDIAccess`, the same
`$lib/control/launchpad/` layer, driven in opposite directions. If one shape
existed anywhere in the cohort, it would exist here.

### 14.1 THE DISCRIMINATOR, AND WHY IT IS NOT A JUDGEMENT CALL

Wave 6 found a one-line discriminator that partitioned its cohort correctly on the
first try (*"Is the thing the body needs to show and drive IN THE GRAPH?"*). The
one that partitions **this** pair is one level down and just as mechanical:

> **WHO OWNS THE DEVICE'S LIFETIME — a GRAPH NODE, or the MACHINE?**

* **`outToLaunch`: the NODE.** `node-launchpad-monitor-registry.svelte.ts` is
  keyed by node id, adopted per node, and released by `sweep(liveNodeIds)` from
  Canvas (`:76-88`). Its header states the rule it was built to enforce: *"a
  monitor claim … MUTATES the device, it is EXCLUSIVE, it accumulates diff state,
  and it is fed by a continuous 30 fps pump. That is a resource with a lifetime,
  and the lifetime is the NODE's."*
* **`launchpadControlLeft`: the MACHINE.** Its deployment, its view, both port
  ids and even the bound clip-player's node id live in `localStorage`
  (`launchpad-control.svelte.ts:683-684`, `:814`, `:900-901`), restored on mount
  by `restoreLaunchpadDeployment()` (`LaunchpadControlCard.svelte:51`). Delete the
  node and the binding is still there next session.

**Everything a faceplate touches follows from that one bit**, and it is why the
two specs share almost no design:

| | `launchpadControlLeft` | `outToLaunch` |
|---|---|---|
| device lifetime owner | the **machine** (`localStorage` ×4 keys) | the **node** (a swept registry) |
| survives reload | ✅ auto-restores | ❌ re-bind by hand |
| survives node delete | ⚠ **yes — a dangling node id** | ✅ swept, LEDs cleared |
| domain | `meta` | `video` |
| ports / params | 0 / **0** | 1 in, 0 out / **2, alive** |
| `NON_SHELL_LANE_TYPES` | **member** — promotion is a DELETION | not a member — promotion is ADDITIVE |
| lane today | no shell tile at all | a placeholder tile with a **borrowed picture** (§0) |
| lane after | 2 action cells, `glyph:'none'` | 2 knobs + 1 action, `glyph:'none'` **after a precursor** |
| body role | `status-primitive` | `picture` |
| SCREEN switch | ruling out of scope (`domain: meta`) | **required by gate** |
| `.data` writes | 0 → **0** | 0 → **1** |
| WebGL attest | zero, structurally (`lib/meta/**`) | zero, **only** because `face` is stripped from the hash |
| docs obligation | **unreachable** — no `docs` field on `MetaModuleDef` | `STRICT_DOCS`; a family costs a doc entry |
| `vrt-cable-stripe` | **needs an entry** (no `.stripe`) | needs none (pins `--cable-video`) |
| card e2e coverage | **zero** — nothing breaks, nothing verifies | a **P0** spec, and promotion breaks it |
| precursor needed | **no** | **yes** (§0.4) |

### 14.2 WHAT THEY GENUINELY SHARE — ONE FUNCTION, AND IT IS ALREADY BUILT

```ts
// launchpad-device.svelte.ts:558-560
export function isOutputClaimed(outputId: string, exceptToken?: string): boolean {
  return outputHeldByUnit(outputId) || outputHeldByOtherMonitor(outputId, exceptToken);
}
```

One arbiter, one owner per physical surface, spanning both consumers. Both
modules' pickers call it (`OutToLaunchCard.svelte:194`; the L/R units through
`outputHeldByUnit`). `DESCRIPTIONS` describes the resulting behaviour
(`module-manifest.ts:165`): *"out to launch on one Launchpad and LAUNCHPAD
CONTROL on another run simultaneously (one owner per physical device; same-device
sharing is refused via `isOutputClaimed`)."*

⚠ **And the tree already argues that this shared half must NOT be duplicated or
abstracted upward** (`node-launchpad-monitor-registry.svelte.ts:60-72`):

> *"The `monitors` map is already node-keyed and already module-scope, and it
> lives beside the L/R clip-launcher units because `isOutputClaimed` has to
> arbitrate across BOTH consumers — one device layer spanning many nodes.
> Duplicating the claim here would mean two maps that can disagree about who owns
> a surface, which is precisely the bug the exclusivity rule exists to prevent.
> So this registry owns the NODE-scoped half … and delegates the DEVICE-scoped
> half. **That division is the entire shape of the fix, because the claim was
> never the thing with the wrong lifetime — the CALLER was.**"*

**That last sentence is the cohort answer in one line.** The *device* layer
generalises, and it already did, three PRs ago. The *caller* is where every
module differs — and a faceplate is nothing but a caller.

### 14.3 THE ANSWER, STATED FOR THE ORCHESTRATOR

**The two modules do NOT share one device-binding shape**, and this pair is the
counter-case that would have found one if it existed: same device, same transport,
same library, same session. They share **one exported predicate**, and the code
that owns it says in writing why it must stay one function rather than become one
abstraction.

The wave-level finding (five transports, three domains, one member with no device
at all) is therefore **not** an artifact of picking dissimilar modules. It
survives the hardest similarity case in the cohort: **even two modules that bind
the same physical unit over the same API diverge on the very first structural
question a faceplate has to answer — who owns the device's lifetime.**

⚠ **The practical corollary, and it is the actionable one:** do **not** build a
shared `LaunchpadBinderBody.svelte`. Beyond the design argument,
`module-shell-import-guard.test.ts` denies the shared shell layer from referencing
module-owned directories, so a shared body would need a home outside the shell or
a declared BOUNDARY entry — paying a structural cost to unify two components that
share a `<button>` and nothing else.

---

## 15. VERDICT

> ## **PROMOTE-WITH-PRECURSOR.** MEDIUM risk. ≈ 4 h (PR A) + ≈ 10 h (PR B) / 2 PRs.

**The one-line reason:** the face itself is small and attest-transparent, but the
module's lane tile is painting another module's video today (§0) and promotion
would make that picture OUTRANK the two knobs — so the `hasVideoSurface` fix has
to land first, alone, where it is reviewable.

**PR A — the precursor. `lib/ui/workflow/module-shell-model.ts` only.**
One clause on `hasVideoSurface`, one optional field on `LaneGlyphDefLike`, and
the derived-membership assertion of §0.3 as its permanent negative control.
**Attest-ZERO. Touches no module.** It changes exactly one tile in the product —
`outToLaunch`'s placeholder — from a borrowed picture to no picture, which is the
correct rendering of a node that has none. ⚠ Its own VRT exposure is nil while
`outToLaunch` is still exempt, which is a reason to land it *before* the drain.

**PR B — the face.** Everything else:

1. `out-to-launch.ts` — `controlFamilies` ×1, `face`, `docs.controls['out-to-launch-connect-{n}']`,
   and the D5 `docs.explanation` edit. **All four are stripped from the attest
   hash** (§12) — verify with a local basis hash before and after rather than
   assuming;
2. `$lib/ui/modules/outToLaunch/shell-extension.ts` + `OutToLaunchMonitorBody.svelte`
   (**Canvas2D — never WebGL**, §12) + a pure status model + its unit test;
3. `shell-cells.ts` — one `action` cell with an `audition` probe;
4. `strict-faces.ts`, `_shell-faces.ts` (§10.3), `face-rack-status-source.test.ts` (§9),
   `face-migration-inventory.ts` (Gate 5);
5. `vrt-exemptions.ts` — two deletions;
6. `OutToLaunchCard.svelte` — `paramSpec` for both ranges + `RANGE_BOUND_CARDS`
   (D2);
7. **the rewritten `launchpad-monitor-survives-card-collapse.spec.ts`** (§8) —
   the highest-care item in this PR, because it is the guard on a P0 that reaches
   a performer's hardware. Flake-check `REPEAT=3`, and keep its 120 s
   bounded-failure cap and its frame-counted polls exactly as they are;
8. `task docs:accept` → `contract-lock.txt`.

**Build the SIBLING first.** `../launchpadControlLeft/spec.md` §15 gives the
reasons; the one that matters here is that this module's PR B is the only one of
the two that rewrites a P0 spec, and it should not also be the PR that discovers
the `vrt-cable-stripe` ordering constraint.
