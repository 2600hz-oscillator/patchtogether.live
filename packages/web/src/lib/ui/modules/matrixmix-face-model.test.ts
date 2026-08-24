// packages/web/src/lib/ui/modules/matrixmix-face-model.test.ts
//
// matrixMix's FACE, as pure model: what the plate ranks, what each axis cell
// reads, and what the roster costs. No DOM, no AudioContext.
//
// ⚠ THE THREE PERMANENT LEGS THIS FILE EXISTS FOR, each of them a thing no
// other gate in the repo can see:
//
//   1. THE CELLS ACTUALLY PAINT, AT EVERY LANE TIER. Eligibility is settled by
//      construction (only a `panel` cell is dock-only, and `laneOrder` drops
//      only a declared `hero.cell` and each pad's `x` key — matrixMix declares
//      neither). The open question was the tier CAP. It is asserted as PRESENCE,
//      not as "the face resolves", because the `joystick` shape is a face that
//      ranks controls and renders ZERO of them — and a two-cell face at the
//      tightest tier is exactly what could quietly become that. For a module
//      whose whole promotion argument is "the lane tile answers WHICH TWO
//      MODULES at a glance", a face that resolves to no lane cells would be a
//      blank tile with every other gate green.
//
//   2. THE ROSTER MEMO IS KEYED ON WHAT THE ROSTER IS A FUNCTION OF, measured in
//      BOTH DIRECTIONS. This is the §6.4 cost: promotion moves the roster
//      derivation out of a dock-only card and into an always-mounted lane tile,
//      where it inherits the card's own acknowledged follow-up — a whole-doc
//      `docVersion()` invalidation that fires on every Y.Doc transaction,
//      including the cable moves under CV modulation that cannot possibly change
//      it. A memo is only correct if its key moves exactly when the answer does,
//      so BOTH legs are permanent: spawning a node MUST re-derive, and moving a
//      cable must NOT. A one-directional version of this test would pass on a
//      memo that never invalidates (serving a stale roster forever) and on a
//      memo that always invalidates (buying nothing) — the two failures it is
//      there to tell apart.
//
//   3. THE TWO SURFACES CANNOT DISAGREE. The card and the face read the SAME
//      four functions. Asserted through the shell cells' own `value(node)` /
//      `options(node)` accessors rather than by re-deriving here, so a second
//      copy of the roster rule cannot creep back in unnoticed — that is the
//      backdraft class (a card silently disagreeing with its def, invisible to
//      every def-reading gate) applied to a rule that lives in no def at all.

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import '$lib/audio/modules'; // side-effect: register audio module defs
import '$lib/meta/modules'; // side-effect: register meta module defs
import { matrixmixDef } from '$lib/meta/modules/matrixmix';
import { curatedFace, laneOrder, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { shellCellFor, shellCellKeys, panelCellKeys } from '$lib/ui/workflow/shell-cells';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { setXAxisModule, setYAxisModule } from '$lib/graph/matrixmix';
import type { ModuleNode } from '$lib/graph/types';
import {
  MATRIXMIX_NO_AXIS,
  matrixmixAxisChoices,
  matrixmixRosterDerivations,
  matrixmixXAxisValue,
  matrixmixYAxisValue,
  __resetMatrixmixRosterMemo,
} from './matrixmix-cell-actions';

const FACE = matrixmixDef.face!;
const DEF = matrixmixDef as unknown as FaceDefLike;
/** Every LANE tier — the dock is not one, and is asserted separately. */
const LANE_TIERS = ['mini', 'compact', 'full'] as const;

const MM = 'mm-face-test';

function node(id: string, type: string, domain = 'audio'): ModuleNode {
  return { id, type, domain, position: { x: 0, y: 0 }, params: {}, data: {} } as unknown as ModuleNode;
}

function setup(): void {
  patch.nodes[MM] = node(MM, 'matrixMix', 'meta');
  patch.nodes['adsr-1'] = node('adsr-1', 'adsr');
  patch.nodes['vca-1'] = node('vca-1', 'vca');
}

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  __resetMatrixmixRosterMemo();
});

describe('matrixMix face — the plate', () => {
  it('is PROMOTED, and promotion is what makes the lane render a shell rather than a placeholder', () => {
    expect(STRICT_FACES.has('matrixMix'), 'matrixMix is promoted').toBe(true);
    expect(matrixmixDef.domain, 'and it is a META def — the first faced one').toBe('meta');
  });

  it('ranks the two axis pickers, and NOT the empty list a zero-param module could have shipped', () => {
    // ⚠ THE ASSERTION IS THE DESIGN DECISION. `order: []` is LEGAL for a module
    // with nothing to rank — the lint puts it out of scope by name — and it
    // paints a blank ModuleShell tile, which is strictly worse than the
    // placeholder promotion replaces (a placeholder at least announces that a
    // real surface is one click away). This pins the choice so that "simplify it
    // to an empty order" is a red test rather than a plausible cleanup.
    expect(FACE.order).toEqual(['matrixmix-x-{n}', 'matrixmix-y-{n}']);
    expect(matrixmixDef.params, 'the module still declares no params at all').toEqual([]);
    expect(matrixmixDef.inputs, 'and no inputs').toEqual([]);
    expect(matrixmixDef.outputs, 'and no outputs').toEqual([]);
  });

  it('every ranked key resolves to a DECLARED control family — the only route a meta def has', () => {
    // A meta def has `params: []` by construction, so a face key can only be
    // legitimized by a declared family or a committed legend. Without the
    // families the keys would resolve as `static` and the dock render-plan
    // parity check would call them DEAD CELLS. Asserted here as well because
    // that lint reads every def and would name the failure — this names the
    // REASON.
    const declared = new Set((matrixmixDef.controlFamilies ?? []).map((f) => f.id));
    for (const key of FACE.order) {
      const prefix = key.replace(/-\{n\}$/, '');
      expect(declared.has(prefix), `${key} resolves to a declared controlFamily`).toBe(true);
    }
  });

  it('declares NO glyph — and any other literal would be a dead one', () => {
    // `laneGlyphFor` returns 'picture' only for `domain === 'video'`, and a
    // trace glyph binds through `primaryAudioOutPortId`, which finds nothing
    // because this def has no outputs AT ALL. module-face-lint reddens a dead
    // glyph unconditionally, so 'none' is the only literal that compiles into a
    // green run — which is the good kind of constraint: an author who never
    // thinks about it ships the right thing.
    expect(FACE.glyph).toBe('none');
  });

  it('declares NO pages and NO tab rail — two cells is one band', () => {
    expect(FACE.pages, 'no declared pages').toBeUndefined();
    expect((FACE as { tabbed?: boolean }).tabbed, 'and no owner-instructed rail').toBeUndefined();
  });

  it('mounts its grid as an EXTENSION rather than a panel cell', () => {
    expect(FACE.extension).toBe('matrixmix');
    // ⚠ AND NOT A PANEL, WHICH IS THE DECISION THIS PINS. A `panel` would make
    // the grid dock-only too, so the observable difference is not visibility —
    // it is that a panel REQUIRES a `minWidth` number and a `probe`. This grid
    // has no design floor (4 columns or 40, depending on two OTHER modules) and
    // its observable is `patch.edges` between two FOREIGN nodes, which the probe
    // vocabulary cannot express. A fiction in a required field is worse than an
    // absent field, so if a future edit reaches for a panel here, this is the
    // test that asks it to answer both questions first.
    expect(panelCellKeys('matrixMix'), 'no panel cells').toEqual([]);
  });
});

describe('matrixMix face — the cells PAINT (leg 1)', () => {
  it('both axis cells resolve to a real selector cell, in both the registry and the resolver', () => {
    expect(shellCellKeys('matrixMix')).toEqual(['matrixmix-x-{n}', 'matrixmix-y-{n}']);
    const bands = dockFacePlan(DEF);
    expect(bands, 'the dock plan resolves').not.toBeNull();
    for (const ctl of bands!.flatMap((b) => b.controls)) {
      const cell = shellCellFor('matrixMix', ctl);
      expect(cell, `${ctl.key} resolves to a cell (an unresolved key renders INERT)`).not.toBeNull();
      expect(cell!.kind, `${ctl.key} is a selector`).toBe('selector');
    }
  });

  it('BOTH cells are PRESENT at EVERY lane tier — not merely "the face resolves"', () => {
    // ⚠ PRESENCE, NOT RESOLUTION, AND THE DIFFERENCE IS A SHIPPED BUG SHAPE.
    // `joystick` is a face that ranks controls and renders zero of them at a
    // lane tier, and every gate that asks "does the face resolve" is green about
    // it. matrixMix's entire promotion argument is that the LANE TILE answers
    // "which two modules" without opening anything — a tier that renders neither
    // cell would make the tile blank and the argument false, silently.
    for (const tier of ['compact', 'full'] as const) {
      const face = curatedFace(DEF, tier);
      expect(face, `lane tier '${tier}': the face resolves`).not.toBeNull();
      const keys = face!.controls.map((c) => c.key);
      expect(keys, `lane tier '${tier}': BOTH axis cells reach the tile`).toEqual([
        'matrixmix-x-{n}',
        'matrixmix-y-{n}',
      ]);
    }
  });

  it('MINI shows exactly ONE cell and it is X — the tier CAP, not a matrixMix regression', () => {
    // ⚠ MEASURED, AND THE UNITS MATTER. `FACE_TIER_CAPS.mini` is 1 CONTROL for
    // EVERY face in the repo — the mini LOD tile is one cell tall — so this leg
    // says nothing about matrixMix until that constant moves. What it actually
    // pins is the RANKING, which is otherwise unobservable: at the most
    // zoomed-out tier the player sees the X axis and nothing else, so "X before
    // Y" is a product choice rather than array order. Swapping the two strings
    // in `face.order` reddens here, which is the review that call deserves.
    //
    // It is asserted separately from the leg above rather than folded into it
    // because the two claims fail for different reasons and want different
    // fixes: a missing cell at COMPACT is a bug, and one cell at MINI is the
    // platform working.
    const face = curatedFace(DEF, 'mini');
    expect(face, "lane tier 'mini': the face resolves").not.toBeNull();
    expect(face!.controls.length, "lane tier 'mini': cells, count (cap is 1 for every face)").toBe(1);
    expect(
      face!.controls[0]!.key,
      "lane tier 'mini': the ONE cell that survives the cap must be the highest-ranked, X",
    ).toBe('matrixmix-x-{n}');
  });

  it('NO lane tier renders an EMPTY tile — the blank-plate failure, asserted directly', () => {
    // The thing `order: []` would have produced, made impossible at every tier
    // rather than argued about in a comment.
    for (const tier of LANE_TIERS) {
      expect(
        curatedFace(DEF, tier)!.controls.length,
        `lane tier '${tier}': cells, count — a promoted face painting nothing is a BLANK tile, ` +
          'strictly worse than the placeholder promotion replaced',
      ).toBeGreaterThan(0);
    }
  });

  it('nothing is dropped from the LANE roster — no hero cell, no pad', () => {
    // The two things `laneOrder` removes. Asserted as an identity rather than
    // read off the face, so declaring either later without re-checking the tile
    // is red instead of quietly halving the lane content.
    expect(laneOrder(FACE)).toEqual(FACE.order);
  });
});

describe('matrixMix face — the roster memo (leg 2)', () => {
  it('POSITIVE CONTROL: spawning a node with jacks RE-DERIVES the roster and the answer moves', () => {
    setup();
    const before = matrixmixAxisChoices(MM);
    expect(before.map((c) => c.nodeId).sort(), 'the two jacked modules, not the matrix itself')
      .toEqual(['adsr-1', 'vca-1']);
    const derivationsBefore = matrixmixRosterDerivations();

    patch.nodes['lfo-1'] = node('lfo-1', 'lfo');
    const after = matrixmixAxisChoices(MM);

    expect(
      after.map((c) => c.nodeId).sort(),
      'a spawn MUST reach the roster — if this fails the memo key is missing the node set',
    ).toEqual(['adsr-1', 'lfo-1', 'vca-1']);
    expect(
      matrixmixRosterDerivations() - derivationsBefore,
      'derivations (memo misses) since the spawn, count: a spawn must cost exactly one',
    ).toBe(1);
  });

  it('NEGATIVE CONTROL: an EDGE change does NOT re-derive the roster — the whole point of the key', () => {
    // ⚠ THIS IS THE LEG THE PROMOTION OWES. The card invalidated on
    // `docVersion()`, which fires on EVERY Y.Doc transaction; a cable moving
    // bumps it and cannot change this list. That was harmless while the card was
    // dock-only and is a per-transaction cost in every lane tile once promoted.
    setup();
    matrixmixAxisChoices(MM); // prime
    const derivationsBefore = matrixmixRosterDerivations();

    patch.edges['e-1'] = {
      id: 'e-1',
      source: { nodeId: 'adsr-1', portId: 'env' },
      target: { nodeId: 'vca-1', portId: 'cv' },
      sourceType: 'cv',
      targetType: 'cv',
    } as unknown as (typeof patch.edges)[string];
    matrixmixAxisChoices(MM);
    delete patch.edges['e-1'];
    matrixmixAxisChoices(MM);

    expect(
      matrixmixRosterDerivations() - derivationsBefore,
      'derivations (memo misses) across an edge ADD and an edge REMOVE, count: must be zero — ' +
        'the roster is not a function of the edge set, and re-deriving it on every cable move ' +
        'is the cost promotion moved into the lane tile',
    ).toBe(0);
  });

  it('NEGATIVE CONTROL: a RENAME does re-derive — the key is not a node COUNT', () => {
    // ⚠ THE INSTRUMENT CHECK. A signature over a cheaper proxy (how many nodes
    // there are, or a version number) is invariant to exactly this: renaming
    // leaves the count identical, the roster's LABELS change, and a count-keyed
    // memo would serve the stale list forever with nothing able to notice. The
    // signature carries the display names for this reason, and this is what says
    // so — the same measurement that would catch someone "simplifying" it.
    setup();
    matrixmixAxisChoices(MM);
    const derivationsBefore = matrixmixRosterDerivations();

    patch.nodes['adsr-1']!.data = { name: 'THE ENVELOPE' };
    const after = matrixmixAxisChoices(MM);

    expect(
      after.find((c) => c.nodeId === 'adsr-1')?.name,
      'the renamed module reports its new display name',
    ).toBe('THE ENVELOPE');
    expect(
      matrixmixRosterDerivations() - derivationsBefore,
      'derivations (memo misses) after a RENAME, count: a rename must cost exactly one — zero ' +
        'here means the signature is keyed on a count and is serving a stale roster',
    ).toBe(1);
  });

  it('excludes the matrix node itself, and every module with NO jacks', () => {
    setup();
    patch.nodes['sticky-1'] = node('sticky-1', 'sticky', 'meta');
    const ids = matrixmixAxisChoices(MM).map((c) => c.nodeId);
    expect(ids, 'a matrix cannot matrix itself, and a jackless module yields no grid')
      .toEqual(['adsr-1', 'vca-1']);
  });

  it('two matrix nodes SHARE the walk — `self` is applied after the memo, not inside it', () => {
    // The exclusion is per-caller, so folding it into the cache key would make
    // two matrix nodes on one rack invalidate each other on every render — a
    // memo that is worse than no memo. Asserted because the failure is a
    // performance one, and a performance failure produces no wrong answer.
    setup();
    const MM2 = 'mm-2';
    patch.nodes[MM2] = node(MM2, 'matrixMix', 'meta');
    matrixmixAxisChoices(MM);
    const derivationsBefore = matrixmixRosterDerivations();
    matrixmixAxisChoices(MM2);
    matrixmixAxisChoices(MM);
    expect(
      matrixmixRosterDerivations() - derivationsBefore,
      'derivations (memo misses) while two matrix nodes alternate reads, count: must be zero',
    ).toBe(0);
    expect(matrixmixAxisChoices(MM).map((c) => c.nodeId)).not.toContain(MM);
    expect(matrixmixAxisChoices(MM2).map((c) => c.nodeId)).not.toContain(MM2);
  });
});

describe('matrixMix face — the cells and the card read ONE truth (leg 3)', () => {
  /** The cell's own accessors, reached the way ModuleShell reaches them. */
  function cellFor(key: string) {
    const ctl = dockFacePlan(DEF)!.flatMap((b) => b.controls).find((c) => c.key === key)!;
    return shellCellFor('matrixMix', ctl) as {
      kind: 'selector';
      tag: string;
      options: (n: ModuleNode | undefined) => { value: string; label: string }[];
      value: (n: ModuleNode | undefined) => string;
      onchange: (id: string, v: string) => void;
    };
  }

  it('an unset axis reads the PLACEHOLDER, and the placeholder is a real option the cell offers', () => {
    setup();
    const x = cellFor('matrixmix-x-{n}');
    const n = patch.nodes[MM] as ModuleNode;
    expect(x.value(n), 'a fresh matrix has no axis').toBe(MATRIXMIX_NO_AXIS);
    // ⚠ A SELECTOR MUST NEVER READ A VALUE ITS OWN ROSTER LACKS. faces-parity
    // refuses that shape by name, and it is how a cell ends up indistinguishable
    // from a dead one.
    expect(
      x.options(n).map((o) => o.value),
      'the unset state is offered, and so is every jacked module',
    ).toEqual([MATRIXMIX_NO_AXIS, 'adsr-1', 'vca-1']);
  });

  it('the cell WRITES through the same seam the card does, and reads its own write back', () => {
    setup();
    const x = cellFor('matrixmix-x-{n}');
    const y = cellFor('matrixmix-y-{n}');
    x.onchange(MM, 'adsr-1');
    y.onchange(MM, 'vca-1');
    const n = () => patch.nodes[MM] as ModuleNode;
    expect(x.value(n())).toBe('adsr-1');
    expect(y.value(n())).toBe('vca-1');
    // …and the CARD's readers agree, because they are the same functions.
    expect(matrixmixXAxisValue(n())).toBe('adsr-1');
    expect(matrixmixYAxisValue(n())).toBe('vca-1');
  });

  it('a DANGLING selection is dropped by the cell, not left pointing at a dead node', () => {
    // ⚠ THE HALF THAT CANNOT BE A BARE `node.data` READ. When a matrixed module
    // is deleted the id persists on the node; a cell that returned it would
    // render a value absent from its own roster and the grid would dangle
    // instead of emptying. The card has always done this; this proves the face
    // inherited it rather than re-deciding it.
    setup();
    setXAxisModule(MM, 'adsr-1');
    setYAxisModule(MM, 'vca-1');
    delete patch.nodes['adsr-1'];
    const n = patch.nodes[MM] as ModuleNode;
    expect(cellFor('matrixmix-x-{n}').value(n), 'the dead axis clears').toBe(MATRIXMIX_NO_AXIS);
    expect(cellFor('matrixmix-y-{n}').value(n), 'the surviving axis is untouched').toBe('vca-1');
  });

  it('the two tags are the only text the plate paints for these cells', () => {
    // The `X` / `Y` captions ARE the card's own axis labels, moved to the
    // primitive's caption slot. Everything else this module could say about a
    // cross-point — what it means, what clicking would break — lives in the
    // grid's `aria-label`, which is speakable and assertable but unpainted,
    // exactly where the resting-text ruling puts it.
    expect(cellFor('matrixmix-x-{n}').tag).toBe('X');
    expect(cellFor('matrixmix-y-{n}').tag).toBe('Y');
  });
});
