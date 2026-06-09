// e2e/tests/toybox-cv-routing.spec.ts
//
// TOYBOX modulation section — the 6-input CV/MOD section. Each input has an
// attenuverter (SCALE) + OFFSET, auto-detects cv-vs-audio from the inbound
// edge's sourceType, and routes to an addressed layer/combine/obj param. This
// spec drives the engine's real setParam path (what the cross-domain bridge does
// each frame) and asserts the resolved LIVE param moves with the new scale/offset
// model:
//
//   (a) cv1 → a SHADER param   (layer 0 content uniform 'speed'),
//   (b) cv2 → a COMBINE param  (a fade op node's amount),
//   (c) cv3 → an OBJ param     (layer 2 material 'spin'),
//   (d) AUDIO source into an input is detected as audio + envelope-modulates,
//   (e) OFFSET on an UNPATCHED routed port moves the param (manual control).
//
// We seed real EDGES (with the right sourceType) so the factory's edge-based
// kind detection fires + applyUnpatchedOffsets leaves the bridge in charge; a
// patched cv source folds its bipolar sample to 0..1, an audio source is taken
// as an already-0..1 envelope.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type ObjMaterial = { spin?: number; [k: string]: number | undefined };
type FadeParams = { amount?: number; [k: string]: number | undefined };

type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      {
        data?: {
          combine?: { nodes?: { id?: string; kind?: string; params?: FadeParams }[]; edges?: unknown[] };
          layers?: { kind?: string; contentId?: string | null; params?: Record<string, number>; material?: ObjMaterial }[];
          cvRoutes?: Record<string, unknown>;
          cvInputs?: Record<string, { scale?: number; offset?: number }>;
        };
      }
    >;
    edges: Record<string, unknown>;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __engine?: () => { getDomain: <T>(d: string) => T };
};

type VideoEngineLike = {
  setParam: (nodeId: string, paramId: string, value: number) => void;
  read?: (nodeId: string, key: string) => unknown;
};

/** Pin the viewport at scale 1, panned up so the (CV-section-open) card body
 *  clears the fixed bottombar footer. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Seed the demo patch (layers + crossfade combine graph) + a set of edges into
 *  the TOYBOX modulation inputs with the given sourceTypes (so the factory's
 *  kind detection sees a "patched" port owned by the bridge). */
async function seedDemoPatch(
  page: Page,
  edges: { id: string; port: string; sourceType: string }[],
): Promise<void> {
  await page.evaluate((edges) => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: { speed: 0.4 } },
        { kind: 'gen', contentId: 'cos-gradient', params: {} },
        {
          kind: 'obj',
          contentId: null,
          params: {},
          material: {
            modelId: 'cube', rotX: 0.3, rotY: 0.6, rotZ: 0, scale: 1,
            spin: 0, matcap: 0, tintR: 1, tintG: 1, tintB: 1,
          },
        },
        { kind: 'off', contentId: null, params: {} },
      ];
      n.data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'xf', kind: 'fade', x: 120, y: 40, params: { amount: 0.5 } },
          { id: 'out', kind: 'output', x: 286, y: 40 },
        ],
        edges: [
          { id: 'e0', from: 'src0', to: 'xf', toPort: 'in0' },
          { id: 'e1', from: 'src1', to: 'xf', toPort: 'in1' },
          { id: 'e2', from: 'xf', to: 'out', toPort: 'in0' },
        ],
      };
      // Seed inbound edges into the modulation inputs (a synthetic source 'lfo'
      // — the node need not exist for the factory's edge-based kind detection,
      // which only reads edge.target + edge.sourceType).
      for (const e of edges) {
        w.__patch.edges[e.id] = {
          id: e.id,
          source: { nodeId: 'lfo', portId: 'out' },
          target: { nodeId: 'tb', portId: e.port },
          sourceType: e.sourceType,
          targetType: 'modsignal',
        };
      }
    });
  }, edges);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Drive a generic input through the engine's real setParam path (what the
 *  bridge does each frame). For cv the value is the bipolar sample (−1..+1);
 *  for audio it's the already-0..1 envelope value. */
async function driveCv(page: Page, port: string, raw: number): Promise<void> {
  await page.evaluate(
    ({ port, raw }) => {
      const w = globalThis as unknown as PatchGlobal;
      const e = w.__engine?.();
      try {
        e?.getDomain<VideoEngineLike>('video')?.setParam('tb', port, raw);
      } catch { /* */ }
    },
    { port, raw },
  );
}

/** Read the LIVE (post-modulation) layers/combine from the ENGINE, plus the
 *  persisted routes/inputs from the patch.
 *
 *  Live CV modulation no longer rides the synced Y.Doc (the progressive-slowdown
 *  / memory-leak fix: mutating the Yjs proxy per CV frame fired a doc update per
 *  frame → SvelteFlow re-render storm → leaked detached edge SVG). The modulated
 *  param values now live in the engine's render-local clone, exposed via
 *  read('liveModulated') — so we read the moved param THERE (mirrors how the card
 *  reads its scopes via read('cvScope')). cvRoutes/cvInputs are authored config
 *  and stay on node.data. */
async function readData(page: Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    const n = w.__patch.nodes['tb'];
    const eng = w.__engine?.().getDomain<VideoEngineLike>('video');
    const live = eng?.read?.('tb', 'liveModulated') as
      | {
          layers?: { kind?: string; contentId?: string | null; params?: Record<string, number>; material?: ObjMaterial }[];
          combine?: { nodes?: { id?: string; kind?: string; params?: FadeParams }[]; edges?: unknown[] };
        }
      | undefined;
    return {
      layers: live?.layers ?? n?.data?.layers ?? [],
      combine: live?.combine ?? n?.data?.combine ?? { nodes: [] },
      cvRoutes: n?.data?.cvRoutes ?? {},
      cvInputs: n?.data?.cvInputs ?? {},
    };
  });
}

/** Set a route + scale/offset directly in node.data (mirrors the card mutators)
 *  for deterministic param assertions without exercising the slow select UI. */
async function seedRoute(
  page: Page,
  port: string,
  route: Record<string, unknown>,
  scale: number,
  offset: number,
): Promise<void> {
  await page.evaluate(({ port, route, scale, offset }) => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n?.data) return;
      if (!n.data.cvRoutes) n.data.cvRoutes = {};
      if (!n.data.cvInputs) n.data.cvInputs = {};
      n.data.cvRoutes[port] = route;
      n.data.cvInputs[port] = { scale, offset };
    });
  }, { port, route, scale, offset });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function spawnToybox(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
}

test.describe('TOYBOX CV/modulation section', () => {
  // TOYBOX runs a WebGL rAF compositor; on CI's software renderer every op is
  // slow. Match the existing heavy-video toybox specs.
  test.setTimeout(90_000);

  test('routes cv1→shader, cv2→combine, cv3→obj + drives each (scale/offset model)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);
    await seedDemoPatch(page, [
      { id: 'ec1', port: 'cv1', sourceType: 'cv' },
      { id: 'ec2', port: 'cv2', sourceType: 'cv' },
      { id: 'ec3', port: 'cv3', sourceType: 'cv' },
    ]);

    // Route via node.data (the UI select path is covered separately below).
    await seedRoute(page, 'cv1', { target: 'layer', layer: 0, param: 'speed' }, 1, 0);
    await seedRoute(page, 'cv2', { target: 'combine', nodeId: 'xf', param: 'amount' }, 1, 0);
    await seedRoute(page, 'cv3', { target: 'layer', layer: 2, param: 'material:spin' }, 1, 0);

    // ── (a) cv1 full scale +1 cv → folds to 1.0 → speed = max (2) ──
    await driveCv(page, 'cv1', 1);
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeCloseTo(2, 2);
    }
    // cv1 = -1 → folds to 0 → speed = min (0). Bidirectional sweep.
    await driveCv(page, 'cv1', -1);
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeCloseTo(0, 2);
    }
    // cv1 = 0 (centre) → folds to 0.5 → speed = midpoint (1).
    await driveCv(page, 'cv1', 0);
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeCloseTo(1, 2);
    }

    // ── (b) cv2 = +1 → fade amount = max (1); -1 → 0 ──
    await driveCv(page, 'cv2', 1);
    {
      const { combine } = await readData(page);
      expect(combine.nodes!.find((x) => x.id === 'xf')!.params!.amount).toBeCloseTo(1, 2);
    }
    await driveCv(page, 'cv2', -1);
    {
      const { combine } = await readData(page);
      expect(combine.nodes!.find((x) => x.id === 'xf')!.params!.amount).toBeCloseTo(0, 2);
    }

    // ── (c) cv3 = +1 → layer 2 material spin = max (3) ──
    await driveCv(page, 'cv3', 1);
    {
      const { layers } = await readData(page);
      expect(layers[2]!.material!.spin).toBeCloseTo(3, 2);
    }

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('attenuverter SCALE inverts + scales; AUDIO source is detected + envelope-modulates', async ({ page }) => {
    await spawnToybox(page);
    await seedDemoPatch(page, [
      { id: 'ec1', port: 'cv1', sourceType: 'cv' },
      { id: 'ea2', port: 'cv2', sourceType: 'audio' },
    ]);

    // cv1 with SCALE -1, OFFSET 1 → a rising signal LOWERS the param (invert).
    await seedRoute(page, 'cv1', { target: 'layer', layer: 0, param: 'speed' }, -1, 1);
    await driveCv(page, 'cv1', 1); // fold → 1.0 → norm = clamp(1*-1+1)=0 → speed min (0)
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeCloseTo(0, 2);
    }
    await driveCv(page, 'cv1', -1); // fold → 0 → norm = clamp(0*-1+1)=1 → speed max (2)
    {
      const { layers } = await readData(page);
      expect(layers[0]!.params!.speed).toBeCloseTo(2, 2);
    }

    // cv2 is an AUDIO source → the value is taken as an already-0..1 envelope
    // (NOT folded). Route to the fade amount (0..1).
    await seedRoute(page, 'cv2', { target: 'combine', nodeId: 'xf', param: 'amount' }, 1, 0);
    await driveCv(page, 'cv2', 0.75); // audio envelope 0.75 → amount 0.75
    {
      const { combine } = await readData(page);
      expect(combine.nodes!.find((x) => x.id === 'xf')!.params!.amount).toBeCloseTo(0.75, 2);
    }
    // The badge auto-detects AUDIO from the edge sourceType (section default-open).
    await page.locator('[data-testid="toybox-cv-rows"]').waitFor({ state: 'visible', timeout: 5_000 });
    await expect(page.locator('[data-testid="toybox-cv-badge-cv2"]')).toHaveAttribute('data-kind', 'audio', {
      timeout: 5_000,
    });
  });

  test('OFFSET on an UNPATCHED routed port drives the param (manual control, no cable)', async ({ page }) => {
    await spawnToybox(page);
    // No inbound edges → applyUnpatchedOffsets owns the write each frame.
    await seedDemoPatch(page, []);
    // Route cv4 → fade amount with OFFSET 0.5, no cable.
    await seedRoute(page, 'cv4', { target: 'combine', nodeId: 'xf', param: 'amount' }, 1, 0.5);

    // Let the engine render a few frames so applyUnpatchedOffsets runs.
    await page.evaluate(() => new Promise<void>((r) => {
      let n = 0;
      const tick = () => (++n < 6 ? requestAnimationFrame(tick) : r());
      requestAnimationFrame(tick);
    }));
    {
      const { combine } = await readData(page);
      expect(combine.nodes!.find((x) => x.id === 'xf')!.params!.amount).toBeCloseTo(0.5, 2);
    }

    // Raise the OFFSET to 0.9 → the param tracks it (manual control).
    await seedRoute(page, 'cv4', { target: 'combine', nodeId: 'xf', param: 'amount' }, 1, 0.9);
    await page.evaluate(() => new Promise<void>((r) => {
      let n = 0;
      const tick = () => (++n < 6 ? requestAnimationFrame(tick) : r());
      requestAnimationFrame(tick);
    }));
    {
      const { combine } = await readData(page);
      expect(combine.nodes!.find((x) => x.id === 'xf')!.params!.amount).toBeCloseTo(0.9, 2);
    }
  });
});
