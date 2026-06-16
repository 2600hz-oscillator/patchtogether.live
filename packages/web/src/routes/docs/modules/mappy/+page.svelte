<script lang="ts">
  // MAPPY — multi-surface manual projection mapper docs.
  //
  // Sections: model · warp + composite (with a small SVG diagram) · IO ·
  // params · usage. The IO / param tables are sourced from the module def
  // (mappyDef, via +page.server.ts) — the auto /docs/modules/[id] manifest is
  // audio-only, so video modules get a dedicated def-driven page like this.

  let { data } = $props();
</script>

<svelte:head>
  <title>mappy · modules · patchtogether.live</title>
  <meta
    name="description"
    content="MAPPY — a multi-surface manual projection mapper: warp up to six video feeds onto draggable quads and composite to a projector."
  />
</svelte:head>

<section class="hero">
  <h1>mappy</h1>
  <div class="sub"><code>{data.type}</code> · {data.category} · schema v{data.schemaVersion}</div>
</section>

<p>
  <strong>MAPPY</strong> is a multi-surface <em>manual</em> projection mapper. It
  spawns up to <strong>six surfaces</strong>; each surface is fed by a distinct
  video input (<code>in1</code>…<code>in6</code>), warped onto its own
  <strong>draggable quad</strong> in the output frame, and composited — painter's
  order, OVER — into one video output you send to a projector.
</p>

<h2>model</h2>
<ul>
  <li>
    <strong>One surface — de-skew.</strong> Point a projector at an
    awkwardly-angled wall, then drag a surface's four corners until the
    projected image lines up square. The homography corrects the keystone /
    perspective distortion.
  </li>
  <li>
    <strong>Up to six — map a cube (or a stage set).</strong> Give each face of
    a white cube its own feed; only ~3-4 faces are ever visible from one
    projector angle, so six surfaces cover a rotating object or a multi-panel
    set. Composite order (<code>in1</code> first … <code>in6</code> last) lets a
    later surface paint over an earlier one where they overlap.
  </li>
  <li>
    <strong>Manual only (v1).</strong> You align by hand on the card. The
    camera-assisted <em>auto</em>-align — point a camera at the projection and
    solve the homography from detected features — is a later phase. There is no
    camera input and no CV in v1 by design.
  </li>
</ul>

<h2>warp + composite</h2>
<p>
  Every surface owns a four-corner quad in <strong>normalized [0,1] output
  space</strong>, corner order <strong>TL, TR, BR, BL</strong>. A
  <em>homography</em> (the unit square → that quad) defines the projective warp.
  The shader runs per <strong>output</strong> texel: it takes the output uv,
  applies the <strong>inverse</strong> homography to find the matching
  <strong>source</strong> uv, and samples the input there — only where the source
  uv is inside [0,1] (outside, the texel is transparent so the layers beneath
  show through). The pure 2D projective math (DLT solve · apply · invert ·
  column-major-for-GLSL) lives in <code>$lib/video/mappy-homography</code> and is
  shared by the shader and the unit tests.
</p>

<div class="diagram-wrap" data-testid="mappy-warp-diagram">
  <svg viewBox="0 0 360 160" width="100%" role="img" aria-label="MAPPY warps a source frame onto a dragged quad in the output">
    <!-- source frame -->
    <rect x="14" y="30" width="100" height="80" rx="3" fill="#0c1418" stroke="#3a8" stroke-width="1.5" />
    <text x="64" y="74" text-anchor="middle" fill="#7cd" font-size="11" font-family="ui-monospace, monospace">source</text>
    <text x="64" y="124" text-anchor="middle" fill="#567" font-size="9" font-family="ui-monospace, monospace">unit square</text>
    <!-- arrow / homography -->
    <line x1="120" y1="70" x2="180" y2="70" stroke="#5a9bff" stroke-width="1.5" marker-end="url(#arr)" />
    <text x="150" y="60" text-anchor="middle" fill="#5a9bff" font-size="9" font-family="ui-monospace, monospace">homography</text>
    <!-- output frame + dragged quad -->
    <rect x="206" y="20" width="140" height="120" rx="3" fill="#070b0e" stroke="#234" stroke-width="1" />
    <polygon points="232,44 322,58 332,118 222,104" fill="rgba(90,155,255,0.18)" stroke="#5a9bff" stroke-width="1.5" />
    <circle cx="232" cy="44" r="4" fill="#5a9bff" />
    <circle cx="322" cy="58" r="4" fill="#5a9bff" />
    <circle cx="332" cy="118" r="4" fill="#5a9bff" />
    <circle cx="222" cy="104" r="4" fill="#5a9bff" />
    <text x="276" y="155" text-anchor="middle" fill="#567" font-size="9" font-family="ui-monospace, monospace">output (draggable quad)</text>
    <defs>
      <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#5a9bff" />
      </marker>
    </defs>
  </svg>
</div>

<p>
  Surfaces composite in input order with an OVER blend. Every surface starts
  <strong>full-frame</strong> (the unit quad), so connecting any single input
  immediately fills the frame with that feed — then drag its corners in to
  skew / shrink the footprint. The composite is exposed on the <code>out</code>
  port and as the on-card live preview.
</p>
<p>
  <strong>SHOW GRID</strong> swaps the input for a numbered calibration grid
  (per-surface-tinted checker + bright border + cross-hairs + a tally encoding
  the surface number), warped into each connected surface's quad. Line the grid
  up to the physical surface, then turn it off.
</p>

<h2>card</h2>
<p>
  A live composite preview with an SVG overlay of every <em>connected</em>
  surface's draggable corner handles and quad outline (coloured per surface; the
  focused surface's handles come to front). A legend lists each connected input
  with a focus toggle and a "reset corners to full-frame" button, plus the GRID
  toggle. All ports live on the yellow drill-down patch panel — no raw side
  jacks.
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
    <thead><tr><th>id</th><th>cable</th></tr></thead>
    <tbody>
      {#each data.outputs as p (p.id)}
        <tr><td><code>{p.id}</code></td><td>{p.type}</td></tr>
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
  <li>Patch a video source into <code>in1</code> — it fills the whole frame.</li>
  <li>
    Turn on <strong>GRID</strong> and drag the surface's four corner handles on
    the preview until the calibration grid lines up with the physical screen /
    cube face, then turn GRID off.
  </li>
  <li>
    Add more sources on <code>in2</code>…<code>in6</code> for more surfaces;
    focus a surface in the legend to bring its handles to front, and
    <em>reset</em> any surface back to full-frame.
  </li>
  <li>Route <code>out</code> → OUTPUT (your projector).</li>
</ol>

<nav class="prev-next">
  <a href="/docs/modules" class="all">all modules</a>
</nav>

<style>
  .diagram-wrap {
    margin: 1.5rem 0;
    max-width: 460px;
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
