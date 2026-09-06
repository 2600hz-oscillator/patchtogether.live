// packages/web/src/lib/ui/modules/nibbles-game-actions.ts
//
// THE NIBBLES GESTURE SEAM — one implementation of RESET, of arrow-key
// steering, and of the two per-view screen preferences, called by every
// surface that offers them.
//
// ── WHY IT IS A PLAIN .ts MODULE ───────────────────────────────────────────
//
// The module-surfaces rule: "one-shot behavior belongs in one plain TypeScript
// action seam called by both legacy and v2 surfaces". `NibblesCard.svelte`
// owned all four of these inline, and promotion is exactly what stops that card
// rendering (`migrated('nibbles')` becomes true and `DockFullView` mounts
// `<ModuleShell>` instead), so a second copy in the body would be two spellings
// of one gesture with nothing able to see them diverge.
//
// It reaches the live engine through `getActiveEngine()` rather than the Svelte
// engine CONTEXT — already exported, already consumed from plain `.ts` by
// `manual-strike-actions.ts` — which is what lets a caller that is NOT a
// component use it, and what keeps the two surfaces on one implementation.
// Reading the engine at the moment of the press is exactly right: that is when
// a non-null engine is required.
//
// ── WHY RESET CANNOT REUSE `resolveManualStrike` ───────────────────────────
//
// That helper resolves a TOP-LEVEL read key that is itself callable — the one
// `MANUAL_STRIKE_KEY` names. NIBBLES answers `read(node, 'extras')` with an
// OBJECT and hangs `reset` off it, and adding a top-level `reset` key would be
// an edit to `nibbles.ts` — which IS in the WebGL attest basis, so it costs an
// owner-machine GPU re-attest CI cannot run. The resolution below is the same
// three-branch shape (no engine / no node / the handle answers with something
// uncallable), one indirection deeper.
//
// ⚠ AND THE CONSTANT IS NAMED RATHER THAN THE LITERAL QUOTED, deliberately:
// `manual-strike-wiring.test.ts`'s "one obvious place" leg greps every file in
// this directory for the audition key literals and does NOT strip comments, so
// quoting one here to EXPLAIN the difference would have enrolled this file as
// an offender. (Reported as an observation; the tree already owns a shared
// quote-aware stripper for exactly this class.)
//
// ── THE OBSERVABLE ─────────────────────────────────────────────────────────
//
// `extras.reset()` writes NOTHING to `params` and NOTHING to `node.data` — the
// game is factory-internal by design (`nibbles.ts` header: "never touches
// node.data, so the persistence layer naturally drops it") — so `readParam` and
// `readData`, the two oracles every other branch of the faces-parity sweep
// uses, are STRUCTURALLY UNABLE to see the press. The audition ledger is the
// next observable inward: did the seam resolve a callable off the live engine
// handle and call it. `delivered: false` is RECORDED, never dropped — "never
// pressed" and "pressed and reached nothing" must stay distinguishable.
//
// ⚠ AND THE PROBE THAT READS IT IS `face-nibbles.spec.ts`, NOT `faces-parity`,
// which is why RESET is a BODY BUTTON rather than a ranked `ShellActionCell`.
// That sweep spawns every module with `spawnPatch({ id, type, position })` and
// no `domain`, which `e2e/tests/_helpers.ts` defaults to `'audio'` — so a VIDEO
// module's factory is never constructed there and `read(node, 'extras')` is
// `undefined`. MEASURED on the default shell, both directions: spawned
// `domain: 'video'` the ledger records `delivered: true`; spawned the sweep's
// way, `delivered: false` on a perfectly live button. The face spec presses
// this seam on a REAL constructed module instead, which is strictly stronger.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { mutateNode, setNodeParam } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import type { NibblesHandleExtras } from '$lib/video/modules/nibbles';
import type { NibblesDirection } from '$lib/video/modules/nibbles-game';
import { recordAudition } from './audition-ledger';

/** The `read(node, key)` half of a PatchEngine — all this seam needs. Injected
 *  so every resolution below is testable with fakes, no browser and no
 *  AudioContext. */
export interface NibblesEngineLike {
  read(node: ModuleNode, key: string): unknown;
}

/** The read key the factory answers with the card-facing handle. */
export const NIBBLES_EXTRAS_KEY = 'extras';

/**
 * The node's live extras handle, or `null` when the gesture is genuinely
 * unavailable. THREE branches, each a real state:
 *   * no engine (the AudioContext has not booted — nothing exists to reset);
 *   * no node (the module was removed between render and press);
 *   * the handle answers `extras` with something that is not an object, or
 *     with an object whose `reset` is not callable — a half-implemented seam.
 *
 * Returning null rather than throwing is deliberate: a gesture that cannot fire
 * is a no-op, never an error dialog over a rack. PURE.
 */
export function resolveNibblesExtras(
  engine: NibblesEngineLike | null | undefined,
  node: ModuleNode | undefined,
): NibblesHandleExtras | null {
  if (!engine || !node) return null;
  const extras = engine.read(node, NIBBLES_EXTRAS_KEY);
  if (!extras || typeof extras !== 'object') return null;
  return extras as NibblesHandleExtras;
}

/** The node's RESET callable, or null on any of the three unavailable states
 *  plus a fourth: an extras object that carries no callable `reset`. PURE. */
export function resolveNibblesReset(
  engine: NibblesEngineLike | null | undefined,
  node: ModuleNode | undefined,
): (() => void) | null {
  const extras = resolveNibblesExtras(engine, node);
  const fn = (extras as { reset?: unknown } | null)?.reset;
  return typeof fn === 'function' ? (fn as () => void) : null;
}

/**
 * Restart the game at the live node — the action every surface calls through
 * (the shell `action` cell). Returns whether a reset actually fired, so a
 * caller can drive a press flash off the truth instead of off the click.
 */
export function fireNibblesReset(nodeId: string): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const reset = resolveNibblesReset(getActiveEngine(), node);
  if (!reset) {
    // ⚠ RECORDED, NOT SILENT. See the header: this is the state the whole
    // action-cell probe turns on.
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  reset();
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  return true;
}

/**
 * Push one steering direction at the live node. Returns the FACTORY's own
 * answer — `pushDirection` returns false while AUTO is on — so a surface can
 * show that the arrow keys are inert without re-deriving the rule.
 *
 * ⚠ NOT AN AUDITION. It is not a one-shot "prove the instrument sounds"
 * gesture; it is continuous play, and a ledger record per arrow press would be
 * a write storm on the module's normal use.
 */
export function pushNibblesDirection(nodeId: string, dir: NibblesDirection): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const extras = resolveNibblesExtras(getActiveEngine(), node);
  const push = (extras as { pushDirection?: unknown } | null)?.pushDirection;
  if (typeof push !== 'function') return false;
  return (push as (d: NibblesDirection) => boolean).call(extras, dir) === true;
}

/** The four arrow keys, as the directions the game speaks. PURE — exported so
 *  both surfaces map keys the same way and the mapping is unit-testable. */
export function nibblesDirectionForKey(key: string): NibblesDirection | null {
  switch (key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    default: return null;
  }
}

/** Flip AUTO through the SANCTIONED, undoable, synced write.
 *
 * ⚠ THIS REPLACES A LEDGERED RAW WRITE. `NibblesCard.svelte` used to do
 * `patch.nodes[id].params.auto = …` directly, carried in `raw-write-ledger.ts`
 * as `kind: 'debt'` — "card button write — user gesture, should be undoable +
 * synced". Promotion would have made that path UNREACHABLE without paying it:
 * the face's toggle cell writes through the shell's sanctioned path, so a
 * player could no longer reach the raw write while the code and the ledger
 * entry both stayed, green forever, describing a path nobody can take. The
 * entry is deleted in the same commit. */
export function toggleNibblesAuto(nodeId: string): void {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return;
  const on = (node.params?.auto ?? 0) >= 0.5;
  setNodeParam(nodeId, 'auto', on ? 0 : 1);
}

// ── THE TWO PER-VIEW SCREEN PREFERENCES ────────────────────────────────────
//
// ⚠ BOTH LIVE ON `node.data`, AND FOR SCALE THAT IS A BUG FIX RATHER THAN A
// PORT. `NibblesCard.svelte` held the zoom in component `$state`, and under the
// shipping shell an un-migrated module's card exists ONLY inside the dock full
// view — so collapsing the pane already reset a user's 4x zoom to 1x today, and
// the dock's LRU eviction did it to a module the user never touched. That is
// the #1531 / #1574 / #1583 class verbatim. "SCALE must survive promotion" and
// "SCALE is broken" have the same fix.
//
// ⚠ AND SCALE MUST NOT BECOME A ParamDef. A param would be a `nibbles.ts` edit
// — a GPU re-attest — to express a per-view preference that has no business in
// the audio contract or on a Push 2 encoder.

/** The zoom steps the screen cycles, in multiples of the native 320x200. */
export const NIBBLES_SCALE_STEPS = [1, 2, 3, 4] as const;

/** This node's stored preview zoom. Absent, malformed, or anything that is not
 *  EXACTLY one of the declared steps ⇒ 1, so a rack saved before this change
 *  opens unchanged and a hand-edited or foreign value cannot strand the button
 *  on a position the cycle can never leave. ⚠ Deliberately NOT rounded: the
 *  only writer is `cycleNibblesScale`, which can only ever store a step, so a
 *  fractional value means something else wrote it and 1 is the honest answer.
 *  PURE. */
export function nibblesPreviewScale(node: ModuleNode | undefined): number {
  const raw = node?.data?.previewScale;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1;
  return (NIBBLES_SCALE_STEPS as readonly number[]).includes(raw) ? raw : 1;
}

/** The next zoom in the 1 -> 2 -> 3 -> 4 -> 1 cycle. Anything outside the
 *  declared steps lands on 1, so a hand-edited rack cannot strand the button on
 *  a value the cycle can never leave. PURE. */
export function nextNibblesScale(current: number): number {
  const i = (NIBBLES_SCALE_STEPS as readonly number[]).indexOf(current);
  if (i === -1) return NIBBLES_SCALE_STEPS[0];
  return NIBBLES_SCALE_STEPS[(i + 1) % NIBBLES_SCALE_STEPS.length]!;
}

/** Advance the zoom one step, on the node so it survives a remount. */
export function cycleNibblesScale(nodeId: string): void {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const next = nextNibblesScale(nibblesPreviewScale(node));
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    live.data.previewScale = next;
  });
}

/** Is this node's screen collapsed? Absent ⇒ false ⇒ ON, so an existing rack
 *  opens unchanged. ⚠ The SAME `previewCollapsed` key every other video face
 *  uses — a different key would silently re-open every preview a player had
 *  collapsed. PURE.
 *
 *  ⚠ THE READER LIVES HERE AND THE WRITER DOES NOT, which is the opposite of
 *  every other gesture in this file. SCREEN has exactly ONE writer — the
 *  faceplate body — because the ruling that requires a screen switch arrived
 *  with the faceplate, so there is no second caller to keep in step; and
 *  `video-face-screen-source.test.ts` reads the BODY's source for a literal
 *  `.data.previewCollapsed =` write, which is the leg separating a body that
 *  can toggle the screen from one that only displays its state. Keeping that
 *  write literal is better than widening a gate to chase a helper. */
export function nibblesPreviewCollapsed(node: ModuleNode | undefined): boolean {
  return (node?.data?.previewCollapsed as boolean | undefined) ?? false;
}

/**
 * The SPEAKABLE half of a picture that paints no text at all.
 *
 * ⚠ THE CARD'S `LEN {n}` ROW IS DELETED BY THE RESTING-TEXT RULING AND HAS NO
 * IN-CANVAS FALLBACK — measured at the source: `paintFrame` draws a background,
 * a border ring, the food cell, the snake and a scanline darken, and there is
 * no `fillText`, no glyph table and no font anywhere in it. Unlike frogger and
 * modtris, whose HUDs the game itself paints, the ruling does not RELOCATE this
 * readout, it DELETES it. Restoring a painted score would be a `paintFrame`
 * edit on a file in the WebGL attest basis, i.e. an owner-machine re-attest, so
 * it is not folded into a face PR: it is a separate, priced, owner-facing
 * change.
 *
 * This is where the length and the dagger become speakable and assertable. It
 * is an `aria-label` on a `role` frame, never a text node. PURE. */
export function nibblesScreenLabel(
  score: number | null,
  alive: boolean,
  autoOn: boolean,
): string {
  if (score === null) return 'NIBBLES — the game screen';
  const life = alive ? 'alive' : 'dead';
  const driver = autoOn ? 'auto-play on' : 'arrow keys';
  return `NIBBLES — length ${score}, ${life}, ${driver}`;
}

/** The `aria-valuetext` for the TICK dial: the milliseconds a player sets AND
 *  the rate they actually feel. ⚠ It is DERIVED (`1000 / tick_ms`) rather than
 *  a second stored number, and it is on the accessible name rather than painted
 *  — a `units`/`format` declaration on the ParamDef would make the readout
 *  paint a resting decimal under the dial AND would be a `params` edit on a def
 *  in the WebGL attest basis. PURE. */
export function nibblesTickValueText(tickMs: number): string {
  const clamped = Math.max(40, Math.min(200, tickMs));
  const perSecond = 1000 / clamped;
  // One decimal, and only when it is not a whole number — 12.5 and 25, never
  // "25.0". This string is an accessible name, not a readout.
  const rate = Number.isInteger(perSecond) ? `${perSecond}` : perSecond.toFixed(1);
  return `${Math.round(clamped)} ms — ${rate} ticks per second`;
}
