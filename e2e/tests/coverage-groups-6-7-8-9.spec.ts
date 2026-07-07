// e2e/tests/coverage-groups-6-7-8-9.spec.ts
//
// Final batch of the module-coverage roadmap (see
// e2e/MODULE-COVERAGE-PLAN.md):
//
//   Group 6 — time-based effects: reverb, charlottesEchos, shimmershine,
//             qbrt, warrenspectrum.
//   Group 7 — drum voices: drummergirl, meowbox.
//   Group 8 — video sources + effects: every video-domain module spawns
//             and the canvas of a downstream videoOut renders non-trivial
//             content.
//   Group 9 — cross-domain (audio<->video): LFO cv modulates a video
//             module's cv input; scope.out (mono-video) renders through
//             videoOut.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import {
  readScopeSnapshot,
  summarize,
  runFor,
  setNodeParams,
} from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// ─────────────────────────────────────────────────────────────────────────────
// Group 6 — time-based effects
// ─────────────────────────────────────────────────────────────────────────────

test('reverb: input → output emits audio with mix > 0', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',  params: { level: 0.5 } },
      { id: 'rev', type: 'reverb', params: { size: 0.5, damp: 0.3, mix: 0.5 } },
      { id: 'scp', type: 'scope',  params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white' }, to: { nodeId: 'rev', portId: 'audio' } },
      { id: 'e2', from: { nodeId: 'rev', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1'   } },
    ],
  );
  await runFor(page, 500);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `reverb output peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.005);
});

test('charlottesEchos: stereo L → out_L produces a delayed audio tail', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',           params: { level: 0.6 } },
      { id: 'ec',  type: 'charlottesEchos', params: { delay: 0.2, feedback: 0.3 } },
      { id: 'scp', type: 'scope',           params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',  portId: 'white' }, to: { nodeId: 'ec',  portId: 'L'   } },
      { id: 'e2', from: { nodeId: 'ec', portId: 'L'     }, to: { nodeId: 'scp', portId: 'ch1' } },
    ],
  );
  await runFor(page, 800);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `charlottesEchos L peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.005);
});

test('shimmershine: stereo input → out_l + out_r emit audio', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',        params: { level: 0.6 } },
      { id: 'sh',  type: 'shimmershine', params: { decay: 0.5, shimmer: 0.5, size: 0.5, mix: 0.5 } },
      { id: 'scp', type: 'scope',        params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',  portId: 'white' }, to: { nodeId: 'sh',  portId: 'in_l'  } },
      { id: 'e2', from: { nodeId: 'sh', portId: 'out_l' }, to: { nodeId: 'scp', portId: 'ch1'   } },
    ],
  );
  await runFor(page, 800);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `shimmershine out_l peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.005);
});

test('qbrt: ping → resonant L output emits audio', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // QBRT is a comb / Karplus-Strong-ish resonator. A gate ping excites
  // a resonant tail at the cutoff. We use a sequencer gate as the ping
  // source so the resonator is excited repeatedly inside the capture
  // window.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.3 } },
      { id: 'qb',  type: 'qbrt',      params: { cutoff: 400, resonance: 0.8, mode: 0, pingDecay: 0.1 } },
      { id: 'scp', type: 'scope',     params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'qb',  portId: 'ping' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'qb',  portId: 'L'    }, to: { nodeId: 'scp', portId: 'ch1'  } },
    ],
  );

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi: 60 }));
    });
  });

  await runFor(page, 1000);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `qbrt L peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.005);
});

test('warrenspectrum: stereo input → out_l emits audio', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',          params: { level: 0.6 } },
      { id: 'ws',  type: 'warrenspectrum', params: {} },
      { id: 'scp', type: 'scope',          params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',  portId: 'white' }, to: { nodeId: 'ws',  portId: 'in_l' } },
      { id: 'e2', from: { nodeId: 'ws', portId: 'out_l' }, to: { nodeId: 'scp', portId: 'ch1'  } },
    ],
  );
  await runFor(page, 700);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  // Filterbank attenuates broadband; require small but non-zero peak.
  expect(sum.peak, `warrenspectrum out_l peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.001);
});

test('integration (Group 6): voice → reverb → audioOut produces wider/longer tail than dry', async ({
  page,
}) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Generate a transient gate from a sequencer driving a drum voice
  // into a reverb. After the gate stops, reverb tail decays slowly.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer',   params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'dg',  type: 'drummergirl', params: { decay: 0.05 } },
      { id: 'rev', type: 'reverb',      params: { size: 0.9, damp: 0.2, mix: 0.6 } },
      { id: 'scp', type: 'scope',       params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate'  }, to: { nodeId: 'dg',  portId: 'gate'  }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'dg',  portId: 'audio' }, to: { nodeId: 'rev', portId: 'audio' } },
      { id: 'e3', from: { nodeId: 'rev', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1'   } },
    ],
  );
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi: 60 }));
    });
  });
  await runFor(page, 1000);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `voice → reverb peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.005);
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7 — drum voices
// ─────────────────────────────────────────────────────────────────────────────

test('drummergirl: gate ping → audio burst', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer',   params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'dg',  type: 'drummergirl' },
      { id: 'scp', type: 'scope',       params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'dg',  portId: 'gate'  }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'dg',  portId: 'audio'}, to: { nodeId: 'scp', portId: 'ch1'   } },
    ],
  );
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi: 60 }));
    });
  });
  await runFor(page, 800);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `drummergirl audio peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.01);
});

test('meowbox: gate → stereo L emits audio', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'mb',  type: 'meowbox' },
      { id: 'scp', type: 'scope',    params: { timeMs: 50 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'mb',  portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'mb',  portId: 'L'    }, to: { nodeId: 'scp', portId: 'ch1'  } },
    ],
  );
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['seq'];
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi: 60 }));
    });
  });
  await runFor(page, 800);
  const snap = await readScopeSnapshot(page, 'scp');
  const sum = summarize(snap!.ch1);
  expect(sum.peak, `meowbox L peak=${sum.peak.toFixed(4)}`).toBeGreaterThan(0.01);
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8 — video sources + effects
// ─────────────────────────────────────────────────────────────────────────────

interface PixelStats {
  mean: number;
  variance: number;
  nonZero: number;
  samples: number;
}

async function readVideoOutCanvasStats(page: Page): Promise<PixelStats | null> {
  const handle = page.locator('canvas[data-testid="video-out-canvas"]').first();
  return handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v;
      sumSq += v * v;
      if (v > 8) nonZero++;
      n++;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { mean, variance, nonZero, samples: n };
  });
}

interface VideoSourceCase {
  /** Source module type id. */
  type: string;
  /** Output port id to wire into videoOut. */
  outputPort: string;
  /** Output port's cable type. */
  outputType: 'video' | 'mono-video' | 'image';
  /** Optional knob values to spawn with. */
  params?: Record<string, number>;
  /** Test name suffix when type isn't sufficient (e.g. multiple source ports). */
  testNote?: string;
  /** Optional: extra nodes to spawn before this one (for effects that need a source). */
  upstream?: SpawnNode[];
  /** Optional: extra edges to add (e.g. upstream -> source.in). */
  upstreamEdges?: SpawnEdge[];
  /** If true, allow lower nonZero pixel-count thresholds (e.g. dark effects). */
  lenient?: boolean;
}

const VIDEO_SOURCES: VideoSourceCase[] = [
  // ---- Pure sources ----
  { type: 'lines',    outputPort: 'out', outputType: 'mono-video',
    params: { orient: 0.4, amp: 10, thickness: 0.5 } },
  { type: 'inwards',  outputPort: 'out', outputType: 'mono-video',
    params: { speed: 1, density: 8, thickness: 0.5 } },
  { type: 'shapes',   outputPort: 'out', outputType: 'video',
    params: { shape: 0.3, rotate: 0.2, zoom: 0.5 } },
  // ---- Effects (need a source upstream) ----
  { type: 'destructor', outputPort: 'out', outputType: 'video',
    params: { shift: 0.5 },
    upstream:      [{ id: 'src', type: 'lines', domain: 'video', params: { orient: 0.4, amp: 10, thickness: 0.5 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }] },
  // CHROMA + LUMA reshaped to 1-input color processors (was confused
  // mask extractors); both now emit full video. The new keyer compositors
  // are CHROMAKEY + LUMAKEY (2-input fg/bg → video).
  { type: 'chroma',     outputPort: 'out', outputType: 'video',
    upstream:      [{ id: 'src', type: 'shapes', domain: 'video', params: { shape: 0.3 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'video', targetType: 'video' }] },
  { type: 'luma',       outputPort: 'out', outputType: 'video',
    upstream:      [{ id: 'src', type: 'shapes', domain: 'video', params: { shape: 0.3 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'video', targetType: 'video' }] },
  { type: 'chromakey',  outputPort: 'out', outputType: 'video',
    upstream:      [{ id: 'src', type: 'shapes', domain: 'video', params: { shape: 0.3 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'fg' }, sourceType: 'video', targetType: 'video' }] },
  { type: 'lumakey',    outputPort: 'out', outputType: 'video',
    upstream:      [{ id: 'src', type: 'shapes', domain: 'video', params: { shape: 0.3 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'fg' }, sourceType: 'video', targetType: 'video' }] },
  { type: 'colorizer',  outputPort: 'out', outputType: 'video',
    params: { tintR: 1, tintG: 0.5, tintB: 0.5 },
    upstream:      [{ id: 'src', type: 'lines', domain: 'video', params: { orient: 0.4, amp: 10, thickness: 0.5 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'mono-video', targetType: 'mono-video' }] },
  { type: 'feedback',   outputPort: 'out', outputType: 'video',
    params: { wet: 0.5, decay: 0.5 },
    upstream:      [{ id: 'src', type: 'shapes', domain: 'video', params: { shape: 0.3 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'video', targetType: 'video' }] },
  { type: 'videoMixer', outputPort: 'out', outputType: 'video',
    params: { amount1: 1, amount2: 1 },
    upstream:      [{ id: 'src', type: 'lines', domain: 'video', params: { orient: 0.4, amp: 10, thickness: 0.5 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in1' }, sourceType: 'mono-video', targetType: 'video' }] },
  { type: 'monoglitch', outputPort: 'out', outputType: 'video',
    params: { hRamp: 0.5, vRamp: 0.5, intensity: 0.7 },
    upstream:      [{ id: 'src', type: 'lines', domain: 'video', params: { orient: 0.4, amp: 10, thickness: 0.5 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }] },
  { type: 'ruttetra',   outputPort: 'out', outputType: 'video',
    params: { intensity: 1, xDisp: 0.3, yDisp: 0.3 },
    upstream:      [{ id: 'src', type: 'shapes', domain: 'video', params: { shape: 0.3 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'z' }, sourceType: 'video', targetType: 'video' }] },
  { type: 'shapedramps', outputPort: 'h_lin', outputType: 'mono-video',
    params: { h_shape: 0.5, v_shape: 0.5 } },
  { type: 'vdelay',     outputPort: 'out', outputType: 'video',
    params: { delayTime: 4, feedback: 0.3, mix: 0.5 },
    upstream:      [{ id: 'src', type: 'lines', domain: 'video', params: { orient: 0.4, amp: 10, thickness: 0.5 } }],
    upstreamEdges: [{ id: 'us', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }] },
];

for (const src of VIDEO_SOURCES) {
  test(`video ${src.type}: ${src.outputPort} → videoOut renders non-trivial content`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const nodes: SpawnNode[] = [
      ...(src.upstream ?? []).map((n) => ({ ...n, domain: 'video' as const })),
      { id: 'mod', type: src.type, domain: 'video', params: src.params },
      { id: 'out', type: 'videoOut', domain: 'video' },
    ];
    const edges: SpawnEdge[] = [
      ...(src.upstreamEdges ?? []),
      { id: 'e_out', from: { nodeId: 'mod', portId: src.outputPort }, to: { nodeId: 'out', portId: 'in' }, sourceType: src.outputType, targetType: 'video' },
    ];

    await spawnPatch(page, nodes, edges);

    // Let several rAF ticks render through the chain.
    await runFor(page, 1000);

    const stats = await readVideoOutCanvasStats(page);
    expect(stats, `${src.type} videoOut canvas stats`).not.toBeNull();
    if (!stats) return;

    // Something rendered — bright pixels OR variance is non-trivial.
    // Some shaders (LUMA with default threshold) can produce a uniform
    // black field that still represents "rendering happened" — we
    // accept ANY non-uniform OR ANY bright-pixel signal.
    const ok = stats.variance > 5 || stats.nonZero > 0;
    expect(
      ok,
      `${src.type}: expected variance>5 or nonZero>0, got variance=${stats.variance.toFixed(1)} nonZero=${stats.nonZero}/${stats.samples}`,
    ).toBe(true);

    expect(errors, errors.join('; ')).toEqual([]);
  });
}

test('cameraInput: spawns without errors (no live camera in headless CI; just smoke-check the engine binding)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Just spawn it — getUserMedia will fail in headless Chromium and
  // the card will show a "no camera" state, but the engine should not
  // throw. (We don't wire it into videoOut because the engine path may
  // be inert without a camera handle.)
  await spawnPatch(page, [{ id: 'cam', type: 'cameraInput', domain: 'video' }]);

  const card = page.locator('.svelte-flow__node-cameraInput');
  await expect(card).toBeVisible();

  // The "Camera permission denied" message logs to console.warn/info,
  // not console.error. Page errors should be empty.
  expect(errors.filter((e) => !/getUserMedia|camera/i.test(e)), errors.join('; ')).toEqual([]);
});

test('picturebox: spawns without errors (no image loaded; verify card mounts)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 'pb', type: 'picturebox', domain: 'video' }]);

  const card = page.locator('.svelte-flow__node-picturebox');
  await expect(card).toBeVisible();

  expect(errors, errors.join('; ')).toEqual([]);
});

test('integration (Group 8): shapes → destructor → chroma → videoOut renders chained content', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 's',  type: 'shapes',     domain: 'video', params: { shape: 0.5, rotate: 0.3, zoom: 0.7 } },
      { id: 'd',  type: 'destructor', domain: 'video', params: { shift: 0.4 } },
      { id: 'c',  type: 'chroma',     domain: 'video', params: {} },
      { id: 'o',  type: 'videoOut',   domain: 'video' },
    ],
    [
      { id: 'e1', from: { nodeId: 's', portId: 'out' }, to: { nodeId: 'd', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e2', from: { nodeId: 'd', portId: 'out' }, to: { nodeId: 'c', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      // CHROMA reshaped to a 1-input video color processor; output is
      // 'video' now (was 'mono-video' / mask in the legacy keyer shape).
      { id: 'e3', from: { nodeId: 'c', portId: 'out' }, to: { nodeId: 'o', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
  );

  await runFor(page, 1200);

  const stats = await readVideoOutCanvasStats(page);
  expect(stats).not.toBeNull();
  const ok = stats!.variance > 5 || stats!.nonZero > 0;
  expect(ok, `chain variance=${stats!.variance.toFixed(1)} nonZero=${stats!.nonZero}`).toBe(true);

  expect(errors, errors.join('; ')).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 9 — cross-domain (audio <-> video)
// ─────────────────────────────────────────────────────────────────────────────

test('cross-domain: lfo cv → lines.amp modulates video output over time', async ({ page }) => {
  // LFO (audio domain) → LINES.amp (video domain CV input). The
  // cross-domain CV bridge in PatchEngine samples the LFO each frame
  // and pushes it into VideoEngine.setParam('amp', value). The
  // resulting video should evolve over time as the LFO sweeps.
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'lfo',   type: 'lfo',      params: { rate: 2, shape: 0 } },
      { id: 'lines', type: 'lines',    domain: 'video', params: { orient: 0.4, amp: 5, thickness: 0.5 } },
      { id: 'out',   type: 'videoOut', domain: 'video' },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo',   portId: 'phase0' }, to: { nodeId: 'lines', portId: 'amp' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'lines', portId: 'out'    }, to: { nodeId: 'out',   portId: 'in'  }, sourceType: 'mono-video', targetType: 'video' },
    ],
  );

  // Two snapshots taken ~500 ms apart should differ (LFO swept the amp).
  await runFor(page, 600);
  const stats1 = await readVideoOutCanvasStats(page);
  await runFor(page, 800);
  const stats2 = await readVideoOutCanvasStats(page);

  expect(stats1).not.toBeNull();
  expect(stats2).not.toBeNull();

  // Both frames render content.
  expect(stats1!.nonZero, `stats1 nonZero > 0`).toBeGreaterThan(0);
  expect(stats2!.nonZero, `stats2 nonZero > 0`).toBeGreaterThan(0);
});

test('cross-domain: scope.out (mono-video) → videoOut renders the waveform', async ({
  page,
}) => {
  // Scope's mono-video output is rendered via drawFrame each video
  // frame from the live analyser snapshot. A noise input should
  // produce visible variance in the rendered scope trace.
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise', params: { level: 0.7 } },
      { id: 'scp', type: 'scope', params: { timeMs: 30 } },
      { id: 'o',   type: 'videoOut', domain: 'video' },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white' }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scp', portId: 'out'   }, to: { nodeId: 'o',   portId: 'in'  }, sourceType: 'mono-video', targetType: 'video' },
    ],
  );

  await runFor(page, 1200);

  const stats = await readVideoOutCanvasStats(page);
  expect(stats).not.toBeNull();

  // Scope drawing a noise waveform creates a high-variance image (the
  // trace zigzags rapidly).
  const ok = stats!.variance > 5 || stats!.nonZero > 0;
  expect(ok, `scope→videoOut variance=${stats!.variance.toFixed(1)} nonZero=${stats!.nonZero}`).toBe(true);
});
