<script lang="ts">
  // moogafakkin 956 RIBBON CONTROLLER card.
  //
  // A horizontal touch-ribbon: press + slide along the strip to set a
  // continuous pitch CV; the gate goes HIGH while touched. Like the
  // hardware ribbon, lifting off HOLDS the last pitch (only the gate
  // falls) — the patched VCO stays at the last played note.
  //
  // Pointer drives two internal params on the node:
  //   pos  (0..1) — finger position along the strip (held on release).
  //   gate (0/1)  — 1 while pressed, 0 on release.
  // SCALE (octave span) + OFFSET (base octave) are knobs.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog903aCard / Moog992Card.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog956Def, clampRibbon, ribbonToVOct } from '$lib/audio/modules/moog956';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog956Def.params.find((p) => p.id === pid)!;
  }

  let pos = $derived(clampRibbon(node?.params.pos ?? def('pos').defaultValue));
  let gate = $derived((node?.params.gate ?? def('gate').defaultValue) > 0.5);
  let scale = $derived(node?.params.scale ?? def('scale').defaultValue);
  let offset = $derived(node?.params.offset ?? def('offset').defaultValue);

  // Live pitch readout (V/oct) for the on-card display.
  let pitchVOct = $derived(ribbonToVOct(pos, scale, offset));

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  function writePos(p: number) {
    const t = patch.nodes[id];
    if (t) t.params.pos = clampRibbon(p);
  }
  function writeGate(on: boolean) {
    const t = patch.nodes[id];
    if (t) t.params.gate = on ? 1 : 0;
  }

  // ---- ribbon pointer drag ----
  let ribbonEl: HTMLDivElement | null = $state(null);
  let touching = $state(false);

  function posFromPointer(ev: PointerEvent): number {
    if (!ribbonEl) return 0;
    const rect = ribbonEl.getBoundingClientRect();
    return clampRibbon((ev.clientX - rect.left) / rect.width); // 0..1 across
  }

  function onPointerDown(ev: PointerEvent) {
    if (!ribbonEl) return;
    touching = true;
    ribbonEl.setPointerCapture(ev.pointerId);
    writePos(posFromPointer(ev));
    writeGate(true);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent) {
    if (!touching) return;
    writePos(posFromPointer(ev));
  }
  function onPointerUp(ev: PointerEvent) {
    if (!touching) return;
    touching = false;
    try { ribbonEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // Ribbon holds its last pitch — drop the gate only, leave pos.
    writeGate(false);
  }

  const RIBBON_PX = 200;
  let dotX = $derived(pos * RIBBON_PX);

  function fmtSemis(v: number): string {
    // V/oct → semitones for a human-readable readout.
    return (v * 12).toFixed(1);
  }

  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'pitch', label: 'PITCH', cable: 'pitch' },
    { id: 'gate', label: 'GATE', cable: 'gate' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="956 Ribbon" width={240}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="ribbon-wrap">
      <div
        class="ribbon nodrag"
        bind:this={ribbonEl}
        style="width: {RIBBON_PX}px;"
        role="slider"
        aria-label="Ribbon controller"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={pos}
        tabindex="0"
        data-testid="moog956-ribbon"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <div
          class="wiper"
          class:active={touching}
          style="left: {dotX}px;"
          data-testid="moog956-wiper"
        ></div>
      </div>
      <div class="readout" data-testid="moog956-readout">
        <span class="gate-led" class:on={gate} aria-hidden="true"></span>
        <span>{fmtSemis(pitchVOct)} st</span>
      </div>
    </div>

    <div class="knob-row" data-testid="moog956-knobs">
      <Knob value={scale} min={0} max={5} defaultValue={2} label="Scale" curve="linear" onchange={setParam('scale')} moduleId={id} paramId="scale" readLive={readLive('scale')} />
      <Knob value={offset} min={-2} max={2} defaultValue={0} label="Offset" curve="linear" onchange={setParam('offset')} moduleId={id} paramId="offset" readLive={readLive('offset')} />
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .ribbon-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin: 6px auto 8px;
  }
  .ribbon {
    position: relative;
    height: 26px;
    background: linear-gradient(180deg, #2a2018 0%, #14100a 100%);
    border: 1px solid var(--cable-pitch, #c0a060);
    border-radius: 4px;
    touch-action: none;
    cursor: ew-resize;
    user-select: none;
  }
  .wiper {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 4px;
    background: var(--cable-pitch, #e0c070);
    border-radius: 2px;
    transform: translateX(-50%);
    box-shadow: 0 0 6px rgba(224, 192, 112, 0.5);
    transition: box-shadow 80ms ease-out;
    pointer-events: none;
  }
  .wiper.active {
    box-shadow: 0 0 12px rgba(224, 192, 112, 0.9);
  }
  .readout {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
    color: var(--text-dim, #b6a684);
    font-variant-numeric: tabular-nums;
  }
  .gate-led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3a3026;
    border: 1px solid #5a4a30;
  }
  .gate-led.on {
    background: var(--cable-gate, #ff5050);
    box-shadow: 0 0 8px var(--cable-gate, #ff5050);
  }
  .knob-row {
    display: flex;
    justify-content: center;
    gap: 18px;
    margin: 2px 0 4px;
  }
</style>
