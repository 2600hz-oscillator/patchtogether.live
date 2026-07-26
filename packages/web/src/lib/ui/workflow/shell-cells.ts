// packages/web/src/lib/ui/workflow/shell-cells.ts
//
// The FAMILY / STATIC cell registry for the RACKLINE <ModuleShell>.
//
// A curated face ranks three kinds of control (curated-face.ts): a `param`
// (backed by a ParamDef — the shell paints a KnobConic or, for a declared
// press-pad, a momentary Button), a `family` (a declared ControlFamily) and a
// `static` (a card-only button/select keyed by the numbered legend). The first
// kind is generic; the other two are NOT — a preset roster, a file loader or a
// step grid each need their own live state + action, which no amount of def
// introspection can synthesize.
//
// Before this registry the shell rendered every family/static key as a DASHED
// LABEL ("the rich render is a P1 per-module concern"), which meant dx7's
// PRESET selector — its hero, `face.order[0]` — and its .syx import were
// UNREACHABLE under `?shell=1`: the DX7's voice could not be changed at all.
// So each such key now declares a small CELL SPEC here and the shell paints it
// with the SHARED primitive library (Selector / Button / Toggle), wired through
// the same card-kit contract the param cells use.
//
// THE BAR (module-face-lint + the faces-parity e2e both enforce it): every
// family/static key ranked by a STRICT_FACES module MUST resolve to a spec
// here. There is no dead-label fallback to fall back TO — an unregistered key
// renders as an explicitly INERT cell that fails both gates, so the inert-cell
// class cannot silently return.
//
// Reads are PURE projections off the live node (the shell owns reactivity via
// `nodeVersion(id)`); writes take the nodeId and mutate the graph store, so the
// specs stay declarative and the shell stays generic.

import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import type { FaceControl } from './curated-face';
import {
  DX7_SYX_ACCEPT,
  dx7PresetName,
  dx7SelectorOptions,
  loadDx7SyxFile,
  selectDx7Preset,
} from '$lib/ui/modules/dx7-patch-actions';

/** A dropdown over a NAMED roster that lives in node.data (not a param). */
export interface ShellSelectorCell {
  kind: 'selector';
  /** Small uppercase tag left of the value (the primitive's `label`). */
  tag: string;
  options: (node: ModuleNode | undefined) => SelectorOption<string>[];
  value: (node: ModuleNode | undefined) => string;
  onchange: (nodeId: string, value: string) => void;
}

/** A one-shot ACTION button (fires on the press edge). */
export interface ShellActionCell {
  kind: 'action';
  label: string;
  title?: string;
  onFire: (nodeId: string) => void;
}

/** A FILE-import button: opens a picker, hands the chosen file to `onFile`,
 *  and shows the returned status/error line under the button. */
export interface ShellFileCell {
  kind: 'file';
  label: string;
  title?: string;
  accept: string;
  onFile: (nodeId: string, file: File) => Promise<{ status: string | null; error: string | null }>;
}

/** A 0/1 LATCHING switch backed by node.data (a param-backed toggle is a
 *  `param` cell, not this). */
export interface ShellToggleCell {
  kind: 'toggle';
  label: string;
  value: (node: ModuleNode | undefined) => boolean;
  onchange: (nodeId: string, on: boolean) => void;
}

export type ShellCell = ShellSelectorCell | ShellActionCell | ShellFileCell | ShellToggleCell;

/**
 * Per-module cell specs, keyed by module type then by the EXACT `face.order`
 * key (a family template `<familyId>-{n}`, or a legend static key). Keeping the
 * face key as the index means the face, the docs (`docs.controls`) and the
 * shell all address the control by the SAME string — a rename breaks all three
 * gates at once instead of silently un-rendering one of them.
 */
const SHELL_CELLS: Record<string, Record<string, ShellCell>> = {
  dx7: {
    // The voice selector — the single control that defines the sound. Drives
    // the SAME `node.data.preset` write the legacy Dx7Card's <select> does
    // (dx7-patch-actions), which the factory polls and re-sends as a patch.
    'dx7-preset-select-{n}': {
      kind: 'selector',
      tag: 'preset',
      options: (node) => dx7SelectorOptions(node),
      value: (node) => dx7PresetName(node),
      onchange: (nodeId, value) => selectDx7Preset(nodeId, value),
    },
    // The cartridge loader — same parse/append/auto-select action as the card's
    // hidden file input, status line included.
    'dx7-syx-input-{n}': {
      kind: 'file',
      label: 'Load .syx bank',
      title: 'Import a Yamaha DX7 cartridge dump (voices are APPENDED to the roster)',
      accept: DX7_SYX_ACCEPT,
      onFile: (nodeId, file) => loadDx7SyxFile(nodeId, file),
    },
  },
};

/**
 * The cell spec for a curated FAMILY / STATIC control, or `null` when the
 * module declares none for that key (→ the shell renders an explicitly INERT
 * cell, which both the unit lint and the faces-parity e2e fail on). A `param`
 * control never routes here — the shell handles those generically. Pure.
 */
export function shellCellFor(moduleType: string, ctl: FaceControl): ShellCell | null {
  if (ctl.kind === 'param') return null;
  return SHELL_CELLS[moduleType]?.[ctl.key] ?? null;
}

/** Every module type that registers at least one cell spec (gate helper). */
export function typesWithShellCells(): string[] {
  return Object.keys(SHELL_CELLS).sort();
}

/** The registered face keys for one module type (gate helper). */
export function shellCellKeys(moduleType: string): string[] {
  return Object.keys(SHELL_CELLS[moduleType] ?? {}).sort();
}
