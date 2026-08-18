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
      'sequencer-transport.spec.ts',
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
    specs: ['modules.spec.ts'],
    reason: /task #102/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'The spawn-smoke QUARANTINE map (currently toybox: SwiftShader first-paint timeout). The fixme '
      + 'annotation derives its description from the map, so map reason and row reason cannot diverge.',
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
    specs: ['blood-audio-output.spec.ts', 'blood-ingame.spec.ts', 'blood-keyboard.spec.ts'],
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
  {
    specs: ['workflow-shell-video.spec.ts'],
    reason: /no videoinput device/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'Device-list assertion needs a videoinput; headless CI runners expose none, so the leg is not '
      + 'applicable there and says so. Tolerated but surfaced.',
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
      + 'clip-automation flakiness and the census shows it did NOT hold.',
  },
  {
    specs: [
      'blood-audio-output.spec.ts',
      'clap.spec.ts',
      'coverage-groups-3-4-5.spec.ts',
      'cv-range-uniformity.spec.ts',
      'drumseqz.spec.ts',
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
      + 'pitch accuracy, CLAP and DRUMSEQZ through their real trigger chains, triplet playback, the mono-normal '
      + 'contract, ADR-004 CV range travel, and SHAPEGEN gate edge semantics. This is precisely the class the '
      + 'poly/MIDI discipline exists for — an engine-direct substitute is what shipped POLYHELM green-but-'
      + 'silent — so while these are parked a silent or mistuned chain has no CI gate at all.',
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
      + 'The alternation admits the loop-parked sites, whose description is the per-subject map value.',
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
    specs: ['modules.spec.ts'],
    reason: /FLAKE-PARK #1847/,
    lanes: ['e2e'],
    homeLane: 'e2e',
    why:
      'PARKED (#1847) — three registry modules (bluebox, buggles, quadralogical) parked inside the existing '
      + 'QUARANTINE map, which renders an interpolated-title test.fixme whose annotation carries the MAP value, '
      + 'so map reason and report row cannot diverge. The live title is unchanged, so un-parking is a one-entry '
      + 'deletion. Lost meanwhile: those modules spawn smoke — card render, registry-derived handle count and a '
      + 'clean console — which is the only per-module render gate outside the VRT lanes.',
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
