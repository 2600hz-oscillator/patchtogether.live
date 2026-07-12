// e2e/tests/workflow-surfaces.spec.ts
//
// WORKFLOW MODE P2 — the topbar surface trio on /rack?mode=workflow:
//
//   🕐 clock — TIMELORDE's face: live BPM readout, the REAL tempo knob,
//      TAP tempo (shared TapTempo core), and click-driven patch-out rows
//      that hand off to the existing patch-menu drill-down picker.
//   ⚇ MIDI DIN — assign a MIDI input as TIMELORDE's clock source by wiring
//      the hidden pinned MIDICLOCK bridge (clock→clock, midistart→start_in,
//      midistop→stop_in); assigning flips the clock surface into the
//      externally-clocked state (tap disabled); unassign restores it.
//   (The 🎧 audio-I/O surface needs the fake-mic browser flags, so its e2e
//   lives in audio-in.spec.ts under the chromium-audio-in project.)
//
// Driving /rack?mode=workflow keeps this in the NORMAL e2e lane (no
// DB/relay) — same rationale as workflow-mode.spec.ts. Web MIDI is faked
// via addInitScript (a deterministic single-input access object): CI
// runners have no MIDI hardware, and the bridge's device handling starts
// at navigator.requestMIDIAccess, which is exactly the seam we stub.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** All always-on pinned ids a workflow rack must hold after the ensure
 *  (P1 trio + P2 surfaces — graph/workflow-pins.ts). */
const PINNED_IDS = [
  'pinned-mixmstrs',
  'pinned-electraControl',
  'pinned-clipplayer',
  'pinned-timelorde',
  'pinned-midiclock',
  'pinned-audioIn',
  'pinned-audioOut',
] as const;

/** The four P2 surface pins (never canvas cards). */
const SURFACE_IDS = PINNED_IDS.slice(3);

async function waitForPins(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    PINNED_IDS as unknown as string[],
    { timeout: 10_000 },
  );
}

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

async function readBpm(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params?: { bpm?: number } } | undefined> };
    };
    return w.__patch.nodes['pinned-timelorde']?.params?.bpm;
  });
}

async function setBpm(page: Page, bpm: number): Promise<void> {
  await page.evaluate((v) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['pinned-timelorde']!.params.bpm = v;
    });
  }, bpm);
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow');
  await page.waitForLoadState('networkidle');
  await waitForPins(page);
}

/** Stub Web MIDI with ONE deterministic input device. Must run before any
 *  page script (addInitScript) so webMidiAvailable() sees it. */
async function installFakeMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const input = {
      id: 'fake-din-1',
      name: 'FAKE CLOCK DECK',
      state: 'connected',
      onmidimessage: null as unknown,
    };
    const access = {
      inputs: new Map([[input.id, input]]),
      onstatechange: null as unknown,
    };
    (navigator as unknown as { requestMIDIAccess: unknown }).requestMIDIAccess = () =>
      Promise.resolve(access);
    (globalThis as unknown as { __fakeMidi: unknown }).__fakeMidi = { access, input };
  });
}

test.describe('workflow clock surface (🕐 TIMELORDE face)', () => {
  test('surface pins exist off-canvas; the menu shows the live BPM readout', async ({ page }) => {
    await gotoWorkflow(page);

    // The P2 surface pins live in the graph but NEVER as MAIN-CANVAS cards
    // (`.flow` is the main rack flow — the audio-I/O menu legitimately
    // hosts the pinned AUDIO IN/OUT faces in its own standalone flow).
    for (const id of SURFACE_IDS) {
      await expect(page.locator(`.flow .svelte-flow__node[data-id="${id}"]`)).toHaveCount(0);
    }

    await page.getByTestId('workflow-topbar-slot-clock').click();
    const menu = page.getByTestId('workflow-clock-menu');
    await expect(menu).toBeVisible();

    const readout = page.getByTestId('workflow-clock-bpm');
    await expect(readout).toContainText('120');
    await expect(readout).toHaveAttribute('data-clock-source', 'internal');
    await expect(page.getByTestId('workflow-clock-tap')).toBeEnabled();

    // The readout is LIVE: a remote/param write reflects without reopening.
    await setBpm(page, 87);
    await expect(readout).toContainText('87');
  });

  test('the tempo knob is the real Knob and turning it writes bpm', async ({ page }) => {
    await gotoWorkflow(page);
    await page.getByTestId('workflow-topbar-slot-clock').click();

    const knob = page
      .getByTestId('workflow-clock-knob')
      .locator('[data-testid="control-bpm"]');
    await expect(knob).toBeVisible();

    const box = await knob.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Vertical drag UP = increase (the shared Knob convention).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => (await readBpm(page)) ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(120);
  });

  test('tap tempo: a single tap is inert; two taps lock the tapped tempo', async ({ page }) => {
    await gotoWorkflow(page);
    await setBpm(page, 60);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    const tap = page.getByTestId('workflow-clock-tap');
    await expect(tap).toBeEnabled();

    // 2-tap minimum: the first tap alone must not move the tempo.
    await tap.click();
    await page.waitForTimeout(250);
    expect(await readBpm(page)).toBe(60);

    // Let the solo tap age past the ~2 s reset window so the timed pair
    // below is a FRESH sequence (otherwise the solo tap joins the median).
    await page.waitForTimeout(2_100);

    // Fire both taps IN-PAGE and measure the actual interval with
    // performance.now() — CI load can stretch any nominal wait, so the
    // assertion compares against the MEASURED interval instead of a fixed
    // band. The exact interval→BPM math is pinned by the tap-tempo unit
    // suite; this proves the button feeds it and the result lands on the
    // real `bpm` param.
    const measured = await page.evaluate(
      () =>
        new Promise<{ intervalMs: number }>((resolve) => {
          const btn = document.querySelector(
            '[data-testid="workflow-clock-tap"]',
          ) as HTMLButtonElement;
          const t0 = performance.now();
          btn.click();
          setTimeout(() => {
            const t1 = performance.now();
            btn.click();
            resolve({ intervalMs: t1 - t0 });
          }, 300);
        }),
    );
    const expected = 60000 / measured.intervalMs;
    await expect
      .poll(async () => (await readBpm(page)) ?? 0, { timeout: 5_000 })
      .not.toBe(60);
    const bpm = (await readBpm(page))!;
    expect(Math.abs(bpm - expected)).toBeLessThan(5);
  });

  test('patch-out row opens the drill-down picker and wires 1x → ADSR gate', async ({ page }) => {
    await gotoWorkflow(page);
    // A canvas target with a gate input. spawnPatch wipes the graph; the
    // ensure effect re-spawns the pins, so re-wait before driving menus.
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 420, y: 220 } }]);
    await waitForPins(page);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    await page.getByTestId('workflow-clock-patchout-1x').click();

    // The EXISTING drill-down picker opens (the same PortContextMenu every
    // card jack uses); the clock menu itself closed on hand-off.
    const picker = page.locator('[data-testid="port-context-menu"]');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('workflow-clock-menu')).toHaveCount(0);

    await picker.locator('[data-testid="patch-to-module"][data-node-id="env"]').click();
    const gateRow = picker.locator('[data-testid="patch-to-port"][data-port-id="gate"]');
    await expect(gateRow).toBeVisible();
    await gateRow.click();

    await expect
      .poll(async () => {
        const edges = await readEdges(page);
        return edges.some(
          (e) =>
            e.source.nodeId === 'pinned-timelorde' &&
            e.source.portId === '1x' &&
            e.target.nodeId === 'env' &&
            e.target.portId === 'gate',
        );
      }, { timeout: 5_000 })
      .toBe(true);
  });
});

test.describe('workflow MIDI DIN surface (⚇ clock source)', () => {
  /** The three bridge edges a DIN assignment writes. */
  function bridgeEdges(edges: PatchEdge[]): PatchEdge[] {
    return edges.filter(
      (e) => e.source.nodeId === 'pinned-midiclock' && e.target.nodeId === 'pinned-timelorde',
    );
  }

  test('assign wires the midiclock bridge, disables tap, and unassign round-trips', async ({ page }) => {
    await installFakeMidi(page);
    await gotoWorkflow(page);

    // The bridge's MidiclockApi lives on the ENGINE-side module — boot the
    // engine the same way every audio e2e does.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
      await w.__ensureEngine();
    });

    // Connect → the faked access lists exactly our device.
    await page.getByTestId('workflow-topbar-slot-midi-din').click();
    const menu = page.getByTestId('workflow-din-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('workflow-din-connect').click();

    const device = menu.locator('[data-testid="workflow-din-device"][data-deviceid="fake-din-1"]');
    await expect(device).toBeVisible();
    await expect(device).toContainText('FAKE CLOCK DECK');

    // Assign → the three bridge cables land in ONE transact.
    await device.click();
    await expect
      .poll(async () => bridgeEdges(await readEdges(page)).length, { timeout: 5_000 })
      .toBe(3);
    const pairs = bridgeEdges(await readEdges(page))
      .map((e) => `${e.source.portId}→${e.target.portId}`)
      .sort();
    expect(pairs).toEqual(['clock→clock', 'midistart→start_in', 'midistop→stop_in']);

    // The menu now shows the assigned source with an unassign ✕.
    const assigned = page.getByTestId('workflow-din-assigned');
    await expect(assigned).toBeVisible();
    await expect(assigned).toContainText('FAKE CLOCK DECK');

    // The clock surface flipped to the externally-clocked state: tap is
    // DISABLED (with the explanatory tooltip) and the readout says external.
    await page.getByTestId('workflow-topbar-slot-clock').click();
    const tap = page.getByTestId('workflow-clock-tap');
    await expect(tap).toBeDisabled();
    await expect(tap).toHaveAttribute('title', /external clock/i);
    await expect(page.getByTestId('workflow-clock-bpm')).toHaveAttribute(
      'data-clock-source',
      'external',
    );

    // Unassign → cables gone, tap re-enabled, source back to internal.
    await page.getByTestId('workflow-topbar-slot-midi-din').click();
    await page.getByTestId('workflow-din-unassign').click();
    await expect
      .poll(async () => bridgeEdges(await readEdges(page)).length, { timeout: 5_000 })
      .toBe(0);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    await expect(page.getByTestId('workflow-clock-tap')).toBeEnabled();
    await expect(page.getByTestId('workflow-clock-bpm')).toHaveAttribute(
      'data-clock-source',
      'internal',
    );
  });
});
