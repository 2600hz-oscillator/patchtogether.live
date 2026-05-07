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
  // QBRT: 9 handles = 6 inputs (L, R, ping, cutoff cv, resonance cv, mode cv,
  //                              pingDecay cv) + 2 outputs (L, R) — wait, that's 7+2=9. Counting again:
  //                              L-in, R-in, ping, cutoff cv, res cv, mode cv, pingDecay cv = 7 inputs;
  //                              L-out, R-out = 2 outputs; total 9.
  // DRUMMERGIRL: 7 handles = 6 inputs (gate, pitch cv, tone cv, shape cv,
  //                              volume cv, decay cv) + 1 output (audio) = 7.
  { type: 'qbrt',         cardClass: 'svelte-flow__node-qbrt',         handleCount: 9, containsLabel: 'QBRT' },
  { type: 'drummergirl',  cardClass: 'svelte-flow__node-drummergirl',  handleCount: 7, containsLabel: 'DRUMMERGIRL' },
  // MEOWBOX: 5 inputs (gate, pitch cv, morph cv, decay cv, level cv) + 2 outputs (L, R) = 7.
  { type: 'meowbox',      cardClass: 'svelte-flow__node-meowbox',      handleCount: 7, containsLabel: 'MEOWBOX' },
  // TIMELORDE: 1 input (clock) + 12 outputs (1x, 4x, 2x, 1/2 .. 1/64, swing) = 13.
  { type: 'timelorde',    cardClass: 'svelte-flow__node-timelorde',    handleCount: 13, containsLabel: 'TIMELORDE' },
  // CHARLOTTE'S ECHOS: 3 inputs (L, R, delay cv) + 2 outputs (L, R) = 5.
  { type: 'charlottesEchos', cardClass: 'svelte-flow__node-charlottesEchos', handleCount: 5, containsLabel: "CHARLOTTE'S ECHOS" },
  // MIXMSTRS: 12 audio inputs (4 ch stereo + 2 returns stereo) + 6 outputs
  // (master L/R + 2 sends stereo) = 18 visible handles. Per-param CV inputs
  // exist in the def but aren't rendered as visible jacks (37 jacks would
  // overwhelm the card chrome) — they're reachable programmatically.
  { type: 'mixmstrs',     cardClass: 'svelte-flow__node-mixmstrs',     handleCount: 18, containsLabel: 'MIXMSTRS' },
  // PlaitsFM: 2 inputs (pitch, trigger) + 2 outputs (audio, sub) = 4.
  { type: 'plaitsFm',     cardClass: 'svelte-flow__node-plaitsFm',     handleCount: 4, containsLabel: 'PlaitsFM' },
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
