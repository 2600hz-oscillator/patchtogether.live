// packages/web/src/lib/ui/modules/cube/cube-table-actions.ts
//
// The three WAVETABLE SLOT writes, shared by the legacy card and the
// faceplate's `cube-table-stack` panel — the `dx7-patch-actions` precedent.
//
// ⚠ WHY THIS IS ONE FILE AND NOT TWO COPIES. The slot write is not a one-liner:
// picking a factory table must DELETE the stale `frames`/`label` a previous
// load left behind, and a load must set `source:'user'` so the roster's
// synthetic USER entry resolves. A second implementation of that in the panel
// is the drift the shell-cells registry exists to prevent — the DX7 shipped
// with its preset selector unreachable under `?shell=1` precisely because the
// card owned the action.
//
// PURE-ish: these take a nodeId and mutate the graph store, exactly like the
// other `*-actions` modules. No DOM, no component state.

import { patch } from '$lib/graph/store';
import { framesToPlain, getFactoryTables } from '$lib/audio/wavetable-factory-tables';
import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
import { parseE352Wav } from '$lib/audio/wavetable-parser';
import { CUBE_DEFAULT_TABLES, type CubeData, type CubeSlot, type CubeSlotData } from '$lib/audio/modules/cube';

export const CUBE_WAV_ACCEPT = '.wav,audio/wav';

/** A slot's live `node.data` entry (never undefined — an untouched slot reads
 *  as `{}` and every consumer falls back to the slot DEFAULT). */
export function cubeSlotData(
  node: { data?: unknown } | undefined,
  slot: CubeSlot,
): CubeSlotData {
  const d = (node?.data ?? {}) as CubeData;
  return (d[slot] as CubeSlotData | undefined) ?? {};
}

/** The `source` string a slot currently resolves to, defaults included. */
export function cubeSlotSource(node: { data?: unknown } | undefined, slot: CubeSlot): string {
  return cubeSlotData(node, slot).source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
}

/** Human label of the currently-loaded table (the loaded filename for a user
 *  table, else the factory table's label). */
export function cubeSlotLabel(node: { data?: unknown } | undefined, slot: CubeSlot): string {
  const sd = cubeSlotData(node, slot);
  if (sd.source === 'user') return sd.label ?? 'USER';
  const src = cubeSlotSource(node, slot);
  if (src.startsWith('factory:')) {
    const fid = src.slice('factory:'.length);
    return getFactoryTables().find((t) => t.id === fid)?.label ?? fid;
  }
  return src;
}

function ensureSlot(nodeId: string, slot: CubeSlot): CubeSlotData | null {
  const t = patch.nodes[nodeId];
  if (!t) return null;
  if (!t.data) t.data = {};
  const d = t.data as CubeData;
  if (!d[slot]) (d as Record<string, unknown>)[slot] = {};
  return d[slot] as CubeSlotData;
}

/** Point a slot at a FACTORY table. Clears any loaded frames so the factory's
 *  poll loop reposts the factory table rather than the stale user one. */
export function selectCubeFactoryTable(nodeId: string, slot: CubeSlot, factoryId: string): void {
  const sd = ensureSlot(nodeId, slot);
  if (!sd) return;
  sd.source = `factory:${factoryId}`;
  delete sd.frames;
  delete sd.label;
}

/** Load a baked PRESET wavetable into a slot. Returns a status line. */
export async function selectCubePreset(
  nodeId: string,
  slot: CubeSlot,
  presetId: string,
): Promise<{ status: string | null; error: string | null }> {
  const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return { status: null, error: `unknown preset ${presetId}` };
  try {
    const parsed = await loadWavetablePreset(preset.url);
    const sd = ensureSlot(nodeId, slot);
    if (!sd) return { status: null, error: 'node is gone' };
    sd.source = 'user';
    sd.frames = parsed.frames;
    sd.label = preset.label;
    return { status: `loaded ${parsed.frames.length} frames`, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse a user .wav into a slot. Returns a status line. */
export async function loadCubeWavFile(
  nodeId: string,
  slot: CubeSlot,
  file: File,
): Promise<{ status: string | null; error: string | null }> {
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseE352Wav(buf);
    const sd = ensureSlot(nodeId, slot);
    if (!sd) return { status: null, error: 'node is gone' };
    sd.source = 'user';
    sd.frames = framesToPlain(parsed.frames);
    sd.label = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
    return { status: `loaded ${parsed.frames.length} frames`, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}
