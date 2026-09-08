# FACEPLATE BUILD SPEC — `gamepad` (audio, the game-controller CV/gate source)

> **SPEC + MOCKS. Nothing here is implemented.** Wave 7, cohort B (agent B).
> Mocks: `dock.html` (the dock faceplate, DISCONNECTED — the state the baseline
> captures) · `dock-remapping.html` (a connected pad with an armed remap and a
> calibration sweep in progress — the module's distinguishing state).
> Every claim carries `file:line` on `origin/main`, verified with
> `flox activate -- git show origin/main:<path>`.

---

## VERDICT — **PROMOTE. No precursor, no platform ask, and it is a strict IMPROVEMENT on every tier.**

`gamepad` is **NOT** in `NON_SHELL_LANE_TYPES`, so `laneRenderKind` returns `'placeholder'`
today (`legacy-fallback.ts:156-160`): the lane paints the **uniform rackline tile** — name,
type badge, a domain glyph and a jack rail — **with no ranked controls at all**, and the
real card opens only through the `⤢` more-affordance into the dock full view
(`ModuleShellPlaceholder.svelte:1-20`). Promotion replaces nothing a player uses; it
replaces a placeholder. **There is no tier to lose.**

The dock full view keeps every affordance (§3), the body is a `control-grid` (§7), the
`padIndex` param becomes a real segmented cell (§4), and the module is already in
`STRICT_DOCS` (`strict-docs.ts:229`) so its docs bar is met.

**Risk: MEDIUM-LOW.** Estimate **≈10-13 h**, dominated by the size of the port (a 1206-line
card) rather than by any unsolved question. Attest cost **zero** (§11).

---

## 0. WHAT `gamepad` ACTUALLY IS — 1330 lines of def characterised

The brief asked what is in a 62 KB def and a 45 KB card. Measured:

| region | lines | what it is |
|---|---|---|
| deadzone + trigger math | `:51-97`, `:275-289` | pure helpers (`applyDeadzone`, `triggerToCv`) |
| **stick CALIBRATION** | `:98-273` | the largest single region: `StickCalibration`, `CalibrationSweep`, `recordCalibrationSample`, `sweepIsUsable`, `finalizeCalibration`, `normalizeAxis`, `applyCalibration`. Per-axis observed min/max → full ±1, a captured TRUE rest centre, a radial deadzone and an outer saturation. Prior art cited in place (SDL/evdev, DS4Windows) at `:70-90`. |
| **REMAP** | `:290-620` | `PhysicalControl`, `detectChangedControl` (the armed-listener primitive — *"the Gamepad API has no events, so an armed listener must poll"*), `DEFAULT_GAMEPAD_BINDINGS`, `bindingForOutput`, `readControlValue`, `setBinding`, `applyBindingToData` |
| `GamepadSnapshot` | `:621-664` | the per-poll publication the card reads through `engine.read(node,'snapshot')` |
| INVERT | `:665-713` | four per-axis sign flips |
| `GamepadData` | `:715-753` | the whole synced shape: two calibrations, `bindings`, `invert` |
| **SAVE / LOAD MAPPING** | `:755-905` | `exportMapping` / `isGamepadMapping` / `applyMapping`, all with an explicit in-place Y.Doc discipline |
| **PRESETS** | `:907-948` | `GAMEPAD_PRESETS` — today exactly one, `NXT Gladiator`, *"the owner's calibrated mapping … captured via 'Save mapping' on a real device"* |
| **the def** | `:950-1000` | 0 inputs, **18 outputs**, **1 param**, a complete `docs` block |
| the factory | `:1001-1327` | 18 `ConstantSourceNode`s + the rAF poll |

**So the answer to "is any of it params?" is: ONE.** `padIndex` — *"discrete 0..3, default 0:
gamepad slot picker"* (`:983`). Everything else the player configures is `node.data`
(§8). `contract-lock.txt:1259-1278` is 20 lines: the meta row, 18 output rows, and
`gamepad param padIndex 0..3 discrete default=0`.

### 0.1 ⚠ CORRECTION — the inventory's `why` overstates on two counts

`face-migration-inventory.ts:814-821` reads:

> *"a GAMEPAD MAPPER: **a live device roster**, a per-button/axis mapping table with
> importable mapping files, and live input echo. The table is the interaction and **none of
> it is a param**."*

Both bolded clauses are wrong, and one of them changes the face:

* **There is no ROSTER.** The card shows `snapshot.id` — the OS name of the pad in the
  *currently selected slot only* (`GamepadCard.svelte:437-441`) — plus four blind `SLOT`
  buttons labelled `0 1 2 3` (`:757-765`). Nothing anywhere enumerates *which* pads are in
  *which* slots. A user with two controllers picks a slot and reads the header to find out
  what they got. **That is a NUMBERED SLOT SELECTOR, not a device picker**, and it is the
  single most consequential difference between this module and `midiclock` / `cameraInput`
  / `chromaconsole` (§2.2).
* **`padIndex` IS a param** (`gamepad.ts:981-984`), it is the face's rank-1 cell, and it is
  the reason this module's face is not the zero-param case matrixMix and `electraControl`
  are.

*(The `why`'s other three clauses — mapping table, importable mapping files, live input
echo — are all exactly right.)*

### 0.2 THE COHORT ANSWER: `gamepad` HAS A DEVICE, AND ITS LIFECYCLE IS UNLIKE EVERY SIBLING'S

**There is nothing to connect.** The Gamepad API has:

* **no permission prompt** — no `requestMIDIAccess`, no `getUserMedia`, no `requestDevice`;
* **no events the module uses** — *"the Gamepad API has no events, so an armed listener must
  poll"* (`gamepad.ts:322-324`), and the factory's own note declines to listen for
  `gamepadconnected` because *"the rAF poll will pick it up the next frame"* (`:1290-1293`);
* **a GESTURE GATE instead of a grant** — *"the Gamepad API only exposes a controller AFTER
  the user has pressed a button on it (a 'gesture' gate to prevent fingerprinting)"*
  (`:12-17`). **Pressing a button on the pad is the whole protocol.** There is no in-page
  affordance that can cause it, which is why the card's copy is an instruction rather than
  a button.

**So there is no connect gesture to design, and the STATUS that remains is a single
boolean**: did the last poll see a pad. That is exactly `StatusLed`'s shape (§5 row 1) and
needs no invention.

### 0.3 ⚠ THE POLL SURVIVES CARD UNMOUNT — the named hazard does NOT apply here

The fleet hazard is *"card unmount kills node resources — COLLAPSE/LRU destroys
node-lifetime state (#1531/#1574/#1583), and the fix shape is a NODE-keyed registry."*
**`gamepad` already has the right shape and did not have to be given it**, because there
are **TWO** rAF polls and only one of them is on the card:

| poll | lives in | lifetime | what it does |
|---|---|---|---|
| **the ENGINE poll** | `gamepadDef.factory` (`gamepad.ts:1268-1288`), torn down in `dispose()` (`:1318-1327`) | **the NODE's** | reads `navigator.getGamepads()`, applies remap → calibration → invert, and writes all 18 `ConstantSourceNode.offset`s |
| the CARD poll | `GamepadCard.svelte:218-256` | the CARD's mount | `engine.read(node,'snapshot')` for the dots, bars and LEDs, plus the armed-remap diff |

**The audio never depends on the card.** Collapse the card and the sticks keep driving
every patched output. **So no registry is needed and none should be built** — wave 6's
discriminator answers it in one line: *"Is the thing the body needs to show and drive IN THE
GRAPH? YES → the body reads it directly. No registry."* Here the state is in `node.params`
and `node.data` (both Y.Doc) plus a snapshot the ENGINE NODE owns, so a
`camera-status-registry`-shaped copy would introduce **a second owner of state the engine
already owns** — a defect, not an abstraction.

⚠ **One real consequence, and it is a property of rAF, not of this module.** Both polls are
`requestAnimationFrame`, which the browser suspends on a backgrounded tab. The factory says
so and calls it correct — *"no point burning CPU updating gamepad state nobody can see. The
Audio worklet continues to receive the last-pushed values"* (`:1263-1267`). **So a
backgrounded tab freezes every gamepad output at its last value**, including a held trigger.
That is a design decision already made and documented; the face does not change it and must
not silently "fix" it.

---

## 1. THE CONSTRAINT MAP

| registry / gate | member? | what it means here |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NO** | **See §6's boxed line.** `'placeholder'` today; promotion gives it a real tile. |
| `DOCKABLE_TYPES` (`dockable.ts:24-59`) | **NO** | so it gets no persistent dock ENTRY, only the transient full view the placeholder's `⤢` opens. ⚠ Not a blocker and **not something this PR should change** — that allowlist is a separate owner-audited rollout (`:5-9`). |
| `STRICT_FACES` | **NO** — nothing structural in the way | `domain: 'audio'`, so `AudioModuleDef.face` has always existed. |
| `STRICT_DOCS` (`strict-docs.ts:229`) | **YES** | `docs.explanation` + all 18 `docs.outputs` + `docs.controls.padIndex` are authored (`gamepad.ts:987-999`). ✅ nothing to add for the param; §10.4 covers the families. |
| `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:868`) | **YES** | *"card content driven by live `navigator.getGamepads()` poll; defeats deterministic capture"*. §6.3 measures it. |
| `ALLOWED_PERMANENT_EXEMPT` (`vrt-exemptions.ts:1226`) | **YES** | anchored both directions by `vrt-meta.test.ts` — a one-sided delete is RED. |
| `PUSH_CARD_CONTROLS` | **NO explicit entry** | ⚠ **and that is the standing hazard, live.** A push card is resolved from the LIVE def, so *"adding or renaming a param on any module can silently change that module's push card"*. §4 adds an `options` roster to `padIndex` — see §11 for why that is safe here and what would make it unsafe. |
| WebGL attest basis | **NO — VERIFIED MECHANICALLY** | `resolveWebglBasis()` (`webgl-attest-lib.ts:256-304`) admits `lib/ui/modules/**.svelte` only where `sourceCreatesWebglContext` holds; `GamepadCard.svelte` creates no context, and `gamepad.ts` is not in `AUDIO_WEBGL_MODULE_DEFS` (`:67-70`, which is `cube` and `wavesculpt`). ⚠ **Conditional on the body staying DOM** — the sticks and bars are `<div>`s today and must remain so (§7.2). |
| `module-manifest.ts` `DESCRIPTIONS:376-377` | **YES**, a long one | ⚠ stale on one point — §13.4. |
| `contract-lock.txt:1259-1278` | 20 lines | §4's `options` roster **moves one of them**. |
| `face-migration-inventory.ts:813-821` | `bespoke-surface`, **no `blockers` array** | ⚠ unlike `controlSurface`/`electraControl`/`archivist`, this module declares NO migration blocker. Nothing is waiting on a capability. |

---

## 2. WHAT THE MODULE IS FOR

A connected USB or Bluetooth controller turned into **eighteen CV and gate outputs** —
`lx ly rx ry` (bipolar ±1, Y flipped so up is +1, 0.08 deadzone), `lt rt` (unipolar 0..1),
and twelve gates: `lb rb a b x y du dd dl dr start back`
(`gamepad.ts:961-980`). *"You play the rack with a gamepad: stick axes sweep filters or pan
a scene, triggers ride a VCA, face buttons fire drum strikes"* (`:989`).

**But that is the module's OUTPUT, not its interaction.** The interaction is **making a
non-standard controller behave like a standard one**, and it has three layers, each of which
exists because a real device failed the layer below:

1. **REMAP** — *"the `a` output can be driven by the user's physical X button, or the `lx`
   output by the right-stick X axis"* (`:434-447`). Arm by right-clicking a button LED or
   pressing `Remap X`/`Remap Y`; the next control you move past a 0.5 threshold binds
   (`detectChangedControl`, `:332-372`). The shipped `NXT Gladiator` preset needs **ten**
   remaps, including buttons at indices 19, 21, 23 and 25 (`:914-948`).
2. **CALIBRATE** — sweep a stick; observed min/max become full ±1, with a captured true rest
   centre so *"a stick that physically RESTS off-centre reads 0"* (`:114-122`).
3. **INVERT** — four sign flips, composing on top of both (`:685-696`).

**The verb is TEACH THE RACK WHAT THIS STICK IS.** Everything on the surface serves that,
and it is a one-time-per-device job whose result is then saved to a `.json` and shared.

### 2.1 What the LIVE ECHO is for, and why it is not decoration

Every affordance above is **blind without feedback**: you cannot tell whether the remap took
the axis you meant, or whether your sweep reached the corners, from anything but watching the
device. The stick pads, the trigger bars and the twelve LEDs are that feedback. The card's
own header states the boundary: they are *"purely informational, NOT a control surface
(dragging the dot does nothing; the gamepad's own sticks are the source of truth)"*
(`GamepadCard.svelte:14-18`). **The echo is a picture of the cell's own state, not a preview
of something elsewhere** — which is exactly why the body's role is `control-grid` and not
`picture` (§7.1).

### 2.2 ⚠ THE COHORT DISCRIMINATOR — a POLL WITH NO GRANT is a third lifecycle

Set against wave 5's binders (`midiCvBuddy` / `midiOutBuddy` / `chromaconsole`) and
`midiclock`:

| | the binders + `midiclock` | `cameraInput` / `loopback` | **`gamepad`** |
|---|---|---|---|
| grant | `requestMIDIAccess()`, once per origin | `getUserMedia()`, per device | **none — a button press on the hardware** |
| roster | a live device list from the grant | `enumerateDevices()` | **none — four numbered slots** |
| picker | a `<select>` of NAMES → `fullViewBody` (the cameraInput precedent) | same | **a segmented cell over a REAL PARAM** — §4 |
| events | `onmidimessage` | `MediaStreamTrack` events | **none. Polled.** (`gamepad.ts:322-324`) |
| lifetime owner | the engine node | a NODE-keyed registry (`camera-status-registry`) | **the engine node, already** (§0.3) |
| status | connected / grant-refused / device-lost | granted / denied / lost | **one boolean: did the last poll see a pad** |

**So `gamepad` needs the LEAST platform of any module in the cohort**, and it is the only
one whose device selector is expressible as an ordinary `ParamDef` — because its "roster" is
a fixed set of four integers known when the def was authored, which is precisely the
condition `legacy-fallback.ts:78-84` says a runtime roster fails: *"a roster is a fixed set
known when the def is authored, and this one differs per machine."* **`padIndex`'s does
not.** That single sentence is the whole reason this module's picker is a cell and every
sibling's is a body.

---

## 3. STOP 1 / STOP 2 — the affordance census

```sh
flox activate -- git grep -nE '<button|<select|<input|oncontextmenu|onkeydown|accept=' \
  origin/main -- packages/web/src/lib/ui/modules/GamepadCard.svelte
```

**STOP 1: NOT a parity loss.** The lane holds a placeholder today (no controls at all), so
every row below is a gain or a hold. Nothing becomes unreachable.

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle defaultLabel="GAMEPAD" inline>` | `:435` | ✅ shell title bar |
| 2 | connection status line | `:437-443` | ⛔ text — §5 row 1 → `StatusLed` |
| 3 | `PatchPanel` with all 18 outputs | `:445`, `:405-412` | ✅ the shell's own jack rail |
| 4 | two **stick pads** with crosshair + live dot | `:460-467`, `:529-536` | ✅ body |
| 5 | **`Remap X` / `Remap Y`** ×2 sticks (arm `only:'axis'`; right-click clears) | `:472-495`, `:539-562` | ✅ body |
| 6 | **INVERT** `x`/`y` toggles ×2 sticks, `aria-pressed` | `:497-518`, `:564-585` | ✅ body |
| 7 | **`set center`** ×2 | `:520-528`, `:587-596` | ✅ body |
| 8 | **`calibrate left/right stick`** ×2 + `calibrated` badge ×2 + clear ✕ ×2 | `:606-645` | ✅ body; badges → `StatusLed` (§5 row 2) |
| 9 | calibration MODE: hint, live min/max, `complete` (gated), `cancel` | `:647-668` | ✅ body — ⚠ §5 rows 3-4 change what it paints |
| 10 | **`save mapping`** → JSON download | `:674-681`, `:326-344` | ✅ body |
| 11 | **`load mapping…`** `<input type="file" accept=".json">` | `:682-690` | ✅ body — precedented: `picturebox`'s `fullViewBody` already carries file inputs (`PictureboxAssetsBody.svelte:269,291`) |
| 12 | **`load preset…`** `<select>` | `:691-699` | ✅ body — its option text is `NXT Gladiator`, an option NAME inside the control that selects it (permitted) |
| 13 | mapping status flash | `:700-702` | ⛔ text — §5 row 5 |
| 14 | **trigger rows** LT/RT: right-click arms, alt-click clears, live 0..1 bar | `:706-733` | ✅ body |
| 15 | **12 button LEDs**: right-click arms, alt-click clears, `class:on` from the live value, `●` remap mark | `:737-753` | ✅ body |
| 16 | the armed-remap **banner** | `:450-459` | ⛔ text — §5 row 7 |
| 17 | **SLOT `0 1 2 3`** | `:755-766`, `:389-397` | ⬆ **PROMOTED TO A RANKED CELL** — §4 |
| 18 | `Escape` cancels an armed remap (`window` keydown) | `:249-260` | ✅ moves with the body — ⚠ and its teardown must too (`:252-258` removes the listener and clears both timers) |

**Nothing in this table has no home.** The only rows that change are the six text rows, and
§5 says where each finding goes.

---

## 4. THE FACE

```ts
// packages/web/src/lib/audio/modules/gamepad.ts
params: [
  {
    id: 'padIndex', label: 'Slot', defaultValue: 0, min: 0, max: 3, curve: 'discrete',
    // ── NEW: the exhaustive roster. See the spec's §4 for why.
    options: [
      { value: 0, label: '0' }, { value: 1, label: '1' },
      { value: 2, label: '2' }, { value: 3, label: '3' },
    ],
    optionsExhaustive: true,
  },
],
face: {
  glyph: 'none',
  order: ['padIndex'],
  extension: 'gamepad',
},
```

**`order` is ONE key and nothing is padded.** One band against `DOCK_TAB_MIN_BANDS = 7`
(`module-faceplates.md:150`), so **no tab rail**, and `face.tabbed` is owner-instruction
only. Everything in §3 rows 4-16 is the body: none of it is a param, and a `<familyId>-{n}`
template resolves to **ONE ranked cell** regardless of how many members the family has
(matrixMix's one-member families at `shell-cells.ts:2036-2049` are the shipped shape) — so
declaring `gamepad-led-{n}` would put a single cell in the lane standing for twelve LEDs,
which says nothing a player can act on. **The family key rule (#2181, "one cell for all
instances") is therefore not a constraint this face has to route around; it is the reason
the LED bank belongs in the body and not in `order`.**

**`glyph: 'none'` is the only literal that compiles into a green run.** `laneGlyphFor`
returns `'picture'` only for `domain === 'video'`, and every live glyph resolves through
`primaryAudioOutPortId`, which is `outputs.find(o => o.type === 'audio')?.id`
(`mandelbulb-glyph-tap.test.ts:32`). **`gamepad` has eighteen outputs and not one of them is
`type: 'audio'`** — six `cv`, twelve `gate` (`gamepad.ts:961-980`) — so a `scope` / `meter`
/ `waveform` glyph resolves to `{kind:'static'}`, which `module-face-lint` reddens as a dead
glyph. Same derivation matrixMix (`meta/modules/matrixmix.ts:92-97`) and `midiclock`
(`_shell-faces.ts:3396-3399`) record.

### 4.1 ⚠ WHY `padIndex` MUST GAIN AN `options` ROSTER — and the SNAP contract that comes with it

The skill's STOP 1 names this trap by measurement: *"A `2..3 discrete` param rendered as a
knob has two reachable positions across the dial's whole travel, so a drag quantises back to
where it started and the control is **inert** — `faces-parity` caught exactly this on
`moog962`"* (`module-faceplates.md:79-88`). `padIndex` is `0..3 discrete`: **four** reachable
positions across a full dial, which is better than `moog962`'s two and is still a dial where
every drag lands on a quantisation boundary. The prescription is stated in the same
paragraph: *"Give a few-state discrete param an `options` roster so `paramCellKind` derives a
segmented cell."*

The labels are **the states' own values**, `0` `1` `2` `3`, which is the skill's rule
verbatim — *"the states' own values where they are literally quantities; never fabricate
semantics"*. ⚠ **Do NOT invent device names here.** The Web Gamepad spec allows up to four
pads and the slots are literally indices (`gamepad.ts:1080-1084` clamps to `[0,3]`); the
card's four blind buttons already print exactly these four glyphs (`:757-765`).

**The roster is EXHAUSTIVE and therefore triggers the SNAP contract.** `param-vocabulary.test.ts`
requires a param declaring an exhaustive roster to **SNAP at point of use**, not
validate-and-reject, because `paramCellKind` returns `'knob'` OFF-DOCK so a lane drag can
genuinely land between options. ⚠ *"One that declares it and does NOT snap is worse than one
that never declared it"* — **use `snapToOptions` from
`$lib/ui/controls/knob-vocabulary-model` and never hand-roll a second implementation.**

⚠ **This is a CONTRACT CHANGE.** `contract-lock.txt:1278` currently reads
`gamepad param padIndex 0..3 discrete default=0` and will gain the roster. Run
`flox activate -- task docs:accept`, review the diff, and **land it in the SAME PR as the
face** — splitting them leaves a face that cannot pass `module-face-lint` for the duration
of the split (the `videobox` precedent, wave 6 §7).

⚠ **And it re-ranks the PUSH 2 CARD.** `gamepad` has no explicit `PUSH_CARD_CONTROLS` entry,
so its push card is resolved from the LIVE def and the tiers re-rank themselves whenever a
param changes. **Here the change is safe by inspection because there is exactly one param and
its rank cannot move** — a roster changes how it renders, not that it is rank 1 of 1. ⚠ Say
so in the PR body; the general rule (*"if a module's card matters, give it an explicit
entry"*) still applies to the next person who adds a second param.

---

## 5. RESTING TEXT — the census

Permitted resting text, exhaustively: module NAME, TAB/SECTION labels, CONTROL CAPTIONS, and
option/landmark NAMES that disambiguate a control's own position.

| # | painted today | site | verdict | what carries the finding after |
|---|---|---|---|---|
| 1 | `snapshot.id` truncated to 24 chars, or `press any button to connect` | `:437-443` | ⛔ **REMOVED.** The settled discriminator: a device name painted OUTSIDE every control, restating what is bound, is a readout. And the string CHANGES with state, the shape `StatusLed` was built to make inexpressible. | **`StatusLed`** — caption `PAD` (static by contract), `lit={snapshot.connected}`, `detail={snapshot.id \|\| 'no controller — press any button on it'}` → `aria-label`/`title`, never a text node. ⚠ The **instruction** half survives as an EMPTY-STATE hint beside the dark lamp, `midiclock`'s shipped precedent by name (`MidiclockDeviceBody.svelte:22-25`). |
| 2 | `calibrated` badge ×2 | `:625`, `:640` | ⛔ **REMOVED as text.** A state word about the module. | **`StatusLed`** ×2 — captions `CAL L` / `CAL R`, `lit` from `snapshot.calibrated` / `.rightCalibrated`. The ✕ clear button stays beside it. |
| 3 | the live sweep range, `x [-0.98, 0.97] · y [-1.00, 0.86]` | `:652-655` | ⛔ **REMOVED.** Four live measurements at rest — the sharpest violation on the module. | ⚠ **See §5.1. It is REPLACED BY A BETTER, NON-TEXT MARK, and the affordance improves.** |
| 4 | `sweep the {calibrating} stick through its full range…` | `:651` | ⛔ **REMOVED.** A sentence, and DERIVED (`{calibrating}`). | the ARMED stick pad's own visual state (a pulsing border, the way `.remap-dot` already works) + `aria-label` on that pad + `docs.controls['gamepad-calibrate-{n}']`, reachable by right-click Annotate. |
| 5 | `mappingStatus` — `mapping saved` / `loaded X.json` / `ignored: invalid JSON` / `save failed: …` | `:700-702`, `:317-321` | ⛔ **REMOVED as text**, and §5.2 explains why the "it's transient" argument is refused rather than used. | **`StatusLed`** — caption `MAPPING`, `tone: 'accent'` for success and `'warn'` for a rejected file (colour, not text — the primitive's stated design), `detail` = the full message → `aria-label`. |
| 6 | `title=` hover strings on every remappable control (`L-X ← axis 3 (right-click to reset)`) | `:479`, `:551`, `:723`, `:747` | ⛔ **REMOVED as hover strings** — *"there but hidden"* is refused by name. | the SAME sentence on `aria-label`, permanently, on the same element. **No information is lost; it stops being mouse-only.** |
| 7 | the armed banner, `listening… move an axis to bind **L-X** (Esc to cancel)` | `:450-459` | ⛔ **text REMOVED, the DOT KEPT.** | `.remap-dot` (`:453`) is already the non-text half — wave 5 §2.1's activity-dot principle verbatim. The armed CELL already carries `class:armed`, so *which* control is listening is on screen without a word. `aria-label` on the armed cell carries the sentence; `role="status"` moves onto that cell. |
| 8 | `●` remap mark on a rebound control | `:726`, `:751` | ✅ **KEEP** — a non-text mark whose whole content is a shape. |
| 9 | the twelve LED captions `LB RB A B X Y ⬆ ⬇ ⬅ ⮕ STA SEL` | `:418-423`, `:752` | ✅ **KEEP** — CONTROL CAPTIONS, and `tidyVco`'s `A`/`D`/`S`/`R` argument at three times the scale: they are the ONLY thing separating twelve identical tiles. ⚠ They are also read from `GAMEPAD_OUTPUTS` so *"a future label edit in the engine def auto-propagates"* (`:412-417`) — keep that, it is the one-source rule applied to captions. |
| 10 | `LT` / `RT`, `L` / `R`, `inv`, `SLOT` | `:723`, `:468`, `:499`, `:756` | ✅ **KEEP** — control captions and section labels. |
| 11 | `save mapping` / `load mapping…` / `load preset…` / `calibrate left stick` / `set center` / `complete calibration` / `cancel` | various | ✅ **KEEP** — control captions on real buttons. |
| 12 | the `load preset…` option `NXT Gladiator` | `:696-698` | ✅ **KEEP** — an option NAME inside the control that selects it. The settled discriminator, applied. |
| 13 | `SLOT` `0 1 2 3` | `:757-765` | ✅ **KEEP, and PROMOTED** — these become the segmented cell's own option labels (§4.1), i.e. option names inside the control that selects them, at the strongest possible position. |

### 5.1 ⚠ ROW 3 — DELETING THE READOUT DELETES A FINDING, AND HERE THE REPLACEMENT IS BETTER

CLAUDE.md: *"When you remove one, say WHICH finding lost its surface and where it goes."*

**The finding: "have I swept far enough?"** Half of it never needed the number — the
`complete calibration` button is `disabled={!canComplete}` (`:661`), driven by
`sweepIsUsable(sweep)`, which requires a span ≥ 0.2 on **both** axes and a real sample count
(`gamepad.ts:166-178`). **So "am I there yet" is already answered by a control's enabled
state**, on a non-text channel, today.

What the number adds is *how close*, and **that has a strictly better non-text form on a
surface this module already draws**: paint the sweep's extent as a **rectangle inside the
stick pad**, positioned from `sweep.minX/maxX/minY/maxY` through the same `dotX`/`dotY`
mapping the live dot uses (`GamepadCard.svelte:426-431`). The box grows as you sweep; when it
reaches the pad's edges you are done. It is one absolutely-positioned `<div>` with a border,
in the element that already contains a crosshair drawn the same way (`:461-462`).

**That is a picture of the exact quantity the four numbers reported, in the coordinate system
the user is already looking at, and it does not require reading.** The numbers themselves go
to `aria-valuetext` on the pad, so nothing is unassertable.

⚠ **It must stay a `<div>`, not a `<canvas>`** — §7.2.

### 5.2 ⚠ ROW 5 — THE "IT'S TRANSIENT, SO THE RULING DOESN'T REACH IT" ARGUMENT IS AVAILABLE AND IS REFUSED

`mappingStatus` self-clears after 4 s (`:320`). The ruling is about text **at rest**, and
`chromaconsole`'s open-loop sentence was refused specifically for being *"permanent, not a
transient toast"* (wave 5 §2.3). So there is a real, non-silly argument that a 4-second toast
after an explicit user action is outside the rule, and that the dock baseline — which
captures the rest state — would never see it.

**It is refused anyway, and the reason is the ruling's own history rather than its wording.**
A rule whose strength is that *"it has never granted one"* (wave 5 §2.3's route (c)) is
weakened most by the most reasonable exception, and "transient" is an unbounded category:
every readout on every card can be re-timed into one. ⚠ And there is no cost to refusing
here, which is what makes the refusal cheap rather than principled-at-the-user's-expense:
`StatusLed` carries the **whole message** in `detail`, distinguishes SUCCESS from REJECTED in
`tone` (colour, the primitive's stated design), and is **more** persistent than the toast —
a user who looked away for five seconds currently misses `ignored: invalid JSON` entirely.

**So the load-failure report gets better, not worse.** That is the honest reason to take this
route, and it should be stated that way in the PR rather than as an appeal to the rule.

### 5.3 ⚠ THE `aria-label` HAZARD — THIS BODY IS WHERE THE LEG BITES

`face-rack-status-source.test.ts:826-860` — *"A CONTROL GRID'S SENTENCE IS SPEAKABLE, NOT
PAINTED"* — refuses any `aria-label={EXPR}` whose **same expression** is also rendered as a
bare text node.

**Rows 9 and 10 mean this body paints `{btn.label}` on twelve tiles.** So the naive port —
`aria-label={btn.label}` beside `>{btn.label}<` — is **exactly the offence the leg was
written for**, and it would be caught. The design:

```svelte
<button class="btn-led" aria-label={ledSentence(btn, bindings)}>{btn.label}…</button>
```

with `ledSentence` returning e.g. `A — gate output, driven by button 0. Right-click to
rebind, alt-click to reset.` — which is row 6's hover string plus row 8's mark, made
speakable and permanent.

⚠ **What the gate can and cannot see, stated rather than implied.** Its predicate is
expression IDENTITY, so `aria-label={btn.label}` is caught and `aria-label={btn.label + ' —
gate'}` is not. The compliance argument rests on the sentence genuinely differing in content;
the only things that can see that are the dock PNG and a human. §10.5's bespoke test adds a
disjointness leg with a two-direction negative control so this module at least checks itself.

---

## 6. WIDTH

> ⚠ **WHICH SIDE OF THE SPLIT, STATED BEFORE THE WIDTH ARGUMENT.** `gamepad` is **NOT** in
> `NON_SHELL_LANE_TYPES`, so `hasCard` is true, `migrated` is false, and `laneRenderKind`
> returns **`'placeholder'`** (`legacy-fallback.ts:156-160`): a uniform rackline tile with
> **no ranked controls**, whose `⤢` opens the real card in the dock full view
> (`ModuleShellPlaceholder.svelte:1-20`). **So this module DOES get a shell lane tile after
> promotion, and the section-heading-versus-caption tradeoff IS live for it** — unlike
> `controlSurface`, which has no lane tile at all and for which `face.bareCells` is
> therefore meaningless. Here `bareCells` is a real (and declined) option: see §6.2.

### 6.1 The dock measurement — **WIDTH IS NOT EARNED. NO `FACE_WIDTH_EXEMPTIONS` ENTRY.**

The instrument: `workflow-shell-faces.spec.ts` measures `bodyW - contentW` against
`FACE_WIDTH_SLACK_MAX_PX = 40` (`:224`, `:440-453`). `PLATE_FLOOR_EXEMPTIONS` in
`face-width-source.test.ts:88` is **`[]`**, and `FACE_WIDTH_EXEMPTIONS`
(`workflow-shell-faces.spec.ts:264`) holds exactly one entry (`moog912`).

Measured off the card's own CSS — every number is a literal in the source:

| element | width | source |
|---|---|---|
| the card's floor | `min-width: 280px` | `GamepadCard.svelte:780` |
| one stick pad | `64 × 64` | `:833` (`.stick-pad`), `PAD_PX = 64` at `:425` |
| the two stick blocks | `2 × 64 + gap 14` = **142 px** | `:829-832` (`.sticks { gap: 14px }`) |
| the LED grid | `repeat(6, 1fr)` — **6 columns × 12 tiles = 2 rows** | `:1034` |
| the trigger label | `22 px` + a flexed bar | `:1006`, `:1029` |
| the body's own padding | `0 10px` | `:917-923` |

**The widest thing on the surface is the LED grid at 6 columns**, and a 6-column grid of
~30 px tiles with gaps is ≈ 220 px. **Everything fits inside the card's existing 280 px
floor**, which means this is a genuinely COMPACT surface and always was. ⚠ **The floor must
not come across** — the face body sizes to its content, and the `.faceplate-body` is
`max-content` clamped to the pane by `_dock-faceplate.css` (`face-width-source.test.ts:111-123`).

**A live picture IS a legitimate earner** (wave 6 §4.2) and this body has three (two pads,
two bars). **It still does not need an exemption**, because they are small: the pads are
64 px and the bars are flexed. **Width is not earned here and none is requested** — which is
the correct outcome of *"compact is the default"*, not a concession.

### 6.2 `face.bareCells` — available, and DECLINED

`bareCells` drops a per-control caption when a SECTION HEADING already conveys it, dock-only
(`graph/types.ts:1011`). The candidates are rows 9-10's captions. **Declined, and the
mixmstrs/tidyVco discriminator is why:** the twelve LED captions are the tidyVco case, not the
mixmstrs case — there is no heading that says "this one is A and that one is B", and dropping
them leaves twelve identical tiles. The `inv` label over two toggles labelled `x` and `y` is
the closest thing to a mixmstrs case on the surface, and it is **two characters**, so
removing it buys nothing and costs the pair's only disambiguation at the lane tiers that
render no heading. **`mixmstrs` remains the only face declaring `bareCells`, and this face
does not join it.**

### 6.3 ⚠⚠ **THE DRAIN LINE** — what makes `gamepad` drainable from `ALLOWED_PERMANENT_EXEMPT`

> **`gamepad` IS DRAINABLE, and the device-INDEPENDENT part is the WHOLE DISCONNECTED
> SURFACE — which on CI is the only surface there is.** The exemption (`:868`) says the
> content is *"driven by live `navigator.getGamepads() `poll; defeats deterministic
> capture"*. **The poll is live; its OUTPUT on a CI runner is not.** With no controller
> attached, `navigator.getGamepads()` returns no populated pad, the factory takes its
> `if (!pad)` branch (`gamepad.ts:1088-1108`), and `snapshot.connected` stays `false`
> forever — so every pixel is a function of the code: the dark `PAD` lamp with its
> instruction, both dots pinned at pad centre (`dotX(0) = dotY(0) = 32`), both trigger
> fills at `width: 0%`, all twelve LEDs unlit, no `●` marks, both `calibrate` buttons in
> their off state, no armed banner, no mapping lamp, and `SLOT 0` selected. **Nothing
> animates and nothing can, because reaching the connected state requires a physical
> button press this suite does not perform.**

**That is `midiclock`'s discharge argument, structurally identical.** `_shell-faces.ts:3350-3372`:
*"A freshly spawned midiclock has NO MIDI ACCESS … So the device roster is not merely empty,
it does not exist … ⚠ AND THE UNREACHABILITY IS STRUCTURAL, NOT INCIDENTAL. On a runner with
no MIDI devices and no prior grant, the connected state is not just unlikely — there is no
path to it without a click. That is what makes this a discharge rather than a bet."*
**Substitute "no controller and no button press" and the paragraph is unchanged.**

⚠ **What the baseline does NOT cover, stated rather than implied:** the CONNECTED surface —
every dot position, every lit LED, every `●`. `e2e/tests/gamepad.spec.ts` already
monkey-patches `navigator.getGamepads()` with a deterministic fake (`:41-70`), so a mocked
baseline is *reachable*, but installing that mock in the VRT harness is a change to the
harness rather than to this module. **Not this PR** — exactly the boundary `midiclock` drew
for its post-connect picker (`_shell-faces.ts:3374-3381`). Behaviour is covered by
`gamepad.spec.ts`'s eighteen tests; §13.3 is what must happen to them.

**No `FACES_WITHOUT_SCENES` entry is warranted.** "Permanent" on this list means UNDRAINED —
`midiclock` was drained on 2026-08-24 (`vrt-exemptions.ts:1217-1222`) and `matrixMix` before
it (`:1209-1212`), and the set's own header says it *"only ever SHRINKS BY NAME"*.

---

## 7. THE BODY

### 7.1 Role: **`control-grid`** — and this body is the role's second adopter and first hard case

Verified against the live predicate (`face-rack-status-source.test.ts:598-606`):

```
'control-grid': holds: (src, extId) => /aria-label=/.test(src) && !paintsCanvas(src, extId)
```

`aria-label` is set on every LED, every remap button, every invert toggle and both stick pads
(§5.3) ✅, and the body mounts no `<canvas>` ✅.

**Why `control-grid` and not `picture`, argued rather than asserted.** The `picture`
predicate is *mounts a `<canvas>`*, and this body does not — so `picture` is mechanically
refused, which is the right answer for the right reason. The prose test is the role's own:
matrixMix's entry says a control grid is *"the surface the module is OPERATED from … not a
preview of something happening elsewhere"*. **The twelve LEDs ARE the remap surface** —
right-click one and the next physical press binds that output (`GamepadCard.svelte:742-745`)
— and their lit state is **the cell's own state**, precisely as a matrixMix dot is the cell's
own state. The stick pads are the same: `Remap X`/`Remap Y` and `set center` are attached to
the pad and operate on it.

⚠ **THE EXTENSION OF THE ROLE, NAMED so nobody has to find it later.** matrixMix's cells
reflect **graph state** (`patch.edges`); these reflect **live device state** read through
`engine.read(node,'snapshot')` at rAF. **The predicate holds either way and the prose survives
the substitution**, but this is the first `control-grid` whose cells are driven by something
outside the document, and that is worth one sentence in the `why` rather than being
discovered by the third adopter.

⚠ **AND IT IS THE FIRST BODY TO SATISFY TWO PREDICATES.** §5 puts four `StatusLed`s in this
body, so `/StatusLed/.test(src) && !paintsCanvas(...)` — the `status-primitive` predicate —
**also holds**. That is **legal and green**: the gate checks `ROLE_PREDICATE[rule.role].holds`
for the DECLARED role only (`:793-795`), and the roster's own header says the roles *"are not
exclusive by intent"*. **The declared role is `control-grid` because the grid is what the
module is operated from**; the lamps are four cells on it, not the surface's purpose. Stated
here because a reader who checks only the `status-primitive` predicate would conclude the
entry is mislabelled.

**The `why` string, AS IT WOULD BE COMMITTED:**

> `gamepad: { role: 'control-grid', why: 'the CONTROLLER MAPPING BOARD — twelve button cells, two trigger rows and two stick pads, where right-clicking a cell ARMS a remap and the next physical control the player moves binds that output, plus both stick calibrations, the four invert toggles, the two set-centre re-zeros and the save/load-mapping row with its preset picker. ⚠ IT IS A CONTROL GRID, NOT A PICTURE: a cell is the surface an OUTPUT is rebound from, and its lit state is that cell\'s own state rather than a preview of something elsewhere — and it mounts no canvas and must not grow one, since WebGL attest basis membership is derived from CONTENT and a GL body would put a face edit on the GPU-attest critical path. ⚠ IT IS THE FIRST CONTROL GRID WHOSE CELLS ARE DRIVEN FROM OUTSIDE THE DOCUMENT: matrixMix reflects patch.edges, these reflect a live navigator.getGamepads() poll published by the ENGINE NODE through read("snapshot") — which is also why no status registry is needed, the poll is node-lifetime and survives card unmount by construction. ⚠ IT ALSO IMPORTS StatusLed, so the status-primitive predicate holds too; the declared role is control-grid because the grid is what the module is OPERATED from and the four lamps (PAD, CAL L, CAL R, MAPPING) are cells on it. ⚠ ALL PAINTED TEXT IS A CAPTION OR AN OPTION NAME: twelve LED captions read from GAMEPAD_OUTPUTS so a def-side label edit propagates, LT/RT, L/R, inv, SLOT, the button captions, and the preset roster\'s own names. No value, no measurement, no state word — the pad id, both calibrated badges, the live sweep range and every mapping outcome are on StatusLed detail or aria-valuetext. ⚠ THE SWEEP EXTENT IS DRAWN, NOT PRINTED: a bordered div inside the stick pad, in the same coordinate system as the live dot, replacing four live numbers with the picture of the quantity they reported. ⚠ IT IS A BODY RATHER THAN A PANEL for two mechanical reasons: ShellPanelCell REQUIRES a minWidth NUMBER and this surface is one calibration banner or a twelve-cell grid depending on mode, and the required probe vocabulary is data/data-rev/text while the observable of an armed remap is a PHYSICAL BUTTON PRESS on hardware no runner has. ⚠ IT CARRIES A FILE INPUT (load mapping, .json) — precedented by picturebox\'s body — and owns a window keydown for Escape-cancels-remap whose teardown must ride the component. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, and markWatched is a VideoEngine pull-set concept this module has no part in.' }`

### 7.2 ⚠ THE BODY MUST STAY DOM — this is the module's only attest risk

The sticks, the bars and the sweep box are all `<div>`s today and must remain so. The reason
is mechanical: `resolveWebglBasis()` sweeps `lib/ui/modules/**.svelte` and admits any file
where `sourceCreatesWebglContext` holds (`webgl-attest-lib.ts:262-269`), **so a body written
against a WebGL context enters the basis AUTOMATICALLY and puts every future face edit on the
GPU-attest critical path.** matrixMix records the identical hazard and the identical
resolution (`MatrixMixGridBody.svelte:37-41`). ⚠ A **2-D** canvas would not trip
`WEBGL_CONTEXT_RE` and would still make the body `picture` under `ROLE_PREDICATE`, changing
the declared role and hiding every measurement it draws from `face-resting-text-source` — so
neither kind of canvas belongs here.

### 7.3 The card poll moves to the body; the FACTORY poll does not move at all

`GamepadCard.svelte:218-256` moves verbatim: the rAF loop, the `snapshot` assignment, the
calibration fold, the armed-remap diff, and — critically — the `onDestroy` that cancels the
frame, removes the keydown listener and clears both timers (`:252-258`). ⚠ **A body that
subscribed without unsubscribing is the node-resource-leak class from the other side**, which
`MidiclockDeviceBody.svelte:55-58` names in its own header.

The FACTORY poll (`gamepad.ts:1268-1288`) is untouched by promotion — it is node-lifetime
already (§0.3), which is why this module needs no registry and no headless host.

---

## 8. STATE — the `.data` / params census, per CALL SITE

Wave 6 established the census is **per call site, not per module**. Measured on
`GamepadCard.svelte`:

| call site | writes | transacted + `LOCAL_ORIGIN`? |
|---|---|---|
| `commitRemap` `:134-140` | `data.bindings[out]` | ✅ `mutateNode` |
| `clearRemap` `:142-146` | `data.bindings` delete | ✅ |
| `toggleInvert` `:158-162` | `data.invert[axis]` | ✅ |
| `setCenter` `:176-201` | `data.*StickCalibration.center{X,Y}` | ✅ |
| `completeCalibration` `:283-297` | `data.*StickCalibration` | ✅ |
| `clearCalibration` `:299-305` | delete `data.*StickCalibration` | ✅ |
| `applyMappingToNode` `:348-352` | the whole bundle via `applyMapping` | ✅ |
| **`setPadIndex` `:393-397`** | **`t.params.padIndex`** | ⛔ **BARE PROXY WRITE** — §13.1 |

**Seven of eight are clean, and the eighth is the only param writer.** That is wave 6's
per-call-site finding again, from a fifth module — ⚠ **and it is the first instance the
census has seen on `params` rather than on `data`**, which is why the running per-module
binary column could never have expressed it.

**The in-place discipline is exemplary and load-bearing.** `applyMapping` (`gamepad.ts:854-905`)
deletes and re-sets individual keys and never re-assigns an integrated Y type, because
*"that is the trap that threw out of this rAF poll and killed all output after a 2nd remap"*
(`GamepadCard.svelte:128-133`). The regressions are named unit legs:
`gamepad-remap-ydoc.test.ts:97` (*"SECOND remap does NOT throw"*), `:284` (*"apply OVER an
existing mapping does NOT throw"*), `:300` (*"apply TWICE … never throws"*). **Any body that
rebuilds `data.bindings` is a shipped crash.**

**Does it break the generic face path?** No. `padIndex` is an ordinary `ParamDef` and the
segmented cell writes it through the standard `shell-param-writes` seam — ⚠ which is also the
fix for §13.1, since that seam is `setNodeParam` and `setNodeParam` is `mutateNode`
(`graph/mutate.ts:106-118`).

---

## 9. LANE TILE AT 1/8 SIZE

**Today:** the uniform placeholder — name, type badge, domain glyph, jack rail. **No ranked
controls.**

**After promotion:** the module name, the 18-jack rail, `glyph: 'none'`, and one segmented
`SLOT 0 1 2 3` cell. `laneOrder` drops a declared `hero.cell` and each `xyPads` entry's `x`
key; this face declares neither, so the single cell survives to every tier
(`shell-cells.ts:2020-2027`).

⚠ **Is one cell enough to avoid the `joystick` shape?** Yes, and for a reason that does not
apply to `controlSurface`: `padIndex` is the **only thing on this module a player changes
without looking at the device.** Remapping, calibrating and inverting are all *"move the
physical control and watch"* gestures — they are meaningless without the echo, so they
belong where the echo is, and the echo cannot fit in 192 px. **The one cell in the lane is
the one control that is useful there.** §10.5's model test asserts it is PRESENT at every
lane tier, not merely that the face resolves.

---

## 10. THE FOUR GATES (plus SNAP)

| # | gate | file:line | this module |
|---|---|---|---|
| 1 | **face lints / `STRICT_FACES` anchor** | `module-face-lint.test.ts`; `strict-faces.ts:10-15` — *"asserted EQUAL to the set of defs that declare a `face` … AUTHORING A `face` IS THE PROMOTION. There is no count"* | ⚠ **NOT vacuous here**, unlike the meta modules: `def.params` has one entry, so completeness genuinely asserts `padIndex ∈ face.order`. |
| 2 | **VRT baselines** | `e2e/vrt/_shell-faces.ts:34` (`FACES`); Linux CI authors them; `task vrt:commit` scopes to the diff | **3 files** — §11. |
| 3 | **`EXTENSION_BODY_ROLES`** | `face-rack-status-source.test.ts:150` (roster), `:557-608` (`ROLE_PREDICATE`), `:784-797` (verified not trusted), `:810-827` (the role SET IDENTITY), `:826-860` (the speakable leg) | `role: 'control-grid'`; `why` in §7.1; predicate satisfied. ⚠ The role set is now a **set identity against `ROLE_PREDICATE`'s keys, asserted both ways** — **not** wave 6's hand-typed pair — so adding a second `control-grid` entry moves nothing. ⚠ §5.3 is where the speakable leg genuinely bites. |
| 4 | **`module-docs-lint` FAMILY↔CARD** | `module-docs-lint.test.ts:359-375` | ⚠ **This face declares NO new `controlFamilies` (§4), so this leg has nothing to check on it, and that is deliberate.** Every family key would resolve to ONE ranked cell standing for a bank, which says nothing in a lane. §10.4 is the docs work that IS worth doing. |
| **5** | ⚠ **`face-migration-inventory.test.ts` — a FIFTH gate no wave has listed, and `gamepad` CLEARS it** | `:229` (a def declaring a `face` must be dispositioned `generic-face`), `:268-281` (a `generic-face` entry may name no blocker), `:226-248` (**typed entry ⇒ NOT `generic-face`**) | ✅ **PASSES, and it is worth stating rather than assuming.** Leg 1 forces this entry from `bespoke-surface` to **`generic-face`** in the face PR — that is a required inventory edit, not an optional one. Leg 2 is satisfied because `:813-821` declares **no `blockers` array** (§1). Leg 3 scans the LEGACY card's rendered markup and `GamepadCard.svelte` mounts **no typed entry** — its only inputs are `<input type="file">` (`:684-689`) and a `<select>` (`:691-699`), neither of which `mountsTypedEntry` matches. ⚠ **This is the gate that BLOCKS `controlSurface`** (see that spec's §5.3) and the asymmetry inside this cohort pair is the finding: same design problem, opposite answers. |
| + | **`optionsExhaustive` SNAP** | `param-vocabulary.test.ts` | ⚠ **LIVE ON THIS MODULE** — §4.1. `paramCellKind` returns `'knob'` off-dock, so a lane drag can land between options; snap with `snapToOptions` from `$lib/ui/controls/knob-vocabulary-model`, never a second implementation. *"One that declares it and does NOT snap is worse than one that never declared it."* |

### 10.4 The docs work (boy-scout, not gate-forced)

`ModuleDocs.controls` accepts *"stable control keys for one-off card buttons"*
(`graph/types.ts:600-604`). `gamepad` is in `STRICT_DOCS`, its one param is documented, and
the gate requires nothing more. **But eleven distinct body gestures currently have no
authored prose**, and after §5 removes six text rows the authored docs are where the
explanation lives (the fleet standard: *"faces carry almost no prose; explanation moves to
right-click annotate from authored docs"*). **Add `docs.controls` entries for
`calibrate`, `set-center`, `remap-axis`, `remap-button`, `invert`, `save-mapping`,
`load-mapping` and `load-preset`** in the face PR. Cost: prose only, and **`docs` is
hash-transparent by construction** (`scripts/attest-code-basis.ts` strips it), so it is free.

### 10.5 A FIFTH, bespoke gate — `gamepad-face-model.test.ts`

The `midiclock-face-model.test.ts` / `matrixmix-face-model.test.ts` pattern, asserting at
source:

1. `glyph === 'none'` **and** `primaryAudioOutPortId(gamepadDef) === null`, so the literal is
   proved rather than asserted (`mandelbulb-glyph-tap.test.ts:63-66`'s shape);
2. the `SLOT` cell is **PRESENT at every lane tier**, not merely that the face resolves —
   the `joystick` guard matrixMix instructs (`shell-cells.ts:2020-2027`);
3. `padIndex`'s roster is exhaustive **and** the cell snaps through `snapToOptions` — the
   SNAP contract's own warning is that a declared-but-unsnapped roster is worse than none;
4. **the body's `aria-label` expressions are disjoint from its painted-text expressions**,
   with a **two-direction negative control**: a fixture with `aria-label={btn.label}` beside
   `>{btn.label}<` must be CAUGHT, and today's design must CLEAR it (§5.3);
5. the body imports `StatusLed` and mounts no canvas — so the §7.1 two-predicate situation is
   asserted rather than left as a surprise, and a future canvas is caught here as well as by
   the shared roster.

---

## 11. COST TABLE

| cost | value | why |
|---|---|---|
| **WebGL attest** | **ZERO** | neither `gamepad.ts` nor `GamepadCard.svelte` is in `resolveWebglBasis()` (`webgl-attest-lib.ts:256-304`); `AUDIO_WEBGL_MODULE_DEFS` is `cube` + `wavesculpt` only (`:67-70`). ⚠ Conditional on §7.2. |
| **ART** | **ZERO** | the factory is 18 `ConstantSourceNode`s written from a poll; there is no DSP and no ART baseline. ⚠ **`padIndex`'s `options` roster does not change a single sample** — it changes how the param renders, and the value space `0..3 discrete` is unchanged. |
| **`contract-lock.txt`** | **ONE LINE MOVES** — `:1278` gains the roster | run `task docs:accept`, review the diff, land it in the SAME PR as the face (§4.1). `face` is stripped by the attest normalizer; ⚠ `controlFamilies` is NOT contract-transparent, but this face declares none. |
| **Push 2 card** | **re-ranks, safely** | no explicit `PUSH_CARD_CONTROLS` entry, so the card is resolved from the live def. With exactly one param the rank cannot move (§4.1). ⚠ Flag it in the PR body. |
| **docs / `STRICT_DOCS`** | already a member; §10.4 is prose only | free — `docs` is hash-transparent by design. |
| **VRT files** | **3** | `face-gamepad-compact.png` + `face-gamepad-dock.png` (new scenes) **+ `gamepad.png`** — draining `EXEMPT_FROM_VRT` enrols the **legacy card** through `vrt.spec.ts:51-54`'s `COVERED_MODULES = REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`. ⚠ `midiclock` predicted 3 where its own spec had said 2, and was right. **Sweeps joined: `vrt.spec.ts` + `workflow-shell-faces.spec.ts` (both scenes).** NOT `vrt-strict` — do not add the type to `STRICT_VRT_MODULES`; the dock scene mounts a body. |
| **deletions the PR must make** | `EXEMPT_FROM_VRT` `:868` **and** `ALLOWED_PERMANENT_EXEMPT` `:1226` | `vrt-meta.test.ts` asserts set equality **in both directions**, so a one-sided delete is RED. ⚠ Note `:1226` is a packed line — `'tempest', 'vfpgaRunner', 'joystick', 'gamepad'` — so the edit removes one string from it, not the line. |
| **CI wall-time** | two face scenes bounded at `FACE_SCENE_BASE_MS = 90_000` + one card scene | ⚠ Over the ~2 min sign-off line in aggregate; estimate and flag it in the PR body per CLAUDE.md. |

---

## 12. BUILD ORDER (one PR)

1. `padIndex` gains `options` + `optionsExhaustive`; wire `snapToOptions`. `task docs:accept`,
   review the `contract-lock` diff.
2. `face` + `STRICT_FACES` entry, same commit as (1).
3. `$lib/ui/modules/gamepad/shell-extension.ts` + `GamepadMappingBody.svelte` — the port of
   `GamepadCard.svelte:445-767` with §5's text rows replaced, §5.1's sweep box added, §5.3's
   sentences on `aria-label`, and §7.3's teardown intact.
4. `EXTENSION_BODY_ROLES` entry (§7.1), **and** flip `face-migration-inventory.ts:813-821`
   from `disposition: 'bespoke-surface'` to `'generic-face'` — **required**, not optional
   (§10 gate 5, leg 1). ⚠ Rewrite the `why` in the same edit: it currently claims a device
   roster that does not exist and says *"none of it is a param"* while `padIndex` is one
   (§0.1, §13.2).
5. `gamepad-face-model.test.ts` (§10.5) + `docs.controls` (§10.4).
6. Drain both VRT lists; `FACES` entry with `pages: 1`; **`task vrt:commit`** and **count the
   files the bot commits against the predicted 3**. A green dispatch that committed nothing is
   a RED FLAG; `git status` for untracked PNGs afterwards.
7. Re-point the e2e specs — §13.3. ⚠ **This is the step a PR would skip**, because skipping it
   is green.

---

## 13. DEFECT LEDGER — live on `main`, independent of any face

1. ⚠ **`GamepadCard.svelte:393-397` — `setPadIndex` is a BARE PROXY WRITE.**

   ```ts
   function setPadIndex(n: number) {
     const t = patch.nodes[id];
     if (!t) return;
     t.params.padIndex = Math.max(0, Math.min(3, Math.round(n)));
   }
   ```

   No `ydoc.transact`, no `LOCAL_ORIGIN`, while **every** `node.data` write on the same file
   correctly uses `mutateNode`. **Cmd-Z cannot undo a slot change**, and the local reconciler
   does not see it as a user edit. The fix is one line — `setNodeParam(id, 'padIndex', …)`
   (`graph/mutate.ts:106-118`, which is `mutateNode` with a single in-place key set). ⚠ **The
   face fixes it as a side effect**, because a ranked cell writes through
   `shell-param-writes` — so the defect and its cure would land in one PR; **fix it
   explicitly and name it**, or the ledger entry disappears into a refactor.

2. ⚠ **`face-migration-inventory.ts:814-821` claims a "live device roster" that does not
   exist** (§0.1). There is one device NAME for the selected slot and four blind numbered
   buttons. The same entry says *"none of it is a param"* while `padIndex` is one. Both are
   stale claims in a field agents read as current fact — wave 6's `recorderbox` finding, from
   another module.

3. ⚠ **All eighteen `gamepad.spec.ts` tests boot `?shell=legacy`** — `:101` and `:715` are
   explicit `goto`s and every `test(…, { page, rack })` rides the `rack` fixture, which is
   `/rack?shell=legacy&seed=none` by construction (`_fixtures.ts:76-98`). **Today that is
   correct** (the fixture's own note: card-interaction specs are written against the verbatim
   card). ⚠ **After promotion it is wave 6's GREEN-AND-BLIND class**: the specs keep passing
   against a card that is no longer the lane render, and **the face's own remap / calibrate /
   invert / mapping paths would have ZERO coverage while eighteen green tests say otherwise.**
   The fixture states the hazard in its own words — *"What a green run on `rack` structurally
   cannot see: everything the default renderer paints"* (`:104-110`). **The face PR owns
   re-pointing them at `rackDefault` (`:107-120`) or splitting card-vs-face coverage**, and
   this is the highest-value item in the ledger because it is the one that ships silently.

4. **`module-manifest.ts:376-377` documents only the LEFT stick calibration.** It says
   *"LEFT-STICK CALIBRATION: 'calibrate left stick' arms a calibration mode …"* and *"applied
   to lx / ly"*, with no mention of the RIGHT stick — but `rightStickCalibration`,
   `calibrate right stick`, `gamepad-calibrate-start-right` and the symmetric `set center`
   all ship (`gamepad.ts:725-729`; `GamepadCard.svelte:627-645`). ⚠ **`module-docs-lint` reads
   the DEF**, so it is structurally blind to a stale `DESCRIPTIONS` string — the
   modtris/score/`videovarispeed` class, from a fifth module. The def's own `docs.explanation`
   is likewise left-only (`gamepad.ts:989`) and **that one the gate could see if it checked
   completeness of prose, which it does not.**

5. **`vrt-exemptions.ts:868` draws the wrong conclusion from a true premise** (§6.3). The poll
   is live; its output on a runner with no controller is a constant. Same shape as the
   `controlSurface` and `matrixMix` entries — *"'no stable pixels' described the surface that
   ISN'T rendered and drew a conclusion about the one that is"* (`:645-652`). **This drain is
   available today with no face**: delete `:868` and the `'gamepad'` string at `:1226`, and
   let CI author `gamepad.png`.

6. **`.claude/skills/module-faceplates.md:485-489` is STALE** — it describes `fullViewBody` as
   *"declared contract, no render site yet"*. It is **wired**:
   `WIRED_SHELL_EXTENSION_SLOTS = ['glyph', 'fullViewBody']` (`shell-extensions.ts:124`), with
   ~30 shipped adopters. Only `editorSurface` is still unwired (`:65`). Boy-scout it.

8. ⚠ **`gamepad` is the reason a live gate has never fired, and that is worth recording.**
   `face-migration-inventory.test.ts:226-248`'s typed-entry leg reddens any module whose
   LEGACY card mounts typed entry once that module is dispositioned `generic-face` — which
   declaring a `face` forces (`:229`). **Every module promoted since the extension slot
   shipped has a clean card** (`midiclock`, `kria`, `matrixMix`, and now `gamepad`), so the
   leg has never had a subject. ⚠ Meanwhile the SAME FILE makes the blocker's own liveness
   probe read a **different artifact** — `:346`, `mountsTypedEntry(moduleShellTemplate())`
   over `ModuleShell.svelte`, *"the ONE renderer every face cell is painted by"*
   (`:332-334`). **So one file holds two subjects — the legacy CARD and the shared face
   RENDERER — and a `fullViewBody` is neither.** The subject was quietly redefined when
   #1512 shipped the extension slot and neither leg was revisited. `controlSurface` is where
   this bites (that spec's §5.3); `gamepad` is the clean control that shows the leg is live
   rather than broken. ⚠ **No gate change is proposed** (the standing no-CI-changes ruling);
   it is recorded so the next author does not read `gamepad`'s green run as evidence about
   `controlSurface`.

9. Minor: `saveMapping` hard-codes the filename `gamepad-mapping.json`
   (`GamepadCard.svelte:334`), so saving two devices' mappings overwrites in the browser's
   download folder without warning; and `GAMEPAD_PRESETS` has exactly one member, so the
   `load preset…` `<select>` is a two-option dropdown — honest, but worth knowing before
   anyone treats "presets" as a populated feature.

---

## 14. VERDICT, RISK, ESTIMATE

| | |
|---|---|
| **verdict** | **PROMOTE.** No precursor, no platform capability, no blocker in the inventory, no tier lost. The lane goes from a placeholder with zero controls to a real tile with the one control that is useful at 192 px. |
| **the one contract change** | `padIndex` gains an exhaustive `options` roster — in the SAME PR, with `snapToOptions`. |
| **available TODAY, with no face** | the **VRT drain** (§13.5) and the **`setPadIndex` fix** (§13.1). Each is a few lines. |
| **risk** | **MEDIUM-LOW.** The port is large (1206 lines of card) but mechanical; the two real hazards are the in-place Y.Doc discipline (§8, a shipped-crash class with three named regression legs) and §13.3's silent coverage hole. |
| **estimate** | **≈10-13 h**, plus one CI capture. |

---

## 15. MUST-VERIFY (things I could not measure without running something)

1. **`primaryAudioOutPortId(gamepadDef) === null`** — derived from
   `mandelbulb-glyph-tap.test.ts:32` against 18 outputs, none `type: 'audio'`. Certain by
   reading, unrun; §10.5 leg 1 turns it into an assertion.
2. **The dock scene's `bodyW - contentW` against the 40 px ceiling.** §6.1 predicts a
   comfortable pass (the widest element is a ~220 px LED grid), **provided the card's
   `min-width: 280px` floor does not come across.** Only a captured scene proves it.
3. **Whether the disconnected dock scene is byte-stable across runs.** §6.3 argues it is
   structurally, but `.remap-dot`, the `StatusLed` lamps and the trigger fills should be
   confirmed to carry no CSS animation before the first capture — an animated dark lamp would
   be a 1 px flake, not a design problem.
4. **Whether the segmented `SLOT` cell fits four options at the `compact` lane tier** without
   ellipsis. Four single-digit labels in a 192 px tile should be comfortable; measure rather
   than assume, because a clipped roster is the `joystick` failure in miniature.
