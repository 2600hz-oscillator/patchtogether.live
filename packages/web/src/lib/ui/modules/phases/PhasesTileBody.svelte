<script lang="ts">
  import PhasesEditor from './PhasesEditor.svelte';
  let { nodeId }: { nodeId: string } = $props();
</script>

<PhasesEditor {nodeId} compact />
