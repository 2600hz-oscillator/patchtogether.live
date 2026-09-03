<script lang="ts">
  // ⚠ THIS CARD NO LONGER PRODUCES ANYTHING, AND THAT IS THE WHOLE EDIT
  // (legacy-removal S1). It used to run the cvCombined push — the ONLY path a
  // same-domain cv cable has to a display param — inside its own repaint loop,
  // so `scope` sat in `CARD_PRODUCER_LANE_TYPES` and the default shell kept this
  // card mounted OFF-SCREEN in `<HeadlessSourceHost>` purely to keep that push
  // alive. It belongs to the NODE now (`$lib/ui/media/frame-producers`), and the
  // TRACE moved to `scope/ScopeTraceSurface.svelte` so this card, the dock
  // faceplate body and `GroupCard`'s viz-passthrough mount all paint one picture
  // from one file. What is left here is the frame, the controls and the tuner.
  //
  // ⚠ DO NOT SPELL THE SEAM CALL-SHAPED IN A COMMENT IN THIS SUBTREE. The
  // producer gate in `dom-source-modules.test.ts` matches its seam regexes
  // against RAW source — it strips no comments — so writing the push out as a
  // call here re-enrols `scope` in the set this diff removes it from, and the
  // gate's own header admits the blind spot. Name it, never spell it.
  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  // NB: no `patch` store import — the last direct reader was `toggleXY`'s bare
  // proxy assignment, which now goes through `setNodeParam` like every other
  // write on this card.
  import { setNodeParam } from '$lib/graph/mutate';
  import { scopeDef, type PitchResult } from '$lib/audio/modules/scope';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import ScopeTraceSurface from './scope/ScopeTraceSurface.svelte';
  import { portsFromDef } from './card-kit';

  // Inputs: 2 audio channels + 1 CV per param. Port ids match SCOPE's
  // module def 1:1 (the io-spec consistency e2e test enforces this);
  // the CV bridge auto-routes via setParam(portId).
  const inputs: PortDescriptor[] = [
    { id: 'ch1', label: 'CHANNEL 1', cable: 'audio' },
    { id: 'ch2', label: 'CHANNEL 2', cable: 'audio' },
    { id: 'timeMs',    label: 'TIME (CV)',     cable: 'cv' },
    { id: 'ch1Scale',  label: 'CH1 SCALE (CV)',  cable: 'cv' },
    { id: 'ch1Offset', label: 'CH1 OFFSET (CV)', cable: 'cv' },
    // ch{1,2}Range and mode are discrete (0/1) but accepting CV is
    // useful: any signal ≥ 0.5 flips to the alt state. Stable Eurorack
    // gate convention.
    { id: 'ch1Range',  label: 'CH1 RANGE (CV)',  cable: 'cv' },
    { id: 'ch2Scale',  label: 'CH2 SCALE (CV)',  cable: 'cv' },
    { id: 'ch2Offset', label: 'CH2 OFFSET (CV)', cable: 'cv' },
    { id: 'ch2Range',  label: 'CH2 RANGE (CV)',  cable: 'cv' },
    { id: 'mode',      label: 'XY MODE (CV)',    cable: 'cv' },
    { id: 'intensity', label: 'INTENSITY (CV)',  cable: 'cv' },
  ];
  const outputs = portsFromDef(scopeDef.outputs, {
    ch1_out: 'CHANNEL 1 OUT', ch2_out: 'CHANNEL 2 OUT', out: 'VIDEO OUT',
  });

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // KNOB positions, read from the patch (single source of truth for the
  // FADERS and the mode toggles — a fader shows where the user put it,
  // never where a cable has pushed it).
  //
  // What the TRACE is drawn with is a different question, and the answer
  // is `eng.read(node, 'drawParams')` — the module's combined knob + CV
  // values, the same record its video-out `drawFrame` renders from, so
  // the on-card picture and the video output cannot disagree (#1664).
  // `ScopeTraceSurface` owns that read; these are the FADER positions only.
  let timeMs    = $derived(node?.params.timeMs    ?? scopeDef.params[0]!.defaultValue);
  let ch1Scale  = $derived(node?.params.ch1Scale  ?? scopeDef.params[1]!.defaultValue);
  let ch1Offset = $derived(node?.params.ch1Offset ?? scopeDef.params[2]!.defaultValue);
  let ch1Range  = $derived(node?.params.ch1Range  ?? scopeDef.params[3]!.defaultValue);
  let ch2Scale  = $derived(node?.params.ch2Scale  ?? scopeDef.params[4]!.defaultValue);
  let ch2Offset = $derived(node?.params.ch2Offset ?? scopeDef.params[5]!.defaultValue);
  let ch2Range  = $derived(node?.params.ch2Range  ?? scopeDef.params[6]!.defaultValue);
  let xyMode    = $derived((node?.params.mode ?? 0) >= 0.5);
  // Phosphor INTENSITY (beam persistence). Default 0.5 (12:00) = legacy
  // render (pixel-identical). See scope-draw.intensityToPersistScreens.
  let intensity = $derived(
    (node?.params.intensity as number | undefined) ?? scopeDef.params[8]!.defaultValue,
  );

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  // ⚠ THIS WAS A BARE PROXY ASSIGNMENT, AND THE THREE LINES BELOW IT WERE NOT.
  // `toggleXY` used to write `patch.nodes[id].params.mode` directly, while
  // `toggleRange` — its immediate neighbour, the same gesture on the same card
  // — has always gone through `setNodeParam`. `setNodeParam` wraps the write in
  // `ydoc.transact(fn, LOCAL_ORIGIN)`, and the UndoManager is configured
  // `trackedOrigins: new Set([LOCAL_ORIGIN])`. A bare assignment runs with
  // origin `null`. So flipping XY was NOT UNDOABLE and did not carry the tag a
  // collaborator's client keys on, while flipping either range switch beside it
  // was and did.
  //
  // ⚠ PAID BY EDITING THIS CARD, NOT BY FACING THE MODULE — and the difference
  // is recorded rather than assumed. #2025 argued this class of debt was "paid
  // by construction" once a faceplate routed the param through the normal path;
  // `raw-write-ledger.ts` refutes that by name. Promotion does not delete the
  // card: the per-card VRT sweep still renders it under `?shell=legacy`, so the
  // face would have given faced users a correct toggle and left legacy users
  // with the broken one. A face does not pay a card's debt; editing the card
  // does. The ledger entry for this file is deleted in the same diff, because
  // its anchor runs BOTH ways — a stale entry naming a write that no longer
  // exists is as red as an unlisted raw write.
  function toggleXY() {
    setNodeParam(id, 'mode', xyMode ? 0 : 1);
  }
  function toggleRange(channel: 1 | 2) {
    const key = channel === 1 ? 'ch1Range' : 'ch2Range';
    setNodeParam(id, key, (node?.params[key] ?? 0) >= 0.5 ? 0 : 1);
  }

  // Cable tints for the two per-channel MODE BUTTONS in the header (the trace
  // resolves its own copies — see ScopeTraceSurface). $state so the buttons pick
  // up the post-mount values, and `onMount` rather than `$effect` for the reason
  // the surface records: an effect that reads each colour in its own `||`
  // fallback and writes it depends on the state it assigns.
  let ch1Color = $state('#fbbf24');
  let ch2Color = $state('#60a5fa');
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    ch1Color = cs.getPropertyValue('--cable-audio').trim() || ch1Color;
    ch2Color = cs.getPropertyValue('--cable-pitch').trim() || ch2Color;
  });

  // Pitch tuner readout — sampled at ~10 Hz (NOT rAF; frame-rate jitter would
  // make the Hz value flicker). When ch1 has no pitched signal, all three
  // fields read null and the UI shows em-dashes.
  let pitch: PitchResult = $state({ hz: null, note: null, cents: null, confidence: null });
  let pitchTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    pitchTimer = setInterval(() => {
      const eng = engineCtx.get();
      if (!eng || !node) return;
      const p = eng.read(node, 'pitch') as PitchResult | undefined;
      if (p) pitch = p;
    }, 100);
    return () => {
      if (pitchTimer !== null) clearInterval(pitchTimer);
      pitchTimer = null;
    };
  });

  onDestroy(() => {
    if (pitchTimer !== null) clearInterval(pitchTimer);
  });

  function fmtHz(hz: number | null): string {
    if (hz === null) return '—';
    return `${hz.toFixed(1)} Hz`;
  }
  // Tuning meter: cents → percentage offset from center. -50 → 0%, 0 → 50%, +50 → 100%.
  let meterPct = $derived(
    pitch.cents === null ? 50 : Math.max(0, Math.min(100, 50 + pitch.cents)),
  );
  let inTune = $derived(pitch.cents !== null && Math.abs(pitch.cents) <= 5);
</script>

<div class="vcard card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="Scope" inline />
    <!-- Per-channel AUDIO↔CV display-mode toggles. Mirrors the FOXY VCO
         freeze-toggle UX (aria-pressed + named-mode label). Pressed =
         the CV range is active (the channel-trace scales ±5V to full
         height); unpressed = AUDIO (±1.0). The toggle ONLY affects
         display scaling — both inputs accept signal regardless. -->
    <button
      class="mode-btn"
      class:cv={ch1Range >= 0.5}
      style="color: {ch1Color};"
      aria-pressed={ch1Range >= 0.5}
      data-testid="scope-ch1-mode"
      onclick={() => toggleRange(1)}
      title={ch1Range >= 0.5 ? 'Ch1: CV display (±5V) — click for AUDIO' : 'Ch1: AUDIO display (±1.0) — click for CV'}
    >
      <span class="mode-ch">1</span>
      <span class="mode-label">{ch1Range >= 0.5 ? 'CV' : 'AUDIO'}</span>
    </button>
    <button
      class="mode-btn"
      class:cv={ch2Range >= 0.5}
      style="color: {ch2Color};"
      aria-pressed={ch2Range >= 0.5}
      data-testid="scope-ch2-mode"
      onclick={() => toggleRange(2)}
      title={ch2Range >= 0.5 ? 'Ch2: CV display (±5V) — click for AUDIO' : 'Ch2: AUDIO display (±1.0) — click for CV'}
    >
      <span class="mode-ch">2</span>
      <span class="mode-label">{ch2Range >= 0.5 ? 'CV' : 'AUDIO'}</span>
    </button>
    <button
      class="xy-btn"
      class:active={xyMode}
      data-testid="scope-xy-mode"
      aria-pressed={xyMode}
      onclick={toggleXY}
      title={xyMode ? 'X/Y (Lissajous) mode — click for NORMAL (dual-trace)' : 'NORMAL (dual-trace) — click for X/Y (Lissajous)'}
    >
      {xyMode ? 'XY' : '⇆'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="screen-wrap">
      <!-- THE trace, not a copy of it. The surface emits the `scope-canvas`
           element itself and no wrapper, so it stays the only child of
           `.screen-wrap` and this box is unchanged.

           ⚠ `vizPassthrough` STAYS FALSE HERE. `data-viz-passthrough` is how
           GroupCard FINDS a canvas to portal-hoist, and the group now mounts its
           OWN ScopeTraceSurface rather than this whole card — so emitting the
           marker here would give a collapsed group two candidate canvases for
           one node and let it hoist the wrong one. -->
      <ScopeTraceSurface nodeId={id} width={320} height={300} />
    </div>

    <div class="tuner" data-testid="scope-tuner">
      <div class="tuner-readout">
        <span class="lbl">PITCH</span>
        <span class="val val-hz" data-testid="pitch-hz">{fmtHz(pitch.hz)}</span>
        <span class="sep">|</span>
        <span class="lbl">NOTE</span>
        <span class="val val-note" data-testid="pitch-note">{pitch.note ?? '—'}</span>
      </div>
      <div class="meter" data-testid="tuning-meter">
        <div class="meter-tick" data-testid="tuning-meter-center"></div>
        <div
          class="meter-marker"
          class:in-tune={inTune}
          class:idle={pitch.cents === null}
          style="left: {meterPct}%;"
          data-testid="tuning-meter-marker"
        ></div>
      </div>
    </div>

    <div class="fader-row">
      <NeonFader value={timeMs}    min={1}    max={200} defaultValue={20} label="Time" units="ms" curve="log"    onchange={setParam('timeMs')} moduleId={id} paramId="timeMs" />
      <NeonFader value={ch1Scale}  min={0.1}  max={10}  defaultValue={1}  label="1 Sc"            curve="log"    onchange={setParam('ch1Scale')} moduleId={id} paramId="ch1Scale" />
      <NeonFader value={ch1Offset} min={-1}   max={1}   defaultValue={0}  label="1 Y"             curve="linear" onchange={setParam('ch1Offset')} moduleId={id} paramId="ch1Offset" />
      <NeonFader value={ch2Scale}  min={0.1}  max={10}  defaultValue={1}  label="2 Sc"            curve="log"    onchange={setParam('ch2Scale')} moduleId={id} paramId="ch2Scale" />
      <NeonFader value={ch2Offset} min={-1}   max={1}   defaultValue={0}  label="2 Y"             curve="linear" onchange={setParam('ch2Offset')} moduleId={id} paramId="ch2Offset" />
      <!-- Phosphor INTENSITY (beam persistence). 0.5 (12:00, centered) =
           today's render; down toward 7:00 → a moving dot; up toward 5:00 →
           a ~2-screen persistence trail. Display-only. -->
      <NeonFader value={intensity} min={0}    max={1}   defaultValue={0.5} label="Inten"          curve="linear" onchange={setParam('intensity')} moduleId={id} paramId="intensity" />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 270px;
  }
  .stripe {
    background: var(--cable-cv);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .xy-btn {
    width: 28px;
    height: 18px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text-dim);
    border-radius: 3px;
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    font-family: inherit;
  }
  .xy-btn.active {
    background: var(--accent);
    color: #1a1d23;
    border-color: var(--accent);
  }
  .mode-btn {
    height: 18px;
    min-width: 48px;
    padding: 0 5px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .mode-btn[aria-pressed='true'] {
    background: #1c2028;
    border-color: currentColor;
  }
  .mode-btn .mode-ch {
    opacity: 0.7;
    font-weight: 600;
  }
  .mode-btn .mode-label {
    font-variant: small-caps;
    letter-spacing: 0.04em;
  }
  .screen-wrap {
    margin: 16px 30px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  /* `:global(canvas)` because the element belongs to `ScopeTraceSurface` now —
     Svelte's scoped selector would not reach a child component's DOM. Scoped by
     `.screen-wrap`, so nothing leaks, and the computed box is unchanged (the
     VRT card baselines pin it). */
  .screen-wrap :global(canvas) {
    display: block;
    width: 100%;
    /* 3u SCOPE — a big screen that fills the taller tier (the rack forces the
     * card to 3u = 540px; the trace bitmap is 320×300 so it stays crisp). */
    height: 300px;
  }
  .fader-row {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 12px;
  }
  .tuner {
    margin: 6px 30px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
  }
  .tuner-readout {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 6px;
    font-size: 0.6rem;
    color: var(--text-dim);
  }
  .tuner-readout .lbl {
    font-variant: small-caps;
    letter-spacing: 0.04em;
  }
  .tuner-readout .val {
    font-family: ui-monospace, monospace;
    color: var(--text);
    font-size: 0.7rem;
  }
  .tuner-readout .val-hz {
    min-width: 5.5em;
    text-align: right;
  }
  .tuner-readout .val-note {
    min-width: 2.5em;
    text-align: left;
  }
  .tuner-readout .sep {
    opacity: 0.4;
  }
  .meter {
    position: relative;
    height: 8px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 2px;
    margin: 0 auto;
    width: 100%;
    max-width: 220px;
  }
  .meter-tick {
    position: absolute;
    top: -1px;
    bottom: -1px;
    left: 50%;
    width: 1px;
    background: var(--text-dim);
    opacity: 0.6;
    transform: translateX(-0.5px);
  }
  .meter-marker {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 3px;
    background: #f59e0b;
    border-radius: 1px;
    transform: translateX(-1.5px);
    transition: left 80ms linear, background 80ms linear;
  }
  .meter-marker.in-tune {
    background: #4ade80;
  }
  .meter-marker.idle {
    background: var(--text-dim);
    opacity: 0.3;
  }
</style>
