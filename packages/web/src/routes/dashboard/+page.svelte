<script lang="ts">
  import { goto } from '$app/navigation';
  import { UserButton } from 'svelte-clerk';

  let { data } = $props();
  let creating = $state(false);
  let error: string | null = $state(null);

  async function createRackspace() {
    creating = true;
    error = null;
    try {
      const res = await fetch('/api/rackspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled rackspace' }),
      });
      if (!res.ok) {
        error = `Create failed: ${res.status}`;
        return;
      }
      const { rackspace } = await res.json();
      await goto(`/r/${rackspace.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }
</script>

<svelte:head><title>Dashboard — patchtogether.live</title></svelte:head>

<div class="root">
  <header class="topbar">
    <h1><a href="/">patchtogether.live</a></h1>
    <span class="caption">Your rackspaces</span>
    <div class="actions">
      <UserButton />
    </div>
  </header>

  <main>
    <div class="actions-row">
      <button class="primary" onclick={createRackspace} disabled={creating}>
        {creating ? 'Creating…' : '+ New rackspace'}
      </button>
    </div>

    {#if error}
      <pre class="error">{error}</pre>
    {/if}

    {#if data.rackspaces.length === 0}
      <p class="empty">
        No rackspaces yet. Create one and you'll get a share URL you can send
        to up to 3 friends.
      </p>
    {:else}
      <ul class="rackspace-list">
        {#each data.rackspaces as r (r.id)}
          <li>
            <a href={`/r/${r.id}`}>
              <span class="name">{r.name || 'Untitled rackspace'}</span>
              <span class="meta">
                {r.id} · {r.memberUserIds.length}/{4} members
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </main>
</div>

<style>
  .root {
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 24px;
    border-bottom: 1px solid #2a2f3a;
  }
  .topbar h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
  }
  .topbar h1 a {
    color: inherit;
    text-decoration: none;
  }
  .topbar .caption {
    color: var(--text-dim);
    font-size: 0.85rem;
    flex: 1;
  }
  main {
    padding: 24px;
    max-width: 800px;
  }
  .actions-row {
    margin-bottom: 24px;
  }
  button.primary {
    background: var(--cable-cv);
    color: #1a1d23;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 500;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .empty {
    color: var(--text-dim);
  }
  .rackspace-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .rackspace-list li {
    border: 1px solid #2a2f3a;
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .rackspace-list a {
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
    text-decoration: none;
    color: var(--text);
  }
  .rackspace-list a:hover {
    background: #1a1d23;
  }
  .name {
    font-weight: 500;
  }
  .meta {
    color: var(--text-dim);
    font-size: 0.8rem;
    font-family: ui-monospace, monospace;
    margin-top: 2px;
  }
  .error {
    color: var(--cable-gate);
    background: rgba(248, 113, 113, 0.1);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
</style>
