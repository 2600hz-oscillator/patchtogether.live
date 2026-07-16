// packages/web/src/lib/audio/automation-touch.ts
//
// TOUCH-SUSPEND CROSS-WIRE for the clip-launcher automation lane (task #183).
//
// A live grab of an AUTOMATED control (screen drag / MIDI CC / Electra twist)
// must SUSPEND that param's automation playback until the loop wrap ("live
// wins") — the client-local `suspended` set the AutomationController already
// owns. But the control that gets grabbed (a synth knob) has NO reference to
// the clip-player that automates it: the two are decoupled. This tiny registry
// is the seam between them.
//
//   - The clipplayer factory REGISTERS its controller here (keyed by node id)
//     on create and UNREGISTERS on dispose.
//   - Every user-gesture control-commit choke point (Knob/Fader pointer grab +
//     wheel, the MIDI-CC transient in makeMidiAssignable, the Electra host's
//     CC pump) calls `notifyAutomationTouch({ nodeId, paramId })`. The single
//     shared choke point is THIS function — screen and MIDI both route through
//     it, so the suspension seam is identical for both.
//   - The card reads `overriddenKeysFor` (for the override indicator) and calls
//     `reEnableAllFor` (the "re-enable automation" affordance).
//
// CHEAP BY DESIGN: a plain Map, and `notifyAutomationTouch` early-returns when
// nothing is registered (the overwhelmingly common case — no automation clip in
// the rack), so ordinary knob turns pay ~one Map.size check. Touch/override
// state stays CLIENT-LOCAL on the controller — never node.data — so this adds
// zero Yjs traffic.
//
// Type-only imports keep this a LEAF module (no runtime dependency on the
// controller/clip-types), so the low-level control components can import it
// without dragging in the audio-engine graph.

import type { AutomationTarget } from './modules/clip-types';
import type { AutomationController } from './modules/clip-automation-controller';

/** node id → the clip-player's AutomationController. One per clipplayer node. */
const controllers = new Map<string, AutomationController>();

/** Register a clip-player's controller (call on factory create). */
export function registerAutomationController(nodeId: string, ctrl: AutomationController): void {
  controllers.set(nodeId, ctrl);
}

/** Drop a clip-player's controller (call on dispose). */
export function unregisterAutomationController(nodeId: string): void {
  controllers.delete(nodeId);
}

/**
 * A live user grab of `target` (screen drag / MIDI CC / Electra) — suspend that
 * param's automation on EVERY registered controller until the loop wrap. Cheap
 * no-op when nothing is registered. The controller's `notifyTouch` is a set-add,
 * so a target no clip-player automates is harmless noise (playback only checks
 * its own tracks; the card intersects with real track keys for the indicator).
 */
export function notifyAutomationTouch(target: AutomationTarget): void {
  if (controllers.size === 0) return; // fast path: no automation in the rack
  for (const ctrl of controllers.values()) ctrl.notifyTouch(target);
}

/**
 * The PHYSICAL RELEASE of a grabbed control (screen pointer-up / MIDI-CC idle
 * timeout / Electra release) — end its automation override on EVERY registered
 * controller so playback resumes (gliding back to the envelope). Paired with
 * notifyAutomationTouch: touch-DOWN suspends, release re-enables, so an override
 * ends on the hand lifting rather than at the loop wrap. Cheap no-op when
 * nothing is registered.
 */
export function notifyAutomationRelease(target: AutomationTarget): void {
  if (controllers.size === 0) return; // fast path: no automation in the rack
  for (const ctrl of controllers.values()) ctrl.notifyRelease(target);
}

/** The override keys ("nodeId::paramId") currently suspended on a player's
 *  controller — for the card's override indicator. Empty when unregistered. */
export function overriddenKeysFor(nodeId: string): string[] {
  return controllers.get(nodeId)?.overriddenKeys() ?? [];
}

/** Re-enable ALL suspended params on a player's controller (the card's
 *  "re-enable automation" click). No-op when unregistered. */
export function reEnableAllFor(nodeId: string): void {
  controllers.get(nodeId)?.reEnableAll();
}

/** TEST-ONLY: drop every registration (isolates unit tests). */
export function __resetAutomationTouchRegistry(): void {
  controllers.clear();
}
