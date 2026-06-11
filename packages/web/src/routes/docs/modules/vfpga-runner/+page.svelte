<script lang="ts">
  // vfpga-runner — module + VFPGA catalog index. The vfpga-runner HOST loads a
  // `.vfpga` declarative effect spec ("virtual FPGA bitstream"); this page
  // explains the host model and lists every bundled VFPGA (each linking to its
  // own subpage).
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>vfpga-runner · modules · patchtogether.live</title>
  <meta
    name="description"
    content="vfpga-runner: a host module that runs a loaded .vfpga declarative effect spec. The full I/O superset, the load-preset model, and the bundled VFPGA catalog."
  />
</svelte:head>

<section class="hero">
  <h1>vfpga-runner</h1>
  <div class="sub"><code>vfpgaRunner</code> · video · host module</div>
</section>

<p>
  <strong>vfpga-runner</strong> is a HOST module: it declares the full I/O
  superset it can wire, and a loaded <code>.vfpga</code> declarative spec — a
  "virtual FPGA bitstream" — selects which subset is ACTIVE and what render-graph
  runs. Swap a compiled effect into the one reconfigurable card the way a
  bitstream reconfigures an FPGA fabric. (The metaphor is inspired by — not a
  clone of — classic video-synth hardware; every VFPGA id stays generic.)
</p>

<h2>The host superset</h2>
<ul>
  <li><strong>Video in:</strong> vin1 … vin4</li>
  <li><strong>CV in:</strong> cv1 … cv4 (linear-scaled; each with a bipolar SCALE attenuverter + OFFSET + always-on scope on the card)</li>
  <li><strong>Gate in:</strong> g1 … g4 (raw passthrough + a factory hysteresis edge-detector → held level / rising-edge count uniforms)</li>
  <li><strong>Video out:</strong> vout1 (canonical) and vout2</li>
  <li><strong>Params:</strong> a generic p1 … p8 slot bank; a loaded spec maps + labels its params onto these</li>
</ul>
<p>
  The card renders the full superset of handles (inactive ports dimmed) and shows
  only the loaded spec's active CV inputs, gate inputs, and param knobs. Pick a
  VFPGA from the card's <em>load preset…</em> menu to hot-swap the effect.
</p>

<h2>Bundled VFPGAs</h2>
<ul class="catalog">
  {#each data.vfpgas as v}
    <li>
      <a href={`/docs/modules/vfpga/${v.docSlug}/`}><code>{v.id}</code> — {v.name}</a>
      <span class="io">{v.videoIn} video in · {v.videoOut} video out · {v.cvRoles} CV · {v.gateRoles} gate · {v.params} params</span>
      <p class="blurb">{v.doc}</p>
    </li>
  {/each}
</ul>

<style>
  .hero { margin-bottom: 1rem; }
  .sub { color: var(--text-dim, #888); font-size: 0.9rem; }
  .catalog { list-style: none; padding: 0; }
  .catalog li { margin-bottom: 1.25rem; }
  .io { display: block; color: var(--text-dim, #888); font-size: 0.8rem; margin-top: 2px; }
  .blurb { margin: 4px 0 0; font-size: 0.9rem; }
  code { font-family: ui-monospace, monospace; }
</style>
