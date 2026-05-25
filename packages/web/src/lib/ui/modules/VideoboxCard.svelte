<script lang="ts">
  // VideoboxCard — file picker + multiplayer playhead.
  //
  // The card owns the <video> element + the object-URL pointing at the
  // user's picked File; the engine module (videobox.ts) samples that
  // element each video frame into its FBO + (after wireAudio) routes
  // its audio into the cross-domain audio bridge.
  //
  // Multiplayer (node.data via Yjs/SyncedStore):
  //   data.fileMeta              — name + duration, set by the loader,
  //                                visible to all peers (so they can
  //                                render "{user} loaded {filename}").
  //   data.isPlaying             — true when the player is logically
  //                                playing (shared across peers).
  //   data.lastSyncTime          — wallclock ms at the last sync write.
  //   data.lastSyncPosition      — video position (s) at lastSyncTime.
  //
  // On every local play/pause/seek we write the new sync triple to
  // data; peers observe the write through the snapshot bus + run
  // videobox-sync.ts's decideDriftCorrection to bring their local
  // element back in line.
  //
  // Peers without a local copy can still see the seekbar (its max is
  // data.fileMeta.duration, set by the loader) and the play state, but
  // their <video> stays in the "drop a file to play locally" state.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    videoboxDef,
    type VideoboxHandleExtras,
    type VideoboxData,
  } from '$lib/video/modules/videobox';
  import {
    buildSyncWrite,
    decideDriftCorrection,
    type VideoboxFileMeta,
  } from '$lib/video/modules/videobox-sync';
  import {
    speedKnobToMultiplier,
    effectiveSpeedKnob,
    effectiveStartFraction,
    effectiveEndFraction,
    resolveWindow,
    decideEdgeAction,
  } from '$lib/video/modules/videobox-transport';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ---- Resize (mirror VideoOutCard / BentboxCard) ----
  // VIDEOBOX is now drag-resizable so several can be tiled into a grid
  // (a "wall of TVs" alongside VIDEO OUT / BENTBOX). Width/height persist
  // on node.data so they sync via Y.Doc.
  const DEFAULT_WIDTH = 320;
  const DEFAULT_HEIGHT = 360;
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 300;
  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);

  // ---- DOM refs + local state ----
  let videoEl: HTMLVideoElement | null = $state(null);
  let objectUrl: string | null = null;
  let localFileName = $state<string | null>(null);
  let isDragOver = $state(false);
  let loadError = $state<string | null>(null);

  // ---- Reactive reads from data (Yjs-backed) ----
  let fileMeta = $derived<VideoboxFileMeta | null>(
    (node?.data as Partial<VideoboxData> | undefined)?.fileMeta ?? null,
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<VideoboxData> | undefined)?.isPlaying ?? false,
  );
  let lastSyncTime = $derived<number>(
    (node?.data as Partial<VideoboxData> | undefined)?.lastSyncTime ?? 0,
  );
  let lastSyncPosition = $derived<number>(
    (node?.data as Partial<VideoboxData> | undefined)?.lastSyncPosition ?? 0,
  );
  let durationSec = $derived<number>(fileMeta?.duration ?? 0);
  let loop = $derived<boolean>(
    (node?.data as Partial<VideoboxData> | undefined)?.loop ?? true,
  );

  /** Track whether THIS browser has loaded a local copy of the file. */
  let hasLocalFile = $derived<boolean>(localFileName !== null);

  // ---- Transport param accessors (knob + sliders live on node.params) ----
  function defaultFor(k: string): number {
    return videoboxDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const setParamFn = (k: string) => (v: number): void => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };

  // ---- CV-connection detection ----
  //
  // The END CV normals to +1 (unpatched END = full duration); START CV
  // normals to 0. We only sum a CV offset into a slider when its port has
  // an incoming edge, so an UNPATCHED endCv leaves END at the slider's
  // default 1. Derived from the live patch edges.
  function portConnected(portId: string): boolean {
    for (const e of Object.values(patch.edges)) {
      if (e && e.target.nodeId === id && e.target.portId === portId) return true;
    }
    return false;
  }
  let startCvConnected = $derived<boolean>(
    (void Object.keys(patch.edges).length, portConnected('startCv')),
  );
  let endCvConnected = $derived<boolean>(
    (void Object.keys(patch.edges).length, portConnected('endCv')),
  );

  // ---- Live CV reads from the engine (raw bipolar -1..+1 samples) ----
  function readCv(paramId: string): number {
    const e = engineCtx.get();
    if (!e || !node) return 0;
    const v = e.readParam(node, paramId);
    return typeof v === 'number' ? v : 0;
  }

  // ---- Extras helper ----
  function getExtras(): VideoboxHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as VideoboxHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }

  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }

  // ---- Sync writers (call inside a single transact so peers see one
  //      coherent update) ----
  function writeSync(args: { isPlaying: boolean; currentPositionSec: number }): void {
    const next = buildSyncWrite({
      isPlaying: args.isPlaying,
      currentPositionSec: args.currentPositionSec,
      nowWallclockMs: Date.now(),
    });
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoboxData>;
      d.isPlaying = next.isPlaying;
      d.lastSyncTime = next.lastSyncTime;
      d.lastSyncPosition = next.lastSyncPosition;
    }, LOCAL_ORIGIN);
  }

  function writeFileMeta(meta: VideoboxFileMeta): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoboxData>;
      d.fileMeta = meta;
      // Reset playhead to start so peers don't extrapolate against
      // stale lastSyncPosition that may exceed the new duration.
      d.isPlaying = false;
      d.lastSyncTime = Date.now();
      d.lastSyncPosition = 0;
    }, LOCAL_ORIGIN);
  }

  function writeLoop(next: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<VideoboxData>).loop = next;
    }, LOCAL_ORIGIN);
  }
  function toggleLoop(): void { writeLoop(!loop); }

  // ---- File-picker handling ----
  async function loadFile(file: File): Promise<void> {
    loadError = null;
    if (!file.type.startsWith('video/')) {
      loadError = `Not a video file: ${file.type || file.name}`;
      return;
    }
    // Free the previous object URL — leaving them around accumulates
    // ~30 MB of blob storage per swap which the browser eventually GCs
    // anyway but it's polite to release explicitly.
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
    objectUrl = URL.createObjectURL(file);
    localFileName = file.name;
    if (!videoEl) return;
    videoEl.src = objectUrl;
    // muted=false so audio plays through MediaElementSource (which IS
    // the audio output once we wireAudio()). The video element's own
    // speaker output is muted-by-Web-Audio once createMediaElementSource
    // is called, so this attribute only matters for the brief window
    // before wireAudio runs.
    videoEl.muted = false;

    // Wait for metadata so duration + readyState are populated before
    // we publish fileMeta. loadedmetadata fires fast (<100ms typical).
    await new Promise<void>((resolve) => {
      if (!videoEl) { resolve(); return; }
      if (videoEl.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
      const onMeta = (): void => { videoEl?.removeEventListener('loadedmetadata', onMeta); resolve(); };
      videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
    });
    if (!videoEl) return;

    writeFileMeta({
      name: file.name,
      duration: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
    });

    // Now that the element has src + metadata, wire its audio into the
    // graph. Must happen exactly once per <video> element instance —
    // creating a second MediaElementSource on the same element throws
    // InvalidStateError.
    const extras = getExtras();
    extras?.wireAudio();
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
    try { input.value = ''; } catch { /* */ }
  }

  function onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    isDragOver = true;
  }
  function onDragLeave(): void { isDragOver = false; }
  function onDrop(ev: DragEvent): void {
    ev.preventDefault();
    isDragOver = false;
    const file = ev.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  }

  // ---- Play / pause / seek ----
  function togglePlay(): void {
    if (!videoEl) {
      // No local file — still flip the shared isPlaying so peers WITH a
      // local copy follow. Position stays where it was.
      writeSync({ isPlaying: !isPlaying, currentPositionSec: lastSyncPosition });
      return;
    }
    const next = !isPlaying;
    writeSync({ isPlaying: next, currentPositionSec: videoEl.currentTime });
  }

  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    if (videoEl && hasLocalFile) {
      videoEl.currentTime = target;
    }
    // Write the seek REGARDLESS of whether we have a local copy — peers
    // with copies will pick it up + jump there.
    writeSync({ isPlaying, currentPositionSec: target });
  }

  // ---- Transport window + speed helpers (live, CV-summed) ----
  function effectiveSpeed(): number {
    return speedKnobToMultiplier(
      effectiveSpeedKnob(paramVal('speed'), readCv('speedCv')),
    );
  }
  function currentWindow() {
    const startFrac = effectiveStartFraction(paramVal('start'), readCv('startCv'), startCvConnected);
    const endFrac = effectiveEndFraction(paramVal('end'), readCv('endCv'), endCvConnected);
    return resolveWindow(durationSec, startFrac, endFrac);
  }

  // ---- Gate actions (start / pause / reset) ----
  //
  // start  — (re)start playback from the START point.
  // pause  — toggle pause / unpause (in place).
  // reset  — seek back to the START point (= "back to the beginning"); we
  //          keep the current play state (reset while playing keeps playing
  //          from START; reset while paused stays paused at START).
  function gateStart(): void {
    const w = currentWindow();
    const pos = w.hasWindow ? w.startSec : (videoEl?.currentTime ?? 0);
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = pos; } catch { /* */ } }
    writeSync({ isPlaying: w.hasWindow, currentPositionSec: pos });
  }
  function gatePause(): void {
    const cur = videoEl?.currentTime ?? lastSyncPosition;
    writeSync({ isPlaying: !isPlaying, currentPositionSec: cur });
  }
  function gateReset(): void {
    const w = currentWindow();
    const pos = w.hasWindow ? w.startSec : 0;
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = pos; } catch { /* */ } }
    writeSync({ isPlaying, currentPositionSec: pos });
  }

  // ---- Sync-driven local element control ----
  //
  // Whenever any of (isPlaying / lastSyncTime / lastSyncPosition) change,
  // bring our local <video> back in line:
  //   - if the shared state says playing but our element is paused, play
  //   - if shared says paused but ours is playing, pause
  //   - if our position drifts > 0.5s off expected, seek
  $effect(() => {
    void isPlaying; void lastSyncTime; void lastSyncPosition;
    if (!videoEl || !hasLocalFile) return;
    const playState = isPlaying;
    if (playState && videoEl.paused) {
      // Programmatic play() can reject on autoplay-policy grounds even
      // after a user has gestured for the page (browsers gate per-element
      // sometimes). Swallow — the next user click on the play button
      // will retry from a fresh gesture.
      void videoEl.play().catch(() => { /* autoplay blocked */ });
    } else if (!playState && !videoEl.paused) {
      try { videoEl.pause(); } catch { /* */ }
    }
    // Multiplayer drift correction extrapolates expected position at +1×
    // forward (the sync model is "play position advances at wallclock").
    // Varispeed / reverse playback breaks that assumption, so we only run
    // drift correction at unity forward speed — varispeed is a local
    // transport mode (play/pause STATE still syncs; position relaxes).
    if (!isUnityForward()) return;
    const decision = decideDriftCorrection(
      { isPlaying: playState, lastSyncTime, lastSyncPosition },
      videoEl.currentTime,
      Date.now(),
      durationSec,
    );
    if (decision.kind === 'seek') {
      try { videoEl.currentTime = decision.to; } catch { /* */ }
    }
  });

  /** True when the effective speed is +1× forward (within a tolerance), i.e.
   *  the multiplayer drift model applies. The default knob (0.5) with no
   *  speed CV yields exactly +1×. */
  function isUnityForward(): boolean {
    return Math.abs(effectiveSpeed() - 1) < 0.02;
  }

  // While playing, the local element advances on its own; we ALSO need
  // a periodic drift check (separate from the sync-state change above)
  // so a local element that's running slow gradually catches up. 500ms
  // is plenty — the threshold is 0.5s, so a check at the same rate
  // bounds total drift at ~1s worst case before correction.
  let driftTimer: ReturnType<typeof setInterval> | null = null;
  function startDriftLoop(): void {
    if (driftTimer !== null) return;
    driftTimer = setInterval(() => {
      if (!videoEl || !hasLocalFile) return;
      if (!isPlaying) return;
      if (!isUnityForward()) return;
      const dec = decideDriftCorrection(
        { isPlaying: true, lastSyncTime, lastSyncPosition },
        videoEl.currentTime,
        Date.now(),
        durationSec,
      );
      if (dec.kind === 'seek') {
        try { videoEl.currentTime = dec.to; } catch { /* */ }
      }
    }, 500);
  }
  function stopDriftLoop(): void {
    if (driftTimer !== null) { clearInterval(driftTimer); driftTimer = null; }
  }

  // ---- Gate input edge detection (rising-edge) ----
  //
  // Each gate routes (via the cross-domain CV bridge) into a synthetic
  // cv_<x> param on the engine module. We poll readParam + detect a rising
  // edge across 0.5, then fire the matching transport action. Polling keeps
  // this single-direction (card observes engine; engine never reaches into
  // the card). Mirrors DOOM's CV-gate plumbing.
  //
  //   play_trigger    → toggle play/pause (legacy; preserved)
  //   cv_start        → (re)start from START
  //   cv_pause        → toggle pause/unpause
  //   cv_reset        → seek to START (back to the beginning)
  //   cv_loop_toggle  → flip LOOP <-> ONE-SHOT
  const lastGate: Record<string, number> = {
    cv_play_trigger: 0,
    cv_start: 0,
    cv_pause: 0,
    cv_reset: 0,
    cv_loop_toggle: 0,
  };
  function risingEdge(paramId: string): boolean {
    const v = readCv(paramId);
    const prev = lastGate[paramId] ?? 0;
    lastGate[paramId] = v;
    return prev < 0.5 && v >= 0.5;
  }
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  function startGateLoop(): void {
    if (gateTimer !== null) return;
    gateTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      if (risingEdge('cv_play_trigger')) gatePause();
      if (risingEdge('cv_start')) gateStart();
      if (risingEdge('cv_pause')) gatePause();
      if (risingEdge('cv_reset')) gateReset();
      if (risingEdge('cv_loop_toggle')) toggleLoop();
    }, 33);
  }
  function stopGateLoop(): void {
    if (gateTimer !== null) { clearInterval(gateTimer); gateTimer = null; }
  }

  // ---- Transport loop (rAF-driven): varispeed + window + loop/oneshot ----
  //
  // Forward varispeed: set <video>.playbackRate to the effective speed; the
  // element advances itself + carries its audio through the MediaElementSource
  // (so audio is pitch+tempo shifted = the varispeed distortion the user
  // wants). HTMLVideoElement clamps playbackRate to ~[0.0625, 16]; ±4 is
  // well inside that + inside the ~[0.25, 4] audible window, so forward
  // audio varispeed is audible/distorted.
  //
  // Reverse (negative speed): HTMLVideoElement can't play backward natively,
  // so we PAUSE the element + scrub currentTime backward each frame by
  // |speed| * dt (rAF-driven). Reverse audio is hard (no native reverse), so
  // we MUTE audio during reverse (documented). On returning to forward we
  // unmute + resume.
  //
  // Window: at the END edge → loop (jump to START) or one-shot (stop). In
  // reverse, the START edge is the wrap point. If START >= END the window is
  // empty → no playback (element paused, holds its last frame).
  let raf: number | null = null;
  let lastRafMs = 0;
  let reverseActive = false;
  function transportTick(nowMs: number): void {
    raf = requestAnimationFrame(transportTick);
    if (!videoEl || !hasLocalFile) { lastRafMs = nowMs; return; }
    const dt = lastRafMs === 0 ? 0 : Math.max(0, (nowMs - lastRafMs) / 1000);
    lastRafMs = nowMs;

    const speed = effectiveSpeed();
    const w = currentWindow();

    // Empty window (START past END) → no playback: hold the element paused.
    if (!w.hasWindow) {
      if (!videoEl.paused) { try { videoEl.pause(); } catch { /* */ } }
      return;
    }

    const forward = speed >= 0;

    // ----- Reverse mode bookkeeping (mute audio while reversing) -----
    if (!forward && !reverseActive) {
      reverseActive = true;
      videoEl.muted = true;                 // no native reverse audio
      try { videoEl.pause(); } catch { /* */ } // we scrub manually
    } else if (forward && reverseActive) {
      reverseActive = false;
      videoEl.muted = false;
    }

    if (!isPlaying) return; // only drive transport while logically playing

    if (forward) {
      // Drive native forward playback at the varispeed rate.
      const rate = Math.max(0.0625, Math.min(16, speed));
      if (Math.abs(videoEl.playbackRate - rate) > 0.001) {
        try { videoEl.playbackRate = rate; } catch { /* */ }
      }
      if (videoEl.paused) void videoEl.play().catch(() => { /* autoplay */ });
    } else {
      // Reverse: scrub currentTime backward by |speed| * dt.
      const back = Math.abs(speed) * dt;
      try { videoEl.currentTime = Math.max(w.startSec, videoEl.currentTime - back); } catch { /* */ }
    }

    // ----- Window edge: loop vs one-shot -----
    const action = decideEdgeAction(videoEl.currentTime, w, forward, loop);
    if (action.kind === 'loop') {
      try { videoEl.currentTime = action.seekTo; } catch { /* */ }
      if (forward && videoEl.paused) void videoEl.play().catch(() => { /* */ });
      writeSync({ isPlaying: true, currentPositionSec: action.seekTo });
    } else if (action.kind === 'stop') {
      try { videoEl.currentTime = action.clampTo; } catch { /* */ }
      try { videoEl.pause(); } catch { /* */ }
      writeSync({ isPlaying: false, currentPositionSec: action.clampTo });
    }
  }
  function startTransportLoop(): void {
    if (raf !== null) return;
    lastRafMs = 0;
    raf = requestAnimationFrame(transportTick);
  }
  function stopTransportLoop(): void {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  // ---- Attach the <video> element to the engine module ----
  //
  // Mirrors CameraInputCard: the factory may not exist yet when the
  // card mounts (engine.addNode is async); poll until it does or we
  // give up after ~5s.
  function attachVideoEl(): void {
    const ve = videoEngine();
    if (!ve || !videoEl) return;
    try { ve.attachExternalSource(id, 'video', videoEl); } catch { /* not ready */ }
  }

  // ---- Mount / unmount ----
  onMount(() => {
    let attempts = 0;
    const attach = setInterval(() => {
      attempts++;
      const ve = videoEngine();
      if (ve && videoEl) {
        try {
          ve.attachExternalSource(id, 'video', videoEl);
          const present = ve.read(id, 'hasVideoElement');
          if (present === true) clearInterval(attach);
        } catch { /* not ready */ }
      }
      if (attempts > 50) clearInterval(attach);
    }, 100);

    startDriftLoop();
    startGateLoop();
    startTransportLoop();
  });

  onDestroy(() => {
    stopDriftLoop();
    stopGateLoop();
    stopTransportLoop();
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    const extras = getExtras();
    extras?.unwireAudio();
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
  });

  // ---- Displayed current position ----
  //
  // While playing, derive it from the sync state + elapsed wallclock
  // (so peers without a local copy still see the seekbar slider move).
  // While paused, just show lastSyncPosition.
  let displayPos = $state(0);
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    if (videoEl && hasLocalFile) {
      displayPos = videoEl.currentTime;
      return;
    }
    if (isPlaying) {
      const elapsed = Math.max(0, (Date.now() - lastSyncTime) / 1000);
      displayPos = Math.min(durationSec || Infinity, lastSyncPosition + elapsed);
    } else {
      displayPos = lastSyncPosition;
    }
  }
  onMount(() => {
    displayTimer = setInterval(refreshDisplay, 100);
  });
  onDestroy(() => {
    if (displayTimer !== null) clearInterval(displayTimer);
  });

  function formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // ---- Reactive transport readouts ----
  let speedMult = $derived(
    speedKnobToMultiplier(effectiveSpeedKnob(paramVal('speed'), readCv('speedCv'))),
  );
  let speedLabel = $derived(`${speedMult >= 0 ? '+' : ''}${speedMult.toFixed(1)}×`);
  // Window validity (START < END). Re-evaluates when the start/end params
  // change. Uses the slider values directly (CV is live + not reactive here;
  // the warning reflects the user's slider intent).
  let windowValid = $derived(
    resolveWindow(durationSec || 1, paramVal('start'), paramVal('end')).hasWindow,
  );

  // ---------- True fullscreen (Fullscreen API) ----------
  // The preview-wrap is the fullscreen element; it holds the live <video>.
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // ---------- Full Frame (in-app, NOT browser fullscreen) ----------
  // Expands the <video> preview to consume the card border, hiding the file
  // picker / transport / seekbar / port labels + jacks; the card stays in
  // the rack + remains resizable. Persisted in node.data.fullFrame (Y.Doc-
  // synced) so a wall-of-TVs layout survives reload + is shareable.
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        (target.data as Record<string, unknown>).fullFrame = on;
      }
    },
    exitFullscreen: () => void fs.exit(),
  });
  let cardEl: HTMLDivElement | null = $state(null);
  $effect(() => ff.attach(cardEl, () => fullFrame));

  // Right-click-on-preview context menu (Fullscreen / Full Frame).
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onPreviewContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  // ---------- Corner-drag resize ----------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          (target.data as Record<string, unknown>).width = w;
          (target.data as Record<string, unknown>).height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }
  onDestroy(() => { if (resizeAbort) resizeAbort.abort(); });
</script>

<div
  bind:this={cardEl}
  class="card video videobox-card"
  class:drag-over={isDragOver}
  class:resizing
  class:full-frame={fullFrame}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="videobox-card"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  data-loop={loop}
  data-full-frame={fullFrame}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
  aria-label="VIDEOBOX video player"
>
  <div class="stripe"></div>
  <header class="title">VIDEOBOX</header>

  <Handle type="target" position={Position.Left}  id="play_trigger" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">TRIG</span>
  <Handle type="target" position={Position.Left}  id="cv_start" style="top: 84px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 78px;">STRT</span>
  <Handle type="target" position={Position.Left}  id="cv_pause" style="top: 112px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 106px;">PAUS</span>
  <Handle type="target" position={Position.Left}  id="cv_reset" style="top: 140px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 134px;">RST</span>
  <Handle type="target" position={Position.Left}  id="cv_loop_toggle" style="top: 168px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 162px;">LOOP</span>
  <Handle type="target" position={Position.Left}  id="speedCv" style="top: 196px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 190px;">SPD</span>
  <Handle type="target" position={Position.Left}  id="startCv" style="top: 224px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 218px;">S-CV</span>
  <Handle type="target" position={Position.Left}  id="endCv" style="top: 252px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 246px;">E-CV</span>

  <Handle type="source" position={Position.Right} id="video"   style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">VID</span>
  <Handle type="source" position={Position.Right} id="audio_l" style="top: 84px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 78px;">A-L</span>
  <Handle type="source" position={Position.Right} id="audio_r" style="top: 112px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 106px;">A-R</span>

  <div class="body">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={wrapEl}
      class="preview-wrap"
      class:fullscreen={fs.isFullscreen}
      class:full-frame={fullFrame}
      data-testid="videobox-fs-wrap"
      oncontextmenu={onPreviewContextMenu}
    >
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        data-testid="videobox-video"
        playsinline
      ></video>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videobox-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && fileMeta}
        <div class="overlay peer-hint" data-testid="videobox-peer-hint">
          <div><strong>{fileMeta.name}</strong></div>
          <div class="sub">loaded by a peer — pick your own copy to play locally</div>
        </div>
      {/if}
    </div>

    <label class="pick-btn" data-testid="videobox-pick-label">
      <input
        type="file"
        accept="video/*"
        onchange={onFileInputChange}
        data-testid="videobox-file-input"
      />
      <span>{hasLocalFile ? 'Pick another video…' : 'Choose video…'}</span>
    </label>

    {#if loadError}
      <div class="error" data-testid="videobox-error">{loadError}</div>
    {/if}

    <div class="transport">
      <button
        type="button"
        class="play-btn"
        onclick={togglePlay}
        data-testid="videobox-play-btn"
        aria-pressed={isPlaying}
      >{isPlaying ? 'Pause' : 'Play'}</button>
      <span class="time" data-testid="videobox-time">
        {formatTime(displayPos)} / {formatTime(durationSec)}
      </span>
    </div>

    <input
      class="seek"
      type="range"
      min="0"
      max={Math.max(0.001, durationSec)}
      step="0.01"
      value={displayPos}
      oninput={onSeek}
      disabled={durationSec <= 0}
      data-testid="videobox-seek"
      aria-label="Video playhead"
    />

    <div class="speed-row">
      <div class="knob-box">
        <Knob
          value={paramVal('speed')}
          min={0} max={1} defaultValue={defaultFor('speed')}
          label="SPEED" curve="linear"
          onchange={setParamFn('speed')} moduleId={id} paramId="speed"
        />
        <div class="speed-readout" data-testid="videobox-speed-readout">{speedLabel}</div>
      </div>
      <button
        type="button"
        class="loop-btn"
        class:on={loop}
        onclick={toggleLoop}
        data-testid="videobox-loop-btn"
        aria-pressed={loop}
        title="Toggle LOOP (jump to START at END) vs ONE-SHOT (stop at END)"
      >{loop ? 'LOOP' : '1-SHOT'}</button>
    </div>

    <div class="window-row">
      <label class="slider-label" for="vb-start-{id}">START</label>
      <input
        id="vb-start-{id}"
        class="window-slider"
        type="range"
        min="0" max="1" step="0.001"
        value={paramVal('start')}
        oninput={(e) => setParamFn('start')(Number((e.target as HTMLInputElement).value))}
        data-testid="videobox-start"
        aria-label="Playback window start"
      />
    </div>
    <div class="window-row">
      <label class="slider-label" for="vb-end-{id}">END</label>
      <input
        id="vb-end-{id}"
        class="window-slider"
        type="range"
        min="0" max="1" step="0.001"
        value={paramVal('end')}
        oninput={(e) => setParamFn('end')(Number((e.target as HTMLInputElement).value))}
        data-testid="videobox-end"
        aria-label="Playback window end"
      />
    </div>
    {#if !windowValid}
      <div class="warn" data-testid="videobox-window-warn">START past END — no playback</div>
    {/if}

    {#if fileMeta}
      <div class="filename" title={fileMeta.name} data-testid="videobox-filename">
        {fileMeta.name}
      </div>
    {/if}
  </div>

  <!-- Bottom-right corner-drag resize handle (nodrag so xyflow's node-drag
       doesn't hijack the pointerdown). -->
  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize VIDEOBOX"
    data-testid="videobox-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="VIDEOBOX"
  onfullscreen={() => { ff.exit(); void fs.enter(); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .card {
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
    /* The body fills the card below the header so the preview-wrap can
     * grow as the card is resized (and to 100% in full-frame). */
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.drag-over {
    border-color: var(--cable-video);
    box-shadow: 0 0 0 2px var(--cable-video), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .port-label {
    position: absolute;
    font-size: 0.55rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }

  .body {
    margin-top: 28px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }

  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    min-height: 160px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    /* Grow to consume the card space above the transport controls so a
     * resized card shows a bigger preview. */
    flex: 1;
  }
  video {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: auto;
    object-fit: contain;
    background: #000;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.85);
    color: var(--text);
    font-size: 0.7rem;
    padding: 8px;
    gap: 4px;
  }
  .overlay .sub {
    color: var(--text-dim);
    font-size: 0.6rem;
  }
  .drop-hint { border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent); }

  .pick-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .pick-btn input { display: none; }
  .pick-btn:hover {
    color: var(--text);
    border-color: #6a7282;
  }

  .error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .play-btn {
    background: var(--cable-video);
    color: #000;
    border: none;
    border-radius: 2px;
    padding: 3px 10px;
    font-size: 0.7rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    min-width: 56px;
  }
  .play-btn:hover { filter: brightness(1.1); }
  .time {
    font-size: 0.65rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }

  .seek {
    width: 100%;
    accent-color: var(--cable-video);
  }
  .seek:disabled { opacity: 0.5; }

  .filename {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .speed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
  }
  .knob-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .speed-readout {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    min-width: 52px;
    text-align: center;
  }
  .loop-btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    padding: 5px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    min-width: 56px;
  }
  .loop-btn:hover { border-color: var(--accent-dim); }
  .loop-btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .window-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .slider-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    width: 36px;
    flex: none;
  }
  .window-slider {
    flex: 1;
    accent-color: var(--cable-cv);
  }
  .warn {
    font-size: 0.6rem;
    color: #ffb347;
    font-family: ui-monospace, monospace;
  }

  /* ---------- True fullscreen (Fullscreen API) ---------- */
  .preview-wrap.fullscreen {
    width: 100%;
    height: 100%;
    background: #000;
    aspect-ratio: auto;
  }
  .preview-wrap.fullscreen video {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    cursor: pointer;
  }

  /* ---------- FULL FRAME (in-app, NOT browser fullscreen) ---------- */
  /* The <video> preview consumes the whole card border; hide the title,
   * stripe, port labels, file picker, transport + seekbar so the card shows
   * only video. Stays in the rack + resizable; double-click exits. */
  .card.full-frame {
    padding: 0;
  }
  .card.full-frame .title,
  .card.full-frame .stripe,
  .card.full-frame .port-label,
  .card.full-frame .pick-btn,
  .card.full-frame .transport,
  .card.full-frame .seek,
  .card.full-frame .speed-row,
  .card.full-frame .window-row,
  .card.full-frame .warn,
  .card.full-frame .filename,
  .card.full-frame .error {
    display: none;
  }
  /* Hide the card's OWN Svelte Flow jacks while full-frame — keep them in
   * the DOM (opacity/pointer-events, not display:none) so existing cables
   * stay connected; we hide, not remove. */
  .card.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame .body {
    margin-top: 0;
    padding: 0;
    gap: 0;
  }
  .preview-wrap.full-frame {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 0;
    background: #000;
    aspect-ratio: auto;
    cursor: pointer;
  }
  .preview-wrap.full-frame video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  /* Keep the peer-hint overlay legible if a peer loaded a file we can't
   * play locally — but the drop-hint should vanish so full-frame is clean. */
  .card.full-frame .drop-hint {
    display: none;
  }

  /* ---------- Corner-drag resize handle ---------- */
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
