// packages/web/src/lib/ui/cable-leg-groups.test.ts
//
// ONE BEZIER PER LEG GROUP, and the dashed only-L/R verdict.
//
// The two ways this can fail are opposite and both silent:
//   * TWO renderers for one group → a visually doubled cable;
//   * ZERO renderers → a live cable that is invisible, and therefore
//     undeletable (nothing to select, nothing to Backspace).
// So every case here asserts the render count as well as the classification,
// and there is a property test over the whole fixture set that says "exactly
// one renderer per group, always".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Edge } from '$lib/graph/types';
import type { StereoDef } from '$lib/graph/stereo-autowire';
import { computeLegGroups, LEG_KEY_SEP } from './cable-leg-groups';

describe('the composite-key separator is an ESCAPE, not a raw byte', () => {
  // A literal NUL in the source makes git classify the whole FILE as binary:
  // `git diff` shows `Bin 0 -> 8980 bytes` instead of a line diff, so nobody
  // can review it — including the owner — a merge conflict in it is
  // unresolvable, and `git blame` / grep / code search skip it. This shipped
  // once; the value is correct, only its spelling was wrong.
  const SOURCE = readFileSync(
    fileURLToPath(new URL('./cable-leg-groups.ts', import.meta.url)),
    'utf8',
  );

  it('the separator VALUE is NUL (unforgeable — no id can contain one)', () => {
    expect(LEG_KEY_SEP).toBe('\u0000');
    expect(LEG_KEY_SEP).toHaveLength(1);
  });

  it('the SOURCE FILE contains no raw NUL byte', () => {
    // Anchored to the artifact: reads the file off disk, so it fails on the
    // spelling regardless of what the module exports.
    const at = SOURCE.indexOf('\u0000');
    expect(
      at,
      at < 0
        ? ''
        : `raw NUL at offset ${at} — write '\\u0000' instead: ` +
          `${JSON.stringify(SOURCE.slice(Math.max(0, at - 40), at + 20))}`,
    ).toBe(-1);
  });

  it('the vacuity control: the test really is reading THIS file', () => {
    // Without this, a bad path would make the check above pass on an empty
    // string forever.
    expect(SOURCE).toContain('export function computeLegGroups');
    expect(SOURCE).toContain("export const LEG_KEY_SEP = '\\u0000';");
  });
});

const STEREO_SRC: StereoDef = {
  type: 'src',
  inputs: [],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
};
const STEREO_DST: StereoDef = {
  type: 'dst',
  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
  ],
  outputs: [],
};
const MONO_SRC: StereoDef = {
  type: 'monosrc',
  inputs: [],
  outputs: [{ id: 'audio', type: 'audio' }],
};
const MONO_DST: StereoDef = {
  type: 'monodst',
  inputs: [{ id: 'audio', type: 'audio' }],
  outputs: [],
};
const CV_SRC: StereoDef = {
  type: 'cvsrc',
  inputs: [],
  outputs: [
    { id: 'env_l', type: 'cv' },
    { id: 'env_r', type: 'cv' },
  ],
};
const CV_DST: StereoDef = {
  type: 'cvdst',
  inputs: [
    { id: 'cv_l', type: 'cv' },
    { id: 'cv_r', type: 'cv' },
  ],
  outputs: [],
};

const DEFS: Record<string, StereoDef> = {
  a: STEREO_SRC,
  a2: STEREO_SRC,
  b: STEREO_DST,
  m: MONO_SRC,
  n: MONO_DST,
  cv: CV_SRC,
  cvd: CV_DST,
};
const defForNode = (nodeId: string): StereoDef | undefined => DEFS[nodeId];

function edge(from: string, fromPort: string, to: string, toPort: string): Edge {
  return {
    id: `e-${from}-${fromPort}-${to}-${toPort}`,
    source: { nodeId: from, portId: fromPort },
    target: { nodeId: to, portId: toPort },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

/** The ids that would actually be drawn, in input order. */
function rendered(edges: Edge[]): string[] {
  const groups = computeLegGroups(edges, defForNode);
  return edges.filter((e) => groups.get(e.id)?.render !== false).map((e) => e.id);
}
function soloOf(edges: Edge[], id: string) {
  return computeLegGroups(edges, defForNode).get(id)?.soloChannel ?? null;
}

describe('computeLegGroups — one cable per group', () => {
  it('stereo → stereo: two legs, ONE bezier, drawn by the LEFT leg', () => {
    const edges = [edge('a', 'out_l', 'b', 'in_l'), edge('a', 'out_r', 'b', 'in_r')];
    expect(rendered(edges)).toEqual(['e-a-out_l-b-in_l']);
    expect(soloOf(edges, 'e-a-out_l-b-in_l')).toBeNull();
    expect(computeLegGroups(edges, defForNode).get('e-a-out_l-b-in_l')!.groupIds).toEqual([
      'e-a-out_l-b-in_l',
      'e-a-out_r-b-in_r',
    ]);
  });

  it('order-independent: the right leg listed FIRST still yields one bezier', () => {
    const edges = [edge('a', 'out_r', 'b', 'in_r'), edge('a', 'out_l', 'b', 'in_l')];
    expect(rendered(edges)).toEqual(['e-a-out_l-b-in_l']);
  });

  it('mono → stereo double-patch: both legs from ONE output, one bezier', () => {
    const edges = [edge('m', 'audio', 'b', 'in_l'), edge('m', 'audio', 'b', 'in_r')];
    expect(rendered(edges)).toEqual(['e-m-audio-b-in_l']);
  });

  it('stereo → MONO dual-mono: both legs into one input, one bezier', () => {
    const edges = [edge('a', 'out_l', 'n', 'audio'), edge('a', 'out_r', 'n', 'audio')];
    expect(rendered(edges)).toEqual(['e-a-out_l-n-audio']);
  });

  it('a CROSS patch (out_l→in_r) is still ONE group with its mirror', () => {
    const edges = [edge('a', 'out_l', 'b', 'in_r'), edge('a', 'out_r', 'b', 'in_l')];
    // The source side names the channel, so out_l→in_r is the 'left' leg.
    expect(rendered(edges)).toEqual(['e-a-out_l-b-in_r']);
  });
});

describe('computeLegGroups — the dashed only-L/R verdict', () => {
  it('a lone LEFT leg is soloChannel left', () => {
    const edges = [edge('a', 'out_l', 'b', 'in_l')];
    expect(rendered(edges)).toEqual(['e-a-out_l-b-in_l']);
    expect(soloOf(edges, 'e-a-out_l-b-in_l')).toBe('left');
  });

  it('a lone RIGHT leg is soloChannel right — AND still renders', () => {
    // The failure that would be invisible: if the right leg only ever rendered
    // as a partner, an only-R cable would vanish from the canvas.
    const edges = [edge('a', 'out_r', 'b', 'in_r')];
    expect(rendered(edges)).toEqual(['e-a-out_r-b-in_r']);
    expect(soloOf(edges, 'e-a-out_r-b-in_r')).toBe('right');
  });

  it('a LEGACY mono→one-leg edge (the pre-leg-group rack shape) reads as only-L', () => {
    // `vca.audio → audioOut.L` with no R sibling. Audio-identical to what it
    // always was; the dashes are the app finally saying half the image is dead.
    const edges = [edge('m', 'audio', 'b', 'in_l')];
    expect(soloOf(edges, 'e-m-audio-b-in_l')).toBe('left');
  });

  it('a MONO→MONO audio cable is never dashed', () => {
    const edges = [edge('m', 'audio', 'n', 'audio')];
    expect(rendered(edges)).toEqual(['e-m-audio-n-audio']);
    expect(soloOf(edges, 'e-m-audio-n-audio')).toBeNull();
  });

  it('a CV L/R pair is never a leg group — cv is not audio', () => {
    // The audio-only rule, seen from the cable layer: two cv cables stay two
    // cables and neither is dashed.
    const edges = [edge('cv', 'env_l', 'cvd', 'cv_l'), edge('cv', 'env_r', 'cvd', 'cv_r')];
    expect(rendered(edges)).toHaveLength(2);
    expect(soloOf(edges, 'e-cv-env_l-cvd-cv_l')).toBeNull();
  });

  it('the group loses its dashes the moment the sibling appears, and regains them when it goes', () => {
    // The reason `solo` is part of Canvas's FlowEdge reuse key: this verdict
    // changes without THIS edge's record changing at all.
    const l = edge('a', 'out_l', 'b', 'in_l');
    expect(soloOf([l], l.id)).toBe('left');
    expect(soloOf([l, edge('a', 'out_r', 'b', 'in_r')], l.id)).toBeNull();
    expect(soloOf([l], l.id)).toBe('left');
  });
});

describe('computeLegGroups — the two pair lists are asked DIFFERENT questions', () => {
  // `rings` declares ['odd','even'] and is COLLAPSE_EXEMPT: one WIRING pair,
  // NOT one stereo image. Both halves of that distinction are load-bearing and
  // both failures render as a plausible-looking cable.
  const RINGS: StereoDef = {
    type: 'rings',
    inputs: [{ id: 'in', type: 'audio' }],
    outputs: [
      { id: 'odd', type: 'audio' },
      { id: 'even', type: 'audio' },
    ],
    stereoPairs: [['odd', 'even']],
  };
  const defs = (n: string) => (n === 'rings' ? RINGS : n === 'b' ? STEREO_DST : MONO_DST);

  it('GROUPING uses the WIRING list: rings odd+even auto-wired is ONE cable', () => {
    // If this drew two cables, deleting "the cable" (which expands leg groups)
    // would remove a bezier the user never selected.
    const edges = [edge('rings', 'odd', 'b', 'in_l'), edge('rings', 'even', 'b', 'in_r')];
    const groups = computeLegGroups(edges, defs);
    expect(edges.filter((e) => groups.get(e.id)!.render)).toHaveLength(1);
  });

  it('the SOLO TAG uses the COLLAPSE list: a lone rings.odd is NOT dashed and NOT "L"', () => {
    // odd and even are two TIMBRES. "Only L" would be a lie about that jack,
    // and rings deliberately keeps two separate visible jacks.
    const edges = [edge('rings', 'odd', 'n', 'audio')];
    const groups = computeLegGroups(edges, defs);
    expect(groups.get(edges[0]!.id)!.render).toBe(true);
    expect(groups.get(edges[0]!.id)!.soloChannel).toBeNull();
  });

  it('…while a real stereo pair in the same position IS dashed (the control)', () => {
    // Same shape, same lone-leg situation — the only difference is that
    // out_l/out_r is a COLLAPSE pair. Without this leg the test above would
    // pass even if the solo tag were disabled outright.
    const edges = [edge('a', 'out_l', 'n', 'audio')];
    expect(soloOf(edges, edges[0]!.id)).toBe('left');
  });
});

describe('computeLegGroups — leg-level occupancy stays TWO cables (owner Q4)', () => {
  it('A-only-L and B-only-R into one stereo input are NOT one group', () => {
    // Different sources. Co-deleting or co-drawing these would silently undo
    // the whole point of leg-level occupancy.
    const edges = [edge('a', 'out_l', 'b', 'in_l'), edge('a2', 'out_r', 'b', 'in_r')];
    expect(rendered(edges)).toHaveLength(2);
    expect(soloOf(edges, 'e-a-out_l-b-in_l')).toBe('left');
    expect(soloOf(edges, 'e-a2-out_r-b-in_r')).toBe('right');
  });
});

describe('computeLegGroups — invariants', () => {
  const CASES: Edge[][] = [
    [],
    [edge('a', 'out_l', 'b', 'in_l')],
    [edge('a', 'out_r', 'b', 'in_r')],
    [edge('a', 'out_l', 'b', 'in_l'), edge('a', 'out_r', 'b', 'in_r')],
    [edge('a', 'out_r', 'b', 'in_r'), edge('a', 'out_l', 'b', 'in_l')],
    [edge('m', 'audio', 'b', 'in_l'), edge('m', 'audio', 'b', 'in_r')],
    [edge('a', 'out_l', 'n', 'audio'), edge('a', 'out_r', 'n', 'audio')],
    [edge('a', 'out_l', 'b', 'in_r'), edge('a', 'out_r', 'b', 'in_l')],
    [edge('a', 'out_l', 'b', 'in_l'), edge('a2', 'out_r', 'b', 'in_r')],
    [edge('m', 'audio', 'n', 'audio')],
    [edge('cv', 'env_l', 'cvd', 'cv_l'), edge('cv', 'env_r', 'cvd', 'cv_r')],
    // an unknown node (mid-teardown / a def the registry does not carry)
    [edge('ghost', 'out_l', 'b', 'in_l')],
  ];

  it('EXACTLY ONE renderer per group — never two (doubled cable), never zero (invisible cable)', () => {
    for (const edges of CASES) {
      const groups = computeLegGroups(edges, defForNode);
      expect(groups.size, JSON.stringify(edges.map((e) => e.id))).toBe(edges.length);
      const byGroup = new Map<string, number>();
      for (const e of edges) {
        const g = groups.get(e.id)!;
        const key = [...g.groupIds].sort().join('|');
        if (g.render) byGroup.set(key, (byGroup.get(key) ?? 0) + 1);
        else byGroup.set(key, byGroup.get(key) ?? 0);
      }
      for (const [key, renderers] of byGroup) {
        expect(renderers, `group ${key} has ${renderers} renderers`).toBe(1);
      }
    }
  });

  it('groupIds is symmetric — both legs name the same group', () => {
    for (const edges of CASES) {
      const groups = computeLegGroups(edges, defForNode);
      for (const e of edges) {
        for (const other of groups.get(e.id)!.groupIds) {
          expect([...groups.get(other)!.groupIds].sort()).toEqual(
            [...groups.get(e.id)!.groupIds].sort(),
          );
        }
      }
    }
  });

  it('a node with NO resolvable def yields a plain, always-drawn cable', () => {
    const edges = [edge('ghost', 'out_l', 'b', 'in_l')];
    // The TARGET is still paired, so this is a lone left leg — but the point is
    // that it renders. A missing def must never make a cable disappear.
    expect(rendered(edges)).toEqual(['e-ghost-out_l-b-in_l']);
  });

  it('the DEGENERATE same-side pair still elects exactly one renderer', () => {
    // Unreachable from any planner (the sibling mapping flips the side of
    // whichever end is paired), but reachable from a hand-authored graph. The
    // id tie-break is here so the cable cannot vanish.
    const oneSided: StereoDef = {
      type: 'weird',
      inputs: [{ id: 'audio', type: 'audio' }],
      outputs: [
        { id: 'out_l', type: 'audio' },
        { id: 'out_r', type: 'audio' },
      ],
    };
    const defs = (n: string) => (n === 'w' ? oneSided : n === 'n' ? MONO_DST : undefined);
    const edges = [edge('w', 'out_l', 'n', 'audio'), edge('w', 'out_r', 'n', 'audio')];
    const groups = computeLegGroups(edges, defs);
    expect(edges.filter((e) => groups.get(e.id)!.render)).toHaveLength(1);
  });
});
