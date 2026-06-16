// grid-diagram-types.ts — shared types for the GridDiagram docs component.
// Kept in a plain .ts (not the .svelte) so both the component and the data
// specs import them without depending on `import type … from '*.svelte'`.

/** A single pad. `fill` is any CSS colour; omit for the dim default. */
export interface GridCell {
  x: number;
  y: number;
  fill?: string;
}

/** A labeled callout under the grid. A bracket spans columns [fromCol..toCol]
 *  (inclusive); a single column (toCol omitted/equal) draws one tick. */
export interface GridCallout {
  label: string;
  fromCol: number;
  toCol?: number;
  /** stack depth (0 = nearest the grid) for sub-labels above a group bracket. */
  tier?: number;
}

/** A label that points at ONE specific pad with a leader line to the right
 *  gutter — for controls that are stacked in a single column (e.g. EDIT /
 *  STOP-ALL / TRANSPORT all in the last column) where a below-column callout
 *  can't disambiguate by row. */
export interface GridSideLabel {
  label: string;
  atX: number;
  atY: number;
}
