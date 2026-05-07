<script lang="ts">
  import IoDiagram from '$lib/docs/IoDiagram.svelte';
  import type { ManifestModule } from '$lib/docs/module-manifest';

  let { data } = $props();
  const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];

  const manifest = $derived(data.manifest);
  const byCat = $derived.by(() => {
    const out: Record<string, ManifestModule[]> = {};
    for (const m of manifest.modules) {
      (out[m.category] ??= []).push(m);
    }
    return out;
  });
  const cats = $derived(
    CAT_ORDER.filter((c) => byCat[c]).concat(
      Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)),
    ),
  );
</script>

<svelte:head>
  <title>modules · patchtogether.live</title>
  <meta name="description" content="Audio module catalog generated from the registry." />
</svelte:head>

<section class="hero">
  <h1>module catalog</h1>
  <div class="sub">
    {manifest.moduleCount} audio modules · generated from <code>module-registry.ts</code> at build
    time
  </div>
</section>

<p>
  Cards below are auto-generated from each module's <code>AudioModuleDef</code>. I/O diagrams,
  port lists, and param tables are ground-truthed against the source — there is no second source
  of truth. If you change a module's ports or params, the next docs build picks it up.
</p>

<div class="cat-list" data-testid="cat-list">
  {#each cats as c (c)}
    <a href="#{c}">{c} ({byCat[c].length})</a>
  {/each}
</div>

{#each cats as c (c)}
  <section class="cat-section" id={c}>
    <h2>{c}</h2>
    <div class="module-grid" data-testid="module-grid">
      {#each byCat[c] as m (m.type)}
        <article class="mod-card" data-module-type={m.type}>
          <div class="head">
            <span class="name">
              <a href="/docs/modules/{m.type}">{m.label}</a>
            </span>
            <span class="cat">
              {#if m.maxInstances === 1}<span class="tag singleton">singleton</span>{' '}{/if}
              {m.category}
            </span>
          </div>
          <p class="desc">{m.description}</p>
          <IoDiagram mod={m} />
          <div class="ports">
            {#if m.inputs.length > 0}
              <h4>inputs</h4>
              <table>
                <tbody>
                  {#each m.inputs as p (p.id)}
                    <tr>
                      <td>{p.id}</td>
                      <td>{p.type}</td>
                      <td>{p.note ?? ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if m.outputs.length > 0}
              <h4>outputs</h4>
              <table>
                <tbody>
                  {#each m.outputs as p (p.id)}
                    <tr>
                      <td>{p.id}</td>
                      <td>{p.type}</td>
                      <td>{p.note ?? ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if m.params.length > 0}
              <h4>params</h4>
              <table>
                <tbody>
                  {#each m.params as p (p.id)}
                    <tr>
                      <td>{p.id}</td>
                      <td>{p.units ?? p.curve}</td>
                      <td>
                        {p.min ?? '?'}..{p.max ?? '?'}{#if p.defaultValue !== null}
                          (default {p.defaultValue}){/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
          <a class="source-link" href={m.sourceUrl} rel="noopener">source · {m.file}</a>
        </article>
      {/each}
    </div>
  </section>
{/each}
