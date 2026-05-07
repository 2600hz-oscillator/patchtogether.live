<script lang="ts">
  // /docs section layout — Tron-themed shell shared by every docs page.
  //
  // Token choice: scoped to this subtree via :global() rules under :where(.docs-shell)
  // so we don't collide with the app's main canvas palette. The accent / accent-glow
  // hex values match docs/src/styles/global.css from the retired Astro build, and
  // are intentionally aligned with the in-app Tron tokens being introduced in
  // PR #41 (--accent: #00f0ff). Once #41 lands, the app and docs share visual DNA.
  //
  // Header text: spaced-out wordmark uses CSS letter-spacing rather than literal
  // spaces in the text content, so screen readers + page titles + URL referrers
  // still see "patchtogether.live".
  import { page } from '$app/state';

  let { children } = $props();

  const nav = [
    { href: '/docs',          label: 'home' },
    { href: '/docs/modules',  label: 'modules' },
    { href: '/docs/testing',  label: 'testing' },
    { href: '/docs/deploy',   label: 'deploy' },
  ];
  let path = $derived(page.url.pathname.replace(/\/$/, '') || '/docs');
</script>

<div class="docs-shell">
  <div class="docs-page">
    <header class="docs-topbar">
      <a class="brand" href="/docs" aria-label="patchtogether.live docs home">
        <span class="brand-spaced">patchtogether.live</span>
      </a>
      <nav>
        {#each nav as n (n.href)}
          {@const active = path === n.href || path.startsWith(n.href + '/')}
          <a href={n.href} class:active>{n.label}</a>
        {/each}
        <a href="/" class="back-app">← app</a>
      </nav>
    </header>

    <main>
      {@render children()}
    </main>

    <footer class="docs-footer">
      Generated from <code>packages/web/src/lib/audio/module-registry.ts</code> ·
      <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a>
    </footer>
  </div>
</div>

<style>
  .docs-shell {
    --docs-bg: #000;
    --docs-bg-soft: #0a0a0f;
    --docs-fg: #c8d4dc;
    --docs-fg-dim: #6e7a82;
    --docs-accent: #00f0ff;
    --docs-accent-dim: #006e7a;
    --docs-accent-glow: rgba(0, 240, 255, 0.45);
    --docs-border-dim: #062b32;
    --docs-grid: rgba(0, 240, 255, 0.04);
    --docs-mono: 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
    --docs-sans: 'Inter', system-ui, sans-serif;

    position: fixed;
    inset: 0;
    overflow: auto;
    background:
      radial-gradient(ellipse at top right, rgba(0,240,255,0.04), transparent 50%),
      linear-gradient(transparent 95%, var(--docs-grid) 95%) 0 0 / 24px 24px,
      linear-gradient(90deg, transparent 95%, var(--docs-grid) 95%) 0 0 / 24px 24px,
      var(--docs-bg);
    color: var(--docs-fg);
    font-family: var(--docs-mono);
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .docs-page {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px 60px;
  }
  .docs-shell :global(*) { box-sizing: border-box; }

  .docs-topbar {
    border-bottom: 1px solid var(--docs-border-dim);
    padding: 18px 0 14px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 28px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .brand {
    font-family: var(--docs-sans);
    font-weight: 500;
    font-size: 1rem;
    color: var(--docs-accent);
    text-shadow: 0 0 8px var(--docs-accent-glow);
    text-decoration: none;
  }
  .brand-spaced {
    letter-spacing: 0.18em;
  }
  nav {
    display: flex;
    gap: 1.4rem;
    font-size: 0.86rem;
    flex-wrap: wrap;
  }
  nav a {
    color: var(--docs-fg-dim);
    text-decoration: none;
    transition: color 120ms;
  }
  nav a:hover,
  nav a.active {
    color: var(--docs-accent);
    text-shadow: 0 0 6px var(--docs-accent-glow);
  }
  nav a.back-app {
    margin-left: auto;
    border-left: 1px solid var(--docs-border-dim);
    padding-left: 1.2rem;
  }

  .docs-footer {
    border-top: 1px solid var(--docs-border-dim);
    margin-top: 60px;
    padding: 20px 0 60px;
    font-size: 0.8em;
    color: var(--docs-fg-dim);
  }

  /* Apply common docs typography to children via :global */
  .docs-shell :global(h1),
  .docs-shell :global(h2),
  .docs-shell :global(h3),
  .docs-shell :global(h4) {
    font-family: var(--docs-sans);
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--docs-fg);
  }
  .docs-shell :global(h1) { font-size: 1.75rem; margin: 0 0 1rem; }
  .docs-shell :global(h2) {
    font-size: 1.25rem;
    margin: 2.5rem 0 0.75rem;
    color: var(--docs-accent);
    border-bottom: 1px solid var(--docs-border-dim);
    padding-bottom: 0.4rem;
  }
  .docs-shell :global(h3) { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: var(--docs-fg); }
  .docs-shell :global(p) { margin: 0.6rem 0; max-width: 64ch; }
  .docs-shell :global(ul),
  .docs-shell :global(ol) { padding-left: 1.4rem; max-width: 64ch; }
  .docs-shell :global(li) { margin: 0.2rem 0; }
  .docs-shell :global(a) {
    color: var(--docs-accent);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: border-color 120ms;
  }
  .docs-shell :global(a:hover) {
    border-bottom-color: var(--docs-accent);
    text-shadow: 0 0 6px var(--docs-accent-glow);
  }
  .docs-shell :global(code),
  .docs-shell :global(pre) {
    font-family: var(--docs-mono);
    background: var(--docs-bg-soft);
    border: 1px solid var(--docs-border-dim);
  }
  .docs-shell :global(code) { padding: 1px 5px; font-size: 0.9em; }
  .docs-shell :global(pre) { padding: 0.75rem 1rem; overflow-x: auto; line-height: 1.45; }
  .docs-shell :global(pre code) { border: 0; padding: 0; background: transparent; }
  .docs-shell :global(hr) {
    border: 0;
    border-top: 1px solid var(--docs-border-dim);
    margin: 2rem 0;
  }
  .docs-shell :global(table) {
    border-collapse: collapse;
    margin: 1rem 0;
    font-size: 0.92em;
  }
  .docs-shell :global(th),
  .docs-shell :global(td) {
    text-align: left;
    padding: 6px 12px;
    border: 1px solid var(--docs-border-dim);
  }
  .docs-shell :global(th) { color: var(--docs-accent); font-weight: 500; }
  .docs-shell :global(.hero) {
    border: 1px solid var(--docs-border-dim);
    padding: 28px 32px;
    margin-bottom: 36px;
    position: relative;
  }
  .docs-shell :global(.hero::before) {
    content: '';
    position: absolute;
    top: -1px; left: -1px;
    width: 12px; height: 12px;
    border-top: 1px solid var(--docs-accent);
    border-left: 1px solid var(--docs-accent);
  }
  .docs-shell :global(.hero::after) {
    content: '';
    position: absolute;
    bottom: -1px; right: -1px;
    width: 12px; height: 12px;
    border-bottom: 1px solid var(--docs-accent);
    border-right: 1px solid var(--docs-accent);
  }
  .docs-shell :global(.hero h1) {
    color: var(--docs-accent);
    text-shadow: 0 0 12px var(--docs-accent-glow);
    margin: 0 0 0.4rem;
  }
  .docs-shell :global(.hero .sub) { font-size: 0.92em; color: var(--docs-fg-dim); }
  .docs-shell :global(.banner) {
    border: 1px dashed var(--docs-border-dim);
    padding: 12px 16px;
    margin: 1.5rem 0;
    font-size: 0.88em;
    color: var(--docs-fg-dim);
  }
  .docs-shell :global(.tag) {
    display: inline-block;
    border: 1px solid var(--docs-border-dim);
    color: var(--docs-fg-dim);
    padding: 1px 8px;
    font-size: 0.72em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .docs-shell :global(.tag.singleton) {
    color: var(--docs-accent);
    border-color: var(--docs-accent-dim);
  }
</style>
