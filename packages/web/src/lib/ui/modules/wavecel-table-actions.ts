// packages/web/src/lib/ui/modules/wavecel-table-actions.ts
//
// THE ONE IMPLEMENTATION of WAVECEL's three wavetable-acquisition actions —
// pick a factory table, load a built-in preset, import a WAV — shared by the
// legacy card and by the faceplate's shell cells.
//
// ⚠ WHY IT EXISTS AT ALL, and it is the `dx7-patch-actions` argument. A face
// promotes the module, `migrated()` goes true, and NEITHER surface renders
// `WavecelCard.svelte` any more. Every one of these actions lived only in that
// card's `<script>`, so without extracting them the faceplate would either have
// no way to load a wavetable (the `samsloop` STOP-2 failure) or a SECOND copy
// of the same node.data writes, free to drift from the card's.
//
// All three write the SAME `node.data` keys the card wrote, deliberately: a
// rack saved before the promotion carries `wavetableSource` / `wavetableFrames`
// / `wavetableLabel` already, and the factory's poll loop is what picks them
// up (within POLL_MS) and re-posts to the worklet. Reading or writing a
// different key would silently orphan every saved table.
//
// ⚠ NODE.DATA, NOT NODE.PARAMS — so `mutate.guard` (which greps `node.params`
// writes) does not see these, and they are not a raw-write-ledger entry. The
// data path is the one the card already used and the one the worklet already
// polls; this module changes WHERE it is written from, never WHAT is written.

import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import type { WavecelData } from '$lib/audio/modules/wavecel';
import {
  getFactoryTables,
  DEFAULT_FACTORY_TABLE_ID,
  framesToPlain,
} from '$lib/audio/wavetable-factory-tables';
import { parseE352Wav } from '$lib/audio/wavetable-parser';
import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';

/** The `accept` string for the WAV importer — one definition, so the card and
 *  the shell `file` cell cannot drift on what they will open. */
export const WAVECEL_WAV_ACCEPT = '.wav,audio/wav';

/** What a loader reports back: the shell `file` cell's contract is
 *  `Promise<{ status, error }>`, and the card renders the same two strings in
 *  its `wavecel-upload-status` / `wavecel-upload-error` divs. The two
 *  surfaces therefore say the same words because they call one function. */
export interface WavecelLoadResult {
  status: string | null;
  error: string | null;
}

/** The node's data bag, created on demand. Returns `null` when the node is
 *  gone — every caller is an async user gesture, so the node CAN disappear
 *  mid-flight (a delete during a fetch), and silently doing nothing is right. */
function dataOf(nodeId: string): WavecelData | null {
  const target = patch.nodes[nodeId];
  if (!target) return null;
  if (!target.data) target.data = {};
  return target.data as WavecelData;
}

/** The selected source id — `factory:<id>` or `'user'`. */
export function wavecelSourceValue(node: ModuleNode | undefined): string {
  const d = node?.data as WavecelData | undefined;
  return d?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
}

/** The human label for the current source (the USER row carries the uploaded
 *  file's name, which is the only place it is ever shown). */
export function wavecelSourceLabel(node: ModuleNode | undefined): string {
  const d = node?.data as WavecelData | undefined;
  if (d?.wavetableSource === 'user' && d.wavetableLabel) return d.wavetableLabel;
  const factories = getFactoryTables();
  const id = wavecelSourceValue(node).slice('factory:'.length);
  return factories.find((t) => t.id === id)?.label ?? factories[0]!.label;
}

/** The source roster: every factory table, plus a USER row ONLY once an upload
 *  exists — offering "user" with nothing loaded would be a dead option. */
export function wavecelSourceOptions(
  node: ModuleNode | undefined,
): { value: string; label: string }[] {
  const opts = getFactoryTables().map((t) => ({ value: `factory:${t.id}`, label: t.label }));
  const d = node?.data as WavecelData | undefined;
  if (d?.wavetableSource === 'user') {
    opts.push({ value: 'user', label: `USER · ${wavecelSourceLabel(node)}` });
  }
  return opts;
}

/** Select a FACTORY table. Clears the user upload's frames + label, because
 *  leaving them would make a later `'user'` selection resurrect a table the
 *  operator believes they replaced. */
export function selectWavecelSource(nodeId: string, value: string): void {
  if (value === 'user') return; // the USER row is a state, not an action
  const d = dataOf(nodeId);
  if (!d) return;
  const factoryId = value.startsWith('factory:') ? value.slice('factory:'.length) : value;
  d.wavetableSource = `factory:${factoryId}`;
  delete d.wavetableFrames;
  delete d.wavetableLabel;
  // A factory table is not a preset — clear the marker so the preset selector
  // cannot keep naming something that is no longer loaded.
  delete d.wavetablePresetId;
}

/** The built-in preset roster. The leading blank row is what lets the SAME
 *  preset be re-picked (the selection resets to '' on completion), which is
 *  the card's own cheap "did it actually take?" affordance. */
export function wavecelPresetOptions(): { value: string; label: string }[] {
  return [
    { value: '', label: '— pick a preset —' },
    ...WAVETABLE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
  ];
}

/** Which preset is loaded, or '' for none.
 *
 *  ⚠ THE CARD ANSWERS THIS DIFFERENTLY, AND THE CARD IS THE ONE THAT IS WRONG
 *  for a faceplate. It blanks its `<select>` as soon as a load finishes, so the
 *  control never shows what it loaded. `faces-parity` refuses exactly that: it
 *  picks an option and asserts the selection CHANGED, on the grounds that a
 *  selector which always reads the same thing cannot be told apart from a dead
 *  one. So the face reports real state — and the panel picture is the
 *  did-it-take feedback the card's reset was substituting for. */
export function wavecelPresetValue(node: ModuleNode | undefined): string {
  const d = node?.data as WavecelData | undefined;
  return d?.wavetablePresetId ?? '';
}

/** Load a built-in preset into the node. Writes the same three keys the WAV
 *  importer writes, so a preset and an upload are indistinguishable downstream
 *  — which is the existing behaviour, preserved deliberately. */
export async function loadWavecelPreset(
  nodeId: string,
  presetId: string,
): Promise<WavecelLoadResult> {
  if (!presetId) return { status: null, error: null };
  const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return { status: null, error: `unknown preset: ${presetId}` };
  try {
    const parsed = await loadWavetablePreset(preset.url);
    const d = dataOf(nodeId);
    if (!d) return { status: null, error: null };
    d.wavetableSource = 'user';
    d.wavetableFrames = parsed.frames;
    d.wavetableLabel = preset.label;
    d.wavetablePresetId = preset.id;
    return {
      status: `loaded ${parsed.frames.length} frames @ ${parsed.sampleRate} Hz`,
      error: null,
    };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Import a user WAV. The label is the filename, uppercased and clipped to 24
 *  chars — the width the source dropdown can actually show. */
export async function loadWavecelWavFile(
  nodeId: string,
  file: File,
): Promise<WavecelLoadResult> {
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseE352Wav(buf);
    const d = dataOf(nodeId);
    if (!d) return { status: null, error: null };
    d.wavetableSource = 'user';
    d.wavetableFrames = framesToPlain(parsed.frames);
    d.wavetableLabel = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
    // A user upload is not a preset — same reason as the factory path.
    delete d.wavetablePresetId;
    return {
      status: `loaded ${parsed.frames.length} frames @ ${parsed.sampleRate} Hz`,
      error: null,
    };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}
