<script lang="ts">
  // VeilsCard — quad VCA + summing mix. Four channel strips, each with:
  //   - audio IN port, CV port, GAIN fader, response-curve toggle,
  //   - per-channel direct OUT port.
  // Plus a single MIX OUT port at the bottom (post-soft-clip sum).
  //
  // PatchPanel pattern (mirrors StereovcaCard / MixerCard). The response
  // toggle button cycles "LIN" / "EXP" and writes the resp{N} param
  // directly into patch.nodes[id].params, the same path the fader uses.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { veilsDef } from '$lib/audio/modules/veils';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Default-aware fallback so the card UI reflects the def's
  // defaultValue (1 for resp3/resp4 = EXP) even before the engine pushes
  // initial values into node.params.
  function defaultFor(k: string): number {
    return veilsDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string, fallback?: number): number {
    const v = node?.params?.[k];
    if (typeof v === 'number') return v;
    return fallback ?? defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Toggle the resp{N} param between 0 (LIN) and 1 (EXP).
  function toggleResp(ch: number): void {
    const k = `resp${ch}`;
    const t = patch.nodes[id]; if (!t) return;
    t.params[k] = (paramVal(k) >= 0.5) ? 0 : 1;
  }

  // Ports — generated channel-by-channel so we keep the L→R reading order
  // on the panel (in1, cv1, out1, in2, cv2, out2, ...). PatchPanel groups
  // by cable type for display, so the explicit ordering here is just to
  // keep the source readable.
  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'IN 1', cable: 'audio' },
    { id: 'in2', label: 'IN 2', cable: 'audio' },
    { id: 'in3', label: 'IN 3', cable: 'audio' },
    { id: 'in4', label: 'IN 4', cable: 'audio' },
    { id: 'cv1', label: 'CV 1', cable: 'cv' },
    { id: 'cv2', label: 'CV 2', cable: 'cv' },
    { id: 'cv3', label: 'CV 3', cable: 'cv' },
    { id: 'cv4', label: 'CV 4', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1', label: 'OUT 1', cable: 'audio' },
    { id: 'out2', label: 'OUT 2', cable: 'audio' },
    { id: 'out3', label: 'OUT 3', cable: 'audio' },
    { id: 'out4', label: 'OUT 4', cable: 'audio' },
    { id: 'mix',  label: 'MIX',   cable: 'audio' },
  ];

  const channels = [1, 2, 3, 4] as const;
</script>

<div class="mod-card veils-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">VEILS</header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={280}>
    <div class="strips">
      {#each channels as ch (ch)}
        <div class="strip">
          <Fader
            value={paramVal(`gain${ch}`, 0)}
            min={0} max={2} defaultValue={veilsDef.params[ch - 1]!.defaultValue}
            label={`Ch${ch}`}
            curve="linear"
            onchange={set(`gain${ch}`)} moduleId={id} paramId={`gain${ch}`}
            readLive={live(`gain${ch}`)}
          />
          <button
            type="button"
            class="resp-toggle"
            class:expo={paramVal(`resp${ch}`) >= 0.5}
            data-testid={`veils-resp${ch}`}
            onclick={() => toggleResp(ch)}
            title="Response curve: LIN (linear, CV-friendly) / EXP (exponential, audio-friendly)"
          >
            {paramVal(`resp${ch}`) >= 0.5 ? 'EXP' : 'LIN'}
          </button>
        </div>
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .veils-card { width: 280px; min-height: 240px; }
  .veils-card .strips {
    display: flex;
    gap: 8px;
    padding: 12px 14px 0;
    justify-content: space-between;
  }
  .veils-card .strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .veils-card .resp-toggle {
    font-size: 9px;
    font-family: var(--font-mono, monospace);
    padding: 2px 6px;
    border: 1px solid var(--border-dim, #444);
    border-radius: 3px;
    background: var(--surface-deep, #1a1a1a);
    color: var(--text-dim, #888);
    cursor: pointer;
    letter-spacing: 0.5px;
    line-height: 1;
  }
  .veils-card .resp-toggle:hover {
    color: var(--text, #ddd);
    border-color: var(--text-dim, #888);
  }
  .veils-card .resp-toggle.expo {
    color: var(--cable-audio, #f80);
    border-color: var(--cable-audio, #f80);
  }
</style>
