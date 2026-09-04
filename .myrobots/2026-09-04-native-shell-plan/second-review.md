# Second independent review — native Chromium shell plan

**Date:** 2026-09-03. Fresh-eyes pass over the `plan.md` + `build-brief.md` in this
directory, as they stood on 2026-09-03. **Status: ⚠ EVIDENCE, NOT INSTRUCTION.**
Read-only review; no commits, no PRs.

> ### ⚠ HISTORICAL — read the reconciled body, not this file, for current state
>
> Written 2026-09-03 against copies then living in
> `.myrobots/2026-09-03-native-chromium/` — a byte-identical duplicate package, since
> deleted. This file was its only unique content and was moved here.
>
> **Its CONFIRMED issues 1, 4 and 5 were correct, and were then ignored for a day**
> while the owner answers were appended to `build-brief.md` without touching the body
> those issues named. They are now folded in (2026-09-04): issue 1 → **P6a is HELD**;
> issue 4 → **crossfade is MANDATORY**, options in
> [crossfade-options.md](crossfade-options.md); issue 5 → **the lane GATES, kept
> light**, specified at `build-brief.md` §4.1. Do not re-litigate them here — read
> the body.
>
> The answer-integration scorecard below is a 2026-09-03 snapshot and is stale by
> design. The lesson it taught is now rule 4 of the document contract at the top of
> `build-brief.md`: **FOLD, NEVER APPEND.**
Method: every finding below was verified against origin/main, `feat/legacy-removal`, or the
sibling repos on disk — file:line or command evidence cited. Appendix-A refuted items were
not re-litigated.

---

## CONFIRMED issues

### 1. Owner answer 7 contradicts the brief's build order on P6a — do not start P6a

The recorded binding answer reads "P6 strictly after S4". The brief's §1 order table row 5
starts "P6a — off-branch continuity hardening … now, parallel". The plan proposed the
P6a/P6b split inside Q13, but the answer's text neither names P6a nor acknowledges the
split — under the read-the-card-never-the-why discipline the owner's words say ALL of P6
waits for S4. Two readings exist; the brief silently picked the favorable one. One word
from the owner resolves it; until then P6a is not authorized to start.

### 2. The cliprec program is invisible to the plan and is actively merging into P6a/P4 seams

The plan's staged-parallel overlap analysis was run against the legacy-removal inventory
ONLY (review C4/C1). Meanwhile on origin/main THIS WEEK: #2332 (clip media store: OPFS
chunked writes), #2335 (pre-board tap, record band, MON duck), #2339 (POST FADER + MASTER
taps wired), #2340 (recorder worklet, eight lanes). The cliprec spec
(`.myrobots/2026-09-02-mixmstrs-multitrack-clip-recording/spec.md`) explicitly studies and
builds on recorderbox capture/quality/OPFS files (`recorderbox-capture.ts`,
`recorderbox-capture-drain.ts`, `recorderbox-store.ts`, quality ladder) — the exact files
P6a rewrites (OffscreenCanvas worker capture, save-path off-main) — and its stated
follow-up records VIDEO clips "saved from a connected output", which is P4's surface.
Additionally PH's AudioWorklet min-RMS instrument taps the master — cliprec just landed a
master/post-fader tap roster (#2339); design the instrument aware of it (reuse candidate,
or a double-tap conflict). The plan needs a cliprec coordination gate on P6a, P4, and PH;
none exists. This also compounds issue 1: even an owner-approved P6a-now is not "zero
overlap" any more.

### 3. The staged-parallel gates reference milestones that are NOT on main — P1/P4 start dates are overstated

Verified: `git merge-base --is-ancestor 8e1b705e6 origin/main` → NOT an ancestor
(8e1b705e6 = S1.5 close, where S2 begins); `HeadlessSourceHost` still present on
origin/main (`input-device.svelte.ts` et al.) — S1's producer extractions have not landed;
`feat/legacy-removal` is 41 commits ahead of main. Consequences:

- Owner gate "P1 after legacy S1 reaches main" is unsatisfied and has no near date unless
  legacy-removal merges incrementally. The plan's "P1 product code can start within days"
  rested on legacy-plan Q10 (S1 as ordinary main PRs) — which visibly has not happened.
- The P1 fixture-churn window "EITHER before S2 begins OR after S4" is now HALF-CLOSED:
  S2 began (fixture flip = S2 commit 1, DONE on the branch). Only the after-S4 window
  remains. P1's DoD includes the fixture pass, so P1 cannot reach web prod before the
  branch's S4 merge regardless of when its product code starts.
- Owner gate "P4 after the S2 fixture flip" only means anything once the flip is ON MAIN;
  if the branch merges as one unit, P4's real gate ≈ the whole branch.
- P1's fixture pricing (295 `seed=none` specs, 243 `rack` importers) was measured against
  pre-flip main. The S2 ledger shows the denominators and the selector idiom changed
  wholesale (553 spec files; `rackLegacy` alias; `:has([data-shell-type])` recipes;
  per-type node classes match NOTHING on the default shell). Re-derive before the fixture
  pass, and write P1's slot specs shell-agnostic from day one
  (`.svelte-flow__node[data-id="slot:cam1"]`-style), or they join the inversion queue.

### 4. Click-free crossfade (answer 6) has no owning phase and the contract still contradicts it

Plan §3.1 row 1 and Q15 call the crossfade "optional"; the brief's matrix row "load patch
(different ids)" still reads "*content dip allowed*". The answer makes it REQUIRED, and it
is the largest unpriced architectural item in the program: under the one-transaction
clear+insert (`persistence.ts` clears unconditionally; async factories rebuild silently),
a crossfade needs the OUTGOING audio graph to keep rendering past the Y.Doc swap
(deferred-teardown/graveyard in the reconciler — the #2321 seam) or a master-bus
capture-hold. It interacts with the RMS instrument (row 2's assertion must tighten from
"content dip allowed" to "crossfade envelope only") and with the ES-9 single-client socket
(both graphs must share the slot session — no re-dial). No phase owns this work and no
design exists. Needs: an owner clarification of semantics (see decisions below), a spike,
a phase assignment (P1-adjacent), and a price.

### 5. The GATING-light lane (answer 3) invalidates §7's framing; required-path constraints are unwritten

Plan §7 and the brief still say NON-REQUIRED dispatch job only, "zero PR-lane delta", and
price 30–35 min on the assumption of a separate workflow re-paying full setup ("e2e-preview
artifact not reusable across workflows"). A REQUIRED job lives in `ci.yml`, where the
`needs: dsp-build` artifact-download pattern applies — the cross-workflow objection
dissolves and the pricing must be redone (likely well under the 30–35 min figure for a
boot-only subset). What a required lane changes, none of it yet in the plan:

- **Split the lane:** required subset = boot-determinism family ONLY (shell boots, `/rack`
  paints, expected content, zero pageerrors/prompts; post-P1 add 8-slots-present). The RMS
  instrument, helper SIGKILL/supervision specs, continuity matrix, and anything
  timing-shaped stay dispatch-only — a required check under the no-flake-tolerance +
  PR-runs-go-red-on-recovered-flakes regime has an effective retry budget of ZERO.
- **Electron binary must be cached** in the runner (a network fetch inside a required
  check is a standing flake source).
- **Authorization chain must be written down:** adding the check to the `ci` umbrella's
  `needs:` list is exactly what the 2026-08-23 no-CI-changes ruling forbids; answer 3 IS
  the owner authorization, but unless the plan records that chain an executing agent will
  (correctly) refuse.
- **Lane membership:** desktop specs live in `apps/desktop`, outside `e2e/tests` — no
  existing lane globs them (the spec-filename-decides-lane class). The new job must
  enumerate them explicitly or they run nowhere, green forever.

### 6. Signing "reuse" (answer 4) is thinner than the answer assumes

Verified on disk: `../doom_viz` has NO discoverable signing/notarization config (grep over
build/scripts/plists: nothing). `../p10entrancer` is an Xcode APP-STORE export —
`ExportOptions.plist`: `method=app-store`, `signingStyle=automatic`, team `PHY35R5456` —
not a Developer ID + notarytool pipeline, and not portable to electron-builder. What is
genuinely reusable is the Apple Developer TEAM (enrollment done — that half of Q10 is
answered). P7 still builds the Developer-ID/notarization pipeline from scratch.
Opportunity the plan misses: probe EARLY (P2) whether a Developer ID Application cert
already exists in that team — if yes, sign interim builds from day one and the whole
per-rebuild TCC re-grant pain (§1.4 runbook note) disappears.

### 7. Answer 2's artifact sweep was not integrated — the vendoring step misses real artifacts

The plan vendors only `../scratch/start_edge.sh` + `edge_defaults.sh`. Found by this
review, per the owner's instruction to search scratch and recently touched folders:

- **`../patchtogether.browser/` (NOT a git repo — same single-point-of-loss class es9
  was):** `tier0-edge-policy.sh` — root Managed-Preferences Edge policy granting
  `AutomaticFullscreenAllowedForUrls` AND `PopupsAllowedForUrls`, newer (2026-08-26
  measurements) and broader than `edge_defaults.sh`, with a documented trap ("`defaults
  write` to Managed Preferences exits 0 and writes NOTHING") — the actual
  per-projector-click killer for the still-supported browser path. Plus `probe/`.
- `../scratch/ptzcam-research.md` — PTZ-via-UVC research (pan/tilt/zoom through
  `getUserMedia` constraints; a NexiGo P610 may need no pt-ptz at all) — feeds P5's
  camera panel design.
- `../es9scratch/ES9-standalone-mixer-setup.md` — sweep into docs or the es9 repo.
- `../scratch/start_ptz.sh` is byte-identical to `tools/pt-ptz/start_ptz.sh` (verified
  by diff) — no loss there.

### 8. P0 is mid-flight with staged-uncommitted work and two records missing

Both helper repos hold STAGED, uncommitted work (es9: `M .gitignore`, `A LICENSE`;
nativeapps: entire initial tree staged incl. LICENSE + CLAUDE.md). Missing before push:
(a) no evidence the es9 `git bundle` backup ran (plan step 1, "FIRST"); (b) no secrets-gate
record exists in `.myrobots/` (the gate requires the record CREATED at push time). Also:
the staged es9 LICENSE reads "Copyright (c) 2026 2600hz-oscillator" — the answers ruled
MIT/public but never named the org or the copyright-holder string; and
`nativeapps/docs/vst-bridge-design.md` §6 still says "Repo license intentionally unset …
If it ends up AGPL…" — stale prose that should be corrected on the way public.

---

## Narrowings / reinterpretations of the owner's words

- **"Boots to a pre-flight UI"** — the pre-flight is build-order slot 8 of 10 (P5, after
  P4). For most of the program the shell boots straight into the rack. Defensible staging,
  but the owner's most visible goal-2 deliverable arrives near the end; say so out loud.
- **"e2e … proving harness + device connections"** — no verbatim record of this clause
  exists in `.myrobots/` (the spec records only "whether an Electron-launched e2e lane
  should EXIST is an owner decision"). Answer 3 then limited the REQUIRED path to "boots
  and loads expected content; nothing more" — meaning device-connection proof lives only
  in the non-required dispatch tier. If answer 3 was given with that consequence in view,
  fine; the plan should state it plainly rather than leave "proving device connections"
  implicitly demoted.
- **Goal 5 "never even temporarily disrupt output"** — narrowed to graph-tap verification
  plus owner ears for device-level continuity. This narrowing is honest and STATED
  (plan §3); carried correctly.
- **"As submodules"** — the plan keeps the A4 vendoring alternative alive via Q4; the
  answers ratified neither. The directive's verbatim word is submodules; the vendoring
  alternative is dead unless the owner re-opens it. Execute P0 with submodules.
- **Slot placement, device list, save/load, full-Chromium-control** — no narrowing found;
  §2.1 placement matches the directive, the matrix covers the named device families,
  Electron re-affirmation is well-argued and the MidiMacUmp/display-media flags are a
  genuine catch by the first ecosystem.

## Answer-integration scorecard

| answer | integrated? |
|---|---|
| 1 public MIT, backup+push approved | Partially — plan §4 still says "presumably private"; gate must be re-run at the PUBLIC bar (it passes: see below); copyright holder/org string never ruled (issue 8) |
| 2 search scratch + touched folders | NOT integrated (issue 7) |
| 3 GATING-light lane | NOT integrated (issue 5) |
| 4 signing reuse | NOT integrated, and partially false-premised (issue 6) |
| 5 slots web-too | Integrated (plan already recommended it) |
| 6 click-free crossfade | NOT integrated (issue 4) |
| 7 staged-parallel + gates | Integrated in words; gates don't match program reality today (issues 1–3) |

## Positive verifications (so nobody re-checks)

- es9 commit authors are the placeholder `2600hz timmy <2600hz@127.0.0.1>` — no real
  email in history; all 5 commit messages clean (no profanity — GitHub ruling safe).
- Tracked trees of BOTH repos grep-clean for `/Users/`, gmail, password/key patterns.
- nativeapps hosts plugins via Apple's public AU API — **no VST3 SDK, no JUCE** — MIT is
  legally clean for public release (its own design doc §6 confirms "no SDK obligations").
- `packages/web/_headers` = COOP `same-origin` + COEP `credentialless` exactly as §1.4 claims.
- `graph/duplicate.ts` has zero pinned/undeletable guards (M3/B3 claim true).
- Exactly ONE product caller of `loadEnvelopeIntoStore` — `Canvas.svelte:176` (claim true).
- `tools/pt-ptz/` tracked in-tree (5 files); `scratch/start_ptz.sh` identical to tree copy.
- No `.gitmodules`; no workflow passes `submodules:` to checkout — web CI is untouched by
  a submodule add, by construction.
- Root `package.json` workspaces has no `apps/*` — P2's `apps/desktop` needs a root
  package.json edit (another shared-file coordination point beside `Taskfile.yml`).

---

## P0 verdict: GO — with conditions

Publication of the two helper repos as public MIT is safe TODAY on the evidence: clean
histories, placeholder author emails, no third-party SDK exposure, clean messages.
Conditions, in order:

1. Run the es9 `git bundle` backup FIRST (approved, not yet evidenced).
2. Get one line from the owner: GitHub org + copyright-holder string (staged LICENSE says
   "2600hz-oscillator" — unconfirmed).
3. Fix the stale license prose in `nativeapps/docs/vst-bridge-design.md` in the initial
   commit (prose must not contradict the ruled MIT).
4. Run the secrets gate at the PUBLIC bar and CREATE the `.myrobots/` record at push time
   (none exists yet).
5. Extend the P0 sweep with issue 7's artifacts (`tier0-edge-policy.sh` + `probe/`,
   `ptzcam-research.md`, es9scratch doc).
6. Submodules at `apps/helpers/*` per the directive verbatim; vendoring alternative dead.
   `Taskfile.yml` (helpers:build) is the one legacy-branch shared file — coordinate.

Everything in P0 that does NOT touch pushes (backup, gate run, doc fixes, Taskfile target,
Edge/browser-artifact vendoring into this repo) can proceed immediately.

## Decisions the owner should make that are NOT in the questions list

1. **P6a now vs "P6 strictly after S4"** (issue 1) — one word.
2. **Legacy-removal merge cadence** — incremental S1-to-main vs one branch merge; it now
   sets P1/P4's start dates (issue 3).
3. **Cliprec coordination** — who owns the recorderbox-adjacent capture/save seams while
   both programs are live, and whether PH's RMS instrument reuses cliprec's new master
   tap (issue 2).
4. **Crossfade semantics** (issue 4) — true overlap-crossfade (old graph keeps rendering
   while the new builds: heavy, reconciler-core) vs fade-out → build → fade-in
   (click-free but briefly quiet: cheap). The four words in answer 6 don't choose, and
   the cost difference is roughly an order of magnitude.
5. **Sign interim builds now?** If a Developer ID cert exists under team PHY35R5456,
   early signing deletes the TCC re-grant churn (issue 6).
6. **Org + copyright string** for the public repos (issue 8 / P0 condition 2).
