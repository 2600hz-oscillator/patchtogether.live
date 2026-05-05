<script lang="ts">
  // Global stylesheet for Svelte Flow's canvas, viewport, handles, edges
  import '@xyflow/svelte/dist/style.css';
  import './global.css';
  import '$lib/ui/modules/_module-card.css';
  let { children } = $props();
</script>

{@render children()}
