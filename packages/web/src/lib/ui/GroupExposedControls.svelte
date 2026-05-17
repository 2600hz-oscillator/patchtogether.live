<script lang="ts">
  // GroupExposedControls — Module-grouping Phase 4.
  //
  // Renders the bounded box stack on a GROUP! card body for any child-module
  // controls that have been opted into surface. One box per child, with the
  // child's display name as the header, followed by the exposed controls
  // (buttons + knobs) reusing the same primitives the source card uses.

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { resolveExposedControls } from '$lib/graph/group-controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { GroupData } from '$lib/graph/group-projection';

  interface Props {
    /** The group's ModuleNode — read for data.exposedControls. */
    group: ModuleNode;
    /** Cardversion bump so we re-derive when any patch mutation lands. */
    cardVersion: number;
  }

  let { group, cardVersion }: Props = $props();
  const engineCtx = useEngine();

  let blocks = $derived.by(() => {
    void cardVersion;
    return resolveExposedControls(group as { data?: unknown }, {
      nodes: patch.nodes as Record<string, ModuleNode | undefined>,
      defLookup: (t: string) => getModuleDef(t),
      defLabelLookup: (t: string) => getModuleDef(t)?.label,
    });
  });

  // Lookup ParamDef so knob controls inherit the same min/max/curve/default
  // as on the source card. Falls back to a flat 0..1 linear knob — should
  // never trigger because the schema-validation test enforces a matching
  // params[] entry, but the cast lets the render survive a stale def.
  function paramDefFor(child: ModuleNode, paramId: string) {
    const def = getModuleDef(child.type);
    return def?.params.find((p) => p.id === paramId);
  }

  function readParam(child: ModuleNode, paramId: string): number {
    void cardVersion;
    const live = patch.nodes[child.id];
    return (live?.params[paramId] ?? paramDefFor(child, paramId)?.defaultValue ?? 0) as number;
  }

  function setParam(child: ModuleNode, paramId: string, value: number) {
    const target = patch.nodes[child.id];
    if (!target) return;
    target.params[paramId] = value;
  }

  function isPlaying(child: ModuleNode, paramId: string): boolean {
    return readParam(child, paramId) >= 0.5;
  }

  function togglePlay(child: ModuleNode, paramId: string) {
    setParam(child, paramId, isPlaying(child, paramId) ? 0 : 1);
  }

  function liveReader(child: ModuleNode, paramId: string) {
    return () => {
      const e = engineCtx.get();
      if (!e) return undefined;
      const live = patch.nodes[child.id];
      if (!live) return undefined;
      return e.readParam(live as unknown as ModuleNode, paramId);
    };
  }
</script>

{#if blocks.length > 0}
  <div class="exposed-controls" data-testid="group-exposed-controls">
    {#each blocks as block (block.childId)}
      <div class="ctrl-box" data-testid="ctrl-box" data-child-id={block.childId}>
        <div class="ctrl-header" data-testid="ctrl-box-header">{block.childLabel}</div>
        <div class="ctrl-body">
          {#each block.controls as c (c.id)}
            {#if c.kind === 'button'}
              <button
                class="play-btn"
                class:playing={isPlaying(block.child, c.paramId)}
                onclick={() => togglePlay(block.child, c.paramId)}
                title={isPlaying(block.child, c.paramId) ? 'Stop' : 'Play'}
                data-testid={`ctrl-btn-${block.childId}-${c.id}`}
                data-control-kind="button"
                data-playing={isPlaying(block.child, c.paramId) ? 'true' : 'false'}
              >
                {isPlaying(block.child, c.paramId) ? '■' : '▶'}
              </button>
            {:else if c.kind === 'knob'}
              {@const pd = paramDefFor(block.child, c.paramId)}
              {#if pd}
                <div class="knob-wrap" data-testid={`ctrl-knob-${block.childId}-${c.id}`} data-control-kind="knob">
                  <Knob
                    value={readParam(block.child, c.paramId)}
                    min={pd.min}
                    max={pd.max}
                    defaultValue={pd.defaultValue}
                    label={c.label}
                    units={pd.units}
                    curve={pd.curve}
                    onchange={(v) => setParam(block.child, c.paramId, v)}
                    readLive={liveReader(block.child, c.paramId)}
                  />
                </div>
              {/if}
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .exposed-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px 4px;
  }
  .ctrl-box {
    border: 1px solid var(--border, #404652);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.02);
    padding: 6px 8px 8px;
  }
  .ctrl-header {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim, #8e94a2);
    padding-bottom: 4px;
  }
  .ctrl-body {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    justify-content: flex-start;
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
    background: var(--cable-gate, #f59e0b);
    color: #1a1d23;
    border-color: var(--cable-gate, #f59e0b);
  }
  .knob-wrap {
    display: inline-flex;
  }
</style>
