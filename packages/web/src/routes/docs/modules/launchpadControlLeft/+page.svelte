<script lang="ts">
  // LAUNCHPAD CONTROL · LEFT — module docs. Right-click the card → "View docs"
  // opens this page (/docs/modules/launchpadControlLeft). It renders the SHARED
  // Launchpad guide (pairing / matrix / deck / editor / colour language), which
  // the RIGHT page renders too — one colour-coded source of truth for the pair.
  import LaunchpadDocs from '$lib/docs/LaunchpadDocs.svelte';
</script>

<svelte:head>
  <title>Launchpad control (left / matrix) · modules · patchtogether.live</title>
  <meta
    name="description"
    content="Drive the clip player from a pair of Novation Launchpad Mini Mk3 units over Web MIDI. The LEFT unit is the always-live 8×8 clip matrix; the RIGHT unit is the command deck + note editor. Pairing, pad/CC map, and the full LED colour language."
  />
</svelte:head>

<LaunchpadDocs />
