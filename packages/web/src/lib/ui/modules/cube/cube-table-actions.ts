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
import {
  CUBE_DEFAULT_TABLES,
  resolveSlotFrames,
  type CubeData,
  type CubeSlot,
  type CubeSlotData,
} from '$lib/audio/modules/cube';

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

/**
 * A slot's resolved FRAMES, memoised on which table the slot holds.
 *
 * ⚠ `resolveSlotFrames` COPIES EVERY FRAME (`t.frames.map(f => new
 * Float32Array(f))`) — 16 384 floats per table, 49 152 across the three, 0.076 ms
 * measured. Both faceplate panels read frames from a `$derived` that re-runs on
 * every node-version bump, i.e. every tick of a knob drag, so calling it bare
 * re-copies all of it ~60 times a second to redraw tables that did not change.
 *
 * ⚠ HONEST MAGNITUDE, because a cache invites over-reading: 0.076 ms is 5.1 %
 * of the hero panel's per-bump cost. The dominant term is the 1.421 ms wave
 * scan, and THAT is fixed by `cubeWaveSignature`, not by this. This memo earns
 * its place on the second count below — the WeakMap half is a correctness fix,
 * not a speed-up.
 *
 * ⚠ TWO CACHES, BECAUSE ONE KEY CANNOT BE BOTH CHEAP AND EXACT — and getting
 * this wrong is the failure mode that looks like nothing at all. A FACTORY
 * table is fully identified by its id, so a string key is exact. A USER table
 * is not: its signature would be `user:<FILENAME>:<frameCount>`, so re-loading
 * an EDITED file under the same name with the same frame count is a key
 * COLLISION, and the panel would keep drawing the old wavetable forever with
 * every gate green. (The card's field-texture signature has always had that
 * weakness; it was survivable there only because the GL path prefers the
 * engine's frames. It is not survivable in a cache.) So a user table is keyed
 * on the IDENTITY of its own frames array instead, in a WeakMap:
 *
 *   - exact — a re-load writes a new array, which is a miss by construction;
 *   - self-evicting — the entry dies with the node data that owns it;
 *   - and it FAILS SAFE. If the store hands back a fresh proxy per read the
 *     lookup simply always misses, which costs the copy and returns the
 *     CORRECT frames. The degradation is performance, never staleness.
 *
 * The string map is therefore bounded by the factory roster (3 slots × the
 * table list), not by session history.
 */
const FACTORY_FRAME_MEMO = new Map<string, readonly Float32Array[]>();
const USER_FRAME_MEMO = new WeakMap<object, readonly Float32Array[]>();

/**
 * WHICH table this slot holds — the string both the memo and the renderer's
 * field-texture invalidation key on, so the picture and its frames can never
 * disagree about whether a table moved.
 *
 * ⚠ It deliberately does NOT read any param: that is the property the panels'
 * `$derived` chains rely on to stop propagating on a knob tick.
 */
export function cubeSlotTableSig(node: { data?: unknown } | undefined, slot: CubeSlot): string {
  const sd = cubeSlotData(node, slot);
  return `${slot}:${cubeSlotSource(node, slot)}:${sd.label ?? ''}:${sd.frames?.length ?? 0}`;
}

/** Cache MISSES so far — the memo's own instrument. Exported so a test can
 *  measure that it memoises rather than assert that it should. */
let frameResolveCount = 0;
export function cubeFrameResolveCount(): number {
  return frameResolveCount;
}

export function cubeSlotFrames(
  node: { data?: unknown } | undefined,
  slot: CubeSlot,
): readonly Float32Array[] {
  const sd = cubeSlotData(node, slot);
  const userFrames = sd.source === 'user' && Array.isArray(sd.frames) && sd.frames.length > 0
    ? (sd.frames as unknown as object)
    : null;

  if (userFrames) {
    const hit = USER_FRAME_MEMO.get(userFrames);
    if (hit) return hit;
    frameResolveCount++;
    const frames = resolveSlotFrames(slot, sd).frames;
    USER_FRAME_MEMO.set(userFrames, frames);
    return frames;
  }

  const key = cubeSlotTableSig(node, slot);
  const hit = FACTORY_FRAME_MEMO.get(key);
  if (hit) return hit;
  frameResolveCount++;
  const frames = resolveSlotFrames(slot, sd).frames;
  FACTORY_FRAME_MEMO.set(key, frames);
  return frames;
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
