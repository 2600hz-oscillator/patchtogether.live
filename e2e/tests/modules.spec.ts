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
  /** 'audio' (default) or 'video'. Phase 0 video spike modules need
   *  this so spawnPatch sets node.domain correctly and the reconciler
   *  routes the new node to the VideoEngine. */
  domain?: 'audio' | 'video';
}

const MODULES: ModuleSpec[] = [
  { type: 'analogVco',    cardClass: 'svelte-flow__node-analogVco',    handleCount: 6, containsLabel: 'Analog VCO' },
  { type: 'audioOut',     cardClass: 'svelte-flow__node-audioOut',     handleCount: 2, containsLabel: 'Audio Out' },
  { type: 'vca',          cardClass: 'svelte-flow__node-vca',          handleCount: 3, containsLabel: 'VCA' },
  { type: 'mixer',        cardClass: 'svelte-flow__node-mixer',        handleCount: 5, containsLabel: 'Mixer' },
  { type: 'adsr',         cardClass: 'svelte-flow__node-adsr',         handleCount: 6, containsLabel: 'ADSR' },
  { type: 'filter',       cardClass: 'svelte-flow__node-filter',       handleCount: 4, containsLabel: 'Filter' },
  { type: 'reverb',       cardClass: 'svelte-flow__node-reverb',       handleCount: 2, containsLabel: 'Reverb' },
  // SCOPE: 2 audio inputs + 2 audio passthrough outputs + 1 mono-video output = 5.
  { type: 'scope',        cardClass: 'svelte-flow__node-scope',        handleCount: 5, containsLabel: 'Scope' },
  { type: 'sequencer',    cardClass: 'svelte-flow__node-sequencer',    handleCount: 4, containsLabel: 'Sequencer' },
  { type: 'wavetableVco', cardClass: 'svelte-flow__node-wavetableVco', handleCount: 4, containsLabel: 'Wavetable VCO' },
  { type: 'lfo',          cardClass: 'svelte-flow__node-lfo',          handleCount: 7, containsLabel: 'LFO' },
  // Cartesian: 4 inputs (clock, x cv, y cv, lfo clock) + 5 outputs (pitch,
  // gate, clock, lfo x, lfo y) = 9 handles. lfo_clock + lfo_x + lfo_y were
  // added by the embedded LFO subsystem.
  { type: 'cartesian',    cardClass: 'svelte-flow__node-cartesian',    handleCount: 9, containsLabel: 'Cartesian' },
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
  // MIXMSTRS: 12 audio inputs (4 ch stereo + 2 returns stereo) + 37 CV-per-
  // param inputs + 6 outputs (master L/R + 2 sends stereo) = 55 handles.
  // Post-PatchPanel-refactor every def-declared port renders a Handle
  // (visually hidden until the panel is hovered open).
  { type: 'mixmstrs',     cardClass: 'svelte-flow__node-mixmstrs',     handleCount: 55, containsLabel: 'MIXMSTRS' },
  // SCORE: 5 inputs (clock + A/D/S/R cv) + 4 outputs (pitch, gate, env, clock) = 9.
  { type: 'score',        cardClass: 'svelte-flow__node-score',        handleCount: 9, containsLabel: 'Score' },
  // VIZVCO: 3 inputs (pitch, fm, foldAmount cv) + 5 outputs (saw, square, triangle, sine, scope mono-video) = 8.
  { type: 'vizvco',       cardClass: 'svelte-flow__node-vizvco',       handleCount: 8, containsLabel: 'VIZVCO' },
  // WAVVIZ: 4 inputs (pitch, fm, wavePos cv, foldAmount cv) + 2 outputs (audio, scope mono-video) = 6.
  { type: 'wavviz',       cardClass: 'svelte-flow__node-wavviz',       handleCount: 6, containsLabel: 'WAVVIZ' },
  // ---- Video-domain (Phase 0 spike) ----
  // LINES: 5 inputs (fm + 4 cv: orient, amp, thickness, phase) + 1 output (out) = 6 handles.
  { type: 'lines',        cardClass: 'svelte-flow__node-lines',        handleCount: 6, containsLabel: 'LINES',  domain: 'video' },
  // OUTPUT (videoOut): 1 input (in) + 0 outputs = 1 handle.
  { type: 'videoOut',     cardClass: 'svelte-flow__node-videoOut',     handleCount: 1, containsLabel: 'OUTPUT', domain: 'video' },
  // ---- Video-domain (Phase 1 — .myrobots/plans/video-modules-mvp.md) ----
  // INWARDS: 3 cv inputs (speed, density, thickness — match LINES PR-65 pattern)
  // + 1 output (out) = 4 handles.
  { type: 'inwards',      cardClass: 'svelte-flow__node-inwards',      handleCount: 4, containsLabel: 'INWARDS',    domain: 'video' },
  // PICTUREBOX: 1 input (gain cv) + 1 output (out) = 2 handles.
  { type: 'picturebox',   cardClass: 'svelte-flow__node-picturebox',   handleCount: 2, containsLabel: 'PICTUREBOX', domain: 'video' },
  // DESTRUCTOR: 2 inputs (in, mangle) + 1 output (out) = 3 handles.
  { type: 'destructor',   cardClass: 'svelte-flow__node-destructor',   handleCount: 3, containsLabel: 'DESTRUCTOR', domain: 'video' },
  // CHROMA: 6 inputs (in, keyR, keyG, keyB, tolerance, softness) + 1 output (out) = 7.
  { type: 'chroma',       cardClass: 'svelte-flow__node-chroma',       handleCount: 7, containsLabel: 'CHROMA',     domain: 'video' },
  // LUMA: 2 inputs (in, threshold) + 1 output (out) = 3 handles.
  { type: 'luma',         cardClass: 'svelte-flow__node-luma',         handleCount: 3, containsLabel: 'LUMA',       domain: 'video' },
  // COLORIZER: 4 inputs (in, tintR, tintG, tintB) + 1 output (out) = 5 handles.
  { type: 'colorizer',    cardClass: 'svelte-flow__node-colorizer',    handleCount: 5, containsLabel: 'COLORIZER',  domain: 'video' },
  // FEEDBACK: 7 inputs (in + wet/decay/zoom/rotate/offsetX/offsetY cv) + 1 output (out) = 8.
  { type: 'feedback',     cardClass: 'svelte-flow__node-feedback',     handleCount: 8, containsLabel: 'FEEDBACK',   domain: 'video' },
  // V-MIXER: 4 video inputs (in1..in4) + 4 cv inputs (amount1..4) + 1 output (out) = 9.
  { type: 'videoMixer',   cardClass: 'svelte-flow__node-videoMixer',   handleCount: 9, containsLabel: 'V-MIXER',    domain: 'video' },
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

    await spawnPatch(page, [{ id: 'm-1', type: spec.type, position: { x: 100, y: 100 }, domain: spec.domain }]);

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
