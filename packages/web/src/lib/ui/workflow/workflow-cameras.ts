// packages/web/src/lib/ui/workflow/workflow-cameras.ts
//
// WORKFLOW MODE P4 — the camera manager behind the topbar 📷 slot.
//
// A "mapped camera" is a FULL cameraInput module in the graph that renders
// NO canvas card: it carries the `hiddenCard` node-data flag
// (graph/hidden-card.ts), so Canvas's flowNodes derivation skips it while
// everything else — engine reconciliation, persistence (quicksave / .set /
// .ptperf / raw JSON), collaborator sync, the patch-menu drill-down
// listings, and the def's `maxInstances` cap — treats it as an ordinary
// CAMERA instance. Its face is the CameraSurface menu, which hosts the
// REAL CameraInputCard (AudioIoSurface precedent), so device enumeration,
// the getUserMedia permission flow and the `node.data.deviceId`
// persistence are all the card's own code — nothing forked here.
//
// Unlike the P1/P2 pins these are DYNAMIC (0..N, user-added): created by
// the menu's ＋ row, deleted by its ✕ (standard removePatchNode — they are
// NOT pinned, so the shared delete path just works), and NEVER auto-
// ensured. Because they count toward cameraInput's `maxInstances` (4 per
// rack, shared with any canvas CAMERA cards), the ＋ row is cap-guarded
// with the exact wouldExceedCap predicate every spawn route uses.
//
// Pure helpers up top (unit-tested against plain fixtures); the two
// store-bound drivers at the bottom follow the media/asset-spawn.ts
// pattern (imperative, tested against the REAL syncedStore Y.Doc).

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { removePatchNode } from '$lib/graph/mutate';
import { wouldExceedCap } from '$lib/graph/cap';
import { isHiddenCardNode } from '$lib/graph/hidden-card';
import { nextDefaultName } from '$lib/multiplayer/module-naming';
// The def itself (READ-ONLY import — its maxInstances is the cap truth).
// Imported directly rather than via getVideoModuleDef so the cap guard
// works before/without the glob registry boot (which only runs in-app).
import { cameraInputDef } from '$lib/video/modules/camera-input';
import type { ModuleNode } from '$lib/graph/types';

/** The module type every mapped camera is an instance of. */
export const WORKFLOW_CAMERA_TYPE = cameraInputDef.type;

/** The camera module's one video output (cameraInputDef.outputs[0]) — the
 *  port the menu rows' virtual-port drag resolves to. */
export const WORKFLOW_CAMERA_OUT_PORT = 'out';

/** Minimal node shape the pure helpers inspect. */
export interface CameraNodeLike {
  id: string;
  type: string;
  data?: Record<string, unknown> | null;
}

/** True when `node` is a menu-mapped (headless) camera: a cameraInput
 *  instance carrying the hiddenCard flag. Canvas CAMERA cards (no flag)
 *  are ordinary modules and never appear in the camera menu. */
export function isWorkflowCameraNode(node: CameraNodeLike | null | undefined): boolean {
  return !!node && node.type === WORKFLOW_CAMERA_TYPE && isHiddenCardNode(node);
}

/**
 * The camera's stable ordinal, parsed from its `nextDefaultName`-assigned
 * `data.name` ("CAMERAINPUT" → 1, "CAMERAINPUT3" → 3). Names are assigned
 * monotonically at add time, so ordinals survive deletions ("camera 2"
 * stays "camera 2" after "camera 1" is unmapped) and agree across
 * collaborators (the name is synced node data). Null when the name is
 * missing or user-shaped.
 */
export function cameraNumberOf(node: CameraNodeLike): number | null {
  const name = typeof node.data?.name === 'string' ? (node.data.name as string) : null;
  if (!name) return null;
  const m = /^CAMERAINPUT(\d*)$/.exec(name);
  if (!m) return null;
  return m[1] === '' ? 1 : Number(m[1]);
}

/** The menu-mapped cameras in `nodes`, sorted by ordinal (unparseable
 *  names last, id as the tiebreak) so every client lists the same order. */
export function listWorkflowCameras<T extends CameraNodeLike>(
  nodes: ReadonlyArray<T>,
): T[] {
  const cams = nodes.filter((n) => isWorkflowCameraNode(n));
  return cams.sort((a, b) => {
    const na = cameraNumberOf(a) ?? Number.POSITIVE_INFINITY;
    const nb = cameraNumberOf(b) ?? Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The camera's saved device id (`node.data.deviceId` — the SAME key the
 *  CameraInputCard persists its dropdown pick to), or null. */
export function readCameraDeviceId(node: CameraNodeLike): string | null {
  const d = node.data;
  return d && typeof d['deviceId'] === 'string' ? (d['deviceId'] as string) : null;
}

/** Minimal MediaDeviceInfo shape (structural — unit tests need no DOM). */
export interface DeviceLabelLike {
  deviceId: string;
  label: string;
}

/**
 * The menu row label — the owner's spec verbatim: "device label or
 * 'camera N'". The device label resolves LOCALLY (deviceIds/labels are
 * browser-instance-local and only visible post-permission); when the
 * saved device isn't resolvable here — no pick yet, permission not
 * granted, or a collaborator's camera — fall back to the stable ordinal.
 */
export function cameraRowLabel(
  node: CameraNodeLike,
  devices: ReadonlyArray<DeviceLabelLike>,
): string {
  const deviceId = readCameraDeviceId(node);
  if (deviceId) {
    const label = devices.find((d) => d.deviceId === deviceId)?.label;
    if (label) return label;
  }
  const n = cameraNumberOf(node);
  return n === null ? 'camera' : `camera ${n}`;
}

/** The cap-refusal message the ＋ row surfaces (mirrors asset-spawn's
 *  generic maxInstances message shape). */
export function cameraCapMessage(cap: number): string {
  return `${WORKFLOW_CAMERA_TYPE} limit reached (${cap} per rack)`;
}

/** Node-record shape wouldExceedCap consumes (the live patch.nodes). */
type NodeRecord = Record<string, { type: string; data?: { pinned?: unknown } | null } | null | undefined>;

/**
 * Would adding ONE more camera exceed cameraInput's `maxInstances`?
 * Counts through graph/cap.ts (the single counting truth), so hidden
 * mapped cameras AND ordinary canvas CAMERA cards both consume the
 * budget — the def's cap is a per-rack hardware-sanity limit, not a
 * per-presentation one.
 */
export function workflowCameraAtCap(nodes: NodeRecord | ReadonlyArray<CameraNodeLike>): boolean {
  const record: NodeRecord = Array.isArray(nodes)
    ? Object.fromEntries((nodes as ReadonlyArray<CameraNodeLike>).map((n) => [n.id, n]))
    : (nodes as NodeRecord);
  return wouldExceedCap(record, cameraInputDef);
}

// ---------------------------------------------------------------------------
// Store-bound drivers (media/asset-spawn.ts pattern)
// ---------------------------------------------------------------------------

export interface CameraAddOptions {
  /** Surface a user-facing refusal (cap hit). Optional. */
  onError?: (message: string) => void;
}

/**
 * Map a new camera: create a hidden cameraInput node in ONE transact.
 * Cap-guarded exactly like spawnFromPalette (wouldExceedCap re-checked
 * against the LIVE nodes). Returns the new node id, or null on refusal.
 *
 * The node is a full CAMERA instance — `data.hiddenCard` is the only
 * thing distinguishing it from a palette spawn. Position is inert while
 * hidden (flowNodes skips it); kept sane in case the flag is ever
 * cleared. deviceId is NOT written here: source assignment is the hosted
 * CameraInputCard's own pick → `node.data.deviceId` flow, untouched.
 */
export function addWorkflowCamera(opts: CameraAddOptions = {}): string | null {
  if (wouldExceedCap(patch.nodes, cameraInputDef)) {
    opts.onError?.(cameraCapMessage(cameraInputDef.maxInstances ?? 0));
    return null;
  }
  const id = `wfcam-${crypto.randomUUID().slice(0, 8)}`;
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type: WORKFLOW_CAMERA_TYPE,
      domain: 'video',
      position: { x: 24, y: 24 },
      params: {},
      data: {
        hiddenCard: true,
        name: nextDefaultName(patch.nodes, WORKFLOW_CAMERA_TYPE),
      },
    } as ModuleNode;
  }, LOCAL_ORIGIN);
  return id;
}

/**
 * Unmap a camera: delete the module + every edge touching it through the
 * standard remove path (removePatchNode — one origin-tagged transact).
 * Mapped cameras are never pinned, so this always succeeds for a live
 * node. Confirm-free by design: re-adding is one ＋ click.
 */
export function unmapWorkflowCamera(nodeId: string): boolean {
  return removePatchNode(nodeId);
}
