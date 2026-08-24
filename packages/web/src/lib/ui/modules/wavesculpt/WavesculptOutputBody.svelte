<script lang="ts">
  // packages/web/src/lib/ui/modules/wavesculpt/WavesculptOutputBody.svelte
  //
  // The WAVESCULPT dock full-view body: THE renderer, the camera pad that flies
  // it, the SCREEN switch and the MONITOR resize.
  //
  // ⚠ IT MOUNTS THE RENDERER; IT DOES NOT RE-DRAW IT. `WavesculptVizSurface` is
  // the same component `WavesculptCard` mounts, so the legacy card and this
  // faceplate are two mounts of ONE renderer rather than two renderers drifting
  // against one DSP. That is the whole reason the extraction was its own PR.
  //
  // ⚠ THE SURFACE IS NEVER UNMOUNTED BY THE SCREEN SWITCH, AND THIS IS THE ONE
  // THING NOT TO "TIDY UP". Turning SCREEN off hides the picture with CSS; it
  // does NOT `{#if}` the surface away, the way `RasterizeOutputBody` may drop
  // its canvas. Unmounting here would run the surface's `onDestroy` — which
  // disposes the GL context AND uninstalls the cross-domain frame drawer — so
  // `video_out` would go BLACK for every module downstream the moment a player
  // collapsed a preview they were not even looking at. The module's own
  // `drawFrame` fills the canvas solid black with no drawer installed (measured
  // elsewhere in the tree: nonBlack 0/3072 px, maxLuma 0), so this is not a
  // theoretical tidiness point. SKIP THE VIEW, NEVER THE RENDER.
  //
  // ⚠ WHY CSS RATHER THAN A `blit` PROP ON THE SURFACE. Telling the surface to
  // skip its presentation blit would be marginally cheaper — but the surface is
  // IN THE WEBGL ATTEST BASIS, so adding a prop to it costs a real-GPU
  // re-attest window for what is a per-frame `drawImage` of a 320x240 canvas.
  // The face is otherwise entirely attest-free (`face`, `docs` and
  // `controlFamilies` are all stripped), and spending a GPU run on a CPU
  // micro-optimisation is the wrong trade. If the blit ever shows up in a
  // profile, do it in a PR that is already moving the hash for a real reason.
  //
  // ⚠ THE PAD SHOWS THE KNOB; CV MOVES THE PICTURE. The pad reads and writes
  // `pos_x`/`pos_y` through the ordinary param path. The RENDERER separately
  // reads the live camera (CV included) for its own viewport. Those are two
  // different numbers and BOTH ARE CORRECT — do not "fix" the pad to follow CV
  // by reading the camera shadow, which is a known owner-listed defect this
  // face deliberately does not build on.

  import { patch } from '$lib/graph/store';
  import { mutateNode, setNodeParam } from '$lib/graph/mutate';
  import { clampJoy } from '$lib/audio/modules/joystick';
  import WavesculptVizSurface from './WavesculptVizSurface.svelte';
  import { WAVESCULPT_MONITOR_BOX, WAVESCULPT_RESTING } from './monitor-box';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class. `node.data` survives a
  // tab switch (the owner's stated floor), a remount, a reload, and syncs to
  // collaborators. Absent => false => ON, so an existing rack opens unchanged.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  let monitor = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.hideControls as boolean | undefined) ?? false,
  );

  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // Unlike ruttetra's, this does NOT clear the stored size — see monitor-box.ts:
  // no other surface reads these keys, so keeping them means the monitor
  // reopens at the size its author chose.
  function toggleMonitor(): void {
    const next = !monitor;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.hideControls = next;
    });
  }

  let boxW = $derived<number>(
    Math.max(
      WAVESCULPT_MONITOR_BOX.minW,
      (patch.nodes[nodeId]?.data?.resizedWidth as number | undefined) ?? WAVESCULPT_MONITOR_BOX.defW,
    ),
  );
  let boxH = $derived<number>(
    Math.max(
      WAVESCULPT_MONITOR_BOX.minH,
      (patch.nodes[nodeId]?.data?.resizedHeight as number | undefined) ?? WAVESCULPT_MONITOR_BOX.defH,
    ),
  );

  /** The picture's box in CSS px. MONITOR mode is the only user-sized state. */
  let viewW = $derived(monitor ? boxW : WAVESCULPT_RESTING.w);
  let viewH = $derived(monitor ? boxH : WAVESCULPT_RESTING.h);

  let resizing = $state(false);
  function onResizeStart(ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const w0 = boxW;
    const h0 = boxH;
    resizing = true;
    const ac = new AbortController();
    const move = (e: PointerEvent): void => {
      const w = Math.max(WAVESCULPT_MONITOR_BOX.minW, Math.round(w0 + (e.clientX - startX)));
      const h = Math.max(WAVESCULPT_MONITOR_BOX.minH, Math.round(h0 + (e.clientY - startY)));
      // guard:allow-raw-write — fires per pointermove during a drag; a tracked
      // write per frame would storm the doc and flood the undo stack.
      const target = patch.nodes[nodeId];
      if (target) {
        if (!target.data) target.data = {};
        target.data.resizedWidth = w;
        target.data.resizedHeight = h;
      }
    };
    const end = (): void => { resizing = false; ac.abort(); };
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // ── the CAMERA PAD ────────────────────────────────────────────────────────
  //
  // Both axes are linear +-1 and come off their own ParamDefs via `clampJoy`,
  // the same helper the audio side clamps with — never re-typed here.
  let padEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);

  let posX = $derived<number>(clampJoy((patch.nodes[nodeId]?.params?.pos_x as number | undefined) ?? 0));
  let posY = $derived<number>(clampJoy((patch.nodes[nodeId]?.params?.pos_y as number | undefined) ?? 0));

  /** Dot position as a PERCENTAGE of the pad, so it tracks the monitor resize
   *  without recomputing anything: -1..+1 maps to 0..100%, and Y is inverted
   *  because screen-down is camera-negative. */
  let dotLeft = $derived(((posX + 1) / 2) * 100);
  let dotTop = $derived(((-posY + 1) / 2) * 100);

  function writeFromPointer(ev: PointerEvent): void {
    if (!padEl) return;
    const r = padEl.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const nx = clampJoy(((ev.clientX - r.left) / r.width) * 2 - 1);
    const ny = clampJoy(-(((ev.clientY - r.top) / r.height) * 2 - 1));
    setNodeParam(nodeId, 'pos_x', nx);
    setNodeParam(nodeId, 'pos_y', ny);
  }
  function onPointerDown(ev: PointerEvent): void {
    dragging = true;
    try { padEl?.setPointerCapture(ev.pointerId); } catch { /* */ }
    writeFromPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    writeFromPointer(ev);
  }
  function onPointerUp(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try { padEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
  }

  /** The accessible name carries the VALUES, because the resting faceplate
   *  paints no derived text. This is where a spec (or a screen reader) reads
   *  what the camera is doing. */
  let ariaLabel = $derived(
    `Camera position pad. X ${posX.toFixed(2)}, Y ${posY.toFixed(2)}.`,
  );
</script>

<div class="ws-output" data-testid="wavesculpt-output-body">
  <div
    class="screen-wrap"
    data-cell-kind="param"
    data-cell-control="xy"
    data-cell-key="pos_x"
    data-monitor={monitor ? 'on' : 'off'}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
         — `role="application"` is exactly right for a control that OWNS its
         pointer handling. Svelte's rules do not model `application` as
         interactive. -->
    <div
      class="pad nodrag"
      bind:this={padEl}
      style="width: {viewW}px; height: {viewH}px;"
      role="application"
      tabindex="0"
      aria-label={ariaLabel}
      data-testid="control-pos_x"
      data-control-params="pos_x,pos_y"
      data-screen={previewCollapsed ? 'off' : 'on'}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <!-- ⚠ ALWAYS MOUNTED — see the header. SCREEN off hides it, never
           unmounts it, because unmounting disposes the GL context and
           uninstalls the video_out frame drawer. -->
      <!-- ⚠ `ownsVideoOut={false}` IS LOAD-BEARING — THIS IS THE SECOND MOUNT.
           wavesculpt is a faced producer that is NOT in FACE_MOUNTS_PRODUCER,
           so its real card stays alive in <HeadlessSourceHost> while this dock
           full view is open (`keepsHeadlessWhileDocked`). That card is the
           mount that OWNS `video_out`; this one is the viewer the surface's
           own prose calls "a second, viewer-only mount"
           (WavesculptVizSurface.svelte:88-99: "Exactly ONE mounted surface per
           node should" own the seam).

           Without it BOTH mounts default to `ownsVideoOut = true` and the node
           goes permanently black on COLLAPSE. ⚠ THE DEFECT IS ON THE INSTALL
           SIDE, NOT THE RELEASE SIDE, and the distinction is the whole reason
           this prop is the fix rather than a stronger guard:

             * install (`wavesculpt.ts:101-103`) is a BARE
               `FRAME_DRAWERS.set(nodeId, fn)` — no owner check, last writer
               silently wins. So this mount does not race the card at teardown;
               it STEALS ownership at MOUNT, orphaning a drawer whose card is
               still live and still visible.
             * release (`:121-124`) IS owner-checked (#1587), and the check is
               genuinely active — the surface passes `myFrameDrawer`. When this
               mount later unmounts, the entry really is its own, the check
               correctly passes, and the map is emptied. Nothing restores the
               card's drawer.

           #1587 hardened exactly half of this seam and the hardened half is not
           the half that failed: an owner-checked RELEASE cannot defend against
           a silent ownership STEAL at INSTALL. Measured before this prop: 9
           live frames, then 81 consecutive black (788 ms) with no recovery.

           The picture here is unaffected — the flag gates the cross-domain
           registry and the DRS step seam, never this mount's own render. -->
      <div class="viz" class:hidden={previewCollapsed}>
        <WavesculptVizSurface {nodeId} ownsVideoOut={false} />
      </div>

      <!-- The gesture, ON TOP of its own feedback: crosshair + dot. -->
      <div class="cross-h"></div>
      <div class="cross-v"></div>
      <div class="dot" class:active={dragging} style="left: {dotLeft}%; top: {dotTop}%;"></div>
    </div>

    <button
      type="button"
      class="chip screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="wavesculpt-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the picture off to reclaim its space. The renderer keeps running, so video_out is unaffected."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>

    <button
      type="button"
      class="chip monitor-btn nodrag"
      class:on={monitor}
      onclick={toggleMonitor}
      data-testid="wavesculpt-face-monitor-toggle"
      aria-pressed={monitor}
      title="MONITOR: hide the controls and watch the render. Drag the corner to resize."
    >MONITOR {monitor ? 'ON' : 'OFF'}</button>

    {#if monitor}
      <!-- svelte-ignore a11y_no_static_element_interactions — a RESIZE GRIP is a
           pointer-only affordance with no keyboard equivalent to offer: there is
           no "size" to type and no discrete step to arrow through, and the thing
           it adjusts (`resizedWidth`/`resizedHeight`) is already reachable by
           reopening the monitor at its stored size. It carries role="separator"
           and an aria-label so it is announced rather than silent. Same shape as
           RuttetraOutputBody's grip, for the same reason. -->
      <div
        class="grip nodrag"
        class:resizing
        role="separator"
        aria-label="Resize the monitor"
        onpointerdown={onResizeStart}
      ></div>
    {/if}
  </div>
</div>

<style>
  .ws-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  .screen-wrap { position: relative; display: flex; justify-content: center; }

  /* The pad IS the picture's frame — the gesture and its feedback are one
     surface, which is the whole argument for `surface: 'body'`. */
  .pad {
    position: relative;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 2px;
    touch-action: none;
    cursor: crosshair;
    overflow: hidden;
  }
  .pad:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

  /* ⚠ `visibility`/`display` on a WRAPPER, never `{#if}` on the surface. The
     renderer keeps running and keeps feeding video_out; only the view stops. */
  .viz { position: absolute; inset: 0; }
  .viz.hidden { visibility: hidden; }

  .cross-h, .cross-v { position: absolute; background: rgba(255, 255, 255, 0.12); pointer-events: none; }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; }

  .dot {
    position: absolute;
    width: 9px;
    height: 9px;
    margin: -5px 0 0 -5px;
    border-radius: 50%;
    background: var(--accent, #6cf);
    box-shadow: 0 0 6px rgba(108, 204, 255, 0.8);
    pointer-events: none;
  }
  .dot.active { background: #fff; }

  /* ⚠ THE CHIPS COST ZERO LAYOUT HEIGHT. Stacking them under the picture would
     add rows to a body whose height IS the picture's height, which is the
     "useless gray space" the compact default forbids. They overlay the
     corners. */
  .chip {
    position: absolute;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .chip.on { color: var(--text); border-color: var(--accent-dim); }
  .chip:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .screen-btn { right: 4px; bottom: 4px; }
  .monitor-btn { left: 4px; bottom: 4px; }

  .grip {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 0 45%,
      var(--border-dim, rgba(255, 255, 255, 0.35)) 45% 55%,
      transparent 55%
    );
  }
  .grip.resizing { background-color: rgba(108, 204, 255, 0.25); }
</style>
