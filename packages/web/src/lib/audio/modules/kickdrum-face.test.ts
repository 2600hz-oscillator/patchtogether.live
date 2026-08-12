// packages/web/src/lib/audio/modules/kickdrum-face.test.ts
//
// The PIN for KICK DRUM's curated face — the design decisions, projected
// through the same PURE selectors the shell renders from (`curatedFace`,
// `dockFacePlan`, `paramCellKind`, `shellCellFor`), so a later edit that
// undoes one of them fails HERE rather than in a screenshot.
//
// The registry-wide gates (module-face-lint, faces-parity) prove the face is
// WELL-FORMED — every param ranked, every cell operable, nothing rendered
// twice. They are structurally blind to whether it is the RIGHT shape: the
// tier ladder, the band story, and the two rules this module's face is built
// on (ranks 7+ never reach a lane; `level` is a saturation lever, not a fader)
// are all invisible to them. That is what this file holds.
//
// ⚠ NOT a restatement of the def. Every assertion below runs the def through a
// selector and checks the RESULT, so it fails on a change to the face OR to
// the selector semantics — the two-sided contract. `expect(order).toEqual([…])`
// would only have proved the file parses.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { kickdrumDef } from './kickdrum';
import {
  curatedFace,
  dockFacePlan,
  dockPlanControls,
  faceTierCap,
  LANE_PLATE_MAX_CELLS,
  type FaceDefLike,
} from '$lib/ui/workflow/curated-face';
import { paramCellKind, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { laneBodyPlan } from '$lib/ui/workflow/module-shell-model';
import { DOCK_TAB_MIN_BANDS, dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
import {
  activePresetId,
  faceAnnotationTally,
  faceAnnotations,
  facePageHeader,
  heroFacePlan,
  heroFacePlanIsTotal,
  presetWrites,
  readoutText,
  sidebarPlan,
  type FaceplateDefLike,
} from '$lib/ui/workflow/dock-faceplate-model';

const def = kickdrumDef as unknown as FaceDefLike;

/** The control KEYS a tier surfaces, in rank order. */
function keysAt(tier: 'mini' | 'compact' | 'full' | 'dock'): string[] {
  return (curatedFace(def, tier)?.controls ?? []).map((c) => c.key);
}

/** The declared ranking. */
function faceOrder(): readonly string[] {
  return kickdrumDef.face!.order;
}

describe('kickdrum face — the tier ladder (order = PRIORITY)', () => {
  it('mini shows TUNE alone: nothing about a kick is knowable before its pitch', () => {
    expect(keysAt('mini')).toEqual(['tune']);
  });

  it('compact adds SUB DEC beside the glyph — pitch, then pulse LENGTH', () => {
    const face = curatedFace(def, 'compact')!;
    expect(face.glyph, 'the compact tile keeps its live trace').toBe('scope');
    expect(faceTierCap('compact', true), 'a glyph-bearing compact tile fits two whole cells').toBe(2);
    expect(keysAt('compact')).toEqual(['tune', 'sub_decay']);
  });

  it('the plate is SIX cells and that is the WHOLE lane budget — rank 7+ reaches no lane tier', () => {
    const full = keysAt('full');
    expect(full).toEqual(['tune', 'sub_decay', 'drive', 'pitch_amt', 'body_level', 'click_level']);
    expect(full.length).toBe(LANE_PLATE_MAX_CELLS);

    // The claim that makes rank 7 dock-only, checked against the FIT PLAN
    // rather than restated: the plate renders exactly what the cap selects.
    const plan = laneBodyPlan(full.length, true, 'full');
    expect(plan.cellCount, 'the plate paints every selected cell (no silent truncation)').toBe(6);
    expect(plan.glyph, 'a ≥4-cell face needs both plate rows, so the glyph drops at this tier').toBe(false);

    // …and every rank past 6 is absent from EVERY lane tier.
    const tail = (kickdrumDef.face!.order as readonly string[]).slice(LANE_PLATE_MAX_CELLS);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const shown = new Set(keysAt(tier));
      for (const key of tail) {
        expect(shown.has(key), `${key} must not reach the '${tier}' lane tier`).toBe(false);
      }
    }
  });

  it('LEVEL is DOCK-ONLY on purpose — it is applied before the ceiling, so it is a saturation lever', () => {
    expect(keysAt('full')).not.toContain('level');
    expect(keysAt('dock')).toContain('level');
    // The reason is documented, not folklore — the doc gate keeps the prose
    // honest, so pin that the two agree.
    expect(kickdrumDef.docs!.controls!.level).toMatch(/applied BEFORE the ceiling/);
  });

  it('the audition ranks 7th: first rank that cannot reach a lane, and a BUTTON has no lane precedent', () => {
    const order = kickdrumDef.face!.order as readonly string[];
    expect(order[LANE_PLATE_MAX_CELLS]).toBe('kickdrum-strike-{n}');
  });
});

describe('kickdrum face — the dock bands (pages = FUNCTION)', () => {
  const plan = dockFacePlan(def)!;

  it('renders FIVE bands, in signal order, with no defensive __unpaged tail', () => {
    // FIVE, not six: the hero is a SLOT above the bands, not one more band of
    // knobs. A sixth band would also put this face one step from
    // DOCK_TAB_MIN_BANDS, where the whole faceplate collapses into a tab rail.
    expect(plan.map((b) => b.id)).toEqual(['sub', 'body', 'click', 'drive', 'dynamics']);
    expect(plan.map((b) => b.label)).toEqual([
      '1 · sub — the pulse',
      '2 · body — the punch',
      '3 · click — the edge',
      'bus · drive',
      'bus · dynamics · out',
    ]);
  });

  it('stays UNTABBED — a seventh band would hide most of the faceplate', () => {
    // The band count is a design ceiling, not an accident: `DOCK_TAB_MIN_BANDS`
    // is 7, so appending one more page silently converts this faceplate into a
    // tab rail (and moves every dock baseline). Pin the consequence, not the
    // number, by asking the same function DockFullView and ModuleShell ask.
    expect(plan.length).toBeLessThan(DOCK_TAB_MIN_BANDS);
    expect(dockTabPlan(plan), 'kickdrum reads as ONE scrolling column').toBeNull();
  });

  it('the three GENERATOR bands are numbered and described; the bus bands are not', () => {
    // The owner's finding was that a band header saying `sub` teaches nothing.
    // `1 sub · depth sine · mono` names the stage, what it is made of, and the
    // fact that makes WIDTH safe downstream.
    const labels = Object.fromEntries(plan.map((b) => [b.id, b.label]));
    const hints = Object.fromEntries(plan.map((b) => [b.id, b.hint]));
    expect(labels.sub).toMatch(/^1 · /);
    expect(labels.body).toMatch(/^2 · /);
    expect(labels.click).toMatch(/^3 · /);
    expect(labels.drive).toMatch(/^bus · /);
    expect(labels.dynamics).toMatch(/^bus · /);
    // ⚠ THE DESCRIPTION IS A SEPARATE FIELD, not a longer label. The two are
    // typeset differently (a name vs a sentence), and fusing them into one
    // string — as an earlier draft did — makes the header read as one shouted
    // run-on and gives the platform nothing to style.
    for (const id of ['sub', 'body', 'click', 'drive', 'dynamics'] as const) {
      expect(hints[id]!.length, `${id} carries a DESCRIPTION of its own`).toBeGreaterThan(0);
      expect(labels[id], `${id}'s label is not the hint fused on`).not.toContain(hints[id]!);
    }
  });

  it('the ONE bespoke cell is the hero PICTURE — the sidebar is platform data', () => {
    // An earlier draft declared a second panel for the right sidebar. That is
    // the shape this face was re-cut to remove: a sidebar is what every
    // faceplate wants, so it belongs to the platform, and only the picture no
    // amount of def introspection can synthesise stays a component.
    const cells = dockPlanControls(plan).filter(
      (c) => shellCellFor('kickdrum', c)?.kind === 'panel',
    );
    expect(cells.map((c) => c.key)).toEqual(['kickdrum-hero-{n}']);
    const strike = dockPlanControls(plan).find((c) => c.key === 'kickdrum-strike-{n}')!;
    expect(shellCellFor('kickdrum', strike)?.kind).toBe('action');
  });

  it('band 1 is the SUB LAYER alone — the audition moved up to the hero, not away', () => {
    const sub = plan[0]!;
    expect(sub.controls.map((c) => c.key)).toEqual([
      'kickdrum-hero-{n}', 'kickdrum-strike-{n}', 'tune',
      'sub_decay', 'sub_level', 'sub_eq', 'translate',
    ]);
    // …BEFORE the hero split. The three promoted keys are still band members
    // in the raw plan — `heroFacePlan` is what lifts them out, and asserting
    // this here is what makes the promotion test below a real MOVE rather than
    // an assertion about a band that never had them.
  });

  it('the merged dynamics·out band carries its split as CLUSTERS, not as a sixth band', () => {
    const dyn = plan[4]!;
    expect(dyn.controls, 'every cell is claimed by a cluster').toEqual([]);
    expect(dyn.clusters.map((c) => c.label)).toEqual(['transient · glue', 'level · width · ceiling']);
    expect(dyn.clusters[0]!.controls.map((c) => c.key)).toEqual(['attack', 'sustain', 'glue']);
    expect(dyn.clusters[1]!.controls.map((c) => c.key)).toEqual(['level', 'width', 'ceiling']);
  });

  it('…and that split is the DSP’s ACTUAL chain order, read from the worklet source', () => {
    // ⚠ THE ASSERTION ABOVE, ALONE, PINS WHATEVER THE DEF SAYS. It shipped
    // pinning `[attack, sustain, glue, CEILING]` + `[width, LEVEL]` against a
    // def comment claiming the chain is "transient → glue → ceiling → stereo →
    // level". The DSP does the opposite at both ends, so the faceplate taught a
    // producer that raising LEVEL escapes the clipper — it feeds it
    // (`tanh(g · 10^(level/20) · …)`, i.e. more saturation, the exact misuse
    // the ranking exists to prevent). A restatement of the def cannot catch a
    // wrong def; reading the other side of the contract can.
    const dspSrc = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/kickdrum-dsp.ts', import.meta.url)),
      'utf8',
    );
    // LEVEL: the last line of the voice step. CEILING: the tanh in the stereo
    // wrapper, applied to the level-scaled mid AND side.
    const levelAt = dspSrc.indexOf('const lin = Math.pow(10, clamp(p.level');
    const ceilAt = dspSrc.indexOf('out[0] = Math.tanh(g * (m + sd))');
    expect(levelAt, 'the level line moved — re-anchor this gate on the real expression').toBeGreaterThan(0);
    expect(ceilAt, 'the ceiling line moved — re-anchor this gate').toBeGreaterThan(0);
    expect(levelAt, 'LEVEL is applied BEFORE the ceiling in the worklet').toBeLessThan(ceilAt);
    expect(
      dspSrc.slice(ceilAt - 200, ceilAt),
      'the side term is scaled by the LEVEL linear gain, so width sits between them',
    ).toContain('s.sideOut * lin * clamp(p.width');

    // …and the faceplate's out-cluster teaches exactly that order.
    const out = plan[4]!.clusters[1]!.controls.map((c) => c.key);
    expect(out.indexOf('level')).toBeLessThan(out.indexOf('width'));
    expect(out.indexOf('width')).toBeLessThan(out.indexOf('ceiling'));
  });

  it('each band-EQ stays with the LAYER it shapes (the face’s best existing idea)', () => {
    const bandOf = (key: string) =>
      plan.find((b) => dockPlanControls([b]).some((c) => c.key === key))?.id;
    expect(bandOf('sub_eq')).toBe('sub');
    expect(bandOf('body_eq')).toBe('body');
    expect(bandOf('attack_eq')).toBe('click');
    // …and TRANSLATE is a SUB control: it taps a copy of the raw sub layer
    // pre-drive and reconstructs its harmonics.
    expect(bandOf('translate')).toBe('sub');
  });

  it('the dock paints all 28 cells: 25 params + the audition + the two panels, each exactly once', () => {
    const flat = dockPlanControls(plan);
    expect(flat).toHaveLength(kickdrumDef.params.length + kickdrumDef.controlFamilies!.length);
    expect(new Set(flat.map((c) => c.key)).size).toBe(flat.length);
    expect(flat.filter((c) => c.kind === 'param')).toHaveLength(kickdrumDef.params.length);
    // Every family resolves to a REAL cell spec — the inert-cell class (a
    // dashed label that both gates fail on) cannot creep back in.
    for (const ctl of flat.filter((c) => c.kind === 'family')) {
      expect(shellCellFor('kickdrum', ctl), `no shell cell for '${ctl.key}'`).toBeDefined();
    }
  });

  it('the REAR renders every band exactly once, and no page claims the LEADING slot', async () => {
    // ⚠ THIS USED TO FORBID *ANY* page id matching a curated rear group id,
    // which is the opposite of the mechanism. `rear-card-model`'s page loop
    // does `curatedGroups.find(gr => gr.id === page.id)` and lets that group
    // CLAIM the page's slot — its label wins, `usedGroupIds` stops the
    // extra-curated loop re-adding it, and exactly one band renders. That is
    // how a page band gets a rear-specific heading at all, and this module now
    // relies on it (`sub` → `sub · the layer`, so the rear does not show two
    // bands both headed STRIKE). tidyVco shares `oscillator` the same way.
    //
    // The real double-render trap is a page id equal to the LEADING derived
    // band — 'voice'/'signal' — which is pushed BEFORE the page loop and is not
    // in `curatedGroups`, so nothing claims it. So: assert the property that
    // actually matters (each band id once) and forbid only the leading ids.
    const { rearFieldPlan } = await import('$lib/ui/workflow/rear-card-model');
    const bands = rearFieldPlan(kickdrumDef as never).bands;
    const ids = bands.map((b) => b.id);
    expect(new Set(ids).size, `a band rendered twice: ${ids.join(', ')}`).toBe(ids.length);
    for (const b of plan) {
      expect(['voice', 'signal'], `page '${b.id}' would claim the leading derived band`).not.toContain(b.id);
    }
  });

  it('the REAR re-heads the sub band so two bands are not both read as STRIKE', async () => {
    // The mispatch this closes, on the module it was found on (the
    // registry-wide version lives in module-face-lint). The front page is
    // `strike · the pulse` because it holds the strike BUTTON; the rear band
    // with the same id holds five sub-layer CVs whose first hole is `tune_cv`,
    // sitting directly under the band that IS the strike. A gate patched into
    // the wrong one detunes the drum instead of hitting it.
    const { rearFieldPlan } = await import('$lib/ui/workflow/rear-card-model');
    const bands = rearFieldPlan(kickdrumDef as never).bands;
    const byId = new Map(bands.map((b) => [b.id, b]));
    expect(byId.get('voice')!.label).toBe('strike');
    expect(byId.get('sub')!.label).toBe('sub · the layer');
    expect(byId.get('sub')!.holes[0]!.portId, 'the hole a mis-read STRIKE would hit').toBe('tune_cv');
    const labels = bands.map((b) => (b.label ?? '').toLowerCase());
    for (const a of labels) {
      for (const b of labels) {
        if (a !== b) expect(b.startsWith(a), `'${a}' heads '${b}'`).toBe(false);
      }
    }
  });
});

describe('kickdrum face — the primitives each cell resolves to', () => {
  const momentary = momentaryParamIds(kickdrumDef);

  it('HARD paints a <Toggle>, not a rotary printing 0.00', () => {
    const hard = kickdrumDef.params.find((p) => p.id === 'hard')!;
    expect(paramCellKind(hard, momentary, 'dock')).toBe('toggle');
    // ⚠ THE `'lane'` HALF USED TO BE ASSERTED HERE AS "at BOTH tiers", and it
    // was VACUOUS FOR THIS MODULE: `hard` is rank ~20 and this same file proves
    // (below) that rank 7+ reaches no lane tier, so the lane path it exercised
    // is one kickdrum never takes. It pinned the primitive registry, not this
    // face. The registry-wide claim belongs to shell-control-kind's own test;
    // what THIS file can honestly say is that the cell kickdrum actually
    // renders is a toggle, and that the lane never has to render it at all.
    expect(faceOrder().indexOf('hard')).toBeGreaterThanOrEqual(faceTierCap('full', true));
    expect(keysAt('full')).not.toContain('hard');
  });

  it('every other param stays a knob — this voice declares no momentary pad and no grid', () => {
    expect(kickdrumDef.face!.momentary ?? []).toEqual([]);
    expect(kickdrumDef.face!.paramCells ?? {}).toEqual({});
    for (const p of kickdrumDef.params) {
      if (p.id === 'hard') continue;
      expect(paramCellKind(p, momentary, 'dock'), `${p.id} renders as a knob`).toBe('knob');
    }
  });

  it('the audition resolves to a live ACTION cell — never the inert placeholder', () => {
    const ctl = curatedFace(def, 'dock')!.controls.find((c) => c.key === 'kickdrum-strike-{n}')!;
    const cell = shellCellFor('kickdrum', ctl);
    expect(cell, 'an unregistered family key renders an INERT cell and fails both gates').not.toBeNull();
    expect(cell!.kind).toBe('action');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PF-20 — THE FACEPLATE STRUCTURE (kickdrum is the platform's first adopter)
// ─────────────────────────────────────────────────────────────────────────
//
// module-face-lint proves this face's hero/sidebar are WELL-FORMED — every key
// ranked, every preset in range, the split total. It is structurally blind to
// whether the declarations are TRUE about this drum, which is what follows.

describe('kickdrum faceplate structure — the hero PROMOTES, it does not copy', () => {
  const heroPlan = dockFacePlan(def)!;
  const split = heroFacePlan(kickdrumDef as unknown as FaceplateDefLike, heroPlan);

  it('the PICTURE, TUNE and the audition leave their band and land in the hero, once each', () => {
    expect(split.hero?.cell?.key).toBe('kickdrum-hero-{n}');
    expect(split.hero?.control?.key).toBe('tune');
    expect(split.hero?.action?.key).toBe('kickdrum-strike-{n}');
    const stillInBands = dockPlanControls(split.bands).map((c) => c.key);
    expect(stillInBands, 'the picture is not rendered twice').not.toContain('kickdrum-hero-{n}');
    expect(stillInBands, 'TUNE is not rendered twice').not.toContain('tune');
    expect(stillInBands, 'the audition is not rendered twice').not.toContain('kickdrum-strike-{n}');
    expect(heroFacePlanIsTotal(heroPlan, split), 'nothing dropped, nothing duplicated').toBe(true);
  });

  it('the SUB band survives the promotion with its remaining layer controls', () => {
    // A hero that emptied its source band would be a design mistake, not just
    // an arithmetic one: band 1 would render as a bare header.
    const sub = split.bands.find((b) => b.id === 'sub')!;
    expect(sub.controls.map((c) => c.key)).toEqual(['sub_decay', 'sub_level', 'sub_eq', 'translate']);
  });

  it('the hero readouts print the MOCK\u2019s numbers — and TAIL is DERIVED, not a knob', () => {
    // The mock bakes `tail ≈ 480 ms · +24 st → 50 Hz` into the picture. Baked
    // strings are how a faceplate prints 480 while the knob under it reads 450,
    // so all three are live.
    //
    // ⚠ BUT `tail` IS NOT `sub_decay`. An earlier draft declared exactly that,
    // and it printed `450 ms` here — a number that moves with SUB DEC, looks
    // completely right, and is INVARIANT to SUB LEVEL, which genuinely changes
    // how long this drum rings. The voice's real −60 dB tail is 398 ms. This
    // assertion is the difference between the two models, in one line.
    const read = (pid: string) => kickdrumDef.params.find((p) => p.id === pid)?.defaultValue;
    const printed = (split.hero?.readouts ?? []).map(
      (r) => `${r.label} ${readoutText(r, kickdrumDef.params, read)}`,
    );
    expect(printed).toEqual(['tail 398 ms', 'sweep +24 st', 'settles to 50 Hz']);
    expect(printed[0], 'the blind model printed 450 ms here').not.toContain('450');
  });

  it('the hero also promotes the module\u2019s own PICTURE, which is the mock\u2019s top strip', () => {
    // The single element whose absence got the delivered face rejected. It is a
    // panel cell, promoted — so it renders in the hero and nowhere else.
    const cell = split.hero?.cell;
    expect(cell?.key).toBe('kickdrum-hero-{n}');
    expect(shellCellFor('kickdrum', cell!)?.kind).toBe('panel');
  });
});

describe('kickdrum faceplate structure — the sidebar says what the DSP does', () => {
  const blocks = sidebarPlan(kickdrumDef as unknown as FaceplateDefLike)!;

  it('paints three blocks: the crossover picture, the presets, the output', () => {
    expect(blocks.map((b) => b.kind)).toEqual(['custom', 'presets', 'readouts']);
  });

  it('the CROSSOVER picture draws the DSP’s ACTUAL split, read from the worklet source', () => {
    // ⚠ The "a card silently disagrees with its def" guard, applied to a
    // picture. Nothing at runtime can see that the panel draws 120 Hz while
    // the filter runs at some other frequency — the panel takes the number
    // from a declaration, and a declaration is free to drift. So read the
    // other side of the contract: the DSP's own exported constant.
    const dspSrc = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/kickdrum-dsp.ts', import.meta.url)),
      'utf8',
    );
    //
    // Anchored on the FILTER CALL, exactly like the level/ceiling gate above
    // anchors on `out[0] = Math.tanh(...)`. Exporting a named constant from the
    // worklet lib and importing it here would read better, and it is the wrong
    // trade: `kickdrum-dsp.ts` is inside TWO ART source-SHA pins (this module's
    // own profile and grand-integration's combined master), so a comment-level
    // edit to it costs two baseline re-pins for zero audio change. Reading the
    // source is free and just as strong.
    const m = dspSrc.match(/updateHighpass\(s\.sideHp,\s*(\d+(?:\.\d+)?),\s*sr\)/);
    expect(m, 'the side high-pass call moved — re-anchor this gate on the real expression').not.toBeNull();
    const dspSplit = Number(m![1]);
    // BOTH cascaded stages must sit at that frequency, or "the split" is two
    // splits and the picture can only be drawing one of them.
    expect(dspSrc, 'the 4th-order pair is at ONE frequency').toContain(
      `updateHighpass(s.sideHp2, ${dspSplit}, sr)`,
    );

    const xover = blocks.find((b) => b.kind === 'custom')!;
    if (xover.kind !== 'custom') throw new Error('unreachable');
    expect(xover.panelId).toBe('stereo-crossover');
    expect(xover.props?.splitHz, `the faceplate must draw the DSP's ${dspSplit} Hz split`).toBe(dspSplit);
    // …and the width param it opens the sides with is a real param.
    expect(kickdrumDef.params.some((p) => p.id === xover.props?.widthParam)).toBe(true);
  });

  it('every preset is a REAL, in-range setting of this drum — never a decorative row', () => {
    const presets = blocks.find((b) => b.kind === 'presets')!;
    if (presets.kind !== 'presets') throw new Error('unreachable');
    expect(presets.entries.map((e) => e.label)).toEqual([
      'DEEP CLUB',
      'TECHNO PUNCH',
      '909 CLASSIC',
      'SUB BOOM',
      'LO-FI THUMP',
    ]);
    for (const e of presets.entries) {
      const writes = presetWrites(e.values, kickdrumDef.params);
      // Every declared key survives (none dropped as unknown) and none was
      // clamped — a clamped preset applies a value it does not name.
      expect(writes.map((w) => w.paramId).sort(), `${e.id}: every key is a real param`).toEqual(
        Object.keys(e.values).sort(),
      );
      for (const w of writes) {
        expect(w.value, `${e.id}.${w.paramId} was clamped`).toBe(e.values[w.paramId]);
      }
      // …and each one is DISTINCT from the defaults, so selecting it does
      // something audible.
      const changed = writes.filter(
        (w) => w.value !== kickdrumDef.params.find((p) => p.id === w.paramId)!.defaultValue,
      );
      expect(changed.length, `${e.id}: selecting it must change the sound`).toBeGreaterThan(0);
    }
  });

  it('the presets’ TUNE values are the numbers their names promise', () => {
    // The note beside each row is the claim; this is the check. A row reading
    // "DEEP CLUB · 50 Hz" that tunes to 70 is the same lie class as a knob
    // whose range disagrees with its def.
    const presets = blocks.find((b) => b.kind === 'presets')!;
    if (presets.kind !== 'presets') throw new Error('unreachable');
    const byId = Object.fromEntries(presets.entries.map((e) => [e.id, e]));
    expect(byId['deep-club']!.values.tune).toBe(50);
    expect(byId['909-classic']!.values.tune).toBe(62);
    expect(byId['sub-boom']!.values.tune).toBe(38);
    // The two whose notes name a CHARACTER rather than a pitch drive HARD.
    expect(byId['techno-punch']!.values.hard).toBe(1);
    expect(byId['lo-fi-thump']!.values.hard).toBe(1);
  });

  it('a fresh kickdrum sits on NO preset — the list starts honest', () => {
    const presets = blocks.find((b) => b.kind === 'presets')!;
    if (presets.kind !== 'presets') throw new Error('unreachable');
    const read = (pid: string) => kickdrumDef.params.find((p) => p.id === pid)?.defaultValue;
    expect(activePresetId(presets.entries, read)).toBeNull();
    // …and selecting one lights exactly it (the round trip, so the write path
    // and the match predicate are pinned against each other rather than each
    // being asserted alone).
    for (const e of presets.entries) {
      const after: Record<string, number> = Object.fromEntries(
        kickdrumDef.params.map((p) => [p.id, p.defaultValue]),
      );
      for (const w of presetWrites(e.values, kickdrumDef.params)) after[w.paramId] = w.value;
      expect(activePresetId(presets.entries, (pid) => after[pid]), `${e.id} lights itself`).toBe(e.id);
    }
  });
});

describe('kickdrum faceplate structure — the page header + band hints', () => {
  it('the faceplate header is ANNOTATION IN FULL — title as well as sentence', () => {
    // ⚠ BOTH ARE STILL AUTHORED ON THE DEF — they are living-docs content and
    // they are what the annotate toggle reveals. What changed (owner,
    // 2026-08-02) is only whether the CARD paints them at rest: "no 'voice' etc
    // section, no text on the module". Nothing was deleted from the def, so
    // this asserts the prose exists and is good, AND that the resting faceplate
    // withholds all of it.
    const head = facePageHeader(kickdrumDef as unknown as FaceplateDefLike, true)!;
    expect(head.title).toBe('Voice');
    expect(head.hint).toMatch(/three decoupled generators/i);
    // The hint must name the actual chain, not a generic blurb.
    expect(head.hint).toMatch(/sub, body and click/i);

    expect(
      facePageHeader(kickdrumDef as unknown as FaceplateDefLike),
      'at rest the faceplate paints NO header at all — the module name is the ' +
        'dock title bar’s job, and “Voice” is a description of the page',
    ).toBeNull();
  });

  it('…and BOTH are in the annotation roster, so the toggle can reach them', () => {
    // The failure this forecloses: the title paints only behind the switch, so
    // a roster that did not count it could leave a face offering no switch and
    // a title reachable in no state of the UI.
    const kinds = faceAnnotations(kickdrumDef as unknown as FaceplateDefLike).map((a) => a.kind);
    expect(kinds.filter((k) => k === 'title')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'page-hint')).toHaveLength(1);
    expect(
      faceAnnotationTally(kickdrumDef as unknown as FaceplateDefLike),
      'five bands each describe themselves (asserted below), plus the title and the sentence',
    ).toEqual({ title: 1, pageHint: 1, bandHints: 5, total: 7 });
  });

  it('every band header carries a description, and each names its GENERATOR', () => {
    const hints = Object.fromEntries((kickdrumDef.face!.pages ?? []).map((p) => [p.id, p.hint ?? '']));
    expect(Object.values(hints).every((h) => h.length > 0), 'all five bands describe themselves').toBe(true);
    expect(hints.sub).toMatch(/sine/i);
    expect(hints.body).toMatch(/sweep/i);
    expect(hints.click).toMatch(/noise/i);
    expect(hints.drive).toMatch(/saturation/i);
    // The dynamics hint teaches the DSP's real order — the same chain the
    // cluster split above pins against the worklet source.
    expect(hints.dynamics).toBe('transient → glue → level → width → ceiling, in that order');
  });

  it('this face is UNDER the tab threshold, so its band hints actually render', () => {
    // A hint on a tabbed face is dead metadata (module-face-lint fails it).
    // Five bands is under DOCK_TAB_MIN_BANDS, so the headers paint.
    expect(dockTabPlan(dockFacePlan(def))).toBeNull();
  });
});
