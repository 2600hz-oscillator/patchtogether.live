// packages/web/src/lib/ui/controls/status-led-model.ts
//
// THE STATUS LED's pure model — the accessible name and the hover title for a
// faceplate INDICATOR, and the one place a measurement is allowed to become a
// string.
//
// ── WHY A PRIMITIVE EXISTS FOR THIS AT ALL ─────────────────────────────────
//
// The resting-text rulings (four owner statements, 2026-08-19, gated by
// `face-resting-text-source.test.ts`) permit exactly four text roles on a
// resting faceplate: the module NAME, tab/section LABELS, control CAPTIONS and
// option/landmark NAMES. A measurement — "3 skipped", "no ES-9 in rack",
// "jacks 1-3" — is none of them, and three separate mechanisms have now been
// deleted for painting one.
//
// Each of those deletions denied a MECHANISM, and the number came back wearing
// the next mechanism's clothes. So this is the other half of that lesson: a
// SHAPE that can only express the permitted form. The component below takes
//
//   caption  a STATIC string the caller passes as a literal — the name of the
//            thing being indicated, never its state. It is a control caption
//            under the ruling, and it does not change when `lit` changes.
//   lit      a BOOLEAN, which becomes a PICTURE — a dark or lit lamp, the
//            eurorack panel idiom. There is no third visual state, so "how
//            many" cannot be smuggled in as a colour ramp.
//   detail   the derived quantity, which goes to `aria-label` and `title` and
//            NOWHERE ELSE.
//
// ⚠ THERE IS NO `value` PROP, AND THAT ABSENCE IS THE FEATURE. `Readout.svelte`
// next door is the shape being refused: a `value` prop, a formatter and a text
// node. A caller who wants to paint a number here has to add a prop to do it,
// which is a visible edit to a gated file rather than a call-site parameter.
//
// ⚠ AND `detail` IS NOT A LOOPHOLE, because it never reaches a text node. It is
// speakable (a screen reader reads it), assertable (a spec reads it), and
// hoverable — the same home `aria-valuetext` gives a control's derived value,
// which is why the readout deletions cost no assertion. `status-led-source.
// test.ts` asserts the component only ever places it in an attribute.
//
// PURE: no Svelte imports, so both halves are node-env testable.

/** Everything an indicator knows about itself. */
export interface StatusLedState {
  /** The STATIC name of the indicated thing (e.g. `LATE`, `ROUTED`). Never
   *  the state, never a value — it reads identically lit and unlit. */
  caption: string;
  /** The whole of the visual state. Dark or lit; there is no third. */
  lit: boolean;
  /** The derived quantity or sentence, for `aria-label` / `title` ONLY. */
  detail?: string;
}

/**
 * The accessible name. `caption` first so a screen reader announces WHAT this
 * is before it announces how it is doing, then the state as a word, then the
 * detail if there is one.
 *
 * ⚠ THE STATE WORD LIVES HERE AND ONLY HERE. On screen the state is the
 * picture; a sighted player reads a lit lamp, and a "ON"/"OFF" text node beside
 * it would be the ruling's "state word" by name. In the accessible name it is
 * mandatory — a lamp with no announced state is an unlabelled decoration.
 */
export function statusLedLabel(s: StatusLedState): string {
  const head = `${s.caption} ${s.lit ? 'on' : 'off'}`;
  const detail = s.detail?.trim();
  return detail ? `${head} — ${detail}` : head;
}

/**
 * The hover title. `undefined` when there is no detail, so the component emits
 * NO `title` attribute rather than an empty tooltip — an empty tooltip is a
 * hover target that rewards the hover with nothing.
 *
 * The title deliberately does NOT repeat the state word: a player hovering a
 * lamp can see whether it is lit, and the reason to hover is the number.
 */
export function statusLedTitle(s: StatusLedState): string | undefined {
  const detail = s.detail?.trim();
  return detail ? detail : undefined;
}
