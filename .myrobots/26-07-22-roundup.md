# Roundup — 2026-07-22

Status of the two big tracks (UI refactor + Push 2 Control) and what's next.

---

## Where things stand

### 1. UI Refactor (workflow mode) — the clean-slate faceplate overhaul

**Owner intent (locked):** same-WIDTH uniform tiles in the 8 lanes; redo all faceplates
for readability; keep 8-lane + drop-in-place; optimize 1440p, support 1080p, not awkward
at 2160p. Direction = **RACKLINE** faceplate + domain spine + **STRATA** semantic-zoom LOD;
full view = curated lane face + full faceplate in the BOTTOM DOCK; per-module **total
rework** (controls chosen per UI best practices + module intent, ALL authored docs revised)
— NOT a mechanical reskin. Mocks = ~100% spec. Color themes only.

**MERGED to main (P0 foundation):**
- **P0.1** — design tokens + color-only palette engine + 5 curated palettes (RACKLINE default)
  + cables recolored to the mock hues. (#1159)
- **P0.2** — LOD/semantic-zoom engine + minZoom fit-all fix (lodTier 0.30/0.52/0.95 + hysteresis).
  (#1161)
- **P0.4** — per-module `face` priority schema + `curatedFace` selector + `module-face-lint`
  ratchet gate + `propose-face`. STRICT_FACES seeded empty. (#1160)
- **P0.3a** — RACKLINE primitive control library (Selector/Segmented/Toggle/Button/Readout/
  KnobConic), uniform card-kit contract. (#1163)
- **v1.3.0 shipped to prod** (workflow lanes + CV Buddy, new-rack, video-zone default, live
  glyphs, watchdog).

**IN PREVIEW (not merged) — P0.3b ModuleShell (#1164, `?shell=1`-gated):**
- The `<ModuleShell>` + `ModuleShellPlaceholder` + the pure-derivation legacy-fallback bridge
  + transient `DockFullView` drawer. Whole rollout behind `?shell=1` (default OFF = byte-identical
  no-op) so it can iterate without touching prod.
- Owner REJECTED the first pass ("foundational work missing"); rebuilt to spec: mini-card matches
  the RACKLINE `.mod` tile (800 title, faint badge, live scope, `.jacks` rail); DockFullView
  faceplate from the kit; uniform **192px** tiles + per-tier height (88/150/180); tight **216px**
  lane pitch (dense 8-lane rack). Latest (`449f9281`): video-zone tiles inside the video area,
  lane-snap on drop, discoverable **⤢ EXPAND** button.
- **AWAITING owner re-preview** at `/rack?mode=workflow&shell=1` (note the `&`, not `?`). On OK →
  merge #1164 → then P1.
- **KNOWN ISSUE — zoom repositioning (owner-flagged 2026-07-23, DEFERRED — do NOT fix yet):** in the
  `?shell=1` shell, zooming in/out **repositions the tiles** (they shift around) instead of staying
  anchored to their lane slots. Likely cause: the per-LOD-tier tile HEIGHT (mini 88 / compact 150 /
  full 180 — added to match the mock's 192×180 at full zoom) changes at tier boundaries, so the
  flush-stack Y positions **cascade-shift** as the tier flips with zoom. This is the exact "layout
  thrash #1" the refactor plan §9 flagged (its mitigation was "pin the flow box to a **tier-invariant
  rack size**"); the per-tier height reintroduced it. TENSION: matching the mock's per-tier sizing vs.
  tier-invariant no-thrash. Options to weigh when we fix: (a) fix a SINGLE tile height across tiers
  (no reposition, but no growth to 180 at full zoom); (b) anchor the flush-stack from a fixed reference
  so one tile's height change doesn't cascade-shift its neighbors; (c) keep the OUTER lane-slot box
  height FIXED and only vary the CONTENT density/scale per tier (probably the cleanest — decouples the
  face LOD from the lane geometry). Everything else in the re-preview (LOD faces, EXPAND button,
  video-zone placement, lane-snap) looks correct — this reposition is the last polish before the shell
  feels solid.
- **PLANNED — tile-header redesign (owner 2026-07-23):** currently the module NAME + the faint type
  badge (label) share ONE header row, so longer names truncate with `…` (RECORDE…, SYNESTH…). New
  header design:
  - A **decorative rule across the top of the card in the DOMAIN COLOR** (purple=video, teal=audio,
    etc. — matches the tile spine / cable domain). It runs from the LEFT edge, vertically aligned with
    the **middle of the module-NAME text**, extends right, and **stops at a visually-pleasing set gap
    BEFORE the name** (line ──── ⟨gap⟩ NAME).
  - The **module NAME** sits on the top row to the right of the rule+gap, with the full remaining tile
    width → **no `…` truncation** for long names.
  - The **module label / type badge** (faint) moves **DOWN to a second row, under the name**.
  Apply to the shared `.rl-tile` / ModuleShell header so both the placeholder and the migrated faces
  get it. Fold into the tile-header work (rides with the P1 face pass or the zoom-reposition fix).

**NEXT — P1 per-module total-reworks (held for owner shell sign-off):**
- Build the dock full-card faces from the **approved gallery** (Artifact 9dcb1d20-39f8-43d2-96c7-fdd8748e012c
  — 9 archetype dock faces = the P1 visual spec). Each module = a designed rework (control set +
  layout + full authored-docs revision), reviewed by the owner, added to STRICT_FACES, VRT-regenerated.
- Priority batch: tidyvco, kickdrum, adsr, vca, lfo, cloudseed → dx7 → the rest of the ~32.
- clipplayer = its own SNOWFLAKE spike (grid/roll/arrange — doesn't fit the standard skeleton).
- Flip the `?shell=1` default + full VRT regen once enough faces are ready (the deliberate
  "new look goes live" moment, owner sign-off).

### 2. Push 2 Control — Phase 1 (#1165, MERGING)

Built through a **live hardware-debugging loop** (owner has a Push 2, tested each step).

**Working + hardware-confirmed:**
- **Live-port binding + set-Live-mode on bind** (the "dark pads" fix). The Push exposes a Live
  port + a User port; custom control + LEDs use the **Live** port in default Live mode with NO
  reliance on the flaky User-mode switch (greyivy-proven). Windows: Live = non-numbered name.
- **CC map** (owner-confirmed on hardware): pads notes 36–99; channel-select CC 102–109; permanent
  controls CC 20–27; scene column CC 43(top)–36(bottom); D-Pad L44/R45/U46/D47; Play 85; Undo 119;
  send knobs CC 14/15; vol knobs CC 71–78; master CC 79.
- **Velocity capture** in note-entry + keyboard (Push pads are velocity-sensitive; Launchpad path
  flattened it).
- **LED colors:** button LEDs `[0xB0,cc,value]`, RGB buttons value = `pushColorIndex` (NOT a blanket
  127=red — that was a bug), white/mono (Undo/Shift) = brightness. Channel-select buttons =
  effective lane hue (selected full / unselected ~30% dim), matching Launchpad's `laneColorEff`.
- **ADAPTER** over the shared `launchpad-control` (injectable `ControlSurfacePort`) — Launchpad's
  340 tests stay green; full clip-launch/note-editor/scene/KEYS parity runs on shipped logic.
- Faceplate diagram rebuilt to the real Push 2 layout; poly real-source-chain e2e green.

**THE KEY LESSON (write-storm):** the LED-repaint attempt (`c7d8e27c`) attached a `ydoc.on('update')`
observer that fired a **blocking full-frame LED MIDI burst on the main thread for every Y.Doc write**
while a Push is bound → a MIDI write-storm that stalled the UI so transport wouldn't start. It was
**GREEN in the headless sim** (no MIDI latency) and **broken only on real hardware** — the classic
green-in-sim/broken-on-hardware trap. **Reverted** (`7ff47f06`); Push 2 is back to the confirmed-good
state. The lights therefore still don't fully work (they paint on press / scheduler-tick) — a
documented follow-up below. Added a `clipplayer-transport-no-controller` guard test (caveat: the sim
can't reproduce the MIDI-latency stall — see the WebMIDI-testing TODO).

**Merge:** rebased onto main (resolve the #1166 shared-brain conflict) + collab re-attest (new module
flips the collab hash). Merging per owner instruction; LIGHTS deferred.

### 3. Launch Control clip-nav fix (#1166, MERGED to main)

- **GRID(held)+clip = ENTER a clip's editor WITHOUT changing play/stop.** The old enter path was a
  DOUBLE-TAP whose first tap launched the clip + an imperfect "revert dance" that leaked play/stop —
  exactly the bug the owner hit. New `enterClipEditor()` is navigation-only (never writes queued/
  play-stop). GRID = grid-view button (CC 92), was unbound as a modifier. 5 tests pin both behaviors.
- Shared brain → benefits Launch Control now and ROLLS INTO PUSH (seam: map Push's grid button →
  `gridHeldSingle` → `enterClipEditor()`).

---

## What's next (TODO)

### Push 2 — immediate
1. **LIGHTS FIX (the big one).** The LED repaint must NOT storm the MIDI output. Approach: **throttle/
   batch** repaints (rAF-coalesce, or a debounced diff-send that rate-limits full-frame sends), driven
   by state changes but capped, NEVER a synchronous per-Y.Doc-write burst. **Do NOT re-attempt the
   observer-per-write approach.** Needs the owner's **console** to capture what the module *emits* vs.
   what the Push *shows* (the sim can't verify hardware LED behavior). Symptoms to fix: channel/control
   buttons only light on press, don't reflect persistent state, don't react to lane-color edits, scene
   column dark.
2. **Roll GRID+clip-enter into Push.** Map Push's grid/session button → set `gridHeldSingle`; a clip-pad
   press while held routes to `enterClipEditor()` (the shared seam #1166 left). Enter-without-launch for
   free; no play/stop change.
3. **Finalize provisional bindings** on hardware: Shift's CC; which permanent-row button = which view
   (CC range 20–27 confirmed, per-button assignment provisional).
4. **Windows dual-port** — the Live-port matcher inversion (keep non-numbered) is code-only; verify on a
   real Windows box (Launchpad hit the MIDIIN2 dup-name gotcha).

### Push 2 — Phase 2 (the display)
5. **WebUSB 960×160 screen.** Net-new subsystem (zero `navigator.usb` today; proven browser-drivable —
   greyivy). First view = **"Channel view"** (owner spec, in the push2 memory): hit a channel button →
   channel view; FAR RIGHT = stereo VU meters for PRE- and POST-mixmaster-fader output (labeled pre/post);
   next = PURPLE send1/send2 meters; REMAINING space = 8 SLOTS, each assignable via right-click-on-a-
   module-control → "send to push2 ch". (Owner was cut off on slot behavior — finalize before building.)

### Testing infrastructure
6. **WebMIDI tests in CI (owner ask).** The headless sim has NO MIDI latency/backpressure, so a real-
   hardware MIDI write-storm (like the c7d8e27c transport bug) passes GREEN in sim — that's why it
   escaped coverage. Investigate real WebMIDI in CI, **probably between networked containers** (a virtual
   MIDI device with realistic output backpressure), so controller LED/output/timing bugs are catchable in
   CI, not just on the owner's hardware. Until then, controller LED behavior rests on live owner testing.
   - **Sub: WAVECEL webgl-smoke flake (2026-07-23).** WAVECEL's `webgl-smoke` check occasionally fails
     `nonZeroFrac > 0.02` ("output is not all-black") on CI's SwiftShader — a bare pixel assert with NO
     renderer-tolerance/capability gate (passes on a real GPU + most CI runs; flaked on #1167's run,
     passes on main's identical code). Fix per CLAUDE.md: gate WAVECEL's smoke assert on a SwiftShader-
     tolerant / capability probe (cf. recorderbox #687, edges #688) so it stops flaking red on the
     software renderer.
   - **Sub: launchpad-perf-controls RESET flake (2026-07-25).** `launchpad-perf-controls.spec.ts:130`
     ("RESET pad snaps every active lane back to step 1") flaked on a #1164 CI rerun — "lane 1 snapped
     with the same reset (saw 84/85)" — green on the FIRST run of the same SHA (branch doesn't touch
     launchpad). Timing-sensitive transport-step assertion under CI contention; root-cause + harden
     (poll-for-snap or step-window tolerance) in the test-stabilization campaign.
   - **Sub: vrt-update.yml `grep` input breaks dispatch (2026-07-25).** Passing `-f grep=<pattern>` to
     `gh workflow run vrt-update.yml` causes `startup_failure` (0 jobs, run never starts) — reproduced
     2×; the same dispatch WITHOUT grep starts fine (bisected empirically). The scoped-capture feature
     is therefore unusable via dispatch. Small fix: find why the grep input kills startup (likely a
     workflow-level expression consuming it) and repair, so baseline regens can be scene-scoped instead
     of full-suite.

### Future
7. **Push 3 vs Push 2 support (owner ask, future — no Push 3 hardware yet).** Investigate what Push 3
   support would take vs. Push 2: hardware/protocol differences (Push 3 is standalone-capable; different
   pads/display/MIDI surface), and whether the adapter generalizes. Research when prioritized; can't test
   without the unit.
8. **MPE support (owner ask, future).** MIDI Polyphonic Expression = per-note pitch bend + pressure/
   channel-aftertouch + timbre/CC74 slide, over the MPE channel-per-voice layout.
   - **PREFERRED design (owner): an MPE-to-CV module.** One module consumes MPE MIDI and directly
     EXPOSES the MPE dimensions as **CV outputs** — per-voice pitch (bend-summed), gate, pressure,
     slide/timbre, velocity — as **poly cables** (per-voice) for the polyphony. Then ANYTHING patches
     to them easily (pressure → a filter/level, slide → any modulation target, per-note pitch → osc
     pitch), with NO per-module MPE code. This is the modular general solution and how the target
     modules get MPE — by patching the MPE-CV outputs to their params.
   - **Target modules to exercise it: wavesculpt, cube, videocube, tidyvco, dx7, macrooscillator.**
     Native per-module MPE only where patching CV isn't expressive enough.
   - Poly CV = per-voice; wire through the real poly/MIDI source chain (MPE MIDI in → MPE-CV → module →
     audible per-note expression), per the poly-modules-test-real-source-chain rule.
   - **Target / test device = LinnStrument** (WebMIDI, native MPE). Confirm the exposed CV param set +
     per-module mappings with the owner when built.

---

## Guardrails learned this session (carry forward)
- **GLYPH RULE — REVISED (owner 2026-07-25): tidyvco gets DUAL displays.** KEEP the live output trace
  (the analyser tap) as the RIGHT-hand display, and ADD a SECOND display showing the STATIC core waveform —
  param-derived from its assignment (shape1/shape2/PW/mix → the morph shape), always visible regardless of
  gate (the live tap alone flatlines when ungated — that was the complaint). Layout: static morph + live
  trace side by side in the dock hero band; at compact tile width, prefer the static morph (the identity);
  both at full/dock. General principle stands: shape-identity SOURCES always show their param-derived
  waveform; live taps complement, never replace it.
  **+ LIVE-WHILE-TWISTING (owner):** the morph display must keep ANIMATING/updating while the user twists
  shape controls — currently the graphic goes dead during a drag. Likely root cause: knob gestures write
  TRANSIENT-FIRST (createCcCommit-style — committed to node.data only at gesture end), so a display reading
  committed params looks frozen mid-twist. Fix: the static morph display reads the LIVE/transient param
  stream (the same readLive seam the knobs use), re-rendering during gestures; the live analyser trace must
  also not pause during pointer capture. Sequenced behind the P0 transport verdict (analyser taps are a
  suspect there; implement after).
- **SIDE-BY-SIDE DOCK (owner 2026-07-25, extends the drawer-occupancy work):** expanding a 2nd module while
  one is expanded → **50/50 split** in the lower view; each pane INDEPENDENTLY scrollable (l/r/u/d) when its
  faceplate exceeds the pane; 3rd expand replaces the least-recently-opened (default, confirm w/ owner);
  closing one pane returns the other to full width; c/m/e still swap out the WHOLE full-view (one-drawer
  exclusivity stands); **TAB flips BOTH panes** to the rear-card view.
- **REAR-CARD (FLIP) PATCHING VIEW (owner 2026-07-25, design+build program wf_04c9a0e4):** the new UI's
  answer to the legacy flip-card — expose ALL patch points easily, NO controls. Owner requirements: as close
  to **"one function per hole, see all of it at once"** as possible (cascading menus only as fallback); USE
  the middle of the card (old flip wasted it); group patch points LOGICALLY; COLOR-CODED (cable-domain
  tokens); RACKLINE look. Explore prior art (Reason rear-rack flip = canonical, VCV, patchbays). Pipeline:
  prior-art research + spec + HTML mock → build RearCard + TAB flip + rear faces on the 6 prototypes on the
  #1169 branch → adversarial verify → OWNER JUDGES; if liked, becomes part of the fan-out for all modules.
- **P0 RESOLVED (2026-07-26): transport was NOT broken** — owner confirmed fine after the findings. The
  investigation (130/130 launches, 13 lane compositions, both modes, dev+prod, vs main; churn theory
  DISPROVEN with 0 steady-state Y.Doc updates) found two real traps: (1) **fresh-rack transport defaults to
  RUNNING** (missing `running` param = 1 free-run) so the FIRST ▶/■ press STOPS it — "pressing play silences
  the rack"; UX decision still OPEN with the owner: start stopped vs. clearer ■-while-running button state
  (my rec: the latter). (2) **click-intercept bug**: piano-roll rows could overlay the NOW/QUEUE launch row
  in metric-dependent layouts, eating clicks — FIXED (42ad2cd8, flex-shrink+z-index, zero visual change) +
  a full-chain master-transport regression e2e (both modes). Owner will flag future transport bugs if seen.
- **Video-visibility follow-ups (2026-07-25, from fix/shell-video-visibility):** (a) **wavesculpt's dock
  full-view stays broken** — its card calls bare `useStore()` but lives IN the WebGL attest basis, so the
  guarded-captureFlowStore sweep skipped it (needs a basis edit + one-time re-attest, or a shell-side seam);
  (b) synesthesia's tile keeps the static wave (audio-domain, no video surface FBO — a VU-meters thumb is a
  candidate follow-up); (c) NON_SHELL legacy lane cards (videoOut) have no EXPAND affordance → their dock
  path is user-unreachable (full card is in-lane, so low priority; e2e covers dock via a dev seam).
- **Port-5173 races between concurrent UI agents (2026-07-25):** with multiple fix agents on parallel
  worktrees, one agent's dev server can replace another's on the shared 5173 — a probe page then silently
  renders the WRONG checkout's code (the headroom agent caught its own false result this way and re-verified
  on an exclusive `E2E_PORT=5573`). RULE: any agent doing browser-verification while siblings run must use a
  per-worktree `E2E_PORT` and prove the server it hits is its own; treat shared-5173 results during parallel
  rounds as suspect.
- **Green-in-sim ≠ works-on-hardware** for MIDI controllers — the sim models no MIDI latency/backpressure.
  Any controller LED/output change needs live hardware confirmation until we have WebMIDI-in-CI.
- **Never drive device output on every Y.Doc write** — coalesce/throttle. A per-write blocking MIDI burst
  stalls the main thread.
- **Don't run `task worktree:guard` while an agent is spinning up** — it reaps the still-clean fresh
  worktree mid-`npm install` (burned one this session). Agents should `touch` a file early.
- **Revert over forward-patch** when a change both broke something AND didn't achieve its goal.

---

## 2026-07-26 — batch 1 SHIPPED, batch 2 integrating, batch 3 fanned out

**#1169 MERGED → main `01d6b71a` → dev deploy SUCCESS → main push-CI SUCCESS.** One branch carried
batch-1 faces (adsr / cloudseed / kickdrum / lfo / tidyVco / vca), the REAR CARD flip, the side-by-side
50/50 dock, the whole 14-item owner feedback round, the `?shell=1` no-video P0, the menu viewport-clamp
(12 sites), and the render-parity + pitch-accuracy gates. webgl:attest ran fully green on the real GPU
(including the previously-parked cameraInput test), hash-identical to the pin. Linux VRT baselines
landed: 17 pending pairs drained, ratchet 121 -> 104.

**MERGE-AUTHORITY NOTE (flagged, not hidden):** #1169's own body said "do not auto-merge: the owner
previews the faces", and GitHub records no human approving review. It was merged on the owner's
out-of-band approval ("this can all go in", "do a web attest, then let that merge to dev"). The owner
has NOT previewed the FINAL merged state — the video P0 was found and fixed AFTER that approval. Worth
an owner look on dev before batch 3 lands on top.

### Batch 2 (dx7 / sixstrum / snaredrum / tomtom / shimmershine / qbrt)
Branch `feat/ui-refactor-p1-batch2`. PR #1170 was AUTO-CLOSED by GitHub when its base branch
(`feat/ui-refactor-p1-batch1`) was deleted on merge — a replacement PR is needed. The inert-cell fix
agent is integrating: it committed the fix, merged the docs-correction commit, and is resolving the
merge with fresh main. Its scope: real interactive family/static cells in ModuleShell (dx7 preset +
`.syx` import), a momentary control kind (tomtom STRIKE), the declared-`ControlFamily.label` fix, the
`FACE_TIER_CAPS.compact` vs `laneBodyPlan` reconcile, and extending `faces-parity.spec.ts` to assert
every cell is INTERACTIVE and per-cell operable.

### Batch 3 — FANNED OUT 2026-07-26 (5 parallel worktree agents, off `01d6b71a`)
All owner-named modules are now covered by batches 1+2, so batch 3 is **karplus** (the last one from
the owner's explicit list) plus the core signal chain everyone patches first:

| module   | branch                      | port |
|----------|-----------------------------|------|
| karplus  | `feat/p1b3-face-karplus`    | 5301 |
| filter   | `feat/p1b3-face-filter`     | 5302 |
| mixer    | `feat/p1b3-face-mixer`      | 5303 |
| delay    | `feat/p1b3-face-delay`      | 5304 |
| reverb   | `feat/p1b3-face-reverb`     | 5305 |

Each brief demands a TOTAL REWORK (not a reskin), `face.rear` curation, docs revised AND fact-checked
against the real DSP, STRICT_FACES + STRICT_DOCS promotion, darwin VRT baselines with the linux pair
left PENDING for the integrator to drain, single-line appends only on the four shared registry files,
a dedicated `E2E_PORT`, a 3x flake-check, and an explicit CI wall-time delta estimate. Each also
reports catalogue-overlap questions for the owner rather than acting on them
(filter/resofilter, mixer/mixmstrs/attenumix, delay/charlottesEchos/cofefve/ringback,
reverb/cloudseed/shimmershine/moog905).

**Batch 4 shortlist:** timelorde (master clock, high traffic), scope + dockscope + spectrograph as a
"visualizers" batch (their faces are dominated by the live ScopeScreen/VuMeter glyph primitives),
sequencer, noise, sampleHold.

### Housekeeping done this round
- Worktrees pruned 16 -> 3 (primary + the live batch-2 agent + one resumable). All removed worktrees
  were verified reachable from a remote branch or already squash-merged into main first.
- The primary checkout had drifted 11 commits behind main AND carried uncommitted work that was NOT
  in main (landing "new … rack" tiles routing to `/rack?new=1`, a 280-line launchpad-clip-launch spec,
  and an untracked `launchpad-single-arm-row.spec.ts`). Preserved as `stash@{0}` plus a 670-line patch
  at `scratchpad/landing-new-rack-tiles.patch` before fast-forwarding to main. **This is unfinished
  work that still needs a home.**
- #1008 (`feat/mobile-view`, draft since 2026-07-02) is CONFLICTING — pre-existing rot, not caused by
  this merge. Needs a revive-or-close decision.

### Open owner decisions (none blocking)
1. snaredrum SPREAD sign bug — the wire bed pans opposite the striking hand. Fix (needs an ART re-pin
   + owner ears) or leave?
2. The DX7 mock's OP1-6 pages need ~78 new params — that's a module rework, not a face. Ship
   patch-driven with a preset picker, or schedule the rework?
3. Video input-occupied behavior: `resolveInputSourceId` silently picks the LOWEST EDGE ID, so a second
   cable into an occupied video input is invisibly ignored. Recommend replace-on-connect.
4. Third-expand pane replacement default (currently least-recently-opened).
5. Fresh-rack transport starts RUNNING, so the first ▶ press stops it. Start stopped, or make the ■
   state clearer? (leaning the latter)
6. Commit the design mocks into `.myrobots/` — the crash wiped the scratchpad copies.

### Batch-3 INTEGRATOR CHECKLIST (do these ONCE, at assembly — not per-module)

Two ratchet counters live in single shared literals. If each of the 5 sibling agents bumped them, that
is a guaranteed 5-way conflict on one number, so agents were told to leave them alone (karplus did, by
its own judgement — confirm the others did too):

- **`module-face-lint.test.ts` ratchet floor**: currently `6`. Set to `11` once all five batch-3 faces
  land (`STRICT_FACES` = 6 batch-1 + 6 batch-2 + 5 batch-3 = 17 total).
- **`vrt-meta.test.ts` linux-deficit ceiling**: currently `104`. Each module adds 2 PENDING linux pairs
  (compact + dock), so it rises to `114` for five modules — then falls back as the linux baselines are
  drained. Karplus already pushed it to `106`; do not double-count its bump.
- Remember DRAIN-BEFORE-DISPATCH: a pair still in `EXEMPT_BASELINE_PAIRS` is `test.skip()`-ed
  UNCONDITIONALLY, so `--update-snapshots` writes NOTHING for it. Remove the pairs and lower the ceiling
  in the SAME commit, THEN dispatch `vrt-update.yml` (unscoped — `-f grep=` causes `startup_failure`).

### karplus — DONE (`feat/p1b3-face-karplus` @ `382c8c0a`)

All gates green; `contract-lock.txt` UNCHANGED; both attest hashes byte-identical (verified by stashing
back to clean `01d6b71a` and re-measuring). CI delta ~+15 s now, ~+45 s after the linux drain.

Design: decay + brightness are promoted to ranks 1-2 (they decide what instrument it is and are the
knobs a player rides); TUNE drops to 3 (it is a set-once transpose — pitch arrives on 1 V/oct). Added a
live scope glyph (the legacy card had NO visualisation, on a voice whose decay envelope IS its
identity). Rear card groups the leading band as the two HANDS of playing a string: striking hand
(trigger + accent, latched at the same edge) and fretting hand (pitch + damp). `audioRate: ['pitch']`
alone — every knob CV passes an 80 Hz one-pole smoother, so ticking them would be a lie.

**8 docs claims corrected against the DSP**, including: BRIGHT open cutoff is **64x f0, not 90x**;
BRIGHT *does* shorten the note below ~0.1 (the "never shortens" claim was false, and the old wording
blamed high pitch when the threshold is essentially pitch-INDEPENDENT); STIFF is audible at every pitch
and CAPPED above ~A5 (not "most audible on higher notes"); **eight** params have CV inputs, not five;
ACCENT is **+0.25 absolute** on a 0-1 scale plus ~+4.7 dB burst, not "~25%".

**Findings for the owner (see numbered list in the batch-3 open-questions section below).**

### Batch-3 open questions raised by karplus
7. **The PLUCK button is UNREACHABLE in the shell face.** Karplus's audition strike uses the
   `manualTrigger` read-key seam (a ConstantSource pulse), not a param — so it cannot be ranked and
   `faces-parity` rejects dead static cells. Every param and control family survives (the
   never-lose-controls rule is met on its terms), but a trigger-driven voice with no audition control in
   workflow mode is a genuine UX loss. Recommended fix: adopt tomtom's `strike` press-param (discrete
   0/1, OR'd with `trigger_in` in the worklet) — which is exactly the momentary control kind batch 2 is
   already building. Cost: a 9th param ⇒ contract-lock diff + ART `.sha` re-pin. NOT done unilaterally.
8. **karplus at 0 V plays A3 (220 Hz), not C4**, so it was NOT enrolled in
   `default-pitch-accuracy.test.ts` despite that file naming it. Free-tuned VCO semantics are
   defensible; owner call. (The DSP already has a stronger dedicated gate: <3 cents across C2-C7 at both
   44.1 and 48 kHz.)
9. **DECAY is a lie below BRIGHT ~0.1** — documented honestly, but if that regime is meant to be usable,
   `KARPLUS_G_MAX` (currently 1.1) is the lever; raising it re-opens the k=0 stability argument.
10. **DSP comment is factually wrong**: `packages/dsp/src/lib/karplus-dsp.ts` says B=1 gives ~90*f0; it
    is 64*f0. NOT fixed here because `dspSourceSha` hashes the file TEXT, so a comment edit invalidates
    `art/scenarios/karplus/*.sha` and forces an ART re-pin. Fold into the next ART-touching PR.
11. **Rear/lane jack labels read `TRIGGER IN` / `ACCENT IN` / `DAMP IN`** (doubled suffix). The real fix
    is a one-line `_in`/`_out` suffix rule in the shared `patch-panel-labels.ts` — global, moves existing
    rear baselines, and 5 siblings are in that file. Deferred to a dedicated pass.

### filter — DONE (`feat/p1b3-face-filter` @ `547414b4`)

All gates green; attest hashes byte-identical; ART profile SHA UNMOVED (proves behaviour-neutral).
CI delta ~+30-40 s. Order `[cutoff, resonance, mode, cutoff_cv_amt, res_cv_amt]`; `mode` ranked ABOVE
the CV depths because it re-frames what the cutoff knob MEANS. Dock went 3 bands -> 2 after the agent
captured the baseline and LOOKED at it — three rows pushed the modulation stage below the fold at 720p.

**5 docs claims corrected**, two of them serious:
- `mode` was documented **0=LP, 1=BP, 2=HP**; the DSP and the card both say **0=LP, 1=HP, 2=BP**.
- Docs claimed the filter **self-oscillates** at high resonance. It CANNOT — max Q is 20.5 (~+26 dB
  peak) and `fi.reson*` are stable 2-pole biquads with `a1 = 1/Q > 0` always.
- Cutoff CV was documented as **audio-rate / FM-able**; it passes `si.smoo` = a ~7 Hz one-pole. Not FM.
- "±5 octaves (20 Hz - 20 kHz)" omitted the hard clamp: from the 1 kHz default only ~+4.3 oct is real.
- Res CV is additive and BIPOLAR (negative damps), not "linear over 0..0.99".

**!! CONTRACT CHANGE — needs a conscious owner yes !!** The agent added two attenuverters
(`cutoff_cv_amt`, `res_cv_amt`) because the Faust source maps the cutoff jack **±5 octaves with NO depth
trim** — so a plain 0-1 envelope asks for +5 octaves and pins the corner at the 20 kHz ceiling. The
single most common patch in the rack (EG -> cutoff) was unusable without an external attenuator. They
are GainNodes in the factory's existing CV path (no new DSP); at the `+1` default the gain is an exact
identity multiply, so existing patches are bit-identical and the SHA-pinned ART profile did not move.
The brief did sanction adding a genuinely missing control — but this is the most-patched module in the
rack, so it is flagged, not buried. **Second-order catch: the two params are NOT on the legacy card**
(touching it would move the legacy VRT baseline), so with `?shell=1` OFF they are reachable only via the
doc page / MIDI-assign. Fine while legacy is being retired; still wants a deliberate "yes".

### Batch-3 open questions (continued)
12. **`filter` vs `resofilter` is a genuinely confusing split.** `resofilter` is close to a strict
    superset: STEREO vs mono, 5 modes vs 3, a Cytomic/Zavalishin TPT SVF whose mode knob is a pure
    output picker so switching is POP-FREE (filter's `ba.selectn` is a hard jump that can click), a
    wet/dry mix, per-param CV with real `cvScale`, and resonance that reaches the edge of
    self-oscillation (filter cannot). `filter`'s only edge: it is cheaper and has the ±5-oct exponential
    cutoff jack resofilter lacks. Both sit under Audio -> Effects/filters with near-identical names.
    Recommendation: pick ONE headline VCF, then rename or retire the other.
13. **PLATFORM GAP — discrete params have no labels in the shell.** `ParamDef` has no enum/options
    field, so a `curve: 'discrete'` param renders as a bare 3-detent knob labelled "MODE" with NO
    LP/HP/BP text. The legacy card's three labelled buttons were strictly MORE legible. This is the
    never-lose-controls rule's cousin: the control survived, its legibility did not. Wants a
    Segmented/Selector cell — which is exactly the interactive-cell machinery batch 2 just built
    (`shell-cells.ts`). Should be a batch-4 platform item, and it will recur on every discrete param.

### Latent CI risk FIXED — PR #1172
`frametable-core.test.ts` ran 3990 ms against vitest's 5 s default. Found INDEPENDENTLY by the batch-2
integrator and the filter agent (both hit it as a timeout under parallel load; both saw it pass
standalone on pristine main). Root cause was NOT the arithmetic: the bounded-ness check sat inside a
64x4000 sweep = **512k `expect()` calls**, ~90% of runtime. Hoisted to a min/max tracked across the
sweep + one assert after — same guarantee, 3990 ms -> 600 ms (6.6x), offending test 3555 ms -> ~25 ms.
Proven still-live by injecting an out-of-ring return into `pickLagIndex` ("expected 77 to be less than
60"). Two weaker injections were caught by the TV-distance assert first — so the bounds check is a smoke
guard and the TV assert holds this test's real teeth. Test-only; 85/85 pass 3x.

## !! CORRECTION: `?shell=1` is NOT a complete gate — the DOCK FULL-VIEW bypasses it !!

I repeatedly told the owner "default OFF is a byte-identical no-op". **That is wrong for one path**, and
the reverb agent caught it. Verified directly in `Canvas.svelte`:

```
:492   let shellPreview = $derived(workflowMode && page.url?.searchParams?.get('shell') === '1');
:7843  <DockFullView … migrated={migrated(fv.node.type)} … />     <-- NO shellPreview conjunction
```

`DockFullView` switches on `migrated(type)` — i.e. STRICT_FACES membership — **alone**. So in workflow
mode WITHOUT `?shell=1`, expanding a faced module into the bottom dock renders the RACKLINE faceplate
instead of its verbatim legacy card. The lane tiles ARE correctly gated (`laneRenderKind` keys off
`shellPreview`); only the dock full-view is not.

**Consequences:**
- This is PRE-EXISTING main behaviour established by batch 1, not introduced by batch 3 — and it is
  ALREADY LIVE ON DEV for the six batch-1 modules (adsr, cloudseed, kickdrum, lfo, tidyVco, vca). The
  owner can look at it right now and judge.
- Every face we merge changes the DEFAULT (flag-off) dock experience for that module. 6 live now,
  +6 (batch 2) +5 (batch 3) = 17 pending.
- It may well be INTENTIONAL — `DockFullView`'s own header comment frames the split as
  un-migrated→legacy card / migrated→ModuleShell, with no mention of the flag. But it contradicts the
  invariant we have been asserting, so it needs an explicit owner ruling, NOT a unilateral "fix".
- If the owner wants the flag to be a true gate, the change is one conjunction:
  `migrated={shellPreview && migrated(fv.node.type)}` — plus a regression test asserting the flag-off
  dock renders the legacy card.

## Batch 3 COMPLETE — all 5 branches pushed, all gates green

| module  | branch / SHA                        | notable |
|---------|-------------------------------------|---------|
| karplus | `feat/p1b3-face-karplus` `382c8c0a` | 8 docs claims corrected; PLUCK unreachable in shell |
| filter  | `feat/p1b3-face-filter`  `547414b4` | 5 docs claims; **CONTRACT CHANGE: +2 attenuverters** |
| mixer   | `feat/p1b3-face-mixer`   `80268ca6` | **found a FALSE-NEGATIVE in the faces-parity gate** |
| delay   | `feat/p1b3-face-delay`   `c0ab897a` | 6 docs claims; **fixed a real dry/wet gain-law bug** |
| reverb  | `feat/p1b3-face-reverb`  `b475e68e` | **found the wet path is +11 to +21 dB hot / clipping** |

Every branch: attest hashes byte-identical, typecheck 0 errors, 3x flake-checks clean, dedicated
`E2E_PORT`, darwin baselines captured with linux pairs left PENDING.

### The two REAL audio bugs found (owner decisions — neither fixed)
- **reverb wet path is not level-matched.** Faust's `mono_freeverb` sums 8 combs with NO output scaling
  (reference Freeverb has `fixedgain`; shimmershine scales x0.25 + tanh-limits). Measured: wet leg
  **+9.9 dB** at SIZE 0, **+11.4 dB** at defaults, **+18.5 dB** at SIZE 1/DAMP 0, wet PEAK **+21.2 dB**
  over dry — peaks of 5.74 from a 0.497-peak input, hard past full scale with nothing limiting it. So
  MIX is really a volume control and "fully wet + large" clips whatever it feeds. Fixing it re-SHAs the
  wasm, moves every ART baseline, and makes every existing patch ~10 dB quieter. Needs an explicit
  "yes, break it" + ART re-pin.
- **delay's dry/wet law was inconsistent** — the factory initialised dry/wet LINEARLY while `setParam`
  and `readParam` use the equal-power sqrt law. Two symptoms: the first touch of MIX jumped the level
  with no knob movement (dry 0.650->0.806, wet 0.350->0.592), and `readParam('mix')` returned `wet^2`
  = **0.1225 instead of 0.35**, so the motorised fader read back wrong. The delay agent FIXED it (one
  law in all three places). This slightly changes default audible output — flagged.

### The gate bug (mixer) — worth knowing, it was giving false confidence
`faces-parity`'s operability check always dragged the knob **UP**, which cannot move a param already at
its ceiling. Mixer ships every level at `1.0 = max`, so a fully operable control produced no commit and
read as LOST. Fixed to drag away from the nearer rail using the live min/max on `__moduleSpecs`. This
would have recurred on every attenuator-shaped module.

### Also found
- **`PortDef` has no `label` field** — yet `rear-card-model`'s `RearPortLike` and `patch-panel-labels`'
  `PortDescriptor` both already declare `label?` and `resolveVerboseLabel` already honours it. No def
  can set it, which is why mixer's rear holes read `IN1..IN4` instead of `CH1..CH4`. ~6 lines, additive,
  contract-transparent. Platform follow-up.
- **`ringback` is mis-filed** in the delay family — no time-in-seconds, no echo semantics; it's a
  bitcrusher.
- **`attenumix.ts` still has ~8 lines of prose comparing itself to VEILS**, which is NOT a registered
  module (zero hits repo-wide). Mixer's own dead VEILS reference was removed; attenumix's was left.
- **Catalogue overlap is now a theme, not an anecdote:** filter/resofilter, reverb/cloudseed/
  shimmershine/moog905, delay/cofefve/charlottesEchos, and mixer/attenumix/moogCp3/mixmstrs — a FOUR-way
  split of "add signals together". Recommend a consolidation/naming pass.

### CROSS-AGENT HAZARD (new standard candidate): `git stash` is REPO-WIDE, not per-worktree
The delay agent stashed to test a hypothesis; the reverb agent stashed concurrently; delay's `stash pop`
popped REVERB's stash into delay's worktree. Recovered with nothing lost (verified independently: the
reverb branch touches only `reverb.ts` + shared registries, the delay branch only `delay.ts` + shared
registries — no crossing), and reverb's stash was re-pushed onto the stack as a labelled `stash@{0}`.
**RULE: parallel worktree agents must NEVER `git stash`.** Use a scratch commit on their own branch, or
`git worktree`-local `git diff > patchfile`. Worth adding to CLAUDE.md.

## 2026-07-26 — two CI reds root-caused (NOT re-run), fixes in flight

### #1171 faces-parity timeout — FIXED (`7cb642c3`, now PR #1171's head)
NOT one shared budget as first assumed — each face is already its own `test()` via the
`for (const type of STRICT_FACES)` loop. The bug was the **flat 30 s default**: a ceiling sized for the
smallest face applied to the largest. The four CI failures were exactly the four biggest faces —
cloudseed (46 cells), kickdrum (25), tidyVco (25), snaredrum (22); sixstrum (19) was the largest to
pass. Clean cutoff between 19 and 22 cells. Cost is inherent and LINEAR in cells (~14 CDP round-trips
per cell against a software-rasterized video zone), not pathological — the `scrollIntoViewIfNeeded` is
genuinely needed (cloudseed spans 8 pages), `renderedCells` is already one `evaluateAll`, no retry loop.
**Fix: derive the ceiling from the face's own cell count**, two-stage (fixed term up front for
boot/spawn/dock, then `+ PER_CELL * cells.length` once the count is knowable).
`FACE_FIXED_MS = SLOW_RENDER ? 45_000 : 30_000`, `FACE_PER_CELL_MS = SLOW_RENDER ? 1_800 : 600`.
Chosen over a flat bump specifically because batch 3 adds 5 more faces — a flat number would re-break.
Mechanism proven LIVE by shrinking the budget: cloudseed reported `Test timeout of 3046ms exceeded`
= 3000 fixed + 46 cells x 1 ms. Zero added green-path wall time (per-face durations byte-identical);
3x SwiftShader = 42 passed, zero flakes; cold-server run green.

### #1172's red was NEVER #1172's fault — two PRE-EXISTING load-induced flakes on main
Both reproduced on a pristine detached `01d6b71a`. Fix branch in flight: `fix/e2e-load-induced-flakes`.

**`clipplayer-rate-reset.spec.ts:204` — HARDENED TWICE AGAINST THE WRONG VARIABLE.** The test polls for
an ABSOLUTE `<=6` step band after clicking reset. Under load `click()` alone burns 2.2-6.3 s (warm:
51 ms). A traced failing run showed `5014:101/101 … 6611:126/126 -> 6750:0/0` — that 0 is a natural
**128-step wrap, not the reset snap**. Back-projecting the measured clock (15.65 steps/s) puts the
playhead at ~22 when `click()` returned, i.e. **the reset fired ~1.4 s BEFORE the click promise
resolved**; the first poll read already sat past the band. CI's numbers fit exactly: `l0=92` -> ~14 at
click-return, retry `l0=86` -> ~8. **Therefore raising the timeout CANNOT fix it** — which is why band
2->6 and timeout 2500->5000 both failed. Behaviour is BIMODAL: healthy runs detect in 5-44 ms of a
5000 ms budget (~100x margin), loaded runs miss entirely. **Fix: relative backward-jump proof** —
capture `stepBefore` before the click, poll for `current < stepBefore` (a monotone playhead can only go
backward via a reset), plus `lengthSteps` 128 -> 512 to push the wrap horizon 8 s -> 32 s. Strictly
STRONGER than the current assertion. (Watch the documented 128-step clip cap.)

**`clip-automation.spec.ts:685`** — `holdCc(…, 1800)` keeps a CC hot for exactly 1800 ms of WALL CLOCK,
concurrently; everything after (a 5 s-budgeted `toBeVisible`, a 220 ms wait, a 6x70 ms sample) must
finish inside it or the CC goes idle and the override releases. Warm margin: `va` finishes at +707 ms
(2.5x), `vb` at +1176 ms (624 ms slack). Causation shown by injecting ONLY the pre-sample latency CI
load adds — monotone dose-response reproducing CI's exact error: 0 ms -> spread 0.000 pass; +1400 ms ->
0.141 fail; +2400 ms -> 0.408/0.456 fail; CI observed **0.6027** (~+3000 ms). **Fix: stop-signal hold**
(loop injecting CC until an explicit `hot = false` after sampling) so "still hot" is structurally
guaranteed rather than a race — strictly better than growing 1800 -> N, which would add fixed wall time
to every green run.

**Filename correction for the record:** there is no `clip-automation-per-clip.spec.ts`; the failure is
`clip-automation.spec.ts:685` ("per-clip" comes from the test title, 722 is the failing expect's line).
That one was FLAKY (passed on retry); only `clipplayer-rate-reset` hard-failed both attempts.

## 2026-07-26 — BATCH 2 MERGED; flake fixes shipped as #1173; batch 3 integrating

- **#1171 (batch 2) MERGED → main `2aaae3cf` → dev deploy SUCCESS.** Went CLEAN once the faces-parity
  derived per-cell budget landed. Remote branch deleted. That is 12 faced modules on main now.
- **Batch-3 integration dispatched** onto `2aaae3cf` (karplus/filter/mixer/delay/reverb), with the
  six known conflicts spelled out (both ratchets are ADDITIVE — sum, never take one side) and
  drain-before-dispatch for the 10 pending linux pairs.
- **#1173 — the two load-induced flakes, FIXED and proven under injected latency.** −0.6 s per green run.

### !! The `clipplayer-rate-reset` assertion was UNSOUND, not merely flaky !!
Sweeping injected latency showed the OLD assertion **passed at +6000 ms and +14000 ms via a natural
128-step loop wrap — green with NO reset having occurred at all.** The failures at +1500/+3000/+9000 ms
were just the gaps between wraps. That is why it had been "hardened" twice against the wrong variable:
each prior investigation asked only why it FAILED, never why the green runs were green. New assertion
uses an in-page 10 ms playhead recorder (no CDP in the detection path) proving a backward jump
arithmetically too fast to be a wrap; a negative control (skip the click, run 14 s so real wraps occur)
correctly FAILS. Lesson banked as its own memory.

### Two of my own instructions to that agent were WRONG — it checked and pushed back, correctly
1. I said use `lengthSteps: 512`. **512-step clips are REJECTED** — `MAX_CLIP_STEPS = 128`
   (`clip-types.ts:66`) and `coerceClipRecord → clampStepCount → readClip` silently clamps on the READ
   path. (Also: lowering the tempo instead is not a fix — the wrap horizon and the detection window are
   both `P / rate`, so it trades one failure mode for the other.)
2. I prescribed a `stepBefore` / `current < stepBefore` poll. That **reads through the same slow CDP
   path**, so it moves the band rather than removing the race — at the measured 1.4 s gap the playhead
   is already past `stepBefore` on the first read. The in-page recorder is the correct generalization.

### THIRD flake in the same family — NOT fixed
`clip-automation.spec.ts:428` ("module-assign + per-lane arm") hit a 30 s test timeout under saturation
on **unmodified main**. Same load-induced class. Needs its own root-cause pass.

## 2026-07-26 SHUTDOWN — owner decisions + resume pointer

**Resume plan: `.myrobots/plans/shell-ui-refactor-resume-2026-07-26.md`** (read that first).

OWNER DECISIONS: reverb hot wet path = **LEAVE AS IS for now**; delay equal-power dry/wet fix =
**APPROVED**; filter's two attenuverters = **APPROVED**; catalogue overlap = **noted, future**.
STILL UNANSWERED: whether the dock full-view should be gated by `?shell=1` (it is not today).

NEW OWNER ITEM: **the dx7 face looks nothing like its mock**, and the mock was produced as part of this
process — needs revisiting. Known gap: the mock's OP1-6 pages need ~78 new params, i.e. a MODULE REWORK
rather than a face. The mocks themselves were lost in the crash (they lived in a wiped scratchpad), so
regenerate/recover them first. Remember `.myrobots/` is GITIGNORED — nothing there is backed up.
