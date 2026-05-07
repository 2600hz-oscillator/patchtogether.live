<script lang="ts">
  import IoDiagram from '$lib/docs/IoDiagram.svelte';

  let { data } = $props();
  const m = data.mod;
</script>

<svelte:head>
  <title>{m.label} · patchtogether.live docs</title>
  <meta name="description" content={m.description} />
</svelte:head>

<nav class="docs-cat-list" aria-label="breadcrumb">
  <a href="/docs/modules">&larr; all modules</a>
</nav>

<section class="docs-hero">
  <h1>
    {m.label}
    {#if m.maxInstances === 1}
      <span class="docs-tag singleton" style="margin-left: 0.6em; vertical-align: middle;">singleton</span>
    {/if}
  </h1>
  <div class="docs-sub">{m.description}</div>
</section>

<p>
  <span class="docs-tag">type: {m.type}</span>
  &nbsp;
  <span class="docs-tag">category: {m.category}</span>
  {#if m.schemaVersion !== undefined}
    &nbsp;
    <span class="docs-tag">schema v{m.schemaVersion}</span>
  {/if}
</p>

<h2>I/O diagram</h2>
<IoDiagram mod={m} />

{#if m.inputs.length > 0}
  <h2>Inputs ({m.inputs.length})</h2>
  <table>
    <thead><tr><th>id</th><th>type</th><th>note</th></tr></thead>
    <tbody>
      {#each m.inputs as p}
        <tr><td><code>{p.id}</code></td><td>{p.type}</td><td>{p.note ?? ''}</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if m.outputs.length > 0}
  <h2>Outputs ({m.outputs.length})</h2>
  <table>
    <thead><tr><th>id</th><th>type</th><th>note</th></tr></thead>
    <tbody>
      {#each m.outputs as p}
        <tr><td><code>{p.id}</code></td><td>{p.type}</td><td>{p.note ?? ''}</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if m.params.length > 0}
  <h2>Params ({m.params.length})</h2>
  <table>
    <thead><tr><th>id</th><th>label</th><th>range</th><th>default</th><th>curve / units</th></tr></thead>
    <tbody>
      {#each m.params as p}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.label}</td>
          <td>{p.min ?? '?'} &mdash; {p.max ?? '?'}</td>
          <td>{p.defaultValue ?? '—'}</td>
          <td>{p.units ?? p.curve}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<h2>Source</h2>
<p>
  <a class="docs-source-link" href={m.sourceUrl} rel="noopener" data-testid="docs-source-link">
    {m.file} on GitHub &rarr;
  </a>
</p>
