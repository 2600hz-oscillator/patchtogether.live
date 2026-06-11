<script lang="ts">
  // Per-VFPGA subpage — model / controls / I-O / CV+gate roles / usage for one
  // bundled VFPGA, served from the registry (so it never drifts from the spec).
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
  let s = $derived(data.spec);
</script>

<svelte:head>
  <title>{s.name} · VFPGA · patchtogether.live</title>
  <meta name="description" content={s.doc} />
</svelte:head>

<section class="hero">
  <h1>{s.name}</h1>
  <div class="sub">
    VFPGA <code>{s.id}</code> · runs in <a href="/docs/modules/vfpga-runner/">vfpga-runner</a>
  </div>
</section>

<h2>Model</h2>
<p>{s.doc}</p>

<h2>I/O</h2>
<ul>
  <li><strong>Video in:</strong> {s.videoIn}{s.videoIn === 0 ? ' (pure generator)' : ` (vin1…vin${s.videoIn})`}</li>
  <li><strong>Video out:</strong> {s.videoOut} (vout1{s.videoOut > 1 ? ' + vout2' : ''})</li>
</ul>

{#if s.params.length > 0}
  <h2>Controls (param knobs)</h2>
  <table>
    <thead><tr><th>Slot</th><th>Knob</th><th>Range</th><th>Default</th><th>What it does</th></tr></thead>
    <tbody>
      {#each s.params as p}
        <tr>
          <td><code>p{p.slot}</code></td>
          <td>{p.label}</td>
          <td>{p.min} … {p.max}</td>
          <td>{p.defaultValue}</td>
          <td>{p.doc ?? ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if s.cvRoles.length > 0}
  <h2>CV roles</h2>
  <table>
    <thead><tr><th>Input</th><th>Role</th><th>What it modulates</th></tr></thead>
    <tbody>
      {#each s.cvRoles as r}
        <tr><td><code>cv{r.slot}</code></td><td>{r.label}</td><td>{r.doc ?? ''}</td></tr>
      {/each}
    </tbody>
  </table>
  <p class="note">Each CV input has a bipolar SCALE attenuverter + OFFSET on the card, and an always-on scope.</p>
{/if}

{#if s.gateRoles.length > 0}
  <h2>Gate roles</h2>
  <table>
    <thead><tr><th>Input</th><th>Role</th><th>What it triggers</th></tr></thead>
    <tbody>
      {#each s.gateRoles as r}
        <tr><td><code>g{r.slot}</code></td><td>{r.label}</td><td>{r.doc ?? ''}</td></tr>
      {/each}
    </tbody>
  </table>
  <p class="note">Gate inputs raw-pass into the host's synthetic gN_evt params; the factory hysteresis edge-detects rising edges (rise &gt; 0.6 / fall &lt; 0.4).</p>
{/if}

<h2>Usage</h2>
<p>
  Add a <a href="/docs/modules/vfpga-runner/">vfpga-runner</a>, pick
  <code>{s.name}</code> from the card's <em>load preset…</em> menu, and patch the
  active outputs into OUTPUT / a video mixer / a downstream effect.
  {#if s.videoIn === 0}
    As a pure generator it always runs (no input needed) — a deterministic
    reference source for bringing up the rest of a video chain.
  {/if}
</p>

<style>
  .hero { margin-bottom: 1rem; }
  .sub { color: var(--text-dim, #888); font-size: 0.9rem; }
  table { border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.9rem; }
  th, td { border: 1px solid var(--border, #333); padding: 4px 10px; text-align: left; }
  .note { font-size: 0.85rem; color: var(--text-dim, #888); }
  code { font-family: ui-monospace, monospace; }
</style>
