// node-recorder-registry.svelte.ts
//
// NODE-OWNED RECORDING LIFETIME — the registry that makes an in-progress
// recorderbox capture outlive the CARD that started it.
//
// THE BUG THIS EXISTS FOR (owner P0, dev, 2026-08-13, #1574): "when recorderbox
// is un-expanded, it stops the recording." Recorderbox is an un-migrated video
// module, so under the faceplate shell it has NO real card in the lane — the
// card exists only while its dock FULL-VIEW is open. Collapsing the full view
// UNMOUNTS the card, and `RecorderboxCard.onDestroy` ran:
//
//     if (rafId !== null) cancelAnimationFrame(rafId);
//     if (recorder && recState === 'recording') void recorder.abandon();
//
// A VIEW action destroyed the user's take. Note the comment that shipped with
// it — "Card destroyed mid-record: abandon" — which was correct when a card
// unmount implied the module was going away. The dock shell made collapse
// produce the identical unmount, and the teardown could not tell the two apart.
//
// THREE card-owned things died with that unmount, each fatal on its own:
//   1. THE RECORDER     — `recorder.abandon()`, above.
//   2. THE CAPTURE PUMP — `cancelAnimationFrame(rafId)`. The per-frame
//      `recorder.frame()` ran inside the CARD's rAF loop, so even a surviving
//      recorder would have received no frames.
//   3. THE CAPTURE CANVAS — the recorder encodes from a <canvas> that was an
//      ELEMENT OF THE CARD. The unmount detaches it, and a detached canvas keeps
//      its last bitmap, so 1 and 2 alone would still have recorded a freeze
//      frame for the whole collapsed span. This is exactly mechanism 3 from
//      #1531, and it is deleted rather than worked around: the capture canvas is
//      created HERE and never enters the document, so no unmount can reach it.
//
// PLUS ONE THE PROJECTOR BUG ALREADY TAUGHT US: the RENDER LEASE. The engine
// only draws nodes something is pulling. With the card gone nothing pulls the
// recorderbox node, so the capture would encode a stale or black buffer even
// with 1-3 fixed. The lease is acquired here, for the recording's lifetime.
//
// THE RULE THIS ENCODES is the one $lib/ui/media/node-media-registry encodes for
// <video>/<img>, and node-present-registry encodes for projectors: a resource
// whose LIFETIME is the node's belongs to the NODE, never to whichever view
// happens to be rendering it. Cards ADOPT and READ; they do not CREATE and
// DESTROY. Teardown is keyed to GRAPH lifetime — `sweep(liveNodeIds)` from
// Canvas, reconciled against the live node set — so a node deleted by ANY route
// (menu, lasso, undo, a peer's CRDT delete, Clear, a patch load) finalizes its
// recording with no delete site having to remember.
//
// ── THE STRUCTURAL GUARD ──────────────────────────────────────────────────
//
// This registry deliberately exposes NO per-card teardown: no `dispose()`, no
// `release()`, no `detach()`. Its ABSENCE is the guard, exactly as
// PresentController's missing dispose() is in #1531 — a future card cannot
// re-introduce this bug in an onDestroy, because there is no method to call and
// `tsc` refuses the attempt before any test runs. The only ways a recording ends
// are `stop()` (the user pressed Record OFF) and `sweep()` (the node is gone).
//
// ── THE DESTINATION FOLDER — #1583's last tabled row ──────────────────────
//
// The same file owns the node's chosen OUTPUT FOLDER, and that is a second
// instance of the identical bug rather than a convenience. `saveFolder` was a
// card-local `$state` in RecorderboxCard, so every card unmount forgot it —
// and the card's own header promises the opposite ("The folder is remembered,
// so the next record needs no prompt").
//
// ⚠ THE EPIC UNDER-RATED THIS ROW as "survives as a re-prompt, not data loss".
// It is worse than a re-prompt, because of the PRESENTATION path: at record
// start `planRecordStartFolder(haveFolder, isFullscreen)` returns 'download'
// — deliberately NOT 'prompt' — when there is no folder while presenting,
// since opening a picker would drop the performer out of fullscreen
// (./recorderbox-present-policy). So the sequence
//
//     pick a folder → expand a THIRD module (LRU evicts this pane, no user
//     action against RECORDERBOX at all) → go fullscreen → press Record
//
// SILENTLY REDIRECTS the take from the chosen folder to the browser's
// downloads, mid-performance, with only a non-modal hint on a card that is not
// even mounted to show it. A re-prompt is visible; this is not.
//
// WHY A REGISTRY AND NOT THE Y.DOC: a `FileSystemDirectoryHandle` is a
// permission-bound, origin-bound live capability, not data. It must never sync
// to a rack-mate (their browser cannot honour it, and it would leak the local
// filesystem layout), so the Y.Doc is the wrong owner however convenient. Node
// lifetime in local memory is exactly right.
//
// SCOPE — this survives card unmount, NOT a page reload. Re-picking after a
// reload is correct-by-permission (the handle needs a fresh user gesture to
// re-grant write access anyway), so it is out of this bug's scope.
//
// The folder map has no remover either, for the same structural reason: a
// re-pick OVERWRITES via `rememberFolder`, and the only removal is `sweep()`.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`, NOT `lib/video/**`, which is
// hashed WHOLESALE for the WebGL attest — a change there costs a GPU re-attest
// window. Keeping it here is deliberate and is a constraint on any future edit:
// do not move this file.
//
// TESTABILITY: the recorder is created through an injectable factory and the
// pump through an injectable scheduler, so the whole registry drives under
// vitest's node environment with no rAF, no DOM and no GL.

import {
  RecorderboxRecorder,
  type RecorderboxRecorderOptions,
  type RecorderState,
} from '$lib/video/recorderbox-recorder';

/** The slice of VideoEngine a capture needs: render one node into the shared
 *  drawing buffer, read that buffer, and pin the node as a pull root. */
export interface RecorderEngine {
  readonly canvas: (CanvasImageSource & { readonly width: number; readonly height: number }) | null;
  blitOutputToDrawingBuffer(nodeId: string): void;
  acquireRenderLease(nodeId: string): () => void;
}

/** What the card must resolve before a recording can start. Everything here is
 *  user-gesture-bound or UI-policy work (folder pickers, overwrite confirms,
 *  codec probes) and deliberately stays in the card — the registry owns the
 *  LIFETIME, not the dialogs. */
export interface StartRecordingArgs {
  /** The live video engine. Resolved by the CARD at Record-press time and stored
   *  on the entry, because the engine is a page singleton that outlives every
   *  card — unlike the card's own context handle. */
  engine: RecorderEngine;
  width: number;
  height: number;
  /** Recorder options MINUS the ones this registry owns. `canvas` is absent by
   *  type: the capture surface is registry-owned, and letting a caller pass one
   *  would re-open mechanism 3. */
  options: Omit<RecorderboxRecorderOptions, 'canvas' | 'onStateChange' | 'onChunkSaved'>;
}

interface Entry {
  nodeId: string;
  recorder: RecorderboxRecorder;
  /** Created here, never appended to the document. See mechanism 3 above. */
  canvas: HTMLCanvasElement;
  engine: RecorderEngine;
  releaseLease: () => void;
  stopPump: () => void;
  state: RecorderState;
  elapsed: number;
  lastSavedChunk: string | null;
}

/** Injectable seams (tests replace these; production uses the real ones). */
export interface RegistryDeps {
  makeRecorder(opts: RecorderboxRecorderOptions): RecorderboxRecorder;
  makeCanvas(width: number, height: number): HTMLCanvasElement;
  /** Start a per-frame pump; returns its canceller. */
  startPump(tick: () => void): () => void;
}

const defaultDeps: RegistryDeps = {
  makeRecorder: (opts) => new RecorderboxRecorder(opts),
  makeCanvas: (width, height) => {
    // NOT appended to the document — this element exists only as an encode
    // surface, so there is no DOM position for an unmount to detach it from.
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  },
  startPump: (tick) => {
    let raf: number | null = requestAnimationFrame(function loop() {
      tick();
      raf = requestAnimationFrame(loop);
    });
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  },
};

export class NodeRecorderRegistry {
  #entries = new Map<string, Entry>();
  /** The node's chosen destination FOLDER. Keyed by node and kept OUTSIDE
   *  `#entries` on purpose: an entry exists only for the span of one live
   *  recording, but the whole point of remembering a folder is that it spans
   *  recordings — including the gap before the FIRST one. See the header. */
  #folders = new Map<string, FileSystemDirectoryHandle>();
  /** Bumped on every mutation so `$derived` readers in cards re-run. The Map
   *  itself is not deeply reactive, and entry fields are written from a rAF
   *  pump, so a version counter is the honest way to publish changes. */
  #version = $state(0);
  #deps: RegistryDeps;

  constructor(deps: Partial<RegistryDeps> = {}) {
    this.#deps = { ...defaultDeps, ...deps };
  }

  /** Reactive read for a card: the live recording for this node, or null. */
  view(nodeId: string): { state: RecorderState; elapsed: number; lastSavedChunk: string | null } | null {
    void this.#version;
    const e = this.#entries.get(nodeId);
    return e ? { state: e.state, elapsed: e.elapsed, lastSavedChunk: e.lastSavedChunk } : null;
  }

  /**
   * The destination folder this node last chose, or null.
   *
   * Reactive: reading it inside a `$derived` re-runs when a pick lands. The
   * card ADOPTS this value; it never holds its own copy, because a copy in
   * card state is precisely the bug (#1583).
   */
  folderFor(nodeId: string): FileSystemDirectoryHandle | null {
    void this.#version;
    return this.#folders.get(nodeId) ?? null;
  }

  /**
   * USER INTENT: this node's recordings go here from now on. Called only from
   * a real user gesture (the folder picker resolving), and idempotent — a
   * re-pick simply overwrites, which is why no `forgetFolder` is needed and
   * therefore why none exists (see the structural guard in the header).
   */
  rememberFolder(nodeId: string, handle: FileSystemDirectoryHandle): void {
    this.#folders.set(nodeId, handle);
    this.#bump();
  }

  /** Is this node recording right now? Survives card unmount by construction. */
  isRecording(nodeId: string): boolean {
    void this.#version;
    const e = this.#entries.get(nodeId);
    return !!e && (e.state === 'recording' || e.state === 'finalizing');
  }

  /**
   * Begin a recording owned by `nodeId`. Idempotent: a second call while one is
   * live is ignored rather than silently replacing (which would abandon the take
   * the user is already making).
   *
   * @returns true if a recording is now running.
   */
  async start(nodeId: string, args: StartRecordingArgs): Promise<boolean> {
    if (this.#entries.has(nodeId)) return true;

    const canvas = this.#deps.makeCanvas(args.width, args.height);
    const recorder = this.#deps.makeRecorder({
      ...args.options,
      canvas,
      onStateChange: (s) => {
        const e = this.#entries.get(nodeId);
        if (e) {
          e.state = s;
          this.#bump();
        }
      },
      onChunkSaved: ({ name }) => {
        const e = this.#entries.get(nodeId);
        if (e) {
          e.lastSavedChunk = name;
          this.#bump();
        }
      },
    });

    // Pin the node as a pull root FIRST: the engine must already be drawing it
    // when the first captured frame is read, or the take opens on a stale buffer.
    const releaseLease = args.engine.acquireRenderLease(nodeId);

    const entry: Entry = {
      nodeId,
      recorder,
      canvas,
      engine: args.engine,
      releaseLease,
      stopPump: () => {},
      state: 'idle',
      elapsed: 0,
      lastSavedChunk: null,
    };
    this.#entries.set(nodeId, entry);
    this.#bump();

    try {
      await recorder.start();
    } catch {
      releaseLease();
      this.#entries.delete(nodeId);
      this.#bump();
      return false;
    }

    entry.stopPump = this.#deps.startPump(() => this.#tick(entry));
    this.#bump();
    return true;
  }

  /** One captured frame: render THIS node, copy it, hand it to the encoder. */
  #tick(entry: Entry): void {
    if (entry.state !== 'recording') return;
    const engine = entry.engine;
    try {
      engine.blitOutputToDrawingBuffer(entry.nodeId);
    } catch {
      // Never let a transient engine error kill the pump — a dropped frame is
      // recoverable, a dead pump silently truncates the recording.
      return;
    }
    const src = engine.canvas;
    if (!src) return;
    const ew = src.width;
    const eh = src.height;
    if (!ew || !eh) return;
    // Follow an engine resolution change rather than freezing at the start size.
    if (entry.canvas.width !== ew) entry.canvas.width = ew;
    if (entry.canvas.height !== eh) entry.canvas.height = eh;
    const ctx = entry.canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.drawImage(src, 0, 0, ew, eh);
    entry.recorder.frame();
    entry.elapsed = entry.recorder.elapsed();
    this.#bump();
  }

  /**
   * USER INTENT: finish the recording and write the file.
   * @returns the saved name, if the recorder reported one.
   */
  async stop(nodeId: string): Promise<string | null> {
    const entry = this.#entries.get(nodeId);
    if (!entry) return null;
    this.#entries.delete(nodeId);
    this.#teardown(entry);
    this.#bump();
    try {
      return await entry.recorder.stop();
    } catch {
      return null;
    }
  }

  /**
   * GRAPH LIFETIME: the node is gone (deleted by any route), so its recording
   * cannot be completed meaningfully — abandon it, leaving the recover candidate
   * so a reload can still salvage the bytes.
   *
   * This is the ONLY teardown besides `stop()`, and it is keyed to the node set
   * rather than to any view. That is the whole point of the file.
   */
  sweep(liveNodeIds: Iterable<string>): void {
    const live = liveNodeIds instanceof Set ? liveNodeIds : new Set(liveNodeIds);
    let changed = false;
    for (const [nodeId, entry] of [...this.#entries]) {
      if (live.has(nodeId)) continue;
      this.#entries.delete(nodeId);
      this.#teardown(entry);
      void entry.recorder.abandon().catch(() => {});
      changed = true;
    }
    // The remembered folder is node-lifetime too, so it ends the same way and
    // ONLY this way. A node id is swept independently of whether it also had a
    // live recording — the two maps have different populations by design.
    for (const nodeId of [...this.#folders.keys()]) {
      if (live.has(nodeId)) continue;
      this.#folders.delete(nodeId);
      changed = true;
    }
    if (changed) this.#bump();
  }

  /** Release the machinery around a recording. Never called on card unmount. */
  #teardown(entry: Entry): void {
    entry.stopPump();
    entry.releaseLease();
  }

  #bump(): void {
    this.#version++;
  }

  /** Test-only introspection: which nodes hold a live recording. */
  get liveNodeIds(): string[] {
    void this.#version;
    return [...this.#entries.keys()];
  }

  /** Test-only introspection: which nodes remember a destination folder. */
  get folderNodeIds(): string[] {
    void this.#version;
    return [...this.#folders.keys()];
  }
}

/** The singleton the cards read through. */
export const nodeRecorder = new NodeRecorderRegistry();
