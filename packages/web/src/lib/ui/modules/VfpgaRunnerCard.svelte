<script lang="ts">
  // VfpgaRunnerCard — UI for the vfpga-runner HOST module.
  //
  // The card is MANIFEST-DRIVEN: a loaded VfpgaSpec (node.data.vfpga, resolved
  // from the registry) determines the param-knob grid and the CV/gate roles. All
  // I/O patches through the yellow drill-down PatchPanel (post-#767 standard: NO
  // raw <Handle> side jacks). PatchPanel renders the full host port SUPERSET of
  // handles internally (so the per-module-per-port handle sweep stays green); the
  // card body shows only the controls for the loaded spec's ACTIVE roles.
  //
  // Layout (PatchPanel children):
  //   - preview canvas — the REAL engine output for the LOADED spec, pulled via
  //     engine.blitOutputToDrawingBuffer(id) + a 2D blit of engine.canvas (the
  //     same path OUTPUT uses). This shows whatever the loaded VFPGA renders, so
  //     switching presets visibly changes the preview (NOT a CPU snapshot frozen
  //     on the smpte-bars test pattern — the old read('snapshot') path only ever
  //     produced a preview for smpte-bars, so every other preset left the canvas
  //     showing the last-drawn bars).
  //   - "load preset…" <select> — VFPGAs ARE the presets (one option per spec);
  //   - manifest-driven p1..pN knob grid (Knob w/ moduleId/paramId → MIDI-learn);
  //   - active CV inputs each with a SCALE attenuverter + OFFSET + always-on
  //     scope (TOYBOX pattern; the jack itself lives in the PatchPanel);
  //   - active gate inputs with an activity LED;
  //   - docs link to the loaded VFPGA's subpage.
  //
  // Live render state (attenuverter/scope/preset) lives in node.data — NEVER
  // per-frame Y.Doc writes.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { setCvScale, setCvOffset } from '$lib/graph/toybox-cv-inputs';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { listVfpgaSpecs, getVfpgaSpec, DEFAULT_VFPGA_ID } from '$lib/video/vfpga/registry';
  import {
    VFPGA_VIDEO_IN_PORTS,
    VFPGA_CV_PORTS,
    VFPGA_GATE_PORTS,
    VFPGA_VIDEO_OUT_PORTS,
    type VfpgaSpec,
  } from '$lib/video/vfpga/types';
  import { getCvInput, DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET, type CvInputs } from '$lib/video/toybox-cv-routes';
  import { drawToyboxInputScope, type ToyboxScopeColors } from '$lib/video/toybox-scope-draw';
  import { setVfpgaSpec } from '$lib/graph/vfpga-runner';
  import ModuleTitle from './ModuleTitle.svelte';
  import VfpgaFloorplan from './VfpgaFloorplan.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const SPECS = listVfpgaSpecs();

  // ── PatchPanel port descriptors — the FULL host I/O superset. EVERY declared
  //    def port id MUST appear here (byte-identical) so PatchPanel renders its
  //    handle + the per-module-per-port handle-presence sweep stays green. Port
  //    ids are load-bearing (the CV bridge routes by id) — do NOT rename. The
  //    card body below only surfaces controls for the LOADED spec's active roles;
  //    the jacks for every port live in the panel.
  const inputs: PortDescriptor[] = [
    ...VFPGA_VIDEO_IN_PORTS.map((pid) => ({ id: pid, label: pid.toUpperCase(), cable: 'video' })),
    ...VFPGA_CV_PORTS.map((pid) => ({ id: pid, label: pid.toUpperCase(), cable: 'cv' })),
    ...VFPGA_GATE_PORTS.map((pid) => ({ id: pid, label: pid.toUpperCase(), cable: 'gate' })),
  ];
  const outputs: PortDescriptor[] = VFPGA_VIDEO_OUT_PORTS.map((pid) => ({
    id: pid,
    label: pid.toUpperCase(),
    cable: 'video',
  }));

  // ── reactive trigger so the card re-derives the active spec/grid after a local
  //    data write (preset change) immediately, not a snapshot-bus tick later.
  let dataRev = $state(0);
  function bumpData() { dataRev++; }

  function liveData(): { vfpga?: string; cvInputs?: CvInputs } {
    void node; void dataRev;
    return (patch.nodes[id]?.data ?? node?.data ?? {}) as { vfpga?: string; cvInputs?: CvInputs };
  }

  let currentVfpgaId = $derived.by<string>(() => liveData().vfpga ?? DEFAULT_VFPGA_ID);
  let spec = $derived.by<VfpgaSpec | undefined>(() => getVfpgaSpec(currentVfpgaId) ?? getVfpgaSpec(DEFAULT_VFPGA_ID));

  let paramGrid = $derived.by(() => spec?.params ?? []);

  // ── Param knob helpers (p1..p8 slots) ──
  function paramVal(slot: number): number {
    const v = node?.params?.[`p${slot}`];
    if (typeof v === 'number') return v;
    const ps = spec?.params?.find((p) => p.slot === slot);
    // The card knob lives in the slot's mapped [min,max] space; default = spec default.
    return ps?.defaultValue ?? 0;
  }
  // The host param is a generic 0..1 slot; the spec maps it to [min,max]. The
  // knob shows the MAPPED range, so we convert knob<->slot on read/write.
  function knobValue(slot: number): number {
    const ps = spec?.params?.find((p) => p.slot === slot);
    if (!ps) return 0;
    const raw = paramVal(slot); // 0..1 slot value
    return ps.min + raw * (ps.max - ps.min);
  }
  const setKnob = (slot: number) => (mapped: number) => {
    const ps = spec?.params?.find((p) => p.slot === slot);
    if (!ps) return;
    const raw = ps.max > ps.min ? (mapped - ps.min) / (ps.max - ps.min) : 0;
    setNodeParam(id, `p${slot}`, Math.max(0, Math.min(1, raw)));
  };
  function knobDefault(slot: number): number {
    const ps = spec?.params?.find((p) => p.slot === slot);
    return ps?.defaultValue ?? 0;
  }

  // ── Preset (= VFPGA) selector ──
  let presetSelect = $state('');
  function onPresetChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    setVfpgaSpec(id, sel);
    bumpData();
    // Trigger the engine handle's hot-swap (rebuild from the new data.vfpga id);
    // the worker proxy forwards the pulse to the worker node too.
    const e = engineCtx.get();
    if (e) {
      try { e.getDomain<VideoEngine>('video').setParam(id, '__reloadVfpga', 1); } catch { /* */ }
    }
    presetSelect = ''; // reset to placeholder after apply
  }

  // ── CV attenuverter (SCALE) + OFFSET (TOYBOX cvInputs shape) ──
  function cvInputFor(slot: number): { scale: number; offset: number } {
    return getCvInput(liveData().cvInputs ?? {}, VFPGA_CV_PORTS[slot - 1]!);
  }
  const setScale = (slot: number) => (v: number) => { setCvScale(id, VFPGA_CV_PORTS[slot - 1]!, v); bumpData(); };
  const setOffset = (slot: number) => (v: number) => { setCvOffset(id, VFPGA_CV_PORTS[slot - 1]!, v); bumpData(); };

  // ── Preview canvas + always-on CV scopes (ONE rAF pulls both) ──
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  const scopeEls = new Map<number, HTMLCanvasElement>();
  const scopeRings = new Map<number, number[]>();
  const SCOPE_LEN = 64;
  let raf: number | null = null;

  // Preview internal resolution (4:3).
  const PREVIEW_W = 320;
  const PREVIEW_H = 240;

  const SCOPE_COLORS: ToyboxScopeColors = {
    trace: 'var(--cable-cv)',
    fill: 'rgba(120, 200, 255, 0.18)',
    wave: 'rgba(255,255,255,0.18)',
    grid: 'rgba(255,255,255,0.12)',
    bg: '#0a0d12',
  };

  /** Svelte action: register a CV scope canvas for `slot` (passed via
   *  use:regScope={slot}). */
  function regScope(el: HTMLCanvasElement, slot: number) {
    el.width = 64; el.height = 22;
    scopeEls.set(slot, el);
    if (!scopeRings.has(slot)) scopeRings.set(slot, []);
    return { destroy() { scopeEls.delete(slot); } };
  }

  /** Aspect-fit a (srcW×srcH) source into a (dstW×dstH) canvas. */
  function fitRect(srcW: number, srcH: number, dstW: number, dstH: number) {
    const srcAspect = srcW / srcH;
    const dstAspect = dstW / dstH;
    if (dstAspect > srcAspect) {
      const h = dstH;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((dstW - w) / 2), y: 0, w, h };
    }
    const w = dstW;
    const h = Math.round(w / srcAspect);
    return { x: 0, y: Math.round((dstH - h) / 2), w, h };
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const e = engineCtx.get();
    if (!e || !node) return;
    let ve: VideoEngine | undefined;
    try { ve = e.getDomain<VideoEngine>('video'); } catch { return; }
    // Preview: blit THIS node's own output FBO into the engine drawing buffer,
    // then 2D-blit the engine canvas (aspect-fit) into the preview. This shows
    // the REAL output of whatever VFPGA is loaded — so switching presets visibly
    // changes the preview (the old CPU read('snapshot') only ever rendered the
    // smpte-bars pattern; every other preset left the canvas stale).
    if (ctx2d && canvasEl) {
      try {
        ve.blitOutputToDrawingBuffer(id);
        const src = ve.canvas as CanvasImageSource;
        const sw = ve.canvas.width || PREVIEW_W;
        const sh = ve.canvas.height || PREVIEW_H;
        const cw = canvasEl.width;
        const ch = canvasEl.height;
        ctx2d.fillStyle = '#050608';
        ctx2d.fillRect(0, 0, cw, ch);
        const r = fitRect(sw, sh, cw, ch);
        ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
      } catch { /* engine not ready / GL hiccup — keep the loop alive */ }
    }
    // CV scopes: read each active CV slot's post scale+offset value back.
    for (const [slot, el] of scopeEls) {
      const ctx = el.getContext('2d');
      if (!ctx) continue;
      const raw = (ve.readParam?.(id, `cv${slot}_val`) ?? 0) as number;
      const { scale, offset } = cvInputFor(slot);
      const eff = Math.max(0, Math.min(1, raw * scale + offset));
      const ring = scopeRings.get(slot)!;
      ring.push(eff);
      if (ring.length > SCOPE_LEN) ring.shift();
      drawToyboxInputScope(ctx, { width: el.width, height: el.height, values: ring, colors: SCOPE_COLORS });
    }
    // Gate activity LEDs.
    const gs = ve.read(id, 'gateState') as boolean[] | undefined;
    if (gs) gateHeld = gs.slice();
  }

  let gateHeld = $state<boolean[]>([false, false, false, false]);

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = PREVIEW_W; canvasEl.height = PREVIEW_H;
      ctx2d = canvasEl.getContext('2d');
    }
    raf = requestAnimationFrame(tick);
  });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });

  let docSlug = $derived.by(() => spec?.docSlug ?? '');

  // ── Fabric floorplan view (P5): a read-only tile-grid + lit-nets diagram of
  //    the loaded VFPGA's placed fabric. Off by default (the card already shows
  //    the preview + controls); toggled on demand. Render-local UI state only.
  let showFloorplan = $state(false);
  function toggleFloorplan() { showFloorplan = !showFloorplan; }
</script>

<div class="mod-card vfpga-card" data-testid="vfpga-runner-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="VFPGA-RUNNER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- preview -->
    <div class="screen-wrap">
      <canvas bind:this={canvasEl} class="screen" data-testid="vfpga-screen"></canvas>
    </div>

    <!-- load preset… (VFPGAs are the presets) -->
    <div class="preset-row">
      <select class="preset" data-testid="vfpga-preset" bind:value={presetSelect} onchange={onPresetChange}>
        <option value="">load preset…</option>
        {#each SPECS as s}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
      <span class="loaded" data-testid="vfpga-loaded">{spec?.name ?? '—'}</span>
      <button
        type="button"
        class="fp-toggle"
        class:on={showFloorplan}
        data-testid="vfpga-floorplan-toggle"
        aria-pressed={showFloorplan}
        title="show the fabric floorplan (tile grid + lit routing nets)"
        onclick={toggleFloorplan}
      >fabric</button>
    </div>

    <!-- fabric floorplan view (read-only tile grid + lit routing nets) -->
    {#if showFloorplan}
      <VfpgaFloorplan {spec} />
    {/if}

    <!-- manifest-driven param knob grid -->
    {#if paramGrid.length > 0}
      <div class="knob-grid" data-testid="vfpga-knobs">
        {#each paramGrid as ps}
          <div class="knob-box">
            <Knob
              value={knobValue(ps.slot)}
              min={ps.min} max={ps.max} defaultValue={knobDefault(ps.slot)}
              label={ps.label} curve={ps.curve ?? 'linear'}
              onchange={setKnob(ps.slot)} moduleId={id} paramId={`p${ps.slot}`}
            />
          </div>
        {/each}
      </div>
    {/if}

    <!-- active CV inputs: SCALE attenuverter + OFFSET + scope (jack lives in the panel) -->
    {#if (spec?.cvRoles ?? []).length > 0}
      <div class="cv-section" data-testid="vfpga-cv">
        {#each spec?.cvRoles ?? [] as role}
          <div class="cv-row">
            <span class="cv-name">{role.label}</span>
            <div class="cv-knobs">
              <Knob value={cvInputFor(role.slot).scale} min={-1} max={1} defaultValue={DEFAULT_INPUT_SCALE}
                label="SCALE" curve="linear" onchange={setScale(role.slot)}
                moduleId={id} paramId={`${VFPGA_CV_PORTS[role.slot - 1]}:scale`} />
              <Knob value={cvInputFor(role.slot).offset} min={0} max={1} defaultValue={DEFAULT_INPUT_OFFSET}
                label="OFFSET" curve="linear" onchange={setOffset(role.slot)}
                moduleId={id} paramId={`${VFPGA_CV_PORTS[role.slot - 1]}:offset`} />
            </div>
            <canvas class="cv-scope" use:regScope={role.slot} data-testid={`vfpga-scope-${role.slot}`}></canvas>
          </div>
        {/each}
      </div>
    {/if}

    <!-- active gate inputs: activity LED (jack lives in the panel) -->
    {#if (spec?.gateRoles ?? []).length > 0}
      <div class="gate-section" data-testid="vfpga-gates">
        {#each spec?.gateRoles ?? [] as role}
          <div class="gate-row">
            <span class="led" class:on={gateHeld[role.slot - 1]}></span>
            <span class="gate-name">{role.label}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if docSlug}
      <a class="docs-link" data-testid="vfpga-docs" href={`/docs/modules/vfpga/${docSlug}/`} target="_blank" rel="noopener">docs ↗</a>
    {/if}
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 420px;
    min-height: 460px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 18px 14px 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .screen-wrap {
    margin: 8px auto 10px;
    width: 320px; height: 240px;
    border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6);
    background: #000; border-radius: 4px; overflow: hidden;
  }
  .screen { width: 320px; height: 240px; image-rendering: pixelated; display: block; }
  .preset-row { display: flex; align-items: center; gap: 8px; padding: 0 6px; margin-bottom: 8px; }
  .preset {
    flex: 1; background: var(--module-bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 3px;
    font-size: 0.7rem; padding: 4px 6px; font-family: ui-monospace, monospace;
  }
  .loaded { font-size: 0.65rem; color: var(--text-dim); font-family: ui-monospace, monospace; }
  .fp-toggle {
    background: var(--module-bg); color: var(--text-dim);
    border: 1px solid var(--border); border-radius: 3px;
    font-size: 0.6rem; padding: 3px 6px; font-family: ui-monospace, monospace;
    cursor: pointer; white-space: nowrap;
  }
  .fp-toggle:hover { border-color: var(--accent-dim); color: var(--text); }
  .fp-toggle.on { border-color: var(--accent); color: var(--accent); }
  .knob-grid { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; padding: 4px 6px 8px; }
  .knob-box { display: flex; flex-direction: column; align-items: center; }
  .cv-section, .gate-section { padding: 4px 6px; }
  .cv-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .cv-name { font-size: 0.6rem; font-family: ui-monospace, monospace; color: var(--text-dim); min-width: 40px; }
  .cv-knobs { display: flex; gap: 8px; }
  .cv-scope { width: 64px; height: 22px; border: 1px solid var(--border); border-radius: 2px; }
  .gate-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .led { width: 8px; height: 8px; border-radius: 50%; background: #333; border: 1px solid #000; }
  .led.on { background: #5fd35f; box-shadow: 0 0 4px #5fd35f; }
  .gate-name { font-size: 0.6rem; font-family: ui-monospace, monospace; color: var(--text-dim); }
  .docs-link { position: absolute; right: 10px; bottom: 8px; font-size: 0.6rem; color: var(--accent-dim); text-decoration: none; }
  .docs-link:hover { color: var(--accent); text-decoration: underline; }
</style>
