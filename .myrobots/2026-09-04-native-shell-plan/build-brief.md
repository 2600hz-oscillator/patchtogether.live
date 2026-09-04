# Native shell — build brief

**Date:** 2026-09-04. Self-contained brief for the build crew. Source of truth for
design rationale: `plan.md` in this directory (v2, adversarial reviews folded) and
`.myrobots/2026-08-31-native-shell-spec.md`. This brief is EVIDENCE per AGENTS.md —
owner-gated items are marked and nothing here self-authorizes them.

> ## ⚠ READ THIS BEFORE EDITING — document contract
>
> 1. **Owner answers are NORMATIVE.** The `OWNER ANSWERS 2026-09-03` and
>    `OWNER GO 2026-09-03` sections at the foot of this file outrank every other
>    line in this package. Where prose and an owner answer disagree, the answer
>    wins and the prose is the bug.
> 2. **Body reconciled against those answers on 2026-09-04.** Answers 3, 6 and 7
>    are now folded into the phase table, §2, §5, §6 and §7 — not merely appended.
> 3. **The [interruption matrix](interruption-matrix.md) is the architectural
>    source of truth** (owner ruling — `.myrobots/2026-09-04-desktop-review-APPROVED.md`).
>    §5 below is its summary view. No phase is "done" until its matrix row is
>    filled in and its **receiver-side instrument exists**. No phase may claim a
>    continuity result its instrument cannot see.
> 4. **FOLD, NEVER APPEND.** When the owner answers a question, edit the BODY at
>    the lines that answer contradicts, in the same commit. Do not add a third
>    layer of appendices. This package has already failed exactly that way: the
>    2026-09-03 answers were appended, `second-review.md` caught the resulting
>    contradictions the same day and scored four answers "NOT integrated", and
>    they were re-discovered a day later still unfixed. An appendix that
>    contradicts the body is worse than no appendix.
> 5. **One binding section only.** §6 is sequencing NARRATIVE; the owner answers
>    are the binding sequencing authority.

---

## 0. Owner constraints — verbatim, non-negotiable

Owner directive (verbatim goals, 2026-08-31):

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

Standing rulings that bind every phase:

- **NEVER touch DOOM** (code, specs, waits, budgets, ledger, sweeps) without explicit
  owner approval; exclude it by name from sweeps and say why.
- **No new gates or kinds of tests without owner discussion** (2026-08-25) —
  **DISCHARGED for this lane by owner answer 3: the shell e2e lane GATES, kept
  LIGHT.** It ships in two tiers (§4.1): a REQUIRED boot-determinism subset
  ("proves the harness boots and loads expected content; nothing more in the
  required path") and a NON-REQUIRED dispatch tier for everything
  timing-shaped. Nothing beyond that split is authorized.
- **No fundamental CI changes** (2026-08-23) — **the required-subset job in
  `ci.yml` is AUTHORIZED by owner answer 3; see §4.1 for the exact edit chain.**
  Record that chain in any PR that touches `ci.yml`, or a reviewing agent will
  correctly refuse the change. CI wall-time deltas >2 min still need sign-off:
  price the required subset from §4.1's re-derivation, not from the retired
  ~30–35 min standalone-workflow figure.
- **Nobody opens GitHub issues** (2026-08-22). Fix coherent defects in the current PR;
  otherwise report to the owner.
- Every command through Flox: `flox activate -- <cmd>`; git NEVER outside flox.
- Agent budget: me + two, ≤3 open PRs (re-check the latest owner message).
- Merge only when THIS PR's exact final commit is green; red `main` is P0; no flake
  tolerance — root-cause or park with the owner; `REPEAT=3` on new/changed tests.
- Renderer-dependent readiness = frames or observable state, never ms delays
  (DOOM exempt-by-exclusion).
- Main-thread trigger detection via `createEdgeCounter` only; worklet per-sample
  compare exempt by construction.
- Look changes (present/recorderbox/faces): owner preview before merge.
- Functional parity is a hard requirement; never surface "we would lose X".

---

## 1. Phase order (build order, not P-number order)

| order | phase | size | starts when |
|---|---|---|---|
| 1 | **P0** repo hygiene + helper integration | S (~2–4 d) | now (step 1, the es9 backup, immediately; pushes gated on owner Q1) |
| 2 | **P2** minimal shell | M (~1 wk) | now, parallel with P0 |
| 3 | **PH** shell e2e harness bring-up | M (~1 wk) | as soon as P2 boots |
| 4 | **P3** helper supervision | M (~1 wk) | after PH skeleton exists |
| 5 | **P6a** off-branch continuity hardening | M (~1 wk) | ⛔ **HELD — do NOT start.** Owner answer 7 ("P6 strictly after S4") + OWNER GO ("P6a HELD until cliprec slice 6 lands"). Both gates must clear; then P6a and the cliprec video tie-in run under ONE builder |
| 6 | **P1** device-slot layer (web-only) | L (~2 wk) | product seams after legacy-removal S1; fixture churn in the §6 window |
| 7 | **P4** outputs + display map | M (~1–1.5 wk) | after P1 + P2 opener-spike result |
| 8 | **P5** pre-flight UI | M (~1 wk) | after P4 |
| 9 | **P6b** sweep/registry continuity remainder | S (~2–3 d) | after legacy-removal S4 |
| 10 | **P7** distribution | S (owner-gated) | owner Q10 |

---

## 2. Phase tasks, verification, definition of done

Conventions: all commands run as `flox activate -- task <target>`; abbreviated below
to `task <target>`. New/changed specs get `REPEAT=3`. Every face/fixture-touching PR:
`GREP=<module> task vrt:one`, and re-pin BOTH `e2e/e2e-timings.generated.json` +
`e2e/vrt-strict-timings.generated.json` — never accept while shards pend.

### P0 — repo hygiene + helper integration

Tasks:
1. `git bundle` backup of `../patchtogether.es9` to a second location. FIRST, before
   anything else — it is the only repo with commits and no remote.
2. [owner Q1] remotes created → es9: add repo-local `.gitignore` for
   `.claude/settings.local.json` + `.myrobots/`; LICENSE [owner Q3]; commit; push.
3. nativeapps: initial commit of the clean tree; same ignores; LICENSE; push.
4. Run the secrets gate (§3) per repo immediately before each push; write the record.
5. [owner Q4] add submodules at `apps/helpers/es9-bridge` + `apps/helpers/vst-bridge`
   (or vendor in-tree if the owner picks the A4 alternative), pinned SHAs. Document
   `git submodule update --init` in the worktree runbook.
6. `helpers:build` Taskfile target = swift build -c release in both bridge dirs AND
   `make -C tools/pt-ptz` (pt-ptz is in-tree C — NOT a submodule, NOT Swift).
7. [owner Q2] vendor `../scratch/start_edge.sh` + `edge_defaults.sh` into
   `tools/edge-browser/`, secrets-gated on the way in.
8. `helpers:protocol-diff` non-gating parity report (browser protocol twins
   `es9-protocol.ts`/`vst-protocol.ts` stay deliberate COPIES).

Verification:
- macOS: `task helpers:build` → three binaries (es9-bridge, vst-bridge, pt-ptz).
- Linux/CI: fresh clone + `task setup` + `task test` unaffected (submodules not
  cloned by web CI; zero workflow-file changes).
- Gate records exist in `.myrobots/`.

DoD: both repos pushed with clean audited history; submodules pinned; all three
helpers build from one target; Edge scripts versioned; web CI provably untouched.

### P2 — minimal shell

Tasks:
1. `apps/desktop`: Electron main + preload (TS). `window.ptNative` contract:
   `nativeAvailable()`, `loadPatchRequested` event, `presentTargets()`,
   `slotBindings` get/subscribe, `helperStatus` subscribe, `quit()` — plus a
   simulated double for browser/e2e. Web code never imports Electron.
2. Loopback HTTP server: static web build, `COOP: same-origin` +
   `COEP: credentialless`, SPA fallback for `/rack`, fixed documented port,
   `BETA_GATE_PASS` unset.
3. Flag/handler set: `backgroundThrottling:false`, autoplay no-gesture, permission
   auto-grant, kiosk windows, powerSaveBlocker, USB/serial device handlers,
   **`--disable-features=MidiMacUmp`** (SysEx dies on Chromium ≥152 without it —
   check exposure at every Electron pin bump), **`setDisplayMediaRequestHandler`**
   (without it `getDisplayMedia` fails outright in Electron and loopback dies).
4. electron-builder packaging with **TCC usage strings for camera/mic/audio-input in
   Info.plist NOW** (unsigned interim builds crash on first getUserMedia without
   them; signing stays P7). Runbook: quarantine xattr removal; TCC re-grants per
   unsigned rebuild (binary identity changes).
5. Native menus (app ▸ Quit [owner Q12], File ▸ Load Patch…); single fullscreen window.
6. Web change (small): `statechange → suspended → auto-resume` on the AudioContext;
   suppress the `AudioGate` full-screen overlay under `nativeAvailable()` (status row
   instead; overlay only after repeated resume failure).
7. **HOUR-ONE SPIKE:** on the pinned Electron, verify same-origin opener→popup DOM
   access under `setWindowOpenHandler` (the entire P4 blit design rests on it; the
   captureStream fallback rendered BLACK on real dual-monitor hardware). Record the
   result in `.myrobots/`. If it fails: STOP, re-plan P4 before more shell work.

Verification:
- `task desktop:dev` boots against the flox dev server; `task desktop:build` produces
  a runnable unsigned .app.
- Manual owner-machine smoke (§7 checklist): `/rack` paints; AudioContext `running`
  with ZERO gestures; zero permission prompts; zero pageerrors; SysEx device
  round-trips (Electra/PTZ if attached).
- `task typecheck` for all TS.

DoD: shell boots the real web build offline; full flag set applied; spike result
recorded; ptNative double in place; TCC strings in the bundle.

### PH — shell e2e harness bring-up (own early phase — the instrument comes first)

Tasks:
1. Playwright `_electron.launch()` harness in `apps/desktop` (deps THERE or at root —
   **NEVER in `e2e/package.json`**, which is a webgl-attest TOOLCHAIN PIN; touching it
   forces a real-GPU re-attest).
2. Tier A subject = **unpackaged `electron .`** + test web build
   (`VITE_E2E_HOOKS=1` baked at build). State in the spec header that this is NOT the
   shipped artifact; packaged seams are Tier B/manual.
3. Runner: ubuntu-latest + `xvfb-run`, in TWO tiers per owner answer 3 (§4.1):
   a **REQUIRED** `desktop-e2e` job in `ci.yml` running the boot-determinism
   subset ONLY, and a **NON-REQUIRED** `workflow_dispatch` job for the
   timing-shaped remainder. Cache the Electron binary in the required job — a
   network fetch inside a required check is a standing flake source.
   [Local `task desktop:e2e` needs no approval and already ships.]
4. Fake devices: `--use-fake-device-for-media-stream` with device-count=4 +
   `--use-file-for-fake-video-capture=<file>.y4m`; assert 4 DISTINCT simultaneously
   bound cameras. MIDI via the in-page `requestMIDIAccess` mock
   (`e2e/_helpers/midi.ts` pattern) + ptNative doubles. No snd-virmidi, no container.
5. Protocol-faithful Node stub helpers (es9 v1, vst wire — reuse the
   `mock-vst-bridge.ts` pattern: real WebSocket + in-tree codec constants), launched
   through the SAME supervisor state machine via injected binary paths.
6. **The instrument:** an AudioWorklet-resident min-RMS/underrun accumulator at the
   master tap + audio-clock-vs-wall-clock progress check, exposed as an e2e hook.
   AnalyserNode polling only for threshold-crossing assertions, never "never-dips".
7. **Positive controls, both required green-to-red:** (i) hook-forced graph teardown
   reddens the floor assertion; (ii) a forced main-thread stall (synchronous busy
   loop during save) does NOT blind the accumulator — prove the instrument sees the
   stall window.
8. Boot-determinism spec family (assertion family 4) + pageerror guard in every spec.
9. Teardown discipline: no leaked chrome-headless-shell/electron processes.

Verification:
- `task desktop:e2e` local green; `REPEAT=3` on each new spec.
- Both positive controls demonstrably red on broken builds (commit the forced-failure
  hooks behind env flags, not as skipped tests).
- Wall-time measured and recorded for BOTH tiers separately (§4.1): the required
  subset against its ~6–9 min re-derived budget, the dispatch tier against the
  ~30–35 min figure. The >2 min sign-off applies to the REQUIRED number only.

DoD: harness boots the shell, instrument armed with proven positive controls, boot
family green ×3; required subset landed under §4.1's edit chain with a measured
number; dispatch tier proposed with its own.

### P3 — helper supervision

Tasks:
1. Supervisor per helper (es9-bridge, vst-bridge, pt-ptz): `stopped → starting →
   running → restarting(backoff+jitter) → crash-looped`. Health = process alive AND
   hello accepted (pt-ptz: virtual CoreMIDI ports exist — macOS; stubbed on Linux).
2. Binary resolution injectable: packaged = `Contents/Resources/helpers/`; tests
   inject stub paths through the same state machine.
3. Crash-loop → red status row (NEVER a modal — no modals while presenting).
4. `render-process-gone` → reload window; helpers untouched; bindings re-apply on
   boot. ⚠ **The fate of OUTPUT windows on renderer death is PENDING** — a
   same-origin `window.open` popup is renderer-parented and dies with the crashed
   process, so "windows untouched" cannot be asserted as written. Do not write a
   crash spec against this line until the matrix's `renderer crash` row is
   resolved; see [interruption-matrix.md](interruption-matrix.md#renderer-crash).

Verification (harness):
- SIGKILL stub helper → observed `running→restarting→running` → client reattach (vst
  `hello.clientId`; es9 grace takeover) → audio/MIDI path re-verified. All waits are
  observable-state; zero ms sleeps.
- `task desktop:e2e:one -- supervision` + `REPEAT=3`.
- macOS manual: kill the REAL es9-bridge process; same recovery.

DoD: supervision spec family green ×3 on stubs; manual real-binary recovery observed
once on macOS; status rows live.

### P6a — off-branch continuity hardening (⛔ HELD — not a parallel track)

**Do not start this phase.** The "parallelizable now" framing below was written
before the owner answered, and is retired. Two independent holds are live:

1. Owner answer 7: "P6 strictly after S4" — the answer's text neither names P6a
   nor ratifies the P6a/P6b split the plan proposed, so under
   read-the-card-never-the-why ALL of P6 waits for legacy-removal S4.
2. OWNER GO 2026-09-03: "P6a HELD until cliprec slice 6 lands; then P6a + the
   cliprec video tie-in run under ONE builder (the recorderbox/output seams get
   rewritten once)."

Releasing the hold needs BOTH: S4 on main AND cliprec slice 6 landed. Coordinate
with the cliprec program (`.myrobots/2026-09-02-mixmstrs-multitrack-clip-recording/`)
— it is actively rewriting the same recorderbox capture/OPFS seams P6a targets.

Tasks (for the eventual single builder):
1. Measure the REAL save paths: `makePortableEnvelope`/`makeStateOnlyEnvelope`
   (encode→decode→traverse→rebuild→re-encode) and performance-zip `zipSync` (ALL
   asset bytes, main thread by design — revisit that constraint).
2. Move base64/Blob assembly and the zip to a worker; keep the Y encode short or
   chunked. Acceptance is the WORKLET RMS floor across each save family — not a ms
   budget.
3. Recorderbox OffscreenCanvas worker capture (standing GO; **owner preview before
   merge** — look-changes ruling). Assert RMS floor while recording.
4. Take-finalize (interrupter 6): verify no dip under the instrument (OPFS writes
   already off-main).

Verification:
- `task desktop:e2e:one -- output-floor` (assertion family 2) per save family;
  `REPEAT=3`.
- `task typecheck`; `task test:one -- persistence`; full `task test` before merge.
- Web-only changes also verified in the browser path (both paths must keep working).

DoD: every save family + record + finalize holds the RMS floor at Tier A; positive
control still red-capable; owner preview done for the capture change.

### P1 — device-slot layer, web-only (GATED: seams after legacy-removal S1; fixture
churn in the §6 window)

Tasks:
1. Slot defs (`cameraSlot`, `outputSlot`) × 4 fixed ids `slot:cam1..4`,
   `slot:out1..4`; faces on day 1 (compact, near-zero prose); DESCRIPTIONS,
   lowercase labels, PatchPanel, docs pages.
2. Survival = THREE mechanisms: def `undeletable`+`maxInstances` (deleteNode path),
   `data.pinned:true` (Clear consults ONLY `isPinnedNode`), and a `duplicate()`
   exclusion (today duplicate has zero guards).
3. `ensureSlots()`: runs at doc create + after every envelope load (single seam:
   the one `loadEnvelopeIntoStore` caller) + a nodes-map deep observer re-asserting
   presence (covers local Clear, PEER Clear over sync, undo/redo). Spawn under an
   UNTRACKED origin (workflow-pins precedent) so undo never captures slots.
4. Reconciler retry for slot ids: clear the `failedNodes` mark on backoff /
   ensureSlots re-assert (a permanent id must never wedge on one transient throw).
5. Envelope semantics: clear pass skips slot ids (merge-not-clear); insert pass maps
   incoming slot nodes onto live ids; **type guard: an incoming node at a slot id
   with a different type is dropped/coerced — identityChanged structurally
   impossible**; binding-strip migration shim; never route slot defs through
   `RETIRED_TYPE_ALIASES`.
6. Bindings out of node.data → electron-store (shell) / localStorage (web).
   Complete name-rebind for the `device-module.ts` family via `device-rebind.ts`.
7. Slot-keyed app-lifetime sessions: camera streams, audio-in tracks (**the
   irreversible one — `track.stop()` never called by any load path; this lands HERE,
   not P6**), ES-9 socket in `bridge-owner.ts` (engine nodes attach/detach from the
   LIVE socket).
8. In-place "File → New rack" (shell path): tracked-origin clear +
   `resetLocalScratchId` + `ensureSlots`, no navigation/reload.
9. [owner Q17] version-floor field in envelopes (refuse-don't-amputate forward);
   sequencing defense regardless: this phase reaches web prod BEFORE any shell save
   path exists.
10. Fixture/VRT/cost pass (OWN PR window per §6): EXPECTED_NODE_TYPES, contract-lock,
    `task face:inventory:accept`, empty-rack assertions, full-rack VRT scenes, BOTH
    timing artifacts re-pinned.

Verification:
- Unit: merge-not-clear; type-guard drop/coerce; Clear/undo/peer-Clear survival;
  duplicate exclusion; binding strip; rebind resolver; factory-retry.
  `task test:one -- slot` then FULL `task test` (FULL web unit suite mandatory if any
  CV-scaled port is added).
- Web e2e (existing lane, fake devices): bind cam slot → load DIFFERENT patch → save
  (EVERY family) → stream token identity unchanged AND frame counter advanced; ES-9
  sim double zero re-dials; audio-in track `readyState` stays `live`.
  `task e2e:one -- tests/<spec>.spec.ts` with `REPEAT=3`; pageerror guard in every
  spec.
- `GREP=<slotdef> task vrt:one`; `task typecheck`.

DoD: 8 slots in every tree in web prod; all interruption-sweep unit/e2e green ×3;
fixture pass landed in its window with both cost artifacts re-pinned; no legacy-path
regressions (`?shell=legacy` still boots).

### P4 — outputs + display map

Tasks:
1. `setWindowOpenHandler` present integration on the verified opener→popup mechanism
   (P2 spike); output1..4 ↔ display map in main; screen-identity matcher reused.
2. Output BrowserWindows shell-owned, never swept; blit re-targets the live window on
   patch load.
3. Loopback capture continuity: gesture-free, picker-free (re-)acquisition via the
   P2 display-media handler; capture joins the app-session-lifetime set.
4. Display hotplug: re-place/re-fullscreen placement LOGIC (unit-tested against
   mocked `screen` metadata). Real hotplug is untested at every tier — say so in the
   spec header; owner-machine smoke covers it.
5. Native save dialog from main (no fullscreen exit; no modals while presenting).

Verification:
- Harness: present live → load patch → SAME BrowserWindow ids, zero close/reopen;
  blit frame counter advances in the DRIVING window (count frames in the window that
  drives the animation — unfocused throttling rule); loopback capture survives a load
  with zero pickers. `REPEAT=3`.
- Placement unit tests: `task test:one -- display-map`.
- **Owner preview for any visible change** (look-changes ruling).

DoD: 4 output windows placed per map, surviving load/save; interrupter 5 (projector
blink) dead; owner preview done.

### P5 — pre-flight UI

Tasks:
1. Shell-native panel: per-slot camera pickers, display assignment, ES-9 config
   ([owner Q11] push-policy caller — hw-verify outstanding, do not assume), VST/PTZ
   status rows (pt-ptz now has a real producer), MIDI/gamepad presence.
2. Persistence in electron-store; bindings applied at boot; unbind/rebind live.

Verification:
- Harness: bindings survive relaunch; unbind/rebind WHILE a patch plays never tears
  sessions (stream ids stable, RMS floor held); USB/serial flow with simulated
  doubles. `REPEAT=3`.

DoD: owner can go from cold boot → bound rig → playing rack without touching a
browser-style prompt; relaunch restores everything.

### P6b — sweep/registry continuity remainder (after legacy-removal S4)

Tasks: the sweep/registry-adjacent items only; re-verify row 3 (audio-in) under the
instrument; full contract audit over plan §3.1.

Verification: the ENTIRE continuity matrix (§5) at Tier A; Tier B smoke if the lane
exists by then.

DoD: every row of the matrix green or explicitly owner-waived.

### P7 — distribution (owner-gated: Q10)

Tasks: Developer ID signing, notarization, hardened runtime, DMG, release lane
(any release CI change = separate owner sign-off).
Verification: signed build on a real Mac — TCC prompts appear ONCE and persist;
Gatekeeper clean; §7 smoke checklist.
DoD: notarized artifact the owner can install without xattr surgery.

---

## 3. Submodule / secrets gate procedure (run per repo, before EVERY push of new or
rewritten history)

1. `flox activate -- git -C <repo> log -p --all > /private/tmp/.../audit.txt` — grep
   for: keys, tokens, passwords, `.env`, PEM blocks, serial numbers, absolute home
   paths (`/Users/`), user identifiers/emails.
2. Same grep over the working tree (including untracked: `git status --ignored`).
3. Confirm repo-local `.gitignore` covers local agent state
   (`.claude/settings.local.json`, `.myrobots/`, `.build/`, `DerivedData/`) — the
   user's GLOBAL gitignore protects only this machine.
4. Any hit → `git filter-repo` or fresh-init, then RE-RUN from step 1.
5. **Write the record** to `.myrobots/<date>-helper-secrets-gate-<repo>.md`: command,
   date, hit list (paraphrased — no profanity/verbatim quotes in anything that could
   reach GitHub), verdict. The record is created at execution time — never cite a
   prior run as the record.
6. Push. All git through `flox activate --` (LFS hang).

Known state 2026-09-04: es9 = 5 commits, clean (benign "token" prose hits only), NO
REMOTE — bundle-backup first; nativeapps = zero commits, tree clean; both need
repo-local ignores + LICENSE [owner Q1/Q3 gate the pushes].

---

## 4. Harness quick reference (Tier A / Tier B)

- Tier A (Linux, dispatch/local): unpackaged `electron .`, xvfb-run, fake cams
  (device-count=4, y4m fixtures), WebMIDI in-page mock, Node stub helpers through the
  real supervisor (injected paths), null audio device, worklet RMS accumulator hook.
  NOT covered: packaging (asar, Resources spawn), menus/TCC, real devices.
- Tier B (macOS, owner-gated): real Swift bridges + es9 SyntheticEngine (42 tests in
  that repo), real CoreMIDI + **SysEx round-trip (MidiMacUmp canary)**, packaged-.app
  smoke. [verify first: AudioContext `running` on a runner with zero CoreAudio output
  devices — unproven; fallback = assert to context creation + topology.]
- Structurally unseen everywhere: signed-build TCC, Gatekeeper, real USB/display
  hotplug, real ES-9, device-callback underruns, NotReadableError contention →
  §7 owner-machine checklist at every phase boundary.

### 4.1 CI lane split, pricing, and the authorization chain (owner answer 3)

**Owner answer 3 (binding):** *"Shell e2e lane: GATING, kept LIGHT — proves the
harness boots and loads expected content; nothing more in the required path."*
This supersedes the earlier non-required-dispatch-only framing everywhere it
still appears in prose.

**Two tiers, and the boundary is load-bearing.**

| tier | contents | where | status |
|---|---|---|---|
| **Required subset** | boot determinism ONLY: shell boots (main + preload + loopback server), `/rack` paints, AudioContext reaches `running` with ZERO gestures, zero pageerrors, zero extra windows. Post-P1 add: 8 slots present. | `desktop-e2e` job in `ci.yml`, in the `ci` umbrella | **SHIPPED as a local task** — `task desktop:e2e`, `apps/desktop/e2e/boot.spec.ts`. The CI job is the remaining step. |
| **Dispatch tier** | everything timing-shaped: the worklet RMS instrument, supervision/SIGKILL, the continuity matrix, crossfade assertions. | `workflow_dispatch` job, NON-required | not built |

The boundary is not stylistic. A required check under the no-flake-tolerance +
`PR-runs-go-red-on-recovered-flakes` regime has an **effective retry budget of
ZERO**, so nothing whose result depends on timing may enter the required subset.
`apps/desktop/e2e/boot.spec.ts:1-16` already states this split in its header and
`Taskfile.yml`'s `desktop:e2e` already describes itself as "the GATING-light
lane's required subset as a LOCAL task" — the code shipped ahead of this prose;
these paragraphs are catching the documents up, not proposing a new design.

**Re-priced (the ~30–35 min figure is RETIRED for the required tier).** That
number priced a standalone workflow re-paying full setup, on the premise that
"the ci.yml e2e-preview artifact is not reusable across workflows". A job inside
`ci.yml` dissolves that premise — it uses the same `needs: [dsp-build, build-web]`
artifact-download pattern every other required job uses. Re-derivation:

- checkout + flox + npm: shared/cached, as for `e2e` and `webgl-smoke`
- `needs: dsp-build` + `build-web` artifact download: ~1 min (measured pattern)
- `desktop:install` (standalone lockfile) + Electron binary **from cache**: ~1–2 min
- boot spec, no `REPEAT`, single spec: ~2–4 min (cold rack paint dominates;
  budget from the same BOOT_MS lesson the spec header cites)
- **≈ 6–9 min wall on the critical path.** Over the >2 min threshold, so it needs
  wall-time sign-off — but as an added parallel job it extends the umbrella only
  if it exceeds the current longest need (`e2e` ~3–4 min × 12 shards + webgl).
  **Measure before claiming a delta; the sign-off number is the measured one.**

**Electron binary MUST be cached** in the required job. A network fetch inside a
required check is a standing flake source.

**Lane membership is explicit, not glob-inherited.** Desktop specs live in
`apps/desktop/e2e/`, outside `e2e/tests/` — no existing lane globs them (the
spec-filename-decides-its-lane class: a spec in no job is green forever). The new
job runs them via `task desktop:e2e`, whose Taskfile entry carries a LANE ANCHOR
comment tying it to `scripts/package-workspace-membership.test.ts`.

**⚠ AUTHORIZATION CHAIN — write this into the PR that touches `ci.yml`.**

The 2026-08-23 "no fundamental CI changes" ruling forbids editing the umbrella's
`needs:` list. **Owner answer 3 IS the authorization that lifts it, for this job
only.** Without this paragraph cited in the PR body, a reviewing agent will
correctly refuse the change and the phase stalls. The chain:

1. Owner directive 2026-08-31 goal 2 asks for the shell + e2e proving the harness.
2. `plan.md` §7 opened the discussion and priced it (satisfying the 2026-08-25
   "no new gates without discussion" ruling's precondition).
3. **Owner answer 3, 2026-09-03: "GATING, kept LIGHT."** That is the approval,
   and it is scoped: required = boot + expected content, *"nothing more"*.
4. Scope ends there. Promoting ANY dispatch-tier spec into the required subset is
   a NEW gate needing its own discussion.

**Arming it is THREE edits made together**, and a partial job is refused by
`scripts/ci-umbrella-parity.test.ts` (which parses `ci.yml`):

1. add `desktop-e2e` to the `ci` umbrella's `needs:` list (`ci.yml:2211`),
2. add its result to the aggregate `env:` block,
3. add `|| "$DESKTOP_E2E" != "success"` to the failing `if`.

`needs:` alone gates NOTHING — the umbrella is `if: always()` and decides purely
from the env+if block. That exact divergence (jobs in `needs:` that the `if` never
tested) is the defect #1505 and the parity test exist to prevent.

**No ruleset change is needed.** The required status context is the umbrella job's
NAME (`typecheck + unit + ART + E2E`), not the new job's, so adding a job inside
the umbrella needs no `gh api -X PUT .../rulesets/...`. (Contrast `vrt-strict`,
which IS required by literal name and whose renaming does require a ruleset PUT.)

---

## 5. Continuity-contract test matrix

> **This section is the ASSERTION view. The architectural source of truth is
> [interruption-matrix.md](interruption-matrix.md)** — which additionally states,
> per interruption, the owning PROCESS per resource, the TRANSPORT that survives,
> what RECONNECTS, the permitted GLITCH, and the receiver-side INSTRUMENT that
> proves it (owner ruling). Read that file before arming any row here.

Assertions (columns): A=AudioContext running, no gesture · B=worklet min-RMS floor +
audio-clock progress · C=camera stream ids stable + frame counters advance (×4) ·
D=audio-in track `readyState:'live'` · E=ES-9 socket zero re-dials · F=VST clientId
reattach across a SOCKET drop, no park loss · G=MIDI claims held + SysEx round-trip ·
H=loopback capture uninterrupted, zero pickers · I=output BrowserWindow ids stable ·
J=zero permission prompts / pageerrors / modals · **K=helper RECOVERY SLA** (not
continuity — see below).

**E and F are CONTINUITY assertions and hold only across RENDERER-side workflows**
(save, load, navigate, Clear). Neither can hold across helper PROCESS death, by
construction:

- **F** — the VST park is an in-memory dictionary in the helper's heap
  (`VSTBridgeCore/VSTBridgeService.swift:112-113`), parked for a 90 s reattach
  grace (`:50-58`, `:304-334`) with NO serialization to disk. SIGKILL destroys the
  plugin instance and its state.
- **E** — a killed es9 helper forces a re-dial by construction; the shipped
  `supervision.spec.ts` es9 leg awaits `a.closed` and dials a NEW client.

**K = helper recovery SLA:** the process returns to `running` under a NEW pid
within the supervisor's backoff+probe bound (`apps/desktop/src/supervisor.ts:66-69`
— `backoffBaseMs: 300`, `backoffMaxMs: 10_000`, plus a hello-probe window at
`:189-207`); the client re-dials; audio resumes. **VST park state is LOST** (the
plugin returns as a fresh default instance) and patch-persisted state is re-applied
only within two bounds:
- **size** — state above `VST_STATE_B64_CAP` (256 KB base64,
  `packages/web/src/lib/audio/vst/vst-persistence.ts:43-44`) is dropped from the
  patch entirely; only the plugin id travels (`:173-179`, `:199-201`), and the card
  already says so (`vst-status-model.ts:186-189`).
- **freshness** — anything changed since the last `getState` is lost regardless of
  size (60 s refresh cadence, `VST_STATE_REFRESH_MS`, `vst-persistence.ts:49`, plus
  editor-close and mount events).

| workflow (rows) | asserts | tier | phase armed |
|---|---|---|---|
| cold boot → bound rig | A,C,D,E,F,G,H,I,J | A (G-sysex: B) | PH/P5 |
| load patch (different ids) | A,B**,C,D,E,F,G,H,I,J (**CROSSFADE ENVELOPE ONLY — owner answer 6 makes click-free crossfade MANDATORY; a content dip is NO LONGER permitted. Assertion: no discontinuity beyond the declared fade shape) | A | P1 (+ P1x, see below) |
| quicksave | A,B,C,D,E,F,G,H,I,J | A | P1 |
| portable save / state-only save | A,B,C,D,E,F,G,H,I,J | A | P6a |
| performance-zip save | A,B,C,D,E,F,G,H,I,J | A | P6a |
| recorderbox record → Save mid-performance | A,B,C,D,E,I,J | A | P6a |
| take finalize / samsloop end | A,B,D,E,G | A | P6a |
| helper SIGKILL → recovery | A, B-after-recovery, **K**, J — **NOT E, NOT F** (both are impossible across process death; see the K definition above) | A (stubs) + B (real) | P3 |
| Clear / undo / redo / PEER Clear | slots re-asserted + C,D,E,I | A | P1 |
| File → New rack (shell path) | A,C,D,E,G,H,I,J | A | P1 |
| forced `render-process-gone` | helpers alive (K-class); main window reloads to a running rig. ⚠ **OUTPUT-window fate PENDING** — do not write this spec until the matrix's renderer-crash row resolves | A | P3 (windows: P4) |
| simulated `statechange: suspended` | auto-resume; NO overlay | A | P2/PH |
| unbind/rebind while playing | B,C(others),D,E | A | P5 |
| OS sleep/wake, default-sink removal | A,B | manual (owner) | checklist |
| display hotplug | I + re-place | manual (owner) | checklist |
| collab reconnect / re-auth failure | no navigation; A..J | A | Q7-gated |
| DOOM anything | **EXCLUDED BY NAME** | — | Q8 |

Positive controls (must stay red-capable for the matrix to mean anything): forced
teardown → B reddens; forced main-thread stall → B still sees the window; forced
sweep of a slot id → C/D redden.

---

## 6. Sequencing (NARRATIVE — the owner answers below are the binding authority)

> This section is explanatory. When it disagrees with `OWNER ANSWERS` /
> `OWNER GO`, those win. It previously claimed to be "binding for this brief"
> while contradicting them; that claim is retired.

P0 and P2 have SHIPPED (#2343). PH immediately after P2 boots — **no phase may
claim a continuity result before PH's instrument + positive controls are green**;
P3 runs parallel. **P6a does NOT** — it is held twice over (owner answer 7 + OWNER
GO); see the P6a section in §2. P1 product seams wait for legacy-removal S1; P1's
fixture/VRT/cost churn lands EITHER before S2 begins OR after S4 — never
mid-inversion (and S2 has begun on the branch, so in practice only the after-S4
window remains). P4 after P1 and only on a passing opener-spike; P5 after P4; P6b
after S4; P7 on owner signing approval. Never `gh pr update-branch` on anything
touching shared/generated files — merge `origin/main` locally.

**P1x — click-free crossfade (owner answer 6) has no owning phase yet.** It is
the largest unpriced item in the program and it is NOT a wording change: a
click-free crossfade requires the OUTGOING audio graph to keep rendering past the
Y.Doc swap, which the current teardown-then-rebuild load path and the
single-client ES-9 socket do not allow. **Options, costs, and the semantic
question the owner must settle are written up in
[crossfade-options.md](crossfade-options.md) — that decision gates P1's acceptance
criteria and the `load patch` matrix row.** Do not start crossfade work, and do
not weaken the matrix row to match the current behavior, until it is answered.

---

## 7. Owner-machine smoke checklist (run at EVERY phase boundary; the only coverage
for §4's structurally-unseen list)

boot unsigned .app → zero prompts beyond expected TCC (re-grant per rebuild) →
pre-flight shows all helper rows → bind 4 cams + displays → rack plays → SysEx
device round-trip (PTZ/Electra) → load a patch mid-performance (no blink, no
silence) → recorderbox record + Save (no dip audible) → sleep/wake → still running →
unplug a display → outputs re-place → quit clean (no orphan helpers:
`ps aux | grep -E 'es9-bridge|vst-bridge|pt-ptz'`).

---

## 8. Open owner questions (blockers marked)

**ANSWERED** (folded into the body — do not re-ask): Q1 ✅ answer 1 + OWNER GO ·
Q3 ✅ MIT · Q5 ✅ answer 5 (yes/yes) · Q9 ✅ answer 3 — **GATING-light, not
dispatch-only**; see §4.1 · Q13 ✅ answer 7 + OWNER GO (P6a held) · Q15 ✅ answer 6
— **click-free crossfade is MANDATORY**; semantics still open, see
[crossfade-options.md](crossfade-options.md).

**STILL OPEN:** Q2 Edge-script vendoring location · Q4 submodule vs in-tree
vendoring + paths (answer 7's execution used submodules) · Q6 Electron + bundled
build (rec: yes/yes) · Q7 collab in v1 (if in: fix re-auth navigation first) · Q8
DOOM continuity (else excluded — do NOT touch) · Q10 signing [BLOCKS P7] · Q11
ES-9 push-policy caller (hw-verify outstanding) · Q12 Quit placement · Q14
`../patchtogether.native` disposition · Q16 previews (recorderbox capture, present
changes) · Q17 envelope version-floor field.

**NEW, raised by this reconciliation:**
- **Crossfade semantics** — true overlap-crossfade vs fade-out/build/fade-in. The
  cost difference is roughly an order of magnitude.
  See [crossfade-options.md](crossfade-options.md).
- **Renderer-crash output-window guarantee** — narrow it, or give output windows a
  real shell-owned transport. Currently PENDING in the matrix; a separate review
  thread owns it.

## OWNER ANSWERS 2026-09-03 (binding)
1. Helper repos: GitHub PUBLIC, MIT license. es9 backup+push approved.
2. PTZ/Edge artifacts: search ~/Documents/workspace/scratch and all recently
   touched workspace folders before building fresh.
3. Shell e2e lane: GATING, kept LIGHT — proves the harness boots and loads
   expected content; nothing more in the required path.
4. Signing/notarization: setup already exists for ../doomviz and/or
   ../p10entrancer — REUSE that configuration.
5. Slots across-the-board: YES — cam1..4/output1..4 bake into the web app too.
6. Patch swap: CLICK-FREE CROSSFADE.
7. Staged-parallel sequencing: APPROVED (P0/P2/P3+harness now; P1 after legacy
   S1 reaches main; P4 after the S2 fixture flip; P6 strictly after S4).

## OWNER GO 2026-09-03 (final P0 gates)
- P0 GO: copyright string "Copyright (c) 2026 2600hz-oscillator" confirmed; repos
  2600hz-oscillator/patchtogether-{es9,nativeapps}, PUBLIC, MIT.
- P6a HELD until cliprec slice 6 lands; then P6a + the cliprec video tie-in run
  under ONE builder (the recorderbox/output seams get rewritten once).
