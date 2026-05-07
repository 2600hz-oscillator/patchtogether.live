<script lang="ts">
  import './docs.css';
  import { page } from '$app/state';

  let { children } = $props();

  const nav = [
    { href: '/docs',          label: 'home' },
    { href: '/docs/modules',  label: 'modules' },
    { href: '/docs/testing',  label: 'testing' },
    { href: '/docs/deploy',   label: 'deploy' },
  ];

  let path = $derived(page.url.pathname.replace(/\/$/, '') || '/');
</script>

<svelte:head>
  <title>patchtogether.live · docs</title>
</svelte:head>

<div class="docs-shell">
  <header class="docs-topbar">
    <div class="docs-brand"><a href="/docs">patchtogether.live</a></div>
    <nav>
      {#each nav as n}
        <a href={n.href} class:active={n.href === path || (n.href !== '/docs' && path.startsWith(n.href))}>{n.label}</a>
      {/each}
      <a class="back-to-app" href="/" data-testid="docs-back-to-app">app -&gt;</a>
    </nav>
  </header>

  <main class="docs-main">
    {@render children()}
  </main>

  <footer class="docs-footer">
    Generated from <code>packages/web/src/lib/audio/modules/*.ts</code> ·
    <a href="https://github.com/2600hz-oscillator/patchtogether.live" rel="noopener">repo</a>
  </footer>
</div>
