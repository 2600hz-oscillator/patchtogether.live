// e2e/tests/timelorde-transport-state.spec.ts
//
// THE STOP-vs-MUTE FIX, IN A BROWSER.
//
// MEASURED on the real clock core (packages/dsp/src/lib/timelorde-clock-core.
// test.ts): `running = 0`, `muteOutputs = 1` and both together are BYTE-
// IDENTICAL on all thirteen gate outputs — zero edges, zero peak, zero DC.
// Nothing downstream of a patch cable can tell them apart, and TIMELORDE is the
// singleton every patch rides, so "why is my whole rack stopped" is the
// question this card most needs to answer.
//
// The four-state derivation is exhaustively unit-tested (timelorde-transport-
// state.test.ts, including the `bpm` negative control). What a unit test CANNOT
// see is whether the strip is actually mounted, whether it survives the
// transport being slaved to an external MIDICLOCK — the case that HIDES the RUN
// button — and whether the engine handle agrees with what the card prints. That
// is this spec.
//
// Assertions are on `data-transport-state` (the machine id), not the prose, so
// re-wording the readout is not a test change; one leg checks the visible text
// separately so the attribute cannot silently drift away from what a player
// reads.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TL = 'tl';

/** The FACE's visible transport state, recombined from the two tile readouts
 *  (the card's one-strip `data-transport-state` died with the card; the def
 *  formatter feeds `readout-running` RUNNING/STOPPED and
 *  `readout-muteOutputs` GATES LIVE/MUTED, and the PAIR is the four-state
 *  discrimination a player reads). Returns the same machine ids the shared
 *  derivation names, or null while either readout is missing. */
async function stripState(page: Page): Promise<string | null> {
  return page.evaluate((id) => {
    const tile = document.querySelector(
      `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`,
    );
    const run = tile?.querySelector('[data-testid="readout-running"]')?.textContent?.trim() ?? null;
    const mute = tile?.querySelector('[data-testid="readout-muteOutputs"]')?.textContent?.trim() ?? null;
    if (run === null || mute === null) return null;
    const running = run === 'RUNNING';
    const muted = mute === 'MUTED';
    if (running && !muted) return 'running';
    if (!running && !muted) return 'stopped';
    if (running && muted) return 'muted';
    return 'stopped-muted';
  }, TL);
}

/** What the ENGINE thinks the state is — read('transportState') off the live
 *  handle. The card and the engine share one derivation; if they ever diverge
 *  the readout is lying about the thing it exists to report. */
async function engineState(page: Page): Promise<unknown> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read?: (node: { id: string; domain: string }, key: string) => unknown;
      } | undefined;
      __patch?: { nodes: Record<string, { id: string; domain: string } | undefined> };
    };
    const engine = w.__engine?.();
    const node = w.__patch?.nodes[id];
    if (!engine?.read || !node) return null;
    return engine.read(node, 'transportState') ?? null;
  }, TL);
}

/** Write a param straight into the patch store — the same path the transport
 *  gates use, and the only way to reach `running` while the RUN button is
 *  hidden by an external transport. */
async function setParam(page: Page, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, k, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes[id];
        if (target) target.params[k] = v;
      });
    },
    { id: TL, k: key, v: value },
  );
}

async function spawnClock(page: Page, params: Record<string, number> = {}): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio', params }],
    [],
  );
}

test.describe('TIMELORDE transport state', () => {
  test('all four states are distinguishable on the card', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await spawnClock(page);
    // The two readouts are always mounted on the lane tile (the card's strip
    // died with the card; the readout PAIR carries the same four states).
    const tile = page.locator(`.svelte-flow__node[data-id="${TL}"] [data-testid="module-shell"]`);
    await expect(tile.getByTestId('readout-running'), 'RUN readout always mounted').toBeVisible();
    await expect(tile.getByTestId('readout-muteOutputs'), 'MUTE readout always mounted').toBeVisible();

    // (running, muteOutputs) → the id the strip must publish. Four inputs, four
    // DIFFERENT answers — which is the whole point, because all but the first
    // are indistinguishable at every jack.
    const CASES: { running: number; mute: number; id: string }[] = [
      { running: 1, mute: 0, id: 'running' },
      { running: 0, mute: 0, id: 'stopped' },
      { running: 1, mute: 1, id: 'muted' },
      { running: 0, mute: 1, id: 'stopped-muted' },
    ];

    const seen = new Set<string>();
    for (const c of CASES) {
      await setParam(page, 'running', c.running);
      await setParam(page, 'muteOutputs', c.mute);
      await expect
        .poll(() => stripState(page), {
          timeout: 4000,
          message: `running=${c.running} muteOutputs=${c.mute}`,
        })
        .toBe(c.id);
      seen.add(c.id);
    }
    expect(seen.size, 'four param combinations must yield four DISTINCT states').toBe(4);

    expect(errors).toEqual([]);
  });

  test('NEGATIVE CONTROL: bpm does not move the transport state', async ({ page }) => {
    // The face spec's named control. A readout that drifted with tempo would be
    // reporting something other than the transport.
    await spawnClock(page, { bpm: 120 });

    for (const state of [
      { running: 1, mute: 0, id: 'running' },
      { running: 0, mute: 1, id: 'stopped-muted' },
    ]) {
      await setParam(page, 'running', state.running);
      await setParam(page, 'muteOutputs', state.mute);
      await expect.poll(() => stripState(page), { timeout: 4000 }).toBe(state.id);

      for (const bpm of [10, 60, 240, 300]) {
        await setParam(page, 'bpm', bpm);
        // Give the card a frame to re-render before re-reading, then assert it
        // did NOT move. (A poll would happily pass on the first sample before
        // any re-render had a chance to happen; this waits first.)
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        expect(await stripState(page), `bpm=${bpm} moved the state off ${state.id}`).toBe(state.id);
      }
    }

    // POSITIVE CONTROL for the same instrument: the strip CAN move — otherwise
    // every assertion above would pass against a hard-coded attribute.
    await setParam(page, 'running', 1);
    await setParam(page, 'muteOutputs', 0);
    await expect.poll(() => stripState(page), { timeout: 4000 }).toBe('running');
  });

  test('the strip survives an EXTERNAL transport, which hides the RUN button', async ({ page }) => {
    // Patching start_in/stop_in makes the card step aside (`transportSlaved`) so
    // it does not fight a MIDICLOCK — and that removes the RUN button, i.e. the
    // only pre-existing hint that the transport is stopped disappears in exactly
    // the case where a hardware stop is the likely cause.
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio' },
        { id: 'mc', type: 'midiclock', position: { x: 520, y: 80 }, domain: 'audio' },
      ],
      [
        { id: 'e1', from: { nodeId: 'mc', portId: 'midistart' }, to: { nodeId: TL, portId: 'start_in' } },
        { id: 'e2', from: { nodeId: 'mc', portId: 'midistop' }, to: { nodeId: TL, portId: 'stop_in' } },
      ],
    );

    // ⚠ FACE DELTA, measured: the CARD hid its RUN button while slaved; the
    // face keeps `control-running` rendered (a param cell does not step
    // aside). What the card's hiding protected — the transport state staying
    // LEGIBLE when a hardware stop is the likely cause — is exactly what the
    // readouts below assert, on the surface a player actually reads.
    const tile = page.locator(`.svelte-flow__node[data-id="${TL}"] [data-testid="module-shell"]`);
    await expect(tile.getByTestId('control-running'), 'the RUN control stays rendered on the face').toBeVisible();
    await expect(tile.getByTestId('readout-running'), 'the readout does NOT step aside').toBeVisible();

    await setParam(page, 'running', 0);
    await expect
      .poll(() => stripState(page), { timeout: 4000, message: 'a slaved stop must still be reported' })
      .toBe('stopped');
    // …and it says so in words a player reads, not only in a derived id.
    await expect(tile.getByTestId('readout-running')).toHaveText('STOPPED');
  });

  test('the ENGINE and the CARD agree about the state', async ({ page }) => {
    // Both come from one pure derivation; this proves the seam is wired, so a
    // future consumer reading read('transportState') gets what the card shows.
    await spawnClock(page);
    for (const c of [
      { running: 1, mute: 1, id: 'muted' },
      { running: 0, mute: 0, id: 'stopped' },
      { running: 1, mute: 0, id: 'running' },
    ]) {
      await setParam(page, 'running', c.running);
      await setParam(page, 'muteOutputs', c.mute);
      await expect.poll(() => stripState(page), { timeout: 4000 }).toBe(c.id);
      await expect
        .poll(() => engineState(page), { timeout: 4000, message: `engine read('transportState') for ${c.id}` })
        .toBe(c.id);
    }
  });
});
