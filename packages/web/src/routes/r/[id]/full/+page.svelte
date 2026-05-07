<script lang="ts">
  // /r/[id]/full — friendly "rackspace is at capacity" page. Reached
  // either via direct nav (when the loader knows the doc is full) or
  // via client-side redirect from +page.svelte when the WS handshake
  // returns capacity-rejected.

  import { page } from '$app/state';

  let rackspaceId = $derived(page.params.id);
</script>

<svelte:head>
  <title>Rackspace full — patchtogether.live</title>
</svelte:head>

<div class="full-page">
  <div class="full-card">
    <h1>This rackspace is full</h1>
    <p>
      Up to 4 people can be in <code>{rackspaceId}</code> at once. Try again in a
      minute — when someone leaves, a spot opens up.
    </p>
    <div class="actions">
      <a class="btn primary" href="/r/{rackspaceId}">Try again</a>
      <a class="btn" href="/dashboard">Dashboard</a>
    </div>
  </div>
</div>

<style>
  .full-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--text);
    padding: 2rem;
  }
  .full-card {
    border: 1px solid #2a2f3a;
    border-radius: 6px;
    padding: 32px;
    max-width: 440px;
    width: 100%;
  }
  .full-card h1 {
    margin-top: 0;
    font-size: 1.2rem;
  }
  .full-card p {
    color: var(--text-dim);
    font-size: 0.9rem;
  }
  .full-card code {
    font-family: ui-monospace, monospace;
    background: #14171c;
    padding: 1px 5px;
    border-radius: 2px;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 20px;
  }
  .btn {
    display: inline-block;
    padding: 8px 16px;
    border-radius: 4px;
    text-decoration: none;
    font-size: 0.85rem;
    border: 1px solid #404652;
    color: var(--text);
    background: #2a2f3a;
  }
  .btn.primary {
    background: var(--cable-cv);
    border-color: var(--cable-cv);
    color: #1a1d23;
  }
  .btn:hover {
    filter: brightness(1.1);
  }
</style>
