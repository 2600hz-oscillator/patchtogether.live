<script lang="ts">
  import type { ManifestModule } from '$lib/docs/modules-manifest';
  import IoDiagram from '$lib/docs/IoDiagram.svelte';

  let { data } = $props();
  let manifest = $derived(data.manifest);

  const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];
  let byCat = $derived.by(() => {
    const out: Record<string, ManifestModule[]> = {};
    for (const m of manifest.modules) {
      (out[m.category] ??= []).push(m);
    }
    return out;
  });
  let cats = $derived(
    CAT_ORDER.filter((c) => byCat[c]).concat(
      Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)),
    ),
  );
</script>

<svelte:head>
  <title>module catalog — patchtogether.live docs</title>
  <meta name="description" content="Audio module catalog generated from the registry." />
</svelte:head>

<section class="hero">
  <h1>module catalog</h1>
  <div class="sub">{manifest.moduleCount} audio modules · generated from <code>module-registry.ts</code> at build time</div>
</section>

<p>
  Cards below are auto-generated from each module's <code>AudioModuleDef</code>. I/O diagrams,
  port lists, and param tables are ground-truthed against the source — there is no second
  source of truth. If you change a module's ports or params, the next docs build picks it up.
</p>

<div class="cat-list">
  {#each cats as c (c)}
    <a href="#{c}">{c} ({byCat[c].length})</a>
  {/each}
</div>

{#each cats as c (c)}
  <section class="cat-section" id={c}>
    <h2>{c}</h2>
    <div class="module-grid">
      {#each byCat[c] as m (m.type)}
        <article class="mod-card">
          <div class="head">
            <a class="name" href="/docs/modules/{m.type}">{m.label}</a>
            <span class="cat">
              {#if m.maxInstances === 1}<span class="tag singleton">singleton</span>{/if}
              {' '}{m.category}
            </span>
          </div>
          <p class="desc">{m.description}</p>
          <IoDiagram mod={m} />
          <a class="source-link" href="/docs/modules/{m.type}">details →</a>
        </article>
      {/each}
    </div>
  </section>
{/each}

<style>
  .cat-list {
    display: flex;
    gap: 1.2rem;
    flex-wrap: wrap;
    margin: 0 0 1rem;
    font-size: 0.86em;
  }
  .cat-list a { color: var(--docs-fg-dim); text-decoration: none; }
  .cat-list a:hover { color: var(--docs-accent); }

  .cat-section { margin: 2rem 0; }
  .cat-section > h2 { scroll-margin-top: 80px; }

  .module-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 18px;
    margin: 1rem 0 2rem;
  }
  .mod-card {
    border: 1px solid var(--docs-border-dim);
    background: var(--docs-bg);
    padding: 16px 18px 18px;
    transition: border-color 160ms, box-shadow 160ms;
  }
  .mod-card:hover {
    border-color: var(--docs-accent);
    box-shadow: 0 0 0 1px var(--docs-accent-glow), inset 0 0 24px rgba(0, 240, 255, 0.05);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid var(--docs-border-dim);
    padding-bottom: 6px;
    margin-bottom: 10px;
  }
  .name {
    font-family: var(--docs-sans);
    color: var(--docs-accent);
    font-size: 1rem;
    letter-spacing: 0.02em;
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }
  .name:hover {
    border-bottom-color: var(--docs-accent);
    text-shadow: 0 0 6px var(--docs-accent-glow);
  }
  .cat {
    font-size: 0.72em;
    color: var(--docs-fg-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .desc {
    font-size: 0.88em;
    color: var(--docs-fg);
    margin: 0 0 10px;
  }
  .source-link {
    display: inline-block;
    margin-top: 12px;
    font-size: 0.78em;
    color: var(--docs-fg-dim);
  }
  .source-link:hover { color: var(--docs-accent); }
</style>
