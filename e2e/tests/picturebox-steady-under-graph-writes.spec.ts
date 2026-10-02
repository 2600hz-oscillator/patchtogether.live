// PICTUREBOX HOLDS ITS PICTURE WHILE THE GRAPH CHANGES AROUND IT (DRS).
//
// Owner, 2026-10-02: with picturebox and lushgarden both open in the dock,
// twisting lushgarden's knobs made the picturebox preview flicker, and the
// flicker reached the patched output. MEASURED (in-page per-rAF probe, three
// runs): picturebox's ENGINE texture itself alternated image → idle field in a
// 2-off / 1-on cycle from the first knob tick (run 1: 1057 of 1733 active
// frames idle), so every surface fed from it flickered with it. The mechanism:
// `picturebox.ts` rebuilt its `extras` literal on every `read`, five members as
// fresh arrows, so `node-extras-registry`'s handle fingerprint (function
// identity) read "re-materialized node" on every graph snapshot and re-ran
// `produce` — slot 0 cleared synchronously, the image re-decoded a task later.
// One Y.Doc write per frame (drag-commit's cadence) is enough; the knob can be
// on any module.
//
// This spec drives the SAME seam a knob commits through — one Y.Doc param
// write on lushgarden per step — with the engine rAF loop paused, steps the
// engine once per write, and reads picturebox's output texture AND videoOut's
// FBO after every step, inside ONE page.evaluate. The flush between the write
// and the step is MICROTASKS ONLY (the snapshot bus fires on `doc.on('update')`
// and Svelte flushes effects in a microtask), so an image decode — a task —
// cannot land inside the window: with the defect present every step reads the
// idle field (positive control, fix reverted: 24 of 24 steps idle); with the
// fix none can. Anti-vacuity: an exact step count, an exact frame delta per
// step, and image floors (the idle field is a flat fill, mean ≈ 12.6,
// variance 0) on every read.
//
// The presented surfaces are read once at the end, after two frames, because
// a paused engine never re-renders: whatever the last step left in the texture
// is what the dock preview and the sink show.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { settle } from '../_helpers/frames';

const PB = 'pb';
const LG = 'lg';
const VO = 'vo';
/** Graph writes = engine steps. Small, like the DRS specs (6-8 live; 24 here
 *  because the subject is a per-write cycle and one write must not be the
 *  whole series). */
const STEPS = 24;
/** Image floors on a 32×24 luma grid. The seeded picture reads mean ≈ 140,
 *  variance ≈ 4000 on both renderers; picturebox's idle field is a flat
 *  (5,15,20) fill: mean 12.6, variance 0. */
const MIN_MEAN = 40;
const MIN_VARIANCE = 200;

interface StepRead {
  k: number;
  framesDelta: number;
  hasImage: boolean;
  pb: { mean: number; variance: number };
  vo: { mean: number; variance: number };
}

/** A large-scale structured picture, JPEG-encoded and written to node.data the
 *  way the picker does (picturebox-sync.spec.ts' shape). */
async function seedImage(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(async (nodeId) => {
    const W = 640, H = 480;
    const src = new OffscreenCanvas(W, H);
    const c = src.getContext('2d')!;
    const grad = c.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#ff2020');
    grad.addColorStop(0.5, '#ffe020');
    grad.addColorStop(0.5001, '#2040ff');
    grad.addColorStop(1, '#20ffe0');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(0, H); c.lineTo(W, 0); c.lineTo(W, 80); c.lineTo(80, H); c.closePath(); c.fill();
    c.fillStyle = '#101010';
    c.beginPath(); c.arc(W * 0.3, H * 0.35, 90, 0, Math.PI * 2); c.fill();
    const blob = await src.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
    }
    const base64 = btoa(binary);
    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const target = w.__patch.nodes[nodeId];
      if (!target) throw new Error(`node ${nodeId} not found`);
      if (!target.data) target.data = {};
      target.data.imageBytes = base64;
      target.data.imageMime = 'image/jpeg';
      target.data.imageName = 'steady.jpg';
    });
  }, nodeId);
}

async function readHasImage(page: Page, nodeId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } | null } | null;
    };
    return w.__engine?.()?.getDomain?.('video')?.read?.(id, 'hasImage') === true;
  }, nodeId);
}

async function openDockPane(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate((i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i), nodeId);
  await expect(page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${nodeId}"]`)).toBeVisible({ timeout: 60_000 });
}

test.describe('PICTUREBOX — steady under graph writes (the dock-knob flicker)', () => {
  test('one lushgarden param write per engine step leaves picturebox and the patched output on the image every step', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: PB, type: 'picturebox', position: { x: 100, y: 100 }, domain: 'video' },
        { id: LG, type: 'lushgarden', position: { x: 520, y: 100 }, domain: 'video' },
        { id: VO, type: 'videoOut', position: { x: 940, y: 100 }, domain: 'video' },
      ],
      [{ id: 'e_pb_vo', from: { nodeId: PB, portId: 'out' }, to: { nodeId: VO, portId: 'in' }, sourceType: 'video', targetType: 'video' }],
      { mountTimeout: 60_000 },
    );
    await seedImage(page, PB);
    await expect.poll(() => readHasImage(page, PB), { timeout: 30_000, message: 'picturebox decoded + uploaded the seeded image' }).toBe(true);
    // The owner's layout: both faceplates open in the dock.
    await openDockPane(page, PB);
    await openDockPane(page, LG);
    const pbCanvas = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${PB}"]`).getByTestId('picturebox-face-canvas');
    await expect(pbCanvas).toBeVisible({ timeout: 60_000 });

    const reads: StepRead[] = await page.evaluate(async ({ PB, LG, VO, STEPS }) => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => unknown };
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const vid = w.__engine().getDomain('video') as {
        gl: WebGL2RenderingContext;
        res: { width: number; height: number };
        step: () => void;
        currentFrameCount: () => number;
        outputTexture: (id: string) => WebGLTexture | null;
        read: (id: string, key: string) => unknown;
      };
      const gl = vid.gl;
      const SW = 32, SH = 24;
      const dsTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, dsTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SW, SH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      const dsFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dsFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dsTex, 0);
      const srcFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const px = new Uint8Array(SW * SH * 4);
      const stats = (tex: WebGLTexture | null): { mean: number; variance: number } => {
        if (!tex) return { mean: -1, variance: -1 };
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFbo);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dsFbo);
        gl.blitFramebuffer(0, 0, vid.res.width, vid.res.height, 0, 0, SW, SH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dsFbo);
        gl.readPixels(0, 0, SW, SH, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        let s = 0, s2 = 0;
        for (let i = 0; i < SW * SH; i++) {
          const l = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
          s += l; s2 += l * l;
        }
        const mean = s / (SW * SH);
        return { mean, variance: s2 / (SW * SH) - mean * mean };
      };
      const out: StepRead[] = [];
      for (let k = 0; k < STEPS; k++) {
        const v = 0.5 + 0.45 * Math.sin((k / STEPS) * Math.PI * 2);
        // THE KNOB'S SEAM: drag-commit → setNodeParam → one Y.Doc transaction on
        // node.params, once per frame.
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes[LG];
          if (n) { n.params.view = v; n.params.horizon = 1 - v; }
        });
        // Microtasks only: the snapshot bus has already fired on `update`, and
        // Svelte flushes the graph effect (→ nodeExtras.sync) in a microtask.
        for (let i = 0; i < 4; i++) await Promise.resolve();
        const before = vid.currentFrameCount();
        vid.step();
        out.push({
          k,
          framesDelta: vid.currentFrameCount() - before,
          hasImage: vid.read(PB, 'hasImage') === true,
          pb: stats(vid.outputTexture(PB)),
          vo: stats(vid.outputTexture(VO)),
        });
      }
      gl.deleteFramebuffer(dsFbo);
      gl.deleteFramebuffer(srcFbo);
      gl.deleteTexture(dsTex);
      return out;
    }, { PB, LG, VO, STEPS });

    expect(reads.length, 'one read per write').toBe(STEPS);
    const idle = reads.filter((r) => !(r.pb.mean > MIN_MEAN && r.pb.variance > MIN_VARIANCE));
    const sinkIdle = reads.filter((r) => !(r.vo.mean > MIN_MEAN && r.vo.variance > MIN_VARIANCE));
    const summary = reads.map((r) => `k${r.k}:${r.hasImage ? 'img' : 'IDLE'}/pb${r.pb.mean.toFixed(0)}/vo${r.vo.mean.toFixed(0)}`).join(' ');
    for (const r of reads) expect(r.framesDelta, `step ${r.k} advanced exactly one engine frame`).toBe(1);
    expect(idle.length, `picturebox texture left the image on ${idle.length}/${STEPS} steps — ${summary}`).toBe(0);
    expect(sinkIdle.length, `videoOut (patched output) left the image on ${sinkIdle.length}/${STEPS} steps — ${summary}`).toBe(0);
    expect(reads.every((r) => r.hasImage), `hasImage dropped during the write series — ${summary}`).toBe(true);

    // The presented surface: the dock preview is a drawImage of the texture the
    // last step left behind. Two frames, then one read (sample-twice rule: the
    // texture cannot change with the loop paused, so the second frame IS the
    // settled picture).
    await settle(page);
    const preview = await pbCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const probe = document.createElement('canvas');
      probe.width = 32; probe.height = 24;
      const ctx = probe.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 32, 24);
      const d = ctx.getImageData(0, 0, 32, 24).data;
      let s = 0, s2 = 0;
      for (let i = 0; i < 32 * 24; i++) { const l = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!; s += l; s2 += l * l; }
      const mean = s / (32 * 24);
      return { mean, variance: s2 / (32 * 24) - mean * mean };
    });
    expect(preview.mean, `dock preview shows the image (mean ${preview.mean.toFixed(1)})`).toBeGreaterThan(MIN_MEAN);
    expect(preview.variance, `dock preview has the image's structure (variance ${preview.variance.toFixed(0)})`).toBeGreaterThan(MIN_VARIANCE);
    errorWatch.assertClean();
  });
});
