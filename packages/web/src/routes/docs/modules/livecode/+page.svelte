<script lang="ts">
  // LIVECODE — text-DSL module docs.
  //
  // Sections:
  //   1. Intro
  //   2. Syntax reference
  //   3. Examples (incl. the topbar "Load example" patch recreated in DSL)
  //   4. Per-module addressable surface (auto-generated from module-manifest)
  //   5. Limitations + roadmap
  //
  // The per-module port reference (Section 4) reads from the same manifest
  // /docs/modules uses, so when a module's port set changes the LIVECODE
  // reference picks it up on the next build automatically.

  import type { ManifestModule } from '$lib/docs/module-manifest';

  let { data } = $props();
  const manifest = $derived(data.manifest);
  const modules = $derived<ManifestModule[]>(manifest.modules);

  // Order the addressable-surface section by category (matches the rest of
  // the docs site) then by label. The LIVECODE entry itself has no I/O so
  // we drop it from this section — it's a tool, not a target.
  const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];
  const byCat = $derived.by(() => {
    const out: Record<string, ManifestModule[]> = {};
    for (const m of modules) {
      if (m.type === 'livecode') continue;
      (out[m.category] ??= []).push(m);
    }
    return out;
  });
  const cats = $derived(
    CAT_ORDER.filter((c) => byCat[c]).concat(
      Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)),
    ),
  );

  // The "Load example" patch recreation, written in DSL form. Mirrors
  // the loadExample() function in Canvas.svelte exactly:
  //   - 8-step C-major motif on a Sequencer (BPM 180)
  //   - Sequencer pitch -> Analog VCO pitch
  //   - Sequencer gate -> ADSR gate
  //   - VCO sine -> VCA audio
  //   - ADSR env -> VCA cv
  //   - VCA audio -> Audio Out L AND R
  // Notes: midi 60 = c4, 67 = g4, 72 = c5, etc — the example uses MIDI
  // numbers in the source, but the DSL renders them as note literals.
  const LOAD_EXAMPLE_DSL = `// Recreate the topbar "Load example" patch in LIVECODE DSL.
// Plays an 8-note C-major motif at 180 BPM.

seq  = sequencer.new()
vco  = analogVco.new()
env  = adsr.new()
amp  = vca.new()
out  = audioOut.new()

// Wires
seq.pitch  -> vco.pitch
seq.gate   -> env.gate
vco.sine   -> amp.audio
env.env    -> amp.cv
amp.audio  -> out.L
amp.audio  -> out.R

// Sequencer params + 8-step motif (one C-major arpeggio).
seq.bpm        = 180
seq.length     = 8
seq.isPlaying  = 1
seq.gateLength = 0.4
seq.steps      = [c4, g4, c5, g4, e4, c4, f4, g4]

// Envelope params (snappy pluck)
env.attack  = 0.005
env.decay   = 0.08
env.sustain = 0.3
env.release = 0.15

// VCA: cv-driven (no DC offset)
amp.base     = 0
amp.cvAmount = 1

// Master volume
out.master   = 0.4`;

  const SIMPLEST_DSL = `// Spawn one VCO + Audio Out and route a steady tone.
v = analogVco.new()
o = audioOut.new()
v.sine -> o.L
v.sine -> o.R
v.tune = 0`;

  const TWO_MODULE_DSL = `// LFO modulating an Analog VCO's tune.
//
// patch the LFO's phase0 output into the vco's pitch input —
// the rate slider on the LFO controls vibrato speed.
lfo = lfo.new()
vco = analogVco.new()
out = audioOut.new()

lfo.phase0 -> vco.pitch
vco.sine   -> out.L
vco.sine   -> out.R

lfo.rate = 4
lfo.shape = 0`;

  const DRUMS_DSL = `// Drumseqz + Drummergirl + Audio Out — beat machine in 12 lines.

clk  = timelorde.new()
seq  = drumseqz.new()
kick = drummergirl.new()
out  = audioOut.new()

// Master clock drives drumseqz; track 1 fires the drum.
clk.1x        -> seq.clock
seq.gate1     -> kick.gate
seq.pitch1    -> kick.pitch
kick.audio    -> out.L
kick.audio    -> out.R

// 16 steps; 1 hit on every quarter note.
seq.tracks = [c2, -, -, -, c2, -, -, -, c2, -, -, -, c2, -, -, -]
clk.bpm    = 124`;

  // Operator reference table — one row per surface form.
  const SYNTAX_ROWS: Array<{ form: string; example: string; meaning: string }> = [
    { form: '<var> = <type>.new()',       example: 'vco = analogVco.new()',  meaning: 'Spawn a new module of <type>; bind it to <var> for the rest of the script.' },
    { form: '<var> = <module-name>',      example: 'mine = ANALOGVCO1',     meaning: 'Bind a local variable to a pre-existing module addressed by its rack name.' },
    { form: '<src>.<port> -> <dst>.<port>', example: 'vco.sine -> amp.audio', meaning: 'Wire an output port to an input port. Cable type is inferred from the registry.' },
    { form: '<var>.<param> = <number>',   example: 'vco.tune = 7',          meaning: 'Set a knob/param value on the bound module.' },
    { form: '<var>.<param> = <note>',     example: 'seq.steps = [c3, e3]',  meaning: 'Note literals (c3, d4#, gb2) live inside arrays of sequencer steps.' },
    { form: '<var>.<param> = [list]',     example: 'd.tracks = [c3, -, c4]', meaning: 'Array assignments land on node.data; the bare `-` is an empty step.' },
    { form: '<MODULENAME>.<param> = ...', example: 'ANALOGVCO1.tune = 12', meaning: 'Address pre-existing modules in the rack by their displayed name (case-insensitive).' },
    { form: '// comment',                 example: '// my LFO',             meaning: 'Line comments. End-of-line; no block comments yet.' },
    { form: 'newline / `;`',              example: 'a = vca.new(); b = vca.new()', meaning: 'Statement terminators. Either works; mix freely.' },
  ];

  // Cable-type lookup — used to color tags in the per-module reference.
  function cableTag(t: string): string {
    return `cable cable-${t}`;
  }
</script>

<svelte:head>
  <title>LIVECODE · modules · patchtogether.live</title>
  <meta name="description" content="Text-DSL module that spawns and patches modules from a small live-coding language." />
</svelte:head>

<section class="hero">
  <h1>LIVECODE</h1>
  <div class="sub">
    <code>livecode</code> · utilities · text-DSL module
  </div>
</section>

<p>
  LIVECODE is a side-tool module that mutates the rack from a small text DSL.
  Spawn modules, draw patch cables, set knob values, and write sequence arrays
  — all from a textarea on a card. Designed for live coding, repeatable
  set-ups, and bulk module wiring without click-fatigue.
</p>

<p>
  The card has no audio I/O. Drop it onto your canvas like any other module,
  type a script, hit <strong>Run</strong>, and the rack reshapes itself.
  Mutations are transactional: a parse or eval error means <em>nothing</em>
  changes — the existing rack is untouched.
</p>

<h2>Syntax reference</h2>

<p>
  The DSL is line-oriented. Each line is one statement; statements end at
  newlines or a <code>;</code>. The grammar fits on one screen.
</p>

<table class="syntax-table">
  <thead>
    <tr><th>Form</th><th>Example</th><th>Meaning</th></tr>
  </thead>
  <tbody>
    {#each SYNTAX_ROWS as r (r.form)}
      <tr>
        <td><code>{r.form}</code></td>
        <td><code>{r.example}</code></td>
        <td>{r.meaning}</td>
      </tr>
    {/each}
  </tbody>
</table>

<h3>Symbol resolution</h3>
<ul>
  <li><strong>Local variables</strong> — anything bound with <code>x = …</code> in this script.</li>
  <li><strong>Rack names</strong> — every module has a unique <code>node.data.name</code>
    (default <code>&lt;TYPE&gt;&lt;N&gt;</code>, e.g. <code>ANALOGVCO1</code>). The
    DSL resolves names case-insensitively, so <code>ANALOGVCO1.tune = 12</code>
    works from any LIVECODE on the rack.</li>
  <li><strong>Module types</strong> — the registry's identifiers (case-insensitive),
    one of: {modules.map((m) => m.type).join(', ')}.</li>
</ul>

<h3>Notes &amp; numbers</h3>
<ul>
  <li>Notes are <code>&lt;letter&gt;[#|b]&lt;octave&gt;</code> — examples:
    <code>c3</code>, <code>d4#</code>, <code>gb2</code>, <code>a4</code>.
    They map to MIDI numbers (a4 = 69, c4 = 60).</li>
  <li>Numbers are integers or floats: <code>440</code>, <code>0.4</code>, <code>-3.5</code>.</li>
  <li>Inside an array, the bare <code>-</code> marks an empty step (e.g.
    <code>[c3, -, -, d4]</code>).</li>
</ul>

<h2>Examples</h2>

<h3>Simplest — spawn one module + change a param</h3>
<pre><code>{SIMPLEST_DSL}</code></pre>

<h3>Two-module patch — LFO modulating a VCO</h3>
<pre><code>{TWO_MODULE_DSL}</code></pre>

<h3>"Load example" patch, recreated in DSL</h3>
<p>
  This is the same patch the topbar's <strong>Load example</strong> button
  builds: a Sequencer driving an Analog VCO + ADSR + VCA into the Audio Out,
  with an 8-note C-major motif at 180 BPM. The DSL recreation is bit-for-bit
  isomorphic — same nodes, same ports, same params (less the absolute
  positions, which the DSL doesn't speak).
</p>
<pre><code>{LOAD_EXAMPLE_DSL}</code></pre>

<h3>Drum machine — drumseqz + drummergirl + clock</h3>
<pre><code>{DRUMS_DSL}</code></pre>

<h2>Reference: per-module addressable surface</h2>

<p>
  Every module's port + param ids, ready to drop into a DSL script.
  Auto-generated from <code>module-registry.ts</code> at build time.
</p>

<div class="cat-list">
  {#each cats as c (c)}
    <a href="#{c}">{c} ({byCat[c].length})</a>
  {/each}
</div>

{#each cats as c (c)}
  <section class="cat-section" id={c}>
    <h3>{c}</h3>
    <div class="ref-grid">
      {#each byCat[c] as m (m.type)}
        <article class="ref-card" data-module-type={m.type}>
          <header class="head">
            <span class="name"><a href="/docs/modules/{m.type}">{m.label}</a></span>
            <code class="type">{m.type}</code>
          </header>
          <p class="desc">{m.description}</p>
          {#if m.outputs.length > 0}
            <h4>outputs</h4>
            <ul class="port-list">
              {#each m.outputs as p (p.id)}
                <li>
                  <code>{p.id}</code>
                  <span class={cableTag(p.type)}>{p.type}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if m.inputs.length > 0}
            <h4>inputs</h4>
            <ul class="port-list">
              {#each m.inputs as p (p.id)}
                <li>
                  <code>{p.id}</code>
                  <span class={cableTag(p.type)}>{p.type}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if m.params.length > 0}
            <h4>params</h4>
            <ul class="port-list">
              {#each m.params as p (p.id)}
                <li>
                  <code>{p.id}</code>
                  <span class="rng">{p.min ?? '?'}..{p.max ?? '?'}{p.units ? p.units : ''}</span>
                </li>
              {/each}
            </ul>
          {/if}
          <details>
            <summary>example dsl</summary>
            <pre><code>x = {m.type}.new()
{#if m.params.length > 0}x.{m.params[0]!.id} = {m.params[0]!.defaultValue ?? 0}
{/if}{#if m.outputs.length > 0 && m.inputs.length > 0}x.{m.outputs[0]!.id} -> x.{m.inputs[0]!.id}
{/if}</code></pre>
          </details>
        </article>
      {/each}
    </div>
  </section>
{/each}

<h2>Limitations &amp; roadmap</h2>
<ul>
  <li>The editor is a plain <code>&lt;textarea&gt;</code>. Syntax highlighting + autocomplete (CodeMirror) is deferred.</li>
  <li>No conditionals, loops, functions, or arithmetic. Each statement does exactly one thing.</li>
  <li>No <em>delete</em> primitive yet. Spawn-only — to remove a module, right-click it on the canvas.</li>
  <li>No collaborative editing inside the textarea (multi-caret CRDT). Two users typing on the same LIVECODE see last-write-wins on commit.</li>
  <li>No multiplayer presence on the cursor inside the editor. Other rack-mates do see the spawned modules + patch cables in real time.</li>
  <li>String values are not yet supported. Numbers + notes + arrays only.</li>
  <li>Comments are line comments only (<code>//</code>). No block comments.</li>
</ul>

<style>
  .syntax-table {
    width: 100%;
    margin: 1rem 0 2rem;
  }
  .syntax-table th {
    text-align: left;
  }
  .syntax-table code {
    white-space: nowrap;
  }
  .ref-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
    margin: 0.5rem 0 2rem;
  }
  .ref-card {
    border: 1px solid var(--doc-border-dim);
    background: var(--doc-bg);
    padding: 12px 14px 14px;
  }
  .ref-card .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid var(--doc-border-dim);
    padding-bottom: 4px;
    margin-bottom: 8px;
  }
  .ref-card .name {
    font-weight: 500;
    color: var(--doc-accent);
  }
  .ref-card .name a {
    color: inherit;
  }
  .ref-card .type {
    font-size: 0.7em;
    color: var(--doc-fg-dim);
  }
  .ref-card .desc {
    font-size: 0.78em;
    color: var(--doc-fg);
    margin: 0 0 8px;
  }
  .ref-card h4 {
    font-family: var(--doc-mono);
    font-size: 0.66em;
    color: var(--doc-accent-dim);
    margin: 8px 0 2px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .port-list {
    list-style: none;
    padding: 0;
    margin: 0 0 4px;
  }
  .port-list li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 1px 0;
    font-size: 0.72em;
  }
  .port-list li code {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--doc-fg);
  }
  .cable {
    font-size: 0.62em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--doc-fg-dim);
    border: 1px solid var(--doc-border-dim);
    padding: 1px 5px;
    border-radius: 2px;
  }
  .cable-audio  { border-color: #fbbf24; color: #fbbf24; }
  .cable-pitch  { border-color: #6effd6; color: #6effd6; }
  .cable-gate   { border-color: #ff3df0; color: #ff3df0; }
  .cable-cv     { border-color: #ff8a00; color: #ff8a00; }
  .cable-polyPitchGate { border-color: #a78bfa; color: #a78bfa; }
  .rng {
    font-size: 0.7em;
    color: var(--doc-fg-dim);
  }
  details summary {
    cursor: pointer;
    color: var(--doc-fg-dim);
    font-size: 0.72em;
    margin-top: 6px;
  }
  details pre {
    margin-top: 4px;
    font-size: 0.72em;
  }
</style>
