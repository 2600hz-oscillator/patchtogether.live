<script lang="ts">
  // TrailsCard — the Bela TRAILS eurorack module's surface.
  //
  // Three things live here, and only one of them is a knob:
  //   * CONNECT — the gesture-gated Web MIDI request. It must be a real click
  //     handler with no `await` above the request, or Chromium spends the user
  //     activation and refuses to prompt.
  //   * the STATUS line — the difference between "no device", "denied",
  //     "the prompt was suppressed" and "bound", all of which look identical
  //     from a silent module.
  //   * the PAD MIRROR — a square view of the physical 85 × 85 mm surface, with
  //     one coloured dot and one fading trail per channel.
  //
  // ⚠ THE PAD IS A MIRROR, NOT A CONTROL. It is READ-ONLY: nothing here writes
  // a param, a `node.data` key or a Y.Doc update, and there is no pointer
  // handler on the canvas. That is what makes it honest to call this a bespoke
  // surface rather than an `xyPads` face cell — an `xyPads` pad is declared as
  // the two params its axes DRIVE, and these axes drive nothing; they report.
  //
  // ⚠ THE FRAME LOOP DRAWS ONLY WHEN THE DEVICE MOVED. `axisMessages` is a
  // monotonic counter on the engine handle; the rAF wakes, compares it against
  // the last frame it painted (plus the four gate levels) and returns without
  // touching the 2-D context when nothing changed. A rack full of idle TRAILS
  // cards therefore costs one integer compare per card per frame, not a canvas
  // repaint — and, because an idle card paints EXACTLY the resting grid, the
  // VRT capture of a fresh spawn is deterministic with no mask.

  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { KnobConic } from '$lib/ui/controls';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    trailsDef,
    TRAILS_TRAIL_LENGTH,
    type TrailsCardApi,
    type TrailsState,
  } from '$lib/audio/modules/trails';
  import { connectTrails, trailsMidiVersion, trailsStatus } from '$lib/midi/trails-device';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);
  const { paramVal, set, live, engineCtx } = cardParams(
    trailsDef,
    () => id,
    () => node,
  );

  const KNOBS = ['range', 'smooth', 'divisor'] as const;

  /** One colour per channel, matching the hardware's shine-through LEDs closely
   *  enough to tell four fingers apart at 150 px. */
  const CHANNEL_COLOURS = ['#4ecdc4', '#f2c14e', '#e06c9f', '#7aa2f7'] as const;

  /** Bumped by user actions so api-backed reads re-run alongside the store. */
  let revision = $state(0);

  // Mirror the device layer's version store into rune state with an INIT-TIME
  // subscription (the PtzcamCard finding: neither store sugar nor an
  // `$effect(() => store.subscribe(...))` bridge delivers updates here).
  let midiV = $state(0);
  onDestroy(
    trailsMidiVersion.subscribe((n) => {
      midiV = n;
    }),
  );

  function api(): TrailsCardApi | null {
    const engine = engineCtx.get();
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as TrailsCardApi | undefined) ?? null;
  }

  let status = $derived.by(() => {
    void midiV;
    void revision;
    return api()?.status() ?? trailsStatus();
  });
  let problem = $derived(status.kind !== 'bound' && status.kind !== 'idle');

  function onConnect(): void {
    // Straight from the click handler — an `await` above the request spends the
    // user activation. When this node's engine handle is not built yet (a click
    // can race the reconciler) fall through to the app-level connect rather
    // than dropping the gesture.
    const a = api();
    void (a ? a.connect() : connectTrails());
    revision++;
  }

  // ── The pad mirror ────────────────────────────────────────────────────────

  let canvas = $state<HTMLCanvasElement | null>(null);
  let rafId = 0;
  /** The `axisMessages` count + packed gate levels of the last painted frame.
   *  −1 forces the first paint (the resting grid). */
  let lastPainted = -1;
  let lastGateMask = -1;

  function readState(): TrailsState | null {
    return api()?.state() ?? null;
  }

  function paint(state: TrailsState | null): void {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const cssSize = el.clientWidth || 150;
    const px = Math.round(cssSize * dpr);
    if (el.width !== px || el.height !== px) {
      el.width = px;
      el.height = px;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);

    // Resting surface: the pad's face plus a centre cross. Drawn every frame so
    // there is no "cleared to nothing" state a stalled producer could leave.
    ctx.fillStyle = '#101318';
    ctx.fillRect(0, 0, cssSize, cssSize);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cssSize / 2, 0);
    ctx.lineTo(cssSize / 2, cssSize);
    ctx.moveTo(0, cssSize / 2);
    ctx.lineTo(cssSize, cssSize / 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.strokeRect(0.5, 0.5, cssSize - 1, cssSize - 1);

    if (!state) return;

    // The pad's Y axis points UP; the canvas's points DOWN. Flipping here is
    // what makes the view a MIRROR of the surface rather than of its reflection.
    const sx = (u: number): number => u * cssSize;
    const sy = (u: number): number => (1 - u) * cssSize;

    for (let i = 0; i < state.channels.length; i++) {
      const ch = state.channels[i];
      if (!ch || !ch.gate) continue;
      const colour = CHANNEL_COLOURS[i % CHANNEL_COLOURS.length]!;
      // Trail: oldest point faintest. One stroke per segment so the fade is
      // real rather than a single translucent polyline.
      for (let p = 1; p < ch.trail.length; p++) {
        const a = ch.trail[p - 1]!;
        const b = ch.trail[p]!;
        ctx.globalAlpha = (p / TRAILS_TRAIL_LENGTH) * 0.7;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(sx(ch.x), sy(ch.y), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(): void {
    const state = readState();
    let gateMask = 0;
    if (state) {
      for (let i = 0; i < state.channels.length; i++) {
        if (state.channels[i]?.gate) gateMask |= 1 << i;
      }
    }
    const stamp = state ? state.axisMessages : 0;
    if (stamp !== lastPainted || gateMask !== lastGateMask) {
      lastPainted = stamp;
      lastGateMask = gateMask;
      paint(state);
    }
    rafId = requestAnimationFrame(frame);
  }

  onMount(() => {
    paint(readState());
    rafId = requestAnimationFrame(frame);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  });

  const inputs = portsFromDef(trailsDef.inputs);
  const outputs = portsFromDef(trailsDef.outputs);
</script>

<div class="mod-card trails-card" data-testid={`trails-card-${id}`}>
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="TRAILS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="bind-row">
      <span class={`led led-${status.kind}`} data-testid={`trails-led-${id}`}></span>
      {#if status.kind !== 'bound'}
        <button type="button" class="connect" onclick={onConnect} data-testid={`trails-connect-${id}`}>
          Connect
        </button>
      {/if}
    </div>

    <p
      class="status"
      class:problem
      role={problem ? 'alert' : undefined}
      data-testid={`trails-status-${id}`}
    >
      {status.message}
    </p>

    <div class="pad-wrap">
      <canvas bind:this={canvas} class="pad" data-testid={`trails-pad-${id}`}></canvas>
    </div>

    <div class="knob-row">
      {#each KNOBS as knobId (knobId)}
        {@const spec = paramSpec(trailsDef, knobId)}
        <!-- min/max/curve/defaultValue come from the DEF via paramSpec — never
             re-typed here (card-range-source / card-control-ranges gates). -->
        <KnobConic
          value={paramVal(knobId)}
          min={spec.min}
          max={spec.max}
          defaultValue={spec.defaultValue}
          curve={spec.curve}
          label={knobId}
          moduleId={id}
          paramId={knobId}
          onchange={set(knobId)}
          readLive={live(knobId)}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .trails-card {
    width: 260px;
  }
  .stripe {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .bind-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 0;
  }
  .connect {
    font-size: 10px;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    flex: none;
  }
  .led-bound {
    background: #4caf7d;
  }
  .led-no-port,
  .led-denied,
  .led-no-prompt,
  .led-unsupported {
    background: #d98a3a;
  }
  .status {
    margin: 0;
    padding: 4px 14px 0;
    font-size: 9px;
    line-height: 1.3;
    opacity: 0.75;
  }
  .status.problem {
    color: #d98a3a;
    opacity: 1;
  }
  .pad-wrap {
    padding: 8px 14px 0;
    display: flex;
    justify-content: center;
  }
  .pad {
    display: block;
    /* SQUARE, because the surface it mirrors is square. Capped rather than
       filling the card: a full-width pad would put the card's natural height
       well past its declared rack tier for no extra readable detail — four
       dots and their trails resolve fine at this size. */
    width: 100%;
    max-width: 140px;
    aspect-ratio: 1 / 1;
    border-radius: 3px;
  }
  .knob-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 8px 14px 10px;
  }
</style>
