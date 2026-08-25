// packages/web/src/lib/ui/modules/push2Control/push2-binder-status-model.ts
//
// EVERY STRING THE PUSH 2 FACEPLATE BODY CAN PRODUCE, decided here.
//
// ── WHY A MODEL AND NOT `{#if}` IN THE COMPONENT ────────────────────────────
//
// `Push2ControlCard.svelte` painted a NINE-BRANCH status region: two capability
// warnings, a four-way status line and two display hints. Most of those
// branches need hardware, a permission decision or a browser without WebUSB to
// reach, so a dock baseline photographs exactly ONE of them and the other eight
// are invisible to every gate in the tree. Deciding them in a pure module means
// `push2-binder-status-model.test.ts` can read the ones no PNG will ever show.
//
// ── WHAT MOVED, AND WHAT IT COST ────────────────────────────────────────────
//
// The resting-text ruling permits the module NAME, section LABELS, control
// CAPTIONS and option/landmark NAMES — nothing else. Four of the card's strings
// are none of those and are DELETED rather than restyled:
//
//   * `Not connected.` — a STATE WORD about the module. → the PUSH lamp, whose
//     dark/lit state IS the sentence.
//   * `Driving clip-player <code>{id}</code> — <b>{VIEW}</b> view.` — a sentence
//     carrying a derived node id AND a derived state word. → the BOUND lamp's
//     `detail`, which reaches `aria-label`/`title` and never a text node.
//     ⚠ THE FINDING IS REAL AND IS NAMED HERE RATHER THAN ALLOWED TO LAPSE:
//     *which* clip-player this Push is driving. With `maxInstances: 1` there is
//     one Push and potentially many clip-players, so "bound" without "to what"
//     is materially less useful. It is speakable and assertable, and unpainted.
//   * `Push 2 ✓ — hit Bind to drive your clip-player.` — instructional copy
//     restating the state of a live BIND button sitting on the same plate.
//     → deleted outright; the dark BOUND lamp beside a live button says it.
//   * `Screen not connected ({displaySt}) — hit Connect display…` — a raw
//     status string interpolated into a hint. → the SCREEN lamp's `detail`,
//     with the part that actually matters carried by `tone` IN COLOUR: a
//     DECLINED display is a fault, an ABSENT one is not.
//
// And the card's `{card.title}` flip label goes too, because the canvas
// immediately above it ALREADY PAINTS the module's name in the push card's own
// header — the DOM label was a second copy of a string the picture draws a few
// pixels higher. Deleting it removes a duplicate rather than a finding.
//
// ⚠ `{card.index}/{card.count}` IS A DIFFERENT CASE AND IT DOES CARRY A
// FINDING: *there are N modules in this lane and you are looking at the i-th* —
// the only thing on the plate telling a player the ‹ › buttons have anywhere to
// go. Without it a lane with one module and a lane with six are the same
// picture. It moves to `aria-valuetext` on the flip control (`push2FlipValue`
// below). A sighted player operating the flip gets nothing, which is the
// ruling's intended trade and is stated rather than smoothed over.
//
// ── WHAT SURVIVES AS PAINTED TEXT, exhaustively ─────────────────────────────
//
//   * ERRORS — absent whenever nothing is wrong, which is what separates them
//     from a readout. Three of them, all capability failures.
//   * ONE EMPTY STATE — `push2EmptyLine`, present only while there is nothing
//     in the rack to bind to, and REPLACED by the BIND control the moment there
//     is. That is the shape wave 6 settled (samsloop's NO SAMPLE LOADED): a
//     placeholder naming the surface's own condition is not a measurement of
//     any control.
//   * CONTROL CAPTIONS and OPTION NAMES — `Bind to clip-player` / `Unbind
//     clip-player`, `Connect display`, the lane digits and the four view names.

import type { Push2GestureOutcome } from '$lib/ui/modules/push2-cell-actions';
import type { Push2DisplayStatus } from '$lib/control/push2/push2-display.svelte';
import type { SingleView } from '$lib/control/launchpad/launchpad-map';
import { PUSH2_VIEWS } from '$lib/meta/modules/push2-control';

/** Everything the body reads, in ONE snapshot — so every derivation below is a
 *  pure function of it and the unit lane can build states no runner reaches. */
export interface Push2BinderView {
  /** `navigator.requestMIDIAccess` exists in this browser. */
  supported: boolean;
  /** A Push is bound over Web MIDI. */
  connected: boolean;
  /** `navigator.usb` exists in this browser. */
  usbOk: boolean;
  /** The 960×160 display is open over WebUSB. */
  displayOn: boolean;
  /** The display layer's own status word. */
  displayStatus: Push2DisplayStatus;
  /** The clip-player node this Push drives, or null. */
  boundNode: string | null;
  /** The patch contains at least one clip-player. */
  hasClip: boolean;
  /** The active Launchpad-parity single-mode view. */
  view: SingleView;
  /** What the last CONNECT press reported. */
  outcome: Push2GestureOutcome;
}

/** The four views, re-exported from the DEF so the body and the legacy card
 *  read one roster. See `PUSH2_VIEWS`'s note on why it is not a param. */
export { PUSH2_VIEWS };

/** The human name of a view — the `aria-label` behind its two-to-four letter
 *  option name, so a screen reader is not read four abbreviations. */
export function push2ViewName(id: SingleView): string {
  switch (id) {
    case 'grid':
      return 'Clip grid';
    case 'clip':
      return 'Clip view';
    case 'arranger':
      return 'Arranger';
    case 'control':
      return 'Control deck';
  }
}

/**
 * THE ERROR LINE — absent whenever nothing is wrong.
 *
 * Ordered by how early the failure stops the player: no Web MIDI at all beats a
 * refused permission beats no device on the bus. All three are the card's own
 * sentences, unchanged.
 */
export function push2ErrorLine(v: Push2BinderView): string | null {
  if (!v.supported) {
    return 'Web MIDI isn’t available in this browser — connect a Push 2 in Chrome or Edge.';
  }
  if (v.outcome === 'no-midi') {
    return 'Couldn’t access MIDI — allow the permission prompt and try Connect Push 2 again.';
  }
  if (v.outcome === 'no-device') {
    return 'No Push 2 detected — plug one in, then hit Connect Push 2.';
  }
  return null;
}

/**
 * THE WebUSB CAPABILITY LINE — a second, independent error, and it is NOT
 * folded into the one above because the two are orthogonal: a player can have
 * a perfectly working Push and no WebUSB, which costs the on-device picture and
 * nothing else.
 *
 * ⚠ IT IS DELIBERATELY ONLY SHOWN ONCE CONNECTED. Saying "no WebUSB here"
 * before a device is even bound is an answer to a question nobody has asked,
 * and the card gated it the same way.
 */
export function push2UsbLine(v: Push2BinderView): string | null {
  if (!v.connected || v.usbOk) return null;
  return 'No WebUSB here — the on-device screen needs Chrome or Edge. Everything else still works, and the preview above shows exactly what that screen would.';
}

/**
 * THE EMPTY STATE — there is nothing in this rack to drive.
 *
 * ⚠ THIS IS THE ONE STATUS SENTENCE THAT SURVIVES, and the condition is what
 * earns it. It fires only when the patch has NO clip-player at all, so there is
 * nothing to bind, no control on the plate whose state it restates, and no
 * surface for it to be replaced by — until there is, at which point BIND
 * appears and this disappears. The card's sibling sentence ("hit Bind to drive
 * your clip-player") fired while BIND was live three rows up, which made it a
 * readout of a button; that one is deleted.
 *
 * ⚠ `boundNode` IS PART OF THE CONDITION, AND IT IS NOT REDUNDANT WITH
 * `hasClip`. The two disagree in a state a player can actually reach: DELETE the
 * clip-player while the Push is driving it, and `firstClipplayer()` (which reads
 * the patch) goes null while `boundClipNode()` (a module-level rune on the
 * control singleton) still holds the id. Without this clause the plate would
 * paint "add a clip-player to drive" NEXT TO a live `Unbind clip-player`
 * button — a contradiction, and one that only a player who deletes a bound
 * clip-player ever sees. The legacy card never showed it because its status
 * region was one `{#if}` chain in which the `bound` branch won; splitting the
 * region into a body control and an empty state is what made the ordering
 * explicit, so it is stated here rather than re-derived. The mutual exclusion
 * is asserted over every combination in
 * `push2-binder-status-model.test.ts`.
 */
export function push2EmptyLine(v: Push2BinderView): string | null {
  if (!v.connected || v.hasClip || v.boundNode !== null) return null;
  return 'Add a clip-player to drive — the Push binds it automatically.';
}

/** Is the BIND control on screen? The card's own condition. */
export function push2BindVisible(v: Push2BinderView): boolean {
  return v.connected && (v.boundNode !== null || v.hasClip);
}

/** BIND's caption — two genuinely DIFFERENT actions on one control, which is
 *  why it names which one will fire and why it is not a `ShellActionCell`
 *  (whose `label` is a plain string). */
export function push2BindLabel(v: Push2BinderView): string {
  return v.boundNode ? 'Unbind clip-player' : 'Bind to clip-player';
}

/** Is the four-role view segment on screen? It steers a bound surface, so it
 *  means nothing before one exists — a selector whose roster is meaningless
 *  half the time is the defect an unconditional cell would have shipped. */
export function push2ViewSegVisible(v: Push2BinderView): boolean {
  return v.connected;
}

/** The PUSH lamp's detail — the connection, in a sentence nothing paints. */
export function push2PushDetail(v: Push2BinderView): string {
  if (!v.supported) return 'Web MIDI unavailable in this browser';
  if (v.connected) return 'Push 2 connected over Web MIDI';
  if (v.outcome === 'connecting') return 'Requesting Web MIDI access…';
  if (v.outcome === 'no-device') return 'No Push 2 on the MIDI bus';
  if (v.outcome === 'no-midi') return 'Web MIDI access refused or blocked';
  return 'No Push 2 connected';
}

/** The SCREEN lamp's detail — the display layer's own status word, which is
 *  what the card interpolated into a parenthesis. */
export function push2ScreenDetail(v: Push2BinderView): string {
  if (!v.usbOk) return 'WebUSB unavailable in this browser — the pads and encoders work without it';
  if (v.displayOn) return 'Push 2 display open over WebUSB';
  return `Push 2 display not open (${v.displayStatus}) — optional; the pads and encoders work without it`;
}

/**
 * The SCREEN lamp's TONE, and this is the axis carrying the part that matters.
 *
 * ⚠ AN UNLIT SCREEN LAMP IS NOT A FAULT, and the tone must say so. The def's
 * own header: the display "degrades to nothing if it is unavailable or
 * declined — pads and encoders keep working over Web MIDI." A warn-toned lamp
 * on the DEFAULT path would be a lie in the opposite direction from the one the
 * ruling usually guards against. Only an outright failure to open a display the
 * player asked for earns `warn`.
 */
export function push2ScreenTone(v: Push2BinderView): 'accent' | 'warn' {
  return v.displayStatus === 'failed' || v.displayStatus === 'denied' ? 'warn' : 'accent';
}

/** The BOUND lamp's detail — WHICH clip-player, and in WHICH view. This is the
 *  finding the deleted `Driving clip-player …` sentence carried. */
export function push2BoundDetail(v: Push2BinderView): string {
  if (!v.boundNode) return 'Not driving a clip-player';
  return `Driving clip-player ${v.boundNode} — ${push2ViewName(v.view)}`;
}

/** What one push card looks like to this model — the shape `currentPushCardView()`
 *  returns, narrowed to the fields the flip control needs. */
export interface Push2CardPosition {
  title: string;
  index: number | null;
  count: number | null;
  empty?: string | null;
}

/**
 * THE FLIP CONTROL'S `aria-valuetext` — where `{index}/{count}` went.
 *
 * Speakable and assertable, painted nowhere. `push2-binder-status-model.test.ts`
 * asserts a one-module lane and a six-module lane produce DIFFERENT strings,
 * which is precisely the distinction the deleted badge was making and the one a
 * picture of eight bars cannot.
 */
export function push2FlipValue(card: Push2CardPosition): string {
  if (card.empty) return `Lane empty — ${card.empty.replace(/-/g, ' ')}`;
  if (card.index === null || !card.count) return card.title;
  return `${card.title} — card ${card.index} of ${card.count}`;
}
