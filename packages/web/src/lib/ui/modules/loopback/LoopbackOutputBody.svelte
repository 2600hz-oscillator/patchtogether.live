<script lang="ts">
  // packages/web/src/lib/ui/modules/loopback/LoopbackOutputBody.svelte
  //
  // The LOOPBACK dock full-view body: the live picture, the SCREEN switch, a
  // capture lamp, the card's recovery text, and the two CAPTURE GESTURES.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED,
  // and that is the single most important line in this file — verbatim the
  // constraint `CameraInputOutputBody.svelte` carries, for the same mechanical
  // reason. LOOPBACK's `<video>` is owned by the NODE and *adopted* into
  // `LoopbackCard.svelte` at runtime. A DOM node has exactly one parent, so a
  // body that adopted it here would STEAL it from the card — and the card is
  // what owns `getDisplayMedia`, the stream and the capture machine. "Port the
  // card's preview" is the obvious move and it would silently kill the capture
  // the moment the dock opened. `blitOutputForPreview` reads the module's own
  // output texture instead, which is what every other video face does anyway.
  //
  // ⚠ AND HERE IT WOULD BE UNRECOVERABLE, WHICH IS THE DIFFERENCE FROM CAMERA.
  // A stolen camera stream can be re-acquired programmatically — the origin is
  // already granted. A stolen tab capture cannot: `getDisplayMedia` needs a
  // fresh USER GESTURE and a fresh trip through the picker, every time. So the
  // failure mode of the obvious move is "the user has to re-pick their tab",
  // not "a frame is dropped".
  //
  // ⚠ THE CARD IS STILL ALIVE, AND IS STILL THE ONLY OWNER — IT IS JUST NOT ON
  // SCREEN. Under the default shell the lane paints this module's faceplate and
  // the real card runs inside `<HeadlessSourceHost>`, parked at `left:-9999px`
  // with `pointer-events: none`. The STREAM is unaffected; every BUTTON the card
  // draws is unreachable. So this body is NOT a thin add-on to a visible card —
  // it is the only surface a player can touch, and it has to carry:
  //   * the ACQUIRE gesture — "START CAPTURE" / "RE-CAPTURE". ⚠ THE WHOLE
  //     MODULE depends on it: a display capture has no already-granted state,
  //     so unlike CAMERA there is no auto-acquire path that could stand in.
  //     Without this button a promoted LOOPBACK can never start.
  //   * the STOP gesture, which is not a param and cannot become one (adding a
  //     param to `loopback.ts` moves the WebGL attest hash, and a synced param
  //     would let one collaborator stop a capture living in another's browser).
  //   * the capture LAMP, showing the card's REAL state rather than a guess —
  //     and here a guess is not merely worse, it is impossible: NOTHING about a
  //     tab capture is in the graph. `gain` and `crop` are the only params and
  //     neither moves when a capture starts, stops, is refused, or is ended
  //     from the browser's own share bar.
  //   * the card's RECOVERY TEXT for an unsupported browser or a failed picker.
  //
  // ⚠ AND IT CARRIES THEM WITHOUT BECOMING A SECOND OWNER. `getDisplayMedia`,
  // the MediaStream and the capture state machine stay entirely on the card.
  // This body READS a published status and INVOKES a registered command through
  // `$lib/ui/media/loopback-status-registry` — a remote control, not a second
  // machine. Two callers would be two owners, and each would be able to prompt
  // the user with a picker the other did not ask for.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { loopbackStatus, type LoopbackStatus } from '$lib/ui/media/loopback-status-registry';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── SCREEN, on the shared key ─────────────────────────────────────────────
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── The capture LAMP, the ERROR TEXT and the two GESTURES ─────────────────
  //
  // ⚠ A NULL STATUS IS A REAL STATE AND IS RENDERED AS ONE. `null` means no card
  // has published — the node exists but nothing is mounted for it yet. It is not
  // an error and it is not `idle`; the lamp goes dim and both buttons are
  // disabled, because there is nobody to deliver the command to.
  let live = $state<LoopbackStatus | null>(null);
  let commandable = $state(false);

  $effect(() => {
    const id = nodeId;
    const sync = (): void => {
      live = loopbackStatus.read(id);
      commandable = loopbackStatus.hasCommands(id);
    };
    sync();
    return loopbackStatus.subscribe(id, sync);
  });

  type Lamp = 'no-card' | 'idle' | 'requesting' | 'capturing' | 'ended' | 'error';
  let lamp = $derived<Lamp>(
    !live ? 'no-card'
      : live.state === 'capturing' ? 'capturing'
      : live.state === 'requesting' ? 'requesting'
      : live.state === 'ended' ? 'ended'
      : live.state === 'error' || live.state === 'unsupported' ? 'error'
      : 'idle',
  );

  // ⚠ THE STATE SENTENCE LIVES HERE — SPEAKABLE, NEVER PAINTED. The resting
  // faceplate paints no derived-state text, so the lamp's colour is the visible
  // half and this is the readable half (`aria-label` + `title`). The card's
  // "the preview loops recursively" hint moved into the `capturing` line rather
  // than being dropped: it is genuinely worth knowing — the picture below IS
  // the tab it is captured from, so the feedback tunnel is expected, not a bug
  // — but it is a sentence about state, and a sentence about state does not go
  // on a faceplate.
  const LAMP_TITLE: Record<Lamp, string> = {
    'no-card': 'No LOOPBACK surface is mounted for this node yet — nothing has reported a capture state.',
    idle: 'Nothing is captured yet. Use START CAPTURE and pick this tab in the browser\'s picker.',
    requesting: 'The browser\'s capture picker is open — choose a surface to continue.',
    capturing: 'Capture is running: frames are arriving and feeding OUT. The preview shows the tab it is captured from, so it loops recursively — that is expected.',
    ended: 'You stopped sharing from the browser\'s share bar. Use RE-CAPTURE to start again.',
    error: 'Capture is not running — see the message below.',
  };

  /** The card's own recovery text, verbatim — the instructions live there. */
  let errorMsg = $derived<string | null>(live?.errorMsg ?? null);

  /**
   * ⚠ THE ONLY ROUTE TO getDisplayMedia IN THE DEFAULT SHELL. The card's button
   * is off-screen and `pointer-events: none`; this is the gesture that reaches
   * it.
   *
   * It must stay a real click handler on a real `<button>`. `getDisplayMedia`
   * requires a user gesture and the browser judges that by the call's activation
   * context — and unlike `getUserMedia` there is NO previously-granted state
   * that would let a programmatic call through. A call from an effect is refused
   * always, not just on a first visit.
   */
  function requestAcquire(): void {
    const res = loopbackStatus.request(nodeId, 'acquire');
    // ⚠ DELIVERY IS REPORTED, NEVER DROPPED. An acquire writes nothing to the
    // graph, so no readParam/readData probe can see whether it landed — this log
    // is the only thing separating "the card acted" from "no card was listening".
    if (!res.delivered) {
      console.warn('[loopback] START CAPTURE reached no card for node', nodeId);
    }
  }

  function requestStop(): void {
    const res = loopbackStatus.request(nodeId, 'stop');
    if (!res.delivered) {
      console.warn('[loopback] STOP reached no card for node', nodeId);
    }
  }

  /** Offerable only when a card is listening AND this browser HAS the Screen
   *  Capture API — the same two conditions the card's own button is disabled
   *  on. A request already in flight blocks a second picker. */
  let canAcquire = $derived<boolean>(
    commandable && (live?.supported ?? false) && live?.state !== 'requesting',
  );
  /** Stopping only makes sense while something is running. */
  let canStop = $derived<boolean>(commandable && live?.state === 'capturing');

  // ── SCREEN OFF stops the COPY and keeps the WATCH MARK (#2015) ────────────
  //
  // ⚠ THE WIDEST VERSION OF THE ARGUMENT, exactly as on CAMERA. LOOPBACK has no
  // video input — it is the ORIGIN of whatever it feeds. A lapsed watch mark
  // drops the node from the pull set, so the switch would stop being a preview
  // control and become a MUTE for every consumer downstream. There is no
  // accumulator to lose (the picture is whatever the tab last showed), so this
  // is the OUTPUT argument, not `vdelay`'s or `peakstate`'s.
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="loopback-output" data-testid="loopback-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="loopback-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="loopback-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the loopback preview is collapsed and its space reclaimed. CAPTURE KEEPS RUNNING and keeps feeding OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the loopback preview off to collapse it and reclaim the vertical space. Capture goes on feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  {#if errorMsg}
    <!-- ⚠ THE CARD'S RECOVERY TEXT, VERBATIM AND UNSUMMARISED. This is the
         exception the resting-text rule is built to allow: it is not derived
         state restating a control, it is an ERROR with instructions, and it is
         absent whenever nothing is wrong. -->
    <p class="error" role="alert" data-testid="loopback-face-error">{errorMsg}</p>
  {/if}

  <div class="capture-row">
    <!-- ⚠ The lamp carries its state in `aria-label`/`title`, never as a resting
         readout — the colour is the painted half, the sentence is the spoken
         half. There is no TEXT in this row that is not a button caption. -->
    <span
      class="lamp"
      data-testid="loopback-face-lamp"
      data-lamp={lamp}
      role="img"
      aria-label={LAMP_TITLE[lamp]}
      title={LAMP_TITLE[lamp]}
    ></span>

    <!-- ⚠ THE ACQUIRE GESTURE. Under the default shell this is the ONLY
         clickable route to getDisplayMedia: the card's own button is parked
         off-screen with `pointer-events: none`, and no auto-acquire path
         exists for a display capture at all. It must stay a real click on a
         real <button> — the browser grants a capture only from a genuine
         activation context, every single time. -->
    <button
      type="button"
      class="acquire nodrag"
      onclick={requestAcquire}
      disabled={!canAcquire}
      data-testid="loopback-face-acquire"
      data-can-acquire={canAcquire ? 'true' : 'false'}
      title={canAcquire
        ? 'Ask the browser to capture a tab. Pick THIS tab in the picker to feed your own viewport into the patch.'
        : 'Unavailable: no LOOPBACK surface is mounted for this node, this browser has no Screen Capture API, or a picker is already open.'}
    >{live?.state === 'capturing' || live?.state === 'ended' ? 'RE-CAPTURE' : 'START CAPTURE'}</button>

    <button
      type="button"
      class="stop nodrag"
      onclick={requestStop}
      disabled={!canStop}
      data-testid="loopback-face-stop"
      data-can-stop={canStop ? 'true' : 'false'}
      title={canStop
        ? 'End the capture and release the tab. Starting again needs a fresh trip through the browser picker.'
        : 'Unavailable: nothing is capturing on this node.'}
    >STOP</button>
  </div>
</div>

<style>
  .loopback-output {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — it OVERLAYS the picture's corner,
     so the body is exactly the height the picture is. See the OVERLAY paragraph
     in module-faceplates.md. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: without a floor the wrap collapses to
       zero and takes the absolutely-positioned button with it. */
    min-height: 18px;
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
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

  .capture-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    max-width: 480px;
  }
  .lamp {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-dim);
    opacity: 0.5;
  }
  .lamp[data-lamp='capturing'] { background: var(--accent); opacity: 1; box-shadow: 0 0 4px var(--accent); }
  .lamp[data-lamp='requesting'],
  .lamp[data-lamp='ended'] { background: var(--warn, #c9a227); opacity: 1; }
  .lamp[data-lamp='error'] { background: #dc2626; opacity: 1; }
  /* `no-card` / `idle` keep the dim default — nothing is wrong, nothing is
     running. A red lamp for "you have not started a capture yet" would cry
     wolf, and idle is where every LOOPBACK begins. */

  .error {
    margin: 0;
    width: 100%;
    max-width: 480px;
    font-size: 0.65rem;
    color: #fca5a5;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.3);
    padding: 4px 6px;
    border-radius: 2px;
    line-height: 1.3;
  }
  .acquire {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--cable-video, var(--border));
    border-radius: 2px;
    background: rgba(244, 114, 182, 0.12);
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }
  .acquire:hover:not(:disabled) { background: rgba(244, 114, 182, 0.2); }
  .stop {
    flex: 0 0 auto;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: var(--module-bg);
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .stop:hover:not(:disabled) { color: var(--text); border-color: var(--accent-dim); }
  .acquire:disabled,
  .stop:disabled { opacity: 0.4; cursor: not-allowed; }
  .acquire:focus-visible,
  .stop:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
