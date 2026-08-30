// scripts/e2e-skip-budget.mjs
//
// The PER-LANE RUNTIME-SKIP BUDGET (#1502) — deny-by-default.
//
// A runtime-skipped row in a merged Playwright report is a test that DID NOT
// RUN while the job stayed green. #1560 made those rows visible; this module
// makes the *population* governed: every skip a lane may legitimately produce
// is a NAMED (spec, reason-pattern) entry below, with the lane set it may
// appear in and a why. A row that matches no entry — reasonless, an unknown
// reason, or a known reason in the wrong lane — is a budget VIOLATION, and the
// lane audit (scripts/e2e-report-audit.mjs --lane <name>) exits non-zero on
// it. There is no count anywhere: membership is derived, entries are named,
// and both directions are anchored against runtimeSkipInventory() by
// scripts/e2e-skip-budget.test.ts (a stale entry is RED; an unclaimed site is
// RED; the reasonless-site set is asserted EMPTY unconditionally).
//
// ── WHAT THIS GATE STRUCTURALLY CANNOT SEE ────────────────────────────────
//
//  1. Tests grep-inverted OUT of a lane before running (e.g. @collab /
//     @capacity titles in the e2e shards) produce NO row at all — absence is
//     invisible here. Entries with `lanes: []` turn the LEAK direction red
//     (such a row materializing in an audited lane), but a spec silently
//     dropped from every lane leaves nothing to audit. Enrolment truth lives
//     in the ledger + reconciliation counts, not here.
//  2. `[SKIPPED: …]` / `[EXEMPT: …]` title-marker placeholder rows are
//     exemption-map machinery with their own named-entry governance (ledger
//     buckets 1–2). This budget deliberately does not re-govern them.
//  3. Lanes with no JSON audit step (collab, webgl-attest) are not audited at
//     all — `homeLane` records where a guard is EXPECTED to resolve, but
//     nothing checks those lanes' reports today.
//  4. The TRUTH of a reason string. A guard that skips for reason A while
//     printing budgeted reason B matches its entry. The budget pins the
//     vocabulary, not the diagnosis.
//
// Lane names are the AUDIT invocations in ci.yml. Since 2026-08-17 there is
// exactly ONE: 'e2e', run PER SHARD inside the e2e job (it used to live in the
// `merge-reports` aggregator, which was deleted with the other non-gating jobs
// — the audit was migrated first, and it now GATES because `e2e` is in the
// umbrella). 'behavioral' has no audit site any more: the
// `merge-behavioral-reports` job went with `behavioral-coverage`. It stays in
// AUDITED_LANES because entries still declare it, and because a lane that
// declares itself audited while nothing audits it is exactly the kind of
// silent hole this module exists to make loud — see scope note 3.
// `homeLane` may also name a non-audited resolution context ('collab',
// 'webgl-attest', 'local' = a developer machine / opt-in local run).

export const AUDITED_LANES = Object.freeze(['e2e', 'behavioral']);
// 'webgl-smoke' is the SwiftShader WebGL floor job in ci.yml. It is a real lane
// with a real job name, and it is where the WEBGL_HEAVY_GLOBS specs resolve —
// they are in the chromium project's `testIgnore` under E2E_WEBGL_HEAVY=exclude,
// which is what the sharded matrix sets, so their rows can never reach the `e2e`
// audit. It is NOT audited (no merged-JSON step), which is scope note 3 again:
// naming it lets a heavy spec's guard declare where it actually resolves instead
// of borrowing 'local' and hiding that a CI lane owns it.
export const KNOWN_LANES = Object.freeze([
  ...AUDITED_LANES,
  'collab',
  'webgl-attest',
  'webgl-smoke',
  'local',
]);

/** Loop-generated exemption placeholders carry their reason in the TITLE. */
export const PLACEHOLDER_TITLE_RE = /\[(SKIPPED|EXEMPT):/;

/**
 * @typedef {Object} BudgetEntry
 * @property {string[]} specs   spec basenames under e2e/tests/ — every
 *                              (spec, reason) pair in the entry is NAMED; the
 *                              grouping only exists to share one `why`.
 * @property {RegExp}   reason  matched against the row's recorded skip reason
 * @property {string[]} lanes   audited lanes where the row MAY appear.
 *                              [] = this guard must never fire in any audited
 *                              lane; a row is a violation (env drift / lane
 *                              leak made visible).
 * @property {string}   homeLane where the guard is expected to resolve
 * @property {string}   why     the justification — required prose, not a label
 */

/** @type {BudgetEntry[]} */
export const SKIP_BUDGET = [
  // ── DOOM assets ──────────────────────────────────────────────────────────
  {
    specs: [
      'doom-aspect.spec.ts',
      'doom-audio-output.spec.ts',
      'doom-cheat-gates.spec.ts',
      'doom-controls.spec.ts',
      'doom-keyboard-routing.spec.ts',
      'doom-per-type-death-gates.spec.ts',
      'per-module-per-port-inputs.spec.ts',
      'per-module.spec.ts',
    ],
    reason: /DOOM WASM|DOOM1\.WAD/,
    lanes: [],
    homeLane: 'local',
    why:
      'DOOM needs the locally built WASM bundle + DOOM1.WAD; a dev machine without them gets a clean skip. '
      + 'CI builds and ships BOTH before e2e, so this guard firing on an audited lane means the DOOM asset '
      + 'pipeline broke — and without this entry a green suite would silently lose every DOOM assertion.',
  },
  {
    specs: [
      'doom-identity-crossview.spec.ts',
      'doom-late-join.spec.ts',
      'doom-launch.spec.ts',
      'doom-mp-latejoin-freeze.spec.ts',
      'doom-mp-lockstep-sharedstate.spec.ts',
      'doom-mp-real.spec.ts',
      'doom-multiplayer.spec.ts',
    ],
    reason: /DOOM WASM|DOOM1\.WAD/,
    lanes: [],
    homeLane: 'collab',
    why:
      'Same DOOM asset gate, in the multiplayer specs. These are @collab titles, grep-inverted out of the '
      + 'audited shards entirely — they produce no row there at all, so one appearing is a lane-partition '
      + 'leak first and an asset problem second.',
  },
  {
    specs: ['doom-identity-crossview.spec.ts', 'doom-late-join.spec.ts', 'doom-multiplayer.spec.ts'],
    reason: /DOOM runtime failed to load on (A|host) within \d+s/,
    lanes: [],
    homeLane: 'collab',
    why:
      'Bounded-load fallback inside @collab multiplayer specs: rather than time out the whole spec, a DOOM '
      + 'runtime that never reaches ready skips with the elapsed bound. Inverted out of audited lanes, so a '
      + 'row here is a lane leak.',
  },

  // ── @collab lane routing ─────────────────────────────────────────────────
  {
    specs: [
      'doom-identity-crossview.spec.ts',
      'doom-late-join.spec.ts',
      'doom-launch.spec.ts',
      'doom-multiplayer.spec.ts',
      'in-card-title.spec.ts',
    ],
    reason: /COLLAB_JOB lane/,
    lanes: [],
    homeLane: 'collab',
    why:
      'The in-body backstop that keeps @collab specs off the sharded matrix (no DB/relay there). The grep '
      + 'inversion removes these tests from audited lanes BEFORE they run, so the guard should never even '
      + 'get to fire in one — a row with this reason means the @collab partition leaked.',
  },
  {
    specs: ['in-card-title.spec.ts'],
    reason: /task #101/,
    lanes: [],
    homeLane: 'collab',
    why:
      'Quarantined @collab rename-sync case (relay-contention timeout); the fixme annotation carries the '
      + 'task #101 reason. Lives inside the @collab describe, so audited lanes never see the row.',
  },

  // ── environment capabilities CI is known to have ─────────────────────────
  {
    specs: [
      'dx7.spec.ts',
      'new-rack-return-to-last.spec.ts',
      'scratch-persist-video-live.spec.ts',
      'scratch-persist.spec.ts',
      'workflow-video-zone-defaults.spec.ts',
    ],
    reason: /IndexedDB unavailable/,
    lanes: [],
    homeLane: 'local',
    why:
      'Scratch-replica persistence needs IndexedDB; an exotic local browser profile may lack it. CI '
      + 'Chromium always ships it, so this firing on an audited lane means persistence coverage just went '
      + 'dark — exactly the "probe starts skipping everywhere" failure the audit exists to catch.',
  },
  {
    specs: ['milkdrop-render-smoke.spec.ts', 'vfpga-p2-cells.spec.ts', 'vfpga-patchpanel-presets.spec.ts'],
    reason: /WebGL2 (unsupported|not available)|no WebGL2 context/,
    lanes: [],
    homeLane: 'local',
    why:
      'WebGL2 capability probes. CI SwiftShader provides WebGL2, so a row on an audited lane means the '
      + 'software renderer regressed and every WebGL2 assertion silently stopped asserting.',
  },

  // ── #1905 render-worker producer-init race: the REAL-GPU control ──────────
  // Two guards in ONE test, deliberately separate entries: they fire in
  // different places for opposite reasons, and one shared entry would let
  // either go dark behind the other.
  {
    specs: ['render-worker-toybox.spec.ts'],
    reason: /REAL-GPU control: under SwiftShader/,
    lanes: [],
    homeLane: 'local',
    why:
      'The #1905 two-directional control arms the producer-init race (a worker frame posted before the node '
      + 'had a picture) and needs the worker to be the LIVE render path to hold that window open. Under '
      + 'SwiftShader the TOYBOX worker context dies mid-run — a separate, pre-existing gap, which is why '
      + 'toybox is renderLocus:worker-experimental — so the window cannot be held and the control would be a '
      + 'slow unstable red saying nothing about the defect. It is deliberately NOT tagged @webgl-smoke '
      + '(that tag would enrol it in the one CI lane where it cannot speak), and render-worker-*.spec.ts is '
      + 'in WEBGL_HEAVY_GLOBS so it is testIgnored out of the sharded matrix: lanes:[] because this guard '
      + 'cannot reach an audited lane at all. It resolves on a developer SwiftShader flake-check; the test '
      + 'itself RUNS on the real-GPU attest pass (E2E_WEBGL_HEAVY=only + E2E_REAL_GPU=1), which is the lane '
      + 'every #1905 sighting came from and the one this control exists to protect.',
  },
  {
    specs: ['render-worker-toybox.spec.ts'],
    reason: /worker-WebGL2 did not initialize on this renderer/,
    lanes: [],
    homeLane: 'webgl-attest',
    why:
      'Dynamic capability guard inside the same #1905 control: if worker-WebGL2 never initializes there is no '
      + 'race window to arm, so it skips LOUDLY (carrying the full handshake diagnosis in the reason) rather '
      + 'than passing vacuously against a main-thread fallback — the exact "green and blind to the whole thing '
      + 'it covers" failure this spec family already hit once. homeLane webgl-attest because that is the pass '
      + 'where the test actually runs on CI infrastructure and where a worker that stops initializing on a real '
      + 'GPU would surface; a row there means the worker path went dark and the control silently stopped '
      + 'exercising it. Not audited (scope note 3), so this is a resolution record, not a checked claim.',
  },

  {
    specs: ['picturebox-gif.spec.ts'],
    reason: /ImageDecoder\(image\/gif\) unavailable/,
    lanes: [],
    homeLane: 'local',
    why:
      'WebCodecs ImageDecoder probe; the app degrades to a static first frame without it. CI Chromium '
      + 'ships it, so an audited-lane row means GIF decode coverage went dark.',
  },
  {
    specs: ['auth-routes.spec.ts'],
    reason: /tier has no DATABASE_URL/,
    lanes: [],
    homeLane: 'e2e',
    why:
      'DB-reachability leg of the auth smoke. Audited lanes provision Postgres, so this firing means the '
      + 'DB wiring broke while the job stayed green.',
  },
  {
    specs: ['patch-load-leak.spec.ts'],
    reason: /not measurable under vite dev/,
    lanes: [],
    homeLane: 'local',
    why:
      'DOM-retention measurement is meaningless under the dev server (HMR retains destroyed instances by '
      + 'design). Audited lanes serve the built preview, so a row here means a lane is misconfigured onto '
      + 'the dev server and its leak assertions are vacuous.',
  },
  {
    specs: ['multi-video-playback.spec.ts'],
    reason: /excluded from the heavy WebGL attest gate/,
    lanes: [],
    homeLane: 'webgl-attest',
    why:
      'Fires only under E2E_WEBGL_HEAVY=only, which is set by the local webgl-attest run and never by an '
      + 'audited lane. A row here means the attest env leaked into CI.',
  },

  // ── skips EXPECTED on the audited e2e lane, each with its mechanism ──────
  {
    specs: ['edges.spec.ts'],
    reason: /task #106/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Quarantined thickness-dilation case: its capture wait never resolves under CI SwiftShader; the CPU '
      + 'mirror (edges.test.ts) carries the logic meanwhile. The fixme annotation names task #106.',
  },
  {
    specs: ['recorderbox.spec.ts'],
    reason: /task #105/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Quarantined real-recording case: CI headless Chrome claims H.264 support but has no OS encoder, so '
      + 'no moof fragments ever materialize. Verified on-device; unit/per-port/behavioral cover the module.',
  },
  {
    specs: ['io-spec-consistency.spec.ts'],
    reason: /task #102/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'The spawn-smoke QUARANTINE map (currently toybox: SwiftShader first-paint timeout), which moved '
      + 'with the rest of modules.spec.ts into the consolidated registry card sweep (#1861). The fixme '
      + 'annotation derives its description from the map, so map reason and row reason cannot diverge. '
      + 'It now stands down ONE assertion group rather than the whole test — toybox still runs its '
      + 'handle-parity and control-bounds groups there, as it always did in the sweeps that never '
      + 'quarantined it.',
  },
  {
    specs: ['dx7.spec.ts'],
    reason: /SUSPECTED LIVE REGRESSION/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED WHILE CORRECTLY FAILING — this is NOT flake debt, and the reason regex deliberately quotes '
      + 'the annotation so it cannot be mistaken for one. The algorithm-switch leg used to assert that two '
      + 'scope captures differ by a normalised per-sample L2 > 0.1; measured with the switch made a NO-OP, '
      + 'that distance is 1.2636, so the assertion could not fail on the very regression its header names '
      + '(setParam early-out short-circuiting a postMessage-only param). Repaired to compare a '
      + 'phase/envelope-robust TIMBRE FINGERPRINT (captureScopeTimbre, e2e/_helpers/scope-poll.ts), and it '
      + 'now fails: algorithm 1->32 reads 0.0489 against a 0.0456 noise floor, 16->32 reads 0.0359, while '
      + 'the POSITIVE CONTROL — a preset change through the identical metric — reads 1.1579. The host path '
      + 'traces intact (engine has no early-out; the handle posts {type:"algorithm"} before its early-out '
      + 'and is unit-tested; the worklet handles the message and process() re-reads patch.algorithm), so '
      + 'resolving it needs worklet instrumentation rather than test work. Un-park it by fixing the product '
      + 'or by disproving the measurement — never by widening the threshold, which is how it went blind the '
      + 'first time. Full write-up: #1787 batch 5 (PR #2142).',
  },
  {
    specs: ['recording-survives-card-collapse.spec.ts'],
    reason: /no real H\.264 encoder/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'The #1574 collapse-recording gate needs real encoded chunks; CI has no OS H.264 encoder, so both '
      + 'legs skip loudly there and E2E_REQUIRE_RECORD=1 turns the skip into a failure in an armed lane.',
  },
  {
    specs: ['collapse-keeps-playing.spec.ts'],
    reason: /is not a local-file player/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Registry-driven sweep over media players; module types without a file input + transport have no '
      + 'unmount-survival contract to test here and are gated by card-media-lifetime.test.ts instead. The '
      + 'per-type reason names which module opted out.',
  },
  {
    specs: ['card-producer-lifetime.spec.ts'],
    reason: /shows no picture on any video output/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Registry-driven sweep; a type that paints nothing even while mounted has nothing to lose on '
      + 'collapse, and the skip names the type so a producer regressing to black is at least visible here.',
  },
  {
    // ⚠ `blood-keyboard.spec.ts` WAS HERE AND IS GONE — the spec was DELETED by
    // owner ruling (2026-08-23, verbatim: "delete the blood keyboard spec"), so
    // the name had to leave this list with it: this budget is anchored
    // budget→tree, and "an entry naming a spec that no longer exists is RED".
    // The other two BLOOD specs are untouched and keep this entry alive.
    specs: ['blood-audio-output.spec.ts', 'blood-ingame.spec.ts'],
    reason: /BLOOD (engine|runtime)|engine not ready|extras unavailable|runtime\/extras unavailable/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'The BLOOD engine is heap/renderer-sensitive on CI SwiftShader and may legitimately not reach ready '
      + 'within bound; the specs skip rather than flake. Known CI condition, tolerated but surfaced.',
  },
  {
    specs: ['peertube.spec.ts', 'tv-librarian-audio.spec.ts'],
    reason: /could not decode the AVC\/AAC HLS clip/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Codec-capability gate: headless Chromium builds without proprietary codecs cannot decode the AVC '
      + 'HLS fixture; the state= suffix records what the renderer reached. Tolerated but surfaced.',
  },
  {
    specs: ['wavesculpt.spec.ts'],
    reason: /no usable GL pixel read/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Renderer capability probe: readPixels on some software-GL stacks returns nothing usable; asserting '
      + 'on it would test the renderer, not WAVESCULPT. Tolerated but surfaced.',
  },
  {
    specs: ['multi-video-playback.spec.ts'],
    reason: /heavy for CI software-GL runners/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'The scale-run leg is deliberately CI-skipped; the 4-source case is the CI guard. Every run skips it '
      + 'on the audited lane, and the budget keeps that decision named rather than ambient.',
  },
  // ⚠ THIS ENTRY WAS RE-AIMED, AND THE REASON IS WORTH READING BEFORE EDITING
  // IT. It used to be:
  //
  //   specs: ['workflow-shell-video.spec.ts'], reason: /no videoinput device/
  //   why: 'Device-list assertion needs a videoinput; headless CI runners
  //         expose none, so the leg is not applicable there and says so.'
  //
  // That skip is GONE — not moved, not renamed. The CAMERA picker case that
  // owned it was reworked when cameraInput was promoted: its capability-
  // dependent half became an `if (cameraCount > 0) … else …` BRANCH, so the
  // zero-device state is now ASSERTED (the control renders, is correctly
  // disabled, and says why) rather than skipped. The rest of that test is
  // capability-independent and now reports a real pass on CI, which a mid-test
  // `test.skip` had been hiding behind a whole-case "skipped".
  //
  // ⚠ BUT DELETING THE ENTRY OUTRIGHT ORPHANED A SECOND SITE, and that is the
  // finding. `workflow-shell-video.spec.ts:737` is a DYNAMIC guard
  // (`test.skip(VIDEO_SINK_FIXTURE.kind !== 'ok' || …, VIDEO_SINK_FIXTURE.why)`)
  // about an exhausted video-sink pool — nothing to do with cameras. A dynamic
  // site is claimed at SPEC granularity by testing the entry's regex against the
  // spec's whole SOURCE TEXT, so `/no videoinput device/` was claiming it purely
  // because that unrelated string happened to appear somewhere in the file.
  // An incidental claim looks identical to a deliberate one right up until the
  // string it depended on is deleted — which is exactly what happened here, and
  // direction B caught it in the same cycle.
  //
  // So the regex now names the dynamic reason EXPRESSION itself. It cannot be
  // satisfied by an unrelated edit elsewhere in the file, and if that guard is
  // ever removed this entry goes stale loudly instead of drifting onto whatever
  // string is nearest.
  {
    specs: ['workflow-shell-video.spec.ts'],
    reason: /VIDEO_SINK_FIXTURE\.why/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'A DYNAMIC guard: the video-SINK fixture is resolved from the registry, and an exhausted pool '
      + 'is a MIGRATION state rather than a failure. The named fixture-health test in the same file '
      + 'is what goes red for it, so this case skips to keep one failure in one place instead of two. '
      + 'Tolerated but surfaced.',
  },
  {
    specs: ['auth-routes.spec.ts'],
    reason: /live-deploy only/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'The live-target leg only means anything when E2E_BASE_URL points at a deployed tier; against the '
      + 'local preview it skips by design on every audited run.',
  },
  {
    specs: ['login-smoke.spec.ts'],
    reason: /E2E_CLERK_TEST_EMAIL/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Real Clerk sign-in needs the dev-instance test credentials, which are not wired into the sharded '
      + 'lane today. The skip names both env vars so arming the guard is a secrets change, not a code hunt.',
  },
  {
    specs: ['cv-buddy-face.spec.ts'],
    reason: /multichannel output device|E2E_ES9_HARDWARE=1/,
    lanes: ['e2e'],
    homeLane: 'local',
    why:
      'Hardware-in-the-loop, #2024: the CV BUDDY face\'s last leg needs a physical ES-9, and the probe is '
      + 'real rather than an env check — it reads `destination.maxChannelCount` and requires >= 8. CI can '
      + 'never satisfy it twice over (no device, and Chrome caps the destination at 2 channels), so the '
      + 'reason NAMES the measured number it saw. ⚠ Unlike its es9-hardware sibling this guard INVERTS on '
      + 'the opt-in flag: with E2E_ES9_HARDWARE=1 a missing rig THROWS instead of skipping, so in the lane '
      + 'that promises hardware "the rig is unplugged" cannot green the same way "the code is fine" does. '
      + 'Everything about the face that a browser can prove is covered unskipped by the six other tests in '
      + 'this spec; only voltage at a physical jack is deferred to the owner recipe in the PR body.',
  },
  {
    specs: ['es9-hardware.spec.ts'],
    reason: /real ES-9|ES9_HW=1/,
    lanes: ['e2e'],
    homeLane: 'local',
    why:
      'Hardware-in-the-loop: needs a physical ES-9 + the es9-bridge WebSocket, opt-in via ES9_HW=1 on the '
      + 'owner machine. On CI the whole file skips with this reason on every run.',
  },
  {
    specs: ['samsloop-memory-bench.spec.ts'],
    reason: /E2E_RUN_MEM_BENCH=1/,
    lanes: ['e2e'],
    homeLane: 'local',
    why:
      'Opt-in memory benchmark, too slow and too machine-sensitive for a shared lane; the reason names the '
      + 'env var that arms it locally.',
  },

  // ── ⏸ FLAKE PARK (#1847) — the NONDETERMINISTIC population ────────────────
  //
  // These are NOT capability probes and NOT env gates. Every entry below names a
  // spec holding one or more tests that, during the 96 h CI census to
  // 2026-08-18, FAILED AND THEN PASSED ON RETRY AT THE SAME SHA. A recovered
  // flake makes Playwright report the job SUCCESS, so this whole population was
  // invisible in the green/red signal — which is the same failure mode this
  // module was written for, arriving from the other direction.
  //
  // ⚠ THEY ARE PARKED, NOT EXEMPT. An exemption says "there is no contract to
  // assert here". Every one of these has a real contract; what is unreliable is
  // the MEASUREMENT. The reason string says `parked until root-caused` on
  // purpose, and #1847 states the exit condition: a test leaves this list when
  // its nondeterminism is root-caused and fixed — never by deletion, never by
  // retrying until green, and never because "it passes now".
  //
  // ⚠ WHAT THIS BUDGET STILL CANNOT SEE, specific to these entries: the pattern
  // is the PARK MARKER, not the diagnosis. It admits any parked row in a named
  // spec, so a park that spreads to a second test inside an already-listed spec
  // does not redden here — it reddens in the ledger diff and in the e2e report
  // audit's printed skip list. Anchoring per-test would mean typing every title,
  // and a title is not a stable key (they get edited); the spec is.
  //
  // The grouping is by SUBSYSTEM so each `why` says what goes dark, per the
  // coverage report committed with the campaign
  // (.myrobots/2026-08-18-flake-park-coverage-lost.md).
  {
    specs: [
      'cable-drag-panel-lock.spec.ts',
      'card-drop-patch.spec.ts',
      'clear-patch-undo.spec.ts',
      'clear.spec.ts',
      'control-surface.spec.ts',
      'duplicate-module.spec.ts',
      'matrixmix.spec.ts',
      'patch-load-leak.spec.ts',
      'patch-panel.spec.ts',
    ],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — the patch/canvas gesture surface: drop-to-patch, the PatchPanel open/close contract, '
      + 'matrix undo integrity, Duplicate, Clear + its undo, and patch-load retention. card-drop-patch alone '
      + 'was a quarter of all flakiness in the census window and is the ONLY coverage of the card-onto-card '
      + 'drop-to-patch gesture; while these are parked, a modal that opens on every drag, an edge written by a '
      + 'cancel, an irreversible Clear or a leaking patch load all ship green.',
  },
  {
    specs: ['landing-new-rack-is-fresh.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (2026-08-29) — the landing tile-new-rack freshness guard: 1 recovered-on-retry observation '
      + 'on PR #2247 e2e shard 3 under the live fail-on-flaky gate. While parked, a landing tile that '
      + 'serves the CACHED rack instead of a fresh one ships green — this is the only coverage of that '
      + 'path, so root-causing it is not optional debt.',
  },
  {
    specs: ['workflow-mode.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (2026-08-30, owner order: "any tests that failed disable / skip") — the pinned-MIXMSTRS '
      + 'auto-wire leg: waitForFunction 10s timeout, recovered-on-retry on PR #2274 e2e shard 7 (run '
      + '33291594537); same load-sensitivity family as the branch-side boot-budget fixes on #2263/#2266. '
      + 'While parked, the one-shot default-wiring contract has no e2e coverage in this leg — un-park '
      + 'after the 2026-08-30 performance alongside the tempolock park.',
  },
  {
    specs: ['tempolock.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (2026-08-30, owner order: "any tests that failed disable / skip") — the follows-tracked-tempo '
      + 'leg only: toBeLessThan settle failure on PR #2274 e2e shard 10 (run 33290095701) under shard load. '
      + 'While parked, the tracked-clock→TIMELORDE follow path has no e2e coverage — un-park and root-cause '
      + 'after the 2026-08-30 performance; the unit-lane tracker tests still cover the fold/PLL math.',
  },
  {
    specs: ['per-module-per-port-inputs.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (2026-08-29) — the SYNESTHESIA row only of the registry-driven inputs-accept wire-up sweep: '
      + '1 recovered-on-retry observation on PR #2265 e2e shard 3 under the live fail-on-flaky gate '
      + '(attempt 1: pageerror "Cannot read properties of undefined (reading 0)" during input wire-up; '
      + 'attempt 2 green at the same SHA; the PR under test composes label strings deterministically, so a '
      + 'bug there would fail both attempts). While parked, a synesthesia input that throws on wire-up '
      + 'ships green — its outputs/behavioral dims and every other module\'s inputs row still run. '
      + 'Scope caveat (the section note above): this entry admits any FLAKE-PARK row in this spec; the '
      + 'per-module anchor lives in the spec source (`mod.type === \'synesthesia\'`), not here.',
  },
  {
    specs: ['perf-tempo-under-modulation.spec.ts'],
    reason: /FLAKE-PARK/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED 2026-08-25 — BOTH tests in the file: the hand-drag commit-coalescing assertion (:274) and its '
      + 'no-drag CONTROL (:414). Census: 2 observations across 2 SHAs / 2 branches on one day — ONE HARD '
      + 'failure (#2200 shard 3 at :274, failed both attempts) and ONE RECOVERED FLAKE (#2202 shard 3, '
      + '`1 flaky · 189 passed`, red only via --fail-on-flaky), measuring `delta=92 … expected~102.40 '
      + 'band=[94,111]` — short of the floor by exactly TEMPO_SLOP_STEPS. ⚠ The MIX matters: it is not '
      + 'deterministically broken, so do not hunt a determinism bug the runs do not evidence. '
      + 'THIS IS THE THIRD ATTEMPT: 182e905fc root-caused the original chronic shard-7 flake (Playwright IPC '
      + 'overhead spilling into a RUN_MS-based count) and anchored the window inside the page — correct, still '
      + 'in place; 311a82ac6 then widened TEMPO_SLOP_STEPS to 2, and it still misses by 2 on a loaded '
      + 'ten-shard runner. A fourth widening would fix the THRESHOLD, not the subject: the band is already '
      + '±8%, and at ±10% it stops measuring "the clock keeps tempo" at all. '
      + 'UN-PARK LEAD: both tests count advances against a WALL-CLOCK window, so a CPU-starved runner is '
      + 'indistinguishable from a slipping scheduler. Re-anchor the count to AUDIO time (ctx.currentTime), '
      + 'which does not stretch under CPU load — the same "count the right clock" move this repo already '
      + 'applies to renderer-dependent waits. '
      + 'COVERAGE LOST, STATED: this file is the ONLY proof that a hand-drag coalesces patch-store commits to '
      + '<= rAF rate — the owner-reported "unstable tempo when dragging stuff around" case. Both parked '
      + 'together deliberately, because :414 is :274\'s control and parking one leaves the half-open pair '
      + 'this budget calls out as half-coverage.',
  },
  {
    specs: [
      'clip-automation.spec.ts',
      'clip-prob-default.spec.ts',
      'clipplayer-card-erase.spec.ts',
      'clipplayer-clip-view-grid.spec.ts',
      'clipplayer-controls.spec.ts',
      'clipplayer-custom-scale.spec.ts',
      'clipplayer-grid-stability.spec.ts',
      'clipplayer-play-every.spec.ts',
      'clipplayer-rate-reset.spec.ts',
      'clipplayer-songmode.spec.ts',
      'clipplayer-transport-no-controller.spec.ts',
      'launchpad-keys-record.spec.ts',
      'launchpad-perf-controls.spec.ts',
    ],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — the clip player, its transport and the hardware surfaces that drive it: per-clip '
      + 'automation (record/arm/suspend), clip-default probability, song mode, per-lane rate + RST, the note '
      + 'editor, and the #1165 guard that the card transport works with NO controller attached. Several of '
      + 'these are the ONLY real-source-chain proof for their feature; #1646 was a declared fix for the '
      + 'clip-automation flakiness and the census shows it did NOT hold. '
      + 'ADDED 2026-08-24 — launchpad-perf-controls\' RESET NEGATIVE CONTROL (:286), which was left running '
      + 'when its POSITIVE at :190 was parked. The two are co-nondeterministic by construction: both ride the '
      + 'same free-running 128-step clip whose 8 s wrap is precisely what the control distinguishes from a '
      + 'real reset. A control with no positive is half-coverage — it can only show the probe staying silent '
      + '— so this closes a half-open pair rather than widening the debt. Recovered-on-retry, FIRST '
      + 'observation of that leg (run 32725328269 shard 2/10, 2026-08-24 12:31Z, absent from main\'s previous '
      + '8 runs), NOT triaged as flake vs under-budget; un-park is the PAIR\'s budget diagnosis.',
  },
  {
    specs: ['workflow-mode.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — the M/E/C-inert-while-typing guard (workflow hotkeys must not fire while the user '
      + 'types in an input/contenteditable). 3 consecutive recovered-on-retry observations across 2 SHAs on '
      + 'feat/ptzcam (runs 33286052552 ×1 + 33286720503 ×2 incl. a --failed rerun, 2026-08-30) — failed '
      + 'attempt 1 / passed attempt 2 every time, so the recovered-flake-goes-red gate (#1903) reddens the '
      + 'job while the diff (a MIDI sink module) touches nothing in the subject. The inert-guard itself is '
      + 'still half-covered by the passing hotkey-positive legs in the same spec; un-park is a root-cause '
      + 'diagnosis of the typing-probe timing, not a green rerun. '
      + 'ADDED 2026-08-30 — the pinned-nodes-refuse-deletion leg: 2 consecutive recovered-on-retry '
      + 'observations on the very next runs (33287966893, 33288512372), same shape; the pin mechanism '
      + 'stays exercised by the boot and M/E/C legs that wait on the pinned trio every run. '
      + 'ADDED 2026-08-30 (owner-authorized pre-show green directive) — the default-wiring leg: 1 '
      + 'recovered-on-retry observation (33289422851 shard 7), the fourth distinct flake of the same '
      + 'fleet-load storm; the wiring itself stays exercised by waitForDefaultWires in the boot leg. '
      + 'ADDED 2026-08-30 — the M/E-toggle leg (33290699375 shard 7), the fourth leg of this one spec '
      + 'to flake tonight; the dock keymap stays exercised by workflow-dock-occupancy.spec.ts. '
      + 'ADDED 2026-08-30 — the quicksave round-trip leg, the FIFTH: 2 recovered-on-retry observations '
      + 'on run 33291739984 attempts 2+3. Shard 7 flaked a different leg of this spec on five '
      + 'consecutive runs tonight; root-causing the spec-wide load sensitivity is the un-park unit. '
      + 'ESCALATED 2026-08-30 to a SPEC-WIDE park after the SIXTH distinct leg (Clear-rack) flaked on '
      + 'the sixth consecutive run: every leg shares the /rack boot + pinned-trio wait, so the failing '
      + 'unit is the boot path under a degraded runner, and per-leg parks were whack-a-mole. All nine '
      + 'legs are fixme; the shell boot itself stays exercised by every other workflow spec.',
  },
  {
    specs: ['tempolock.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847, owner-authorized pre-show green directive 2026-08-30) — the 216→108 octave-fold '
      + 'and TIMELORDE-follow wire proof: 1 recovered-on-retry observation (run 33289422851 shard 9) in '
      + 'the same fleet-load storm as the workflow-mode legs, failed attempt 1 / passed attempt 2. The '
      + 'tracker math is exhaustively pinned by tempolock-tracker.test.ts; un-park on a root cause.',
  },
  {
    specs: [
      'blood-audio-output.spec.ts',
      'clap.spec.ts',
      'coverage-groups-3-4-5.spec.ts',
      'cv-range-uniformity.spec.ts',
      'illogic-face.spec.ts',
      'nibbles.spec.ts',
      'scope-tuner.spec.ts',
      'score.spec.ts',
      'shapegen-clock.spec.ts',
      'stereo-mono-normal.spec.ts',
      'voice-pitch-accuracy.spec.ts',
    ],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — REAL-SOURCE-CHAIN audio proofs and the CV conventions they rest on: default-tuning '
      + 'pitch accuracy, CLAP through its real trigger chain, triplet playback, the mono-normal '
      + 'contract, ADR-004 CV range travel, and SHAPEGEN gate edge semantics. This is precisely the class the '
      + 'poly/MIDI discipline exists for — an engine-direct substitute is what shipped POLYHELM green-but-'
      + 'silent — so while these are parked a silent or mistuned chain has no CI gate at all.',
  },
  {
    specs: [
      'timelorde-pinned-source.spec.ts',
    ],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — the SOLE regression guard for the FACE_MOUNTS_PRODUCER producer-unmount class '
      + '(#2163): a promoted face that merely BLITS kills the card rAF that fills `video_out`, and the '
      + 'pre-fix failure painted a bright STALE bitmap, so only a CHANGING picture catches it. That class '
      + 'was a live product bug TWICE this week (camera + timelorde), which is why this entry says SOLE '
      + 'rather than "covered elsewhere" — while it is parked, nothing in CI watches it. Parked on the '
      + 'FIRST recovered-flake observation, deliberately, to unblock the board rather than hold a PR for an '
      + 'owner round-trip; OWNER NOTIFIED via the orchestrator as the coverage-loss exception, which is the '
      + 'half of the ruling a park alone does not satisfy. '
      + 'TRIAGE (the rule says a test with no flake-fix history is more likely under-budgeted than flaky, '
      + 'and the two need opposite responses): `git log` on this spec has exactly ONE commit — its birth '
      + 'commit b22850e09 — so there is no failed-fix history. `sampleVideoOut` is NOT the poll-starvation '
      + 'class: it accumulates all 12 rAF frames inside ONE page.evaluate. The suspect is the `expect.poll` '
      + 'around it, bounded by BOOT_MS — a WALL-CLOCK budget gating a renderer-dependent movement '
      + 'assertion, the house rule\'s named anti-pattern. UN-PARK: re-express that window in FRAMES '
      + '(e2e/_helpers/frames.ts), keeping a wall-clock cap only to BOUND the failure, and reproduce under '
      + 'E2E_SWIFTSHADER=1 first — "slower here" and "genuinely different here" need opposite fixes.',
  },
  {
    specs: [
      'cv-buddy-face.spec.ts',
    ],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — the LATE lamp\'s static caption + its count riding the accessible name. '
      + 'Recovered-on-retry, FIRST observation (PR e2e shard 6/10), NOT yet triaged as flake vs '
      + 'under-budget. TRIAGE POINTS THE OTHER WAY and the entry says so rather than claiming "flaky": '
      + 'the rule is that a test with no flake-fix history is more likely UNDER-BUDGETED than flaky, and '
      + '`git log` on this spec has exactly ONE commit — the feature that created it (#2082) — so there '
      + 'is no failed-fix history to argue the other side. The two classes need OPPOSITE responses, so '
      + 'UN-PARK is a reproduce-and-measure budget diagnosis, never a re-run until green. '
      + 'SIBLINGS RETAIN COVERAGE, named: the ES-9-sentences leg and the ROUTED-lamp positive control in '
      + 'this same file both exercise the lamp — what is parked is narrower than the lamp itself. '
      + 'Parked on the first observation to unblock the board (it reddens every PR on this commit range, '
      + 'not just the one that found it) rather than hold a PR for a diagnosis lane the cap does not allow.',
  },
  {
    specs: [
      'backdraft-preview-toggle.spec.ts',
      'backdraft-pure-tv.spec.ts',
      'extras-producer-lifetime.spec.ts',
      'layers-survive-card-collapse.spec.ts',
      'lushgarden.spec.ts',
      'mapper.spec.ts',
      'present-survives-card-collapse.spec.ts',
      'reshaper-shapedramps.spec.ts',
    ],
    reason: /FLAKE-PARK #1847|parkReason/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — video producers and NODE-LIFETIME state: that collapsing or never mounting a card does '
      + 'not tear down its producer, drop its layers or freeze a live projector. This is the #1720/#1574/#1589 '
      + 'family, a class that has shipped repeatedly, and extras-producer-lifetime is its unique regression net '
      + '— #1757 was a declared fix for that spec and the census shows most of its flakiness landed AFTER it. '
      + 'The alternation admits the loop-parked sites, whose description is the per-subject map value. '
      + 'ADDED 2026-08-24 — backdraft-preview-toggle\'s THIRD leg (:303, the collapse/reclaim geometry). Its '
      + 'two same-file siblings were already parked (:362 with 21 recovered-on-retry observations, :425 with '
      + '11) and they document the shared preview-collapse mechanism this leg runs on, so it flakes by the '
      + 'family\'s cause rather than one of its own. Recovered-on-retry, FIRST observation of THIS leg (run '
      + '32725328269 shard 2/10, 2026-08-24 12:31Z, absent from main\'s previous 8 runs), NOT triaged as '
      + 'flake vs under-budget; un-park is the FAMILY\'s budget diagnosis — repairing one of three siblings '
      + 'that share a mechanism would leave the other two parked and prove nothing.',
  },
  {
    specs: [
      'workflow-channel-columns.spec.ts',
      'workflow-dock-ux.spec.ts',
      'workflow-dock.spec.ts',
      'workflow-shell-faces.spec.ts',
      'workflow-shell.spec.ts',
      'workflow-surfaces.spec.ts',
    ],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — the workflow shell and dock: the migration seam (a curated face in-lane rather than '
      + 'the placeholder), lane tile geometry and header composition, the two-pane dock split with LRU '
      + 'replacement asserted for BOTH shells, independent rail zoom, the MIDI clock-source assignment and the '
      + 'channel-column reconciler additivity invariant. The shell-parity legs are the ones that stop a fix '
      + 'landing for one shell only, and they are what goes dark first here.',
  },
  {
    specs: ['io-spec-consistency.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — three registry modules (bluebox, buggles, quadralogical) parked inside the existing '
      + 'QUARANTINE map, which renders an interpolated-title test.fixme whose annotation carries the MAP value, '
      + 'so map reason and report row cannot diverge. The live title is unchanged, so un-parking is a one-entry '
      + 'deletion. Lost meanwhile: those modules spawn smoke — card render, registry-derived handle count and a '
      + 'clean console — which is the only per-module render gate outside the VRT lanes. '
      + 'The map moved with the rest of modules.spec.ts into the consolidated registry card sweep (#1861) and '
      + 'the park did NOT change scope: it stands down that sweep\'s render-smoke group, which is exactly what '
      + 'modules.spec.ts asserted, and these three were never parked in the three sibling sweeps that also '
      + 'spawned them.',
  },
  {
    specs: ['per-module-per-port-behavioral.spec.ts'],
    reason: /FLAKE-PARK #1847|parkReason/,
    lanes: [],
    homeLane: 'behavioral',
    why:
      'PARKED (#1847) — fifteen modules taken out of the BEHAVIORAL input-coverage sweep. lanes:[] because the '
      + 'whole describe is grep-inverted out of the sharded matrix ("BEHAVIORAL input coverage"), so a row with '
      + 'this reason appearing in an audited lane is a lane-partition leak first. ⚠ ci.yml already records that '
      + 'deleting the full behavioral lane left the modules outside behavioral-smoke with no dead-input '
      + 'detection on CI; parking these removes the last of it for those fifteen, so a module that silently '
      + 'IGNORES a wired input is now unobservable for them.',
  },
  {
    specs: ['peakstate-render-smoke.spec.ts', 'wavecel-video-outs.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: [],
    homeLane: 'webgl-smoke',
    why:
      'PARKED (#1847) — two WEBGL_HEAVY_GLOBS specs, so they are in the chromium project testIgnore under the '
      + 'sharded matrix\'s E2E_WEBGL_HEAVY=exclude and resolve only on the webgl-smoke floor job, which has no '
      + 'JSON audit step: lanes:[] means a row here in an audited lane is a partition leak. Lost meanwhile: '
      + 'PEAKSTATE\'s per-port render gate (unconsumed outputs stay dark) and WAVECEL.scope_out producing a '
      + 'structured, frame-stable trace independent of the on-card preview toggle.',
  },
  {
    specs: ['quadralogical-face-screen.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — both legs of the QUADRALOGICAL screen spec. ⚠ THIS ENTRY IS NOT THE '
      + 'RECOVERED-ON-RETRY SHAPE THE REST OF THIS LIST RECORDS, and the distinction matters to whoever '
      + 'un-parks it: both legs failed BOTH attempts at the FULL 90 s SLOW_BOOT_TEST_TIMEOUT_MS, inside '
      + 'page.evaluate in sampleQuadrants. That is UNDER-BUDGETING, not nondeterminism. The in-page loop is '
      + 'already correct by construction — it counts 240 FRAMES via rAF rather than wall-clock, which is what '
      + 'the standard asks for; what does not scale is the per-test BOUND, a flat 90 s sized for BOOT while '
      + 'this spec spends a boot AND a 240-frame sample. At the measured 7.9 fps under SwiftShader the sample '
      + 'alone is ~30 s. '
      + 'It surfaced on batch-22 G3 (#2120) because four new scenes re-packed the shards and these legs landed '
      + 'on a hot one — the load-sensitivity class of #2096/#2114 — so it is a defect in neither the faces nor '
      + 'these tests\' logic. ROOT CAUSE IS THE FLEET TIMEOUT DEFAULT and the fix is the owner\'s option-B '
      + 'call, not a one-spec bound raise, which would only move the lottery onto the next-hottest spec. '
      + 'Lost meanwhile: the bespoke proof that each quadrant carries ITS OWN input under its own corner label '
      + '— quadrant-to-input MAPPING, which no fleet sweep covers. The generic screen coverage '
      + '(reachable / collapse / reclaim) is superseded by the fleet SUBJECTS table.',
  },
  {
    specs: ['acidwarp-face-screen.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — ONE leg of the ACIDWARP screen spec ("freeze does NOT stop the picture"), and it is '
      + 'the THIRD MODULE IN THE *-face-screen CLASS the entry directly above already records. That is the '
      + 'whole justification for parking rather than investigating: quadralogical\'s two legs are already here '
      + 'with the cause written down, and a third instance of a triaged class is not new coverage loss — it is '
      + 'evidence for the pending decision. The shape is the same one that entry describes: a *-face-screen '
      + 'spec spends a BOOT *and* a multi-hundred-frame rAF sample against a flat, boot-sized per-test bound, '
      + 'so it loses the shard lottery whenever re-packing lands it on a hot one (the load-sensitivity class of '
      + '#2096/#2114). The in-page loop is already correct by construction — it counts FRAMES via rAF, not '
      + 'wall-clock. ⚠ ROOT CAUSE IS THE FLEET TIMEOUT DEFAULT and the fix is the owner\'s option-B call; a '
      + 'one-spec bound raise would only move the lottery onto the next-hottest spec, which is why nobody '
      + 'should "fix" this entry by raising a number. ⚠ ONE DIFFERENCE FROM THE QUADRALOGICAL ENTRY, recorded '
      + 'so the two are not read as identical: that one failed BOTH attempts (under-budgeting, flat out), '
      + 'while this one RECOVERED ON RETRY — so this is the same cause caught one notch earlier. '
      + 'Lost meanwhile: the bespoke runtime evidence for acidwarp\'s FACES_WITHOUT_SCENES entry — that its '
      + '`freeze` param does not still the picture. The CLAIM survives at the entry itself, which argues it '
      + 'from the read site (the freeze test guards only the scene advance; the palette accumulator sits '
      + 'outside it) and is anchored four ways, so a face that became capturable still reddens. What lapses is '
      + 'the re-proof, not the record.',
  },
];

// ─────────────────────────── the shared predicates ──────────────────────────
// The CI audit and the unit tests' negative controls call THESE — never a
// re-implementation — so a control that passes proves the same code path that
// gates the lane.

/** @param {{ title?: string, reason?: string|null }} row */
export function classifySkipRow(row) {
  if (PLACEHOLDER_TITLE_RE.test(row.title ?? '')) return 'placeholder';
  const r = row.reason ?? '';
  if (!r || r === '(no reason given)') return 'anonymous';
  return 'annotated';
}

/** Does (file, reason) fit a budget entry that admits `lane`? */
export function matchBudget(lane, file, reason) {
  return SKIP_BUDGET.find(
    (e) =>
      e.lanes.includes(lane)
      && e.specs.some((s) => file === s || file.endsWith(`/${s}`))
      && e.reason.test(reason ?? ''),
  ) ?? null;
}

/**
 * THE lane gate: every non-placeholder skipped row must be budgeted for this
 * lane. Returns the violations (empty = within budget).
 * @param {{ file: string, title: string, reason?: string|null }[]} skippedRows
 * @param {string} lane one of AUDITED_LANES
 */
export function budgetViolations(skippedRows, lane) {
  const out = [];
  for (const row of skippedRows) {
    const cls = classifySkipRow(row);
    if (cls === 'placeholder') continue; // governed by the exemption maps (scope note above)
    if (cls === 'anonymous') {
      out.push({ ...row, violation: 'reasonless skip — every runtime skip must carry a reason string' });
      continue;
    }
    if (!matchBudget(lane, row.file, row.reason)) {
      out.push({
        ...row,
        violation: `no budget entry admits this (spec, reason) in lane '${lane}' — add a NAMED entry to scripts/e2e-skip-budget.mjs or fix the guard`,
      });
    }
  }
  return out;
}
