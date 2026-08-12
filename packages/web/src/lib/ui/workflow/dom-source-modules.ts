// packages/web/src/lib/ui/workflow/dom-source-modules.ts
//
// THE DOM-SOURCE SEAM — why a video module can go DARK when the shell swaps its
// lane card, and the pure decision that keeps it alive.
//
// THE BUG (owner P0, `/rack?mode=workflow&shell=1`: "no video at all"):
// most video modules are self-contained GPU passes — the reconciler materializes
// them from the GRAPH (`VideoEngine.addNode`, $lib/audio/reconciler) and they
// render whether or not anything is mounted. A MINORITY are different: their
// pixels come from a DOM media element (`<video>` / `<img>`) that the module's
// own *Card.svelte creates, feeds (getUserMedia / a File blob / a URL) and hands
// to the engine handle via `VideoEngine.attachExternalSource(id, kind, el)`.
// For those, the ENGINE NODE exists but its SOURCE is null until the card mounts
// — and `onDestroy` explicitly detaches it again.
//
// Under `?shell=1` the lane renders <ModuleShellPlaceholder> / <ModuleShell>
// INSTEAD of the legacy card (see ./legacy-fallback). So for a DOM-source module
// the card never mounts, `attachExternalSource` never runs, the node emits a
// blank texture, and EVERY consumer downstream of it is black — the chain looks
// patched and is dead. Switching an already-running rack INTO the shell is worse:
// the card unmounts and actively DETACHES the live source.
//
// THE RULE THIS FILE ENCODES: the ENGINE-VISIBLE state of a rack must not depend
// on which UI renders a module. Node registration already satisfies that (it is
// graph-driven). Source ATTACHMENT does not — so when the shell swaps a
// DOM-source module's lane card away, Canvas keeps that module's REAL card
// mounted in an off-screen host (<HeadlessSourceHost>), exactly the way the
// workflow camera manager already keeps `hiddenCard` cameras alive
// (./CameraSurface: "Hidden hosts park OFF-SCREEN (fixed, left:-9999px) rather
// than display:none/visibility:hidden: an off-screen video element is the same
// scenario as a canvas card scrolled out of view — decode + rVFC keep running").
//
// SCOPE — this is deliberately about REGISTRATION, not rendering. The pull-eval
// visibility gating ($lib/video/pull-eval) is untouched: an off-screen tile still
// costs zero draws, the chain still only runs when something OBSERVES it. What
// changes is that the source is ATTACHED and therefore CAN run.
//
// PURE + registry-free (a plain string set + one boolean), so it unit-tests with
// no GL, no DOM and no engine — and it lives OUTSIDE `lib/video/**`, so it is
// hash-transparent to the WebGL attest.

import type { LaneRenderKind } from './legacy-fallback';

/**
 * Video module TYPES whose engine handle is fed by a CARD-OWNED DOM element via
 * `VideoEngine.attachExternalSource` — i.e. the card mount IS the source
 * lifecycle. Kept in sync with reality by a GREP GATE
 * (dom-source-modules.test.ts): the set must equal exactly the set of module
 * types whose resolved card component calls `attachExternalSource`, so a NEW
 * DOM-source module cannot ship dark under the shell.
 *
 * Note `cameraInput` is listed here even though it is ALSO a
 * NON_SHELL_LANE_TYPE (its real card always renders in the lane, so it is never
 * swapped and never needs the headless host — see `needsHeadlessSourceMount`,
 * which returns false for the 'legacy' kind). It stays in the set because the
 * set documents "this module's source lives on its card", which is true of
 * cameraInput and is exactly WHY it earned the carve-out.
 */
export const DOM_SOURCE_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'archivist',
  'cameraInput',
  'frametable',
  'loopback',
  'peertube',
  'tvLibrarian',
  'videobox',
  'videocube',
  'videovarispeed',
]);

/** Inputs to the headless-mount decision. */
export interface HeadlessSourceInput {
  /** What the lane decided to render for this node (./legacy-fallback). */
  kind: LaneRenderKind;
  /** The module type id. */
  type: string;
}

/**
 * Does this node need its REAL card kept alive in the off-screen host?
 *
 * TRUE only when BOTH hold:
 *   - the module's source lives on its card (DOM_SOURCE_LANE_TYPES), AND
 *   - the lane is NOT rendering that card:
 *       * 'shell' / 'placeholder' — the shell swapped it out  → YES,
 *       * 'legacy' — the card IS in the lane (?shell=legacy, or a
 *         NON_SHELL carve-out like cameraInput/videoOut) → no,
 *       * 'stub'   — the user DOCKED it, so the real card is mounted in the
 *         dock rail (DockCardHost) → no. Double-mounting would run TWO
 *         getUserMedia / two <video> elements for one node, and whichever
 *         unmounted last would detach the survivor's source.
 *
 * PURE — same inputs, same output, no side effects. Preview-off can never
 * produce 'shell'/'placeholder', so this is a strict no-op there.
 */
export function needsHeadlessSourceMount(i: HeadlessSourceInput): boolean {
  if (!DOM_SOURCE_LANE_TYPES.has(i.type)) return false;
  return i.kind === 'shell' || i.kind === 'placeholder';
}
