<script lang="ts">
  // LAUNCHPAD CONTROL — module docs. Right-click the card → "View docs" opens
  // this page (/docs/modules/launchpadControlLeft; the type string is kept as
  // launchpadControlLeft after the L/R cards were consolidated into one module).
  // It renders the SHARED Launchpad guide (pairing / matrix / deck / editor /
  // colour language) — one colour-coded source of truth for the pair.
  import LaunchpadDocs from '$lib/docs/LaunchpadDocs.svelte';
</script>

<svelte:head>
  <title>Launchpad control · modules · patchtogether.live</title>
  <meta
    name="description"
    content="Drive the clip player from a pair of Novation Launchpad Mini Mk3 units over Web MIDI. The left unit is the always-live 8×8 clip matrix; the right unit is the command deck + note editor. Pairing, pad/CC map, and the full LED colour language."
  />
</svelte:head>

<LaunchpadDocs />
