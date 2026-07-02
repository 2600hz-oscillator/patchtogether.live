<script lang="ts">
  // The public landing / front door (the scratch canvas moved to /rack).
  //
  // Reuses the docs "house" stylesheet (black / electric-blue / white Tron
  // palette) by wrapping the content in a .docs-root element and importing
  // house.css — same decision as the docs site (see the landing-page overhaul
  // plan section 2, no new CSS lib). The only landing-specific styling is below
  // in the scoped style block: the two orb bands, the NEW RACK hero, and the
  // tile grid. Palette values come from house.css's .docs-root custom props.
  //
  // Fully STATIC (prerender=true in +page.ts): reads NO auth state, so the
  // header is a plain "sign in" link and there is nothing to glitch. Magenta
  // appears ONLY inside the #8 logo PNG — every CSS color here is
  // black/blue/white.
  import '$lib/styles/house.css';
  import { BUILD_INFO } from '$lib/build-info';

  // ART + VRT galleries are published to the repo's GitHub Pages site by
  // pages.yml (a SEPARATE deploy from the CF-Pages app). Per owner decision Q4
  // the landing LINKS to those existing absolute URLs (the native /docs/art
  // route is a later phase), so they resolve today.
  const GH_PAGES = 'https://2600hz-oscillator.github.io/patchtogether.live';
  const ART_GALLERY = GH_PAGES + '/art/';
  const VRT_GALLERY = GH_PAGES + '/vrt/';

  interface Tile {
    id: string;
    label: string;
    href: string;
    blurb: string;
    external?: boolean;
  }

  const tiles: Tile[] = [
    {
      id: 'new-rack',
      label: 'new rack',
      href: '/rack',
      blurb: 'open a fresh scratch canvas — patch modules, make sound.',
    },
    {
      id: 'rackspaces',
      label: 'my rackspaces',
      href: '/dashboard',
      blurb: 'your saved racks and shared multiplayer sessions.',
    },
    {
      id: 'modules',
      label: 'modules',
      href: '/docs/modules',
      blurb: 'the full module catalog — I/O, controls, CV routing.',
    },
    {
      id: 'art',
      label: 'art gallery',
      href: ART_GALLERY,
      blurb: 'waveform + spectrogram of every audio baseline.',
      external: true,
    },
    {
      id: 'docs',
      label: 'docs',
      href: '/docs',
      blurb: 'guides — persistence, testing, deploy, and more.',
    },
    {
      id: 'vrt',
      label: 'vrt gallery',
      href: VRT_GALLERY,
      blurb: 'reference render of every module card — the visual lookbook.',
      external: true,
    },
  ];
</script>

<svelte:head>
  <title>patchtogether.live — a browser modular synthesizer</title>
  <meta
    name="description"
    content="patchtogether.live is a collaborative modular synthesizer that runs in your browser. Patch modules, make sound, share a rack."
  />
  <!-- Above-the-fold assets: preload the header band + the logo. -->
  <link rel="preload" as="image" href="/landing/sun.png" />
  <link rel="preload" as="image" href="/landing/logo-256.png" />
</svelte:head>

<div class="docs-root landing">
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <a href="/">
          <img
            class="logo"
            src="/landing/logo-256.png"
            width="36"
            height="29"
            alt="patchtogether logo"
            decoding="async"
          />
          <span>patchtogether</span>
        </a>
      </div>
      <nav>
        <a href="/docs">docs</a>
        <a href="/docs/modules">modules</a>
        <a class="signin" href="/sign-in" data-testid="header-signin">sign in</a>
        <span class="version" data-testid="app-version">v{BUILD_INFO.version}</span>
      </nav>
    </header>
  </div>

  <!-- Header band: static vertical slices of the #6 "white sun" orb over
       black (CSS mask, pixelated, no animation → VRT-deterministic). -->
  <div class="band band-header" role="presentation" aria-hidden="true"></div>

  <div class="shell">
    <a class="hero-cta" href="/rack" data-testid="hero-new-rack">
      <span class="hero-kicker">start patching</span>
      <span class="hero-title">NEW RACK</span>
      <span class="hero-sub">open a fresh canvas &rarr;</span>
    </a>

    <div class="module-grid tiles" data-testid="landing-tiles">
      {#each tiles as t (t.id)}
        <a
          class="mod-card tile"
          href={t.href}
          data-testid="tile-{t.id}"
          rel={t.external ? 'noopener' : undefined}
          target={t.external ? '_blank' : undefined}
        >
          <span class="tile-body">
            <span class="tile-label">{t.label}</span>
            <span class="tile-blurb">{t.blurb}</span>
          </span>
        </a>
      {/each}
    </div>
  </div>

  <!-- Footer band: static vertical slices of the #7 "invert" orb — the dim
       inverse of the header, bracketing the page. -->
  <div class="band band-footer" role="presentation" aria-hidden="true"></div>

  <div class="shell">
    <footer class="footer">
      a browser modular synthesizer ·
      <a href="https://github.com/2600hz-oscillator/patchtogether.live">repo</a>
    </footer>
  </div>
</div>

<style>
  /* Landing-specific styling. Palette tokens (--doc-*) come from house.css's
     .docs-root block; every color below is black / electric-blue / white. */

  /* --- Header nav extras --- */
  .brand a {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    display: block;
    width: 36px;
    height: 29px;
    image-rendering: pixelated;
  }
  .version {
    color: var(--doc-fg-dim);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
  }

  /* --- Orb bands: vertical slices via a static CSS mask --- */
  .band {
    width: 100%;
    height: clamp(84px, 12vw, 148px);
    margin: 6px 0 14px;
    background-color: #000;
    background-position: center;
    background-repeat: no-repeat;
    background-size: cover;
    /* Upscaled orb keeps hard pixel edges → lo-fi VHS read. */
    image-rendering: pixelated;
    /* Opaque 6px slice / transparent 5px gutter, repeated across the band.
       Fully static (no animation) so the raster is VRT-deterministic. */
    -webkit-mask-image: repeating-linear-gradient(
      to right,
      #000 0 6px,
      transparent 6px 11px
    );
    mask-image: repeating-linear-gradient(to right, #000 0 6px, transparent 6px 11px);
  }
  .band-header {
    background-image: url('/landing/sun.png');
  }
  .band-footer {
    background-image: url('/landing/invert.png');
    height: clamp(72px, 10vw, 120px);
    margin: 14px 0 6px;
  }

  /* --- NEW RACK hero CTA (corner-bracket treatment like house.css .hero).
     Higher specificity than house.css's global 'a' rule so the box border
     doesn't get overridden to the inline-link underline. --- */
  :global(.docs-root a.hero-cta) {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    position: relative;
    padding: 30px 34px;
    margin: 20px 0 34px;
    border: 1px solid var(--doc-accent-dim);
    text-decoration: none;
    background: linear-gradient(120deg, rgba(0, 240, 255, 0.04), transparent 62%);
    transition:
      border-color 160ms,
      box-shadow 160ms,
      background 160ms;
  }
  :global(.docs-root a.hero-cta:hover),
  :global(.docs-root a.hero-cta:focus-visible) {
    border-color: var(--doc-accent);
    box-shadow:
      0 0 0 1px var(--doc-accent-glow),
      inset 0 0 40px rgba(0, 240, 255, 0.06);
    outline: none;
  }
  .hero-cta::before,
  .hero-cta::after {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
  }
  .hero-cta::before {
    top: -1px;
    left: -1px;
    border-top: 1px solid var(--doc-accent);
    border-left: 1px solid var(--doc-accent);
  }
  .hero-cta::after {
    bottom: -1px;
    right: -1px;
    border-bottom: 1px solid var(--doc-accent);
    border-right: 1px solid var(--doc-accent);
  }
  .hero-kicker {
    font-size: 0.72rem;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--doc-fg-dim);
  }
  .hero-title {
    font-family: var(--doc-sans);
    font-weight: 500;
    font-size: clamp(2rem, 6vw, 3.4rem);
    line-height: 1;
    letter-spacing: 0.05em;
    color: var(--doc-accent);
    text-shadow: 0 0 16px var(--doc-accent-glow);
  }
  .hero-sub {
    font-size: 0.9rem;
    color: var(--doc-fg-dim);
  }

  /* --- Tile grid (.mod-card styling). Reassert the full box border at higher
     specificity than house.css's global 'a' rule. --- */
  .tiles {
    margin: 0 0 10px;
  }
  :global(.docs-root a.mod-card.tile) {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    text-decoration: none;
    border: 1px solid var(--doc-border-dim);
  }
  :global(.docs-root a.mod-card.tile:hover),
  :global(.docs-root a.mod-card.tile:focus-visible) {
    border-color: var(--doc-accent);
    box-shadow:
      0 0 0 1px var(--doc-accent-glow),
      inset 0 0 24px rgba(0, 240, 255, 0.05);
    outline: none;
  }
  .tile-body {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .tile-label {
    font-family: var(--doc-sans);
    font-size: 1.05rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--doc-accent);
  }
  .tile-blurb {
    font-size: 0.84rem;
    color: var(--doc-fg-dim);
  }
</style>
