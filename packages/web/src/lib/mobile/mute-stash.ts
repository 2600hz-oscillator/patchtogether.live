// packages/web/src/lib/mobile/mute-stash.ts
//
// UI-level channel MUTE for the MIX tab (spec §3 MIX — DECISION):
//
// MIXMSTRS has NO mute param (the def reserves none; Electra reserves the
// row). v1 mute = write volume 0 + STASH the previous volume in
// `node.data['ch{N}_muteStash']` via ONE in-place transact — the stash syncs
// to peers so two clients can't fight a view-local stash, and desktop
// truthfully shows volume 0. Known tradeoff: CV patched into the volume
// input defeats it. The real `ch{N}_mute` param is a deliberate follow-up
// contract-change PR (also unblocks the Electra mute row).
//
// Yjs discipline: single-key in-place writes inside mutateNode — never a
// rebuild/reassign of an integrated map ([[yjs-save-load-real-ydoc]]).

import { mutateNode } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';

export function muteStashKey(ch: number): string {
  return `ch${ch}_muteStash`;
}

export function volumeParamId(ch: number): string {
  return `ch${ch}_volume`;
}

/** The mixmstrs channel volume default (mixmstrs.ts buildParams). */
export const CH_VOLUME_DEFAULT = 0.8;

/** Muted ⇔ a stash exists on the node. */
export function isChannelMuted(node: ModuleNode | undefined, ch: number): boolean {
  return typeof (node?.data as Record<string, unknown> | undefined)?.[muteStashKey(ch)] === 'number';
}

/**
 * Toggle mute for channel `ch` of a mixmstrs node — ONE transact either way:
 *   mute:   stash the current volume (param → default fallback), volume = 0.
 *   unmute: volume = stash, delete the stash key.
 * Idempotent against races: muting an already-muted channel / unmuting an
 * unmuted one is a no-op.
 */
export function toggleChannelMute(nodeId: string, ch: number): void {
  const volKey = volumeParamId(ch);
  const stashKey = muteStashKey(ch);
  mutateNode(nodeId, (live) => {
    if (!live.data) live.data = {};
    const data = live.data as Record<string, unknown>;
    const stashed = data[stashKey];
    if (typeof stashed === 'number') {
      // UNMUTE — restore, then clear the stash (single keys, in place).
      live.params[volKey] = stashed;
      delete data[stashKey];
    } else {
      // MUTE — stash the live volume (fallback to the param default so an
      // untouched fader still restores to something sensible), then zero.
      const current = live.params[volKey];
      data[stashKey] = typeof current === 'number' ? current : CH_VOLUME_DEFAULT;
      live.params[volKey] = 0;
    }
  });
}
