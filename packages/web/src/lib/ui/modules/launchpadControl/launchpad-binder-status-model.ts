// packages/web/src/lib/ui/modules/launchpadControl/launchpad-binder-status-model.ts
//
// EVERY STRING THE LAUNCHPAD BINDER BODY CAN PRODUCE — painted or not — decided
// here, where a unit test can read them.
//
// The shape is `midiclock-status-model.ts`'s and the reason is its reason
// verbatim: *"An unpainted string that is wrong is invisible to a VRT baseline
// and to a human reading one, so they are decided where a unit test can read
// them."* Most of what this file returns is an `aria-label` that no baseline
// and no reviewer will ever see, which is precisely why it needs a test.
//
// ── WHAT PROMOTION DELETED, AND WHERE EACH FINDING WENT ─────────────────────
//
// `LaunchpadControlCard.svelte:206-228` painted a NINE-BRANCH status sentence.
// The resting-text ruling permits the module NAME, section LABELS, control
// CAPTIONS and option/landmark NAMES — a state word, a derived node id and an
// instruction about a control that is on screen are none of those. So:
//
//   * "Not connected." / "Paired ✓" / "Single unit ✓"  → the LINK lamp. The
//     sentence is the lamp's `detail`, i.e. its `aria-label`.
//   * "Driving clip-player <n7>" — a derived NODE ID    → the CLIP lamp's
//     `detail`. ⚠ THIS IS THE FINDING THAT LOST ITS PAINTED SURFACE, named
//     rather than allowed to lapse: on a rack with two clip-players, WHICH ONE
//     the Launchpad drives is the only thing distinguishing them, and it is now
//     speakable instead of readable. It was in the LANE (the card was the lane
//     tile); it is now in the dock, on `aria-label`.
//   * "hit Bind to drive your clip-player"              → deleted outright. It
//     is an instruction about a control that is on screen, and the control's
//     own caption already says what it does.
//
// Three classes SURVIVE, and each is permitted for a stated reason:
//
//   * ERRORS (`errorLine`) — absent whenever nothing is wrong, which is the
//     discriminator midiclock's body already uses for its access failure.
//   * EMPTY-STATE COPY (`emptyLine`) — "Add a clip-player to drive." renders
//     only while `firstClipplayer()` is null, i.e. while the BIND control has
//     no object to act on, and is REPLACED by that control the moment one
//     exists. samsloop's `NO SAMPLE LOADED` / matrixMix's "Pick an X-axis…"
//     shape. ⚠ The card's parenthetical "(pairing auto-binds it)" is dropped:
//     that is a claim about BEHAVIOUR, not a naming of the empty state.
//   * THE PAIRING INSTRUCTION (`pairingLine`) — it exists only BETWEEN the
//     press of PAIR and the first pad hit on a physical unit. The ruling is
//     about the RESTING faceplate; this is not at rest and cannot be reached
//     without a gesture. It is also the only place in the product that says
//     what to do next during a handshake whose other affordance is on the
//     hardware.
//
// PURE + framework-free: no runes, no DOM, no device layer.

import type { SingleView } from '$lib/control/launchpad/launchpad-map';
import type { LaunchpadGestureOutcome } from '../launchpad-cell-actions';

/** Everything the body knows about the binder this frame. */
export interface LaunchpadBinderView {
  /** `midiAvailable()` — Web MIDI exists in this browser at all. */
  supported: boolean;
  /** A PAIR or a SINGLE unit is bound. */
  paired: boolean;
  /** The bound deployment is ONE unit (the L slot alone). */
  single: boolean;
  /** A handshake is in flight. */
  pairing: boolean;
  /** The single-unit role the lone device is currently painting. */
  view: SingleView;
  /** The clip-player node this Launchpad drives, or null. */
  boundNode: string | null;
  /** A clipplayer exists in the patch for BIND to act on. */
  hasClip: boolean;
  /** What the last gesture reported. */
  outcome: LaunchpadGestureOutcome;
}

/** The four single-unit roles, by their own names. These are the labels the
 *  legacy card prints on its segment (`LaunchpadControlCard.svelte:122-127`)
 *  and they are OPTION NAMES — the one text class the ruling permits on a
 *  control that has otherwise-identical siblings. */
export const LAUNCHPAD_VIEWS: readonly { id: SingleView; label: string }[] = [
  { id: 'grid', label: 'GRID' },
  { id: 'clip', label: 'CLIP' },
  { id: 'arranger', label: 'ARR' },
  { id: 'control', label: 'CTRL' },
];

/** The unabbreviated role name, for an accessible label. `ARR` and `CTRL` are
 *  the segment's own captions; a screen reader gets the whole word. */
export function launchpadViewName(view: SingleView): string {
  switch (view) {
    case 'grid': return 'Grid';
    case 'clip': return 'Clip';
    case 'arranger': return 'Arranger';
    case 'control': return 'Control';
  }
}

/**
 * The LINK lamp's `detail` — what is bound, and how.
 *
 * ⚠ It never restates the lamp. `lit` already says "something is bound"; this
 * says WHICH DEPLOYMENT, which the picture cannot carry.
 */
export function launchpadLinkDetail(v: LaunchpadBinderView): string {
  if (!v.supported) return 'Web MIDI is not available in this browser';
  if (v.pairing) return 'pairing — press a pad on the unit you want as LEFT';
  if (v.single) return `one Launchpad bound, painting the ${launchpadViewName(v.view)} view`;
  if (v.paired) return 'two Launchpads bound — LEFT is the clip matrix, RIGHT the command deck';
  return 'no Launchpad bound';
}

/**
 * The CLIP lamp's `detail` — WHICH clip-player, by node id.
 *
 * The card printed this id as a `<code>` in its status line. It is a derived
 * value, so it may not paint; it is also the only thing that distinguishes two
 * clip-players, so it may not be dropped either. `aria-label` is where the
 * ruling puts exactly this class.
 */
export function launchpadClipDetail(v: LaunchpadBinderView): string {
  if (v.boundNode) return `driving clip-player ${v.boundNode}`;
  if (!v.paired) return 'no clip-player bound — connect a Launchpad first';
  if (v.hasClip) return 'no clip-player bound — Bind attaches the one in this patch';
  return 'no clip-player bound, and none in this patch';
}

/**
 * The ERROR line, or null when nothing is wrong.
 *
 * All four branches are the legacy card's, verbatim in substance — an error is
 * permitted resting text precisely because it is ABSENT at rest.
 */
export function launchpadErrorLine(v: LaunchpadBinderView): string | null {
  if (!v.supported) {
    return 'Web MIDI isn’t available in this browser — connect a Launchpad in Chrome/Edge.';
  }
  switch (v.outcome) {
    case 'no-midi':
      return 'Couldn’t access MIDI — allow the permission prompt and try again.';
    case 'one-unit':
      return 'One Launchpad — use Connect single, or plug in both for the split.';
    case 'no-device':
      return 'No Launchpad detected — plug one in, then Connect single.';
    default:
      return null;
  }
}

/** The TRANSIENT handshake instruction, or null. Not resting text: it exists
 *  only while a gesture is in flight (see the header). */
export function launchpadPairingLine(v: LaunchpadBinderView): string | null {
  if (!v.supported || !v.pairing) return null;
  return 'Both Launchpads should light up (green + blue) — press any pad on the one you want as the LEFT (matrix) unit; the other becomes RIGHT.';
}

/**
 * The EMPTY-STATE line, or null.
 *
 * TWO empty states, in the order a player meets them, and each one names the
 * condition that is missing and vanishes when it is supplied:
 *
 *   1. NO DEVICE — the whole content of the plate before a handshake, which is
 *      midiclock's pre-connect hint one module over. It is REPLACED by the
 *      lamps going lit and the BIND control appearing.
 *   2. A DEVICE BUT NO CLIP-PLAYER — replaced by the BIND control itself, the
 *      instant there is anything for BIND to act on.
 *
 * ⚠ NEITHER LINE MAKES A CLAIM ABOUT BEHAVIOUR, deliberately. The card's
 * version of (2) read "Paired ✓ — add a clip-player module to drive (pairing
 * auto-binds it)", and the parenthetical is not a naming of the empty state —
 * it is a sentence about what the module will do, which is what the resting
 * -text ruling refuses. It is dropped rather than relocated.
 */
export function launchpadEmptyLine(v: LaunchpadBinderView): string | null {
  if (!v.supported || v.pairing) return null;
  if (!v.paired) return 'Connect a Launchpad to drive a clip-player.';
  if (v.hasClip || v.boundNode) return null;
  return 'Add a clip-player to drive.';
}

/**
 * The BIND control's caption.
 *
 * ⚠ A BUTTON'S CAPTION NAMES THE ACTION IT WILL PERFORM, so this one flips and
 * the `StatusLed` static-caption rule does not reach it. That rule is about a
 * LAMP, whose whole job is to be a picture and which must not be able to
 * smuggle a measurement through `lit ? 'LATE 3' : 'OK'`. `Bind` and `Unbind`
 * are two different actions; a control that named only one of them would lie
 * half the time. This is the shape the legacy card already ships (`:176`).
 */
export function launchpadBindLabel(v: LaunchpadBinderView): string {
  return v.boundNode ? 'Unbind clip-player' : 'Bind to clip-player';
}

/** Whether the BIND control has anything to act on — the card's own condition
 *  (`LaunchpadControlCard.svelte:169`), extracted so both the render and the
 *  test read one expression. */
export function launchpadBindVisible(v: LaunchpadBinderView): boolean {
  return v.supported && v.paired && (v.boundNode !== null || v.hasClip);
}

/** Whether the four-role segment has a role to pick — the card's condition
 *  (`:181`). In PAIR mode the roles are fixed by the hardware split, so the
 *  segment has no meaning and does not render. */
export function launchpadViewSegVisible(v: LaunchpadBinderView): boolean {
  return v.supported && v.paired && v.single;
}
