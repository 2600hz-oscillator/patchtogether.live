<script lang="ts">
  // CvBuddyCard — the FULL CV BUDDY (pitch + gate + velocity, three ES-9 jacks).
  //
  // Everything visible lives in CvBuddyBody, shared with CvBuddyMiniCard. The
  // two differ by one port and one line of slot text, so a single body keeps
  // them from drifting — a divergence there would show up as one card telling
  // the truth about ES-9 jacks and the other not.
  import type { NodeProps } from '@xyflow/svelte';
  import CvBuddyBody from './CvBuddyBody.svelte';
  let { id, data }: NodeProps = $props();
</script>

<CvBuddyBody {id} {data} kind="full" />
