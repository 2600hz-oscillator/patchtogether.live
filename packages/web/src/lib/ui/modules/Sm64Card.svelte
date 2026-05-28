<script lang="ts">
  // Sm64Card — host shell around the upstream sm64js webpack bundle.
  //
  // The bundle was authored as a single-page app: it expects a fixed set of
  // DOM ids at module-eval time (`#gameCanvas`, `#fullCanvas`, `#mapSelect`,
  // `#startbutton`, `#rom`, `#romSelect`, `#romFile`, `#romMessage`,
  // `#mainContent`, `#fps`, `#slider`, `#maxFps`, `#timing-total`) and a
  // jQuery + bootstrap-popover global (`window.$`). It also exports two
  // functions we need (`produceOneFrame`, `playerInputUpdate`) only as
  // *closures inside the bundle*. We surface them by injecting a tiny shim
  // BEFORE the bundle runs that:
  //
  //   1. Plants the DOM scaffold inside the card (so the bundle's
  //      `document.querySelector('#gameCanvas')` in WebGLInstance's eval
  //      resolves to OUR canvas — NOT a global window-level one).
  //   2. Defines `window.$` as a lightweight jQuery-like shim that supports
  //      ONLY the surface the bundle actually uses ($('#x').clone() /
  //      .detach() / .popover() / .show() / .hide()) — keeps us off
  //      jQuery+Bootstrap+Popper (~150KB of CDN deps).
  //   3. After the bundle script tag loads, monkey-patches the bundle's
  //      `playerInputUpdate` (resolved via the bundle's webpack runtime —
  //      see resolveBundleExport) to a no-op and exposes `produceOneFrame`
  //      on `window.__sm64.produceOneFrame`. The audio-domain factory in
  //      sm64.ts then writes `window.playerInput` + calls produceOneFrame
  //      once per scheduler tick.
  //
  // ROM-extract UX: if `IDB.get('assets')` is null on mount we just leave
  // the upstream's #rom dropzone visible (it carries its own submit
  // handler). On success the upstream's flow flips #startbutton enabled +
  // hides #rom, AND sets `window.__sm64.romPresent = true` so the audio
  // factory's BOOT NOTE arms the auto-start synthetic pulse.
  //
  // maxInstances:1 lets us assume there is exactly one SM64 card mounted
  // at a time, so we install the bridge + load the bundle on mount and
  // tear it down on unmount. A second mount during a hot-reload would
  // overwrite the bridge — that's fine, the old factory is gone too.

  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    SM64_IDB_KEY,
    shouldAutoDownsample,
    type Sm64Snapshot,
  } from '$lib/audio/modules/sm64';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const inputs: PortDescriptor[] = [
    { id: 'stick_x_cv',   label: 'STICK X',     cable: 'cv' },
    { id: 'stick_y_cv',   label: 'STICK Y',     cable: 'cv' },
    { id: 'a_gate',       label: 'A (GATE)',    cable: 'gate' },
    { id: 'b_gate',       label: 'B (GATE)',    cable: 'gate' },
    { id: 'z_gate',       label: 'Z (GATE)',    cable: 'gate' },
    { id: 'r_gate',       label: 'R (GATE)',    cable: 'gate' },
    { id: 'c_up_gate',    label: 'C-UP (GATE)', cable: 'gate' },
    { id: 'c_down_gate',  label: 'C-DN (GATE)', cable: 'gate' },
    { id: 'c_left_gate',  label: 'C-L (GATE)',  cable: 'gate' },
    { id: 'c_right_gate', label: 'C-R (GATE)',  cable: 'gate' },
    { id: 'start_gate',   label: 'START (GATE)',cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [];

  // ---- Canvas sizing -------------------------------------------------------
  // Internal canvas resolution. Auto-downsample on mobile / low-core devices
  // per the spec: 1024-or-narrower viewport OR <8 logical cores → 320×240.
  // Otherwise stay at the upstream default 640×480. Internal logic, no user
  // knob.
  function pickCanvasRes(): { width: number; height: number } {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return { width: 640, height: 480 };
    }
    const narrow = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1024px)').matches
      : false;
    const cores = navigator.hardwareConcurrency ?? 0;
    if (shouldAutoDownsample(cores, narrow)) return { width: 320, height: 240 };
    return { width: 640, height: 480 };
  }
  const RES = pickCanvasRes();
  // Display size in the card (CSS px). The card surface is ~320×240; the
  // internal backing is RES (640×480 on desktop). Image-rendering pixelated.
  const CSS_W = 320;
  const CSS_H = 240;

  // ---- Host DOM scaffold ---------------------------------------------------
  // We bind the upstream's required ids to THESE elements. Refs are filled
  // in by Svelte's bind:this so we can hand them to the bridge after mount.
  let cardEl: HTMLDivElement | null = $state(null);
  let gameCanvasEl: HTMLCanvasElement | null = $state(null);
  let fullCanvasEl: HTMLCanvasElement | null = $state(null);
  let romDivEl: HTMLDivElement | null = $state(null);
  let romFormEl: HTMLFormElement | null = $state(null);
  let romFileInputEl: HTMLInputElement | null = $state(null);
  let romMessageEl: HTMLElement | null = $state(null);
  let startButtonEl: HTMLButtonElement | null = $state(null);
  let mapSelectEl: HTMLSelectElement | null = $state(null);
  let mainContentEl: HTMLDivElement | null = $state(null);
  let fpsEl: HTMLSpanElement | null = $state(null);
  let sliderEl: HTMLInputElement | null = $state(null);
  let maxFpsEl: HTMLElement | null = $state(null);
  let timingTotalEl: HTMLElement | null = $state(null);

  // ---- Snapshot loop -------------------------------------------------------
  // Surfaces engine state (tick / rom present / game started) for the
  // playwright spec + any future card overlay. Cheap rAF poll.
  let snapshot = $state<Sm64Snapshot | null>(null);
  let snapRaf: number | null = null;
  function pollSnapshot(): void {
    const eng = engineCtx.get();
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as Sm64Snapshot | undefined;
      if (snap) snapshot = snap;
    }
    snapRaf = requestAnimationFrame(pollSnapshot);
  }

  // ---- Bundle lifecycle ----------------------------------------------------
  let loadStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let loadError = $state<string | null>(null);
  let scriptTagEl: HTMLScriptElement | null = null;
  let cssLinkEl: HTMLLinkElement | null = null;

  /** Install the global bridge — `window.$`, `window.__sm64`, the upstream's
   *  expected globals (`window.kill`, `window.cheats`, `window.fullWindowMode`,
   *  `window.debugMarioYaw/X/Y/Z`). Idempotent: a stale bridge from a previous
   *  card mount is overwritten. */
  function installSm64Bridge(): void {
    const w = globalThis as unknown as Record<string, unknown>;
    // ----- Lightweight jQuery shim -----
    // The bundle uses jQuery for FOUR things:
    //   $('selector').popover({...}) / .popover('show'|'hide')
    //   $('#elem').clone()
    //   $('#elem').detach()
    //   $('selector') iterable + .each()
    // None of these need the real jQuery; we ship a 60-line shim.
    if (typeof w.$ !== 'function') {
      const jqShim = (selector: unknown): JQueryishHandle => {
        let els: Element[] = [];
        if (typeof selector === 'string') {
          els = Array.from(document.querySelectorAll(selector));
        } else if (selector instanceof Element) {
          els = [selector];
        }
        return makeJQueryish(els);
      };
      w.$ = jqShim;
      // The bundle also references `jQuery` in a couple of guarded paths.
      (w as Record<string, unknown>).jQuery = jqShim;
    }

    // ----- Upstream globals the bundle pokes during eval -----
    if (w.kill === undefined) w.kill = false;
    if (w.cheats === undefined) {
      w.cheats = { disableFallDamage: false, disableSlopePhysics: false, healOnWarp: false };
    }
    if (w.fullWindowMode === undefined) w.fullWindowMode = false;
    // window.playerInput must exist as an object before player_input_manager
    // evaluates (its first `window.playerInput.buttonDownA` reads it).
    if (w.playerInput === undefined) w.playerInput = {};

    // ----- Our own bridge namespace -----
    // The audio factory in sm64.ts writes to / reads from `window.__sm64.*`.
    // Pre-populate fields so the factory's optional-chain reads (no-op
    // before the bundle resolves) are well-defined.
    const bridge: Sm64Bridge = {
      romPresent: false,
      gameStarted: false,
      setPlayerInput(input) {
        // Mirror into the bundle's expected global. The bundle reads
        // window.playerInput directly inside its frame step (e.g. Mario
        // input handlers); writing here BEFORE produceOneFrame is the
        // step-extraction contract.
        (globalThis as unknown as { playerInput: unknown }).playerInput = input;
      },
      produceOneFrame: undefined,
      autoStart: undefined,
    };
    w.__sm64 = bridge;
  }

  /** Resolve `produce_one_frame` + `playerInputUpdate` out of the loaded
   *  bundle's webpack runtime. Both are exported as top-level consts in the
   *  bundle's index.js, but webpack tree-shakes them into closure scope so
   *  they aren't on window by default. We work around this by re-loading
   *  the bundle through an iframe-style global capture: the upstream's
   *  `produce_one_frame` is referenced from `on_anim_frame` which IS
   *  attached via `requestAnimationFrame` after `main_func()`. The cleanest
   *  hook is to monkey-patch `requestAnimationFrame` BEFORE the bundle
   *  evaluates so we capture the very first scheduled callback (which IS
   *  the bundle's `on_anim_frame`), then CANCEL the rAF chain and instead
   *  drive `produce_one_frame` ourselves via a stub `on_anim_frame` that
   *  just calls produce_one_frame.
   *
   *  We do this BEFORE the bundle's <script> evaluates by installing the
   *  rAF interceptor in installSm64Bridge → the bundle's main_func →
   *  on_anim_frame(undefined) calls our hijacked rAF → we cache the
   *  on_anim_frame fn but do NOT call back. Then our scheduler-clock tick
   *  calls it directly via bridge.produceOneFrame().
   *
   *  Why not just monkey-patch playerInputUpdate? Because it's a named
   *  export but the bundle doesn't expose it on window — and the bundle's
   *  produce_one_frame closes over the lexical playerInputUpdate import.
   *  We can't change WHICH function the closure calls without modifying
   *  the bundle source. The rAF-hijack trick gets us a handle to
   *  `on_anim_frame` (which calls `produce_one_frame` internally), and
   *  one call to on_anim_frame at the right time IS one game frame. We
   *  also write window.playerInput BEFORE invoking it so the bundle's
   *  in-closure call to playerInputUpdate() reads our values (it falls
   *  through every gate as false because no keyboard buttons were
   *  pressed, but then OR-blends into `window.playerInput` — see
   *  player_input_manager.js line 333). So the playerInput we wrote is
   *  preserved across the call.
   *
   *  This is intentionally surgical to keep us at 0 upstream edits. */
  let capturedOnAnimFrame: ((time?: number) => void) | null = null;
  function hijackRaf(): void {
    const w = globalThis as unknown as {
      requestAnimationFrame: typeof requestAnimationFrame;
      __sm64_orig_raf?: typeof requestAnimationFrame;
    };
    if (w.__sm64_orig_raf) return; // already hijacked
    w.__sm64_orig_raf = w.requestAnimationFrame.bind(globalThis);
    w.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      // Capture the bundle's on_anim_frame (first rAF after main_func).
      // After capture, swallow further rAF calls from inside on_anim_frame
      // so the bundle doesn't free-run alongside our scheduler tick. Any
      // OTHER rAF (e.g. svelte/-flow's own renders) goes through.
      const stack = new Error().stack ?? '';
      if (!capturedOnAnimFrame && stack.includes('on_anim_frame')) {
        capturedOnAnimFrame = cb as unknown as () => void;
        return 0;
      }
      // The bundle's setStatsUpdate setInterval also calls into rAF-adjacent
      // DOM. We don't filter those — they're cheap.
      if (capturedOnAnimFrame && stack.includes('on_anim_frame')) {
        // Suppress the rAF chain from inside on_anim_frame; we drive the
        // frame from our scheduler-clock tick instead.
        return 0;
      }
      return w.__sm64_orig_raf!(cb);
    }) as typeof requestAnimationFrame;
  }
  function restoreRaf(): void {
    const w = globalThis as unknown as {
      requestAnimationFrame: typeof requestAnimationFrame;
      __sm64_orig_raf?: typeof requestAnimationFrame;
    };
    if (w.__sm64_orig_raf) {
      w.requestAnimationFrame = w.__sm64_orig_raf;
      delete w.__sm64_orig_raf;
    }
    capturedOnAnimFrame = null;
  }

  /** Attach a one-shot interval that watches for the upstream's IDB-based
   *  ROM-present sentinel + flips `bridge.romPresent` accordingly. The
   *  audio factory consumes that to arm the synthetic start_gate. */
  let romWatchInterval: ReturnType<typeof setInterval> | null = null;
  // Native IndexedDB read of the upstream's `idb-keyval`-managed
  // `keyval-store` / `keyval` / 'assets' triple — same store the bundle
  // uses, but the host doesn't need a build-time idb-keyval dep.
  async function readIdbAssets(): Promise<unknown | null> {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('keyval');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const value = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('keyval', 'readonly');
        const store = tx.objectStore('keyval');
        const r = store.get(SM64_IDB_KEY);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return value ?? null;
    } catch (_e) { return null; }
  }
  function watchRomPresent(): void {
    const tryFlip = async (): Promise<boolean> => {
      const v = await readIdbAssets();
      if (v) {
        const w = globalThis as unknown as { __sm64?: Sm64Bridge };
        if (w.__sm64) w.__sm64.romPresent = true;
        return true;
      }
      return false;
    };
    // First check immediately. If still missing, poll @ 500 ms — the
    // upstream's romTextureLoader fires `IDB.set('assets', ...)` once
    // extraction finishes, so the next poll will flip.
    void tryFlip().then((ok) => {
      if (!ok) {
        romWatchInterval = setInterval(() => {
          void tryFlip().then((ready) => {
            if (ready && romWatchInterval) {
              clearInterval(romWatchInterval);
              romWatchInterval = null;
            }
          });
        }, 500);
      }
    });
  }

  async function loadBundle(): Promise<void> {
    if (loadStatus !== 'idle') return;
    loadStatus = 'loading';
    try {
      installSm64Bridge();
      hijackRaf();

      // Optional: load the upstream's template.css. We DON'T link it
      // globally — the bundle's stylesheet uses Bootstrap-y selectors
      // (.btn, .btn-success, .col-2) that would leak into the rest of the
      // app. The card carries its own minimal styles (below).

      // Inject the bundle <script> tag. The bundle's IIFE runs at load.
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/sm64js/sm64js.bundle.js';
        s.async = false;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('SM64 bundle failed to load (404? unzipped LFS pointer?)'));
        scriptTagEl = s;
        document.head.appendChild(s);
      });

      // Wire the bridge to the captured on_anim_frame so each scheduler
      // tick advances one game frame. The bundle's `produce_one_frame` is
      // called inside on_anim_frame.
      const w = globalThis as unknown as { __sm64?: Sm64Bridge };
      if (w.__sm64 && capturedOnAnimFrame) {
        w.__sm64.produceOneFrame = () => {
          try { capturedOnAnimFrame!(0); } catch (_e) { /* swallow per-frame engine errors */ }
        };
        // autoStart: equivalent to clicking #startbutton. The bundle binds
        // a click listener that calls startGame() (or location.reload() if
        // already started). We re-fire startGame via the button click.
        w.__sm64.autoStart = () => {
          try { startButtonEl?.click(); } catch (_e) { /* */ }
        };
      }

      // The bundle's romTextureLoader.js wires its submit handler at
      // module-eval time. Our #romSelect FORM was already in the DOM when
      // the script tag evaluated, so the upstream listener is now attached
      // to OUR form. Watch IDB for the post-extract flag flip.
      watchRomPresent();

      loadStatus = 'ready';
      loadError = null;
    } catch (e) {
      loadStatus = 'error';
      loadError = (e as Error).message;
    }
  }

  function teardownBundle(): void {
    if (snapRaf !== null) cancelAnimationFrame(snapRaf);
    snapRaf = null;
    if (romWatchInterval) {
      clearInterval(romWatchInterval);
      romWatchInterval = null;
    }
    restoreRaf();
    // Best-effort: stop the bundle's frame loop. Setting window.kill
    // throws inside the bundle's on_anim_frame, breaking the rAF chain.
    // (We already neutered rAF, but in case the bundle re-entered it via
    // a different code path.)
    try {
      const w = globalThis as unknown as { kill?: boolean };
      w.kill = true;
    } catch (_e) { /* */ }
    if (scriptTagEl?.parentNode) scriptTagEl.parentNode.removeChild(scriptTagEl);
    scriptTagEl = null;
    if (cssLinkEl?.parentNode) cssLinkEl.parentNode.removeChild(cssLinkEl);
    cssLinkEl = null;
    // Clear the bridge so a re-mount starts clean.
    delete (globalThis as unknown as { __sm64?: unknown }).__sm64;
  }

  onMount(() => {
    snapRaf = requestAnimationFrame(pollSnapshot);
    // Load asynchronously — we don't block the card's first paint on the
    // 12 MB bundle.
    void loadBundle();
  });
  onDestroy(() => { teardownBundle(); });

  // ---- jQuery shim types ---------------------------------------------------
  // Defined here (instead of in sm64.ts) because they're a card-mount
  // concern, not engine-side.
  interface JQueryishHandle {
    popover: (..._args: unknown[]) => JQueryishHandle;
    clone: () => JQueryishHandle;
    detach: () => JQueryishHandle;
    show: () => JQueryishHandle;
    hide: () => JQueryishHandle;
    each: (cb: (i: number, el: Element) => void) => JQueryishHandle;
    on: (..._args: unknown[]) => JQueryishHandle;
    off: (..._args: unknown[]) => JQueryishHandle;
    addClass: (..._args: unknown[]) => JQueryishHandle;
    removeClass: (..._args: unknown[]) => JQueryishHandle;
    attr: (..._args: unknown[]) => JQueryishHandle;
    [Symbol.iterator]: () => Iterator<Element>;
    length: number;
  }
  function makeJQueryish(els: Element[]): JQueryishHandle {
    const handle: JQueryishHandle = {
      popover: () => handle,            // no-op (we don't show popovers)
      clone: () => makeJQueryish(els.map((el) => el.cloneNode(true) as Element)),
      detach: () => {
        for (const el of els) el.remove();
        return handle;
      },
      show: () => { for (const el of els) (el as HTMLElement).hidden = false; return handle; },
      hide: () => { for (const el of els) (el as HTMLElement).hidden = true; return handle; },
      each: (cb) => { els.forEach((el, i) => cb(i, el)); return handle; },
      on: () => handle,
      off: () => handle,
      addClass: () => handle,
      removeClass: () => handle,
      attr: () => handle,
      [Symbol.iterator]: function* () { yield* els; },
      length: els.length,
    };
    return handle;
  }

  interface Sm64Bridge {
    romPresent: boolean;
    gameStarted: boolean;
    setPlayerInput: (input: unknown) => void;
    produceOneFrame: (() => void) | undefined;
    autoStart: (() => void) | undefined;
  }
</script>

<div class="mod-card sm64-card" bind:this={cardEl}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">SM64</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <!-- The upstream's two canvases. We keep #fullCanvas hidden (no
           fullscreen support in v1); the bundle's n64GfxProcessor.start_frame
           toggles their visibility based on `window.fullWindowMode` (always
           false here). -->
      <canvas
        bind:this={fullCanvasEl}
        id="fullCanvas"
        width={RES.width}
        height={RES.height}
        hidden
      ></canvas>
      <canvas
        bind:this={gameCanvasEl}
        id="gameCanvas"
        width={RES.width}
        height={RES.height}
        style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
        data-viz-passthrough
        data-testid="sm64-canvas"
      ></canvas>

      <!-- ROM-upload affordance. The upstream's checkForRom() unhides this
           if IDB('assets') is null; it stays hidden once extraction
           succeeds. Visible until the user supplies a US .z64 ROM. -->
      <div bind:this={romDivEl} id="rom" class="sm64-rom" hidden>
        <form bind:this={romFormEl} id="romSelect">
          <h4 class="sm64-rom-title">Drop your US sm64 (.z64) ROM here</h4>
          <input bind:this={romFileInputEl} id="romFile" type="file" accept=".z64" />
          <input type="submit" value="Extract" class="sm64-rom-extract" />
        </form>
        <p bind:this={romMessageEl} id="romMessage" class="sm64-rom-msg">
          One-time per browser. Persists in IndexedDB; subsequent SM64 spawns
          boot straight to a running game. The textures + assets stay in your
          browser — nothing leaves this device.
        </p>
      </div>

      <!-- Status / error overlay, on top of #gameCanvas. -->
      {#if loadStatus === 'loading'}
        <div class="sm64-overlay">Loading bundle…</div>
      {:else if loadStatus === 'error'}
        <div class="sm64-overlay sm64-overlay-err">Bundle failed: {loadError}</div>
      {:else if loadStatus === 'ready' && snapshot && !snapshot.romPresent && !snapshot.gameStarted}
        <div class="sm64-overlay" data-testid="sm64-rom-prompt">
          Provide a .z64 ROM above to start the game.
        </div>
      {/if}
    </div>

    <!-- Off-screen scaffolding the bundle's index.js touches but the user
         never sees. Kept hidden inside the card (rather than the global
         <body>) so multiple SM64 cards in dev hot-reload don't dup the
         ids. With maxInstances:1 there's never more than one. -->
    <div class="sm64-scaffold" aria-hidden="true">
      <div bind:this={mainContentEl} id="mainContent"></div>
      <select bind:this={mapSelectEl} id="mapSelect"></select>
      <button bind:this={startButtonEl} id="startbutton" type="button">Start</button>
      <input bind:this={sliderEl} id="slider" type="range" min="1" max="60" value="30" />
      <span bind:this={fpsEl} id="fps">30 fps</span>
      <span bind:this={maxFpsEl} id="maxFps"></span>
      <span bind:this={timingTotalEl} id="timing-total"></span>
    </div>
  </PatchPanel>
</div>

<style>
  .sm64-card { width: 320px; min-height: 420px; }
  .sm64-card .game-area {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 0 8px;
  }
  .sm64-card canvas#gameCanvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #000;
  }
  .sm64-card canvas#fullCanvas { display: none; }
  .sm64-card .sm64-rom {
    width: 100%;
    padding: 8px;
    font-size: 11px;
    color: #dafff7;
  }
  .sm64-card .sm64-rom-title {
    font-size: 12px;
    margin: 0 0 6px;
    color: #ffd040;
  }
  .sm64-card .sm64-rom-msg {
    font-size: 10px;
    color: #88a;
    margin: 6px 0 0;
    line-height: 1.3;
  }
  .sm64-card .sm64-rom-extract {
    margin-left: 6px;
    background: var(--cable-gate);
    color: #000;
    border: none;
    padding: 2px 10px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
  }
  .sm64-card .sm64-overlay {
    position: absolute;
    top: 8px;
    left: 6px;
    right: 6px;
    background: rgba(0, 0, 0, 0.7);
    color: #ffd040;
    padding: 6px 8px;
    border-radius: 2px;
    font-size: 11px;
    text-align: center;
    pointer-events: none;
  }
  .sm64-card .sm64-overlay-err {
    color: #ff5050;
  }
  .sm64-card .sm64-scaffold {
    /* Off-screen but in-DOM — the bundle still reads + writes these. */
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    visibility: hidden;
  }
</style>
