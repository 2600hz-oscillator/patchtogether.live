<script lang="ts">
  // GroupCard — Module-grouping Phase 1.
  //
  // Renders a GROUP! meta-domain node as a single card whose handles are
  // derived from `node.data.exposedPorts`. The exposed ports stand in for
  // real child ports on the contained modules; `group-projection.ts`
  // rewrites edges to/from the group BEFORE the reconciler sees them, so
  // the engine never knows groups exist.
  //
  // Phase 1: minimal "GROUP!" label, no scope visualization. Phase 3 adds
  // the SCOPE pass-through viz under the same card shell.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import type { GroupData, ExposedPort } from '$lib/graph/group-projection';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  let groupData = $derived(node?.data as unknown as GroupData | undefined);

  function descriptor(ep: ExposedPort): PortDescriptor {
    return {
      id: ep.id,
      label: ep.label,
      cable: ep.cableType as string,
    };
  }

  let inputs = $derived<PortDescriptor[]>(
    (groupData?.exposedPorts ?? []).filter((p) => p.direction === 'input').map(descriptor),
  );
  let outputs = $derived<PortDescriptor[]>(
    (groupData?.exposedPorts ?? []).filter((p) => p.direction === 'output').map(descriptor),
  );

  let label = $derived<string>(groupData?.label ?? 'GROUP!');
  let childCount = $derived<number>(groupData?.childIds?.length ?? 0);
</script>

<div class="mod-card group-card" data-testid="group-card" data-node-id={id}>
  <div class="stripe" style="background: var(--accent, #60a5fa);"></div>
  <header class="title">GROUP!</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="group-body">
      <div class="group-label" data-testid="group-card-label">{label}</div>
      <div class="group-children-count">{childCount} module{childCount === 1 ? '' : 's'}</div>
    </div>
  </PatchPanel>
</div>

<style>
  .group-card {
    width: 220px;
    min-height: 180px;
  }
  .group-body {
    padding: 30px 24px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 120px;
  }
  .group-label {
    font-size: 1.05rem;
    letter-spacing: 0.04em;
    color: var(--text, #f1f1f1);
    font-weight: 500;
    text-align: center;
    word-break: break-word;
  }
  .group-children-count {
    font-size: 0.7rem;
    color: var(--text-dim, #8e94a2);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
</style>
