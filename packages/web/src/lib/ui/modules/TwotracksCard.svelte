<script lang="ts">
  // TwotracksCard — tape loop emulator card (Phase 4: live waveform + WAV export).
  //
  // Layout: horizontal — reel A (left) | center col (A/B + Lofi) | reel B (right)
  //
  // All param writes go through setNodeParam() — never direct node.params mutation.
  // Per-frame playhead scrub state kept LOCAL — NOT written to Y.Doc per frame.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  // ⚠ THE TWO ROSTERS ARE IMPORTED, NEVER RE-TYPED. Both used to be private
  // arrays in this file, which is how the def's own `docs` string was free to
  // describe the filter as "off / low-pass / high-pass" — modes 1 and 2 the
  // wrong way round — for as long as it did: nothing joined the words the card
  // painted to the words the contract published, so neither could contradict
  // the other. The def now declares both as `options` from these symbols.
  import {
    twotracksDef, type TwoTracksData, TWOTRACKS_MAX_SAMPLES, abGains,
    clampLoopStart, clampLoopEnd, TWOTRACKS_FILTER_MODES, TWOTRACKS_LOFI_MODES,
  } from '$lib/audio/modules/twotracks';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { paramSpec, portsFromDef } from './card-kit';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import {
    drawTwotracksReel, twotracksHandleHit, twotracksPosToFrac,
    type TwotracksReelView,
  } from './twotracks-waveform-draw';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ⚠ THE RANGES COME FROM THE DEF, ONCE. Every one of these was re-typed here
  // as a literal and every one AGREED — so this is a maintainability conversion
  // rather than a bug fix, and it is pixel-neutral (twotracks has no committed
  // card baseline; it is in EXEMPT_FROM_VRT). What makes it worth doing WITH the
  // promotion is that from here the DOCK renders these controls straight off the
  // ParamDef while this card renders its own numbers, so a later edit to one
  // copy would ship two surfaces disagreeing about one control.
  //
  // ⚠ RANGE ONLY — deliberately NOT in MAPPING_BOUND_CARDS, for two reasons the
  // measurement found rather than assumed. RATE passes `units="×"` where the def
  // declares none, so binding `units` would silently drop a suffix the card has
  // always printed. And ECHOES passes `curve="linear"` against the def's
  // `discrete` — which CLAUDE.md names as a live platform gap rather than a
  // declaration bug (`Knob.svelte` has no discrete branch, so writing
  // `discrete` here would green a gate and change nothing). The card does its
  // own `Math.round` on that write; the FACE needs none, because the conic-knob
  // model quantises discrete params itself.
  const P = {
    rate_a: paramSpec(twotracksDef, 'rate_a'),
    echoes_a: paramSpec(twotracksDef, 'echoes_a'),
    eqLow_a: paramSpec(twotracksDef, 'eqLow_a'),
    eqMid_a: paramSpec(twotracksDef, 'eqMid_a'),
    eqHigh_a: paramSpec(twotracksDef, 'eqHigh_a'),
    cutoff_a: paramSpec(twotracksDef, 'cutoff_a'),
    reso_a: paramSpec(twotracksDef, 'reso_a'),
    rate_b: paramSpec(twotracksDef, 'rate_b'),
    echoes_b: paramSpec(twotracksDef, 'echoes_b'),
    eqLow_b: paramSpec(twotracksDef, 'eqLow_b'),
    eqMid_b: paramSpec(twotracksDef, 'eqMid_b'),
    eqHigh_b: paramSpec(twotracksDef, 'eqHigh_b'),
    cutoff_b: paramSpec(twotracksDef, 'cutoff_b'),
    reso_b: paramSpec(twotracksDef, 'reso_b'),
    ab: paramSpec(twotracksDef, 'ab'),
    a2b: paramSpec(twotracksDef, 'a2b'),
    b2a: paramSpec(twotracksDef, 'b2a'),
  } as const;


  const defaultFor = (k: string): number =>
    twotracksDef.params.find((p) => p.id === k)?.defaultValue ?? 0;

  // ─── Reel A synced params ───
  let rateA         = $derived(node?.params.rate_a         ?? defaultFor('rate_a'));
  let modeA         = $derived(node?.params.mode_a         ?? defaultFor('mode_a'));
  let echoesA       = $derived(node?.params.echoes_a       ?? defaultFor('echoes_a'));
  let overdubFlagA  = $derived(node?.params.overdub_flag_a ?? defaultFor('overdub_flag_a'));
  let eqLowA        = $derived(node?.params.eqLow_a        ?? 0);
  let eqMidA        = $derived(node?.params.eqMid_a        ?? 0);
  let eqHighA       = $derived(node?.params.eqHigh_a       ?? 0);
  let filterModeA   = $derived(node?.params.filterMode_a   ?? 0);
  let cutoffA       = $derived(node?.params.cutoff_a       ?? 20000);
  let resoA         = $derived(node?.params.reso_a         ?? 0);
  // Loop scrubbers (fractions of the WHOLE tape — matches the waveform draw).
  let startA        = $derived(node?.params.start_a        ?? defaultFor('start_a'));
  let endA          = $derived(node?.params.end_a          ?? defaultFor('end_a'));

  // ─── Reel B synced params ───
  let rateB         = $derived(node?.params.rate_b         ?? defaultFor('rate_b'));
  let modeB         = $derived(node?.params.mode_b         ?? defaultFor('mode_b'));
  let echoesB       = $derived(node?.params.echoes_b       ?? defaultFor('echoes_b'));
  let overdubFlagB  = $derived(node?.params.overdub_flag_b ?? defaultFor('overdub_flag_b'));
  let eqLowB        = $derived(node?.params.eqLow_b        ?? 0);
  let eqMidB        = $derived(node?.params.eqMid_b        ?? 0);
  let eqHighB       = $derived(node?.params.eqHigh_b       ?? 0);
  let filterModeB   = $derived(node?.params.filterMode_b   ?? 0);
  let cutoffB       = $derived(node?.params.cutoff_b       ?? 20000);
  let resoB         = $derived(node?.params.reso_b         ?? 0);
  // Loop scrubbers reel B.
  let startB        = $derived(node?.params.start_b        ?? defaultFor('start_b'));
  let endB          = $derived(node?.params.end_b          ?? defaultFor('end_b'));

  // ─── Global A/B param ───
  let abParam = $derived(node?.params.ab ?? 0);

  // ─── Cross-feed params (A→B / B→A), default off ───
  let a2bParam = $derived(node?.params.a2b ?? 0);
  let b2aParam = $derived(node?.params.b2a ?? 0);

  // ─── Global Lofi param ───
  let lofiParam = $derived(node?.params.lofi ?? 0);

  // ─── Global Monitor (input passthrough) ───
  let monitorOn = $derived(Math.round(node?.params.monitor ?? 0) === 1);

  // ─── Worklet data ───
  let transportStateA = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.transportState_a ?? 'idle';
  });
  let transportStateB = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.transportState_b ?? 'idle';
  });
  // Peaks AND playhead are local volatile render state — polled via eng.read()
  // like SCOPE snapshots, NEVER stored in node.data/Y.Doc (Float32Array can't be
  // Y.Doc-encoded; a per-frame playhead proxy write is the live-store render
  // storm). The worklet only emits new values while a reel is active, so an idle
  // module settles to a fixed playhead + null peaks and this poll stops mutating
  // state → the card is completely static on spawn (no flicker / no sweep).
  let peaksA = $state<Float32Array | null>(null);
  let peaksB = $state<Float32Array | null>(null);
  let syncedPlayheadA = $state(0);
  let syncedPlayheadB = $state(0);
  // ⚠ THIS RUNS ON THE SHARED, VISIBILITY-GATED TICKER — it used to be a private
  // `requestAnimationFrame` loop with no gate at all, so a mounted-but-offscreen
  // twotracks read the engine and invalidated its canvases forever, on the same
  // main thread the audio render thread contends with. That is the exact loop
  // `onMeterFrame` exists to collapse (one rAF for every meter card, skipped
  // while the element is off screen). Gated on reel A's canvas: both canvases
  // live in this one card, so they enter and leave the viewport together.
  $effect(() => {
    const gateEl = canvasElA;
    const handle = onMeterFrame(gateEl, () => {
      const eng = engineCtx.get();
      if (!eng || !node) return;
      const pA = eng.read(node, 'peaksA') as Float32Array | null;
      const pB = eng.read(node, 'peaksB') as Float32Array | null;
      if (pA !== peaksA) peaksA = pA;
      if (pB !== peaksB) peaksB = pB;
      const hA = eng.read(node, 'playheadA') as number | undefined;
      const hB = eng.read(node, 'playheadB') as number | undefined;
      if (typeof hA === 'number' && hA !== syncedPlayheadA) syncedPlayheadA = hA;
      if (typeof hB === 'number' && hB !== syncedPlayheadB) syncedPlayheadB = hB;
    });
    return () => handle.stop();
  });

  let bufLenA = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.bufLenA ?? 0;
  });
  let bufLenB = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.bufLenB ?? 0;
  });

  // ─── Derived LEDs reel A ───
  let ledArmA     = $derived(transportStateA === 'armed');
  let ledRecA     = $derived(transportStateA === 'rec' || transportStateA === 'overdub');
  let ledPlayA    = $derived(transportStateA === 'play' || transportStateA === 'rec' || transportStateA === 'overdub');
  let ledOverdubA = $derived(transportStateA === 'overdub');

  // ─── Derived LEDs reel B ───
  let ledArmB     = $derived(transportStateB === 'armed');
  let ledRecB     = $derived(transportStateB === 'rec' || transportStateB === 'overdub');
  let ledPlayB    = $derived(transportStateB === 'play' || transportStateB === 'rec' || transportStateB === 'overdub');
  let ledOverdubB = $derived(transportStateB === 'overdub');

  // ─── Mode / overdub toggles ───
  let isLoopA     = $derived(Math.round(modeA) === 1);
  let isLoopB     = $derived(Math.round(modeB) === 1);
  let overdubActA = $derived(Math.round(overdubFlagA) === 1);
  let overdubActB = $derived(Math.round(overdubFlagB) === 1);

  // ─── A/B gain display ───
  let gains = $derived(abGains(abParam));

  // ─── Canvas + scrub state (local) ───
  let canvasElA: HTMLCanvasElement | null = $state(null);
  let canvasElB: HTMLCanvasElement | null = $state(null);
  let scrubbingA = $state(false);
  let scrubbingB = $state(false);
  let localPlayheadA = $state(0);
  let localPlayheadB = $state(0);

  // Scrub velocity tracking (local — NOT written to Y.Doc per frame)
  let pointerPrevXA = 0;
  let pointerPrevXB = 0;

  let displayPlayheadA = $derived(scrubbingA ? localPlayheadA : syncedPlayheadA);
  let displayPlayheadB = $derived(scrubbingB ? localPlayheadB : syncedPlayheadB);

  // While a reel is actively rolling (and has tape), the loop handles can't be
  // dragged past the playhead — it must stay inside [start, end]. When idle the
  // playhead resets to the window start on the next PLAY, so dragging is free
  // (clamp arg = null). Mirrors clampLoopStart/clampLoopEnd's playhead rule.
  let rollingA = $derived(transportStateA !== 'idle' && bufLenA > 0);
  let rollingB = $derived(transportStateB !== 'idle' && bufLenB > 0);
  let playheadClampA = $derived(rollingA ? displayPlayheadA : null);
  let playheadClampB = $derived(rollingB ? displayPlayheadB : null);

  // Loop-handle drag state (separate from playhead scrub). Pointer-down
  // hit-tests which marker is grabbed; null = scrubbing the playhead.
  let dragHandleA = $state<'start' | 'end' | null>(null);
  let dragHandleB = $state<'start' | 'end' | null>(null);

  /** The current filter mode's NAME, off the def's roster. */
  function filterLabel(v: number): string {
    const i = Math.round(v);
    return TWOTRACKS_FILTER_MODES.find((m) => m.value === i)?.label ?? TWOTRACKS_FILTER_MODES[0].label;
  }

  const inputs = portsFromDef(twotracksDef.inputs, {
    audio_l_in_a: 'L IN A', audio_r_in_a: 'R IN A', rec_start_a: 'REC START A',
    rec_arm_a: 'REC ARM A', overdub_a: 'OVERDUB A', rate_cv_a: 'RATE CV A',
    audio_l_in_b: 'L IN B',
    audio_r_in_b: 'R IN B', rec_start_b: 'REC START B', rec_arm_b: 'REC ARM B',
    overdub_b: 'OVERDUB B', rate_cv_b: 'RATE CV B',
  });
  const outputs = portsFromDef(twotracksDef.outputs, { out_l: 'OUT L', out_r: 'OUT R' });

  // ─── Helpers ───

  // The tape geometry, the hit-test and the draw all live in
  // `twotracks-waveform-draw.ts` and are SHARED with the faceplate body. See
  // that file's header for why a copy here would be a defect rather than
  // duplication: the hit-test and the draw are the same arithmetic, and a drift
  // between them is a dead zone the player feels as an unresponsive handle.
  function posPxToNorm(x: number, canvas: HTMLCanvasElement | null): number {
    if (!canvas) return 0;
    return twotracksPosToFrac(x, canvas.clientWidth || canvas.width);
  }
  const handleHit = twotracksHandleHit;

  function setStartA(norm: number) { setNodeParam(id, 'start_a', clampLoopStart(norm, endA, playheadClampA)); }
  function setEndA(norm: number)   { setNodeParam(id, 'end_a',   clampLoopEnd(norm, startA, playheadClampA)); }
  function setStartB(norm: number) { setNodeParam(id, 'start_b', clampLoopStart(norm, endB, playheadClampB)); }
  function setEndB(norm: number)   { setNodeParam(id, 'end_b',   clampLoopEnd(norm, startB, playheadClampB)); }

  function sendSeek(reel: 'a' | 'b', pos: number): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        const port = eng.read(node, 'workletPort') as MessagePort | undefined;
        if (port) port.postMessage({ type: 'seek', reel, pos });
      } catch { /* engine may not be ready */ }
    }
  }

  function requestDumpTape(reel: 'a' | 'b'): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        const port = eng.read(node, 'workletPort') as MessagePort | undefined;
        if (port) port.postMessage({ type: 'dump-tape', reel });
      } catch { /* engine may not be ready */ }
    }
  }

  function sendTransport(reel: 'a' | 'b', action: 'rec' | 'play' | 'stop'): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        const port = eng.read(node, 'workletPort') as MessagePort | undefined;
        if (port) port.postMessage({ type: 'transport', reel, action });
      } catch { /* engine may not be ready */ }
    }
  }

  function sendScrubVelocity(reel: 'a' | 'b', velocity: number): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        eng.setParam(node, reel === 'a' ? 'scrubVelocity_a' : 'scrubVelocity_b', velocity);
      } catch { /* engine may not be ready */ }
    }
  }

  // ─── Reel A handlers ───

  function toggleModeA() { setNodeParam(id, 'mode_a', Math.round(modeA) === 1 ? 0 : 1); }
  function toggleOverdubA() { setNodeParam(id, 'overdub_flag_a', Math.round(overdubFlagA) === 1 ? 0 : 1); }

  function cycleFilterA() {
    setNodeParam(id, 'filterMode_a', (Math.round(filterModeA) + 1) % 4);
  }

  function onCanvasPointerDownA(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasElA) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const norm = posPxToNorm(e.offsetX, canvasElA);
    const hit = handleHit(norm, startA, endA, canvasElA.width);
    if (hit === 'start') { dragHandleA = 'start'; setStartA(norm); return; }
    if (hit === 'end')   { dragHandleA = 'end';   setEndA(norm);   return; }
    scrubbingA = true;
    pointerPrevXA = e.offsetX;
    localPlayheadA = norm;
  }
  function onCanvasPointerMoveA(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasElA) return;
    const norm = posPxToNorm(e.offsetX, canvasElA);
    if (dragHandleA === 'start') { setStartA(norm); return; }
    if (dragHandleA === 'end')   { setEndA(norm);   return; }
    if (!scrubbingA) return;
    localPlayheadA = norm;
    const blockWidthPx = canvasElA.width;
    const velocity = Math.abs(e.offsetX - pointerPrevXA) / blockWidthPx * 50;
    pointerPrevXA = e.offsetX;
    sendScrubVelocity('a', Math.min(10, velocity));
  }
  function onCanvasPointerUpA(e: PointerEvent) {
    e.stopPropagation();
    if (dragHandleA) { dragHandleA = null; return; }
    if (!scrubbingA) return;
    scrubbingA = false;
    const pos = posPxToNorm(e.offsetX, canvasElA);
    localPlayheadA = pos;
    sendSeek('a', pos);
    sendScrubVelocity('a', 0);
  }

  // ─── Reel B handlers ───

  function toggleModeB() { setNodeParam(id, 'mode_b', Math.round(modeB) === 1 ? 0 : 1); }
  function toggleOverdubB() { setNodeParam(id, 'overdub_flag_b', Math.round(overdubFlagB) === 1 ? 0 : 1); }

  function cycleFilterB() {
    setNodeParam(id, 'filterMode_b', (Math.round(filterModeB) + 1) % 4);
  }

  function onCanvasPointerDownB(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasElB) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const norm = posPxToNorm(e.offsetX, canvasElB);
    const hit = handleHit(norm, startB, endB, canvasElB.width);
    if (hit === 'start') { dragHandleB = 'start'; setStartB(norm); return; }
    if (hit === 'end')   { dragHandleB = 'end';   setEndB(norm);   return; }
    scrubbingB = true;
    pointerPrevXB = e.offsetX;
    localPlayheadB = norm;
  }
  function onCanvasPointerMoveB(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasElB) return;
    const norm = posPxToNorm(e.offsetX, canvasElB);
    if (dragHandleB === 'start') { setStartB(norm); return; }
    if (dragHandleB === 'end')   { setEndB(norm);   return; }
    if (!scrubbingB) return;
    localPlayheadB = norm;
    const blockWidthPx = canvasElB.width;
    const velocity = Math.abs(e.offsetX - pointerPrevXB) / blockWidthPx * 50;
    pointerPrevXB = e.offsetX;
    sendScrubVelocity('b', Math.min(10, velocity));
  }
  function onCanvasPointerUpB(e: PointerEvent) {
    e.stopPropagation();
    if (dragHandleB) { dragHandleB = null; return; }
    if (!scrubbingB) return;
    scrubbingB = false;
    const pos = posPxToNorm(e.offsetX, canvasElB);
    localPlayheadB = pos;
    sendSeek('b', pos);
    sendScrubVelocity('b', 0);
  }

  // ─── Waveform draw ───
  // Delegates to the shared pure module. The card passes the SAME view object
  // the faceplate body passes, so both surfaces cannot drift apart.

  function reelView(
    peaks: Float32Array | null, bufLen: number,
    playheadFrac: number, startFrac: number, endFrac: number,
  ): TwotracksReelView {
    return { peaks, bufLen, playheadFrac, startFrac, endFrac };
  }

  // Reactive waveform draws
  $effect(() => {
    void peaksA; void bufLenA; void displayPlayheadA; void startA; void endA;
    drawTwotracksReel(canvasElA, reelView(peaksA, bufLenA, displayPlayheadA, startA, endA));
  });
  $effect(() => {
    void peaksB; void bufLenB; void displayPlayheadB; void startB; void endB;
    drawTwotracksReel(canvasElB, reelView(peaksB, bufLenB, displayPlayheadB, startB, endB));
  });
</script>

<div class="mod-card twotracks-card" data-testid="twotracks-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="TWOTRACKS" />
  <div class="subtitle">TAPE LOOP · 2 REELS · EQ · FILTER · A/B MIX</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">

      <!-- ════════════ REEL A ════════════ -->
      <div class="reel-block reel-a" data-testid="twotracks-reel-a">
        <div class="reel-header">REEL A</div>

        <!-- Transport LEDs + mode/overdub toggles -->
        <div class="leds-row">
          <div class="led-item">
            <div class="led" class:active={ledArmA} data-testid="led-arm"></div>
            <span class="led-label">ARM</span>
          </div>
          <div class="led-item">
            <div class="led led-rec-color" class:active={ledRecA} data-testid="led-rec"></div>
            <span class="led-label">REC</span>
          </div>
          <div class="led-item">
            <div class="led led-play-color" class:active={ledPlayA} data-testid="led-play"></div>
            <span class="led-label">PLAY</span>
          </div>
          <div class="led-item">
            <div class="led led-ovdb-color" class:active={ledOverdubA} data-testid="led-overdub"></div>
            <span class="led-label">OVDB</span>
          </div>
          <button type="button" class="mode-btn nodrag" class:loop={isLoopA}
            onclick={toggleModeA} data-testid="twotracks-mode-toggle"
            aria-label="Toggle tape / loop tape A">{isLoopA ? 'loop tape' : 'tape'}</button>
          <button type="button" class="overdub-btn nodrag" class:active={overdubActA}
            onclick={toggleOverdubA} data-testid="twotracks-overdub-toggle"
            aria-label="Toggle overdub A">OVERDUB</button>
        </div>

        <!-- Transport trigger buttons -->
        <div class="transport-row">
          <button type="button" class="transport-btn rec nodrag" class:active={ledArmA || ledRecA}
            onclick={() => sendTransport('a', 'rec')}
            data-testid="twotracks-rec" aria-label="Record reel A">● REC</button>
          <button type="button" class="transport-btn play nodrag" class:active={ledPlayA}
            onclick={() => sendTransport('a', 'play')}
            data-testid="twotracks-play" aria-label="Play reel A">▶ PLAY</button>
          <button type="button" class="transport-btn stop nodrag"
            onclick={() => sendTransport('a', 'stop')}
            data-testid="twotracks-stop" aria-label="Stop reel A">■ STOP</button>
        </div>

        <!-- Waveform canvas -->
        <canvas bind:this={canvasElA} width="220" height="60" class="waveform nodrag"
          data-testid="twotracks-waveform"
          onpointerdown={onCanvasPointerDownA}
          onpointermove={onCanvasPointerMoveA}
          onpointerup={onCanvasPointerUpA}></canvas>

        <!-- 3-band EQ (assignable knobs) -->
        <div class="knob-row" data-testid="twotracks-eq-a">
          <Knob value={eqLowA}  min={P.eqLow_a.min} max={P.eqLow_a.max} defaultValue={P.eqLow_a.defaultValue} label="LOW"  units="dB" curve="linear"
            onchange={(v) => setNodeParam(id, 'eqLow_a', v)}  moduleId={id} paramId="eqLow_a" />
          <Knob value={eqMidA}  min={P.eqMid_a.min} max={P.eqMid_a.max} defaultValue={P.eqMid_a.defaultValue} label="MID"  units="dB" curve="linear"
            onchange={(v) => setNodeParam(id, 'eqMid_a', v)}  moduleId={id} paramId="eqMid_a" />
          <Knob value={eqHighA} min={P.eqHigh_a.min} max={P.eqHigh_a.max} defaultValue={P.eqHigh_a.defaultValue} label="HIGH" units="dB" curve="linear"
            onchange={(v) => setNodeParam(id, 'eqHigh_a', v)} moduleId={id} paramId="eqHigh_a" />
        </div>

        <!-- Filter (mode button + assignable cutoff/reso knobs) -->
        <div class="knob-row filter-row" data-testid="twotracks-filter-a">
          <button type="button" class="filter-mode-btn nodrag" onclick={cycleFilterA}
            aria-label="Cycle filter mode A">
            {filterLabel(filterModeA)}
          </button>
          <Knob value={cutoffA} min={P.cutoff_a.min} max={P.cutoff_a.max} defaultValue={P.cutoff_a.defaultValue} label="CUT" units="Hz" curve="log"
            onchange={(v) => setNodeParam(id, 'cutoff_a', v)} moduleId={id} paramId="cutoff_a" />
          <Knob value={resoA}   min={P.reso_a.min}  max={P.reso_a.max}     defaultValue={P.reso_a.defaultValue}     label="RES" curve="linear"
            onchange={(v) => setNodeParam(id, 'reso_a', v)}   moduleId={id} paramId="reso_a" />
        </div>

        <!-- Echoes + Rate (assignable knobs); RATE has a 1× reset button -->
        <div class="knob-row">
          <div data-testid="twotracks-echoes">
            <Knob value={echoesA} min={P.echoes_a.min} max={P.echoes_a.max} defaultValue={P.echoes_a.defaultValue} label="ECHOES" curve="linear"
              onchange={(v) => setNodeParam(id, 'echoes_a', Math.round(v))} moduleId={id} paramId="echoes_a" />
          </div>
          <div class="rate-knob">
            <Knob value={rateA} min={P.rate_a.min} max={P.rate_a.max} defaultValue={P.rate_a.defaultValue} label="RATE" units="×" curve="linear"
              onchange={(v) => setNodeParam(id, 'rate_a', v)} moduleId={id} paramId="rate_a" />
            <button type="button" class="rate-reset nodrag" onclick={() => setNodeParam(id, 'rate_a', 1)}
              data-testid="twotracks-rate-reset" aria-label="Reset reel A speed to 1×">1×</button>
          </div>
        </div>

        <!-- Save row -->
        <div class="save-row">
          <button type="button" class="save-btn nodrag"
            disabled={bufLenA === 0}
            onclick={() => requestDumpTape('a')}
            data-testid="twotracks-save" aria-label="Save reel A tape as WAV">SAVE TAPE</button>
          {#if bufLenA > 0}
            <span class="tape-info">{(bufLenA / 48000).toFixed(1)}s</span>
          {:else}
            <span class="tape-info dim">no tape</span>
          {/if}
        </div>
      </div><!-- /reel A -->

      <!-- ════════════ CENTER COLUMN ════════════ -->
      <div class="center-col">

        <!-- A/B crossfade knob -->
        <div class="ab-strip" data-testid="twotracks-ab-knob">
          <div class="ab-knob-wrap">
            <Knob
              value={abParam}
              min={P.ab.min}
              max={P.ab.max}
              defaultValue={P.ab.defaultValue}
              label="A/B"
              curve="linear"
              onchange={(v) => setNodeParam(id, 'ab', v)}
              moduleId={id}
              paramId="ab"
            />
            <div class="ab-pcts">
              <span class="ab-pct">A:{Math.round(gains.gainA * 100)}%</span>
              <span class="ab-pct">B:{Math.round(gains.gainB * 100)}%</span>
            </div>
          </div>
        </div>

        <!-- Cross-feed: A→B / B→A (assignable knobs, default off) -->
        <div class="cross-strip" data-testid="twotracks-crossfeed">
          <Knob value={a2bParam} min={P.a2b.min} max={P.a2b.max} defaultValue={P.a2b.defaultValue} label="A→B" curve="linear"
            onchange={(v) => setNodeParam(id, 'a2b', v)} moduleId={id} paramId="a2b" />
          <Knob value={b2aParam} min={P.b2a.min} max={P.b2a.max} defaultValue={P.b2a.defaultValue} label="B→A" curve="linear"
            onchange={(v) => setNodeParam(id, 'b2a', v)} moduleId={id} paramId="b2a" />
        </div>

        <!-- Monitor (input passthrough) -->
        <button type="button" class="monitor-btn nodrag" class:active={monitorOn}
          onclick={() => setNodeParam(id, 'monitor', monitorOn ? 0 : 1)}
          data-testid="twotracks-monitor" aria-label="Toggle input monitoring"
          aria-pressed={monitorOn}>MONITOR</button>

        <!-- Lofi strip -->
        <div class="lofi-strip" data-testid="twotracks-lofi">
          <span class="strip-label">LOFI</span>
          <div class="lofi-btns">
            {#each TWOTRACKS_LOFI_MODES as mode}
              <button
                type="button"
                class="lofi-btn nodrag"
                class:active={Math.round(lofiParam) === mode.value}
                class:error={mode.value === 3 && Math.round(lofiParam) === 3}
                onclick={() => setNodeParam(id, 'lofi', mode.value)}
                aria-label="Lofi mode {mode.label}"
                title={mode.title}
              >{mode.label}</button>
            {/each}
          </div>
        </div>

      </div><!-- /center-col -->

      <!-- ════════════ REEL B ════════════ -->
      <div class="reel-block reel-b" data-testid="twotracks-reel-b">
        <div class="reel-header">REEL B</div>

        <!-- Transport LEDs + mode/overdub toggles -->
        <div class="leds-row">
          <div class="led-item">
            <div class="led" class:active={ledArmB} data-testid="led-arm-b"></div>
            <span class="led-label">ARM</span>
          </div>
          <div class="led-item">
            <div class="led led-rec-color" class:active={ledRecB} data-testid="led-rec-b"></div>
            <span class="led-label">REC</span>
          </div>
          <div class="led-item">
            <div class="led led-play-color" class:active={ledPlayB} data-testid="led-play-b"></div>
            <span class="led-label">PLAY</span>
          </div>
          <div class="led-item">
            <div class="led led-ovdb-color" class:active={ledOverdubB} data-testid="led-overdub-b"></div>
            <span class="led-label">OVDB</span>
          </div>
          <button type="button" class="mode-btn nodrag" class:loop={isLoopB}
            onclick={toggleModeB} data-testid="twotracks-mode-toggle-b"
            aria-label="Toggle tape / loop tape B">{isLoopB ? 'loop tape' : 'tape'}</button>
          <button type="button" class="overdub-btn nodrag" class:active={overdubActB}
            onclick={toggleOverdubB} data-testid="twotracks-overdub-toggle-b"
            aria-label="Toggle overdub B">OVERDUB</button>
        </div>

        <!-- Transport trigger buttons reel B -->
        <div class="transport-row">
          <button type="button" class="transport-btn rec nodrag" class:active={ledArmB || ledRecB}
            onclick={() => sendTransport('b', 'rec')}
            data-testid="twotracks-rec-b" aria-label="Record reel B">● REC</button>
          <button type="button" class="transport-btn play nodrag" class:active={ledPlayB}
            onclick={() => sendTransport('b', 'play')}
            data-testid="twotracks-play-b" aria-label="Play reel B">▶ PLAY</button>
          <button type="button" class="transport-btn stop nodrag"
            onclick={() => sendTransport('b', 'stop')}
            data-testid="twotracks-stop-b" aria-label="Stop reel B">■ STOP</button>
        </div>

        <!-- Waveform canvas reel B -->
        <canvas bind:this={canvasElB} width="220" height="60" class="waveform nodrag"
          data-testid="twotracks-waveform-b"
          onpointerdown={onCanvasPointerDownB}
          onpointermove={onCanvasPointerMoveB}
          onpointerup={onCanvasPointerUpB}></canvas>

        <!-- 3-band EQ reel B (assignable knobs) -->
        <div class="knob-row" data-testid="twotracks-eq-b">
          <Knob value={eqLowB}  min={P.eqLow_b.min} max={P.eqLow_b.max} defaultValue={P.eqLow_b.defaultValue} label="LOW"  units="dB" curve="linear"
            onchange={(v) => setNodeParam(id, 'eqLow_b', v)}  moduleId={id} paramId="eqLow_b" />
          <Knob value={eqMidB}  min={P.eqMid_b.min} max={P.eqMid_b.max} defaultValue={P.eqMid_b.defaultValue} label="MID"  units="dB" curve="linear"
            onchange={(v) => setNodeParam(id, 'eqMid_b', v)}  moduleId={id} paramId="eqMid_b" />
          <Knob value={eqHighB} min={P.eqHigh_b.min} max={P.eqHigh_b.max} defaultValue={P.eqHigh_b.defaultValue} label="HIGH" units="dB" curve="linear"
            onchange={(v) => setNodeParam(id, 'eqHigh_b', v)} moduleId={id} paramId="eqHigh_b" />
        </div>

        <!-- Filter reel B (mode button + assignable cutoff/reso knobs) -->
        <div class="knob-row filter-row" data-testid="twotracks-filter-b">
          <button type="button" class="filter-mode-btn nodrag" onclick={cycleFilterB}
            aria-label="Cycle filter mode B">
            {filterLabel(filterModeB)}
          </button>
          <Knob value={cutoffB} min={P.cutoff_b.min} max={P.cutoff_b.max} defaultValue={P.cutoff_b.defaultValue} label="CUT" units="Hz" curve="log"
            onchange={(v) => setNodeParam(id, 'cutoff_b', v)} moduleId={id} paramId="cutoff_b" />
          <Knob value={resoB}   min={P.reso_b.min}  max={P.reso_b.max}     defaultValue={P.reso_b.defaultValue}     label="RES" curve="linear"
            onchange={(v) => setNodeParam(id, 'reso_b', v)}   moduleId={id} paramId="reso_b" />
        </div>

        <!-- Echoes + Rate reel B (assignable knobs); RATE has a 1× reset button -->
        <div class="knob-row">
          <div data-testid="twotracks-echoes-b">
            <Knob value={echoesB} min={P.echoes_b.min} max={P.echoes_b.max} defaultValue={P.echoes_b.defaultValue} label="ECHOES" curve="linear"
              onchange={(v) => setNodeParam(id, 'echoes_b', Math.round(v))} moduleId={id} paramId="echoes_b" />
          </div>
          <div class="rate-knob">
            <Knob value={rateB} min={P.rate_b.min} max={P.rate_b.max} defaultValue={P.rate_b.defaultValue} label="RATE" units="×" curve="linear"
              onchange={(v) => setNodeParam(id, 'rate_b', v)} moduleId={id} paramId="rate_b" />
            <button type="button" class="rate-reset nodrag" onclick={() => setNodeParam(id, 'rate_b', 1)}
              data-testid="twotracks-rate-reset-b" aria-label="Reset reel B speed to 1×">1×</button>
          </div>
        </div>

        <!-- Save row reel B -->
        <div class="save-row">
          <button type="button" class="save-btn nodrag"
            disabled={bufLenB === 0}
            onclick={() => requestDumpTape('b')}
            data-testid="twotracks-save-b" aria-label="Save reel B tape as WAV">SAVE TAPE</button>
          {#if bufLenB > 0}
            <span class="tape-info">{(bufLenB / 48000).toFixed(1)}s</span>
          {:else}
            <span class="tape-info dim">no tape</span>
          {/if}
        </div>
      </div><!-- /reel B -->

    </div>
  </PatchPanel>
</div>

<style>
  .twotracks-card {
    width: 580px;
  }
  .twotracks-card .subtitle {
    font-size: 0.50rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.07em;
    margin-top: 2px;
  }
  .twotracks-card .body {
    margin-top: 8px;
    padding: 0 10px 10px;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 6px;
  }

  /* ─── Reel blocks ─── */
  .twotracks-card .reel-block {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    padding: 7px;
  }

  /* ─── Center column (A/B + Lofi) ─── */
  .twotracks-card .center-col {
    flex: 0 0 90px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    justify-content: center;
  }
  .twotracks-card .reel-a {
    border-color: #3a4254;
  }
  .twotracks-card .reel-b {
    border-color: #3a4254;
  }
  .twotracks-card .reel-header {
    font-size: 0.50rem;
    color: rgba(255, 140, 40, 0.8);
    letter-spacing: 0.12em;
    font-family: ui-monospace, monospace;
    font-weight: bold;
  }

  /* ─── LEDs ─── */
  .twotracks-card .leds-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .twotracks-card .led-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .twotracks-card .led {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #1e2430;
    border: 1px solid #3a4050;
    transition: background 80ms, box-shadow 80ms;
  }
  .twotracks-card .led.active {
    background: rgb(255, 220, 60);
    border-color: rgb(255, 240, 100);
    box-shadow: 0 0 4px 1px rgba(255, 220, 60, 0.5);
  }
  .twotracks-card .led.led-rec-color.active {
    background: rgb(255, 70, 60);
    border-color: rgb(255, 120, 100);
    box-shadow: 0 0 4px 1px rgba(255, 70, 60, 0.5);
  }
  .twotracks-card .led.led-play-color.active {
    background: rgb(60, 220, 100);
    border-color: rgb(100, 240, 140);
    box-shadow: 0 0 4px 1px rgba(60, 220, 100, 0.5);
  }
  .twotracks-card .led.led-ovdb-color.active {
    background: rgb(80, 160, 255);
    border-color: rgb(120, 200, 255);
    box-shadow: 0 0 4px 1px rgba(80, 160, 255, 0.5);
  }
  .twotracks-card .led-label {
    font-size: 0.42rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.05em;
    font-family: ui-monospace, monospace;
  }

  /* ─── Mode + overdub buttons ─── */
  .twotracks-card .mode-btn,
  .twotracks-card .overdub-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 2px 6px;
    font-size: 0.50rem;
    cursor: pointer;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .twotracks-card .mode-btn.loop { color: rgb(80, 200, 220); border-color: rgb(80, 160, 220); }
  .twotracks-card .overdub-btn.active { color: rgb(80, 160, 255); border-color: rgb(80, 140, 255); background: #111a2a; }

  /* ─── Transport trigger buttons (REC / PLAY / STOP) ─── */
  .twotracks-card .transport-row {
    display: flex;
    gap: 4px;
  }
  .twotracks-card .transport-btn {
    flex: 1 1 0;
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 3px 4px;
    font-size: 0.50rem;
    cursor: pointer;
    letter-spacing: 0.04em;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .twotracks-card .transport-btn:hover { border-color: #5a6275; }
  .twotracks-card .transport-btn.rec.active {
    color: rgb(255, 90, 80);
    border-color: rgb(255, 70, 60);
    background: #2a1414;
    box-shadow: 0 0 5px rgba(255, 70, 60, 0.4);
  }
  .twotracks-card .transport-btn.play.active {
    color: rgb(80, 230, 120);
    border-color: rgb(60, 220, 100);
    background: #122a18;
    box-shadow: 0 0 5px rgba(60, 220, 100, 0.4);
  }

  /* ─── Waveform canvas ─── */
  .twotracks-card .waveform {
    display: block;
    width: 100%;
    height: 56px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    cursor: ew-resize;
  }

  /* ─── Knob rows (EQ / filter / decay / rate — all assignable knobs) ─── */
  .twotracks-card .knob-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-around;
    gap: 4px;
    flex-wrap: wrap;
  }
  .twotracks-card .filter-row {
    align-items: center;
  }
  .twotracks-card .filter-mode-btn {
    background: #1a1f2a;
    color: rgb(200, 180, 100);
    border: 1px solid #504030;
    border-radius: 2px;
    padding: 2px 5px;
    font-size: 0.48rem;
    cursor: pointer;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    min-width: 24px;
    text-align: center;
  }
  /* Shrink the shared Knob a touch so 3 fit across a reel column. */
  .twotracks-card .knob-row :global(.knob) {
    width: 30px;
    height: 30px;
  }
  .twotracks-card .knob-row :global(.label) {
    font-size: 0.42rem;
  }
  /* RATE knob + its 1× reset button stacked. */
  .twotracks-card .rate-knob {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .twotracks-card .rate-reset {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 1px 5px;
    font-size: 0.45rem;
    cursor: pointer;
    letter-spacing: 0.04em;
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .rate-reset:hover { border-color: #5a6275; color: var(--text, #cfd6e4); }

  /* ─── Save row ─── */
  .twotracks-card .save-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .twotracks-card .save-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 4px 10px;
    font-size: 0.50rem;
    cursor: pointer;
    letter-spacing: 0.07em;
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .save-btn:hover:not(:disabled) { color: rgb(80, 200, 220); border-color: rgb(80, 160, 220); }
  .twotracks-card .save-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .twotracks-card .tape-info {
    font-size: 0.46rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .tape-info.dim { opacity: 0.5; }

  /* ─── A/B center crossfade knob ─── */
  .twotracks-card .ab-strip {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #111520;
    border: 1px solid #2a3045;
    border-radius: 3px;
    padding: 6px 8px;
  }
  .twotracks-card .ab-knob-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .twotracks-card .ab-pcts {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
  }
  .twotracks-card .ab-pct {
    font-size: 0.38rem;
    color: rgba(200, 180, 255, 0.7);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
  }

  /* ─── Cross-feed strip (A→B / B→A) ─── */
  .twotracks-card .cross-strip {
    display: flex;
    align-items: flex-start;
    justify-content: space-around;
    gap: 4px;
    background: #111520;
    border: 1px solid #2a3045;
    border-radius: 3px;
    padding: 6px 4px;
  }
  .twotracks-card .cross-strip :global(.knob) {
    width: 30px;
    height: 30px;
  }
  .twotracks-card .cross-strip :global(.label) {
    font-size: 0.42rem;
  }

  /* ─── Monitor button ─── */
  .twotracks-card .monitor-btn {
    background: #111520;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #2a3045;
    border-radius: 3px;
    padding: 4px 8px;
    font-size: 0.52rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .twotracks-card .monitor-btn:hover { border-color: #5a6275; }
  .twotracks-card .monitor-btn.active {
    color: rgb(120, 220, 160);
    border-color: rgb(80, 200, 130);
    background: #112218;
    box-shadow: 0 0 5px rgba(80, 200, 130, 0.35);
  }

  /* ─── Lofi strip ─── */
  .twotracks-card .lofi-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #100e18;
    border: 1px solid #2a2040;
    border-radius: 3px;
    padding: 5px 8px;
  }
  .twotracks-card .strip-label {
    font-size: 0.50rem;
    color: rgba(180, 150, 255, 0.8);
    font-family: ui-monospace, monospace;
    font-weight: bold;
    letter-spacing: 0.10em;
    min-width: 28px;
  }
  .twotracks-card .lofi-btns {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  .twotracks-card .lofi-btn {
    flex: 1;
    background: #1a1525;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #3a304a;
    border-radius: 2px;
    padding: 3px 4px;
    font-size: 0.46rem;
    cursor: pointer;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    text-align: center;
    transition: background 80ms, color 80ms, border-color 80ms;
  }
  .twotracks-card .lofi-btn.active {
    background: #251c3a;
    color: rgb(180, 140, 255);
    border-color: rgb(140, 100, 220);
  }
  .twotracks-card .lofi-btn.error {
    background: #2a1020;
    color: rgb(255, 80, 80);
    border-color: rgb(200, 60, 60);
    animation: lofi-error-pulse 1.2s ease-in-out infinite;
  }
  @keyframes lofi-error-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.65; }
  }
</style>
