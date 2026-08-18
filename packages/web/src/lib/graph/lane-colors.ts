// packages/web/src/lib/graph/lane-colors.ts
//
// THE RACK'S LANE COLOURS — one derivation, read by every surface that paints
// "channel N" in channel N's colour.
//
// ── WHY IT IS ITS OWN FILE (#1825) ─────────────────────────────────────────
//
// A rackspace has ONE canonical clip player — the lowest node id, the same
// deterministic tie-break `automationAssignmentFor` and the assigned-card
// border already use — and its per-lane colour is the identity of channel N
// EVERYWHERE: the automation lane, the clip grid row, the mixer channel, the
// Launchpad LED, the card border, and (since #1825) the mixmstrs faceplate's
// Nth column.
//
// Until now the mapping existed only as an inline `$derived.by` inside
// `Canvas.svelte` (`ctxMenuChannelColors`), which meant the SECOND consumer had
// two choices: reach into Canvas, or restate the derivation. Restating it is
// the failure this repo keeps paying for — two opinions that agree on the day
// they are written and disagree the first time the tie-break, the lane count or
// the unpicked-colour fallback moves. So the derivation moves here and Canvas
// consumes it, which is what makes "the face and the menu show the same eight
// colours" a property of the code rather than of care.
//
// ⚠ NO COLOUR IS CHOSEN HERE. `laneColorEff` is the authority: the user's
// picked `#rrggbb` if there is one, else `defaultLaneColorHex(lane)` — the
// evenly-spaced hue the clip card and the LED pads already agree on. This file
// only decides WHICH player's lanes to read.
//
// ⚠ AND IT IS TOTAL ONLY WHEN A PLAYER EXISTS. `[]` means "this rack has no
// clip player, so no lane has a colour" — NOT "black". Every consumer must
// state its own fallback for that case; the faceplate's is the domain accent.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  CLIP_LANES,
  laneColorEff,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import { listClipPlayers } from './automation-assign';
import { PINNED_CLIP_ID } from './column-reconcile';

/** The minimum a node must expose for this file to read it. */
interface NodeLike {
  type?: string;
  data?: unknown;
}

/**
 * The rack's CANONICAL clip player — the PINNED one if the rack has it, else
 * the lowest node id — or `null` when the rack has none.
 *
 * ⚠ THE PINNED CLAUSE IS NOT DECORATION, AND ITS ABSENCE WAS A LATENT SPLIT.
 * Canvas held TWO answers to this question: the workflow column badges asked
 * `wcolCanonClip()` (pinned first), and the node menu's channel BUTTONS took
 * their tint from `listClipPlayers().sort()[0]` (lowest id, full stop). A
 * workflow rack has BOTH a `pinned-clipplayer` and, the moment a player is
 * spawned from the palette, a second id — and `'clipplayer…' <
 * 'pinned-clipplayer'`, so the two derivations answer with DIFFERENT players
 * and the rack paints two sets of channel colours at once. (The channel
 * ASSIGNMENT never split: the workflow branch of `commitAssignToChannel`
 * returns early through `wcolCanonClip`. It was the colours that could
 * disagree, which is precisely the value #1825 now also paints a console
 * with.) One rule, stated once, is the fix.
 *
 * ⚠ THE SORT IS THE TIE-BREAK, NOT A TIDY-UP. `Object.entries` order is an
 * insertion artifact, so without it a second clip player could silently
 * re-colour every channel depending on the order the Y.Doc happened to replay.
 * `automationAssignmentFor` sorts for exactly this reason.
 */
export function canonicalClipPlayerId(
  nodes: Record<string, NodeLike | undefined>,
): string | null {
  if (nodes[PINNED_CLIP_ID]?.type === 'clipplayer') return PINNED_CLIP_ID;
  return listClipPlayers(nodes).sort()[0] ?? null;
}

/**
 * The canonical clip player's per-lane colours, lane 0 first — or `[]` when the
 * rack has no clip player to hold them.
 *
 * The length is `CLIP_LANES`, read off the clip module's own constant rather
 * than typed: a rack that grows a ninth lane grows a ninth colour here and on
 * every surface that consumes this, with nothing to update.
 */
export function canonicalLaneColors(
  nodes: Record<string, NodeLike | undefined>,
): string[] {
  const player = canonicalClipPlayerId(nodes);
  if (!player) return [];
  const data = nodes[player]?.data as ClipPlayerData | undefined;
  return Array.from({ length: CLIP_LANES }, (_, lane) => laneColorEff(data, lane));
}
