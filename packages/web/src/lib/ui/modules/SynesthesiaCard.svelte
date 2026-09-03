<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import { synesthesiaDef, type SynesthesiaSnapshot } from '$lib/audio/modules/synesthesia';
  import { paramSpec } from './card-kit';
  import { drawVuMeters } from '$lib/audio/modules/synesthesia-draw';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function param(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }
  const set = (id_: string) => (v: number) => setNodeParam(id, id_, v);
  const live = (id_: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };

  const BANDS = [1, 2, 3, 4] as const;

  // ⚠ RANGES COME FROM THE DEF, NEVER RE-TYPED HERE (the backdraft class).
  // Until 2026-08-24 the eight ENV-DEPTH knobs below passed literal
  // `min={0} max={4}` while `synesthesiaDef` — and the worklet's own
  // `AudioParam` descriptor, via `ENVDEPTH_MIN`/`ENVDEPTH_MAX` in
  // packages/dsp/src/lib/synesthesia-dsp.ts — declared `0..2`. So the TOP HALF
  // of every one of those dials wrote a value the contract forbids and
  // `setValueAtTime` clamped it silently: the knob moved, the readout moved,
  // the sound did not.
  //
  // ⚠ AND NO GATE COULD SEE IT. `card-def-agreement` extracts the param id with
  // `/paramId="([^"]+)"/` — a DOUBLE-QUOTED literal — and skips any tag it
  // cannot name. These knobs bind `paramId={`a_envdepth${b}`}`, a template
  // literal, so all eight were classified "expression-bound" and excluded from
  // the comparison entirely. `paramSpec` throws on an id this def does not
  // declare, so the binding cannot rot the way the literals did.
  //
  // Each knob binds ITS OWN param rather than a shared "one of these is
  // representative" constant — copy A's and copy B's controls are separate
  // ParamDefs, and a shared spec would go on agreeing after one of them moved.
  //
  // ⚠ `curve` COMES FROM THE DEF TOO, and that is the same blind spot wearing a
  // different prop. `card-range-source` refuses a hand-typed `curve` it cannot
  // attribute — and it cannot attribute ANY of the sixteen controls inside the
  // two `{#each}` blocks, for the same reason `card-def-agreement` could not
  // check their ranges: the id is a template literal. So a `curve="linear"`
  // there is exactly as unverifiable as a `max={4}` was. Reading it off the
  // ParamDef removes the second copy rather than asserting it agrees.
  const spec = (id: string): ParamDef => paramSpec(synesthesiaDef, id);
  // Musical band edges: bass 20–200, low-mid 200–1k, high-mid 1k–4k, treble 4k+.
  const BAND_LABELS = ['20–200', '200–1k', '1k–4k', '4k+'] as const;
  // In VIDEO mode the 4 lanes are the R/G/B/Luma channels of the patched frame.
  const VIDEO_LABELS = ['R', 'G', 'B', 'L'] as const;

  // MODE: 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma). Per copy, switches
  // independently. Reactive so labels + the active-mode badge follow the param.
  let aMode = $derived(Math.round(param('a_mode', 0)));
  let bMode = $derived(Math.round(param('b_mode', 0)));
  const isVideo = (c: 'a' | 'b'): boolean => (c === 'a' ? aMode : bMode) === 1;
  function toggleMode(c: 'a' | 'b'): void {
    const cur = c === 'a' ? aMode : bMode;
    set(`${c}_mode`)(cur === 1 ? 0 : 1);
  }

  // POLARITY of the env CV outputs (env_slow / env_fast): UNI = unipolar [0,1]
  // (default), BI = bipolar [-1,+1]. Bipolar makes a strong kick sweep the FULL
  // destination range through the knob-centered cv→video bridge. Per copy.
  let aBipolar = $derived(Math.round(param('a_bipolar', 0)));
  let bBipolar = $derived(Math.round(param('b_bipolar', 0)));
  const isBipolar = (c: 'a' | 'b'): boolean => (c === 'a' ? aBipolar : bBipolar) === 1;
  function togglePolarity(c: 'a' | 'b'): void {
    const cur = c === 'a' ? aBipolar : bBipolar;
    set(`${c}_bipolar`)(cur === 1 ? 0 : 1);
  }

  function copyPorts(c: 'a' | 'b'): { inputs: PortDescriptor[]; outputs: PortDescriptor[] } {
    return {
      inputs: [
        { id: `${c}_in`, label: `${c.toUpperCase()} IN`, cable: 'audio' },
        { id: `${c}_video_in`, label: `${c.toUpperCase()} VIDEO IN`, cable: 'video' },
      ],
      outputs: BANDS.flatMap((b, i) => [
        { id: `${c}_band${b}_audio`,    label: `B${b} ${BAND_LABELS[i]} OUT`, cable: 'audio' as const },
        { id: `${c}_band${b}_env_slow`, label: `B${b} SLOW ENV`,             cable: 'cv' as const },
        { id: `${c}_band${b}_env_fast`, label: `B${b} FAST ENV`,             cable: 'cv' as const },
        { id: `${c}_band${b}_gate`,     label: `B${b} GATE`,                 cable: 'gate' as const },
        { id: `${c}_band${b}_trig`,     label: `B${b} BEAT TRIG`,            cable: 'gate' as const },
        { id: `${c}_band${b}_raster`,   label: `B${b} RASTER`,               cable: 'mono-video' as const },
      ]),
    };
  }
  const portsA = copyPorts('a');
  const portsB = copyPorts('b');
  const sections = [
    { label: 'Copy A', inputs: portsA.inputs, outputs: portsA.outputs },
    { label: 'Copy B', inputs: portsB.inputs, outputs: portsB.outputs },
  ];

  // ---- VU meters (one canvas per copy, each drawing 4 band/channel columns) ----
  //
  // ⚠ THIS CARD IS A READER NOW, NOT A PRODUCER (legacy-removal S1). The
  // cross-domain PIXEL path — resolve what is patched into `{c}_video_in`, blit
  // one frame of it into a 64×48 scratch, average it to R/G/B/Luma and hand the
  // four numbers to the worklet — used to live right here, so `synesthesia` sat
  // in `CARD_PRODUCER_LANE_TYPES` and the default shell kept this card mounted
  // OFF-SCREEN in `<HeadlessSourceHost>` purely to keep that loop running. It
  // belongs to the NODE now (`$lib/ui/media/frame-producers`), on graph
  // lifetime. What is left is a repaint of the levels the worklet already
  // posts — the same thing `synesthesia/SynesthesiaVuBody.svelte` does.
  //
  // ⚠ DO NOT SPELL THE SEAM CALL-SHAPED IN A COMMENT IN THIS SUBTREE. The
  // producer gate matches its seam regexes against RAW source and strips no
  // comments, so writing the departed push out as a call re-enrols this module
  // in the set this change removes it from. Name it, never spell it.
  let canvasA: HTMLCanvasElement | null = $state(null);
  let canvasB: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasA && !canvasB) return;
    function tick(): void {
      const eng = engineCtx.get();
      if (eng && node) {
        const snap = eng.read(node, 'snapshot') as SynesthesiaSnapshot | undefined;
        if (snap) {
          const ca = canvasA?.getContext('2d');
          if (ca && canvasA) drawVuMeters(ca, snap.levelsA, canvasA.width, canvasA.height);
          const cb = canvasB?.getContext('2d');
          if (cb && canvasB) drawVuMeters(cb, snap.levelsB, canvasB.width, canvasB.height);
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });
</script>

<div class="mod-card syn-card" data-testid="synesthesia-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SYNESTHESIA" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={560}>
    <!-- Copy A -->
    <div class="copy">
      <div class="master">
        <button
          type="button"
          class="mode-toggle"
          class:video={isVideo('a')}
          data-testid="synesthesia-mode-a"
          data-mode={isVideo('a') ? 'video' : 'audio'}
          onclick={() => toggleMode('a')}
          title="Toggle A between AUDIO (spectral bands) and VIDEO (R/G/B/Luma)"
        >{isVideo('a') ? 'VIDEO' : 'AUDIO'}</button>
        <button
          type="button"
          class="polarity-toggle"
          class:bipolar={isBipolar('a')}
          data-testid="synesthesia-polarity-a"
          data-polarity={isBipolar('a') ? 'bi' : 'uni'}
          onclick={() => togglePolarity('a')}
          title="Env CV polarity: UNI [0,1] or BI [-1,+1] (BI sweeps the full destination range)"
        >{isBipolar('a') ? 'BI' : 'UNI'}</button>
        <Knob value={param('a_master', spec('a_master').defaultValue)} min={spec('a_master').min} max={spec('a_master').max} defaultValue={spec('a_master').defaultValue} label="A MAS"
          curve={spec('a_master').curve} onchange={set('a_master')} moduleId={id} paramId="a_master" readLive={live('a_master')} />
      </div>
      <div class="bands">
        <canvas bind:this={canvasA} width="208" height="96" data-testid="synesthesia-vu-a"></canvas>
        <div class="gain-row">
          {#each BANDS as b, i (b)}
            <div class="gcol">
              <Knob value={param(`a_gain${b}`, spec(`a_gain${b}`).defaultValue)} min={spec(`a_gain${b}`).min} max={spec(`a_gain${b}`).max} defaultValue={spec(`a_gain${b}`).defaultValue} label={`B${b}`}
                curve={spec(`a_gain${b}`).curve} onchange={set(`a_gain${b}`)} moduleId={id} paramId={`a_gain${b}`} readLive={live(`a_gain${b}`)} />
              <div class="band-label" class:video={isVideo('a')}>{isVideo('a') ? VIDEO_LABELS[i] : BAND_LABELS[i]}</div>
            </div>
          {/each}
        </div>
        <!-- Per-band ENV-OUTPUT depth: scales BOTH env CV outputs (slow + fast)
             for that band — source-side modulation depth. 0=cut, 1=unity, 2=2×. -->
        <div class="depth-row" data-testid="synesthesia-depth-a">
          {#each BANDS as b (b)}
            <div class="gcol">
              <Knob value={param(`a_envdepth${b}`, spec(`a_envdepth${b}`).defaultValue)} min={spec(`a_envdepth${b}`).min} max={spec(`a_envdepth${b}`).max} defaultValue={spec(`a_envdepth${b}`).defaultValue} label={`B${b}`}
                curve={spec(`a_envdepth${b}`).curve} onchange={set(`a_envdepth${b}`)} moduleId={id} paramId={`a_envdepth${b}`} readLive={live(`a_envdepth${b}`)} />
              <div class="depth-label">DPT</div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Copy B -->
    <div class="copy">
      <div class="master">
        <button
          type="button"
          class="mode-toggle"
          class:video={isVideo('b')}
          data-testid="synesthesia-mode-b"
          data-mode={isVideo('b') ? 'video' : 'audio'}
          onclick={() => toggleMode('b')}
          title="Toggle B between AUDIO (spectral bands) and VIDEO (R/G/B/Luma)"
        >{isVideo('b') ? 'VIDEO' : 'AUDIO'}</button>
        <button
          type="button"
          class="polarity-toggle"
          class:bipolar={isBipolar('b')}
          data-testid="synesthesia-polarity-b"
          data-polarity={isBipolar('b') ? 'bi' : 'uni'}
          onclick={() => togglePolarity('b')}
          title="Env CV polarity: UNI [0,1] or BI [-1,+1] (BI sweeps the full destination range)"
        >{isBipolar('b') ? 'BI' : 'UNI'}</button>
        <Knob value={param('b_master', spec('b_master').defaultValue)} min={spec('b_master').min} max={spec('b_master').max} defaultValue={spec('b_master').defaultValue} label="B MAS"
          curve={spec('b_master').curve} onchange={set('b_master')} moduleId={id} paramId="b_master" readLive={live('b_master')} />
      </div>
      <div class="bands">
        <canvas bind:this={canvasB} width="208" height="96" data-testid="synesthesia-vu-b"></canvas>
        <div class="gain-row">
          {#each BANDS as b, i (b)}
            <div class="gcol">
              <Knob value={param(`b_gain${b}`, spec(`b_gain${b}`).defaultValue)} min={spec(`b_gain${b}`).min} max={spec(`b_gain${b}`).max} defaultValue={spec(`b_gain${b}`).defaultValue} label={`B${b}`}
                curve={spec(`b_gain${b}`).curve} onchange={set(`b_gain${b}`)} moduleId={id} paramId={`b_gain${b}`} readLive={live(`b_gain${b}`)} />
              <div class="band-label" class:video={isVideo('b')}>{isVideo('b') ? VIDEO_LABELS[i] : BAND_LABELS[i]}</div>
            </div>
          {/each}
        </div>
        <!-- Per-band ENV-OUTPUT depth (see Copy A). -->
        <div class="depth-row" data-testid="synesthesia-depth-b">
          {#each BANDS as b (b)}
            <div class="gcol">
              <Knob value={param(`b_envdepth${b}`, spec(`b_envdepth${b}`).defaultValue)} min={spec(`b_envdepth${b}`).min} max={spec(`b_envdepth${b}`).max} defaultValue={spec(`b_envdepth${b}`).defaultValue} label={`B${b}`}
                curve={spec(`b_envdepth${b}`).curve} onchange={set(`b_envdepth${b}`)} moduleId={id} paramId={`b_envdepth${b}`} readLive={live(`b_envdepth${b}`)} />
              <div class="depth-label">DPT</div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .syn-card {
    width: 460px;
    min-height: 360px;
  }
  .copy {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 10px 16px;
  }
  .copy + .copy {
    border-top: 1px solid var(--border);
  }
  .master {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
  }
  .mode-toggle {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #0c0e12;
    color: var(--cable-audio, #22c55e);
    cursor: pointer;
    width: 52px;
    text-align: center;
  }
  .mode-toggle.video {
    color: var(--cable-video, #c084fc);
    border-color: var(--cable-video, #c084fc);
    box-shadow: 0 0 4px var(--cable-video, #c084fc);
  }
  .polarity-toggle {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #0c0e12;
    color: var(--text-dim);
    cursor: pointer;
    width: 52px;
    text-align: center;
  }
  .polarity-toggle.bipolar {
    color: var(--cable-cv, #f59e0b);
    border-color: var(--cable-cv, #f59e0b);
    box-shadow: 0 0 4px var(--cable-cv, #f59e0b);
  }
  .bands {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bands canvas {
    display: block;
    width: 208px;
    height: 96px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #0c0e12;
  }
  .gain-row,
  .depth-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    width: 208px;
  }
  .depth-row {
    border-top: 1px dashed var(--border);
    padding-top: 4px;
  }
  .depth-label {
    font-size: 0.45rem;
    color: var(--cable-cv, #f59e0b);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
  }
  .gcol {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .band-label {
    font-size: 0.5rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.01em;
  }
  .band-label.video {
    color: var(--cable-video, #c084fc);
    font-weight: 600;
    font-size: 0.6rem;
  }
</style>
