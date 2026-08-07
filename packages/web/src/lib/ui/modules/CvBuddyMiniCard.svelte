<script lang="ts">
  // CvBuddyMiniCard — the TWO-JACK CV BUDDY (pitch + gate, no velocity).
  //
  // Shares CvBuddyBody with the full card; `kind="mini"` drops the velocity
  // jacks and switches the slot readout to a pair. The ES-9 slot it reports
  // depends on EVERY CV Buddy on the rack, of either kind, because they draw
  // from one jack pool — see $lib/audio/cv-buddy/slot-alloc.
  import type { NodeProps } from '@xyflow/svelte';
  import CvBuddyBody from './CvBuddyBody.svelte';
  let { id, data }: NodeProps = $props();
</script>

<CvBuddyBody {id} {data} kind="mini" />
