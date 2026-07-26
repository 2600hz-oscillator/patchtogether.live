// packages/web/src/lib/ui/modules/sixstrum-preset-actions.ts
//
// SIX STRUM's PRESET RECALL — the guitar / bass / harp voice roster — as ONE
// shared implementation.
//
// The three modes are NOT hidden DSP branches and they are NOT the `tuning`
// param: "GUITAR / BASS / HARP are three KNOB STATES of this one control
// scheme… presets recall knob positions, nothing else" (sixstrum.ts). Recalling
// one STAMPS a calibrated 14-value configuration — `tuning` plus register /
// ring / material / pickPos / stiffness / pickTone / pickGrain / strumSpread /
// strumDir / muteDepth / quality / body / spread — onto the module's params.
// Turning `tuning` ALONE only switches which open strings (and which body
// resonances) the same engine uses.
//
// The stamping used to live inline in SixstrumCard's `setMode`, which is why
// the RACKLINE ModuleShell could not offer it: the shell's face carried the raw
// `tuning` param but there was nothing to CALL for the recall, so the three
// presets were unreachable under `?shell=1` — the param survived the redesign,
// the affordance did not. Extracted here so the legacy card's MODE knob and the
// shell's PRESET cell drive the IDENTICAL stamp (no second implementation to
// drift), exactly as dx7-patch-actions did for the DX7's voice selector.
//
// Reads are pure projections off a node (the caller owns reactivity — the card
// via its `$derived` param reads, the shell via `nodeVersion(id)`); the write
// takes a nodeId and goes through the NORMAL param commit path (setNodeParam →
// the live Y.Doc), so undo, collab and the engine push all behave exactly like
// a hand-turned knob.

import { setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';

/** The three modes, in `tuning` index order (0 guitar, 1 bass, 2 harp). */
export const SIXSTRUM_MODE_NAMES = ['guitar', 'bass', 'harp'] as const;

/**
 * The calibrated knob state of each mode — the WHOLE preset, `tuning`
 * included. (register/ring/material calibrated to the plucked-string decay
 * research; guitar ~2.5 s, bass long+dark −1 oct, harp long+bright +7 st.)
 *
 * Verbatim from SixstrumCard's original `MODE_PRESETS` — same keys, same
 * values, same order — so a recall commits byte-identical param writes before
 * and after the extraction.
 */
export const SIXSTRUM_MODE_PRESETS: Record<string, number>[] = [
  { tuning: 0, register: 0,   ring: 2.5, material: 0.55, pickPos: 0.17, stiffness: 0.06, pickTone: 0.60, pickGrain: 1.0,  strumSpread: 0.28, strumDir: 0, muteDepth: 0.5, quality: 0, body: 0.35, spread: 0.25 },
  { tuning: 1, register: -12, ring: 6,   material: 0.32, pickPos: 0.11, stiffness: 0.22, pickTone: 0.40, pickGrain: 1.5,  strumSpread: 0.07, strumDir: 0, muteDepth: 0.6, quality: 6, body: 0.50, spread: 0.15 },
  { tuning: 2, register: 7,   ring: 9,   material: 0.85, pickPos: 0.28, stiffness: 0.02, pickTone: 0.72, pickGrain: 0.55, strumSpread: 0.70, strumDir: 1, muteDepth: 0.3, quality: 3, body: 0.45, spread: 0.40 },
];

/** Clamp + round an arbitrary control value to a real preset index. Pure. */
export function sixstrumModeIndex(v: number): number {
  return Math.max(0, Math.min(SIXSTRUM_MODE_PRESETS.length - 1, Math.round(v)));
}

/** The mode NAME for a preset index (out-of-range falls back to guitar). Pure. */
export function sixstrumModeName(v: number): string {
  return SIXSTRUM_MODE_NAMES[sixstrumModeIndex(v)] ?? 'guitar';
}

/**
 * Which mode a node currently READS as: the mode whose string set `tuning` is
 * on. After a recall every knob stays editable, so this reports the TUNING the
 * instrument is in — the same readout the legacy card's MODE name shows — not
 * "the preset is still pristine". Pure read.
 */
export function sixstrumPresetName(node: ModuleNode | undefined): string {
  const v = node?.params?.tuning;
  return sixstrumModeName(typeof v === 'number' ? v : 0);
}

/** The roster as <Selector> options (guitar / bass / harp). Pure read. */
export function sixstrumSelectorOptions(): SelectorOption<string>[] {
  return SIXSTRUM_MODE_NAMES.map((name, i) => ({
    value: name,
    label: name,
    title: `recall the ${name} knob state (${Object.keys(SIXSTRUM_MODE_PRESETS[i]!).length} calibrated values)`,
  }));
}

/**
 * RECALL a mode by index: stamp its whole calibrated configuration onto the
 * node's params through the normal commit path. Every value is a plain param
 * write, so the recall is undoable, shared over collab, and instantly editable
 * afterwards — a starting point, never a lock.
 */
export function applySixstrumPreset(nodeId: string, v: number): void {
  const preset = SIXSTRUM_MODE_PRESETS[sixstrumModeIndex(v)]!;
  for (const [k, val] of Object.entries(preset)) setNodeParam(nodeId, k, val);
}

/** RECALL a mode by NAME (the shell selector's value space). Unknown names are
 *  ignored rather than stamping guitar over the user's knobs. */
export function selectSixstrumPreset(nodeId: string, name: string): void {
  const idx = SIXSTRUM_MODE_NAMES.indexOf(name as (typeof SIXSTRUM_MODE_NAMES)[number]);
  if (idx < 0) return;
  applySixstrumPreset(nodeId, idx);
}
