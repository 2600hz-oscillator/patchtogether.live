// packages/web/src/lib/graph/device-slots.test.ts
//
// The PURE half of the device-slot layer: the reserved-id table, presence,
// identity repair, the rig/patch split, and the duplicate strip. The mechanism
// tests that need a REAL Y.Doc and the REAL reconciler live beside this file in
// device-slots-ydoc.test.ts — this file only pins the decisions, so a failure
// here names the RULE that changed rather than the machinery around it.

import { describe, it, expect } from 'vitest';
import {
  CAMERA_SLOTS,
  DEVICE_SLOTS,
  DEVICE_SLOT_IDENTITY_DATA_KEYS,
  DEVICE_SLOT_RIG_KEYS,
  OUTPUT_SLOTS,
  OUTPUT_SLOT_LAYOUT,
  RESERVED_DEVICE_SLOT_IDS,
  decideSlotMerge,
  deviceSlotForId,
  deviceSlotForName,
  isDeviceSlotId,
  outputSlotPosition,
  planDeviceSlotIdentityRepairs,
  planDeviceSlotSpawns,
  slotCoercionReason,
  stripRigBindings,
  stripSlotIdentityForDuplicate,
} from './device-slots';
import { DEFAULT_VIDEO_OUT_ID, videoZoneSlotPos } from './channel-columns';
import { RESERVED_PINNED_IDS } from './workflow-pins';

const camNode = (over: Record<string, unknown> = {}) => ({
  id: 'slot:cam1',
  type: 'cameraInput',
  domain: 'video',
  data: { pinned: true, hiddenCard: true },
  ...over,
});

const outNode = (over: Record<string, unknown> = {}) => ({
  id: DEFAULT_VIDEO_OUT_ID,
  type: 'videoOut',
  domain: 'video',
  data: {},
  ...over,
});

// Every slot, in canonical shape — the steady state the planners must both
// report as clean.
const steadyState = () =>
  DEVICE_SLOTS.map((s) => ({
    id: s.id,
    type: s.type,
    domain: s.domain,
    data: {
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.hiddenCard ? { hiddenCard: true } : {}),
    } as Record<string, unknown>,
  }));

describe('the reserved slot table', () => {
  it('is exactly four cameras and four outputs, named as the program names them', () => {
    expect(CAMERA_SLOTS.map((s) => s.slot)).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);
    expect(OUTPUT_SLOTS.map((s) => s.slot)).toEqual([
      'output1',
      'output2',
      'output3',
      'output4',
    ]);
    expect(DEVICE_SLOTS).toHaveLength(8);
  });

  it('gives every slot a UNIQUE id — the id IS the session key', () => {
    expect(RESERVED_DEVICE_SLOT_IDS.size).toBe(DEVICE_SLOTS.length);
  });

  // The two reserved-id tables defend different things and must never collide:
  // a shared id would put two ensure effects, with different presence rules and
  // different canonical types, in a write fight over one Y.Map entry.
  it('never collides with the pinned-singleton reserved ids', () => {
    for (const id of RESERVED_DEVICE_SLOT_IDS) {
      expect(RESERVED_PINNED_IDS.has(id)).toBe(false);
    }
  });

  it('keeps output1 on the HISTORICAL videoOut id rather than renaming it', () => {
    // Renaming is a delete of one id and an add of another — precisely the
    // remove+add teardown this layer exists to prevent, and it would land on
    // every rack in the fleet at once, on the slot most likely to be presenting.
    expect(deviceSlotForName('output1')!.id).toBe(DEFAULT_VIDEO_OUT_ID);
  });

  it('routes camera slots to the header and output slots to the purple zone', () => {
    expect(CAMERA_SLOTS.every((s) => s.zone === 'header')).toBe(true);
    expect(OUTPUT_SLOTS.every((s) => s.zone === 'video-zone')).toBe(true);
  });

  // The two flags are also the canvas-HIDE bits (isCanvasHiddenNode is
  // `pinned || hiddenCard`), so this is not bookkeeping: it is the difference
  // between a camera whose face is the header menu and an output the operator
  // can no longer see or patch into.
  it('pins + hides cameras and does NEITHER to outputs', () => {
    expect(CAMERA_SLOTS.every((s) => s.pinned && s.hiddenCard)).toBe(true);
    expect(OUTPUT_SLOTS.every((s) => !s.pinned && !s.hiddenCard)).toBe(true);
  });

  it('resolves by id and by name, and refuses anything else', () => {
    expect(deviceSlotForId('slot:cam3')!.slot).toBe('cam3');
    expect(deviceSlotForName('cam3')!.id).toBe('slot:cam3');
    expect(deviceSlotForId('lfo-abc123')).toBeNull();
    expect(deviceSlotForName('cam9')).toBeNull();
    expect(isDeviceSlotId('slot:cam1')).toBe(true);
    expect(isDeviceSlotId('pinned-mixmstrs')).toBe(false);
    expect(isDeviceSlotId(undefined)).toBe(false);
  });

  it('places output slot 0 exactly where the historical videoOut spawned', () => {
    expect(outputSlotPosition(OUTPUT_SLOTS[0]!)).toEqual(videoZoneSlotPos(0));
  });

  it('offers only output2..4 to the zone packer (output1 is already in it)', () => {
    expect(OUTPUT_SLOT_LAYOUT.map((s) => s.id)).toEqual([
      'slot:output2',
      'slot:output3',
      'slot:output4',
    ]);
  });
});

describe('presence — by ID, not by type', () => {
  it('plans every slot on an empty rack', () => {
    expect(planDeviceSlotSpawns([]).map((s) => s.slot)).toEqual(
      DEVICE_SLOTS.map((s) => s.slot),
    );
  });

  it('plans nothing in steady state', () => {
    expect(planDeviceSlotSpawns(steadyState())).toEqual([]);
  });

  // The load-bearing difference from planPinnedSpawns. If an imported patch's
  // own CAMERA satisfied `cam1`, the reserved id would stay FREE — and a free
  // reserved id is one a peer can occupy, which is the hole the layer closes.
  it('is NOT satisfied by an ordinary node of the same type at another id', () => {
    const plan = planDeviceSlotSpawns([
      { id: 'cameraInput-abc', type: 'cameraInput', domain: 'video', data: {} },
      { id: 'videoOut-def', type: 'videoOut', domain: 'video', data: {} },
    ]);
    expect(plan).toHaveLength(8);
  });

  it('ignores null/undefined and id-less entries rather than throwing', () => {
    expect(planDeviceSlotSpawns([null, undefined, { type: 'lfo' }])).toHaveLength(8);
  });
});

describe('identity repair — the hostile-peer defence', () => {
  it('reports nothing in steady state', () => {
    expect(planDeviceSlotIdentityRepairs(steadyState())).toEqual([]);
  });

  it('leaves an ABSENT reserved id to the spawn planner', () => {
    expect(planDeviceSlotIdentityRepairs([])).toEqual([]);
  });

  // type/domain are the two fields the reconciler's identityChanged reads, so
  // canonicalising them IS the device-session defence.
  it('names type when a peer retypes a camera slot', () => {
    const r = planDeviceSlotIdentityRepairs([camNode({ type: 'scope' })]);
    expect(r).toHaveLength(1);
    expect(r[0]!.fields).toEqual(['type']);
    expect(r[0]!.type).toBe('cameraInput');
    expect(r[0]!.slot).toBe('cam1');
  });

  it('names domain when a peer moves a slot to another registry', () => {
    const r = planDeviceSlotIdentityRepairs([camNode({ domain: 'audio' })]);
    expect(r[0]!.fields).toEqual(['domain']);
  });

  it('re-pins a camera slot a peer un-pinned', () => {
    const r = planDeviceSlotIdentityRepairs([camNode({ data: { hiddenCard: true } })]);
    expect(r[0]!.fields).toEqual(['pinned']);
    expect(r[0]!.pinned).toBe(true);
  });

  // ⚠ THE ATTACK THE PINNED REPAIR CANNOT SEE, because that one only ever SETS
  // `pinned`. `isCanvasHiddenNode` is `pinned || hiddenCard`, so one field
  // write makes the rack's master video sink disappear from the purple zone —
  // no delete, no error, nothing in the console — on the exact surface the
  // owner is presenting from.
  it('UN-pins an output slot a peer pinned (the vanishing-sink attack)', () => {
    const r = planDeviceSlotIdentityRepairs([outNode({ data: { pinned: true } })]);
    expect(r).toHaveLength(1);
    expect(r[0]!.fields).toEqual(['pinned']);
    expect(r[0]!.pinned).toBe(false);
  });

  it('clears a hostile hiddenCard on an output slot too', () => {
    const r = planDeviceSlotIdentityRepairs([outNode({ data: { hiddenCard: true } })]);
    expect(r[0]!.fields).toEqual(['hiddenCard']);
    expect(r[0]!.hiddenCard).toBe(false);
  });

  it('reports every wrong field at once, in a stable order', () => {
    const r = planDeviceSlotIdentityRepairs([
      camNode({ type: 'scope', domain: 'audio', data: {} }),
    ]);
    expect(r[0]!.fields).toEqual(['type', 'domain', 'pinned', 'hiddenCard']);
  });

  // The lesson the pinned applier learned the hard way: an applier that
  // canonicalises everything on any repair silently overrides the planner's
  // own exemptions. The planner is the single decision site, so it must never
  // name a field that is already correct.
  it('never names a field that is already canonical', () => {
    const r = planDeviceSlotIdentityRepairs([camNode({ type: 'scope' })]);
    expect(r[0]!.fields).not.toContain('pinned');
    expect(r[0]!.fields).not.toContain('hiddenCard');
    expect(r[0]!.fields).not.toContain('domain');
  });

  // Legitimate user state must survive a hardening, or the hardening is the
  // bug. params/position/name are deliberately not canonical fields.
  it('does not report a slot carrying user params, a name or a position', () => {
    const node = camNode();
    (node.data as Record<string, unknown>).name = 'FRONT CAM';
    expect(
      planDeviceSlotIdentityRepairs([{ ...node, params: { gain: 1.4 } } as never]),
    ).toEqual([]);
  });
});

describe('rig properties vs patch content', () => {
  it('treats deviceId as rig-owned', () => {
    expect(DEVICE_SLOT_RIG_KEYS).toContain('deviceId');
  });

  // The id and the label are ONE binding. Once a device id rotates (a different
  // USB port, a driver reinstall, cleared site data) the label is the only
  // thing left that names the hardware, and device-rebind.ts falls back to it.
  // Carrying one without the other would leave a slot able to resolve a camera
  // it was never told about.
  it('treats deviceLabel as rig-owned too — the pair travels together', () => {
    expect(DEVICE_SLOT_RIG_KEYS).toContain('deviceLabel');
  });

  it('strips rig keys and reports what it removed', () => {
    const data: Record<string, unknown> = {
      deviceId: 'abc',
      deviceLabel: 'FaceTime HD',
      name: 'FRONT',
      gain: 1,
    };
    expect(stripRigBindings(data)).toEqual(['deviceId', 'deviceLabel']);
    expect(data).toEqual({ name: 'FRONT', gain: 1 });
  });

  it('is a no-op on data with no bindings, and on null', () => {
    expect(stripRigBindings({ name: 'x' })).toEqual([]);
    expect(stripRigBindings(null)).toEqual([]);
    expect(stripRigBindings(undefined)).toEqual([]);
  });

  // ⚠ THE PREDICATE THE CAMERA SOURCE REGISTRY'S AUTO-ACQUIRE GUARD TURNS ON
  // (ui/media/node-camera-source-registry.ts `bootstrap`).
  //
  // A dynamic camera with nothing saved deliberately falls through to an
  // UNCONSTRAINED getUserMedia and gets the browser's default camera — that is
  // right, because it only exists because someone just pressed ＋. A reserved
  // slot exists in every rack whether or not anyone asked, so the same
  // fall-through would fire four unconstrained requests on EVERY boot for any
  // operator who has ever granted camera permission to this origin: a camera
  // light at boot, and four clients contending for one physical device.
  //
  // The registry asks `isDeviceSlotId(node.id)`, so the two must not converge.
  it('DISTINGUISHES a reserved slot from a dynamic camera by id alone', () => {
    expect(isDeviceSlotId('slot:cam1')).toBe(true);
    expect(isDeviceSlotId('wfcam-deadbeef')).toBe(false);
    expect(isDeviceSlotId('cameraInput-abc12345')).toBe(false);
  });
});

describe('the envelope merge decision', () => {
  it('returns null for ordinary patch content, so the load loop is unchanged', () => {
    expect(decideSlotMerge({ id: 'lfo-1', type: 'lfo', data: {} })).toBeNull();
  });

  it('MERGES a matching type and strips the incoming rig binding', () => {
    const node = { id: 'slot:cam2', type: 'cameraInput', data: { deviceId: 'theirs', name: 'X' } };
    const d = decideSlotMerge(node)!;
    expect(d.action).toBe('merge');
    expect(d.slot).toBe('cam2');
    expect(d.strippedRigKeys).toEqual(['deviceId']);
    // A shared patch must never rebind THIS machine's hardware.
    expect(node.data).toEqual({ name: 'X' });
  });

  // The contract-lock cannot see envelope DATA, so a hand-edited, foreign or
  // version-skewed envelope is the reachable path to a type change at a reused
  // id — which the reconciler reads as remove+add. The layer's own merge would
  // otherwise fire the exact teardown the layer exists to prevent.
  it('COERCES a foreign type at a reserved id — the slot type always wins', () => {
    const d = decideSlotMerge({ id: 'slot:cam1', type: 'doom', data: {} })!;
    expect(d.action).toBe('coerce');
    expect(d.incomingType).toBe('doom');
    expect(slotCoercionReason(d)).toContain('cam1');
    expect(slotCoercionReason(d)).toContain('cameraInput');
  });

  it('strips the rig binding on a coercion too', () => {
    const node = { id: DEFAULT_VIDEO_OUT_ID, type: 'lfo', data: { deviceId: 'theirs' } };
    const d = decideSlotMerge(node)!;
    expect(d.action).toBe('coerce');
    expect(node.data).toEqual({});
  });
});

describe('the duplicate strip', () => {
  it('lists pinned + hiddenCard + the zone-placement latch', () => {
    expect(DEVICE_SLOT_IDENTITY_DATA_KEYS).toEqual(
      expect.arrayContaining(['pinned', 'hiddenCard', 'videoZonePlaced']),
    );
  });

  // Without this a clone inherits `pinned` at an id nothing reserves: refused
  // by every delete path, hidden from the canvas, exempt from maxInstances —
  // an unremovable ghost with no card to right-click.
  it('never lets a clone inherit undeletability', () => {
    const data: Record<string, unknown> = {
      pinned: true,
      hiddenCard: true,
      videoZonePlaced: true,
      name: 'CAM 1',
      deviceId: 'abc',
    };
    stripSlotIdentityForDuplicate(data);
    expect(data.pinned).toBeUndefined();
    expect(data.hiddenCard).toBeUndefined();
    expect(data.videoZonePlaced).toBeUndefined();
    // User state the gesture DOES mean to copy is untouched.
    expect(data).toEqual({ name: 'CAM 1', deviceId: 'abc' });
  });

  it('is a no-op on ordinary data', () => {
    const data: Record<string, unknown> = { name: 'LFO' };
    expect(stripSlotIdentityForDuplicate(data)).toEqual([]);
    expect(data).toEqual({ name: 'LFO' });
  });
});
