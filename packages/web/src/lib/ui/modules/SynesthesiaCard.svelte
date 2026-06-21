<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type { SynesthesiaSnapshot } from '$lib/audio/modules/synesthesia';
  import { drawVuMeters } from '$lib/audio/modules/synesthesia-draw';
  import { videoChannelLevels } from '../../../../../dsp/src/lib/synesthesia-dsp';
  import type { VideoEngine } from '$lib/video/engine';
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

  // ---- VIDEO-mode frame reader (the cross-domain pixel path) ----
  // In VIDEO mode the card reads the patched frame's pixels (only the DOM has a
  // canvas; the worklet can't), averages them to R/G/B/Luma levels, and writes
  // them to the worklet which sample-and-holds them through the env/gate/meter
  // stage. Mirrors WAVESCULPT's wall inputs: walk patch.edges to find the
  // upstream source, then either blit a video-domain source into the shared
  // drawing buffer, or pull an audio-domain mono-video source's drawFrame.
  const FRAME_W = 64;
  const FRAME_H = 48;
  let frameCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  let frameCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  function ensureFrameCanvas(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    if (frameCtx) return frameCtx;
    if (typeof OffscreenCanvas !== 'undefined') {
      frameCanvas = new OffscreenCanvas(FRAME_W, FRAME_H);
    } else if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = FRAME_W; c.height = FRAME_H;
      frameCanvas = c;
    } else {
      return null;
    }
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    return frameCtx;
  }

  /** Resolve the (nodeId, portId) currently patched into one of our inputs. */
  function findInputSource(portId: string): { nodeId: string; portId: string } | null {
    for (const eid of Object.keys(patch.edges)) {
      const e = patch.edges[eid];
      if (!e) continue;
      if (e.target?.nodeId === id && e.target?.portId === portId) {
        return { nodeId: e.source.nodeId, portId: e.source.portId };
      }
    }
    return null;
  }

  /** Draw whatever is patched into {c}_video_in into the scratch canvas, then
   *  read its pixels → [R,G,B,Luma] levels (0..1). Returns null when no source
   *  is patched or the frame can't be read (gate stays closed → meters dark). */
  function readVideoLevels(c: 'a' | 'b'): [number, number, number, number] | null {
    const e = engineCtx.get();
    if (!e) return null;
    const src = findInputSource(`${c}_video_in`);
    if (!src) return null;
    const ctx2d = ensureFrameCanvas();
    if (!ctx2d || !frameCanvas) return null;

    const srcNode = patch.nodes[src.nodeId];
    const srcDomain = srcNode?.domain ?? 'audio';
    let imageSource: CanvasImageSource | undefined;
    if (srcDomain === 'video') {
      // Cross-domain: render the source video module's FBO into the shared
      // drawing buffer, then sample that buffer.
      let videoEngine: VideoEngine | undefined;
      try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { videoEngine = undefined; }
      if (!videoEngine) return null;
      try { videoEngine.blitOutputToDrawingBuffer(src.nodeId); } catch { return null; }
      imageSource = videoEngine.canvas as CanvasImageSource | undefined;
    } else {
      // Audio-domain mono-video source (RASTERIZE, WAVESCULPT.video_out, even
      // SYNESTHESIA's own raster): pull its drawFrame into the scratch canvas.
      let audioEngine:
        | { getVideoSource?: (n: string, p: string) => { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null }
        | undefined;
      try { audioEngine = e.getDomain('audio') as unknown as typeof audioEngine; }
      catch { audioEngine = undefined; }
      const vsrc = audioEngine?.getVideoSource?.(src.nodeId, src.portId) ?? null;
      if (!vsrc?.drawFrame) return null;
      try { vsrc.drawFrame(frameCanvas); } catch { return null; }
      // drawFrame already painted frameCanvas; read straight from it.
      try {
        const img = ctx2d.getImageData(0, 0, FRAME_W, FRAME_H);
        return videoChannelLevels(img.data);
      } catch { return null; }
    }
    if (!imageSource) return null;
    try {
      ctx2d.clearRect(0, 0, FRAME_W, FRAME_H);
      ctx2d.drawImage(imageSource, 0, 0, FRAME_W, FRAME_H);
      const img = ctx2d.getImageData(0, 0, FRAME_W, FRAME_H);
      return videoChannelLevels(img.data);
    } catch {
      return null;
    }
  }

  // ---- VU meters (one canvas per copy, each drawing 4 band/channel columns) ----
  let canvasA: HTMLCanvasElement | null = $state(null);
  let canvasB: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasA && !canvasB) return;
    function tick(): void {
      const eng = engineCtx.get();
      if (eng && node) {
        // VIDEO mode: push the latest frame's channel levels to the worklet so
        // its env/gate/meter stage runs off the colour, before reading back the
        // VU snapshot the worklet posts.
        if (isVideo('a')) {
          const lv = readVideoLevels('a');
          if (lv) eng.write(node, 'video_levels_a', lv);
        }
        if (isVideo('b')) {
          const lv = readVideoLevels('b');
          if (lv) eng.write(node, 'video_levels_b', lv);
        }
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
        <Knob value={param('a_master', 1)} min={0.5} max={1.5} defaultValue={1} label="A MAS"
          curve="linear" onchange={set('a_master')} moduleId={id} paramId="a_master" readLive={live('a_master')} />
      </div>
      <div class="bands">
        <canvas bind:this={canvasA} width="208" height="96" data-testid="synesthesia-vu-a"></canvas>
        <div class="gain-row">
          {#each BANDS as b, i (b)}
            <div class="gcol">
              <Knob value={param(`a_gain${b}`, 1)} min={1} max={2} defaultValue={1} label={`B${b}`}
                curve="linear" onchange={set(`a_gain${b}`)} moduleId={id} paramId={`a_gain${b}`} readLive={live(`a_gain${b}`)} />
              <div class="band-label" class:video={isVideo('a')}>{isVideo('a') ? VIDEO_LABELS[i] : BAND_LABELS[i]}</div>
            </div>
          {/each}
        </div>
        <!-- Per-band ENV-OUTPUT depth: scales BOTH env CV outputs (slow + fast)
             for that band — source-side modulation depth. 0=cut, 1=unity, 2=2×. -->
        <div class="depth-row" data-testid="synesthesia-depth-a">
          {#each BANDS as b (b)}
            <div class="gcol">
              <Knob value={param(`a_envdepth${b}`, 1)} min={0} max={2} defaultValue={1} label={`B${b}`}
                curve="linear" onchange={set(`a_envdepth${b}`)} moduleId={id} paramId={`a_envdepth${b}`} readLive={live(`a_envdepth${b}`)} />
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
        <Knob value={param('b_master', 1)} min={0.5} max={1.5} defaultValue={1} label="B MAS"
          curve="linear" onchange={set('b_master')} moduleId={id} paramId="b_master" readLive={live('b_master')} />
      </div>
      <div class="bands">
        <canvas bind:this={canvasB} width="208" height="96" data-testid="synesthesia-vu-b"></canvas>
        <div class="gain-row">
          {#each BANDS as b, i (b)}
            <div class="gcol">
              <Knob value={param(`b_gain${b}`, 1)} min={1} max={2} defaultValue={1} label={`B${b}`}
                curve="linear" onchange={set(`b_gain${b}`)} moduleId={id} paramId={`b_gain${b}`} readLive={live(`b_gain${b}`)} />
              <div class="band-label" class:video={isVideo('b')}>{isVideo('b') ? VIDEO_LABELS[i] : BAND_LABELS[i]}</div>
            </div>
          {/each}
        </div>
        <!-- Per-band ENV-OUTPUT depth (see Copy A). -->
        <div class="depth-row" data-testid="synesthesia-depth-b">
          {#each BANDS as b (b)}
            <div class="gcol">
              <Knob value={param(`b_envdepth${b}`, 1)} min={0} max={2} defaultValue={1} label={`B${b}`}
                curve="linear" onchange={set(`b_envdepth${b}`)} moduleId={id} paramId={`b_envdepth${b}`} readLive={live(`b_envdepth${b}`)} />
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
