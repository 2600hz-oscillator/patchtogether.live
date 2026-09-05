// e2e/vrt/pentemelodica-composite.spec.ts
//
// Composite-state VRT for PENTEMELODICA — the KEY deliverable: a whole-patch
// screenshot of PENTEMELODICA driven by a MIDI LANE poly chord. Proves the
// 5-voice synth plays a held chord routed off MIDI LANE's polyPitchGate bus.
//
// Patch:  midiLane (mode=poly, held C-major triad via mock MIDI)
//             → poly → pentemelodica → out_l/out_r
//
// MIDI LANE's `poly` output only carries signal in mode='poly' with held
// notes; we mock requestMIDIAccess (same shim the midiLane per-port driver
// uses), connect the lane, set mode=poly, then send three note-ons (no
// note-offs → a held chord). We settle the cards' layout (height-stability
// loop, for text-row raster determinism) then freeze the AudioContext so the
// voice waveform previews + meters are pixel-stable across runs.
//
// Informational lane (`task vrt`, FULL_MATCH).
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
//
// Output: e2e/vrt/__screenshots__/pentemelodica-composite.spec.ts/pentemelodica-midilane.png

import { test, expect } from '@playwright/test';
import { spawnPatch, canvasNode } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

test.describe.configure({ mode: 'default' });

test.describe('VRT: PENTEMELODICA composite', () => {
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

  test('pentemelodica-midilane matches baseline', async ({ page }) => {

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and
    // await their decode after load — the app resolves card text through
    // GENERIC stacks (system-ui / ui-monospace) that fontconfig picks
    // nondeterministically, and document.fonts.ready can't see them. Without
    // this the captured text metrics differ run-to-run and platform-to-platform.
    // Full root cause: e2e/vrt/_fonts.ts.
    await pinVrtFonts(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);

    await spawnPatch(
      page,
      [
        { id: 'lane', type: 'midiLane', position: { x: 30, y: 60 }, domain: 'audio' },
        { id: 'pm', type: 'pentemelodica', position: { x: 360, y: 60 }, domain: 'audio' },
      ],
      [
        { id: 'e_lane_pm', from: { nodeId: 'lane', portId: 'poly' }, to: { nodeId: 'pm', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
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

    // ⚠ BY NODE ID, NOT NODE TYPE. xyflow tags a lane node with its NODE TYPE
    // and every lane node is `moduleShell`, so a per-module class matches
    // nothing (the mechanism `e2e/tests/ptzcam.spec.ts` records).
    const laneCard = canvasNode(page, 'lane');
    const pmCard = canvasNode(page, 'pm');
    await laneCard.waitFor({ state: 'visible', timeout: 10_000 });
    await pmCard.waitFor({ state: 'visible', timeout: 10_000 });

    // Let the chord land + the voices ring up.
    await page.waitForTimeout(600);

    // Height-stability settle (text-row raster determinism — see vrt.spec.ts).
    for (const card of [laneCard, pmCard]) {
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

    await expect(page).toHaveScreenshot('pentemelodica-midilane.png', {
      maskColor: '#ff00ff',
      fullPage: false,
    });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
