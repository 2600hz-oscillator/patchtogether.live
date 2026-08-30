# FACEPLATE BUILD SPEC — `nibbles` (**VIDEO**, a self-playing snake with CV taps)

> **SPEC + MOCKS. Nothing here is implemented.** Group analysis: [`../GAMES.md`](../GAMES.md).
> Siblings: [`../frogger/spec.md`](../frogger/spec.md) · [`../modtris/spec.md`](../modtris/spec.md)
> · [`../skifree/spec.md`](../skifree/spec.md). Precedent for the class:
> `.myrobots/2026-08-23-bespoke-wave1/pong/spec.md` — ⚠ and **nibbles is the module in this group
> where pong's argument transfers LEAST**, because it is VIDEO domain and pong is audio.
>
> **Mocks:** `dock.html` · `dock-screen-off.html` (self-contained, open in a browser).
>
> ⚠ **DOOM is excluded from this spec by name**, per the standing owner ruling. It is a game
> module and would fall inside every sweep here; nothing in this document applies to it and no
> file of its was opened.

**Verdict: PROMOTE. This is the only lane PICTURE in the group and the only module whose
determinism seam ALREADY EXISTS and is already proven byte-identical.** It is also the module
with the largest STOP-2 surface — a RESET button, a 1×–4× SCALE control that is currently doomed
component `$state`, and arrow-key steering that is the module's INSTRUMENT rather than an a11y
concern — so the parity work is real even though none of it touches the attested file.

Three things make this PR unusual and all three are measurements rather than opinions:

1. **`nibbles.ts` is IN the WebGL attest basis** (verified: all three named in `webgl-attest-hash.sh --list`). A face-only edit
   is hash-transparent, **measured in both directions** (§10.1). Any other edit to that file
   costs an owner-machine GPU re-attest CI cannot run — **so this PR touches `nibbles.ts` with
   `face:` and nothing else.**
2. **The resting-text ruling DELETES nibbles' `LEN` readout with no in-canvas fallback**, and
   restoring one would be a `paintFrame` edit — i.e. a GPU re-attest. §9.
3. **Promotion makes a ledgered raw-write debt unreachable without paying it**, which is the
   "quietly green forever" shape. One line pays it. §3.2.

---

## 0. THE CONSTRAINT MAP, READ FIRST

| registry | member? | what it means here |
|---|---|---|
| `contract-lock.txt:2347` | **`nibbles meta domain=video`** | ⚠ **the single most consequential line in this table.** `hasVideoSurface(def)` is `def?.domain === 'video'` and nothing else, so the lane tile paints a LIVE `VideoTileThumb` with nothing declared. §2 |
| `NON_SHELL_LANE_TYPES` | **NO** | the lane swaps. `laneRenderKind` returns `'placeholder'` today. |
| `CARD_PRODUCER_LANE_TYPES` | **NO — and CORRECTLY so, and it is CROSS-CHECKED** | `card-media-lifetime.test.ts` classifies `NibblesCard` as **`module-renders-itself`**: *"nibbles.ts paints a frame before the first tick and ticks its own clock, with a built-in greedy bot under AUTO; the card pushes only arrow keys and a reset."* ⚠ **That is a typed, deny-by-default verdict a human wrote and a gate anchors** — and it is exactly the opposite of `skifree`, whose card owns the game and which no gate classifies at all (GAMES.md §5). |
| `HEADLESS_MOUNT_LANE_TYPES` | **NO** | correct: nothing engine-visible depends on the card. |
| `EXEMPT_FROM_VRT` / `ALLOWED_PERMANENT_EXEMPT` | **NO — in NEITHER** | ⚠ the only module in this group that is not exempt. It has a committed card baseline and nine more. §11.1 |
| `STRICT_FACES` | **NO** | un-migrated. |
| `STRICT_DOCS` (`strict-docs.ts:375`) | **YES** | ⚠ **and the docs describe card chrome this face changes.** §12 |
| `module-manifest.ts` `DESCRIPTIONS` | **ABSENT — and that is FINE, checked** | `describeModule` falls back to `def.docs.explanation` for a video def (`:1090-1097`); only AUDIO modules are required to have a hand-written line. **Not a defect** — recorded so nobody "fixes" it. |
| `PUSH_CARD_CONTROLS` | **NO** | GENERIC tier; two params, so both get encoders. A face moves it to the FACE tier and re-ranks by `face.order`. |
| `RANGE_BOUND_CARDS` | **NO** | the card re-types `min={40} max={200}` (§13.4). ⚠ The boy-scout for this is the one that must NOT ride this PR. §10.1 |
| `raw-write-ledger.ts:269` | ⚠ **YES — `keys: ['auto'], kind: 'debt'`** | *"card button write — user gesture, should be undoable + synced"*. §3.2 |
| ART | **N/A** — video domain, outside the audio gate | ZERO |
| `_face-fixtures.ts` `VIDEO_FIXTURE` | pool member, index 5 of 13 | not the pick (`painter` is); 12 members of slack, promotion invisible to it |
| `scripts/e2e-skip-budget.mjs:563` | ⚠ **`nibbles.spec.ts` is PARKED** (FLAKE-PARK #1847) | §13.1 |
| `e2e/webgl-heavy-globs.ts` | ⚠ `nibbles-render-smoke.spec.ts` is a heavy-WebGL DRS member | so it runs in the real-GPU attest lane |
| `face-migration-inventory.ts:919-922` | **`bespoke-surface`, NO BLOCKERS** | *"a GAME: a snake viewport played on the keyboard; its outputs are taps off the running game."* ⚠ **this is the ONE of the four whose `why` is FACTUALLY CORRECT** — nibbles is the only card in the group with a keydown handler. GAMES.md §8.6. |
| **WebGL attest basis** | ⚠ **YES — VERIFIED, 3 files.** `webgl-attest-hash.sh --list` contains `video/modules/nibbles.ts`, `nibbles-game.ts` and `nibbles-bot.ts`. `NibblesCard.svelte` is **NOT** in it. | §10.1 |

---

## 1. WHAT THE MODULE IS FOR

**In one paragraph.** NIBBLES is **a video source that is also a self-generating CV/gate/audio
rig** — and the "also" is the module, not a bolt-on. Its three audio siblings in this group emit
gates and nothing else; nibbles emits a 320×200 picture, three gates (`pellet`, `death`,
`dir_change`), a continuous length CV, and **two pitched square waves whose frequency tracks the
snake's length** (`length 4 = A2 = 110 Hz`, `+12 length = +1 octave`). So the same running game
is simultaneously the picture in a video chain, the trigger source in a drum patch, and a
melodic voice that climbs as the snake grows. The verb a player performs is **LET IT RUN, OR
DRIVE IT**: flip AUTO and the greedy no-foresight bot plays itself into a corner and restarts —
a generator you patch and leave — or take focus and steer with the arrow keys. Nothing else in
the rack is a picture, a trigger source and a pitched voice from one state variable.

**The chain** (`nibbles.ts:198-720`):

1. **The clock is the VIDEO ENGINE's.** `surface.draw(frame)` accumulates `dt = frame.time -
   lastDrawTimeS` into `tickAccumS` and steps the game while `tickAccumS >= tick_ms/1000`, at
   most 4 ticks per frame (`:584-599`). ⚠ **This is a completely different clock from its three
   audio siblings**, which all subscribe to `getSchedulerClock()`; it is why §11's pin works and
   theirs does not (GAMES.md §4.1).
2. **AUTO.** `chooseDirection(state)` from `nibbles-bot.ts`, applied just before `gameTick`
   (`:442-451`). ⚠ The bot has **no foresight** and `NIBBLES_MAX_LENGTH = 119` is the empirically
   calibrated 95th percentile of its death-length distribution over 2000 seeded games (p50 = 67,
   max = 180, board = 4000 cells). That constant rebases **both** the length CV and the
   square-wave pitch, and `nibbles-bot.test.ts` fails loudly if the bot's strategy drifts.
3. **Events → outputs.** `drainEvents` → 10 ms `pulseGate` on `pellet`/`death`/`dir_change`, a
   15 ms/100 ms/exp-tail envelope on `gated`, and `updateLengthCvAndFreq` with a 20 ms
   `linearRamp` so a fast pellet chain does not zip the pitch.
4. **The picture.** A CPU rasteriser paints a 320×200 RGBA buffer (background, border, food,
   snake head/body/tail, then a **scanline darken of every other row to 85 %**) and uploads it
   with `texSubImage2D`; the fragment shader is a Y-flipped passthrough.
5. **The card.** Polls `read(node,'snapshot')` at ~30 Hz on a `setInterval` and
   `putImageData`s it. ⚠ **The card is a VIEWER, not a producer** — the module has already
   painted and uploaded before any card exists (`:568-569`).

**What each control genuinely changes.**

| param | shape | read at | effect |
|---|---|---|---|
| `auto` | `0..1 discrete`, default 0 | `applyAutoDirection` (`:443`) and `advanceGame`'s restart branch (`:471`) | bot self-play + auto-restart on death. ⚠ `setParam` also resets `lastAutoDir` on the transition *"so a freshly-enabled AUTO doesn't stall"* (`:700-705`) — a real, deliberate detail |
| `tick_ms` | `40..200` linear, default 80 | `surface.draw` (`:588`), **every frame** | the game-tick period, clamped `max(0.04, min(0.2, …))`. ~12 Hz at the default |

⚠ **Neither control is inert and neither is latency-bound.** That is worth stating because it is
the exception in this group: `frogger.initialTime` only applies at the next START, `modtris.levelStep`
applies never, and `skifree` has no params at all. **nibbles is the only module in the wave whose
whole declared control surface actually works.**

---

## 2. ⚠ THE FACT THAT DEFINES THIS FACE: IT IS VIDEO DOMAIN, SO THE LANE GETS A PICTURE FREE

GAMES.md §2 is the group statement; this is what it buys here.

```
module-shell-model.ts:177-179   hasVideoSurface(def) → def?.domain === 'video'
module-shell-model.ts:237-240   laneGlyphFor(def)    → 'picture' when hasVideoSurface
ModuleShell.svelte              <VideoTileThumb nodeId={id} />
```

**`domain === 'video'` is the whole condition** — no opt-in, no face field, no port check — and
the thumb takes `nodeId`, so the picture is **per-node by construction**. Every audio module in
waves 2, 3 and this one was refused a lane picture because `ShellExtensionGlyphProps` carries no
`nodeId`; **nibbles is not on that seam at all.**

⚠ **The declaration is counter-intuitive: `face.glyph: 'none'` is MANDATORY.** `laneGlyphFor`
returns `'picture'` before it ever reads `face.glyph`, and any non-`'none'` literal on a def whose
`primaryAudioOutPortId` resolution does not apply is a DEAD glyph the lint reddens unconditionally.
So `'none' + blank tile` and `'none' + live thumb` are **indistinguishable from the declaration**.
**Assert `hasVideoSurface`, never infer the picture from the face.** MUST-VERIFY §15.1.

⚠ **AND NIBBLES DECLARES TWO `audio` OUTPUTS** (`snake`, `gated`) **and still gets the picture**,
while `skifree` declares a `video` OUTPUT and gets none. The port list is a decoy; the DOMAIN is
the predicate. GAMES.md §2.3.

### 2.1 The lane tile fits EXACTLY, which is a measurement worth having

`laneBodyPlan` caps a `compact` row at `LANE_ROW_MAX_CELLS_WITH_GLYPH` when a glyph is present.
**nibbles has exactly two ranked params**, so at `compact` the tile is **the live picture + TICK +
AUTO with nothing evicted**. The #1785 rule that a PICTURE outranks ranked controls — which is
what strips cells off `backdraft`'s tile — **never has to fire here.** MUST-VERIFY §15.1: derive
it through `curatedFace`, and confirm the cell count is 2 rather than assuming the cap.

---

## 3. STOP 2 — does every way of getting DATA IN survive? (the largest surface in the group)

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/NibblesCard.svelte
```
**Three `<button>` hits** (`:137`, `:159`, `:160`) — plus the keydown handler and the score row
the grep does not look for.

| # | affordance | site | after promotion |
|---|---|---|---|
| 1 | `<ModuleTitle defaultLabel="NIBBLES">` | `:132` | **YES** — the shell's own title bar |
| 2 | `<PatchPanel>` — all seven output jacks, with `dir_change → 'DIR'` / `length_cv → 'LENGTH'` relabels | `:113`, `:134` | **YES** ⚠ carry the relabels: `portsFromDef`'s overrides are what make the rail readable |
| 3 | TICK `<Knob>` | `:152-157` | **YES** — rank 1, `paramCells` not needed (knob is the generic default and the card draws a knob) |
| 4 | AUTO `<button class="btn auto-btn">AUTO ON/OFF</button>` | `:137-144` | **YES — as a `'toggle'` cell, DERIVED not declared.** §8 |
| 5 | RESET `<button data-testid="nibbles-reset">` | `:160` | **YES — as a `ShellActionCell` with an AUDITION probe.** §8.2 |
| 6 | SCALE `<button data-testid="nibbles-scale">{scale}×</button>` (1→2→3→4→1) | `:159`, `:84-86` | ⚠ **YES, but ONLY if it moves off component `$state`.** §3.1 — **and it is a BUG FIX, not a workaround** |
| 7 | ARROW-KEY STEERING — `role="application"`, `tabindex="0"`, `onkeydown` → `extras.pushDirection` | `:89-105`, `:120-130` | ⚠ **YES via `fullViewBody`, and it is the INSTRUMENT, not a11y.** §3.3 |
| 8 | the 320×200 screen canvas | `:147-149` | **YES — twice.** The lane tile gets `VideoTileThumb` free (§2) and the dock body gets the real preview (§7) |
| 9 | the `.score` row — `LEN {n}` + a `†` when dead | `:136` | ⛔ **NO — FORBIDDEN by the resting-text ruling, and there is no in-canvas fallback.** §9 |
| 10 | the `.tip` line — *"Click to focus → arrow keys drive snake. AUTO = self-play."* | `:164` | ⛔ **NO — prose on a faceplate.** It moves to right-click ANNOTATE, sourced from the authored `docs`. §9.2 |
| 11 | `class:has-focus` glow on the card | `:123`, `:191-193` | **YES, and it MUST survive** — it is the only signal that arrow keys will work. It moves onto the body's own focusable element. §3.3 |
| 12 | every `data-testid` (`nibbles-screen`, `nibbles-auto`, `nibbles-reset`, `nibbles-scale`, `nibbles-score`) | — | ⚠ **carry them verbatim onto the equivalent face elements.** `nibbles.spec.ts` and `nibbles-render-smoke.spec.ts` read them, and `nibbles-score` is the one that must be re-pointed rather than kept (§9) |

**Ten of twelve survive unchanged or better. Two are deleted by a ruling, and one of the two
(the score) has a real cost.**

### 3.1 ⚠ SCALE is component `$state`, which means it is ALREADY BROKEN

`let scale = $state(1)` (`NibblesCard.svelte:40`). Component state dies with the component — and
under the shipping shell an un-migrated module's card exists **only inside the dock full view**,
so **collapsing the pane already resets a user's 4× zoom to 1× today**, and the dock's LRU
eviction does it to a module the user never touched. That is the #1531 / #1574 / #1583 class
verbatim.

**So "SCALE must survive promotion" and "SCALE is broken" have the SAME fix**, and it is the one
the platform already mandates for the SCREEN toggle: **`node.data.previewScale`**. It survives a
tab switch, a remount, a reload and syncs to collaborators.

⚠ **This is the one place where functional parity and a bug fix coincide, and it must not be
described as a workaround.** *"We would lose the zoom"* is never an owner choice to surface — it
is a thing to solve, and solving it fixes a live defect. ⚠ And note what it does NOT need: SCALE
must **not** become a `ParamDef`. A param would be a `nibbles.ts` edit — **a GPU re-attest**
(§10.1) — to express a per-view preference that has no business in the audio contract.

### 3.2 Where state lives — `params` vs `node.data`, and a LEDGERED DEBT

| what | lives in | tagged `LOCAL_ORIGIN`? |
|---|---|---|
| `auto`, `tick_ms` | `params` | `tick_ms` via `cardParams`'s `set()` ✓ ; ⚠ **`auto` NOT** — `toggleAuto` (`:74-77`) writes `patch.nodes[id].params.auto` directly through the store |
| `scale` | ⚠ component `$state` — **nothing.** §3.1 | n/a |
| the GAME | factory-internal, deliberately (`nibbles.ts:29-31`: *"never touches node.data, so the persistence layer naturally drops it"*) | n/a |

**The `auto` write is LEDGERED**: `raw-write-ledger.ts:269` — `'ui/modules/NibblesCard.svelte':
{ keys: ['auto'], kind: 'debt', why: 'card button write — user gesture, should be undoable +
synced' }`.

⚠ **Promotion makes that debt UNREACHABLE WITHOUT PAYING IT**, which is the worst outcome
available. The face's toggle cell writes through the shell's sanctioned path, so a user can no
longer reach the raw write — but the code and the ledger entry both stay, and the ledger's
anchoring (*"an entry naming a write that no longer exists → RED"*) keeps it **green forever**
while describing a path nobody can take. That is the "stale scoping claim goes quietly green" shape.

**Fix it in this PR: one line.** `toggleAuto` becomes `setNodeParam(id, 'auto', …)`, and the
ledger entry is DELETED **in the same commit** (leaving it would then be the RED stale-exemption
case, which is the anchoring working). ⚠ Per the owner ruling *"NEVER ledger payable debt — fix it
in one sweep"*, paying a one-line debt while standing here is the rule, not a courtesy.

⚠ **And note the wave-level census result**: `mutate.guard`'s regex anchors on the literal token
`.params`, so it is blind to `.data` writes — **but it is NOT blind to this one**, and the ledger
proves it. `frogger`, `modtris` and `skifree` contribute clean/empty rows (their specs' §3.1);
**nibbles is the only module in this group with a `params` discipline finding, and the gate
caught it correctly.** That is a data point in the gate's FAVOUR and should be reported as such.

### 3.3 ⚠ ARROW KEYS ARE THE INSTRUMENT. THAT IS NOT KEYBOARD-A11Y WORK.

Standing owner ruling: **no keyboard-a11y work; Tab IS the flip gesture; never file or fix
keyboard-nav a11y.** This spec proposes none, and the distinction has to be made explicitly
because it is easy to conflate:

- **a11y keyboard nav** = reaching and operating a CONTROL without a mouse. Not proposed, not
  designed, not touched. `Knob`'s existing `role="slider"` keys are untouched.
- **nibbles' arrow keys** = the module's PLAYING INTERFACE, exactly as a ribbon is `moog956`'s and
  a mouse is `skifree`'s. `pushDirection` returns `false` when AUTO is on; the card declares
  `role="application"` **precisely because it owns its key handling** and Svelte's a11y rules do
  not model `application` as interactive (`:116-119`).

**So the `fullViewBody` must be focusable and must take `keydown`, and it must carry the
`has-focus` affordance with it** (row 11) — otherwise the face ships a game with no way to play
it, which is a parity loss, not an a11y question. ⚠ The body is DOCK-ONLY, so **a lane tile can
never be steered** — which is true of the card today too (the card is not in the lane), so it is
not a regression. Say it plainly rather than letting a reviewer discover it.

---

## 4. THE RANK — `face.order`

| # | key | why it earns this rank — an argument that would be WRONG for a different module | what it costs below |
|---|---|---|---|
| 1 | `tick_ms` | **It is the module's TEMPO, and nibbles is the one module in this group whose tempo control is also its PITCH-EVENT rate.** Everything downstream — the three gates, the `gated` envelope retrigger, the rate at which `length_cv` steps — is clocked by how fast the snake moves. ⚠ **And it is read EVERY FRAME** (`:588`), so it acts on the next tick. A rack cares about rate; this is the rate. | evicts `auto` from mini |
| 2 | `auto` | **Genuinely second, and the argument is that it is a MODE rather than a quantity.** It changes *who is playing*, not *how fast*. On a module you patch and leave, AUTO is the setting you flip once at spawn and never touch again, while TICK is the one you ride. ⚠ It is also the only control whose effect is invisible at a glance — a bot-driven snake and a human-driven snake look identical for the first few seconds — which is a reason to rank it lower, not higher. | — |

**THE TIER LADDER, read back as a sentence.** With `hasVideoSurface` true the caps are the
WITH-GLYPH column: **at mini you get the picture and TICK; at compact, the picture, TICK and AUTO;
at plate, the same; at the dock, both plus the live preview, SCREEN, SCALE, RESET and the arrow
keys.** ⚠ **MUST-VERIFY §15.1** — derive it through `curatedFace`, never from `LANE_PLATE_MAX_CELLS`;
four sibling faces got that wrong, and this is a WITH-GLYPH module where the cap differs.

**THE LOSER, NAMED.** `auto` lost mini to `tick_ms` for the mode-vs-rate reason above, and the
revert is one swap (§14.2). ⚠ There is a real argument for the swap that a reviewer should see:
AUTO is what makes nibbles a self-running generator at all, and a rack owner glancing at a mini
tile may care more about *"is it playing itself?"* than about how fast. It loses because a mini
tile's ONE cell should be the one you actually adjust.

---

## 5. VOCABULARY — NOTHING NEW, AND THAT IS THE POINT

**5.1 NO new param. NOT EVEN `freeze`.** Its three siblings all need one; nibbles does not, and
the reason is measured:

- the determinism pair **already exists** (`__nibblesVrtSeed` + `__videoEngineFreezeTime`) and is
  already the pinned pair a sibling VRT spec uses (§11);
- adding a `freeze` param would be a **`params` edit on a def in the WebGL attest basis**, i.e.
  an owner-machine GPU re-attest CI cannot run (§10.1, measured), **to buy an assertion that
  already holds.** That is the `4plexvid` conclusion reached from the other side, and it is
  written into that module's roster entry in caps: *"DO NOT 'FIX' THAT BY ADDING A `freeze`
  PARAM."*

**5.2 NO roster on `auto`, and the moog962 trap does NOT apply.** A `2..3 discrete` param drawn as
a KNOB has two reachable positions across the dial and quantises back — `faces-parity` failed
`moog962` on exactly that, twice. ⚠ **`auto` is `0..1 discrete`, and `paramCellKind` has a
dedicated branch for that shape**: `looksLikeToggle(p)` → `'toggle'` → a `<Toggle>`, before
`options` is ever consulted. So the states are selectable **by derivation**, and declaring an
`options` roster would be inventing semantics the module does not have. **Checked deliberately,
because the trap is real one param shape away.** MUST-VERIFY §15.2 — assert the derived kind is
`'toggle'`, not that it "should be".

**5.3 NO landmarks, NO `units`.** `units: 'ms'` on `tick_ms` is the strongest candidate in this
group — the milliseconds are the quantity a player reasons about. ⚠ **Refused for the sharp
reason**: a `format` on the param makes the readout PAINT (`paintsReadout` survives only when the
text is an option/landmark NAME **and** the param declares no `format`), which re-introduces a
resting decimal under the dial by the back door — mechanism five. The ms go in `aria-valuetext`
(§9.3). ⚠ **And declaring `units` would be a `params` edit — a GPU re-attest.** The ruling and the
cost point the same way, which is worth noticing.

---

## 6. BAND STRUCTURE — one band, and no rail

```ts
pages: [
  // ONE band. Two params, one idea — HOW THE SNAKE MOVES — and splitting a
  // rate from a mode would invent a distinction the module does not have.
  // A page costs a ~81px band header on a dock that folds at 720p.
  //
  // ⚠ `order` and `pages` AGREE. Stated so a reader does not go hunting for
  // the disagreement the house style usually carries.
  { id: 'snake', label: 'snake', controls: ['tick_ms', 'auto'] },
],
```

**ONE band, so no tab rail.** ⚠ **And nibbles is exactly the module a reader might expect to be
TABBED, so the refusal is argued rather than skipped.** The owner's control-heavy ruling
(2026-08-18) says *"lots of controls of DIFFERENT types"* gets a backdraft-style rail — backdraft
has eight semantic pages. nibbles has **two params plus three body affordances**. The rail engages
at `DOCK_TAB_MIN_BANDS = 7`, and *"do NOT pad pages to force the rail"* is explicit.
`face.tabbed` is **owner-instruction-only** (`FACE_TAB_OPT_IN`, verbatim quote required) and is
not reached for. **One band is the honest answer and this face is not control-heavy.**

**REAR CARD.** nibbles has **NO INPUTS AT ALL** (`inputs: []`), so the input rail is empty and
there is nothing to curate there. The OUTPUT rail has seven ports across four cable domains
(`video`, `gate`×3, `cv`, `audio`×2) and takes the **derived default**: one `out` section
splitting per CABLE DOMAIN once the rail out-runs a column. ⚠ **Author a `face.rear.groups`
entry only if the split should mean something other than the domains** — and here it should:

```ts
rear: { groups: [
  { id: 'picture', direction: 'output', ports: ['out'] },
  { id: 'events',  direction: 'output', ports: ['pellet', 'death', 'dir_change'] },
  { id: 'voice',   direction: 'output', ports: ['length_cv', 'snake', 'gated'] },
] },
```

because *"the picture / the events / the voice"* is the module's actual structure and the domain
split would put `length_cv` (a pitch source) away from the two oscillators it pitches. ⚠ **Every
group declares `direction: 'output'`** — the default is `'input'` and module-face-lint refuses a
group whose ports are not on the direction it declares. MUST-VERIFY §15.3.

---

## 7. THE BODY — `face.extension: 'nibbles'`

### 7.1 Why a body, and what it must carry

```ts
// $lib/ui/modules/nibbles/shell-extension.ts
import NibblesScreenBody from './NibblesScreenBody.svelte';
export default { fullViewBody: NibblesScreenBody } satisfies ShellExtension;
```

`spirographs` is the template (`592ca4f6b` → `$lib/ui/modules/spirographs/shell-extension.ts`),
and its file header is the reason: **spirographs shipped the SCREEN toggle on its CARD, was
promoted, and the ruling was then satisfied only on a surface nobody can reach (#1928).** Do not
repeat it.

The body carries **five** things, and all five are STOP-2 rows:

| in the body | why it cannot be a cell |
|---|---|
| the live 320×200 preview | a picture, not a control |
| **SCREEN ON/OFF** | required by the 2026-08-18 owner ruling for every video module; `previewCollapsed` appears in **zero** shell files, so `fullViewBody` is the only route |
| **SCALE 1×–4×** | a per-view preference; making it a `ParamDef` costs a GPU re-attest (§3.1) |
| **RESET** | ⚠ it COULD be a `ShellActionCell` — §8.2 argues it should be, and the body hosts only its gesture if the cell route is refused |
| **arrow-key focus** | the instrument (§3.3); the body must be focusable and carry the `has-focus` affordance |

### 7.2 The zone map

```
┌─ dock full view ────────────────────────────────────────────────┐
│ NIBBLES                                                 [ ✕ ]   │
├─────────────────────────────────────────────────────────────────┤
│   ┌────────── fullViewBody ──────────┐                           │
│   │ ┌──────────────────────────────┐ │  the live screen,         │
│   │ │  ·                           │ │  320×200 at 1×,           │
│   │ │        ▓▓▓▓▓●               │ │  image-rendering:pixelated│
│   │ │             ▓                │ │  scanlines baked in       │
│   │ │  [1×]          [SCREEN ON]   │ │  by the module            │
│   │ └──────────────────────────────┘ │                           │
│   │   ⌨ focus ring when steerable    │                           │
│   └──────────────────────────────────┘                           │
├─ snake ─────────────────────────────────────────────────────────┤
│      ◉ TICK        [ AUTO ]        ▷ RESET                       │
└─────────────────────────────────────────────────────────────────┘
```

**WIDTH.** ⚠ **This is the one face in the group that genuinely EARNS width, and the amount is a
measurement rather than a claim.** *"A genuine earner is a live picture, a scope trace, a video
preview, an XY pad."* nibbles' preview is 320 CSS px at 1× and **1280 px at 4×**.

- **The plate is sized to the 1× preview** (~350–380 px), not to 4×.
- **At >1× the preview must SCROLL inside its own `overflow: auto` box, never widen the plate.**
  ⚠ The card does the opposite — `.mod-card { width: max-content }` and
  `style="width:${320*scale}px"` (`:110`, `:147`, `:174`), so a 4× zoom makes the CARD 1280 px
  wide. That is exactly the *"useless gray horizontal space"* the compact ruling forbids, and a
  face must not inherit it.
- ⚠ **`face-width-source.test.ts` and `workflow-shell-faces.spec.ts`'s content-vs-plate leg are
  both DENY-BY-DEFAULT with a NAMED exemption carrying the thing that consumes the width.** If
  nibbles needs an entry, it says **"the live 320 px game preview"** — and it must be measured at
  1×, because an entry justified by 4× would be justifying the bug. MUST-VERIFY §15.4.

### 7.3 SCREEN ON/OFF — required, and this is the one module in the group the ruling ACTUALLY COVERS

The 2026-08-18 owner ruling — *"'screen on / off' on the card like that is a thing all video
modules should have moving forward"* — is about **video modules**, and nibbles is the only
video-domain module in this group. Its three siblings are audio, so their SCREEN switches are
**this spec's proposal rather than a rule** (see their §7.3, each flagged as an owner question).
**Here it is mandatory.**

- **OFF collapses the preview and reclaims its vertical space; the module KEEPS RENDERING.** Do
  not tear the producer down — that is the #1720/#1721 class. ⚠ **For nibbles this is not merely
  a policy, it is load-bearing:** `surface.draw` is where the GAME TICKS (`:584-599`), so a
  collapse that stopped the draw would **stop the game and silence every output.** The toggle
  must gate only the CARD-SIDE POLL, never the surface.
- **State on `node.data.previewCollapsed`** — the same key the card would have used, so a rack
  saved before the promotion does not silently re-open its collapsed preview.
- **Placement is a MEASUREMENT: OVERLAY the preview's bottom-right corner on a translucent
  backplate (`rgba(5,6,8,0.72)`), NEVER a row of its own.** A stacked row cost spirographs
  ~18.8 px against ~11 px of slack and `io-spec-consistency` caught the overhang. The backplate
  exists because a transparent button over a live picture was never legible; keep a small
  `min-height` on the wrap so the button does not leave the box when the canvas is gone.
- **SCALE goes in the opposite corner (bottom-LEFT), same treatment**, for the same reason: two
  overlays cost zero height; two rows cost ~37 px.

`dock-screen-off.html` is the second mock, and it shows the state that matters: **the plate is
short, the gates still fire, and the pitched voices keep playing.**

---

## 8. CONTROL INVENTORY — every primitive decision, argued

| face key | primitive | derivation | why not the alternative |
|---|---|---|---|
| `tick_ms` | **`'knob'` — the GENERIC default, DECLARED NOTHING** | continuous linear, no `options` → `'knob'` | PARITY: `NibblesCard.svelte:152` renders a `<Knob>`. ⚠ Its sibling `modtris` DECLARES `'fader'` because its card renders `<NeonFader>`s. Each face matches its OWN card; copying across the group would be a parity loss nothing gates. |
| `auto` | **`'toggle'` — DERIVED, not declared** | `looksLikeToggle` on a `0..1 discrete` param → `<Toggle>` | ⚠ **NOT a knob** (two reachable positions across a whole dial = the inert `moog962` control, §5.2) and **NOT a segmented roster** (that would invent names the module does not have). The derivation already produces the right primitive; **assert it, do not declare it.** |
| `auto` | ⚠ **NOT `face.momentary`** | `momentary` is for a press that must not latch (tomtom's `strike`, `momentary-params.ts`) | AUTO is a LATCHING mode and must persist across a reload. Checked deliberately: the two look identical at the ParamDef and are opposite in behaviour. |
| **RESET** | **`ShellActionCell`, `mode: 'trigger'`, with an `engine-message` AUDITION probe** | §8.2 | |
| — | **NO `hero`** | | Considered: `hero.cell` for the preview. ⚠ **REFUSED, and the reason is mechanical**: *"a `hero.cell` SUPPRESSES the shell glyph at the dock"* — and for a video module the glyph IS the `VideoTileThumb`. A hero would trade the free per-node picture for a bespoke one. The `fullViewBody` paints above the bands without touching the glyph binding. |
| — | **NO PF-14 panel** | | a panel's first legal rank is 7; nibbles has two params. |
| — | **NO `face.bareCells`** | | it hides a per-control caption a SECTION HEADING already conveys. One band, two differently-named controls — the captions disambiguate. mixmstrs is the only adopter and should stay so. |

### 8.2 RESET is an ACTION CELL, and the probe is the whole design

`ShellActionCell.probe` is **required** (`shell-cells.ts:157`). Until 2026-08-02 faces-parity's
`action` branch asserted `toBeEnabled()`, clicked, and asserted nothing — **a dead audition passed
the face green**, and sixstrum shipped a face over an instrument that could not be sounded.

`extras.reset()` (`nibbles.ts:634-640`) re-seeds the game, updates the CV and pitch, repaints and
re-uploads. ⚠ **It writes NOTHING to `node.data` and nothing to `params`** — the game is
factory-internal by design (`:29-31`) — so `readParam` and `readData` are **structurally blind to
it**, exactly as they are to samsloop's REC arm. The observable is the **AUDITION LEDGER**: per
press, did the seam resolve a callable off the live engine handle and call it.
`delivered: false` is **recorded, never dropped** — "never pressed" and "pressed and reached
nothing" must be distinguishable.

```ts
probe: { effect: { kind: 'audition', seam: 'engine-message' } }
```

⚠ **Do NOT reach for a `data-rev` probe** — *"a revision-only probe passes on a dead button that
bumps the counter"*. ⚠ And `getActiveEngine()` (`$lib/audio/engine-ref.ts:23`) is already exported
and already consumed from plain `.ts`; **two independent agents have invented the false blocker
that a shell-cells action needs a platform PR to reach the engine. Assume a third will.**

⚠ **A `controlFamilies` entry for the action IS in the contract.** Batch 3 added three such lines.
So the RESET cell costs `task docs:accept` plus a `docs.controls` entry for the family
(STRICT_DOCS completeness) — **and that is a `nibbles.ts` edit.** §10.1: **if `controlFamilies` is
required on the def, it is HASH-TRANSPARENT** (it is in `HASH_TRANSPARENT_PROPS` alongside `docs`
and `face`), so it is still free. **MEASURE IT before assuming**, the same way §10.1 measured
`face`.

---

## 9. ⛔ THE RESTING-TEXT RULING — nibbles is the group's EXPENSIVE case

**The ruling** (GAMES.md §1): a game's score and lives painted INSIDE the playfield canvas are
ALLOWED; a score or lives row rendered as CHROME BESIDE the playfield is FORBIDDEN.

### 9.1 The `LEN` row is FORBIDDEN, and there is NO in-canvas fallback

`NibblesCard.svelte:136`: `<div class="score" data-testid="nibbles-score">LEN {score}{alive ? ''
: ' †'}</div>` — a labelled derived value with a state glyph, sitting at rest beside the picture.
Measured against the exhaustive permitted list — module NAME, TAB/SECTION labels, CONTROL
CAPTIONS, option/landmark NAMES that disambiguate a control's own position — **it is none of the
four.** It is the hero readout strip (#1957) with a different label. **REFUSED BY NAME.**

⚠ **And unlike frogger and modtris, nibbles has NOTHING PAINTED IN ITS CANVAS to fall back on.**
MEASURED at the source: `paintFrame` (`nibbles.ts:514-552`) draws the background, a one-pixel
border ring, the food cell, the snake body back-to-front, and a scanline darken. **Zero text.**
There is no `fillText`, no glyph table, no font.

**So the ruling does not RELOCATE the score here. It DELETES it.** Its home is the accessible name
(§9.3), which is speakable and assertable — and `nibbles.spec.ts`'s `readScore` already reads the
value through `eng.read(node,'score')` rather than off the DOM, so **no assertion has to be
weakened to survive the removal.** ⚠ The `data-testid="nibbles-score"` locator is the one testid
that must be RE-POINTED rather than carried (§3, row 12).

⚠ **Restoring a visible score would be a `paintFrame` edit — and `nibbles.ts` IS IN THE WEBGL
ATTEST BASIS**, so it costs an owner-machine GPU re-attest CI cannot run (§10.1, measured). **Do
not fold that into the face PR.** If the owner wants a painted score it is a separate, priced,
owner-facing change. **This is the sharpest consequence of the ruling in the whole wave and it is
recorded rather than absorbed.**

### 9.2 The `.tip` line is also refused

*"Click to focus → arrow keys drive snake. AUTO = self-play."* (`:164`) is a SENTENCE, and
**faces carry almost no prose**: plain labels and values, with explanation moving to right-click
ANNOTATE sourced from the authored `docs`. ⚠ It is genuinely useful text — it is the only place
the module tells you how to play it — so **the `docs.explanation` must carry the same information
so annotate can surface it** (§12), and the `has-focus` ring (§3, row 11) must survive so the
affordance is discoverable without prose.

### 9.3 The ARIA contract

| element | contract |
|---|---|
| the body's screen canvas | `role="img"`, `aria-label="NIBBLES — length 17, alive, auto-play on"` (`"length 17, dead"` when `!alive`). ⚠ Not `aria-valuetext`: a picture is not a range role. **This is where the deleted `LEN` and the `†` become speakable**, and it is what every spec proving the face tracks the game now reads. |
| the lane tile's `VideoTileThumb` | carries the shell's own generic label. ⚠ **Do not duplicate the game state onto it** — it is a per-node thumbnail, the shell owns it, and a module-authored label there would be resting text on a surface with no body. |
| `control-tick_ms` | `aria-valuetext`: `"80 ms — 12.5 ticks per second"`. The ticks-per-second is what a player feels and it is `1000/tick_ms`, a DERIVED quantity with a live negative control (`auto` must not move it) — a permanent leg of the face model test. |
| `control-auto` | `aria-pressed` + `aria-valuetext`: `"self-play"` / `"arrow keys"`. ⚠ **Those two strings are option NAMES that disambiguate the control's own position, so they may PAINT** as the toggle's own label — the one place in this face where derived-looking text is permitted, and the rule that permits it is worth naming: a NAME disambiguates otherwise-identical states, a NUMBER restates the dial. |
| the SCREEN button | `aria-pressed={!previewCollapsed}`, `SCREEN ON` / `SCREEN OFF`, and a `title` saying **the game keeps playing and every output keeps firing** (§7.3). |
| the SCALE button | `aria-label="Preview scale 1×"`; the `{n}×` text is the control's own option NAME, so it paints. |
| RESET | `ShellActionCell` label `RESET`; the observable is the audition ledger, not text. |
| the body wrapper | `role="application"`, `tabindex="0"`, `aria-label="NIBBLES — arrow keys drive the snake when AUTO is off"`, carried verbatim from the card (`:126`). ⚠ **The instrument, not a11y** (§3.3). |
| every param cell | `data-testid="control-<paramId>"`; `faces-parity` asserts exact multiset equality against the def's param ids and scans the whole `dockShell` **including the body**. |

---

## 10. COST

| item | cost |
|---|---|
| **WebGL attest** | ⚠ **`nibbles.ts`, `nibbles-game.ts` and `nibbles-bot.ts` are IN the attest basis.** **ZERO for a `face`-only edit — MEASURED BOTH WAYS, §10.1.** Any other edit to those three files costs a real-machine re-attest CI cannot run. `NibblesCard.svelte` is NOT in the basis, so card edits are free. |
| **contract-lock** | **UNCHANGED — and it must stay unchanged.** No new param, no removed param. ⚠ **Expect an EMPTY `docs:accept` diff on the contract**, apart from a `controlFamilies` line if the RESET action declares one. **A non-empty diff you cannot attribute is a finding.** |
| **docs** | nibbles is in `STRICT_DOCS` (`:375`). ⚠ **The `docs.explanation` DESCRIBES CARD CHROME THIS FACE CHANGES**: *"The card also has a RESET button, a 1x-4x zoom button, and a live LEN readout (a dagger appears when the snake is dead) … the on-card scale button cycles … while only the screen grows."* Every clause of that is about a surface the promotion removes. **Rewrite it in this PR** — and fold in §9.2's how-to-play sentence so annotate can carry it. ⚠ `docs` is hash-transparent, so this is free. |
| **ART** | **ZERO** — video domain, outside the audio gate. |
| **VRT** | §11. **2 face scenes ADDED, 0 moved** — the card scene captures at `?shell=legacy`, so promotion does not change it. |
| **Push 2** | GENERIC today. A face moves it to the FACE tier: two turnable params in `face.order` order. **Accept the golden diff deliberately, with the reason written in the test.** |
| **New code** | one `shell-extension.ts`, one `NibblesScreenBody.svelte` (2D `putImageData` — ⚠ **must stay 2D**; a WebGL body would be a new basis file), the `previewScale`/`previewCollapsed` `node.data` moves, the RESET action cell + probe, one `STRICT_FACES` line, one `FACES` roster row with `videoFaceWhy` + `simPin`, one `nibbles-face-model.test.ts`, the one-line `setNodeParam` fix and the ledger deletion. |
| **Conflict surface** | `strict-faces.ts` · `_shell-faces.ts` · `shell-cells.ts` (one `SHELL_CELLS` record for RESET) · `push-card-config.ts` golden · `raw-write-ledger.ts` · `contract-lock.txt` (GENERATED — take main and re-run the accept task). |

### 10.1 ⚠ THE ATTEST MEASUREMENT, BOTH DIRECTIONS

Wave 4's `picturebox` correction is why this was MEASURED rather than inherited: the first attest
reading there looked like a platform defect and was false. Run non-mutatively through
`scripts/attest-code-basis.ts`'s own `normalizeForHashWithReport`, on the real
`packages/web/src/lib/video/modules/nibbles.ts`:

| tree state | normalised digest (first 16) | stripped props |
|---|---|---|
| baseline | `5f29cf092c8d45fd` | `["docs"]` |
| `+ face: { glyph:'none', order, pages }` | `5f29cf092c8d45fd` **UNCHANGED** | `["face","docs"]` |
| `+ face + a def-level `noUserControl[]`` | `5f29cf092c8d45fd` **UNCHANGED** | `["face","noUserControl","docs"]` |
| `+ a NESTED `face:` (negative control) | `95e993d0c16741f2` **MOVED** | `["docs"]` |
| `NIBBLES_MAX_LENGTH 119 → 120` (positive control) | `09a90ac6d20ba75d` **MOVED** | `["docs"]` |

**Both controls fire**, so the instrument is not blind in either direction — which is the half a
single "unchanged" row cannot establish. The mechanism is `HASH_TRANSPARENT_PROPS` = `['docs',
'controlFamilies', 'face', 'noUserControl']`, stripped **only** when the property is a direct
member of a MODULE-SCOPE def object literal; the nested-`face` control is the gate's own
negative control reproduced.

> **THE OPERATIVE RULE: a nibbles face PR that adds ONLY `face` (and, if the RESET cell needs one,
> `controlFamilies`) costs ZERO GPU. ANY other edit to those three files costs a real-machine
> re-attest.**

That is why this spec refuses a `freeze` param (§5.1), refuses `units` (§5.3), refuses to paint
the score (§9.1), refuses to make SCALE a param (§3.1), and **splits the range boy-scout into its
own PR** (§13.4). ⚠ **Merging them would convert a free PR into one held hostage to an attest
window** — wave 4 named that the single most avoidable cost in a face wave. ⚠ **And re-measure the
`controlFamilies` claim before relying on it** (§8.2): it is in the strip list, but measure rather
than assume.

---

## 11. DETERMINISM AND VRT — the seam ALREADY EXISTS and is ALREADY PROVEN

**Two new scenes** — `face-nibbles-compact`, `face-nibbles-dock` — added by hand to the `FACES`
roster. ⚠ Nothing ties that roster to `STRICT_FACES`; a promoted module missing from it silently
has no VRT scene.

⚠ **BOTH scenes carry a live picture here**, unlike its three siblings whose compact tiles are
static: the compact tile paints a `VideoTileThumb` through `hasVideoSurface` and the dock body is
the module's own preview. **So both need the pin, not just the dock.**

**`videoFaceWhy` IS MANDATORY.** It is the **video-zone boot selector first** and the freeze
opt-in second. Without it a video module takes the AUDIO boot path, which spawns into a mixer
channel column and then waits — with no explicit timeout, inheriting the 90 s test timeout — for a
`pinned-mixmstrs.data.columns['1']` membership a video node never acquires. `backdraft` is the
measured precedent: *"both its scenes timed out in that waitForFunction."* ⚠ **A 90 s timeout at a
`waitForFunction` reads as "CI is slow, raise the budget", and raising it buys another 90 s of
waiting for a condition that can never become true. "Slower" and "never" need opposite fixes.**

**`simPin`: TWO GLOBALS, BOTH ALREADY IN THE MODULE, BOTH ALREADY REVIEWED.**

```ts
simPin: [
  { global: '__videoEngineFreezeTime', value: 1.0,
    why: 'pins frame.time, so `dt` is identically 0, `tickAccumS` never reaches `tickPeriodS` '
       + 'and the snake never steps. NECESSARY BUT NOT SUFFICIENT — it stops the stepping and '
       + 'does not choose which frame it stopped on, because the seed still comes from Date.now().' },
  { global: '__nibblesVrtSeed', value: 0xC0DE,
    why: 'pins initialSeed(), so the snake start and every pellet placement are identical. '
       + '⚠ MUST be set BEFORE spawn: maybeApplyVrtSeed re-seeds `state` on a later draw frame '
       + 'but does NOT repaint, so a post-spawn pin leaves the original Date.now() frame on '
       + 'screen. simPin installs via addInitScript before goto, which is strictly earlier than '
       + 'any afterSpawn hook manages. Reuses the seed vrt-composite-scenes.ts already pins, '
       + 'deliberately: one seed for both deterministic capture paths means a surface a human '
       + 'has already reviewed.' },
]
```

⚠ **The freeze half of `videoFaceWhy` is a NO-OP here and that is fine** — nibbles has no `freeze`
param, so `params.freeze = 1` is rejected by `setParam`'s `if (paramId in params)` guard. The
still-picture assertion is satisfied by the `__videoEngineFreezeTime` pin instead. **Do NOT remove
`videoFaceWhy` on the grounds that the freeze is inert** — that is the exact reasoning that cost
`4plexvid` both scenes, and it is the wrong half of a two-purpose flag. **And do NOT add a
`freeze` param to make the freeze real** — §5.1, §10.1.

### 11.1 ⚠ THE PIN IS PROVEN IN BOTH DIRECTIONS, BY A MEASUREMENT ALREADY IN THE TREE

`.myrobots/2026-08-23-nibbles-composite-vrt-nondeterminism.md` is the diagnosis and fix for
`composite-nibbles-length_cv-driven`, and it carries the byte-level result:

| tree | run A | run B | verdict |
|---|---|---|---|
| pre-fix (neither global pinned) | `2ed942ac…` | `62fc8ce5…` | **differ** |
| post-fix (both globals pinned) | `14256032…` | `14256032…` | **identical** |

Three things in that record are load-bearing here:

1. **Both halves are required.** The seed alone fixes *which* pellets spawn, not *how many ticks
   elapsed*; the clock alone stops the stepping and leaves the seed on `Date.now()`. Same shape as
   `mirrorpool`'s three globals, reached independently.
2. **The diagnosis was carried out by CLASSIFYING THE DIFF PNG FIRST**, and it refuted the
   file's own leading hypothesis in one look. That method is the reason to trust the result.
3. ⚠ **A local pass/fail loop on this scene was warned to be vacuous — and comparing captured PNGs
   BYTE-FOR-BYTE was not.** *"When a flake hides inside a tolerance, drop the tolerance rather
   than repeating the gated check."* **Use the byte comparison for §15.5, not `REPEAT`.**

### 11.2 What promotion does to nibbles' ten existing baselines

| baseline set | count | moves? |
|---|---|---|
| `vrt.spec.ts/nibbles.png` (the CARD scene) | 1 | ⚠ **NO.** `vrt.spec.ts:86` navigates `/rack?shell=legacy&seed=none`, and `_shell-faces.ts:604` states the rule: *"promotion does not change what it captures."* |
| `vrt-composite.spec.ts/nibbles-cv-{min,25,50,75,max}.png` | 5 | NO — composite scenes, unaffected |
| `vrt-composite-coverage.spec.ts/composite-nibbles-*.png` | 4 | NO |
| `face-nibbles-compact.png` + `face-nibbles-dock.png` | **+2** | **NEW** |

**Predict two, count two.** ⚠ *"A green dispatch that committed nothing is a RED FLAG"*, and so is
one that commits more than you predicted. **Scope the dispatch:** `GREP=nibbles flox activate --
task vrt:commit` — measured 41-56 min unscoped against ~3 min scoped; a bare dispatch on a face PR
derives FULL.

**CI wall-time.** `faces-parity` budgets ≈ `10 s + 0.8 s/cell`. **2 param cells + 1 action ⇒
≈ 12.4 s**, plus two face scenes. Well under the ~2 min threshold. ⚠ `nibbles.spec.ts` costs 4.4 s
(and is PARKED — §13.1); `nibbles-cv-scope.spec.ts` costs 13.8 s; both are untouched. **Re-pin
BOTH cost artifacts** (`e2e:timings:accept` AND `vrt:strict:timings:accept`) — an unmeasured
`vrt-strict` scene rides the median and has reddened `main` at 92 % of a shard budget with every
test passing.

---

## 12. THE DOCS REWRITE IS PART OF THIS PR

`nibbles.ts`'s `docs.explanation` currently ends with two sentences that describe the CARD:

> *"The card also has a RESET button, a 1x-4x zoom button, and a live LEN readout (a dagger appears
> when the snake is dead). The card's game screen is resizable: the on-card scale button cycles the
> 320x200 source through 1x / 2x / 3x / 4x zoom (image-rendering: pixelated, so it stays crisp);
> the knobs, buttons, and patch jacks stay fixed-size while only the screen grows."*

After promotion: the LEN readout **does not exist** (§9.1), the zoom does not make the plate grow
(§7.2), and the buttons live in a dock body rather than on a card. **Every clause is stale.**
⚠ `docs` is hash-transparent, so rewriting it is FREE — and it is the one edit to `nibbles.ts`
this PR may make besides `face` (§10.1). Fold §9.2's how-to-play sentence in while there, so
right-click ANNOTATE can carry what the deleted `.tip` line used to say.

---

## 13. DEFECT LEDGER

Per CLAUDE.md nobody opens issues: each is fixed **inside this PR** unless marked otherwise.

**13.1 — ⚠ `nibbles.spec.ts`'s ONLY BEHAVIOURAL TEST IS PARKED.**
`scripts/e2e-skip-budget.mjs:563` lists it under FLAKE-PARK #1847, and
`e2e/tests/nibbles.spec.ts:64` is `test.fixme('nibbles: AUTO on → game advances within 5s
(length_cv leaves default; snake grows or dies)')` — *"2 recovered-on-retry observations in the
96 h census to 2026-08-18; parked until root-caused."* **Only the mount smoke test still runs.**
So the assertion that AUTO actually advances the game and moves the length CV — the module's whole
generative premise — has no CI gate. ⚠ **The face PR does not un-park it** (an owner-ruled park is
not an agent's to reverse casually), **but it must NOT be read as coverage**: §16's verification
gate names the park explicitly so nobody counts a green `nibbles.spec.ts` as proof the game runs.
⚠ **And triage the park honestly if it is ever revisited**: a 5 s wall-clock budget on a
frame-driven game under SwiftShader is the under-budgeted shape, not obviously the flaky one, and
those need opposite responses. **Severity: report to the owner as a coverage note.**

**13.2 — SCALE dies on every dock collapse, today.** `let scale = $state(1)`
(`NibblesCard.svelte:40`) is component state, and under the shell the card lives only in the dock
full view — so collapsing the pane (or the dock's LRU evicting it when a third module is expanded)
resets a user's 4× zoom to 1×. The #1531/#1574/#1583 class. **Severity: fold in** — §3.1; the fix
(`node.data.previewScale`) is the same one parity requires.

**13.3 — the AUTO button is a ledgered raw param write, and promotion would make it unreachable
rather than paid.** `NibblesCard.svelte:74-77` writes `patch.nodes[id].params.auto` directly;
`raw-write-ledger.ts:269` carries it as `kind: 'debt'`. **Severity: fold in** — one line
(`setNodeParam`), and DELETE the ledger entry in the SAME commit or it becomes the RED
stale-exemption case. §3.2. ⚠ Owner ruling: *"NEVER ledger payable debt — fix it in one sweep."*

**13.4 — the card re-types two range literals, and this is the boy-scout that must NOT ride this
PR.** `NibblesCard.svelte:154`: `min={40} max={200}` — while correctly using
`defaultFor('tick_ms')` from `cardParams` on the same line, which is the tell that the author knew
the pattern. nibbles is not in `RANGE_BOUND_CARDS`, whose own stated scope is *"every card NOT in
this set is unchecked"*. ⚠ **The `.svelte` half is attest-free, but the correct fix exports a
`NIBBLES_TICK_RANGE` from the DEF — and that is a `nibbles.ts` edit, i.e. a GPU re-attest**
(§10.1). **Severity: fold into a SEPARATE PR** with the attest window, exactly as wave 4 split
`picturebox`'s.

**13.5 — the card grows to 1280 px at 4× zoom.** `.mod-card { width: max-content }` (`:174`) plus
`style="width: ${320*scale}px"` (`:147`) means a 4× preview makes the whole card 1280 px wide.
That is the *"useless gray horizontal space"* the compact ruling forbids, and the face must not
inherit it (§7.2: the preview scrolls inside its own box). **Severity: the FACE fixes it by
construction; the card is left as-is** because it is about to stop rendering, and the honest note
is that this is why the face's width exemption must be measured at 1×.

**13.6 — the lane tile is a dead placeholder today.** Not in `NON_SHELL_LANE_TYPES`, not in
`STRICT_FACES`, not a `CARD_PRODUCER` ⇒ `'placeholder'`. ⚠ **Unlike its three siblings, promotion
FULLY fixes this** — the video-domain thumb is a real per-node picture in the lane, not a dock-only
consolation. **Severity: closed by this PR**, and it is the strongest single argument for doing it.

**13.7 — `NIBBLES_MAX_LENGTH = 119` is an empirical calibration with no surface and a real
coupling.** `nibbles.ts:49-71` documents it fully: the 95th percentile of 2000 seeded bot games,
rebasing **both** the length CV mapping and the square-wave pitch mapping, with
`nibbles-bot.test.ts` failing loudly if the bot drifts. **Nothing is wrong with it** — it is
recorded here so a face author does not treat it as a magic number, and because it is exactly the
kind of constant a "put the score in the canvas" change would tempt someone to touch. ⚠ It is in
the attested file. **Severity: none — a note.**

**13.8 (checked, NOT a defect) — nibbles is absent from `module-manifest.ts`'s `DESCRIPTIONS`.**
`describeModule` (`:1090-1097`) falls back to `def.docs.explanation` for a video def and only AUDIO
modules are required to carry a hand-written line. **Recorded so nobody "fixes" it** and adds a
second source of truth for the same sentence.

---

## 14. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

1. **NO `freeze` param (§5.1).** Revert: add one and make the freeze real. Consequence: a GPU
   re-attest to buy an assertion that already holds — the `4plexvid` anti-pattern by name.
2. **`tick_ms` ranks 1 over `auto`.** Revert: swap them. ⚠ The argument for AUTO (it is what makes
   nibbles a self-running generator at all) is genuinely strong and is written out in §4 so an
   owner can overrule with the facts in hand.
3. **`auto` as a DERIVED `'toggle'`, not a declared roster (§5.2).** Revert: declare `options`.
   Consequence: two invented state names where the shell already produces the right primitive.
4. **RESET as a `ShellActionCell` rather than a body button (§8.2).** Revert: put it in the body.
   Consequence: it leaves the cell grid, `faces-parity` stops probing it, and the audition ledger
   — the only observable that can distinguish a live RESET from a dead one — stops being read.
5. **`node.data.previewScale` rather than a `ParamDef` (§3.1).** Revert: make it a param.
   Consequence: a GPU re-attest, plus a per-view preference in the audio contract and on the Push
   card.
6. **ONE band (§6).** Revert: split `snake` into `rate` (tick_ms) and `driver` (auto).
   Consequence: a second ~81 px band header for a distinction the module does not make.
7. **NO hero (§8).** Revert: `hero: { cell: … }` for the preview. Consequence: it SUPPRESSES the
   shell glyph at the dock — trading the free per-node `VideoTileThumb` for a bespoke one.
8. **The plate is sized to the 1× preview (§7.2).** Revert: size it to 4×. Consequence: the exact
   *"useless gray horizontal space"* the compact ruling forbids, and a width exemption justified by
   a bug.

---

## 15. MUST-VERIFY

1. **The tier ladder AND `hasVideoSurface`**, derived through `curatedFace` — and **assert
   `hasVideoSurface(def)` directly**, because `'none' + blank tile` and `'none' + live thumb` are
   indistinguishable from the declaration. Confirm the compact tile shows the picture **plus BOTH
   cells** (§2.1), rather than assuming the with-glyph cap.
2. **`auto` derives `'toggle'`** — assert the derived kind, do not declare it, and confirm the
   rendered cell is a `<Toggle>` and not a two-position knob (`moog962`'s inert-control failure).
3. **`rear-card-model`** — all three output groups declare `direction: 'output'` and resolve; the
   EMPTY input rail renders without orphaning.
4. **Plate width ≤ pane width AT 1×**, and the preview SCROLLS at 2×/3×/4× rather than widening
   the plate. ⚠ Needs a baseline; the first `vrt:commit` IS the measurement. If a
   `face-width-source` exemption is needed, its `why` names *the live 320 px game preview*.
5. **`simPin` reaches the factory, and the seed lands BEFORE the first paint.** Prove it with a
   **BYTE-FOR-BYTE PNG comparison**, not a pass/fail loop: three consecutive dock captures
   byte-identical, AND a fourth with a DIFFERENT seed that is visibly different. ⚠ §11.1.3 — a
   tolerance-gated repeat here is known to be vacuous.
6. **SCREEN OFF leaves EVERY output firing** — a downstream counter on `pellet` and a level probe
   on `snake` before and after a collapse window. ⚠ **The single most valuable assertion in this
   spec**, because `surface.draw` is where the game ticks: a collapse that stopped the draw would
   stop the game and silence the module.
7. **RESET's audition probe records `delivered: true`**, and a deliberately-disconnected `reset`
   read key makes it record `delivered: false` — negative-controlled in BOTH directions, with
   `toBeEnabled()` and `click()` still passing. That is the karplus finding in one line.
8. **`previewScale` and `previewCollapsed` survive a dock collapse, an LRU eviction and a reload**,
   and `previewCollapsed` uses the SAME key the card would have.
9. **The body is focusable, takes arrow keys, and shows the focus affordance** — and
   `pushDirection` returns false while AUTO is on, so the two paths cannot fight.
10. **The `docs:accept` diff is EMPTY on the contract** apart from a `controlFamilies` line if the
    RESET cell declares one. Anything else is a finding.
11. **The attest hash does not move.** Re-run §10.1's probe against the FINAL tree — including the
    `controlFamilies` line — before merging. ⚠ Measure the MERGED tree, not the branch tip: main
    moving a basis file changes your hash.
12. **The body contains NO derived text outside the canvas** — no `LEN`, no `†`, no tip sentence.
    Negative-controlled by temporarily adding one.

---

## 16. VERIFICATION GATE

```sh
# 1. the pure model + this face's PERMANENT negative controls (§15.6, §15.7, §9.3's derived legs)
REPEAT=3 flox activate -- task test:one -- nibbles-face-model
# 2. the module's own units — the game, the bot calibration, the CV/pitch mapping
REPEAT=3 flox activate -- task test:one -- nibbles
flox activate -- task test:one -- nibbles-game
flox activate -- task test:one -- nibbles-bot
# 3. face lint + plans
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- shell-cells            # the RESET probe shape
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard
# 4. the rulings' source gates
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source
flox activate -- task test:one -- video-face-screen-source   # ⚠ nibbles IS in this sweep's scope
# 5. lifetime + discipline
flox activate -- task test:one -- card-media-lifetime    # NibblesCard's EXTRAS_OWNERS verdict
flox activate -- task test:one -- mutate.guard           # §13.3 — the ledger entry must GO
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema
flox activate -- task test:one -- module-docs-lint       # §12's rewrite
# 6. the contract diff must be EMPTY (bar a controlFamilies line)
flox activate -- task docs:accept && flox activate -- git diff
# 7. ART — NIL. Video domain.
# 8. e2e — ⚠ nibbles.spec.ts's AUTO leg is PARKED (§13.1). A green run here is the MOUNT SMOKE
#    ONLY and is NOT proof the game advances. Read the skip count.
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/faces-parity.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/nibbles.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/nibbles-cv-scope.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/faceplate-platform.spec.ts
flox activate -- task e2e:stop
# 9. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck
# 10. ⚠ ATTEST: re-run the §10.1 probe on the MERGED tree and confirm the hash has NOT moved.
#     If it has, the PR contains an edit to nibbles.ts / -game.ts / -bot.ts that it should not.
# 11. VRT: SCOPED dispatch. PREDICT TWO NEW PNGs and COUNT what the bot commits.
GREP=nibbles flox activate -- task vrt:commit
# 12. re-pin BOTH cost artifacts against the newest run, and review both diffs
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>
```

**The negative controls, spelled out so a builder cannot ship a green stub:** a DIFFERENT
`__nibblesVrtSeed` must produce a visibly different dock capture, compared BYTE-FOR-BYTE;
SCREEN OFF for N frames must leave a downstream `pellet` counter STILL INCREMENTING and the
`snake` output STILL AUDIBLE; RESET with its read key disconnected must record `delivered: false`
while `toBeEnabled()` and `click()` both still pass; `tick_ms` 80 → 40 must change
`control-tick_ms`'s `aria-valuetext` from `12.5 ticks per second` to `25 ticks per second` AND
double the measured game rate, while `auto` moves neither; adding a `<div>LEN 17</div>` to the
body must turn §15.12's leg RED.

## 17. BUILD-COST ESTIMATE

| phase | estimate |
|---|---|
| `face` on the def (**the ONLY edit to `nibbles.ts` besides `docs`**) + `STRICT_FACES` | ~1 h |
| `shell-extension.ts` + `NibblesScreenBody.svelte` — preview, SCREEN overlay, SCALE overlay, focus + arrow keys | ~4 h |
| `node.data.previewScale` / `previewCollapsed` (§3.1, §13.2) incl. the saved-rack key check | ~1.5 h |
| RESET `ShellActionCell` + `SHELL_CELLS` record + the audition probe, both directions (§8.2, §15.7) | ~2.5 h |
| §13.3 `setNodeParam` + DELETE the ledger entry in the same commit | ~0.5 h |
| §12 the docs rewrite | ~1 h |
| `nibbles-face-model.test.ts` + the §15.6 SCREEN-OFF leg + the §15.12 no-chrome leg | ~2.5 h |
| roster row (`videoFaceWhy` + the two `simPin` entries), rear groups, push golden | ~1 h |
| gate loop, 3× flake checks, typecheck, the attest re-measure | ~2 h |
| VRT dispatch + the byte-for-byte seed negative control | ~1.5 h wall |
| **total** | **≈ 17.5 h** — plus a SEPARATE ~2 h PR for §13.4 in an attest window |

**Risk rank: MEDIUM — and the risk is concentrated in ONE rule.** The determinism seam is free,
the attest is free **if and only if** the `face`-and-`docs`-only discipline holds, the lane picture
is free, and there is no contract change. What is genuinely large is the body: five affordances,
one of which is the module's playing interface and one of which is a live state-lifetime bug.
⚠ **The single most avoidable failure on this PR is an incidental edit to `nibbles.ts`** — it
converts a free PR into one held hostage to a GPU window, and §10.1 is the measurement that says
so.
