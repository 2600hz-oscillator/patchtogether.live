// per-module-per-port-inputs.spec.ts
//
// SPLIT from per-module-per-port.spec.ts (#1538). That file was 3,370 CPU-s —
// 1.74x a whole balanced shard's budget — so no cost-based scheduler could
// place it. Splitting at its three existing top-level `test.describe`s makes a
// balanced partition possible; the shared prelude moved verbatim to
// `_per-module-per-port-shared.ts`. No test logic changed.
//
// Measured cost of this dimension: 1652.6 s / 173 tests (+ heavy-GL budget)

import { test, expect } from '@playwright/test';
import {
  EXEMPT_INPUT_DRIVE,
  HEAVY_GL_MOUNT_MS,
  PER_INPUT_MS,
  PER_PORT_BASE_MS,
  REGISTRY,
  SKIP_SPAWN,
  budgetFlatUntilInputs,
  collectPageErrors,
  doomAssetsPresent,
  freezeVideoRender,
  heavyVideoTimeout,
  legacyWireUpBudgetMs,
  observeScopePeak,
  pickInputSource,
  readEdgeIds,
  runFor,
  spawnPatch,
  touchesVideo,
  wireUpBudgetMs,
  emitSkipReason,
  liveEmitOutputs,
  PER_OUTPUT_MS,
  emitBudgetMs,
} from './_per-module-per-port-shared';
import type {
  SpawnEdge,
  SpawnNode,
} from './_per-module-per-port-shared';

test.describe.configure({ mode: 'parallel' });


// ────────── DIM 3: inputs accept ──────────
//
// For every declared input, spawn a type-compatible upstream source,
// patch the edge, assert the edge materialises + no console errors.
// This is the "wire-up" coverage — strictly weaker than verifying a
// downstream effect, but strong enough to catch:
//   * input port disappearing from the def (regression — failure: pick
//     fails because mod.inputs no longer contains the port we expected,
//     OR the edge insert fails because the engine rejects the port id)
//   * cable-type drift (input typed `cv` in the def but `audio` in the
//     engine's port table → addEdge rejects it → edge missing post-spawn)
//   * console-error storms (a buggy input handler that throws on first
//     CV value)

test.describe('per-module per-port: inputs accept signal (wire-up)', () => {
  for (const mod of REGISTRY) {
    if (mod.inputs.length === 0) continue;
    const skipReason = SKIP_SPAWN[mod.type];
    const title = `${mod.type}: every declared input accepts a type-compatible upstream cable`;
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }

    test(title, async ({ page }) => {
      // Per-iteration: spawnPatch (~1s under-load) + 100ms wait + edge-read
      // (~50ms). The default 30s test budget is ALWAYS too tight under shard
      // CPU contention — even at the previous "> 20 inputs" gate, modules
      // like BENTBOX (16 inputs) sat at ~24s of pure per-iter work with
      // zero headroom, and flaked on a heavier-than-usual runner. Scale
      // unconditionally to (n * 1.5s + 30s) baseline so any module finishes
      // with ~1× margin on top of the iteration cost.
      test.setTimeout(Math.max(30_000, mod.inputs.length * 1500 + 30_000));
      // Video modules: we FREEZE the engine's per-frame GL render for this
      // iteration (see freezeVideoRender + VideoEngine.step()). The wire-up
      // assertions are graph/DOM-level — a materialised edge in the patch
      // store, no console errors — so the heavy GLSL render (a 4-pass float
      // NTSC pipeline for b3ntb0x, a raymarch for mandelbulb, …) is purely
      // incidental. Freezing it removes the SwiftShader-bound per-input cost
      // that used to force the giant `inputs * 6_000` budget below; with the
      // render off, per-input work is DOM + addEdge only, so a small uniform
      // headroom on top of the base scaling covers CI contention with ~2×
      // margin. (Pixel-asserting coverage of these inputs lives in the
      // bespoke video specs + the behavioral lane, which keep rendering.)
      // Keyed on touchesVideo (any video port), NOT domain — so audio-domain
      // GL cards (WAVESCULPT: wall1..6 video ins + video_out) also freeze the
      // render + get the heavy budget instead of timing out wiring inputs.
      if (touchesVideo(mod)) {
        await freezeVideoRender(page);
        // The inner `Math.max(45_000, …)` that used to sit here is GONE. It was
        // a second floor stacked under the first — binding below 8 inputs, and
        // then swallowed whole by the 90 000 above it, so it could never change
        // any budget. With the tax additive, the 30_000 base carries that job
        // honestly. See wireUpBudgetMs for the derivation and its gates.
        test.setTimeout(wireUpBudgetMs(mod.inputs.length));
      }

      const errors = collectPageErrors(page);

      await page.goto('/rack?shell=legacy&seed=none');

      // DOOM-asset skip — when the WASM blob isn't present the module
      // can't materialise its input handles, breaking the edge assertion.
      // The handle-presence dim STILL runs (it reads the def-side handles
      // off the rendered card, which the SvelteKit dev server renders
      // regardless of WASM presence).
      if (mod.type === 'doom') {
        const { wasm, wad } = await doomAssetsPresent(page);
        test.skip(!wasm || !wad, 'DOOM WASM/WAD not built — see static/doom/DOWNLOAD_INSTRUCTIONS.md');
      }

      for (const port of mod.inputs) {
        const exemptReason = EXEMPT_INPUT_DRIVE[`${mod.type}.${port.id}`];
        if (exemptReason) {
          // eslint-disable-next-line no-console
          console.log(`[per-port] SKIP drive ${mod.type}.${port.id}: ${exemptReason}`);
          continue;
        }

        const source = pickInputSource(port.type, `up-${port.id}`);
        if (!source) {
          // Unknown port type — fail loudly. New cable types must extend
          // pickInputSource OR earn an EXEMPT_INPUT_DRIVE entry with a reason.
          expect(
            source,
            `${mod.type}.${port.id} (type=${port.type}): no upstream source known for type — extend pickInputSource or add EXEMPT_INPUT_DRIVE`,
          ).not.toBeNull();
          continue;
        }

        const nodes: SpawnNode[] = [
          {
            id: 'sut',
            type: mod.type,
            position: { x: 400, y: 60 },
            domain: mod.domain,
          },
          source.node,
        ];
        if (source.extraNode) nodes.push(source.extraNode);
        const edges: SpawnEdge[] = [
          {
            id: 'e-up-sut',
            from: { nodeId: source.node.id, portId: source.outPort },
            to:   { nodeId: 'sut',           portId: port.id },
            sourceType: source.sourceType,
            targetType: port.type,
          },
        ];
        if (source.extraNode) {
          // RASTERIZE needs its `in` audio input fed from NOISE so it
          // emits non-blank frames; otherwise the wire-up survives but
          // is vacuous. This wiring is implementation-detail of the
          // mono-video / image branch.
          edges.push({
            id: 'e-noise-rast',
            from: { nodeId: source.extraNode.id, portId: 'white' },
            to:   { nodeId: source.node.id,     portId: 'in' },
            sourceType: 'audio',
            targetType: 'audio',
          });
        }

        await spawnPatch(page, nodes, edges);

        // Minimal settle window — spawnPatch already waits for the DOM
        // node count to match, by which time the engine's addEdge has
        // fired. 100ms gives the cross-domain bridge + CV-bridge a tick
        // to wire up; we only need to assert "edge materialised", not
        // "downstream effect observable".
        await runFor(page, 100);

        // Edge survival check — the edge we asked to insert is still in
        // the patch graph. A silent engine.addEdge drop (the #414-style
        // class) would manifest as missing edge ids.
        const edgeIds = await readEdgeIds(page);
        expect(
          edgeIds,
          `${mod.type}.${port.id} (type=${port.type}): edge survived engine.addEdge`,
        ).toContain('e-up-sut');
      }

      // ⚠ THE LOAD-BEARING ASSERTION OF THIS DIM. The edge check above reads
      // the patch store, so it materialises whether or not the engine behind
      // the module ever came up — this is the only line here that can see a
      // module that FAILED TO LOAD.
      expect(
        errors.significant(),
        `${mod.type} inputs-accept: no console / page errors during input wire-up (a failed `
        + `resource load — a 404'd worklet, a dropped static asset — reads as "Failed to load `
        + `resource" with the url in brackets; see _page-errors.ts)`,
      ).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HEAVY-GL BUDGET IS DERIVED, NOT FLOORED
//
// Pure arithmetic against the LIVE registry — no page, no renderer, ~1 ms. These
// are the gates that would have caught the defect: a budget that reads as scaled
// and behaves as a constant passes every runtime check there is, because a
// timeout only spends wall clock when it FIRES. Nothing observes it otherwise.
//
// ⚠ WHAT THIS BUDGET CANNOT ABSORB, stated plainly so nobody sizes to it. The
// runner that went red printed `[perf-midi-cc] FPS diagnostic: idle=2.0` and had
// a 79-SECOND window with zero `/rack?shell=legacy&seed=none` navigations across all four workers. At
// ~2 fps a single `spawnPatch` can legally consume its whole 30 s mount cap, so
// 26 of them do not fit in any budget worth writing down. This change fixes the
// REVIEW defect — the per-port term is live again, and wavesculpt gets the
// 52 000 ms the floor was discarding — and it buys real margin on an ordinarily
// slow runner. It does NOT and must not try to cover a 79 s dead window. If that
// environment recurs, the answer is a CHEAPER PLAN for 26-port modules (fewer
// spawns, or the sweep split per-port), not a bigger number.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('per-port heavy-GL budget: DERIVED, not floored', () => {
  const heavyGl = REGISTRY.filter(touchesVideo);

  test('the per-port term is LIVE AT EVERY PORT COUNT — the crossover is 0', () => {
    // THE DEFECT, as one number. The old budget's per-port term did not start
    // binding until 31 inputs, so it was dead for 74 of the 78 heavy-GL modules.
    const legacy = budgetFlatUntilInputs(legacyWireUpBudgetMs);
    const now = budgetFlatUntilInputs(wireUpBudgetMs);
    const deadUnderLegacy = heavyGl.filter((m) => m.inputs.length <= legacy);
    expect(
      legacy + 1,
      `sanity: the OLD budget's per-port term must still compute as starting to bind at the 31 ` +
        `inputs this change documents — if this moved, the arithmetic under the fix changed too ` +
        `and every number in the comments needs re-deriving.`,
    ).toBe(31);
    expect(
      deadUnderLegacy.length,
      `…and that crossover left ${deadUnderLegacy.length}/${heavyGl.length} heavy-GL modules on a ` +
        `FLAT budget, including the largest one under it (${
          [...deadUnderLegacy].sort((a, b) => b.inputs.length - a.inputs.length)[0]?.type
        }).`,
    ).toBeGreaterThan(0);
    expect(
      now,
      `the NEW budget's per-port term must bind from the FIRST port (crossover 0, got ${now}). ` +
        `Any value above 0 means the budget is flat for every module below it — the defect this ` +
        `replaces. Crossover is COMPUTED from the constants, so it cannot drift from the prose.`,
    ).toBe(0);
  });

  test('NEGATIVE CONTROL: modules with different port counts get DIFFERENT budgets', () => {
    // The property the old budget failed. Perturb the input the budget claims to
    // price and require the number to move — for the REAL registry, not a
    // synthetic pair, because "the formula responds" and "the formula responds
    // over the range that actually exists" are different claims and only the
    // second one matters here.
    const distinctPortCounts = new Set(heavyGl.map((m) => m.inputs.length)).size;
    const distinctBudgets = new Set(heavyGl.map((m) => wireUpBudgetMs(m.inputs.length))).size;
    const distinctLegacy = new Set(heavyGl.map((m) => legacyWireUpBudgetMs(m.inputs.length))).size;
    expect(
      distinctBudgets,
      `${heavyGl.length} heavy-GL modules span ${distinctPortCounts} distinct port counts and must ` +
        `therefore get ${distinctPortCounts} distinct budgets — one per plan. The OLD budget ` +
        `produced only ${distinctLegacy}, which is what a flat number wearing a scaled costume ` +
        `looks like from the outside.`,
    ).toBe(distinctPortCounts);
    // And the pair that motivated this: the module that went red vs a small one.
    const wavesculpt = heavyGl.find((m) => m.type === 'wavesculpt');
    const mandleblot = heavyGl.find((m) => m.type === 'mandleblot');
    if (wavesculpt && mandleblot) {
      expect(
        wireUpBudgetMs(wavesculpt.inputs.length) - wireUpBudgetMs(mandleblot.inputs.length),
        `wavesculpt (${wavesculpt.inputs.length} inputs) must out-budget mandleblot ` +
          `(${mandleblot.inputs.length} inputs) by their port difference × ${PER_INPUT_MS} ms. ` +
          `Under the old floor both got exactly 90 000 ms.`,
      ).toBe((wavesculpt.inputs.length - mandleblot.inputs.length) * PER_INPUT_MS);
    }
  });

  test('the historical 90 000 ms constant is PRESERVED, and no module SHRANK', () => {
    // This change must not be readable as "the timeout was raised until it
    // passed". The constant survives verbatim as the zero-port budget, and the
    // direction of every other move is asserted rather than asserted about.
    expect(
      wireUpBudgetMs(0),
      `a heavy-GL module with ZERO inputs must still budget exactly the historical 90 000 ms — ` +
        `that anchor is what pins HEAVY_GL_MOUNT_MS (${HEAVY_GL_MOUNT_MS}) instead of leaving it free.`,
    ).toBe(90_000);
    const shrunk = heavyGl.filter(
      (m) => wireUpBudgetMs(m.inputs.length) < legacyWireUpBudgetMs(m.inputs.length),
    );
    expect(
      shrunk.map((m) => m.type),
      'no module may end up with LESS budget than it has today — a re-derivation that quietly ' +
        'tightens somebody is a new timeout class, not a fix.',
    ).toEqual([]);
  });

  test('the worst-case budget still fits the e2e shard job, with the margin stated', () => {
    // What a derived budget is structurally unable to see: ITSELF GROWING. A
    // timeout only spends wall clock when it FIRES, so the first symptom of an
    // over-large one is a shard dying on the JOB ceiling — which reports as
    // infrastructure trouble, not as a test failure.
    const ATTEMPTS = 2; // playwright.config.ts: retries: 1 on CI
    const JOB_TIMEOUT_MS = 20 * 60_000; // ci.yml: e2e (shard N/10) timeout-minutes
    const CEILING = JOB_TIMEOUT_MS * 0.5; // the shard has ~1/10 of the suite to run too
    const worstModule = [...heavyGl].sort((a, b) => b.inputs.length - a.inputs.length)[0]!;
    const worst = wireUpBudgetMs(worstModule.inputs.length) * ATTEMPTS;
    expect(
      worst,
      `the largest heavy-GL plan in the sweep (${worstModule.type}, ${worstModule.inputs.length} ` +
        `inputs) can burn ${Math.round(worst / 1000)} s across ${ATTEMPTS} attempts against a ` +
        `${JOB_TIMEOUT_MS / 60_000}-minute shard ceiling that also has ~1/10 of the suite to run. ` +
        `If this trips, the fix is a CHEAPER PLAN — fewer spawns per port — not a bigger job timeout.`,
    ).toBeLessThan(CEILING);

    // THE OTHER CALL SITE. `heavyVideoTimeout` is also applied to the EMIT
    // sweep's budget, and a gate that priced only the wire-up site would be
    // exactly the partial-scope blindness this file keeps being fixed for.
    //
    // It now calls the REAL `emitBudgetMs` the sweep itself spends. It used to
    // keep a private hand-rolled copy, and that copy was wrong in the way a
    // copy always eventually is: it re-read the two EXEMPT_* lists and nothing
    // else, so it could not see the SKIP_SPAWN, effect-shape or pure-CV-utility
    // skips — three of the five reasons an emit test does not exist. It
    // therefore nominated `colourofmagic` (22 outputs, 1 020 s across two
    // attempts) as "the worst LIVE plan" when that test is `test.fixme`-d and
    // has never run. The number the ratchet was pinned to described a
    // hypothetical test. Measured against the real skip set, the worst plan
    // that actually runs was `clipplayer` at 980 s.
    const worstEmit = [...REGISTRY].sort((a, b) => emitBudgetMs(b) - emitBudgetMs(a))[0]!;
    const worstEmitMs = emitBudgetMs(worstEmit) * ATTEMPTS;

    // The emit sweep must be priced against tests that EXIST. Anchor the gate
    // to the artifact: every module it prices must be one Playwright will run.
    expect(
      [...REGISTRY].filter((m) => emitBudgetMs(m) > 0 && emitSkipReason(m) !== null).map((m) => m.type),
      'a module with a NON-ZERO emit budget whose emit test is skipped means the budget function '
      + 'and the sweep disagree about which tests exist — the exact defect that once priced this '
      + 'gate against colourofmagic, a test that never runs.',
    ).toEqual([]);

    // The `doom → max(scaled, 90 000)` floor the old accumulator carried is
    // gone. Prove it could not bind rather than leaving a dead branch: doom is
    // heavy-GL, and ONE live output on a heavy-GL module already exceeds it.
    expect(
      heavyVideoTimeout(1 * PER_OUTPUT_MS + PER_PORT_BASE_MS),
      'a heavy-GL module with ONE live output must already budget more than the 90 000 ms the '
      + 'removed doom floor asked for, or that floor was load-bearing and should not have gone.',
    ).toBeGreaterThan(90_000);

    // THE PLAN GOT CHEAPER — kept here because it is the measurement, and the
    // measurement is what tells the next author whether a budget change is a
    // real cost regression or just a different tree.
    //
    // 980 s → 300 s for the worst live plan (clipplayer, 24 outputs), from two
    // changes to the PLAN and none to the tolerance:
    //
    //   * the per-port `waitForLoadState('networkidle')` is gone. MEASURED at
    //     ~1 000 ms of every ~1 150 ms iteration — a fixed quiet-window wait
    //     sitting in front of `spawnPatch`, which already waits for
    //     `__ensureEngine`, the engine boot and a frame-budgeted mount. Event-
    //     driven readiness was always there; the fixed wait was pure cost.
    //   * the scope read is ONE in-page peak-hold instead of `ceil(window/30)`
    //     Playwright-side polls, each serialising ~4 096 floats over CDP.
    //     MEASURED at 11.4 s for a stated 1 200 ms window, at a ~10 % sampling
    //     duty cycle. See `observeScopePeak`.
    //
    // MEASURED end-to-end, full emit sweep, `E2E_USE_PREVIEW=1` (the bundle CI
    // serves) + `E2E_SWIFTSHADER=1`, 1 worker: 2.9 min → 1.8 min, and the worst
    // module 17.9 s → 6.3 s. The 300 s budget is therefore ~24× the measured
    // cost of the plan it covers.
    //
    // That retires the debt rather than shrinking it: what remains is a real
    // `toBeLessThan(CEILING)` — the worst plan fits inside the healthy share of
    // the shard job — and CEILING is FULLY DERIVED from the configured job
    // timeout, so it is not a hand-typed quantity and stays.
    //
    // ⚠ `EMIT_WORST_CEILING_MS` (300_000) IS GONE (2026-08-10) — P0 owner
    // directive, "ratchets are an anti pattern; remove all ratchets". It was
    // asserted twice: `worstEmitMs <= EMIT_WORST_CEILING_MS`, plus a zero-slack
    // twin `expect(EMIT_WORST_CEILING_MS - worstEmitMs).toBe(0)`.
    //
    // WHY IT IS A POPULATION COUNT IN MILLISECOND CLOTHING. `worstEmitMs` is
    // computed from the widest module's LIVE OUTPUT-PORT COUNT
    // (`liveEmitOutputs(worstEmit) * PER_OUTPUT_MS + …`, × ATTEMPTS) — a
    // strictly increasing function of a quantity read off the tree. The
    // zero-slack twin then required the literal to EQUAL that derived value
    // exactly. So `300_000` was, by construction, a hand-typed copy of
    // "how many output ports does the widest module have", wearing a unit. It
    // goes wrong the moment a wider-output video module merges — and it goes
    // wrong the way the edge ledger did: two branches each computing correctly
    // for their own tree, the merge silently taking one of them, no conflict
    // marker, no red test. The `ms` suffix is precisely what made that hard to
    // see.
    //
    // WHAT IS DROPPED, and it is real: the EARLY WARNING that the emit sweep's
    // worst plan got more expensive AT ALL. `toBeLessThan(CEILING)` only fires
    // when the plan no longer FITS the shard — a cliff — whereas the zero-slack
    // pin fired on the first millisecond of growth and forced the author to
    // look. Nothing replaces that gradient signal here; a plan can now creep
    // from 6 s to 290 s of budget with every gate green. Name it in the PR
    // body. (The right successor, if the creep ever bites, is a measured
    // wall-time trend in CI — not another literal in this file.)
    expect(
      worstEmitMs,
      `the EMIT sweep's largest live plan (${worstEmit.type}, ${liveEmitOutputs(worstEmit)} live of ` +
        `${worstEmit.outputs.length} outputs) budgets ${Math.round(worstEmitMs / 1000)} s across ` +
        `${ATTEMPTS} attempts — ${Math.round((100 * worstEmitMs) / JOB_TIMEOUT_MS)} % of the ` +
        `${JOB_TIMEOUT_MS / 60_000}-minute shard job, for ONE test. If this trips, the fix is a ` +
        `CHEAPER PLAN — fewer spawns per port — not a bigger job timeout.`,
    ).toBeLessThan(CEILING);
    // …and the headroom, expressed as the port count the envelope carries, which
    // is the number a future author actually needs.
    const capacityPorts = Math.floor(
      (CEILING / ATTEMPTS - PER_PORT_BASE_MS - HEAVY_GL_MOUNT_MS) / PER_INPUT_MS,
    );
    expect(
      capacityPorts,
      `the shard envelope carries ${capacityPorts} inputs in ONE wire-up test; the biggest module ` +
        `in the sweep needs ${worstModule.inputs.length}. Keep at least 10 inputs of headroom so ` +
        `the next big video module does not land straight on the cliff.`,
    ).toBeGreaterThanOrEqual(worstModule.inputs.length + 10);
  });
});
