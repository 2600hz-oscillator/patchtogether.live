// packages/web/src/lib/ui/controls/index.ts
//
// Barrel for the shared PRIMITIVE CONTROL LIBRARY (RACKLINE). The ModuleShell
// faces (P0.3b) + the per-module reworks (P1) assemble their control grids from
// these. Cards may still import a component by its direct path; this barrel is
// the convenience surface for the shell. Every interactive primitive shares the
// card-kit plumbing contract — `{ value, onchange, moduleId, paramId, readLive
// }` — so MIDI-Learn, live-motorized reads, and the right-click
// ControlContextMenu work uniformly across them.

// ── existing primitives ──
export { default as Knob } from './Knob.svelte';
// `Fader.svelte` was exported here until #1794 migrated every call site onto
// `NeonFader` and deleted it. There is ONE throw primitive.
export { default as NeonFader } from './NeonFader.svelte';
export { default as XyPad } from './XyPad.svelte';
export { default as VuMeter } from './VuMeter.svelte';
export { default as ScopeScreen } from './ScopeScreen.svelte';
export { default as MidiAssignButton } from './MidiAssignButton.svelte';
export { default as NoteEntry } from './NoteEntry.svelte';
export { default as WaveformGlyph } from './WaveformGlyph.svelte';

// ── P0.3a primitives ──
export { default as KnobConic } from './KnobConic.svelte';
export { default as Selector } from './Selector.svelte';
export { default as Segmented } from './Segmented.svelte';
export { default as ParamGrid } from './ParamGrid.svelte';
export { default as ColorField } from './ColorField.svelte';
export { default as Toggle } from './Toggle.svelte';
export { default as Button } from './Button.svelte';
export { default as Readout } from './Readout.svelte';

// ── pure model helpers + shared option types (node-env testable) ──
export {
  knobValueToFrac,
  knobFracToValue,
  knobPointerAngle,
} from './knob-conic-model';
export {
  currentOption,
  selectorLabel,
  cycleOptionValue,
  numericOptionRange,
  type SelectorOption,
} from './selector-model';
export { activeSegmentIndex, nearestSegmentValue, type Segment } from './segmented-model';
export {
  GRID_MAX_CELLS,
  gridChipLabel,
  gridColumns,
  gridNavIndex,
  nearestGridIndex,
  paramGridCells,
  type GridCell,
} from './param-grid-model';
export {
  PACKED_RGB_MAX,
  PACKED_RGB_MIN,
  PACKED_RGB_STATES,
  PROBE_CHANNEL_STEP,
  clampPacked,
  hexToPacked,
  isPackedRgbParam,
  nextProbeColor,
  packedChannels,
  packedToHex,
} from './color-field-model';
export { looksLikeToggle, isToggleOn, toggledValue } from './toggle-model';
export { buttonPointerFire, buttonGateFire, type ButtonFire } from './button-model';
export { formatReadout, type ReadoutFormatOptions } from './readout-model';
