<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { timelordeDef } from '$lib/audio/modules/timelorde';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    bitmapToDots,
    bitmapSize,
    beatPulse,
    type WizardDot,
  } from '$lib/audio/modules/timelorde-wizard';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  // Live BPM the engine is currently locked to when an external clock
  // is patched (the worklet posts a measurement on each rising edge;
  // 0 means "no external lock right now, fall back to internal").
  // Polled at ~4 Hz — the worklet emits on edge so this just samples
  // the latest cached value.
  let measuredBpm = $state(0);
  $effect(() => {
    const e = engineCtx.get();
    if (!e || !node) return;
    const id = setInterval(() => {
      const v = e.read?.(node, 'measuredBpm');
      measuredBpm = typeof v === 'number' ? v : 0;
    }, 250);
    return () => clearInterval(id);
  });

  let bpm         = $derived((void cardVersion, node?.params.bpm         ?? 120));
  let swingAmount = $derived((void cardVersion, node?.params.swingAmount ?? 0));
  let swingSource = $derived((void cardVersion, node?.params.swingSource ?? 0));
  // v2: muteOutputs replaces isPlaying. Default 0 = unmuted/running.
  // Existing v1 patches save `isPlaying` (1=playing/0=stopped); the
  // factory's inline migrate-on-spawn flips them to muteOutputs, so
  // here we only read the new key.
  let muteOutputs = $derived((void cardVersion, (node?.params.muteOutputs ?? 0) >= 0.5));

  // running (v3): the GLOBAL transport. 1 = clock advances; 0 = HALTED (phase
  // freezes, gates go low). Distinct from MUTE (muteOutputs only silences gate
  // outputs; the internal clock keeps turning for LIVECODE). Every sequencer
  // locked to TIMELORDE — incl. the clip player — freezes when running = 0, so
  // this is the rack-wide stop/start.
  let running = $derived((void cardVersion, (node?.params.running ?? 1) >= 0.5));

  // wizardOn: the dot-matrix neon WIZARD graphic show/hide flag. Driven by
  // BOTH the on-card toggle button (toggleWizard, below) AND the `gate` input
  // level (the factory's pollWizardGate writes node.params.wizardOn from the
  // gate's level). They converge here on a single param — button = manual
  // override, gate = external control. Persisted on node.data + Y.Doc-synced.
  let wizardOn = $derived((void cardVersion, (node?.params.wizardOn ?? 1) >= 0.5));

  function toggleWizard() {
    set('wizardOn')(wizardOn ? 0 : 1);
  }

  // ---- Beat-pulse animation (the wizard flashes in time with the beat) ----
  //
  // The pulse intensity (0 dim … 1 flash) is computed by the PURE beatPulse()
  // helper from TIMELORDE's OWN bpm + running state (the same values the clock
  // worklet uses — we do NOT spin up a second clock; this is just a cheap
  // function of bpm and elapsed wall-clock time). An rAF loop re-evaluates it
  // each frame and writes the brightness to a CSS custom property.
  //
  // VRT/accessibility determinism: under `prefers-reduced-motion: reduce`
  // (which the VRT runner sets, alongside animations:'disabled') we DON'T run
  // the rAF loop and pin the pulse to 0 (the idle/dim frame) — so the card
  // renders one deterministic frame and stays in the strict VRT lane. Real
  // users without reduced-motion get the live beat pulse.
  let pulse = $state(0);
  // Wall-clock anchor: reset whenever the transport (re)starts so the flash
  // lands on the downbeat after a start rather than at an arbitrary offset.
  let beatAnchorMs = performance.now();
  let prevRunningForAnchor = running;

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  $effect(() => {
    // Re-anchor the beat phase on a stopped→running transition.
    if (running && !prevRunningForAnchor) beatAnchorMs = performance.now();
    prevRunningForAnchor = running;

    if (prefersReducedMotion()) {
      // Frozen, deterministic frame (VRT / reduced-motion): idle wizard.
      pulse = 0;
      return;
    }

    let raf: number | null = null;
    const tick = () => {
      // External-clock lock writes the measured tempo into node.params.bpm,
      // so reading the reactive `bpm` keeps the visual pulse on the real beat.
      pulse = beatPulse({
        bpm,
        running,
        nowMs: performance.now(),
        anchorMs: beatAnchorMs,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  // The dot-matrix wizard, derived once from the (data-driven) bitmap.
  const wizardDots: WizardDot[] = bitmapToDots();
  const wizardGrid = bitmapSize();

  let hasExternalClock = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'clock') return true;
    }
    return false;
  });
  // When start_in / stop_in are patched, an external transport owns `running`
  // (MIDICLOCK etc.), so the card's transport button steps aside to avoid a fight.
  let transportSlaved = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && (edge.target.portId === 'start_in' || edge.target.portId === 'stop_in'))
        return true;
    }
    return false;
  });

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function toggleMute() {
    // External clock no longer overrides — the user can mute the rack
    // even while MIDICLOCK drives TIMELORDE. The internal clock keeps
    // running for LIVECODE consumers regardless.
    set('muteOutputs')(muteOutputs ? 0 : 1);
  }
  function toggleRun() {
    // Global transport: halt/resume the whole rack clock. Musical position is
    // preserved (the worklet resumes from the frozen phase on restart).
    set('running')(running ? 0 : 1);
  }

  const OUT_LABELS = ['1x', '8x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64', 'swing'];
  const SRC_LABELS = ['1x', '8x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64'];

  const inputs: PortDescriptor[] = [
    { id: 'clock',    label: 'CLOCK IN', cable: 'gate' },
    // Transport gates — rising edge mirrors the ON / MUTE button.
    // Intended pairing: MIDICLOCK.midistart → START, MIDICLOCK.midistop → STOP.
    { id: 'start_in', label: 'START',    cable: 'gate' },
    { id: 'stop_in',  label: 'STOP',     cable: 'gate' },
    // ▭ = level-sensitive gate glyph. Drives the wizard show/hide (HIGH = on).
    { id: 'gate',     label: '▭ WIZARD', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = OUT_LABELS.map((label) => ({
    id: label,
    label: `CLOCK ${label.toUpperCase()}`,
    cable: 'gate',
  }));
</script>

<div class="mod-card timelorde-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="TIMELORDE" inline />
    <!-- Global TRANSPORT (running): halts/resumes the whole rack clock — every
         sequencer locked to TIMELORDE (incl. the clip player) stops with it.
         Hidden when an external transport (start_in/stop_in) owns `running`. -->
    {#if !transportSlaved}
      <button class="play-btn run-btn" class:playing={running} onclick={toggleRun} title={running ? 'Stop transport (halt the rack clock)' : 'Start transport (resume the rack clock)'} data-testid={`timelorde-run-${id}`}>
        {running ? '■' : '▶'}
      </button>
    {/if}
    <!-- MUTE always shown (v2 — clock keeps running even when an
         external clock is patched; the mute only silences the gate
         outputs, not the internal phase that LIVECODE rides on). -->
    <button class="play-btn" class:playing={!muteOutputs} onclick={toggleMute} title={muteOutputs ? 'Unmute (gates fire)' : 'Mute (gates go silent; internal clock keeps running for LIVECODE)'}>
        {muteOutputs ? 'MUTE' : 'ON'}
      </button>
  </header>

  <!-- Neon pixel-art WIZARD — a blown-up SOLID-PIXEL sprite (not a sparse
       dot-matrix) that pulses with the beat. The actual pixels come from the
       data-driven WIZARD_BITMAP in timelorde-wizard.ts (PLACEHOLDER art; the
       owner swaps that one constant for their own painting). The bloom here
       rides the beat-pulse rAF (frozen idle under reduced motion / VRT). Hidden
       via wizardOn (button or gate input). -->
  <div class="wizard-wrap">
    <button
      class="wizard-toggle"
      class:on={wizardOn}
      onclick={toggleWizard}
      title={wizardOn ? 'Hide the wizard' : 'Show the wizard'}
      data-testid={`timelorde-wizard-toggle-${id}`}
    >🧙</button>
    {#if wizardOn}
      <div
        class="wizard"
        data-testid={`timelorde-wizard-${id}`}
        style={`--wiz-cols:${wizardGrid.cols}; --wiz-rows:${wizardGrid.rows}; --wiz-pulse:${pulse.toFixed(3)};`}
      >
        {#each wizardDots as dot (dot.row * wizardGrid.cols + dot.col)}
          <span
            class={`dot dot-${dot.role}`}
            style={`grid-column:${dot.col + 1}; grid-row:${dot.row + 1};`}
          ></span>
        {/each}
      </div>
    {:else}
      <div class="wizard-off" data-testid={`timelorde-wizard-off-${id}`}>wizard off</div>
    {/if}
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={bpm}         min={10} max={300} defaultValue={120} label="BPM"   curve="log"      onchange={set('bpm')} moduleId={id} paramId="bpm"         readLive={live('bpm')} />
      <Knob value={swingAmount} min={0}  max={90}  defaultValue={0}   label="Swing" curve="linear"   onchange={set('swingAmount')} moduleId={id} paramId="swingAmount" readLive={live('swingAmount')} />
      <Knob value={swingSource} min={0}  max={10}  defaultValue={0}   label="Src"   curve="discrete" onchange={set('swingSource')} moduleId={id} paramId="swingSource" />
    </div>

    <div class="footer">
      {(hasExternalClock && measuredBpm > 0 ? measuredBpm : bpm).toFixed(0)} BPM ({hasExternalClock ? 'external' : 'internal'}) · src={SRC_LABELS[Math.round(swingSource)] ?? '1x'}
    </div>
  </PatchPanel>
</div>

<style>
  .timelorde-card {
    width: 280px;
    padding-bottom: 26px;
  }
  .timelorde-card > .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  /* The global transport reads distinct from MUTE: accent-tinted while running. */
  .run-btn.playing {
    background: var(--accent, #6cf);
    border-color: var(--accent, #6cf);
    color: #1a1d23;
  }
  .knob-row {
    margin: 16px 0 0;
    display: flex;
    flex-direction: row;
    justify-content: center;
    gap: 14px;
  }
  .footer {
    margin-top: 12px;
    text-align: center;
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }

  /* ---- Dot-matrix neon WIZARD ---- */
  .wizard-wrap {
    position: relative;
    margin: 12px 0 4px;
    display: flex;
    justify-content: center;
  }
  .wizard-toggle {
    position: absolute;
    top: -4px;
    right: 8px;
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    border-radius: 3px;
    font-size: 0.8rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0.55;
    filter: grayscale(1);
    z-index: 1;
  }
  .wizard-toggle.on {
    opacity: 1;
    filter: none;
    border-color: var(--cable-gate);
    box-shadow: 0 0 4px var(--cable-gate);
  }
  .wizard {
    /* SOLID-PIXEL render: each lit cell is a full square (no gap), so adjacent
       cells merge into clean blocks — a blown-up pixel-art sprite of the
       thumbnail, NOT a sparse dot-matrix (the spaced circles looked bad scaled
       up). One px var sizes the whole sprite. */
    --px: 8px;
    display: grid;
    grid-template-columns: repeat(var(--wiz-cols), var(--px));
    grid-template-rows: repeat(var(--wiz-rows), var(--px));
    gap: 0;
    padding: 10px;
    background: #07090d;
    border: 1px solid #1a1f2a;
    border-radius: 4px;
    /* Overall neon bloom rides the beat-pulse on the WHOLE sprite (dim idle →
       bright flash), rather than per-pixel blooms that muddy a solid sprite. */
    filter: brightness(calc(0.82 + 0.5 * var(--wiz-pulse, 0)))
            drop-shadow(0 0 calc(2px + 8px * var(--wiz-pulse, 0)) var(--cable-gate, #ffd23f));
    /* Scale up subtly on the beat (1.0 idle → ~1.05 flash). */
    transform: scale(calc(1 + 0.05 * var(--wiz-pulse, 0)));
    transform-origin: center bottom;
  }
  .dot {
    /* A solid square pixel filling its whole grid cell (no radius, no gap). */
    width: var(--px);
    height: var(--px);
  }
  /* Neon palette — body via the gate cable accent, warm skin, bright staff/orb
     ("the magic"). Solid fills; the container's filter supplies the glow. */
  .dot-hat,
  .dot-body { background: var(--cable-gate, #ffd23f); }
  .dot-skin { background: #ffd9b0; }
  .dot-staff { background: #7bdfff; }
  .wizard-off {
    font-size: 0.55rem;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    padding: 18px 0;
    opacity: 0.5;
  }
  /* Reduced motion (also the VRT capture): no transform animation; the JS
     loop already pins pulse=0, so this is belt-and-braces for the scale. */
  @media (prefers-reduced-motion: reduce) {
    .wizard { transform: none; }
  }
</style>
