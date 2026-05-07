<script lang="ts">
  // IoDiagram.svelte
  //
  // Tron-style I/O diagram for one module. Inputs render as labeled pins on
  // the left, outputs on the right. Cable types color-coded:
  //   audio = electric blue   cv    = orange
  //   gate  = magenta         pitch = cyan-green
  //   polyPitchGate = violet  (Stage-1 polyphony cable)
  //
  // Auto-sizing: height grows with max(inputs, outputs).

  import type { ManifestModule } from './module-manifest';

  interface Props {
    mod: ManifestModule;
  }
  let { mod }: Props = $props();

  // Tron-themed I/O diagram is purely a function of `mod`. We compute layout
  // via $derived so a hot module reload (or any future stash that mutates
  // `mod` reactively) updates the SVG dimensions without a remount.
  const rowH = 16;
  const headerH = 36;
  const padTop = 14;
  const padBottom = 14;
  const W = 380;
  const boxX = 80;
  const boxW = W - 160;
  const boxY = headerH + padTop;

  const inputs = $derived(mod.inputs ?? []);
  const outputs = $derived(mod.outputs ?? []);
  const innerH = $derived(Math.max(inputs.length, outputs.length, 1) * rowH + 2);
  const totalH = $derived(headerH + padTop + innerH + padBottom + 22);
  const boxH = $derived(innerH);

  function pinClass(t: string): string {
    return `pin pin-${t}`;
  }
</script>

<svg
  class="io-svg"
  viewBox="0 0 {W} {totalH}"
  role="img"
  aria-label="{mod.label} I/O"
  data-testid="io-diagram"
>
  <text x={W / 2} y={20} class="header-text" text-anchor="middle">
    {mod.label}{mod.maxInstances === 1 ? ' · singleton' : ''}
  </text>

  <rect class="box" x={boxX} y={boxY} width={boxW} height={boxH} />

  {#each inputs as p, i (p.id)}
    {@const y = boxY + 8 + i * rowH}
    <line class={pinClass(p.type)} x1={4} y1={y} x2={boxX} y2={y} />
    <circle class={pinClass(p.type)} cx={boxX} cy={y} r={2.4} />
    <text class="label-name" x={boxX + 6} y={y + 3}>{p.id}</text>
    <text class="label-type" x={4} y={y - 3}>{p.type}</text>
  {/each}

  {#each outputs as p, i (p.id)}
    {@const y = boxY + 8 + i * rowH}
    {@const x2 = W - 4}
    <line class={pinClass(p.type)} x1={boxX + boxW} y1={y} x2={x2} y2={y} />
    <circle class={pinClass(p.type)} cx={boxX + boxW} cy={y} r={2.4} />
    <text class="label-name" x={boxX + boxW - 6} y={y + 3} text-anchor="end">{p.id}</text>
    <text class="label-type" x={x2} y={y - 3} text-anchor="end">{p.type}</text>
  {/each}

  <g transform="translate({boxX}, {totalH - 14})">
    <line class="pin-audio" x1={0} y1={4} x2={14} y2={4} />
    <text class="legend-text" x={18} y={7}>audio</text>
    <line class="pin-cv" x1={56} y1={4} x2={70} y2={4} />
    <text class="legend-text" x={74} y={7}>cv</text>
    <line class="pin-gate" x1={102} y1={4} x2={116} y2={4} />
    <text class="legend-text" x={120} y={7}>gate</text>
    <line class="pin-pitch" x1={150} y1={4} x2={164} y2={4} />
    <text class="legend-text" x={168} y={7}>pitch</text>
  </g>
</svg>
