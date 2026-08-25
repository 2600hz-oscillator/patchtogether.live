<script lang="ts">
  // packages/web/src/lib/ui/modules/VfpgaModulationPanel.svelte
  //
  // The VFPGA-RUNNER MODULATION RACK — the PF-14 panel cell that carries the
  // half of this module's control surface the generic shell cells cannot
  // express: one SCALE attenuverter + OFFSET + live trace per CV role the
  // LOADED VFPGA declares, then an activity lamp per gate role.
  //
  // ⚠ WHY A PANEL AND NOT PARAM CELLS. SCALE and OFFSET are NOT ParamDefs. They
  // live in `node.data.cvInputs` (the shared TOYBOX shape, written by
  // `setCvScale`/`setCvOffset`), and the ROSTER is dynamic: which strips exist
  // is a property of whichever bitstream is loaded, so there is nothing static
  // for the def to declare. That is exactly the "a picture you edit" case the
  // panel rung of the bespoke-surface ladder is for, and it is the EARLIEST
  // rung that fits — a selector/toggle/file/action cell cannot hold N pairs of
  // continuous controls.
  //
  // ⚠ NO CELL HERE EMITS `control-<paramId>` (shell-cells.ts rule 1) — but the
  // knobs DO keep `moduleId`/`paramId`, so MIDI Learn survives promotion
  // exactly as it works on the legacy card. The two are separated by the
  // `testid` override prop on Knob; see the argument on that prop.
  //
  // ⚠ STATE LIVES ON THE NODE. `cvInputs` rides the Y.Doc like the card's, so
  // a dock collapse / LRU eviction cannot destroy it (the #1531/#1574/#1583
  // card-unmount class), and a rack saved before this promotion keeps its
  // conditioning.

  import { onDestroy, onMount } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { setCvScale, setCvOffset } from '$lib/graph/toybox-cv-inputs';
  import { getActiveEngine } from '$lib/audio/engine-ref';
  import type { VideoEngine } from '$lib/video/engine';
  import { getVfpgaSpec, DEFAULT_VFPGA_ID } from '$lib/video/vfpga/registry';
  import { VFPGA_CV_PORTS, type VfpgaSpec } from '$lib/video/vfpga/types';
  import {
    getCvInput,
    DEFAULT_INPUT_SCALE,
    DEFAULT_INPUT_OFFSET,
    type CvInputs,
  } from '$lib/video/toybox-cv-routes';
  import { drawToyboxInputScope, type ToyboxScopeColors } from '$lib/video/toybox-scope-draw';

  interface Props {
    /** The graph node this panel edits — the only prop a `ShellPanelCell`
     *  component receives. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  // ⚠ THE ATTENUVERTER RANGES COME FROM THE MODEL, NOT FROM LITERALS HERE.
  // `DEFAULT_INPUT_SCALE`/`DEFAULT_INPUT_OFFSET` are the same constants
  // `getCvInput` fills in when a slot is unset, so "the default" and "what the
  // knob resets to on double-click" cannot disagree.
  const SCALE_MIN = -1;
  const SCALE_MAX = 1;
  const OFFSET_MIN = 0;
  const OFFSET_MAX = 1;

  const SCOPE_W = 64;
  const SCOPE_H = 22;
  const SCOPE_LEN = 64;

  const SCOPE_COLORS: ToyboxScopeColors = {
    trace: 'var(--cable-cv)',
    fill: 'rgba(120, 200, 255, 0.18)',
    wave: 'rgba(255,255,255,0.18)',
    grid: 'rgba(255,255,255,0.12)',
    bg: '#0a0d12',
  };

  /** The live node, re-read through the shell's own reactivity seam so a
   *  preset swap re-derives the roster immediately. */
  let node = $derived.by(() => {
    void nodeVersion(nodeId);
    return patch.nodes[nodeId];
  });

  let spec = $derived.by<VfpgaSpec | undefined>(() => {
    const id = (node?.data as { vfpga?: string } | undefined)?.vfpga ?? DEFAULT_VFPGA_ID;
    return getVfpgaSpec(id) ?? getVfpgaSpec(DEFAULT_VFPGA_ID);
  });

  let cvRoles = $derived(spec?.cvRoles ?? []);
  let gateRoles = $derived(spec?.gateRoles ?? []);

  function cvInputs(): CvInputs {
    const ci = (node?.data as { cvInputs?: CvInputs } | undefined)?.cvInputs;
    return ci && typeof ci === 'object' ? ci : {};
  }
  function conditioning(slot: number): { scale: number; offset: number } {
    return getCvInput(cvInputs(), VFPGA_CV_PORTS[slot - 1] ?? `cv${slot}`);
  }
  const setScale = (slot: number) => (v: number) => {
    setCvScale(nodeId, VFPGA_CV_PORTS[slot - 1] ?? `cv${slot}`, v);
  };
  const setOffset = (slot: number) => (v: number) => {
    setCvOffset(nodeId, VFPGA_CV_PORTS[slot - 1] ?? `cv${slot}`, v);
  };

  // ── Live traces + gate lamps (ONE rAF pulls both) ────────────────────────
  const scopeEls = new Map<number, HTMLCanvasElement>();
  const scopeRings = new Map<number, number[]>();
  let raf: number | null = null;
  let gateHeld = $state<boolean[]>([]);

  /** Svelte action: register a trace canvas for `slot`. */
  function regScope(el: HTMLCanvasElement, slot: number) {
    el.width = SCOPE_W;
    el.height = SCOPE_H;
    scopeEls.set(slot, el);
    if (!scopeRings.has(slot)) scopeRings.set(slot, []);
    return { destroy() { scopeEls.delete(slot); } };
  }

  /** The live video engine, or undefined before boot / mid-teardown. Never
   *  throws — a hiccup must not kill the loop or the faceplate. */
  function videoEngine(): VideoEngine | undefined {
    try {
      return getActiveEngine()?.getDomain<VideoEngine>('video') ?? undefined;
    } catch {
      return undefined;
    }
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const ve = videoEngine();
    if (!ve) return;
    for (const [slot, el] of scopeEls) {
      const ctx = el.getContext('2d');
      if (!ctx) continue;
      const raw = (ve.readParam?.(nodeId, `cv${slot}_val`) ?? 0) as number;
      const { scale, offset } = conditioning(slot);
      const eff = Math.max(0, Math.min(1, raw * scale + offset));
      // ⚠ THE RING IS BORN FULL, AND THAT IS A DETERMINISM FIX RATHER THAN A
      // STYLE CHOICE. `drawToyboxInputScope` draws THREE different pictures for
      // the same constant value depending on how many samples it holds: at
      // length 0 it takes an early-return branch that strokes a bare baseline
      // and no fill at all, at length 1 every x collapses to 0 (`m > 1 ? … : 0`),
      // and only from 2 upward does it draw the flat line across the full width.
      // Growing one sample per rAF therefore makes the trace a function of HOW
      // LONG THE PANEL HAS BEEN MOUNTED — which is a different number of frames
      // on every renderer, and would put a frame-count dependency inside a VRT
      // baseline. Seeding the whole window with the current value makes the
      // resting picture identical on frame 1 and frame 1000, and costs nothing
      // once a cable is patched: the real samples wash through exactly as before.
      const ring = scopeRings.get(slot)!;
      if (ring.length === 0) {
        for (let i = 0; i < SCOPE_LEN; i++) ring.push(eff);
      } else {
        ring.push(eff);
        if (ring.length > SCOPE_LEN) ring.shift();
      }
      drawToyboxInputScope(ctx, {
        width: el.width,
        height: el.height,
        values: ring,
        colors: SCOPE_COLORS,
      });
    }
    try {
      const gs = ve.read(nodeId, 'gateState') as boolean[] | undefined;
      if (gs) gateHeld = gs.slice();
    } catch {
      /* engine hiccup — keep the loop alive */
    }
  }

  onMount(() => { raf = requestAnimationFrame(tick); });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });
</script>

<div class="vf-mod" data-testid="vfpga-modulation-panel">
  {#if cvRoles.length}
    <div class="cv-rows">
      {#each cvRoles as role (role.slot)}
        <div class="cv-row">
          <span class="role">{role.label}</span>
          <Knob
            value={conditioning(role.slot).scale}
            min={SCALE_MIN}
            max={SCALE_MAX}
            defaultValue={DEFAULT_INPUT_SCALE}
            label="SCALE"
            curve="linear"
            onchange={setScale(role.slot)}
            moduleId={nodeId}
            paramId={`${VFPGA_CV_PORTS[role.slot - 1]}:scale`}
            testid={`vfpga-scale-${role.slot}`}
          />
          <Knob
            value={conditioning(role.slot).offset}
            min={OFFSET_MIN}
            max={OFFSET_MAX}
            defaultValue={DEFAULT_INPUT_OFFSET}
            label="OFFSET"
            curve="linear"
            onchange={setOffset(role.slot)}
            moduleId={nodeId}
            paramId={`${VFPGA_CV_PORTS[role.slot - 1]}:offset`}
            testid={`vfpga-offset-${role.slot}`}
          />
          <canvas class="trace" use:regScope={role.slot} data-testid={`vfpga-trace-${role.slot}`}
          ></canvas>
        </div>
      {/each}
    </div>
  {/if}

  {#if gateRoles.length}
    <div class="gate-rows">
      {#each gateRoles as role (role.slot)}
        <span
          class="lamp-row"
          data-testid={`vfpga-gate-${role.slot}`}
          aria-label={`${role.label} gate ${gateHeld[role.slot - 1] ? 'high' : 'low'}`}
        >
          <span class="lamp" class:on={gateHeld[role.slot - 1]}></span>
          <span class="role">{role.label}</span>
        </span>
      {/each}
    </div>
  {/if}

  {#if !cvRoles.length && !gateRoles.length}
    <!-- A bitstream with no CV and no gate roles genuinely has nothing to
         condition. Saying so beats a blank rectangle a reader would read as a
         broken panel. It is a SECTION-scale statement about the loaded
         program, not a derived value. -->
    <span class="empty" data-testid="vfpga-modulation-empty">no modulation roles</span>
  {/if}
</div>

<style>
  .vf-mod {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 4px 4px;
  }
  .cv-rows, .gate-rows { display: flex; flex-direction: column; gap: 4px; }
  .gate-rows { flex-direction: row; flex-wrap: wrap; gap: 10px; }
  .cv-row { display: flex; align-items: center; gap: 8px; }
  .role {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    min-width: 44px;
    letter-spacing: 0.04em;
  }
  .trace {
    width: 64px;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .lamp-row { display: inline-flex; align-items: center; gap: 5px; }
  .lamp {
    width: 8px; height: 8px; border-radius: 50%;
    background: #333; border: 1px solid #000;
  }
  .lamp.on { background: #5fd35f; box-shadow: 0 0 4px #5fd35f; }
  .empty {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
</style>
