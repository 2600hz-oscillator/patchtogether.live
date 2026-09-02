// packages/web/src/lib/audio/clip-media-store.ts
//
// THE CLIP MEDIA STORE — where a recorded take's samples actually live.
//
// OPFS holds the bytes at `clipmedia/<mediaId>`; IndexedDB holds one manifest
// per take; the Y.Doc holds a `mediaId` and a dozen integers and NOTHING ELSE.
// Modelled on `recorderbox-store.ts` + the `WorkerOpfsWriter` in
// `recorderbox-recorder.ts`, with the four differences called out below.
//
// ⚠ IT LIVES IN `lib/audio/**`, AND THAT IS A GATE, NOT A PREFERENCE.
// `lib/video/**` is hashed wholesale for the real-GPU WebGL attest — #2314 moved
// the recorderbox transport out of it for exactly this reason. Clip recording is
// audio; putting any of it under `lib/video/**` would make every slice of this
// programme cost an attest window.
//
// ── WHAT THIS DOES THAT RECORDERBOX'S STORE DOES NOT ───────────────────────
//
// 1. **A GARBAGE COLLECTOR.** recorderbox retires scratch only on a SUCCESSFUL
//    delivery and states plainly that there is no background GC or orphan
//    sweeper — nothing in the repo enumerates its OPFS directory, so a file
//    whose manifest row is lost is invisible and never reclaimed. A single-take
//    video sink can live with that. A LAUNCHER CANNOT: deleting a clip has to
//    free its bytes, and a clip's media is referenced by exactly ONE `mediaId`
//    in ONE `node.data`, so the live set is derivable and a GC is possible.
//
// 2. **Keyed by `mediaId`, not by the OPFS path.** recorderbox's path carries
//    (nodeId, epoch, filename, chunkIndex) and there is no single id to key on,
//    so it derives a deterministic path and keys the manifest by it. Here the id
//    is generated up front and WRITTEN DOWN BEFORE THE FIRST BYTE, so it
//    survives a crash on its own and the path is a pure function of it. Keying
//    by the path would store a derived value as the key.
//
// 3. **Truncate-to-a-whole-loop recovery.** A partial video file needs a muxer
//    to be a valid shorter video. PCM is trivially truncatable: a partial file
//    IS a valid shorter take, and the honest length is the last whole
//    `unitFrames` — never a partial loop, which is the one outcome Arm-Endless
//    exists to prevent.
//
// 4. **The drain STALLS, it never skips.** See `ClipMediaWriter.write`.

import { isClipAudioFormat, type ClipAudioFormat } from './clip-media';

// ---------------------------------------------------------------------------
// Names + shapes
// ---------------------------------------------------------------------------

/** The OPFS sub-directory. Every clip take is one file directly inside it. */
export const CLIP_MEDIA_DIR = 'clipmedia';

const DB_NAME = 'patchtogether-clipmedia';
const DB_VERSION = 1;
const STORE = 'manifests'; // keyPath: 'mediaId'

/** How long to wait for a wedged writer worker to acknowledge `close` before
 *  giving up on it and terminating. A commit must never hang on a worker.
 *  (recorderbox uses the same bound for the same reason.) */
export const CLIP_MEDIA_CLOSE_TIMEOUT_MS = 2000;

/** One in-flight or finished take, as the recovery scan sees it.
 *
 *  ⚠ WRITTEN BEFORE THE FIRST BYTE. A crash 100 ms into a take still leaves a
 *  recover candidate; a manifest written after the bytes would leave orphaned
 *  samples that nothing can name. */
export interface ClipMediaManifest {
  /** The content key — the IDB key, and the OPFS filename. */
  mediaId: string;
  /** The clipplayer node the take will commit to (the recovery scan filters on
   *  it, so a rack with two launchers offers each its own candidates). */
  nodeId: string;
  lane: number;
  slot: number;
  startedAt: number;
  /** `'recording'` while the take is open OR abandoned-and-recoverable;
   *  `'done'` once the bytes are complete. The recovery scan reads
   *  `'recording'`, and so does the GC's in-flight guard. */
  status: 'recording' | 'done';
  format: ClipAudioFormat;
  sampleRate: number;
  channels: 1 | 2;
  /** Frames written SO FAR — updated as chunks land. This is the recovery
   *  length, before truncation. */
  frames: number;
  /** The unit loop in frames. A recovered endless take truncates to a whole
   *  multiple of it. */
  unitFrames: number;
  lengthSteps: number;
}

/** The OPFS path for a take. A pure function of the id — there is no second
 *  naming scheme to keep in sync. */
export function clipMediaPath(mediaId: string): string {
  return `${CLIP_MEDIA_DIR}/${sanitizeMediaId(mediaId)}`;
}

/** Strip anything that is not filename-safe. Ids we generate are already safe;
 *  this guards an id that arrived from stored data. */
function sanitizeMediaId(raw: string): string {
  const s = String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  return s || 'media';
}

/** A fresh content key. Follows the store-local `new<Thing>Id()` convention
 *  (`newVideoFileId`, `newFrametableFileId`) — there is no repo-wide id module,
 *  and the guarded `randomUUID` with a prefixed fallback is the shape they use. */
export function newClipMediaId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `clip-${crypto.randomUUID()}`;
  }
  return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether this runtime can store clip media at all. Requires OPFS **and**
 *  `Worker`: `createSyncAccessHandle` is worker-only, so a runtime with OPFS but
 *  no workers cannot write a take and must say so rather than half-working. */
export function hasClipMediaStore(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker !== 'undefined'
  );
}

// ---------------------------------------------------------------------------
// IndexedDB — the manifest sidecar
// ---------------------------------------------------------------------------

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDB()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'mediaId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Whole-record write (the keyPath collides and overwrites). Never throws — a
 *  storage failure must not take down the audio thread's caller. */
export async function putClipMediaManifest(m: ClipMediaManifest): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(m);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

export async function getClipMediaManifest(mediaId: string): Promise<ClipMediaManifest | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<ClipMediaManifest | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(mediaId);
      req.onsuccess = () => resolve((req.result as ClipMediaManifest | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

export async function listClipMediaManifests(): Promise<ClipMediaManifest[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    return await new Promise<ClipMediaManifest[]>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as ClipMediaManifest[] | undefined) ?? []);
      req.onerror = () => resolve([]);
    });
  } finally {
    db.close();
  }
}

export async function deleteClipMediaManifest(mediaId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(mediaId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

/** Takes that were still OPEN when their tab went away — the recover
 *  candidates. Filtered to one node when asked, so a rack with two launchers
 *  offers each only its own. */
export async function listRecoverableClipMedia(nodeId?: string): Promise<ClipMediaManifest[]> {
  const all = await listClipMediaManifests();
  return all.filter(
    (m) => m && m.status === 'recording' && (nodeId === undefined || m.nodeId === nodeId),
  );
}

// ---------------------------------------------------------------------------
// OPFS
// ---------------------------------------------------------------------------

async function resolveFile(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return null;
    let dir: FileSystemDirectoryHandle = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return await dir.getFileHandle(fileName, { create });
  } catch {
    return null;
  }
}

/** The stored bytes of a take, or null when the file is gone. */
export async function readClipMedia(mediaId: string): Promise<File | null> {
  const handle = await resolveFile(clipMediaPath(mediaId), false);
  if (!handle) return null;
  try {
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function deleteClipMediaFile(mediaId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CLIP_MEDIA_DIR, { create: false });
    await dir.removeEntry(sanitizeMediaId(mediaId));
  } catch {
    /* already gone, or no OPFS — either way there is nothing to free */
  }
}

/** Every mediaId with bytes on disk, whether or not it still has a manifest.
 *  ⚠ THE CAPABILITY RECORDERBOX LACKS. Without directory enumeration an OPFS
 *  file whose manifest row was lost is permanently invisible and can never be
 *  reclaimed; with it, orphans are collectable. */
async function listClipMediaFiles(): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CLIP_MEDIA_DIR, { create: false });
    const out: string[] = [];
    // `values()` is the async-iterable form; some engines only expose keys().
    const iter = (dir as unknown as { values?: () => AsyncIterable<FileSystemHandle> }).values?.();
    if (iter) {
      for await (const h of iter) if (h.kind === 'file') out.push(h.name);
      return out;
    }
    const keys = (dir as unknown as { keys?: () => AsyncIterable<string> }).keys?.();
    if (keys) for await (const name of keys) out.push(name);
    return out;
  } catch {
    return [];
  }
}

/** Delete a take's bytes AND its manifest. The explicit discard path. */
export async function removeClipMedia(mediaId: string): Promise<void> {
  await deleteClipMediaFile(mediaId);
  await deleteClipMediaManifest(mediaId);
}

// ---------------------------------------------------------------------------
// Recovery arithmetic — PURE, so it is tested without a browser
// ---------------------------------------------------------------------------

/** Bytes per FRAME (all channels) for a stored format. `opus` has no fixed
 *  frame size, so it reports 0 and the caller must not do frame arithmetic on
 *  it — which is exactly why `compact` is the tier whose exact-length promise
 *  is the weakest. */
export function clipMediaBytesPerFrame(format: ClipAudioFormat, channels: 1 | 2): number {
  if (format === 'pcm-f32') return 4 * channels;
  if (format === 'pcm-i16') return 2 * channels;
  return 0; // opus — variable rate, not frame-addressable
}

/** THE RECOVERED LENGTH: how many frames of a partial take are honestly
 *  playable, given how many bytes actually reached the disk.
 *
 *  ⚠ TRUNCATE TO THE LAST WHOLE `unitFrames`. A partial loop is the one outcome
 *  Arm-Endless exists to prevent, and recovering one would hand the player a
 *  clip that is musically wrong in a way they cannot see until it loops. Below
 *  one whole unit there is nothing to recover: 0.
 *
 *  ⚠ AND IT NEVER TRUSTS THE MANIFEST'S `frames` ALONE. The manifest is updated
 *  as chunks land, so after a crash it can name more frames than reached the
 *  disk. The bytes are the truth; the manifest is the intent. PURE. */
export function recoverableFrames(
  manifest: Pick<ClipMediaManifest, 'format' | 'channels' | 'unitFrames' | 'frames'>,
  bytesOnDisk: number,
): number {
  const per = clipMediaBytesPerFrame(manifest.format, manifest.channels);
  if (per <= 0) return 0; // not frame-addressable — nothing safe to claim
  const unit = Math.trunc(manifest.unitFrames);
  if (!Number.isFinite(unit) || unit < 1) return 0;
  const onDisk = Math.floor(Math.max(0, bytesOnDisk) / per);
  // The manifest can only ever OVER-claim after a crash, never under-claim.
  const claimed = Number.isFinite(manifest.frames) ? Math.max(0, Math.trunc(manifest.frames)) : 0;
  const usable = Math.min(onDisk, claimed || onDisk);
  return Math.floor(usable / unit) * unit;
}

// ---------------------------------------------------------------------------
// The writer — an inline module Worker owning a FileSystemSyncAccessHandle
// ---------------------------------------------------------------------------

/** What a take writes through. Deliberately NO `abort()` / `dispose()` beyond
 *  the two below: a take ends by finishing or by being explicitly discarded,
 *  and a third exit would be a third lifecycle to reason about. */
export interface ClipMediaWriter {
  readonly mediaId: string;
  /** Append `bytes` at `position`.
   *
   *  ⚠ THE RETURNED PROMISE IS THE BACKPRESSURE, AND AWAITING IT IS MANDATORY.
   *  It resolves only when the worker has written AND flushed. A caller that
   *  awaits it in order STALLS when the disk falls behind, which is correct; a
   *  caller that fires and forgets will interleave positions and, worse, will be
   *  tempted to drop a chunk to catch up. A DROPPED CHUNK IS A HOLE IN THE
   *  MIDDLE OF A LOOP — the same silence-padded discontinuity that made
   *  recorderbox click, and unlike a video CFR grid a loop cannot absorb it. */
  write(bytes: Uint8Array, position: number): Promise<void>;
  /** Flush, close the handle, terminate the worker. Bounded by
   *  `CLIP_MEDIA_CLOSE_TIMEOUT_MS` so a wedged worker never hangs a commit. */
  close(): Promise<void>;
}

const WORKER_SOURCE = `
let accessHandle = null;

async function openFile(path) {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  // createSyncAccessHandle is worker-only. Truncate to 0 in case a stale file
  // exists at this exact path (it shouldn't — the mediaId is fresh).
  accessHandle = await fileHandle.createSyncAccessHandle();
  accessHandle.truncate(0);
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'open') {
    try {
      await openFile(d.path);
      self.postMessage({ type: 'open-ok' });
    } catch (err) {
      self.postMessage({ type: 'open-err', error: String((err && err.message) || err) });
    }
    return;
  }
  if (d.type === 'write') {
    try {
      // Synchronous POSITIONED write. flush() forces the bytes to disk so a
      // crash right after this chunk cannot lose it — which is what makes the
      // manifest's frame count and the file agree closely enough to recover.
      accessHandle.write(d.data, { at: d.position });
      accessHandle.flush();
      self.postMessage({ type: 'write-ok', id: d.id });
    } catch (err) {
      self.postMessage({ type: 'write-err', id: d.id, error: String((err && err.message) || err) });
    }
    return;
  }
  if (d.type === 'close') {
    try {
      if (accessHandle) { accessHandle.flush(); accessHandle.close(); accessHandle = null; }
    } catch (err) { /* best effort */ }
    self.postMessage({ type: 'close-ok' });
    return;
  }
};
`;

class WorkerClipMediaWriter implements ClipMediaWriter {
  readonly mediaId: string;
  #worker: Worker | null = null;
  #ready: Promise<void>;
  #seq = 0;
  #pending = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();

  constructor(mediaId: string) {
    this.mediaId = mediaId;
    this.#ready = new Promise<void>((resolve, reject) => {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url, { type: 'module' });
      URL.revokeObjectURL(url);
      this.#worker = w;
      w.onerror = (err) => reject(err);
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as { type?: string; id?: number; error?: string };
        if (d?.type === 'open-ok') return resolve();
        if (d?.type === 'open-err') return reject(new Error(d.error ?? 'open failed'));
        if (d?.type === 'write-ok' || d?.type === 'write-err') {
          const p = this.#pending.get(d.id!);
          if (!p) return;
          this.#pending.delete(d.id!);
          if (d.type === 'write-ok') p.resolve();
          else p.reject(new Error(d.error ?? 'write failed'));
        }
      };
      w.postMessage({ type: 'open', path: clipMediaPath(mediaId) });
    });
  }

  async write(bytes: Uint8Array, position: number): Promise<void> {
    await this.#ready;
    const w = this.#worker;
    if (!w) throw new Error('clip media writer gone');
    const id = ++this.#seq;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // Copy into a fresh buffer we can TRANSFER: the capture path reuses its
      // chunk buffers, so posting the original would either be structure-cloned
      // (a copy anyway) or detached out from under the producer.
      const copy = bytes.slice();
      w.postMessage({ type: 'write', id, position, data: copy }, [copy.buffer]);
    });
  }

  async close(): Promise<void> {
    try {
      await this.#ready;
    } catch {
      /* never opened — still tear the worker down */
    }
    const w = this.#worker;
    if (!w) return;
    await new Promise<void>((resolve) => {
      const onClose = (e: MessageEvent) => {
        if ((e.data as { type?: string })?.type === 'close-ok') {
          w.removeEventListener('message', onClose);
          resolve();
        }
      };
      w.addEventListener('message', onClose);
      try {
        w.postMessage({ type: 'close' });
      } catch {
        resolve();
      }
      // Safety timeout: a wedged worker must never hang a commit.
      setTimeout(resolve, CLIP_MEDIA_CLOSE_TIMEOUT_MS);
    });
    try {
      w.terminate();
    } catch {
      /* already gone */
    }
    this.#worker = null;
    this.#pending.clear();
  }
}

/** Swappable writer factory — the seam the unit tests inject through, so the
 *  store's ORDERING can be tested in node with no OPFS and no Worker. */
export type ClipMediaWriterFactory = (mediaId: string) => ClipMediaWriter;

let makeWriter: ClipMediaWriterFactory = (mediaId) => new WorkerClipMediaWriter(mediaId);

/** Replace the writer factory (tests only). Returns the previous one so a test
 *  can restore it. */
export function setClipMediaWriterFactory(f: ClipMediaWriterFactory): ClipMediaWriterFactory {
  const prev = makeWriter;
  makeWriter = f;
  return prev;
}

// ---------------------------------------------------------------------------
// The take lifecycle
// ---------------------------------------------------------------------------

/** Open a take: **manifest first, then the writer, then any bytes.**
 *
 *  ⚠ THE ORDER IS THE CRASH MODEL. A manifest written after the first byte
 *  leaves samples on disk that nothing can name, and a manifest written after
 *  the writer opens leaves a window in which a crash orphans a file. The
 *  manifest is put, awaited, and only then is the worker asked to open the
 *  file — so a crash at any instant leaves either nothing, or a recover
 *  candidate pointing at a (possibly tiny) file. */
export async function beginClipMediaTake(m: ClipMediaManifest): Promise<ClipMediaWriter> {
  await putClipMediaManifest({ ...m, status: 'recording' });
  try {
    return makeWriter(m.mediaId);
  } catch (err) {
    // The writer could not even be constructed — roll the manifest back rather
    // than leaving a phantom recover candidate for a take that never started.
    await deleteClipMediaManifest(m.mediaId);
    throw err;
  }
}

/** Mark a take complete at its final frame count. Called AFTER the writer's
 *  `close()` resolves, so `status: 'done'` means the bytes are on disk. */
export async function finishClipMediaTake(mediaId: string, frames: number): Promise<void> {
  const existing = await getClipMediaManifest(mediaId);
  if (!existing) return;
  await putClipMediaManifest({
    ...existing,
    frames: Math.max(0, Math.trunc(frames)),
    status: 'done',
  });
}

/** Update the in-flight frame count. Cheap and idempotent; called as chunks
 *  land so a crash leaves a length close to the truth. */
export async function noteClipMediaProgress(mediaId: string, frames: number): Promise<void> {
  const existing = await getClipMediaManifest(mediaId);
  if (!existing || existing.status !== 'recording') return;
  await putClipMediaManifest({ ...existing, frames: Math.max(0, Math.trunc(frames)) });
}

// ---------------------------------------------------------------------------
// The garbage collector
// ---------------------------------------------------------------------------

export interface ClipMediaGcResult {
  /** How many takes' bytes were freed. */
  freed: number;
  /** The ids freed, for the caller's log. */
  ids: string[];
  /** Ids skipped because a take is still open (or is a recover candidate). */
  inFlight: number;
}

/** Free every stored take that no clip references any more.
 *
 *  ⚠ TWO THINGS PROTECT A TAKE, AND MISSING EITHER LOSES DATA:
 *
 *  1. **Membership in `liveMediaIds`** — the ids reachable from `node.data`.
 *  2. **`status === 'recording'`** — an OPEN take has no clip record yet
 *     (the record is written at COMMIT), so it is absent from the live set by
 *     construction. Collecting on membership alone would delete the take
 *     currently being recorded, mid-take. The same guard is what keeps a
 *     crashed take collectable-by-the-user-only: a recover candidate is
 *     `'recording'` and survives every sweep until it is recovered or
 *     explicitly discarded.
 *
 *  An OPFS file with NO manifest at all is an orphan and IS collected: the
 *  manifest is written before the file is opened, so a file without one cannot
 *  be a take in progress.
 *
 *  Never throws; a storage failure frees nothing and says so. */
export async function gcClipMedia(liveMediaIds: Iterable<string>): Promise<ClipMediaGcResult> {
  const live = liveMediaIds instanceof Set ? liveMediaIds : new Set(liveMediaIds);
  const manifests = await listClipMediaManifests();
  const byId = new Map(manifests.map((m) => [m.mediaId, m]));
  const onDisk = await listClipMediaFiles();

  const candidates = new Set<string>([...byId.keys(), ...onDisk]);
  const ids: string[] = [];
  let inFlight = 0;

  for (const id of candidates) {
    if (live.has(id)) continue;
    const m = byId.get(id);
    if (m && m.status === 'recording') {
      inFlight++;
      continue;
    }
    ids.push(id);
  }

  for (const id of ids) await removeClipMedia(id);
  return { freed: ids.length, ids, inFlight };
}

/** The mediaIds a graph snapshot still references — the live set `gcClipMedia`
 *  takes. Reads AUDIO clips out of every clipplayer's `clips` map.
 *
 *  ⚠ RAW, DELIBERATELY. It does not coerce, because a record that fails
 *  validation is still a record someone might repair, and a GC that frees the
 *  bytes behind a repairable clip is a GC that destroys data on a technicality.
 *  Over-retention is a wasted file; under-retention is a lost take. PURE. */
export function referencedClipMediaIds(
  nodes: readonly { type?: string; data?: unknown }[],
): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n?.type !== 'clipplayer') continue;
    const clips = (n.data as { clips?: Record<string, unknown> } | undefined)?.clips;
    if (!clips || typeof clips !== 'object') continue;
    for (const raw of Object.values(clips)) {
      const rec = raw as { mediaId?: unknown; videoMediaId?: unknown } | null | undefined;
      if (!rec || typeof rec !== 'object') continue;
      if (typeof rec.mediaId === 'string' && rec.mediaId) out.add(rec.mediaId);
      // The video tie-in seam: a clip's video take is referenced the same way
      // and must be protected by the same sweep, or shipping slice 10 would
      // silently start deleting video takes.
      if (typeof rec.videoMediaId === 'string' && rec.videoMediaId) out.add(rec.videoMediaId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The graph-lifetime sweep
// ---------------------------------------------------------------------------

let gcInFlight = false;
let lastLiveKey = '';

/** The memo key's join separator.
 *
 *  ⚠ SPELLED AS AN ESCAPE, NOT AS A LITERAL NUL BYTE. A NUL is the right
 *  separator — `sanitizeMediaId` restricts ids to `[a-zA-Z0-9_-]`, so it can
 *  never appear inside one and two different live sets can never collide on the
 *  same key — but writing it literally puts a 0x00 in the SOURCE FILE, and
 *  `grep` then reports NO MATCHES anywhere in that file, silently, with an exit
 *  code indistinguishable from "the symbol does not exist". This file would
 *  have become invisible to every source search in the repo. The escape is
 *  byte-identical at runtime. (Caught by `tracked-source-is-greppable`, which
 *  is exactly the defect it exists to find.) */
const SWEEP_KEY_SEP = '\u0000';

/** The GC as the graph-lifetime `$effect` calls it: fire-and-forget, and
 *  cheap enough to sit in a pass that re-runs on EVERY graph change.
 *
 *  ⚠ THE OTHER REGISTRY SWEEPS IN THAT PASS ARE `Map` DELETES. This one touches
 *  IndexedDB and enumerates an OPFS directory, so it cannot run unguarded at
 *  the same cadence. Two guards, both cheap: skip while a sweep is already in
 *  flight, and skip when the live set is unchanged since the last one. A graph
 *  edit that does not add or remove an audio clip therefore costs one string
 *  compare. */
export function sweepClipMedia(liveMediaIds: Iterable<string>): void {
  const ids = [...liveMediaIds].sort();
  const key = ids.join(SWEEP_KEY_SEP);
  if (gcInFlight || key === lastLiveKey) return;
  lastLiveKey = key;
  gcInFlight = true;
  void gcClipMedia(ids).finally(() => {
    gcInFlight = false;
  });
}

/** Forget the sweep's memo (tests, and a rack switch — a different rack's live
 *  set is a different question, and an equal-looking key must not suppress the
 *  first sweep after the switch). */
export function resetClipMediaSweepMemo(): void {
  lastLiveKey = '';
  gcInFlight = false;
}

/** Coerce a stored manifest, or null. The recovery scan's boundary: a manifest
 *  it cannot trust is a candidate it must not offer. PURE. */
export function coerceClipMediaManifest(raw: unknown): ClipMediaManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.mediaId !== 'string' || !r.mediaId) return null;
  if (typeof r.nodeId !== 'string' || !r.nodeId) return null;
  if (!isClipAudioFormat(r.format)) return null;
  const channels = Number(r.channels);
  if (channels !== 1 && channels !== 2) return null;
  const sampleRate = Number(r.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const num = (v: unknown, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : min;
  };
  return {
    mediaId: r.mediaId,
    nodeId: r.nodeId,
    lane: num(r.lane, 0),
    slot: num(r.slot, 0),
    startedAt: num(r.startedAt, 0),
    status: r.status === 'done' ? 'done' : 'recording',
    format: r.format,
    sampleRate,
    channels,
    frames: num(r.frames, 0),
    unitFrames: num(r.unitFrames, 0),
    lengthSteps: num(r.lengthSteps, 1),
  };
}
