<script lang="ts">
  import PhasesEditor from './PhasesEditor.svelte';
  let { nodeId }: { nodeId: string } = $props();
</script>

<div role="group" aria-label="Phases envelope editor" data-testid={`phases-face-body-${nodeId}`}>
  <PhasesEditor {nodeId} />
</div>
