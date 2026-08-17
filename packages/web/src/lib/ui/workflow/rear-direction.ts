// packages/web/src/lib/ui/workflow/rear-direction.ts
//
// HOW A REAR HOLE SAYS WHICH WAY IT POINTS — declared, not assumed (#1800).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// COLOUR ON THE REAR CARD IS ALREADY SPENT. A hole's hue is its CABLE DOMAIN
// and nothing else — the RACKLINE domain tokens ride the live `--cable-*`
// palette so a jack and the cable that will hang off it are the same colour.
// That is a hard constraint, not a preference: two ports of the same domain on
// opposite rails MUST be the same hue, or the palette stops meaning what the
// canvas means by it.
//
// So direction has always been carried by NON-COLOUR channels, and the shipped
// card carried three: the outputs' fixed RAIL POSITION, their INVERTED TILE
// chrome, and the ←/→ glyph on each band header. The third of those was
// load-bearing in a way that is easy to miss — **the input/output visual
// difference WAS one of the direction cues**, so unifying the two into one row
// grammar (the owner's ask) spends a channel unless the redesign puts one back.
//
// It does, and this file is the declaration. Four channels, none of them hue:
//
//   ZONE     the field is two headed regions, inputs left, outputs right
//   GLYPH    every section heading carries ← or →
//   MIRROR   the row's jack sits on the OUTER edge — leading for an input,
//            trailing for an output — and the label reads inward
//   CHROME   an output row is a filled, inverted tile; an input row is open
//
// MIRROR is the one that is genuinely NEW, and it is the one that matters most,
// because it is the only channel that survives seeing a single row in
// isolation: ZONE and GLYPH need their container in frame, CHROME degrades in
// a high-contrast or forced-colours rendering, and a row scrolled alone under
// the cursor still shows its jack on one side or the other.
//
// ── WHAT THE GATE OVER THIS CHECKS (rear-direction.test.ts) ─────────────────
//
//   1. Every channel's `anchors` still appear in RearCard.svelte. ANCHORED TO
//      THE ARTIFACT: a channel entry naming a selector the component no longer
//      has is RED, so a channel cannot outlive the code that realises it. This
//      is the half that catches "we deleted the mirror and nobody noticed".
//   2. COLOUR STAYS DOMAIN-ONLY: no direction-qualified selector in the
//      component may assign the domain hue variable. That is the inverse
//      statement — not "direction has channels" but "direction has not
//      STOLEN one" — and it is the one a reviewer cannot eyeball.
//   3. The model agrees: the same cable type on either rail derives the same
//      `domain`, so hue is invariant to direction by construction.
//
// ⚠ WHAT THE GATE CANNOT SEE, stated inside the gate as well: it reads SOURCE,
// so it cannot tell that a rule is reachable, that a mirrored row is legible at
// the shipped size, or that a channel is perceptible at all. Those are the e2e
// leg's job (`workflow-rear-card.spec.ts` measures the jack's real box on both
// rails) and the owner's eyes. It also cannot see any OTHER component: a second
// surface that re-renders holes with its own CSS is outside this file entirely.

/** How a channel is realised — the axis a reader decodes it on. */
export type RearDirectionChannelKind = 'zone' | 'glyph' | 'geometry' | 'chrome';

export interface RearDirectionChannel {
  id: string;
  kind: RearDirectionChannelKind;
  /** What a reader SEES that differs by direction. Required: a channel nobody
   *  can describe in one sentence is not a channel, it is a hope. */
  what: string;
  /** Why it works WITHOUT hue, and what it costs — specifically whether it
   *  survives seeing one row / one section in isolation. Required. */
  why: string;
  /** Literal tokens `RearCard.svelte` must still contain for this channel to
   *  exist. Anchored: an entry naming something the component dropped is RED. */
  anchors: readonly string[];
}

/**
 * THE DIRECTION CHANNELS, deny-by-default: a direction cue that is not declared
 * here is not one the card is allowed to rely on, and one declared here that
 * the component no longer implements fails the gate.
 *
 * Deliberately NOT a count of anything — the gate asserts each entry against
 * the artifact and asserts the colour invariant unconditionally. There is no
 * floor on how many channels there are, because "four" would be a number that
 * goes stale the first time someone finds a fifth.
 */
export const REAR_DIRECTION_CHANNELS: readonly RearDirectionChannel[] = [
  {
    id: 'zone',
    kind: 'zone',
    what:
      'The field is two regions parted by a rule and a change of ground: every ' +
      'input section sits in the left zone, every output section in the right ' +
      'one, and the zone element carries the direction as a data attribute.',
    why:
      'Position, not hue. This is the shipped "rail position" cue generalised — ' +
      'the outputs used to be a fixed-width rail and are now a zone of sections ' +
      'in the same place. Costs nothing and is the strongest cue at a glance; ' +
      'does NOT survive looking at one section with the rest scrolled away, ' +
      'which is why it is not the only channel.',
    anchors: ['rear-zone', 'data-direction={'],
  },
  {
    id: 'section-glyph',
    kind: 'glyph',
    what: 'Every section heading carries ← (into the module) or → (out of it).',
    why:
      'A literal arrow, so it needs no legend and reads in monochrome, in ' +
      'forced-colours mode, and at any zoom. Survives a section seen alone; ' +
      'does not survive a single ROW seen alone.',
    anchors: ['rsec-dir'],
  },
  {
    id: 'row-mirror',
    kind: 'geometry',
    what:
      "The row's jack sits on its OUTER edge — leading (left) on an input, " +
      'trailing (right) on an output — and the label reads inward from it, so ' +
      'the two rails are mirror images of one row grammar.',
    why:
      'THE ONE CHANNEL THAT SURVIVES A SINGLE ROW IN ISOLATION, which is what ' +
      'makes it the replacement for the input/output shape difference the ' +
      'unification spends. It is pure geometry: no hue, no chrome, no text, ' +
      'and no extra pixels — the same row, reversed. It also matches the ' +
      'signal: a cable arrives at the left edge and leaves at the right one. ' +
      'Realised with flex direction so the MARKUP stays a single snippet — ' +
      'one row grammar in the source as well as on screen.',
    anchors: ['row-reverse'],
  },
  {
    id: 'tile-chrome',
    kind: 'chrome',
    what:
      'An output row is a filled, bordered tile with its socket sunk into a ' +
      'collar; an input row is open on the card ground with a ringed socket.',
    why:
      'The shipped "inverted output tiles" cue, kept verbatim. It is a ' +
      'LUMINANCE / PRESENCE difference (fill vs no fill), not a hue difference: ' +
      'the fill takes whatever domain hue the row already has, so the same port ' +
      'type is the same colour on both rails and the gate below asserts exactly ' +
      'that. Weakest of the four — it is the one that degrades under ' +
      'forced-colours — so it is never the only thing separating two rows.',
    anchors: ['rcd-wash', 'rj.out'],
  },
];
