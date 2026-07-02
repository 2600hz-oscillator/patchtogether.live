<script lang="ts">
  // Docs layout. Lives outside the canvas / rackspace UI; carries its own
  // Tron / electric-blue palette so the docs site reads as a sibling product
  // rather than a marketing tab attached to the app. Pages under /docs/* are
  // statically prerendered; nothing in this layout needs auth or a db query.

  import { page } from '$app/state';

  // The docs "house" styling (black / electric-blue / white Tron palette) now
  // lives in a shared global stylesheet so any route can adopt it by wrapping
  // its content in a `.docs-root` element. Every rule is `.docs-root`-scoped, so
  // importing it here is behavior-identical to the former inline <style> block.
  // See .myrobots/plans/landing-page-ux-overhaul-2026-07-01.md (Phase 0).
  import '$lib/styles/house.css';

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
      Generated from <code>packages/web/src/lib/&lbrace;audio,video&rbrace;/module-registry.ts</code> ·
      <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a>
    </footer>
  </div>
</div>
