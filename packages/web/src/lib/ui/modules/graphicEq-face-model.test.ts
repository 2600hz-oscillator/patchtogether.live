// packages/web/src/lib/ui/modules/graphicEq-face-model.test.ts
//
// GRAPHIC EQ — the permanent gates on the claims this face is built from. Each
// reads the LIVE def through the SAME pure resolvers the shell renders from, so
// an assertion here cannot drift from what actually paints.
//
// ⚠ WHY A FILE AT ALL — the blind-gate question, asked before writing it.
// Delete the two `options` rosters tomorrow and ask what goes red. `params` IS
// in the WebGL attest hash, so the HASH moves — but a moved hash says "something
// changed", never "the face now lies about its own controls". `module-face-lint`
// checks the SHAPE of a declaration rather than whether removing it changes
// what renders, and `contract-lock` projects neither `options` nor `face`. The
// face would keep rendering, as two unlabelled ON/OFF switches on a module where
// neither param has an "off" state. That is the failure this file exists to
// catch, and the positive controls below are the whole point of it.

import { describe, expect, it } from 'vitest';
import { graphicEqDef } from '$lib/video/modules/graphicEq';
import { GRAPHIC_EQ_MONITOR_BOX } from './graphicEq/monitor-box';
import type { ParamDef } from '$lib/graph/types';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';

function param(id: string): ParamDef {
  const p = (graphicEqDef.params ?? []).find((q) => q.id === id);
  expect(p, `graphicEq declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

const MOMENTARY = momentaryParamIds(graphicEqDef);
const CELLS = declaredParamCells(graphicEqDef);
/** Every declared param id, read off the def — never a typed roster. */
const ALL_PARAMS = (graphicEqDef.params ?? []).map((p) => p.id);

describe('graphicEq face — the two rosters are LOAD-BEARING, not decoration', () => {
  it('style and display resolve to a NAMED segmented row, not a bare toggle', () => {
    for (const id of ['style', 'display']) {
      expect(
        paramCellKind(param(id), MOMENTARY, 'dock', CELLS),
        `${id} names its two states; a bare toggle would say only pressed/unpressed`,
      ).toBe('segmented');
    }
  });

  it('⚠ POSITIVE CONTROL: stripping the roster DOWNGRADES them to an unlabelled toggle', () => {
    // The negative-control-is-not-enough rule: proving the probe CAN move is not
    // proving it reads the right thing. This runs the real resolver against the
    // real param minus one field and asserts the answer becomes the specific
    // wrong thing the roster exists to prevent.
    for (const id of ['style', 'display']) {
      const { options: _dropped, ...stripped } = param(id);
      expect(
        paramCellKind(stripped as ParamDef, MOMENTARY, 'dock', CELLS),
        `${id} without its roster falls back to a toggle — which is why the roster is required`,
      ).toBe('toggle');
    }
  });

  it('the labels are PROMOTED from the def\'s own docs, not invented', () => {
    // Invention is the failure mode here (naming these "A"/"B", or "coarse"/
    // "fine" — words that appear nowhere). Anchored to the docs blob the module
    // already shipped, so the face and the documentation cannot drift apart.
    const controls = graphicEqDef.docs?.controls ?? {};
    for (const [id, expected] of [
      ['style', ['BARS', 'BOXES']],
      ['display', ['MONO', 'STEREO']],
    ] as const) {
      const labels = (param(id).options ?? []).map((o) => o.label);
      expect(labels, `${id} offers exactly its two documented states`).toEqual([...expected]);
      const prose = String(controls[id] ?? '');
      for (const l of expected) {
        expect(
          prose.toUpperCase().includes(l),
          `${id}'s docs already use the word ${l} — the label is promoted, not coined here`,
        ).toBe(true);
      }
    }
  });

  it('every option value is a REACHABLE param value', () => {
    // A roster naming a state the param cannot hold is a control that lies.
    for (const id of ['style', 'display']) {
      const p = param(id);
      for (const o of p.options ?? []) {
        expect(o.value, `${id}: option ${o.label} lies within [${p.min}, ${p.max}]`)
          .toBeGreaterThanOrEqual(p.min as number);
        expect(o.value).toBeLessThanOrEqual(p.max as number);
      }
    }
  });
});

describe('graphicEq face — the throws survive, and hue does NOT', () => {
  it('gain and peak keep the card\'s throw', () => {
    for (const id of ['gain', 'peak']) {
      expect(
        paramCellKind(param(id), MOMENTARY, 'dock', CELLS),
        `${id} is a <NeonFader> on GraphicEqCard and nothing in a ParamDef says "throw"`,
      ).toBe('fader');
    }
  });

  it('⚠ hue is the DELIBERATE departure from the card: a conic ring, not a fader', () => {
    // The card draws hue as a NeonFader. This is the one control the face
    // refuses to reproduce, because the param is a CONTINUOUS 0..1 ANGLE THAT
    // WRAPS — 0 and 1 are the same colour. On a linear throw those sit at
    // opposite extremes while being the identical result, so the crossing a
    // player most wants is the one a fader cannot make.
    expect(paramCellKind(param('hue'), MOMENTARY, 'dock', CELLS)).toBe('hue');
    const p = param('hue');
    expect(p.min, 'the wrap argument needs the full 0..1 circle').toBe(0);
    expect(p.max).toBe(1);
    expect(p.curve ?? 'linear', 'a wrapping angle is continuous, not stepped').toBe('linear');
  });

  it('⚠ POSITIVE CONTROL: undeclared, hue would repaint as a KNOB', () => {
    const NO_CELLS: ReturnType<typeof declaredParamCells> = new Map();
    expect(
      paramCellKind(param('hue'), MOMENTARY, 'dock', NO_CELLS),
      'the declaration is what buys the ring; without it the end stops come back',
    ).not.toBe('hue');
  });
});

describe('graphicEq face — the surface it promises', () => {
  it('declares the extension that carries SCREEN, MONITOR and the resize', () => {
    // Promotion stops GraphicEqCard rendering, and that card is the sole home of
    // all three. Without this the def's own docs would describe a monitor that
    // no longer exists — and every def-reading gate would stay green.
    expect(graphicEqDef.face?.extension).toBe('graphicEq');
    expect(graphicEqDef.face?.monitor?.why.length ?? 0).toBeGreaterThan(40);
  });

  it('the lane tile gets a live picture from the video surface', () => {
    expect(hasVideoSurface(graphicEqDef)).toBe(true);
  });

  it('glyph is `none` — this def has no AUDIO OUTPUT to bind one to', () => {
    // ⚠ The audio-typed INPUTS do not satisfy `primaryAudioOutPortId`: the glyph
    // binds to what a module EMITS, and this one emits video. Any other literal
    // falls through to `{kind:'static'}` and reddens module-face-lint.
    expect(graphicEqDef.face?.glyph).toBe('none');
    expect(
      (graphicEqDef.outputs ?? []).some((o) => o.type === 'audio'),
      'no audio output exists, which is WHY the glyph is none',
    ).toBe(false);
  });

  it('every param is ranked — the face hides none of the five', () => {
    expect([...(graphicEqDef.face?.order ?? [])].sort()).toEqual([...ALL_PARAMS].sort());
  });
});

describe('graphicEq monitor box — ONE source, shared with the card', () => {
  it('the floors and default come from the shared module, not re-typed numbers', () => {
    // The backdraft rule: a control's geometry must come from ONE place. Both
    // GraphicEqCard.svelte and GraphicEqOutputBody.svelte key off
    // node.data.resizedWidth/resizedHeight, so a second copy of these numbers
    // would let the two surfaces disagree about the size a rack was left at.
    expect(GRAPHIC_EQ_MONITOR_BOX.minW).toBeLessThanOrEqual(GRAPHIC_EQ_MONITOR_BOX.defW);
    expect(GRAPHIC_EQ_MONITOR_BOX.minH).toBeLessThanOrEqual(GRAPHIC_EQ_MONITOR_BOX.defH);
    expect(GRAPHIC_EQ_MONITOR_BOX.minW, 'floors are whole-u 180px rack tiles (#759)')
      .toBe(360);
    expect(GRAPHIC_EQ_MONITOR_BOX.minH).toBe(180);
  });
});
