# BESPOKE SURFACE SPEC — `trails` (audio, the Bela TRAILS touch-gesture recorder)

**SPEC + MOCK ONLY. No product code is proposed here and none was written.**

Owner directive, verbatim: *"yes lets go ahead and spec out seqtris and trails.
those work well so we want 1:1 parity"*. So the job of this document is to
translate `TrailsCard.svelte` into the v2 shell-extension architecture with
**nothing dropped and nothing redesigned**. Every claim below was re-verified
against `origin/main` at `7957400c0` on 2026-09-01, reading the CARD and the
GATE rather than any inventory prose.

Companion files: [`mock.html`](./mock.html) (both tiers, compact density),
[`open-questions.md`](./open-questions.md) (three owner calls, each with a
recommended default).

---

## 0. VERDICT

**Promote, with `face.extension: 'trails'` filling BOTH wired body slots.**

| | |
|---|---|
| `face.glyph` | `'none'` — **mechanically forced**, §4.1 |
| `face.order` | `['trails-connect-{n}', 'range', 'smooth', 'divisor']` |
| `fullViewBody` | `TrailsPadBody.svelte` — the pad mirror, the status lamp, MON + reset, the counters, the log |
| `tileBody` | `TrailsTileBody.svelte` — the same mirror at 46 px + the status lamp, read-only |
| `EXTENSION_BODY_ROLES` | `trails: { role: 'picture', … }` |
| parity leftovers | **EMPTY** — §3.3 |
| things that cannot be 1:1 | **NONE.** Two strings change *mechanism* (painted → `StatusLed.detail`), which is what every shipped binder in the cohort did; §6 |

The disposition in `face-migration-inventory.ts:993` stays `bespoke-surface`;
its `state` flips to done automatically once the `face` exists and `trails` is in
`STRICT_FACES` (the set is asserted EQUAL to the set of defs declaring a `face`,
`strict-faces.ts` header — *authoring the face IS the promotion*).

---

## 1. THE CONSTRAINT MAP, READ FIRST

### 1.1 The subject

| file | what it owns |
|---|---|
| `packages/web/src/lib/ui/modules/TrailsCard.svelte` (555 lines) | **the whole legacy surface** — 10 testids, one rAF loop, one canvas painter |
| `packages/web/src/lib/audio/modules/trails.ts` (963) | the def + factory: 21 outputs, 3 params, `card-api`, `state`, `monitor` read keys |
| `packages/web/src/lib/midi/trails-device.ts` (550) | the app-wide WebMIDI binding, `trailsStatus()`, `trailsMidiVersion`, the simulated device |
| `packages/web/src/lib/midi/trails-decode.ts` (946) | the 14-bit CC / note / transport decoder |
| `packages/web/src/lib/midi/trails-monitor.ts` (392) | the MON tally + `summary` string |

⚠ `packages/web/src/lib/audio/seqtris-launchpad.ts` is **not** this module. It
is named here only so a reader of both specs in this wave does not conflate them.

### 1.2 Facts verified on `origin/main` today (not inherited from prose)

1. **The card changed twice, not four times** — `287174f8a` (#2277, the module)
   and `2e2f0c185` (#2292, note mode + TRIG + poly). Both are dated 2026-09-01
   in git, so "yesterday" and "today" are the same working day here. Everything
   the brief lists as *recent* is present in the tree: the 4-colour pad mirror,
   the bottom-edge hatched bar (`TRAILS_BAR_EDGE = 'bottom'`, trails.ts:295,
   owner-confirmed), the `ch3[2X]` monitor labels, sticky `vel=`, live row
   labels, the `loops N · edges a/b/c/d` line, CONNECT + status, three knobs,
   and the 21-jack port surface.
2. **`?shell=legacy` still renders the verbatim card after promotion**
   (`legacy-fallback.ts` header: `'legacy'` is *"the module's own \*Card.svelte,
   verbatim: what `?shell=legacy` selects"*). So the existing VRT card baseline
   and the three DOM-asserting e2e legs **survive unchanged** — the build owes
   *new* default-shell legs, not replacements. §8.
3. **`trails` is in NO producer/park set.** It appears nowhere in
   `NON_SHELL_LANE_TYPES`, `CARD_PRODUCER_LANE_TYPES`, `DOM_SOURCE_LANE_TYPES`
   or `HEADLESS_MOUNT_LANE_TYPES` (grepped: the only shared files naming
   `'trails'` are `strict-docs.ts:268`, `modules-card-map.test.ts:57` and
   `face-migration-inventory.ts:993`). Promotion therefore parks **no** live
   card off-screen, and there is nothing to coordinate through a status
   registry. The MIDI subscription, the decoder, the monitor and every
   `ConstantSource` live in the FACTORY and run with no UI mounted.
4. **`trails` is already in `STRICT_DOCS`** (`strict-docs.ts:268`), so the new
   control family owes a `docs.controls` entry — a real, small cost. §10.
5. **Both body slots are WIRED** — `WIRED_SHELL_EXTENSION_SLOTS` is
   `['glyph','fullViewBody','tileBody']` (`shell-extensions.ts:144`), and the
   tile render site is `ModuleShell.svelte:1886`, gated `!extBody` so the two
   slots are counterparts, never siblings.

### 1.3 The gates this surface must satisfy

| gate | file | what it asks of trails |
|---|---|---|
| face lint / promotion anchor | `module-face-lint.test.ts` | rank every param; no dead glyph; `STRICT_FACES` set identity |
| extension registry | `shell-extensions.test.ts` | declared id ↔ discovered dir, both directions; no unwired slot |
| shell import freedom | `module-shell-import-guard.test.ts` | ModuleShell imports nothing trails-owned |
| **extension-body text role** | `face-rack-status-source.test.ts:150` | a roster entry with a `why`, and the `picture` predicate must HOLD of the source |
| resting text | `face-resting-text-source.test.ts` | the four permitted roles; §6 |
| readout source | `face-readout-source.test.ts` | no resting decimal under a control |
| range source | `card-range-source` / `card-control-ranges` | bounds come from the def via `paramSpec` — already true on the card |
| dock parity | `faces-parity.spec.ts` | every param reachable; exact `control-*` multiset |
| docs | `module-docs-lint.test.ts` (FAMILY↔CARD leg) | `controlFamilies[].testidPrefix` must appear in card source — **already does** |
| contract | `contract-lock.txt` | `controlFamilies` IS projected (`contract-signature.ts:237`) → **one new line** |

---

## 2. WHAT THE MODULE IS FOR

One sentence, because every rank descends from it: **your finger is a modulation
source, and once you lift it the gesture keeps performing itself.**

Three things make it usable and only one of them is a knob:

1. **CONNECT** — the gesture-gated Web MIDI grant. The module is inert until it
   is pressed; nothing in the rack asks for MIDI on its behalf.
2. **The PAD MIRROR** — a 1:1 read-only picture of the physical panel, so the
   player can see what the rack is receiving without looking down at the
   hardware. ⚠ It is *not* an `xyPads` cell: a declared pad names the two params
   its axes DRIVE, and these axes drive nothing — they report (trails.ts:596-603,
   and the inventory `why` says the same thing and is, unusually, correct).
3. **MON** — the only affordance in the product that can falsify this module's
   wire constants against real hardware, because it reports the frames the
   decoder rejected as well as the ones it understood.

The three knobs (RANGE / SMOOTH / CLOCK DIV) are the only generic-face material.
A face that ranked *only* those would move the knobs to the lane and leave every
one of the above behind — which is precisely why this is a bespoke surface and
not a plain face.

---

## 3. ⚠ THE PARITY TABLE — EVERY AFFORDANCE, WITH ITS HOME

This is the section the program has been burned on six times. It enumerates
**every `data-testid` in `TrailsCard.svelte`** (there are ten, and there are no
child components of its own — `ModuleTitle`, `PatchPanel`, `KnobConic` are
platform components), then **every non-testid affordance**: mount/destroy work,
timers, subscriptions, `node.data` reads and writes, and pointer handlers.

### 3.1 The ten testids

| # | card testid (line) | what it is | HOME in v2 | notes |
|---|---|---|---|---|
| 1 | `trails-card-${id}` (350) | the card ROOT container | **shell tile / dock plate** — `ModuleShell`'s own root | A container selector, not an affordance. Nothing a player can do lives on it. The one e2e use (`trails.spec.ts:1070`) is a visibility check on `?shell=legacy` and **stays valid**; the new default-shell leg asserts the shell root instead. |
| 2 | `trails-led-${id}` (356) | the 4-state binding LED | **`StatusLed` in BOTH bodies** — `trails-face-led-${id}` / `trails-tile-led-${id}` | caption `LINK` (static, by contract), `lit` = bound, `tone="warn"` = problem, and the whole status SENTENCE on `detail` → `aria-label` + `title`. The midiCvBuddy / ptzcam shape. |
| 3 | `trails-connect-${id}` (358) | the gesture-gated grant | **a ranked `action` face CELL**, `trails-connect-{n}`, rank **1** | An `action` cell is not dock-restricted (only `panel` is), so it lands on the **lane tile** — which on a module that does nothing until it is pressed is the biggest single thing promotion changes. `faceTierCap` caps a glyph-less compact tile at 3 cells, so rank 1 is load-bearing, not cosmetic. |
| 4 | `trails-status-${id}` (364-371) | the status sentence, `role="alert"` when problem | **split three ways, §6.2** — empty-state hint (idle), `StatusLed.detail` (bound), transient `role="alert"` error line (denied / no-port / no-prompt / unsupported) | Same testid stem kept on the body's status region so the existing assertions port with a prefix change only. |
| 5 | `trails-pad-${id}` (374-379) | the 1:1 pad mirror `<canvas>` | **`TrailsPadMirror.svelte`, mounted by BOTH bodies** — `trails-face-pad-${id}` (140 px) / `trails-tile-pad-${id}` (46 px) | One component, a `size` prop. Aspect still `MIRROR_ASPECT`, still derived from the millimetre constants, never a chosen pixel ratio. |
| 6 | `trails-bar-note-${id}` (385-387) | `bar — not sent over USB-MIDI` | **dock body only**, under the mirror, verbatim | Gated on the same `TRAILS_BAR_TRANSMITS_MIDI` flag as the hatch, so a firmware that starts transmitting removes both in one edit. Text verdict in §6.3. The HATCH itself is on both tiers — it is canvas, not text. |
| 7 | `trails-mon-${id}` (391-399) | the MON toggle, `aria-pressed` | **dock body only** — `trails-face-mon-${id}` | §4.3 argues the tile exclusion from the 112 px budget, not from taste. |
| 8 | `trails-mon-reset-${id}` (401-403) | zero the tallies | **dock body**, unchanged, still `{#if monOpen}` | Calls the same `resetMonitor()` through the new action seam. |
| 9 | `trails-loops-${id}` (414-416) | `loops N · edges a/b/c/d` | **dock body**, inside the opened MON panel, verbatim | Deliberately kept as a text line, not a lamp: it is read as a RATIO between two numbers and a lamp cannot carry a ratio. §6.4. |
| 10 | `trails-mon-text-${id}` (417-418) | the `<pre>` summary, pre-wrapped and selectable | **dock body**, verbatim, `user-select: text` preserved | The paste-ability is the deliverable (`trails-monitor.ts:120-127`). §6.4. |

### 3.2 Every non-testid affordance

| # | affordance (card line) | HOME | argument |
|---|---|---|---|
| 11 | `ModuleTitle` — the editable node label | shell **title bar** | platform chrome; identical on every faced module |
| 12 | `.stripe` painted `var(--cable-cv)` | shell **domain spine** (tile `border-left`, dock plate rule) | platform chrome. The card's stripe is the shell's spine by another name. |
| 13 | `PatchPanel` over 21 outputs (0 inputs) | shell **jack rail**, `groupingStrategy: 'auto'` | groups by cable type → CV (8) · GATE (9) · POLY (4). Every jack still reachable, and the rear rails are unchanged. |
| 14 | `KnobConic × 3` bound via `paramSpec(trailsDef, id)` | **three ranked param cells** | ⚠ The face must NOT re-type a bound: the def is the one source and `card-range-source` holds it. `range` and `divisor` declare `options`, so their lane cells EARN a readout (`LANE_KNOB_READOUT_H = 57`) and paint their option NAME — `UNI`/`BI`, `1/4` — a permitted landmark role, not a decimal. |
| 15 | `moduleId`/`paramId` on each knob (MIDI-learn target) | preserved by the shell's own param cells | the shell's cells carry the same learn plumbing; nothing module-specific |
| 16 | `readLive(knobId)` — live automation read-back | preserved by the shell's param cells | ditto |
| 17 | `onMount`: `paint(readState())` then `requestAnimationFrame(frame)` | **`TrailsPadMirror`'s own `onMount`**, one loop **per mounted instance** | The tile and an open dock pane are two instances at once. Both read the SAME engine snapshot, so they cannot disagree; the dirty state (`lastPainted`/`lastGateMask`/`lastSize`) is per-component by construction. |
| 18 | teardown: `cancelAnimationFrame` | the same `onMount` return | unchanged |
| 19 | `onDestroy(trailsMidiVersion.subscribe(…))` | **both bodies**, init-time subscribe + `onDestroy` | ⚠ Keep the shape. `PtzcamCard.svelte:39-51` and `PtzcamDeviceBody.svelte` both record the measurement: neither store sugar nor `$effect(() => store.subscribe(…))` delivers bumps here. |
| 20 | `revision` bump after a gesture | both bodies | forces api-backed `$derived`s to re-run before the store's deferred microtask bump |
| 21 | `api()` = `engine.read(node, 'card-api')` | **`trails-cell-actions.ts`** — `trailsApi(nodeId)` via `getActiveEngine()` + `patch.nodes[nodeId]` | the ptzcam seam verbatim; one seam called by the action cell, both bodies, and the legacy card |
| 22 | `onConnect()` — api-or-app-level fallback, **no `await` above the request** | `trailsConnect(nodeId)` in that seam, called from the cell's `onFire` and from the card | ⚠ The fallback branch is not cosmetic: `connectTrails()` is app-level, and dropping a click that races the reconciler is the measured "frozen at idle forever" bug ptzcam paid for. Record the audition honestly on both branches. |
| 23 | `frame()` dirty check: `axisMessages` stamp **+** packed gate mask **+** CSS size | `TrailsPadMirror`, unchanged | the size term is what repaints an idle canvas after a resize or a DPR change — the idle case is exactly the one with no stream to trigger a repaint |
| 24 | `paint()`: DPR-aware backing store, resting grid + centre cross + border | `TrailsPadMirror`, unchanged | this is also what makes the VRT capture deterministic with no mask (§9) |
| 25 | `paintBar()`: dim fill + 6 px diagonal hatch + border, gated on the flag | `TrailsPadMirror`, unchanged | on BOTH tiers |
| 26 | trail render: per-segment fade, `TRAILS_TRAIL_LENGTH` (48), 4 colours, 4 px dot, **Y flip**, **clipped to the pad** | `TrailsPadMirror`, unchanged | ⚠ Keep the clip. Below ~114 px the pad→bar gap is narrower than the dot, and ink on the Bar is live-looking paint on the one surface whose whole message is that it carries no data — which is *more* likely on the 46 px tile, not less. |
| 27 | MON refresh **every 12 frames**, riding the paint loop, not a timer | dock body, unchanged | a surface that already wakes every frame must not also own an interval; and `state()` returns a FRESH object per call, so a 60 Hz assignment would re-render the readout for no new information |
| 28 | `toggleMon()` / `resetMon()` reads | dock body → the action seam | `resetMonitor()` zeroes the loop counters too, deliberately (a ratio against a vanished baseline is worse than no reset) |
| 29 | **NO pointer handler on the canvas** | preserved — neither body adds one | ⚠ An explicit NON-affordance to protect. Read-only is what makes this honest as a mirror; the skifree lesson (two mounted surfaces, one cursor) says the tile especially must stay read-only. |
| 30 | `node.data` READS | only `data.node` (for the label) — the shell owns it | |
| 31 | `node.data` WRITES | **NONE, at all** | trails.ts:44-51: *"This module makes NO `node.data` writes"*. The v2 surface must keep that true — the live touch stream is transient engine state and never reaches the Y.Doc. §5. |
| 32 | `.mon-log` `white-space: pre-wrap` + `word-break` + `user-select: text` | dock body, unchanged | the summary exists to be selected and pasted; a horizontally clipped block loses the ends of the rows that matter most |

### 3.3 ⚠ THE LEFTOVER SET

**EMPTY.** All 32 rows have an explicit home. Three deserve their argument
stated out loud rather than being counted as clean:

* **#1 `trails-card-${id}`** is a container, not an affordance. It is the only
  row whose home is "the shell's own root element", and the only one whose e2e
  selector must be re-pointed on the new leg (the old leg keeps working on
  `?shell=legacy`).
* **#4 the status sentence** and **#2 the LED** are the ONE mechanism change in
  the whole promotion: painted sentence → lamp + `detail`. Every shipped binder
  in the cohort (midiclock, midiCvBuddy, midiLane, midiOutBuddy, es9, ptzcam,
  audioIn) made exactly this move, and in three of them the lamp says *more*
  than the line it replaced. Here it says the same thing, in `aria-label` and
  `title`, plus the error line survives verbatim. §6.2.
* **#7-#10 the MON block** is dock-only. That is a TIER placement, not a
  deletion: every affordance is reachable, and §4.3 derives the tile exclusion
  from the 112 px lane body budget rather than asserting it.

---

## 4. THE SURFACE

### 4.1 The face declaration

```ts
export const TRAILS_FACE: ModuleFace = {
  glyph: 'none',
  order: ['trails-connect-{n}', 'range', 'smooth', 'divisor'],
  extension: 'trails',
  pages: [
    { id: 'device',  label: 'device',  controls: ['trails-connect-{n}'], hint: /* … */ },
    { id: 'signal',  label: 'signal',  controls: ['range', 'smooth', 'divisor'], hint: /* … */ },
  ],
};
```

**`glyph: 'none'` is MECHANICALLY FORCED, not preferred.** Run through
`glyphBinding` (`shell-glyph-live.ts:128`) rather than guessed:
`primaryAudioOutPortId` is `outputs.find(o => o.type === 'audio')?.id` — exactly
`'audio'`. Trails' 21 outputs are `cv` × 8, `gate` × 9 and `polyPitchGate` × 4,
so that resolves null; there is no `algorithm`, `envelope` or waveform-law param
set; every other literal falls through to `{ kind: 'static' }`, which
`module-face-lint`'s dead-glyph clause reddens unconditionally. The midiclock /
ptzcam derivation, on a def with 21 jacks.

⚠ **And the glyph this module would want is the pad mirror — which is why the
mirror is a BODY, not a glyph slot.** The `glyph` extension slot takes
`{ num, numbers, testid }` and is scaled by viewBox alone into a `.topo-glyph`
plate and a ~26 px picker cell; it is a data-derived identity picture bound to a
topology param. The mirror is live transient state with no param behind it. The
slots are not interchangeable and the honest one is `tileBody`.

**TWO BANDS, NOT A TAB RAIL.** `DOCK_TAB_MIN_BANDS` is 7 and nothing here is
padded to reach it (owner ruling: never pad pages to force the rail). `device`
is the binding, `signal` is what the jacks emit — different KINDS of thing,
which is what a band boundary is for.

**Rank order is load-bearing.** `faceTierCap` caps a glyph-less COMPACT tile at
3 cells (`LANE_ROW_MAX_CELLS = 3`, `module-shell-model.ts:374`), so:

| tier | cells painted |
|---|---|
| mini | CONNECT |
| compact | CONNECT · RANGE · SMOOTH |
| full / dock | all four + the body |

CLOCK DIV falling off the compact tile is the ordinary ladder, not a loss — it
is the one control that only matters once a transport is running, and the dock
is one click away. Inverting the order to keep DIV would push CONNECT off the
tile, which is the exact defect midiclock's promotion (#2187) existed to fix.

### 4.2 `fullViewBody` — the DOCK surface

`packages/web/src/lib/ui/modules/trails/TrailsPadBody.svelte`, top to bottom:

```
┌ THE PAD MIRROR ─────────────────── 140 px wide, aspect 85/98 ┐
│  (canvas: resting grid + centre cross; up to 4 dots + trails)│
│  ▨▨▨▨ hatched bar strip on the BOTTOM edge ▨▨▨▨              │
└──────────────────────────────────────────────────────────────┘
  bar — not sent over USB-MIDI                     (dim, centred)

  ● LINK            [ MON ]  [ reset ]        ← lamp + two buttons
  ⟨error line, role="alert", only when something is wrong⟩
  ⟨pre-connect hint, only before a grant⟩

  ── when MON is open ────────────────────────────────────────
  loops 12 · edges 12/0/0/0
  ┌──────────────────────────────────────────────────────────┐
  │ TRAILS MIDI MONITOR — 431 messages, 5 not decoded        │
  │     ch1[1X] CC15         x212     last=64                │
  │   ! ch1[1X] CC47         x5       last=64                │
  │     ch2[1Y] NOTE 81      x106     vel=97                 │
  │ …                                                        │
  └──────────────────────────────────────────────────────────┘
```

Below it, untouched, the shell's own faceplate bands paint every param cell —
`fullViewBody` takes the place of the generic hero glyph, **never** of the
faceplate (`shell-extensions.ts`, the slot's own ⚠ note; the `warrensspectrum`
failure this seam exists to prevent).

**Width: compact.** The mirror is 140 px, exactly the card's `max-width`, so the
dock plate is among the narrowest in the fleet. Widening it is a one-line change
and is offered as an owner call rather than taken (open-questions Q2).

### 4.3 `tileBody` — the LANE surface, derived from the 112 px budget

`ModuleShell.svelte:1886` renders `tileBody` **below the param bands and above
the jack rail**, gated on `!extBody` so exactly one of the two paints per shell
instance. The arithmetic, from `module-shell-model.ts`:

```
tile                     192 × 180                       (SHELL_TILE_W = 192)
body inner width         192 − 11 − 9 = 172 px
body height              LANE_BODY_H = 112 px            (:388)
compact row              3 cells, one row
  ⚠ row height           LANE_KNOB_READOUT_H = 57 px     (:459)
     because `range` and `divisor` declare `options`, and ANY param declaring
     `options`/`landmarks` earns a readout (curated-face.ts:175 `earnsReadout`
     → `paintsReadout`) — 57 px, not the 42 px design row.
remaining for tileBody   112 − 57 − 4 (gap) ≈ 51 px
```

So the tile body is **one 46 px-tall strip**:

```
┌────────────────────────────────────────────┐  ← 172 px inner
│ ┌──────┐                                   │
│ │ pad  │   ● LINK          ← StatusLed     │  46 px
│ │ 40×46│                                   │
│ └──────┘                                   │
└────────────────────────────────────────────┘
```

* **the mirror is 46 px tall / 40 px wide** (aspect 85/98 with the bar on the
  bottom). Four coloured dots at that size is a GLANCE — "is a finger down, and
  roughly where" — which is exactly the claim skifree's tile body makes for its
  104 px slope, and it is the answer to "did my hardware just do something"
  without expanding the module.
* **the lamp sits beside it**, in the ~120 px of horizontal room the mirror does
  not use, so the strip costs one row of height rather than two.
* **MON is NOT here.** The `<pre>` is a 22-character padded label plus counts
  per row; at 172 px it is unreadable, and the panel alone is taller than the
  whole remaining budget. Excluded by measurement, not by taste — and the
  gesture that MON serves (diagnose the wire) is a sit-down activity, unlike
  CONNECT which must be reachable where the module is met.
* **the bar caption is NOT here** — 8 px prose under a 46 px picture. The HATCH
  is, which is the part that does the work at a glance.

⚠ **Read-only, and the testids are namespaced.** A lane tile and an open dock
pane for the same node are mounted at once. Two elements behind one testid is
the bug skifree's extension header names; so `trails-face-*` and `trails-tile-*`
rather than a shared stem.

### 4.4 The components

```
packages/web/src/lib/ui/modules/trails/
  shell-extension.ts        → { fullViewBody: TrailsPadBody, tileBody: TrailsTileBody }
  TrailsPadMirror.svelte    ← the canvas + rAF + paint/paintBar; props { nodeId, size, testidPrefix }
  TrailsPadBody.svelte      ← mirror(140) + caption + lamp + MON + reset + counters + log
  TrailsTileBody.svelte     ← mirror(46) + lamp
  trails-status-model.ts    ← PURE: status → { lit, tone, detail, errorLine, hint }
  trails-status-model.test.ts
packages/web/src/lib/ui/modules/trails-cell-actions.ts
  ← trailsApi(nodeId) / trailsConnect(nodeId) / trailsResetMonitor(nodeId)
```

⚠ `paintsCanvas` (the `picture` role predicate,
`face-rack-status-source.test.ts:1225`) follows **one level** of local
`./X.svelte` imports that are actually MOUNTED. `TrailsPadBody` mounting
`./TrailsPadMirror.svelte` therefore satisfies the predicate — the audioIn
argument, where one shared component makes the tile true by construction rather
than by two components happening to agree.

⚠ **2-D only, and it must stay that way.** WebGL attest-basis membership is
derived from CONTENT over `lib/ui/modules/**/*.svelte`
(`scripts/webgl-attest-lib.ts`), so a GL context here would enrol an audio
module in the GPU attest for a picture that is a rectangle, a cross and four
dots. `getContext('2d')`, always.

### 4.5 The action cell

Def side:

```ts
controlFamilies: [
  { id: 'trails-connect', label: 'Connect Trails', kind: 'other', testidPrefix: 'trails-connect' },
],
```

`module-docs-lint`'s FAMILY↔CARD leg is a presence-only substring test over all
card source, and `TrailsCard.svelte:358` already emits
``data-testid={`trails-connect-${id}`}`` — so **no card edit is needed**, exactly
as ptzcam recorded.

Shell side, in `shell-cells.ts` beside the `midiclock` (:2598) and `ptzcam`
(:2668) entries:

```ts
trails: {
  'trails-connect-{n}': {
    kind: 'action',
    label: 'Connect Trails',
    title: 'Grant this site access to Web MIDI (one-time per origin) and bind any Trails on USB',
    mode: 'trigger',
    probe: { effect: { kind: 'audition', seam: 'engine-message' } },
    onFire: (nodeId) => { trailsConnect(nodeId); },
  },
},
```

⚠ **An AUDITION probe, not a `bound` state read** — ptzcam's argument, and here
it is not close: `status().kind === 'bound'` needs a granted origin *and* a Bela
Trails on USB. No runner has either, so a state probe would be permanently red
on a perfectly live control. The audition asks what a runner CAN answer: did the
press resolve a callable off the live engine handle and call it.

⚠ **Called synchronously from the press.** An `await` above `requestMIDIAccess`
spends the user activation and Chromium then refuses to prompt at all. The card
header says this; the seam must keep saying it.

---

## 5. WHERE THE STATE LIVES

| state | owner | persisted? |
|---|---|---|
| `range`, `smooth`, `divisor` | `node.params`, ordinary param path | ✅ Y.Doc, undoable, automatable, MIDI-learnable |
| binding / status / port names | **module-level** in `trails-device.ts` — one WebMIDI access for the whole app, fanned out to every trails node | ❌ never |
| the touch stream: `channels[]`, `trail[]`, `axisMessages`, `clockTicks`, `loopRestarts`, `gateEdges`, `stepTriggers`, `midiFrames*` | the FACTORY closure, read through `read(node,'state')` | ❌ never |
| the monitor's rows + summary | the factory's `createTrailsMonitor()`, read through `read(node,'monitor')` | ❌ never |
| `monOpen` | **component state on the dock body** | ❌ never |
| `node.data` | **nothing at all** | — |

⚠ **THE DATA-FLOW LAW IS THE ONE THING A PROMOTION COULD BREAK SILENTLY.** A
live gesture is 100-250 messages a second (trails.ts:44-51). Not one of them may
touch the Y.Doc: each becomes a `setValueAtTime`/`setTargetAtTime` plus a
mutation of a render-local snapshot the surface POLLS. The bodies must therefore
**read** (`read(node,'state')` on the frame loop) and never **write** — the
cv-modulation live-store-write-storm discipline, which on this module would be
250 CRDT transactions a second broadcast to every collaborator.

⚠ **`monOpen` is deliberately NOT persisted**, matching the card. A diagnostic
panel that reopened itself on every patch load — and on every collaborator's
screen — is not what "remember my layout" means. The cost is one click after a
reload; the alternative is a `node.data` write on a module whose whole design
claim is that it makes none.

⚠ **The two expensive reads stay separated.** `state()` is cheap (integers plus
a fixed-size ring) and is read every frame; `monitor()` sorts rows and builds a
string and is read only while MON is open, every 12th frame. The v2 body must
not collapse them into one poll — that would make the diagnostic the most
expensive thing in the module (trails.ts:473-486 says so in as many words).

---

## 6. RESTING TEXT — THE CENSUS

The permitted resting roles, exhaustively (`face-resting-text-source.test.ts`
header): the module NAME · TAB/SECTION labels · CONTROL CAPTIONS · OPTION /
LANDMARK NAMES. Everything else at rest is denied. Plus two licences the roster
records for extension bodies: **instructional copy in an EMPTY state** (the
midiclock / es9 / gamepad licence) and **an ERROR that is absent whenever
nothing is wrong** (audioOut, audioIn, midiCvBuddy).

### 6.1 What the resting (fresh-spawn, never-connected) surface paints

| string | role | verdict |
|---|---|---|
| `trails` (title bar) | module NAME | ✅ |
| `device` / `signal` | section LABELS | ✅ |
| `Connect Trails` | control CAPTION on its own button | ✅ |
| `range` / `smooth` / `clock div` | control CAPTIONS | ✅ |
| `UNI` / `1/4` under those two dials | option / LANDMARK names | ✅ (`earnsReadout` paints the option NAME, never a decimal — owner ruling: decimals GONE, not hidden) |
| `LINK` | static lamp CAPTION | ✅ |
| `MON` | control CAPTION on its own toggle | ✅ |
| `bar — not sent over USB-MIDI` | §6.3 | ✅ with an argument |
| the pre-connect hint | instructional copy in the EMPTY state | ✅ (midiclock licence) |

Nothing else. At rest the MON panel is CLOSED, so rows 9 and 10 of the parity
table paint nothing at all.

### 6.2 The one deletion: the BOUND sentence

`Bound to Bela Trails — streaming X / Y / gate.` is a derived state sentence
outside any control — the exact shape the 2026-08-19 rulings deleted fleet-wide.
It becomes `StatusLed` `detail`, reaching `aria-label` and `title` and never a
text node. The port names are still in the product, still speakable, still
assertable.

The other three status kinds are **errors** and survive as painted text
verbatim, `role="alert"`, absent whenever nothing is wrong — including the one
sentence that is the only instruction in the product for the failure a player
will actually hit:

> *"MIDI is granted but no port named "Trails" is present. Connect the module's
> USB-C port to this computer — it appears as a class-compliant MIDI device and
> binds automatically."*

That is the audioIn / midiOutBuddy shape exactly, and `trails.spec.ts:1098`
already asserts the `/USB-C/` substring and the `role="alert"` attribute.

### 6.3 `bar — not sent over USB-MIDI` — KEEP, and here is the ground

It is a SENTENCE, so it is not obviously one of the four roles. It survives on
the same ground two shipped entries already stand on:

* **dockscope** — *"the only text on the surface is inside the canvas — the
  `±1.0` / `±5V` scale annotation … which names the `range` control's own
  position rather than measuring anything."*
* **samsloop** — *"the ONE TEXT IT PAINTS is the literal string NO SAMPLE
  LOADED … a placeholder naming the surface's own condition, not a measurement
  of any control."*

This caption names the surface's own condition — a LANDMARK NAME for the strip
it sits under, plus the reason that strip is inert. It measures nothing, it
never changes, and it is gated on the same flag as the hatch so it cannot become
a stale denial under a live control. It goes in the roster `why` verbatim,
because that roster is the only gate that can see body text at all.

⚠ **The alternative, if review objects:** draw it INSIDE the canvas as the
strip's own label (dockscope's `±5V` shape). Strictly safer under the gate,
strictly less 1:1 with the card. Offered, not taken — open-questions Q3.

### 6.4 MON — a diagnostic behind an explicit toggle

The counters line and the `<pre>` summary are unambiguously **measurements in
text nodes**. They are permitted here for three reasons, in descending strength:

1. **ABSENT AT REST.** `monOpen` defaults false, so the resting faceplate paints
   neither. This is *stronger* than livecode's shipped precedent, whose OUTPUT
   LOG is visible at rest whenever `node.data.lastRun` is set, and which the
   roster accepts on the ground that *"the output log is the SCRIPT'S PRODUCT,
   not derived state about a control."*
2. **ITS SUBJECT IS HARDWARE OUTSIDE THE RACK.** The rulings are about a
   faceplate printing derived state about its own controls. MON reports what a
   USB device put on the wire, *including the frames this module rejected* —
   which is not a property of any control on this plate and cannot be relocated
   to any control's `aria-valuetext` without inventing a control to hang it on.
3. **DELETING IT WOULD DELETE THE PRODUCT.** It is the only affordance in the
   product that can falsify `trails-decode.ts`'s wire constants — and it has
   already earned that keep twice: the owner's 2026-09-01 capture found two
   defects in the readout itself (`lastValue` settling on a release's zero; a
   frozen `label`), and a third in how a MIDI channel was printed, which had the
   gates reported broken when they were firing correctly on another jack.

The `loops N · edges a/b/c/d` line stays a LINE and does not become lamps: it is
read as a RATIO between two counters that must advance together, and four lamps
cannot express "these two numbers moved by the same amount".

### 6.5 SCREEN ON/OFF — **NO**, and it is derived

The fleet-wide ruling ("all video cards get SCREEN ON/OFF") runs over
`STRICT_FACES ∩ video defs`. `trails` is `domain: 'audio'` and declares no video
port, so the ruling does not reach it. That is the derivation every audio
picture in the roster records — spectrograph, samsloop, audioOut, dockscope,
graphicEq — and it is the same sentence each of them writes down.

The two nearest precedents differ, and the difference is the point:

| module | domain | video port? | SCREEN? |
|---|---|---|---|
| `skifree` | audio | ✅ `out` — the slope IS a video source the rack consumes | ✅ has one |
| `dockscope` / `spectrograph` / `samsloop` | audio | ❌ | ❌ none |
| **`trails`** | audio | ❌ | **none** |

And on the merits, independent of the ruling: **there is no producer a switch
could stop.** The stream is decoded in the FACTORY on the WebMIDI callback and
the scheduler tick; the surface only paints. The paint loop already
self-suppresses — an idle card costs one integer compare per frame, not a canvas
repaint (`frame()`'s dirty check), which is the saving a SCREEN switch would
otherwise buy. A toggle here would add a control, a `node.data` key on a module
that has none, and a second state for VRT to capture, in exchange for nothing.

⚠ Also **no watch mark**: `markWatched` is a VideoEngine pull-set concept and
this module has no part in it.

Recorded as owner-visible in open-questions Q1 rather than silently settled.

---

## 7. THE `EXTENSION_BODY_ROLES` ENTRY

`face-rack-status-source.test.ts:150`, deny-by-default over every `fullViewBody`
in the tree, membership derived off the DIRECTORY, `why` required by the type.
**Role: `picture`** (`ROLE_PREDICATE.picture.holds = paintsCanvas(src, extId)`,
satisfied through the mounted `TrailsPadMirror`).

As it would be committed:

> `trails: { role: 'picture', why: '` **the 1:1 PANEL MIRROR** — the Bela
> Trails' 85 × 85 mm multitouch pad drawn from the hardware's own millimetre
> constants (`TRAILS_PAD_MM` / `TRAILS_BAR_MM` / `TRAILS_BAR_GAP_MM` /
> `TRAILS_BAR_EDGE`, never pixels chosen to look right), carrying up to four
> coloured touch points with 48-point fading trails in the pad's own 0..1
> coordinates, plus the 10 × 85 mm Touch Bar drawn HATCHED AND DIM along the
> bottom edge — plus the LINK lamp, the MON toggle and its reset, and the
> monitor readout MON reveals. ⚠ **THE PAD IS A MIRROR, NOT A CONTROL**: it
> carries no pointer handler, writes no param, no `node.data` key and no Y.Doc
> update, which is what makes it honest as a body rather than an `xyPads` cell —
> a declared pad names the two params its axes DRIVE, and these axes drive
> nothing, they report. ⚠ **THE HATCH IS A FINDING, NOT A STYLE**: the device
> transmits no Bar value and has no Bar output jack, so a blank-but-normal strip
> would read as a live control that had broken; the hatch says "not a signal" at
> a glance and the caption under the canvas — `bar — not sent over USB-MIDI` —
> says it in words, gated on the same `TRAILS_BAR_TRANSMITS_MIDI` flag as the
> hatch so a firmware that starts transmitting removes both in one edit. That
> caption is a LANDMARK NAMING THE SURFACE'S OWN CONDITION (the samsloop
> `NO SAMPLE LOADED` / dockscope `±5V` shape), not a measurement of any control.
> ⚠ **NOTHING IS PAINTED INTO THE CANVAS AT ALL** — no coordinates, no channel
> numbers, no counts; the picture is a rectangle, a centre cross, a hatch and up
> to four dots. ⚠ **MON IS THE ONE MEASUREMENT ON THE PLATE AND IT IS ABSENT AT
> REST**: the toggle defaults closed, so a resting faceplate paints neither the
> `loops N · edges a/b/c/d` ratio nor the monitor summary. Its subject is a USB
> device OUTSIDE the rack — specifically the frames this module's decoder
> REJECTED — so it is not derived state about any control here and has no
> control's `aria-valuetext` to move to; it is livecode's OUTPUT LOG argument
> one step safer, and it is the only affordance in the product that can falsify
> `trails-decode.ts` against real hardware (it has already found three readout
> defects the hardware was being blamed for). ⚠ **IT IS 2-D AND MUST STAY 2-D**:
> attest-basis membership is derived from CONTENT over `lib/ui/modules/**`, so a
> WebGL context here would enrol an audio def in the GPU attest for four dots.
> ⚠ **NO SCREEN SWITCH AND NO WATCH MARK**: the video-screen ruling runs over
> `STRICT_FACES ∩ video defs` and this is `domain: audio` with no video port
> (skifree has one and therefore has a switch; dockscope, spectrograph and
> samsloop do not and therefore do not), and there is no producer to stop — the
> decode runs in the factory on the MIDI callback and the scheduler tick, and
> the paint loop already skips every frame in which nothing moved. ⚠ **NO
> `face.rackStatus`**: the binding is app-level and fanned out to every trails
> node, so there is no primary and no band to suppress. Every other text node is
> a control caption, a static lamp caption, an option NAME, instructional copy
> in the pre-connect EMPTY state, or an ERROR absent whenever nothing is wrong.
> `'` `}`

⚠ The roster **cannot see a `tileBody`** (the file's own blind-spot list). The
tile is covered by the audioIn argument instead: both slots mount ONE shared
mirror component, so what the predicate proves of the dock body is true of the
tile by construction.

---

## 8. THE TESTS THE BUILD OWES

### 8.1 What already exists and survives

`e2e/tests/trails.spec.ts` (1106 lines, 8 legs). The **AGENTS.md rule-8 chain is
already there and is not owed again**:

| leg | line | shell | fate |
|---|---|---|---|
| touch → `x1` → real VCA → audible RMS (with a silence negative control) | 178 | `rack` fixture, engine-level | ✅ unchanged |
| looping gesture strikes the gate ONCE PER REPETITION → audible | 369 | engine-level | ✅ unchanged |
| NOTE MODE steers `x1` → audible | 511 | engine-level | ✅ unchanged |
| NOTE MODE plays a real poly voice through `poly1` → audible | 668 | engine-level | ✅ unchanged |
| TRIG strikes a kick ONCE PER STEP while GATE holds | 857 | engine-level | ✅ unchanged |
| MON reports the traffic the module does NOT understand | 992 | `?shell=legacy`, asserts the CARD's DOM | ✅ unchanged — the card still renders there |
| spawning requests NO Web MIDI access | 1061 | `?shell=legacy` | ✅ unchanged |
| CONNECT with nothing plugged in EXPLAINS the no | 1084 | `?shell=legacy` | ✅ unchanged |

Nothing is deleted. Promotion does not remove the legacy card from
`?shell=legacy`, so re-pointing these is neither required nor desirable while
both shells must work.

### 8.2 What the build ADDS — the default-shell legs

⚠ The memory this exists to serve: **377 of 431 e2e specs run on
`?shell=legacy`**, which is exactly how a face ships broken while every spec is
green. All four new legs run with **no shell override**.

1. **`@trails the LANE TILE paints and CONNECT is on it`** — spawn under the
   default shell; assert `trails-tile-pad-<id>` is visible, the
   `trails-connect-{n}` action cell is present at the compact tier, and the LINK
   lamp is dark. ⚠ **Attach a `pageerror` guard** — the shared-derivation memory
   (a repair landing on `ModuleShellPlaceholder` while `ModuleShell` kept
   throwing) says only *promoting* reveals that class, and only a pageerror
   guard catches it.
2. **`@trails the DOCK body paints the mirror and MON`** — expand; assert
   `trails-face-pad-<id>`, then click `trails-face-mon-<id>` and re-run the
   unrecognised-CC assertions from the legacy MON leg (`ch1[1X] CC47`,
   `5 not decoded`, `trails-decode.ts`, sticky `vel=97`, no `vel=0`, no
   `NOTE 81 on`) against `trails-face-mon-text-<id>`. Same instrument, the other
   surface.
3. **`@trails CONNECT from the LANE TILE reaches the module's own seam`** —
   `installMidiMock`, press the tile's action cell, assert the audition ledger
   records `delivered: true` for this node **and** that the body's error line
   names the no-port case. ⚠ The ledger assertion is the one a runner can
   answer; `bound` is unreachable on CI by construction.
4. **`@trails the face surface does not disturb the audio path`** — the §8.1
   line-178 chain re-run under the default shell with the dock OPEN, asserting
   the same audible RMS. This is the leg that would catch a body that polled
   `state()` in a way that starved the engine, and it is cheap because it reuses
   `buildChain`.

Plus **flake-check `REPEAT=3`** on all four (repo standard for new/changed
tests), and a note the author must actually read: a spec passing 3× locally can
still race the product, so any failure gets a fixture fix, never a timeout bump.

### 8.3 Unit

* `trails-face-model.test.ts` — CONNECT is `order[0]`; the gesture survives
  EVERY tier (mini/compact/full/dock); `glyphBinding(trailsDef).kind === 'none'`
  is asserted from the function, not typed; `pages` cover `order` exactly; the
  action registry entry resolves and its probe is an audition.
* `trails-status-model.test.ts` — the pure status → `{ lit, tone, detail,
  errorLine, hint }` mapping, exhaustive over all six `TrailsStatusKind`s, with
  the negative control that `bound` produces NO error line and `idle` produces
  the hint but no error.
* The shared gates run themselves: `module-face-lint`, `shell-extensions`,
  `module-shell-import-guard`, `face-resting-text-source`,
  `face-rack-status-source`, `face-readout-source`, `card-range-source`,
  `card-control-ranges`, `module-docs-lint`, `contract-lock`.

⚠ **No new GATE and no new KIND of test is proposed** (owner ruling,
2026-08-25). Everything above is a module-owned spec or a unit beside an
existing one.

---

## 9. VRT

### 9.1 Scope — predict **2 new files**

| file | status |
|---|---|
| `e2e/vrt/__screenshots__/vrt.spec.ts/trails.png` | **UNCHANGED** — `vrt.spec.ts` navigates `/rack?shell=legacy&seed=none`, which still renders the verbatim card |
| `…/workflow-shell-faces.spec.ts/face-trails-compact.png` | **NEW** |
| `…/workflow-shell-faces.spec.ts/face-trails-dock.png` | **NEW** |

`trails` is **not** in `EXEMPT_FROM_VRT` (it has a live card baseline today), so
there is no exemption to drain and no `ALLOWED_PERMANENT_EXEMPT` line to delete.
A scene entry goes in `e2e/vrt/_shell-faces.ts` beside `ptzcam`'s (`:3766`),
`pages: 2`.

⚠ **Dispatch scoped: `GREP=trails flox activate -- task vrt:commit`.** A bare
dispatch derives FULL (41-56 min) because a face PR always touches a shared
roster file whose path names no module. Linux CI authors the baselines; never
commit a locally captured PNG; review the bot's exact diff.

### 9.2 The determinism argument

**A fresh spawn is deterministic with no mask and no `simPin`**, and the card
header already states why: `axisMessages` is a monotonic counter, the frame loop
compares it (plus the gate mask and the CSS size) against the last painted
frame, and with no device attached nothing ever changes — so the canvas paints
EXACTLY the resting grid, once, and then never again.

Three independent conditions each make the hardware-dependent state unreachable
on a runner, in ptzcam's "doubled" form:

1. `requestMIDIAccess` is never called until CONNECT is pressed, and the scene
   presses nothing (`midi.spec.ts` pins "page load never requests Web-MIDI
   access" globally).
2. Even a granted origin binds nothing: the matcher is `/trails/i` over port
   NAMES, and no CI machine has a Bela Trails on USB.
3. Even a bound port streams nothing without a finger on the pad.

So the capture is the resting grid, the hatched bar, its caption, a dark LINK
lamp, the pre-connect hint, and four control cells. **MON is closed**, so the
one non-deterministic region on the surface is not merely stable — it is not
rendered.

⚠ **No `videoFaceWhy`** — `domain: 'audio'`.
⚠ **What the baseline does NOT cover, stated rather than implied:** the
post-connect states (bound, streaming, MON open). Their strings are pinned in
`trails-status-model.test.ts` and `trails-monitor.test.ts`; their behaviour in
`trails.spec.ts`. Reaching them in VRT would mean installing the MIDI double in
the VRT harness, which is a change to the harness rather than to this module —
not this PR.

---

## 10. COST

| | |
|---|---|
| **WebGL attest** | **ZERO.** Basis membership over `lib/ui/modules/**` is derived from `getContext('webgl'\|'webgl2')`; these bodies are 2-D. And the def is `domain: 'audio'` with nothing under `lib/video/` — **the face is hash-transparent**, exactly as the brief states. |
| **ART** | **ZERO.** No DSP, no port, no param, no voicing change. Nothing in the audio fingerprint moves. |
| **contract-lock** | ⚠ **ONE LINE.** `face` is contract-transparent (`FACE_FIELDS_NOT_IN_LOCK` is empty *by projection*, `contract-signature.ts:58`), but `controlFamilies` IS projected (`:237`) as `trails family trails-connect kind=other prefix=trails-connect`. Run `flox activate -- task docs:accept`, review the one-line diff (CODEOWNERS-gated). |
| **docs** | ⚠ **one entry.** `trails` is in `STRICT_DOCS:268`, so `docs.controls['trails-connect-{n}']` is required — the ptzcam entry (`ptzcam.ts:190`) is the length and register to match. No other docs move: the module's explanation already describes the pad view, the bar, MON and the note mode. |
| **VRT** | 2 new baselines; 1 existing baseline untouched. |
| **e2e wall-time** | +4 legs, one of which reuses `buildChain` and one of which is a two-assertion paint check. Well under the 2-minute sign-off threshold — but the estimate must be re-measured, not asserted, in the PR body. |
| **cost artifacts** | ⚠ **BOTH must be re-pinned** — `e2e/e2e-timings.generated.json` and `e2e/vrt-strict-timings.generated.json`, from the newest run **with blobs**, after every shard has finished. Accepting while shards PEND truncates the artifact into a diff that looks like an ordinary re-pin. |
| **face inventory** | regenerate with `flox activate -- task face:inventory:accept`; never type a count. |

### 10.1 The shared files the build PR touches

Every one of these is a cross-PR conflict surface. `task pr:conflict-sweep`
after any merge to `main`, and ⚠ **never `gh pr update-branch`** on this PR —
merge `origin/main` locally and verify both sides survived.

1. `packages/web/src/lib/audio/modules/trails.ts` — `face`, `controlFamilies`,
   `docs.controls`, and the `⚠ NO face` comment at `:596-603` **deleted with its
   reasoning replaced** rather than left contradicting the tree.
2. `packages/web/src/lib/ui/workflow/strict-faces.ts` — add `'trails'`.
3. `packages/web/src/lib/ui/workflow/shell-cells.ts` — the action entry.
4. `packages/web/src/lib/ui/workflow/face-rack-status-source.test.ts` — the
   `EXTENSION_BODY_ROLES` entry (§7).
5. `packages/web/src/lib/ui/workflow/face-migration-inventory.ts` — refresh the
   `why` to describe what shipped. ⚠ Its current text is accurate today; keep
   the true half and correct the "a face would leave everything behind" clause,
   which stops being true the moment this lands.
6. `docs/design/face-migration.generated.md` — generated; accept, review.
7. `packages/web/src/lib/docs/contract-lock.txt` — one line, accepted.
8. `e2e/vrt/_shell-faces.ts` — the scene.
9. `e2e/e2e-timings.generated.json` + `e2e/vrt-strict-timings.generated.json`.

⚠ **`face-registry`-shaped merges: "keep both sides" is UNSAFE.** If 4, 6 or 9
conflicts, re-run the accept task rather than hand-merging the artifact.

---

## 11. TASTE CALLS, EACH WITH ITS ONE-LINE REVERT

| call | revert |
|---|---|
| the dock mirror stays at the card's 140 px rather than filling the plate | one CSS value |
| the tile mirror is 46 px and the lamp sits beside it | swap the strip to a stacked layout, −1 lamp |
| MON is dock-only | add it to `TrailsTileBody` and accept the overflow |
| `monOpen` is component state, not `node.data` | one write — but it breaks the module's no-`node.data`-writes property |
| the bar caption stays DOM text under the canvas | move the string into `paintBar` (§6.3) |

---

## 12. VERIFICATION GATE

```sh
# 1. the rulings' source gates FIRST — cheapest, most likely to fail
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-rack-status-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- card-range-source
flox activate -- task test:one -- card-control-ranges

# 2. face lint + the promotion anchor (asserted BOTH directions)
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- trails-face-model

# 3. the extension registry + the shared shell's module-freedom
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard

# 4. the module's own pure core — unchanged, but it is the regression floor
flox activate -- task test:one -- trails
flox activate -- task test:one -- trails-monitor
flox activate -- task test:one -- trails-decode
flox activate -- task test:one -- trails-status-model

# 5. registries, docs and the contract
flox activate -- task test:one -- module-docs-lint
flox activate -- task test:one -- contract-lock
flox activate -- task test:one -- modules-card-map
flox activate -- task test:one -- face-migration-inventory

# 6. e2e — ⚠ the WHOLE POINT is the four legs with NO ?shell override
flox activate -- task e2e:serve
flox activate -- task e2e:one -- tests/trails.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/trails.spec.ts
flox activate -- task e2e:stop
#    read the SKIP COUNT, not just the pass count

# 7. typecheck LAST — svelte-check is stricter than vitest
flox activate -- task typecheck

# 8. accept loops, each diff reviewed by eye
flox activate -- task docs:accept              # 1 line
flox activate -- task face:inventory:accept

# 9. VRT: dispatch only, SCOPED. Predict 2 NEW files. COUNT them. Never commit a PNG.
GREP=trails flox activate -- task vrt:commit

# 10. BOTH cost artifacts, from the newest run WITH BLOBS, after every shard lands
# 11. attest: NIL — 2-D bodies, audio domain, nothing under lib/video (§10)
# 12. ART: NIL — no DSP change (§10)
```

---

## 13. VERDICT

`trails` is the binder cohort's shape with a picture attached, and every piece of
it has a shipped precedent in the tree: the CONNECT cell is midiclock's and
ptzcam's, the status lamp is midiCvBuddy's, the two-slot split with a shared
read-only tile picture is skifree's, the `picture` role is dockscope's and
samsloop's, and the diagnostic behind a toggle is livecode's OUTPUT LOG with a
stronger empty-at-rest argument. **The parity leftover set is empty and nothing
in the card is unreachable under current gates.** Build it.
