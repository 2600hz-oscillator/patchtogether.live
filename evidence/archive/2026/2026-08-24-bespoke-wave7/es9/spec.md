# `es9` — FACEPLATE SPEC (wave 7, cohort B, agent C)

**Nothing here is implemented. This is a spec.**

Everything below is measured against `origin/main` at `99a961b08`
(`fix(wavesculpt): the FACE BODY stole the video_out drawer at MOUNT … (#2190)`).
Every claim carries its `file:line`.

---

## 0. THE HEADLINE — **`es9` IS NOT A BESPOKE SURFACE. It is a `kria`-style GENERIC-FACE promotion, and it needs even less than `kria` did.**

The inventory says (`face-migration-inventory.ts:800-806`):

> the ES-9 BRIDGE: connection state machine, connect/disconnect gestures, device
> rate and channel-count detail, xrun/rtt telemetry, and sectioned routing across
> many jacks. **The params are routing, the surface is the bridge.**

Taken clause by clause against `Es9Card.svelte` (260 lines) and `es9.ts` (451 lines),
**four of the five clauses name things the resting-text ruling DELETES, and the fifth
is twenty-two ordinary `ParamDef`s.**

| the `why`'s clause | what it actually is | on a face |
|---|---|---|
| "connection state machine" | `stateLabel`, a 7-way string switch (`Es9Card.svelte:155-165`) painted as one `<span class="state">` (`:178`) | **DELETED as text.** Two `StatusLed` lamps (§4) |
| "connect/disconnect gestures" | two `<button>`s calling `restartEs9Bridge` / `stopEs9Bridge` (`:180`, `:182`) | **two ordinary `ShellActionCell`s** — the shipped `midiclock-connect` shape (`midiclock-cell-actions.ts`) |
| "device rate and channel-count detail" | `{device.rate/1000} kHz · {in}×{out}` (`:187`) | **DELETED.** `detail` → `aria-label` (§4) |
| "xrun/rtt telemetry" | `rtt {n} ms` / `xruns {u}/{o}` (`:188-189`) | **DELETED as text.** An `XRUN` lamp, `tone="warn"` — the *exact mirror* of `cvBuddy`'s `LATE` lamp, which already names this readout as its diagnostic partner (§4.4) |
| "sectioned routing across many jacks" | 22 `0..3 discrete` `ParamDef`s (`es9.ts:281-302`) | **22 ordinary param cells.** Nothing bespoke — they are already in `contract-lock.txt:1060-1082` as plain discrete params |

**What is left that a GENERIC face cannot do?** Exactly one thing: there is nowhere on
a generic faceplate to mount a `StatusLed`. `StatusLed` is only ever rendered from a
module-owned `fullViewBody` — measured, the entire caller set in `packages/web/src` is
`CvBuddyStatusBody.svelte` and `MidiclockDeviceBody.svelte` (`git grep -l StatusLed
origin/main -- packages/web/src`; every other hit is the primitive, its model, or a gate).

So `es9` needs a `fullViewBody` whose role is **`status-primitive`** — the *same role,
built from the same primitive, in the same shape* as the two bodies already on `main`.
That is a shipped generic pattern with two adopters, not a bespoke surface.

**Compare `kria`, the precedent the brief names.** Its entry now reads
(`face-migration-inventory.ts:829-838`): *"PROMOTED. The step grid IS the module, and it
was the reason this entry read 'bespoke-surface' — but it fits a PF-14 PANEL … Nothing
here is bespoke except the grid picture itself."* `kria` still needed a **bespoke panel
component**. **`es9` needs no panel at all** — its body is two lamps and two buttons.
It is therefore a *weaker* bespoke claim than the one already overturned.

> **VERDICT: PROMOTE-WITH-PRECURSOR, and RE-DISPOSITION the inventory entry to
> `generic-face` with a `note` in the same PR.** The precursor is §11's P0: promotion
> deletes the only caller of `updateEs9Config` in the tree.

### 0.1 ⚠ WHAT WOULD MAKE `es9` DRAINABLE FROM `ALLOWED_PERMANENT_EXEMPT` — one line

> **DELETING THE STATUS TEXT.** `es9`'s exemption is not a device-dependence claim at all
> — `vrt-exemptions.ts:451-457` says the card *"IS baseline-able"* and blames only a
> missing capture pass. Its ONE non-deterministic pixel region is `stateLabel`
> (`Es9Card.svelte:155-165`, painted at `:178`), which cycles `connecting…` ↔
> `bridge not found` on the transport worker's reconnect backoff. **The face deletes that
> text by ruling** (§4 rows 1-4), leaving two permanently-dark `StatusLed` lamps, a static
> empty-state hint, 22 param cells and a silent meter — **every pixel a function of the
> code, none of it of the runner's hardware.** So the drain is not a bet the face takes;
> it is a consequence the face produces. The **legacy card's** row is the only remaining
> question, and §9.2 answers it with a named `VRT_MODULE_MASKS` entry over the status row.
> **No `FACES_WITHOUT_SCENES` entry is warranted** (`_shell-faces.ts:3472`) — that list is
> for a genuinely non-deterministic *renderer*, and es9 has none.

### 0.2 ⚠ WHICH SIDE OF THE `NON_SHELL_LANE_TYPES` SPLIT — one sentence

> `es9` is **NOT** in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:109-124`; asserted by
> name at `legacy-fallback.test.ts:187`), so `hasCard` is true and `migrated` is false and
> `laneRenderKind` (`:156-160`) returns **`'placeholder'`** today — a RACKLINE tile with
> **no ranked controls at all** (`ModuleShellPlaceholder.svelte:1-10`: *"differing only in
> the body (no ranked knobs until the module gets a `face`)"*), whose real card opens only
> through the dock full view. **So promotion's entire user-visible lane effect is "which
> ranked cells appear on a tile that currently has none" — and on `es9` that is the
> cohort's biggest such change**, because it is the only member with real params: 22
> routing params plus two gestures arrive where there is presently a bare spine, a name
> and a glyph. It is #2187's headline (*"the CONNECT gesture was DOCK-ONLY on a module
> that is inert until it is pressed"*) with a much larger tail.

---

## 1. WHAT THE MODULE IS, AND WHERE ITS STATE LIVES

`es9.ts:206-311`. `domain: 'audio'`, `label: 'es-9'`, `category: 'utilities'`,
`maxInstances: 1`, `size: '3u'`, `hp: 3`, palette `Audio modules / I/O`.

* **16 inputs** — `out1..out8` (`type:'audio'`, `accepts:['cv','pitch','gate']`, the
  physical DC-coupled jacks on USB channels 9-16) and `usb1..usb8` (plain `audio`, the
  ES-9's internal mixer / S-PDIF / ES-5 feeds). `es9.ts:218-245`.
* **30 outputs** — `in1..in14` raw `audio`, `spdif_l`/`spdif_r` `audio`, and
  `in1_cv..in14_cv` `cv` twins. `es9.ts:246-277`.
* **22 params** — `in{1..14}_class` (default 1 = cv) and `out{1..8}_class`
  (default 0 = audio), all `0..3 discrete`. `es9.ts:281-302`.
* **`docs`** — generated by `inputDocs()` / `outputDocs()` / `controlDocs()`
  (`:153`, `:176`, `:191`), plus a 1 400-word `explanation` (`:307`). Already in
  `STRICT_DOCS` (`strict-docs.ts:29`) and `DESCRIPTIONS` (`module-manifest.ts:134`).

### 1.1 ⚠ `es9` WRITES **NO** `node.data`. AT ALL. It is the binder cohort's only pure-param module.

The wave 3→4→5 `.data` raw-write census gets a **fourth column state** from this module,
and it is the trivial one: **n/a — there is nothing to tag.**

Measured: `grep -n "node.data|\.data\b|writeData|mutateNode|LOCAL_ORIGIN|transact"` over
`Es9Card.svelte` returns **zero lines**. The card's only write path is
`const { set, engineCtx } = cardParams(es9Def, …)` (`:43`) → `set(paramId)(v)` (`:86`),
which is the ordinary origin-tagged param seam. The engine side keys the connection by
`nodeId` in a module-level `Map` (`bridge-owner.ts:74`), never on the node.

**Instrument note (per the brief's §VALIDATE):** the grep is a *presence* probe over one
file, so a clean result could mean "no writes" or "wrong file / wrong pattern". Negative
control: the identical pattern run against `MidiLaneCard.svelte` returns 10 lines
(`:91-99` plus 9 call sites — see the sibling spec), and against `MidiclockCard.svelte`
returns `mutateNode` at `:94`. The probe fires. The zero is real.

**Consequence for the census (updating wave 5 §4's running total):**

| module | `.data` discipline | note |
|---|---|---|
| `kria`, `audioOut`, `midiCvBuddy`, `midiOutBuddy` | ✗ untagged | unchanged |
| ~~`midiclock`~~ | ✅ **PAID** | see §1.2 |
| `picturebox`, `matrixMix`, `chromaconsole`¹ | ✓ tagged | ¹ transacts without `LOCAL_ORIGIN` |
| `twotracks`, **`es9`** | n/a | nothing in `node.data` |

### 1.2 ⚠ CORRECTION TO WAVE 5's CENSUS: `midiclock` IS OFF THE UNTAGGED LIST, and the face PR is what paid it — **on BOTH surfaces**

Wave 5 `BINDERS.md §4` lists `midiclock` among *"five modules writing `.data` untagged"*.
That is **stale**. `MidiclockDeviceBody.svelte:113-121` writes through `mutateNode`, and
so does the **legacy card**, `MidiclockCard.svelte:88-97`, whose comment records the fix
verbatim:

> *"This used to go through a local `writeData` helper that assigned straight onto
> `patch.nodes[id].data` — a bare SyncedStore proxy write with no `ydoc.transact` and no
> `LOCAL_ORIGIN` … `mutate.guard.test.ts`'s patterns all anchor on the literal token
> `.params`, and this touched `.data`."*

**The generalisable finding — and it is what `midiLane` should copy:** a face PR is the
natural place to pay a module's `.data` debt, because the body has to write the same keys
anyway, **and the fix must land on the legacy card too** or the two surfaces disagree
about whether picking a device is undoable.

---

### 1.3 ⚠ THE TRANSPORT AXIS — `es9` is the cohort's ONLY member that touches **no browser device API at all**

Measured, not assumed. Every other member of cohort B reaches its hardware through a
browser permission surface (`navigator.requestMIDIAccess`, `navigator.hid`,
`navigator.usb`, `navigator.getGamepads`). **`es9` reaches nothing.** Its transport is:

```
ws://127.0.0.1:9209/ws  ◀──▶  bridge Worker  ◀── SharedArrayBuffer rings ──▶  'es9-bridge' AudioWorklet
   (a separate NATIVE process)   (es9/bridge.worker.ts)                          (packages/dsp)
```
— `es9.ts:19-23`, `bridge-client.ts:50-54` (`es9BridgeUrl()`, a `VITE_ES9_BRIDGE_URL`
override over a literal `ES9_DEFAULT_URL`), `:87-96` (`start(rate, config, url)` spawns the
worker), `es9-ring.ts` (`createRingSpec`).

**Confirmed. And the consequence for a FACE is a different availability story, not a
smaller one:**

| axis | a permission-prompt binder (`midiLane`, `midiclock`) | `es9` |
|---|---|---|
| what makes it available | a **user gesture** the browser can prompt for | a **process the user installed and started**, on a **local origin** |
| when it is attempted | only after CONNECT is pressed | **at node construction**, unconditionally (`es9.ts:378`) |
| on a bridge-less machine | nothing happens; the roster stays empty | a Worker spawns and retries **forever** on a doubling backoff (`bridge.worker.ts`, `scheduleReconnect()`) |
| what the face's empty state must say | *"press CONNECT to grant access"* | *"run the es9-bridge app, then connect"* — a **different sentence about a different world**, which is why row 6 of §4 is kept rather than collapsed into the sibling's |
| the VRT consequence | the non-deterministic state is **unreachable** (§9.2 quotes `_shell-faces.ts` on it) | the non-deterministic state is **the default** — and is deleted by the ruling rather than avoided by the harness (§0.1) |

**This is the sharpest single reason the cohort does not share one device-binding shape**,
and it is a *transport* fact rather than a design preference: a permission is granted
once per origin and then cached; a helper process is either running or it is not, on this
machine, right now, and the module has to keep asking.

### 1.4 ⚠ `es9` IS **CLEAN** ON THE TYPED-ENTRY GATE — and its sibling is not

`face-migration-inventory.test.ts:509-528`'s TYPED-ENTRY leg refuses a `generic-face`
disposition on any module whose **legacy card** mounts typed entry
(`mountsTypedEntry`, `:144-150`: `<NoteEntry>`, `<textarea>`, `contenteditable`, or
`<input type="text|number|url|search|email|tel">`).

`Es9Card.svelte` mounts **no `<input>` of any kind** — its whole control surface is 22
`<select>`s (`:206`, `:223`) and two `<button>`s (`:180`, `:182`). **So es9 is unaffected
by the blocking finding that lands on `midiLane`** (`../midiLane/spec.md §0.3`). Stated
here explicitly rather than left to inference, because the two modules are otherwise
paired and a reader would reasonably assume the problem is shared. It is not: the one
numeric field is the whole difference.

---

## 2. THE PRIMARY INTERACTION

There isn't a bespoke one. There are three ordinary ones, in this priority order:

1. **BRING THE BRIDGE UP** — press CONNECT. Until the native app answers, every jack is
   silent (`es9.ts:307`: *"Without it the module sits silent and harmless in the patch"*).
2. **SET THE OUT-JACK CLASSES** — 8 params. This is the one a player *must* touch,
   because the default is wrong for the common case by design: `es9.ts:279-280`,
   *"Inputs default cv (the modular-native case for the cv twin); outputs default audio
   (bit-transparent)."* Sending a patchtogether LFO to a hardware VCA means changing
   `outN_class` to `cv`; leaving it at `audio` sends full-scale audio into a CV input.
3. **SET THE IN-JACK TWIN CLASSES** — 14 params, already defaulted to the right thing.

**That ranking is the whole face**, and it is derived from the def's own comment rather
than from a look at the card (which lays IN before OUT purely because IN has more rows).

---

## 3. THE FACE

```ts
// es9.ts — co-located, like every other face.
export const ES9_FACE: ModuleFace = {
  glyph: 'meter',                       // §3.2 — the cohort's FIRST reachable live glyph
  extension: 'es9',                     // $lib/ui/modules/es9/shell-extension.ts
  order: [
    'es9-connect-{n}', 'es9-disconnect-{n}',
    'out1_class','out2_class','out3_class','out4_class',
    'out5_class','out6_class','out7_class','out8_class',
    'in1_class', /* … */ 'in14_class',
  ],
  pages: [
    { id: 'bridge', label: 'bridge', hint: '…', controls: ['es9-connect-{n}','es9-disconnect-{n}'] },
    { id: 'out',    label: 'out jacks', hint: '…', controls: ['out1_class', /* …8 */] },
    { id: 'in',     label: 'in twins',  hint: '…', controls: ['in1_class', /* …14 */] },
  ],
};
```

**THREE bands. NO tab rail.** `DOCK_TAB_MIN_BANDS` is 7 (`graph/types.ts`, `tabbed`'s
doc-comment: *"A face with 3-6 honest pages renders as a column, and that is correct"*).
`face.tabbed` is owner-instruction-only and is **not** proposed. Nothing is padded to
reach a rail and nothing is merged to avoid one — three bands is what the module has.

### 3.1 The 22 class params get `options` — at **ZERO** contract cost, and `optionsExhaustive` MUST NOT be declared

Today the params carry no roster (`es9.ts:281-302`), so `paramCellKind` falls through to
`'knob'` (`shell-control-kind.ts:312-317`) and a 4-state routing switch is a dial that
paints nothing. Add:

```ts
export const ES9_CLASS_OPTIONS: readonly ParamOption[] =
  ES9_CLASS_NAMES.map((label, value) => ({ value, label }));   // es9.ts:64 already exports the names
```

on every `*_class` param. Then `paramCellKind` returns `'segmented'` at the dock
(4 ≤ `SEGMENTED_MAX_OPTIONS` = 6, `shell-control-kind.ts:128`, `:314`) and `'knob'` in
the lane, where `paintsReadout` paints the bare option NAME (`audio` / `cv` / `pitch` /
`gate`) — permitted resting text, and `looksNumeric` (`face-readout-source.test.ts:572`)
does not match any of the four, so **no `NUMERIC_LABEL_EXEMPTIONS` entry is needed.**

> ### ⚠ CORRECTION TO THE COMMISSIONING BRIEF — es9 is **NOT** an `optionsExhaustive` case, and declaring it would be **RED**
>
> The brief states *"This is exactly the `optionsExhaustive` SNAP-contract case."* It is
> not, and the gate says so in words:
>
> ```
> if (opts.length === steps) {
>   bad.push(`${type}.${p.id}: roster covers every step (${opts.length}/${steps}),
>             so optionsExhaustive is redundant — delete it`);
> }
> ```
> — `param-vocabulary.test.ts` (the *"an exhaustive roster is SPARSE, in-range, unique
> and fully labeled"* leg).
>
> `0..3 discrete` has `Math.round(3-0)+1 = 4` steps and the roster has 4 members. It is
> **DENSE**. `optionsExhaustive` buys an exemption from the every-step rule; here there
> is nothing to exempt, so the declaration would be *"an exemption nobody needs is one
> nobody is watching"* and the gate refuses it by name.
>
> **And the SNAP contract does not bind either, for a mechanical reason rather than a
> stylistic one.** `snapToOptions` exists because a lane knob over a SPARSE roster can
> land between members (`midiclock`'s divisor: 5 legal values in a 1..24 span, 19
> illegal integers — `midiclock.ts:143-154`). Over a dense 0..3 roster **every reachable
> integer is already a member**, so there is nothing between. No snap, no `why`, no
> exemption. The rule the brief was reaching for still applies to the sibling module —
> and there too the answer turns out to be "dense, so no" (`midiLane/spec.md §5.3`).
>
> This matters beyond es9: the SNAP contract keys on the DECLARATION, not on "the param
> is discrete with options". Three of this wave's modules will be tempted by it.

**Contract cost of adding the rosters: ZERO.** `ContractParamLike` (`contract-signature.ts`)
projects exactly `{ id, defaultValue, min, max, curve, units }`. Measured:
`grep -c options packages/web/src/lib/docs/contract-lock.txt` → **0**, and
`contract-lock.txt:1729` renders `midiclock`'s divisor — which *does* carry `options` and
`optionsExhaustive` — as the bare `midiclock param divisor 1..24 discrete default=24`.
So the 22 rosters and the whole `face` are contract-lock-transparent; the **only** new
lock lines are the two `controlFamilies` (§3.3).

### 3.2 ⚠ `glyph: 'meter'` — and es9 is the FIRST module in the binder cohort with a REACHABLE live glyph

Wave 5 `BINDERS.md §5` establishes that `midiCvBuddy`, `midiOutBuddy`, `chromaconsole`
and `midiclock` are **all** forced to `glyph: 'none'`, because `glyphBinding`
short-circuits on `primaryAudioOutPortId`, which is
`outputs.find(o => o.type === 'audio')?.id` exactly (`shell-glyph-live.ts:111-113`), and
none of the four declares an `audio` output.

**`es9` declares sixteen.** `es9.ts:247` is `{ id: 'in1', type: 'audio' }`, so
`primaryAudioOutPortId` resolves to `in1` and `glyphBinding` reaches
`{ kind: 'live-audio' }` (`shell-glyph-live.ts:167-`, the *"any glyph + a primary AUDIO
output → live-audio"* clause). No dead-glyph clause fires.

**The glance it buys is the right one:** *is the Eurorack sending anything?* — a meter on
hardware input jack 1. It is a real quantity from a real port, live whenever the bridge
is up, and it does not flatline for an unrelated reason (the way a note-driven binder's
would).

**DECIDED, not escalated, with the narrowing stated.** A dark meter is ambiguous between
"the bridge is down" and "jack 1 is unpatched". That ambiguity is real and it is
acceptable, because the *other* half is answered by the BRIDGE lamp two rows down on the
dock plate, and because the alternative — `'none'` — answers neither. What this module
does **not** get, and should not invent, is a sixth `VALID_GLYPHS` member for
"binding state + event rate"; wave 4 refused that on a module PR and wave 5 §5 refused it
for four more.

> ⚠ **AND es9 is EVIDENCE AGAINST that platform ask being cohort-wide.** Wave 5 wrote
> *"this cohort strengthens the argument from one module to four."* It is now four out of
> **five** — the fifth binder has a perfectly good live glyph for free, because it moves
> AUDIO rather than events. The discriminator for the sixth-glyph ask is therefore not
> "binders", it is **"binders whose payload is EVENTS"**. That is a narrower and more
> honest population than the one the ask was drafted against.

### 3.3 Two control families, and the card must GROW their testids

```ts
controlFamilies: [
  { id: 'es9-connect',    label: 'Connect',    kind: 'other', testidPrefix: 'es9-connect' },
  { id: 'es9-disconnect', label: 'Disconnect', kind: 'other', testidPrefix: 'es9-disconnect' },
],
```

`module-docs-lint.test.ts` (the *"every declared controlFamily.testidPrefix actually
appears in the card source"* leg, `:359-375`) scans **every card's** source for each
declared prefix. `Es9Card.svelte:180` and `:182` carry **no testid at all** today, so both
families would redden on arrival.

**The honest fix is ADDING the testids to the legacy card, never dropping the family** —
shipped precedent `cs-clear-tail` and the four `twotracks-*`. So the face PR edits
`Es9Card.svelte` to `data-testid="es9-connect-{id}"` / `data-testid="es9-disconnect-{id}"`,
which the card genuinely has the gestures for.

⚠ **This ALSO repairs a live e2e weakness for free**: `es9-card-shows-state.spec.ts`
currently finds those buttons by `getByRole('button', { name: /^connect$/i })` — a text
match on a label that is `connect` today and would be a caption change away from
unfindable.

**`docs.controls` needs a prose entry per family key** (`'es9-connect-{n}'`,
`'es9-disconnect-{n}'`) — `midiclock.ts:345` is the shape. es9 is in `STRICT_DOCS`, so
this is required, not optional.

### 3.4 TWO action cells, not one toggle — and the reason is the caption contract

The card renders CONNECT **or** DISCONNECT depending on state (`Es9Card.svelte:179-183`).
A single cell whose label flips would be *"a caption that changes"*, which is the exact
shape `StatusLed`'s contract refuses at the call site
(`StatusLed.svelte`: *"a caller cannot pass `lit ? 'LATE 3' : 'OK'`"*). Two cells with
static captions, both always present:

| cell | fires | `probe` |
|---|---|---|
| `es9-connect-{n}` | `restartEs9Bridge(nodeId, sampleRate, config)` | `{ kind: 'audition' }` |
| `es9-disconnect-{n}` | `stopEs9Bridge(nodeId)` | `{ kind: 'audition' }` |

`ShellActionCell.probe` is **REQUIRED** by the type (`shell-cells.ts:312-318`), and the
right kind is `audition`, for the reason `midiclock-cell-actions.ts` states: an action
writes nothing to the graph, so `readParam`/`readData` are structurally blind, and
`delivered: false` is recorded rather than dropped. Neither cell is dead when pressed out
of state — `restartEs9Bridge` on a missing entry *creates* one (`bridge-owner.ts`, the
*"'Connect' must CONNECT — silently doing nothing here is half of what made the button
look dead"* branch), and `stopEs9Bridge` on a live-but-stopped client is idempotent.

Both are `action` cells, so **both reach the LANE** — only `panel` is dock-restricted
(`curated-face.ts`'s `panelCellKeys` filters on `kind === 'panel'`; `midiclock.ts:278-284`
spells out the mechanism). That is the same win `midiclock` got: on a module that does
nothing until it is connected, the gesture stops being dock-only.

The actions live in a module-owned `$lib/ui/modules/es9-cell-actions.ts` and resolve the
engine through `getActiveEngine()` — **not** through `env`, which carries `write` and no
`read` (`shell-cells.ts:193-200`, which spells this out because *"THE ABSENCE HAS MISLED
THREE AGENTS IN A ROW"*). `es9` does not even need a read: `bridge-owner`'s functions take
a `nodeId`. It needs `sampleRate`, which the card gets off the engine (`Es9Card.svelte:77-81`).

### 3.5 The `fullViewBody` — role `status-primitive`

`$lib/ui/modules/es9/shell-extension.ts` → `Es9BridgeBody.svelte`.

It carries **only** what cannot be a cell:

* **two `StatusLed` lamps** (§4);
* **the pre-connect / unsupported EMPTY-STATE hint** — instructional copy in an empty
  state, which `MidiclockDeviceBody.svelte`'s own header permits by name
  (*"THE PRE-CONNECT HINT — instructional copy in an EMPTY state, and the empty state is
  the whole content of the plate before a grant"*);
* **the CV-BUDDY CLAIM MARKS** (§4.7) — a non-text per-cell state, not body text.

It carries **NO** connect button (the cells own that — `midiclock`'s *"NO CONNECT BUTTON
HERE, DELIBERATELY … A second button on the same plate would be one gesture with two
affordances"*), **no** device picker (there is no roster — one bridge, one device,
`maxInstances: 1`), and **no** canvas.

**`EXTENSION_BODY_ROLES` entry, as it would be committed**
(`face-rack-status-source.test.ts:150`, role union at `:142`, predicate at `:566-575`):

```ts
es9: { role: 'status-primitive', why: 'the ES-9 BRIDGE lamps — BRIDGE (a live native-app connection exists) and XRUN (the bridge under-ran or over-ran the ring), both through StatusLed with the measurement in `detail` → aria-label and NOTHING in a text node. ⚠ IT IS THE EXACT MIRROR OF cvBuddy\'s LATE LAMP, and the pairing is load-bearing rather than decorative: CvBuddyStatusBody.svelte says in place that "the ES-9 card shows xruns (bridge starvation); this shows the clock pulses a LATE scheduler tick could not place (main-thread stall) … the two together are what make \'the clock is unstable\' diagnosable — they have opposite fixes." Deleting the xrun surface without replacing it would have broken a diagnosis another module\'s shipped faceplate depends on. ⚠ NO CANVAS AND NO DEVICE PICKER: the ES-9 is maxInstances 1 and the native app accepts a single client, so there is no roster to pick from — the only affordances are CONNECT and DISCONNECT, and both are ranked ACTION cells that reach the lane. ⚠ THE ONE PIECE OF PROSE IS AN EMPTY-STATE HINT (no bridge running / no SharedArrayBuffer), instructional copy in a state that has no other content, the midiclock precedent. ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over STRICT_FACES INTERSECT video defs and this is domain audio, and markWatched is a VideoEngine pull-set concept this module has no part in.' },
```

Predicate check: the body imports `StatusLed` ✓ and mounts no `<canvas>` ✓, so
`ROLE_PREDICATE['status-primitive'].holds` is satisfied
(`/StatusLed/.test(src) && !paintsCanvas(src, extId)`). `why.length` is far over the
40-char floor (`:799-804`). The role is one of the three the union defines, so the
set-identity leg at `:806-821` is untouched.

⚠ **`face.rackStatus` is NOT declared.** It is for a face that shows a property of the
PATCH and needs `primaryOnlyBands` suppression on non-primary peers (`graph/types.ts`,
`rackStatus`'s doc-comment). `es9` is `maxInstances: 1` — there is no second instance and
no band to suppress. The CV-Buddy relationship runs the *other* way (that module declares
`rackStatus`; this one is the shared hardware it points at).

---

## 4. EVERY READOUT THE CARD PAINTS TODAY — verdict, replacement, and WHICH FINDING LOST ITS SURFACE

The permitted resting text is exhaustively: the module NAME, TAB/SECTION labels, CONTROL
CAPTIONS, and option/landmark NAMES that disambiguate a control's own position.

| # | what it is | where | verdict | what replaces it | the finding |
|---|---|---|---|---|---|
| 1 | `stateLabel` — one of `{device.name}` / `connected` / `connecting…` / `bridge busy (another client)` / `ES-9 unplugged` / `needs cross-origin isolation` / `off` / `bridge not found` | `Es9Card.svelte:155-165`, painted at `:178` | ⛔ **REMOVED.** A state word about the module, painted outside every control — the deleted hero-readout shape | **BRIDGE lamp** (§4.1) | §4.1 |
| 2 | `{device.rate / 1000} kHz · {inputChannels}×{outputChannels}` | `:187` | ⛔ **REMOVED.** Three derived numbers | BRIDGE lamp's `detail` → `aria-label` | §4.2 |
| 3 | `· rtt {rtt.toFixed(1)} ms` | `:188` | ⛔ **REMOVED.** A measurement with units and a decimal — the deleted decimal, verbatim | BRIDGE lamp's `detail` | §4.2 |
| 4 | `· xruns {meters.underruns}/{meters.overruns}` | `:189` | ⛔ **REMOVED as text** | **XRUN lamp**, `tone="warn"`, count in `detail` | §4.4 — the cohort's most consequential |
| 5 | `SharedArrayBuffer unavailable in this context.` | `:192` | ✅ **KEPT.** An EMPTY-STATE hint, not resting text: it is the whole content of the plate in a state where nothing else can be shown, and it is FIXED while we are here (§4.5) | — | — |
| 6 | `Run the es9-bridge app (Chromium required), then connect.` | `:194` | ✅ **KEPT**, same reason, and it is the midiclock precedent by name | — | — |
| 7 | `Jacks driven by CV Buddy: {list}` | `:196-198`, derived at `:133-153` | ⛔ **REMOVED as text.** A derived LIST | **per-cell claim marks on the claimed OUT cells** (§4.7) | §4.7 |
| 8 | `±1.0 ≙ ±10 V at the jacks` | `:234` | ⛔ **REMOVED.** A permanent sentence on a plate — chromaconsole's open-loop line by shape (wave 5 §2.3). It is a **RELOCATION**: `es9.ts:307` already says *"±1.0 ≙ ±10 V"* verbatim in `docs.explanation`, and every `out{n}`/`in{n}` doc repeats it per jack (`:157`, `:180`) | the authored `docs`, via right-click Annotate | — |
| 9 | `IN class (cv twin)` / `OUT class` column labels | `:202`, `:219` | ✅ **KEPT** as SECTION labels — they become the two band labels | — | — |
| 10 | the per-row jack number `{n}` | `:205` | ✅ **KEPT** as a CONTROL CAPTION. This is tidyVco's `A`/`D`/`S`/`R` exactly: fourteen otherwise-identical controls, and the number is the only thing separating them. **`face.bareCells` is NOT declared** — the mixmstrs argument (a section heading already says it) does not apply, because `OUT JACKS` does not tell you *which* jack | — | — |
| 11 | the option names `audio` / `cv` / `pitch` / `gate` inside each `<select>` | `:211-213`, `:228-230` | ✅ **KEPT** — option NAMES inside the control that selects them, which is the settled discriminator | — | — |
| 12 | `connect` / `disconnect` button labels | `:180`, `:182` | ✅ **KEPT**, but as **two static captions on two cells** rather than one label that flips (§3.4) | — | — |

**Twelve rows, six removals.** Compare wave 5's binder table: seven rows, seven removals.
es9 keeps proportionally more, because more than half of what it paints is a control's own
name.

### 4.1 The BRIDGE lamp, and what a state word buys that a lamp does not

```svelte
<StatusLed caption="BRIDGE" lit={connState === 'connected'}
           detail={es9BridgeDetail(snap)} testid="es9-led-bridge-{nodeId}" />
```

`es9BridgeDetail` is a **pure function in a model file beside the body**, for the reason
`MidiclockDeviceBody.svelte` gives: *"An unpainted string that is wrong is invisible to a
VRT baseline and to a human reading one, so they are decided where a unit test can read
them."* It composes rows 1-3 into one sentence:
`"connected to ES-9 (Expert Sleepers), 48 kHz, 16×16, round trip 4.2 ms"` /
`"connecting to the es9-bridge app"` / `"the bridge is busy — another client holds it"` /
`"the ES-9 was unplugged"` / `"no es9-bridge app answered on ws://127.0.0.1:9209"`.

⚠ **THE NARROWING, STATED.** `connState` has **eight** values (`bridge-client.ts:19-27`);
a boolean lamp has two. `busy` and `device_lost` are genuinely different failures with
genuinely different fixes ("quit the other client" vs "plug the module back in"), and at
rest the face will show the same dark lamp for both. **That is a real reduction and it is
the ruling's intended trade**, not an oversight. It is mitigated, not solved, by three
things: the sentence is on `aria-label` and `title` (so hovering the lamp names the exact
failure — `StatusLed.svelte` binds both), the empty-state hint (row 6) covers the
overwhelmingly common failure, and `busy` is now a much rarer state than it was, because
`bridge-owner.ts`'s `pagehide`/`beforeunload` teardown fixed the socket leak that made it
common ("the es9-bridge process was holding NINE leaked sockets").

**A second lamp for FAULT was considered and REFUSED.** `caption="FAULT" tone="warn"
lit={busy || device_lost}` would restore the two-way split — but it makes the plate say
"bridge dark, fault lit" for a *stopped* bridge, which reads as a malfunction where the
user simply pressed DISCONNECT. Two lamps that must be read together are a worse surface
than one lamp plus a hover. Recorded so the next reader does not re-derive it.

### 4.2 rate / channels / rtt — DELETED, and this one costs nothing

`device.rate` is not a user choice: `bridge-owner.ts`'s `restartEs9Bridge` is handed
`sampleRate()` from the engine's own `AudioContext` (`Es9Card.svelte:75-81`), whose
comment is *"the bridge must be restarted at the SAME rate the worklet runs at."* So the
number is always the context rate, always. `16×16` is a constant of the hardware
(`HW_CHANNELS = 16`, `es9.ts:66`). `rtt` is a health metric with no action attached to any
particular value. All three are exactly what `detail` is for.

### 4.3 ⚠ `stateDetail` is READ AND NEVER PAINTED, today

`Es9Card.svelte:51` derives `stateDetail = snap.detail` and **nothing in the template ever
uses it** (the only `.detail` occurrences in the markup are the CSS class `detail`, at
`:186`, `:192`, `:194`, `:197`). The bridge worker sends a real detail string on every
status message (`bridge.worker.ts`, `post({ type:'status', state: closeStateAfter(...),
detail: lastControlDetail })`). So the card **already** computes the sentence the face
needs and throws it away. The face's `detail` prop is that variable finding its consumer.
Minor, and it is a dead-variable lint smell on `main` — filed in §12.

### 4.4 ⚠ THE XRUN COUNTER IS THE WAVE'S MOST CONSEQUENTIAL REMOVAL, and the replacement was already designed BY ANOTHER MODULE

`Es9Card.svelte:189` paints `xruns {meters.underruns}/{meters.overruns}`. Under the
ruling a count may not paint. **The finding is real and it does not lapse**, and the
reason is the strongest single piece of evidence in this spec:

`CvBuddyStatusBody.svelte` — a **shipped faceplate body on `main`** — says, in a comment
directly above its own `LATE` lamp:

> *"The ES-9 card shows `xruns` (bridge starvation); this shows the clock pulses a LATE
> scheduler tick could not place (main-thread stall). **The two together are what make
> "the clock is unstable" diagnosable — they have opposite fixes.**"*

So a promoted `cvBuddy` faceplate **already depends on the ES-9 surfacing this number**,
and it already shipped the exact shape es9 should copy:

```svelte
<StatusLed caption="XRUN" lit={xruns > 0} tone="warn"
           detail={es9XrunDetail(meters)} testid="es9-led-xrun-{nodeId}" />
```

against `cvBuddy`'s `<StatusLed caption="LATE" lit={clockSkips > 0} tone="warn" …>`.
Same primitive, same tone, same `detail`-carries-the-count discipline, same argument —
and `CvBuddyStatusBody.svelte`'s own comment already made the case that the lamp is
**stronger** than the number it replaces:

> *"`clockSkips` is a COUNT, and a count may not paint — so the count reaches the title
> and the lamp carries 'any / none'. That is the eurorack panel idiom, and it is strictly
> MORE informative at rest than the card's `0 skipped`: the card had to argue that a zero
> must always render or 'healthy' and 'not instrumented' would look identical, and a lamp
> that is PRESENT AND DARK says exactly that with no text at all."*

`es9`'s `0/0` has the identical problem and gets the identical fix.

⚠ **ONE THING DOES NARROW, AND IT IS NOT THE COUNT.** The card paints `underruns/overruns`
as **two** numbers, and they mean opposite things: an underrun is the browser failing to
feed the hardware, an overrun the hardware outrunning the browser. A single lamp collapses
them. **DECIDED: one lamp, both in `detail`** (`"3 underruns, 0 overruns since the bridge
came up"`), because the *action* is the same in both cases — the stream is not keeping up
— and because two adjacent warn lamps captioned `UNDER` and `OVER` is a diagnostic panel,
not a faceplate. Stated rather than left to lapse.

### 4.5 ⚠ AND THE UNSUPPORTED HINT (row 5) IS **WRONG ON MAIN**, so the face PR fixes it while it is in there

`Es9Card.svelte:191-192` shows `SharedArrayBuffer unavailable in this context.` when
`connState === 'unsupported'`, and `stateLabel` (`:161`) shows
`needs cross-origin isolation`. `bridge-client.ts:64-72` sets `unsupported` **only** when
`sharedArrayBufferAvailable()` is false — but `es9BridgeAvailable()` (`bridge-owner.ts`)
requires `typeof Worker === 'function' && typeof SharedArrayBuffer === 'function'`, and
when *that* returns false `acquireEs9Bridge` returns `null` **without creating an entry
at all**, so `es9Snapshot` yields `{ ...IDLE, supported: false }` — `state: 'idle'`, which
`stateLabel` renders as **`off`**. So an environment with a `SharedArrayBuffer` but no
`Worker` reports "off", indistinguishably from a user-pressed DISCONNECT.

The `supported` flag exists on the snapshot precisely for this
(`Es9OwnerSnapshot.supported`, *"Views render the 'unsupported' affordance instead of a
dead Connect button"*) and **the card never reads it** — `Es9Card.svelte:49-54` destructures
`state`, `detail`, `device`, `meters`, `rtt` and not `supported`. The face's empty-state
branch reads `snap.supported`, which is what the field was added for.

### 4.6 The two hints that stay — and the ES-9's two standing fleet constraints, as they bear on a FACE

The brief asks what the browser-audio ceiling and the local-origin requirement mean *for a
face specifically*. Measured:

* **The 2-channel `getUserMedia` ceiling is why this module EXISTS, and it touches the
  face not at all.** `es9.ts:3-10`: *"getUserMedia caps the ES-9 at its first stereo pair
  and setSinkId picks whole devices, never channel ranges … The native app owns CoreAudio
  (16-in/16-out …)"*. The face renders 22 params and 46 ports; none of it runs through
  the Web Audio device APIs.
* **The local-origin constraint is a real determinism input for VRT and nothing else.**
  `bridge-client.ts:66-71`: the `/rack` routes are `crossOriginIsolated` for Faust, so
  `SharedArrayBuffer` **is** present on CI, so `es9BridgeAvailable()` is TRUE, so the
  factory really does spawn the transport Worker on every runner and it really does fail
  to reach `ws://127.0.0.1:9209`. That is §9's whole subject. It also means the
  "unsupported" branch is **unreachable** on CI, so no baseline can capture it and no e2e
  can assert it — worth saying, because it is the one branch of the empty state a
  reviewer cannot see in a PNG. (`bridge-client.ts:69-70` names the other case it cannot
  reach either: *"Safari additionally blocks ws://localhost from https pages; that
  surfaces as a normal connect failure."*)

### 4.7 ⚠ THE CV-BUDDY LINE (row 7) — the removal is SAFE, and for a reason no other row in this table has

`Es9Card.svelte:196-198` paints `Jacks driven by CV Buddy: 3, 4, 7 (run), 8 (clock)`,
derived at `:133-153` from `allocateCvBuddySlots`. Its own comment calls it *"Purely
informational"*, which undersells it: **those jacks' `out{N}_class` params are owned by a
janitor and will be overwritten.** `cv-buddy-es9-reconcile.ts` writes `classSets` onto the
ES-9 node under `CVBUDDY_JANITOR_ORIGIN`, and its header is explicit —
*"while a CV Buddy is present those jacks belong to it; set an ES-9 out-class by hand only
when no CV Buddy is in the rack."*

**A face that renders eight identical, freely-editable OUT CLASS cells while a janitor
silently reverts three of them is a control that looks alive and isn't** — CLAUDE.md's
"green gate certifying a live bug" shape. So the *signal* must survive even though the
*text* goes.

**It survives twice over, which is why this deletion is a relocation rather than a trade:**

1. **On the ES-9's own plate, as a per-cell mark.** `status.staleSlots`' argument from
   wave 5 §2.5, applied: staleness is a property of an individual slot, the allocator
   already identifies *which*, and the face renders eight OUT cells. **Mark the claimed
   cells, not the module** — which is strictly better than the card's version, because the
   card tells you *which numbers* and does not tell you which *control* is affected. The
   mark is non-text (a border treatment, the `[data-ch-override='true']` precedent from
   `MidiOutBuddyCard.svelte:189-191`), with the sentence on the cell's `aria-valuetext`:
   `"gate — driven by CV Buddy (clock); changes here are reverted"`.
2. **On CV Buddy's plate, PAINTED, and already ruled permitted.**
   `CvBuddyStatusBody.svelte` renders `cvBuddySlotName(alloc)` — literally `JACKS 1-3` —
   and its header defends it as *"the owner's own disambiguation test made literal … the
   jacks they own is the only thing that tells them apart."* So the union of claimed jacks
   is readable off the CV Buddy faceplates today, on `main`, as permitted text.

⚠ **What genuinely narrows:** with three CV Buddies in a rack, the ES-9's line gives the
*union* at a glance and the replacement makes you read three plates (or hover eight
cells). Small, real, named.

---

## 5. WIDTH — NOT EARNED, and nothing is asked for

The gate is `bodyW - contentW ≤ FACE_WIDTH_SLACK_MAX_PX` (40), with the roster's measured
modes at **15 px** (a band defines the plate) and **32-33 px** (a hero row does)
— `workflow-shell-faces.spec.ts`, the `FACE_WIDTH_SLACK_MAX_PX` block. The source half is
`face-width-source.test.ts`, whose `PLATE_FLOOR_EXEMPTIONS` is **empty**.

**es9 asks for no entry in either.** The measurement:

* the card's own body is `min-width: 210px` (`Es9Card.svelte:245`) with a `panelWidth={520}`
  patch panel (`:174`) — but the panel is the JACK RAIL, which on a face is the rear card,
  not the plate;
* the face's widest band is the **OUT JACKS** row: 8 segmented cells of 4 options each.
  A 4-option segmented at the dock's cell metrics is the same primitive `midiclock`'s
  5-option `divisor` band renders, and that face's dock baseline exists to be measured
  against (`face-midiclock-dock.png`);
* there is **no live picture, no scope trace, no video preview, no XY pad** — the four
  things the ruling names as genuine earners. `face.hero` is not declared.

**es9 is a WIDE-BAND face rather than a wide PLATE**, and the distinction is the one the
gate makes: 14 cells on one row is content, not reserve. If the IN band overflows at
1280 px the cells wrap — `hiddenX === 0` is the leg that would catch a clip, and it is in
the required lane (`face-width-source.test.ts`'s header records that *"an older note in
this repo says vrt-strict covers cards only; it is out of date"*).

---

## 6. THE LANE TILE

`es9` is **not** in `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:112-124`: `group`,
`sticky`, `cadillac`, `clipplayer`, `controlSurface`, `electraControl`,
`launchpadControlLeft`), and `legacy-fallback.test.ts:170-198` asserts that by name, with
the whole history of its removal. So promotion swaps the emitted node type from
`moduleShellPlaceholder` to `moduleShell` (`legacy-fallback.ts:165-179`).

**At 1/8 (compact, zoom 0.45) the tile shows:** the module name, the `meter` glyph on
`in1`, and the top 2-3 cells of `laneOrder` — `CONNECT`, `DISCONNECT`, `OUT 1`. That is
the correct ladder: with 22 identical params there is no honest top-3 among *them*, and
the two gestures are the things a player actually needs from a lane tile.

⚠ **The glyph seam is NOT the constraint here.** `ShellExtensionGlyphProps` carries no
`nodeId` (wave 5 §5), so a *module-drawn* glyph would be identical for every instance —
but es9 uses the SHELL's live-audio meter, which binds to the node's own analyser tap, and
`maxInstances: 1` means there is only ever one instance anyway.

---

## 7. THE FOUR GATES + THE SNAP CONTRACT

| # | gate | file:line | what es9 must do |
|---|---|---|---|
| 1 | face lint / `STRICT_FACES` | `module-face-lint.test.ts`; `strict-faces.ts:10-21` | Author a COMPLETE `face` (all 22 params + both family templates in `order`) and add `'es9'` to `STRICT_FACES` **in the same PR**. The set is asserted EQUAL to the set of defs declaring a `face`, both directions — *"AUTHORING A `face` IS THE PROMOTION. There is no count anywhere."* |
| 2 | VRT baselines | `e2e/vrt/_shell-faces.ts` (`FACES` at `:34`); dispatch `task vrt:commit` | Add `{ type: 'es9', pages: 3 }`. **3 files** (§9). Delete `es9` from `EXEMPT_FROM_VRT` (`vrt-exemptions.ts:457`) **and** from `ALLOWED_PERMANENT_EXEMPT` (`:1205`) — `vrt-meta.test.ts:365` asserts `[...ALLOWED_PERMANENT_EXEMPT].sort()` EQUALS `Object.keys(EXEMPT_FROM_VRT).sort()`, so leaving either name behind is RED |
| 3 | `EXTENSION_BODY_ROLES` | `face-rack-status-source.test.ts:142` (union), `:150` (roster), `:557-575` (predicates), `:806-821` (set identity) | Role **`status-primitive`**, `why` as written in §3.5. Predicate: imports `StatusLed`, mounts no `<canvas>` ✓ |
| 4 | `module-docs-lint` FAMILY↔CARD | `module-docs-lint.test.ts:359-375` | ADD `data-testid="es9-connect-{id}"` / `es9-disconnect-{id}` to `Es9Card.svelte:180`/`:182`. **Never drop the family.** Plus a `docs.controls` entry per family key |

**Plus the `optionsExhaustive` SNAP contract** (`param-vocabulary.test.ts`): **DOES NOT
APPLY, and declaring it would be RED.** See §3.1 — the roster is DENSE (4 options for 4
discrete steps), the gate refuses a redundant declaration by name, and there is no
between-member value for `snapToOptions` to repair.

**And a fifth thing that is not a gate but will redden if forgotten:**
`face-readout-source.test.ts`'s Leg 2 sweeps every paintable option/landmark label through
`looksNumeric` (`:572`). es9's four labels are `audio` / `cv` / `pitch` / `gate` — none
matches the pattern — so **no `NUMERIC_LABEL_EXEMPTIONS` entry.** (Its sibling module is
not so lucky; see `midiLane/spec.md §7`.)

---

## 8. WHERE STATE LIVES — and it does NOT break the generic face path

| thing | lives in | reaches the face by |
|---|---|---|
| 22 jack classes | **`node.params`** (Y.Doc, undoable, automatable, MIDI-learnable) | ordinary param cells |
| the bridge connection | a module-level `Map<nodeId, Entry>` in `bridge-owner.ts` — **graph-lifetime, not component-lifetime** | `subscribeEs9(nodeId, cb)` from the body's `$effect` |
| device / meters / rtt | the same registry's `Es9OwnerSnapshot` | the same subscription → `detail` |
| CV-Buddy jack claims | **derived from the PATCH** (`allocateCvBuddySlots` over every `cvBuddy`/`cvBuddyMini` node) | `nodesStructuralVersion()` + the allocator, exactly as the card does at `:132-153` |

**Nothing here breaks the generic path**, and the reason is worth stating because it is
the opposite of the wave-6 media cohort's answer. Wave 6's one-line discriminator was
*"Is the thing the body needs to show and drive IN THE GRAPH? YES → read `node.data` /
params directly, no registry. NO → a status registry with a `delivered` ledger."*

**es9 is the case that shows the discriminator needs a third branch.** Its controls are in
the graph (params), but its *status* is neither in the graph nor in a card — it is in a
**node-keyed engine-side registry that already exists and was built for exactly this**
(`bridge-owner.ts`'s header: *"the engine-visible state of a rack must not depend on
which UI renders a module"*). It needs no `camera-status-registry` clone, because the
registry `cameraInput` had to build is the thing `es9` already has. Sharpened:

> **Is the thing the body shows OWNED BY THE NODE?** — graph state and engine-node
> registries both say YES, and neither needs a card-status registry. Only state owned by
> a **mounted card** (a `getUserMedia` grant) needs one.

⚠ **AND `subscribeEs9`'s ORDERING PROPERTY IS WHAT MAKES A BODY SAFE** — it is not
incidental and a build agent must not "simplify" it. `bridge-owner.ts` keeps listeners in
a `Map` **outside** the entries, and its comment records the owner-reported showstopper
that shape exists to prevent: *"the CARD mounts when the node spawns and the ENGINE
FACTORY creates the entry later … so in the real ordering the view ALWAYS subscribes
first, always found nothing, and never subscribed at all."* A `fullViewBody` mounts on
dock-expand, i.e. later still — so the property holds a fortiori, but the body must still
call `subscribeEs9` (which delivers the current snapshot synchronously) rather than
polling `es9Snapshot`.

---

## 9. VRT — 3 FILES, and the DRAIN IS THE *RESULT* OF THE FACE RATHER THAN A PRECONDITION FOR IT

### 9.1 The file count

`vrt.spec.ts:52` builds `COVERED_MODULES` as
`REGISTRY.filter(m => !(m.type in EXEMPT_FROM_VRT))`, so a drain enrols the **legacy card**
too. Measured against what `midiclock`'s drain actually produced —
`e2e/vrt/__screenshots__/vrt.spec.ts/midiclock.png` plus
`workflow-shell-faces.spec.ts/face-midiclock-compact.png` and `face-midiclock-dock.png`,
all three present on `main`:

| file | sweep |
|---|---|
| `e2e/vrt/__screenshots__/vrt.spec.ts/es9.png` | the legacy-card sweep |
| `…/workflow-shell-faces.spec.ts/face-es9-compact.png` | the face sweep |
| `…/workflow-shell-faces.spec.ts/face-es9-dock.png` | the face sweep |

**Predicted: 3.** Count what the bot commits against this number — a green dispatch that
committed nothing is a red flag.

**Other sweeps the drain joins:**

* **`vrt-cable-stripe.test.ts`** — `Es9Card.svelte:169` is
  `<div class="stripe" style="background: var(--cable-audio);">`, so the new legacy
  baseline is pinned to `--cable-audio` and joins the palette gate. This is the sweep
  wave 6 saw `midiclock`'s drain surface on #2184. It runs in `unit` **and** in the
  REQUIRED `vrt-strict` job with `VRT_STRIPE_PALETTE_REQUIRED=1`.
* `vrt-legacy-mask-audit.spec.ts` and `vrt-live-surfaces.test.ts` read
  `EXEMPT_FROM_VRT`/`VRT_MODULE_MASKS`; es9 declares **no mask** and needs none, so both
  are satisfied by absence.
* `STRICT_VRT_MODULES` — **do NOT add es9**. `vrt-meta.test.ts:212` refuses a strict entry
  with a canvas mask and `:202` requires a committed baseline; es9 qualifies on both, but
  strict membership is a separate deliberate decision and this PR should not make it.

### 9.2 ⚠ THE DETERMINISM ARGUMENT IS THE **INVERSE** OF `midiclock`'s, AND IT IS THE FACE THAT SUPPLIES IT

`midiclock` was drainable because *nothing happens until CONNECT is pressed*
(`_shell-faces.ts:3352-3372`: *"a freshly spawned midiclock has NO MIDI ACCESS …
`requestMIDIAccess` is never called until someone presses CONNECT, and this scene presses
nothing"*). **es9 has no such gesture gate.** `es9.ts:378` calls `acquireEs9Bridge` in the
**factory**, unconditionally; `SharedArrayBuffer` is present on `/rack` (COOP/COEP for
Faust, `bridge-client.ts:66-67`), so `es9BridgeAvailable()` is true on CI, the Worker
spawns, and `bridge.worker.ts` cycles `connecting` → close → `scheduleReconnect()` with a
doubling backoff, forever.

**Today that makes the card's status row a PHASE LOTTERY**, and it is the same hazard the
file already names two entries away for the VST cards (`vrt-exemptions.ts`, the
`vstInstrument` entry): *"the connection pill cycles connecting/helper-not-found on the
reconnect backoff with no helper on CI, so a PNG is phase-dependent."*

> ### ⚠ SO es9's OWN VRT EXEMPTION TEXT IS **FALSE ON `main`**
>
> `vrt-exemptions.ts:451-457` claims: *"The card is static chrome (status LED + class
> selectors + sectioned patch panel, no canvas), so it **IS** baseline-able — pending the
> darwin/linux capture pass."*
>
> It is not static chrome. `Es9Card.svelte:178` paints `stateLabel`, which on a
> bridge-less runner alternates between `connecting…` and `bridge not found` on the
> worker's backoff. **es9 has the `vstInstrument` hazard and its exemption text denies
> it.** The exemption is *correct by accident* and its stated reason is wrong — which is
> the shape this repo cares about, because the next person to read that sentence would
> drain on it. Filed in §12 as D1.

**And the face is what makes the claim true.** After promotion:

* the cycling TEXT is gone (§4, rows 1-4);
* both lamps are `lit={false}` on any bridge-less runner — `connState` never reaches
  `'connected'`, so no `deviceInfo` ever arrives, so `snap.meters` stays `null` and
  `xruns > 0` is false;
* the empty-state branch renders the STATIC hint (row 6), because `snap.supported` is true
  and `connState !== 'connected'`;
* the `meter` glyph reads `in1`, which is fed by a worklet with no rings attached
  (`acquireEs9Bridge` returns a real `RingSpec` but the worker never fills it), i.e.
  digital silence — and `bootWithFace` freezes the audio graph anyway
  (`workflow-shell-faces.spec.ts`'s re-freeze + `assertFaceAudioFrozen` legs).

So `face-es9-compact.png` and `face-es9-dock.png` are byte-stable by construction, and the
NEW legacy baseline `vrt.spec.ts/es9.png` — which the drain also enrols — is **not**,
because it captures the old card. **Resolution: the drain must be scoped to the face
scenes, or the legacy row needs the status row masked.** Concretely:

**RECOMMENDED: capture all three, and add a `VRT_MODULE_MASKS` entry for `es9` masking
`[data-testid="es9-status-…"]` on the LEGACY card row only.** That is a mask, so
`vrt-live-surfaces.test.ts`'s rule 5 applies — *"every entry in the pre-registry
`VRT_MODULE_MASKS` table must state a checkable CAUSE for the region it deletes"* — and
the cause is checkable and already written down two entries above it in the same file
(the `vstInstrument` backoff argument). The masked region's coverage is not lost: it is
exactly what `es9-card-shows-state.spec.ts` asserts, and §12/D3 makes that spec actually
do so.

### 9.3 ⚠ A PRE-FLIGHT THE BUILD AGENT MUST RUN, AND I COULD NOT (no browser runs in this slot)

`vrt.spec.ts` fails a card row on **console errors**, not only page errors:

```ts
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
```

A failed `new WebSocket('ws://127.0.0.1:9209/ws')` handshake logs a browser-generated
console error. It originates in the **bridge Worker** (`bridge.worker.ts`), and whether
Playwright's `page.on('console')` surfaces worker-context messages decides whether the new
`vrt.spec.ts/es9.png` row is red on arrival.

**Nothing on `main` answers this**, because nothing asserts console cleanliness for es9
today: neither `es9-shell-lifetime.spec.ts` nor `es9-card-shows-state.spec.ts` requests
the `errorWatch` fixture (contrast `midi-lane.spec.ts`, which does — and has no worker).

**Run `task vrt:one -- es9` locally before dispatching the capture.** If the WS failure
surfaces as a console error, the drain needs the worker's reconnect suppressed under a
test flag, or the legacy row stays exempt and only the two face scenes are added
(**2 files, not 3**). Do not dispatch a capture on the assumption.

### 9.4 `FACES_WITHOUT_SCENES` — not needed

The named refusal at `_shell-faces.ts:3472` is for a genuinely non-deterministic renderer.
es9's face is deterministic per §9.2. Do not take an entry.

---

## 10. THE COST TABLE

| axis | cost | evidence |
|---|---|---|
| **WebGL attest** | **ZERO** | The audio-domain basis is exactly `cube.ts` + `wavesculpt.ts` (`scripts/webgl-attest-lib.ts`, `AUDIO_WEBGL_MODULE_DEFS`). `es9.ts` is not in it, so #2186's `paramSpec(def,'x')` rule does not apply and an `export const ES9_CLASS_OPTIONS` is free |
| **ART** | **ZERO** | No ART scenario names es9; the module is silent without a native bridge, and `acquireEs9Bridge` no-ops in Node/vitest/ART (`es9BridgeAvailable()` needs `Worker` + `SharedArrayBuffer`) |
| **contract-lock** | **+2 lines**, and only those | `face` and `options` are both unprojected (§3.1). The two new lines are `es9 family es9-connect kind=other prefix=es9-connect` and the disconnect twin — the `contract-lock.txt:1730` shape |
| **Push 2 card** | ⚠ **CHANGES, deliberately, and must NOT be pinned** | No `PUSH_CARD_CONTROLS` entry today, so es9 sits on tier 3 (GENERIC): *"the params in the order the module DECLARES them"* → encoders 1-8 are `in1_class..in8_class`. After promotion it moves to tier 2 (FACE) → **`out1_class..out8_class`**, which is the improvement §2 argues for. ⚠ There IS real competition for slots here (22 turnable params, 8 encoders), unlike `midiclock` — so this is a genuine re-rank, not a no-op. **Still no override**: an override REPLACES, so pinning would freeze the ranking against any future param |
| **docs / `STRICT_DOCS`** | **already strict** (`strict-docs.ts:29`); **+2 `docs.controls` entries** for the family keys | `midiclock.ts:345` is the shape |
| **`DESCRIPTIONS`** | unchanged (`module-manifest.ts:134`) | — |
| **VRT** | **3 files** (or 2 — see §9.3), 2 exemption deletions | §9.1 |
| **e2e** | **2 tests re-pointed**, 0 deleted | §11 |
| **CI wall-time** | 2 new face scenes ≈ the `midiclock` pair; 1 new legacy card row. Well under the ~2 min sign-off threshold, but **estimate it on the PR** | CLAUDE.md |

---

## 11. ⚠ THE PRECURSOR — PROMOTION DELETES THE ONLY CALLER OF `updateEs9Config`, AND IT WOULD SHIP GREEN

**This is the wave-6 §8 shape (a defect the face CREATES) with an extra twist: half of it
is ALREADY LIVE on `main`.**

Measured — `git grep -n "updateEs9Config" origin/main -- packages e2e` returns **exactly
two** hits outside the definition: a comment (`Es9Card.svelte:15`), an import (`:31`), and
**one call site**, `Es9Card.svelte:89`.

The two class push-paths are **different messages to different consumers**:

| path | who pushes | what it reaches |
|---|---|---|
| `pushClasses()` → `worklet.port.postMessage({type:'classes', …})` | the **engine factory's** `setParam` (`es9.ts:342-345`, `:393-398`) | the AudioWorklet's per-jack voltage scaling |
| `updateEs9Config()` → the worker's `{type:'config', outputModes}` | **`Es9Card.svelte:89` and nothing else** | the **native app's UNDERRUN POLICY** — HOLD vs FADE per jack |

`es9OutputModes` (`es9.ts:140-149`) is the safety mapping the def documents at length
(`:113-139`): cv/pitch **HOLD** their last voltage, gate/audio **FALL TO ZERO**, with an
owner-reported incident behind it (*"Pam's New Workout not locking cleanly … a held gate
does not merely lose information; it EMITS A WRONG SUSTAINED SIGNAL — a stuck note, a
stuck envelope, a clock that stopped"*).

**Three consequences, in increasing severity:**

1. **After promotion, changing an out-class from the FACE would not update the bridge's
   underrun policy at all.** The worklet would scale correctly and the native app would
   apply the previous jack's failure policy.
2. **It is ALREADY BROKEN under the default shell, today.** `es9-shell-lifetime.spec.ts`
   asserts that under `?shell=1` *"no `Es9Card` is mounted in the lane"* — so on the
   renderer every user actually gets, `updateEs9Config` has no caller **now**. Only a user
   who opens the dock full view and touches a selector pushes it.
3. ⚠ **AND THE CV-BUDDY JANITOR NEVER PUSHES IT.** `cv-buddy-es9-reconcile.ts` writes
   `out{N}_class` params directly through the store under `CVBUDDY_JANITOR_ORIGIN` —
   no card, no `updateEs9Config`. Its header calls the reset-to-audio behaviour
   *"LOAD-BEARING: the ES-9 gate/cv classes HOLD their last voltage on a stream hiccup, so
   leaving a freed jack's class non-audio would freeze a stale voltage on the hardware."*
   **That load-bearing property is only enforced at bridge-acquire time**
   (`es9.ts:383`, `outputModes: es9OutputModes(node.params)`), i.e. at node construction.
   A CV Buddy added or removed mid-session re-allocates jacks and rewrites classes, and
   the bridge keeps the policy it was born with.

**No gate can see any of this**, and the reason is structural: `outputModes` is a wire
message to a process that does not exist on CI. `es9-transport.test.ts` and
`bridge-owner.test.ts` cover the transport and the ownership; neither asserts that a
param change reaches the config.

### THE PRECURSOR PR (before the face)

**Move the `updateEs9Config` push onto the ENGINE, where the class already lives.**
`es9.ts`'s handle already has the hook:

```ts
setParam(paramId, value) {
  if (/^(in\d+|out\d+)_class$/.test(paramId)) {
    liveParams[paramId] = value;
    pushClasses(liveParams);
    // NEW — the bridge's failure policy follows the OUT classes, and this is the
    // only place that knows a class changed without a card being mounted.
    updateEs9Config(node.id, { inputChannels: …, outputChannels: …, outputModes: es9OutputModes(liveParams) });
  }
},
```

* it fixes (2) and (3) on `main`, independent of any face;
* it makes the face possible without the face being both cause and cure (wave 6 §8's
  reviewability argument);
* `Es9Card.svelte:83-91` then drops its own push, so the two surfaces cannot disagree —
  the `wavecel-table-actions` / `dx7` "one module imported by both" discipline;
* **it is testable without hardware**: a unit test over the handle can assert that
  `setParam('out3_class', ES9_CLASS_GATE)` produces an `updateEs9Config` call whose
  `outputModes['10']` is `'audio'` (jack 3 → USB channel 11 → index 10 —
  `JACK_CHANNEL_BASE = 8`, `es9.ts:76`). That is a real positive control, not a
  probe-and-skip.

⚠ **`updateEs9Config` is currently a `$lib/audio/es9` import into `$lib/ui`.** Moving the
call into `es9.ts` makes it an audio→audio import, which is *simpler*, not harder — but
check `module-shell-import-guard.test.ts` is untouched (it constrains the shared shell
layer referencing module-owned directories; neither side of this move is the shell).

**Estimate: ~2 h + the unit test. It is the highest-value item in this spec.**

---

## 12. DEFECT LEDGER — live on `main`, independent of any face

**D1. ⚠ es9's VRT exemption text asserts the OPPOSITE of the module's behaviour.**
`vrt-exemptions.ts:451-457` says *"the card is static chrome … so it IS baseline-able."*
The card paints a status label driven by a reconnect backoff that runs on every runner
(§9.2). The exemption's *conclusion* is right and its *reason* is wrong, which is worse
than a wrong exemption: it invites a drain on a false premise. The correct text is the one
two entries above it, for `vstInstrument`.

**D2. ⚠⚠ `updateEs9Config` has one caller, on a card the default shell never mounts —
so the bridge's per-jack UNDERRUN POLICY does not follow the class param, and the
CV-Buddy janitor's writes never reach it at all.** §11. Safety-relevant (a held gate is a
stuck note), invisible to every gate, and already live.

**D3. ⚠⚠ `es9-card-shows-state.spec.ts`'s headline assertion is VACUOUS — it compares a
STATE NAME against a RENDERED LABEL, and the two vocabularies never intersect.**

```ts
await expect.poll(() => cardState(page), { … })
  .not.toContain('idle');   // "card never left its initial idle state"
```

`cardState()` reads `innerText` of `[data-testid="es9-status-…"]`, whose text is
`stateLabel` plus a button. **`stateLabel` never emits the string `idle` for any of its
eight inputs** — `Es9Card.svelte:162` maps `case 'stopped': case 'idle': return 'off'`.
So the assertion is true **on the very first poll**, before the card has subscribed to
anything, and **the exact regression it was written for — a card frozen on its initial
`idle` snapshot — renders `off`, passes, and ships.**

⚠ **Its own negative control does not rescue it.** The third test asserts only
`text.length > 0`, which `off` + `connect` satisfies. That is the memory note verbatim:
*a passing negative control proves the probe can move, not that it reads the right thing.*
The honest repair is a positive control — assert the text is one of the labels a
SUBSCRIBED card can show, and drive a known transition.

**D3b. And a second leg of the same spec is BOTH unreachable on CI AND wrong if reached.**

```ts
const disconnect = row.getByRole('button', { name: /disconnect/i });
if (await disconnect.count()) {
  await disconnect.click();
  await expect.poll(() => cardState(page), …).toContain('stopped');
}
```

The DISCONNECT button renders only when `connState === 'connected'`
(`Es9Card.svelte:179`), which no CI runner reaches — so the guard is always false and the
block never executes. **And if it did, it would fail**: `stop()` reports `'stopped'`, and
`stateLabel` renders `'stopped'` as **`off`**. The comment above it is emphatic that
*"DISCONNECT is deterministic: stop() always reports `stopped`. So that is what we assert
the wiring with"* — and the thing it asserts against is the label, not the state.

**D4. `stateDetail` is derived and never used.** `Es9Card.svelte:51` computes
`snap.detail` and no template branch reads it; the worker sends a real detail string on
every status message. The card discards the most specific thing it knows. (Fixed as a
side effect of §4.1, which is what `detail` becomes.)

**D5. The `supported` snapshot field has no consumer.** `Es9OwnerSnapshot.supported`
exists and documents its purpose (*"Views render the 'unsupported' affordance instead of a
dead Connect button"*); `Es9Card.svelte:49-54` never destructures it, so an
environment with `SharedArrayBuffer` but no `Worker` shows `off` — indistinguishable from
a user-pressed DISCONNECT. §4.5.

**D6. `legacy-fallback.test.ts:191-193`'s COMMENT goes stale on promotion, its assertion
does not.** The `base` fixture hard-codes `migrated: false` (`:38-44`), so
`laneRenderKind(...) === 'placeholder'` stays true as a statement about the pure function.
The comment *"Un-migrated (no curated face yet) ⇒ the uniform placeholder tile"* stops
being true of es9. Prose-only fix, in the face PR.

**D7. `es9.ts`'s FILE HEADER contradicts its own factory, 340 lines later** — the
`recorderbox` stale-`why` class (wave 6 §2.2), found in a def rather than an inventory.
`:25-28` says *"The CARD (Es9Card.svelte) **owns the connection lifecycle** (worker +
rings, via `$lib/audio/es9/bridge-client.ts`)"*, while `:368-376` says *"OWN THE BRIDGE
HERE, not on the card … Collapsing the dock pane, switching to `?shell=1`, or never
opening the card at all can no longer stop the hardware stream."* `bridge-client.ts:5-8`
carries the same stale claim (*"The CARD owns this object's lifecycle (spawn on connect,
dispose on card teardown / disconnect)"*). Three stale sentences; the face PR deletes
them, because a body author reading the header would build the wrong lifetime.

**D8. Minor — `Es9Card.svelte:68`'s `TODO(follow-up): derive masks from patched edges`**
duplicates `es9.ts:380-381`'s identical comment. The v1 decision (subscribe all 16) is
fine; the duplication means two places to change.

---

## 13. VERDICT

> ## **PROMOTE-WITH-PRECURSOR** — and **RE-DISPOSITION the inventory entry from `bespoke-surface` to `generic-face`.**

**The one-line reason:** every clause of the entry's `why` is either a readout the ruling
deletes or an ordinary `ParamDef`; what is left is 22 param cells, 2 action cells and a
`status-primitive` body of the shape `midiclock` and `cvBuddy` already ship — es9 needs
strictly *less* bespoke machinery than `kria` did, and `kria` was re-dispositioned.

| | |
|---|---|
| **PR A (precursor)** | Move `updateEs9Config` onto the engine handle's `setParam`; delete the card's push; add the unit test that a class change produces the right `outputModes`. Fixes D2 on `main`. **~2 h. MEDIUM risk — it touches the hardware safety path.** |
| **PR B (the face)** | `ES9_FACE` + `options` on 22 params + 2 `controlFamilies` + `es9-cell-actions.ts` + `Es9BridgeBody.svelte` + `EXTENSION_BODY_ROLES` + `STRICT_FACES` + testids on the legacy card + 2 `docs.controls` + drain both VRT lists + re-point 2 e2e tests + fix D3/D3b/D4/D5/D6/D7. **~10 h. LOW-MEDIUM risk.** |
| **Overall risk** | **LOW-MEDIUM.** No new capability, no new cell kind, no new role, no attest, no ART, +2 contract lines. The risk is concentrated in PR A |
| **Blocks** | Nothing blocks PR A. PR B is blocked only by PR A |

**Build it AFTER `midiLane`, not before.** `midiLane` is the direct heir to the shipped
`midiclock` body and settles the binder body shape with almost no new argument; es9's PR A
touches a hardware safety path and deserves its own attention. See the cohort note in
`../midiLane/spec.md §12`.

---

## 14. THE e2e SPECS PROMOTION TOUCHES

| spec | shell | effect |
|---|---|---|
| `es9-shell-lifetime.spec.ts` **test 1** | `/rack` (default) | ⛔ **RED.** `:76` asserts the lane class contains `moduleShellPlaceholder`; promotion emits `moduleShell` (`legacy-fallback.ts:165-179`). **Re-point to `moduleShell`** and keep the test — its subject (the bridge is owned with no card mounted) is unchanged and still valuable |
| `es9-shell-lifetime.spec.ts` **test 2** | `/rack` | ⛔ **RED.** `cardMounted()` polls `[data-testid="es9-status-{id}"]`, which is the LEGACY card's status row; the dock full view renders the FACE. **Re-point to `[data-testid="es9-led-bridge-{id}"]`** — the body's own lamp, which is the thing that mounts and unmounts with the pane |
| `es9-shell-lifetime.spec.ts` **tests 3, 4** | `/rack`, `?shell=legacy` | ✅ unchanged. Test 4 explicitly asserts the legacy render is untouched |
| `es9-card-shows-state.spec.ts` | `?shell=legacy` | ✅ unaffected by promotion — and **fix D3/D3b in this PR**, because the face PR is where someone finally reads it |
| `es9-per-leg-patching.spec.ts` | `rack` fixture ⇒ `?shell=legacy&seed=none` (`_fixtures.ts:91`) | ✅ unaffected. It drives `patch-trigger` on the legacy card and asserts the exact 8-edge set off the store |
| `es9-hardware.spec.ts` | opt-in `ES9_HW=1`, never CI | ⚠ its `waitConnected` asserts `es9-status-sut` `toContainText('ES-9')` — the device NAME, which the face removes. It runs on `?shell=legacy` through the `rack` fixture, so it stays green, but **note it in the PR body**: it is the one place the device name is still asserted, and that is now the legacy card's job alone |
| `cv-buddy-es9-reconcile.test.ts` | pure unit | ✅ unaffected — plain object fixtures, no UI. But see D2: this suite is exactly where the missing `updateEs9Config` push is *not* covered, because the planner returns `classSets` and nobody asserts what happens to them downstream |

---

## 15. MOCKS

* [`dock.html`](dock.html) — the dock faceplate at rest, bridge DOWN (the state every CI
  runner and every first-run user sees), with the removal table and the width measurement.
* [`dock-connected.html`](dock-connected.html) — the distinguishing state: bridge UP, one
  XRUN, and three OUT cells claimed by a CV Buddy.
