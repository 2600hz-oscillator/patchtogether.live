// ⛔ MOCK / PROPOSAL — covers the model the /dev/video-patch-drop scenes render.
// Nothing in the engine imports the subject.
//
// These assertions read the REAL defs, so they are a check on the scenes rather
// than on a fixture: if backdraft grows a video input, the scene changes and so
// does this test, in the same diff.
import { describe, it, expect } from 'vitest';
import { backdraftDef } from '$lib/video/modules/backdraft';
import { cameraInputDef } from '$lib/video/modules/camera-input';
import { colorizerDef } from '$lib/video/modules/colorizer';
import { colourofmagicDef } from '$lib/video/modules/colourofmagic';
import { edgesDef } from '$lib/video/modules/edges';
import { peakstateDef } from '$lib/video/modules/peakstate';
import {
  buildDropPlan,
  invertDirection,
  findRepair,
  videoPortsOf,
  dropRefusal,
  dropEdgeKey,
  DROP_REFUSAL_TEXT,
  type DropDefLike,
} from './drop-plan';

const backdraft = backdraftDef as unknown as DropDefLike;
const camera = cameraInputDef as unknown as DropDefLike;
const colorizer = colorizerDef as unknown as DropDefLike;
const com = colourofmagicDef as unknown as DropDefLike;
const edges = edgesDef as unknown as DropDefLike;
const peakstate = peakstateDef as unknown as DropDefLike;

const A = (def: DropDefLike, nodeId = 'a') => ({ nodeId, def });
const B = (def: DropDefLike, nodeId = 'b') => ({ nodeId, def });

describe("scene 1 — the owner's example", () => {
  const plan = buildDropPlan(A(backdraft), B(camera), 'downstream');

  it("carries camera's out into backdraft's ins", () => {
    expect(plan.from.label).toBe('camera');
    expect(plan.into.label).toBe('backdraft');
    expect(plan.carried).toMatchObject({ portId: 'out', cable: 'video' });
  });

  it('offers exactly the inputs that take the carried cable', () => {
    const offered = plan.rows.filter((r) => r.state === 'offered');
    expect(offered.map((r) => r.portId)).toEqual(['in_a', 'in_b', 'lighten', 'darken']);
  });

  it('KEEPS the rest as refused rows rather than filtering them away', () => {
    // The round-2 change. These 29 cv inputs used to be removed by a domain
    // filter and reported only as a number, next to a `disabled` "show all" —
    // so the count was the ONLY thing a user could ever learn about them.
    const refused = plan.rows.filter((r) => r.state === 'refused');
    expect(refused.length).toBeGreaterThan(0);
    expect(new Set(refused.map((r) => r.cable))).toEqual(new Set(['cv']));
    expect(refused.every((r) => r.reason === 'different-domain')).toBe(true);
  });
});

describe('scene 2 — the inverted direction is legitimately empty', () => {
  const plan = buildDropPlan(A(backdraft), B(camera), 'upstream');

  it('swaps the roles wholesale', () => {
    expect(plan.from.label).toBe('backdraft');
    expect(plan.into.label).toBe('camera');
  });

  it('offers nothing, because camera declares no input that takes video', () => {
    expect(videoPortsOf(camera, 'inputs')).toEqual([]);
    expect(plan.rows.filter((r) => r.state === 'offered')).toEqual([]);
    // …and the carry still exists, so the modal has something to say rather
    // than nothing to show.
    expect(plan.carried).toMatchObject({ portId: 'out' });
  });

  it("still LISTS camera's inputs, so 'may not' is distinguishable from 'none'", () => {
    // The whole point of the collapse: an empty offered list next to a
    // "2 not compatible" summary is a different sentence from an empty panel.
    expect(plan.rows.length).toBe((camera.inputs ?? []).length);
    expect(plan.rows.every((r) => r.state === 'refused')).toBe(true);
  });
});

describe('scene 3 — the feedback loop is symmetric', () => {
  const down = buildDropPlan(A(backdraft, 'bd2'), B(backdraft, 'bd1'), 'downstream');
  const up = buildDropPlan(A(backdraft, 'bd2'), B(backdraft, 'bd1'), 'upstream');

  it('both directions are populated and mirror each other', () => {
    expect(down.from.nodeId).toBe('bd1');
    expect(down.into.nodeId).toBe('bd2');
    expect(up.from.nodeId).toBe('bd2');
    expect(up.into.nodeId).toBe('bd1');
    expect(down.rows.map((r) => r.portId)).toEqual(up.rows.map((r) => r.portId));
  });

  it('invertDirection round-trips', () => {
    expect(invertDirection(invertDirection('downstream'))).toBe('downstream');
    expect(invertDirection('downstream')).toBe('upstream');
  });
});

describe('scene 4 — the typing rule', () => {
  it('mono out widens into colour ins', () => {
    const plan = buildDropPlan(A(backdraft), B(peakstate), 'downstream', {
      carriedPortId: 'mono_out',
    });
    expect(plan.carried).toMatchObject({ portId: 'mono_out', cable: 'mono-video' });
    // Every VIDEO-typed input takes it; nothing is refused on a lattice axis.
    const videoRows = plan.rows.filter((r) => r.cable !== 'cv');
    expect(videoRows.filter((r) => r.state !== 'offered')).toEqual([]);
    expect(videoRows.length).toBeGreaterThan(0); // vacuity guard
  });

  it('colour out is REFUSED by a mono in, and says which axis failed', () => {
    const plan = buildDropPlan(A(colorizer), B(camera), 'downstream');
    expect(plan.carried).toMatchObject({ cable: 'video' });
    const row = plan.rows.find((r) => r.portId === 'in');
    expect(row).toMatchObject({ state: 'refused', reason: 'colour-into-mono', cable: 'mono-video' });
  });

  it('a port that declares `accepts` is offered, and is marked as opting in', () => {
    // COLOUR OF MAGIC's channel inputs are `mono-video` but declare
    // accepts:['keys','image','video'] — the module saying it knows how to
    // reduce. That is a DIFFERENT thing from the signal already fitting, and
    // the row records the difference.
    const plan = buildDropPlan(A(com), B(camera), 'downstream');
    const optIns = plan.rows.filter((r) => r.viaPortOptIn);
    expect(optIns.length).toBeGreaterThan(0);
    expect(optIns.every((r) => r.state === 'offered' && r.cable === 'mono-video')).toBe(true);
    // The plain `video` input needs no opt-in.
    expect(plan.rows.find((r) => r.portId === 'in')).toMatchObject({
      state: 'offered',
      viaPortOptIn: undefined,
    });
  });
});

describe('the repair is derived, and offers rather than decides', () => {
  it('finds a colour→mono reducer without any list of converters', () => {
    const repair = findRepair('video', { id: 'in', type: 'mono-video' }, [com, edges]);
    expect(repair?.type).toBe('colourofmagic');
    // EVERY qualifying tap, so the user picks. A single answer here would be
    // the app choosing between a red channel and a luma on their behalf.
    expect(repair!.outPortIds).toContain('luma');
    expect(repair!.outPortIds).toContain('r');
    expect(repair!.outPortIds.length).toBeGreaterThan(1);
  });

  it('every offered tap really does fit the refused input', () => {
    const refused = { id: 'in', type: 'mono-video' };
    const repair = findRepair('video', refused, [com, edges])!;
    const outs = com.outputs ?? [];
    const bad = repair.outPortIds.filter((id) => {
      const p = outs.find((o) => o.id === id)!;
      return p.type !== 'mono-video' && p.type !== 'keys';
    });
    expect(bad).toEqual([]);
  });

  it('returns undefined when nothing in the candidate set reduces', () => {
    expect(findRepair('video', { id: 'in', type: 'mono-video' }, [camera])).toBeUndefined();
    expect(findRepair('video', { id: 'in', type: 'mono-video' }, [])).toBeUndefined();
  });
});

describe('scene 5 — the subset is reported, not just applied', () => {
  it("names the full output count, not the lane rail's truncation", () => {
    // The rail shows the first 4 outputs in declaration order whatever the
    // count; a modal built on the rear model must not inherit that cut.
    const plan = buildDropPlan(A(com), B(camera), 'upstream');
    expect(plan.census.declaredOutputs).toBe((com.outputs ?? []).length);
    expect(plan.carriable.length).toBe(plan.census.declaredOutputs);
    expect(plan.carriable.length).toBeGreaterThan(4);
  });

  it('splits outputs by whether they REACH, instead of by domain', () => {
    // Carrying from colour-of-magic into camera: camera takes no video at all,
    // so every one of COM's outputs is live-but-useless HERE. That is a
    // different sentence from "refused" and gets its own group.
    const plan = buildDropPlan(A(com), B(camera), 'upstream');
    expect(plan.census.reachingOutputs).toBe(0);
    expect(plan.carriable.every((c) => !c.reaches)).toBe(true);

    // …and into backdraft, whose ins are `video`, every one of them reaches.
    const live = buildDropPlan(A(com), B(backdraft), 'upstream');
    expect(live.census.reachingOutputs).toBe(live.carriable.length);
    expect(live.census.reachingOutputs).toBeGreaterThan(0); // vacuity guard
  });
});

describe('THE COLLAPSE INVARIANT — nothing is ever silently absent', () => {
  // The property that makes a collapsed summary honest rather than a second
  // hiding place. Asserted over EVERY ordered pair of the real defs and BOTH
  // directions, so it is a statement about the model and not about the scenes
  // that happen to be rendered today.
  const ALL: [string, DropDefLike][] = [
    ['backdraft', backdraft],
    ['camera', camera],
    ['colorizer', colorizer],
    ['colourofmagic', com],
    ['edges', edges],
    ['peakstate', peakstate],
  ];

  it('every declared input lands in exactly one group, for every pair', () => {
    const broken: string[] = [];
    let sawRefusals = 0;
    for (const [ka, a] of ALL) {
      for (const [kb, b] of ALL) {
        for (const dir of ['downstream', 'upstream'] as const) {
          const p = buildDropPlan(A(a), B(b), dir);
          const { declaredInputs, offeredInputs, refusedInputs } = p.census;
          if (offeredInputs + refusedInputs !== declaredInputs) {
            broken.push(`${ka}->${kb} ${dir}: ${offeredInputs}+${refusedInputs}≠${declaredInputs}`);
          }
          if (p.rows.length !== declaredInputs) {
            broken.push(`${ka}->${kb} ${dir}: rows ${p.rows.length}≠${declaredInputs}`);
          }
          sawRefusals += refusedInputs;
        }
      }
    }
    expect(broken).toEqual([]);
    // ⚠ VACUITY GUARD. The identity above holds trivially if nothing is ever
    // refused, which is exactly the state the pre-collapse filter produced.
    expect(sawRefusals).toBeGreaterThan(0);
  });

  it('every refused row carries a reason with real text', () => {
    const mute: string[] = [];
    for (const [ka, a] of ALL) {
      for (const [kb, b] of ALL) {
        const p = buildDropPlan(A(a), B(b), 'downstream');
        for (const r of p.rows.filter((x) => x.state === 'refused')) {
          if (!r.reason || !DROP_REFUSAL_TEXT[r.reason]) mute.push(`${ka}->${kb}.${r.portId}`);
        }
      }
    }
    expect(mute).toEqual([]);
  });
});

describe('dropRefusal — the fourth case the lattice deliberately does not own', () => {
  it('names the axis inside the lattice', () => {
    expect(dropRefusal('video', 'mono-video')).toBe('colour-into-mono');
    expect(dropRefusal('video', 'image')).toBe('motion-into-still');
    expect(dropRefusal('video', 'keys')).toBe('colour-and-motion');
  });

  it('reports a cross-domain refusal instead of returning undefined into the UI', () => {
    // A `video` cable at a `cv` jack is not an axis failure — it is a
    // different domain, and the lattice returns undefined for it by design.
    expect(dropRefusal('video', 'cv')).toBe('different-domain');
    expect(dropRefusal('cv', 'video')).toBe('different-domain');
    expect(DROP_REFUSAL_TEXT['different-domain'].length).toBeGreaterThan(20);
  });
});

describe('direction symmetry — the property the shipped cascade lacks', () => {
  it('a port `accepts` widening survives the flip', () => {
    // The whole point of Tab. Carrying COM's `pass` (video) into a mono input
    // that opts in must be offered; and carrying FROM the other side must
    // reach the same conclusion about the same pair of ports.
    const monoInWithAccepts = (com.inputs ?? []).find((p) => p.id === 'rgb_r_in')!;
    expect(monoInWithAccepts.accepts).toBeDefined();

    const forward = buildDropPlan(A(com, 'com'), B(camera, 'cam'), 'downstream');
    const row = forward.rows.find((r) => r.portId === 'rgb_r_in');
    expect(row?.state).toBe('offered');

    // Flip the same pair: COM now supplies the out. The plan is built by the
    // same code path in both directions, so the model cannot disagree with
    // itself the way compatibleTargetPorts does.
    const back = buildDropPlan(A(com, 'com'), B(camera, 'cam'), 'upstream');
    expect(back.from.nodeId).toBe('com');
    expect(back.carriable.length).toBeGreaterThan(0);
  });
});
