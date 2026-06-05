// e2e/tests/gibribbon.spec.ts
//
// GibRibbon module smoke + full-play integration + gate-bridge coverage.
//
//   1. The card mounts cleanly with a visible 640×360 canvas that renders
//      non-black (the white vector ribbon).
//   2. Full play: drive clock+gate+CV to SPAWN an imp event, scroll it into
//      the timing window with clock ticks, then a correct ABXY press (X for an
//      imp) CLEARS it → score increases (an enemy was fired-and-killed).
//   3. A MISS degrades the marine (health_cv moves down) without a press.
//   4. forcePulse on each event gate bridges into a downstream SCOPE.ch1
//      (the cross-domain video→audio gate bridge), proven deterministically
//      (no reliance on gameplay RNG / SwiftShader pixels).
//
// DETERMINISTIC BY DESIGN: every gameplay assertion reads the engine's `read`
// state (score / health / combo) or a SCOPE analyser snapshot — NO fragile
// pixel diffs (only ONE coarse "is the canvas non-black?" check). Inputs are
// driven via eng.setParam(node, paramTarget, value), the same path a patched
// cable uses.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';

test.describe.configure({ mode: 'serial' });

/** Drive an input param (mirrors a patched cable's setParam write). */
async function setParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, k, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          setParam: (
            node: { id: string; type: string; domain: string; params: Record<string, number> },
            paramId: string,
            value: number,
          ) => void;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return;
      node.params[k] = v;
      eng.setParam(node, k, v);
    },
    { id: nodeId, k: paramId, v: value },
  );
}

/** Pulse a discrete input: rising edge (1) then falling edge (0). */
async function pulse(page: Page, nodeId: string, paramId: string): Promise<void> {
  await setParam(page, nodeId, paramId, 1);
  await page.waitForTimeout(8);
  await setParam(page, nodeId, paramId, 0);
  await page.waitForTimeout(8);
}

async function readNum(page: Page, nodeId: string, key: string): Promise<number | null> {
  return await page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return null;
      const v = eng.read(node, k);
      return typeof v === 'number' ? v : null;
    },
    { id: nodeId, k: key },
  );
}

async function readStr(page: Page, nodeId: string, key: string): Promise<string | null> {
  return await page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return null;
      const v = eng.read(node, k);
      return typeof v === 'string' ? v : null;
    },
    { id: nodeId, k: key },
  );
}

/** forcePulse a gate output via the extras hook (test-only deterministic
 *  bridge driver). Returns false if the handle isn't materialised yet. */
async function forcePulse(page: Page, nodeId: string, port: string, repeats = 6): Promise<boolean> {
  return await page.evaluate(
    async ({ id, p, n }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      const extras = eng.read(node, 'extras') as { forcePulse?: (p: string) => void } | undefined;
      if (!extras || typeof extras.forcePulse !== 'function') return false;
      for (let i = 0; i < n; i++) {
        extras.forcePulse(p);
        if (i < n - 1) await new Promise((r) => setTimeout(r, 40));
      }
      return true;
    },
    { id: nodeId, p: port, n: repeats },
  );
}

async function readScopePeak(page: Page, scopeNodeId: string): Promise<{ peak: number; rms: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
    if (!snap) return null;
    let peak = 0, sq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
    }
    return { peak, rms: Math.sqrt(sq / Math.max(1, snap.ch1.length)) };
  }, scopeNodeId);
}

test('gibribbon: card mounts cleanly + 640×360 canvas renders the white ribbon', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);

  const card = page.locator('.svelte-flow__node-gibribbon');
  await expect(card).toBeVisible();
  await expect(card).toContainText('GIBRIBBON');

  const canvas = card.locator('[data-testid="gibribbon-screen"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBe(640);
  expect(size.h).toBe(360);

  // The card polls the framebuffer at 30 Hz; give it a few frames, then assert
  // the canvas has the white ribbon (non-black pixels). ONE coarse pixel check.
  await page.waitForTimeout(300);
  const nonBg = await page.evaluate(() => {
    const c = document.querySelector('.svelte-flow__node-gibribbon [data-testid="gibribbon-screen"]') as HTMLCanvasElement | null;
    if (!c) return 0;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i]! > 80 || img.data[i + 1]! > 80 || img.data[i + 2]! > 80) n += 1;
    }
    return n;
  });
  expect(nonBg).toBeGreaterThan(50); // the white ribbon line is ≥ this many lit px

  // Filter benign noise: AudioContext autoplay warnings, and the DOOM1.WAD
  // 404 (the WAD is gitignored + absent in CI — GibRibbon falls back to
  // line-art figures by design; sprite decode is unit-tested separately).
  const real = errors.filter(
    (e) =>
      !e.includes('AudioContext') &&
      !e.includes('DOOM1.WAD') &&
      !/404 \(Not Found\)/.test(e) &&
      !e.includes('Failed to load resource'),
  );
  expect(real).toEqual([]);
});

test('gibribbon: clock+gate+CV spawns an imp → a correct ABXY press clears it (score up)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();

  expect(await readNum(page, 'g', 'score')).toBe(0);

  // cv3 → 'imp' (default cvEventMap = [loop, jump, imp, zombie]). Hold cv3 HIGH
  // + gate HIGH, then tick the clock to spawn an imp on the beat, then keep
  // ticking to scroll it toward the marine (each clock = scrollPerClock).
  await setParam(page, 'g', 'cv3', 0.95);
  await setParam(page, 'g', 'gate', 1);

  // First clock beat: spawns the imp at pos 1.0. Drop cv3 so we don't keep
  // spawning more imps as it scrolls. The imp now scrolls left toward the
  // marine via both clock ticks AND the engine's per-frame scroll (~0.22/s),
  // so it crosses the timing window over the next few seconds.
  await pulse(page, 'g', 'clock');
  await setParam(page, 'g', 'cv3', 0.0);

  // Hammer the X button (the imp's ABXY button) on a tight poll: every poll we
  // pulse x_btn (rising→falling edge) and re-check the score. Whichever press
  // lands while the imp is inside the hit window clears it (marine
  // fires-and-kills) → score > 0. This is robust to the exact pos/scroll phase
  // (no dependence on counting ticks).
  const cleared = await page.waitForFunction(
    ({ id }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          setParam: (n: { id: string; type: string; domain: string; params: Record<string, number> }, k: string, v: number) => void;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      // Rising then falling edge on x_btn (the edge detector needs the fall to
      // re-arm; one full press per poll).
      eng.setParam(node, 'btn_x', 1);
      eng.setParam(node, 'btn_x', 0);
      const s = eng.read(node, 'score');
      return typeof s === 'number' && s > 0;
    },
    { id: 'g' },
    { timeout: 8000, polling: 60 },
  ).catch(() => null);

  expect(cleared, 'a correct X press should clear the imp and raise the score').toBeTruthy();
  expect(await readNum(page, 'g', 'score')).toBeGreaterThan(0);
});

test('gibribbon: a missed event degrades the marine (health drops below healthy)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();

  expect(await readStr(page, 'g', 'health')).toBe('healthy');

  // Spawn a loop event (cv1) and let the clock scroll it PAST the marine with
  // NO button press → a miss → degrade healthy → wounded.
  await setParam(page, 'g', 'cv1', 0.95);
  await setParam(page, 'g', 'gate', 1);
  await pulse(page, 'g', 'clock');
  await setParam(page, 'g', 'cv1', 0.0);
  // Tick well past the miss line (pos 1.0 → missPos −0.12 over ~7 ticks at 0.18).
  for (let i = 0; i < 10; i++) await pulse(page, 'g', 'clock');

  const health = await readStr(page, 'g', 'health');
  expect(['wounded', 'critical', 'dead']).toContain(health);
});

// ── gate-bridge coverage: every event gate reaches a downstream SCOPE ────────
const GATE_PORTS = ['evt_hit', 'evt_miss', 'evt_fire', 'evt_kill', 'evt_gameover'] as const;

for (const port of GATE_PORTS) {
  test(`gibribbon: ${port} bridges into scope.ch1 (forcePulse)`, async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const scopeId = `scope-${port}`;
    await spawnPatch(
      page,
      [
        { id: 'g', type: 'gibribbon', position: { x: 200, y: 120 }, domain: 'video' },
        { id: scopeId, type: 'scope', position: { x: 560, y: 120 }, domain: 'audio' },
      ],
      [
        {
          id: `e-${port}`,
          from: { nodeId: 'g', portId: port },
          to: { nodeId: scopeId, portId: 'ch1' },
          sourceType: 'gate',
          targetType: 'audio', // scope ch1 declared audio; accepts gate via the bridge
        } as SpawnEdge,
      ],
    );
    await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();

    // Baseline: gate idle → scope reads ~0.
    const before = await readScopePeak(page, scopeId);
    expect(before?.peak ?? 0).toBeLessThan(0.2);

    // Drive the gate via forcePulse until the bridged pulse shows on ch1.
    const ok = await page.waitForFunction(
      async ({ id, p, sid }) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        if (!eng) return false;
        const node = w.__patch.nodes[id];
        const scope = w.__patch.nodes[sid];
        if (!node || !scope) return false;
        const extras = eng.read(node, 'extras') as { forcePulse?: (p: string) => void } | undefined;
        if (!extras || typeof extras.forcePulse !== 'function') return false;
        extras.forcePulse(p);
        const snap = eng.read(scope, 'snapshot') as { ch1: Float32Array } | undefined;
        if (!snap) return false;
        let peak = 0;
        for (let i = 0; i < snap.ch1.length; i++) {
          const a = Math.abs(snap.ch1[i]!);
          if (a > peak) peak = a;
        }
        return peak > 0.4;
      },
      { id: 'g', p: port, sid: scopeId },
      { timeout: 6000, polling: 50 },
    ).catch(() => null);

    expect(ok, `${port} should pulse SCOPE.ch1 above the floor via the gate bridge`).toBeTruthy();
  });
}
