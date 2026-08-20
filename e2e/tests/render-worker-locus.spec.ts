// e2e/tests/render-worker-locus.spec.ts
//
// #1811 — THE PARITY PROOF for every module that claims to render off the main
// thread. "Functional parity is a hard requirement": a module that renders
// black in the worker has not been migrated, it has been broken. A unit gate
// (`video/worker/worker-eligibility.test.ts`) can prove the DECLARATIONS agree;
// only a browser can prove there is a PICTURE.
//
// ── why this is registry-driven, and why that is not the forbidden shape ────
//
// This repo deleted a registry-wide render sweep (cv-param-reach) and the rule
// that came out of it is "never build registry-wide render sweeps — test I/O
// per module, structurally". This is deliberately NOT that:
//
//   * the subject set is not the registry, it is the defs that OPT IN by
//     declaring `renderLocus: 'worker'` — a set that grows only when a human
//     deliberately promotes a module, never as a side effect of adding one;
//   * it is ONE page load, ONE spawn and ONE assertion pass for the whole set,
//     not a test per module × per port, so its wall-time is flat in the size of
//     the set rather than multiplied by it;
//   * the alternative is a hand-typed list of module names in a spec file,
//     which is exactly the population-count construct CLAUDE.md forbids — and
//     which would silently stop covering the next promoted module.
//
// ⚠ DOOM is not in this set and cannot enter it: its def declares audio
// outputs, so the eligibility classifier gives it an `audio-port` blocker and
// it is never a worker candidate. Nothing here spawns, waits on, or times it.
//
// ── the capability split, which is load-bearing on CI ──────────────────────
//
// The render worker needs OffscreenCanvas + WebGL2 IN A WORKER. On CI's
// SwiftShader that context can fail to initialise, and the WorkerProxyHandle
// then transparently renders on the main thread — a documented degradation,
// not a bug. So the assertion is capability-aware, exactly like
// render-worker-acidwarp.spec.ts:
//   * worker ACTIVE   → it MUST have delivered bitmaps, and the picture must be
//                       non-black and structured. A silent no-op worker cannot
//                       masquerade as a pass.
//   * worker INACTIVE → the fallback must still paint a non-black, structured
//                       picture. That is the floor, and it is the thing that
//                       would go red if a promotion broke the main path.
//
// ⚠ What this spec CANNOT see: it reads each module's OWN output texture, so it
// proves the worker produces a picture — not that the picture is the SAME one
// the main thread would have produced. A pixel-for-pixel worker/main
// comparison is not available here because the worker runs its own clock (the
// determinism forwarding pins iTime, but the two realms still start at
// different wall times). The VRT baselines are the pixel gate; this is the
// liveness gate.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
// #1905 — turn a timeout on "nobody painted" into a sentence naming the stage
// that stalled. ONE export site, shared with render-worker-toybox.spec.ts.
import { withHandshakeDiagnosis } from '../_helpers/worker-handshake';

interface WorkerLocusDef {
  type: string;
  /** The def's FIRST picture-carrying output port — patched into a VIDEO OUT so
   *  the node has a real downstream consumer, exactly as it would in a rack. */
  outPort: string;
}

/** Read the worker-locus roster from the LIVE registry inside the page. */
async function workerLocusDefs(page: Page): Promise<WorkerLocusDef[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __listVideoModuleDefs: () => Array<{
        type: string;
        domain: string;
        renderLocus?: string;
        outputs: Array<{ id: string; type: string }>;
      }>;
    };
    const PICTURE = new Set(['video', 'mono-video', 'keys', 'image']);
    return w
      .__listVideoModuleDefs()
      .filter((d) => d.renderLocus === 'worker')
      .map((d) => ({
        type: d.type,
        outPort: (d.outputs.find((p) => PICTURE.has(p.type)) ?? d.outputs[0]!).id,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  });
}

/**
 * Read what a card would actually SHOW for `nodeId`, using the product's own
 * present path: `blitOutputToDrawingBuffer` (the call every video card makes
 * immediately before `drawImage(engine.canvas, …)`) followed by a `readPixels`
 * of the default framebuffer.
 *
 * ⚠ WHY NOT `_render-smoke.ts`'s `stepAndReadStats`. That helper attaches the
 * node's OUTPUT TEXTURE to a framebuffer and reads that. For a worker-locus
 * node the texture is the proxy's upload target, built by
 * `texImage2D(..., ImageBitmap)` — and attaching it is NOT framebuffer-complete
 * on every renderer. MEASURED: complete under ANGLE/Metal, INCOMPLETE under
 * `E2E_SWIFTSHADER=1`, where this spec reported `fbComplete=false,
 * nonBlack=0.000` for a worker that had already delivered bitmaps. That reads
 * exactly like "the module renders black off-thread" and is in fact the
 * instrument failing on one renderer — the precise "the result is different
 * here vs the instrument reads differently here" confusion CLAUDE.md warns
 * about. The product never attaches that texture to an FBO; it SAMPLES it, and
 * so does this.
 *
 * The engine canvas is created with `preserveDrawingBuffer: true`, so reading
 * the default framebuffer after the blit is well-defined.
 */
interface ModuleProbe {
  type: string;
  /** 'active' | 'initialising' | 'unsupported' — see WorkerProxyHandle.read. */
  state: string;
  active: boolean;
  delivered: number;
  nonZeroFrac: number;
  variance: number;
  mean: number;
  glErrors: number[];
}

/**
 * ONE in-page pass over the WHOLE roster: worker probe + presented picture for
 * every module, in a single round trip.
 *
 * One evaluate and not one per module, deliberately. This is polled until the
 * set is ready, and a per-module round trip would make the poll cost scale with
 * the roster — on the same main thread as the subject, which is the sampling
 * shape CLAUDE.md rules out. The loop and the accumulation happen in the page;
 * Playwright receives a finished summary.
 */
async function probeAll(page: Page, types: string[]): Promise<ModuleProbe[]> {
  return page.evaluate((types) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          res: { width: number; height: number };
          read: (n: string, k: string) => unknown;
          blitOutputToDrawingBuffer: (n: string) => void;
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    const { width: W, height: H } = vid.res;
    const px = new Uint8Array(W * H * 4);
    const out: ModuleProbeLike[] = [];
    type ModuleProbeLike = {
      type: string;
      state: string;
      active: boolean;
      delivered: number;
      nonZeroFrac: number;
      variance: number;
      mean: number;
      glErrors: number[];
    };
    for (let i = 0; i < types.length; i++) {
      while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }
      // ⚠ CLEAR FIRST. The engine canvas is created with
      // `preserveDrawingBuffer: true`, and `blitOutputToDrawingBuffer` is a
      // NO-OP when the node has no texture yet — so without this clear a
      // not-yet-painted OUTPUT reads back the PREVIOUS module's picture and
      // reports it as its own.
      //
      // This is not hypothetical: the 3× flake-check caught it, and the tell
      // was that all four modules reported byte-identical stats
      // (nonBlack 0.864, var 2544.7, mean 53.2 — four different shaders).
      // Clearing makes a no-op blit read BLACK, which the readiness poll then
      // correctly keeps waiting on instead of passing on a neighbour's frame.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // The PRODUCT's own present path: the call every video card makes right
      // before `drawImage(engine.canvas, …)`, then a read of the default
      // framebuffer.
      vid.blitOutputToDrawingBuffer(`out-${i}`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const glErrors: number[] = [];
      let e: number;
      while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let p = 0; p < px.length; p += 4 * 16) {
        const v = (px[p]! + px[p + 1]! + px[p + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
        if (v > 8) nonZero++;
      }
      const mean = n ? sum / n : 0;
      out.push({
        type: types[i]!,
        state: String(vid.read(`src-${i}`, 'workerState') ?? 'unknown'),
        active: vid.read(`src-${i}`, 'workerActive') === true,
        delivered: (vid.read(`src-${i}`, 'workerFramesDelivered') as number) ?? 0,
        nonZeroFrac: n ? nonZero / n : 0,
        variance: n ? sumSq / n - mean * mean : 0,
        mean,
        glErrors,
      });
    }
    return out;
  }, types);
}

test.describe('#1811 render-locus parity', () => {
  test('every renderLocus:\'worker\' module produces a live picture through the worker @webgl-smoke', async ({
    page,
    errorWatch,
  }) => {
    // Worker WebGL2 compiles + warms slowly on CI's software renderer, and this
    // spawns the whole opted-in set in one rack. The readiness gate below is
    // bounded by REAL worker progress; this cap only bounds the failure.
    test.setTimeout(120_000);

    // The worker flag is left at its DEFAULT. That is the point: a
    // `renderLocus:'worker'` module is supposed to be off-thread for every
    // user with no flag, so forcing `__videoWorkerEnabled = true` here would
    // test a configuration nobody runs and hide a regression in
    // `workerLocusEligible`'s default-state branch.
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // Boot the engine so the registry hooks are installed, then read the roster
    // from the live defs.
    await spawnPatch(page, [{ id: 'boot', type: 'videoOut', position: { x: 20, y: 20 }, domain: 'video' }]);
    const roster = await workerLocusDefs(page);
    console.log(`[render-locus] worker-locus modules: ${roster.map((r) => r.type).join(', ')}`);
    expect(
      roster.length,
      'NO module declares renderLocus:\'worker\'. Either the registry hook is broken or the ' +
        'entire off-main-thread migration has been reverted — in both cases every assertion ' +
        'below would pass vacuously, which is why this floor exists at all.',
    ).toBeGreaterThan(0);

    // One source per worker-locus module, each patched into its own VIDEO OUT so
    // it has a real downstream consumer (and so pull evaluation keeps it live).
    const nodes = roster.flatMap((d, i) => [
      { id: `src-${i}`, type: d.type, position: { x: 40, y: 60 + i * 340 }, domain: 'video' as const },
      { id: `out-${i}`, type: 'videoOut', position: { x: 520, y: 60 + i * 340 }, domain: 'video' as const },
    ]);
    const edges = roster.map((d, i) => ({
      id: `e-${i}`,
      from: { nodeId: `src-${i}`, portId: d.outPort },
      to: { nodeId: `out-${i}`, portId: 'in' },
      sourceType: 'video',
      targetType: 'video',
    }));
    await spawnPatch(page, nodes, edges);

    // HOLD A RENDER LEASE ON EVERY SOURCE.
    //
    // Not a convenience — without it this spec measures the VIEWPORT, not the
    // worker. The rack is laid out in a column, so with more than a couple of
    // promoted modules the lower cards sit outside the browser viewport; the
    // central IntersectionObserver reports them off-screen, sink-driven pull
    // evaluation correctly stops evaluating them, and `WorkerProxyHandle.draw`
    // — which is what DRAINS a delivered bitmap into the main-GL texture — never
    // runs. `workerFramesDelivered` then stays 0 for a worker that is in fact
    // rendering perfectly, and the failure reads exactly like a broken worker.
    // (Measured: this spec timed out that way, while the same four modules
    // delivered ~278 frames each when their cards happened to be on screen.)
    //
    // `acquireRenderLease` is the engine's own documented answer to "this node
    // must keep rendering regardless of its card's viewport rect". Using it
    // makes the assertion about the worker and independent of window size.
    // The lease goes on the OUTPUT, not the source: pull evaluation is
    // reverse-reachable from its roots, so leasing the sink keeps the whole
    // chain (source → OUTPUT) live and exercises the real routing rather than
    // pinning each node individually.
    await page.evaluate((count) => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => { acquireRenderLease: (id: string) => () => void } };
        __renderLocusLeases?: Array<() => void>;
      };
      const vid = w.__engine().getDomain('video');
      w.__renderLocusLeases = [];
      for (let i = 0; i < count; i++) w.__renderLocusLeases.push(vid.acquireRenderLease(`out-${i}`));
    }, roster.length);

    // ── READINESS: bounded by REAL state, capability-aware, three-valued ──────
    //
    // A module is ready when the picture has arrived AND its worker has reached
    // a TERMINAL state — `active` with delivered bitmaps, or `unsupported`.
    // `initialising` is NOT ready and is waited on.
    //
    // The three-valued read matters more than it looks. `workerActive === false`
    // means both "still spinning up" and "will never work", and a poll that
    // accepts it takes the main-thread fallback the moment it paints —
    // MEASURED: this spec reported `workerActive=false` on every real-GPU run
    // for exactly that reason, i.e. it never once exercised the worker while
    // claiming to. Green, and blind to the whole thing it covers.
    //
    // The picture half matters too, and for its own measured reason: under
    // `E2E_SWIFTSHADER=1` a worker delivered 6 bitmaps and THEN lost its
    // context; without waiting on the picture the read landed in the single
    // frame before the fallback had painted, and reported "acidwarp RENDERS
    // BLACK".
    const types = roster.map((r) => r.type);
    let last: ModuleProbe[] = [];
    // #1905 — name the node that is stuck, and the STAGE it is stuck at, rather
    // than leaving a timeout that says only "nobody painted". The thunk is
    // evaluated at throw time so the diagnosis names an actual offender.
    await withHandshakeDiagnosis(
      page,
      () => last.find((p) => p.nonZeroFrac <= 0.02 || p.state === 'initialising')?.type ?? types[0]!,
      () => expect
      .poll(
        async () => {
          last = await probeAll(page, types);
          return last
            .filter(
              (p) =>
                !(
                  p.nonZeroFrac > 0.02 &&
                  (p.state === 'unsupported' || (p.state === 'active' && p.delivered >= 2))
                ),
            )
            .map((p) => `${p.type}(${p.state},delivered=${p.delivered},nonBlack=${p.nonZeroFrac.toFixed(3)})`);
        },
        {
          message:
            'every worker-locus module has a picture at its OUTPUT and its worker has reached a ' +
            'TERMINAL state: `active` with >=2 delivered bitmaps, or `unsupported` (CI ' +
            'SwiftShader, where the proxy falls back to the main thread — the documented ' +
            'degradation). `initialising` is deliberately NOT accepted: taking the fallback ' +
            'while the worker is still spinning up is how this spec passed without ever ' +
            'exercising the worker.',
          timeout: 60_000,
        },
      )
      .toEqual([]),
    );

    // ── the picture, per module ───────────────────────────────────────────────
    //
    // Re-assert on the final probe rather than trusting the poll: the poll's
    // predicate is a boolean, and a failure has to print the NUMBERS.
    for (const p of last) {
      const path = p.active ? 'WORKER' : 'main-thread fallback';
      // Logged per module, not collected for the end: a failure on module 1 of
      // N must not swallow the readings that explain it.
      console.log(
        `[render-locus] ${p.type}: workerState=${p.state} delivered=${p.delivered} ` +
          `nonBlack=${p.nonZeroFrac.toFixed(3)} var=${p.variance.toFixed(1)} ` +
          `mean=${p.mean.toFixed(1)} glErrors=[${p.glErrors.join(',')}]`,
      );

      expect(p.glErrors, `${p.type}: GL errors while rendering through the ${path} path`).toEqual([]);
      expect(
        p.nonZeroFrac,
        `${p.type} RENDERS BLACK through the ${path} path (nonBlack ${p.nonZeroFrac.toFixed(3)}, ` +
          `mean luma ${p.mean.toFixed(1)}). Functional parity is a hard requirement: a module ` +
          'that renders black off-thread has not been migrated, it has been broken. Either fix ' +
          `the worker path or take renderLocus:'worker' off the ${p.type} def.`,
      ).toBeGreaterThan(0.02);
      expect(
        p.variance,
        `${p.type} renders a FLAT FILL through the ${path} path (variance ` +
          `${p.variance.toFixed(1)}) — non-black is not the same as a picture.`,
      ).toBeGreaterThan(5);
      if (p.active) {
        expect(
          p.delivered,
          `${p.type}: the worker is the ACTIVE path, so it must actually have delivered bitmaps ` +
            '(a silently no-op worker must not masquerade as a pass — the main-thread fallback ' +
            'would paint a perfectly good picture underneath it).',
        ).toBeGreaterThanOrEqual(2);
      }
    }

    // ── PERMANENT NEGATIVE CONTROL on the instrument itself ──────────────────
    //
    // Every module above is read from the SAME drawing buffer, one after the
    // other. If the per-node blit ever stops being per-node — a no-op blit, a
    // missing clear, a wrong node id — each module reads whatever the previous
    // one left behind, and every assertion above passes on a picture that is
    // not the module's. That failure produced BYTE-IDENTICAL stats for four
    // different shaders once already; this leg is what turns that from a
    // green run into a red one.
    if (last.length > 1) {
      const signatures = new Set(last.map((p) => `${p.mean.toFixed(4)}|${p.variance.toFixed(4)}`));
      expect(
        signatures.size,
        'Every worker-locus module produced the SAME picture statistics, which means this ' +
          'spec is reading one module\'s frame N times rather than each module\'s own — the ' +
          'per-node blit is not landing and the whole test is vacuous. Readings: ' +
          last.map((p) => `${p.type}(mean ${p.mean.toFixed(2)}, var ${p.variance.toFixed(1)})`).join(', '),
      ).toBeGreaterThan(1);
    }
  });

  // ── THE MULTI-NODE TRANSFER REGRESSION ─────────────────────────────────────
  //
  // Two worker-resident nodes must show TWO DIFFERENT PICTURES.
  //
  // This names ACIDWARP on purpose, and that is not a hand-typed population:
  // it is a regression against a specific defect, pinned to the one module that
  // has been worker-resident by default since the worker shipped. Two ACIDWARP
  // nodes in a rack is a thing a user does, and it is the smallest reproduction
  // of the bug.
  //
  // THE DEFECT (#1811, found by the roster test above the moment a second
  // module joined the worker): `WorkerRenderEngine.transferNodeFrame` blits a
  // node's FBO into the ONE shared OffscreenCanvas and calls
  // `transferToImageBitmap()`, once per node, all inside a single task. GL
  // commands are queued rather than executed and the transfer is not specified
  // to flush them, so on a deferring renderer every transfer in the frame can
  // capture the same contents. MEASURED under `E2E_SWIFTSHADER=1`: four
  // worker-resident nodes all came back with the FIRST node's picture —
  // byte-identical statistics for four different shaders. It had been
  // invisible because ACIDWARP was the only worker-resident module and one
  // node cannot alias with itself.
  //
  // The fix is two-part (`gl.finish()` before the transfer + a task yield
  // between transfers); this test is what keeps either half from being
  // removed as "redundant".
  test('two worker-resident nodes do NOT alias to one picture @webgl-smoke', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // Two ACIDWARPs on DIFFERENT scenes + palettes. Same module, deliberately
    // different pictures: if the two agree, the only explanations are that the
    // params did not apply (which the negative control below rules out) or that
    // the transfer aliased.
    await spawnPatch(
      page,
      [
        { id: 'src-0', type: 'acidwarp', position: { x: 40, y: 60 }, domain: 'video', params: { scene: 3, paletteType: 1, speed: 0 } },
        { id: 'out-0', type: 'videoOut', position: { x: 520, y: 60 }, domain: 'video' },
        { id: 'src-1', type: 'acidwarp', position: { x: 40, y: 400 }, domain: 'video', params: { scene: 27, paletteType: 6, speed: 0 } },
        { id: 'out-1', type: 'videoOut', position: { x: 520, y: 400 }, domain: 'video' },
      ],
      [
        { id: 'e-0', from: { nodeId: 'src-0', portId: 'out' }, to: { nodeId: 'out-0', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-1', from: { nodeId: 'src-1', portId: 'out' }, to: { nodeId: 'out-1', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => { acquireRenderLease: (id: string) => () => void } };
        __renderLocusLeases?: Array<() => void>;
      };
      const vid = w.__engine().getDomain('video');
      w.__renderLocusLeases = [vid.acquireRenderLease('out-0'), vid.acquireRenderLease('out-1')];
    });

    let probes: ModuleProbe[] = [];
    await withHandshakeDiagnosis(
      page,
      () => probes.find((p) => p.nonZeroFrac <= 0.02 || p.state === 'initialising')?.type ?? 'acidwarp#a',
      () => expect
      .poll(
        async () => {
          probes = await probeAll(page, ['acidwarp#a', 'acidwarp#b']);
          return probes.every(
            (p) =>
              p.nonZeroFrac > 0.02 &&
              (p.state === 'unsupported' || (p.state === 'active' && p.delivered >= 2)),
          );
        },
        {
          message:
            'both ACIDWARP nodes are painting AND their workers have reached a terminal state ' +
            '(active with delivered bitmaps, or unsupported)',
          timeout: 60_000,
        },
      )
      .toBe(true),
    );

    const [a, b] = probes;
    console.log(
      `[render-locus] alias check: A(${a!.state} mean ${a!.mean.toFixed(3)} var ` +
        `${a!.variance.toFixed(2)}) B(${b!.state} mean ${b!.mean.toFixed(3)} var ` +
        `${b!.variance.toFixed(2)})`,
    );
    expect(
      `${a!.mean.toFixed(4)}|${a!.variance.toFixed(4)}`,
      'TWO WORKER-RESIDENT NODES RETURNED THE SAME PICTURE. Two ACIDWARP nodes on different ' +
        `scenes (3/palette 1 and 27/palette 6) both read mean ${a!.mean.toFixed(3)}, var ` +
        `${a!.variance.toFixed(2)}. Either per-node params stopped reaching the worker, or — ` +
        'the defect this test exists for — `transferNodeFrame` is capturing the same drawing ' +
        'buffer for every node in the frame. See worker-engine.ts (`gl.finish()` before the ' +
        'transfer) and render-worker.ts (one transfer per task).',
    ).not.toEqual(`${b!.mean.toFixed(4)}|${b!.variance.toFixed(4)}`);
  });
});
