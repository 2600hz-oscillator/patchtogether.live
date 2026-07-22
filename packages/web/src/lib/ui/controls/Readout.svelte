<script lang="ts">
  // Readout — the RACKLINE `.readout` / `.value-chip` / `.ctl-val` mono display
  // value (ALG 05, channel labels, a live level number). Display-only, so the
  // card-kit contract here is `{ value, readLive }` (no onchange). When
  // `readLive` is given the chip shows the LIVE value each rAF (a motorized
  // readout — the number tracks CV modulation), else the prop value. Formatting
  // goes through the shared readout-model so a number here matches the same
  // number shown under a Knob/Fader.
  import { onDestroy, untrack } from 'svelte';
  import { formatReadout } from './readout-model';

  interface Props {
    value: number | string;
    /** Appended after the number (e.g. "Hz", "dB"). */
    units?: string;
    /** Fixed decimals instead of the magnitude-based default. */
    precision?: number;
    /** Optional small uppercase tag rendered before the value. */
    label?: string;
    /** `readout` (domain-tinted chip) · `value-chip` (alias) · `ctl-val`
     *  (plain mono under a control). */
    variant?: 'readout' | 'value-chip' | 'ctl-val';
    /** Live reader — polled each rAF; overrides `value` while present. */
    readLive?: () => number | undefined;
    testid?: string;
  }

  let {
    value,
    units,
    precision,
    label,
    variant = 'readout',
    readLive,
    testid,
  }: Props = $props();

  let liveValue = $state<number | string>(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);
  $effect(() => {
    if (!readLive) { liveValue = currentValue; return; }
    const reader = readLive;
    function tick() {
      const v = reader();
      liveValue = v ?? currentValue;
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  });
  $effect(() => { if (!readLive) liveValue = currentValue; });

  let text = $derived(formatReadout(liveValue, { units, precision }));
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });
</script>

<span
  class="readout-el {variant}"
  data-testid={testid}
  role="status"
  aria-label={label ? `${label}: ${text}` : text}
>
  {#if label}<span class="rd-lab">{label}</span>{/if}<span class="rd-val">{text}</span>
</span>

<style>
  .readout-el {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    font-family: var(--mono, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .rd-lab {
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .rd-val { color: var(--domain, var(--accent)); }

  /* readout / value-chip — a bordered inset chip (domain-tinted value). */
  .readout-el.readout,
  .readout-el.value-chip {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--domain, var(--accent));
    background: var(--module-bg-deep, #0a0c0f);
    border: 1px solid var(--border, #2c3037);
    border-radius: 4px;
    padding: 3px 7px;
  }
  .readout-el.readout .rd-val,
  .readout-el.value-chip .rd-val { color: var(--domain, var(--accent)); }

  /* ctl-val — plain mono value under a control (no chrome). */
  .readout-el.ctl-val {
    font-size: 10px;
    color: var(--text);
  }
  .readout-el.ctl-val .rd-val { color: var(--text); }
</style>
