// packages/web/src/lib/multiplayer/module-naming.ts
//
// Auto-naming + uniqueness for module instances within a single rack.
//
// Every module gets a stable, human-readable name like `ANALOGVCO1`,
// `ANALOGVCO2`, `MIXMSTRS1`. The name lives on `node.data.name` so it
// syncs via Y.Doc to every collaborator on the rack. The LIVECODE DSL
// addresses pre-existing modules by exactly this name (e.g.
// `ANALOGVCO1.frequency = 440`), so the naming has to be deterministic
// and unique-per-rack.
//
// Naming rules:
//   - The FIRST instance of a type gets the BARE prefix (e.g.
//     `WAVESCULPT`). Subsequent instances get `<TYPE><N>` starting at 2
//     (`WAVESCULPT2`, `WAVESCULPT3`, …). We drop the trailing `1` so a
//     single-instance rack reads cleanly + matches the legacy hardcoded
//     module-type labels.
//   - The bare prefix is conceptually slot 1. When picking the next
//     name, prefer the BARE slot if it's free; otherwise pick
//     `<TYPE>(max+1)` where max is the highest numeric suffix in use
//     (min 1, so the next numbered slot is always ≥ 2).
//   - Gaps in the numeric sequence are NOT filled — once a numbered
//     module dies, its number is retired — because a re-spawned module
//     re-using an old number could let a stale DSL script silently
//     target the wrong instance. The BARE slot CAN be refilled (if the
//     bare-named instance is deleted) since it's the "lowest" slot.
//   - Names are case-insensitive for uniqueness purposes (we compare
//     uppercased) so a user can't sneak `analogVco2` past `ANALOGVCO2`.
//   - The default name format is reserved: only the auto-namer (or a
//     deliberate user edit to a `<TYPE>` / `<TYPE>N` form) can write
//     one. User renames to anything else are accepted as long as they
//     pass the uniqueness check.

import type { ModuleNode, ModuleType } from '$lib/graph/types';

/** Maximum length we accept for a user-typed name. Prevents pathological
 *  inputs from blowing up the DSL parser or the card chrome. */
export const MAX_NAME_LENGTH = 32;

/**
 * Compute the next-available default name for a module of `type` given the
 * current set of node entries on the rack. The first instance gets the BARE
 * prefix (e.g. `ANALOGVCO`); subsequent instances get `<TYPE>N` starting at
 * 2 (`ANALOGVCO2`, `ANALOGVCO3`, …). If the bare slot is FREE (no node has
 * the bare name) it's always picked next — even if numbered instances
 * exist — because it's the "lowest" slot. Numeric gaps are NOT filled.
 *
 * Examples:
 *   no instances                                    → `ANALOGVCO`
 *   {a: 'ANALOGVCO'}                                → `ANALOGVCO2`
 *   {a: 'ANALOGVCO', b: 'ANALOGVCO2'}               → `ANALOGVCO3`
 *   {a: 'ANALOGVCO', b: 'ANALOGVCO4'}               → `ANALOGVCO5` (gaps retired)
 *   {a: 'ANALOGVCO2', b: 'ANALOGVCO3'} (bare freed) → `ANALOGVCO`
 *
 * Numeric gap handling: numbered names use `max(matches) + 1` (with min
 * 2 so we never produce `<TYPE>1`) — retired numbers stay retired so a
 * stale DSL script can't silently retarget a re-spawned slot. The BARE
 * slot is the sole exception — it CAN be re-filled when freed since
 * it's the "lowest" slot and any DSL reference would have to be
 * explicitly to the bare name.
 *
 * Scans node.data.name across ALL nodes (regardless of `type`) so a
 * user-typed name like `MYVCO` doesn't collide. The bare/numeric logic
 * is keyed on the uppercased type prefix.
 */
export function nextDefaultName(
  nodes: Record<string, ModuleNode | undefined>,
  type: ModuleType,
): string {
  const prefix = String(type).toUpperCase();
  const bareRe = new RegExp(`^${escapeRegex(prefix)}$`);
  const numRe = new RegExp(`^${escapeRegex(prefix)}(\\d+)$`);
  let bareTaken = false;
  // Start at 1 so an unnumbered bare instance is conceptually slot 1
  // and the first numbered slot we can hand out is always ≥ 2 — we
  // never produce the literal `<TYPE>1`.
  let max = 1;
  for (const node of Object.values(nodes)) {
    if (!node) continue;
    const name = readName(node);
    if (!name) continue;
    if (bareRe.test(name)) {
      bareTaken = true;
      continue;
    }
    const m = numRe.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  if (!bareTaken) return prefix;
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
 * Compute what the in-card title bar should display for a node.
 *
 * Precedence:
 *   1. `node.data.name` if set (user-edited or auto-assigned by migration)
 *   2. `defaultLabel` if the caller supplied one (in-card title surface —
 *      shows the module-type slug like "WAVESCULPT" for an unedited card)
 *   3. `nextDefaultName(...)` computed default (legacy fallback for the
 *      transient first paint before the migration in Canvas.svelte runs).
 *
 * Pure; safe to call from anywhere. The UI component ModuleNameLabel
 * mirrors this logic in its `$derived` so both stay in lockstep — this
 * helper exists for unit-testing the precedence rules without mounting
 * a Svelte component (vitest runs in `node`, no jsdom).
 */
export function resolveDisplayName(
  node: ModuleNode,
  nodes: Record<string, ModuleNode | undefined>,
  defaultLabel?: string,
): string {
  return readName(node) ?? defaultLabel ?? nextDefaultName(nodes, node.type);
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
