// packages/web/src/lib/multiplayer/module-naming.ts
//
// Auto-naming + uniqueness for module instances within a single rack.
//
// Every module gets a stable, human-readable name like `ANALOGVCO1`,
// `ANALOGVCO2`, `RIOTGIRLS1`. The name lives on `node.data.name` so it
// syncs via Y.Doc to every collaborator on the rack. The LIVECODE DSL
// addresses pre-existing modules by exactly this name (e.g.
// `ANALOGVCO1.frequency = 440`), so the naming has to be deterministic
// and unique-per-rack.
//
// Naming rules:
//   - Default name is `<TYPE_UPPERCASE><N>` where TYPE is the module's
//     `type` field uppercased, and N is the next-available positive
//     integer for that type. We compute N by scanning the existing
//     names of the same type for `<TYPE>(\d+)` and picking
//     `max(matches)+1` (with 1 if no matches). Gaps in the sequence
//     are NOT filled — once a module dies, its number is retired —
//     because a re-spawned module that re-uses an old name would let
//     a stale DSL script silently target the wrong instance.
//   - Names are case-insensitive for uniqueness purposes (we compare
//     uppercased) so a user can't sneak `analogVco1` past `ANALOGVCO1`.
//   - The default name format is reserved: only the auto-namer (or a
//     deliberate user edit to a `<TYPE>N` form) can write one. User
//     renames to anything else are accepted as long as they pass the
//     uniqueness check.

import type { ModuleNode, ModuleType } from '$lib/graph/types';

/** Maximum length we accept for a user-typed name. Prevents pathological
 *  inputs from blowing up the DSL parser or the card chrome. */
export const MAX_NAME_LENGTH = 32;

/**
 * Compute the next-available default name for a module of `type` given the
 * current set of node entries on the rack. Returns e.g. `ANALOGVCO1` if no
 * `analogVco` instances exist, `ANALOGVCO3` if `ANALOGVCO1` and `ANALOGVCO2`
 * already exist, etc.
 *
 * Scans node.data.name across ALL nodes (regardless of `type`) so a
 * user-typed name like `MYVCO` doesn't collide. The numeric tail logic
 * is keyed on the uppercased type prefix.
 */
export function nextDefaultName(
  nodes: Record<string, ModuleNode | undefined>,
  type: ModuleType,
): string {
  const prefix = String(type).toUpperCase();
  const re = new RegExp(`^${escapeRegex(prefix)}(\\d+)$`);
  let max = 0;
  for (const node of Object.values(nodes)) {
    if (!node) continue;
    const name = readName(node);
    if (!name) continue;
    const m = re.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

/**
 * Read the displayable name for a node. Returns `node.data.name` when set,
 * otherwise the result of `nextDefaultName` for that type — but the latter
 * is only useful at compute time; UI callers should prefer the helper that
 * returns just the stored name (and let the caller decide what to render
 * when none is set yet).
 */
export function readName(node: ModuleNode): string | undefined {
  const name = node.data?.name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Result of a rename attempt. `ok: true` => caller should write
 * `node.data.name = trimmed` inside a Y.Doc transact. `ok: false` =>
 * caller should display `error` (inline, e.g. red text under the input).
 */
export type RenameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Validate a candidate rename against the current rack state. Pure;
 * caller is responsible for the Y.Doc write on success.
 *
 * Rejection reasons (in priority order):
 *   1. Empty after trim                 → "Name cannot be empty"
 *   2. Whitespace inside                → "Name cannot contain spaces"
 *   3. Too long                         → "Name cannot exceed N chars"
 *   4. Disallowed character             → "Name must be letters/digits/_"
 *   5. Already used by another node     → "Name 'X' is already in use"
 *
 * Renames to the SAME current value are accepted as a no-op (ok: true,
 * name === current). This lets blur-after-no-edit pass cleanly.
 */
export function validateRename(
  nodes: Record<string, ModuleNode | undefined>,
  nodeId: string,
  candidate: string,
): RenameResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Name cannot be empty' };
  if (/\s/.test(trimmed)) return { ok: false, error: 'Name cannot contain spaces' };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Name cannot exceed ${MAX_NAME_LENGTH} chars` };
  }
  // DSL identifier shape: letters, digits, underscore. The DSL itself is
  // lowercase by convention but a name like `ANALOGVCO1` is referenced
  // with its exact (case-sensitive) form, so we permit any case here.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return { ok: false, error: 'Name must start with a letter or _ and contain only letters, digits, _' };
  }
  // Uniqueness check: case-insensitive. Compare against every OTHER node.
  const upper = trimmed.toUpperCase();
  for (const [otherId, other] of Object.entries(nodes)) {
    if (!other) continue;
    if (otherId === nodeId) continue;
    const otherName = readName(other);
    if (otherName && otherName.toUpperCase() === upper) {
      return { ok: false, error: `Name '${trimmed}' is already in use` };
    }
  }
  return { ok: true, name: trimmed };
}

/**
 * Resolve a name → node id, case-insensitive. Returns undefined when no
 * node carries that name. Used by the LIVECODE DSL evaluator to look up
 * a pre-existing module by name (e.g. `ANALOGVCO1.frequency = 440`).
 */
export function findNodeByName(
  nodes: Record<string, ModuleNode | undefined>,
  name: string,
): ModuleNode | undefined {
  const upper = name.toUpperCase();
  for (const node of Object.values(nodes)) {
    if (!node) continue;
    const n = readName(node);
    if (n && n.toUpperCase() === upper) return node;
  }
  return undefined;
}

/**
 * Migration: assign default names to every node that lacks one. Caller
 * is responsible for wrapping in `ydoc.transact`. Idempotent — nodes
 * with a name are left alone, so calling on every page load is fine.
 *
 * The naming order is by node id (lexicographic, stable across clients)
 * so two collaborators running the migration concurrently arrive at the
 * same final state. Y.Doc's last-write-wins on the data field gives us
 * convergence even if they race.
 */
export function migrateAssignNames(nodes: Record<string, ModuleNode | undefined>): number {
  const ids = Object.keys(nodes).sort();
  let assigned = 0;
  for (const id of ids) {
    const node = nodes[id];
    if (!node) continue;
    if (readName(node)) continue;
    const name = nextDefaultName(nodes, node.type);
    if (!node.data) node.data = {};
    node.data.name = name;
    assigned++;
  }
  return assigned;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
