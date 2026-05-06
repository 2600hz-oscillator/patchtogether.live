// e2e/tests/modules.spec.ts
//
// Per-module render checks. Each test spawns one module via the dev-window
// helpers, asserts the card renders with the expected handle count, and
// verifies the engine instantiates without console errors.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface ModuleSpec {
  type: string;
  cardClass: string;       // .svelte-flow__node-<type>
  handleCount: number;     // visible handle elements (input + output)
  containsLabel: string;   // substring expected in the card
}

const MODULES: ModuleSpec[] = [
  { type: 'analogVco',    cardClass: 'svelte-flow__node-analogVco',    handleCount: 6, containsLabel: 'Analog VCO' },
  { type: 'audioOut',     cardClass: 'svelte-flow__node-audioOut',     handleCount: 2, containsLabel: 'Audio Out' },
  { type: 'vca',          cardClass: 'svelte-flow__node-vca',          handleCount: 3, containsLabel: 'VCA' },
  { type: 'mixer',        cardClass: 'svelte-flow__node-mixer',        handleCount: 5, containsLabel: 'Mixer' },
  { type: 'adsr',         cardClass: 'svelte-flow__node-adsr',         handleCount: 6, containsLabel: 'ADSR' },
  { type: 'filter',       cardClass: 'svelte-flow__node-filter',       handleCount: 4, containsLabel: 'Filter' },
  { type: 'reverb',       cardClass: 'svelte-flow__node-reverb',       handleCount: 2, containsLabel: 'Reverb' },
  { type: 'scope',        cardClass: 'svelte-flow__node-scope',        handleCount: 4, containsLabel: 'Scope' },
  { type: 'sequencer',    cardClass: 'svelte-flow__node-sequencer',    handleCount: 4, containsLabel: 'Sequencer' },
  { type: 'wavetableVco', cardClass: 'svelte-flow__node-wavetableVco', handleCount: 4, containsLabel: 'Wavetable VCO' },
  { type: 'lfo',          cardClass: 'svelte-flow__node-lfo',          handleCount: 7, containsLabel: 'LFO' },
  { type: 'cartesian',    cardClass: 'svelte-flow__node-cartesian',    handleCount: 6, containsLabel: 'Cartesian' },
  { type: 'destroy',      cardClass: 'svelte-flow__node-destroy',      handleCount: 5, containsLabel: 'DESTROY' },
  { type: 'qbrt',         cardClass: 'svelte-flow__node-qbrt',         handleCount: 8, containsLabel: 'QBRT' },
  { type: 'drummergirl',  cardClass: 'svelte-flow__node-drummergirl',  handleCount: 5, containsLabel: 'DRUMMERGIRL' },
];

test.describe.configure({ mode: 'parallel' });

for (const spec of MODULES) {
  test(`module ${spec.type} renders + has ${spec.handleCount} handles + no console errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'm-1', type: spec.type, position: { x: 100, y: 100 } }]);

    const card = page.locator(`.${spec.cardClass}`);
    await expect(card, `${spec.type} card visible`).toBeVisible();
    await expect(card, `${spec.type} contains label`).toContainText(spec.containsLabel);

    const handles = card.locator('.svelte-flow__handle');
    await expect(handles, `${spec.type} handle count`).toHaveCount(spec.handleCount);

    // Card has non-zero rect (catches the silent-DOM-only failure mode).
    const box = await card.boundingBox();
    expect(box, `${spec.type} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(50);

    expect(errors, `console/page errors during ${spec.type} render: ${errors.join('; ')}`).toEqual([]);
  });
}
