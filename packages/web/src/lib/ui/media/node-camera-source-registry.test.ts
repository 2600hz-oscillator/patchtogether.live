// packages/web/src/lib/ui/media/node-camera-source-registry.test.ts
//
// The node-owned CAMERA capture lifecycle (legacy-removal S1), driven against
// fakes.
//
// Same premise as `./node-loopback-source-registry.test.ts`: the defect class is
// "the source exists only because a card is mounted", so every leg runs with NO
// card anywhere — there is no component in this file — and asserts the camera
// works regardless. A leg that needed a mount would be re-testing the bug.
//
// ⚠ WHAT IS DIFFERENT HERE, AND WHY MOST OF THIS FILE IS ABOUT REFUSING TO
// ACQUIRE. `getUserMedia` succeeds without a gesture once the origin holds
// permission, so unlike loopback this controller CAN acquire on its own — which
// means the interesting assertions are the ones about when it must NOT. Every
// guard below cost a real bug on the card this replaces:
//
//   * acquiring with no visible labels raises a PERMISSION PROMPT, and a rack
//     LOAD must never raise one;
//   * an exact-`deviceId` request for a camera that is gone only ever
//     OverconstrainedErrors, so it must not be made;
//   * "nothing saved" is NOT "not found" — collapsing them left every FRESH
//     camera stuck at `no-cameras-found` having never called getUserMedia;
//   * `enabled` defaults to 1, so acting on the FIRST observation of it would
//     fire getUserMedia for every camera node the moment it appeared, bypassing
//     all three guards above.
//
// ⚠ AND ONE BEHAVIOUR CHANGE IS ASSERTED RATHER THAN ASSUMED: the awareness
// badge follows the STREAM. The card added it on stream start and removed it in
// `onDestroy`, so it described "a card is on screen" while claiming to describe
// "a camera is live". Both directions are pinned below.

import { describe, it, expect } from 'vitest';
import type { ModuleNode } from '$lib/graph/types';
import {
  createNodeCameraSourceRegistry,
  CAMERA_SOURCE_SLOT,
  NO_CAMERA_SOURCE,
  NODE_CAMERA_SOURCE_TYPES,
  RETRY_ATTEMPTS,
  RETRY_INTERVAL_MS,
  type CameraDeviceEntry,
  type CameraSourceDeps,
  type CameraSourceStatus,
} from './node-camera-source-registry';

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

function node(id: string, type = 'cameraInput'): ModuleNode {
  return { id, type, domain: 'video', position: { x: 0, y: 0 }, params: {} } as unknown as ModuleNode;
}

interface FakeTrack {
  live: boolean;
  listeners: Set<() => void>;
  deviceId: string | null;
}

function makeStream(deviceId: string | null = null) {
  const track: FakeTrack = { live: true, listeners: new Set(), deviceId };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [{ stop: () => { track.live = false; } }],
  } as unknown as MediaStream;
  return { stream, track, endFromDevice: () => { for (const f of [...track.listeners]) f(); } };
}

function makeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    clock: {
      setInterval: (fn: () => void, ms: number) => { timers.set(next, { fn, ms }); return next++; },
      clearInterval: (h: unknown) => { timers.delete(h as number); },
    },
    tick(ms: number, times = 1): void {
      for (let i = 0; i < times; i++) for (const t of [...timers.values()]) if (t.ms === ms) t.fn();
    },
    live: () => timers.size,
  };
}

type El = { id: string; stream: MediaStream | null; played: number };

interface Harness {
  deps: CameraSourceDeps<El>;
  attached: Map<string, unknown>;
  statuses: Array<{ nodeId: string; status: CameraSourceStatus }>;
  elements: Map<string, El>;
  streams: Map<string, MediaStream | null>;
  /** Node ids currently advertising a live camera to rack-mates. */
  presence: Set<string>;
  /** Every graph write of the two device keys, in order. */
  writes: Array<{ nodeId: string; deviceId: string | null; label: string | null }>;
  savedId: Map<string, string | null>;
  savedLabel: Map<string, string | null>;
  enabled: Map<string, boolean>;
  clock: ReturnType<typeof makeClock>;
  setDevices(d: CameraDeviceEntry[]): void;
  setResult(r: {
    stream: MediaStream | null;
    error: { name: string; message: string } | null;
    usedBareRetry?: boolean;
  }): void;
  setSupported(v: boolean): void;
  setEngineMaterialized(v: boolean): void;
  acquireCalls(): number;
  acquireTargets(): Array<string | null>;
  acquireWasSynchronous(): boolean;
  settle(): Promise<void>;
}

function makeHarness(): Harness {
  const attached = new Map<string, unknown>();
  const statuses: Array<{ nodeId: string; status: CameraSourceStatus }> = [];
  const elements = new Map<string, El>();
  const streams = new Map<string, MediaStream | null>();
  const presence = new Set<string>();
  const writes: Array<{ nodeId: string; deviceId: string | null; label: string | null }> = [];
  const savedId = new Map<string, string | null>();
  const savedLabel = new Map<string, string | null>();
  const enabled = new Map<string, boolean>();
  const clock = makeClock();

  let devices: CameraDeviceEntry[] = [];
  let supported = true;
  let materialized = true;
  let result: {
    stream: MediaStream | null;
    error: { name: string; message: string } | null;
    usedBareRetry: boolean;
  } = { stream: null, error: null, usedBareRetry: false };
  let calls = 0;
  const targets: Array<string | null> = [];
  let syncFlag = false;
  let gateOpened = false;

  const deps: CameraSourceDeps<El> = {
    engine: null,
    media: {
      ensure: (nodeId) => {
        let el = elements.get(nodeId);
        if (!el) { el = { id: nodeId, stream: null, played: 0 }; elements.set(nodeId, el); }
        return el;
      },
      setStream: (nodeId, _slot, s) => {
        const prev = streams.get(nodeId);
        if (prev && prev !== s) prev.getTracks().forEach((t) => t.stop());
        streams.set(nodeId, s);
      },
      stream: (nodeId) => streams.get(nodeId) ?? null,
    },
    el: {
      setStream: (el, s) => { el.stream = s; },
      play: (el) => { el.played++; },
    },
    capture: {
      supported: () => supported,
      enumerate: async () => devices,
      acquire: async (deviceId) => {
        calls++;
        targets.push(deviceId);
        syncFlag = !gateOpened;
        return result;
      },
      chosenDeviceId: (stream) =>
        (stream as unknown as { getVideoTracks(): FakeTrack[] }).getVideoTracks()[0]?.deviceId ?? null,
      onEnded: (stream, fn) => {
        const t = (stream as unknown as { getVideoTracks(): FakeTrack[] }).getVideoTracks()[0];
        t?.listeners.add(fn);
        return () => t?.listeners.delete(fn);
      },
    },
    doc: {
      savedDeviceId: (nodeId) => savedId.get(nodeId) ?? null,
      savedDeviceLabel: (nodeId) => savedLabel.get(nodeId) ?? null,
      writeSavedDevice: (nodeId, deviceId, label) => {
        writes.push({ nodeId, deviceId, label });
        savedId.set(nodeId, deviceId);
        // Mirror the "never clear a good label" rule the real doc op implements,
        // so a test can see it working rather than only see the call.
        if (label) savedLabel.set(nodeId, label);
        if (deviceId === null) savedLabel.set(nodeId, null);
      },
      enabled: (nodeId) => enabled.get(nodeId) ?? true,
    },
    presence: {
      add: (nodeId) => { presence.add(nodeId); },
      remove: (nodeId) => { presence.delete(nodeId); },
    },
    clock: clock.clock,
    onStatus: (nodeId, status) => { statuses.push({ nodeId, status }); },
  };

  deps.engine = {
    attach: (nodeId, el) => {
      if (!materialized) return;
      if (el === null) attached.delete(nodeId);
      else attached.set(nodeId, el);
    },
    hasElement: (nodeId) => attached.get(nodeId) != null,
  };

  return {
    deps,
    attached,
    statuses,
    elements,
    streams,
    presence,
    writes,
    savedId,
    savedLabel,
    enabled,
    clock,
    setDevices: (d) => { devices = d; },
    setResult: (r) => { result = { usedBareRetry: false, ...r }; },
    setSupported: (v) => { supported = v; },
    setEngineMaterialized: (v) => { materialized = v; },
    acquireCalls: () => calls,
    acquireTargets: () => targets,
    acquireWasSynchronous: () => syncFlag,
    async settle() {
      gateOpened = true;
      for (let i = 0; i < 8; i++) await Promise.resolve();
      gateOpened = false;
    },
  };
}

const CAM_A: CameraDeviceEntry = { deviceId: 'dev-a', label: 'Studio Cam' };
const CAM_B: CameraDeviceEntry = { deviceId: 'dev-b', label: 'Laptop Cam' };
/** Labels redacted — what `enumerateDevices()` returns BEFORE permission. */
const CAM_REDACTED: CameraDeviceEntry = { deviceId: 'dev-a', label: '' };

function build(h: Harness) {
  return createNodeCameraSourceRegistry(h.deps);
}

// ---------------------------------------------------------------------------

describe('NODE_CAMERA_SOURCE_TYPES', () => {
  it('names cameraInput and nothing else', () => {
    expect([...NODE_CAMERA_SOURCE_TYPES].sort()).toEqual(['cameraInput']);
  });

  it('VACUITY: non-empty, so every disjointness check that reads it means something', () => {
    expect(NODE_CAMERA_SOURCE_TYPES.size).toBeGreaterThan(0);
  });
});

describe('sync — controllers live and die with the GRAPH', () => {
  it('creates a controller per camera node and ignores every other type', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b'), node('c', 'loopback'), node('d', 'acidwarp')], h.deps.engine);
    await h.settle();
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(true);
    expect(r.has('c')).toBe(false);
    expect(r.has('d')).toBe(false);
  });

  it('ensures the node-owned element with NO host — the whole point of the move', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.elements.get('a')).toBeTruthy();
  });

  it('a node leaving the graph disposes its controller; view() falls back to the null status', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    r.sync([], h.deps.engine);
    expect(r.has('a')).toBe(false);
    expect(r.view('a')).toEqual(NO_CAMERA_SOURCE);
  });
});

describe('the bootstrap guards — every one of them cost a bug', () => {
  it('NO CAMERAS: reports it and never calls getUserMedia', async () => {
    const h = makeHarness();
    h.setDevices([]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('no-cameras-found');
    expect(h.acquireCalls()).toBe(0);
  });

  it('NO LABELS YET: does NOT acquire — a rack load must never raise a permission prompt', async () => {
    // ⚠ THE LEG THAT PROTECTS EVERY PATCH LOAD. Redacted labels mean this origin
    // has not been granted camera permission; acquiring here would put a browser
    // prompt in front of someone who merely opened a rack.
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
    expect(r.view('a').state).toBe('idle');
    expect(r.view('a').hasDeviceLabels).toBe(false);
    expect(r.view('a').deviceCount).toBe(1);
  });

  it('DISABLED: does not acquire even with labels visible', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    h.enabled.set('a', false);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
  });

  it('SAVED CAMERA GONE: reports it rather than making a doomed exact-id request', async () => {
    const h = makeHarness();
    h.setDevices([CAM_B]);
    h.savedId.set('a', 'dev-vanished');
    h.savedLabel.set('a', 'Some Other Cam');
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('no-cameras-found');
    expect(r.view('a').errorMsg).toMatch(/Saved camera not found/);
    expect(h.acquireCalls()).toBe(0);
  });

  it('⚠ NOTHING SAVED IS NOT NOT-FOUND: a FRESH camera acquires UNCONSTRAINED', async () => {
    // ⚠ THE REGRESSION THAT SHIPPED ONCE AND CI CAUGHT. Routing "no saved
    // device" into the failure branch left every freshly-spawned camera stuck at
    // `no-cameras-found` having never called getUserMedia at all — while every
    // other assertion stayed green, because the state it reported is a real one.
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.acquireCalls()).toBe(1);
    expect(h.acquireTargets()).toEqual([null]);
    expect(r.view('a').state).toBe('streaming');
  });

  it('⚠ AN UNBOUND DEVICE SLOT IS DARK: a reserved id with nothing saved never reaches getUserMedia', async () => {
    // The complement of the FRESH-camera fall-through above, carried over from
    // the card's acquire path when it moved here (graph/device-slots.ts:
    // "unbound slot = dark module"). A reserved slot exists in every rack
    // whether or not anyone asked, so the unconstrained default-camera request
    // that is RIGHT for a just-added camera would be a camera light at every
    // rack boot here. Same world as the fresh-camera case — labels visible,
    // enabled, a stream on offer — so a regression cannot hide behind a guard
    // earlier in bootstrap.
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('slot:cam1')], h.deps.engine);
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
    expect(r.view('slot:cam1').state).toBe('idle');
  });

  it('a BOUND device slot acquires like any camera — the guard keys on "nothing saved", never the id alone', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    h.savedId.set('slot:cam1', 'dev-a');
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('slot:cam1')], h.deps.engine);
    await h.settle();
    expect(h.acquireTargets()).toEqual(['dev-a']);
    expect(r.view('slot:cam1').state).toBe('streaming');
  });

  it('a saved id that RESOLVES acquires against it and mints no rebind notice', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A, CAM_B]);
    h.savedId.set('a', 'dev-b');
    const s = makeStream('dev-b');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.acquireTargets()).toEqual(['dev-b']);
    expect(r.view('a').rebindNotice).toBeNull();
  });

  it('a saved id that is GONE but whose NAME matches rebinds, says so, and self-heals', async () => {
    // ⚠ NEVER RE-POINT A PATCH SILENTLY. deviceIds are per-origin hashes that do
    // not survive a reboot / re-plug / cleared site data, so the remembered NAME
    // is the only thing left that identifies the hardware. Binding by it is
    // right; doing so without saying is how "why is this the wrong camera"
    // becomes a mystery weeks later.
    const h = makeHarness();
    h.setDevices([{ deviceId: 'dev-new', label: 'Studio Cam' }]);
    h.savedId.set('a', 'dev-stale');
    h.savedLabel.set('a', 'Studio Cam');
    const s = makeStream('dev-new');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').rebindNotice).toMatch(/Reconnected to "Studio Cam" by name/);
    expect(r.view('a').selectedDeviceId).toBe('dev-new');
    // Self-healing: THIS session's id is persisted so the fallback is not paid twice.
    expect(h.savedId.get('a')).toBe('dev-new');
    expect(h.acquireTargets()).toEqual(['dev-new']);
  });
});

describe('the acquire outcomes', () => {
  async function acquireWith(err: { name: string; message: string }) {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    h.setResult({ stream: null, error: err });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    return r.view('a');
  }

  it('NotAllowedError → permission-denied, with settings guidance', async () => {
    const v = await acquireWith({ name: 'NotAllowedError', message: 'x' });
    expect(v.state).toBe('permission-denied');
    expect(v.errorMsg).toMatch(/site settings/i);
  });

  it('OverconstrainedError → no-cameras-found', async () => {
    const v = await acquireWith({ name: 'OverconstrainedError', message: 'x' });
    expect(v.state).toBe('no-cameras-found');
  });

  it('NotReadableError → device-in-use, and the text names BOTH causes', async () => {
    // The name is ambiguous — another app holding the device OR a driver failing
    // to start the source. "In use" alone sends people hunting for an app that
    // may not exist, which is why the text says both.
    const v = await acquireWith({ name: 'NotReadableError', message: 'x' });
    expect(v.state).toBe('device-in-use');
    expect(v.errorMsg).toMatch(/busy or failed to start/i);
    expect(v.errorMsg).toMatch(/live input signal/i);
  });

  it('an unrecognised failure surfaces name + message rather than a generic string', async () => {
    const v = await acquireWith({ name: 'AbortError', message: 'gone' });
    expect(v.state).toBe('error');
    expect(v.errorMsg).toBe('AbortError: gone');
  });

  it('a granted stream attaches, plays, and records the device the browser CHOSE', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-actual');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('streaming');
    expect(h.elements.get('a')!.stream).toBe(s.stream);
    expect(h.elements.get('a')!.played).toBe(1);
    expect(h.attached.get('a')).toBe(h.elements.get('a'));
    // The browser may hand back a different camera than asked for.
    expect(h.savedId.get('a')).toBe('dev-actual');
  });

  it('an acquire request reaches getUserMedia SYNCHRONOUSLY — the first-visit prompt depends on it', async () => {
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]); // no labels ⇒ bootstrap does not acquire
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
    r.request('a', { kind: 'acquire' });
    expect(h.acquireCalls()).toBe(1);
    expect(h.acquireWasSynchronous()).toBe(true);
    await h.settle();
  });

  it('a node deleted WHILE the prompt is open stops the stream it was handed', async () => {
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    r.request('a', { kind: 'acquire' });
    r.sync([], h.deps.engine);
    await h.settle();
    expect(s.track.live).toBe(false);
  });
});

describe('the `enabled` param OWNS the hardware', () => {
  it('SKIP-FIRST: the first sync records the value and does NOT act on it', async () => {
    // ⚠ WITHOUT THIS, `enabled`'s default of 1 fires getUserMedia for every
    // camera node the moment it appears, bypassing every bootstrap guard above —
    // including the one that stops a rack load raising a permission prompt.
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    r.sync([node('a')], h.deps.engine); // second sync, value unchanged
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
  });

  it('turning it OFF frees the hardware, not just a shader branch', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('streaming');
    r.sync([node('a')], h.deps.engine); // records enabled=true
    h.enabled.set('a', false);
    r.sync([node('a')], h.deps.engine);
    expect(r.view('a').state).toBe('paused');
    expect(s.track.live).toBe(false);
    expect(h.attached.has('a')).toBe(false);
  });

  it('turning it back ON re-acquires', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const first = makeStream('dev-a');
    h.setResult({ stream: first.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    r.sync([node('a')], h.deps.engine);
    h.enabled.set('a', false);
    r.sync([node('a')], h.deps.engine);
    const second = makeStream('dev-a');
    h.setResult({ stream: second.stream, error: null });
    h.enabled.set('a', true);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('streaming');
    expect(h.streams.get('a')).toBe(second.stream);
  });
});

describe('an EXTERNAL device pick lands — the card hydrated once and never looked again', () => {
  it('a saved id changed by a PEER re-acquires against it', async () => {
    // ⚠ THE LIVE CASE IS COLLABORATION. `deviceId` is in Yjs, so a rack-mate's
    // pick already arrived — and used to sit in the document doing nothing until
    // a remount, because the card hydrated it once in `onMount`.
    const h = makeHarness();
    h.setDevices([CAM_A, CAM_B]);
    const first = makeStream('dev-a');
    h.setResult({ stream: first.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    const second = makeStream('dev-b');
    h.setResult({ stream: second.stream, error: null });
    h.savedId.set('a', 'dev-b'); // a peer's write
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').selectedDeviceId).toBe('dev-b');
    expect(h.acquireTargets().at(-1)).toBe('dev-b');
  });

  it('an UNCHANGED saved id does not re-acquire — the guard against a sync loop', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    const before = h.acquireCalls();
    r.sync([node('a')], h.deps.engine);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.acquireCalls()).toBe(before);
  });

  it('a LOCAL pick command saves, clears any rebind notice, and re-acquires', async () => {
    const h = makeHarness();
    h.setDevices([{ deviceId: 'dev-new', label: 'Studio Cam' }, CAM_B]);
    h.savedId.set('a', 'dev-stale');
    h.savedLabel.set('a', 'Studio Cam');
    const s = makeStream('dev-new');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').rebindNotice).not.toBeNull();
    const s2 = makeStream('dev-b');
    h.setResult({ stream: s2.stream, error: null });
    r.request('a', { kind: 'pick', deviceId: 'dev-b' });
    await h.settle();
    // A pick ANSWERS the notice — it must not linger over an explicit choice.
    expect(r.view('a').rebindNotice).toBeNull();
    expect(h.savedId.get('a')).toBe('dev-b');
  });
});

describe('the saved LABEL is never cleared by a redacted one', () => {
  it('a write with no resolvable label leaves the stored name intact', async () => {
    // ⚠ Before permission, `enumerateDevices()` redacts every label to ''.
    // Persisting whatever is on hand would save a name matching EVERY unlabelled
    // device on the next machine — a fallback with maximum confidence and no
    // information.
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    h.savedLabel.set('a', 'Studio Cam');
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    r.request('a', { kind: 'pick', deviceId: 'dev-a' });
    await h.settle();
    expect(h.savedLabel.get('a')).toBe('Studio Cam');
    expect(h.writes.some((w) => w.label === null)).toBe(true);
  });
});

describe('the awareness badge follows the STREAM, not a mount', () => {
  it('added when the stream starts', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.presence.has('a')).toBe(true);
  });

  it('removed when the stream stops, and when the NODE leaves the graph', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    r.request('a', { kind: 'stop' });
    expect(h.presence.has('a')).toBe(false);

    const s2 = makeStream('dev-a');
    h.setResult({ stream: s2.stream, error: null });
    r.request('a', { kind: 'acquire' });
    await h.settle();
    expect(h.presence.has('a')).toBe(true);
    r.sync([], h.deps.engine);
    expect(h.presence.has('a')).toBe(false);
  });

  it('NEGATIVE CONTROL: a node that never streams never advertises one', async () => {
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.presence.has('a')).toBe(false);
  });
});

describe('the device ENDING (unplug, revoke, sleep/wake)', () => {
  it('lands in error with recovery text and drops the badge', async () => {
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    s.endFromDevice();
    expect(r.view('a').state).toBe('error');
    expect(r.view('a').errorMsg).toMatch(/disconnected or revoked/i);
    expect(h.presence.has('a')).toBe(false);
  });
});

describe('the engine attach retry', () => {
  it('offers the element every RETRY_INTERVAL_MS and stops once the engine confirms', async () => {
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(h.attached.has('a')).toBe(false);
    h.clock.tick(RETRY_INTERVAL_MS);
    expect(h.attached.get('a')).toBe(h.elements.get('a'));
    expect(r.view('a').attached).toBe(true);
    expect(h.clock.live()).toBe(0);
  });

  it('gives up after RETRY_ATTEMPTS rather than polling for the life of the tab', async () => {
    const h = makeHarness();
    h.setDevices([CAM_REDACTED]);
    h.setEngineMaterialized(false);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    h.clock.tick(RETRY_INTERVAL_MS, RETRY_ATTEMPTS + 2);
    expect(h.clock.live()).toBe(0);
    expect(r.view('a').attached).toBe(false);
  });
});

describe('rehydration — a controller rebuilt under a LIVE stream', () => {
  it('comes back streaming and does NOT re-acquire', async () => {
    // ⚠ THE SECOND HALF IS THE LOAD-BEARING ONE. Coming back to 'idle' would
    // tell the user the camera stopped when it did not; RE-ACQUIRING would take
    // a second trip through the hardware for a stream that is already live.
    const h = makeHarness();
    h.setDevices([CAM_A]);
    const s = makeStream('dev-a');
    h.setResult({ stream: s.stream, error: null });
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    const before = h.acquireCalls();
    r.disposeNode('a');
    // `disposeNode` must NOT stop the stream — the no-view-teardown rule.
    expect(h.streams.get('a')).toBe(s.stream);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('streaming');
    expect(h.acquireCalls()).toBe(before);
    expect(h.presence.has('a')).toBe(true);
  });
});

describe('unsupported runtimes', () => {
  it('report it, arm no retry, and refuse to acquire', async () => {
    const h = makeHarness();
    h.setSupported(false);
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    await h.settle();
    expect(r.view('a').state).toBe('unsupported');
    expect(h.clock.live()).toBe(0);
    r.request('a', { kind: 'acquire' });
    await h.settle();
    expect(h.acquireCalls()).toBe(0);
  });
});

describe('the status seam', () => {
  it('publishes an INITIAL status at creation', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a')], h.deps.engine);
    expect(h.statuses[0]).toMatchObject({ nodeId: 'a', status: { state: 'idle' } });
    await h.settle();
  });

  it('request on an unknown node reports NOT delivered rather than throwing', () => {
    const h = makeHarness();
    const r = build(h);
    expect(r.request('nope', { kind: 'acquire' })).toEqual({ delivered: false, error: null });
  });

  it('snapshot lists every live controller with its status', async () => {
    const h = makeHarness();
    const r = build(h);
    r.sync([node('a'), node('b')], h.deps.engine);
    await h.settle();
    expect(r.snapshot().map((s) => s.nodeId).sort()).toEqual(['a', 'b']);
  });
});

describe('the slot is the one the surfaces adopt', () => {
  it('CAMERA_SOURCE_SLOT is the key a card/faceplate adopts', () => {
    expect(CAMERA_SOURCE_SLOT).toBe('main');
  });
});
