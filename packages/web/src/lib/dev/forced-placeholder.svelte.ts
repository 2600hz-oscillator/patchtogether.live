// packages/web/src/lib/dev/forced-placeholder.svelte.ts
//
// THE FORCED-PLACEHOLDER TEST SEAM (#2068) — render a module through the
// UN-MIGRATED lane/dock path even after it has been promoted.
//
// ── WHY IT HAD TO BE BUILT ───────────────────────────────────────────────────
// Some defects live in the un-migrated RENDER PATH but are not about any
// particular module. `midi-binding-node-lifetime.spec.ts` is the standing
// example: #1727 is "a CC bound to a module whose card is not mounted anywhere
// is silently inert", and `<ModuleShellPlaceholder>` is simply the cheapest way
// to reach the state where NO control has registered a setter. The defect class
// outlives the face migration — the graph-level dispatch fallback is permanent —
// but its SUBJECT did not: the spec was re-pointed twice in one day
// (`wavecel` → `depolarizer` → `moog956`) and at the time `moog956` was the last
// un-promoted module that fits. #2068 recorded the conclusion rather than taking
// a third re-point: what such a spec needs is a way to ASK for the placeholder
// path, not a module that happens still to be on it.
//
// ⚠ AND THE POOL IS NOW EMPTY — `moog956` was promoted on 2026-09-02, so there
// is no un-promoted module left to re-point to and the third re-point this seam
// refused to take is no longer even available. The seam is the only way to reach
// the placeholder path; that is the argument holding, not a claim going stale.
//
// ⚠ AND A REGISTERED FIXTURE MODULE IS NOT THE ANSWER, which is why this is a
// render seam and not a def. A "never promoted" module in the registry would
// auto-enrol in every registry-driven sweep (VRT, the per-module I/O sweeps, the
// docs catalog, the face-migration inventory's own remaining-count), and the
// owner has ruled that EVERYTHING migrates and the legacy UI is then deleted —
// so a durable un-migrated fixture subject may not exist. A seam has no def, no
// ports, no card and no inventory row; it disappears with the branch it reaches
// when that branch is deleted.
//
// ── WHY IT CANNOT LEAK INTO PRODUCTION ───────────────────────────────────────
// `testHooksEnabled()` (DEV, or a build with `VITE_E2E_HOOKS=1` — the same gate
// `__patch` / `__ydoc` / `__flow` / `?seed=none` already use) guards BOTH ends:
//
//   * the window hook is the ONLY writer, and it is not installed at all unless
//     the gate is open — there is no URL parameter, no localStorage key and no
//     exported setter that product code could reach;
//   * `forcedUnmigrated()` re-reads the same gate, so in a real production
//     build it constant-folds to `false` and the state below is unreachable
//     dead code even if a writer somehow existed.
//
// It is a FIXTURE, not a product mode: nothing in the app links to it and no
// user-facing behaviour branches on it. On the dev/autotest deploys it is
// exactly as reachable as the test hooks already shipped there.

import { testHooksEnabled } from './test-hooks';

/** The types currently forced onto the un-migrated render path.
 *
 *  `$state`, not a plain `let`, because the seam has to be usable AFTER the
 *  rack has booted: a spec that sets it from `page.evaluate` must move the lane
 *  that is already on screen, and Canvas's `flowNodes` derivation is what has to
 *  re-run. (A test may also set it before boot via `addInitScript` — the pending
 *  list below is what makes that work.) */
let forced = $state<ReadonlySet<string>>(new Set());

/**
 * Should this type render through the UN-MIGRATED path even though
 * `migrated(type)` says yes?
 *
 * Read by Canvas's ONE promotion-evaluation site (`laneMigrated`), so every
 * surface Canvas injects a `migrated` boolean into — the lane tile, the dock
 * full view, the dock rail, the 🎧 audio-I/O panel — agrees. A forced type is
 * indistinguishable from an un-promoted one at render time, which is the whole
 * point: the spec exercises the real branch, not a test-only imitation of it.
 */
export function forcedUnmigrated(type: string): boolean {
  return testHooksEnabled() && forced.has(type);
}

/** The pending list a spec may seed from `addInitScript`, BEFORE this module
 *  has evaluated. Without it a pre-boot write would land on a global the
 *  installer then overwrites. */
interface ForcedPlaceholderWindow {
  __forceUnmigrated?: (types: readonly string[]) => string[];
  __forceUnmigratedPending?: readonly string[];
}

/**
 * Install `window.__forceUnmigrated(types) → string[]`, returning the resulting
 * set so a spec asserts what it asked for rather than assuming it.
 *
 * Called from Canvas's existing `testHooksEnabled()` mount block; a no-op
 * everywhere else, including every real production build.
 */
export function installForcedPlaceholderHook(): void {
  if (!testHooksEnabled() || typeof window === 'undefined') return;
  const w = window as unknown as ForcedPlaceholderWindow;
  w.__forceUnmigrated = (types: readonly string[]): string[] => {
    forced = new Set(types);
    return [...forced].sort();
  };
  const pending = w.__forceUnmigratedPending;
  if (pending && pending.length > 0) w.__forceUnmigrated(pending);
}
