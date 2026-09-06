// packages/web/src/lib/ui/media/node-camera-source.svelte.ts
//
// THE REAL-DOM SINGLETON for ./node-camera-source-registry — a thin binding of
// the pure core to the browser, the graph store, the engine and the multiplayer
// awareness channel.
//
// Same split and same reason as `./node-loopback-source.svelte.ts` and
// `./node-video-source.svelte.ts`: the core must unit-test in the web package's
// `environment: 'node'` vitest, where there is no `navigator.mediaDevices`, no
// awareness provider and no `$state`. This file is the only place that names a
// browser global, and it is dependency-shaped rather than logic-shaped — a
// branch that appears here belongs in the core where a test can reach it.
//
// ⚠ IT ALSO FEEDS `camera-status-registry`, unchanged, so every camera FACE file
// (`CameraInputOutputBody`, `CameraInputTileBody`, `CameraSourceControls`) is
// untouched by this migration. What moved is who publishes and who owns the
// acquire command.

import type { ModuleNode } from '$lib/graph/types';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { PatchEngine } from '$lib/audio/engine';
import type { VideoEngine } from '$lib/video/engine';
import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import { cameraInputDef } from '$lib/video/modules/camera-input';
import { acquireCameraStream } from '$lib/ui/camera-acquire';
import { addLocalCameraNodeId, removeLocalCameraNodeId } from '$lib/multiplayer/camera-presence';
import { nodeMedia } from './node-media-registry';
import { cameraStatus, type CameraCommandLease } from './camera-status-registry';
import {
  createNodeCameraSourceRegistry,
  CAMERA_SOURCE_SLOT,
  NO_CAMERA_SOURCE,
  NODE_CAMERA_SOURCE_TYPES,
  type CameraSourceEngine,
  type CameraSourceStatus,
  type NodeCameraSourceRegistry,
} from './node-camera-source-registry';

/** Reactive published status per node. Written ONLY by the core's `onStatus`. */
const statuses = $state<Record<string, CameraSourceStatus>>({});

const commandLeases = new Map<string, CameraCommandLease>();

/**
 * The awareness provider, handed in by `Canvas.svelte` on every sync.
 *
 * ⚠ A GETTER, NOT A PROVIDER, AND THAT IS THE WHOLE REASON THIS PLUMBING EXISTS.
 * The card reached the provider through Svelte CONTEXT (`useProvider()`), which
 * a plain module cannot call — context is only readable during a component's
 * init. The context is deliberately a getter rather than a value because the
 * provider can be swapped or attached LATE (the dev-only `__provider` global the
 * @collab specs install from `+layout.svelte` is the live case), and a captured
 * value would leave presence writing into a provider that has been replaced. So
 * the getter is what crosses the boundary, and it is re-supplied on every sync
 * rather than bound once.
 */
let getProvider: () => HocuspocusProvider | null = () => null;

function adaptEngine(engine: PatchEngine | null): CameraSourceEngine | null {
  if (!engine) return null;
  function video(): VideoEngine | null {
    try {
      return engine!.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }
  return {
    attach(nodeId, el) {
      video()?.attachExternalSource(nodeId, 'video', (el as HTMLElement | null) ?? null);
    },
    hasElement(nodeId) {
      try {
        return video()?.read(nodeId, 'hasVideoElement') === true;
      } catch {
        return false;
      }
    },
  };
}

function ensureCommands(nodeId: string): void {
  if (commandLeases.has(nodeId)) return;
  commandLeases.set(
    nodeId,
    // ⚠ THE STATUS SEAM CARRIES ONE COMMAND (`acquire`) AND THE CONTROLLER TAKES
    // THREE. That is not an oversight: `stop` and `pick` are reachable today
    // through the graph (the `enabled` param and `node.data.deviceId`), which
    // the sync effect watches, so no surface needs a command for them. Widening
    // the published seam would be a second route to the same state, and the
    // camera card's own history is a catalogue of what that costs.
    cameraStatus.registerCommands(nodeId, {
      acquire: () => void registry.request(nodeId, { kind: 'acquire' }),
    }),
  );
}

function releaseCommands(nodeId: string): void {
  commandLeases.get(nodeId)?.release();
  commandLeases.delete(nodeId);
}

const registry = createNodeCameraSourceRegistry<HTMLElement>({
  engine: null,
  media: {
    ensure: (nodeId, slot) =>
      nodeMedia.ensure(nodeId, slot, {
        kind: 'video',
        init: (el) => {
          const v = el as HTMLVideoElement;
          v.playsInline = true;
          v.muted = true;
          v.autoplay = true;
          v.setAttribute('data-testid', 'camera-preview');
          // The registry keys this element by NODE, but nothing said so in the
          // DOM — every camera's element carried the same testid, parked or
          // adopted. Reflecting the key lets a spec (device-slot continuity)
          // hold the SPECIFIC node's element across a patch load and assert
          // identity, instead of fishing among identical previews.
          v.setAttribute('data-node-id', nodeId);
        },
      }),
    setStream: (nodeId, slot, stream) => nodeMedia.setStream(nodeId, slot, stream),
    stream: (nodeId, slot) => nodeMedia.stream(nodeId, slot),
  },
  el: {
    setStream: (el, stream) => {
      (el as HTMLVideoElement).srcObject = stream;
    },
    play: (el) => {
      void (el as HTMLVideoElement).play().catch((err) => {
        // play() can reject before the page has seen a user gesture. The click
        // that triggered the acquire counts as one, so this is rare; log and
        // keep going — the next interaction retries.
        console.warn('[cameraInput] video.play() rejected:', err);
      });
    },
  },
  capture: {
    supported: () =>
      typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    enumerate: async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
        return [];
      }
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        return all
          .filter((d) => d.kind === 'videoinput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      } catch (err) {
        console.warn('[cameraInput] enumerateDevices failed:', err);
        return [];
      }
    },
    acquire: async (deviceId) => {
      const r = await acquireCameraStream(
        (c) => navigator.mediaDevices.getUserMedia(c),
        deviceId,
      );
      if (!r.stream) {
        console.warn(
          '[cameraInput] acquire failed:',
          r.error?.name,
          r.error?.message,
          `(bare retry attempted: ${r.usedBareRetry})`,
        );
      }
      return {
        stream: r.stream,
        error: r.error ? { name: r.error.name, message: r.error.message } : null,
        usedBareRetry: r.usedBareRetry,
      };
    },
    chosenDeviceId: (stream) => stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? null,
    onEnded: (stream, fn) => {
      const track = stream.getVideoTracks()[0];
      if (!track) return () => {};
      track.addEventListener('ended', fn);
      return () => track.removeEventListener('ended', fn);
    },
  },
  doc: {
    savedDeviceId: (nodeId) => {
      const d = patch.nodes[nodeId]?.data;
      return d && typeof d['deviceId'] === 'string' ? (d['deviceId'] as string) : null;
    },
    savedDeviceLabel: (nodeId) => {
      const d = patch.nodes[nodeId]?.data;
      return d && typeof d['deviceLabel'] === 'string' && d['deviceLabel'] !== ''
        ? (d['deviceLabel'] as string)
        : null;
    },
    writeSavedDevice: (nodeId, deviceId, label) => {
      mutateNode(nodeId, (live) => {
        if (!live.data) live.data = {};
        if (deviceId === null) {
          delete live.data['deviceId'];
          delete live.data['deviceLabel'];
          return;
        }
        live.data['deviceId'] = deviceId;
        // Never clear a good label with a redacted one — see the core.
        if (label) live.data['deviceLabel'] = label;
      });
    },
    enabled: (nodeId) => {
      const raw = patch.nodes[nodeId]?.params?.enabled;
      const dflt = cameraInputDef.params.find((x) => x.id === 'enabled')?.defaultValue ?? 1;
      return (typeof raw === 'number' ? raw : dflt) > 0.5;
    },
  },
  presence: {
    add: (nodeId) => addLocalCameraNodeId(getProvider(), nodeId),
    remove: (nodeId) => removeLocalCameraNodeId(getProvider(), nodeId),
  },
  clock: {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  },
  onStatus: (nodeId, status) => {
    statuses[nodeId] = status;
    cameraStatus.publish(nodeId, {
      state: status.state,
      errorMsg: status.errorMsg,
      deviceCount: status.deviceCount,
      rebindNotice: status.rebindNotice,
    });
    ensureCommands(nodeId);
  },
});

/**
 * The process-wide node-owned CAMERA capture registry.
 *
 * `sync` runs from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that retires `nodeMedia`, so a controller's lifetime is the NODE's.
 */
export const nodeCameraSource = {
  sync(
    nodes: readonly ModuleNode[],
    engine: PatchEngine | null,
    provider: () => HocuspocusProvider | null,
  ): void {
    getProvider = provider;
    registry.sync(nodes, adaptEngine(engine));
  },
  view(nodeId: string): CameraSourceStatus {
    return statuses[nodeId] ?? NO_CAMERA_SOURCE;
  },
  request: registry.request,
  has: registry.has,
  disposeNode(nodeId: string): void {
    registry.disposeNode(nodeId);
    releaseCommands(nodeId);
    delete statuses[nodeId];
  },
  sweep(liveIds: Iterable<string>): void {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    registry.sweep(live);
    for (const id of Object.keys(statuses)) {
      if (!live.has(id)) {
        releaseCommands(id);
        delete statuses[id];
      }
    }
  },
  snapshot: registry.snapshot,
} satisfies Omit<NodeCameraSourceRegistry<HTMLElement>, 'sync'> & {
  sync(
    nodes: readonly ModuleNode[],
    engine: PatchEngine | null,
    provider: () => HocuspocusProvider | null,
  ): void;
};

export { CAMERA_SOURCE_SLOT, NODE_CAMERA_SOURCE_TYPES };
