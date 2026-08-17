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

  it('offers every video input and refuses none', () => {
    expect(plan.rows.map((r) => r.portId)).toEqual(['in_a', 'in_b', 'lighten', 'darken']);
    expect(plan.rows.filter((r) => r.state !== 'offered')).toEqual([]);
  });

  it('states what the video filter hid instead of hiding it silently', () => {
    // Derived from the def, not typed: shown + hidden must account for every
    // declared input, which is the property that makes the disclosure honest.
    const declared = (backdraft.inputs ?? []).length;
    const { shownInputs, hiddenCvInputs, hiddenOtherInputs } = plan.subset;
    expect(shownInputs + hiddenCvInputs + hiddenOtherInputs).toBe(declared);
    expect(hiddenCvInputs).toBeGreaterThan(0);
  });
});

describe('scene 2 — the inverted direction is legitimately empty', () => {
  const plan = buildDropPlan(A(backdraft), B(camera), 'upstream');

  it('swaps the roles wholesale', () => {
    expect(plan.from.label).toBe('backdraft');
    expect(plan.into.label).toBe('camera');
  });

  it('yields no rows, because camera declares no video inputs', () => {
    expect(videoPortsOf(camera, 'inputs')).toEqual([]);
    expect(plan.rows).toEqual([]);
    // …and the carry still exists, so the modal has something to say rather
    // than nothing to show.
    expect(plan.carried).toMatchObject({ portId: 'out' });
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
    expect(plan.rows.filter((r) => r.state !== 'offered')).toEqual([]);
    expect(plan.rows.length).toBeGreaterThan(0); // vacuity guard
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
    expect(plan.subset.totalOutputs).toBe((com.outputs ?? []).length);
    expect(plan.carriable.length).toBe(plan.subset.totalOutputs); // every out is video-typed
    expect(plan.carriable.length).toBeGreaterThan(4);
  });

  it('the video filter keeps exactly the video-typed ports', () => {
    const vids = videoPortsOf(backdraft, 'inputs');
    const nonVideo = vids.filter(
      (p) => !['keys', 'image', 'mono-video', 'video'].includes(p.type),
    );
    expect(nonVideo).toEqual([]);
    const dropped = (backdraft.inputs ?? []).filter((p) => !vids.includes(p));
    expect(dropped.every((p) => !['keys', 'image', 'mono-video', 'video'].includes(p.type))).toBe(
      true,
    );
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
