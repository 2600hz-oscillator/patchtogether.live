<script lang="ts">
  import { goto } from '$app/navigation';
  import { UserButton, SignOutButton } from 'svelte-clerk';
  import FeedbackBox from '$lib/ui/FeedbackBox.svelte';

  const RACK_CAP = 4;

  let { data } = $props();
  let creating = $state(false);
  let error: string | null = $state(null);
  let deletingId: string | null = $state(null);
  let leavingId: string | null = $state(null);
  let rackspaces = $state(data.rackspaces);
  let savedGroups = $state(data.savedGroups);
  let deletingSavedGroupId: string | null = $state(null);
  let savedGroupsError: string | null = $state(null);

  let ownedCount = $derived(
    rackspaces.filter((r) => r.ownerUserId === data.userId).length,
  );
  let atCap = $derived(ownedCount >= RACK_CAP);

  async function deleteSavedGroup(id: string, label: string) {
    if (deletingSavedGroupId) return;
    if (!confirm(`Delete saved group "${label}"? This can't be undone.`)) return;
    deletingSavedGroupId = id;
    savedGroupsError = null;
    try {
      const res = await fetch(`/api/saved-groups/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        savedGroupsError = body.message ?? `Delete failed: ${res.status}`;
        return;
      }
      savedGroups = savedGroups.filter((g) => g.id !== id);
    } catch (e) {
      savedGroupsError = e instanceof Error ? e.message : String(e);
    } finally {
      deletingSavedGroupId = null;
    }
  }

  async function createRackspace() {
    if (atCap) return;
    creating = true;
    error = null;
    try {
      const res = await fetch('/api/rackspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled rackspace' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        error = body.message ?? `Create failed: ${res.status}`;
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

  async function deleteRack(id: string, name: string) {
    if (deletingId) return;
    if (!confirm(`Delete "${name || 'this rackspace'}"? This is permanent.`)) return;
    deletingId = id;
    error = null;
    try {
      const res = await fetch(`/api/rackspaces/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        error = body.message ?? `Delete failed: ${res.status}`;
        return;
      }
      // Reload server data so the rack drops out of the list.
      window.location.reload();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      deletingId = null;
    }
  }

  async function leaveRack(id: string, name: string) {
    if (leavingId) return;
    if (!confirm(`Leave "${name || 'this rackspace'}"? You can rejoin from the share link.`))
      return;
    leavingId = id;
    error = null;
    try {
      const res = await fetch(`/api/rackspaces/${id}/leave`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        error = body.message ?? `Leave failed: ${res.status}`;
        return;
      }
      // Drop the card locally so the freed slot is reflected immediately.
      rackspaces = rackspaces.filter((r) => r.id !== id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      leavingId = null;
    }
  }
</script>

<svelte:head><title>Dashboard — patchtogether.live</title></svelte:head>

<div class="root">
  <header class="topbar">
    <h1><a href="/">patchtogether.live</a></h1>
    <span class="caption">Your rackspaces</span>
    <div class="actions">
      <FeedbackBox />
      <SignOutButton redirectUrl="/">
        <button class="signout" title="Sign out">Sign out</button>
      </SignOutButton>
      <UserButton />
    </div>
  </header>

  <main>
    <div class="actions-row">
      <button
        class="primary"
        onclick={createRackspace}
        disabled={creating || atCap}
        title={atCap
          ? `Limit reached (${ownedCount}/${RACK_CAP} owned). Delete one first.`
          : 'Create a new rackspace'}
      >
        {creating ? 'Creating…' : '+ New rackspace'}
      </button>
      <span class="owned-count" class:cap={atCap}>
        {ownedCount}/{RACK_CAP} owned
      </span>
    </div>

    {#if error}
      <pre class="error">{error}</pre>
    {/if}

    {#if rackspaces.length === 0}
      <p class="empty">
        No rackspaces yet. Create one and you'll get a share URL you can send
        to up to 3 friends.
      </p>
    {:else}
      <ul class="rackspace-list">
        {#each rackspaces as r (r.id)}
          <li class="rack-row">
            <a class="rack-link" href={`/r/${r.id}`}>
              <span class="name">{r.name || 'Untitled rackspace'}</span>
              <span class="meta">
                {r.id} · {r.memberUserIds.length}/{4} members
                {#if r.ownerUserId !== data.userId}<span class="role">guest</span>{/if}
              </span>
            </a>
            {#if r.ownerUserId === data.userId}
              <button
                class="delete"
                onclick={() => deleteRack(r.id, r.name)}
                disabled={deletingId === r.id}
                title="Delete this rackspace (permanent)"
              >
                {deletingId === r.id ? 'Deleting…' : 'Delete'}
              </button>
            {:else}
              <button
                class="delete"
                onclick={() => leaveRack(r.id, r.name)}
                disabled={leavingId === r.id}
                title="Leave this rackspace (frees a slot; you can rejoin from the share link)"
              >
                {leavingId === r.id ? 'Leaving…' : 'Leave'}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <section class="saved-groups" data-testid="saved-groups-library">
      <h2>Saved groups</h2>
      {#if savedGroupsError}
        <pre class="error">{savedGroupsError}</pre>
      {/if}
      {#if savedGroups.length === 0}
        <p class="empty">
          No saved groups yet. In a rack, right-click a group → "Save group to library…"
          to add one here.
        </p>
      {:else}
        <ul class="saved-group-list">
          {#each savedGroups as sg (sg.id)}
            <li class="saved-group-row" data-testid="saved-group-row">
              <div class="info">
                <span class="name">{sg.label}</span>
                <span class="meta">
                  {sg.payload.children.length} module{sg.payload.children.length === 1 ? '' : 's'}
                  · {sg.payload.internalEdges.length} internal cable{sg.payload.internalEdges.length === 1 ? '' : 's'}
                </span>
              </div>
              <button
                class="delete"
                onclick={() => deleteSavedGroup(sg.id, sg.label)}
                disabled={deletingSavedGroupId === sg.id}
                data-testid="saved-group-delete"
                title="Delete saved group"
              >
                {deletingSavedGroupId === sg.id ? 'Deleting…' : 'Delete'}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
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
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .signout {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid #404652;
    padding: 6px 12px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
  }
  .signout:hover {
    background: #2a2f3a;
    color: var(--text);
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
  .actions-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .owned-count {
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .owned-count.cap {
    color: var(--cable-gate);
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
  .rack-row {
    display: flex;
    align-items: stretch;
  }
  .rack-link {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
    text-decoration: none;
    color: var(--text);
  }
  .rack-link:hover {
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
  .role {
    margin-left: 6px;
    padding: 1px 6px;
    border: 1px solid #404652;
    border-radius: 3px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .delete {
    background: transparent;
    color: var(--text-dim);
    border: none;
    border-left: 1px solid #2a2f3a;
    padding: 0 16px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
  }
  .delete:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.1);
    color: var(--cable-gate);
  }
  .delete:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error {
    color: var(--cable-gate);
    background: rgba(248, 113, 113, 0.1);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .saved-groups {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid #2a2f3a;
  }
  .saved-groups h2 {
    margin: 0 0 12px;
    font-size: 0.95rem;
    font-weight: 500;
  }
  .saved-group-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .saved-group-list li {
    border: 1px solid #2a2f3a;
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .saved-group-row {
    display: flex;
    align-items: stretch;
  }
  .saved-group-row .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
  }
</style>
