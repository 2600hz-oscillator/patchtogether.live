// packages/web/src/lib/ui/modules/dx7-patch-actions.ts
//
// The DX7's two NON-PARAM controls — the PRESET/voice selector and the .syx
// cartridge import — as ONE shared implementation.
//
// Both are declared control families on the def (`dx7-preset-select`,
// `dx7-syx-input`) with no backing ParamDef: the loaded voice lives in
// `node.data.preset` and imported cartridges in `node.data.userPatches`, and
// the factory POLLS those (see dx7.ts) rather than exposing an engine API. The
// logic used to live inline in Dx7Card, which is why the RACKLINE ModuleShell
// could only render the two families as dead labels — there was nothing to
// call. Extracted here so the legacy card and the shell cell drive the
// IDENTICAL action/state (no second implementation to drift), per the P1
// batch-2 inert-cell fix.
//
// Reads take a node (pure projection — the caller owns reactivity, via
// `nodeVersion(id)` or a SyncedStore-tracked `$derived`); writes take a nodeId
// and mutate the live `patch` store.

import { patch } from '$lib/graph/store';
import { DX7_DEFAULT_PRESET } from '$lib/audio/modules/dx7';
import { DX7_BUILTIN_BANK } from '$lib/audio/dx7-banks';
import { parseSyxBank, type DX7Voice } from '$lib/audio/dx7-syx';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';

/** The `.syx` file-picker accept string (shared by the card input + the shell
 *  cell), so both take exactly the same file set. */
export const DX7_SYX_ACCEPT = '.syx,application/octet-stream';

/** One voice roster entry: a factory patch or an imported cartridge voice. */
export interface Dx7PatchEntry {
  name: string;
  kind: 'builtin' | 'user';
}

/** Cartridge voices imported into THIS node (empty when none). Pure read. */
export function dx7UserPatches(node: ModuleNode | undefined): DX7Voice[] {
  const d = node?.data as Record<string, unknown> | undefined;
  return Array.isArray(d?.userPatches) ? (d.userPatches as DX7Voice[]) : [];
}

/** The currently loaded voice name (the def's default when unset). Pure read. */
export function dx7PresetName(node: ModuleNode | undefined): string {
  const d = node?.data as Record<string, unknown> | undefined;
  return typeof d?.preset === 'string' && d.preset.length > 0 ? d.preset : DX7_DEFAULT_PRESET;
}

/** The full voice roster: the nine factory-inspired built-ins, then every
 *  imported cartridge voice in load order. Pure read. */
export function dx7PatchRoster(node: ModuleNode | undefined): Dx7PatchEntry[] {
  return [
    ...DX7_BUILTIN_BANK.map((p) => ({ name: p.name, kind: 'builtin' as const })),
    ...dx7UserPatches(node).map((p) => ({ name: p.name, kind: 'user' as const })),
  ];
}

/** The roster as <Selector> options — an unnamed imported voice still gets a
 *  stable, distinguishable label so the dropdown is never blank. Pure read. */
export function dx7SelectorOptions(node: ModuleNode | undefined): SelectorOption<string>[] {
  return dx7PatchRoster(node).map((p, i) => ({
    value: p.name,
    label: p.name || `(unnamed ${i + 1})`,
    title: p.kind === 'builtin' ? 'built-in (factory-inspired)' : 'loaded SYX',
  }));
}

/** Load a voice by name — writes `node.data.preset`, which the factory polls
 *  and re-sends to the worklet as a whole patch. */
export function selectDx7Preset(nodeId: string, name: string): void {
  const t = patch.nodes[nodeId];
  if (!t) return;
  if (!t.data) t.data = {};
  (t.data as Record<string, unknown>).preset = name;
}

/** What a cartridge import reported back to the user. */
export interface Dx7SyxLoadResult {
  /** Human status line ('loaded 32 voices (1 warnings)'), or null on failure. */
  status: string | null;
  /** Parse failure message, or null on success. */
  error: string | null;
}

/**
 * Import a .syx cartridge into this node: parse the bank, APPEND its voices to
 * `node.data.userPatches` (never replace — several cartridges stack) and
 * auto-select the first newly-loaded voice. A bad header byte or checksum
 * mismatch is REPORTED as a warning, not rejected (parseSyxBank's contract);
 * only a hard parse throw comes back as `error`.
 */
export async function loadDx7SyxFile(nodeId: string, file: File): Promise<Dx7SyxLoadResult> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = parseSyxBank(bytes);
    const t = patch.nodes[nodeId];
    if (!t) return { status: null, error: 'module is gone' };
    if (!t.data) t.data = {};
    const existing = dx7UserPatches(t as ModuleNode);
    (t.data as Record<string, unknown>).userPatches = [...existing, ...result.voices];
    if (result.voices[0]) selectDx7Preset(nodeId, result.voices[0].name);
    const warn = result.warnings.length ? ` (${result.warnings.length} warnings)` : '';
    return { status: `loaded ${result.voices.length} voices${warn}`, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}
