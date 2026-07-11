// packages/web/src/lib/ui/workflow/workflow-cameras.test.ts
//
// WORKFLOW MODE P4 — the camera manager's bookkeeping, against the REAL
// syncedStore + Y.Doc (graph/store.ts — never a mock,
// [[yjs-save-load-real-ydoc]]; media/asset-spawn.test.ts harness shape):
//
//   * addWorkflowCamera — a FULL cameraInput node lands in ONE transact
//     carrying hiddenCard + a monotonic default name; cap-guarded by the
//     def's maxInstances (4), which hidden cameras AND canvas CAMERA
//     cards both consume; refusal surfaces through onError and writes
//     nothing.
//   * source ASSIGN is the hosted card's own `node.data.deviceId` write —
//     the menu only READS it (readCameraDeviceId / cameraRowLabel), so
//     the test drives the same data key the card persists.
//   * unmapWorkflowCamera — the standard remove path: node + every
//     touching edge gone in one transact (NOT pinned, so never refused).
//   * the pure list/label helpers (ordering, ordinals, label fallback).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  addWorkflowCamera,
  unmapWorkflowCamera,
  listWorkflowCameras,
  isWorkflowCameraNode,
  cameraNumberOf,
  cameraRowLabel,
  readCameraDeviceId,
  workflowCameraAtCap,
  cameraCapMessage,
  WORKFLOW_CAMERA_TYPE,
  WORKFLOW_CAMERA_OUT_PORT,
} from './workflow-cameras';

function reset(): void {
  ydoc.transact(() => {
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  }, LOCAL_ORIGIN);
}

beforeEach(reset);
afterEach(reset);

function seedNode(id: string, type: string, data: Record<string, unknown> = {}): void {
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type,
      domain: type === WORKFLOW_CAMERA_TYPE ? 'video' : 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data,
    } as ModuleNode;
  }, LOCAL_ORIGIN);
}

function liveNodes(): ModuleNode[] {
  return Object.values(patch.nodes).filter((n): n is ModuleNode => !!n);
}

describe('addWorkflowCamera', () => {
  it('creates a hidden FULL camera module with a monotonic default name', () => {
    const id1 = addWorkflowCamera();
    expect(id1).toMatch(/^wfcam-/);
    const n1 = patch.nodes[id1!]!;
    expect(n1.type).toBe(WORKFLOW_CAMERA_TYPE);
    expect(n1.domain).toBe('video');
    expect(n1.data?.hiddenCard).toBe(true);
    expect(n1.data?.pinned).toBeUndefined(); // NOT pinned — deletable
    expect(n1.data?.name).toBe('CAMERAINPUT');

    const id2 = addWorkflowCamera();
    expect(patch.nodes[id2!]!.data?.name).toBe('CAMERAINPUT2');
    expect(cameraNumberOf(patch.nodes[id1!]!)).toBe(1);
    expect(cameraNumberOf(patch.nodes[id2!]!)).toBe(2);
  });

  it('refuses the add past maxInstances — canvas CAMERA cards consume the same budget', () => {
    // 3 mapped cameras + 1 ordinary canvas CAMERA card = the def cap (4).
    expect(addWorkflowCamera()).not.toBeNull();
    expect(addWorkflowCamera()).not.toBeNull();
    expect(addWorkflowCamera()).not.toBeNull();
    seedNode('cam-canvas', WORKFLOW_CAMERA_TYPE, {});
    expect(workflowCameraAtCap(patch.nodes)).toBe(true);
    expect(workflowCameraAtCap(liveNodes())).toBe(true); // array form (snapshot)

    let msg: string | null = null;
    const refused = addWorkflowCamera({ onError: (m) => (msg = m) });
    expect(refused).toBeNull();
    expect(msg).toBe(cameraCapMessage(4));
    // Nothing written.
    expect(liveNodes().filter((n) => n.type === WORKFLOW_CAMERA_TYPE)).toHaveLength(4);

    // Unmapping one frees the slot again.
    const mapped = listWorkflowCameras(liveNodes());
    expect(unmapWorkflowCamera(mapped[0]!.id)).toBe(true);
    expect(workflowCameraAtCap(patch.nodes)).toBe(false);
    expect(addWorkflowCamera()).not.toBeNull();
  });
});

describe('source assignment bookkeeping (the card owns the write)', () => {
  it('reads the deviceId key the CameraInputCard persists; label prefers the local device label', () => {
    const id = addWorkflowCamera()!;
    expect(readCameraDeviceId(patch.nodes[id]!)).toBeNull();

    // The hosted card's pick → setSavedDeviceId writes data.deviceId in
    // place. Same write shape here (single key, live map).
    ydoc.transact(() => {
      patch.nodes[id]!.data!['deviceId'] = 'dev-123';
    }, LOCAL_ORIGIN);
    expect(readCameraDeviceId(patch.nodes[id]!)).toBe('dev-123');

    const devices = [
      { deviceId: 'dev-123', label: 'FaceTime HD Camera' },
      { deviceId: 'dev-456', label: 'Blackmagic' },
    ];
    expect(cameraRowLabel(patch.nodes[id]!, devices)).toBe('FaceTime HD Camera');
    // Unresolvable locally (collaborator's device / pre-permission empty
    // label) → the stable ordinal fallback.
    expect(cameraRowLabel(patch.nodes[id]!, [])).toBe('camera 1');
    expect(
      cameraRowLabel(patch.nodes[id]!, [{ deviceId: 'dev-123', label: '' }]),
    ).toBe('camera 1');
  });
});

describe('unmapWorkflowCamera', () => {
  it('removes the module + every touching edge via the standard remove path', () => {
    const id = addWorkflowCamera()!;
    seedNode('fx', 'chroma');
    ydoc.transact(() => {
      patch.edges['e-cam-fx'] = {
        id: 'e-cam-fx',
        source: { nodeId: id, portId: WORKFLOW_CAMERA_OUT_PORT },
        target: { nodeId: 'fx', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      };
      patch.edges['e-other'] = {
        id: 'e-other',
        source: { nodeId: 'fx', portId: 'out' },
        target: { nodeId: 'fx', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      };
    }, LOCAL_ORIGIN);

    expect(unmapWorkflowCamera(id)).toBe(true);
    expect(patch.nodes[id]).toBeUndefined();
    // Only the camera's edge dropped; unrelated edges survive.
    expect(Object.keys(patch.edges)).toEqual(['e-other']);
    // Idempotent-safe: a second unmap is a no-op false, not a throw.
    expect(unmapWorkflowCamera(id)).toBe(false);
  });
});

describe('listWorkflowCameras / labels (pure)', () => {
  it('lists ONLY hiddenCard cameras, in stable ordinal order', () => {
    const nodes = [
      { id: 'z', type: WORKFLOW_CAMERA_TYPE, data: { hiddenCard: true, name: 'CAMERAINPUT3' } },
      { id: 'a', type: WORKFLOW_CAMERA_TYPE, data: { hiddenCard: true, name: 'CAMERAINPUT' } },
      { id: 'canvas-cam', type: WORKFLOW_CAMERA_TYPE, data: { name: 'CAMERAINPUT2' } },
      { id: 'pin', type: 'mixmstrs', data: { pinned: true } },
      { id: 'osc', type: 'vco', data: {} },
    ];
    const cams = listWorkflowCameras(nodes);
    expect(cams.map((c) => c.id)).toEqual(['a', 'z']); // ordinal 1, then 3
    expect(isWorkflowCameraNode(nodes[2])).toBe(false); // canvas card ≠ mapped
    // Ordinals survive a deletion: "camera 3" stays "camera 3".
    expect(cameraRowLabel(cams[1]!, [])).toBe('camera 3');
  });

  it('unparseable / missing names sort last and fall back gracefully', () => {
    const nodes = [
      { id: 'b', type: WORKFLOW_CAMERA_TYPE, data: { hiddenCard: true, name: 'my studio cam' } },
      { id: 'a', type: WORKFLOW_CAMERA_TYPE, data: { hiddenCard: true, name: 'CAMERAINPUT2' } },
    ];
    const cams = listWorkflowCameras(nodes);
    expect(cams.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cameraNumberOf(cams[1]!)).toBeNull();
    expect(cameraRowLabel(cams[1]!, [])).toBe('camera');
  });
});
