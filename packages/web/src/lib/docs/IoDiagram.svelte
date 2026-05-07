<script lang="ts">
  import type { ManifestModule } from './types';

  interface Props {
    mod: ManifestModule;
  }
  let { mod }: Props = $props();

  const inputs = mod.inputs ?? [];
  const outputs = mod.outputs ?? [];
  const rowH = 16;
  const headerH = 36;
  const padTop = 14;
  const padBottom = 14;
  const innerH = Math.max(inputs.length, outputs.length, 1) * rowH + 2;
  const totalH = headerH + padTop + innerH + padBottom + 22;
  const W = 380;
  const boxX = 80;
  const boxW = W - 160;
  const boxY = headerH + padTop;
  const boxH = innerH;

  const pinClass = (t: string) => `docs-io-pin docs-io-pin-${t}`;
</script>

<svg class="docs-io-svg" viewBox="0 0 {W} {totalH}" role="img" aria-label="{mod.label} I/O" data-testid="docs-io-svg">
  <text x={W / 2} y={20} class="docs-io-header" text-anchor="middle">
    {mod.label}{mod.maxInstances === 1 ? ' · singleton' : ''}
  </text>
  <rect class="docs-io-box" x={boxX} y={boxY} width={boxW} height={boxH} />

  {#each inputs as p, i}
    {@const y = boxY + 8 + i * rowH}
    <line class={pinClass(p.type)} x1={4} y1={y} x2={boxX} y2={y} />
    <circle class={pinClass(p.type)} cx={boxX} cy={y} r={2.4} fill="currentColor" />
    <text class="docs-io-label-name" x={boxX + 6} y={y + 3}>{p.id}</text>
    <text class="docs-io-label-type" x={4} y={y - 3}>{p.type}</text>
  {/each}

  {#each outputs as p, i}
    {@const y = boxY + 8 + i * rowH}
    {@const x2 = W - 4}
    <line class={pinClass(p.type)} x1={boxX + boxW} y1={y} x2={x2} y2={y} />
    <circle class={pinClass(p.type)} cx={boxX + boxW} cy={y} r={2.4} fill="currentColor" />
    <text class="docs-io-label-name" x={boxX + boxW - 6} y={y + 3} text-anchor="end">{p.id}</text>
    <text class="docs-io-label-type" x={x2} y={y - 3} text-anchor="end">{p.type}</text>
  {/each}

  <g transform="translate({boxX}, {totalH - 14})">
    <line class="docs-io-pin-audio" x1={0}   y1={4} x2={14}  y2={4} />
    <text class="docs-io-legend-text" x={18} y={7}>audio</text>
    <line class="docs-io-pin-cv"    x1={56}  y1={4} x2={70}  y2={4} />
    <text class="docs-io-legend-text" x={74} y={7}>cv</text>
    <line class="docs-io-pin-gate"  x1={102} y1={4} x2={116} y2={4} />
    <text class="docs-io-legend-text" x={120} y={7}>gate</text>
    <line class="docs-io-pin-pitch" x1={150} y1={4} x2={164} y2={4} />
    <text class="docs-io-legend-text" x={168} y={7}>pitch</text>
    <line class="docs-io-pin-polyPitchGate" x1={200} y1={4} x2={214} y2={4} />
    <text class="docs-io-legend-text" x={218} y={7}>poly</text>
  </g>
</svg>
