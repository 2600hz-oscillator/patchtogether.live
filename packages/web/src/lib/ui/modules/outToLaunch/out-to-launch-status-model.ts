// packages/web/src/lib/ui/modules/outToLaunch/out-to-launch-status-model.ts
//
// THE PURE HALF of the OUT TO LAUNCH faceplate body: every string and every
// visibility condition the plate needs, as functions of one view object, so the
// unit lane can drive all of them with no browser, no Web MIDI and no hardware.
//
// ── WHERE THE CARD'S TEXT WENT, AND WHY EACH MOVE IS FORCED ────────────────
//
// `OutToLaunchCard.svelte` painted four pieces of prose. The resting-faceplate
// ruling permits the module NAME, section LABELS, control CAPTIONS and
// option/landmark NAMES — and nothing else at rest. So:
//
//   | the card painted | where it is now |
//   |---|---|
//   | `MONITOR ACTIVE — this Launchpad's LEDs mirror the video. It can't be used for control while bound.` | the MONITOR lamp: `lit` IS the "active" half, and the sentence is its `detail` (`aria-label`/`title`) |
//   | `Bound to <code>{outputId}</code>.` | the same lamp's `detail` — WHICH device, on a rack that may hold several |
//   | `Web MIDI isn't available in this browser …` | an ERROR line, absent whenever nothing is wrong |
//   | `No Launchpad detected. …` | an ERROR line, same |
//
// ⚠ THE WARNING IS THE AFFORDANCE MOST AT RISK IN THIS PROMOTION, so it is
// worth being exact about what survives. "The bound surface can no longer be
// used for control" is DERIVED RESTING PROSE — a sentence about state — and a
// faceplate may not paint one. It is not dropped: it becomes the MONITOR lamp's
// `detail`, which `StatusLed` puts in BOTH `aria-label` and `title`, so it is
// speakable by a screen reader and readable on hover, and `lit` carries the
// same fact as a picture at rest. That is the route the ruling names for
// exactly this class, and it is what `launchpadControl` and `push2Control` both
// did with their own status lines.
//
// ⚠ AND IT IS NOT MERELY DECORATIVE PROSE — it is an EXCLUSIVITY warning with a
// mechanism behind it (`isOutputClaimed`: one owner per physical surface, so a
// bound Launchpad really is refused to LAUNCHPAD CONTROL). Losing it would lose
// a fact the player needs. Hence the lamp rather than deletion.

import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';
import type { OutToLaunchGestureOutcome } from '$lib/ui/modules/out-to-launch-cell-actions';

/** Everything the body knows about this node's monitor binding, this frame. */
export interface OutToLaunchBinderView {
  /** `midiAvailable()` — the browser exposes Web MIDI at all. */
  supported: boolean;
  /** This NODE holds a monitor claim (the device layer's `monitors` map). */
  bound: boolean;
  /** WHICH output port this node claimed, or null. */
  outputId: string | null;
  /** What the last CONNECT press reported. */
  outcome: OutToLaunchGestureOutcome;
  /** The Launchpad outputs CONNECT enumerated. Rows, never a count. */
  ports: readonly LaunchpadPort[];
}

/**
 * The MONITOR lamp's `detail` — the card's MONITOR ACTIVE banner and its
 * `Bound to …` line, fused into the one sentence the lamp cannot draw.
 *
 * ⚠ It never restates the lamp. `lit` already says "a Launchpad is being driven
 * by this node"; this says WHICH ONE, and what that costs the player — the two
 * things a two-state picture structurally cannot carry.
 */
export function outToLaunchMonitorDetail(v: OutToLaunchBinderView): string {
  if (!v.bound) {
    return 'No Launchpad is bound: this node drives no hardware and the picture below is the whole monitor.';
  }
  const which = v.outputId ?? 'an unnamed output';
  return `Driving ${which}: its LEDs mirror the video, so it cannot be used for control while bound.`;
}

/**
 * The ERROR line, or null when nothing is wrong.
 *
 * Both branches are the legacy card's, verbatim in substance. An error is
 * permitted resting text precisely because it is ABSENT at rest: on a healthy
 * browser with a Launchpad attached this function returns null forever.
 */
export function outToLaunchErrorLine(v: OutToLaunchBinderView): string | null {
  if (!v.supported) {
    return "Web MIDI isn't available in this browser — open in Chrome or Edge to drive a Launchpad.";
  }
  if (v.outcome === 'no-device') {
    return 'No Launchpad detected. Plug one in (it appears as a “… MIDI” port) and Connect again.';
  }
  return null;
}

/**
 * The EMPTY-STATE line, or null.
 *
 * Present only while there is nothing to pick and nothing bound — i.e. before
 * the CONNECT cell in the band below has ever been pressed — and REPLACED by
 * the picker the moment there is a roster, or by the lamp going lit.
 *
 * ⚠ IT NAMES THE MISSING CONDITION AND MAKES NO CLAIM ABOUT BEHAVIOUR. The
 * `launchpadControl` note records why: its card's version added "(pairing
 * auto-binds it)", which is a sentence about what the module will do, and the
 * ruling refuses that even inside an empty state.
 */
export function outToLaunchEmptyLine(v: OutToLaunchBinderView): string | null {
  if (!v.supported || v.bound) return null;
  if (v.ports.length > 0) return null;
  if (v.outcome !== 'idle') return null;
  return 'No Launchpad connected yet.';
}

/** Whether the port PICKER has anything to offer — the card's own condition
 *  (`OutToLaunchCard.svelte`: `{:else if ports.length > 0}`), extracted so the
 *  render and the test read ONE expression. */
export function outToLaunchPickerVisible(v: OutToLaunchBinderView): boolean {
  return v.supported && !v.bound && v.ports.length > 0;
}

/** Whether the UNBIND control has anything to act on — the card's `{:else if
 *  bound}` branch. */
export function outToLaunchUnbindVisible(v: OutToLaunchBinderView): boolean {
  return v.supported && v.bound;
}

/**
 * A port button's caption.
 *
 * ⚠ THE `(in use)` SUFFIX IS NOT A STATE WORD SMUGGLED INTO A CAPTION. It is
 * part of the OPTION NAME — it distinguishes two otherwise-identical entries in
 * a roster of physical devices, which is the one text class the ruling admits
 * on a control's own position — and it is the card's own text
 * (`OutToLaunchCard.svelte`, the `isClaimedByOther` ternary). A port already
 * claimed by another node or by LAUNCHPAD CONTROL renders DISABLED, so without
 * the suffix the roster would show a dead button with no reason given.
 */
export function outToLaunchPortLabel(port: LaunchpadPort, claimedByOther: boolean): string {
  return claimedByOther ? `${port.name} (in use)` : port.name;
}

/** A port button's `title` — why it is disabled, or what pressing it does.
 *  The card's own two strings. */
export function outToLaunchPortTitle(claimedByOther: boolean): string {
  return claimedByOther ? 'Already in use by another binding' : 'Bind as monitor';
}
