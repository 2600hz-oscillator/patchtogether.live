<script lang="ts">
  // Docs layout. Lives outside the canvas / rackspace UI; carries its own
  // Tron / electric-blue palette so the docs site reads as a sibling product
  // rather than a marketing tab attached to the app. Pages under /docs/* are
  // statically prerendered; nothing in this layout needs auth or a db query.

  import { page } from '$app/state';

  const nav = [
    { href: '/docs', label: 'home' },
    { href: '/docs/modules', label: 'modules' },
    { href: '/docs/rackspace-persistence', label: 'persistence' },
    { href: '/docs/testing', label: 'testing' },
    { href: '/docs/deploy', label: 'deploy' },
  ];

  let path = $derived(page.url.pathname.replace(/\/$/, '') || '/docs');

  let { children } = $props();
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
</svelte:head>

<div class="docs-root">
  <div class="shell">
    <header class="topbar">
      <div class="brand"><a href="/docs">patchtogether.live</a></div>
      <nav>
        {#each nav as n (n.href)}
          {@const active = (n.href.replace(/\/$/, '') || '/docs') === path
            || (n.href !== '/docs' && path.startsWith(n.href))}
          <a href={n.href} class:active>{n.label}</a>
        {/each}
        <a class="back" href="/">launch app -&gt;</a>
      </nav>
    </header>

    <main>
      {@render children()}
    </main>

    <footer class="footer">
      Generated from packages/web/src/lib/{audio,video}/module-registry.ts ·
      <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a>
    </footer>
  </div>
</div>

<style>
  /* Tron palette — scoped under .docs-root so it doesn't bleed into the
   * canvas's native palette (--bg etc. defined in routes/global.css). When
   * PR #41's app-wide --accent token lands we can revisit and unify. */
  .docs-root {
    --doc-bg: #000;
    --doc-bg-soft: #0a0a0f;
    --doc-fg: #c8d4dc;
    --doc-fg-dim: #6e7a82;
    --doc-accent: #00f0ff;
    --doc-accent-dim: #006e7a;
    --doc-accent-glow: rgba(0, 240, 255, 0.45);
    --doc-border: #00f0ff;
    --doc-border-dim: #062b32;
    --doc-grid: rgba(0, 240, 255, 0.04);

    --doc-mono: 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
    --doc-sans: 'Inter', system-ui, sans-serif;

    position: fixed;
    inset: 0;
    overflow: auto;
    background:
      radial-gradient(ellipse at top right, rgba(0, 240, 255, 0.04), transparent 50%),
      linear-gradient(transparent 95%, var(--doc-grid) 95%) 0 0 / 24px 24px,
      linear-gradient(90deg, transparent 95%, var(--doc-grid) 95%) 0 0 / 24px 24px,
      var(--doc-bg);
    color: var(--doc-fg);
    font-family: var(--doc-mono);
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .docs-root :global(*) {
    box-sizing: border-box;
  }

  .shell {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px 60px;
  }

  .topbar {
    border-bottom: 1px solid var(--doc-border-dim);
    padding: 18px 0 14px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 28px;
    gap: 1.4rem;
    flex-wrap: wrap;
  }
  .brand {
    font-family: var(--doc-sans);
    font-weight: 500;
    font-size: 1rem;
    letter-spacing: 0.04em;
  }
  .brand a {
    color: var(--doc-accent);
    text-shadow: 0 0 8px var(--doc-accent-glow);
    text-decoration: none;
    border: 0;
  }
  nav {
    display: flex;
    gap: 1.4rem;
    font-size: 0.86rem;
    align-items: baseline;
  }
  nav a {
    color: var(--doc-fg-dim);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: color 120ms, border-color 120ms;
  }
  nav a:hover,
  nav a.active {
    color: var(--doc-accent);
    text-shadow: 0 0 6px var(--doc-accent-glow);
  }
  nav a.back {
    margin-left: 1rem;
    border-left: 1px solid var(--doc-border-dim);
    padding-left: 1.4rem;
  }

  main {
    min-height: 60vh;
  }

  .footer {
    border-top: 1px solid var(--doc-border-dim);
    margin-top: 60px;
    padding: 20px 0 0;
    font-size: 0.8em;
    color: var(--doc-fg-dim);
  }
  .footer :global(a) {
    color: var(--doc-accent);
    text-decoration: none;
  }

  /* The :global block applies to anything rendered inside this layout's
   * <main>, i.e. every /docs/* +page.svelte. Keeps individual pages clean. */
  .docs-root :global(a) {
    color: var(--doc-accent);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: border-color 120ms;
  }
  .docs-root :global(a:hover) {
    border-bottom-color: var(--doc-accent);
    text-shadow: 0 0 6px var(--doc-accent-glow);
  }
  .docs-root :global(h1),
  .docs-root :global(h2),
  .docs-root :global(h3),
  .docs-root :global(h4) {
    font-family: var(--doc-sans);
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--doc-fg);
  }
  .docs-root :global(h1) {
    font-size: 1.75rem;
    margin: 0 0 1rem;
  }
  .docs-root :global(h2) {
    font-size: 1.25rem;
    margin: 2.5rem 0 0.75rem;
    color: var(--doc-accent);
    border-bottom: 1px solid var(--doc-border-dim);
    padding-bottom: 0.4rem;
  }
  .docs-root :global(h3) {
    font-size: 1rem;
    margin: 1.5rem 0 0.5rem;
  }
  .docs-root :global(h4) {
    font-size: 0.86rem;
    margin: 1.2rem 0 0.4rem;
  }
  .docs-root :global(p) {
    margin: 0.6rem 0;
    max-width: 64ch;
  }
  .docs-root :global(ul),
  .docs-root :global(ol) {
    padding-left: 1.4rem;
    max-width: 64ch;
  }
  .docs-root :global(li) {
    margin: 0.2rem 0;
  }
  .docs-root :global(code),
  .docs-root :global(pre) {
    font-family: var(--doc-mono);
    background: var(--doc-bg-soft);
    border: 1px solid var(--doc-border-dim);
  }
  .docs-root :global(code) {
    padding: 1px 5px;
    font-size: 0.9em;
  }
  .docs-root :global(pre) {
    padding: 0.75rem 1rem;
    overflow-x: auto;
    line-height: 1.45;
  }
  .docs-root :global(pre code) {
    border: 0;
    padding: 0;
    background: transparent;
  }
  .docs-root :global(table) {
    border-collapse: collapse;
    margin: 1rem 0;
    font-size: 0.92em;
  }
  .docs-root :global(th),
  .docs-root :global(td) {
    text-align: left;
    padding: 6px 12px;
    border: 1px solid var(--doc-border-dim);
  }
  .docs-root :global(th) {
    color: var(--doc-accent);
    font-weight: 500;
  }

  /* Hero block — corner brackets framing the page title. */
  .docs-root :global(.hero) {
    border: 1px solid var(--doc-border-dim);
    padding: 28px 32px;
    margin-bottom: 36px;
    position: relative;
  }
  .docs-root :global(.hero::before) {
    content: '';
    position: absolute;
    top: -1px;
    left: -1px;
    width: 12px;
    height: 12px;
    border-top: 1px solid var(--doc-accent);
    border-left: 1px solid var(--doc-accent);
  }
  .docs-root :global(.hero::after) {
    content: '';
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 12px;
    height: 12px;
    border-bottom: 1px solid var(--doc-accent);
    border-right: 1px solid var(--doc-accent);
  }
  .docs-root :global(.hero h1) {
    color: var(--doc-accent);
    text-shadow: 0 0 12px var(--doc-accent-glow);
    margin: 0 0 0.4rem;
  }
  .docs-root :global(.hero .sub) {
    font-size: 0.92em;
    color: var(--doc-fg-dim);
  }

  .docs-root :global(.banner) {
    border: 1px dashed var(--doc-border-dim);
    padding: 12px 16px;
    margin: 1.5rem 0;
    font-size: 0.88em;
    color: var(--doc-fg-dim);
  }

  .docs-root :global(.tag) {
    display: inline-block;
    border: 1px solid var(--doc-border-dim);
    color: var(--doc-fg-dim);
    padding: 1px 8px;
    font-size: 0.72em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .docs-root :global(.tag.singleton) {
    color: var(--doc-accent);
    border-color: var(--doc-accent-dim);
  }

  /* Module catalog grid */
  .docs-root :global(.module-grid) {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 18px;
    margin: 1rem 0 2rem;
  }
  .docs-root :global(.mod-card) {
    border: 1px solid var(--doc-border-dim);
    background: var(--doc-bg);
    padding: 16px 18px 18px;
    transition: border-color 160ms, box-shadow 160ms;
  }
  .docs-root :global(.mod-card:hover) {
    border-color: var(--doc-accent);
    box-shadow: 0 0 0 1px var(--doc-accent-glow), inset 0 0 24px rgba(0, 240, 255, 0.05);
  }
  .docs-root :global(.mod-card .head) {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid var(--doc-border-dim);
    padding-bottom: 6px;
    margin-bottom: 10px;
  }
  .docs-root :global(.mod-card .name) {
    font-family: var(--doc-sans);
    color: var(--doc-accent);
    font-size: 1rem;
    letter-spacing: 0.02em;
  }
  .docs-root :global(.mod-card .name a) {
    color: inherit;
  }
  .docs-root :global(.mod-card .cat) {
    font-size: 0.72em;
    color: var(--doc-fg-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .docs-root :global(.mod-card .desc) {
    font-size: 0.88em;
    color: var(--doc-fg);
    margin: 0 0 10px;
  }
  .docs-root :global(.mod-card .ports) {
    font-size: 0.78em;
  }
  .docs-root :global(.mod-card .ports h4) {
    font-family: var(--doc-mono);
    font-size: 0.72em;
    font-weight: 600;
    color: var(--doc-accent-dim);
    margin: 8px 0 4px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .docs-root :global(.mod-card .ports table) {
    width: 100%;
    margin: 0;
  }
  .docs-root :global(.mod-card .ports td) {
    padding: 3px 6px;
    font-size: 0.92em;
  }
  .docs-root :global(.mod-card .ports td:first-child) {
    color: var(--doc-accent);
    white-space: nowrap;
    width: 1%;
  }
  .docs-root :global(.mod-card .ports td:nth-child(2)) {
    color: var(--doc-fg-dim);
    white-space: nowrap;
    width: 1%;
  }
  .docs-root :global(.mod-card .ports td:nth-child(3)) {
    color: var(--doc-fg);
  }
  .docs-root :global(.mod-card .source-link) {
    display: inline-block;
    margin-top: 12px;
    font-size: 0.78em;
    color: var(--doc-fg-dim);
  }
  .docs-root :global(.mod-card .source-link:hover) {
    color: var(--doc-accent);
  }

  /* SVG diagram colors. Inline <svg> uses these as plain CSS classes. */
  .docs-root :global(.io-svg) {
    width: 100%;
    height: auto;
    display: block;
    margin: 4px 0 10px;
    background: var(--doc-bg-soft);
    border: 1px solid var(--doc-border-dim);
  }
  .docs-root :global(.io-svg .box) {
    fill: none;
    stroke: var(--doc-accent);
    stroke-width: 1;
  }
  .docs-root :global(.io-svg .label-name) {
    fill: var(--doc-accent);
    font-family: var(--doc-mono);
    font-size: 9px;
  }
  .docs-root :global(.io-svg .label-type) {
    fill: var(--doc-fg-dim);
    font-family: var(--doc-mono);
    font-size: 8px;
  }
  .docs-root :global(.io-svg .header-text) {
    fill: var(--doc-fg);
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 500;
  }
  .docs-root :global(.io-svg .legend-text) {
    fill: var(--doc-fg-dim);
    font-family: var(--doc-mono);
    font-size: 8px;
  }
  .docs-root :global(.io-svg .pin-audio) {
    stroke: var(--doc-accent);
    fill: var(--doc-accent);
  }
  .docs-root :global(.io-svg .pin-cv) {
    stroke: #ff8a00;
    fill: #ff8a00;
  }
  .docs-root :global(.io-svg .pin-gate) {
    stroke: #ff3df0;
    fill: #ff3df0;
  }
  .docs-root :global(.io-svg .pin-pitch) {
    stroke: #6effd6;
    fill: #6effd6;
  }
  .docs-root :global(.io-svg .pin-polyPitchGate) {
    stroke: #a78bfa;
    fill: #a78bfa;
  }

  .docs-root :global(.cat-list) {
    display: flex;
    gap: 1.2rem;
    flex-wrap: wrap;
    margin: 0 0 1rem;
    font-size: 0.86em;
  }
  .docs-root :global(.cat-list a) {
    color: var(--doc-fg-dim);
  }
  .docs-root :global(.cat-list a:hover) {
    color: var(--doc-accent);
  }
  .docs-root :global(section.cat-section) {
    margin: 2rem 0;
  }
  .docs-root :global(section.cat-section > h2) {
    scroll-margin-top: 80px;
  }
</style>
