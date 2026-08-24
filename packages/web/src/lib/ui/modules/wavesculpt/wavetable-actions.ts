// packages/web/src/lib/ui/modules/wavesculpt/wavetable-actions.ts
//
// THE WAVETABLE-SOURCE WRITES, in ONE place because TWO surfaces need them:
// `WavesculptCard.svelte` (the legacy lane card) and the twelve faceplate shell
// cells. Both write the same `node.data.osc{N}.*` shape the factory's poll loop
// reads, so neither surface can drift about what "this oscillator holds table
// X" means.
//
// ⚠ THE DX7 IS THE PRECEDENT FOR WHY THIS IS SHARED RATHER THAN COPIED: a card
// that owned its own action shipped a faceplate that could not change the voice
// at all. `cube/cube-table-actions.ts` is the same move for the same reason,
// one module over — and this file deliberately mirrors its shape.
//
// ⚠ IT IS A `.ts`, SO IT IS OUTSIDE THE WEBGL ATTEST BASIS BY CONSTRUCTION.
// The basis takes `.svelte` under `ui/modules` only when the file creates a GL
// context and skips `.ts` entirely, so the shared writes cost no re-attest even
// though the surface beside them is a basis file.
//
// ⚠ EVERY WRITE IS RAW (`patch.nodes[...]`), NOT `mutateNode`, and that is
// carried over unchanged from the card rather than "improved": these write
// `wavetableFrames`, a large Float32-derived payload, and they are already the
// shape the factory polls. Changing the write mechanism is a behaviour question
// for the sync layer, not a tidy-up to fold into a faceplate PR.

import { patch } from '$lib/graph/store';
import {
  getFactoryTables,
  DEFAULT_FACTORY_TABLE_ID,
  framesToPlain,
} from '$lib/audio/wavetable-factory-tables';
import { parseE352Wav } from '$lib/audio/wavetable-parser';
import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
import type { ModuleNode } from '$lib/graph/types';
import type { WavesculptData, WavesculptOscData } from '$lib/audio/modules/wavesculpt';

/** The four oscillators, by their 0-based index. The `{N}` in every family id
 *  and testid is this index PLUS ONE — the player counts from 1. */
export const WAVESCULPT_OSC_COUNT = 4;

/** `.wav` only — the E352 single-cycle layout the parser understands. */
export const WAVESCULPT_WAV_ACCEPT = '.wav,audio/wav';

/** The per-oscillator slice of `node.data`, read-only. */
export function wavesculptOscData(node: ModuleNode | undefined, oscIdx: number): WavesculptOscData {
  const d = (node?.data ?? {}) as WavesculptData;
  return (d[`osc${oscIdx + 1}` as keyof WavesculptData] as WavesculptOscData | undefined) ?? {};
}

/** The stored source id, defaulted. `factory:<id>` or the literal `'user'`. */
export function wavesculptOscSource(node: ModuleNode | undefined, oscIdx: number): string {
  return wavesculptOscData(node, oscIdx).wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
}

/** What to PAINT for this oscillator's current table. A user-loaded table has
 *  no factory option to match, so it shows the stored filename instead. */
export function wavesculptOscLabel(node: ModuleNode | undefined, oscIdx: number): string {
  const od = wavesculptOscData(node, oscIdx);
  if (od.wavetableSource === 'user' && od.wavetableLabel) return od.wavetableLabel;
  const id = (od.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`).slice('factory:'.length);
  return getFactoryTables().find((t) => t.id === id)?.label ?? getFactoryTables()[0]!.label;
}

/** Mutable access to one oscillator's slice, creating it on first write. */
function oscSlice(nodeId: string, oscIdx: number): WavesculptOscData | null {
  const t = patch.nodes[nodeId];
  if (!t) return null;
  // guard:allow-raw-write — see the header: the frames payload and the poll-loop
  // contract are carried over from the card unchanged.
  if (!t.data) t.data = {};
  const d = t.data as WavesculptData;
  const key = `osc${oscIdx + 1}` as keyof WavesculptData;
  if (!d[key]) (d as Record<string, unknown>)[key as string] = {};
  return d[key] as WavesculptOscData;
}

/** Point an oscillator at a FACTORY table. Clears any user frames, because a
 *  stale payload beside a factory source is the drift `cube-table-actions`
 *  documents: the picture and the sound would disagree about what is loaded. */
export function selectWavesculptFactoryTable(nodeId: string, oscIdx: number, factoryId: string): void {
  const od = oscSlice(nodeId, oscIdx);
  if (!od) return;
  od.wavetableSource = `factory:${factoryId}`;
  delete od.wavetableFrames;
  delete od.wavetableLabel;
}

/** The outcome of an async load, for the surface to paint as feedback. */
export interface WavetableLoadResult {
  status: string | null;
  error: string | null;
}

/** Fetch + parse a curated PRESET into one oscillator. */
export async function loadWavesculptPreset(
  nodeId: string,
  oscIdx: number,
  presetId: string,
): Promise<WavetableLoadResult> {
  const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return { status: null, error: `unknown preset '${presetId}'` };
  try {
    const parsed = await loadWavetablePreset(preset.url);
    const od = oscSlice(nodeId, oscIdx);
    if (!od) return { status: null, error: 'node is gone' };
    od.wavetableSource = 'user';
    od.wavetableFrames = parsed.frames;
    od.wavetableLabel = preset.label;
    return { status: `loaded ${parsed.frames.length} frames`, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse a user `.wav` into one oscillator. */
export async function loadWavesculptWavFile(
  nodeId: string,
  oscIdx: number,
  file: File,
): Promise<WavetableLoadResult> {
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseE352Wav(buf);
    const od = oscSlice(nodeId, oscIdx);
    if (!od) return { status: null, error: 'node is gone' };
    od.wavetableSource = 'user';
    od.wavetableFrames = framesToPlain(parsed.frames);
    od.wavetableLabel = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
    return { status: `loaded ${parsed.frames.length} frames`, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The FACTORY roster, plus the synthetic `USER · <label>` entry when this
 *  oscillator is holding a table the player loaded. Without that entry the
 *  `<select>` would have no option matching its value and render BLANK — the
 *  issue the card's own `oscSource`/`oscLabel` pair exists to avoid. */
export function wavesculptTableOptions(
  node: ModuleNode | undefined,
  oscIdx: number,
): { value: string; label: string }[] {
  const out = getFactoryTables().map((t) => ({ value: `factory:${t.id}`, label: t.label }));
  const od = wavesculptOscData(node, oscIdx);
  if (od.wavetableSource === 'user') {
    out.push({ value: 'user', label: `USER · ${od.wavetableLabel ?? 'loaded'}` });
  }
  return out;
}

/** The PRESET roster. The empty sentinel leads it because a freshly-spawned
 *  oscillator holds a FACTORY table, which is no preset at all — and a picker
 *  whose value matches no option renders blank (the same trap
 *  `wavesculptTableOptions`' synthetic `user` entry exists to avoid). */
export function wavesculptPresetOptions(): { value: string; label: string }[] {
  return [
    { value: '', label: '— preset —' },
    ...WAVETABLE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
  ];
}

/** WHICH PRESET THIS OSCILLATOR IS HOLDING, as a preset id — or `''` for none.
 *
 * ⚠ THIS EXISTS BECAUSE THE PICKER USED TO RETURN `''` UNCONDITIONALLY, and a
 * control whose displayed value cannot move is indistinguishable from a dead
 * one. The faceplate parity sweep caught it on wavesculpt's own row: pick ZAP,
 * the chip still reads `— preset —`, forever. It was defended in a comment as
 * "a preset is an ACTION, so the picker rests on a sentinel", but the sweep is
 * right and the comment was wrong on two counts:
 *
 *  1. IT WAS A PARITY REGRESSION. `WavesculptCard.svelte` paints the same
 *     roster into a NATIVE `<select>`, and a native select shows what you
 *     picked — so the legacy card reflects the choice and only the faceplate
 *     could not. Faces must not lose an affordance the card has.
 *  2. IT WAS ALONE. Every other `kind: 'selector'` in `shell-cells.ts` —
 *     milkdrop's preset picker included, which this module's own comment cites
 *     as its precedent — derives `value` from the node. These four cells were
 *     the only ones that ignored it.
 *
 * The identity is DERIVED, not stored, so it cannot drift out of step with the
 * table actually loaded: pick a factory table or load your own `.wav` and this
 * goes back to `''` on its own, because both of those clear or overwrite the
 * label below. (Storing an id instead would need a field on `WavesculptOscData`
 * — measured: that moves the WebGL attest hash, since the def is a basis file
 * and only its `docs`/`face`/`controlFamilies` are stripped. A derivation in
 * this `.ts` costs no GPU re-attest, which is the same argument the header
 * makes for keeping the writes here.)
 *
 * ⚠ ITS ONE AMBIGUITY, STATED: a user `.wav` literally named `ZAP.wav` stores
 * the label `ZAP` and will read back as the ZAP preset. Nothing is lost by it —
 * the FACTORY picker says `USER · ZAP` either way — but it is a genuine
 * near-miss rather than an exact answer, and a reader should know that. */
export function wavesculptPresetValue(node: ModuleNode | undefined, oscIdx: number): string {
  const od = wavesculptOscData(node, oscIdx);
  if (od.wavetableSource !== 'user') return '';
  return WAVETABLE_PRESETS.find((p) => p.label === od.wavetableLabel)?.id ?? '';
}
