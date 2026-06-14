<script lang="ts">
  // VideoVarispeedCard — local-file video player with a PERFORMANT varispeed
  // transport. The performant redo of the rolled-back VIDEOBOX #291.
  //
  // The card owns the <video> element + the object-URL for the picked File;
  // the engine module (videovarispeed.ts) samples that element into its FBO
  // via requestVideoFrameCallback (so the output streams at ANY speed —
  // the upload cadence is the element's own decode cadence, NOT playbackRate)
  // and routes audio into the cross-domain bridge after wireAudio().
  //
  // Transport (driven by this card's rAF loop):
  //   * Forward varispeed -> <video>.playbackRate (native, cheap; audio
  //     pitch/tempo-shifts = varispeed distortion).
  //   * Reverse -> THROTTLED currentTime scrub (~10 Hz, NOT per-frame) so the
  //     decoder never floods + the main thread never stalls. Audio muted in
  //     reverse (no native reverse audio).
  //   * START/END window + loop/one-shot + CV gates per videovarispeed-
  //     transport.ts.
  //
  // Play state + loop + fileMeta live on node.data so they persist across
  // reload. CV-connection lookups are cached (recomputed only when the edge
  // set changes) so the hot rAF loop never scans the patch.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    videoVarispeedDef,
    type VideoVarispeedHandleExtras,
    type VideoVarispeedData,
  } from '$lib/video/modules/videovarispeed';
  import type { VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
  import {
    speedKnobToMultiplier,
    effectiveSpeedKnob,
    effectiveStartFraction,
    effectiveEndFraction,
    resolveWindow,
    decideEdgeAction,
    reverseScrubStep,
  } from '$lib/video/modules/videovarispeed-transport';
  import {
    canPersistVideoHandles,
    newVideoFileId,
    putVideoFileHandle,
    getVideoFileHandle,
    deleteVideoFileHandle,
    queryHandleReadPermission,
    requestHandleReadPermission,
    type StoredFileHandle,
  } from '$lib/video/video-file-store';
  import {
    registerVideoExport,
    unregisterVideoExport,
  } from '$lib/video/video-export-registry';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow drill-down
  //      standard; also gives the card its rear-view back panel). Port `id`s are
  //      BYTE-IDENTICAL to the module def so the CV bridge + persisted edges
  //      route unchanged; only the rendering moved into the panel. ----
  const inputs: PortDescriptor[] = [
    { id: 'cv_start', label: 'START', cable: 'gate' },
    { id: 'cv_pause', label: 'PAUSE', cable: 'gate' },
    { id: 'cv_reset', label: 'RESET', cable: 'gate' },
    { id: 'cv_loop_toggle', label: 'LOOP', cable: 'gate' },
    { id: 'speedCv', label: 'SPEED', cable: 'cv' },
    { id: 'startCv', label: 'START CV', cable: 'cv' },
    { id: 'endCv', label: 'END CV', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'video', label: 'VIDEO', cable: 'video' },
    { id: 'audio_l', label: 'AUDIO L', cable: 'audio' },
    { id: 'audio_r', label: 'AUDIO R', cable: 'audio' },
  ];

  // ---- DOM refs + local state ----
  let videoEl: HTMLVideoElement | null = $state(null);
  let objectUrl: string | null = null;
  let localFileName = $state<string | null>(null);
  let isDragOver = $state(false);
  let loadError = $state<string | null>(null);

  // ---- Persistence: remembered file handle (Chromium) + re-link fallback ----
  // Mirrors VIDEOBOX: a picked/dropped FileSystemFileHandle is stashed in
  // IndexedDB keyed by an id stamped into fileMeta.handleId; on patch / perf-zip
  // load we reload that exact file (or the seeded blob the zip carried) so the
  // clip plays again WITHOUT a re-pick. Firefox / Safari never produce a handle
  // and fall back to the re-link prompt only.
  const canRememberHandle = canPersistVideoHandles();
  let pendingHandle = $state<StoredFileHandle | null>(null);
  let handleReloadAttempted = false;

  // ---- Reactive reads from data (Yjs-backed) ----
  let fileMeta = $derived<VideoboxFileMeta | null>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.fileMeta ?? null,
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.isPlaying ?? false,
  );
  let durationSec = $derived<number>(fileMeta?.duration ?? 0);
  let loop = $derived<boolean>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.loop ?? true,
  );

  /** Track whether THIS browser has loaded a local copy of the file. */
  let hasLocalFile = $derived<boolean>(localFileName !== null);

  // ---- Transport param accessors (knob + sliders live on node.params) ----
  function defaultFor(k: string): number {
    return videoVarispeedDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const setParamFn = (k: string) => (v: number): void => {
    setNodeParam(id, k, v);
  };

  // ---- CV-connection detection (CACHED) ----
  //
  // END CV normals to +1 (unpatched END = full duration); START CV normals
  // to 0. We only sum a CV offset into a slider when its port has an incoming
  // edge. The hot rAF loop must NOT scan the patch every frame, so we compute
  // these reactively (recomputed only when the edge set changes) + read the
  // cached booleans in the loop.
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

  // ---- Extras / engine helpers ----
  function getExtras(): VideoVarispeedHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as VideoVarispeedHandleExtras | undefined) ?? null;
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

  // ---- data writers ----
  function writePlaying(next: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<VideoVarispeedData>).isPlaying = next;
    }, LOCAL_ORIGIN);
  }
  function writeFileMeta(meta: VideoboxFileMeta): void {
    // Drop a stale remembered handle in THIS browser's IDB if the id changes
    // (a fresh pick); a reload reuses the same id, so no churn there.
    const prevId = fileMeta?.handleId;
    if (prevId && prevId !== meta.handleId) {
      void deleteVideoFileHandle(prevId);
    }
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoVarispeedData>;
      d.fileMeta = meta;
      d.isPlaying = false;
    }, LOCAL_ORIGIN);
  }
  function writeLoop(next: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<VideoVarispeedData>).loop = next;
    }, LOCAL_ORIGIN);
  }
  function toggleLoop(): void { writeLoop(!loop); }

  // ---- File-picker handling ----
  //
  // `opts.handle` — a FileSystemFileHandle to persist for one-click reload (from
  //   showOpenFilePicker / a drop that exposed getAsFileSystemHandle, or the
  //   synthetic blob-handle the perf-zip loader seeds).
  // `opts.reuseHandleId` — reload from an existing remembered handle: keep the
  //   patch's existing handleId rather than minting a new one.
  async function loadFile(
    file: File,
    opts?: { handle?: StoredFileHandle | null; reuseHandleId?: string },
  ): Promise<void> {
    loadError = null;
    pendingHandle = null;
    if (!file.type.startsWith('video/')) {
      loadError = `Not a video file: ${file.type || file.name}`;
      return;
    }
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
    objectUrl = URL.createObjectURL(file);
    localFileName = file.name;
    // Register this node's bytes resolver for the portable "Export performance"
    // (.zip) path — the exporter (Canvas) collects loaded video bytes across ALL
    // video cards via this registry. Mirrors VIDEOBOX exactly. The closure
    // re-reads objectUrl/localFileName so a later swap is reflected.
    registerVideoExport(id, async () => {
      const url = objectUrl;
      if (!url) return null;
      const resp = await fetch(url);
      const ab = await (await resp.blob()).arrayBuffer();
      return { bytes: new Uint8Array(ab), name: localFileName ?? file.name };
    });
    if (!videoEl) return;
    videoEl.src = objectUrl;
    videoEl.muted = false;

    await new Promise<void>((resolve) => {
      if (!videoEl) { resolve(); return; }
      if (videoEl.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
      const onMeta = (): void => { videoEl?.removeEventListener('loadedmetadata', onMeta); resolve(); };
      videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
    });
    if (!videoEl) return;

    // Persist the handle (if we have one + the browser supports it) BEFORE
    // writing fileMeta so the stamped handleId is the one the handle is stored
    // under. On the perf-zip path the loader has already seeded a blob handle
    // under `bundle-<nodeId>` (reuseHandleId), so we just re-stamp the same id.
    let handleId: string | undefined = opts?.reuseHandleId;
    if (opts?.handle && canRememberHandle) {
      if (!handleId) handleId = newVideoFileId();
      await putVideoFileHandle(handleId, opts.handle);
    }

    writeFileMeta({
      name: file.name,
      duration: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
      size: Number.isFinite(file.size) ? file.size : undefined,
      handleId,
    });

    // Force a first frame to decode so the output streams immediately even
    // before play (rVFC fires on the first decoded frame).
    try { videoEl.currentTime = 0; } catch { /* */ }

    ensureAudioWired();
  }

  // ---- Persistence: reload from a remembered handle on patch / perf-zip load ----
  //
  // After a load, fileMeta may carry a handleId pointing at a handle THIS
  // browser persisted, OR the synthetic blob handle the perf-zip loader seeded
  // (putVideoFileBlob under `bundle-<nodeId>`). Same flow as VIDEOBOX:
  //   - granted  → reload immediately (no re-pick);
  //   - prompt   → stash for a one-click re-allow gesture;
  //   - missing / denied → re-link prompt covers it.
  async function tryReloadFromHandle(): Promise<void> {
    const hid = fileMeta?.handleId;
    if (!hid || hasLocalFile) return;
    const handle = await getVideoFileHandle(hid);
    if (!handle) return; // not in this browser → re-link prompt path
    const perm = await queryHandleReadPermission(handle);
    if (perm === 'granted') {
      try {
        const file = await handle.getFile();
        await loadFile(file, { handle, reuseHandleId: hid });
      } catch { /* file moved/gone — re-link prompt takes over */ }
      return;
    }
    if (perm === 'prompt') pendingHandle = handle;
    // 'denied' → re-link prompt covers it.
  }

  // One-click "re-allow": request read permission inside this click gesture,
  // then reload. Bound to the re-allow button.
  async function onReAllow(): Promise<void> {
    const handle = pendingHandle;
    const hid = fileMeta?.handleId;
    if (!handle) return;
    const perm = await requestHandleReadPermission(handle);
    if (perm === 'granted') {
      pendingHandle = null;
      try {
        const file = await handle.getFile();
        await loadFile(file, { handle, reuseHandleId: hid ?? undefined });
        return;
      } catch { /* fall through to re-link */ }
    }
    pendingHandle = null;
  }

  // Re-link prompt visibility: saved fileMeta exists (a file was loaded at save)
  // but THIS browser has no local copy + no usable handle.
  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandle === null,
  );

  // Run the handle-reload attempt once fileMeta.handleId becomes available.
  $effect(() => {
    void fileMeta?.handleId;
    if (handleReloadAttempted) return;
    if (!fileMeta?.handleId) return;
    if (hasLocalFile) return;
    handleReloadAttempted = true;
    void tryReloadFromHandle();
  });

  // Wire the element's audio into the engine, RETRYING until it sticks.
  //
  // wireAudio() can no-op for two reasons that are both transient at file-load
  // time: (a) getExtras() returns null because the engine hasn't materialized
  // this card's video node yet (the reconciler runs async to the card, and is
  // slower to settle when a cross-domain audio edge is already present), and
  // (b) the factory's own <video> reference isn't set yet because
  // attachExternalSource (driven by the onMount poll) hasn't run. Calling
  // wireAudio exactly once (the old behaviour) lost this race and left audio_l /
  // audio_r stuck on the silent placeholder forever -> the operator's downstream
  // AUDIO-OUT patch was silent. wireAudio() is idempotent (guards on its own
  // audioWired flag), so retrying until isAudioWired() reports true is safe and
  // converges as soon as both the handle and the element are ready.
  let audioWireTimer: ReturnType<typeof setTimeout> | null = null;
  function ensureAudioWired(attempt = 0): void {
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    if (!hasLocalFile) return; // file was cleared; nothing to wire
    const extras = getExtras();
    extras?.wireAudio();
    if (extras?.isAudioWired()) return;
    if (attempt >= 50) return; // ~5s of 100ms retries; give up quietly
    audioWireTimer = setTimeout(() => ensureAudioWired(attempt + 1), 100);
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // The native <input type=file> can't hand us a FileSystemFileHandle, so a
    // pick through this path gets no remembered-handle persistence (only
    // fileMeta + the export resolver). The picker button path uses
    // showOpenFilePicker when available to also persist a handle.
    if (file) void loadFile(file);
    try { input.value = ''; } catch { /* */ }
  }

  // Picker button: prefer showOpenFilePicker (Chromium) so we capture a
  // FileSystemFileHandle to remember; fall back to the native <input>.
  async function pickViaPicker(): Promise<boolean> {
    if (!canRememberHandle) return false;
    const picker = (globalThis as {
      showOpenFilePicker?: (opts?: unknown) => Promise<StoredFileHandle[]>;
    }).showOpenFilePicker;
    if (typeof picker !== 'function') return false;
    try {
      const handles = await picker({
        multiple: false,
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.webm', '.mov', '.m4v', '.ogv'] } }],
      });
      const handle = handles?.[0];
      if (!handle) return true; // user cancelled — still "handled"
      const file = await handle.getFile();
      await loadFile(file, { handle });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        loadError = `Could not open file: ${(e as Error)?.message ?? 'unknown error'}`;
      }
    }
    return true;
  }
  function onPickClick(ev: MouseEvent): void {
    if (!canRememberHandle) return; // let the native <input> handle it
    ev.preventDefault();
    void pickViaPicker();
  }

  function onDragOver(ev: DragEvent): void { ev.preventDefault(); isDragOver = true; }
  function onDragLeave(): void { isDragOver = false; }
  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    isDragOver = false;
    // Try to grab a FileSystemFileHandle (Chromium) so a dropped file is also
    // remembered for one-click reload.
    const item = ev.dataTransfer?.items?.[0];
    let handle: StoredFileHandle | null = null;
    const getHandle = (item as unknown as {
      getAsFileSystemHandle?: () => Promise<StoredFileHandle | null>;
    })?.getAsFileSystemHandle;
    if (canRememberHandle && typeof getHandle === 'function') {
      try {
        const h = await getHandle.call(item);
        if (h && h.kind === 'file') handle = h;
      } catch { /* fall back to the plain File below */ }
    }
    const file = handle ? await handle.getFile().catch(() => null) : ev.dataTransfer?.files?.[0];
    if (file) void loadFile(file, { handle });
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

  // ---- Play / pause / seek (manual UI) ----
  function togglePlay(): void {
    if (!videoEl) { writePlaying(!isPlaying); return; }
    writePlaying(!isPlaying);
  }
  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = target; } catch { /* */ } }
  }

  // ---- Gate actions ----
  function gateStart(): void {
    const w = currentWindow();
    const pos = w.hasWindow ? w.startSec : (videoEl?.currentTime ?? 0);
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = pos; } catch { /* */ } }
    writePlaying(w.hasWindow);
  }
  function gatePause(): void { writePlaying(!isPlaying); }
  function gateReset(): void {
    const w = currentWindow();
    const pos = w.hasWindow ? w.startSec : 0;
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = pos; } catch { /* */ } }
  }

  // ---- Gate input edge detection (rising-edge, polled) ----
  const lastGate: Record<string, number> = {
    cv_start: 0, cv_pause: 0, cv_reset: 0, cv_loop_toggle: 0,
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
  // Forward varispeed: set <video>.playbackRate; the element advances itself.
  // Reverse: THROTTLED currentTime scrub (~10 Hz via reverseScrubStep) — NOT
  // per-frame; per-frame scrubbing is what killed #291's perf + froze the
  // downstream texture. The rAF loop only does cheap arithmetic + at most one
  // playbackRate write or one throttled seek per tick — no per-frame
  // allocations, no per-frame patch scans (CV-connection booleans are cached).
  let raf: number | null = null;
  let reverseActive = false;
  let reverseAccumMs = 0;
  let lastRafMs = 0;
  function transportTick(nowMs: number): void {
    raf = requestAnimationFrame(transportTick);
    if (!videoEl || !hasLocalFile) { lastRafMs = nowMs; return; }
    const dt = lastRafMs === 0 ? 0 : Math.max(0, nowMs - lastRafMs);
    lastRafMs = nowMs;

    const speed = effectiveSpeed();
    const w = currentWindow();

    // Empty window (START past END) -> no playback: hold the element paused.
    if (!w.hasWindow) {
      if (!videoEl.paused) { try { videoEl.pause(); } catch { /* */ } }
      return;
    }

    const forward = speed >= 0;

    // Reverse-mode bookkeeping (mute audio while reversing; pause native).
    if (!forward && !reverseActive) {
      reverseActive = true;
      reverseAccumMs = 0;
      videoEl.muted = true;
      try { videoEl.pause(); } catch { /* */ }
    } else if (forward && reverseActive) {
      reverseActive = false;
      videoEl.muted = false;
    }

    if (!isPlaying) return;

    if (forward) {
      const rate = Math.max(0.0625, Math.min(16, speed));
      if (Math.abs(videoEl.playbackRate - rate) > 0.001) {
        try { videoEl.playbackRate = rate; } catch { /* */ }
      }
      if (videoEl.paused) void videoEl.play().catch(() => { /* autoplay */ });
    } else {
      // Throttled reverse scrub: accumulate elapsed ms, seek at most once per
      // REVERSE_SCRUB_INTERVAL_MS. Each seek covers the accumulated ground so
      // the average reverse rate stays correct while issuing ~10 seeks/sec.
      reverseAccumMs += dt;
      const step = reverseScrubStep(videoEl.currentTime, Math.abs(speed), reverseAccumMs, w.startSec);
      if (step.seek) {
        reverseAccumMs = 0;
        try { videoEl.currentTime = step.toSec; } catch { /* */ }
      }
    }

    // Window edge: loop vs one-shot.
    const action = decideEdgeAction(videoEl.currentTime, w, forward, loop);
    if (action.kind === 'loop') {
      try { videoEl.currentTime = action.seekTo; } catch { /* */ }
      if (forward && videoEl.paused) void videoEl.play().catch(() => { /* */ });
    } else if (action.kind === 'stop') {
      try { videoEl.currentTime = action.clampTo; } catch { /* */ }
      try { videoEl.pause(); } catch { /* */ }
      writePlaying(false);
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

  // ---- Sync data.isPlaying -> element play/pause (manual + gate) ----
  $effect(() => {
    void isPlaying;
    if (!videoEl || !hasLocalFile) return;
    const speed = effectiveSpeed();
    if (isPlaying && videoEl.paused && speed >= 0) {
      void videoEl.play().catch(() => { /* autoplay blocked */ });
    } else if (!isPlaying && !videoEl.paused) {
      try { videoEl.pause(); } catch { /* */ }
    }
  });

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

    startGateLoop();
    startTransportLoop();
  });

  onDestroy(() => {
    stopGateLoop();
    stopTransportLoop();
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    const extras = getExtras();
    extras?.unwireAudio();
    unregisterVideoExport(id);
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
  });

  // ---- Displayed current position ----
  let displayPos = $state(0);
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    if (videoEl && hasLocalFile) { displayPos = videoEl.currentTime; return; }
    displayPos = 0;
  }
  onMount(() => { displayTimer = setInterval(refreshDisplay, 100); });
  onDestroy(() => { if (displayTimer !== null) clearInterval(displayTimer); });

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
  let windowValid = $derived(
    resolveWindow(durationSec || 1, paramVal('start'), paramVal('end')).hasWindow,
  );
</script>

<div
  class="card video videovarispeed-card"
  class:drag-over={isDragOver}
  data-testid="videovarispeed-card"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  data-loop={loop}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
  aria-label="VIDEOVARISPEED video player"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="VIDEOVARISPEED" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="body">
    <div class="preview-wrap" data-testid="videovarispeed-preview">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={videoEl} data-testid="videovarispeed-video" playsinline></video>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videovarispeed-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && pendingHandle}
        <!-- One-click re-allow: a remembered handle exists but its read
             permission lapsed. Re-grant + reload in a single user gesture. -->
        <div class="overlay reallow-hint" data-testid="videovarispeed-reallow-hint">
          <div><strong>{fileMeta?.name}</strong></div>
          <button
            type="button"
            class="reallow-btn"
            onclick={onReAllow}
            data-testid="videovarispeed-reallow-btn"
          >Click to re-allow {fileMeta?.name}</button>
        </div>
      {:else if showRelinkPrompt}
        <!-- Re-link fallback (no usable handle / cross-machine): re-pick the
             clip. On Chromium onPickClick uses showOpenFilePicker so the
             re-picked file gets a fresh remembered handle. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
        <label
          class="overlay relink-hint"
          data-testid="videovarispeed-relink-hint"
          onclick={onPickClick}
        >
          <input type="file" accept="video/*" onchange={onFileInputChange} data-testid="videovarispeed-relink-input" />
          <div class="relink-label">Re-link: drop "{fileMeta?.name}"</div>
        </label>
      {/if}
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <label class="pick-btn" data-testid="videovarispeed-pick-label" onclick={onPickClick}>
      <input
        type="file"
        accept="video/*"
        onchange={onFileInputChange}
        data-testid="videovarispeed-file-input"
      />
      <span>{hasLocalFile ? 'Pick another video…' : 'Choose video…'}</span>
    </label>

    {#if loadError}
      <div class="error" data-testid="videovarispeed-error">{loadError}</div>
    {/if}

    <div class="transport">
      <button
        type="button"
        class="play-btn"
        onclick={togglePlay}
        data-testid="videovarispeed-play-btn"
        aria-pressed={isPlaying}
      >{isPlaying ? 'Pause' : 'Play'}</button>
      <span class="time" data-testid="videovarispeed-time">
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
      data-testid="videovarispeed-seek"
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
        <div class="speed-readout" data-testid="videovarispeed-speed-readout">{speedLabel}</div>
      </div>
      <button
        type="button"
        class="loop-btn"
        class:on={loop}
        onclick={toggleLoop}
        data-testid="videovarispeed-loop-btn"
        aria-pressed={loop}
        title="Toggle LOOP (jump to START at END) vs ONE-SHOT (stop at END)"
      >{loop ? 'LOOP' : '1-SHOT'}</button>
    </div>

    <div class="window-row">
      <label class="slider-label" for="vvs-start-{id}">START</label>
      <input
        id="vvs-start-{id}"
        class="window-slider"
        type="range"
        min="0" max="1" step="0.001"
        value={paramVal('start')}
        oninput={(e) => setParamFn('start')(Number((e.target as HTMLInputElement).value))}
        data-testid="videovarispeed-start"
        aria-label="Playback window start"
      />
    </div>
    <div class="window-row">
      <label class="slider-label" for="vvs-end-{id}">END</label>
      <input
        id="vvs-end-{id}"
        class="window-slider"
        type="range"
        min="0" max="1" step="0.001"
        value={paramVal('end')}
        oninput={(e) => setParamFn('end')(Number((e.target as HTMLInputElement).value))}
        data-testid="videovarispeed-end"
        aria-label="Playback window end"
      />
    </div>
    {#if !windowValid}
      <div class="warn" data-testid="videovarispeed-window-warn">START past END — no playback</div>
    {/if}

    {#if fileMeta}
      <div class="filename" title={fileMeta.name} data-testid="videovarispeed-filename">
        {fileMeta.name}
      </div>
    {/if}
  </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 420px;
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
    display: flex;
    flex-direction: column;
  }
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
    min-height: 140px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
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
  .overlay .sub { color: var(--text-dim); font-size: 0.6rem; }
  .drop-hint { border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent); }

  /* Re-allow affordance (remembered handle, lapsed permission). */
  .reallow-hint { gap: 8px; }
  .reallow-btn {
    background: var(--cable-video);
    color: #000;
    border: none;
    border-radius: 2px;
    padding: 5px 12px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.03em;
    max-width: 90%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reallow-btn:hover { filter: brightness(1.1); }

  /* Re-link prompt (no usable handle — re-pick your own copy). */
  .relink-hint {
    cursor: pointer;
    border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent);
    gap: 6px;
  }
  .relink-hint input { display: none; }
  .relink-label {
    color: var(--text);
    font-size: 0.7rem;
    max-width: 92%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .relink-hint:hover .relink-label { text-decoration: underline; }

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
  .pick-btn:hover { color: var(--text); border-color: #6a7282; }

  .error { font-size: 0.6rem; color: #ff6b6b; font-family: ui-monospace, monospace; }

  .transport { display: flex; align-items: center; gap: 8px; }
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
  .time { font-size: 0.65rem; color: var(--text-dim); font-family: ui-monospace, monospace; }

  .seek { width: 100%; accent-color: var(--cable-video); }
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
  .knob-box { display: flex; flex-direction: column; align-items: center; gap: 2px; }
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
  .window-row { display: flex; align-items: center; gap: 8px; }
  .slider-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    width: 36px;
    flex: none;
  }
  .window-slider { flex: 1; accent-color: var(--cable-cv); }
  .warn { font-size: 0.6rem; color: #ffb347; font-family: ui-monospace, monospace; }
</style>
