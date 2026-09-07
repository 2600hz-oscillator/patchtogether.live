// packages/web/src/lib/graph/device-slot-bindings.ts
//
// THE PER-MACHINE RIG STORE — device bindings that must NEVER ride the Y.Doc.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// A slot's device binding (which camera, which monitor), the master audio sink,
// and the operator's MIDI/ES-9/PTZ picks are properties of the RIG, not the
// patch. Device ids are machine-local and meaningless elsewhere, so they must
// not ride the envelope or the shared doc: a saved patch opened on another
// machine would carry a stranger's hardware, and in collab each peer would
// fight over the other's cameras (the #2045 class). The spec is explicit —
// `plan.md:85-86`: "config store (electron-store JSON): slot↔device bindings,
// display map, helper prefs — NEVER the Y.Doc"; `build-brief.md:381`: "bindings
// applied at boot; relaunch restores everything." `device-slots.ts:55-57`
// already strips `DEVICE_SLOT_RIG_KEYS` off `node.data` on the way in and out
// and names THIS file as where the binding actually lives — it just never
// existed until now.
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────
// One per-machine record, keyed on the stable slot vocabulary (`cam1..cam4`,
// `output1..output4`) plus the singleton rig roles (`audioOut`, `es9`, `push`,
// `launchpad`, `ptz`). Two backends behind one interface: the native shell
// persists in electron-store (via the `bindings.*` bridge ops); the browser
// falls back to `localStorage`. Reads are SYNCHRONOUS against an in-memory
// cache so the Canvas graph sync effect can consult a binding on a render tick;
// hydration and persistence are async. `whenReady()` resolves after the first
// load, and `subscribe()` fires whenever the record changes — locally or from
// another tab / shell window — so a re-apply pass (`runDeviceRestore`) can run
// again once a late shell load lands.
//
// PURE-ish: no Svelte, no Yjs. Only a type import from screen-identity and the
// slot-name constants from device-slots, so the schema is unit-testable against
// plain fixtures. The impure part — window/localStorage/ptNative — is confined
// to the two backends and probed defensively (the same discipline as
// platform/native.ts, whose vitest runs under a partial `window`).

import type { ScreenDescriptor } from '$lib/ui/modules/screen-identity';
import {
  CAMERA_SLOT_NAMES,
  OUTPUT_SLOT_NAMES,
  type CameraSlotName,
  type OutputSlotName,
} from './device-slots';

// ── Binding shapes, one per device class ────────────────────────────────────

/** A camera slot's device pick. Mirrors the old `node.data` rig keys 1:1. */
export interface CameraBinding {
  deviceId: string;
  deviceLabel?: string;
}

/** An output slot's physical display. Fingerprint, not an id — the web platform
 *  exposes no persistent per-monitor id (see screen-identity.ts). */
export interface OutputBinding {
  screen: ScreenDescriptor;
}

/** The master audio sink (the pinned audioOut's `setSinkId` device). */
export interface AudioOutBinding {
  outputDeviceId: string;
}

export type LaunchpadMode = 'tetris' | 'launchcontrol' | 'out-to-launch';

/** A Launchpad pick plus how the operator is driving it. */
export interface LaunchpadBinding {
  deviceId: string;
  mode: LaunchpadMode;
}

export interface Push2Binding {
  deviceId: string;
}

/** ES-9 config. Kept loose here; Part-3's pre-flight refines the fields (e.g.
 *  the output-mode push policy, es9OutputModePush). */
export interface Es9Binding {
  pushPolicy?: string;
}

export interface PtzBinding {
  deviceId: string;
}

/** The full per-machine record. Every field optional — an unbound rig is the
 *  empty object, and the failure mode of a missing field is "device unbound",
 *  never a crash. */
export interface RigBindings {
  cameras: Partial<Record<CameraSlotName, CameraBinding>>;
  outputs: Partial<Record<OutputSlotName, OutputBinding>>;
  audioOut?: AudioOutBinding;
  es9?: Es9Binding;
  push?: Push2Binding;
  launchpad?: LaunchpadBinding;
  ptz?: PtzBinding;
}

/** A fresh, fully-unbound rig. */
export function emptyRigBindings(): RigBindings {
  return { cameras: {}, outputs: {} };
}

/** Coerce arbitrary loaded JSON into a well-formed record. A localStorage blob
 *  or a shell payload can be stale, partial, or hand-edited; every read starts
 *  here so the rest of the module can trust the shape. */
export function normalizeRigBindings(raw: unknown): RigBindings {
  const out = emptyRigBindings();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.cameras && typeof r.cameras === 'object') {
    for (const slot of CAMERA_SLOT_NAMES) {
      const b = (r.cameras as Record<string, unknown>)[slot];
      if (b && typeof b === 'object' && typeof (b as CameraBinding).deviceId === 'string') {
        const cb = b as CameraBinding;
        out.cameras[slot] = { deviceId: cb.deviceId, deviceLabel: cb.deviceLabel };
      }
    }
  }
  if (r.outputs && typeof r.outputs === 'object') {
    for (const slot of OUTPUT_SLOT_NAMES) {
      const b = (r.outputs as Record<string, unknown>)[slot];
      if (b && typeof b === 'object' && isScreenDescriptor((b as OutputBinding).screen)) {
        out.outputs[slot] = { screen: (b as OutputBinding).screen };
      }
    }
  }
  if (r.audioOut && typeof (r.audioOut as AudioOutBinding).outputDeviceId === 'string') {
    out.audioOut = { outputDeviceId: (r.audioOut as AudioOutBinding).outputDeviceId };
  }
  if (r.push && typeof (r.push as Push2Binding).deviceId === 'string') {
    out.push = { deviceId: (r.push as Push2Binding).deviceId };
  }
  if (r.launchpad && typeof (r.launchpad as LaunchpadBinding).deviceId === 'string') {
    const lp = r.launchpad as LaunchpadBinding;
    const mode: LaunchpadMode =
      lp.mode === 'launchcontrol' || lp.mode === 'out-to-launch' ? lp.mode : 'tetris';
    out.launchpad = { deviceId: lp.deviceId, mode };
  }
  if (r.ptz && typeof (r.ptz as PtzBinding).deviceId === 'string') {
    out.ptz = { deviceId: (r.ptz as PtzBinding).deviceId };
  }
  if (r.es9 && typeof r.es9 === 'object') {
    const pushPolicy = (r.es9 as Es9Binding).pushPolicy;
    out.es9 = typeof pushPolicy === 'string' ? { pushPolicy } : {};
  }
  return out;
}

function isScreenDescriptor(v: unknown): v is ScreenDescriptor {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.label === 'string' &&
    typeof d.isInternal === 'boolean' &&
    typeof d.width === 'number' &&
    typeof d.height === 'number' &&
    typeof d.dpr === 'number' &&
    typeof d.left === 'number' &&
    typeof d.top === 'number'
  );
}

// ── Backend interface + implementations ─────────────────────────────────────

/** Where the record physically lives. `load` may be async (the shell round-trips
 *  to main); the store serves synchronous reads from its own cache regardless. */
export interface RigStoreBackend {
  load(): RigBindings | Promise<RigBindings>;
  save(bindings: RigBindings): void | Promise<void>;
  /** Fire on an EXTERNAL change (another tab, another shell window). Returns an
   *  unsubscribe. Never fires for this store's own `save`. */
  subscribe(onExternal: (bindings: RigBindings) => void): () => void;
}

const LS_KEY = 'pt:rig-bindings:v1';

/** Browser backend: localStorage, cross-tab via the `storage` event. Every
 *  access guarded — private-mode and partial-window test envs both throw. */
export function localStorageBackend(): RigStoreBackend {
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(LS_KEY);
        return raw ? normalizeRigBindings(JSON.parse(raw)) : emptyRigBindings();
      } catch {
        return emptyRigBindings();
      }
    },
    save(bindings) {
      try {
        globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(bindings));
      } catch {
        /* private mode / quota — the in-memory cache still holds the value */
      }
    },
    subscribe(onExternal) {
      const handler = (e: StorageEvent): void => {
        if (e.key !== LS_KEY) return;
        try {
          onExternal(normalizeRigBindings(e.newValue ? JSON.parse(e.newValue) : null));
        } catch {
          /* ignore a malformed cross-tab write */
        }
      };
      try {
        globalThis.addEventListener?.('storage', handler as EventListener);
      } catch {
        return () => {};
      }
      return () => {
        try {
          globalThis.removeEventListener?.('storage', handler as EventListener);
        } catch {
          /* nothing to remove */
        }
      };
    },
  };
}

/** The slice of the preload bridge this backend uses. Structural, so the web
 *  build never imports the shell's types (same discipline as platform/native). */
interface RigBridgeLike {
  command?: (op: string, payload?: unknown) => Promise<unknown>;
  onEvent?: (topic: string, cb: (payload: unknown) => void) => () => void;
}

/** Shell backend: the `bindings.*` bridge ops (persisted in electron-store on
 *  the main side). `command` resolves the PtResult envelope rather than throwing
 *  (preload.ts), so we read `ok`/`result` defensively. */
export function bridgeBackend(bridge: RigBridgeLike): RigStoreBackend {
  const unwrap = (envelope: unknown): RigBindings => {
    const e = envelope as { ok?: boolean; result?: unknown } | undefined;
    return normalizeRigBindings(e && e.ok ? e.result : null);
  };
  return {
    async load() {
      try {
        return unwrap(await bridge.command?.('bindings.get'));
      } catch {
        return emptyRigBindings();
      }
    },
    async save(bindings) {
      try {
        await bridge.command?.('bindings.set', bindings);
      } catch {
        /* the in-memory cache still holds the value; next save retries */
      }
    },
    subscribe(onExternal) {
      try {
        return (
          bridge.onEvent?.('bindings.changed', (payload) =>
            onExternal(normalizeRigBindings(payload)),
          ) ?? (() => {})
        );
      } catch {
        return () => {};
      }
    },
  };
}

// ── The store ───────────────────────────────────────────────────────────────

/** Synchronous-read, async-persist store over one backend. */
export class RigBindingStore {
  private cache: RigBindings = emptyRigBindings();
  private readonly ready: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly unsubBackend: () => void;

  constructor(private readonly backend: RigStoreBackend) {
    this.ready = Promise.resolve(backend.load()).then((b) => {
      this.cache = normalizeRigBindings(b);
      this.emit();
    });
    this.unsubBackend = backend.subscribe((b) => {
      this.cache = normalizeRigBindings(b);
      this.emit();
    });
  }

  /** Resolves after the first backend load — a shell load is a round-trip. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** The current record. Reference changes on every mutation. */
  snapshot(): RigBindings {
    return this.cache;
  }

  getCamera(slot: CameraSlotName): CameraBinding | null {
    return this.cache.cameras[slot] ?? null;
  }
  getOutput(slot: OutputSlotName): OutputBinding | null {
    return this.cache.outputs[slot] ?? null;
  }
  getAudioOut(): AudioOutBinding | null {
    return this.cache.audioOut ?? null;
  }
  getPush(): Push2Binding | null {
    return this.cache.push ?? null;
  }
  getLaunchpad(): LaunchpadBinding | null {
    return this.cache.launchpad ?? null;
  }
  getEs9(): Es9Binding | null {
    return this.cache.es9 ?? null;
  }
  getPtz(): PtzBinding | null {
    return this.cache.ptz ?? null;
  }

  setCamera(slot: CameraSlotName, binding: CameraBinding | null): void {
    this.mutate((c) => {
      if (binding) c.cameras[slot] = binding;
      else delete c.cameras[slot];
    });
  }
  setOutput(slot: OutputSlotName, binding: OutputBinding | null): void {
    this.mutate((c) => {
      if (binding) c.outputs[slot] = binding;
      else delete c.outputs[slot];
    });
  }
  setAudioOut(binding: AudioOutBinding | null): void {
    this.mutate((c) => {
      if (binding) c.audioOut = binding;
      else delete c.audioOut;
    });
  }
  setPush(binding: Push2Binding | null): void {
    this.mutate((c) => {
      if (binding) c.push = binding;
      else delete c.push;
    });
  }
  setLaunchpad(binding: LaunchpadBinding | null): void {
    this.mutate((c) => {
      if (binding) c.launchpad = binding;
      else delete c.launchpad;
    });
  }
  setEs9(binding: Es9Binding | null): void {
    this.mutate((c) => {
      if (binding) c.es9 = binding;
      else delete c.es9;
    });
  }
  setPtz(binding: PtzBinding | null): void {
    this.mutate((c) => {
      if (binding) c.ptz = binding;
      else delete c.ptz;
    });
  }

  /** Fire `cb` on any change — local mutation or external. Returns unsubscribe.
   *  Not called for the initial state; call a getter first if you need it. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Tear down the backend subscription (tests / teardown). */
  dispose(): void {
    this.unsubBackend();
    this.listeners.clear();
  }

  private mutate(fn: (c: RigBindings) => void): void {
    const next = cloneRig(this.cache);
    fn(next);
    this.cache = next;
    this.emit();
    void this.backend.save(next);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function cloneRig(b: RigBindings): RigBindings {
  return {
    cameras: { ...b.cameras },
    outputs: { ...b.outputs },
    audioOut: b.audioOut ? { ...b.audioOut } : undefined,
    es9: b.es9 ? { ...b.es9 } : undefined,
    push: b.push ? { ...b.push } : undefined,
    launchpad: b.launchpad ? { ...b.launchpad } : undefined,
    ptz: b.ptz ? { ...b.ptz } : undefined,
  };
}

// ── Default singleton (the app's one store) ─────────────────────────────────

/** Pick the backend for the current platform. Shell → bridge; browser →
 *  localStorage; a headless/SSR context with neither → an in-memory no-op so an
 *  import never throws. */
export function createDefaultRigBackend(): RigStoreBackend {
  try {
    const host = globalThis as unknown as { ptNative?: RigBridgeLike & { nativeAvailable?: () => boolean } };
    const bridge = host.ptNative;
    if (bridge && typeof bridge.nativeAvailable === 'function' && bridge.nativeAvailable() === true) {
      return bridgeBackend(bridge);
    }
  } catch {
    /* fall through to localStorage */
  }
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return localStorageBackend();
  }
  return {
    load: () => emptyRigBindings(),
    save: () => {},
    subscribe: () => () => {},
  };
}

let singleton: RigBindingStore | null = null;

/** The app's rig store. Lazily created so an SSR import doesn't touch a backend. */
export function rigBindings(): RigBindingStore {
  if (!singleton) singleton = new RigBindingStore(createDefaultRigBackend());
  return singleton;
}

/** Replace the singleton with a store over an injected backend (tests / e2e).
 *  Pass `null` to drop it so the next `rigBindings()` rebuilds from the real
 *  backend. */
export function setRigBindingsForTests(store: RigBindingStore | null): void {
  singleton?.dispose();
  singleton = store;
}
