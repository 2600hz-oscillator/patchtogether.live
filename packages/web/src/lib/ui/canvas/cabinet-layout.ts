// packages/web/src/lib/ui/canvas/cabinet-layout.ts
//
// Pure, unit-testable layout math for the Moog (moogafakkin) cabinet
// spawn buttons. Given a system ('35' | '55') it returns one entry per
// module with an ABSOLUTE flow-space position that mirrors the real Moog
// service-manual cabinet-wiring figures (Fig 47 = System 35, Fig 48 =
// System 55): modules laid left-to-right within a row, the two cabinet
// rows stacked vertically.
//
// The function is intentionally side-effect-free (no registry / Yjs
// access) so the geometry can be exhaustively asserted in a vitest unit
// test — most importantly that NO two cards' bounding boxes overlap. The
// Canvas spawn path filters the returned types through the live module
// registry (skipping any unregistered type gracefully) before writing the
// nodes into the patch graph.

/** Horizontal gap between adjacent cards within a row (px). */
export const GAP = 24;
/** Vertical stride between the two cabinet rows (px). Generous so the
 *  tallest card in row 1 can never reach into row 2. The fixed-filter
 *  banks (moog907a/moog914) render ~650-900px tall — far beyond a nominal
 *  card — so this stride is sized to clear the tallest realistically-
 *  rendered row-1 card with headroom. */
export const ROW_HEIGHT = 960;
/** Top-left origin for the whole cabinet in flow space. */
export const ORIGIN = { x: 80, y: 80 };

/** Fallback width for any type whose card width we don't have on hand. */
export const DEFAULT_CARD_WIDTH = 240;

/**
 * Card render width by module type-id (px). These mirror the `width={N}`
 * prop each Moog*Card.svelte passes to the shared <MoogPanel> wrapper —
 * advancing x by the exact width keeps spawned cards non-overlapping.
 */
export const CARD_WIDTHS: Record<string, number> = {
  moog902: 236,
  moog903a: 180,
  moog904a: 236,
  moog904b: 236,
  moog904c: 220,
  moog907a: 200,
  moog911: 232,
  moog911a: 200,
  moog912: 200,
  moog914: 200,
  moog921Vco: 252,
  moog921a: 236,
  moog921b: 252,
  moog923: 220,
  moog960: 520,
  moog961: 220,
  moog962: 200,
  moog984: 300,
  moog992: 220,
  moog993: 220,
  moog994: 180,
  moog995: 200,
  moogCp3: 264,
};

/** Width of a card by type-id, falling back to DEFAULT_CARD_WIDTH. */
export function cardWidth(type: string): number {
  return CARD_WIDTHS[type] ?? DEFAULT_CARD_WIDTH;
}

// Cabinet row contents, in left-to-right order, from the Moog service-
// manual figures. Row 1 = upper cabinet, row 2 = lower cabinet.
const SYSTEM_35: { row1: string[]; row2: string[] } = {
  // Fig 47 upper: fixed-filter + filters + VCAs + envelopes
  row1: [
    'moog907a',
    'moog904b',
    'moog904a',
    'moog902',
    'moog902',
    'moog902',
    'moog911',
    'moog911',
    'moog911',
  ],
  // Fig 47 lower: oscillator-driver / oscillators + noise + sequencer-row
  row2: [
    'moog921a',
    'moog921b',
    'moog921b',
    'moog923',
    'moog921a',
    'moog921b',
    'moog921b',
    'moog921Vco',
  ],
};

const SYSTEM_55: { row1: string[]; row2: string[] } = {
  // Fig 48 upper
  row1: [
    'moog904a',
    'moog992',
    'moog902',
    'moog902',
    'moog911',
    'moog911',
    'moog902',
    'moog902',
    'moog902',
    'moog993',
    'moog911',
    'moog993',
    'moog911',
    'moog911',
    'moog911',
  ],
  // Fig 48 lower
  row2: [
    'moog921a',
    'moog921b',
    'moog921b',
    'moog921b',
    'moog921a',
    'moog921b',
    'moog921b',
    'moog921b',
    'moog914',
    'moog904b',
    'moog904a',
    'moog992',
  ],
};

export type CabinetSystem = '35' | '55';

export interface CabinetPlacement {
  type: string;
  x: number;
  y: number;
}

function cabinetRows(system: CabinetSystem): { row1: string[]; row2: string[] } {
  return system === '35' ? SYSTEM_35 : SYSTEM_55;
}

/**
 * Compute absolute x/y positions for every module in the requested Moog
 * cabinet, mirroring the real cabinet layout: two rows stacked
 * vertically, each laid left-to-right advancing x by the card's width +
 * GAP so nothing overlaps.
 *
 * Pure: depends only on `system` and the static width table above.
 */
export function computeCabinetLayout(system: CabinetSystem): CabinetPlacement[] {
  const { row1, row2 } = cabinetRows(system);
  const placements: CabinetPlacement[] = [];

  const layRow = (types: string[], y: number) => {
    let x = ORIGIN.x;
    for (const type of types) {
      placements.push({ type, x, y });
      x += cardWidth(type) + GAP;
    }
  };

  layRow(row1, ORIGIN.y);
  layRow(row2, ORIGIN.y + ROW_HEIGHT);

  return placements;
}
