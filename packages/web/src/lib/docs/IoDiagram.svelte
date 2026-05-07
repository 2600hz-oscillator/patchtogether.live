<script lang="ts">
  // Tron-style I/O diagram for one module. Inputs as labeled pins on the left,
  // outputs on the right. Cable types color-coded:
  //   audio = electric blue   cv    = orange
  //   gate  = magenta         pitch = cyan-green
  //   polyPitchGate = violet
  // Auto-sizing: height grows with max(inputs, outputs).
  import type { ManifestModule } from '$lib/docs/modules-manifest';

  let { mod }: { mod: ManifestModule } = $props();

  let inputs = $derived(mod.inputs ?? []);
  let outputs = $derived(mod.outputs ?? []);
  const rowH = 16;
  const headerH = 36;
  const padTop = 14;
  const padBottom = 14;
  let innerH = $derived(Math.max(inputs.length, outputs.length, 1) * rowH + 2);
  let totalH = $derived(headerH + padTop + innerH + padBottom + 22);
  const W = 380;
  const boxX = 80;
  const boxW = W - 160;
  const boxY = headerH + padTop;
</script>

<svg class="io-svg" viewBox={`0 0 ${W} ${totalH}`} role="img" aria-label={`${mod.label} I/O`}>
  <text x={W / 2} y={20} class="header" text-anchor="middle">
    {mod.label}{mod.maxInstances === 1 ? ' · singleton' : ''}
  </text>

  <rect class="box" x={boxX} y={boxY} width={boxW} height={innerH} />

  {#each inputs as p, i (p.id)}
    {@const y = boxY + 8 + i * rowH}
    <line class="pin pin-{p.type}" x1={4} y1={y} x2={boxX} y2={y} />
    <circle class="pin pin-{p.type}" cx={boxX} cy={y} r={2.4} fill="currentColor" />
    <text class="label-name" x={boxX + 6} y={y + 3}>{p.id}</text>
    <text class="label-type" x={4} y={y - 3}>{p.type}</text>
  {/each}

  {#each outputs as p, i (p.id)}
    {@const y = boxY + 8 + i * rowH}
    {@const x2 = W - 4}
    <line class="pin pin-{p.type}" x1={boxX + boxW} y1={y} x2={x2} y2={y} />
    <circle class="pin pin-{p.type}" cx={boxX + boxW} cy={y} r={2.4} fill="currentColor" />
    <text class="label-name" x={boxX + boxW - 6} y={y + 3} text-anchor="end">{p.id}</text>
    <text class="label-type" x={x2} y={y - 3} text-anchor="end">{p.type}</text>
  {/each}

  <g transform="translate({boxX}, {totalH - 14})">
    <line class="pin-audio" x1={0}   y1={4} x2={14}  y2={4} />
    <text class="legend-text" x={18} y={7}>audio</text>
    <line class="pin-cv"    x1={56}  y1={4} x2={70}  y2={4} />
    <text class="legend-text" x={74} y={7}>cv</text>
    <line class="pin-gate"  x1={102} y1={4} x2={116} y2={4} />
    <text class="legend-text" x={120} y={7}>gate</text>
    <line class="pin-pitch" x1={150} y1={4} x2={164} y2={4} />
    <text class="legend-text" x={168} y={7}>pitch</text>
    <line class="pin-polyPitchGate" x1={200} y1={4} x2={214} y2={4} />
    <text class="legend-text" x={218} y={7}>poly</text>
  </g>
</svg>

<style>
  .io-svg {
    width: 100%;
    height: auto;
    display: block;
    margin: 4px 0 10px;
    background: var(--docs-bg-soft);
    border: 1px solid var(--docs-border-dim);
  }
  .io-svg .box { fill: none; stroke: var(--docs-accent); stroke-width: 1; }
  .io-svg .label-name { fill: var(--docs-accent); font-family: var(--docs-mono); font-size: 9px; }
  .io-svg .label-type { fill: var(--docs-fg-dim); font-family: var(--docs-mono); font-size: 8px; }
  .io-svg .header { fill: var(--docs-fg); font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 500; }
  .io-svg .pin { fill: none; stroke-width: 1; }
  .io-svg circle.pin { stroke: currentColor; }
  .io-svg .pin-audio { color: #00f0ff; stroke: #00f0ff; }
  .io-svg .pin-cv { color: #ff8a00; stroke: #ff8a00; }
  .io-svg .pin-gate { color: #ff3df0; stroke: #ff3df0; }
  .io-svg .pin-pitch { color: #6effd6; stroke: #6effd6; }
  .io-svg .pin-polyPitchGate { color: #a78bfa; stroke: #a78bfa; }
  .io-svg .legend-text { fill: var(--docs-fg-dim); font-family: var(--docs-mono); font-size: 8px; }
</style>
