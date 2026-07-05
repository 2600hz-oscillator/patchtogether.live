<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import IoDiagram from '$lib/docs/IoDiagram.svelte';
  import DocHoverPane from '$lib/docs/interactive/DocHoverPane.svelte';
  import type VirtualModuleComponent from '$lib/docs/interactive/VirtualModule.svelte';
  import type { DocHoverState } from '$lib/docs/interactive/use-doc-hover.svelte';

  let { data } = $props();
  const mod = $derived(data.mod);

  // ---- Interactive virtual module (the redesign's PRIMARY view) ----
  //
  // The live card touches `window`/xyflow on mount, so it must NEVER run during
  // SSR/prerender. We gate it behind onMount AND the per-module allowlist
  // (data.interactive); until it mounts (and for non-prototype modules) the LEFT
  // column shows the static numbered face / IoDiagram fallback, which is exactly
  // what the prerendered (no-JS) HTML carries. The RIGHT pane's authored text is
  // SSR-rendered too (DocHoverPane is pure presentational), so the doc is fully
  // readable without JS.
  let mounted = $state(false);
  let VirtualModule = $state<typeof VirtualModuleComponent | null>(null);

  // Shared hover state between the live card's hover action + the pane.
  let hoverState = $state<DocHoverState>({ hovered: null });
  const docIndex = $derived(data.docIndex);

  // Show the live card only when: in the browser, mounted, allowlisted, and the
  // card module finished loading.
  let showLive = $derived(browser && mounted && data.interactive && !!VirtualModule);

  onMount(() => {
    if (!data.interactive) return;
    // Dynamic import keeps VirtualModule (xyflow + cards) out of the prerender
    // server bundle entirely.
    import('$lib/docs/interactive/VirtualModule.svelte').then((m) => {
      VirtualModule = m.default;
      mounted = true;
    });
  });

  /** Friendly display name for a `docs.controls` key: a real param uses its
   *  ParamDef label; a control-family template (`foo-{n}`) or any other key is
   *  humanized (dashes/underscores → spaces, Title-cased). Keeps the controls
   *  table readable — no raw `seq-gate-{n}` keys on the page. */
  function controlName(key: string): string {
    const param = mod.params.find((p) => p.id === key);
    if (param) return param.label;
    const pretty = key
      .replace(/-\{n\}$/, ' {n}')
      .replace(/[-_]/g, ' ')
      .trim();
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }
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
  </div>
</section>

<p>{mod.description}</p>

{#if mod.docs?.explanation}
  <p class="authored-explanation" data-testid="docs-explanation">{mod.docs.explanation}</p>
{/if}

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

<!-- THE CARD — 2-column interactive view (the redesign): LEFT a live, hoverable
     virtual module (the PRIMARY view), RIGHT a pane that explains whatever
     faceplate control / patch port you hover. The static numbered face is the
     no-JS / prerender / not-yet-promoted FALLBACK shown on the left until the
     live card mounts (or for modules not on the interactive allowlist). -->
<h2>the faceplate</h2>
<div class="card-explore" data-testid="card-explore" class:has-live={showLive}>
  <div class="card-explore-left">
    {#if showLive && VirtualModule}
      {@const VM = VirtualModule}
      <VM type={mod.type} {docIndex} {hoverState} def={data.defLite} />
    {:else if data.face}
      <!-- FALLBACK: numbered screenshot of the real rendered card + its KEY. -->
      <div class="face-wrap" data-testid="module-face">
        <img
          class="face-img"
          src={data.face.src}
          alt={`Numbered control face for ${mod.label}`}
          loading="lazy"
        />
        {#if data.face.controls.length > 0}
          <table class="face-key" data-testid="module-face-key">
            <thead>
              <tr><th>#</th><th>control</th><th>what it does</th></tr>
            </thead>
            <tbody>
              {#each data.face.controls as c (c.n)}
                <tr>
                  <td class="key-n">{c.n}</td>
                  <td class="ctrl-name">{c.name}</td>
                  <td>{c.desc ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {:else}
      <!-- FALLBACK: no numbered face generated yet → the abstract pin diagram. -->
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
    {/if}
  </div>
  <!-- RIGHT pane: SSR-rendered (pure presentational) so the prerendered HTML
       carries the authored explanation with NO JS, then live-updates on hover. -->
  <div class="card-explore-right">
    <DocHoverPane hovered={hoverState.hovered} docIndex={data.docIndex} />
  </div>
</div>

<!-- INPUTS & OUTPUTS — AUTO-GENERATED from the enriched module def via
     io-explain (docs-overhaul §3c). The `explain` column is the single source
     of truth; it cannot drift from the def (the drift gate fails CI if any
     port lacks an explanation). -->
{#if mod.io.inputs.length > 0}
  <h2>inputs</h2>
  <table data-testid="io-inputs">
    <thead>
      <tr><th>id</th><th>cable</th><th>what it does</th></tr>
    </thead>
    <tbody>
      {#each mod.io.inputs as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.type}</td>
          <td>
            {#if mod.docs?.inputs?.[p.id]}
              {mod.docs.inputs[p.id]}
              <div class="io-explain">{p.explain}</div>
            {:else}{p.explain}{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if mod.io.outputs.length > 0}
  <h2>outputs</h2>
  <table data-testid="io-outputs">
    <thead>
      <tr><th>id</th><th>cable</th><th>what it does</th></tr>
    </thead>
    <tbody>
      {#each mod.io.outputs as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.type}</td>
          <td>
            {#if mod.docs?.outputs?.[p.id]}
              {mod.docs.outputs[p.id]}
              <div class="io-explain">{p.explain}</div>
            {:else}{p.explain}{/if}
          </td>
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

{#if !data.face && mod.docs?.controls && Object.keys(mod.docs.controls).length > 0}
  <!-- No numbered face for this module → list the authored controls directly
       (the numbered KEY above subsumes this when a face exists). -->
  <h2>controls</h2>
  <table data-testid="docs-controls">
    <thead>
      <tr><th>control</th><th>what it does</th></tr>
    </thead>
    <tbody>
      {#each Object.entries(mod.docs.controls) as [k, desc] (k)}
        <tr>
          <td class="ctrl-name">{controlName(k)}</td>
          <td>{desc}</td>
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
  .authored-explanation {
    font-size: 1.02em;
    line-height: 1.55;
  }
  /* 2-column interactive explorer: live/static card LEFT, hover pane RIGHT. */
  .card-explore {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(240px, 1fr);
    gap: 1.25rem;
    align-items: start;
    margin: 1rem 0 1.5rem;
  }
  .card-explore-left {
    min-width: 0;
  }
  /* On narrow viewports stack the pane below the card. */
  @media (max-width: 760px) {
    .card-explore {
      grid-template-columns: 1fr;
    }
  }
  .io-explain {
    color: var(--doc-fg-dim, #6e7a82);
    font-size: 0.82em;
    margin-top: 2px;
  }
  .diagram-wrap {
    margin: 1.5rem 0;
  }
  .face-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    align-items: flex-start;
    margin: 1rem 0 1.5rem;
  }
  .face-img {
    max-width: min(100%, 480px);
    height: auto;
    border: 1px solid var(--doc-border-dim, #062b32);
    border-radius: 6px;
    background: #0a0a0a;
  }
  .ctrl-name {
    font-weight: 600;
    white-space: nowrap;
  }
  .face-key {
    flex: 1;
    min-width: 260px;
    margin: 0;
  }
  .face-key .key-n {
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--doc-accent, #2bb6c8);
    font-weight: 700;
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
