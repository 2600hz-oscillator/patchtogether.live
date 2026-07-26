// e2e/tests/workflow-master-transport.spec.ts
//
// P0 GUARD — WORKFLOW MASTER TRANSPORT drives real clip playback, end to end.
// Joins the transport guard family (clipplayer-transport-no-controller covers
// the dawless card seam); this one drives the OWNER-FACING workflow surface on
// /rack?mode=workflow AND ?shell=1: the pinned clipplayer in the `c` drawer,
// a lane instrument auto-wired by the wcol reconciler, and the pinned master
// chain (MIXMSTRS → audio out).
//
// The transport CONTRACT it pins (per timelorde's design — `running` defaults
// to 1, so a fresh rack FREE-RUNS):
//   (1) a clip-cell click LAUNCHES the lane on the default-running transport:
//       `playing[0]` flips, the lane's step counter ADVANCES, and the REAL
//       chain (clip pitch/gate → tidyVco → mixmstrs ch1 → master) is AUDIBLE;
//   (2) the drawer card's ■ STOPS the rack TIMELORDE: `params.running` → 0
//       and the step counter FREEZES (playback genuinely halts — not just a
//       flag flip);
//   (3) the same control STARTS it again: `running` → 1, steps advance again,
//       and the master is audible again;
//   (4) the wcol reconcile budget NEVER trips during this ordinary flow (the
//       janitor stays quiet — a tripped budget here means a diverging heal).
//
// Any break in the click→running plumbing, the timelorde scheduler, the clip
// engine's transport lock, the lane note wiring, or the master chain turns
// this red in the exact mode that broke.

import { test, expect, type Page } from '@playwright/test';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const PINNED_CLIP = 'pinned-clipplayer';
const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_TL = 'pinned-timelorde';

async function bootWorkflow(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        __spawnFromPalette?: unknown;
        __assignNodeToChannel?: unknown;
      };
      return (
        typeof w.__spawnFromPalette === 'function' &&
        typeof w.__assignNodeToChannel === 'function' &&
        !!w.__patch &&
        ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-timelorde'].every(
          (id) => w.__patch!.nodes[id]?.data?.pinned === true,
        )
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Spawn a module and make it a channel-1 member through the REAL assign path
 *  (the same commitAssignToChannel seam the module menu drives). */
async function addLaneInstrument(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const w = globalThis as unknown as {
      __spawnFromPalette: (t: string) => void;
      __assignNodeToChannel: (id: string, ch: number) => void;
      __patch: { nodes: Record<string, unknown> };
    };
    const before = new Set(Object.keys(w.__patch.nodes));
    w.__spawnFromPalette(t);
    const added = Object.keys(w.__patch.nodes).find((id) => !before.has(id));
    if (!added) throw new Error(`spawn of ${t} added no node`);
    w.__assignNodeToChannel(added, 0); // 0-based → channel 1
    return added;
  }, type);
}

/** Seed a 4-note clip in lane 0 / slot 0 (flat key '0') — the same record shape
 *  the card/grid write. Playback itself is then driven via the REAL pad click. */
async function seedClip(page: Page): Promise<void> {
  await page.evaluate((cpId) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[cpId]!;
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': {
          kind: 'note', lengthSteps: 4, root: 48, loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
    });
  }, PINNED_CLIP);
}

/** Wire a scope onto the pinned master L so audibility is measurable. */
async function tapMaster(page: Page): Promise<void> {
  await page.evaluate((mixId) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p0-scope'] = {
        id: 'p0-scope', type: 'scope', domain: 'audio',
        position: { x: 2400, y: 900 }, params: { timeMs: 200 }, data: {},
      } as never;
      w.__patch.edges['p0-e-master-scope'] = {
        id: 'p0-e-master-scope',
        source: { nodeId: mixId, portId: 'masterL' },
        target: { nodeId: 'p0-scope', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio',
      } as never;
    });
  }, PINNED_MIXER);
}

async function timelordeRunning(page: Page): Promise<number | undefined> {
  return page.evaluate(
    (tid) =>
      (globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> } })
        .__patch.nodes[tid]?.params?.running,
    PINNED_TL,
  );
}

async function lane0Playing(page: Page): Promise<unknown> {
  return page.evaluate(
    (cpId) =>
      (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { playing?: unknown[] } } | undefined> } })
        .__patch.nodes[cpId]?.data?.playing?.[0] ?? null,
    PINNED_CLIP,
  );
}

/** The engine-side lane-0 step counter (what the moving playhead shows). */
async function lane0Step(page: Page): Promise<number | null> {
  return page.evaluate((cpId) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const e = typeof w.__engine === 'function' ? w.__engine() : null;
    const cp = w.__patch.nodes[cpId];
    if (!e || !cp) return null;
    const v = e.read(cp, 'currentStep:0');
    return typeof v === 'number' ? v : null;
  }, PINNED_CLIP);
}

/** Count distinct step values seen over `windowMs` (≥2 ⇒ the clock advances). */
async function distinctSteps(page: Page, windowMs: number): Promise<number> {
  const seen = new Set<number>();
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const s = await lane0Step(page);
    if (s !== null && s >= 0) seen.add(s);
    if (seen.size >= 2) break;
    await page.waitForTimeout(50);
  }
  return seen.size;
}

/** The wcol edges as src.port->dst.port strings. */
async function wcolEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        edges: Record<
          string,
          { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
        >;
      };
    };
    return Object.entries(w.__patch.edges)
      .filter(([id, e]) => e && id.startsWith('wcol-e-'))
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  });
}

for (const [label, url] of [
  ['preview-off', '/rack?mode=workflow'],
  ['shell', '/rack?mode=workflow&shell=1'],
] as const) {
  test(`master transport drives audible clip playback through the real lane chain (${label})`, async ({ page }) => {
    const budgetWarns: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('reconcile budget tripped')) budgetWarns.push(m.text());
    });

    await bootWorkflow(page, url);

    // Lane-1 instrument through the REAL assign path → the reconciler wires
    // the clip's notes in AND the audio chain out to the pinned mixer.
    const vco = await addLaneInstrument(page, 'tidyVco');
    await expect
      .poll(async () => await wcolEdges(page), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          `${PINNED_CLIP}.pitch1->${vco}.poly`,
          `${vco}.out_l->${PINNED_MIXER}.ch1L`,
        ]),
      );

    await seedClip(page);
    await tapMaster(page);

    // Open the `c` drawer → the pinned clipplayer card (the owner's surface).
    await page.keyboard.press('c');
    const dockCard = page.locator(`[data-dock-card="${PINNED_CLIP}"]`);
    await expect(dockCard).toBeVisible({ timeout: 10_000 });
    const pad = dockCard.locator('[data-clip="0"]');
    await expect(pad).toBeVisible({ timeout: 10_000 });
    // Let the drawer's slide-in settle: a click mid-animation can land on the
    // neighbouring pad row (verified live — the pad geometry moves under the
    // pointer while the drawer opens).
    await expect
      .poll(async () => JSON.stringify(await pad.boundingBox()), { timeout: 5_000 })
      .toBe(JSON.stringify(await pad.boundingBox()));

    // (1) LAUNCH on the default-running transport: the cell click starts the
    // lane (single-click path, 220ms debounce inside the card)…
    await pad.click();
    await expect.poll(() => lane0Playing(page), { timeout: 8_000 }).toBe(0);
    // …the engine is up and the drawer transport mirror agrees (■ = running)…
    await expect(dockCard.getByTestId(`clipplayer-transport-${PINNED_CLIP}`)).toHaveText('■', { timeout: 10_000 });
    // …the step counter genuinely advances…
    expect(await distinctSteps(page, 4_000), 'launch: steps advance').toBeGreaterThanOrEqual(2);
    // …and the REAL chain is audible at the pinned master.
    const runRms = await readScopePeakOverWindow(page, 'p0-scope', 2_500);
    expect(runRms.polls, 'scope polled').toBeGreaterThan(0);
    expect(runRms.rms, 'audible RMS at the master while running').toBeGreaterThan(0.02);

    // (2) STOP from the drawer card: running flips AND playback halts.
    const transport = dockCard.getByTestId(`clipplayer-transport-${PINNED_CLIP}`);
    await transport.click();
    await expect.poll(() => timelordeRunning(page), { timeout: 5_000 }).toBe(0);
    await expect(transport).toHaveText('▶', { timeout: 5_000 });
    await page.waitForTimeout(400); // drain scheduled steps (lookahead)
    const s1 = await lane0Step(page);
    await page.waitForTimeout(700);
    const s2 = await lane0Step(page);
    expect(s2, 'stop: the step counter freezes').toBe(s1);

    // (3) START again from the same control: running flips back, steps move,
    // the master is audible again.
    await transport.click();
    await expect.poll(() => timelordeRunning(page), { timeout: 5_000 }).toBe(1);
    await expect(transport).toHaveText('■', { timeout: 5_000 });
    expect(await distinctSteps(page, 4_000), 'restart: steps advance').toBeGreaterThanOrEqual(2);
    const restartRms = await readScopePeakOverWindow(page, 'p0-scope', 2_500);
    expect(restartRms.rms, 'audible RMS after restart').toBeGreaterThan(0.02);

    // (4) The wcol reconcile budget never trips during this ordinary flow.
    expect(budgetWarns).toEqual([]);
  });
}
