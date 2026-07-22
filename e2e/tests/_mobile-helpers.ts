// e2e/tests/_mobile-helpers.ts
//
// Shared helpers for the /m mobile-prototype specs (mobile-synth, mobile-cam).
// NEW FILE by design: the shared _helpers.ts/_drivers.ts are in the attest
// hash bases and must not grow mobile-only code.

import { expect, type Page } from '@playwright/test';

/** The per-spec mobile emulation the /m specs use (spec §7): iPhone-ish
 *  viewport + touch. Per-spec `test.use(...)`, NEVER a new project in
 *  e2e/playwright.config.ts (which is in BOTH attest hash bases). */
export const MOBILE_USE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
} as const;

interface NodeLike {
  id: string;
  type: string;
  domain: string;
}

/** Audibility floor at AUDIO OUT's terminal tap (silent chain = 0 fails it). */
export const AUDIBLE_RMS = 0.01;

/** Boot /m/synth to the FIRST BLEEP scene and wait for audible RMS. Returns
 *  the collected pageerror list so a test can assert it stayed empty. */
export async function bootFirstBleep(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/m/synth');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('m-first-bleep').tap();
  await expect(page.getByTestId('m-tabbar')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => readOutputRms(page), { timeout: 60_000, message: 'FIRST BLEEP is audible' })
    .toBeGreaterThan(AUDIBLE_RMS);
  return errors;
}

/** Boot /m/synth to the EMPTY RACK scene (timelorde+mixmstrs+audioOut). */
export async function bootEmptyRack(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/m/synth');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('m-empty-rack').tap();
  await expect(page.getByTestId('m-tabbar')).toBeVisible({ timeout: 20_000 });
  return errors;
}

/** Read a live param of the FIRST node of `type` (undefined if absent). */
export async function nodeParam(page: Page, type: string, param: string): Promise<number | undefined> {
  return await page.evaluate(
    ([t, p]) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { type: string; params: Record<string, number> } | undefined> };
      };
      const n = Object.values(w.__patch?.nodes ?? {}).find((x) => x?.type === t);
      return n?.params?.[p];
    },
    [type, param],
  );
}

/** All live edges as {sourceNode,sourcePort,targetNode,targetPort} tuples. */
export async function readEdges(
  page: Page,
): Promise<{ st: string; sp: string; tt: string; tp: string }[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: {
        nodes: Record<string, { id: string; type: string } | undefined>;
        edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined>;
      };
    };
    const nodes = w.__patch?.nodes ?? {};
    const typeOf = (id: string) => nodes[id]?.type ?? id;
    const out: { st: string; sp: string; tt: string; tp: string }[] = [];
    for (const e of Object.values(w.__patch?.edges ?? {})) {
      if (!e) continue;
      out.push({ st: typeOf(e.source.nodeId), sp: e.source.portId, tt: typeOf(e.target.nodeId), tp: e.target.portId });
    }
    return out;
  });
}

/** Find the first node of `type` in the live patch via the __patch hook. */
export async function findNodeIdByType(page: Page, type: string): Promise<string | null> {
  return await page.evaluate((t) => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { id: string; type: string } | undefined> };
    };
    if (!w.__patch) return null;
    for (const n of Object.values(w.__patch.nodes)) {
      if (n && n.type === t) return n.id;
    }
    return null;
  }, type);
}

/**
 * RMS at AUDIO OUT's TERMINAL tap (the limiter feeding ctx.destination) —
 * the genuine audibility probe (read('outputSnapshot'), audio-out.ts).
 * Returns 0 when the engine/node isn't up yet, so callers can poll.
 */
export async function readOutputRms(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: NodeLike, k: string) => unknown;
      } | null;
      __patch?: { nodes: Record<string, NodeLike | undefined> };
    };
    const eng = w.__engine?.();
    if (!eng || !w.__patch) return 0;
    let out: NodeLike | undefined;
    for (const n of Object.values(w.__patch.nodes)) {
      if (n && n.type === 'audioOut') {
        out = n;
        break;
      }
    }
    if (!out) return 0;
    let snap: { samples: Float32Array } | undefined;
    try {
      snap = eng.read(out, 'outputSnapshot') as { samples: Float32Array } | undefined;
    } catch {
      return 0;
    }
    if (!snap?.samples?.length) return 0;
    let s = 0;
    for (let i = 0; i < snap.samples.length; i++) s += snap.samples[i]! * snap.samples[i]!;
    return Math.sqrt(s / snap.samples.length);
  });
}

/** MIXMSTRS per-channel post-fader RMS levels (engine.read(mx,'levels')). */
export async function readMixLevels(page: Page): Promise<number[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: NodeLike, k: string) => unknown } | null;
      __patch?: { nodes: Record<string, NodeLike | undefined> };
    };
    const eng = w.__engine?.();
    if (!eng || !w.__patch) return [];
    let mx: NodeLike | undefined;
    for (const n of Object.values(w.__patch.nodes)) {
      if (n && n.type === 'mixmstrs') {
        mx = n;
        break;
      }
    }
    if (!mx) return [];
    try {
      const l = eng.read(mx, 'levels');
      return Array.isArray(l) ? (l as number[]) : [];
    } catch {
      return [];
    }
  });
}

/** Count edges in the live patch (via __patch). */
export async function edgeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: { edges: Record<string, unknown> };
    };
    if (!w.__patch) return 0;
    return Object.values(w.__patch.edges).filter(Boolean).length;
  });
}

/**
 * Drag a mobile HSlider/LaneFader track horizontally by `dxRatio` of its
 * width (relative drag — the component never jumps to the touch point).
 */
export async function dragSliderBy(page: Page, trackSelector: string, dxRatio: number): Promise<void> {
  const track = page.locator(trackSelector);
  const box = await track.boundingBox();
  if (!box) throw new Error(`no bounding box for ${trackSelector}`);
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  // A few intermediate moves so the rAF-coalesced commit sees a real drag.
  const dx = box.width * dxRatio;
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(startX + (dx * i) / 5, y);
  }
  await page.mouse.up();
}

/**
 * Luma signature of a 2D canvas: fraction of non-black pixels + mean luma,
 * sampled on a coarse grid (renderer-tolerant — SwiftShader vs real GPU may
 * differ per-pixel; a fraction/mean comparison does not).
 */
export async function canvasLumaStats(
  page: Page,
  canvasSelector: string,
): Promise<{ litFraction: number; meanLuma: number }> {
  return await page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      return { litFraction: 0, meanLuma: 0 };
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return { litFraction: 0, meanLuma: 0 };
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const stride = 16; // coarse grid — plenty of samples, cheap
    let lit = 0;
    let total = 0;
    let lumaSum = 0;
    for (let y = 0; y < canvas.height; y += stride) {
      for (let x = 0; x < canvas.width; x += stride) {
        const i = (y * canvas.width + x) * 4;
        const luma =
          0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
        lumaSum += luma;
        if (luma > 16) lit++;
        total++;
      }
    }
    return { litFraction: total ? lit / total : 0, meanLuma: total ? lumaSum / total : 0 };
  }, canvasSelector);
}
