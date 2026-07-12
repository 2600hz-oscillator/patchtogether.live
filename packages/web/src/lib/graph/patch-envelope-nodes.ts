// packages/web/src/lib/graph/patch-envelope-nodes.ts
//
// Read-only decode of a PatchEnvelope's node map into plain objects — the
// runtime feeder for the cross-mode import guard's LEGACY inference path
// (patch-mode.ts / detectPatchMode). When an incoming export carries no `mode`
// stamp we must peek at its CONTENT (are there pinned/hiddenCard/default-wire
// nodes?) to classify it, and the envelope stores its graph as a base64 Yjs
// update — so we decode it here.
//
// This deliberately does NOT reuse persistence.ts's loadEnvelopeIntoStore:
// that function is the DESTRUCTIVE loader (it wipes + replaces the live graph),
// and it lives in the collab-attest basis. This module only READS — it decodes
// into a THROWAWAY Y.Doc and never touches the live doc, the live store, or any
// registry — so it stays out of the basis and can run as a pure precondition.

import * as Y from 'yjs';
import type { PatchModeNode } from './patch-mode';

/** base64 → bytes (browser + jsdom safe). Local copy so this module doesn't
 *  reach into persistence.ts's private helper. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Decode the `nodes` map from an envelope's base64 Yjs `update` into plain
 * node objects (id/type/data). READ-ONLY: applies the update to a throwaway
 * Y.Doc and severs the proxies via toJSON(). Defensive — returns [] for a
 * missing/garbage/undecodable update (the guard then infers 'dawless', the safe
 * default; a genuinely workflow patch would carry the explicit stamp anyway).
 */
export function decodeEnvelopeNodes(envelope: { update?: unknown } | null | undefined): PatchModeNode[] {
  const update = envelope?.update;
  if (typeof update !== 'string' || update.length === 0) return [];
  try {
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, base64ToBytes(update));
    const nodes = tempDoc.getMap('nodes').toJSON() as Record<string, PatchModeNode>;
    return Object.values(nodes);
  } catch {
    return [];
  }
}
