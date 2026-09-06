// packages/web/src/lib/ui/media/node-archivist-source.svelte.ts
//
// THE REAL-DOM SINGLETON for ./node-archivist-source-registry — a thin binding of
// the pure core to the browser, the graph store, the engine and archive.org.
//
// Same split and same reason as the two sibling controllers: the core must
// unit-test in the web package's `environment: 'node'` vitest, where there is no
// `document`, no `fetch` to a real host and no `$state`. This file is the only
// place that names a browser global or an archive.org helper, and it is
// dependency-shaped rather than logic-shaped — a branch that appears here
// belongs in the core where a test can reach it.
//
// ⚠ IT FEEDS `archivist-status-registry` unchanged, so all four archivist FACE
// files (`ArchivistArchiveBody`, `ArchivistTileBody`, `ArchivistBrowseControls`
// and the shell extension) are untouched by this migration. What moved is who
// publishes into the seam and who owns the six commands.

import type { ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from '$lib/audio/engine';
import type { VideoEngine } from '$lib/video/engine';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type {
  ArchivistData,
  ArchivistHandleExtras,
  ArchivistItemMeta,
} from '$lib/video/modules/archivist';
import {
  type ArchivistMediaType,
  buildSearchUrl,
  parseSearchResponse,
  pickRandomDoc,
  parseMetadata,
  pickBestFile,
  buildFileUrl,
  concreteTypeFromMediatype,
  hasCleanOutput,
  METADATA_URL,
} from '$lib/video/modules/archivist-query';
import { nodeMedia } from './node-media-registry';
import { archivistStatus, type ArchivistCommandLease } from './archivist-status-registry';
import {
  createNodeArchivistSourceRegistry,
  ARCHIVIST_SLOTS,
  NO_ARCHIVIST_SOURCE,
  NODE_ARCHIVIST_SOURCE_TYPES,
  type ArchivistSourceEngine,
  type ArchivistSourceStatus,
  type NodeArchivistSourceRegistry,
} from './node-archivist-source-registry';

/** Reactive published status per node. Written ONLY by the core's `onStatus`. */
const statuses = $state<Record<string, ArchivistSourceStatus>>({});

const commandLeases = new Map<string, ArchivistCommandLease>();

function adaptEngine(engine: PatchEngine | null): ArchivistSourceEngine | null {
  if (!engine) return null;
  function video(): VideoEngine | null {
    try {
      return engine!.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }
  return {
    attach(nodeId, kind, el) {
      video()?.attachExternalSource(nodeId, kind, (el as HTMLElement | null) ?? null);
    },
    hasSource(nodeId) {
      try {
        return video()?.read(nodeId, 'hasVideoElement') === true;
      } catch {
        return false;
      }
    },
    extras(nodeId) {
      try {
        return (video()?.read(nodeId, 'extras') as ArchivistHandleExtras | undefined) ?? null;
      } catch {
        return null;
      }
    },
    readParam(node, paramId) {
      try {
        return engine!.readParam(node, paramId);
      } catch {
        return undefined;
      }
    },
  };
}

function ensureCommands(nodeId: string): void {
  if (commandLeases.has(nodeId)) return;
  commandLeases.set(
    nodeId,
    archivistStatus.registerCommands(nodeId, {
      search: () => void registry.request(nodeId, { kind: 'search' }),
      next: () => void registry.request(nodeId, { kind: 'next' }),
      togglePlay: () => void registry.request(nodeId, { kind: 'togglePlay' }),
      skip: (deltaS: number) => void registry.request(nodeId, { kind: 'skip', deltaS }),
      seek: (positionS: number) => void registry.request(nodeId, { kind: 'seek', positionS }),
      jumpRandom: () => void registry.request(nodeId, { kind: 'jumpRandom' }),
    }),
  );
}

function releaseCommands(nodeId: string): void {
  commandLeases.get(nodeId)?.release();
  commandLeases.delete(nodeId);
}

/** A media element's `<video>`/`<audio>` face, whichever slot it came from. */
const media = (el: HTMLElement): HTMLMediaElement => el as HTMLMediaElement;

const registry = createNodeArchivistSourceRegistry<HTMLElement>({
  engine: null,
  media: {
    ensure: (nodeId, slot) =>
      nodeMedia.ensure(nodeId, slot, {
        kind: slot === 'image' ? 'img' : slot === 'audio' ? 'audio' : 'video',
        init: (el) => {
          // ⚠ THE TESTIDS ARE SET HERE, NOT IN A SURFACE. These elements are
          // node-owned and adopted by whichever surface is showing them, so a
          // testid applied at adoption time would exist only while that surface
          // was mounted — the coupling this move removes.
          if (slot === 'image') {
            el.setAttribute('data-testid', 'archivist-image');
            el.classList.add('img-el');
          } else if (slot === 'audio') {
            el.setAttribute('data-testid', 'archivist-audio');
            el.classList.add('audio-el');
          } else {
            el.setAttribute('data-testid', 'archivist-video');
            (el as HTMLVideoElement).playsInline = true;
          }
        },
      }),
  },
  el: {
    setCrossOrigin: (el, value) => {
      // ⚠ null IS NOT '' HERE. archive.org VIDEO lacks CORS, and setting
      // crossorigin at all BLOCKS PLAYBACK ENTIRELY — the attribute has to be
      // REMOVED, not blanked.
      if (value === null) el.removeAttribute('crossorigin');
      else (el as HTMLMediaElement | HTMLImageElement).crossOrigin = value;
    },
    setSrc: (el, url) => {
      (el as HTMLMediaElement | HTMLImageElement).src = url;
    },
    awaitImageLoad: (el) =>
      new Promise<boolean>((resolve) => {
        const img = el as HTMLImageElement;
        const done = (): void => { cleanup(); resolve(true); };
        const fail = (): void => { cleanup(); resolve(false); };
        function cleanup(): void {
          img.removeEventListener('load', done);
          img.removeEventListener('error', fail);
        }
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', fail, { once: true });
      }),
    awaitMetadata: (el, timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const m = media(el);
        if (m.readyState >= 1 /* HAVE_METADATA */) { resolve(true); return; }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (ok: boolean): void => {
          if (timer !== null) { clearTimeout(timer); timer = null; }
          m.removeEventListener('loadedmetadata', onMeta);
          m.removeEventListener('error', onErr);
          resolve(ok);
        };
        const onMeta = (): void => settle(true);
        const onErr = (): void => settle(false);
        m.addEventListener('loadedmetadata', onMeta, { once: true });
        m.addEventListener('error', onErr, { once: true });
        timer = setTimeout(() => settle(false), timeoutMs);
      }),
    duration: (el) => {
      const d = media(el).duration;
      return Number.isFinite(d) ? d : 0;
    },
    currentTime: (el) => media(el).currentTime,
    seek: (el, to) => { try { media(el).currentTime = to; } catch { /* */ } },
    paused: (el) => media(el).paused,
    ended: (el) => media(el).ended,
    play: (el) => { void media(el).play().catch(() => { /* autoplay blocked */ }); },
    pause: (el) => { try { media(el).pause(); } catch { /* */ } },
    onEnded: (el, fn) => {
      const m = media(el);
      m.addEventListener('ended', fn);
      return () => m.removeEventListener('ended', fn);
    },
  },
  io: {
    searchUrl: (q, opts) => buildSearchUrl(q, opts),
    fetchJson: async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    },
    metadataUrl: (identifier) => METADATA_URL(identifier),
    parseSearch: (json) => parseSearchResponse(json),
    parseMetadata: (json, identifier) => parseMetadata(json, identifier),
    pickRandomDoc: (docs) => pickRandomDoc(docs),
    pickBestFile: (files, type) => pickBestFile(files, type),
    fileUrl: (meta, name) => buildFileUrl(meta, name),
    concreteTypeFromMediatype: (m) => concreteTypeFromMediatype(m),
    hasCleanOutput: (t) => hasCleanOutput(t),
  },
  doc: {
    // ⚠ READ AT THE MOMENT IT IS NEEDED, from the GRAPH. Three surfaces can
    // write these four keys and so can a rack-mate; a query composed from any
    // surface's local copy would be a fourth opinion. See the core's header.
    query: (nodeId) => {
      const d = patch.nodes[nodeId]?.data as Partial<ArchivistData> | undefined;
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      return {
        term: typeof d?.searchTerm === 'string' ? d.searchTerm : '',
        mediatype: (d?.mediaType ?? 'video') as ArchivistMediaType,
        yearFrom: num(d?.yearFrom),
        yearTo: num(d?.yearTo),
      };
    },
    item: (nodeId) =>
      ((patch.nodes[nodeId]?.data as Partial<ArchivistData> | undefined)?.item ?? null),
    isPlaying: (nodeId) =>
      Boolean((patch.nodes[nodeId]?.data as Partial<ArchivistData> | undefined)?.isPlaying),
    writeItem: (nodeId, meta) => {
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        const d = t.data as Partial<ArchivistData>;
        d.item = meta;
        d.isPlaying = false;
      }, LOCAL_ORIGIN);
    },
    writePlaying: (nodeId, on) => {
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        (t.data as Partial<ArchivistData>).isPlaying = on;
      }, LOCAL_ORIGIN);
    },
    writeDuration: (nodeId, identifier, durationSec) => {
      const d = Number.isFinite(durationSec) ? durationSec : 0;
      ydoc.transact(() => {
        const data = patch.nodes[nodeId]?.data as Partial<ArchivistData> | undefined;
        const cur = data?.item;
        if (!data || !cur || cur.identifier !== identifier) return;
        // ⚠ REASSIGN THE WHOLE OBJECT. An in-place nested mutation does not
        // re-trigger the node re-render, so the duration readout and the seek
        // `max` stayed at 0 even after metadata loaded — the nested-Y-mutation
        // reactivity gap this repo has recorded before.
        data.item = { ...cur, duration: d } as ArchivistItemMeta;
      }, LOCAL_ORIGIN);
    },
  },
  clock: {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  onStatus: (nodeId, status) => {
    statuses[nodeId] = status;
    archivistStatus.publish(nodeId, {
      loading: status.loading,
      statusMsg: status.statusMsg,
      errorMsg: status.errorMsg,
      docCount: status.docCount,
      positionSec: status.positionSec,
    });
    ensureCommands(nodeId);
  },
});

/**
 * The process-wide node-owned ARCHIVIST source registry.
 *
 * `sync` runs from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that retires `nodeMedia`, so a controller's lifetime is the NODE's.
 */
export const nodeArchivistSource = {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void {
    registry.sync(nodes, adaptEngine(engine));
  },
  view(nodeId: string): ArchivistSourceStatus {
    return statuses[nodeId] ?? NO_ARCHIVIST_SOURCE;
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
} satisfies Omit<NodeArchivistSourceRegistry<HTMLElement>, 'sync'> & {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void;
};

export { ARCHIVIST_SLOTS, NODE_ARCHIVIST_SOURCE_TYPES };
