// packages/web/src/lib/mobile/mobile-host.ts
//
// MOBILE PROTOTYPE (`/m/*`) — engine host + graph recipes, OUTSIDE Canvas.
//
// The mobile routes host the SAME store + engine as the desktop canvas but
// render their own touch-first views (CardStage single-node pager, matrix
// patching, mixer lanes). Canvas.svelte keeps its ~40-line `ensureEngine`
// recipe + spawn/delete transacts PRIVATE, so this module re-implements them
// against the exact same lib seams (spec: .myrobots/plans/
// mobile-view-2026-07-02.md §2). Rules preserved verbatim:
//
//   - 48 kHz pin (every ART baseline / DSP time-constant is calibrated there).
//   - DECISION: hard-coded Stable 45 ms latencyHint on mobile — the owner's
//     drag-glitch is an output-buffer underrun and phone+video is the
//     worst-case profile. No latency ladder UI on mobile.
//   - Audio must survive a missing WebGL2 (VideoEngine try/catch).
//   - Memoized boot promise (two parallel callers must not race two
//     AudioContexts).
//   - One LOCAL_ORIGIN transact per structural edit so everything lands on
//     the undo stack + would ride a Y.Doc to peers.
//
// Side-effect barrel imports are MANDATORY — without them the module
// registries are empty and every def lookup returns undefined.

import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { AudioEngine, PatchEngine } from '$lib/audio/engine';
import { attachReconciler } from '$lib/audio/reconciler';
import { setActiveEngine } from '$lib/audio/engine-ref';
import { getModuleDef } from '$lib/audio/module-registry';
import { VideoEngine } from '$lib/video/engine';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import '$lib/audio/modules'; // auto-registers every audio def
import '$lib/video/modules'; // auto-registers every video def
import '$lib/meta/modules'; // auto-registers meta defs
import { instanceCount, wouldExceedCap } from '$lib/graph/cap';
import { canAddModule } from '$lib/doom/doom-gating';
import { nextDefaultName } from '$lib/multiplayer/module-naming';
import type { ResolveDef } from '$lib/graph/validate-edge';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  loadEnvelopeIntoStore,
  type LivePatch,
} from '$lib/graph/persistence';
import { testHooksEnabled } from '$lib/dev/test-hooks';

// ---------------- Def lookup ----------------

/** Registry chain shared by every mobile consumer (spawn, matrix validate,
 *  card resolution). Same order the desktop spawn path uses. */
export const resolveAnyDef: ResolveDef = (type) =>
  getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);

/** Loose common def view across the three registries — just the fields the
 *  mobile host reads. Every real AudioModuleDef / VideoModuleDef /
 *  MetaModuleDef is structurally assignable to it. */
export interface AnyDefLike {
  type: string;
  label?: string;
  maxInstances?: number;
  undeletable?: boolean;
  inputs?: readonly import('$lib/graph/types').PortDef[];
  outputs?: readonly import('$lib/graph/types').PortDef[];
  params?: readonly import('$lib/graph/types').ParamDef[];
  stereoPairs?: readonly (readonly [string, string])[];
  size?: string;
  hp?: number;
}

/** Full def (loose shape) + its domain, for the spawn transact. */
export function lookupDefWithDomain(type: string): {
  def: AnyDefLike | undefined;
  domain: 'audio' | 'video' | 'meta';
} {
  const audioDef = getModuleDef(type);
  const videoDef = !audioDef ? getVideoModuleDef(type) : undefined;
  const metaDef = !audioDef && !videoDef ? getMetaModuleDef(type) : undefined;
  return {
    def: (audioDef ?? videoDef ?? metaDef) as AnyDefLike | undefined,
    domain: audioDef ? 'audio' : videoDef ? 'video' : 'meta',
  };
}

// ---------------- Engine boot (45 ms / 48 kHz) ----------------

/** The mobile-pinned AudioContext latency hint — Stable (45 ms). */
export const MOBILE_LATENCY_HINT_S = 0.045;

let engine: PatchEngine | null = null;
let audioCtx: AudioContext | null = null;
let reconciler: { dispose(): void } | null = null;
let bootPromise: Promise<PatchEngine> | null = null;

export interface MobileEngineOptions {
  /** Boot the VideoEngine at a specific render resolution (the /m/cam page
   *  boots at 960×540 — the perf-ladder default for phone GPUs). Omitted =
   *  the engine's own default (1024×768). Only honoured on first boot. */
  videoRes?: { width: number; height: number };
}

/**
 * Boot (or return) the mobile PatchEngine. Mirrors Canvas.svelte ensureEngine:
 * memoized in-flight promise, 48 kHz pin, audio survives missing WebGL2,
 * reconciler attached, engine-ref published.
 */
export async function ensureMobileEngine(opts: MobileEngineOptions = {}): Promise<PatchEngine> {
  if (engine) return engine;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      audioCtx = new AudioContext({
        latencyHint: MOBILE_LATENCY_HINT_S,
        sampleRate: 48000,
      });
      // iOS: route as media playback so the silent (ringer) switch doesn't
      // mute the synth. Feature-detected — the API is Safari 16.4+.
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      try {
        if (nav.audioSession) nav.audioSession.type = 'playback';
      } catch {
        /* non-fatal — playback still works, just honours the silent switch */
      }
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const e = new PatchEngine();
      e.registerDomain(new AudioEngine(audioCtx));
      try {
        const ve = opts.videoRes
          ? new VideoEngine({ res: { width: opts.videoRes.width, height: opts.videoRes.height } })
          : new VideoEngine();
        e.registerDomain(ve);
      } catch (videoErr) {
        console.warn('[mobile-host] video engine unavailable:', videoErr);
      }
      reconciler = attachReconciler(e);
      engine = e;
      setActiveEngine(e);
      return e;
    } catch (err) {
      bootPromise = null; // allow retry on next call
      throw err;
    }
  })();
  return bootPromise;
}

/** The live mobile engine (null before the first gesture boots it). */
export function getMobileEngine(): PatchEngine | null {
  return engine;
}

/** The live AudioContext (null before boot) — the AudioGate binds to this. */
export function getMobileAudioContext(): AudioContext | null {
  return audioCtx;
}

/** Tear down the engine + reconciler on route destroy. Navigation between
 *  /m routes is a full reload (data-sveltekit-reload), so this is
 *  belt-and-suspenders against SPA-nav leaks. */
export function disposeMobileEngine(): void {
  reconciler?.dispose();
  reconciler = null;
  engine?.dispose();
  engine = null;
  setActiveEngine(null);
  try {
    void audioCtx?.close();
  } catch {
    /* already closed */
  }
  audioCtx = null;
  bootPromise = null;
}

// ---------------- Spawn / delete / unpatch transacts ----------------

/**
 * Spawn a module — the Canvas spawn recipe: def lookup across the three
 * registries → owner-only gate → maxInstances cap → `${type}-${uuid8}` id →
 * nextDefaultName → ONE LOCAL_ORIGIN transact → kick the engine boot.
 *
 * Returns the new node id, or null when the spawn was refused (unknown type
 * or at cap). Position is a spread-out column so a doc opened on desktop
 * later doesn't stack every card at the origin.
 */
export function spawnModule(
  type: string,
  initialData: Record<string, unknown> = {},
  initialParams: Record<string, number> = {},
): string | null {
  const { def, domain } = lookupDefWithDomain(type);
  if (!def) return null;
  // Mobile is single-user/scratch — treat the local user as the owner so
  // the shared gate helper keeps its signature (it only bites for DOOM).
  if (!canAddModule(type, true)) return null;
  if (def.maxInstances !== undefined && wouldExceedCap(patch.nodes, def)) {
    return null;
  }
  const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
  const autoName = nextDefaultName(patch.nodes, type);
  const existing = Object.keys(patch.nodes).length;
  // spawnSeq = the RACK chip-strip ordering key (spawn order, not id order).
  const data: Record<string, unknown> = { name: autoName, spawnSeq: Date.now(), ...initialData };
  // BENTBOX honours persisted dims — stamp a phone-fit 370px square ONCE at
  // spawn so the card fits the pager natively forever (spec §3 RACK).
  if (type === 'bentbox' && data.width === undefined) {
    data.width = 370;
    data.height = 370;
  }
  const params: Record<string, number> = { ...initialParams };
  // MIXMSTRS: seed the volume params so a later mute/undo is always a value
  // CHANGE (the reconciler skips REMOVED param keys — see first-bleep.ts
  // mixmstrsSeedParams for the full rationale).
  if (type === 'mixmstrs') {
    params.master_volume = params.master_volume ?? 0.8;
    for (let ch = 1; ch <= 6; ch++) {
      params[`ch${ch}_volume`] = params[`ch${ch}_volume`] ?? 0.8;
    }
  }
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type,
      domain,
      // Simple column layout for desktop-open parity: 2 per row.
      position: { x: 40 + (existing % 2) * 620, y: 40 + Math.floor(existing / 2) * 560 },
      params,
      data,
    };
  }, LOCAL_ORIGIN);
  void ensureMobileEngine();
  return id;
}

/** Count of cables touching a node (the remove-sheet "N cables" copy). */
export function edgeCountFor(nodeId: string): number {
  let n = 0;
  for (const edge of Object.values(patch.edges)) {
    if (!edge) continue;
    if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) n++;
  }
  return n;
}

/** Delete a node + every edge touching it in ONE transact. Refuses
 *  `def.undeletable` (TIMELORDE). Returns true when deleted. */
export function deleteNode(nodeId: string): boolean {
  const target = patch.nodes[nodeId];
  if (target) {
    const def = resolveAnyDef(target.type) as { undeletable?: boolean } | undefined;
    if (def?.undeletable) return false;
  }
  ydoc.transact(() => {
    for (const [eid, edge] of Object.entries(patch.edges)) {
      if (!edge) continue;
      if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) {
        delete patch.edges[eid];
      }
    }
    delete patch.nodes[nodeId];
  }, LOCAL_ORIGIN);
  return true;
}

/** Disconnect every cable touching a node (keep the node) in ONE transact. */
export function unpatchNode(nodeId: string): void {
  ydoc.transact(() => {
    for (const [eid, edge] of Object.entries(patch.edges)) {
      if (!edge) continue;
      if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) {
        delete patch.edges[eid];
      }
    }
  }, LOCAL_ORIGIN);
}

/** Instance count for a type (the AddModuleSheet "4/4" disabled copy). */
export function typeCount(type: string): number {
  return instanceCount(patch.nodes, type);
}

/** Would spawning one more `type` exceed its cap? */
export function typeAtCap(type: string): boolean {
  const { def } = lookupDefWithDomain(type);
  return def?.maxInstances !== undefined && wouldExceedCap(patch.nodes, def);
}

// ---------------- Session envelope autosave (localStorage) ----------------
//
// iOS evicts background tabs and the mobile doc is memory-only (scratch
// store, no relay) — so we silently snapshot the whole doc as a
// PatchEnvelope on visibilitychange and offer "restore last session" on the
// start card. ~20 lines over makeEnvelope/loadEnvelopeIntoStore (spec §6).

export const MOBILE_SESSION_KEY = 'pt.mobile.synth.session';

/** Snapshot the current doc into localStorage. No-op on an empty rack (a
 *  blank autosave would clobber a useful previous session). */
export function saveMobileSession(): void {
  try {
    if (Object.keys(patch.nodes).length === 0) return;
    localStorage.setItem(MOBILE_SESSION_KEY, serializeEnvelope(makeEnvelope(ydoc)));
  } catch {
    /* quota / private mode — autosave is best-effort */
  }
}

/** True when a restorable session envelope exists. */
export function hasMobileSession(): boolean {
  try {
    return localStorage.getItem(MOBILE_SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

/** Load the saved envelope into the live store. Returns true on success. */
export function restoreMobileSession(): boolean {
  try {
    const raw = localStorage.getItem(MOBILE_SESSION_KEY);
    if (!raw) return false;
    const env = parseEnvelope(raw);
    loadEnvelopeIntoStore(env, ydoc, patch as unknown as LivePatch);
    return true;
  } catch (err) {
    console.warn('[mobile-host] session restore failed:', err);
    return false;
  }
}

// ---------------- Dev/e2e test hooks ----------------

/**
 * Expose the same window globals the Canvas exposes (`__patch`, `__ydoc`,
 * `__engine`, `__ensureEngine`) so the mobile e2e specs can read the live
 * graph + assert audible RMS at AUDIO OUT's terminal tap. Gated on
 * testHooksEnabled() — stripped from prod builds, re-enabled on autotest/
 * preview tiers via VITE_E2E_HOOKS=1.
 */
export function installMobileTestHooks(): void {
  if (!testHooksEnabled()) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  g.__patch = patch;
  g.__ydoc = ydoc;
  g.__engine = () => engine;
  g.__ensureEngine = () => ensureMobileEngine();
  g.__undoManager = undoManager;
}

/** Convenience for views: read a node's live param with ParamDef fallback. */
export function readParamValue(node: ModuleNode | undefined, paramId: string): number {
  if (!node) return 0;
  const live = node.params?.[paramId];
  if (typeof live === 'number') return live;
  const def = resolveAnyDef(node.type) as
    | { params?: readonly { id: string; defaultValue: number }[] }
    | undefined;
  return def?.params?.find((p) => p.id === paramId)?.defaultValue ?? 0;
}
