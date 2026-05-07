<script lang="ts">
  import IoDiagram from '$lib/docs/IoDiagram.svelte';
  import type { ManifestModule } from '$lib/docs/types';

  let { data } = $props();

  const byCat: Record<string, ManifestModule[]> = {};
  for (const m of data.manifest.modules) {
    (byCat[m.category] ??= []).push(m as ManifestModule);
  }
  const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];
  const cats = CAT_ORDER.filter((c) => byCat[c]).concat(
    Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)),
  );
</script>

<svelte:head>
  <title>modules · patchtogether.live</title>
  <meta name="description" content="Audio module catalog generated from the registry." />
</svelte:head>

<section class="docs-hero">
  <h1>module catalog</h1>
  <div class="docs-sub">{data.manifest.moduleCount} audio modules · generated from <code>module-registry.ts</code> at build time</div>
</section>

<p>
  Cards below are auto-generated from each module&apos;s <code>AudioModuleDef</code>. I/O diagrams,
  port lists, and param tables are ground-truthed against the source &mdash; there is no second
  source of truth. If you change a module&apos;s ports or params, the next docs build picks it up.
</p>

<div class="docs-cat-list">
  {#each cats as c}
    <a href="#{c}">{c} ({byCat[c].length})</a>
  {/each}
</div>

{#each cats as c}
  <section class="docs-cat-section" id={c}>
    <h2>{c}</h2>
    <div class="docs-mod-grid">
      {#each byCat[c] as m (m.type)}
        <article class="docs-mod-card" data-testid="docs-mod-card" data-module-type={m.type}>
          <div class="docs-card-head">
            <span class="docs-mod-name">
              <a href="/docs/modules/{m.type}">{m.label}</a>
            </span>
            <span class="docs-mod-cat">
              {#if m.maxInstances === 1}
                <span class="docs-tag singleton">singleton</span>{' '}
              {/if}
              {m.category}
            </span>
          </div>
          <p class="docs-mod-desc">{m.description}</p>
          <IoDiagram mod={m} />
          <div class="docs-mod-ports">
            {#if m.inputs.length > 0}
              <h4>inputs</h4>
              <table>
                <tbody>
                  {#each m.inputs as p}
                    <tr><td>{p.id}</td><td>{p.type}</td><td>{p.note ?? ''}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if m.outputs.length > 0}
              <h4>outputs</h4>
              <table>
                <tbody>
                  {#each m.outputs as p}
                    <tr><td>{p.id}</td><td>{p.type}</td><td>{p.note ?? ''}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if m.params.length > 0}
              <h4>params</h4>
              <table>
                <tbody>
                  {#each m.params as p}
                    <tr>
                      <td>{p.id}</td>
                      <td>{p.units ?? p.curve}</td>
                      <td>
                        {p.min ?? '?'}..{p.max ?? '?'}{p.defaultValue !== null ? ` (default ${p.defaultValue})` : ''}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
          <a class="docs-source-link" href={m.sourceUrl} rel="noopener">source · {m.file}</a>
        </article>
      {/each}
    </div>
  </section>
{/each}
