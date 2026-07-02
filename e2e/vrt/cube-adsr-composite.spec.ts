// e2e/vrt/cube-adsr-composite.spec.ts
//
// Composite-state VRT for the per-voice ADSR feature: CUBE driven by a MIDI LANE
// poly chord, with the AMP ADSR dialed to an audible shape. Proves the whole
// patch (MIDI LANE poly → CUBE.poly → per-voice envelopes) renders, exercising
// the new ADSR controls + TRIG-family poly path on a real card screenshot.
//
// Patch:  midiLane (mode=poly, held C-major triad via mock MIDI)
//             → poly → cube → L/R
//
// Same recipe as pentemelodica-composite.spec.ts: mock requestMIDIAccess,
// connect the lane in poly mode, send three held note-ons (no note-offs → a
// held chord), dial CUBE's ADSR, settle the card layout, freeze the
// AudioContext, then screenshot.
//
// Informational lane (`task vrt`, FULL_MATCH). Darwin baseline captured locally;
// linux pending a `vrt-update.yml` workflow_dispatch (gated below).
//
// Output: e2e/vrt/__screenshots__/cube-adsr-composite.spec.ts/{platform}/cube-adsr-midilane.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

test.describe('VRT: CUBE per-voice-ADSR composite', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the Web MIDI API so MIDI LANE can connect + receive a held chord.
    await page.addInitScript(() => {
      const handlers: Array<(ev: { data: Uint8Array; timeStamp: number }) => void> = [];
      const input = {
        id: 'fake-midi-input-0',
        name: 'Synthetic MIDI (Playwright)',
        state: 'connected',
        set onmidimessage(fn: ((ev: { data: Uint8Array; timeStamp: number }) => void) | null) {
          handlers.length = 0;
          if (fn) handlers.push(fn);
        },
        get onmidimessage() { return handlers[0] ?? null; },
      };
      const access = {
        inputs: new Map([[input.id, input]]),
        outputs: new Map(),
        onstatechange: null as (() => void) | null,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator as any).requestMIDIAccess = async () => access;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__fakeMidiSend = (bytes: number[]) => {
        const ev = { data: new Uint8Array(bytes), timeStamp: performance.now() };
        for (const h of handlers) h(ev);
      };
    });
  });

  test('cube-adsr-midilane matches baseline', async ({ page }) => {
    test.skip(VRT_PLATFORM === 'linux', 'darwin baseline only; linux pending a vrt-update on CI');

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'lane', type: 'midiLane', position: { x: 30, y: 60 }, domain: 'audio' },
        // Dial an audible AMP ADSR shape (slow attack, partial sustain, screen off
        // so the WebGL viz placeholder doesn't dominate the screenshot).
        { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.8, decay: 0.5, sustain: 0.6, release: 1.2, screen_on: 0 } },
      ],
      [
        { id: 'e_lane_cb', from: { nodeId: 'lane', portId: 'poly' }, to: { nodeId: 'cb', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      ],
    );

    // Put MIDI LANE in poly mode + connect, then send a held C-major triad.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['lane'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.mode = 'poly';
      });
    });
    await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        __fakeMidiSend?: (bytes: number[]) => void;
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes['lane'];
      if (!eng || !node) return;
      const api = eng.read(node, 'card-api') as
        | { connect: () => Promise<boolean>; setMode?: (m: string) => void }
        | undefined;
      if (api) {
        await api.connect();
        api.setMode?.('poly');
      }
      const send = w.__fakeMidiSend;
      if (!send) return;
      // Held C-major triad (no note-offs): C4, E4, G4 on channel 1, vel 100.
      send([0x90, 60, 100]);
      send([0x90, 64, 100]);
      send([0x90, 67, 100]);
    });

    const laneCard = page.locator('.svelte-flow__node-midiLane').first();
    const cbCard = page.locator('.svelte-flow__node-cube').first();
    await laneCard.waitFor({ state: 'visible', timeout: 10_000 });
    await cbCard.waitFor({ state: 'visible', timeout: 10_000 });

    // Let the chord land + the voices ring up the slow attack.
    await page.waitForTimeout(600);

    // Height-stability settle (text-row raster determinism — see vrt.spec.ts).
    for (const card of [laneCard, cbCard]) {
      await card.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            let lastH = -1;
            let stable = 0;
            const tick = () => {
              const h = Math.round(el.getBoundingClientRect().height);
              if (h === lastH) {
                if (++stable >= 3) return resolve();
              } else {
                stable = 0;
                lastH = h;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    }

    // Freeze the AudioContext so any analyser-driven UI holds steady.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    await expect(page).toHaveScreenshot('cube-adsr-midilane.png', {
      maskColor: '#ff00ff',
      fullPage: false,
    });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
