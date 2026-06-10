<script lang="ts">
  // VfpgaRunnerCard — UI for the vfpga-runner HOST module.
  //
  // The card is MANIFEST-DRIVEN: a loaded VfpgaSpec (node.data.vfpga, resolved
  // from the registry) determines which ports are ACTIVE, the param-knob grid,
  // and the CV/gate jack labels. The card renders the FULL host port SUPERSET as
  // handles (so the per-module-per-port handle sweep stays green) but DIMS the
  // ports the loaded spec doesn't activate, so the active I/O reads clearly.
  //
  // Layout:
  //   - preview canvas (CPU snapshot via read('snapshot'), ~30 Hz);
  //   - "load preset…" <select> — VFPGAs ARE the presets (one option per spec);
  //   - manifest-driven p1..pN knob grid (Knob w/ moduleId/paramId → MIDI-learn);
  //   - active CV inputs each with a SCALE attenuverter + OFFSET + always-on
  //     scope (TOYBOX pattern, batched read('cvScope')-style — here we read the
  //     post scale+offset value back per rAF, joined to the preview pull);
  //   - active gate inputs with an activity LED;
  //   - docs link to the loaded VFPGA's subpage.
  //
  // Live render state (active-port set, attenuverter/scope) lives in node.data —
  // NEVER per-frame Y.Doc writes.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
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

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const SPECS = listVfpgaSpecs();

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

  // ── Active-port sets derived from the loaded spec ──
  let activeVin = $derived.by<Set<string>>(() => {
    const s = new Set<string>();
    const n = spec?.videoIn ?? 0;
    for (let i = 1; i <= n; i++) s.add(VFPGA_VIDEO_IN_PORTS[i - 1]!);
    return s;
  });
  let activeVout = $derived.by<Set<string>>(() => {
    const s = new Set<string>();
    const n = spec?.videoOut ?? 1;
    for (let i = 1; i <= n; i++) s.add(VFPGA_VIDEO_OUT_PORTS[i - 1]!);
    return s;
  });
  let cvRoleBySlot = $derived.by<Map<number, { label: string }>>(() => {
    const m = new Map<number, { label: string }>();
    for (const r of spec?.cvRoles ?? []) m.set(r.slot, { label: r.label });
    return m;
  });
  let gateRoleBySlot = $derived.by<Map<number, { label: string }>>(() => {
    const m = new Map<number, { label: string }>();
    for (const r of spec?.gateRoles ?? []) m.set(r.slot, { label: r.label });
    return m;
  });
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

  const SCOPE_COLORS: ToyboxScopeColors = {
    trace: 'var(--cable-cv)',
    fill: 'rgba(120, 200, 255, 0.18)',
    wave: 'rgba(255,255,255,0.18)',
    grid: 'rgba(255,255,255,0.12)',
    bg: '#0a0d12',
  };

  function regScope(slot: number) {
    return (el: HTMLCanvasElement) => {
      el.width = 64; el.height = 22;
      scopeEls.set(slot, el);
      if (!scopeRings.has(slot)) scopeRings.set(slot, []);
      return { destroy() { scopeEls.delete(slot); } };
    };
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const e = engineCtx.get();
    if (!e || !node) return;
    let ve: VideoEngine | undefined;
    try { ve = e.getDomain<VideoEngine>('video'); } catch { return; }
    // Preview snapshot.
    if (ctx2d) {
      const snap = ve.read(id, 'snapshot') as ImageData | undefined;
      if (snap) ctx2d.putImageData(snap, 0, 0);
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
      canvasEl.width = 320; canvasEl.height = 240;
      ctx2d = canvasEl.getContext('2d');
    }
    raf = requestAnimationFrame(tick);
  });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });

  // Handle vertical positions (px from card top).
  const VIN_TOP = (i: number) => 60 + i * 26;
  const CV_TOP = (i: number) => 60 + i * 26;
  const G_TOP = (i: number) => 168 + i * 26;
  const VOUT_TOP = (i: number) => 60 + i * 26;

  let docSlug = $derived.by(() => spec?.docSlug ?? '');
</script>

<div class="mod-card vfpga-card" data-testid="vfpga-runner-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="VFPGA-RUNNER" />

  <!-- VIDEO IN superset (left, upper) -->
  {#each VFPGA_VIDEO_IN_PORTS as p, i}
    <Handle type="target" position={Position.Left} id={p}
      class={activeVin.has(p) ? 'vfpga-active' : 'vfpga-inactive'}
      style={`top:${VIN_TOP(i)}px; --handle-color: var(--cable-video);`} />
    <span class="port-label left" class:dim={!activeVin.has(p)} style={`top:${VIN_TOP(i) - 6}px;`}>{p.toUpperCase()}</span>
  {/each}

  <!-- VIDEO OUT superset (right) -->
  {#each VFPGA_VIDEO_OUT_PORTS as p, i}
    <Handle type="source" position={Position.Right} id={p}
      class={activeVout.has(p) ? 'vfpga-active' : 'vfpga-inactive'}
      style={`top:${VOUT_TOP(i)}px; --handle-color: var(--cable-video);`} />
    <span class="port-label right" class:dim={!activeVout.has(p)} style={`top:${VOUT_TOP(i) - 6}px;`}>{p.toUpperCase()}</span>
  {/each}

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
  </div>

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

  <!-- active CV inputs: jack + SCALE attenuverter + OFFSET + scope -->
  {#if (spec?.cvRoles ?? []).length > 0}
    <div class="cv-section" data-testid="vfpga-cv">
      {#each spec?.cvRoles ?? [] as role}
        <div class="cv-row">
          <Handle type="target" position={Position.Left} id={VFPGA_CV_PORTS[role.slot - 1]}
            class="vfpga-active"
            style={`top:${CV_TOP(role.slot + 3)}px; --handle-color: var(--cable-cv);`} />
          <span class="cv-name">{role.label}</span>
          <div class="cv-knobs">
            <Knob value={cvInputFor(role.slot).scale} min={-1} max={1} defaultValue={DEFAULT_INPUT_SCALE}
              label="SCALE" curve="linear" onchange={setScale(role.slot)} />
            <Knob value={cvInputFor(role.slot).offset} min={0} max={1} defaultValue={DEFAULT_INPUT_OFFSET}
              label="OFFSET" curve="linear" onchange={setOffset(role.slot)} />
          </div>
          <canvas class="cv-scope" use:regScope(role.slot) data-testid={`vfpga-scope-${role.slot}`}></canvas>
        </div>
      {/each}
    </div>
  {/if}

  <!-- active gate inputs: jack + activity LED -->
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

  <!-- inactive gate jack handles (rendered for the handle sweep; dimmed) -->
  {#each VFPGA_GATE_PORTS as p, i}
    <Handle type="target" position={Position.Left} id={p}
      class={gateRoleBySlot.has(i + 1) ? 'vfpga-active' : 'vfpga-inactive'}
      style={`top:${G_TOP(i)}px; --handle-color: var(--cable-gate);`} />
    {#if !gateRoleBySlot.has(i + 1)}
      <span class="port-label left dim" style={`top:${G_TOP(i) - 6}px;`}>{p.toUpperCase()}</span>
    {/if}
  {/each}

  <!-- inactive CV jack handles (active ones rendered in cv-section above) -->
  {#each VFPGA_CV_PORTS as p, i}
    {#if !cvRoleBySlot.has(i + 1)}
      <Handle type="target" position={Position.Left} id={p}
        class="vfpga-inactive"
        style={`top:${CV_TOP(i + 3)}px; --handle-color: var(--cable-cv);`} />
      <span class="port-label left dim" style={`top:${CV_TOP(i + 3) - 6}px;`}>{p.toUpperCase()}</span>
    {/if}
  {/each}

  {#if docSlug}
    <a class="docs-link" data-testid="vfpga-docs" href={`/docs/modules/vfpga/${docSlug}/`} target="_blank" rel="noopener">docs ↗</a>
  {/if}
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
  .port-label { position: absolute; font-size: 0.55rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 16px; }
  .port-label.right { right: 16px; }
  .port-label.dim { opacity: 0.35; }
  /* dim inactive handles so the active I/O reads clearly */
  :global(.vfpga-inactive) { opacity: 0.3; }
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
