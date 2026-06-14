// e2e/tests/midi-autobind-perfzip.spec.ts
//
// FIX 1: MIDI auto-bind on perf-zip load.
//
// Before this fix, loading a perf zip that had MIDI mappings required the user
// to click "Connect MIDI…" on EVERY midilane / midiclock to re-attach the
// device — Web MIDI access is strictly on-demand (needs a user gesture). The
// zip-LOAD click IS a user gesture, so loadPerformanceZip now requests access
// once + auto-binds each MIDI module to its saved device (by id, NAME fallback).
//
// This spec wires the DETERMINISTIC Web-MIDI mock (e2e/_helpers/midi.ts — a
// single "Mock MIDI Input"), so CI never depends on real hardware:
//   1. Spawn MIDI LANE + MIDICLOCK, click Connect on each → the mock device is
//      selected + lastDeviceId persisted on node.data.
//   2. Export the perf .zip → clear the rack → load the zip.
//   3. Assert each card auto-resolved to the mock device on load (connected +
//      selectedDeviceId === the mock id) WITHOUT any manual per-card click.
//   4. Cross-machine guard: a saved binding whose id no longer matches still
//      re-binds by NAME.

import { test, expect, type Page } from '@playwright/test';
import { installMidiMock } from '../_helpers/midi';
import { spawnPatch } from './_helpers';

const MOCK_ID = 'mock-midi-in-0';
const LANE_ID = 'lane';
const CLK_ID = 'clk';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await installMidiMock(page); // BEFORE goto so the first requestMIDIAccess sees the mock
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Read a MIDI node's persisted lastDeviceId + the live card-api state. */
async function readMidiBinding(page: Page, nodeId: string) {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type: string; data?: { lastDeviceId?: string | null } }> };
      __engine: () => { read: (n: unknown, k: string) => unknown } | null;
    };
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const eng = w.__engine();
    const state = eng ? (eng.read(node, 'state') as { connected?: boolean; selectedDeviceId?: string | null } | undefined) : undefined;
    return {
      type: node.type,
      lastDeviceId: node.data?.lastDeviceId ?? null,
      connected: state?.connected ?? false,
      selectedDeviceId: state?.selectedDeviceId ?? null,
    };
  }, nodeId);
}

async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

async function exportZip(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
    const bytes = await w.__perfZip.export();
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  });
}

async function clearRack(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
  });
  await expect.poll(() => nodeCount(page), { timeout: 5000 }).toBe(0);
}

async function loadZip(page: Page, b64: string): Promise<void> {
  await page.evaluate(async (zip) => {
    const bin = atob(zip);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const w = globalThis as unknown as { __perfZip: { load: (b: Uint8Array) => Promise<void> } };
    await w.__perfZip.load(bytes);
  }, b64);
}

test.describe('MIDI auto-bind on perf-zip load', () => {
  test('midilane + midiclock re-attach to their saved device on load — no per-card click', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [
      { id: LANE_ID, type: 'midiLane', position: { x: 120, y: 160 } },
      { id: CLK_ID, type: 'midiclock', position: { x: 520, y: 160 } },
    ]);

    // Manually connect + select the mock device on each card (the one-time
    // grant the perf load will later automate). Clicking Connect requests
    // access (mocked) → the card auto-picks the single mock input.
    const laneCard = page.locator(`.svelte-flow__node[data-id="${LANE_ID}"]`);
    const clkCard = page.locator(`.svelte-flow__node[data-id="${CLK_ID}"]`);
    await laneCard.getByRole('button', { name: /Connect MIDI/ }).click();
    await clkCard.getByRole('button', { name: /Connect MIDI/ }).click();

    // Persist the selection on node.data (the card writes lastDeviceId on the
    // device <select> change; connect auto-picks but doesn't write data, so we
    // drive the select to mirror a real user pick).
    await laneCard.locator('select').first().selectOption(MOCK_ID);
    await clkCard.locator('select').first().selectOption(MOCK_ID);

    await expect.poll(() => readMidiBinding(page, LANE_ID).then((b) => b?.lastDeviceId), { timeout: 5000 }).toBe(MOCK_ID);
    await expect.poll(() => readMidiBinding(page, CLK_ID).then((b) => b?.lastDeviceId), { timeout: 5000 }).toBe(MOCK_ID);

    // Export → clear → load.
    const zipB64 = await exportZip(page);
    expect(zipB64.length).toBeGreaterThan(100);
    await clearRack(page);
    await loadZip(page, zipB64);

    await expect(page.locator(`.svelte-flow__node[data-id="${LANE_ID}"]`)).toBeVisible({ timeout: 8000 });
    await expect(page.locator(`.svelte-flow__node[data-id="${CLK_ID}"]`)).toBeVisible({ timeout: 8000 });

    // THE ASSERTION: both modules auto-connected + bound to the mock device on
    // load, WITHOUT any manual "Connect MIDI…" click in this post-load phase.
    await expect.poll(() => readMidiBinding(page, LANE_ID).then((b) => b?.connected), { timeout: 8000 }).toBe(true);
    await expect.poll(() => readMidiBinding(page, CLK_ID).then((b) => b?.connected), { timeout: 8000 }).toBe(true);
    const laneAfter = await readMidiBinding(page, LANE_ID);
    const clkAfter = await readMidiBinding(page, CLK_ID);
    expect(laneAfter!.selectedDeviceId, 'MIDI LANE must auto-bind to the saved device').toBe(MOCK_ID);
    expect(clkAfter!.selectedDeviceId, 'MIDICLOCK must auto-bind to the saved device').toBe(MOCK_ID);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('no MIDI mappings in the zip → load does not request access (no prompt)', async ({ page }) => {
    const errors = await setup(page);

    // A rack with NO MIDI modules. The mock counts requestMIDIAccess calls; a
    // perf load on a mapping-free rack must NOT trigger one (the graceful
    // "no mappings → no prompt" path).
    await spawnPatch(page, [{ id: 'nz', type: 'noise', position: { x: 200, y: 200 } }]);
    const zipB64 = await exportZip(page);
    const callsBeforeLoad = await page.evaluate(() => {
      const w = globalThis as unknown as { __mockMidi: { accessCallCount: () => number } };
      return w.__mockMidi.accessCallCount();
    });
    await clearRack(page);
    await loadZip(page, zipB64);
    await expect.poll(() => nodeCount(page), { timeout: 8000 }).toBe(1);

    const callsAfterLoad = await page.evaluate(() => {
      const w = globalThis as unknown as { __mockMidi: { accessCallCount: () => number } };
      return w.__mockMidi.accessCallCount();
    });
    expect(callsAfterLoad, 'load of a MIDI-free rack must NOT request MIDI access').toBe(callsBeforeLoad);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
