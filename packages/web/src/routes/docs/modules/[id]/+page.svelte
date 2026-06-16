<script lang="ts">
  import IoDiagram from '$lib/docs/IoDiagram.svelte';

  let { data } = $props();
  const mod = $derived(data.mod);
</script>

<svelte:head>
  <title>{mod.label} · modules · patchtogether.live</title>
  <meta name="description" content={mod.description} />
</svelte:head>

<section class="hero">
  <h1>
    {mod.label}
    {#if mod.maxInstances === 1}
      <span class="tag singleton">singleton</span>
    {/if}
  </h1>
  <div class="sub">
    <code>{mod.type}</code> · {mod.category}
    {#if mod.schemaVersion !== undefined}
      · schema v{mod.schemaVersion}
    {/if}
  </div>
</section>

<p>{mod.description}</p>

{#if data.guide}
  <a class="guide-callout" href={data.guide.href} data-testid="module-guide-link">
    <span class="guide-icon" aria-hidden="true">📖</span>
    <span class="guide-text">
      <strong>Full guide: {data.guide.title}</strong>
      <span class="guide-blurb">{data.guide.blurb}</span>
    </span>
    <span class="guide-arrow" aria-hidden="true">→</span>
  </a>
{/if}

<div class="diagram-wrap" data-testid="module-diagram">
  <IoDiagram mod={mod} />
  <div class="port-counts">
    <span data-testid="input-count">{mod.inputs.length} inputs</span>
    ·
    <span data-testid="output-count">{mod.outputs.length} outputs</span>
    ·
    <span data-testid="param-count">{mod.params.length} params</span>
  </div>
</div>

{#if mod.inputs.length > 0}
  <h2>inputs</h2>
  <table>
    <thead>
      <tr><th>id</th><th>cable</th><th>note</th></tr>
    </thead>
    <tbody>
      {#each mod.inputs as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.type}</td>
          <td>{p.note ?? ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if mod.outputs.length > 0}
  <h2>outputs</h2>
  <table>
    <thead>
      <tr><th>id</th><th>cable</th><th>note</th></tr>
    </thead>
    <tbody>
      {#each mod.outputs as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.type}</td>
          <td>{p.note ?? ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if mod.params.length > 0}
  <h2>params</h2>
  <table>
    <thead>
      <tr><th>id</th><th>label</th><th>range</th><th>default</th><th>curve</th></tr>
    </thead>
    <tbody>
      {#each mod.params as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.label}</td>
          <td>
            {p.min ?? '?'}..{p.max ?? '?'}{#if p.units}
              {p.units}{/if}
          </td>
          <td>{p.defaultValue ?? '—'}</td>
          <td>{p.curve}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<h2>source</h2>
<p>
  <a href={mod.sourceUrl} rel="noopener">{mod.file}</a> on GitHub.
</p>

<nav class="prev-next">
  {#if data.prev}
    <a href="/docs/modules/{data.prev.type}" class="prev">← {data.prev.label}</a>
  {:else}
    <span></span>
  {/if}
  <a href="/docs/modules" class="all">all modules</a>
  {#if data.next}
    <a href="/docs/modules/{data.next.type}" class="next">{data.next.label} →</a>
  {:else}
    <span></span>
  {/if}
</nav>

<style>
  .guide-callout {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    margin: 1.25rem 0;
    padding: 0.9rem 1rem;
    border: 1px solid var(--doc-accent, #2bb6c8);
    border-left-width: 4px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--doc-accent, #2bb6c8) 8%, transparent);
    text-decoration: none;
    color: inherit;
    transition: background 0.12s ease;
  }
  .guide-callout:hover {
    background: color-mix(in srgb, var(--doc-accent, #2bb6c8) 16%, transparent);
  }
  .guide-icon {
    font-size: 1.4rem;
    line-height: 1;
  }
  .guide-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .guide-blurb {
    color: var(--doc-fg-dim, #6e7a82);
    font-size: 0.86em;
  }
  .guide-arrow {
    font-size: 1.2rem;
    color: var(--doc-accent, #2bb6c8);
  }
  .diagram-wrap {
    margin: 1.5rem 0;
  }
  .port-counts {
    color: var(--doc-fg-dim, #6e7a82);
    font-size: 0.82em;
    text-align: center;
    margin-top: -4px;
  }
  .prev-next {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    margin: 3rem 0 0;
    padding-top: 1rem;
    border-top: 1px solid var(--doc-border-dim, #062b32);
    font-size: 0.86em;
  }
  .prev-next .all {
    color: var(--doc-fg-dim, #6e7a82);
  }
</style>
