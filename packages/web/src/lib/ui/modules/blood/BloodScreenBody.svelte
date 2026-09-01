<script lang="ts">
  // packages/web/src/lib/ui/modules/blood/BloodScreenBody.svelte
  //
  // THE BLOOD SCREEN — the dock full-view body: the module's live Build-engine
  // picture, the SCREEN ON/OFF switch the 2026-08-18 owner ruling requires of
  // every video module, the boot/data affordances, and the capture-phase
  // keyboard host that makes the game playable.
  //
  // ⚠ WHY THIS FILE EXISTS, AND IT IS NOT THE #1928 REASON. On acidwarp and
  // lushgarden the argument is "promotion deletes the card, and the card owns
  // the only picture". BLOOD HAS NO PICTURE TO LOSE — `BloodCard.svelte` mounts
  // no `<canvas>` at all, in any of its 380-odd lines; it is a title, a status
  // line, a picker and one knob, and the game was visible only if you patched
  // `out` into a videoOut. So this body ADDS the module's first picture and its
  // first SCREEN switch.
  //
  // ⚠ WHAT IT MUST NOT FAIL TO DO IS BOOT THE ENGINE. `extras.ensureLoaded()`
  // is what starts BLOOD, blood is in NEITHER half of
  // `HEADLESS_MOUNT_LANE_TYPES` (it owns no media element and is not a
  // CARD_PRODUCER), and promotion stops both shipping surfaces rendering the
  // card — so if this component forgot to boot, a promoted BLOOD would be dark
  // FOREVER while every def-reading gate stayed green: the shader still
  // compiles, still draws its "alive, no signal" scanline field, and nothing in
  // the tree can tell that apart from a game nobody has started. The boot is
  // therefore `$lib/blood/blood-boot.ts` — one action this body and the legacy
  // card both call — and it is proved through THIS surface by
  // `blood-face-screen.spec.ts` and by the default-shell leg of
  // `blood-audio-output.spec.ts`, not by reading this file.
  //
  // ⚠ WHEN IT BOOTS IS UNCHANGED BY THE PROMOTION. Before: the lane tile was a
  // `ModuleShellPlaceholder` and the legacy card mounted only in the DOCK, so
  // BLOOD booted when you opened the dock full view. After: this body mounts in
  // the same place. The module has never booted from a lane tile and does not
  // start doing so here.
  //
  // ── THE KEYBOARD HOST IS AUTHORED, NOT COPIED ──────────────────────────────
  //
  // The rAF/blit/markWatched loop below is a PORT of the fleet body
  // (`AcidwarpScreenBody` / `LushGardenScreenBody`) and is deliberately spelled
  // the same way. The keyboard host is not: NO SHIPPED `fullViewBody` IN THE
  // TREE INSTALLS A CAPTURE-PHASE KEYBOARD LISTENER, so it is hand-carried off
  // `BloodCard.svelte` with two differences that have to be stated rather than
  // discovered:
  //
  //   (a) THE CARD'S `selected` BRANCH IS GONE, AND IT WAS ALREADY INERT. The
  //       card claims a key when `selected === true || cardIsFocused()`, where
  //       `selected` is SvelteFlow's node-selection prop. A `fullViewBody` slot
  //       receives `{ nodeId }` and NOTHING ELSE
  //       (`ShellExtensionFullViewBodyProps`), so the branch is unreproducible
  //       here — and it is not a loss, because it never fired on the surface
  //       this body replaces either: both dock hosts mount the card as
  //       `<CardComponent id={node.id} data={{ node }} />` with no `selected`
  //       prop (`DockFullView.svelte`, `DockCardHost.svelte`). The branch exists
  //       for the LANE card, which is `?shell=legacy` only. Focus-within is the
  //       whole predicate here, and the frame is focusable and focuses on click.
  //
  //   (b) CLAIMING `Tab` SUPPRESSES THE FACEPLATE FLIP GESTURE, and that is a
  //       real trade rather than an oversight. `SCANCODE_FOR_KEYBOARD_CODE`
  //       includes `Tab` (BLOOD's inventory key), so while this frame holds
  //       focus and the game is running, Tab is preventDefault-ed and does not
  //       reach the shell's flip-to-rear. It is PRE-EXISTING — the legacy card
  //       does exactly this in the dock today — and it is scoped: click off the
  //       frame and Tab flips again. Recorded because "the faceplate stopped
  //       flipping" is otherwise a mystifying bug report.
  //
  //   (c) THE SAME IS TRUE OF `Escape`, WHICH ALSO CLOSES THE DOCK — and this one
  //       was a real defect until `face-screen-render-4` found it. `Escape` is
  //       BLOOD's menu key, so a focused game frame swallows it and the dock does
  //       not close. That is CORRECT while the player is playing (you cannot back
  //       out of the Blood menu otherwise, and DOOM behaves identically), and it
  //       was WRONG when merely clicking the SCREEN button conferred game focus —
  //       which it did, because the button was a CHILD of the focus-within frame.
  //       The button is now a sibling; see the note beside it in the markup. What
  //       remains is the intended trade: click the PICTURE and Escape belongs to
  //       the game until you click away.
  //
  // ⚠ THIS BODY MUST STAY 2-D. It blits the engine's already-rendered canvas
  // through a `getContext('2d')` surface and must never create a GL context:
  // WebGL attest basis membership is derived from CONTENT, so a
  // `getContext('webgl')` here would enrol this file — permanently — and put
  // every future edit to a face body on the real-GPU attest critical path.

  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import { isEditableTarget, shouldClaimBloodKey } from '$lib/blood/blood-keys';
  import type { BloodHandleExtras } from '$lib/video/modules/blood';
  import {
    BLOOD_REQUIRED,
    autoBootBlood,
    bloodErrorKind,
    bootBlood,
    importBloodData,
    type BloodBootResult,
    type BloodLoadStatus,
  } from '$lib/blood/blood-boot';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). See caveat (a) in the header. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT, and it is the SAME
  // `previewCollapsed` key every other video surface uses — deliberately: a rack
  // saved before this promotion already carries it, and a second spelling is how
  // these fork. This component unmounts on dock collapse / LRU eviction (the
  // #1531 / #1574 / #1583 class), and `node.data` is what survives a tab switch,
  // a remount, a reload and collab sync. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  let frameEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let fileInputEl: HTMLInputElement | null = $state(null);
  let rafId: number | null = null;

  let loadStatus = $state<BloodLoadStatus>('idle');
  let loadError = $state<string | null>(null);
  let missing = $state<readonly string[]>([]);
  let importing = $state(false);
  let errorKind = $derived(bloodErrorKind(loadError, missing));

  // ⚠ THE CARD'S RESTING READOUT, DELETED AND RELOCATED — not hidden.
  // `BloodCard` painted "Running — click + use arrows/Ctrl/Space" as a text node
  // whenever the engine was up: a STATE WORD outside any control, which the
  // 2026-08-19 ruling removes from a faceplate. The fact it carried is real
  // (this frame owns the keyboard, and only while focused), so it moves onto the
  // frame's ACCESSIBLE NAME, where it is speakable and unpainted, and onto
  // `data-blood-status` so a spec can read the state without a readout existing.
  let frameName = $derived(
    loadStatus === 'ready'
      ? 'BLOOD — running. Click the picture, then the arrows, Ctrl and Space play the game.'
      : 'BLOOD — click to play; this frame takes the keyboard once the engine is running.',
  );

  /** ⚠ SPELLED INLINE, the fleet idiom and not an oversight — see the paragraph
   *  in blood-boot.ts. The `try` is load-bearing rather than defensive:
   *  `getDomain('video')` throws on a rack with no video domain yet, and `read`
   *  throws for a node the engine has not adopted, both of which happen in the
   *  frames between this body mounting and the engine catching up. */
  function getExtras(): BloodHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const videoEngine = e.getDomain<VideoEngine>('video');
      return (videoEngine.read(nodeId, 'extras') as BloodHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }

  function apply(r: BloodBootResult): void {
    loadStatus = r.status;
    loadError = r.error;
    missing = r.missing;
  }

  /** Manual kick — only reachable while the auto-boot has not yet found an
   *  engine to boot (the node is spawned but the video domain has not adopted
   *  it). Idempotent through `ensureLoaded`'s own latch. */
  async function bootNow(): Promise<void> {
    const extras = getExtras();
    if (!extras) return;
    loadStatus = 'loading';
    apply(await bootBlood(extras));
  }

  async function onFilesPicked(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const extras = getExtras();
    const files = input.files ? Array.from(input.files) : [];
    if (files.length === 0 || !extras) return;
    importing = true;
    try {
      const done = await importBloodData(files, extras);
      if (done) apply(done.result);
    } finally {
      importing = false;
      // Allow re-picking the same file/folder later.
      if (input) input.value = '';
    }
  }

  function openPicker(): void {
    fileInputEl?.click();
  }

  // ── THE CAPTURE-PHASE KEYBOARD HOST ────────────────────────────────────────
  //
  // Window-level and CAPTURE-phase because xyflow's own keydown fires on the
  // document and we must `preventDefault` BEFORE it — otherwise the arrow keys
  // pan the canvas instead of driving the marine. The claim predicate is the
  // shared pure one (`shouldClaimBloodKey`), so this surface and the legacy card
  // cannot disagree about which keys belong to the game.

  /** Is the game frame FOCUSED? focus-within only — see caveat (a). */
  function frameIsFocused(): boolean {
    return !!frameEl && frameEl.contains(document.activeElement);
  }

  function claim(e: KeyboardEvent): boolean {
    return shouldClaimBloodKey({
      ready: loadStatus === 'ready',
      focused: frameIsFocused(),
      // The editable guard is load-bearing, not belt-and-braces: without it a
      // key aimed at the rack's search box or a rename field would be eaten
      // whenever this faceplate happened to hold focus (owner-reported on the
      // card, and the reason the card carries the same two reads).
      editableTarget: isEditableTarget(e.target) || isEditableTarget(document.activeElement),
      code: e.code,
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!claim(e)) return;
    e.preventDefault();
    e.stopPropagation();
    getExtras()?.pushKeyboardKey(e.code, true);
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (!claim(e)) return;
    e.preventDefault();
    e.stopPropagation();
    getExtras()?.pushKeyboardKey(e.code, false);
  }

  // ── THE PICTURE ────────────────────────────────────────────────────────────

  function draw(): void {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937 / #2015).
      // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
      // calls `markWatched` itself — and a node is a pull root only while that
      // mark is fresh, so a collapsed state that merely stopped blitting would
      // drop this node out of the pull set.
      //
      // ⚠ THE HONEST VERSION OF THE ARGUMENT ON THIS MODULE, WHICH IS WEAKER
      // THAN acidwarp's AND MUST NOT BE COPIED FROM IT — and weaker than the
      // first draft of this very comment claimed, which is why it says so.
      //
      // BLOOD is ALSO pull-exempt STRUCTURALLY: `isPullExempt` returns true for
      // a handle with a non-empty `audioSources` map, and `video/engine.ts`
      // names BLOOD in that comment by name. blood.ts populates that map only
      // inside `if (ctx.audioCtx)`, and the first draft reasoned from there that
      // a fresh gesture-less rack would have an EMPTY map and would therefore
      // need this mark. FALSE, and measured rather than argued:
      // `PatchEngine.registerDomain` injects `audio.ctx` into the VideoEngine
      // whenever both domains are registered, an `AudioContext` constructs
      // suspended with no user gesture, and `/rack` always registers both. So
      // `audioSources` is non-empty from construction and BLOOD is a pull root
      // unconditionally.
      //
      // ⚠ MEASURED, NOT INFERRED: deleting this line and re-running
      // `blood-face-screen.spec.ts` leaves it GREEN — the game keeps running
      // with SCREEN off and the mark gone. That is recorded here and in that
      // spec so nobody reads the leg as covering this line.
      //
      // It stays anyway, and the reason is a real one rather than symmetry: it
      // is what makes SCREEN OFF safe INDEPENDENT of the audio topology. The
      // day blood is registered without an audio domain, or loses `audio_l` /
      // `audio_r`, or the exemption is narrowed, this line is the difference
      // between a collapsed preview and a FROZEN GAME — `surface.draw` is what
      // calls `runtime.runFrame()`, so the switch would stop the simulation, not
      // a picture. It costs one call per frame.

      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    // ⚠ 2-D ONLY — see the header. Never `getContext('webgl')` in this file.
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); }
      catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      // Letterbox to the ENGINE aspect, not to Build's 320x200. The module's own
      // shader has already aspect-fitted the framebuffer into `ctx.res` (that is
      // what `fillMode` chooses between), so fitting to 1.6:1 here would apply
      // the correction twice and squash the picture.
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched it back on
  // and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  onMount(() => {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    // BOOT OUT-OF-BOX — the single most load-bearing line in this file. First
    // restore any previously-picked FULL-game data from IndexedDB, otherwise
    // fall straight through to the BUNDLED 1997 shareware committed under
    // static/blood/; either way the engine starts with no picker.
    void (async () => {
      loadStatus = 'loading';
      // ⚠ THE ACCESSOR, NOT A HANDLE. `autoBootBlood` waits for the VideoEngine
      // to ADOPT this node before booting — a component mounts as soon as the
      // graph has the node, and a synchronous `extras` read on mount loses that
      // race on a heavier graph, which on THIS module means dark forever. See
      // `awaitBloodExtras`, which exists because that regression was shipped and
      // caught by a spec that went from PASS to SKIP.
      const r = await autoBootBlood(getExtras);
      if (r) apply(r);
      else loadStatus = 'idle'; // the engine never adopted it — offer BOOT
    })();
  });

  onDestroy(() => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  });
</script>

<div class="blood-screen" data-testid="blood-screen-body">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events
       — `role="application"` is exactly right for a surface that OWNS its key
       handling: it must be focusable and must take pointer + key handlers.
       Svelte's rules do not model `application` as interactive. One
       comma-separated comment, not three: see the runes trap documented in
       lib/dev/svelte-ignore-audit.ts. -->
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    <div
      class="game-frame nodrag"
      bind:this={frameEl}
      data-testid="blood-face-frame"
      data-blood-status={loadStatus}
      role="application"
      aria-label={frameName}
      tabindex="0"
      onclick={() => frameEl?.focus()}
    >
      {#if !previewCollapsed}
        <canvas
          bind:this={canvasEl}
          width={480}
          height={360}
          data-testid="blood-face-canvas"
          data-node-id={nodeId}
        ></canvas>
      {/if}
    </div>
    <!-- ⚠ THE SCREEN SWITCH IS A SIBLING OF THE GAME FRAME, NOT A CHILD OF IT,
         and that is a FIX rather than a layout preference — the one place this
         body deliberately differs from every other `fullViewBody`, all of which
         put the button inside the element the `{#if}` guards.
         The claim predicate is focus-WITHIN, so while the button lived inside the
         frame, clicking SCREEN handed the GAME the keyboard — and BLOOD claims
         `Escape` (its menu key), so the very next Escape was swallowed and the
         dock would not close. MEASURED, not foreseen: `face-screen-render-4`
         went red on precisely that ("blood: the dock must close before the next
         module in this batch opens") the first time blood was a subject, and the
         same trap was live for a PLAYER, who would have clicked SCREEN and then
         found Escape dead. As a sibling the button takes focus itself, the frame
         no longer contains the active element, and Escape reaches the dock.
         Clicking the PICTURE still hands the game the keyboard — that is the
         affordance, and it is why caveat (c) in the header exists. -->
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={toggleScreen}
      data-testid="blood-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the picture is collapsed and its space reclaimed. BLOOD keeps PLAYING: the engine runs its frames, the game audio keeps feeding audio_l/audio_r, and out keeps feeding whatever is patched to it. Switching it back on shows the live game, not a stale frame.'
        : 'SCREEN — turn the picture off to collapse it and reclaim the vertical space. BLOOD goes on running either way; click the picture and the keyboard reaches the game.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <!-- Hidden picker: `multiple` for file-by-file, `webkitdirectory` so the owner
       can point at a whole Blood folder in one go. -->
  <input
    bind:this={fileInputEl}
    class="file-input"
    type="file"
    multiple
    webkitdirectory
    data-testid="blood-face-data-input"
    onchange={onFilesPicked}
  />

  {#if loadStatus === 'idle'}
    <!-- Reachable only before the engine has a node to boot; the mount path
         above starts BLOOD with no gesture on every normal open. -->
    <div class="row">
      <button class="load nodrag" data-testid="blood-face-boot" onclick={bootNow}>BOOT</button>
      <button class="load alt nodrag" data-testid="blood-face-pick-data" onclick={openPicker}>
        LOAD FULL DATA
      </button>
    </div>
  {:else if loadStatus === 'loading'}
    <div class="status" data-testid="blood-face-loading">{importing ? 'reading data…' : 'loading…'}</div>
  {:else if loadStatus === 'error'}
    {#if errorKind === 'not-built'}
      <!-- INSTRUCTIONS FOR A GESTURE, which the resting-text ruling permits in a
           body: without the build command there is no way for a local developer
           to act on this state at all. -->
      <div class="status err" data-testid="blood-face-error">
        BLOOD engine not built. The hosted build ships <code>blood.js</code> +
        <code>blood.wasm</code>; if you see this locally, run
        <code>BLOOD_LINK=1 bash packages/web/native/build-blood-wasm.sh</code>.
      </div>
    {:else if errorKind === 'data-missing'}
      <div class="status err" data-testid="blood-face-error">
        <div class="data-prompt" data-testid="blood-face-data-missing">
          Couldn't load the bundled Blood data ({BLOOD_REQUIRED.join(', ')}). You can
          load your own copy ({BLOOD_REQUIRED.join(', ')}, plus <code>*.ART</code>/<code>*.DAT</code>) —
          pick the files, or your whole Blood folder, from a copy you own.
        </div>
        <button class="load nodrag" data-testid="blood-face-pick-data" onclick={openPicker} disabled={importing}>
          {importing ? 'READING…' : 'LOAD FULL DATA'}
        </button>
      </div>
    {:else}
      <div class="status err" data-testid="blood-face-error">
        {loadError}
        <button class="load alt nodrag" data-testid="blood-face-pick-data" onclick={openPicker}>
          LOAD FULL DATA
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .blood-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. A stacked
     row cost spirographs ~18.8 px against ~11 px of slack and overhung its card.
     It OVERLAYS the picture's bottom-right corner, so the frame is exactly the
     height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a floor
       the wrap would collapse to zero and take the absolutely-positioned button
       with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
    max-width: 100%;
  }
  /* The focusable GAME FRAME — the keyboard-owning region, and deliberately NOT
     the wrap (see the markup note beside the SCREEN button). It fills the wrap so
     the picture's whole area is the click target. */
  .game-frame {
    display: flex;
    justify-content: center;
    min-height: 18px;
    max-width: 100%;
  }
  .game-frame:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .row {
    display: flex;
    gap: 4px;
  }
  .load {
    cursor: pointer;
    background: #2a0c0c;
    color: var(--text);
    border: 1px solid #602020;
    border-radius: 2px;
    padding: 2px 8px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
  }
  .load.alt { background: transparent; color: var(--text-dim); }
  .load:disabled { opacity: 0.6; cursor: default; }
  .file-input { display: none; }
  .status {
    font-size: 0.6rem;
    line-height: 1.4;
    max-width: 480px;
  }
  .status.err { color: #f99; }
  .data-prompt { margin-bottom: 4px; }
  code {
    background: #2a0a0a;
    padding: 0 3px;
    border-radius: 3px;
  }
</style>
