# Renderer failures that can look successful

Every entry names the tree anchor that carries the mechanism; read the anchor
before acting on the summary. Measured figures with no anchor come from session
records preserved at git tag `myrobots-preserved-2026-09`.

## DOOM timing is game state

`packages/web/src/lib/video/modules/doom.ts` advances one game tic from
`surface.draw`. A rendered
frame is therefore a game tic. Replacing a DOOM millisecond wait with a frame
wait changes how far the marine moves; do not touch it without owner approval.

## Smaller rendering can delete the subject

Lowering an iterated renderer from its normal framebuffer to 384×288 or 512×384
was tried twice as a speedup for geometry tests. It failed because resolvable
depth depends on pixel width: deeper bands physically fall below one pixel.
Lower resolution is valid only when the assertion is independent of spatial
detail.

## Snapshot acceptance can hide a wrong picture

- Playwright `=changed` cannot rewrite a baseline whose comparison passes,
  even when the baseline is stale. The CI capture (`vrt-update.yml`, the only
  baseline author) spells `=changed`; local `task vrt:update` spells `=all`,
  which writes byte-different output without consulting the tolerance and is
  diagnostic only.
- The current pixel-count budget plus narrow explicit scope is the safety
  argument. Do not weaken either, and do not rely on a bare flag's
  version-dependent default.
- A broken black/frozen render can be captured and then pass forever. Inspect
  semantic content before acceptance; baseline equality is not correctness.
- A nondeterministic scene must be pinned or removed from deterministic VRT, not
  repeatedly rebased.

## Scope can silently become a shell command

go-task expands some CLI arguments unquoted. An alternation such as
`GREP="a|b"` can become a shell pipe and silently change capture scope. Use the
supported single-literal scope path, or prove quoting at the Taskfile boundary
before using shell metacharacters.

## Missing snapshots recreate themselves

A plain VRT run writes an absent snapshot as an untracked PNG while still
failing the test. After any run in a deleted/missing-baseline window, inspect
`git status` so an accidental recreation cannot enter a commit.

## Sampling an oscillating quantity aliases

An instrument that takes ONE sample, or samples on a regular interval, reports
whichever phase it happened to land on. The measured attest pre-flight read one
`ps` and declared the machine quiet; the co-tenant it was looking for swung
3.5 % to 87 % on a roughly 4 s period, and a regular 10 s lag aliased into its
troughs and read 3.9-5.6 % against a signal that was over threshold 56 % of the
time.

The repair is a window, not a bigger number: pairwise-irregular gaps so the
series cannot phase-lock, a verdict over the whole window (a sustained fraction
plus an egregious single spike), and the irregularity asserted by a test rather
than promised by a comment. `scripts/attest-preflight.ts` — `SAMPLE_OFFSETS_MS`,
`SUSTAINED_FRACTION`, `EGREGIOUS_MULTIPLE`, `judgeProfile` (pure, so it is
testable against a recorded series with no `ps` and no clock);
`scripts/attest-preflight.test.ts` asserts the gaps. A pre-flight refusal naming
a sustained co-tenant is a TRUE refusal about machine STATE, and different in
kind from a refusal the TOOLING caused — a stale or HEAD-vs-main hash pin, a
missing dist, a dirty tree. Attest procedure is this skill's `SKILL.md`
§ Real-GPU attestation plus `ci-webgl-attest/README.md`.

Two relatives of the same fault:

- A sustained-negative wait IS the assertion. An auto-retrying poll converges at
  t=0, so replacing a wait with a later `expect.poll` covers it only if the poll
  would be FALSE at t=0. Ask what the poll would do if the bug were present;
  where the answer is "pass immediately", the window has to be spent, and it is
  spent in frames.
- `page.waitForFunction` with an ASYNC predicate is vacuous: the pending Promise
  is itself truthy on the first poll, so an always-false predicate "passes"
  (measured: 298 ms). Poll from the Node side with `expect.poll` over
  `page.evaluate`, which awaits by contract. Sync predicates are fine. Anchor:
  `apps/desktop/e2e/supervision.spec.ts` `waitForState`.

## A render check can read the wrong surface, or an unpinned clock

The shared deterministic-render harness is `e2e/tests/_render-smoke.ts`:
`installRenderSmokeHooks(page)` BEFORE `page.goto` (it pauses the engine rAF
loop so the test owns the exact frame count, and pins the engine clock), then
`stepAndReadStats()` inside ONE `page.evaluate` so rAF, decode and blit cannot
interleave, then `assertRenderStats()` — floors and counts only, so SwiftShader
and a real GPU both clear them while a black/flat/GL-error regression still
fails. Do not hand-roll a second one.

Two mechanics decide whether it measures anything:

- Read the ENGINE output texture for the node, not a downstream 2D copy. The
  lane tile thumb is a throttled repaint of the picture, not the picture.
- Pin the module's OWN clock too where it keeps a private `performance.now()`
  baseline: `__videoEngineFreezeTime` only reaches modules that read
  `frame.time` (the module-side early-return is asserted in
  `packages/web/src/lib/ui/modules/gibribbon-face-model.test.ts`).

"A param visibly changes output" is TWO FROZEN READS — freeze, step, read with
A; step, read with B; assert they differ — never an animation diff, which is the
un-pinned version of the same question. Keep step counts small (the live specs
sit at 6-8; `FIXED_STEPS` in `e2e/tests/4plexvid.spec.ts` and its neighbours)
and never add a wall-clock timing probe to a deterministic render spec.

## A filter or a selector before the check redefines the subject

The gate then reports honestly about a population nobody cares about.

- **A blanket error filter.** Each registry sweep kept a private filter that
  dropped every `Failed to load resource` line unconditionally, and that message
  carries NO url, so it
  could not distinguish a dead worklet from a missing optional asset even in
  principle — and for 58 module types it was the only net that could observe a
  module failing to load at all. The fix records `location().url` and then
  denies by default, exempting only NAMED optional runtime assets:
  `e2e/tests/_page-errors.ts` — `collectPageErrors()` / `isBenign()`, whose
  header also states what the channel still cannot see (a `requestfailed` with
  no console line, a `fetch()` rejection).
- **A selector that cannot match.** xyflow stamps a node's wrapper class from
  the EMITTED node type, and `emittedTypeFor`
  (`packages/web/src/lib/ui/workflow/legacy-fallback.ts`) emits `moduleShell`
  for a faceplate tile and `dockStub` for a docked node; only
  `NON_SHELL_LANE_TYPES` (one member, `cadillac`, filtered out of `flowNodes`
  upstream) keeps its own type — so `.svelte-flow__node-<moduleType>` matches
  nothing for any real module. A `waitFor` on it fails
  loudly; a `toHaveCount(0)` on it is satisfied by a page that rendered NOTHING,
  and four such gates sat in the required lane. Address by node id
  (`.svelte-flow__node[data-id="…"]`) and keep a POSITIVE statement that can
  still fail. Anchors: `e2e/tests/io-spec-consistency.spec.ts` (the handle
  partition, and why it is one `evaluateAll`), `e2e/tests/audio-in.spec.ts`
  (both retired absence checks, with the replacement).
- **An assertion satisfied by nothing at all.** `expect(b).toEqual(a)` on two
  black frames passes; a flatness check passes on black; a symmetry check scores
  0 on black. Pair each with an anti-vacuity floor, and force the dead-render
  control — make every read return black and confirm the test FAILS. ⚠ But the
  floor cannot just be "the frame is LIT": an unpatched `videoOut` paints its
  OWN dark-blue idle gradient, which clears `nonBlackFrac > 0.001` and
  `variance > 0.5` with nothing connected at all. Measure a DIFFERENTIAL against
  the sink's idle picture — `e2e/tests/per-module-per-port-outputs.spec.ts`
  (`sinkIdleCells` / `differsFrom` / `SINK_CELL_DELTA` / `SINK_DIFF_MIN_CELLS`):
  a 16×12 luma grid captured once per worker from a rack holding only the sink,
  and required to differ in N cells. The control itself needs a settle rule —
  the tile canvas has not painted on its first readable frame — so cache the
  idle grid only after TWO CONSECUTIVE AGREEING READS, or an idle that has not
  arrived yet becomes a control that differs from itself forever after.
- **A driver that cannot reach what the sweep observes.** Ask what is being
  OBSERVED, not just what is being driven: a CV that provably cannot perturb a
  fixed-stroke output makes a vacuous row whose greens ride incidental
  animation phase. Name the observed output instead:
  `BEHAVIORAL_OBSERVED_OUTPUT` / `_BY_PORT` in
  `e2e/tests/per-module-per-port-behavioral.spec.ts`.
- **A bulk rename onto a different contract.** Repointing specs at a
  replacement with different params, ports or seeding hooks leaves a subject
  that silently vanishes and a spec that passes vacuously. The replaced module's
  own code is the conversion truth, not its consumers' prose.
- **An assertion with no viewport requirement.** Playwright's `toBeVisible()` is
  `display`/`visibility`/`opacity` plus a non-empty box — NO viewport check and
  NO scroll-position check — and `.click()` auto-scrolls before acting, so both
  walk past an element painted below the fold of its own scroll container. A
  face whose controls sat ~300 px past the bottom of the dock faceplate's
  scroller at the 1280×720 default was asserted `toBeVisible` and ran green for
  months against an owner-reported P0. Assert the ON-SCREEN predicate the player
  means: in the viewport, inside the visible box of every scrolling ancestor,
  and hit-testing to itself via `elementFromPoint` — `onScreenReport` in
  `e2e/tests/camera-input.spec.ts`, whose case carries an in-test POSITIVE
  control that re-appends the control to the pre-fix position and asserts the
  same predicate reports it off-screen.
- **An enrolment predicate derived from the DOM.** A registry sweep that decides
  membership by counting elements in the surface under test un-enrols itself the
  moment that surface changes shape: the predicate goes false, `test.skip` fires
  with a loud message, and the sweep silently stops covering the module it was
  written for. Skips are not passes — read the skip count. Worse, a skip fires
  BEFORE the assertions behind it, so a spec that would now fail red reports
  green with a skip and nobody reaches the real failure. Derive enrolment from
  SOURCE, cross-check the source-derived answer against the runtime one per
  subject in both directions, make a zero-enrolled run throw, and keep a
  permanent NEGATIVE leg. Anchor: `e2e/tests/collapse-keeps-playing.spec.ts` —
  `realPlayerTypes()`, the source-vs-runtime disagreement assertion before its
  `test.skip`, the `.not.toEqual([])` population floor, and
  `assertCreditRuleIsSound`.

## A floor is not one number

A universal threshold is one number for ~100 modules, and it cannot be a floor
for a quantity whose null scatter varies by three orders of magnitude between
them. Measured: `snaredrum` passed 24 of its 26 ports with NOTHING WIRED,
because a drum voice re-struck by a free-running sequencer scatters its own
spectral centroid by thousands of Hz against a 30 Hz `centMean` floor.

Every row therefore measures its own null scatter in the same run it is judged
in, and the effective bar is
`max(universal floor, NULL_NOISE_SIGMAS × that row's own sampling error)` —
currently 5σ, and the number is MEASURED, not chosen: 3σ let `snaredrum`
false-pass under negative control, because the pass predicate is an OR over
thirteen terms and that is a multiple-comparisons problem (~234 chances per
module, ~0.6 expected false passes per run; the multiplier pays the Bonferroni
shape). Because it is a MAX it can only tighten: no row that fails today starts
passing because of it. Anchor: `NULL_NOISE_SIGMAS`, the "A FLOOR IS NOT ONE
NUMBER" header and the "WHY 5σ AND NOT 3σ" block above it in
`e2e/tests/per-module-per-port-behavioral.spec.ts` (two older in-file comments
still say 3σ; the constant is the authority).

- Prove it rather than trusting it: `task behavioral:negative-control` re-runs
  the whole sweep with every perturbation edge omitted and asserts NO ROW
  PASSES.
- No floor rescues a mis-shaped metric. Fit the metric to the output: pitch
  voices to cents, one-shot pulses to per-transient peak, summed mixers to a
  per-channel sink, animated video to a per-frame structural diff (variance is
  swamped by the scene's own noise). An exempt entry leaves the backlog by being
  re-enabled with a fitting metric, or deleted because the input can never
  affect output — there is no permanent exempt bucket.

## Captured is not gated

`e2e/vrt/vrt.config.ts` `testMatch()` decides the lane: `VRT_STRICT=1` selects
`STRICT_MATCH` — the required lane, currently the single face-scene spec — and
everything else is `FULL_MATCH`, exercised only by the CAPTURE path
(`task vrt:update` / `vrt-update.yml`). The informational full-sweep job is
gone; `ci.yml`'s header states the coverage that cost. So a scene can be
captured, committed and never compared by any gate.

Two measured consequences:

- Breaking a non-`STRICT_MATCH` scene costs zero required signal. One dead
  selector took out 105 scenes with nothing to say so, while the mechanism was
  already spelled out verbatim in an `e2e/tests/` spec that could not propagate
  into `e2e/vrt/`.
- A baseline nothing compares is simultaneously unwatched AND un-repinnable,
  because `=changed` only writes on a FAILING comparison. 95 such baselines had
  drifted, one of them by ~353,000 px.

Before quoting a VRT result, name its lane. Keep a face spec in BOTH lists —
dropping it from `FULL_MATCH` would silently stop capturing its baselines, which
is worse than a duplicated run. The sibling trap outside VRT is
`e2e/webgl-heavy-globs.ts`: adding a spec there DELETES its PR coverage, it does
not move it. Where a list like this needs a vacuity tripwire, anchor it on NAMES
checkable against the tree, never on a count.

Two more ways a lane reports on the wrong half of its own contract:

- **A guard over a SELECTION is blind to EXECUTION.** A subset gate that
  reconstructs titles from the live registry and asserts which ones the pattern
  SELECTS still counts a row that is skipped, disabled or parked — one side of a
  two-sided contract. Measured: the required `behavioral-smoke` grep resolves to
  six modules, two of them were parked, the lane ran four, and the guard written
  to stop that subset drifting stayed green. Assert what RAN, and where the gate
  deliberately
  will not (`packages/web/src/lib/dev/behavioral-smoke-subset.test.ts` states
  the constraint at the parking site instead of reddening the unit lane on a
  park). The same asymmetry hides skips: `scripts/e2e-skip-budget.mjs` is wired
  to the `e2e` lane's per-shard reports, so a skip in a lane that produces no
  such report surfaces nowhere — name the lanes an audit actually covers, and
  the ones it does not.
- **A lane nobody has to act on finds nothing.** `ci.yml` deleted nine
  informational jobs for exactly that reason (its umbrella `if` block, "THE
  INFORMATIONAL TIER NO LONGER EXISTS"), and records that two of them had grown
  into their caps and were reporting `cancelled` on `main`, which disqualifies
  the run from the nightly prod deploy. "Land it informational-first, arm it
  later" is not a supported shape: the second half never happened. A red test is
  FIXED, or PARKED with the coverage loss written down at the parking site (the
  `FLAKE_PARK_1847` maps) — never left producing a signal nobody reads.

## Boot-vs-boot and boot-vs-baseline are different questions

A determinism probe boots the same scene twice with the baseline out of the
loop, so a non-zero row can only mean "this scene does not reproduce"
(`e2e/vrt/vrt-determinism-probe.spec.ts`, under `VRT_PROBE=1`). A baseline
comparison answers "has the picture changed". Neither substitutes for the other,
and two boots in one session cannot see 1-in-N instability: one face scene was
reported bit-exact by the probe and then rewrote at 8 px, maxChannel 1.

- Tightening the tolerance found unpinned SIMULATIONS, not renderer physics.
  Pin the sim, not the tolerance — and prefer `simPin` (an e2e-only global,
  outside the attest basis) over a `freeze` ParamDef, which lives in `params`
  and therefore costs an attest re-pin and a contract re-pin while buying only
  intra-boot stillness at whichever frame the harness caught. A video sim needs
  BOTH halves, clock and seed, and the seed must land before spawn.
- Pin every non-deterministic INPUT, not just the animation — a different
  mechanism from clock+seed. Where a face's pixels are partly a runtime `fetch`,
  the DATA needs its own pin: with no network the request REJECTS and the body
  paints the ENVIRONMENT's error string, so the baseline becomes a function of
  which browser build refused it. Anchor: `__tvLibrarianTestCountries` in
  `e2e/vrt/_shell-faces.ts`. ⚠ And derive which halves need pinning from the
  SOURCE rather than copying a prescription: that same entry records a second
  pin dropped after reading the shader, because the idle branch is a pure
  function of position and the pin would have frozen something already still.
- Predict which baselines should move, then ATTRIBUTE every file the bot
  committed: bucket 1 is the repair, bucket 2 is the fix's own render change.
  Predicted 19, committed 115; on another run predicted 1, committed 2, and the
  extra was a 24 px bucket-2 member that was reverted rather than accepted.
- Classify the diff PNG before theorising from the code. A hypothesis derived
  from source was refuted in one look by the two images.
- When a flake hides inside a tolerance, drop the tolerance: compare the
  captured PNGs byte-for-byte instead of repeating the tolerance-gated check. A
  pass/fail repeat loop on a scene that usually passes is the vacuous version.
- An instrument that could not LOOK prints the same as one that saw nothing:
  the watcher reported "0 baselines committed, red flag" because its
  `origin/<branch>` diff failed on a branch that did not exist on the remote.
- A baseline whose pixel SIZE moves against byte-identical source is a product
  bug being laundered by re-pinning, and `git diff --name-status` cannot see it.
  Decode the IHDR: `scripts/vrt-geom-audit.sh`.
- The bar itself, its history and its STATED blind spot live in
  `e2e/vrt/vrt.config.ts`'s `toHaveScreenshot` block, with the per-scene budgets
  (`COMPACT_MAX_DIFF` / `DOCK_MAX_DIFF`, both 0) in `e2e/vrt/_shell-faces.ts`.
  The comparator band is pinned by
  `packages/web/src/lib/ui/vrt-comparator-band.test.ts`, which drives the same
  comparator function in both directions and FOLLOWS a threshold change rather
  than pinning the old number (it parses the gate's own settings out of
  `vrt.config.ts` and imports the per-scene budgets) — what reddens is WIDENING
  the band past ±3 LSB, which is the FAIL side's smallest case. Read all of it
  before touching either number.

## Unsound, not merely flaky

Ask why a GREEN run is green. One behavioral row went eight consecutive greens
with a DIFFERENT metric carrying each pass by a hair: the stimulus was a random
walk worth about 7 % of the declared param range, and six of thirteen OR-ed
terms had control-vs-control scatter LARGER than their own floor. After the fix
the worst-pair separation went from 1.7x to 10.6x the floor.

The test is that control-vs-control scatter sits below the floor. Where it does
not, the row is decided by noise and its green runs are not evidence of
anything.

- Check a threshold against the range the same file has already measured. A
  `fast − slow ≥ 5` frame gate required the free arm above ~76 fps while its own
  header documented rates down to 33.9 fps — a separation of minus four,
  satisfiable only where the probe happened to hit 120 fps.
- A control that cannot fail is not a control. On the WebGL attest, comments,
  formatting and a def's `docs` / `controlFamilies` / `face` / `noUserControl`
  are hash-transparent BY CONSTRUCTION (`scripts/attest-code-basis.ts`,
  `HASH_TRANSPARENT_PROPS`), so a positive control there must perturb a VALUE.
- A recovered flake is a finding, not a pass. `retries: 1` on CI still runs, but
  the shard report is audited and a flaky result REDS the job
  (`scripts/e2e-report-audit.mjs --fail-on-flaky`). Root-cause it; do not re-run
  it.
- Read the population near the ceiling when you touch a budget. A test that
  fired at 30.77 s against a 30.00 s budget ranked only SIXTH among the tests
  sitting at 70 % or more of theirs — the timeout was the messenger. This is
  judgment for the author, not a gate: a CI headroom guard that failed shards at
  85 % of budget while every test passed was built, tried and deleted
  (2026-08-23). Do not rebuild it.
