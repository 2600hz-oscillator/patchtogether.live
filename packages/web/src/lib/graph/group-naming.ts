// packages/web/src/lib/graph/group-naming.ts
//
// Helpers for assigning + migrating user-facing group names.
//
// The canvas displays a group's name from `data.label`. Historically this
// defaulted to the literal "GROUP!" placeholder, which is fine for one group
// but useless once there are several. This file centralizes:
//
//   - nextGroupName(existing): given the set of existing groups in a rack,
//     return the next `GROUP<N>` slot that isn't already taken.
//   - planDefaultGroupNames(nodes): one-shot migration — returns a list of
//     {groupId, name} for every group whose label is missing or matches the
//     legacy "GROUP!" placeholder. Caller wraps the assignments in a single
//     ydoc.transact so peers converge atomically.
//
// Pure functions. No Yjs, no DOM, no side effects. Iterating groups in
// id-sorted order makes the migration deterministic — every peer that runs
// the same migration produces the same name assignments.
//
// NOTE: we walk only the `nodes` map (filtered by `type === 'group'`). We
// don't recurse through any group's `data.childIds`, so this code path does
// not share the enumeration bug being tracked in issue #187 (where group
// children are looked up via `data.exposedPorts`).

import type { ModuleNode } from './types';

/** The legacy placeholder. Treated as "no real name" by the migration. */
export const LEGACY_GROUP_PLACEHOLDER = 'GROUP!';

/** The prefix used by auto-assigned names. */
const AUTO_PREFIX = 'GROUP';

/** Pull a string label off a group node's data. Returns undefined for any
 *  shape mismatch — caller treats that the same as "no label". */
export function readGroupLabel(node: ModuleNode): string | undefined {
  const data = node.data as { label?: unknown } | undefined;
  if (!data) return undefined;
  if (typeof data.label !== 'string') return undefined;
  const trimmed = data.label.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

/** True when the label is unset, blank, or matches the legacy placeholder. */
export function isDefaultOrMissingLabel(node: ModuleNode): boolean {
  const label = readGroupLabel(node);
  if (label === undefined) return true;
  return label === LEGACY_GROUP_PLACEHOLDER;
}

/**
 * Compute the next free `GROUP<N>` slot given a set of existing names. The
 * search starts at N=1 and skips any slot already claimed. Names that don't
 * match the `GROUP<digits>` pattern are ignored — users renaming a group to
 * "Pad chain" doesn't burn a numeric slot.
 */
export function nextGroupName(existingNames: Iterable<string>): string {
  const taken = new Set<number>();
  for (const name of existingNames) {
    const m = /^GROUP(\d+)$/.exec(name.trim());
    if (m) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${AUTO_PREFIX}${n}`;
}

/**
 * Walk every group node in `nodes`, sorted by id (so peers converge), and
 * assign `GROUP<N>` to any group whose label is missing or is the legacy
 * "GROUP!" placeholder. Returns the assignments only; caller is responsible
 * for applying them inside a single ydoc.transact.
 *
 * Already-named groups are preserved verbatim — if a user picked "Pad chain"
 * the migration leaves it alone. Their name is also fed into the dedupe set
 * so we don't reuse it for an auto-assigned slot.
 */
export function planDefaultGroupNames(
  nodes: Record<string, ModuleNode | undefined>,
): Array<{ groupId: string; name: string }> {
  const groups: ModuleNode[] = [];
  for (const node of Object.values(nodes)) {
    if (!node) continue;
    if (node.type !== 'group') continue;
    groups.push(node);
  }
  groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Seed with names that are already user-set so we don't collide with them.
  const existingNames = new Set<string>();
  for (const g of groups) {
    if (isDefaultOrMissingLabel(g)) continue;
    const label = readGroupLabel(g);
    if (label) existingNames.add(label);
  }

  const out: Array<{ groupId: string; name: string }> = [];
  for (const g of groups) {
    if (!isDefaultOrMissingLabel(g)) continue;
    const name = nextGroupName(existingNames);
    out.push({ groupId: g.id, name });
    existingNames.add(name);
  }
  return out;
}

/**
 * Compute the default name for a brand-new group, given the current set of
 * group nodes (the one about to be added does NOT need to be included).
 * Wraps nextGroupName with the label-extraction logic.
 */
export function nextGroupNameForNewGroup(
  nodes: Record<string, ModuleNode | undefined>,
): string {
  const existingNames = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!node) continue;
    if (node.type !== 'group') continue;
    const label = readGroupLabel(node);
    if (label && label !== LEGACY_GROUP_PLACEHOLDER) existingNames.add(label);
  }
  return nextGroupName(existingNames);
}
