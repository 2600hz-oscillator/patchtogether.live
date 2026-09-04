// e2e/tests/io-spec-consistency.spec.ts
//
// THE registry-wide SOLO-SPAWN tile sweep. One page load + one module spawn
// per registered module, then SIX assertion groups read different properties
// of that one rendered tile.
//
// ── WHY THE FILE KEPT ITS NAME ─────────────────────────────────────────────
// Four specs used to spawn all 196 modules independently and then read
// different DOM properties of the same node. MEASURED on CI
// (e2e/e2e-timings.generated.json): io-spec-consistency 1051.3 CPU-s, modules
// 795.4, per-module-per-port-handles 682.2, control-overflow 672.3 = 3201
// CPU-s, of which three quarters was duplicated page loads. #1861 folded them
// into this file. The NAME stays because ~15 sites across README.md,
// docs/testing, MODULE-COVERAGE-PLAN.md and module source comments cite this
// spec BY NAME as the coverage backing a claim; renaming it would silently
// un-cite all of them. Read the describe titles, not the filename, for what
// this file now asserts.
//
// ⚠ EVERY LOCATOR ADDRESSES THE NODE BY ID (`SUT`), NEVER BY A PER-TYPE NODE
// CLASS. xyflow stamps the wrapper class from the EMITTED node type and every
// lane node emits `moduleShell`, so `.svelte-flow__node-<type>` matches
// nothing — and a sweep reading an empty handle set would pass its per-port
// assertions vacuously. Group B's `toHaveCount(expectedHandles)` against a
// non-zero def total is the anti-vacuity guard that makes that impossible.
//
// ── THE SIX GROUPS, AND WHERE EACH CAME FROM ───────────────────────────────
//   A. HANDLE IDS == DEF PORT IDS, as sorted-array EQUALITY in both
//      directions (this spec's original assertion), plus a PER-PORT
//      pinpoint assertion so a failure names the offending `<module>.<port>`
//      and its type (ported from per-module-per-port-handles.spec.ts, whose
//      `⊇` claim is mathematically subsumed by the equality — it only ever
//      added the better message, which is now here).
//   B. HANDLE COUNT == inputs+outputs, as an auto-retrying `toHaveCount`
//      that doubles as the "all handles have rendered" settle before A reads
//      their ids (this spec's original wait; also modules.spec.ts's
//      handle-count assertion, which the same expectation subsumes).
//   C. TILE IDENTITY — the editable name label reads /^<TYPE>(\d+)?$/, with a
//      def-label substring fallback for a surface that renders its own chrome
//      without ModuleTitle (from modules.spec.ts).
//   D. THE TILE HAS A REAL BOX — visible, >50×50 (from modules.spec.ts;
//      catches the silent DOM-only mount).
//   E. CONTROLS FIT THE TILE — no in-flow control past the right/bottom edge
//      and no horizontal content overflow (the instrument lives in
//      _card-overflow.ts).
//   F. NO CONSOLE / PAGE ERRORS across the whole spawn (from modules.spec.ts),
//      asserted LAST — see the live-render window below.
//
// ⚠ GROUP E's SUBJECT CHANGED SIZE, NOT KIND. It used to bound controls
// against a box each module authored for itself; every tile is now the same
// RACKLINE box, so the same instrument now asks whether a declared cell ladder
// fits the uniform tile. It is kept rather than folded into
// faceplate-platform.spec.ts's per-cell geometry gate because the two sweep
// DIFFERENT populations — this one every REGISTERED module at spawn, that one
// every strictFace type — and those sets are only equal once the promotion is
// complete for all of them.
//
// ── THE ONE THING THAT IS NOT A PURE MERGE: THE VIDEO RENDER FREEZE ────────
// Three of the four old specs set `__videoEngineFreezeRender` for video
// modules (the per-frame GL draw is brutally slow on CI's SwiftShader
// renderer, and groups A–D are DOM/layout-only, so freezing changes nothing
// they observe).
// modules.spec.ts did NOT freeze — so its console-error window (F) covered
// LIVE per-frame draws, which a frozen page cannot see.
//
// Rather than pick one and quietly narrow a gate, this sweep does both: it
// spawns FROZEN (identical preconditions to A–E as they ran before), then
// UNFREEZES and waits a bounded number of FRAMES before asserting F — so F
// still observes real draw passes. The unfreeze carries a POSITIVE CONTROL,
// because "no errors" and "nothing ever drew" are indistinguishable from the
// assertion's output alone.
//
// Adding a new module: no edits needed. The registry barrels import it at
// registration time; the manifest emitter picks it up; this spec iterates the
// manifest. The only hand-curated structures are the four NAMED maps below,
// every one of them anchored to REGISTRY by the anchor test at the bottom.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { REGISTRY, type RegistryModule } from './_registry';
import { driverFor } from './_drivers';
import { waitFrames } from '../_helpers/frames';
import { EXEMPT_CONTROL_OVERFLOW, assertControlsFitCard } from './_card-overflow';

/** The one node every test in this sweep spawns. Every locator addresses it by
 *  THIS id rather than by a per-type node class: xyflow stamps the wrapper
 *  class from the EMITTED node type, and every lane node emits `moduleShell`. */
const SUT = 'sut';

// ────────── Module-level skips (the WHOLE sweep) ──────────
//
// Modules whose UI is intentionally lagging the def, or which cannot render a
// flow card under bare spawnPatch at all — skipped with a TODO + a pointer at
// the dedicated coverage. Each entry MUST cite an alternative spec so we don't
// lose coverage by hiding the failure. This is the canonical list of
// "needs-follow-up" modules; the per-port sweeps' SKIP_SPAWN mirrors it.
const SKIP_DEF_VS_UI: Record<string, string> = {
  // GROUP is a meta-domain container whose card body renders the
  // exposed-ports surface of the modules a user added INSIDE it. A
  // bare spawnPatch({type:'group'}) without `data.children` doesn't
  // render the Svelte Flow node, so spawnPatch's "wait for N nodes"
  // check times out. Functional coverage lives in
  // e2e/tests/grouping-phase1.spec.ts (creates a group from an
  // actual selection of modules). Promote here once a spawnPatch
  // overload accepts initial node.data.
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  // CADILLAC renders as a roaming overlay sprite (CadillacOverlay), not
  // as a SvelteFlow card — Canvas.svelte filters it out of flowNodes so
  // xyflow doesn't paint a fallback box. spawnPatch's "wait for N cards"
  // would hang. The def has zero ports anyway (it's meta-domain).
  // Functional coverage: e2e/tests/cadillac.spec.ts.
  cadillac: 'overlay sprite, not a flow card (zero ports); covered by e2e/tests/cadillac.spec.ts',
};

// ────────── RENDER-SMOKE skips (groups C/D/F only) ──────────
//
// Inherited VERBATIM from modules.spec.ts's SKIP_RENDER, minus the two entries
// that are whole-sweep skips above. ⚠ This is deliberately NOT a whole-test
// skip: the module still renders a card, so groups A/B/E (handle parity, count,
// control bounds) run for it exactly as they did in the three sweeps that never
// skipped it. Only the render-smoke assertions are stood down.
const SKIP_RENDER_SMOKE: Record<string, string> = {
  // GIBRIBBON renders DOOM-WAD sprites; the shareware DOOM1.WAD is gitignored
  // and baked in by the build-web job (SHA-pinned download from an external
  // mirror). On a clean checkout — OR when that single-mirror download misses
  // transiently in CI — the spawn-time fetch 404s, which the strict "no console
  // errors" smoke rejects. Same ROM-404 shape as the since-retired qbert/snes9x
  // (its siblings were already exempted; gibribbon was overlooked → a latent
  // flake that fired on PR #832's shard 4). Render coverage lives in
  // e2e/tests/gibribbon.spec.ts; the real cure for the flake is hardening the
  // build-web WAD acquisition (task #83).
  gibribbon: 'renders the gitignored DOOM WAD (404s on clean checkout / transient build-web miss); covered by e2e/tests/gibribbon.spec.ts',
};

// QUARANTINED (known flake) pending follow-up tasks — the render-smoke group
// only, for the same reason as SKIP_RENDER_SMOKE above. Distinct from it: a
// QUARANTINE entry is a module that SHOULD pass here but currently flakes, and
// whose un-fixme is owned by the referenced task.
//
// ⚠ NAME + SHAPE ARE LOAD-BEARING. `scripts/test-ledger.mjs` reads this record
// out of THIS FILE by name (`readRecord(<this spec>, 'QUARANTINE')`) to render
// the ledger's spawn-smoke section, and `scripts/e2e-skip-budget.mjs` claims the
// companion `test.fixme` row by (spec, /task #102/). Move or rename it and both
// go red — which is the intended coupling, not a hazard to route around.
const QUARANTINE: Record<string, string> = {
  // task #102 — TOYBOX is WebGL-heavy and times out at the 30s default test
  // timeout on CI's SwiftShader software renderer (ci-swiftshader-video-e2e
  // timeout class; heavy first-paint, passes locally on a real GPU). Skipped
  // until #102 lands SwiftShader-scaled timeouts / WEBGL_HEAVY routing for it
  // and restores this coverage, THEN un-fixme.
  toybox: 'task #102: SwiftShader software-renderer timeout (heavy WebGL); restore coverage then un-fixme',

  // ── ⏸ FLAKE-PARK #1847 ────────────────────────────────────────────────────
  // These three are NOT a SwiftShader timeout class like toybox above — they are
  // NONDETERMINISTIC: in the 96 h CI census to 2026-08-18 each failed and then
  // PASSED ON RETRY at the same SHA, so every one of those jobs reported SUCCESS
  // and the debt was invisible in the green/red signal. Parked here rather than
  // deleted; the title the branch renders is IDENTICAL to the live one, so
  // un-parking is a one-entry deletion from this map.
  // LOST WHILE PARKED: each module's slot in the per-module spawn smoke — that
  // its card renders with the registry-derived handle count and a clean console.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  //
  // ⚠ CARRIED OVER FROM modules.spec.ts BY #1861, AND THE PARK IS NOT WIDENED
  // OR NARROWED. #1850 parked these in modules.spec.ts ONLY — on main they still
  // run, unparked, in io-spec-consistency, per-module-per-port-handles and
  // card-control-overflow. So standing down the RENDER-SMOKE group here (rather
  // than the whole test) reproduces main exactly: modules.spec.ts's assertions
  // parked, the other three specs' assertions live.
  // ⚠ The one entry worth checking twice is the HANDLE COUNT named in "LOST
  // WHILE PARKED" above. It still runs for these three — and that is NOT an
  // un-park: the count assertion this sweep runs is io-spec-consistency's own
  // `toHaveCount(inputs + outputs)`, which #1850 never touched and which is
  // live on main for these modules today. modules.spec.ts's separate copy of
  // that assertion is the one that was parked, and it is gone with the file.
  bluebox:
    'FLAKE-PARK #1847 — nondeterministic on CI: 9 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused',
  buggles:
    'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused',
  quadralogical:
    'FLAKE-PARK #1847 — nondeterministic on CI: 3 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused',
};

// ────────── Heavy-WebGL budgets + scheduling (from modules.spec.ts) ─────────
//
// WebGL-heavy modules whose FIRST-paint is slow on CI's SwiftShader software
// renderer — markedly slower at 1024×768 (#662, 2.56× the pixels of the old
// 640×480). The generic 5s spawn-readiness wait + default test timeout aren't
// enough to mount + measure them on CI (b3ntb0x's 8×-oversampled NTSC chain,
// mandleblot's per-pixel GPU fractal). We still run every assertion group for
// these; we only grant a longer budget so the heavy first-paint can complete.
// Their DEEP render behaviour is covered by dedicated heavy-lane specs
// (b3ntb0x.spec.ts; mandleblot-render-smoke.spec.ts — both routed to the
// serialized e2e-video lane via WEBGL_HEAVY_GLOBS in playwright.config.ts).
// Also 'twotracks' (xyflow keeps the node wrapper visibility:hidden until
// ResizeObserver fires; on CI's production preview bundle TwotracksCard —
// 580px wide, complex layout — can take longer than the default 5s),
// 'mandelbulb' (a per-pixel GPU 3D fractal raymarcher whose first-paint shader
// compile overruns the default budget) and 'warrensvisions' (a 520px
// two-column card whose mount compiles two programs and whose every frame runs
// a 128² inverse FFT on the CPU plus a full-res composite — measured at
// ~4.2 ms/frame on SwiftShader against a 1.80 ms passthrough floor).
const HEAVY_RENDER = new Set(['b3ntb0x', 'mandleblot', 'mandelbulb', 'twotracks', 'colourofmagic', 'sourcery', 'warrensvisions']);
const HEAVY_MOUNT_TIMEOUT = 30_000;
const HEAVY_TEST_TIMEOUT = 90_000;
// Baseline per-test budget. WebGL-heavy cards (mandelbulb/toybox/cube/
// quadralogical/b3ntb0x/…) paint their connection handles slowly on CI's
// software renderer, so the 30s Playwright default times out while handles are
// still mounting. This is the budget this spec has always taken.
const BASE_TEST_TIMEOUT = 60_000;
// Bound the "all handles rendered" settle separately from the test budget so a
// stuck card fails with a handle-count message rather than an anonymous
// test-level timeout.
const HANDLE_SETTLE_TIMEOUT = 45_000;
// Frames of LIVE (unfrozen) rendering the console-error group observes on a
// video card. FRAMES, not milliseconds: a wall-clock budget is a different
// number of frames on every renderer (7.9 fps under E2E_SWIFTSHADER=1 vs ~60
// on a real GPU), so it would be a different assertion per machine. Four is
// enough that the draw path, the cross-domain bridge tick and a couple of
// steady-state frames have all run.
const LIVE_DRAW_FRAMES = 4;

// ⚠ DOOM IS IN THIS SWEEP, AND IT WAS IN ALL FOUR OF THE SPECS THIS REPLACES.
// Read this before "fixing" anything about how long it renders here.
//
// `video/modules/doom.ts` calls `runtime.runTic()` inside `surface.draw`, and
// `runTic` runs exactly one `dgpt_tick` — so DOOM's GAME CLOCK IS ITS FRAME
// CLOCK: one rendered frame is one game tic, and changing how long it renders
// re-specifies HOW FAR THE MARINE WALKS. That is why the owner ruling forbids
// touching DOOM's timing without specific approval.
//
// What this sweep asserts about DOOM is unchanged and contains no game state:
// handle parity, handle count, card identity, card box, control bounds, console
// errors. What DID change is the tic count, and it changed DOWNWARD:
// modules.spec.ts ran DOOM UN-FROZEN for the whole test (seconds of tics at
// whatever rate the renderer managed), whereas here it mounts FROZEN and then
// renders exactly LIVE_DRAW_FRAMES tics. Fewer tics, and a fixed number of them
// instead of a renderer-dependent one.
//
// EXCLUDING it was considered and rejected: the other three specs assert DOOM's
// handle parity today, so dropping it from the sweep would be a real coverage
// loss to avoid a change that is strictly more deterministic. No DOOM spec, DOOM
// wait, DOOM budget or DOOM ledger entry is touched by this file.

// ────────── Video render freeze: which modules, and why THAT predicate ─────
//
// Freezing means `VideoEngine.stepInner()` returns before the per-frame draw,
// so it only does anything for a module the VIDEO ENGINE actually steps — i.e.
// a `domain === 'video'` node.
//
// ⚠ MEASURED, and it corrects a claim the old card-control-overflow sweep made.
// That sweep froze on a `touchesVideo` predicate ("any video / mono-video port
// on either side, NOT just domain === 'video' — WAVESCULPT is audio-domain with
// a 3D viewport"). Solo-spawn WAVESCULPT and the video engine advances ZERO
// frames across four animation frames whether the flag is set or not: with no
// video-domain node in the patch there is nothing for that engine to step, and
// WAVESCULPT's own viewport does not read the flag (nothing outside
// engine.ts / VideoOutBody / BackdraftOutputBody / DetachedDisplay does). So on
// those cards the freeze was a NO-OP, and the sweep's stated saving there was
// imaginary. This was caught by the live-draw POSITIVE CONTROL below, which is
// the whole reason that control exists.
//
// Consequences, both directions:
//   * audio-domain cards are never frozen now — which is what modules.spec.ts
//     and this spec's own original predicate already did, and is a no-op change
//     for the layout sweep, since the flag never reached them anyway.
//   * `domain === 'video'` cards are frozen for groups A–E and un-frozen for F,
//     where the frame counter is REQUIRED to move.
const isVideoDomain = (mod: RegistryModule): boolean => mod.domain === 'video';

// Set via addInitScript (document_start, every navigation) so it covers
// spawnPatch's navigation. The card still mounts (shaders compiled, FBOs
// allocated → handles render); only the SwiftShader-bound per-frame draw passes
// are skipped. See VideoEngine.stepInner()'s __videoEngineFreezeRender branch.
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

interface LiveDrawProof {
  /** The freeze flag as the page sees it AFTER the unfreeze write. */
  frozen: boolean;
  /** The unrelated pause flag — the only other early-return in stepInner(). */
  paused: boolean;
  /** VideoEngine.currentFrameCount() delta across the unfrozen window. */
  framesDelta: number;
  /** false when the page exposes no video domain to read (non-video page). */
  readable: boolean;
}

/**
 * Un-freeze the video render and let REAL draw passes run for a bounded number
 * of frames, returning the evidence that they did.
 *
 * ⚠ WHY A POSITIVE CONTROL IS MANDATORY HERE. The assertion this feeds is
 * `expect(errors).toEqual([])`. "The draws produced no console errors" and "no
 * draw ever happened" print the SAME empty array, so without evidence that the
 * render actually resumed, group F would be a gate whose green run looks
 * identical to a gate that never looked.
 *
 * WHAT THE PROOF IS, mechanically: `VideoEngine.stepInner()` has exactly two
 * early-returns before the draw — `__videoEngineFreezeRender` and
 * `__videoEnginePause` — and BOTH branches still increment the frame counter.
 * So a frame-count delta alone proves only that the step loop ran. Combined
 * with both flags read false in the same page, the draw path is the only branch
 * that could have executed. All three are asserted.
 *
 * ⚠ WHAT IT STILL CANNOT SEE: whether any given module's own draw() was
 * REACHED — pull evaluation prunes nodes outside the frame's active set, and a
 * solo-spawned module with no downstream sink may legitimately be pruned. This
 * proves the engine rendered, not that this card did. That is the same reach
 * modules.spec.ts had (it never asserted a draw at all), so it is preserved,
 * not weakened; a per-module draw assertion is the render-smoke specs' job.
 */
async function unfreezeAndDraw(page: Page): Promise<LiveDrawProof> {
  // ⚠ `currentFrameCount` is a METHOD — read it THROUGH the domain object every
  // time. Detaching it (`const fc = domain.currentFrameCount; fc.call(null)`)
  // loses `this` and throws inside the engine, which is how the first version
  // of this helper failed.
  const before = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __videoEngineFreezeRender?: boolean;
      __engine?: () => { getDomain?: (d: string) => { currentFrameCount?: () => number } | null } | null;
    };
    w.__videoEngineFreezeRender = false;
    const dom = w.__engine?.()?.getDomain?.('video') ?? null;
    const readable = typeof dom?.currentFrameCount === 'function';
    return { readable, frames: readable ? dom!.currentFrameCount!() : 0 };
  });

  await waitFrames(page, LIVE_DRAW_FRAMES);

  return await page.evaluate(
    ({ readable, frames }) => {
      const w = globalThis as unknown as {
        __videoEngineFreezeRender?: boolean;
        __videoEnginePause?: boolean;
        __engine?: () => { getDomain?: (d: string) => { currentFrameCount?: () => number } | null } | null;
      };
      const dom = w.__engine?.()?.getDomain?.('video') ?? null;
      const stillReadable = typeof dom?.currentFrameCount === 'function';
      const now = stillReadable ? dom!.currentFrameCount!() : 0;
      return {
        frozen: w.__videoEngineFreezeRender === true,
        paused: w.__videoEnginePause === true,
        framesDelta: now - frames,
        readable: readable && stillReadable,
      };
    },
    before,
  );
}

/** Partition the node's rendered handles into inputs (target) vs outputs
 *  (source) in ONE round trip.
 *
 *  ⚠ ADDRESSED BY NODE ID, never by a per-type node class. xyflow stamps the
 *  wrapper class from the EMITTED node type, and every lane node emits
 *  `moduleShell` — so `.svelte-flow__node-<type>` matches nothing and this
 *  sweep would read an empty handle set for every module while its per-port
 *  assertions all passed vacuously.
 *
 *  SOME modules (sequencer, score) declare an input AND an output with the SAME
 *  id ("clock" for both) — `[data-handleid="clock"]` matches BOTH, so we can't
 *  assert per id without first separating by Svelte Flow's source/target class.
 *
 *  ⚠ ONE `evaluateAll`, deliberately: the version this replaced looped
 *  `handles.nth(i).getAttribute(...)` from the Playwright side, which is one CDP
 *  round trip per handle ON THE SAME MAIN THREAD as the card it is measuring.
 *  That is what made this the most expensive of the four sweeps at 5.36 s/test
 *  against modules.spec.ts's 4.06 s/test for MORE assertions. */
async function readHandleIds(
  page: Page,
  nodeId: string,
): Promise<{ inputs: string[]; outputs: string[] }> {
  return await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"]`)
    .locator('.svelte-flow__handle')
    .evaluateAll((els) => {
      const inputs: string[] = [];
      const outputs: string[] = [];
      for (const el of els) {
        const id = el.getAttribute('data-handleid');
        if (!id) continue;
        const cls = el.getAttribute('class') ?? '';
        if (cls.includes('source')) outputs.push(id);
        else inputs.push(id); // 'target' or unspecified → input
      }
      return { inputs, outputs };
    });
}

test.describe.configure({ mode: 'parallel' });

test.describe('I/O spec consistency: def <-> rendered tile handles', () => {
  test('seed: registry manifest is non-empty + every non-meta module has ≥1 port', () => {
    expect(REGISTRY.length, 'manifest contains modules').toBeGreaterThan(0);
    // Meta-domain modules (sticky, group) intentionally have zero
    // ports — they're pure-UI cards with no signal-routing surface.
    // LIVECODE + clockedRunner are side-tools that mutate the rack
    // via the JS runtime; they intentionally have no patch I/O.
    // CHROMACONSOLE is a control surface for an EXTERNAL device: its output
    // is MIDI on a wire, not a patch cable, so it has no ports by design.
    const ZERO_PORT_OK = new Set(['livecode', 'clockedRunner', 'chromaconsole']);
    for (const s of REGISTRY) {
      if (s.domain === 'meta') continue;
      if (ZERO_PORT_OK.has(s.type)) continue;
      const total = s.inputs.length + s.outputs.length;
      expect(total, `${s.type} has at least one port`).toBeGreaterThan(0);
    }
  });
});

function declareSweep(mod: RegistryModule): void {
  const expectedHandles = mod.inputs.length + mod.outputs.length;
  const title =
    `module ${mod.type}: handles match def (${expectedHandles}) + renders + no console errors`;

  const skipReason = SKIP_DEF_VS_UI[mod.type];
  if (skipReason) {
    // .fixme over .skip when the test SHOULD pass once the fix lands —
    // Playwright surfaces fixme-marked tests in the report so they're
    // harder to forget.
    test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => { /* see SKIP_DEF_VS_UI */ });
    return;
  }

  // Group-level stand-downs. Each emits its OWN report row so the exemption
  // stays visible in the report exactly as it was when it disabled a whole
  // spec's test, while the module's other groups keep running below.
  const smokeSkip = SKIP_RENDER_SMOKE[mod.type];
  if (smokeSkip) {
    test.fixme(
      `module ${mod.type} render smoke (name + box + no console errors) [SKIPPED: ${smokeSkip}]`,
      () => { /* see SKIP_RENDER_SMOKE for the alternative coverage */ },
    );
  }
  const quarantineReason = QUARANTINE[mod.type];
  if (quarantineReason) {
    // The annotation carries the QUARANTINE map's reason onto the report row
    // itself (ONE source — the map; #1502's audit reads the annotation, and a
    // fixme without one is an anonymous skip). ⚠ The title deliberately carries
    // NO `[SKIPPED:]` marker: that marker makes the row a "placeholder" to
    // scripts/test-reconciliation.mjs, which excludes it from the skip-budget's
    // site inventory — and this row is the one scripts/e2e-skip-budget.mjs
    // claims by (spec, /task #102/).
    test.fixme(
      `module ${mod.type} render smoke (name + box + no console errors)`,
      { annotation: { type: 'fixme', description: quarantineReason } },
      () => { /* QUARANTINED — see QUARANTINE map */ },
    );
  }
  const overflowExempt = EXEMPT_CONTROL_OVERFLOW[mod.type];
  if (overflowExempt) {
    // Known pre-existing overflow debt. The module still appears in the report
    // as documented debt, and the anchor test below keeps the key honest.
    // ⚠ Because this is `test.fixme`, the tile is NEVER MEASURED for overflow —
    // see the stated-scope note on the anchor test: an exempt surface that has
    // since been reflowed stays exempt silently.
    test.fixme(
      `module ${mod.type}: controls fit within the tile [EXEMPT: ${overflowExempt}]`,
      () => { /* see EXEMPT_CONTROL_OVERFLOW in _card-overflow.ts */ },
    );
  }

  const runSmoke = !smokeSkip && !quarantineReason;
  const isHeavy = HEAVY_RENDER.has(mod.type);
  const isVideo = isVideoDomain(mod);

  test(title, async ({ page }) => {
    test.setTimeout(isHeavy ? HEAVY_TEST_TIMEOUT : BASE_TEST_TIMEOUT);

    // Attach BEFORE the navigation so group F sees boot-time errors too.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Freeze the per-frame video GL render for the spawn + the DOM/layout
    // groups (A–E), which is exactly how those assertions ran before this
    // consolidation. Group F un-freezes below so it keeps observing real draws.
    if (isVideo) await freezeVideoRender(page);

    await page.goto('/rack?seed=none');

    await spawnPatch(
      page,
      [
        {
          id: SUT,
          type: mod.type,
          position: { x: 400, y: 60 },
          domain: mod.domain,
          params: driverFor(mod).params,
        },
      ],
      [],
      isHeavy ? { mountTimeout: HEAVY_MOUNT_TIMEOUT } : undefined,
    );

    const node = page.locator(`.svelte-flow__node[data-id="${SUT}"]`);

    // ── GROUP D (part 1): the surface mounted and is visible ──
    await expect(node, `${mod.type} node visible`).toBeVisible(
      isHeavy ? { timeout: HEAVY_MOUNT_TIMEOUT } : undefined,
    );

    // ── GROUP B: handle COUNT — and the settle that group A depends on ──
    // Wait for ALL handles to render before snapshotting their ids. A bare
    // count() taken mid-render undercounts on slow GL cards → flaky id-mismatch.
    // Settling on the def's port total is deterministic and only costs time for
    // slow cards.
    await expect(
      node.locator('.svelte-flow__handle'),
      `${mod.type}: all ${expectedHandles} handles rendered before reading ids`,
    ).toHaveCount(expectedHandles, { timeout: HANDLE_SETTLE_TIMEOUT });

    // ── GROUP A: handle ids == def port ids ──
    const { inputs: handleInputs, outputs: handleOutputs } = await readHandleIds(page, SUT);
    const renderedInputs = new Set(handleInputs);
    const renderedOutputs = new Set(handleOutputs);

    // A1 — per-port pinpoint assertions FIRST, so a dropped port fails by NAME
    // ("doom.p1_up (input, type=cv): handle present…") rather than as an array
    // diff. This is the regression net for the DOOM PR #393 class: drop a port
    // from the def, this fails naming it.
    for (const port of mod.inputs) {
      expect(
        renderedInputs.has(port.id),
        `${mod.type}.${port.id} (input, type=${port.type}): handle present in card UI (rendered inputs: ${[...renderedInputs].sort().join(', ')})`,
      ).toBe(true);
    }
    for (const port of mod.outputs) {
      expect(
        renderedOutputs.has(port.id),
        `${mod.type}.${port.id} (output, type=${port.type}): handle present in card UI (rendered outputs: ${[...renderedOutputs].sort().join(', ')})`,
      ).toBe(true);
    }

    // A2 — and STRICT set equality, which additionally catches the other
    // direction: a handle the card renders that the def does not declare (a
    // cable can be routed to a port the engine knows nothing about).
    expect(
      [...handleInputs].sort(),
      `${mod.type}: rendered input handle ids match def`,
    ).toEqual(mod.inputs.map((p) => p.id).sort());
    expect(
      [...handleOutputs].sort(),
      `${mod.type}: rendered output handle ids match def`,
    ).toEqual(mod.outputs.map((p) => p.id).sort());

    // ── GROUP C: the tile says which module it is ──
    if (runSmoke) {
      // Title-text assertion: the tile hosts the editable name button (see
      // ModuleNameLabel.svelte). The default auto-assigned name for the first
      // instance is the BARE uppercased type prefix (e.g. "WAVESCULPT");
      // subsequent instances get "<TYPE>2", "<TYPE>3", ... — see the
      // bare-prefix policy in $lib/multiplayer/module-naming.ts. Use a regex so
      // the test stays valid regardless of how many instances spawned earlier
      // in the same browser context, AND so punctuation in `mod.label` like
      // "MIDI-CV-BUDDY" or "NUMPAD+" doesn't drift this.
      const nameLabel = node.locator('[data-testid="tile-name-label"]');
      if (await nameLabel.count() > 0) {
        const prefix = mod.type.toUpperCase();
        const namePattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)?$`);
        await expect(nameLabel, `${mod.type} name matches /<TYPE>(\\d+)?/`).toHaveText(namePattern);
      } else {
        await expect(node, `${mod.type} contains def label`).toContainText(mod.label, {
          ignoreCase: true,
        });
      }

      // ── GROUP D (part 2): non-zero rect (catches the silent DOM-only mount) ──
      const box = await node.boundingBox();
      expect(box, `${mod.type} bounding box`).toBeTruthy();
      expect(box!.width, `${mod.type} tile width`).toBeGreaterThan(50);
      expect(box!.height, `${mod.type} tile height`).toBeGreaterThan(50);
    }

    // ── GROUP E: controls fit within the tile ──
    if (!overflowExempt) {
      await assertControlsFitCard(page, mod.type, mod.type);
    }

    // ── GROUP F: no console / page errors, over a window that INCLUDES real
    //    draw passes for video cards (see the file header + unfreezeAndDraw). ──
    if (runSmoke) {
      if (isVideo) {
        const proof = await unfreezeAndDraw(page);
        expect(
          proof.readable,
          `${mod.type}: the page exposes no video engine to un-freeze — the live-draw window below would be vacuous`,
        ).toBe(true);
        expect(
          proof.frozen,
          `${mod.type}: __videoEngineFreezeRender is STILL true — the draw path never ran, so "no console errors" would prove nothing`,
        ).toBe(false);
        expect(
          proof.paused,
          `${mod.type}: __videoEnginePause is set — stepInner() returns before the draw, so the live-draw window is vacuous`,
        ).toBe(false);
        expect(
          proof.framesDelta,
          `${mod.type}: the engine advanced ${proof.framesDelta} frames across ${LIVE_DRAW_FRAMES} un-frozen animation frames — the render loop is not running, so the live-draw window is vacuous`,
        ).toBeGreaterThan(0);
      }

      expect(
        errors,
        `console/page errors during ${mod.type} render: ${errors.join('; ')}`,
      ).toEqual([]);
    }
  });
}

// ── HEAVY WebGL RENDERS DO NOT RUN CONCURRENTLY ─────────────────────────────
//
// MEASURED 2026-08-13 (#1539): all seven HEAVY_RENDER modules land on ONE shard
// (5/10 — expanded via `playwright test --list --shard=N/10` with the e2e lane's
// real flags), and that shard runs `--workers=4`. So up to four heavy SwiftShader
// renders compete for the software renderer at once. That is not bad luck; with
// count-based sharding it is the expected case.
//
// It cost a red run: `module b3ntb0x renders + has 20 handles` exceeded its 90 s
// budget on BOTH the attempt and the retry, on shard 5, on a PR that touched no
// WebGL code at all (it deleted three unrelated specs — which re-partitions every
// shard, because Playwright shards by test COUNT).
//
// WHY SERIALISING IS FREE HERE: shard 5 runs ~466 s while shards 3 and 10 set the
// critical path at ~790 s. Spending shard 5's slack to remove a required-lane
// flake costs nothing in time-to-merge.
//
// `mode: 'default'`, NOT `'serial'`: default runs them in order in a single
// worker; serial ADDITIONALLY skips the rest of the group after any failure,
// which would hide six results behind one. We want sequencing, not a cascade.
//
// This is a scheduling fix, not a budget change — no timeout was raised.
test.describe('module tile sweep (parallel)', () => {
  test.describe.configure({ mode: 'parallel' });
  for (const mod of REGISTRY) {
    if (HEAVY_RENDER.has(mod.type)) continue;
    declareSweep(mod);
  }
});

test.describe('module tile sweep — HEAVY WebGL (one at a time)', () => {
  test.describe.configure({ mode: 'default' });
  for (const mod of REGISTRY) {
    if (!HEAVY_RENDER.has(mod.type)) continue;
    declareSweep(mod);
  }
});

// ─── ARTIFACT ANCHOR — every curated key must still name a live module ──────
//
// ⚠ There is no population COUNT here and there must never be one. What made a
// 7th control-overflow exemption red used to be a hand-typed cap frozen at 6;
// it died with the kill-ratchets directive (2026-08-10). A count could not tell
// a justified addition from an unjustified one, only that the number moved —
// and BOTH already show up as a named key plus a prose reason in the diff.
// Review the reason string; that was always the real gate.
//
// WHAT THIS ANCHORS INSTEAD is a protection the count never had. Every map in
// this file is read exactly once, as `MAP[mod.type]`, so a key naming a module
// that was renamed or deleted is simply never consulted — a dead exemption,
// invisible. This makes that RED. A name is checkable against the tree; a
// number never was. ⚠ THREE of these five maps had NO anchor at all before the
// consolidation (SKIP_RENDER_SMOKE, QUARANTINE and HEAVY_RENDER all lived in
// modules.spec.ts, which anchored nothing).
//
// ⚠ STATED SCOPE — what this file STILL cannot see: an exempt card that has
// since been REFLOWED and no longer overflows stays exempt SILENTLY, because
// the sweep `test.fixme`s the overflow row rather than measuring it, so there
// is no "unexpectedly passing" signal anywhere. The debt can only be reclaimed
// by a human re-running the card unexempted. Fixing that means measuring exempt
// cards and asserting they still overflow — a real change to the sweep's shape,
// deliberately not made here. The same applies to SKIP_RENDER_SMOKE and
// QUARANTINE.
test('sweep exemption keys are anchored to REGISTRY', () => {
  const liveTypes = new Set(REGISTRY.map((m) => m.type));

  // ── VACUITY FLOOR ──
  // Every assertion below is a lookup against REGISTRY. If REGISTRY resolved
  // nothing, "no key is stale" would be trivially true and this test would pass
  // while proving NOTHING. This is a sanity FLOOR, not a ratchet: the tree
  // carries ~196 modules, so it only trips if the manifest is empty/truncated.
  expect(
    REGISTRY.length,
    'VACUITY: REGISTRY resolved almost no modules — the anchors below would pass trivially. '
    + 'Run `flox activate -- task test:emit-manifest` (e2e/.generated/registry-manifest.json).',
  ).toBeGreaterThan(100);

  // ── ARTIFACT ANCHOR ──
  // Ground truth is the REGISTRY module, not the list. A key that outlives the
  // module it names is a dead exemption the sweep can never consult.
  const moduleKeyIsLive = (moduleType: string): boolean => liveTypes.has(moduleType);

  const staleIn = (name: string, keys: Iterable<string>): string[] =>
    [...keys].filter((k) => !moduleKeyIsLive(k)).map((k) => `${name}.${k}`).sort();

  expect(
    [
      ...staleIn('SKIP_DEF_VS_UI', Object.keys(SKIP_DEF_VS_UI)),
      ...staleIn('SKIP_RENDER_SMOKE', Object.keys(SKIP_RENDER_SMOKE)),
      ...staleIn('QUARANTINE', Object.keys(QUARANTINE)),
      ...staleIn('EXEMPT_CONTROL_OVERFLOW', Object.keys(EXEMPT_CONTROL_OVERFLOW)),
      ...staleIn('HEAVY_RENDER', HEAVY_RENDER),
    ].sort(),
    'STALE KEY: these curated keys name modules that are no longer in REGISTRY. The module was '
    + 'renamed or deleted, so `MAP[mod.type]` can never match and the entry buys nothing — delete '
    + 'it. If the module was RENAMED, re-measure before re-adding the key under its new name: the '
    + 'debt (layout overflow, first-paint cost, flake) may be gone.',
  ).toEqual([]);

  // ── PERMANENT NEGATIVE CONTROL, BOTH DIRECTIONS ──
  // Runs on EVERY execution, not once at authoring time. Without it, an anchor
  // that silently resolved nothing (empty manifest, a refactor that made the
  // resolver return `true` unconditionally) prints the same empty array as a
  // genuinely clean tree — "no stale keys" and "never looked" are
  // indistinguishable from the output. So force both answers out of the SAME
  // resolver the assertions above used.
  const liveType = REGISTRY[0]?.type;
  expect(liveType, 'NEGATIVE CONTROL: REGISTRY is empty').toBeTruthy();
  expect(
    staleIn('FABRICATED', ['__no_such_module__']),
    'NEGATIVE CONTROL (false leg): the resolver called a non-existent module type LIVE — it '
    + 'accepts anything, so the stale-key assertion above is decoration.',
  ).toEqual(['FABRICATED.__no_such_module__']);
  expect(
    staleIn('FABRICATED', [liveType!]),
    `NEGATIVE CONTROL (true leg): the resolver called the real module "${liveType}" STALE — it `
    + 'rejects everything, so it would have reddened on a clean tree.',
  ).toEqual([]);
});
