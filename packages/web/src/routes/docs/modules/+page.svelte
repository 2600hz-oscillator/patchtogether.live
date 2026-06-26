<script lang="ts">
  import IoDiagram from '$lib/docs/IoDiagram.svelte';
  import type { ManifestModule } from '$lib/docs/module-manifest';
  import { GUIDE_PAGES } from '$lib/docs/module-guides';

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
  <meta name="description" content="Module catalog auto-generated from the audio + video registries." />
</svelte:head>

<section class="hero">
  <h1>module catalog</h1>
  <div class="sub">
    {manifest.moduleCount} modules · generated from
    <code>packages/web/src/lib/&lbrace;audio,video&rbrace;/modules/*.ts</code> at build time
  </div>
</section>

<p>
  Cards below are auto-generated from each module's <code>AudioModuleDef</code>,
  <code>SyncedModuleDef</code>, or <code>VideoModuleDef</code>. I/O diagrams, port lists, and
  param tables are ground-truthed against the source — there is no second source of truth. If
  you change a module's ports or params, the next docs build picks it up. Ports are coloured
  by cable type: audio (cyan), cv (orange), gate (magenta), pitch (mint), polyPitchGate
  (violet); video cables (image / mono-video / video / keys) follow the same audio-cyan tone
  for now.
</p>

<section class="guides" data-testid="guides">
  <h2 id="guides">guides &amp; hardware</h2>
  <p class="guides-intro">
    Hand-written, illustrated walkthroughs that live alongside the auto-generated
    cards above — clip-launcher hardware (monome grid, Novation Launchpad), video
    mapping, and other modules with a dedicated guide.
  </p>
  <div class="guide-grid">
    {#each GUIDE_PAGES as g (g.slug)}
      <a class="guide-card" href="/docs/modules/{g.slug}" data-testid="guide-link">
        <span class="guide-title">{g.title}</span>
        <span class="guide-blurb">{g.blurb}</span>
      </a>
    {/each}
  </div>
</section>

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

<style>
  /* Guides & hardware — the hand-written walkthrough pages (custom routes) that
     the auto-generated catalog can't list, so they aren't orphaned. */
  .guides {
    margin: 1rem 0 2rem;
  }
  .guides-intro {
    color: var(--doc-fg-dim, #6e7a82);
  }
  .guide-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    margin: 1rem 0 0;
  }
  .guide-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--doc-border-dim, #062b32);
    background: var(--doc-bg, #000);
    padding: 12px 14px;
    transition: border-color 160ms, box-shadow 160ms;
    /* override the layout's global underline-on-hover for these card links */
    border-bottom: 1px solid var(--doc-border-dim, #062b32);
  }
  .guide-card:hover {
    border-color: var(--doc-accent, #00f0ff);
    box-shadow: 0 0 0 1px var(--doc-accent-glow, rgba(0, 240, 255, 0.45));
  }
  .guide-title {
    font-family: var(--doc-sans, 'Inter', system-ui, sans-serif);
    color: var(--doc-accent, #00f0ff);
    font-size: 0.95rem;
    letter-spacing: 0.02em;
  }
  .guide-blurb {
    color: var(--doc-fg, #c8d4dc);
    font-size: 0.82em;
  }
</style>
