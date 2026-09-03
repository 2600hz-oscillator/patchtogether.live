// packages/web/src/lib/ui/modules/trails/trails-status-model.ts
//
// EVERY STRING AND EVERY LAMP STATE THE TRAILS BODIES CAN PRODUCE, as pure
// functions — including the ones that are never painted.
//
// An unpainted string that is wrong is invisible to a VRT baseline and to a
// human reading one, which is precisely what the resting-text ruling creates by
// moving a status sentence onto `aria-label`. So it is decided here, where a
// unit test can read it, exactly as `ptzcam-status-model.ts` and
// `midiclock-status-model.ts` do for the binders next door.
//
// ── ⚠ THE ONE MECHANISM CHANGE IN THE WHOLE PROMOTION ──────────────────────
//
// `TrailsCard.svelte` painted the status as a `<p>` in three visual states: a
// grey LED beside a dim sentence (idle), an AMBER LED beside an amber
// `role="alert"` sentence (any fault), and a GREEN LED beside a dim sentence
// (bound). Under the rulings the BOUND sentence — `Bound to Bela Trails —
// streaming X / Y / gate.` — is derived state outside any control and may not
// be a text node. It becomes `StatusLed.detail`, which reaches `aria-label` and
// `title`. The FAULT sentences are ERRORS and survive as painted text verbatim,
// `role="alert"`, absent whenever nothing is wrong.
//
// ⚠ AND `lit` IS NOT `bound`, WHICH IS THE HALF A NAIVE PORT GETS WRONG.
// `StatusLed`'s `tone` styles ONLY the lit lamp (`.status-led.warn.lit .lamp`
// in its own stylesheet — an unlit lamp is `var(--border)` whatever the tone),
// so the obvious `lit={bound} tone={problem ? 'warn' : 'accent'}` renders a
// FAULT pixel-identically to a module nobody has pressed CONNECT on yet. That
// would silently delete the card's amber state — one of its three — while every
// gate in the tree stayed green, because no gate reads a lamp's colour.
//
// So `lit` is "this link has RESOLVED to something", and the tone says which:
//
//     idle     dark              nothing has been asked for yet
//     fault    lit, WARN         amber, exactly as the card's LED was
//     bound    lit, ACCENT       the hardware is streaming
//
// The caption stays the static literal `LINK` in all three, which is
// `StatusLed`'s actual contract (a caption that CHANGES is the refused shape);
// what varies is the lamp, its colour, and the sentence on `aria-label`.

import type { TrailsStatus, TrailsStatusKind } from '$lib/midi/trails-device';

/** The instructional copy the plate carries before any grant — the ONE piece of
 *  resting prose on the surface, permitted as instructional copy in an EMPTY
 *  state (the midiclock / es9 / gamepad licence). It is replaced by the lamp's
 *  own state the moment a link exists, so it can never become a stale claim. */
export const TRAILS_PRE_CONNECT_HINT =
  'Press Connect Trails to grant this browser MIDI access and bind any Bela Trails on USB.';

/** The whole visual + textual state of the LINK lamp and the lines under it. */
export interface TrailsLamp {
  /** `StatusLed.lit` — see the header: NOT `bound`. */
  readonly lit: boolean;
  /** `StatusLed.tone` — `warn` is the card's amber LED. */
  readonly tone: 'accent' | 'warn';
  /** `StatusLed.detail` — the binding layer's own sentence, whatever the kind.
   *  Reaches `aria-label` + `title` and never a text node. */
  readonly detail: string;
  /** The `role="alert"` line, or null when nothing is wrong. Painted verbatim:
   *  for `no-port` it is the only instruction in the product for the failure a
   *  player will actually hit. */
  readonly errorLine: string | null;
  /** The pre-connect empty-state hint, or null once anything has resolved. */
  readonly hint: string | null;
}

/**
 * Is this status a FAULT — something the player must act on?
 *
 * `idle` is not (nothing has been asked for yet) and `bound` is not. The other
 * four are, and this is the predicate that decides whether the sentence is
 * ALSO painted as a `role="alert"` line. An error is permitted painted text
 * precisely because it is ABSENT whenever nothing is wrong.
 *
 * ⚠ IT IS `TrailsCard.svelte:94` VERBATIM. The card's `problem` derivation and
 * this function must agree, because both shells ship while the migration is
 * live and a player must not see two different verdicts about one device.
 */
export function trailsIsProblem(kind: TrailsStatusKind): boolean {
  return kind !== 'bound' && kind !== 'idle';
}

/** Is the module receiving from a Trails right now? */
export function trailsIsBound(kind: TrailsStatusKind): boolean {
  return kind === 'bound';
}

/** The lamp, the error line and the hint, from one status read. */
export function trailsLamp(status: TrailsStatus | null): TrailsLamp {
  if (!status) {
    // No engine handle yet — indistinguishable from `idle` to a player, and
    // deliberately painted as such rather than as a fault: a node whose handle
    // is still being built has nothing wrong with it.
    return {
      lit: false,
      tone: 'accent',
      detail: TRAILS_PRE_CONNECT_HINT,
      errorLine: null,
      hint: TRAILS_PRE_CONNECT_HINT,
    };
  }
  const problem = trailsIsProblem(status.kind);
  const bound = trailsIsBound(status.kind);
  return {
    lit: problem || bound,
    tone: problem ? 'warn' : 'accent',
    detail: status.message,
    errorLine: problem ? status.message : null,
    hint: status.kind === 'idle' ? TRAILS_PRE_CONNECT_HINT : null,
  };
}

/**
 * The MON counters line — `loops 12 · edges 12/0/0/0`, verbatim from the card.
 *
 * ⚠ IT STAYS A LINE AND DOES NOT BECOME LAMPS. It is read as a RATIO between
 * two counters that must advance together — the whole defect the loop-retrigger
 * exists for is "does the gate strike once per repetition" — and four boolean
 * lamps cannot express "these two numbers moved by the same amount". It is
 * permitted because it is ABSENT AT REST: `monOpen` defaults false, so a
 * resting faceplate paints neither this nor the summary.
 */
export function trailsCountersLine(
  counters: { loopRestarts: number; gateEdges: readonly number[] } | null,
): string {
  const loops = counters?.loopRestarts ?? 0;
  const edges = counters?.gateEdges ?? [0, 0, 0, 0];
  return `loops ${loops} · edges ${edges.join('/')}`;
}

/** What the MON `<pre>` shows before a device has said anything. The samsloop
 *  `NO SAMPLE LOADED` shape: a placeholder naming the surface's own condition,
 *  replaced by the real summary the moment one exists. Card text verbatim. */
export const TRAILS_MON_IDLE_TEXT =
  'MIDI monitor idle — press CONNECT, then touch the pad.';
