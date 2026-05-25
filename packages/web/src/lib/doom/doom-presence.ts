// packages/web/src/lib/doom/doom-presence.ts
//
// Per-DOOM-module Yjs awareness channel. Two payload kinds ride on a
// per-rack awareness field keyed by moduleId:
//
//   1. KEY ENVELOPES (small): {kind:'key', moduleId, srcUserId, doomKey, pressed}
//      Non-host users emit one each time their card sees keyboard input or a
//      CV-gate edge; the host's runtime mirror sees them and feeds the queue.
//
//   2. FRAME ENVELOPES (large): {kind:'frame', moduleId, hostUserId, width,
//      height, framebufferB64}
//      The host emits at ~10 Hz so spectators render the live game without
//      running their own WASM. We base64 the framebuffer to keep the
//      awareness payload schema strictly JSON; a typed transfer is a
//      future optimization (Y.Doc awareness rejects ArrayBuffer cleanly so
//      our path is JSON-string + decode-on-read).
//
// Both encode/decode are pure functions — testable as part of the unit
// suite without spinning up a Yjs provider. The actual awareness wiring
// (subscribing, throttling, host-migration tie-break) lives in DoomCard
// and is e2e-tested by the multi-tab Playwright scenario.

import { CV_GATE_PORT_IDS } from './doomkeys';

// ---------------- Key envelopes ----------------

export interface KeyEnvelope {
  kind: 'key';
  /** DOOM module instance id (one host per module-id). */
  moduleId: string;
  /** Who fired the input (Y.Awareness clientID or `${currentUserId}`). */
  srcUserId: string;
  /** doomkeys.h constant (0..255). */
  doomKey: number;
  pressed: boolean;
  /** Wall-clock millis at emit. Lossy on reorder but lets the host
   *  drop stale messages on disconnect storms (deferred). */
  ts: number;
}

export function encodeKey(env: KeyEnvelope): KeyEnvelope {
  // The "encoding" here is the typed object itself — Yjs awareness state
  // serializes JSON natively. We surface this function anyway so the
  // call site reads symmetrically with encodeFrame and so future schema
  // bumps can interpose validation (e.g. clamp doomKey to 0..255).
  return {
    kind: 'key',
    moduleId: env.moduleId,
    srcUserId: env.srcUserId,
    doomKey: env.doomKey & 0xff,
    pressed: !!env.pressed,
    ts: env.ts,
  };
}

export function decodeKey(raw: unknown): KeyEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'key') return null;
  if (typeof r['moduleId'] !== 'string') return null;
  if (typeof r['srcUserId'] !== 'string') return null;
  if (typeof r['doomKey'] !== 'number') return null;
  if (typeof r['pressed'] !== 'boolean') return null;
  if (typeof r['ts'] !== 'number') return null;
  return {
    kind: 'key',
    moduleId: r['moduleId'] as string,
    srcUserId: r['srcUserId'] as string,
    doomKey: (r['doomKey'] as number) & 0xff,
    pressed: r['pressed'] as boolean,
    ts: r['ts'] as number,
  };
}

// ---------------- Host-side relay receiver (edge-triggered) ----------------
//
// PHANTOM-INPUT BUG (fixed here): the host's awareness 'update' listener
// fires on EVERY awareness change in the rack — not just on a remote
// keystroke. The host's own ~10 Hz framebuffer broadcast
// (setLocalStateField('doom:<id>:frame', …)) alone emits ~10 updates/sec,
// and host-election / cursor / presence churn add more. The original
// receiver re-read each remote client's CURRENT `doom:<id>:key` field on
// every such update and re-pushed it into the runtime unconditionally.
//
// Result: a single still-held (or not-yet-cleared) remote key envelope —
// e.g. a second browser tab the user forgot about, which counts as a
// distinct awareness client — got re-injected as a fresh key event ~10×/sec.
// For KEY_DOWNARROW that reads in-game as the marine being shoved backward
// continuously with no key pressed ("random CV on the movement pot").
//
// Fix: edge-trigger. Track the last key-envelope `ts` we relayed per
// source client and only push when a STRICTLY NEWER envelope arrives.
// Repeated observations of the same (sticky) envelope across unrelated
// awareness updates are ignored. This is a pure reducer so it's unit-
// testable without a live Yjs provider.

/** Per-source-client cursor of the last relayed key-envelope timestamp.
 *  Keyed by awareness clientID. Callers own one map per DOOM card. */
export type RelayCursor = Map<number, number>;

/** One key event the host should push into its runtime this update. */
export interface RelayPush {
  doomKey: number;
  pressed: boolean;
}

/**
 * Given the current awareness states + the cursor of already-relayed
 * timestamps, return ONLY the key events that are new since last call and
 * advance the cursor in place. Pure aside from the cursor mutation:
 * calling it twice with the same states + cursor yields an empty list the
 * second time (the dedup that kills the phantom re-injection).
 *
 *  - skips the host's own client (selfClientId)
 *  - skips envelopes the host itself authored (selfUserId) — defends
 *    against a host that is ALSO relaying (shouldn't happen, but cheap)
 *  - skips envelopes for a different module id
 *  - skips null / malformed `doom:<id>:key` fields (cleared envelopes)
 */
export function collectIncomingKeyPushes(args: {
  states: Map<number, Record<string, unknown>>;
  moduleId: string;
  selfClientId: number;
  selfUserId: string;
  cursor: RelayCursor;
}): RelayPush[] {
  const { states, moduleId, selfClientId, selfUserId, cursor } = args;
  const pushes: RelayPush[] = [];
  states.forEach((state, clientId) => {
    if (clientId === selfClientId) return;
    const env = decodeKey((state as Record<string, unknown>)[`doom:${moduleId}:key`]);
    if (!env || env.moduleId !== moduleId) return;
    if (env.srcUserId === selfUserId) return;
    const last = cursor.get(clientId);
    if (last !== undefined && env.ts <= last) return; // already relayed — skip the sticky re-read.
    cursor.set(clientId, env.ts);
    pushes.push({ doomKey: env.doomKey, pressed: env.pressed });
  });
  return pushes;
}

// ---------------- Frame envelopes ----------------

export interface FrameEnvelope {
  kind: 'frame';
  moduleId: string;
  hostUserId: string;
  width: number;
  height: number;
  /** Base64-encoded BGRA8 pixel buffer (DOOM's native format). Length is
   *  width*height*4 bytes pre-encoding; the b64 envelope is ~33% larger.
   *  640×400×4 = 1024000 B raw → ~1366000 B b64. At 10 Hz that's ~13 MB/s
   *  per spectator pair; awareness is intentionally bounded to small
   *  payloads, so we cap the broadcast rate AGGRESSIVELY in DoomCard. */
  framebufferB64: string;
  ts: number;
}

/** Encode a raw BGRA framebuffer (Uint8Array view over WASM HEAP) to
 *  base64 + wrap in the awareness envelope. Pure: identical inputs →
 *  identical output. Throws if width*height*4 doesn't match buf.length. */
export function encodeFrame(args: {
  moduleId: string;
  hostUserId: string;
  width: number;
  height: number;
  framebuffer: Uint8Array | Uint8ClampedArray;
  ts: number;
}): FrameEnvelope {
  const expected = args.width * args.height * 4;
  if (args.framebuffer.length !== expected) {
    throw new Error(
      `encodeFrame: buffer length ${args.framebuffer.length} != ${args.width}*${args.height}*4 = ${expected}`,
    );
  }
  return {
    kind: 'frame',
    moduleId: args.moduleId,
    hostUserId: args.hostUserId,
    width: args.width,
    height: args.height,
    framebufferB64: bytesToB64(args.framebuffer),
    ts: args.ts,
  };
}

/** Inverse of encodeFrame. Returns null on shape mismatch (callers
 *  silently drop malformed frames). */
export function decodeFrame(raw: unknown): FrameEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'frame') return null;
  if (typeof r['moduleId'] !== 'string') return null;
  if (typeof r['hostUserId'] !== 'string') return null;
  if (typeof r['width'] !== 'number') return null;
  if (typeof r['height'] !== 'number') return null;
  if (typeof r['framebufferB64'] !== 'string') return null;
  if (typeof r['ts'] !== 'number') return null;
  return {
    kind: 'frame',
    moduleId: r['moduleId'] as string,
    hostUserId: r['hostUserId'] as string,
    width: r['width'] as number,
    height: r['height'] as number,
    framebufferB64: r['framebufferB64'] as string,
    ts: r['ts'] as number,
  };
}

/** Decode the framebuffer half of a FrameEnvelope back to a Uint8Array
 *  for the spectator's GL upload. Separate from decodeFrame so the
 *  envelope-validation step can short-circuit on schema mismatch
 *  without paying the base64 decode cost. */
export function decodeFrameBuffer(env: FrameEnvelope): Uint8Array {
  return b64ToBytes(env.framebufferB64);
}

// ---------------- Host migration tie-break ----------------
//
// Spec: when the host leaves the rack the next user takes over from
// current state. "Next" = the surviving rack-member whose user id sorts
// lexicographically first. Deterministic + symmetric across clients →
// no quorum needed.

/** Pure: given the current host (or null on first spawn) and the live
 *  set of rack-member user ids, return who should be host this tick. */
export function pickHost(currentHost: string | null, members: readonly string[]): string | null {
  if (members.length === 0) return null;
  if (currentHost !== null && members.includes(currentHost)) {
    return currentHost;
  }
  // Stable: lex-sorted first id wins. Sort a copy to avoid mutating the
  // caller's array.
  const sorted = [...members].sort();
  return sorted[0] ?? null;
}

// ---------------- Internal: base64 helpers ----------------
//
// btoa / atob are available in browsers AND in Node 16+, but TS's
// lib.dom typings flag them as DOM-only — we keep the calls behind
// helpers so the few places that need them get readable code.

function bytesToB64(buf: Uint8Array | Uint8ClampedArray): string {
  // Chunked: btoa-string-construction on a 1 MB framebuffer + 1 MB
  // String.fromCharCode chain blows the JS call stack on Safari. Process
  // in 8 KB slices.
  const SLICE = 8192;
  let binary = '';
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += SLICE) {
    const slice = bytes.subarray(i, i + SLICE);
    binary += String.fromCharCode(...slice);
  }
  // btoa exists in browsers + node; node sometimes adds it via globalThis.
  return globalThis.btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------------- Module-level invariants exported for tests ----------------

export const SUPPORTED_KEY_PORT_IDS = CV_GATE_PORT_IDS;
