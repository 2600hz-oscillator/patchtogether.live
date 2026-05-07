<script lang="ts">
  import IoDiagram from '$lib/docs/IoDiagram.svelte';

  let { data } = $props();
  let mod = $derived(data.mod);
</script>

<svelte:head>
  <title>{mod.label} — patchtogether.live docs</title>
  <meta name="description" content={mod.description} />
</svelte:head>

<section class="hero">
  <h1>{mod.label}</h1>
  <div class="sub">
    <span class="tag">{mod.category}</span>
    {#if mod.maxInstances === 1}<span class="tag singleton">singleton</span>{/if}
    <code>type: {mod.type}</code>
    <code>schemaVersion: {mod.schemaVersion}</code>
  </div>
</section>

<p>{mod.description}</p>

<nav class="back-nav"><a href="/docs/modules">← back to catalog</a></nav>

<h2>I/O</h2>
<IoDiagram {mod} />

{#if mod.inputs.length > 0}
  <h3>inputs</h3>
  <table>
    <thead><tr><th>port</th><th>type</th><th>note</th></tr></thead>
    <tbody>
      {#each mod.inputs as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.type}</td>
          <td>{p.note}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if mod.outputs.length > 0}
  <h3>outputs</h3>
  <table>
    <thead><tr><th>port</th><th>type</th><th>note</th></tr></thead>
    <tbody>
      {#each mod.outputs as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.type}</td>
          <td>{p.note}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if mod.params.length > 0}
  <h2>params</h2>
  <table>
    <thead><tr><th>id</th><th>label</th><th>units / curve</th><th>range</th><th>default</th></tr></thead>
    <tbody>
      {#each mod.params as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.label}</td>
          <td>{p.units || p.curve}</td>
          <td>{p.min ?? '?'}..{p.max ?? '?'}</td>
          <td>{p.defaultValue ?? '—'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<h2>source</h2>
<p>
  <a href={mod.sourceUrl} rel="noopener">{mod.file}</a> on GitHub.
</p>

<style>
  .back-nav {
    margin: 0.5rem 0 1.2rem;
    font-size: 0.86em;
  }
  .back-nav a { color: var(--docs-fg-dim); text-decoration: none; }
  .back-nav a:hover { color: var(--docs-accent); }
  .hero .sub { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
</style>
