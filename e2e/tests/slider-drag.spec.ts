// e2e/tests/slider-drag.spec.ts
//
// "Every knob/slider is dead" regression — the THREE-channel guarantee.
//
// When a user changes a module control, the new value MUST propagate to all
// three observers, or the instrument is silently broken:
//   1. the patch store        (__patch.nodes[id].params[p])      — sync + save
//   2. the rendered control   (aria-valuenow on [role="slider"]) — what's seen
//   3. the audio engine       (__engine().readParam)             — what's heard
//
// The reported symptom was "store updated BUT display + engine frozen". This
// spec exercises the EXACT write the Fader/Knob cards perform on every
// pointermove — `patch.nodes[id].params[x] = v` inside a LOCAL_ORIGIN
// ydoc.transact (driven through the dev __patch/__ydoc globals, the same
// trigger audio-controls.spec.ts uses) — then asserts all three channels
// moved to the new value.
//
// NOTE on the write shape: a whole-node-entry replacement
// (`patch.nodes[id] = { ...node, params: { ...params, [x]: v } }`) propagates
// to the store + engine but BREAKS aria-valuenow (Svelte Flow's node-data
// reference identity changes and the card's value prop drops to undefined).
// The in-place nested write is the correct, working contract — this spec pins
// it so a refactor to whole-node-replace (a tempting "fix") is caught.
//
// Parametrized over a Fader card (ADSR) and a Knob card (VCA) — both render
// [role="slider"][aria-valuenow] with an aria-label. FILTER cutoff uses a
// different layout and is intentionally excluded so a selector mismatch can't
// mask a real check.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface Case {
  label: string;
  type: string;
  param: string;
  ariaLabel: string;
  /** Spawn value, and a clearly-different target to write. */
  spawn: number;
  target: number;
  /** Decimal places for the close-to comparison (log params want fewer). */
  precision: number;
}

const CASES: Case[] = [
  { label: 'ADSR Attack (Fader)', type: 'adsr', param: 'attack', ariaLabel: 'Attack', spawn: 0.5, target: 4, precision: 1 },
  { label: 'VCA Base (Knob/Fader)', type: 'vca', param: 'base', ariaLabel: 'Base', spawn: 0.25, target: 0.8, precision: 2 },
];

async function writeParamNested(page: Page, id: string, param: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, param, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n && n.params) n.params[param] = value;
      });
    },
    { id, param, value },
  );
}

async function readStoreParam(page: Page, id: string, param: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, param }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch?.nodes[id]?.params?.[param];
    },
    { id, param },
  );
}

async function readEngineParam(page: Page, id: string, param: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, param }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          readParam: (
            node: { id: string; type: string; domain: string },
            paramId: string,
          ) => number | undefined;
        } | null;
        __patch?: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch?.nodes[id];
      if (!eng || !node) return undefined;
      return eng.readParam(node, param) ?? undefined;
    },
    { id, param },
  );
}

async function ariaValueNow(control: Locator): Promise<number> {
  const raw = await control.getAttribute('aria-valuenow');
  return raw === null ? NaN : Number(raw);
}

test.describe('knob/slider value propagates to store + UI + engine', () => {
  for (const c of CASES) {
    test(c.label, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: 'm', type: c.type, params: { [c.param]: c.spawn } }]);

      const control = page.locator(`[role="slider"][aria-label="${c.ariaLabel}"]`).first();
      await control.waitFor({ state: 'visible', timeout: 10_000 });

      // Engine must materialize the node, and all three channels must agree on
      // the spawn value — the healthy baseline.
      await expect
        .poll(() => readEngineParam(page, 'm', c.param), { timeout: 10_000 })
        .toBeCloseTo(c.spawn, c.precision);
      expect(await readStoreParam(page, 'm', c.param), 'store baseline = spawn').toBeCloseTo(
        c.spawn,
        c.precision,
      );
      await expect
        .poll(() => ariaValueNow(control), { timeout: 5_000 })
        .toBeCloseTo(c.spawn, c.precision);

      // The change: the exact in-place nested write a Fader/Knob card performs.
      await writeParamNested(page, 'm', c.param, c.target);

      // 1. STORE took the write.
      await expect
        .poll(() => readStoreParam(page, 'm', c.param), { timeout: 5_000 })
        .toBeCloseTo(c.target, c.precision);

      // 2. RENDERED CONTROL reflects it (aria-valuenow tracks via the
      //    motorized readLive loop landing on the new engine value).
      await expect
        .poll(() => ariaValueNow(control), { timeout: 5_000 })
        .toBeCloseTo(c.target, c.precision);

      // 3. ENGINE reflects it.
      await expect
        .poll(() => readEngineParam(page, 'm', c.param), { timeout: 5_000 })
        .toBeCloseTo(c.target, c.precision);
    });
  }
});
