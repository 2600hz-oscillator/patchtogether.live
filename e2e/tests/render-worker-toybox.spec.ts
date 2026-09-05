// e2e/tests/render-worker-toybox.spec.ts
//
// Fix E Phase 2 — TOYBOX off-main-thread render worker, end-to-end (determ.).
//
// The CORRECTNESS GATE for the TOYBOX worker path: with the flag ON, TOYBOX's
// pure-GL layers render in the render worker. Finished frames copy back as
// transferred ImageBitmaps into a MAIN-GL texture (WorkerProxyHandle), which a
// downstream VIDEO OUT samples exactly like a normal node.
//
// DETERMINISM (plan §5 Layer B):
//   - flag ON (worker render): the worker is a SEPARATE THREAD (own clock + rAF),
//     so we poll the DETERMINISTIC readiness counter `read('workerFramesDelivered')`
//     (worker bitmaps actually uploaded into the main-GL texture) until ≥2. That
//     removes the old fixed wall-clock poll budget AND strengthens the gate — the
//     counter only advances on a REAL worker upload, so a silent fall-back to the
//     main-thread render (which would still paint the OUTPUT non-black) can no
//     longer masquerade as a passing worker path.
//   - flag OFF (main-thread render, prod default): warm up (unpaused) until the
//     gen-layer content has compiled + the downstream OUTPUT is non-black (a real
//     state, polled — not a fixed budget), THEN pin TOYBOX's iTime
//     (`__toyboxFreezeTime`) + pause the engine rAF (`__videoEnginePause`) and
//     read TOYBOX's OWN output texture across two fixed step bursts → a bit-stable
//     deterministic render smoke.
//
// Run under CI SwiftShader: the Phase-0 spike + Phase-1 acidwarp e2e proved
// worker WebGL2 renders non-black under CI. The flag is OFF by default; the ON
// test flips it via addInitScript.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { stepAndReadStats, assertRenderStats } from './_render-smoke';
import { WORKER_FRAME_MS } from '../../packages/web/src/lib/video/worker/protocol';
import { handshakeTrace, describeHandshake, withHandshakeDiagnosis, type HandshakeTrace } from '../_helpers/worker-handshake';

const FIXED_STEPS = 6;

/**
 * #1905 — the worker frames a node must deliver before a spec calls the worker
 * path proven. A policy threshold on a derived measurement, not a population.
 */
const WORKER_PROVEN_FRAMES = 2;

/**
 * #1905 — THE RACE WINDOW, DERIVED FROM THE PRODUCT'S OWN CADENCE.
 *
 * The worker posts a frame every `WORKER_FRAME_MS`, so the pre-fix defect
 * needed only that TOYBOX's content take longer than
 * `WORKER_PROVEN_FRAMES × WORKER_FRAME_MS` (= 32 ms) to arrive: by then the
 * main thread had accepted two contentless bitmaps, retired the fallback that
 * was drawing the real picture, and gone black. Two HTTP round-trips inside a
 * worker realm land on either side of 32 ms depending on machine load, which is
 * precisely why this was a lottery rather than a bug.
 *
 * We do not try to LOSE that lottery by luck. We widen the window to a large
 * multiple of the cadence so the contentless phase is unmissable on any
 * renderer, arm it as a one-shot delay on the content fetch, and assert what
 * the user sees during it.
 */
const CONTENT_STALL_MS = WORKER_FRAME_MS * 40;

/** Read an OUTPUT sink's engine-surface pixel statistics (non-black fraction +
 *  variance) via `vid.outputTexture(<sink>)` + readPixels (the card-era probe
 *  read `video-out-canvas` card chrome, absent on the default shell). Already
 *  node-scoped by construction — the #1905 control's warm main-thread node and
 *  the worker-resident one read distinct sink surfaces. */
async function outputStats(
  page: Page,
  outNodeId = 'out',
): Promise<{ nonZeroFrac: number; variance: number; mean: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          outputTexture: (n: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    if (!w.__engine) return null;
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    const tex = vid.outputTexture(id);
    if (!tex) return null;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const data = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    if (!complete) return null;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 4 * 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean, mean };
  }, outNodeId);
}

/** Deterministic worker-readiness signal: worker bitmaps uploaded for `nodeId`. */
async function workerFramesDelivered(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (n: string, k: string) => unknown } };
    };
    return (w.__engine().getDomain('video').read(id, 'workerFramesDelivered') as number) ?? 0;
  }, nodeId);
}

/** Capability probe: is the render worker the ACTIVE path (spawned AND its
 *  WebGL2 context initialized)? FALSE on CI's SwiftShader (worker-WebGL2 can't
 *  init → the proxy falls back to the main-thread render). The "worker delivered"
 *  assertion is enforced only when this is true; otherwise the non-black fallback
 *  is the achievable floor. */
async function workerActive(page: Page, nodeId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (n: string, k: string) => unknown } };
    };
    return w.__engine().getDomain('video').read(id, 'workerActive') === true;
  }, nodeId);
}

/** 'active' | 'initialising' | 'unsupported' — WHICH KIND of not-active (#1811). */
async function workerState(page: Page, nodeId: string): Promise<string> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (n: string, k: string) => unknown } };
    };
    return String(w.__engine().getDomain('video').read(id, 'workerState'));
  }, nodeId);
}

test.describe('Fix E render worker — toybox', () => {
  test('flag ON: TOYBOX gen layer renders in the worker; downstream OUTPUT is non-black', async ({ page, errorWatch }) => {
    // Worker WebGL2 compiles + warms slowly on CI's software renderer; TOYBOX's
    // larger shader set takes longer. The readiness poll is bounded by REAL worker
    // progress, not a fixed budget; 90s headroom covers boot + worker spawn +
    // shader warm-up + gen-layer content on CI.
    test.setTimeout(90_000);

    // Flip the worker flag ON before the app boots (default is OFF).
    await page.addInitScript(() => {
      (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = true;
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'tb', type: 'toybox', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'tb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(
      page.locator('.svelte-flow__node[data-id="tb"] [data-testid="module-shell"]'),
      'toybox faceplate present',
    ).toBeVisible();
    await expect(
      page.locator('.svelte-flow__node[data-id="out"] [data-testid="module-shell"]'),
      'video-out faceplate present',
    ).toHaveCount(1);

    const workerSupported = await page.evaluate(() =>
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined',
    );
    console.log(`[render-worker-toybox] workerSupported=${workerSupported}`);
    expect(workerSupported, 'Chromium supports the worker path (else this asserts the fallback)').toBe(true);

    // DETERMINISTIC readiness, capability-aware. The render worker is a real-GPU
    // capability (OffscreenCanvas + WebGL2 in a Worker): a real GPU spins it up
    // and it delivers; CI's SwiftShader can't init worker-WebGL2, so the proxy
    // falls back to the main-thread render (still non-black).
    //
    // ⚠ #1905 — THIS POLL USED TO EXIT ON `active && delivered >= 2` ALONE, and
    // the very next line asserted the OUTPUT was non-black. "Bitmaps arrived" is
    // not "a picture arrived": a worker whose content is still being fetched
    // posts opaque black frames at one per WORKER_FRAME_MS, so on a fast, quiet
    // real GPU the two frames landed before the content did and the assertion
    // read `nonZeroFrac=0.000` — the exact reported failure. That is a gate
    // whose exit condition is not the thing it goes on to assert.
    //
    // Both branches now require the OUTPUT to be PAINTING; the worker branch
    // additionally requires the worker to have delivered, which keeps the strong
    // "a silent main-thread fallback cannot masquerade as the worker path" gate
    // that the counter was added for. The sibling locus spec already had this
    // shape (`render-worker-locus.spec.ts` — nonZeroFrac AND a terminal state);
    // this brings the toybox leg into line with it.
    let delivered = 0;
    let active = false;
    // #1905 — on failure, say WHICH zero this is instead of just "0.000".
    await withHandshakeDiagnosis(page, 'tb', () =>
      expect
        .poll(async () => {
          active = await workerActive(page, 'tb');
          delivered = await workerFramesDelivered(page, 'tb');
          const s = await outputStats(page);
          const nonBlack = (s?.nonZeroFrac ?? 0) > 0.02;
          return nonBlack && (!active || delivered >= WORKER_PROVEN_FRAMES);
        }, {
          message: 'TOYBOX OUTPUT is painting AND (if the worker is the active path) it delivered bitmaps',
          timeout: 45_000,
        })
        .toBe(true),
    );

    const stats = await outputStats(page);
    expect(stats, 'OUTPUT canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, `TOYBOX OUTPUT is not all-black (nonZeroFrac=${stats!.nonZeroFrac.toFixed(3)})`).toBeGreaterThan(0.02);
    expect(stats!.variance, `TOYBOX OUTPUT has spatial structure (var=${stats!.variance.toFixed(1)})`).toBeGreaterThan(5);

    // STRONG worker-path gate, enforced only where worker-WebGL2 initialized.
    if (active) {
      expect(delivered, `worker is active → it must deliver bitmaps (got ${delivered})`).toBeGreaterThanOrEqual(WORKER_PROVEN_FRAMES);
      console.log(`[render-worker-toybox] WORKER path verified (framesDelivered=${delivered})`);
    } else {
      console.log('[render-worker-toybox] worker-WebGL2 unavailable on this renderer → main-thread fallback (OUTPUT non-black)');
    }

  });

  // ── #1905 — THE PRODUCER-INIT RACE, ON DEMAND ──────────────────────────────
  //
  // The family's whole difficulty was that it could not be summoned: four
  // sightings across three specs, every one of them "failed both attempts, then
  // passed on the identical tree". So this test does not wait for the race — it
  // ARMS it, at an offset derived from the product's own frame cadence
  // (CONTENT_STALL_MS above), and asserts what the user sees while it is open.
  //
  // THE MECHANISM. TOYBOX's worker handle fetches its manifest and its
  // gen-layer GLSL over HTTP from inside the worker realm. Until both land,
  // every draw clears the output FBO to opaque black and composites nothing.
  // Those frames were posted anyway; `WorkerProxyHandle` cannot see inside an
  // ImageBitmap, so it took the first one as proof the worker was producing,
  // set `workerTextureReady`, and stopped sampling the main-thread fallback
  // that was drawing the real picture. The OUTPUT went black and stayed black
  // for the length of two network round-trips — or FOREVER if the fetch failed.
  //
  // TWO DIRECTIONS, both asserted here:
  //   * WITH the fix — the worker WITHHOLDS contentless frames (`withheld > 0`,
  //     `posted === 0`) and the OUTPUT keeps painting throughout the stall.
  //   * WITHOUT it — `posted` climbs during the stall and the OUTPUT reads
  //     `nonZeroFrac=0.000`, the verbatim production failure. Verified by
  //     reverting the gate in `worker-engine.step()`; see the PR body.
  //
  // The `withheld`/`posted` half is a POSITIVE control: it proves the stall was
  // actually armed and that the gate is what kept the picture, rather than the
  // test passing because the perturbation missed.
  // ⚠ WHERE THIS RUNS, AND WHY IT IS NOT `@webgl-smoke`.
  //
  // This is a REAL-GPU control. Every #1905 sighting came from a lane where the
  // render worker was the ACTIVE path — the attest runner sets `E2E_REAL_GPU=1`
  // for exactly that reason, and a lottery loss there costs ~12 min of an
  // attestation window. Under SwiftShader the TOYBOX worker path has a SEPARATE,
  // pre-existing instability (MEASURED here: the worker inits, delivers 2367
  // frames, then loses its GL context inside `transferToImageBitmap`), so the
  // window this control needs cannot be held open long enough to observe. It
  // would be a slow, unstable red on the software renderer while telling us
  // nothing about the defect — so it skips there, LOUDLY, rather than being
  // quietly tuned until it passes.
  //
  // Tagging it `@webgl-smoke` would enrol it in the CI SwiftShader lane, which
  // is the one place it cannot speak. It is deliberately untagged.
  test('#1905: worker content still in flight does NOT black out the OUTPUT', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    test.skip(
      process.env.E2E_SWIFTSHADER === '1',
      'REAL-GPU control: under SwiftShader the TOYBOX worker context dies mid-run (a separate, ' +
        'pre-existing parity gap — toybox is renderLocus:worker-experimental for this family of ' +
        'reasons), so the contentless window cannot be held open. Run it on a real GPU / the ' +
        'attest lane (E2E_REAL_GPU=1), which is where every #1905 sighting came from.',
    );

    // ⚠ THE FIRST VERSION OF THIS CONTROL WAS BLIND, AND IT FAILED HONESTLY.
    //
    // It stalled `**/toybox/**` from the first navigation with the worker flag
    // already on. That starves BOTH producers — the worker AND the main-thread
    // fallback the fix relies on — so the OUTPUT was black for a reason that
    // has nothing to do with the defect, and the test would have "reproduced"
    // the bug against a tree that was already fixed. (Measured: withheld=2,
    // posted=0, note="waiting on content [noise-fbm]" — the gate was working
    // perfectly and the picture was still black.)
    //
    // The production situation is asymmetric and that asymmetry IS the defect:
    // the main thread is WARM (the card fetched and compiled this content
    // already — the #1905 failure screenshot shows the card fully rendered with
    // GEN·NOISE FBM selected) while the WORKER realm, which has its own module
    // instance and its own cold `glslCache`, is fetching from scratch. So we
    // reproduce that asymmetry: warm the main thread first, THEN arm the stall,
    // THEN introduce a worker-resident node.
    await page.addInitScript(() => {
      // Start with the worker OFF so the warm-up node renders on the main
      // thread. The flag is read per addNode from a mutable global, so we flip
      // it below without reloading.
      (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = false;
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // ── PHASE 1: warm the MAIN thread ──
    await spawnPatch(
      page,
      [
        { id: 'warm', type: 'toybox', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'warmout', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e0', from: { nodeId: 'warm', portId: 'out' }, to: { nodeId: 'warmout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );
    await expect
      .poll(async () => (await outputStats(page, 'warmout'))?.nonZeroFrac ?? 0, {
        message: 'main-thread TOYBOX content compiled (warms the main realm glslCache)',
        timeout: 45_000,
      })
      .toBeGreaterThan(0.02);

    // ── PHASE 2: arm the stall (the worker realm's cache is still cold) ──
    // One-shot per URL: the stall must cover the worker's boot and first frames
    // and then get out of the way, so the test can also prove the worker
    // RECOVERS — a gate that only ever withholds would satisfy the assertions
    // below while being just as broken.
    const stalled = new Set<string>();
    await page.route('**/toybox/**', async (route) => {
      const url = route.request().url();
      if (!stalled.has(url)) {
        stalled.add(url);
        // pacing: the derived race window (CONTENT_STALL_MS = 40 ×
        // WORKER_FRAME_MS, the worker's own render cadence, from
        // packages/web/src/lib/video/worker/protocol.ts). This is the
        // perturbation under test, not a wait for readiness.
        await new Promise((r) => setTimeout(r, CONTENT_STALL_MS));
      }
      await route.continue();
    });

    // ── PHASE 3: flip the flag ON and introduce a worker-resident node ──
    //
    // APPENDED, not re-spawned: `spawnPatch` clears the graph first, which would
    // take the warm main-thread node with it and undo phase 1. The flag is read
    // per-addNode, so the pre-existing `warm` node stays on the main thread and
    // only `tb` gets a WorkerProxyHandle.
    await page.evaluate(() => {
      (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = true;
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['tb'] = { id: 'tb', type: 'toybox', domain: 'video', position: { x: 80, y: 420 }, params: {} };
        w.__patch.nodes['out'] = { id: 'out', type: 'videoOut', domain: 'video', position: { x: 560, y: 420 }, params: {} };
        w.__patch.edges['e1'] = {
          id: 'e1',
          source: { nodeId: 'tb', portId: 'out' },
          target: { nodeId: 'out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        };
      });
    });
    await expect(
      page.locator('.svelte-flow__node[data-id="out"] [data-testid="module-shell"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.svelte-flow__node[data-id="warmout"] [data-testid="module-shell"]'),
    ).toHaveCount(1);
    // Keep the appended chain OBSERVED: the legacy video-out card's blit loop
    // marked its node watched unconditionally, but the shell's tile thumb is
    // viewport-gated and the appended pair lands wherever the first spawn's
    // fit left the viewport — so open the sink's dock pane (a real presenting
    // surface; Canvas holds a per-open-pane render lease) for the phase under
    // measurement. Without an observer the sink never routes a frame and the
    // black read would be about pull-eval, not #1905.
    await page.evaluate(
      (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
      'out',
    );
    await expect(
      page
        .locator('[data-testid="dock-fullview-pane"][data-pane-node="out"]')
        .getByTestId('videoout-face-canvas'),
    ).toBeVisible({ timeout: 60_000 });

    // Wait for the worker to be the ACTIVE path AND to have stepped its node at
    // least once — i.e. we are INSIDE the window: GL is live, the node is
    // drawing, its content is not here yet. If the worker can't init on this
    // renderer (SwiftShader) there is no window to observe and no defect to
    // reproduce, so skip loudly rather than pass vacuously.
    let inWindow: HandshakeTrace | null = null;
    const reached = await expect
      .poll(async () => {
        const t = await handshakeTrace(page);
        inWindow = t;
        const wn = t.worker?.nodes.find((n) => n.id === 'tb');
        return t.main?.readyAt !== null && t.main?.glOk === true && (wn?.drawn ?? 0) > 0;
      }, { message: 'worker is live and drawing TOYBOX', timeout: 30_000 })
      .toBe(true)
      .then(() => true, () => false);

    const t0 = inWindow as HandshakeTrace | null;
    if (!reached || !t0?.main?.glOk) {
      test.skip(true, `worker-WebGL2 did not initialize on this renderer — no race window to arm (${t0 ? describeHandshake(t0, 'tb') : 'no trace'})`);
      return;
    }

    // ── THE ASSERTION THE USER CARES ABOUT ──
    // While the worker is live but contentless, the OUTPUT must still be a
    // picture. Pre-fix this read 0.000.
    const n0 = t0.worker!.nodes.find((n) => n.id === 'tb')!;
    const during = await outputStats(page, 'out');
    expect(
      during!.nonZeroFrac,
      `#1905: the OUTPUT went BLACK while the worker's content was still in flight. ` +
        `Worker node: drawn=${n0.drawn} posted=${n0.posted} withheld=${n0.withheld} note="${n0.contentNote}". ` +
        `The main-thread fallback must keep the node painting until the worker has a real picture ` +
        `(worker-proxy-handle.ts: "a worker-locus node is NEVER blank because of the worker").`,
    ).toBeGreaterThan(0.02);

    // ── THE POSITIVE CONTROL ──
    // Prove the stall was genuinely armed and that WITHHOLDING is what saved the
    // picture — not a perturbation that missed. A run where the content beat the
    // worker's first frame would show withheld=0, and would then be proving
    // nothing about the defect.
    expect(
      n0.withheld,
      `#1905 control: the stall did not open a contentless window (withheld=0, posted=${n0.posted}). ` +
        `Either the route delay did not apply to the worker's fetches, or the content arrived first — ` +
        `in both cases this run cannot speak to the defect.`,
    ).toBeGreaterThan(0);
    expect(
      n0.posted,
      `#1905 control: the worker POSTED ${n0.posted} contentless frames — the gate in worker-engine.step() is not holding.`,
    ).toBe(0);

    // ── AND IT REACHES A TERMINAL STATE, STILL PAINTING ──
    //
    // Withholding forever would satisfy the two assertions above and still be a
    // broken worker path. So require a TERMINAL outcome — and there are two
    // legitimate ones, which is the same discipline the locus spec applies:
    //
    //   * the worker takes over once its content lands (`delivered >= 2`); or
    //   * the worker FAILS OVER and the main thread takes it back. That is the
    //     documented degradation, not a pass-by-default: it is only accepted
    //     with the OUTPUT still painting, which is the whole contract.
    //
    // ⚠ The failover branch is not hypothetical padding. MEASURED under
    // `E2E_SWIFTSHADER=1`: the worker initialized, delivered frames, and then
    // lost its GL context inside `transferToImageBitmap`. Before this PR that
    // throw voided the loop's only reschedule and the node stayed black
    // forever; now it is reported as `ready:{glOk:false}` and the fallback
    // resumes. Requiring `delivered >= 2` unconditionally here would have made
    // this test RED on a renderer where the product now behaves CORRECTLY.
    let terminal = '';
    await withHandshakeDiagnosis(page, 'tb', () =>
      expect
        .poll(async () => {
          const d = await workerFramesDelivered(page, 'tb');
          const s = await outputStats(page, 'out');
          const painting = (s?.nonZeroFrac ?? 0) > 0.02;
          if (!painting) return false;
          if (d >= WORKER_PROVEN_FRAMES) { terminal = `worker delivered ${d}`; return true; }
          const st = await workerState(page, 'tb');
          if (st === 'unsupported') { terminal = 'worker failed over to the main thread'; return true; }
          return false;
        }, {
          message:
            'the OUTPUT is painting AND the worker reached a terminal state — either it delivered ' +
            'real frames, or it failed over and the main thread took the node back',
          timeout: 60_000,
        })
        .toBe(true),
    );

    const t1 = await handshakeTrace(page);
    const n1 = t1.worker?.nodes.find((n) => n.id === 'tb');
    console.log(
      `[#1905] window held (${terminal}): drawn=${n1?.drawn} withheld=${n1?.withheld} posted=${n1?.posted} ` +
        `firstContentAt=${n1?.firstContentAt?.toFixed(0)}ms loopTicks=${t1.worker?.loopTicks} ` +
        `loopErrors=${t1.worker?.loopErrors} failReason=${t1.main?.failReason ?? 'none'}`,
    );
  });

  // @webgl-smoke — REQUIRED on-CI WebGL floor: TOYBOX's MAIN-THREAD WebGL render
  // path (the prod default) compiles its gen-layer shader + paints non-black
  // downstream under CI's SwiftShader, deterministically.
  test('flag OFF (default): TOYBOX renders on main thread — deterministic render smoke (parity) @webgl-smoke', async ({ page, rack, errorWatch }) => {
    test.setTimeout(90_000);


    await spawnPatch(
      page,
      [
        { id: 'tb', type: 'toybox', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'tb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node[data-id="out"] [data-testid="module-shell"]')).toHaveCount(1);

    // Warm up (rAF running) until the gen-layer content has compiled + the
    // downstream OUTPUT is non-black — a deterministic STATE, polled, not a fixed
    // wall-clock budget. (TOYBOX's first render compiles its shader set + fetches
    // its default gen content, which can't be synchronously stepped into being.)
    await expect
      .poll(async () => (await outputStats(page))?.nonZeroFrac ?? 0, {
        message: 'TOYBOX gen-layer compiled + downstream OUTPUT non-black',
        timeout: 45_000,
      })
      .toBeGreaterThan(0.02);

    // Now PIN TOYBOX's iTime + PAUSE the engine rAF → the render is frozen +
    // the test owns the exact frame count → bit-stable DRS on TOYBOX's own
    // output texture.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __toyboxFreezeTime?: number | null; __videoEnginePause?: boolean };
      g.__toyboxFreezeTime = 2.0;
      g.__videoEnginePause = true;
    });

    // Flag stayed OFF → no worker frames ever delivered.
    expect(await workerFramesDelivered(page, 'tb'), 'no worker frames with the flag off').toBe(0);

    const a = await stepAndReadStats(page, { nodeId: 'tb', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minVariance: 5 });

    const b = await stepAndReadStats(page, { nodeId: 'tb', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

  });
});
