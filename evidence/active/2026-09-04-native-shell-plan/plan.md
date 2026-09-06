# Native shell plan — Electron shell, in-repo helpers, device-slot continuity

**Date:** 2026-09-04 (v2 — three adversarial reviews folded: continuity-contract,
harness, integration/sequencing; all CONFIRMED findings absorbed below, all REFUTED
plan claims moved to Appendix A with reasons)
**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). Every owner-decision
item is flagged; nothing here authorizes itself. READ-ONLY plan — no commits, PRs, or
submodule changes have been made.
**Basis:** `.myrobots/2026-08-31-native-shell-spec.md` (the spec — this plan extends, does
not replace it); three surveys 2026-09-03/04; three adversarial reviews 2026-09-04
(measured against `origin/main` incl. #2321, which is NOT in stale local checkouts);
`.myrobots/2026-09-03-legacy-removal-plan-v2/plan.md` (v2.1) for sequencing facts.

> ## ⚠ READ THIS BEFORE EDITING — document contract
>
> 1. **Owner answers are NORMATIVE.** `build-brief.md`'s `OWNER ANSWERS 2026-09-03`
>    and `OWNER GO 2026-09-03` sections outrank every line in this file. Where this
>    plan and an owner answer disagree, the answer wins and this prose is the bug.
> 2. **Body reconciled against those answers on 2026-09-04.** Answers 3 (gating-light
>    lane), 6 (mandatory click-free crossfade) and 7 + OWNER GO (P6a held) are folded
>    in at §3.1, §6, §7 and §8. Q9/Q13/Q15 in §9 are ANSWERED, not open.
> 3. **The [interruption matrix](interruption-matrix.md) is the architectural source
>    of truth** (owner ruling — `.myrobots/2026-09-04-desktop-review-APPROVED.md`).
>    No phase is "done" until its matrix row is filled in and its receiver-side
>    instrument exists. No phase may claim a continuity result its instrument cannot
>    see.
> 4. **FOLD, NEVER APPEND.** Edit the BODY at the lines an owner answer contradicts,
>    in the same commit. Do not add a third layer of appendices. This package already
>    failed that way once: the 2026-09-03 answers were appended, `second-review.md`
>    caught the contradictions the same day, and they survived a further day unfixed.
> 5. **This package supersedes `.myrobots/2026-09-03-native-chromium/`**, which was a
>    byte-identical stale copy and has been deleted; its unique `second-review.md`
>    now lives beside this file.
**Owner directive (verbatim goals):**
1. Pull `patchtogether.nativeapps` (VST bridge, PTZ, Edge helper scripts) and
   `patchtogether.es9` into this repo as submodules — git-ifying them first if needed,
   with the secrets audit gating (no user/machine data or secrets; history rewrite or
   fresh-init where the audit demands).
2. Tasks + code to build an OSX executable bundling Chromium that boots to a pre-flight
   UI for connecting ES-9, PTZ, up to 4 webcams, and up to 4 "present on" displays.
3. Boot Patchtogether so access to those cameras/screens/VSTs/hardware (push, launchpad,
   trails, kria, gamepad/joystick) NEVER breaks; every patch gets baked-in cam1..cam4 +
   output1..output4 modules (outputs render in the purple/video zone, inputs in the
   header-bar patch area).
4. Save/load in this mode never disrupts any connection.
5. Recorderbox Save and ALL workflows never even temporarily disrupt output.
6. We fully control our Chromium (Electron per the owner's standing direction — or
   justify deviation; a modified Chromium build is on the table if needed) to eliminate
   web-app/local-server hassles.

**Shell choice re-affirmed:** Electron, per the spec §2 and owner 2026-08-31.
Tauri/WKWebView lack WebMIDI/WebUSB/Web Serial; raw CEF and real-Chrome kiosk lose
menus/permission handlers/window interception. A **modified Chromium build is NOT
needed** — every named hassle is killed by Electron's stock flag/handler surface plus
pinning the Electron version — **with two flags the first draft missed** (adversarial
review, CONFIRMED):

- **`--disable-features=MidiMacUmp` is load-bearing, not optional.** Chromium ≥152's
  UMP CoreMIDI backend silently breaks SysEx on macOS; the tree ships detection and
  "relaunch Edge" advice for exactly this (`electra/transport-gate.ts:5-12,46`,
  `audio/ptz-midi.ts:277`, `ptzcam/ptzcam-status-model.ts:27`), and
  `../scratch/start_edge.sh` exists solely to apply the flag. pt-ptz's protocol is pure
  SysEx; owner goal 3's device list (PTZ, Push, Launchpad, Electra) is SysEx-dependent.
  The flag goes in the P2 flag set, with a Tier-B SysEx round-trip assertion; the
  pinned Electron's Chromium version is checked against it at every pin bump.
- **`setDisplayMediaRequestHandler` is required or loopback dies entirely.** In
  Electron, `getDisplayMedia` fails outright without a display-media handler
  (`ui/viewport-acquire.ts:18` documents the gesture requirement the shell must also
  dissolve). P2 handler set, and interrupter row 14 below.

---

## 1. Architecture

### 1.1 Process model

```
Electron main process (apps/desktop, ~1–2k LoC TS)
├── loopback HTTP server serving the static web build          (§1.4)
├── helper supervisor: es9-bridge, vst-bridge, pt-ptz          (§1.3)
├── window manager: main UI + output1..4 sinks, display map    (P4)
├── native menus (app ▸ Quit, File ▸ Load Patch…)              (spec §8)
├── permission/device handlers: midi+sysex, cam/mic, USB,
│   serial, AND setDisplayMediaRequestHandler (loopback)
└── config store (electron-store JSON): slot↔device bindings,
    display map, helper prefs — NEVER the Y.Doc
        │ contextBridge preload → window.ptNative
        ▼
renderer: the SAME packages/web build, unmodified
   main window = patcher (owns the ONE AudioContext)
   output windows = pure canvas sinks (/present blit, opener-driven)
```

Two layers with different lifetimes — this is the whole design:

- **Persistent-device layer (app-session lifetime).** Hardware sessions — camera
  MediaStreams, audio-in tracks, ES-9 socket, VST bridge connections, MIDI claims,
  USB/serial claims, loopback screen captures, output BrowserWindows — keyed on
  **slot ids**, owned by node-keyed registries. NOTE (review D4): the S1 extractions
  that make the 7 producers card-independent are **future work on the legacy-removal
  branch, not present-tense fact** — today cameraInput et al. are still card-mounted
  via HeadlessSourceHost; the sweep registries exist (`Canvas.svelte:2573-2587`) but
  producer card-independence lands with S1. This is exactly why P1 waits for S1 (§8).
  Slots then move sessions one step further: from graph lifetime to app-session
  lifetime (slot ids never disappear). Completes the #1531/#1574/#1583/#1590 direction.
- **Swappable-patch layer (graph lifetime).** Everything else in the Y.Doc, loaded
  in-place via `loadEnvelopeIntoStore` clear+insert (persistence.ts:457; clears
  unconditionally today, :536-537 — verified). The reconciler's
  one-snapshot-per-transaction + same-id-same-type survival (#2321, verified on
  origin/main) delivers continuity once identity is stable; baked slot ids provide it.

**Renderer-owned resources are the honest blast radius** (review M4): the
AudioContext, camera/audio-in MediaStreams, MIDIAccess objects, and popup opener links
all live in the renderer. Any renderer navigation or reload IS an output teardown; only
helpers and shell-owned BrowserWindows survive it. The contract (§3) therefore names
renderer navigations explicitly, and "File → New rack" gets an in-place path (row 16).

### 1.2 IPC / protocol map

| link | transport | protocol | notes |
|---|---|---|---|
| main ↔ renderer | contextBridge preload | typed `window.ptNative`: `nativeAvailable()`, `loadPatchRequested` event, `presentTargets()`, `slotBindings` get/subscribe, `helperStatus` subscribe, `quit()` | five-conventions shape + simulated double; web never imports Electron |
| renderer ↔ es9-bridge | `ws://127.0.0.1:9209/ws` (9210 fallback) | protocol v1: JSON control + binary 0x01 planar-f32; ±1.0 ≙ ±10 V | client stays the existing transport Worker + SAB rings; main only spawns/supervises. Single active client + grace takeover (es9 423b6f2, verified) |
| renderer ↔ vst-bridge | `ws://127.0.0.1:9309/ws` | 0x01 audio + 0x02 MIDI; `hello.clientId` park/reattach; cap 16 | client-clocked pull-through; browser blocks ARE the clock |
| renderer ↔ pt-ptz | virtual CoreMIDI pairs (WebMIDI, pure SysEx) | `docs/pt-ptz-midi-protocol.md` | **pt-ptz EXISTS IN-TREE: `tools/pt-ptz/` (C + Makefile, tracked)** — review A3; owner Q2 is now a build/packaging question, not an existence question. Main owns lifecycle only |
| main ↔ helpers | child_process spawn + WS health probe | supervisor (§1.3) | binaries from `Contents/Resources` in the packaged app; binary resolution is INJECTABLE so Tier A tests the supervisor with stub paths (review F2) |
| main ↔ output windows | `setWindowOpenHandler` + display map | same-origin opener→popup DOM access preserved; blit loop unchanged | ⚠ HIGHEST-RISK display assumption; [verify] = **`task desktop:spike`** (apps/desktop/SPIKE-OPENER-DISPLAY.md — the one-command dual-monitor harness; run it on the owner's rig and record the verdict there). The 2026-09-03 hour-one probe (p2-notes.md) answered the DOM-access half on ONE display only; the cross-display blit half is what the harness answers — the fallback (captureStream) rendered BLACK on real dual-monitor hardware (spec §5). PASS unblocks P4 on this architecture; a domAccess/blitPixels/motion FAIL forces the P4 re-plan |

Port map (all reserved in-tree already — verified): 9209/9210 es9 · 9309 vst · 1234
Bitwig (avoid) · 1235 Hocuspocus · 5173/4173 Vite · NEW: one fixed loopback port for the
shell's HTTP server. **[verify] settled (review B1/B3):** both bridges' default origin
policies admit ANY loopback origin — the check is host-only (es9
`WebSocketServer.swift:108-115`; nativeapps `BridgeKit/OriginPolicy.swift:3-6`). A fixed
port is kept for documentation and debuggability only; it is not load-bearing for Origin
allowlists (the first draft's justification was false — Appendix A.4).

### 1.3 Helper lifecycle supervision

- Spawn at app launch, one supervisor instance per helper (es9-bridge, vst-bridge,
  pt-ptz): state machine `stopped → starting → running → restarting(backoff) →
  crash-looped`. Health = process alive AND endpoint accepts a hello within the startup
  window (observable state, not a timer). pt-ptz health = its virtual CoreMIDI ports
  exist (macOS only; stubbed on Linux).
- Binary resolution is an injected function: packaged builds resolve
  `Contents/Resources/helpers/`; Tier A injects stub paths through the SAME state
  machine. The real packaged-path seam (asar-unpack, Resources layout) is covered ONLY
  by Tier B + owner-machine smoke — stated honestly, per review F1/F2.
- Exponential backoff with jitter; crash-loop threshold surfaces a red status row in the
  pre-flight UI (never a modal — no modals while presenting is standing policy).
- Renderer reattachment is already designed into both protocols: vst `hello.clientId`
  park/reattach; es9 single-client grace takeover. The web probes already retry; the
  supervisor just makes the endpoint come back.
- `render-process-gone` → reload the window; helpers and shell-owned windows survive,
  slot bindings re-apply on renderer boot. **A reload is still an output teardown**
  (renderer owns the AudioContext and streams — §1.1); the goal is fast automatic
  recovery to a running rig, not the first draft's overstated "not a rig teardown"
  (Appendix A.1).
- ES-9 output-mode push policy (stuck-note incident; never got a caller) gets its
  natural home in the pre-flight ES-9 panel — owner Q11, not assumed; hw-verify
  outstanding.

### 1.4 Serving the web app

Loopback HTTP server in main serving the static build with `COOP: same-origin` +
`COEP: credentialless` (matching `packages/web/_headers`; credentialless so archivist's
archive.org media loads), SPA fallback for `/rack`. file:// is out (OPFS, getUserMedia,
WebMIDI need secure context; SAB/Faust needs cross-origin isolation). Beta gate auto-off
(its env var is named in `runbooks/secrets-and-accounts.md`, the one home for that —
do not restate it here). `/api/*` (Clerk/Neon) is dashboard/collab only — the local rig
runs anonymous. Build item: adapter-static or serve the CF adapter's static output
directly [verify output shape, per spec]. Dev switch points at the flox dev server
(5173). Recommend bundled build (spec Q4) — offline-stable, versioned with the app.

**Packaging note moved out of P7 (review B4):** entitlements' TCC **usage strings**
(NSCameraUsageDescription / NSMicrophoneUsageDescription) belong to electron-builder
packaging in `desktop:build` (P2) — macOS kills a packaged app on first getUserMedia
without them, signing or no signing. Only Developer ID signing/notarization stays
owner-gated in P7. Operational note: ad-hoc/unsigned rebuilds change binary identity, so
TCC grants do NOT persist across interim rebuilds — the owner re-grants camera/mic per
rebuild until P7; document in the runbook.

---

## 2. Baked-in root-tree modules — cam1..4 / output1..4

### 2.1 Shape

- **Recommend 2 defs × 4 fixed instances** (`cameraSlot`, `outputSlot`). Load-bearing
  invariant: **fixed, reserved node ids** (`slot:cam1` … `slot:out4`) with **one type
  forever** — `identityChanged` must be structurally impossible for a slot id.
- **Slot survival is THREE disjoint mechanisms, not one** (review M3/B3 — the first
  draft's single `undeletable` claim is Appendix A.3):
  1. def-level `undeletable` + `maxInstances` — covers `deleteNode`/Cadillac
     (`graph/mutate.ts:165-167`);
  2. `data.pinned: true` on every slot node — covers Clear, which consults
     `isPinnedNode()` ONLY (`Canvas.svelte:3539-3548`), a mechanism disjoint from
     the registry flag;
  3. a `duplicate()` guard — today `graph/duplicate.ts` has zero
     undeletable/pinned checks, so a duplicated slot would mint a sweepable
     same-type fifth "slot" competing for hardware with undefined `maxInstances`
     interplay (review B3). Slot ids/types are excluded from duplicate.
- **`ensureSlots()` trigger set (review M3):** doc create, after every envelope load
  (single seam — exactly ONE `loadEnvelopeIntoStore` caller, `Canvas.svelte:176`,
  verified), AND a deep observer on the nodes map that re-asserts slot presence — this
  covers local Clear, a PEER's Clear arriving over sync, and undo/redo cycling.
  `ensureSlots` spawns under an **untracked origin** (the `workflow-pins.ts:37-40`
  precedent) so undo never captures slot creation and Cmd-Z cannot remove one.
- **Slot factory failures must retry (review M5):** the reconciler's `failedNodes`
  mark is dropped only when the id leaves the snapshot — which a slot id never does —
  so one transient throw (worklet addModule hiccup, GL loss mid-add) would silence a
  slot for the whole app session with a single console.warn. Slot ids get an explicit
  retry: clear the failure mark on a backoff timer / on `ensureSlots` re-assert, so a
  slot gets genuine re-attempts.
- **Placement (owner directive):** output1..4 in the purple/video zone; cam1..4 in the
  header-bar patch area. Unbound slot = dark module (web and native).
- **Across the board, not native-only** (spec Q2, recommend): one tree shape, one code
  path. Consequence priced honestly (review C2): 8 always-present visible nodes enter
  EVERY boot — 295 `seed=none` spec files, the `rack` fixture (243 importers), every
  full-rack VRT scene, every empty-rack assertion (`landing-new-rack-is-fresh`,
  parked #1847, asserts fresh-rack contents). **NOT priced like the trails PR** —
  that comparable was wrong (one optional module vs 8 always-present nodes). Budget a
  dedicated fixture/VRT/cost-artifact pass, and land it in the §8 window.
- Standard new-module bookkeeping: DESCRIPTIONS (unit gate), lowercase labels,
  PatchPanel, contract-lock, EXPECTED_NODE_TYPES, docs page; face fleet is COMPLETE so
  every slot def needs a **face disposition on day 1**. Faces near-zero prose; compact
  per density ruling.
- If slot defs add CV-scaled ports → FULL web unit suite; any poly width interaction →
  FULL `task art` (standing rules).

### 2.2 Infrastructure, not patch content (save/load semantics)

- **Envelope OUT:** slot nodes serialize as presence + user-facing params only.
  Hardware bindings (camera `deviceId`, display id, ES-9 config, MIDI
  `lastDeviceName`) live in the local config store (shell electron-store; web
  localStorage fallback) — nothing machine-specific rides the envelope. Kills the
  #2045 class; in collab each client sees their own hardware in the slots.
- **Envelope IN:** the clear pass **skips slot ids** (merge, never delete); the insert
  pass maps incoming slot nodes onto the live baked ids (params merged, id preserved);
  edges referencing slot ids reconnect under the reconciler's same-id-skip. Old
  envelopes without slots: `ensureSlots()` post-load. Foreign envelopes with stale
  bindings inside node.data: stripped on import (one-time shim).
- **Load-time type guard at slot ids (review B2):** the contract-lock cannot see
  envelope DATA. A hand-edited/foreign envelope carrying a different type at
  `slot:cam1` would otherwise reach the insert pass and — under #2321 — a type change
  at a reused id is EXACTLY a remove+add teardown: the plan's own mechanism firing
  against its own invariant. The merge pass therefore **drops/coerces any incoming
  node at a slot id whose type differs** (slot type wins, foreign params discarded).
  Related hazard: slot defs must never route through `RETIRED_TYPE_ALIASES`
  (persistence.ts:484-496 rewrites type in place and zeroes params — retiring a slot
  def through that table would turn every old-envelope load into an identityChanged
  teardown + params wipe).
- **Version-skew story (review B1):** web prod ships nightly; the shell is a bundled
  build on its own cadence — mixed-version fleets are permanent. An OLDER web build
  loading a shell envelope drops unknown slot types AND their edges, and a re-save
  persists the amputation (persistence.ts:501-507, 552-558). Mitigations, in order:
  (1) **ordering** — P1 lands slots across the board in web prod BEFORE the shell can
  produce envelopes containing them (P1 precedes shell save paths by construction);
  (2) fix-forward: add a version-floor field so future builds refuse-don't-amputate
  envelopes above their ceiling (owner Q17 — a small parseEnvelope contract change).
  Old already-shipped builds cannot be fixed retroactively; (1) is the real defense.
- **Binding resolution:** `graph/device-rebind.ts` (id → unique name → deterministic
  tie-break → none, with `matchedBy` — verified) is the resolver; `resolveGamepadSlot`
  is the precedent. Complete the name-rebind coverage gap for the `device-module.ts`
  family (#2319/#2325 — only the 4 audio-MIDI factories read the name back today).
- **Double-instantiation is NOT a risk (review B4, attack failed):** deterministic ids
  converge under CRDT (workflow-pins precedent) and there is a single
  `loadEnvelopeIntoStore` seam.
- **Sweep contract:** the Canvas sweep against the live node-id set never fires for a
  slot id — survival via EXISTING machinery. Slot-keyed hardware sessions additionally
  get app-session lifetime so even hypothetical slot-node churn cannot stop a track
  (`readyState:'ended'` is irreversible — the audio-in row, fixed in P1, row 3).

---

## 3. The output-continuity contract

**Definition (mechanical):** the AudioContext, the master/ES-9 output chain, slot-keyed
hardware sessions (camera streams, audio-in tracks, bridge sockets, MIDI/USB/serial
claims, loopback screen captures), and display surfaces (output BrowserWindows) have
**app-session lifetime** and outlive every workflow. No workflow — patch load/change,
save (ALL save paths: quicksave, portable, state-only, performance-zip), recorderbox
Save, take finalize, helper restart, **renderer navigation (File → New rack included)**,
Clear, undo/redo, OS sleep/wake, collab reconnect (if in) — may cause: (a) an output
RMS dip below floor at the master/ES-9 tap beyond what the patch-content change itself
sounds like; (b) camera stream re-acquisition (light blink / renegotiation); (c) a
bridge socket disconnect; (d) an output window close/reopen; (e) any permission
re-prompt; (f) a screen-capture share picker.

**⚠ REVISED by owner answer 6 (2026-09-03): "Patch swap: CLICK-FREE CROSSFADE."**
The original text here read "Patch CONTENT changing sound on load is not a
violation; infrastructure flinching is." That is now only half true. Infrastructure
flinching remains a violation, and patch content is still allowed to CHANGE — but
the TRANSITION between old and new content must be click-free, i.e. no
discontinuity beyond a declared fade shape. A hard cut, and the silent gap while
async factories rebuild, are both violations under the answer. This is a real
architectural obligation with no owning phase and no design yet; see
[crossfade-options.md](crossfade-options.md) for the options, their costs, and the
semantic question the owner must settle first. Do not weaken this clause back to
"content dip allowed" to make a test pass.

**Instrument scope, stated honestly (review F4):** clause (a) is verified at the GRAPH
tap by an **AudioWorklet-resident min-RMS/underrun accumulator** (gapless,
audio-thread-side — same by-construction argument as boundary 7's worklet exemption),
plus an audio-clock-vs-wall-clock progress check for audio-thread stalls. An
AnalyserNode poll CANNOT carry a "never" claim (683 ms retention ceiling; the poll runs
on the main thread that save stalls; positive control blind to stall-window dips).
Device-callback underruns are downstream of any in-graph tap: **device-level continuity
is verifiable only by Tier B + owner ears** — a stated scope reduction, not an implied
guarantee.

### 3.1 Every current interrupter and its fix

| # | interrupter (today) | fix | phase |
|---|---|---|---|
| 1 | Different-id load: full audio-graph teardown, silent until async factories rebuild | ⚠ **NO LONGER "inherent".** Owner answer 6 makes a CLICK-FREE CROSSFADE mandatory, so the silent rebuild window is a defect to fix, not a semantic to accept. Contract scope still holds (master output chain + ES-9 path hang off slot-keyed infrastructure and stay alive), but the transition itself must now be click-free. **No phase owns this and no design exists** — options + cost in [crossfade-options.md](crossfade-options.md); owner must settle semantics first | P1 + **P1x (unassigned, unpriced)** |
| 2 | Camera MediaStreams stopped → fresh `getUserMedia` (blink; `NotReadableError` risk) | Camera sessions keyed to slot id, app-session lifetime; patch nodes consume the slot's stream by reference. NOTE: `NotReadableError` contention is NOT reproducible with fake devices — Tier B/manual only (review F7) | P1 |
| 3 | AUDIO IN tracks stopped — **irreversible** (`readyState:'ended'`) | Slot/app-lifetime acquisition; `track.stop()` never called by any load path; node-audio-input-registry re-keys to the persistent session. **Assigned to P1, not P6** — the first draft listed it in both (review D1); the only unrecoverable teardown goes earliest, P6b merely re-verifies under the RMS instrument | P1 |
| 4 | ES-9 bridge released + re-dialed when the engine handle disposes | Socket owned by an app-lifetime slot-keyed session in `bridge-owner.ts`; engine nodes attach/detach from the LIVE socket | P1 |
| 5 | Projector popups CLOSED by `nodePresent.sweep`, restore-reopened | output1..4 slots + shell display map: BrowserWindows shell-owned, never swept; blit re-targets the live window; screen-identity matcher reused | P4 |
| 6 | Recorderbox recording FINALIZED mid-take on load | Correct semantics (recorder is patch content) but finalize must be non-disruptive: OPFS writes already off-main (verified); verify no dip under the worklet RMS instrument | P6a |
| 7 | samsloop take ended; Launchpad LED pump released on load | Acceptable patch-content semantics; MIDI claims already app-lifetime; pump re-binds on rebuild. Assert no double-claim | P1 |
| 8 | **DOOM session killed on load** | **DO NOT TOUCH.** Excluded by name until explicit owner approval (Q8) | — |
| 9 | Save: the SHIPPING paths are `makePortableEnvelope`/`makeStateOnlyEnvelope` (encode → decode into temp doc → full traversal → toJSON → fresh-SyncedStore rebuild → re-encode, persistence.ts:237-346) — several× `makeEnvelope` — and performance save runs fflate `zipSync` over ALL asset bytes on the main thread BY DESIGN (`performance-zip.ts:24-27,166`). Review M6; the first draft's "one short main-thread step" is Appendix A.2 | Measure the REAL paths; move base64/Blob assembly AND the zip off-main (worker; revisit the deliberate no-Worker constraint in performance-zip); keep the Y encode short or chunked. Acceptance = worklet RMS floor across the WHOLE workflow, every save family | P6a |
| 10 | Recorderbox capture: per-rAF main-thread WebCodecs VideoFrame encode (drag-glitch/output-underrun class) | OffscreenCanvas worker capture (standing GO; owner preview before merge); assert RMS floor while recording | P6a |
| 11 | Recorderbox stop(): remux + Save-As dialog | Native save dialog from main never exits fullscreen; no-modals-while-presenting policy kept; assert under RMS floor | P4/P6a |
| 12 | Browser-only: unfocused rAF throttling, modal-exits-fullscreen, Esc toast, permission prompts, autoplay gate, device pickers | Electron flag/handler set: `backgroundThrottling:false`, permission auto-grant, no-gesture autoplay, kiosk windows, USB/serial handlers, powerSaveBlocker, **`--disable-features=MidiMacUmp`**, **`setDisplayMediaRequestHandler`**, pinned Chromium | P2 |
| 13 | Renderer crash takes the rig | `render-process-gone` → reload window; helpers + windows live in main; slot bindings re-apply on boot. Honest scope: reload IS an output teardown (§1.1); target is automatic recovery, not survival | P2/P3 |
| 14 | **NEW (review M1): OS-side AudioContext suspension has NO non-gesture recovery** — every resume path is gesture-backed (`audio-gate.svelte.ts`, `Canvas.svelte` ensureEngine, video-audio-keepalive), and `AudioGate.svelte` throws a full-screen fixed overlay whenever `!running`. Default-sink removal, sleep/wake, or another app grabbing the device = silence + a modal-class overlay mid-set | `statechange → suspended → auto-resume` (trivially safe under shell permission auto-grant); AudioGate overlay suppressed under `nativeAvailable()` (status row instead), shown only if auto-resume fails repeatedly | P2 (shell) + small web change |
| 15 | **NEW (review M2): loopback screen capture is graph-lifetime** — node-keyed single-owner stream (`loopback-status-registry`), swept on load; new node ids mean re-acquisition = gesture + share picker mid-performance. And without a display-media handler Electron fails `getDisplayMedia` outright | P2: handler (auto-select, no picker). P4: loopback capture joins the slot/app-session-lifetime set, or at minimum gesture-free, picker-free re-acquisition across loads | P2 + P4 |
| 16 | **NEW (review M4): "File → New rack" = `resetLocalScratchId()` + `window.location.reload()`** (`Canvas.svelte:3596-3603`) — a renderer navigation that kills AudioContext, streams, MIDIAccess, opener links | In shell: New rack routes through in-place clear (tracked origin) + `resetLocalScratchId` + `ensureSlots`, no navigation. Browser path keeps reload | P1 |
| 17 | **NEW (review M7, only if collab is in — Q7): relay re-auth failure navigates the renderer away** — authenticationFailed → `provider.destroy()` → `clearLocalReplica` + `goto` (`multiplayer/provider.ts:85-99`, `routes/r/[id]/+page.svelte:196-210`), tearing the rig mid-performance. Ordinary reconnect is clean (CRDT state-vector merge; `/rack` attaches no provider) | Guard the failure path: surface a status row + retry auth in place; never navigate while output lives | Q7-gated |

---

## 4. Helper-repo integration — with the secrets gate

Survey verdicts, independently re-run by the integration review (A1 — CONFIRMED):
**both bridge repos audit CLEAN** (es9: 5 commits, no remote, full `log -p --all` grep
clean except benign prose "token" hits; nativeapps: zero commits, tree clean). Neither
needs a history rewrite or fresh-init. **Correction (review A2):** the first draft
cited "survey 2" as the gate record — **no such file exists in `.myrobots/`**; the gate
requires its record to be CREATED at execution time (step 5), never cited from a
nonexistent artifact.

**Premise corrections (review A3 — the directive's helper inventory):**

- **pt-ptz EXISTS AND IS TRACKED IN THIS REPO:** `tools/pt-ptz/{pt-ptz.c, Makefile,
  README.md, start_ptz.sh}`; `docs/pt-ptz-midi-protocol.md` names it canonical. It is
  C + make, NOT Swift, NOT in a submodule. Consequences fixed in this plan:
  `task helpers:build` builds it via make alongside the Swift bridges; P3 bundles it
  from the tree, not from a submodule; P5's pre-flight PTZ status row now has a real
  producer.
- **The Edge helper scripts EXIST at `../scratch/start_edge.sh` +
  `../scratch/edge_defaults.sh`** — unversioned, outside every repo, never
  secrets-audited, single-point-of-loss like es9 was. `edge_defaults.sh`
  (AutomaticFullscreenAllowedForUrls) is fully subsumed by the shell owning
  fullscreen. `start_edge.sh`'s purpose (`--disable-features=MidiMacUmp`) is subsumed
  ONLY because the P2 flag set now carries the flag (§0). Both scripts stay operative
  for the still-supported browser path and must be versioned (owner Q2, reshaped):
  recommend `tools/edge-browser/` in this repo, audited on the way in.
- **Integration-shape alternative the owner should see (review A4, feeds Q4):**
  submodules serve the BUILD barely — web CI never clones them, protocol constants
  are deliberately copied never imported (zero code sharing), the repo has no
  `.gitmodules` today, and every worktree (cap 10) and fresh clone gains a
  `git submodule update --init` step. The repo ALREADY vendors a native helper
  directly in-tree: `tools/pt-ptz/` — a working precedent. Recommendation stands as
  submodules per the directive's explicit wording, but the vendoring alternative is
  surfaced, not buried. Also: nativeapps' own README defers es9's migration onto
  BridgeKit, so the es9 submodule's path/pin churns by design later.

Ordered steps (each blocked on the owner Qs it names):

1. **Back up es9 NOW** — only repo with commits and no remote: `git bundle` to a second
   location before any restructuring. No owner input needed; do first.
2. **Owner Q1:** create remotes (org + visibility — presumably private under
   `2600hz-oscillator`). Nothing pushes until this exists.
3. **es9 prep:** add repo-local `.gitignore` entries for `.claude/settings.local.json`
   and `.myrobots/` (currently saved only by the user's GLOBAL gitignore; the local
   settings file carries an absolute `/Users/2600hz/...` path — verified); LICENSE
   (owner Q3); commit; push.
4. **nativeapps prep:** initial commit of the clean tree; same repo-local ignores;
   LICENSE; push.
5. **Secrets gate (run per repo immediately before EVERY push of rewritten/new
   history):** `git log -p --all` + working-tree grep for keys/tokens/passwords/
   `.env`/serials/absolute home paths/user identifiers; confirm `.gitignore` covers
   local agent state; **write the run + result to
   `.myrobots/<date>-helper-secrets-gate.md` at execution time** (review A2). Any hit:
   filter-repo or fresh-init, then re-run. The 2026-09-03/04 runs passed; they are
   re-run and RECORDED at push time regardless.
6. **Add submodules** in inet.modular (path owner Q4; recommend
   `apps/helpers/es9-bridge` + `apps/helpers/vst-bridge`), pinned SHAs. All git via
   flox (LFS hang rule). Document the `submodule update --init` step in the worktree
   runbook.
7. **Version the Edge scripts** (Q2 reshaped): `tools/edge-browser/`, secrets-gated on
   the way in.
8. **Duplication convention (owner Q4b):** browser twins (`es9-protocol.ts`,
   `vst-protocol.ts`) deliberately COPY wire constants. **Recommend KEEP** (web CI has
   no Swift toolchain; submodule-pin drift must never break the web build). Non-gating
   `task helpers:protocol-diff` parity report (report, don't gate).
9. **CI stance:** web CI does NOT clone or build the submodules. Only desktop packaging
   tasks build them, on macOS. No CI workflow changes without owner sign-off.
10. **Not submodule candidates:** `../patchtogether.native` (3.3G, LFS'd .app bundles,
    pre-Electron rejected direction) — disposition owner Q14. `../standalone.native`
    **does not exist on disk** (verified) — stale reference in the tasking.

---

## 5. Build pipeline

- `apps/desktop` (spec Q8): Electron main + preload in TS, own package.json, workspace
  conventions. **Harness deps (Playwright `_electron`, electron) live HERE or at root —
  NEVER in `e2e/package.json`, which is a webgl-attest TOOLCHAIN PIN: any dep added
  there moves the content hash and demands a real-GPU re-attest** (review F8;
  `scripts/webgl-attest-lib.ts`, documented at `mock-vst-bridge.ts:26-33`).
- **electron-builder**, macOS `dmg` + `zip`, **pinned Electron version** (the pin IS
  the point; #2270 class). Every pin bump re-checks the MidiMacUmp/SysEx exposure (§0)
  and re-runs the opener→popup [verify].
- Pipeline: `task desktop:web-build` (static client; `VITE_E2E_HOOKS=1` baked only into
  the TEST build) → `task helpers:build` (**swift build -c release in both submodules
  AND `make -C tools/pt-ptz`** — review A3) → `task desktop:build` (electron-builder
  packages web build + helper binaries into `Contents/Resources`; **includes TCC usage
  strings for camera/mic/audio-input** — review B4, moved out of P7) →
  `task desktop:dist` (Developer ID sign + notarize + hardened runtime — owner-gated,
  Q10).
- Interim: unsigned local builds for the owner's machine (quarantine xattr removal in
  the runbook; TCC re-grants per rebuild — §1.4 note).
- Taskfile targets: `desktop:dev`, `desktop:web-build`, `helpers:build`,
  `desktop:build`, `desktop:e2e`, `desktop:e2e:one -- <spec>`, `helpers:protocol-diff`.
  All through `flox activate -- task …`.

---

## 6. Phased delivery with per-phase verification

Phases extend the spec's 0–4 spine; P-numbers are this plan's. **Changes from v1:**
harness bring-up is its own early phase (PH) so the continuity instrument exists BEFORE
any phase claims continuity (review D2); P6 splits into P6a (off-branch, parallelizable)
and P6b (post-S4) per review C4; the build ORDER is §8's, not the P-number order.

| phase | content | verification (existing lanes; nothing gates without owner sign-off) |
|---|---|---|
| **P0 — repo hygiene + helper integration** (§4) | backup, remotes, gitignore/LICENSE, initial commits, secrets gate WITH written record, submodule adds, Edge-script vendoring, pt-ptz make target, protocol-diff task | fresh clone + `task setup` unaffected on Linux CI; `task helpers:build` produces all THREE binaries on macOS; gate record exists in `.myrobots/` |
| **P2 — minimal shell** (spec Phase 1) | `apps/desktop` main + preload `ptNative` + simulated double; loopback server + COOP/COEP + SPA fallback; full flag/handler set incl. MidiMacUmp + setDisplayMediaRequestHandler; TCC usage strings in packaging; menus; single fullscreen window; statechange auto-resume + AudioGate suppression (row 14); **opener→popup DOM-access spike on the pinned Electron (review D3 — one hour, first thing; the single-display DOM-access half PASSed 2026-09-03 (p2-notes.md), and the full dual-monitor harness now ships as `task desktop:spike`)** | manual boot on owner's machine; PH harness (below) then pins: `/rack` paints, AudioContext `running` with zero gestures, zero prompts, zero pageerrors; spike result recorded — the record is one owner run of `task desktop:spike` on the dual-monitor rig, filled into apps/desktop/SPIKE-OPENER-DISPLAY.md; if opener DOM access or the cross-display blit fails there, P4 re-plans BEFORE more shell work |
| **PH — shell e2e harness bring-up** (§7) — own early phase | Tier A runner (unpackaged `electron .` under Xvfb via dispatch job — owner Q9), fake-device config incl. 4-camera count, WebMIDI mock seam, protocol-faithful Node stub helpers, **the worklet RMS/underrun accumulator instrument + its positive controls**, boot-determinism spec family | instrument's positive controls pass: hook-forced teardown reddens it AND a forced main-thread stall does NOT blind it; boot spec: 8 slots present (once P1 lands), zero prompts/pageerrors; `REPEAT=3` |
| **P3 — helper supervision** (§1.3) | bundle + spawn + supervise es9/vst/pt-ptz; injectable binary resolution; status surface | harness: SIGKILL stub helper → `running→restarting→running` observed → client reattached (vst clientId; es9 grace takeover) → audio/MIDI path re-verified. Waits = observable state, never ms |
| **P1 — device-slot layer, web-only** (spec Phase 0; §2 + rows 1–4, 7, 16) | slot defs + faces + fixed ids; pinned+undeletable+duplicate guards; ensureSlots (untracked origin, observer re-assert); factory retry; envelope merge + slot-id type guard; bindings → local store; slot-keyed sessions (camera, audio-in, ES-9 socket); name-rebind completion; in-place New rack | unit: merge-not-clear, type-guard drop/coerce, Clear/undo/peer-Clear survival, binding-strip migration, rebind resolver, duplicate guard; web e2e (fake devices): bind cam slot → load DIFFERENT patch → save (ALL save families) → stream token identity unchanged AND frame counter advanced; ES-9 sim double: zero re-dials. `REPEAT=3`; pageerror guard; FULL unit suite if CV ports; contract-lock + EXPECTED_NODE_TYPES + inventory accept; dedicated fixture/VRT/cost-artifact re-pin pass (BOTH e2e-timings + vrt-strict-timings; never accept while shards pend) |
| **P4 — outputs + display map** (spec Phase 2; rows 5, 11, 15) | `setWindowOpenHandler` present integration — GATED on a recorded PASS from `task desktop:spike` on the owner's dual-monitor rig (apps/desktop/SPIKE-OPENER-DISPLAY.md; a domAccess/blitPixels/motion FAIL there means re-plan to main-owned BrowserWindows + a push transport FIRST); output1..4 ↔ display map; loopback capture continuity; hotplug re-place/re-fullscreen (placement logic only — real hotplug is untested at every tier, admitted); kiosk polish | harness: present live → load patch → SAME BrowserWindow ids, blit frame counter advances in the DRIVING window; display-map placement unit-tested against mocked `screen`; loopback capture survives a load with zero pickers; owner preview for visible changes |
| **P5 — pre-flight UI** (spec Phase 3) | shell-native panel: per-slot camera pickers, display assignment, ES-9 config (push-policy caller = Q11), VST/PTZ status, MIDI/gamepad presence; persistence | bindings survive relaunch; unbind/rebind while a patch plays never tears sessions (harness); USB/serial flow exercised with simulated doubles |
| **P6a — off-branch continuity hardening** (rows 6, 9, 10, 11) — ⛔ **HELD, NOT parallelizable.** The "parallelizable NOW" reading (review C4) is retired: owner answer 7 says "P6 strictly after S4" and OWNER GO adds "P6a HELD until cliprec slice 6 lands", then one builder for P6a + the cliprec video tie-in. BOTH gates must clear | REAL save paths off-main (portable/state-only rebuild + performance zipSync → worker); recorderbox OffscreenCanvas worker capture (owner preview); take-finalize verification | harness: mid-performance recorderbox Save → worklet min-RMS never below floor for the WHOLE workflow, every save family; positive control stays red-capable |
| **P6b — sweep/registry continuity hardening** — strictly after legacy-removal S4 | the sweep/registry-adjacent remainder; row-3 re-verification under the instrument; contract audit pass over §3.1 | full continuity matrix (build-brief §5) green at Tier A; Tier B smoke if lane exists |
| **P7 — distribution** (spec Phase 4; owner-gated) | Developer ID signing/notarization, DMG, release lane | owner sign-off twice: Apple accounts (Q10) and any release-lane CI change |

DOOM is excluded by name from every phase (owner Q8; nothing proceeds without approval).

---

## 7. Test strategy — the shell e2e harness

Standing rulings apply: **no new gates or kinds of tests without discussion**
(2026-08-25) and **no fundamental CI changes** (2026-08-23).

**⚠ RESOLVED by owner answer 3 (2026-09-03): the lane GATES, kept LIGHT.** The
earlier resolution here — "local + optional NON-REQUIRED `workflow_dispatch` job;
promotion to a required lane is owner Q9" — is RETIRED. Q9 is answered. The lane
ships in two tiers, and **`build-brief.md` §4.1 is the normative specification** of
the split, the re-derived pricing, and the exact `ci.yml` edit chain (three edits
together — `needs:`, aggregate `env:`, failing `if` — enforced by
`scripts/ci-umbrella-parity.test.ts`). Summary:

- **REQUIRED subset** (`desktop-e2e` in `ci.yml`, inside the `ci` umbrella): boot
  determinism only — boots, `/rack` paints, AudioContext `running` gesture-free,
  zero pageerrors/extra windows. **Already shipped as a local task**
  (`task desktop:e2e`, `apps/desktop/e2e/boot.spec.ts:1-16`); only the CI job
  remains. Owner answer 3 IS the authorization to touch the umbrella's `needs:`
  list — cite §4.1's chain in the PR or a reviewer will correctly refuse.
- **NON-REQUIRED dispatch tier**: everything timing-shaped — the RMS instrument,
  supervision/SIGKILL, the continuity matrix, crossfade assertions. A required
  check has an effective retry budget of ZERO under the no-flake-tolerance regime,
  so timing-shaped work may not enter the required subset.

**Wall-time (re-derived; the ~30–35 min figure is RETIRED for the required tier).**
That number priced a STANDALONE workflow re-paying full setup, on the premise that
"the ci.yml e2e-preview artifact is not reusable across workflows without new
plumbing". A job inside `ci.yml` dissolves that premise: it uses the same
`needs: [dsp-build, build-web]` artifact-download pattern as every other required
job. Required subset ≈ **6–9 min wall** (artifact download ~1 min + standalone
`desktop:install` and a CACHED Electron binary ~1–2 min + a single boot spec, no
`REPEAT`, ~2–4 min). Measure before claiming an umbrella delta — as an added
parallel job it only extends the critical path if it exceeds the current longest
need. **Dispatch tier** keeps the ~30–35 min figure. Tier B macOS: ~20–30 min at
~10× Linux billing, owner-gated.

### 7.1 Harness — two tiers, honestly scoped (reviews F1–F3, F6)

- **Driver:** Playwright `_electron.launch()` (`@playwright/test` ^1.50 supports it —
  verified). Deps in `apps/desktop`, never `e2e/package.json` (F8, §5).
- **Tier A — Linux VM (ubuntu-latest + xvfb-run wrapper; NO container — the repo runs
  none and the first draft's container framing is Appendix A.5).** Subject:
  **unpackaged `electron .`** with the test web build — explicitly a DIFFERENT artifact
  from the shipped macOS bundle (no asar, no Contents/Resources, no packaged menus/TCC
  — Appendix A.6). What Tier A really covers: main/preload/renderer logic, supervisor
  state machine via injected stub paths, slot/continuity semantics, window identity.
  What it structurally cannot see is listed in §7.3 and covered by Tier B + manual.
  - Helpers: **protocol-faithful Node stubs** (es9 v1 + vst wire; constants in-tree in
    `es9-protocol.ts`/`vst-protocol.ts`; the `mock-vst-bridge.ts` pattern — real
    WebSocket, in-tree codecs — is the verified precedent), launched through the SAME
    supervisor state machine with injected binary paths.
  - Cameras: `--use-fake-device-for-media-stream` **with the device-count config set
    to 4** + `--use-file-for-fake-video-capture=<file>.y4m`; the 4-camera assertion
    binds 4 distinct fake devices simultaneously (review F7 — one fake camera was the
    silent default). `NotReadableError` contention stays untestable with fakes:
    Tier B/manual.
  - MIDI: the in-page `navigator.requestMIDIAccess` mock (`e2e/_helpers/midi.ts` —
    the repo's entire MIDI e2e precedent) + `ptNative`/device-layer simulated doubles.
    **The snd-virmidi plank is DROPPED** (kernel module; impossible in a container,
    new CI provisioning on a VM — Appendix A.7). Real CoreMIDI lives in Tier B only.
  - Audio: null output device; clause (a) asserted by the **worklet-resident min-RMS/
    underrun accumulator at the master tap** (gapless; survives main-thread stalls) +
    audio-clock-vs-wall-clock progress. AnalyserNode polling is demoted to
    threshold-crossing assertions only (its proven green class). Trigger detection
    stays on `createEdgeCounter` (worklet consumers exempt per boundary 7).
  - Displays: Xvfb sized for 4 output windows (identity + blit assertions); physical
    placement logic unit-tested against mocked `screen` metadata.
- **Tier B — macOS runner (small, owner-gated cost).** Real Swift bridges with es9
  `SyntheticEngine` (hardware-free by design; **42** `func test`s exist there — count
  corrected, review), real CoreMIDI virtual ports + **SysEx round-trip (the MidiMacUmp
  canary)**, packaged-.app smoke: boot → pre-flight → rack → audio → quit clean.
  **[verify] (review F6, unproven):** GH macOS runners have no cameras and no audio
  output device; that AudioContext reaches `running` with zero CoreAudio output
  devices is NOT demonstrated anywhere — probe first; fallback is asserting up to
  context creation + graph topology, with audio-running left to owner-machine smoke.

### 7.2 Assertion families

1. **Continuity:** bind 4 fake cameras + mock MIDI + stub ES-9 → load patch A → play →
   load patch B → save (each save family) → assert: camera stream ids unchanged AND
   frame counters advanced; MIDI round-trip live; ES-9 stub reports the SAME connection
   (zero re-dials); output windows keep ids; loopback capture uninterrupted; zero
   prompts/pickers.
2. **Output floor:** tone patch → recorderbox record → Save mid-performance → worklet
   min-RMS at the master tap never below floor across the entire workflow.
   **Positive controls (plural — review F4):** (i) hook-forced teardown reddens it;
   (ii) a forced main-thread stall must NOT blind it (the accumulator is
   audio-thread-side — prove it); a green whose instrument can't see the failure is
   vacuous.
3. **Supervision:** SIGKILL stub helper → observed status transitions → reattach →
   path re-verified. Observable-state waits only.
4. **Boot determinism:** cold boot → 8 slots present, unbound slots dark, bindings
   applied, AudioContext running, zero pageerrors, zero prompts.
5. **Interruption sweep (new — reviews M1/M3/M4):** Clear, undo/redo, peer-Clear over
   sync, File → New rack, forced `render-process-gone`, simulated `statechange:
   suspended` — slots re-asserted, sessions alive, auto-resume fires, no overlay.

### 7.3 Structurally unseen at every tier (admitted, per boundary 4 — review F9)

Signed/hardened-runtime behavior (TCC prompts, entitlement mistakes — only a signed
build on a real Mac); Gatekeeper/notarization (never executed by any tier); real
USB/serial hotplug (Push 2 WebUSB — simulated doubles only); real display hotplug
(no test at any tier; Xvfb is one virtual display); real ES-9 hardware (hw-verify
outstanding); device-callback audio continuity (§3 scope reduction); fake-device
`NotReadableError` contention. Mitigation: owner-machine smoke checklist runs at EVERY
phase boundary (build-brief §7), not just P7.

Flake policy: `REPEAT=3` on every new/changed spec; no flake tolerance; root-cause or
park with the owner. Local Playwright teardown mandatory (no leaked
chrome-headless-shell).

---

## 8. Sequencing vs legacy removal — recommendation: STAGED PARALLEL (revised)

- **Start now, in parallel:** P0, P2, PH, P3, and **P6a** (review C4: persistence
  makeEnvelope + recorderbox capture/save files are absent from the legacy-removal
  inventory — serializing them behind a ~4-week branch was unforced). Measured overlap
  with the removal branch = `Taskfile.yml` ONLY (review C1) — coordinate that one file.
- **P1 (device slots): product seams wait for legacy-removal S1** (the slot layer
  builds ON the S1 node-keyed extractions — which are FUTURE work, review D4). Its
  **fixture/VRT/cost-artifact churn lands either BEFORE S2 begins or AFTER S4 — never
  mid-inversion** (review C2): 8 always-present nodes change every boot for 295
  `seed=none` specs + the `rack` fixture's 243 importers while S2 rewrites ~412 of the
  same specs; landing mid-inversion moves S2's target under it. Also colliding if
  mistimed: `modules-card-map.test.ts` EXPECTED_NODE_TYPES (S4 deletes it),
  `face:inventory:accept` (S4 retires the machinery), the strict-faces roster + the
  371-baseline VRT tier (vrt-strict at its 12-shard cap), and BOTH cost artifacts (the
  exact shared-generated-file class rule 6 exists for). If the owner approves plan-v2
  Q10 (S1 lands as ordinary main PRs first), P1 product code can start within days —
  with the fixture pass windowed separately.
- **P4 after P1 + the fixture window.** The present spec family is TWO files (review
  C3 — the "inside the ~412-spec inversion" justification was false); the wait is for
  fixture stability and the P2 opener-spike result, not spec-count economics.
  Interrupter 5 (projector blink) is owner-visible goal-3 value — do not let it drift.
- **P6b strictly after S4** — the genuinely sweep/registry-adjacent remainder only.
- **⚠ P6a is HELD, and the "zero overlap" premise it rested on is stale.** Owner
  answer 7 ("P6 strictly after S4") plus OWNER GO ("P6a HELD until cliprec slice 6
  lands") both apply. Review C4 measured P6a's overlap against the
  legacy-removal inventory ONLY — the cliprec program
  (`.myrobots/2026-09-02-mixmstrs-multitrack-clip-recording/`) has since been
  landing on the very recorderbox capture/OPFS seams P6a rewrites, so P6a is not
  overlap-free even against a hypothetical owner release. When both gates clear,
  P6a and the cliprec video tie-in run under ONE builder.
- Why not fully-after: zero-overlap work idling behind a ~4-week branch. Why not
  fully-parallel: P1/P6b target S1–S4's seams — guaranteed conflict at 84
  main-commits/week; never `gh pr update-branch` on shared generated files. Agent
  budget (me + two, ≤3 open PRs) caps parallelism anyway.

---

## 9. Open owner questions

1. **Remotes** for es9 + nativeapps: org, visibility. Approve the immediate es9 backup
   + push (it exists on ONE machine).
2. **REVISED (review A3):** pt-ptz is in-tree C (`tools/pt-ptz/`, tracked) and the Edge
   scripts are unversioned at `../scratch/`. Approve: keep pt-ptz vendored + add it to
   `helpers:build`; vendor the Edge scripts at `tools/edge-browser/` (secrets-gated)
   while the browser path lives.
3. **LICENSE** for both helper repos (neither has one).
4. **Integration shape:** submodules at `apps/helpers/*` per the directive — OR
   in-tree vendoring, for which `tools/pt-ptz/` is the working precedent and which
   avoids worktree/`.gitmodules` friction with zero code-sharing cost (review A4).
   Plus the protocol-duplication convention (rec: keep copies; non-gating parity
   report).
5. **Slots across the board** (rec: yes) vs native-only; **fixed 4+4** (rec) vs
   configurable. (Spec Q2/Q3.)
6. **Electron confirmed** (rec: yes, no modified Chromium — with the MidiMacUmp flag
   and a <152-exposure check at every pin bump) and **bundled build vs URL** (rec:
   bundled).
7. **Collab in native v1** — in or out. If IN, the relay re-auth failure path (row 17)
   must be fixed first; today it navigates the rig away mid-performance.
8. **DOOM continuity:** the load sweep kills a DOOM session today; fixing it means
   touching DOOM. Approve a DOOM-continuity item, or it stays excluded by name.
9. ✅ **ANSWERED (answer 3) — Shell e2e lane GATES, kept LIGHT.** Not "decide later
   whether it ever gates": it gates now, scoped to boot + expected content, with
   everything timing-shaped in a non-required dispatch tier. The ~30–35 min figure
   applies to the dispatch tier only; the required subset re-prices to ≈6–9 min.
   Normative spec: `build-brief.md` §4.1. Tier B ~20–30 min at ~10× billing
   remains open (owner-gated).
10. **Signing/notarization:** Apple Developer ID enrollment, entitlements,
    distribution channel. (TCC usage strings are NOT gated on this — they ship with
    packaging in P2, review B4.)
11. **ES-9 output-mode push policy** caller in the pre-flight panel? hw-verify
    outstanding (stuck-note incident).
12. **Quit placement:** literal File ▸ Quit vs conventional macOS app-menu Quit.
13. ✅ **ANSWERED (answer 7 + OWNER GO) — staged-parallel APPROVED, but P6a is
    HELD, not "starting now."** Binding text: "P0/P2/P3+harness now; P1 after
    legacy S1 reaches main; P4 after the S2 fixture flip; P6 strictly after S4",
    plus "P6a HELD until cliprec slice 6 lands; then P6a + the cliprec video
    tie-in run under ONE builder." The P1 fixture-churn window is approved as
    stated (before S2 or after S4 — in practice only after-S4 remains).
14. **`../patchtogether.native` disposition** (park/archive vs long-horizon);
    `../standalone.native` confirmed absent from disk.
15. ✅ **ANSWERED (answer 6) — "Patch swap: CLICK-FREE CROSSFADE."** It is in the
    contract and MANDATORY; the hard cut is a defect. **A follow-up decision is
    still needed** — the four words do not choose between true overlap-crossfade
    (old graph keeps rendering while the new one builds) and fade-out → build →
    fade-in (click-free but briefly quiet). The cost gap is roughly an order of
    magnitude and the ES-9 single-client socket constrains one of them. Options,
    costs and the recommendation-free write-up: [crossfade-options.md](crossfade-options.md).
16. **Owner previews:** recorderbox worker capture + any visible present change
    (standing look-changes ruling) — confirming the checkpoint.
17. **NEW (review B1): envelope forward-compat.** Approve a version-floor field so
    future web builds refuse-don't-amputate envelopes newer than they understand
    (today an older build silently drops unknown node types + edges and a re-save
    persists the loss). Ordering (P1-to-prod before shell saves exist) is the primary
    defense either way.

---

## Appendix A — discarded items (refuted or speculative), one line each

1. **"A renderer crash costs a reload, not a rig teardown" (v1 §1.3)** — audio,
   cameras, MIDI, and screen capture are renderer-owned; a reload IS an output
   teardown (review M4).
2. **"Save = `makeEnvelope`, one short main-thread step" (v1 §3.1 row 9)** — the
   shipping paths are makePortable/StateOnly + synchronous `zipSync`, several× heavier
   and a different fix surface (review M6).
3. **"Registry `undeletable` protects slot presence" (v1 §2.1)** — Clear consults
   `data.pinned` only, a disjoint mechanism; and `duplicate()` checks neither (reviews
   M3, B3).
4. **"Fixed port so the bridges' Origin allowlists stay stable" (v1 §1.2)** — both
   default policies check host only; any loopback port passes (review B3; [verify]
   settled).
5. **"Tier A — Linux container" (v1 §7.1)** — this repo's CI runs zero containers, and
   a container makes the same section's virtual-MIDI plank impossible (review F3).
6. **"Tier A drives the ACTUAL packaged test build" (v1 §7.1)** — a macOS bundle does
   not execute on ubuntu-latest; Tier A runs unpackaged, a different artifact, and the
   plan now says so (review F1).
7. **ALSA `snd-virmidi` virtual-MIDI plank (v1 §7.1)** — kernel module: impossible in
   a container, new CI provisioning on a VM under the no-CI-changes ruling; the
   repo's WebMIDI mock is the precedent (review F3).
8. **"Shell/main/preload/web logic is byte-identical across platforms" as a coverage
   argument (v1 §7.1)** — the JS is; the behavior is not (spawn paths, menus,
   TCC-adjacent handlers never execute on Linux) (review F2).
9. **"35 SyntheticEngine tests" (v1 §7.1)** — 42; count stale, direction correct.
10. **"No PTZ helper and no Edge helper scripts exist" (v1 §4 / owner Q2 premise)** —
    pt-ptz is tracked in-tree at `tools/pt-ptz/`; the Edge scripts exist at
    `../scratch/` (review A3).
11. **"The secrets-gate record is survey 2" (v1 §4.5)** — no such file exists under
    `.myrobots/`; the record is created at execution time instead (review A2).
12. **"The present spec family is inside the ~412-spec inversion" as the P4-wait
    justification (v1 §8)** — the family is two spec files; the real wait is fixture
    stability + the opener spike (review C3).
13. **"P6 strictly AFTER S4" as a whole (v1 §8)** — interrupters 6/9/10/11 live in
    files absent from the removal inventory; only the sweep/registry remainder waits
    (review C4; hence the P6a/P6b split).
14. **"Registries ALREADY made card-independent by S1" (v1 §1.1, present tense)** —
    S1 has not happened; producers are still card-mounted today (review D4).
15. **"Priced like the trails PR" (v1 §2.1)** — wrong comparable: one optional module
    vs 8 always-present nodes in every boot/fixture/VRT scene (review C2).
16. **Speculative, not carried:** slot double-instantiation from saved patches — the
    attack itself failed (deterministic ids converge under CRDT; single
    `loadEnvelopeIntoStore` seam) (review B4).
