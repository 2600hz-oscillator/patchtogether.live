// packages/web/src/lib/ui/modules/colourofmagic-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the COLOUROFMAGIC faceplate.
//
// WHAT MAKES THIS FILE NECESSARY: two of the three defects this face fixes were
// invisible to EVERY gate in the tree, and both are one deleted line away from
// coming back with nothing going red.
//
//   · `pal_r/g/b` are packed `0xRRGGBB` integers. Delete the `'color'` cells
//     and they resolve to a KNOB SWEEPING 16.7 MILLION VALUES — and
//     `faces-parity` PASSES that, because it drags the knob and the param
//     moves. The platform's own doc-comment names this as the reason the kind
//     is DECLARED rather than sniffed: a packed RGB differs from any other
//     discrete param only in MAGNITUDE, and nothing in the repo reads magnitude.
//   · `preview` chooses which of 22 outputs you are looking at. Delete the
//     roster and it is a 22-position ANONYMOUS dial. Also green everywhere.
//
// So every leg below pairs the good outcome with a control that DELETES the
// declaration and asserts the defect returns, through the SAME resolver the
// shell renders from. A test that only asserted the good outcome would pass
// just as happily against a resolver that had stopped reading the declaration.
//
// ⚠ SCOPE, stated rather than implied. These are DECLARATION-shape assertions.
// What actually paints is the VRT scenes' business; what this file proves is
// that the declarations the renderer reads still say what the face was built
// on, and that the two silent defects cannot return unnoticed.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  colourofmagicDef,
  COLOUROFMAGIC_OVER_PARAMS,
} from '$lib/video/modules/colourofmagic';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from '$lib/ui/workflow/shell-control-kind';
import { primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { paintsReadout, knobNameReadout } from '$lib/ui/controls/knob-vocabulary-model';
import { isPackedRgbParam, PACKED_RGB_MAX } from '$lib/ui/controls/color-field-model';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { heroFacePlan } from '$lib/ui/workflow/dock-faceplate-model';
import { DOCK_TAB_MIN_BANDS } from '$lib/ui/workflow/dock-tabs-model';
import { rearFieldPlan } from '$lib/ui/workflow/rear-card-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const NONE: ReadonlySet<string> = new Set();

function param(id: string): ParamDef {
  const p = colourofmagicDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`colourofmagic declares no param '${id}'`);
  return p as ParamDef;
}

const CELLS = new Map(
  Object.entries(colourofmagicDef.face?.paramCells ?? {}),
) as ReadonlyMap<string, 'grid' | 'color' | 'hue' | 'fader'>;

const PALETTE = ['pal_r', 'pal_g', 'pal_b'] as const;

describe('colourofmagic face — promoted, and built on these DEFAULTS', () => {
  it('is in STRICT_FACES — an authored face outside it ships as a no-op', () => {
    expect(STRICT_FACES.has('colourofmagic')).toBe(true);
  });

  it('the def still ships the shape this face was authored against', () => {
    expect(colourofmagicDef.params.length).toBe(37);
    expect(colourofmagicDef.inputs.length).toBe(31);
    expect(colourofmagicDef.outputs.length).toBe(22);
    // preview spans exactly the 22 outputs, and its default is a real tap.
    expect(param('preview').min).toBe(0);
    expect(param('preview').max).toBe(colourofmagicDef.outputs.length - 1);
    expect(param('preview').defaultValue).toBe(1);
  });
});

describe('colourofmagic face — the THREE packed-RGB params (first `color` adopter)', () => {
  it('all three ARE packed RGB, by the platform predicate that validates the cell', () => {
    for (const id of PALETTE) {
      expect(isPackedRgbParam(param(id) as never), `${id}`).toBe(true);
      expect(param(id).min).toBe(0);
      expect(param(id).max).toBe(PACKED_RGB_MAX);
      expect(param(id).curve).toBe('discrete');
    }
  });

  it('resolve a COLOUR SWATCH at every tier', () => {
    for (const id of PALETTE) {
      expect(colourofmagicDef.face?.paramCells?.[id], `${id} declaration`).toBe('color');
      expect(paramCellKind(param(id), NONE, 'dock', CELLS), `${id} dock`).toBe('color');
      expect(paramCellKind(param(id), NONE, 'lane', CELLS), `${id} lane`).toBe('color');
    }
  });

  it('NEGATIVE CONTROL — undeclared, each is a KNOB over 16.7 MILLION values', () => {
    // The defect, reconstructed by deleting exactly this face's declaration and
    // running the SAME resolver. `faces-parity` passes this state, which is why
    // the control lives here instead.
    for (const id of PALETTE) {
      expect(paramCellKind(param(id), NONE, 'dock', new Map()), `${id}`).toBe('knob');
      expect(paramCellKind(param(id), NONE, 'lane', new Map()), `${id}`).toBe('knob');
    }
    // The magnitude nothing in the repo reads, stated so the number is on the page.
    expect(PACKED_RGB_MAX + 1).toBe(16_777_216);
  });
});

describe('colourofmagic face — `preview`: 22 named taps, not an anonymous dial', () => {
  it('the roster names EVERY reachable tap, in uOutMode order', () => {
    const opts = param('preview').options ?? [];
    // The value IS the shader's output-mode index, so the roster must be the
    // contiguous 0..21 run in order — not merely 22 entries in any arrangement.
    expect(opts.map((o) => o.value)).toEqual(
      Array.from({ length: colourofmagicDef.outputs.length }, (_, i) => i),
    );
    expect(opts.length).toBe(22);
    for (const o of opts) expect(o.label.trim().length).toBeGreaterThan(0);
    // None reads as a number — a numeric label is a value readout wearing a name.
    for (const o of opts) expect(Number.isNaN(Number(o.label)), o.label).toBe(true);
  });

  it('resolves a SELECTOR at the dock — past the button-row budget, deliberately', () => {
    const p = param('preview');
    expect((p.options ?? []).length).toBeGreaterThan(SEGMENTED_MAX_OPTIONS);
    expect(paramCellKind(p, NONE, 'dock', CELLS)).toBe('selector');
    // Every LANE tier keeps the dial, and it paints the NAME — a lane column
    // cannot hold a 22-row roster.
    expect(paramCellKind(p, NONE, 'lane', CELLS)).toBe('knob');
    expect(paintsReadout(p)).toBe(true);
    expect(knobNameReadout(0, p)).toBe('PASS');
    expect(knobNameReadout(1, p)).toBe('RGB');
    expect(knobNameReadout(21, p)).toBe('Cr');
  });

  it('NEGATIVE CONTROL — without the roster it is a 22-position ANONYMOUS dial', () => {
    const { options: _dropped, ...bare } = param('preview');
    const anon = bare as ParamDef;
    expect(paramCellKind(anon, NONE, 'dock', CELLS)).toBe('knob');
    expect(paramCellKind(anon, NONE, 'lane', CELLS)).toBe('knob');
    expect(paintsReadout(anon)).toBe(false);
    expect(knobNameReadout(7, anon)).toBeNull();
  });
});

describe('colourofmagic face — `freeze` is a HARNESS switch and must never paint', () => {
  it('is declared noUserControl, written internally', () => {
    const entry = (colourofmagicDef as unknown as {
      noUserControl?: readonly { param: string; writer: string; why: string }[];
    }).noUserControl?.find((e) => e.param === 'freeze');
    expect(entry, 'freeze must be declared noUserControl').toBeTruthy();
    expect(entry!.writer).toBe('internal');
    expect(entry!.why.length).toBeGreaterThan(40);
  });

  it("the claim is TRUE: no input port targets it", () => {
    // `writer: 'internal'` is a statement about the ports, so it is asserted
    // against them — the day a CV port targets `freeze` the declaration stops
    // being true and this goes red rather than quietly lying.
    const targeted = colourofmagicDef.inputs.filter(
      (p) => (p as { paramTarget?: string }).paramTarget === 'freeze',
    );
    expect(targeted).toEqual([]);
  });

  it('is NOT ranked — a face must not paint it', () => {
    expect(colourofmagicDef.face?.order).not.toContain('freeze');
    for (const page of colourofmagicDef.face?.pages ?? []) {
      expect(page.controls, `page '${page.id}'`).not.toContain('freeze');
    }
    // POSITIVE CONTROL: the same lookup DOES find the params that are ranked,
    // so "not ranked" is a finding rather than a broken accessor.
    expect(colourofmagicDef.face?.order).toContain('preview');
    expect(colourofmagicDef.face?.order).toContain('pal_r');
  });
});

describe('colourofmagic face — FIVE rendered bands, and no tab rail', () => {
  it('declares SIX pages and renders FIVE — the hero empties `output`', () => {
    const declared = colourofmagicDef.face?.pages ?? [];
    expect(declared.length).toBe(6);
    expect(declared[0]!.id).toBe('output');
    expect(declared[0]!.controls).toEqual(['preview']);

    const bands = dockFacePlan(colourofmagicDef as never);
    const plan = heroFacePlan(colourofmagicDef as never, bands);
    // `preview` is PROMOTED, not duplicated — a duplicate emits a second
    // control-preview and fails faces-parity's exact multiset.
    expect(plan.hero?.control?.key).toBe('preview');
    expect(plan.bands.map((b) => b.id)).toEqual(['rgb', 'ydbdr', 'hsv', 'yiq', 'ycc']);
    expect(plan.bands.length).toBe(5);
  });

  it('the emptied page declares NO hint — a hint nobody renders is worse than none', () => {
    const output = (colourofmagicDef.face?.pages ?? []).find((p) => p.id === 'output');
    expect((output as { hint?: string } | undefined)?.hint).toBeUndefined();
  });

  it('does NOT reach the tab rail — 37 params is not 37 BANDS', () => {
    const bands = dockFacePlan(colourofmagicDef as never);
    const plan = heroFacePlan(colourofmagicDef as never, bands);
    expect(plan.bands.length).toBeLessThan(DOCK_TAB_MIN_BANDS);
    // The distinction the rail actually turns on, asserted so nobody "fixes"
    // this by padding pages to seven.
    expect(colourofmagicDef.params.length).toBeGreaterThan(DOCK_TAB_MIN_BANDS);
  });
});

describe('colourofmagic face — the glyph is FORCED to none by the port types', () => {
  it('declares none, because a video def has no audio output to meter', () => {
    expect(colourofmagicDef.face?.glyph).toBe('none');
    expect(primaryAudioOutPortId(colourofmagicDef as never)).toBeNull();
    expect(colourofmagicDef.outputs.some((o) => o.type === 'audio')).toBe(false);
  });
});

describe('colourofmagic face — the REAR CARD is curated, and the DERIVED plan is why', () => {
  // ⚠ THE MEASUREMENT THAT JUSTIFIES THE CURATION, held permanently rather than
  // written in a comment. At 31x22 the derived plan drops all FIFTEEN
  // mono-override inputs into ONE undifferentiated `signal` section, because
  // only the `_cv` ports carry a `paramTarget` that projects them onto a page.
  const stripRear = () => ({
    ...colourofmagicDef,
    face: { ...colourofmagicDef.face, rear: undefined },
  }) as unknown as Parameters<typeof rearFieldPlan>[0];

  it('NEGATIVE CONTROL — derived, fifteen mono inputs land in ONE pile', () => {
    const plan = rearFieldPlan(stripRear());
    const signal = plan.inputs.find((s) => s.id === 'signal');
    expect(signal, 'a derived signal section must exist to be the problem').toBeTruthy();
    // 1 video IN + 15 mono overrides, with their block identity invisible.
    expect(signal!.holes.length).toBe(16);
  });

  it('CURATED — every block owns its own six holes (3 CV + 3 mono override)', () => {
    const plan = rearFieldPlan(colourofmagicDef as never);
    const byId = new Map(plan.inputs.map((s) => [s.id, s]));
    for (const block of ['rgb', 'ydbdr', 'hsv', 'yiq', 'ycc']) {
      expect(byId.get(block)?.holes.length, `input block ${block}`).toBe(6);
    }
    expect(byId.get('signal')?.holes.length, 'only the video IN remains').toBe(1);
    // Outputs group by PRODUCING BLOCK rather than one 22-hole slab.
    expect(plan.outputs.map((s) => s.id)).toEqual([
      'source', 'out_rgb', 'out_ydbdr', 'out_hsv', 'out_yiq', 'out_ycc',
    ]);
  });

  it('TOTALITY holds either way — no port becomes unreachable', () => {
    // The curation must not lose a jack. Both plans address every declared port
    // exactly once; that is the property, and it is asserted for BOTH so the
    // curation is shown to be a re-grouping rather than a filter.
    const declared = colourofmagicDef.inputs.length + colourofmagicDef.outputs.length;
    for (const plan of [rearFieldPlan(colourofmagicDef as never), rearFieldPlan(stripRear())]) {
      expect(plan.portCount).toBe(declared);
      expect(plan.portCount).toBe(53);
    }
  });
});

describe('colourofmagic face — SCREEN ON/OFF reaches the dock, and the CARD owns no roster', () => {
  const extDir = join(import.meta.dirname, 'colourofmagic');

  it('declares the fullViewBody extension the owner ruling requires', () => {
    // On a FACE the toggle cannot live on the card: promotion stops both
    // surfaces rendering it, which is the bug spirographs shipped (#1928).
    expect(colourofmagicDef.face?.extension).toBe('colourofmagic');
    const ext = readFileSync(join(extDir, 'shell-extension.ts'), 'utf-8');
    expect(ext).toMatch(/fullViewBody:\s*ColourofmagicOutputBody/);

    const body = readFileSync(join(extDir, 'ColourofmagicOutputBody.svelte'), 'utf-8');
    // State on the NODE, never component $state — it must survive the collapse
    // / LRU unmount, and it must reuse the key the card already persisted.
    expect(body).toMatch(/previewCollapsed/);
    expect(body).toMatch(/mutateNode\(/);
    expect(body).not.toMatch(/let previewCollapsed = \$state/);
    // ⚠ #2015: OFF stops the COPY, never the producer. The engine owns the
    // render; this component only blits, so there is no producer here to tear
    // down and the first frame back ON is current by construction.
    expect(body).toMatch(/blitOutputForPreview/);
  });

  it('the CARD no longer declares its own tap names (ONE roster, on the def)', () => {
    const card = readFileSync(join(import.meta.dirname, 'ColourofmagicCard.svelte'), 'utf-8');
    // The literal array is gone; the names come from the ParamDef both surfaces
    // read, so a rename cannot leave the card and the face disagreeing.
    expect(card).toMatch(/paramSpec\(colourofmagicDef, 'preview'\)\.options/);
    expect(card).not.toMatch(/'PASS',\s*'RGB'/);
  });
});

describe('colourofmagic face — the OVER switches are DERIVED, not typed', () => {
  it('the exported list is exactly the live `over_*` params', () => {
    // It backs colourofmagic's ACKNOWLEDGED_LATCHING entries, so a stale copy
    // would be fifteen dead exemptions. Anchored to the def by construction.
    const fromDef = colourofmagicDef.params
      .filter((p) => p.id.startsWith('over_'))
      .map((p) => p.id);
    expect([...COLOUROFMAGIC_OVER_PARAMS]).toEqual(fromDef);
    expect(COLOUROFMAGIC_OVER_PARAMS.length).toBe(15);
    // Every one is ranked, or face completeness would fail elsewhere with a
    // less obvious message.
    for (const id of COLOUROFMAGIC_OVER_PARAMS) {
      expect(colourofmagicDef.face?.order, id).toContain(id);
    }
  });
});
