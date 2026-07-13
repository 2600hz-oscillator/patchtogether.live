<script lang="ts">
  // LAUNCHPAD CONTROL — module docs. Right-click the card → "View docs" opens
  // this page (/docs/modules/launchpadControlLeft; the type string is kept as
  // launchpadControlLeft after the L/R cards were consolidated into one module).
  // It renders the SHARED Launchpad guide — the SINGLE-pad four-view rework
  // (permanent top row · Grid/Clip/Keys/Control · shift · arp) AND the pair
  // (matrix / deck / editor) — one colour-coded source of truth for both.
  import LaunchpadDocs from '$lib/docs/LaunchpadDocs.svelte';
</script>

<svelte:head>
  <title>Launchpad control · modules · patchtogether.live</title>
  <meta
    name="description"
    content="Drive the clip player from one or a pair of Novation Launchpad Mini Mk3 units over Web MIDI. Single-pad mode: a permanent top row with Grid/Clip/Keys/Control views, one-hand shift, per-clip divider, swing, and an arpeggiator. Pair mode: an always-live 8×8 clip matrix plus a command-deck / note-editor. Pairing, pad/CC map, and the full LED colour language."
  />
</svelte:head>

<LaunchpadDocs />
