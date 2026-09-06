// e2e/tests/vst-lane-autowire.spec.ts
//
// THE OWNER'S SENTENCE, end to end: "i can drop a card connected to an
// instrument vst in a lane, drop another card wired to a DSP vst in the
// lane, and all that stuff wires up and works the same way our internal
// instruments do."
//
// Drives the REAL palette-drop pipeline (__setSpawnFlowPos +
// __spawnFromPalette → wcolDropTarget → membership/order → reconciler), the
// workflow-channel-columns pattern, with the vst-bridge helper MOCKED at the
// WebSocket seam (../_helpers/mock-vst-bridge — real protocol, fake plugin):
//
//   1. vstInstrument dropped in channel 1 auto-wires EXACTLY like tidyVco:
//      clip pitch1 → poly, gate1 → gate, vel1 → vel, out_l/out_r → mixer ch1.
//   2. vstFx dropped below it inserts into the chain: instrument → fx → mixer.
//   3. With the mock's sine instrument mounted and the pinned clip player
//      running, channel 1 registers AUDIBLE RMS at the mixer meter AND at
//      the pinned AUDIO OUT — clip → VST card → fx card → mixer → out, the
//      same chain internal instruments ride.

import { test, expect, type Page } from '@playwright/test';
import { installRenderSmokeHooks } from './_render-smoke';
import { startMockVstBridge, type MockVstBridge } from '../_helpers/mock-vst-bridge';
import { BOOT_MS } from '../_helpers/boot-budget';

/** channel-columns.ts geometry (workflow-channel-columns.spec.ts values). */
const COLUMN_W = 765;
const COLUMN_BASELINE_Y = 4320;
const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_CLIP = 'pinned-clipplayer';

function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: COLUMN_BASELINE_Y - 40 };
}

async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return !!w.__patch && ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-audioOut'].every(
        (id) => w.__patch!.nodes[id]?.data?.pinned === true,
      );
    },
    undefined,
    { timeout: BOOT_MS },
  );
}

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown };
      return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function';
    },
    undefined,
    { timeout: BOOT_MS },
  );
}

async function dropInBand(page: Page, type: string, pos: { x: number; y: number }): Promise<void> {
  await waitForHooks(page);
  await page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
    },
    { type, pos },
  );
}

async function orderOf(page: Page, kind: 'columns' | 'sends', key: number): Promise<string[]> {
  return page.evaluate(
    ({ kind, key }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, Record<string, string[]>> } | undefined> };
      };
      return w.__patch.nodes['pinned-mixmstrs']?.data?.[kind]?.[String(key)] ?? [];
    },
    { kind, key },
  );
}

async function wcolEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined> };
    };
    return Object.entries(w.__patch.edges)
      .filter(([id, e]) => e && id.startsWith('wcol-e-'))
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  });
}

async function laneOf(page: Page, moduleId: string): Promise<number | null> {
  return page.evaluate((mid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { autoAssign?: Record<string, number> } } | undefined> };
    };
    const a = w.__patch.nodes['pinned-clipplayer']?.data?.autoAssign;
    return a && mid in a ? a[mid]! : null;
  }, moduleId);
}

/** Seed a looping dense clip on lane 0 and run every TIMELORDE — verbatim
 *  from workflow-channel-columns.spec.ts seedAndRun. */
async function seedAndRun(page: Page, lanes: number[]): Promise<void> {
  await page.evaluate((lanes) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { type?: string; params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
    };
    w.__ydoc.transact(() => {
      const cp = w.__patch.nodes['pinned-clipplayer']!;
      if (!cp.data) cp.data = {};
      const d = cp.data as { clips?: Record<string, unknown>; queued?: (number | 'stop' | null)[]; queuedImmediate?: boolean[] };
      if (!d.clips) d.clips = {};
      const steps = [0, 4, 8, 12].map((step) => ({ step, midi: 60 }));
      for (const lane of lanes) {
        d.clips[String(lane * 64)] = { kind: 'note', steps, lengthSteps: 16, root: 48, loop: true };
      }
      const queued = new Array(8).fill(null) as (number | 'stop' | null)[];
      const imm = new Array(8).fill(false) as boolean[];
      for (const lane of lanes) { queued[lane] = 0; imm[lane] = true; }
      d.queued = queued;
      d.queuedImmediate = imm;
      for (const n of Object.values(w.__patch.nodes)) {
        if (n?.type === 'timelorde') { n.params.running = 1; n.params.bpm = 120; }
      }
    });
  }, lanes);
}

/** In-page accumulator for mixer meter + audio-out RMS (never a Playwright-
 *  side poll loop) — verbatim from workflow-channel-columns.spec.ts. */
async function pollAudio(
  page: Page,
  durationMs: number,
): Promise<{ channelMax: number[]; outMax: number; samples: number; elapsedMs: number }> {
  return await page.evaluate(
    ({ durationMs }) =>
      new Promise<{ channelMax: number[]; outMax: number; samples: number; elapsedMs: number }>(
        (resolve) => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
            __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
          };
          const channelMax = new Array(8).fill(0);
          let outMax = 0;
          let samples = 0;
          const startedAt = performance.now();
          const timer = setInterval(() => {
            const eng = w.__engine?.();
            const mixer = w.__patch.nodes['pinned-mixmstrs'];
            const out = w.__patch.nodes['pinned-audioOut'];
            const levels = eng && mixer ? (eng.read(mixer, 'levels') as number[] | undefined) : undefined;
            if (levels) {
              for (let i = 0; i < levels.length && i < 8; i++) {
                channelMax[i] = Math.max(channelMax[i], levels[i] ?? 0);
              }
            }
            if (eng && out) {
              const snap = eng.read(out, 'outputSnapshot') as { samples: Float32Array } | undefined;
              if (snap?.samples?.length) {
                let s = 0;
                for (let i = 0; i < snap.samples.length; i++) s += snap.samples[i]! * snap.samples[i]!;
                outMax = Math.max(outMax, Math.sqrt(s / snap.samples.length));
              }
            }
            samples++;
            const elapsedMs = performance.now() - startedAt;
            if (elapsedMs >= durationMs) {
              clearInterval(timer);
              resolve({ channelMax, outMax, samples, elapsedMs });
            }
          }, 25);
        },
      ),
    { durationMs },
  );
}

test.describe.configure({ mode: 'serial', timeout: 150_000 });

let mock: MockVstBridge;

test.beforeAll(async () => {
  mock = await startMockVstBridge();
});
test.afterAll(async () => {
  await mock?.close();
});

test.beforeEach(async ({ page }) => {
  // Idle the video-engine rAF loop (this spec asserts wiring + AUDIO RMS,
  // never pixels) and point the vst cards at the mock helper before boot.
  await installRenderSmokeHooks(page);
  await page.addInitScript((url) => {
    (globalThis as unknown as { __vstBridgeUrlOverride?: string }).__vstBridgeUrlOverride = url;
  }, mock.url);
});

test('lane drop wires vstInstrument like an internal instrument, inserts vstFx, and the clip drives audible RMS through both', async ({ page }) => {
  await page.goto('/rack');
  await waitForPinnedTrio(page);

  // 1. Drop the instrument card into channel 1 — the tidyVco wiring shape.
  await dropInBand(page, 'vstInstrument', colPos(1));
  await expect.poll(async () => (await orderOf(page, 'columns', 1)).length, { timeout: 10_000 }).toBe(1);
  const inst = (await orderOf(page, 'columns', 1))[0]!;
  expect(await laneOf(page, inst), 'clip automation lane auto-assigned').toBe(0);

  await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
  let edges = await wcolEdges(page);
  // The owner sentence, wire by wire: clip CV → the VST card as note control…
  expect(edges).toContain(`${PINNED_CLIP}.pitch1->${inst}.poly`);
  expect(edges).toContain(`${PINNED_CLIP}.gate1->${inst}.gate`);
  expect(edges).toContain(`${PINNED_CLIP}.vel1->${inst}.vel`);
  // …and the audio autowired through to the lane's mixer channel.
  expect(edges).toContain(`${inst}.out_l->${PINNED_MIXER}.ch1L`);
  expect(edges).toContain(`${inst}.out_r->${PINNED_MIXER}.ch1R`);

  // 2. Drop the fx card into the SAME lane — it must insert into the chain.
  await dropInBand(page, 'vstFx', colPos(1));
  await expect.poll(async () => (await orderOf(page, 'columns', 1)).length, { timeout: 10_000 }).toBe(2);
  const fx = (await orderOf(page, 'columns', 1)).find((id) => id !== inst)!;
  await expect
    .poll(async () => (await wcolEdges(page)).some((e) => e === `${inst}.out_l->${fx}.in_l`), {
      timeout: 10_000,
      message: 'instrument out must re-route into the fx insert',
    })
    .toBe(true);
  edges = await wcolEdges(page);
  expect(edges).toContain(`${inst}.out_l->${fx}.in_l`);
  expect(edges).toContain(`${inst}.out_r->${fx}.in_r`);
  expect(edges).toContain(`${fx}.out_l->${PINNED_MIXER}.ch1L`);
  expect(edges).toContain(`${fx}.out_r->${PINNED_MIXER}.ch1R`);

  // 3. Mount the mock sine instrument on the dropped card (fx card stays
  //    unmounted = bit-transparent echo through the helper), run the clip,
  //    and demand audible RMS at the mixer meter AND the audio out.
  // The picker/lamps are the dock face body (fullViewBody; the card's text
  // rows live in the lamps' aria-label sentences — vst-status-model.ts).
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    inst,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${inst}"]`);
  await expect(pane.getByTestId(`vst-face-body-${inst}`)).toBeVisible({ timeout: 30_000 });
  await expect(pane.getByTestId(`vst-led-bridge-${inst}`)).toHaveAttribute('aria-label', /mock-vst-bridge/, { timeout: 15_000 });
  const picker = pane.getByTestId(`vst-face-picker-${inst}`);
  await picker.scrollIntoViewIfNeeded().catch(() => {});
  await picker.selectOption('mock:sine');
  await pane.getByTestId(`vst-face-mount-${inst}`).click();
  await expect(pane.getByTestId(`vst-led-plugin-${inst}`)).toHaveAttribute('aria-label', /mock sine synth/, { timeout: 10_000 });

  await seedAndRun(page, [0]);
  const audio = await pollAudio(page, 12_000);
  expect(
    audio.channelMax[0],
    `mixer ch1 meter should register the VST voice (samples=${audio.samples}, elapsed=${audio.elapsedMs.toFixed(0)}ms, ch=${audio.channelMax.map((v) => v.toFixed(4)).join(',')})`,
  ).toBeGreaterThan(0.002);
  expect(
    audio.outMax,
    `pinned AUDIO OUT should carry the lane (outMax=${audio.outMax.toFixed(5)}, samples=${audio.samples})`,
  ).toBeGreaterThan(0.005);

  // The notes really crossed the wire as MIDI on this card's session.
  const session = mock.sessionFor(inst);
  expect(session, 'mock saw the dropped card connect with clientId = node id').toBeTruthy();
  expect(session!.midi.length).toBeGreaterThan(0);
});
