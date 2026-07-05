<script lang="ts">
  // ONE TO NINE — fixed 3×3 screen-splitter docs.
  //
  // Sections: model · the numbered split (with a small SVG diagram) · monitor ·
  // IO · params · usage. The IO / param tables are sourced from the module def
  // (oneToNineDef, via +page.server.ts) — the auto /docs/modules/[id] manifest
  // is audio-only, so video modules get a dedicated def-driven page like this.

  let { data } = $props();
</script>

<svelte:head>
  <title>one to nine · modules · patchtogether.live</title>
  <meta
    name="description"
    content="ONE TO NINE — a fixed 3×3 screen splitter: one video input divided into nine clean crops, one per output, with a numbered monitor."
  />
</svelte:head>

<section class="hero">
  <h1>one to nine</h1>
  <div class="sub"><code>{data.type}</code> · {data.category}</div>
</section>

<p>
  <strong>ONE TO NINE</strong> is a fixed <strong>3×3 screen splitter</strong>.
  It takes <strong>one</strong> video input and divides it into a 3×3 grid of
  nine equal sub-rectangles; each grid <strong>cell</strong> is exposed on its
  own output (<code>out1</code>…<code>out9</code>), scaled up to fill the output
  frame. Use it <em>alongside</em> (not wired to) MAPPY to feed each of up to
  nine projectors a different ninth of one source.
</p>

<h2>model</h2>
<ul>
  <li>
    <strong>Reading-order numbering.</strong> Cells are numbered like text:
    <code>1</code> top-left, <code>2</code> top-center, <code>3</code> top-right,
    <code>4</code> mid-left, <code>5</code> centre, <code>6</code> mid-right,
    <code>7</code> bottom-left, <code>8</code> bottom-center, <code>9</code>
    bottom-right.
  </li>
  <li>
    <strong>Output N = cell N.</strong> Each output carries <em>only</em> the
    content of its cell — a 1/9 sub-rectangle of the input — magnified to the
    full output frame. So every output is a low-res crop of one ninth (expected
    and fine).
  </li>
  <li>
    <strong>Clean crops.</strong> The nine outputs have no grid lines and no
    numbers. The grid + numbers live only on the monitor.
  </li>
  <li>
    <strong>No params.</strong> The 3×3 split is fixed; the only control is a
    GRID toggle for the monitor overlay.
  </li>
</ul>

<h2>the numbered split</h2>
<p>
  The monitor shows the input with a 3×3 grid drawn over it and a big digit
  <code>1</code>…<code>9</code> in each cell, so you can see which cell feeds
  which output before you patch:
</p>

<div class="diagram-wrap" data-testid="onetonine-split-diagram">
  <svg viewBox="0 0 240 160" width="100%" role="img" aria-label="ONE TO NINE divides one input into a numbered 3x3 grid, one cell per output">
    <rect x="10" y="10" width="220" height="140" rx="4" fill="#070b0e" stroke="#234" stroke-width="1" />
    <!-- grid lines -->
    <line x1="83.3" y1="10" x2="83.3" y2="150" stroke="#ffd24a" stroke-width="1" stroke-opacity="0.7" />
    <line x1="156.6" y1="10" x2="156.6" y2="150" stroke="#ffd24a" stroke-width="1" stroke-opacity="0.7" />
    <line x1="10" y1="56.6" x2="230" y2="56.6" stroke="#ffd24a" stroke-width="1" stroke-opacity="0.7" />
    <line x1="10" y1="103.3" x2="230" y2="103.3" stroke="#ffd24a" stroke-width="1" stroke-opacity="0.7" />
    <!-- numbers in reading order -->
    {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as n (n)}
      {@const col = (n - 1) % 3}
      {@const row = Math.floor((n - 1) / 3)}
      <text
        x={10 + 36.6 + col * 73.3}
        y={10 + 33 + row * 46.6}
        text-anchor="middle"
        fill="#fff"
        font-size="20"
        font-family="ui-monospace, monospace"
      >{n}</text>
    {/each}
  </svg>
</div>

<h2>monitor</h2>
<p>
  The <strong>monitor</strong> is the module's canonical surface — the on-card
  live preview and the blit target. It renders the input plus the numbered 3×3
  grid. The <strong>GRID</strong> toggle on the card hides the overlay (raw input
  passthrough) when off; it is on by default since the numbered grid is the point
  of the monitor. The grid and numbers appear <em>only</em> on the monitor — the
  nine outputs are always clean crops. (The y-up texture convention is handled in
  the pure crop math so cell 1 is genuinely the top-left and the digits render
  upright.)
</p>

{#if data.inputs.length > 0}
  <h2>inputs</h2>
  <table>
    <thead><tr><th>id</th><th>cable</th></tr></thead>
    <tbody>
      {#each data.inputs as p (p.id)}
        <tr><td><code>{p.id}</code></td><td>{p.type}</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if data.outputs.length > 0}
  <h2>outputs</h2>
  <table>
    <thead><tr><th>id</th><th>cable</th><th>cell</th></tr></thead>
    <tbody>
      {#each data.outputs as p, i (p.id)}
        <tr><td><code>{p.id}</code></td><td>{p.type}</td><td>cell {i + 1}</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if data.params.length > 0}
  <h2>params</h2>
  <table>
    <thead><tr><th>id</th><th>label</th><th>range</th><th>default</th></tr></thead>
    <tbody>
      {#each data.params as p (p.id)}
        <tr>
          <td><code>{p.id}</code></td>
          <td>{p.label}</td>
          <td>{p.min ?? '?'}..{p.max ?? '?'}</td>
          <td>{p.defaultValue ?? '—'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<h2>usage</h2>
<ol>
  <li>Patch a video source into <code>in</code>.</li>
  <li>Read the numbered <strong>monitor</strong> to learn the cell layout.</li>
  <li>
    Patch each <code>out1</code>…<code>out9</code> to its destination — a
    projector (via <code>videoOut</code>), a recorder, or a mixer.
  </li>
  <li>
    Toggle <strong>GRID</strong> off if you want a clean input passthrough on the
    monitor too.
  </li>
</ol>

<nav class="prev-next">
  <a href="/docs/modules" class="all">all modules</a>
</nav>

<style>
  .diagram-wrap {
    margin: 1.5rem 0;
    max-width: 360px;
  }
  .prev-next {
    display: flex;
    justify-content: flex-start;
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
