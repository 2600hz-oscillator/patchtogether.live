// e2e/tests/timelorde-owl-overlay-parity.spec.ts
//
// THE REAL-COMPOSITOR PARITY PROOF for TIMELORDE's beat-boost overlay.
//
// ── WHAT CHANGED, AND WHY A UNIT TEST CANNOT CLOSE IT ────────────────────────
// `tlDrawOwl` (`$lib/ui/media/frame-producers`) used to brighten the owl's
// eyes and border per frame by `getImageData` → `applyBeatBoost` (a
// 48,400-pixel JS loop) → `putImageData` — a synchronous GPU→CPU readback on
// ~60 % of every frame the transport ran, on a pinned singleton every rack
// carries. MEASURED with the CDP profiler on a plain `/rack`: `tlDrawOwl`
// 2.1–2.3 s of every 15 s of main thread, the largest single cost on an idle
// rack. It now bakes the per-pixel membership ONCE into a white-with-alpha
// overlay and draws that at `globalAlpha = pulse·amount` — a lerp toward white
// IS a source-over of white, so the maths is the same (`timelorde-wizard.ts`
// §2b).
//
// The unit grid in `timelorde-wizard.test.ts` proves that identity against a
// MODEL of the compositor. This file proves it against the BROWSER: the same
// overlay, drawn by a real Chromium 2D canvas with real premultiplied 8-bit
// storage and real paint-alpha quantisation, on the REAL owl the product
// composites, compared to the reference `applyBeatBoost` over all 48,400 × 3
// channels. The bar is ±1 per channel (two roundings of the same real number
// can differ by one), and the bare-owl pixels — the body, the ground, every
// pixel with zero membership — must be BYTE-IDENTICAL, because those are the
// bytes the reduced-motion VRT baseline pins.
//
// ── THE TWO LEGS ─────────────────────────────────────────────────────────────
//   1. THE COMPOSITOR. Under `prefers-reduced-motion` the producer paints the
//      bare owl (pulse pinned to 0) and `video_out` serves it 1:1 — so the
//      product's own bare frame is read there, the overlay is built from it
//      with the shipped builder, and a real canvas composites it at three
//      pulses against the reference. Max |Δ| is reported, not just bounded.
//   2. THE LIVE PRODUCT. On an ordinary rack with the transport running,
//      `video_out`'s frames are sampled INSIDE the page over more than a beat
//      and held to the bare owl: outside the bands byte-identical on every
//      frame, inside them never darker, and at least one frame brighter —
//      i.e. the overlay lands where and only where the membership says, on
//      the frames the user sees.
//
// ⚠ NO PLAYWRIGHT-SIDE POLL LOOP SAMPLES A PAGE-SIDE QUANTITY. Each leg's
// accumulator runs in the page (one evaluate), the same shape
// `timelorde-pinned-source.spec.ts` records the reason for.

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  applyBeatBoost,
  beatBoostOverlayAlpha,
  buildBeatBoostOverlay,
} from '../../packages/web/src/lib/audio/modules/timelorde-wizard';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** The composite size — `TL_DISPLAY_W/H` in frame-producers; `video_out`
 *  blits its bitmap 1:1 into a probe canvas of the same size. */
const W = 220;
const H = 220;
const PINNED_ID = 'pinned-timelorde';

async function bootRack(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.waitForFunction(
    (pid) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { type?: string; data?: { pinned?: boolean } } | undefined> };
      };
      const n = w.__patch?.nodes[pid];
      return n?.type === 'timelorde' && n?.data?.pinned === true;
    },
    PINNED_ID,
    { timeout: BOOT_MS },
  );
  await page.waitForFunction(
    () => typeof (globalThis as { __ensureEngine?: unknown }).__ensureEngine === 'function',
    undefined,
    { timeout: BOOT_MS },
  );
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
}

interface FrameRead {
  ok: boolean;
  reason?: string;
  /** RGBA, W×H×4, or empty when !ok. */
  data: number[];
}

/** ONE frame of `video_out`, read through the module's own `drawFrame` into a
 *  W×H probe canvas (a 1:1 blit of the pushed bitmap). */
async function readVideoOut(page: Page): Promise<FrameRead> {
  return page.evaluate(
    async ({ nodeId, W, H }) => {
      const out: FrameRead = { ok: false, data: [] };
      const w = globalThis as unknown as { __engine?: () => { getDomain: (d: string) => unknown } };
      if (typeof w.__engine !== 'function') { out.reason = 'no __engine hook'; return out; }
      const eng = w.__engine();
      if (!eng) { out.reason = '__engine() returned nothing'; return out; }
      let audio:
        | { getVideoSource?: (n: string, p: string) => { drawFrame?: (c: HTMLCanvasElement) => void } | null }
        | undefined;
      try { audio = eng.getDomain('audio') as typeof audio; } catch (e) { out.reason = `getDomain threw: ${String(e)}`; return out; }
      const src = audio?.getVideoSource?.(nodeId, 'video_out') ?? null;
      if (!src?.drawFrame) { out.reason = 'video_out publishes no drawFrame'; return out; }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) { out.reason = 'no 2d context'; return out; }
      try { src.drawFrame(c); } catch (e) { out.reason = `drawFrame threw: ${String(e)}`; return out; }
      out.data = Array.from(g.getImageData(0, 0, W, H).data);
      out.ok = true;
      return out;
    },
    { nodeId: PINNED_ID, W, H },
  );
}

/** Is this frame the module's `#07090d` idle field (nothing pushed yet)? */
function isIdleField(data: number[]): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! > 12 || data[i + 1]! > 12 || data[i + 2]! > 16) return false;
  }
  return true;
}

/** The product's BARE owl: `video_out` under reduced motion, once it holds a
 *  frame. The push is asynchronous, so the read is polled — each attempt is a
 *  one-frame in-page read, and the auto-retrying expect bounds the failure. */
async function bareOwlFrom(page: Page): Promise<Uint8ClampedArray> {
  let last: FrameRead | null = null;
  await expect
    .poll(
      async () => {
        last = await readVideoOut(page);
        return last.ok && !isIdleField(last.data);
      },
      { timeout: BOOT_MS, message: 'video_out never left the idle field under reduced motion' },
    )
    .toBe(true)
    .catch((e: unknown) => {
      const l = last as FrameRead | null;
      throw new Error(`${String(e)}\nlast read: ${JSON.stringify({ ok: l?.ok, reason: l?.reason, px: l?.data.length })}`);
    });
  return Uint8ClampedArray.from((last as unknown as FrameRead).data);
}

test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS * 2 });

test.describe('timelorde — the beat-boost OVERLAY is the per-pixel boost, on the real compositor', () => {
  test('LEG 1: a real canvas composites the overlay within ±1 of applyBeatBoost on the real owl; zero-membership pixels byte-identical', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      await bootRack(page);
      const bare = await bareOwlFrom(page);
      expect(bare.length).toBe(W * H * 4);

      // The shipped builder, on the product's own bare frame.
      const overlay = buildBeatBoostOverlay(bare);
      let members = 0;
      for (let i = 3; i < overlay.length; i += 4) if (overlay[i]! > 0) members++;
      expect(members, 'the real owl has eyes and a border — the overlay is not empty').toBeGreaterThan(500);
      expect(members, '…and it is not the whole picture either').toBeLessThan((W * H) / 2);

      for (const pulse of [0.5, 1, 0.1]) {
        const alpha = beatBoostOverlayAlpha(pulse);
        const reference = applyBeatBoost(Uint8ClampedArray.from(bare), pulse);
        // THE REAL COMPOSITOR: the same two draws `tlDrawOwl` performs —
        // the bare owl, then the overlay at `globalAlpha` — on an
        // OffscreenCanvas, which is what the producer's surface is.
        const composited = await page.evaluate(
          ({ W, H, bare, overlay, alpha }) => {
            const base = new OffscreenCanvas(W, H);
            const g = base.getContext('2d', { willReadFrequently: true })!;
            const img = g.createImageData(W, H);
            img.data.set(bare);
            g.putImageData(img, 0, 0);
            const ov = new OffscreenCanvas(W, H);
            const og = ov.getContext('2d')!;
            const oimg = og.createImageData(W, H);
            oimg.data.set(overlay);
            og.putImageData(oimg, 0, 0);
            g.globalAlpha = alpha;
            g.drawImage(ov, 0, 0);
            g.globalAlpha = 1;
            return Array.from(g.getImageData(0, 0, W, H).data);
          },
          { W, H, bare: Array.from(bare), overlay: Array.from(overlay), alpha },
        );
        expect(composited.length).toBe(W * H * 4);

        // ⚠ PLAIN COUNTERS, ONE expect PER PROPERTY. An `expect` per pixel
        // (48,400 × 3 pulses) costs more than the whole boot and timed the
        // first draft of this leg out at 60 s with nothing wrong in the data.
        let maxDev = 0;
        let where = '';
        let exact = 0;
        let zeroMembershipMoved = 0;
        let darker = 0;
        let notOpaque = 0;
        for (let i = 0; i < composited.length; i += 4) {
          const a8 = overlay[i + 3]!;
          for (let ch = 0; ch < 3; ch++) {
            const got = composited[i + ch]!;
            const ref = reference[i + ch]!;
            const b = bare[i + ch]!;
            const dev = Math.abs(got - ref);
            if (dev === 0) exact++;
            if (dev > maxDev) {
              maxDev = dev;
              where = `px ${(i / 4) % W},${Math.floor(i / 4 / W)} ch${ch}: canvas ${got} vs reference ${ref} (bare ${b}, a8 ${a8}, alpha ${alpha})`;
            }
            if (a8 === 0 && got !== b) zeroMembershipMoved++;
            if (got < b) darker++;
          }
          if (composited[i + 3] !== 255) notOpaque++;
        }
        const total = W * H * 3;
        expect(notOpaque, `pulse ${pulse}: the frame stays opaque`).toBe(0);
        expect(
          zeroMembershipMoved,
          `pulse ${pulse}: ${zeroMembershipMoved} channel(s) OUTSIDE the bands moved — the body/ground must be byte-identical`,
        ).toBe(0);
        expect(darker, `pulse ${pulse}: the boost only ever brightens`).toBe(0);
        expect(
          maxDev,
          `pulse ${pulse}: max per-channel deviation ${maxDev} (${exact}/${total} exact) at ${where}`,
        ).toBeLessThanOrEqual(1);
        expect(exact, `pulse ${pulse}: most channels EXACT, not merely within tolerance`).toBeGreaterThan(total * 0.95);
        // eslint-disable-next-line no-console
        console.log(`[owl-overlay-parity] pulse ${pulse}: maxDev ${maxDev}, exact ${exact}/${total}, members ${members}${maxDev > 0 ? `, worst ${where}` : ''}`);
      }
    } finally {
      await ctx.close();
    }
  });

  test('LEG 2: the LIVE product — video_out is the bare owl outside the bands on every frame, brighter only inside', async ({ browser }) => {
    const bare = await bareOwlFor(browser);
    const overlay = buildBeatBoostOverlay(bare);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await bootRack(page);
      // Precondition: the producer has pushed at least once.
      await expect
        .poll(async () => { const r = await readVideoOut(page); return r.ok && !isIdleField(r.data); },
          { timeout: BOOT_MS, message: 'video_out never left the idle field on the live rack' })
        .toBe(true);

      interface LiveSample {
        ok: boolean;
        reason?: string;
        frames: number;
        /** Frames on which some in-band channel was brighter than the bare owl. */
        pulsing: number;
        /** Channels outside the bands that differed from the bare owl, summed. */
        outsideMoved: number;
        /** Channels anywhere that were DARKER than the bare owl, summed. */
        darker: number;
        /** Frames that were the idle field (skipped, counted). */
        idle: number;
      }
      // ⚠ THE ACCUMULATOR IS IN THE PAGE, over MORE THAN ONE BEAT of frames:
      // `beatPulse` is flat 0 for the last 40 % of every 500 ms beat at the
      // default 120 BPM, so `pulsing` can only be asserted over a window that
      // spans a whole beat at any plausible frame rate (64 frames ≥ 533 ms at
      // 120 Hz). The two zero-count legs hold on EVERY frame.
      let last: LiveSample | null = null;
      await expect
        .poll(
          async () => {
            last = await page.evaluate(
              async ({ nodeId, W, H, bare, coverage, frames }) => {
                const out: LiveSample = { ok: false, frames: 0, pulsing: 0, outsideMoved: 0, darker: 0, idle: 0 };
                const w = globalThis as unknown as { __engine?: () => { getDomain: (d: string) => unknown } };
                const eng = w.__engine?.();
                const audio = eng?.getDomain('audio') as
                  | { getVideoSource?: (n: string, p: string) => { drawFrame?: (c: HTMLCanvasElement) => void } | null }
                  | undefined;
                const src = audio?.getVideoSource?.(nodeId, 'video_out') ?? null;
                if (!src?.drawFrame) { out.reason = 'video_out publishes no drawFrame'; return out; }
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const g = c.getContext('2d', { willReadFrequently: true })!;
                for (let f = 0; f < frames; f++) {
                  await new Promise<void>((r) => requestAnimationFrame(() => r()));
                  try { src.drawFrame(c); } catch { continue; }
                  const px = g.getImageData(0, 0, W, H).data;
                  let idle = true;
                  for (let i = 0; i < px.length; i += 4) {
                    if (px[i]! > 12 || px[i + 1]! > 12 || px[i + 2]! > 16) { idle = false; break; }
                  }
                  if (idle) { out.idle++; continue; }
                  let brighter = false;
                  for (let i = 0; i < px.length; i += 4) {
                    const a8 = coverage[i >> 2]!;
                    for (let ch = 0; ch < 3; ch++) {
                      const got = px[i + ch]!;
                      const b = bare[i + ch]!;
                      if (got < b) out.darker++;
                      if (a8 === 0) { if (got !== b) out.outsideMoved++; }
                      else if (got > b) brighter = true;
                    }
                  }
                  if (brighter) out.pulsing++;
                  out.frames++;
                }
                out.ok = true;
                return out;
              },
              {
                nodeId: PINNED_ID, W, H,
                bare: Array.from(bare),
                coverage: Array.from({ length: W * H }, (_, p) => overlay[p * 4 + 3]!),
                frames: 64,
              },
            );
            return last.ok && last.frames > 0 && last.pulsing > 0;
          },
          {
            timeout: BOOT_MS,
            message: 'the live video_out never showed a PULSING frame over a full beat — the overlay is not being drawn',
          },
        )
        .toBe(true)
        .catch((e: unknown) => {
          throw new Error(`${String(e)}\nlast sample: ${JSON.stringify(last)}`);
        });

      const s = last as unknown as LiveSample;
      expect(s.frames, `the sampler never ran a frame: ${JSON.stringify(s)}`).toBeGreaterThan(0);
      expect(
        s.outsideMoved,
        `channel(s) OUTSIDE the bands differed from the bare owl on a live frame — the body/ground moved: ${JSON.stringify(s)}`,
      ).toBe(0);
      expect(s.darker, `a live frame was DARKER than the bare owl somewhere: ${JSON.stringify(s)}`).toBe(0);
      expect(s.pulsing, `no live frame was brighter inside the bands: ${JSON.stringify(s)}`).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(`[owl-overlay-parity] live: ${JSON.stringify(s)}`);
    } finally {
      await ctx.close();
    }
  });
});

/** The bare owl from a reduced-motion context of the same browser — the
 *  independent reference LEG 2 compares live frames against. */
async function bareOwlFor(browser: Browser): Promise<Uint8ClampedArray> {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  try {
    await bootRack(page);
    return await bareOwlFrom(page);
  } finally {
    await ctx.close();
  }
}
