// port-patch-helpers.ts
//
// Pure helpers for the right-click "Patch to..." flow.
//
// The cascading menu (port → modules → ports) needs:
//   1. A list of every OTHER module in the patch (with display name + type label).
//   2. For a chosen target module, the list of ports that are type-compatible
//      with the source port. Direction matters: an OUTPUT source picks INPUTs
//      on the target; an INPUT source picks OUTPUTs.
//   3. For each candidate INPUT, whether it already has an incoming cable so
//      the menu can flag the entry as a destructive overwrite.

import type { Edge, ModuleNode, PortDef } from '$lib/graph/types';
import { canConnect, canConnectToPort } from '$lib/graph/types';
import {
  effectiveOutputType,
  makeAdoptionGraph,
  resolveEmittedType,
} from '$lib/graph/adopted-type';
import { isReservedDefaultName, readName } from '$lib/multiplayer/module-naming';
import { collapseStereoPorts } from '$lib/ui/stereo-jack-collapse';
import type { StereoPairDefLike } from '$lib/graph/stereo-pairs';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { VideoModuleDef } from '$lib/video/module-registry';
import type { MetaModuleDef } from '$lib/meta/module-registry';

/** Any-domain module def — they all share the port shape we need. Meta
 *  modules (sticky etc.) declare empty inputs/outputs so they're never
 *  actual candidates in the patch-to menu; including them in the union
 *  keeps the type plumbing uniform with the spawn + persistence paths. */
export type AnyDef = AudioModuleDef | VideoModuleDef | MetaModuleDef;

export interface ModuleEntry {
  nodeId: string;
  /** Display name shown in the menu — the user's rename verbatim when one
   *  exists (e.g. "feedback"), else the type label with a " #N" for
   *  multi-instance types (e.g. "ANALOG VCO #1"). */
  displayName: string;
  /** Module type label (e.g. "Analog VCO") shown beside the name whenever it
   *  differs from `displayName` — which is how a renamed entry keeps its
   *  type visible in the picker. */
  typeLabel: string;
}

export interface CandidatePort {
  /**
   * Stable row identity. NOT `portId` — a collapsed stereo target now offers
   * THREE rows (the pair, then its L and its R) and two of them address the
   * same `portId`, so keying a list on `portId` would collide.
   */
  key: string;
  /**
   * The port id the commit addresses. For a collapsed pair — stereo row AND
   * per-leg rows alike — this is the pair's LEFT port, because `planAudioCommit`
   * derives the sibling leg and applies `channelMode` symmetrically from
   * whichever endpoint carries the image. Naming the R port here instead would
   * be right for a mono source and WRONG for a paired one (it re-anchors the
   * clicked leg on the source side and the single surviving leg then lands on
   * the other target port — verified, and the reason this field is documented).
   */
  portId: string;
  /** Verbose label (already uppercased). */
  label: string;
  /** Type from the def — used to colour the row stripe. */
  cable: string;
  /**
   * Set ONLY on a per-leg row: which side of the collapsed stereo pair this row
   * patches. The caller turns it into `planAudioCommit`'s `channelMode`, so the
   * commit writes EXACTLY ONE edge.
   *
   * WHY THE ROWS EXIST (owner, 2026-08-07). His ES-9 rack returns two stereo
   * buses from hardware on jacks he chose by hand — `in14`→RET1 **L** with
   * `in13`→RET1 **R** (reversed), and `in11`/`in12` non-adjacent to them. The
   * source is a MONO ES-9 point, so the picker's source-side "patch only L/R"
   * rows are correctly hidden (a mono signal has no side to take), and the
   * target RET1 renders as ONE collapsed jack — leaving no gesture anywhere in
   * the app that says "just the L leg". Auto-spreading L to the next adjacent
   * jack was explicitly rejected: it would silently swap his channels.
   */
  leg?: 'left' | 'right';
  /** True on the parent STEREO row of a collapsed pair — the one that patches
   *  both legs. Lets the menu group the pair with its two per-leg children. */
  stereo?: boolean;
  /** When set, this is an INPUT port already receiving from another cable.
   *  Selecting it will replace the existing connection. */
  occupiedBy?: {
    sourceNodeId: string;
    sourcePortId: string;
    sourceDisplayName: string;
  };
}

/**
 * THE user-chosen name for a node, or undefined when the node has none.
 *
 * `data.name` alone is NOT that signal: `migrateAssignNames` runs on every
 * rack load, so a live node virtually always carries a name — usually the
 * auto-namer's reserved `<TYPE>`/`<TYPE>N` default (`CAMERA`, `CAMERA2`).
 * Only a name OUTSIDE the reserved shape is information the user added, and
 * that is the one worth preferring over the type-label composition below
 * (owner, #2264: a rear-card tooltip read "← FROM camera #1.OUT" while the
 * camera's tile said "feedback"). A rename is unique per rack by
 * construction (`validateRename` is case-insensitive-unique), so it never
 * needs a disambiguating " #N".
 */
function userRename(n: ModuleNode): string | undefined {
  const name = readName(n);
  if (!name) return undefined;
  return isReservedDefaultName(name, n.type) ? undefined : name;
}

/**
 * Compute display names for every module in the patch. A module the user
 * RENAMED shows that name verbatim (see `userRename`). Otherwise: when a
 * type has more than one instance, suffix with " #N" using insertion order;
 * single instances use the bare type label. Un-renamed output is
 * byte-identical to what this produced before renames were honoured —
 * that invariant is what keeps every VRT baseline still (fixtures never
 * rename).
 */
export function buildModuleEntries(
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
  excludeNodeId: string,
): ModuleEntry[] {
  const ids = Object.keys(nodes).filter((id) => nodes[id]);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(nodes[id]!.type, (counts.get(nodes[id]!.type) ?? 0) + 1);

  const indexByType = new Map<string, number>();
  const out: ModuleEntry[] = [];
  for (const id of ids) {
    const n = nodes[id]!;
    const idx = (indexByType.get(n.type) ?? 0) + 1;
    indexByType.set(n.type, idx);
    if (id === excludeNodeId) continue;
    const def = defLookup(n.type);
    const typeLabel = def?.label ?? n.type;
    const total = counts.get(n.type) ?? 1;
    // A renamed sibling still counts toward `total`, so the un-renamed
    // instances keep exactly the numbering they had before the rename.
    const displayName = userRename(n) ?? (total > 1 ? `${typeLabel} #${idx}` : typeLabel);
    out.push({ nodeId: id, displayName, typeLabel });
  }
  return out;
}

/** Module display name for a single node — same rename-then-numbering rule
 *  as buildModuleEntries. Used to label the source side of an occupied input,
 *  every remote endpoint in portConnections (rear-card chips + jack titles),
 *  the unpatch-menu rows and the drop-modal header. */
export function moduleDisplayName(
  nodeId: string,
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
): string {
  const n = nodes[nodeId];
  if (!n) return nodeId;
  const renamed = userRename(n);
  if (renamed) return renamed;
  const def = defLookup(n.type);
  const typeLabel = def?.label ?? n.type;
  const sameType = Object.values(nodes).filter(
    (other) => other && other.type === n.type,
  );
  if (sameType.length <= 1) return typeLabel;
  // Index by insertion order.
  const ids = Object.keys(nodes).filter((id) => nodes[id]?.type === n.type);
  const idx = ids.indexOf(nodeId);
  return `${typeLabel} #${idx + 1}`;
}

/**
 * Compute the candidate target ports on `targetDef` for a source port whose
 * cable type is `srcType` and whose direction is `srcDirection`.
 *
 * If `srcDirection === 'output'`, candidates are INPUT ports of the target
 * whose declared type satisfies canConnect(srcType, dstType).
 * If `srcDirection === 'input'`, candidates are OUTPUT ports of the target
 * whose declared type satisfies canConnect(dstType_actually_src_now, srcType).
 *
 * ⚠ "Declared type" is right for INPUTS and WRONG for a TYPE-TRANSPARENT
 * OUTPUT. A jack declaring `adoptsUpstreamFrom` emits whatever is patched into
 * the named input, so SCALER's `out` — declared `audio` — carries `cv` the
 * moment an LFO is on its `in`. Judged on the declaration, this cascade listed
 * NO compatible port on any CV-input module and the patch simply could not be
 * discovered. Both directions now resolve the OUTPUT side through the shared
 * upstream walk: `src` (optional, for the output-source direction) names the
 * jack the menu was opened on, and the input-source direction resolves each
 * candidate output against `targetNodeId`. With nothing upstream the walk
 * returns the declared type, so an unfed pass-through still lists nothing —
 * deliberate; see the unpatched-case note in graph/adopted-type.
 *
 * Returned list preserves the def's declared port order.
 */
export function compatibleTargetPorts(
  srcType: string,
  srcDirection: 'output' | 'input',
  targetDef: AnyDef,
  targetNodeId: string,
  edges: Partial<Record<string, Edge>> | Record<string, Edge>,
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
  /** The jack this menu was opened on. Optional for source compatibility; without
   *  it a TYPE-TRANSPARENT source output is judged on its declared type. */
  src?: { nodeId: string; portId: string },
): CandidatePort[] {
  const out: CandidatePort[] = [];
  // The live graph the pass-through walk needs, from the same maps this helper
  // is already handed — no new parameter, and no second walk.
  const adoption = makeAdoptionGraph(
    (Object.values(nodes).filter(Boolean) as ModuleNode[]),
    (Object.values(edges).filter(Boolean) as Edge[]),
    defLookup as never,
  );
  if (srcDirection === 'output') {
    // What the source jack ACTUALLY emits — its declared type unless it is a
    // pass-through with something on the input it adopts from.
    const emitted =
      (src ? resolveEmittedType(src.nodeId, src.portId, adoption) : undefined) ?? srcType;
    const compatible = targetDef.inputs.filter((p) =>
      // Honour a per-port `accepts` widening (e.g. a SCOPE probe taking the CV
      // family on an audio input) so the cascade matches the drag validator.
      canConnectToPort(emitted, p),
    );
    // ONE ENTRY PER STEREO PAIR — the same collapse the card's jack rows use,
    // so the picker offers the same jacks the panel shows — PLUS, for a pair,
    // its two legs as their own rows.
    //
    // The per-leg rows are the "patch to…" half of the per-side gesture. The
    // picker's source-side only-L/only-R rows can only appear when the SOURCE
    // carries a stereo image; a MONO source into a collapsed stereo target had
    // no per-side affordance at all, which is exactly the ES-9 return case
    // (`es9.in14` → mixmstrs `ret1L` alone). Drilling the pair open here covers
    // the other direction with the same one control: picking a leg row simply
    // means `channelMode = that side`.
    for (const p of collapseStereoPorts(
      compatible.map((p) => ({ id: p.id, label: portLabel(p), cable: p.type as string })),
      targetDef as unknown as StereoPairDefLike,
      'input',
    )) {
      const occupantOf = (portId: string) => {
        const occ = findOccupant(targetNodeId, portId, edges);
        return occ
          ? {
              sourceNodeId: occ.source.nodeId,
              sourcePortId: occ.source.portId,
              sourceDisplayName: `${moduleDisplayName(occ.source.nodeId, nodes, defLookup)}.${occ.source.portId}`,
            }
          : undefined;
      };
      const cable = p.cable ?? 'audio';
      if (!p.siblingId) {
        out.push({
          key: p.id,
          portId: p.id,
          label: p.label ?? p.id,
          cable,
          occupiedBy: occupantOf(p.id),
        });
        continue;
      }
      // A COLLAPSED PAIR. `collapseStereoPorts` emits the row at whichever
      // member came first in the def, so the side has to be read off `p.side`
      // rather than assumed — a rail that declares R before L still resolves
      // the same LEFT port here.
      const leftId = p.side === 'left' ? p.id : p.siblingId;
      const rightId = p.side === 'left' ? p.siblingId : p.id;
      const base = p.label ?? p.id;
      // The parent row is OCCUPIED if EITHER leg is — it replaces the whole
      // cable, and the warning has to say so. Each leg row speaks only for its
      // own leg, so an only-L cable does not flag the R row as destructive.
      out.push({
        key: `${leftId}|stereo`,
        portId: leftId,
        label: base,
        cable,
        stereo: true,
        occupiedBy: occupantOf(leftId) ?? occupantOf(rightId),
      });
      out.push({
        key: `${leftId}|left`,
        portId: leftId,
        label: `${base} L`,
        cable,
        leg: 'left',
        occupiedBy: occupantOf(leftId),
      });
      out.push({
        // ⚠ `portId` is the pair's LEFT port even on the RIGHT row — see the
        // CandidatePort.portId note. The R-ness travels in `leg`, and the
        // planner resolves the actual port from the pair.
        key: `${leftId}|right`,
        portId: leftId,
        label: `${base} R`,
        cable,
        leg: 'right',
        occupiedBy: occupantOf(rightId),
      });
    }
  } else {
    // The source is an INPUT — we're patching FROM the chosen target's
    // OUTPUT into our input. Compatibility is canConnect(targetOutputType,
    // srcType) — the cable runs from target → source.
    const compatible = targetDef.outputs.filter((p) =>
      // The TARGET's outputs are the sources here, so each is judged on what IT
      // emits — a SCALER already fed by a CV offers its `out` to a CV input.
      canConnect(effectiveOutputType(targetNodeId, p, adoption) as string, srcType),
    );
    // The source is an INPUT, so the user is choosing a SOURCE here and the
    // image is the source's to split — that is what the picker's own channel
    // rows do. No per-leg rows on this rail; see the `portMenuStereoPair`
    // note in Canvas.
    for (const p of collapseStereoPorts(
      compatible.map((p) => ({ id: p.id, label: portLabel(p), cable: p.type as string })),
      targetDef as unknown as StereoPairDefLike,
      'output',
    )) {
      out.push({
        key: p.id,
        portId: p.id,
        label: p.label ?? p.id,
        cable: p.cable ?? 'audio',
      });
    }
  }
  return out;
}

/**
 * The single occupancy check: returns the edge currently terminating on
 * (targetNodeId, targetPortId), or undefined if the input is free. Exported so
 * the stereo-autowire planner reuses the EXACT same "is this input occupied?"
 * logic the cascade uses — one source of truth.
 */
export function findOccupant(
  targetNodeId: string,
  targetPortId: string,
  edges: Partial<Record<string, Edge>> | Record<string, Edge>,
): Edge | undefined {
  for (const e of Object.values(edges)) {
    if (!e) continue;
    if (e.target.nodeId === targetNodeId && e.target.portId === targetPortId) {
      return e;
    }
  }
  return undefined;
}

function portLabel(p: PortDef): string {
  return p.id.toUpperCase();
}

/**
 * Live patch-status for every port of one module, derived from the edge set.
 *
 * Used by the on-card patch menu to show a filled/hollow jack indicator + a
 * hover overlay of the remote endpoint(s):
 *   - `inputs`  maps an INPUT portId → the remote sources feeding it. An input
 *     normally takes one cable, but the map is an array so a duplicate/edge race
 *     can't drop a tail — the menu shows the first (and the rest if present).
 *     Each entry is `"<RemoteDisplayName>.<SRCPORT-uppercased>"`.
 *   - `outputs` maps an OUTPUT portId → every consumer it fans out to. Each
 *     entry is `"<RemoteDisplayName>.<DSTPORT-uppercased>"`.
 *
 * Ports with no cable are simply absent from the map (a `.get()` miss = hollow).
 * Framework-free (no Svelte/Yjs) so it unit-tests cleanly.
 */
export function portConnections(
  edges: Partial<Record<string, Edge>> | Record<string, Edge>,
  nodeId: string,
  nodes: Partial<Record<string, ModuleNode>> | Record<string, ModuleNode>,
  defLookup: (type: string) => AnyDef | undefined,
): { inputs: Map<string, string[]>; outputs: Map<string, string[]> } {
  const inputs = new Map<string, string[]>();
  const outputs = new Map<string, string[]>();
  for (const e of Object.values(edges)) {
    if (!e) continue;
    // Defensive: an edge endpoint may be absent or half-formed for a beat — a
    // legacy/partial edge in the live store, or one mid-reconcile. This used to
    // be reached only lazily (the patch menu when OPENED), but the rear-view
    // back panel now derives port-connection status for EVERY card on EVERY
    // render, so a single malformed edge here would throw and tear down every
    // card on screen (SvelteFlow unmounts the whole NodeRenderer). Skip any
    // edge whose endpoints aren't both `{ nodeId, portId }` objects rather than
    // crash the render.
    const src = e.source;
    const dst = e.target;
    if (!src || !dst || typeof src.nodeId !== 'string' || typeof dst.nodeId !== 'string') {
      continue;
    }
    if (e.target.nodeId === nodeId) {
      const remote = `${moduleDisplayName(e.source.nodeId, nodes, defLookup)}.${e.source.portId.toUpperCase()}`;
      const list = inputs.get(e.target.portId);
      if (list) list.push(remote);
      else inputs.set(e.target.portId, [remote]);
    }
    if (e.source.nodeId === nodeId) {
      const remote = `${moduleDisplayName(e.target.nodeId, nodes, defLookup)}.${e.target.portId.toUpperCase()}`;
      const list = outputs.get(e.source.portId);
      if (list) list.push(remote);
      else outputs.set(e.source.portId, [remote]);
    }
  }
  return { inputs, outputs };
}
