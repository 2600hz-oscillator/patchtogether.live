// packages/web/src/lib/ui/modules/wavesculpt-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the WAVESCULPT faceplate.
//
// This face rests on claims no shared gate checks, and every one of them reads
// as true whether or not it is:
//
//   1. "The camera ranks FIRST and the lane still shows the level." That is
//      only true because a declared pad costs no LANE rank. If the pad were
//      ever dropped, the rank would silently become the lane and nothing else
//      would complain.
//   2. "Each of the TWELVE family cells drives ITS OWN oscillator." Twelve
//      cells built from one shape, each closing over an index — the single
//      most refactor-fragile thing on this module, and completely invisible to
//      every gate that only asks whether a cell EXISTS.
//   3. "The wavetable strip survives promotion." Promotion deletes the card
//      from both surfaces, so anything living only there is gone: the
//      `samsloop` failure, which is why STOP 2 exists.
//   4. "ALPHA has one fewer cell BY DESIGN." An omission and a decision look
//      identical in a face block.
//   5. The band count, which is what engages the tab rail — with `face.tabbed`
//      deliberately absent, so the rail is a consequence rather than a claim.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wavesculptDef } from '$lib/audio/modules/wavesculpt';
import { foldedOrder, laneOrder } from '$lib/ui/workflow/curated-face';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import type { ModuleNode } from '$lib/graph/types';

const FACE = wavesculptDef.face!;
const PARAM_IDS = wavesculptDef.params.map((p) => p.id);
const FAMILY_IDS = (wavesculptDef.controlFamilies ?? []).map((f) => f.id);

const cell = (key: string) => shellCellFor('wavesculpt', { kind: 'family', key } as never);

const BODY = readFileSync(
  new URL('./wavesculpt/WavesculptOutputBody.svelte', import.meta.url),
  'utf8',
);

describe('wavesculpt — promoted, complete, and ten honest bands', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('wavesculpt')).toBe(true);
    expect(migrated('wavesculpt')).toBe(true);
  });

  it('ranks every param AND every declared control family', () => {
    const ranked = new Set(FACE.order);
    const missingParams = PARAM_IDS.filter((id) => !ranked.has(id));
    expect(missingParams, 'every param must be ranked or it falls into __unpaged').toEqual([]);
    const missingFamilies = FAMILY_IDS.filter((id) => !ranked.has(`${id}-{n}`));
    expect(missingFamilies, 'every family must be ranked by its {n} template').toEqual([]);
  });

  it('every ranked key is claimed by exactly ONE band', () => {
    const claims = new Map<string, number>();
    for (const page of FACE.pages ?? []) {
      for (const k of page.controls) claims.set(k, (claims.get(k) ?? 0) + 1);
    }
    const unclaimed = FACE.order.filter((k) => !claims.has(k));
    expect(unclaimed, 'a ranked key with no page falls into the defensive __unpaged band').toEqual([]);
    const doubled = [...claims.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(doubled, 'a key claimed twice would render twice').toEqual([]);
  });
});

describe('wavesculpt — the RANK, and the thing that makes it possible', () => {
  it('CAMERA ranks first: the pad axes are the two highest keys', () => {
    expect(FACE.order.slice(0, 2)).toEqual(['pos_x', 'pos_y']);
  });

  it('⚠ THE PAD COSTS NO LANE RANK — which is the only reason the lane is useful', () => {
    // THE LOAD-BEARING ONE. Ranking the camera first must not spend the lane on
    // two axes a 46 px knob column could not carry anyway.
    //
    // ⚠ IT TAKES BOTH FUNCTIONS, AND FINDING THAT OUT IS WHY THIS TEST EXISTS.
    // `laneOrder` drops only the pad's X — the PARTNER axis is removed by
    // `foldedOrder`, which folds `y` into the pad's single cell. The shell
    // composes them (`foldedOrder({ ...face, order: laneOrder(face) })`), and
    // an assertion against `laneOrder` ALONE reports pos_y in the lane and is
    // simply asking the wrong function. This one composes them the same way.
    const lane = foldedOrder({ ...FACE, order: laneOrder(FACE) });
    expect(lane.includes('pos_x'), 'pos_x must NOT reach the lane').toBe(false);
    expect(lane.includes('pos_y'), 'pos_y must NOT reach the lane').toBe(false);
    expect(lane.slice(0, 3)).toEqual(['zoom', 'master_gain', 'blink_mode']);
  });

  it('NEGATIVE CONTROL: without the pad declaration the axes WOULD take the lane', () => {
    // Proves the clause above is doing work rather than describing a rank that
    // would hold anyway — the same face with no `xyPads` opens on pos_x/pos_y.
    const bare = { ...FACE, xyPads: [] };
    const lane = foldedOrder({ ...bare, order: laneOrder(bare) });
    expect(lane.slice(0, 2)).toEqual(['pos_x', 'pos_y']);
  });
});

describe('wavesculpt — the bands, and the rail that follows from them', () => {
  it('has TEN bands and does NOT declare face.tabbed', () => {
    expect(FACE.pages?.length).toBe(10);
    // The rail engages on COUNT. Declaring it is fenced to explicit owner
    // instruction per module, and there is none naming wavesculpt.
    expect(FACE.tabbed).toBeUndefined();
  });

  it('the four oscillator bands are the split that engages the rail', () => {
    const oscBands = (FACE.pages ?? []).filter((p) => p.id.startsWith('osc-'));
    expect(oscBands.map((p) => p.id)).toEqual(['osc-red', 'osc-green', 'osc-blue', 'osc-alpha']);
  });

  it('⚠ ALPHA has one fewer cell BY DESIGN — it is the mask layer, with no colour param', () => {
    const alpha = (FACE.pages ?? []).find((p) => p.id === 'osc-alpha')!;
    const red = (FACE.pages ?? []).find((p) => p.id === 'osc-red')!;
    expect(red.controls).toContain('red_color');
    expect(alpha.controls.some((k) => k.endsWith('_color'))).toBe(false);
    // ...and the reason it is a DECISION rather than an omission: there is no
    // fourth colour param to have ranked.
    expect(PARAM_IDS.filter((id) => id.endsWith('_color'))).toEqual(['red_color', 'grn_color', 'blu_color']);
    expect(alpha.controls.length).toBe(red.controls.length - 1);
  });
});

describe('wavesculpt — the declared cells', () => {
  it('zoom and rot are FADERS, and the three colours are COLOUR cells', () => {
    // The owner split the zoom/rot PAD into two faders because its axes are not
    // commensurate (zoom is log 0.3..3, rot linear +-1), so equal pixel travel
    // was never equal parameter travel. With the pad gone there is no card
    // affordance to preserve, and the affordance becomes the module's choice.
    expect(FACE.paramCells?.zoom).toBe('fader');
    expect(FACE.paramCells?.rot).toBe('fader');
    expect(FACE.paramCells?.red_color).toBe('color');
    expect(FACE.paramCells?.grn_color).toBe('color');
    expect(FACE.paramCells?.blu_color).toBe('color');
  });

  it('the camera pad is painted by the BODY, and the body really paints it', () => {
    const pad = FACE.xyPads?.[0];
    expect(pad).toMatchObject({ x: 'pos_x', y: 'pos_y', surface: 'body' });
    expect(BODY).toContain('data-control-params="pos_x,pos_y"');
  });

  it('⚠ the SCREEN switch must never DROP the surface claim', () => {
    // ⚠ THIS LEG USED TO READ `<WavesculptVizSurface`, AND THE MOUNT IT PINNED
    // IS GONE (legacy-removal S1). The renderer belongs to the NODE now —
    // `$lib/ui/media/NodeVizSurfaceHost` mounts exactly one per node, parked
    // off-screen — and this body CLAIMS its canvas into the pad. A second mount
    // is not merely redundant: the surface stamps `data-testid="wavesculpt-
    // canvas"` on its own canvas, so two mounts put two of them in the document
    // and `wavesculpt.spec.ts` asserts exactly one.
    //
    // The RULE is unchanged and is what this leg still pins: the picture must
    // not sit inside an `{#if}` on the SCREEN state. What SCREEN OFF costs has
    // shrunk (a dropped claim parks the canvas; it no longer disposes the GL
    // context or uninstalls the `video_out` drawer) but a released claim still
    // leaves a BLANK PAD with a live crosshair and dot drawn on it, which reads
    // as a broken surface. Hide the wrapper; never drop the host.
    expect(BODY).toContain('nodeVizSurfaces.claim(');
    expect(BODY, 'the body must not mount a second renderer').not.toContain(
      '<WavesculptVizSurface',
    );
    // The claim host div, and the SCREEN state reaching it as a CLASS.
    expect(/class="viz"[^>]*class:hidden=\{previewCollapsed\}[^>]*bind:this=\{vizHost\}/.test(BODY))
      .toBe(true);
    expect(
      /\{#if !previewCollapsed\}[\s\S]{0,200}bind:this=\{vizHost\}/.test(BODY),
      'the claim host must not sit inside an {#if} on the SCREEN state',
    ).toBe(false);
  });
});

describe('wavesculpt — the wavetable strip reaches the faceplate', () => {
  const OSC = [1, 2, 3, 4];

  it('all TWELVE family cells resolve — none is a dead label', () => {
    const missing: string[] = [];
    for (const n of OSC) {
      for (const kind of ['preset', 'table', 'load']) {
        const key = `wavesculpt-osc${n}-${kind}-{n}`;
        if (!cell(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('⚠ EACH TABLE CELL READS ITS OWN OSCILLATOR — the index closure, proved', () => {
    // THE MOST REFACTOR-FRAGILE CLAIM ON THIS MODULE. Twelve cells are built
    // from one shape, each closing over its own index; a copy-paste slip would
    // point two voices at one oscillator and EVERY other gate would stay green,
    // because all twelve cells would still exist and still resolve.
    //
    // Four oscillators are given four DISTINCT tables, and each cell must
    // report its own.
    const node = {
      id: 'ws',
      type: 'wavesculpt',
      data: {
        osc1: { wavetableSource: 'factory:AAA' },
        osc2: { wavetableSource: 'factory:BBB' },
        osc3: { wavetableSource: 'factory:CCC' },
        osc4: { wavetableSource: 'factory:DDD' },
      },
    } as unknown as ModuleNode;

    const seen = OSC.map((n) => {
      const c = cell(`wavesculpt-osc${n}-table-{n}`);
      expect(c?.kind).toBe('selector');
      return (c as { value: (node: ModuleNode) => string }).value(node);
    });
    expect(seen).toEqual(['factory:AAA', 'factory:BBB', 'factory:CCC', 'factory:DDD']);
  });

  it('NEGATIVE CONTROL: the index proof can FAIL', () => {
    // If every oscillator held the SAME table the clause above would pass for a
    // wrong implementation too, so show it distinguishes.
    const flat = {
      id: 'ws',
      type: 'wavesculpt',
      data: { osc1: {}, osc2: {}, osc3: {}, osc4: {} },
    } as unknown as ModuleNode;
    const seen = OSC.map((n) =>
      (cell(`wavesculpt-osc${n}-table-{n}`) as { value: (node: ModuleNode) => string }).value(flat),
    );
    expect(new Set(seen).size, 'undifferentiated data must NOT produce four distinct answers').toBe(1);
  });

  it('⚠ THE PRESET CELL REPORTS THE PRESET IT HOLDS — the clause that was missing', () => {
    // THIS IS THE REGRESSION LEG. The two clauses above prove the TABLE cells
    // read their own oscillator; NOTHING proved the PRESET cells' `value` could
    // move at all, and it could not — all four were declared `value: () => ''`,
    // a constant. The chip painted `— preset —` for ever, so choosing a preset
    // was invisible on the faceplate while the legacy card's native <select>
    // showed it. Only the e2e faces-parity sweep could see that, 8½ minutes into
    // a shard; this sees it in a millisecond.
    //
    // Four voices are given four DISTINCT preset labels, exactly as
    // `loadWavesculptPreset` writes them, and each cell must report its own.
    const node = {
      id: 'ws',
      type: 'wavesculpt',
      data: {
        osc1: { wavetableSource: 'user', wavetableLabel: 'ZAP' },
        osc2: { wavetableSource: 'user', wavetableLabel: 'TIDAL' },
        osc3: { wavetableSource: 'user', wavetableLabel: 'SPECTRAL' },
        osc4: { wavetableSource: 'user', wavetableLabel: 'TALKING' },
      },
    } as unknown as ModuleNode;

    const seen = OSC.map((n) => {
      const c = cell(`wavesculpt-osc${n}-preset-{n}`);
      expect(c?.kind).toBe('selector');
      return (c as { value: (node: ModuleNode) => string }).value(node);
    });
    expect(seen).toEqual(['zap', 'tidal', 'spectral', 'talking']);

    // …and every id it reports is a real option on its OWN roster, or the chip
    // would render blank on a value it has no option for.
    for (const n of OSC) {
      const c = cell(`wavesculpt-osc${n}-preset-{n}`) as {
        options: (node: ModuleNode) => { value: string }[];
      };
      expect(c.options(node).map((o) => o.value)).toContain(seen[n - 1]);
    }
  });

  it('the sentinel is what a voice holding a FACTORY table reports — not a resting constant', () => {
    // The empty sentinel still exists and still has a job: a fresh oscillator
    // holds a factory table, which is no preset at all. The difference from the
    // defect is that `''` is now an ANSWER about the node rather than the only
    // answer the cell can give — so this clause and the one above must disagree
    // on the same cell, which is the whole proof.
    const factory = {
      id: 'ws',
      type: 'wavesculpt',
      data: {
        osc1: { wavetableSource: 'factory:AAA' },
        osc2: {},
        osc3: { wavetableSource: 'user', wavetableLabel: 'MY OWN FILE' },
        osc4: { wavetableSource: 'factory:DDD' },
      },
    } as unknown as ModuleNode;
    const seen = OSC.map((n) =>
      (cell(`wavesculpt-osc${n}-preset-{n}`) as { value: (node: ModuleNode) => string }).value(
        factory,
      ),
    );
    // osc3 holds a USER table whose label matches no preset — `''` too, and for
    // the honest reason: it is not a preset.
    expect(seen).toEqual(['', '', '', '']);
  });

  it('NEGATIVE CONTROL: the preset index proof can FAIL', () => {
    // Same shape as the table cells' negative control: if all four voices held
    // the SAME preset, four identical answers would pass the clause above for a
    // wrong implementation too.
    const flat = {
      id: 'ws',
      type: 'wavesculpt',
      data: {
        osc1: { wavetableSource: 'user', wavetableLabel: 'ZAP' },
        osc2: { wavetableSource: 'user', wavetableLabel: 'ZAP' },
        osc3: { wavetableSource: 'user', wavetableLabel: 'ZAP' },
        osc4: { wavetableSource: 'user', wavetableLabel: 'ZAP' },
      },
    } as unknown as ModuleNode;
    const seen = OSC.map((n) =>
      (cell(`wavesculpt-osc${n}-preset-{n}`) as { value: (node: ModuleNode) => string }).value(flat),
    );
    expect(new Set(seen).size, 'undifferentiated data must NOT produce four distinct answers').toBe(1);
    expect(seen[0], 'and the one answer is the preset they all hold').toBe('zap');
  });

  it('⚠ STOP 2 — the strip lives in a shared seam, reachable with no card', () => {
    // ⚠ THE PREMISE HALF READ THE CARD for its `wavesculpt/wavetable-actions`
    // import — the proof that the writes had MOVED rather than been copied.
    // With the card gone the move is complete, and what has to stay true is
    // that the seam is reachable from the faceplate: every load is a ranked
    // file cell rather than a gesture that lived on a surface nobody mounts.
    for (const osc of [1, 2, 3, 4] as const) {
      expect(cell(`wavesculpt-osc${osc}-load-{n}`)?.kind, `osc${osc} load`).toBe('file');
    }
  });
});

describe('wavesculpt — the refusals', () => {
  it('declines a lane glyph, and its OUT is real enough that the refusal is a choice', () => {
    expect(FACE.glyph).toBe('none');
    // The refusal is worth pinning precisely because a live glyph here would
    // have been HONEST: `L` is the summed stereo output, not a passthrough.
    const l = wavesculptDef.outputs.find((p) => p.id === 'L');
    expect(l?.type).toBe('audio');
  });

  it('declares the module-owned body extension', () => {
    expect(FACE.extension).toBe('wavesculpt');
  });

  it('declares a monitor with an ARGUED why, not a boolean', () => {
    expect(FACE.monitor?.why.length).toBeGreaterThan(40);
  });
});
