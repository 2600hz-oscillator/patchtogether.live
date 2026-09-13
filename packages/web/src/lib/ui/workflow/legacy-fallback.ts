// Lane rendering is derived locally; do not persist this view state to Y.Doc.

/** What a module renders as in its workflow lane (see the file header).
 *
 *  ⚠ THREE MEMBERS, AND THE SET IS CLOSED BY CONSTRUCTION: a node is either
 *  docked ('stub'), a snowflake that owns its own surface ('native'), or a
 *  faceplate tile ('shell'). There is no fourth thing a module can be, which is
 *  why `laneRenderKind` has no fall-through arm. */
export type LaneRenderKind = 'shell' | 'native' | 'stub';

// CADILLAC owns a roaming sprite and is filtered out of flowNodes upstream.
export const NON_SHELL_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'cadillac',
]);

export interface LaneRenderInput {
  /** An explicit persisted dock entry, not transient dock visibility. */
  userDocked: boolean;
  type: string;
  /** Supplied by the caller from NON_SHELL_LANE_TYPES. */
  laneNative: boolean;
}

// Explicit docking takes precedence over the native-surface exemption.
export function laneRenderKind(i: LaneRenderInput): LaneRenderKind {
  if (i.userDocked) return 'stub';
  return i.laneNative ? 'native' : 'shell';
}

/**
 * Shared by lane and camera hosts. Native types use their own node type;
 * CADILLAC is filtered out before xyflow renders it.
 */
export function emittedTypeFor(kind: LaneRenderKind, moduleType: string): string {
  switch (kind) {
    case 'stub':
      return 'dockStub';
    case 'shell':
      return 'moduleShell';
    case 'native':
    default:
      return moduleType;
  }
}

export function isLaneNative(type: string): boolean {
  return NON_SHELL_LANE_TYPES.has(type);
}
