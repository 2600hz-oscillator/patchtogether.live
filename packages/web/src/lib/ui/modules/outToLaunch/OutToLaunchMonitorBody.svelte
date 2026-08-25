<script lang="ts">
  // OutToLaunchMonitorBody — the OUT TO LAUNCH dock full-view body: the live
  // 9x9 monitor picture, its SCREEN switch, and the Launchpad binder.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ──────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, an EMPTY STATE, or a LAMP:
  //
  //   * THE 9x9 PICTURE — the module's whole point on a machine with no
  //     Launchpad attached, and the thing BRIGHT and GAMMA act on. Drawn by the
  //     shared `drawOutToLaunchPreview`, which the legacy card imports too, so
  //     the two surfaces cannot paint different pictures.
  //   * THE SCREEN SWITCH — required of every faced video module by the
  //     2026-08-18 owner ruling and gated by `video-face-screen-source.test.ts`.
  //   * THE PORT PICKER — a roster enumerated from the MACHINE, so it is not a
  //     `ParamDef`'s `options` (a def roster is fixed when the def is authored)
  //     and it cannot be a `ShellSelectorCell` either: ModuleShell re-projects a
  //     cell from `liveCell` keyed on `nodeVersion(id)`, and `bindMonitor`
  //     writes to `node.data` ZERO times, so a selector would paint the roster
  //     it had at mount and never move. A body is an ordinary component and can
  //     subscribe, which is what the legacy card already did.
  //   * UNBIND — one control whose two presses do OPPOSITE things to CONNECT's,
  //     and it is absent entirely until there is a claim to release.
  //     `ShellActionCell.label` is a plain `string`, so a cell could not say
  //     which of the two it is about to do.
  //   * THE MONITOR LAMP, through `StatusLed`: a static literal caption, a
  //     boolean that IS the picture, and the derived sentence in `aria-label` /
  //     `title`. It carries the card's MONITOR ACTIVE banner and its
  //     `Bound to <code>…</code>` line — see `out-to-launch-status-model.ts`.
  //   * THE ERROR LINES — absent whenever nothing is wrong.
  //   * THE EMPTY-STATE LINE — present only while nothing has been enumerated
  //     and nothing is bound, and replaced by the picker the moment there is a
  //     roster.
  //
  // ⚠ NO CONNECT BUTTON HERE, DELIBERATELY — launchpadControl's rule. CONNECT is
  // the RANKED ACTION CELL in the band below, which is what puts it on the lane
  // tile at all; a second button on this plate would be one gesture with two
  // affordances and a second thing to keep in sync.
  //
  // ── WHY THERE IS NO `markWatched` DANCE, WHERE EVERY SIBLING BODY HAS ONE ──
  //
  // `MirrorpoolOutputBody` must mark its node watched while SCREEN is OFF,
  // because its preview blit IS the watch mark and a node drops out of the pull
  // set 1.5 s after its last mark. That whole mechanism is INERT here, and the
  // reason is structural rather than lucky: `isPullRoot` (`video/engine.ts`)
  // returns true UNCONDITIONALLY for a `pullExempt` node, before it ever looks
  // at `watchedAt`, and `outToLaunchDef` declares `pullExempt: true` precisely
  // so its 9x9 readback stays fresh with no observer. `computePullActiveSet`
  // then keeps its upstream chain alive from that same root. So SCREEN OFF here
  // cannot become the producer kill switch the #1720/#1721 class describes —
  // there is no watch mark to lose.
  //
  // ⚠ AND THIS BODY IS NOT THE LED PUMP. The 30 fps push to the hardware lives
  // on the NODE, in `node-launchpad-monitor-registry` (#1728), for the exact
  // reason this component would be the wrong owner: it unmounts on dock
  // collapse and on LRU eviction, and a performer closing a pane is not a
  // performer finished with their Launchpad. What this component owns is the
  // on-screen picture and the rAF that paints it — card-lifetime work that
  // SHOULD die with the mount, because an element that is not in the DOM cannot
  // be drawn to.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { StatusLed } from '$lib/ui/controls';
  import {
    midiAvailable,
    isOutputClaimed,
    statusRune,
    type LaunchpadPort,
  } from '$lib/control/launchpad/launchpad-device.svelte';
  import { nodeLaunchpadMonitor } from '$lib/ui/modules/node-launchpad-monitor-registry.svelte';
  import { OUT_TO_LAUNCH_DEFAULTS } from '$lib/video/modules/out-to-launch';
  import {
    onOutToLaunchGesture,
    outToLaunchGestureOutcome,
    outToLaunchPorts,
  } from '$lib/ui/modules/out-to-launch-cell-actions';
  import { drawOutToLaunchPreview, OTL_PREVIEW_PX } from './out-to-launch-preview';
  import {
    outToLaunchEmptyLine,
    outToLaunchErrorLine,
    outToLaunchMonitorDetail,
    outToLaunchPickerVisible,
    outToLaunchPortLabel,
    outToLaunchPortTitle,
    outToLaunchUnbindVisible,
    type OutToLaunchBinderView,
  } from './out-to-launch-status-model';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // ADOPT — idempotent and non-destructive, exactly as the legacy card did it.
  // It re-pins the engine accessor on every mount (a reboot swaps the instance)
  // and never resets a live bind.
  //
  // ⚠ THIS IS THE ONLY SURFACE THAT ADOPTS, AND THE PICKER IS ON IT, WHICH IS
  // WHAT MAKES THAT SAFE. `nodeLaunchpadMonitor.bind()` will mint an entry with
  // a NULL engine if it is called before any adopt, and `#pumpFrame` returns
  // early without an engine — a claimed device with a pump that never pushes.
  // Every bind route runs through the picker below, so the adopt has always
  // happened by then; and the accessor is a plain `{ get() }` over the engine
  // Canvas owns, so it stays valid after this component unmounts.
  $effect(() => {
    nodeLaunchpadMonitor.adopt(nodeId, engineCtx);
  });

  // The gesture outcome and the port roster live OUTSIDE this component (see
  // out-to-launch-cell-actions.ts): the ranked CONNECT cell is rendered by the
  // shared shell and cannot reach component state.
  let gestureV = $state(0);
  const off = onOutToLaunchGesture(() => { gestureV++; });
  onDestroy(off);

  // Every read is re-derived on the launchpad layer's own version rune plus the
  // registry's, which is the card's pattern — the device state is module-scope,
  // not node data, so there is nothing on the graph to key off.
  let v = $derived<OutToLaunchBinderView>(
    (statusRune(),
    void gestureV,
    {
      supported: midiAvailable(),
      bound: nodeLaunchpadMonitor.view(nodeId).bound,
      outputId: nodeLaunchpadMonitor.view(nodeId).outputId,
      outcome: outToLaunchGestureOutcome(),
      ports: outToLaunchPorts(),
    }),
  );

  let errorLine = $derived(outToLaunchErrorLine(v));
  let emptyLine = $derived(outToLaunchEmptyLine(v));

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction
  // — the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators. Absent means false, i.e. ON.
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

  function videoEngine(): VideoEngine | undefined {
    const e = engineCtx.get();
    if (!e) return undefined;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return undefined;
    }
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ BRIGHT / GAMMA ARE READ OFF THE ENGINE, NOT OFF THE GRAPH, and that is
  // the same choice the LED pump makes (`node-launchpad-monitor-registry`:
  // "never off a card's props — the card is the thing that may not exist").
  // Reading the same handle the hardware is fed from is what makes "the preview
  // shows exactly what the LEDs show" a structural fact instead of a claim.
  function paint(): void {
    rafId = null;
    const el = canvasEl;
    if (el) {
      const c2d = el.getContext('2d', { alpha: false });
      if (c2d) {
        const ve = videoEngine();
        const grid = (ve?.read(nodeId, 'grid9x9') as Uint8Array | undefined) ?? undefined;
        const bright = ve?.readParam(nodeId, 'bright') ?? OUT_TO_LAUNCH_DEFAULTS.bright;
        const gamma = ve?.readParam(nodeId, 'gamma') ?? OUT_TO_LAUNCH_DEFAULTS.gamma;
        drawOutToLaunchPreview(c2d, grid, bright, gamma);
      }
    }
    rafId = requestAnimationFrame(paint);
  }

  // ONE place owns the loop, so it cannot be started twice. The loop keeps
  // running with SCREEN OFF (there is simply no element to draw into), which
  // removes the "switched back on and the picture never came back" failure mode
  // by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(paint);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  function pick(port: LaunchpadPort): void {
    nodeLaunchpadMonitor.bind(nodeId, port.outputId);
  }
  /** The USER's explicit release — named for their intent, not a lifecycle. */
  function unbind(): void {
    nodeLaunchpadMonitor.unbind(nodeId);
  }
  const claimedByOther = (port: LaunchpadPort) => isOutputClaimed(port.outputId, nodeId);
</script>

<div class="otl-body" data-testid="out-to-launch-binder-body-{nodeId}">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        class="screen"
        width={OTL_PREVIEW_PX}
        height={OTL_PREVIEW_PX}
        data-testid="outToLaunch-face-canvas"
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="outToLaunch-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the preview off to reclaim its space. The module keeps rendering."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>

  <div class="binder">
    <div class="controls">
      {#if outToLaunchUnbindVisible(v)}
        <button
          class="otl-btn nodrag"
          type="button"
          data-testid="out-to-launch-binder-unbind-{nodeId}"
          onclick={unbind}
        >Unbind Launchpad</button>
      {/if}

      {#if outToLaunchPickerVisible(v)}
        <div
          class="picker"
          role="group"
          aria-label="Launchpad outputs"
          data-testid="out-to-launch-binder-picker-{nodeId}"
        >
          <!-- The testid carries the ROW INDEX, not the outputId: a port id is
               machine-specific (and on Windows two Launchpads can report the
               same name, #1101), so an id-keyed testid would be unaddressable
               from a spec. The `key` still uses outputId, which is what keeps
               the DOM stable across a re-enumeration. -->
          {#each v.ports as p, i (p.outputId)}
            <button
              class="otl-btn port nodrag"
              type="button"
              disabled={claimedByOther(p)}
              title={outToLaunchPortTitle(claimedByOther(p))}
              data-testid="out-to-launch-binder-port-{i}-{nodeId}"
              onclick={() => pick(p)}
            >{outToLaunchPortLabel(p, claimedByOther(p))}</button>
          {/each}
        </div>
      {/if}
    </div>

    {#if errorLine}
      <p class="err" data-testid="out-to-launch-binder-error-{nodeId}">{errorLine}</p>
    {:else if emptyLine}
      <p class="hint" data-testid="out-to-launch-binder-empty-{nodeId}">{emptyLine}</p>
    {/if}

    <span class="lamps">
      <StatusLed
        caption="MONITOR"
        lit={v.bound}
        detail={outToLaunchMonitorDetail(v)}
        testid="out-to-launch-led-monitor-{nodeId}"
      />
    </span>
  </div>
</div>

<style>
  /* ⚠ NO PANEL CHROME — no border, no background, no side padding. Same width
     decision `LaunchpadBinderBody` records: a bordered strip's rightmost ink is
     a TEXT RANGE that stops inside its own padding, which shows up as empty
     plate against the 40 px slack ceiling. The picture sets the plate here and
     everything lines up under it. */
  .otl-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px 0 6px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice. See the
     OVERLAY paragraph in module-faceplates.md: stacking it under the canvas
     cost ~18.8px on a card with ~11px of slack and reddened io-spec-
     consistency's card sweep. It OVERLAYS the picture's bottom-right corner,
     so the body is exactly the height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .screen {
    display: block;
    image-rendering: pixelated;
    border: 1px solid #000;
    border-radius: 6px;
    background: #060608;
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.7);
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

  .binder {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .picker { display: flex; flex-direction: column; gap: 4px; }
  .otl-btn {
    appearance: none;
    border: 1px solid var(--accent, #5a7);
    background: transparent;
    color: var(--accent, #5a7);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 10px;
    cursor: pointer;
  }
  .otl-btn:hover:not(:disabled) { filter: brightness(1.2); }
  .otl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  /* A device name is arbitrary-length machine text. Cap it so one long port
     name cannot set the plate width; the full name stays in `title`, and the
     accessible name is the button's own text either way. */
  .port {
    font-family: ui-monospace, monospace;
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
  }
  .hint { color: var(--muted, #888); }
  .err { color: #d66; }
  .lamps { display: inline-flex; align-items: center; gap: 12px; }
</style>
