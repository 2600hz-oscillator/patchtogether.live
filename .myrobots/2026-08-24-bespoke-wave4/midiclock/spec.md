# FACEPLATE BUILD SPEC — `midiclock` (audio, the MIDI TRANSPORT BRIDGE)

**SPEC ONLY. Nothing here is implemented.** Mockups: [`dock.html`](dock.html) ·
[`dock-connect.html`](dock-connect.html).

Method: analyse what the module is FOR, then author the spec, then build from the
spec. This is the wave's defect-richest module: four items in §11 are live on `main`
today and three of them are fixed inside the face PR.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| constraint | midiclock's answer | measured at |
|---|---|---|
| `NON_SHELL_LANE_TYPES` | **NOT a member** | `legacy-fallback.ts:105-112` |
| `HEADLESS_MOUNT_LANE_TYPES` (the #1511 tax) | **NOT a member** — the engine runs without the card | `dom-source-modules.ts:89-97`, `:214-221`; §0.2 |
| ⚠ **a PINNED instance exists** | **YES** — and its surface is a bespoke topbar menu, not a faceplate. §0.3 | `graph/workflow-pins.ts:125` |
| lane picture | **refused**, mechanically protected | §4 |
| WebGL attest | **ZERO — not in the basis** | §10.1 |
| ART | **ZERO** — `ART_EXCLUDED`, with a reason | §10.2 |
| VRT | ⚠ exempt — **and the exit condition it waits for ALREADY EXISTS in the tree** | §9 |
| tab rail | **NO** — one control | `dock-tabs-model.ts:101` |
| `node.data` writes / Cmd-Z | ⚠ **BROKEN** — the third instance of wave 3's class | §0.4 |
| contract | ⚠ **moves** — this face declares the module's first param | §5.1 |

### 0.1 THE PARAM SET IS EMPTY, AND ONE OF THE TWO SETTINGS SHOULD NEVER HAVE BEEN

`midiclock.ts:151-158`:

```ts
inputs: [],
outputs: [
  { id: 'clock',     type: 'gate', edge: 'trigger' },
  { id: 'run',       type: 'cv'   },
  { id: 'midistart', type: 'gate', edge: 'trigger' },
  { id: 'midistop',  type: 'gate', edge: 'trigger' },
],
params: [],
```

Four real outputs, zero params. The two user settings — the DEVICE and the clock
DIVISION — live in `node.data` (`MidiclockData`, `:123-127`).

The def states its reasoning in its own docs (`:162`):

> *"The card has a device picker and a clock-division select; **there are no
> audio-side knobs because every setting (device + division) is a discrete choice
> that lives in the saved patch, not a continuous AudioParam.**"*

⚠ **That reasoning is sound for an AudioParam and wrong for a face.** A `ParamDef` is
not an AudioParam — discrete option rosters are first-class
(`types.ts:431`, `options?: readonly ParamOption[]`), and the `kria` reclassification
note says exactly this about the same shape: *"Everything else — loop, time,
direction, mute, scale, root — is a generic selector or toggle over a roster the def
already declared"* (`face-migration-inventory.ts` kria entry).

So the two settings are **not** the same kind of thing, and separating them is the
whole design:

| setting | roster lives | face-expressible? |
|---|---|---|
| `divisor` | **in the def**, `CLOCK_DIVISORS = [24, 12, 6, 3, 1]` (`midiclock.ts:80`), with a label function at `:88-94` | **YES — a ranked `ParamDef` with `options`.** §5.1 |
| device | on the **engine handle**, behind `requestMIDIAccess()` | **no** — §5.2 |

**One of midiclock's two "bespoke" settings is a param that was never declared.** The
inventory's `why` (`face-migration-inventory.ts:851-857`) says *"No params — the
surface is the binding"*; after §5.1 that sentence has one param and a smaller
binding.

### 0.2 THE ENGINE DOES NOT NEED THE CARD — measured, not assumed

Every promotion in this program has to answer whether a face orphans engine state.
midiclock's answer is clean and it is structural.

The module's outputs are four `ConstantSourceNode`s created and `start()`ed in the
factory (`:179-182`); the MIDI handler is installed on the engine side
(`attachToDevice`, `:293-297`) through an identity-scoped claim
(`createMidiInputClaim('midiclock')`, `:192`). **None of that is on the card.** The
card is a *view*: it calls `read(node, 'card-api')` (`MidiclockCard.svelte:45-49`)
and subscribes (`:52-62`).

Confirmed against the derived set: midiclock is absent from
`CARD_PRODUCER_LANE_TYPES` (`dom-source-modules.ts:214-221` — `cube`, `rasterize`,
`scope`, `synesthesia`, `timelorde`, `wavesculpt`) and from `DOM_SOURCE_LANE_TYPES`
(`:89-97`), hence from `HEADLESS_MOUNT_LANE_TYPES`. That set is grep-derived from the
cards, so the absence is gate-anchored.

⚠ **With ONE exception, and it is a live defect rather than a face problem.** The
`connect()` gesture is only reachable from a mounted card
(`MidiclockCard.svelte:65-69`, `:110-112`). Under the default shell an un-migrated
module renders a `moduleShellPlaceholder` in the lane
(`legacy-fallback.ts:143-146`), so **today the only route to granting MIDI access is
to open the dock full view.** The module is otherwise fully alive. See D4 in §11 —
the face fixes it by making the gesture a face cell, which is the cameraInput
lineage's whole point.

### 0.3 ⚠ THE PINNED INSTANCE — the audioOut question, asked again, with a different answer

`graph/workflow-pins.ts:125`:

```ts
{ type: 'midiclock', domain: 'audio', id: 'pinned-midiclock', presence: 'pinned' },
```

so midiclock has a canvas-hidden pinned instance in every workflow rackspace, exactly
like `audioOut` did in wave 3. That spec's blocker was that `AudioIoSurface.svelte`
hosted the pinned pair via `DockCardHost` and **never called `dockRailRendersFace`**,
so a promoted `audioOut` would render its face on user-added instances only.

**Two things have changed and both matter.**

**(1) Wave 3's precursor LANDED.** `AudioIoSurface.svelte:23` and `:73-76` now
document and pass exactly that rule — *"This is `dockRailRendersFace({ shellFaces,
pinned: true, migrated })` — evaluated by Canvas and INJECTED"* — shipped as
`5f6c289a3`, *"fix(workflow): the 🎧 audio-I/O panel never asked the migration rule
— so the PINNED audio pair could never render a face (#2173)"*. **Wave 3's audioOut
PR-1 is done; its PR-2 is now an ordinary one-param face.** Recorded here because
wave 3's build-order recommendation is stale by one step.

**(2) midiclock's pinned instance is NOT hosted the same way, so there is no
four-line fix.** `workflow-pins.ts:106-122` describes the P2 surfaces:

> *"Same pinned mechanism as the trio (deterministic ids, ensure-effect,
> undeletable, canvas-hidden) but **NO bottom drawer: each one's face is a topbar
> menu** ($lib/ui/workflow — ClockSurface / MidiDinSurface / AudioIoSurface)."*
> … *"midiclock: the hidden MIDI-DIN→TIMELORDE bridge. Inert (no MIDI access) until
> the DIN surface's assign flow connects it."*

Measured: `MidiDinSurface.svelte` contains **no `DockCardHost`, no
`dockRailRendersFace`, and no `face`** — it is a hand-built assign dropdown, not a
card host. There is no `face` prop to thread; there is no host.

⚠ **AND THE FLEET HAS ALREADY ACCEPTED THIS DIVERGENCE FOR A PROMOTED MODULE.**
`ClockSurface.svelte:2-3` calls itself *"TIMELORDE's **face** for workflow racks (the
pinned instance renders no canvas card…)"* — and `timelorde` **is** in
`STRICT_FACES` with a real `face`. So a promoted module whose pinned instance shows a
bespoke topbar surface instead of its faceplate is the shipped state of the product
today, in the module right next door.

**Disposition: the pinned instance is EXPLICITLY OUT OF SCOPE, named in the PR body,
with the timelorde precedent cited.** This is not the audioOut blocker repeating —
audioOut's pinned surface *was* a faceplate host that failed to ask the rule, which is
a bug. midiclock's is a different surface by design, and unifying the three topbar
surfaces with the faceplate system is a real piece of work that should not ride a
module PR.

⚠ What the PR body must **not** say is *"promotion changes nothing for the pinned
instance, so it doesn't matter."* It matters; it is simply a different project, and
naming it is how it stays visible. #2173 fixed one of the three surfaces. The other
two are unexamined.

### 0.4 ⚠ EVERY midiclock SETTING IS OUTSIDE Cmd-Z — the third instance of wave 3's class

`MidiclockCard.svelte:71-79`:

```ts
function writeData(patch_: Partial<MidiclockData>): void {
  const target = patch.nodes[id];
  if (!target) return;
  if (!target.data) target.data = {};
  for (const [k, v] of Object.entries(patch_)) {
    if (v === undefined) delete target.data[k];
    else (target.data as Record<string, unknown>)[k] = v as unknown;
  }
}
```

**No `ydoc.transact`. No `LOCAL_ORIGIN`.** Both callers go through it:
`onChangeDevice` (`:81-85`) and `onChangeDivisor` (`:87-92`).

`mutate.ts:13-18` names this exact shape as the bypass it exists to close:

> *"a bare `patch.nodes[id].params[p] = v` (SyncedStore's proxy transacts with NO
> origin) … is silently NOT undoable"*

and `store.ts:65-72` is the mechanism — `trackedOrigins: new Set<unknown>([LOCAL_ORIGIN])`.

So **picking a MIDI device and changing the clock division are both outside undo.**
The writes still sync (the proxy transacts, just with a `null` origin); they simply
never reach the UndoManager.

⚠ **And nothing can see it.** `mutate.guard.test.ts:94`'s regex anchors on the
literal token `.params`; `writeData` touches `.data`. `raw-write-ledger.ts` names no
midiclock entry, and there is no `.data`-side ledger to name one in.

**Wave 4's contribution to wave 3's finding is the denominator.** Across the two
waves, six bespoke modules were read for this:

| module | `.data` writes | origin |
|---|---|---|
| `kria` | the whole sequencer | ✗ untagged (wave 3) |
| `audioOut` | `outputDeviceId` | ✗ bare proxy write (wave 3) |
| **`midiclock`** | `divisor`, `lastDeviceId` | ✗ **bare proxy write** |
| `picturebox` | image bytes, 7 slots | ✓ `LOCAL_ORIGIN` |
| `matrixMix` | two axis ids | ✓ `LOCAL_ORIGIN` |
| `twotracks` | `bufLenA` (engine-owned) | n/a |

**Three broken, two correct, one n/a — and `mutate.guard` is green over all six.**
That is a materially stronger case than wave 3's two-of-two, because it shows the
gate cannot distinguish the careful modules from the careless ones. The platform
question (does `.data` get an origin-tagged seam and a ledger?) is still an
owner-facing decision and **this spec does not assume it lands.**

**THE FIX IN THIS PR IS ONE ARGUMENT**, and it is not `writeData` gaining a
transact — §5.1 deletes `divisor` from `node.data` entirely by making it a param
(so `setNodeParam` handles it, correctly, through the existing seam). What remains
is `lastDeviceId`, and that one write becomes:

```ts
ydoc.transact(() => { …the same body… }, LOCAL_ORIGIN);
```

---

## 1. WHAT THE MODULE IS FOR

Letting something outside the browser be the boss.

MIDI carries a fixed 24-pulse-per-quarter-note clock plus Start / Stop / Continue.
midiclock listens to that stream on a chosen device and turns it into rack signals:
a `clock` gate at a division you pick, a `run` level that is high while the transport
plays, and one-shot `midistart` / `midistop` pulses (`midiclock.ts:7-14`). Patch
`clock` into TIMELORDE and the whole rack follows a hardware sequencer, a drum
machine, or a DAW.

It is deliberately transport-only — *"Channel-voice messages are ignored — pair with
MIDI-CV-BUDDY for note/velocity"* (`module-manifest.ts:375`) — and its one piece of
real musical thinking is at `:277-281`: **MIDI Continue raises `run` without firing
`midistart`**, because *"Continue exists precisely to resume without re-zeroing
downstream loops, so a midistart pulse would lie about intent."*

**What that means for the face:** the module is one choice (how fast), one binding
(which device), and four jacks. The binding is a state machine with a permission
gesture in it; everything else is a five-position switch. That is a small face with
one honest extension body — and, unusually for this program, the *module* is in
better shape than the *card* that shows it (§11).

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

| affordance | `MidiclockCard.svelte` | where it goes on the face | lost? |
|---|---|---|---|
| `Connect MIDI…` button | `:110-112` | **an `action` shell cell** — §5.2, and it stops being dock-only (§0.2) | no, **gained** |
| the one-time-per-origin hint | `:121` | body, pre-connect state | no |
| the access-failure message | `:113-119` | body, and it stays LOUD | no |
| DEVICE picker | `:124-132` | `fullViewBody` — §5.2 | no |
| DIV picker | `:134-141` | **a ranked param cell** — §5.1 | no, **gained** (automatable) |
| `STATE: RUN/STOP` readout | `:143-149` | ⚠ **removed as text** — §7 | see §7 |
| `TICKS: <n>` readout | `:150-153` | ⚠ **removed as text** — §7, and it is broken anyway (D2) | see §7 |
| the four jacks | `:94-100` (`PatchPanel`) | the shell's own patch surface | no |

**Nothing is lost, two things are gained**, and the two gains are the interesting
part: the connect gesture becomes reachable without opening the dock, and the clock
division becomes a real param — which means for the first time it can be automated,
MIDI-learned, exposed on a group, and put on the Push 2 card.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

| entry point | today | after |
|---|---|---|
| device pick | `<select>` → `api.selectDevice` + `writeData` | body `<select>` → the same API + a `LOCAL_ORIGIN` write |
| division pick | `<select>` → `api.setDivisor` + `writeData` | **`setNodeParam`** → `setParam` on the handle — §5.1 |
| connect | card button → `api.connect()` | `action` cell → the same `api.connect()` |
| device re-attach on load | `savedData.lastDeviceId` in the factory (`:188`) | unchanged |
| hot-plug | `access.onstatechange` (`:333-341`) | unchanged (engine-side) |
| division via automation / MIDI learn / Push 2 | ⚠ **impossible today** | **possible** — §5.1 |

⚠ **The division's migration is the one place a saved patch can regress**, and §5.1
specifies the read order that prevents it.

---

## 4. THE LANE PICTURE — refused, and this is the cleanest refusal in the wave

`glyphBinding()` (`shell-glyph-live.ts:128-200`) short-circuits at `:184` on
`primaryAudioOutPortId`, which is `def.outputs.find(o => o.type === 'audio')?.id`
(`:111-113`) — **`type === 'audio'` exactly**.

midiclock's four outputs are `gate`, `cv`, `gate`, `gate` (`midiclock.ts:152-157`).
**Not one of them is `audio`.** So `primaryAudioOutPortId` returns `null`, no
`live-audio` binding is reachable, and every non-`none` glyph literal falls through
to `{ kind: 'static' }` at `:199` — which `module-face-lint.test.ts:271-290` reddens
**unconditionally, with no exemption list and no count.**

`hasVideoSurface` is `domain === 'video'` (`module-shell-model.ts:177-179`) and
midiclock is `domain: 'audio'`, so `laneGlyphFor` returns `'none'` (`:237-240`).

**`glyph: 'none'` is the only literal that compiles into a green run.** An author who
never thinks about it ships the right thing.

⚠ **And the picture this module would WANT is a fourth distinct case worth
recording.** The useful glance is *"is a clock arriving?"* — a blinking tick
indicator. That is not a *picture of a signal*, it is a picture of an **event rate**,
and the glyph seam has no vocabulary for it: `VALID_GLYPHS` is
`scope | meter | envelope | waveform | algorithm | none`
(`module-face-lint.test.ts:121`), all five of which describe a continuous audio
quantity. There is no `activity` glyph, and this module is the argument for one —
which is precisely why §7 does **not** invent it here.

---

## 5. THE FACE

### 5.1 ⚠ `divisor` BECOMES A REAL PARAM — the one genuine contract change in this wave

```ts
export const CLOCK_DIVISORS = [24, 12, 6, 3, 1] as const;   // midiclock.ts:80
export function divisorLabel(d: ClockDivisor): string {      // :88-94
  if (d === 24) return '1/4';
  if (d === 12) return '1/8';
  if (d === 6)  return '1/16';
  if (d === 3)  return '1/32';
  return 'raw';
}
```

A named roster, a label function, a validator (`isValidDivisor`, `:83-85`) and a
default (`DEFAULT_DATA.divisor = 24`, `:129-132`) — every ingredient of a `ParamDef`,
already exported, already tested. The declaration:

```ts
params: [
  {
    id: 'divisor', label: 'Div', defaultValue: 24,
    min: 1, max: 24, curve: 'discrete',
    options: CLOCK_DIVISORS.map((d) => ({ value: d, label: divisorLabel(d) })),
    optionsExhaustive: { why: '…' },
  },
],
```

Four things about that, each measured:

**(a) ⚠ `optionsExhaustive` is REQUIRED, not optional polish.** `types.ts:433-445`
states the rule: a discrete param's reachable values are its integer steps, and
`param-vocabulary` *"requires a roster to name EVERY one of them — its stated reason
being that a roster that skips one leaves a state the dial can reach and the picker
cannot name."* `divisor` spans 1..24 and names five. Without `optionsExhaustive` the
declaration is RED.

**And the precedent is the same instrument.** `types.ts:443-445` names it: *"`cvBuddy.ppqn`
is the case this exists for — a clock divides by 1, 2, 4, 8, 12, 24 or 48 pulses per
quarter note, and the forty-one integers in between are not 'unnamed states', they
are values the [clock cannot use]."* midiclock's 19 in-between integers are the same
kind of nothing. **Write the `why` for this module rather than copying cvBuddy's** —
it is required by the type and reviewed.

**(b) The labels do NOT trip the numeric-label gate. Measured.**
`face-readout-source.test.ts:572-574`:

```ts
function looksNumeric(label: string): boolean {
  return /^[+\-−]?[0-9]+(\.[0-9]+)?\s*[a-zA-Z%°¢×x]{0,3}$/.test(label.trim());
}
```

`'1/4'` fails it (`/` is outside the trailing character class and `$` demands the
end), and so do `'1/8'`, `'1/16'`, `'1/32'`; `'raw'` fails the leading `[0-9]+`.
**No `NUMERIC_LABEL_EXEMPTIONS` entry is needed** — checked rather than assumed,
because the wrong answer here would have been a spurious exemption in a list whose
own header says *"POPULATE IT FROM A SWEEP, NOT FROM THE RED LINE"* (`:328-338`).

**(c) The engine must learn `setParam`.** `midiclock.ts:393` is
`setParam() { /* no AudioParam-style knobs */ }`. It becomes:

```ts
setParam(id, v) { if (id === 'divisor' && isValidDivisor(v)) setDivisor(v); },
readParam(id)  { return id === 'divisor' ? divisor : undefined; },
```

reusing the existing `setDivisor` (`:364-368`), which already re-zeros `tickCounter`
— the behaviour that keeps a mid-song division change landing on a clean edge.

**(d) ⚠ THE MIGRATION, and it is the one way a saved patch can regress.** Existing
racks hold `node.data.divisor`; new ones hold `node.params.divisor`. The factory
reads `savedData.divisor` at `:184-187`. **Read order must be `params` first, then
`data`, then the default:**

```ts
const fromParams = (node.params as {divisor?: unknown} | undefined)?.divisor;
let divisor: ClockDivisor =
  isValidDivisor(fromParams) ? fromParams
  : isValidDivisor(savedData.divisor) ? savedData.divisor
  : DEFAULT_DATA.divisor;
```

⚠ **Do NOT write the migrated value back to `node.data`, and do not delete the old
key.** `types.ts:467-469` states the rule this follows: *"A silent engine-side repair
of a data-integrity bug is indistinguishable from no bug."* The legacy key is read
and ignored thereafter; the first ordinary tagged write of the param is what makes
the new shape durable. **A round-trip test over a v-old fixture is a must-verify**
(M3, §13).

**(e) The contract moves.** `contract-lock.txt:1722-1726` currently lists midiclock's
four outputs and **no param lines**. Adding `divisor` adds one. So
`flox activate -- task docs:accept` produces a **real, expected** diff that must be
read and accepted — unlike picturebox's, where an empty diff is the correct outcome.

### 5.2 THE DEVICE PICKER GOES IN THE BODY — and the gap that keeps it there is ONE PARAMETER WIDE

matrixMix's spec (§5.1) shows that a runtime roster *can* be a face cell:
`ShellSelectorCell.options` is `(node: ModuleNode | undefined) => SelectorOption<string>[]`
(`shell-cells.ts:154-160`), a function evaluated per render, and a cell-actions module
may import the graph directly (`kria-cell-actions.ts:29`).

**midiclock's roster is not reachable that way**, and the reason is precise:

```
midiclock.ts:204-221   snapshotState() → devices: [...access.inputs]
midiclock.ts:395-399   read(key) { if (key === 'card-api') return cardApi; … }
```

The device list lives on the **engine handle**, behind `requestMIDIAccess()`. A
selector cell's `options` receives only `node` — no engine. Meanwhile
`ShellActionCell` **does** get an engine: `ShellCellEnv` is
`{ engine: { write(node, key, value) } | null; node }` (`shell-cells.ts:164-176`),
typed structurally *"so shell-cells never pulls the whole PatchEngine import chain."*

⚠ **So the platform gap is that `ShellSelectorCell.options`/`value` take `node` where
`ShellActionCell` takes `env`.** That is a genuinely small, well-argued platform ask
— one parameter, matching a shape the same file already has — and it would unblock
the device picker for **midiclock, midiCvBuddy, midiOutBuddy, chromaconsole,
outToLaunch, audioIn and cameraInput** at once, which is most of the binder cohort.

**This spec does NOT ask for it and does not depend on it.** The picker goes in the
`fullViewBody`, which is the shipped cameraInput answer: `legacy-fallback.ts:83-87`
records that its picker *"moved into the faceplate's EXTENSION BODY
($lib/ui/modules/cameraInput/CameraInputOutputBody.svelte), which is the one slot
that can hold a control no `ParamDef` can express."* Recorded here as the wave's
**routing call**, because it is a better first candidate than wave 2's `nodeId`-on-glyph
proposal: smaller, already half-implemented in the neighbouring interface, and with a
larger and more clearly-defined set of waiting adopters.

**The CONNECT gesture is different and does NOT wait for that.** It is an
`ShellActionCell` with `mode: 'trigger'` (`shell-cells.ts:273`), and it needs no
engine `write` seam at all — `read(node, 'card-api').connect()` is reachable from a
nodeId plus the engine the env already carries. ⚠ And unlike cameraInput, **midiclock
needs no status registry**: cameraInput had to build `camera-status-registry` because
its card is kept alive off-screen and an off-screen host is `pointer-events: none`
(`legacy-fallback.ts:88-96`). midiclock's card is not kept alive at all — the face
talks to the engine directly.

### 5.3 RANK — `face.order`

```ts
face: {
  glyph: 'none',                               // mandatory — §4
  order: ['divisor', 'midiclock-connect'],
  extension: 'midiclock',
},
```

* `divisor` — a ranked param cell. Five options ≤ `SEGMENTED_MAX_OPTIONS = 6`
  (`shell-control-kind.ts:128`), so it resolves to a **`segmented`** cell: all five
  divisions visible at once, which is right for a control whose whole job is "which
  of these five". No `paramCells` override is needed and none is declared —
  `paramShapedCellKind` derives it.
* `midiclock-connect` — a `ShellActionCell` registered under a `midiclock:` block in
  `shell-cells.ts` (the registry is keyed module type → exact `face.order` key,
  `:453-460`).

Completeness: one param, one ranked key (`module-face-lint.test.ts:339`); no
`controlFamilies`; no `noUserControl` needed — `divisor` is exactly the kind of param
a player *should* control.

⚠ **The action cell needs a probe** and this is the case CLAUDE.md names: *"An
ACTION-shaped cell needs a probe, exactly like a PANEL does."* `connect()` writes
nothing to the graph — it grants MIDI access — so `readParam`/`readData` are
structurally blind to it. The observable is `cardApi.getState().connected` flipping
false→true. `shellActionProbes` (`shell-cells.ts:1876-1885`) is where that is
declared, and it must be a real read of that state, not a revision counter.

### 5.4 BANDS AND WIDTH — one band, no rail, no hatch

Two ranked cells is one band. `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:101`),
applied at `:142`. **No tab rail**, and `face.tabbed` is OWNER-INSTRUCTION ONLY
(`types.ts:1048-1069`, one adopter: `spirographs`). Nothing is padded.

`face-width-source.test.ts`'s `PLATE_FLOOR_EXEMPTIONS` is empty (`:88`) and midiclock
adds nothing to it. The legacy card is **200 px** wide (`MidiclockCard.svelte:161`);
the body's widest element is a device `<select>`, comfortable at ~280 px. Compact by
construction.

---

## 6. THE BODY — `face.extension: 'midiclock'`, slot `fullViewBody`

`packages/web/src/lib/ui/modules/midiclock/MidiclockDeviceBody.svelte`, registered
via `.../midiclock/shell-extension.ts`. `fullViewBody` is wired
(`shell-extensions.ts:124`), takes `nodeId` (`:57-59`), and leaves the ranked cells
intact (`:83-87`). Never `editorSurface` — declared, unwired (`:65-69`), and a
`<select>` is not *"a control that is not cell-shaped at all"*.

Two states, mirroring the card's own `{#if !cardState.connected}` split (`:109-155`):

**pre-connect** — the one-time-per-origin hint (`:121`), and the access-failure
message when there is one. ⚠ **Keep it LOUD.** The card's comment at `:114-116` is
the reason: *"The old copy was a one-line hint swap that a user reading a dead button
did not register — and the suppressed-prompt case produced NO message at all."* That
message comes from the shared `midiOutcomeMessage` seam (`:318`), which *"ALWAYS
yields a nameable outcome, including the case where the browser silently declined to
show a prompt at all"* (`:309-310`). It is an error, not resting derived state, and
§7 keeps it.

**post-connect** — the DEVICE `<select>` over `cardState.devices`, subscribed exactly
as the card does (`:52-62`) with the same `onDestroy` unsubscribe (`:63`).

⚠ **The body must own its subscription and release it.** The card's `$effect`
teardown (`:58-61`) plus `onDestroy` is the pattern; a body that subscribes without
unsubscribing is the card-unmount-kills-node-resources class from the other side.

---

## 7. RESTING TEXT — two readouts removed, and this is what loses its surface

`face-resting-text-source.test.ts` denies the SHAPE: every `ModuleFace` field must
carry a declared role in `FACE_FIELDS` (`:128-248`), and the permitted resting text
is exhaustively the module NAME, TAB/SECTION labels, CONTROL CAPTIONS, and
OPTION/LANDMARK NAMES (`:44-52`).

The card paints two readouts (`MidiclockCard.svelte:143-154`):

| card text | face | why |
|---|---|---|
| `STATE — RUN / STOP` | **removed as painted text** | a state word about the module. The ruling's mechanism #3 (the hero readout strip) was exactly this shape. |
| `TICKS — <n>` | **removed as painted text** | a raw count. And see D2 — it does not work anyway. |
| the access-failure message | **kept** | an error, not resting derived state |
| the pre-connect hint | **kept** | instructional copy in an empty state |
| `DEVICE` / `DIV` labels | **kept**, as the cells' captions | CONTROL CAPTIONS |

Both removals go to `aria-valuetext` on the controls they describe, which is what
every spec proving a face tracks its module already reads — so no assertion is
weakened to survive the removal.

⚠ **DELETING A READOUT DELETES A FINDING. Here is the one.**

`STATE: RUN/STOP` is currently the only place in the entire product that shows
whether the **external** transport is running. It is not redundant with TIMELORDE's
own transport: the whole point of this module is that something outside the browser
is the boss, and `run` is a level a user may not have patched anywhere visible.

**Where it goes instead, and what is refused:**

* **`aria-valuetext`** on the CONNECT action cell — *"connected · transport running"*
  / *"connected · transport stopped"* / *"not connected"*. Speakable, assertable,
  unpainted. This is the required home.
* ⚠ **An `activity` glyph is REFUSED here.** §4 shows there is no such glyph kind and
  midiclock is a good argument for one. **Inventing a sixth `VALID_GLYPHS` member on
  a module PR is exactly the kind of platform change this program keeps refusing**
  (and the owner has ruled against adding machinery). Recorded as an argument, not
  built.
* **What is NOT refused, and is worth the build lane's attention:** the CONNECT cell
  is a `<Button>` with `aria-pressed`, and a *non-text* connected/disconnected
  affordance on that button is a control's own state, not a readout. That is inside
  the ruling. It is the honest way to keep "is this thing alive" glanceable, and the
  mockups show it.

---

## 8. THE #2166 CLASS — two fixture specs break, and one of them names the reason it will

**Not** in `_face-fixtures.ts`'s `DENIED` map (`:67-96`). **Not** in
`LEGACY_DOCK_CANDIDATES` (`workflow-rear-card.spec.ts:738`).

**SUBJECT:** `midiclock.spec.ts` (`:13`, `:20`, `:29`, `:39`) — four tests, all
legacy-card-coupled (`:15` `page.locator('.svelte-flow__node-midiclock')`, `:17`
`toContainText('MIDICLOCK')`, `:20` *"Connect MIDI… button is visible + interactive"*).
A straightforward rewrite against the face, and the CONNECT test gets *stronger*,
because the button moves out of the dock-only card (§0.2).

**FIXTURE — the one that will break:** `midi-autobind-perfzip.spec.ts:103`,
*"midilane + midiclock re-attach to their saved device on load — no per-card click"*.
Its subject is the perf-zip MIDI auto-bind, and it drives midiclock's card DOM to get
there:

* `:118` `await clkCard.getByRole('button', { name: /Connect MIDI/ }).click();`
* `:124` `await clkCard.locator('select').first().selectOption(MOCK_ID);`

⚠ **Both break, and the second is the interesting one.** `.locator('select').first()`
is positional — it works today because the card has exactly two `<select>`s in a
known order (DEVICE at `:126`, DIV at `:136`). After the face, DIV is a segmented
param cell and is not a `<select>` at all, so `.first()` would silently resolve to a
*different* control if any select were added. **Re-point it at the body's device
select by testid, not by position** — the positional selector is a latent
wrong-element bug independent of this promotion.

**FIXTURE — survives untouched (wire-only, never the DOM):**
`timelorde-transport-state.spec.ts:159` (its header at `:15` names midiclock as the
external transport that hides TIMELORDE's RUN button — it patches
`midistart`/`midistop` and nothing else), `clipplayer-controls.spec.ts:96` (currently
`test.fixme`, FLAKE-PARK #1847), `workflow-surfaces.spec.ts:31`/`:275`/`:284` and
`audio-in.spec.ts:281` (the `pinned-midiclock` roster — §0.3, out of scope),
`workflow-mode.spec.ts:204-205` (counts pinned survivors; midiclock is counted, never
named in code).

⚠ Note `midi.spec.ts:399-511` — those are `__midiClockSource`, the engine-side clock
source, **not** this module. A grep for `midiclock` hits them and they are not usages.

**Per-module sweeps** (all keep their entries — a face does not make a MIDI device
appear on CI):
`_per-module-per-port-shared.ts:267` (`EXEMPT_OUTPUT_EMIT_MODULES` — *"clock/midistop
pulses are sub-frame gates; scope polls miss the edge"*) and `:541`
(`PINNED_MODULE_EXEMPT_KEYS`); `per-module-per-port-behavioral.spec.ts:160`;
`per-module.spec.ts:60`. And `_per-port-drivers.ts:726` has a **real driver** — see §9.

---

## 9. ⚠ VRT — THE EXEMPTION'S EXIT CONDITION ALREADY EXISTS IN THIS REPO

`vrt-exemptions.ts:730`:

> `midiclock: 'card content depends on connected MIDI device; unit + E2E provide coverage',`

with `ALLOWED_PERMANENT_EXEMPT` membership at `:1169` and the reasoning at `:726-729`:

> *"MIDICLOCK: same rationale as midiCvBuddy — pre-Connect state shows a 'Connect
> MIDI…' button **(deterministic)** but post-connect the device list depends on
> hardware that isn't present in CI."*

The exit condition is stated in a third file — `art/DETERMINISM.md:75`:

> *"**MIDI device list** — varies across CI runners. HELM + MIDICLOCK + MIDI-CV-BUDDY
> specs **mock the MIDIAccess API**; cards depending on device state are
> EXEMPT_FROM_VRT **until a deterministic stub lands**."*

⚠ **The deterministic stub landed. It is in this repo. It was built for a different
sweep and nobody carried it back.** `e2e/tests/_per-port-drivers.ts:726` declares a
midiclock driver under the header *"MIDICLOCK — mock requestMIDIAccess + post clock
messages"*, with the note at `:811`: *"MIDICLOCK: mock requestMIDIAccess + pump 0xFA
+ 360×0xF8 spread over 700ms; clock/run/midistart pulse."* The same sentence in
`DETERMINISM.md` even says the specs already mock MIDIAccess — it just does not
connect that to its own exit condition.

**So the exemption is discharge-able**, and there are two honest levels:

1. **The cheap one, and the one this PR should take.** The exemption's own text
   concedes the **pre-Connect state is deterministic**. A promoted midiclock's face
   captured before connect is a segmented DIV cell plus a CONNECT action cell — no
   device list in frame at all. That is stable, module-specific and needs no mock.
2. The fuller one — a post-connect baseline over the mocked roster — is a bigger
   change (the VRT harness would have to install the driver's mock) and is **not**
   this PR.

`ALLOWED_PERMANENT_EXEMPT`'s header is explicit that this is expected:
*"NOT AN ENDORSEMENT … Membership records that a module was exempt on the day the
brake landed"* (`:1144`), *"the set only ever SHRINKS BY NAME"* (`:1137`), and
`:1158-1160` records `cvBuddy` being removed on 2026-08-20 as the shipped precedent.

**The face PR deletes `midiclock` from `EXEMPT_FROM_VRT` AND from
`ALLOWED_PERMANENT_EXEMPT`** — `vrt-meta.test.ts` asserts the two sets equal in both
directions (`:1131-1132`), so a one-sided delete is red.

⚠ **But only if the pre-connect capture is genuinely reachable.** If
`workflow-shell-faces.spec.ts` cannot guarantee a not-yet-connected state — and on a
runner with no MIDI at all it should be the only reachable state — **keep the
exemption and say why in the PR body** rather than pinning a baseline over a
device list. `midiCvBuddy`, `midiOutBuddy` and `midiLane` sit in the same two lists
for the same stated reason; whichever way this goes, it is the precedent for three
more.

**No baseline exists today** (no `midiclock` PNG anywhere under `e2e/`), so promotion
**adds two and moves none**. Dispatch scoped, predict two, count what the bot commits.

---

## 10. COST

### 10.1 WEBGL ATTEST — ZERO. MEASURED.

```
flox activate -- bash scripts/webgl-attest-hash.sh --list | grep -i midiclock
  (no output)
```

The 218-file basis is essentially all of `packages/web/src/lib/video/**` plus
`cube` / `wavesculpt` and four configs. **Nothing under `audio/modules/` except
`cube.ts` and `wavesculpt.ts`**, and no `MidiclockCard`. The def edit in §5.1 is real
code (a new `ParamDef`, a `setParam` body) and it is still free, because the file is
not in the basis.

⚠ Contrast with `../picturebox/spec.md` §10.1, where the identical edit would cost a
GPU window. The difference is the directory, not the change — worth carrying, because
"a face PR is attest-free" is true for two of this wave's three modules and false for
the third.

### 10.2 ART — ZERO, and DECLARED rather than absent

* `ls art/baselines/` — no `midiclock/` directory.
* midiclock **is** in `ART_EXCLUDED`: `art/setup/profile-coverage.ts:37` —
  `midiclock: 'live MIDIAccess device stream — no deterministic offline source',`

That entry is required rather than incidental: the contract golden records
`midiclock meta domain=audio` (`contract-lock.txt:1722`), so the audio-profile gate
**does** enumerate it (`art/scenarios/_meta/audio-profile-gate.test.ts:77-88`) and
would demand a baseline without the exclusion.

⚠ **The exclusion stays.** §5.1 adds a param, not an audio-family output; the module
still has no deterministic offline source. **`art/` should be absent from this diff**
— and if `task art` is run, confirm the exclusion still covers it rather than assuming.

### 10.3 CI wall-time

New: two VRT face captures (dispatched), one unit file
(`midiclock-face-model.test.ts`), one migration round-trip test (M3), and
`midiclock.spec.ts` rewritten in place. **Estimated delta under 2 minutes.**

### 10.4 ⚠ THE PUSH 2 CARD MOVES, AND THIS TIME IT MOVES ONTO A MODULE THAT HAD NONE

CLAUDE.md: *"adding or renaming a param on any module can silently change that
module's push card — the tiers re-rank themselves."* midiclock has **zero** params
today, so it has no push card at all; after §5.1 it has one param, and
`push-card-schema.ts` will resolve a card from the live def.

That is almost certainly desirable — a hardware clock divider on a hardware
controller — but it is a **new surface appearing**, not an existing one shifting, and
it must be in the PR body. `push-card-schema.test.ts` is a must-run (§14).

Also newly reachable, from the same one declaration: group exposure
(`group-controls.ts:71-104`), clip automation, and MIDI learn. None needs work; all
three follow from the param existing. Say so — a reviewer should not have to derive it.

---

## 11. DEFECT LEDGER — live on `main`, independent of any face

| # | defect | evidence | routing |
|---|---|---|---|
| **D1** | ⚠ **Every setting is outside Cmd-Z.** `writeData` is a bare proxy write — no `transact`, no `LOCAL_ORIGIN` — and both the device pick and the division go through it. Invisible to `mutate.guard` (its regex anchors on `.params`) and unledgered. | `MidiclockCard.svelte:71-79`, `:84`, `:91`; `mutate.ts:13-18`; `store.ts:70` | **fix in this PR** — §0.4 |
| **D2** | ⚠ **The "live activity indicator" cannot update while there is activity.** `midiclock.ts:118-120` says *"Card uses this to paint a live activity indicator"*, and `:264-266` deliberately skips `notify()` on every clock tick (*"Card has its own rAF for the activity LED"*) — **but the card has no rAF.** `notify()` fires only on START / CONTINUE / STOP / connect / device / divisor changes, so `TICKS` shows the count as of START, sits frozen for the whole performance, and jumps at STOP. | `midiclock.ts:257-266` vs `MidiclockCard.svelte` (no `requestAnimationFrame` anywhere) | **fix in this PR** by REMOVAL — §7 deletes the readout, and the surviving `aria-valuetext` is transport state, which `notify()` does deliver correctly. ⚠ The PR body must say the readout was removed **because it was broken as well as because the ruling forbids it** — otherwise a future reader restores it. |
| **D3** | **The migration inventory describes an affordance that does not exist.** `face-migration-inventory.ts:851-857` says midiclock is *"a MIDI CLOCK BINDER: permission gesture, live device roster, clock divisor and **a running tempo readout**"*. No tempo is computed anywhere in the module — the card shows STATE and TICKS, and no BPM is derived from the tick stream. | `midiclock.ts:204-221` (`MidiclockCardState` has no tempo field); `MidiclockCard.svelte:143-154` | **fix in this PR** — the entry is rewritten anyway when the disposition changes to `generic-face` |
| **D4** | **The CONNECT gesture is dock-only under the default shell.** An un-migrated module is a `moduleShellPlaceholder` in the lane, so granting MIDI access requires opening the dock full view — on a module whose entire function is unavailable until you do. | `legacy-fallback.ts:143-146`; `MidiclockCard.svelte:65-69` | **fixed by the face** — the CONNECT action cell is in the lane tile (§5.3) |
| **D5** | **A silent device disappearance.** `access.onstatechange` (`:333-341`) deliberately keeps `selectedDeviceId` when the device vanishes (*"Keep selection so it reattaches on hot-plug"* — correct), but nothing tells the user. The `<select>` binds `value` to an id no longer in `devices`, so it renders blank. | `midiclock.ts:333-341`; `MidiclockCard.svelte:126-131` | ⚠ **NOT this PR** — the fix is a new state word in the body, which needs the §7 ruling applied thoughtfully rather than in passing. Recorded so it is not lost. |
| **D6** | ⚠ **A positional selector in a fixture spec** — `.locator('select').first()` — that happens to be right today. | `midi-autobind-perfzip.spec.ts:124` | **fix in this PR** — §8 |

⚠ **What is NOT a defect, checked and recorded.** The `divisor` living in `node.data`
rather than in `params` looked like a straightforward bug. It is not: the def
*argues* for it at `:162`, and the argument is correct about AudioParams. It is wrong
only about faces, and only because faces did not exist when it was written. §5.1
overturns a reasoned decision, not an oversight, and the PR body should say so.

---

## 12. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| `divisor` becomes a param | delete the `ParamDef`, restore `writeData({divisor})` |
| DIV renders `segmented`, not `selector` | add `paramCells: { divisor: … }` — ⚠ but `'segmented'` is not an `AuthoredParamCell` (`shell-control-kind.ts:119`), so the revert is to shorten the roster or accept the derived kind |
| CONNECT is a ranked action cell rather than body-only | drop it from `order`, move the button into the body |
| the device picker is body-only | — (blocked by §5.2 until `options` takes an `env`) |
| DIV ranks before CONNECT | swap the two strings |
| no tab rail, no `activity` glyph | — (both need an owner instruction) |

---

## 13. MUST-VERIFY (before the face is written)

* **M1 — D2 is real.** Instrument `notify()` and drive the module with the existing
  `_per-port-drivers.ts:726` mock (0xFA then 360×0xF8 over 700 ms). Assert
  `ticksReceived` climbs on the engine while the subscriber callback fires **only** on
  the transport messages. ⚠ Count **in the page**, not from a Playwright poll loop —
  "frozen" and "never looked" are indistinguishable from the output otherwise, and
  this defect's whole shape is "frozen".
* **M2 — the segmented cell is what actually renders.** `divisor` spans min 1 max 24
  with five options; confirm `paramShapedCellKind` returns `'segmented'` and not
  `'knob'`, and that all five labels paint. ⚠ Do not infer it from
  `SEGMENTED_MAX_OPTIONS` — read the resolver.
* **M3 — the migration round-trips.** Load a fixture rack whose midiclock node has
  `data.divisor = 6` and no `params.divisor`; assert the engine divides by 6, the
  face shows `1/16`, and **`node.data.divisor` is not rewritten or deleted** (§5.1(d)).
  Then change the division and assert the new value lands in `params` and rides undo.
* **M4 — the CONNECT action probe reads state, not a revision.** Drive the negative
  control: an action cell whose handler does nothing must fail the probe. A
  revision-only probe passes on a dead button.
* **M5 — the pre-connect VRT capture is reachable** from `workflow-shell-faces.spec.ts`
  with no device list in frame (§9). If not, the exemption stays and the PR says why.

---

## 14. VERIFICATION GATE

```bash
# 1. the face model + the migration round-trip + this face's negative controls
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/midiclock-face-model.test.ts \
  packages/web/src/lib/audio/modules/midiclock.test.ts

# 2. face lint + the promotion anchor (both directions)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/module-face-lint.test.ts

# 3. the rulings' source gates — ⚠ #1 matters here: the divisor LABELS (§5.1b)
flox activate -- npx vitest run \
  packages/web/src/lib/ui/controls/face-readout-source.test.ts \
  packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts \
  packages/web/src/lib/ui/dock/face-width-source.test.ts

# 4. the param vocabulary gate — optionsExhaustive is REQUIRED here (§5.1a)
flox activate -- npx vitest run packages/web/src/lib/ui/workflow/param-vocabulary.test.ts

# 5. the registries + shared-file neighbours + the NEW push card (§10.4)
flox activate -- npx vitest run \
  packages/web/src/lib/ui/workflow/shell-extensions.test.ts \
  packages/web/src/lib/ui/workflow/shell-cells.test.ts \
  packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts \
  packages/web/src/lib/ui/modules-card-map.test.ts \
  packages/web/src/lib/control/push2/push-card-schema.test.ts

# 6. the CV/param surface — adding a param touches more than it looks like
flox activate -- npx vitest run packages/web/src/lib/audio/

# 7. e2e — the SUBJECT, the FIXTURE that breaks, and the two that must NOT move
flox activate -- task e2e:one -- midiclock
flox activate -- task e2e:one -- midi-autobind-perfzip
flox activate -- task e2e:one -- timelorde-transport-state
flox activate -- task e2e:one -- workflow-mode

# 8. per-port sweeps — midiclock keeps its exemptions; prove they still apply
flox activate -- task e2e:one -- per-module-per-port

# 9. VRT exemption set-equality — a one-sided delete is red (§9)
flox activate -- npx vitest run packages/web/src/lib/audio/modules/vrt-meta.test.ts

# 10. docs contract — ⚠ EXPECT A REAL DIFF (§5.1e). Read it, then accept it.
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
#     Expected: exactly ONE new line, `midiclock param divisor …`. Anything else, stop.

# 11. typecheck LAST
flox activate -- task typecheck

# 12. flake-check the new/changed specs 3× before pushing
REPEAT=3 flox activate -- task e2e:one -- midiclock

# 13. VRT: dispatch only, SCOPED, predict TWO files, COUNT them. NEVER commit a PNG.
GREP=midiclock flox activate -- task vrt:commit

# 14. attest: NIL (§10.1).
```

---

## 15. VERDICT, RISK, ESTIMATE

**PROMOTE.** One PR. No precursor, no platform change, no new seam, zero attest,
zero ART, two VRT baselines added and — if M5 holds — a permanent exemption
discharged for the first time in the binder cohort.

It is the wave's best *value* pick: the face is small, and it arrives carrying a
param that has never existed (so the clock division becomes automatable,
MIDI-learnable and Push-2-reachable for free), a connect gesture that stops being
dock-only, and three live defects fixed — including one where the module's own
comment promises a live indicator the card never implemented.

**Risk: MEDIUM**, concentrated in exactly one place: **§5.1 is a contract change.**
Everything else in this wave is additive-and-invisible; this declares a module's
first param, moves `contract-lock.txt`, creates a Push 2 card where there was none,
and migrates a value out of `node.data`. The migration is the one way a saved patch
can regress, and M3 is the guard.

⚠ The pinned instance (§0.3) is a *named non-goal*, not a risk that was missed. The
fleet already ships a promoted module (`timelorde`) whose pinned instance renders a
bespoke topbar surface, and #2173 repaired only one of the three surfaces. That is
the wave's largest open platform question and it belongs to the owner, not to a
module PR.

**Estimate: ≈ 13 h** — the def change and its migration ≈ 3 h, the two cells plus the
action probe ≈ 2 h, the body ≈ 2 h, `midiclock.spec.ts` rewritten plus the
`midi-autobind-perfzip` selector fix ≈ 3 h, the unit + migration tests ≈ 2 h, the VRT
exemption discharge ≈ 1 h.

**Build it LAST in the wave** — after `matrixMix` (cheapest, carries a precursor
others wait on) and `picturebox` (settles the lane picture). It is the only one of
the three that changes a contract, and the one whose defect fixes deserve an
unhurried read rather than being the third thing in a batch.
