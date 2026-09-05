# The interruption matrix — architectural source of truth

**Date:** 2026-09-04. **Status:** normative for the native-shell program.

> ## Why this file exists
>
> Owner ruling, `.myrobots/2026-09-04-desktop-review-APPROVED.md`, verbatim:
>
> > **Make the INTERRUPTION MATRIX the architectural source of truth.** For every
> > interruption, state which PROCESS owns each resource, which TRANSPORT survives,
> > what RECONNECTS, what may GLITCH, and what RECEIVER-SIDE instrument proves it.
> >
> > Several rows in the current plan promise more continuity than their owning
> > process can provide. No desktop phase is "done" until its row in that matrix is
> > filled in and its receiver-side instrument exists.
>
> **Two rules follow, and they are the point of the file:**
>
> 1. **No phase may claim a continuity result its instrument cannot see.** A row
>    whose instrument column says "none yet" is an OPEN row, however confident the
>    prose elsewhere sounds.
> 2. **When a row's promise exceeds what its owning process can deliver, the ROW
>    gets corrected — never the instrument weakened until the row passes.**
>    Re-pinning a gate to match broken behavior is what turns a real regression
>    green.
>
> **FOLD, NEVER APPEND.** New owner answers get edited into the affected rows in
> the same commit. Do not add an appendix that contradicts the table.

---

## 0. Processes and what each one owns

The continuity question is always "does the resource's OWNING process survive this
interruption?" So the ownership map comes first.

| process | owns | dies when |
|---|---|---|
| **Electron MAIN** (Node) | output/present BrowserWindows *(contested — see row 1)*, the loopback HTTP server, helper supervisors, native menus + save dialogs, `electron-store` slot bindings, display map | app quit only |
| **RENDERER** (Chromium, the web app) | the Y.Doc / patch graph, the audio-graph reconciler, camera `MediaStream`s, audio-in tracks, `MIDIAccess` claims, loopback capture streams, the WebSocket clients to every helper, the `__presentFrame` blit closure | renderer crash, navigation, reload |
| **AUDIO RENDER THREAD** (worklet, Chromium audio service) | the sample-accurate graph, the min-RMS/underrun accumulator | AudioContext close / renderer death |
| **es9-bridge** (Swift helper) | the ES-9 CoreAudio device session, **single-client** socket | its own crash/SIGKILL, app quit |
| **vst-bridge** (Swift helper) | live + PARKED plugin instances, their in-memory state | its own crash/SIGKILL, app quit |
| **pt-ptz** (in-tree C helper) | virtual CoreMIDI ports | its own crash/SIGKILL, app quit |

**Transports:** loopback WebSocket (renderer ↔ es9/vst); virtual CoreMIDI ports
(pt-ptz); `contextBridge` IPC (renderer ↔ main, `window.ptNative`); `postMessage` +
a same-realm closure (opener ↔ present popup — **the weak one**, see row 1).

**The structural asymmetry that most rows turn on:** every hardware session the
owner cares about is owned by the RENDERER or by a HELPER, not by MAIN. So MAIN
surviving an interruption is necessary but nowhere near sufficient.

---

## 1. The matrix

Instrument status: **✅ shipped** · **⏳ planned (phase named)** · **❌ none — row is
OPEN** · **⛔ PENDING a decision**.

| # | interruption | owning process per resource | transport that survives | what reconnects | permitted glitch | receiver-side instrument |
|---|---|---|---|---|---|---|
| 1 | **renderer crash** (`render-process-gone`) | MAIN: server, supervisors, bindings, display map. RENDERER: **everything else** — graph, streams, MIDI, sockets, blit closure | contextBridge IPC (re-established on reload); helper sockets re-dialed by the new renderer | main window reloads; bindings re-apply at boot; helper clients re-dial | **FULL output teardown.** Audio stops; cameras/MIDI/loopback re-acquire. Recovery, not continuity | ⛔ **PENDING** — output-window fate unresolved; see §2 |
| 2 | **helper SIGKILL** (es9 / vst / pt-ptz) | the dead helper owned its device session + plugin instances; MAIN owns the supervisor; RENDERER keeps the graph | none to that helper — **the socket dies with the process** | supervisor respawns (new pid); renderer **re-dials a NEW client** | **Bounded silence on that helper's path** + **state loss** (see §3). NOT zero re-dials, NOT park-preserving | ✅ `apps/desktop/e2e/supervision.spec.ts` (asserts recovery + park LOSS) |
| 3a | **patch load / swap — the DEVICE half** (slot-keyed camera + output sessions) | RENDERER owns doc, graph, streams and the node-keyed registries that hold them; helpers untouched | all of them — no process dies | **nothing.** The reserved slot ids are never deleted, so no registry entry is retired and no stream is re-acquired | **NONE for a slot.** No re-acquisition, no camera blink, no permission re-prompt. An UNRESERVED camera still dies — that is the interruption, and it is now the positive control rather than the behaviour | ✅ **graph tap:** `graph/device-slots-ydoc.test.ts` runs the REAL loader + REAL reconciler and asserts NO `removeNode` for any reserved id across a load, with an unreserved camera in the same rack asserted to die. ⏳ **receiver side:** `e2e` camera-pixels-advance across a load — see the P1 report. ⚠ Neither subsumes the other: the graph tap cannot see a frame, the e2e cannot see the engine |
| 3b | **patch load / swap — the AUDIO half** (the transition itself) | RENDERER owns the audio graph; the reconciler disposes removed nodes inline and synchronously | all — no process dies | n/a | **⚠ CLICK-FREE CROSSFADE ONLY** (owner answer 6). Content may change; the transition may not click. A hard cut or a silent rebuild gap is a DEFECT | ❌ **none — the row stays OPEN.** The design does not exist either; see §4. ⚠ P1 does NOT close this and must not be read as closing it: slots keep the INFRASTRUCTURE alive across a load, which is a precondition for a crossfade and not a crossfade |
| 4 | **device unplug** (camera / MIDI / USB) | RENDERER owns the stream + claim; the OS owns the device | contextBridge + helper sockets survive | slot re-binds when the device returns; other slots unaffected | the unplugged slot's stream ends; **no other slot may flinch**, and no permission re-prompt | ⛔ **PENDING — the receiver-side instrument does not exist at any tier.** P1 supplies the addressing the row assumes (a stable id to re-bind AT, and `device-rebind.ts`'s id→unique-name→tie-break resolver), but nothing observes an unplug: fake devices cannot be unplugged mid-run, and the `NotReadableError` contention this row's "no other slot may flinch" clause is really about is **not reproducible with fake devices at all** (plan review F7). What is missing, named: a device-enumeration fault-injection seam, or an owner-machine checklist step that is actually run. Until one exists this row is OPEN — do not let P5's unbind/rebind spec, which exercises a USER action rather than an OS event, be counted as covering it |
| 5 | **display change / hotplug** | MAIN owns the display map + window placement; RENDERER owns the blit source | contextBridge IPC | outputs re-place / re-fullscreen per the map | re-placement is visible; **audio must not flinch** | ⏳ P4 placement UNIT tests vs mocked `screen`. **Real hotplug is untested at every tier** — owner-machine checklist only. Say so in the spec header |
| 6 | **save / export** (quicksave, portable, state-only, performance-zip, recorderbox Save, take finalize) | RENDERER owns the whole save path — including, today, main-thread `zipSync` over all asset bytes | everything; no process dies | nothing | **NONE.** No RMS dip, no dropped frames. This is owner goal 5, verbatim: workflows must never *even temporarily* disrupt output | ⏳ PH worklet min-RMS/underrun accumulator + audio-clock-vs-wall-clock progress. **Must be armed BEFORE P6a claims anything** |
| 7 | **app quit** | MAIN tears down deliberately | none — by design | nothing | orderly stop; **zero orphaned helpers** | ✅ `main.ts:265-268` `will-quit` stops every supervisor (SIGTERM → SIGKILL escalation, `supervisor.ts:139-142`); checklist verifies with `ps aux` |
| 8 | **AudioContext suspension** (sleep/wake, default-sink removal) | Chromium audio service; RENDERER observes | all | `statechange → suspended → auto-resume` | brief silence at the OS event; **no full-screen `AudioGate` overlay** under `nativeAvailable()` | ⏳ P2/PH; real sleep/wake is owner-machine only |
| 9 | **Clear / undo / redo / PEER Clear** | RENDERER owns doc; slots must survive all four | all | nothing | slots survive by ID — **not** re-asserted after a delete, which would be a teardown followed by a re-add. `data.pinned` is NOT available to an output slot (it is also the canvas-HIDE bit), so the reserved-id guard is the one mechanism covering both kinds | ✅ **Clear + PEER Clear:** `device-slots-ydoc.test.ts` runs a real two-peer converge and asserts content goes while every slot id stands. Untracked spawn origin means undo never captured a slot, so Cmd-Z cannot remove one. ⏳ **redo** is unexercised — the origin argument covers it by construction but nothing observes it |
| 10 | **DOOM anything** | — | — | — | — | **EXCLUDED BY NAME.** Do not touch DOOM code, specs, waits, budgets, ledger, or sweeps without explicit owner approval (owner Q8 unanswered) |

**Positive controls — the matrix means nothing without them.** Each must stay
demonstrably red-capable, committed behind env flags (never as skipped tests):
forced graph teardown reddens the RMS floor; a forced main-thread stall does NOT
blind the accumulator (it must SEE the stall window); a forced sweep of a slot id
reddens the camera/audio-in assertions. An instrument that cannot go red is not an
instrument. Ask of each: *what is this gate structurally unable to see?*

---

## 2. Row 1 — renderer crash: the output-window cell is PENDING

**Do not write a crash spec against this row yet, and do not assert either
outcome.** A separate review thread owns the decision.

What is already established and NOT in dispute:

- The plan has already, deliberately, narrowed the crash guarantee. `§1.1`: "Any
  renderer navigation or reload IS an output teardown"; interrupter row 13: "reload
  IS an output teardown; target is automatic recovery, not survival." A prior
  review killed the stronger claim.
- The mechanism forces that narrowing for popups: `present-window.ts:358-362`
  installs `__presentFrame` as an **opener-realm closure** capturing the opener's
  `ctx`/`dst`/`source`, and `present/+page.svelte:209-217` merely calls it. A
  same-origin `window.open` child shares the crashed renderer process, and the
  shipped handler (`main.ts:255`) is a bare `{ action: 'allow' }` — no
  `outlivesOpener`. Even a surviving window would freeze forever: nothing re-installs
  the closure, and `startPresent` has **no "adopt an existing window" entry point**
  (`present-window.ts:148` always opens a fresh one).

**The live contradiction to resolve:** the plan calls output windows "shell-owned,
never swept" AND builds them on the opener→popup mechanism via
`setWindowOpenHandler`. A renderer-parented popup is not shell-owned in any lifetime
sense. **Both cannot be true of the same window.** The choice:

- **(a) Give it a real transport** — MAIN creates output windows as genuine
  `BrowserWindow`s loading `/present`, plus an adopt-existing-window entry point and
  re-installation of the frame pump on renderer boot. Genuinely shell-owned;
  P4-sized work.
- **(b) Narrow the words** — outputs stay renderer-opened popups, and "never swept"
  is downgraded to "not swept by `nodePresent.sweep`". That still kills interrupter 5
  (the projector blink on patch load), which is what P4 actually promised the owner.

Until that lands: `build-brief.md`'s P3 task 4 and its `render-process-gone` matrix
row are both marked PENDING and must not be turned into assertions. **Left as-is,
"helpers+windows alive" would become a green test for a property that cannot hold —
and in a Tier-A harness with no output window it would pass vacuously.** Free
add-on: the P2 opener spike is already scheduled with Electron running; have it
record what `render-process-gone` does to a popup and whether `outlivesOpener:true`
changes anything. Costs one assertion.

---

## 3. Row 2 — helper SIGKILL is a RECOVERY SLA, not continuity

**This row was downgraded. The old matrix claimed `E or F` — "ES-9 socket zero
re-dials" or "VST clientId reattach, no park loss". Neither is achievable across
process death, and the shipped code already behaves honestly.**

**Why F (no park loss) cannot hold.** The VST park is an in-memory dictionary in the
helper's own heap — `VSTBridgeCore/VSTBridgeService.swift:112-113`, holding a live
`Instance` (mounted AU + host). On socket detach the instance is marked
`parked = true`, notes are silenced, and it is torn down after a 90 s reattach grace
(`:304-334`, grace at `:50-58`). **There is no serialization to disk anywhere on the
park path.** SIGKILL destroys the plugin instance and everything in it. Park is
per-bridge-**process**-lifetime; it survives a SOCKET drop, never a process death.

**Why E (zero re-dials) cannot hold either** — the review that caught this named only
the VST half. A killed es9 helper forces a re-dial by construction: the shipped
`supervision.spec.ts` es9 leg awaits `a.closed` and then dials a **new** client. The
row was wrong on both bridges.

**What replaces them — assertion K, the honest SLA:**

> **K = helper recovery SLA.** The process returns to `running` under a NEW pid
> within the supervisor's backoff + health-probe bound; the renderer re-dials a new
> client; audio resumes on that path. VST park state is LOST — the plugin returns as
> a fresh default instance — and patch-persisted state is re-applied only within the
> two bounds below.

**Silence bound:** `supervisor.ts:66-69` — `backoffBaseMs: 300`,
`backoffMaxMs: 10_000`, plus jitter, plus a hello-probe-until-healthy startup window
(`:189-207`). Health is process-alive AND protocol-hello-accepted, so the bound is
real and measurable rather than zero.

**State-loss bounds — BOTH must be stated; the size cap alone is not honest:**

| bound | value | evidence |
|---|---|---|
| **size** | state above 256 KB base64 never travels in the patch at all — only the plugin id — so the plugin returns as a default instance | `vst-persistence.ts:43-44` (`VST_STATE_B64_CAP`), `:173-179` (drops `stateB64`), `:199-201` (cold remount applies only `stateB64`). The card already tells the user: `vst-status-model.ts:186-189` |
| **freshness** | anything changed since the last `getState` is lost **regardless of size** — a 60 s refresh cadence plus editor-close and mount events | `vst-persistence.ts:49` (`VST_STATE_REFRESH_MS`) |

So the honest promise for an arbitrary real plugin is: *"the bridge comes back, the
plugin remounts from patch-persisted state if it fits under the cap, and you lose up
to the last 60 s of edits either way."* Not "reattach with no park loss."

**⚠ The code is AHEAD of the prose here — this is a documentation fix, not a code
change.** `supervision.spec.ts`'s header already states "park state legitimately dies
with the bridge process — park is per-bridge-lifetime, asserted as such", and its
final leg positively asserts the ABSENCE of a replayed `mounted` after SIGKILL (a
real negative assertion, made sleep-free with a ping→pong FIFO barrier rather than a
timeout). P3's implementer found this and fixed it in code; nobody came back to
correct the plan. **Do not add a gate for this** (owner ruling: no new gates without
discussion) — the assertion exists.

**Also stale, one line:** `nativeapps/docs/vst-bridge-design.md:157-158` still lists
the `fullState` size policy as OPEN. It shipped: 256 KB base64, id-only past the cap,
warned on the card.

---

## 4. Row 3b — patch load/swap: mandatory crossfade, no design, no instrument

> **⚠ ROW 3 WAS SPLIT ON 2026-09-04 (P1), and the split is a CORRECTION, not a
> softening.** The single row promised two different things of two different
> resources, and lumping them made the whole row read OPEN while half of it was
> shippable — which is the mirror image of the failure this file exists to
> prevent. **3a** is the DEVICE half: camera and output sessions surviving the
> swap, which P1 delivers by never deleting the reserved id, and which now has a
> graph-tap instrument that goes red on an unreserved camera in the same rack.
> **3b**, below, is the AUDIO half: the transition itself. It is UNCHANGED and
> still OPEN.
>
> **Do not let 3a's green be read as progress on 3b.** Keeping the
> infrastructure alive across a load is a PRECONDITION for a crossfade — you
> cannot fade between two graphs if the output device went with the first one —
> and it is not a crossfade. The clause below still holds in full: three
> resources structurally forbid two simultaneous owners, there is no master gain
> to fade with, and the reconciler disposes inline. P1 moved none of that.

Owner answer 6 is four words: **"Patch swap: CLICK-FREE CROSSFADE."** They change
this row from permissive to demanding, and nothing downstream has caught up:

- the old matrix cell read *"content dip allowed; infra floor held"* — now
  **"crossfade envelope only"**;
- `plan.md` §3.1 row 1 called the crossfade *"optional … owner Q15"* — now mandatory;
- **no phase owns the work**, and **no instrument asserts it**.

**This is the one row where the honest answer is "the architecture does not currently
permit the promise."** A true crossfade needs the OUTGOING audio graph to keep
rendering past the Y.Doc swap. Measured against `origin/main`, it cannot today:

- the load is one transaction that clears unconditionally
  (`persistence.ts:529-587`), and the reconciler disposes removed nodes **inline and
  synchronously** (`reconciler.ts:182` → `engine.ts:341`) — there is no deferred-teardown
  seam anywhere;
- **there is no master gain to fade with** — the whole terminal chain including
  `connect(ctx.destination)` is itself a patch node (`audio-out.ts:305`, disposed at
  `:518-534`), and the `master` write is a step, not a ramp (`:477-478`);
- **three resources structurally forbid two simultaneous owners** — ES-9 answers
  `busy` to a second client (`bridge-owner.ts:28-31`), Launchpad `bind()` returns
  false while another owner holds the port
  (`node-launchpad-monitor-registry.svelte.ts:51-52`), and mic release is an
  irreversible `track.stop()` (`node-audio-input-registry.svelte.ts:23-33`). MIDI
  inputs are single-slot last-writer-wins, so an overlapping graph goes MIDI-deaf
  (`input-attach.ts:1-15`);
- and **17 single-owner registries are swept off the DOC snapshot, not engine
  liveness** (`Canvas.svelte:2574-2660`), so deferring audio teardown alone yields a
  still-sounding graph whose hardware has already been reclaimed.

**That is a design decision with a phase and a price, not a wording change** —
options, costs, and the semantic question the owner must settle first (a smooth
*gap* vs a true *overlap*, roughly an order of magnitude apart) are in
[crossfade-options.md](crossfade-options.md).

**⚠ This row also shapes the PH instrument.** A "min-RMS never dips" floor is only
meaningful under a true overlap; under a fade-out/rebuild/fade-in the instrument must
assert the ENVELOPE SHAPE instead. Building the instrument before the semantics are
settled risks building the wrong one.

Until it is answered: the row stays OPEN and demanding. **Do not weaken it back to
"content dip allowed" to make a test pass** — that would re-pin the gate to the
behavior the owner rejected.

---

## 5. How to use this file

**Arming a phase:** its rows must be filled in — all six columns — and the
instrument column must name something that EXISTS and has been shown to go red.
"Planned" is not armed.

**Adding an interruption:** add the row here first, then the assertion in
`build-brief.md` §5. The matrix leads; §5 is its assertion view.

**When a row cannot be met:** correct the ROW and tell the owner what the guarantee
now is. Never weaken the instrument until the row passes. Rows 1, 2 and 3 above are
worked examples of that correction — two downgraded to match physics, one left
demanding because the owner raised the bar and the work is simply unbuilt.
