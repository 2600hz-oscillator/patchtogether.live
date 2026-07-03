<script lang="ts">
  // LIVECODE — JS-runtime module docs (v2).
  //
  // Sections:
  //   1. Intro
  //   2. API reference (table, sourced from $lib/livecode/api-surface)
  //   3. Examples (incl. sidechain via clocked() + ADSR.env_inv)
  //   4. Per-module addressable surface (from module-manifest, audio
  //      domain only)
  //   5. Limitations + roadmap

  import type { ManifestModule } from '$lib/docs/module-manifest';
  import { LIVECODE_API, CLOCKED_DIVISIONS } from '$lib/livecode/api-surface';

  let { data } = $props();
  const manifest = $derived(data.manifest);
  const modules = $derived<ManifestModule[]>(manifest.modules);

  // Order the addressable-surface section by category.
  const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];
  const byCat = $derived.by(() => {
    const out: Record<string, ManifestModule[]> = {};
    for (const m of modules) {
      if (m.type === 'livecode' || m.type === 'clockedRunner') continue;
      (out[m.category] ??= []).push(m);
    }
    return out;
  });
  const cats = $derived(
    CAT_ORDER.filter((c) => byCat[c]).concat(
      Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)),
    ),
  );

  // Worked example: the sidechain ducker the user requested. VCO →
  // VCA; ADSR's INVERTED envelope drives the VCA cv; the drum
  // sequencer (DRUMSEQZ gate1) fires the ADSR. Every beat → quick
  // volume dip on the VCO — classic sidechain shape.
  const SIDECHAIN_JS = `// Sidechain ducker — VCO plays through VCA; a drum-sequencer gate
// fires an ADSR whose INVERTED envelope (env_inv) modulates the
// VCA's cv, ducking the VCO in time with the beat.

spawn('analogVco', 'lead');
spawn('vca', 'duck');
spawn('adsr', 'ducker');
spawn('drumseqz', 'drums');
spawn('audioOut', 'mainout');

patch('lead.sine',       'duck.audio');
patch('ducker.env_inv',  'duck.cv');
patch('drums.gate1',     'ducker.gate');
patch('duck.audio',      'mainout.L');
patch('duck.audio',      'mainout.R');

// Snappy envelope so the dip is quick + the level returns fast.
set('ducker', 'attack',  0.005);
set('ducker', 'decay',   0.18);
set('ducker', 'sustain', 0);
set('ducker', 'release', 0.05);

// VCA: cv-driven, no DC offset (env_inv idles at 1 → VCA full open
// when no kick has fired yet).
set('duck', 'base',     0);
set('duck', 'cvAmount', 1);

// 120 BPM; toggle a hit on track 1 then run the sequencer so gate1
// fires on the beat.
set('drums', 'bpm',       120);
set('drums', 'isPlaying', 1);`;

  const CLOCKED_JS = `// clocked() — fire a callback every clock division. The clocked()
// call spawns a CLOCKED runner module on the canvas; delete the
// runner to cancel; edit its body inline to change the logic.

clocked('1/16', () => {
  // boolean predicates work the same as any JS — combine reads from
  // multiple modules with && / || / ?:
  if (read('SEQUENCER1', 'stepIndex') === 0) {
    set('SAMSLOOP1', 'gate', 1);
  }
});`;

  const TRANSPORT_JS = `// Master clock control. TIMELORDE is always running so clocked()
// callbacks keep firing; clock.mute() / clock.unmute() only gate
// the gate outputs.

clock.bpm(140);  // set BPM
clock.stop();    // mute clock outputs (callbacks keep firing)
clock.start();   // unmute`;

  const SIMPLEST_JS = `// Simplest: spawn one VCO + Audio Out and route a steady tone.
spawn('analogVco', 'v');
spawn('audioOut',  'o');
patch('v.sine', 'o.L');
patch('v.sine', 'o.R');
set('v', 'tune', 0);`;

  // Full chain: sequencer → ADSR-shaped VCA → VCO into a mixer + audio
  // out, with a DRUMMERGIRL kick fired on every beat, sidechain-ducking
  // the melody via a second ADSR's inverted envelope. A clocked()
  // callback slowly modulates the duck depth using state.* to track
  // a per-tick beat counter.
  const COMPLEX_CHAIN_JS = `// ── 9 modules ───────────────────────────────────────────────────
spawn('sequencer',   'seq');
spawn('analogVco',   'vco');
spawn('adsr',        'env');     // pluck envelope for the melody
spawn('vca',         'amp');     // melody VCA (env-driven)
spawn('vca',         'duck');    // sidechain VCA — kick ducks this one
spawn('adsr',        'sideEnv'); // sidechain envelope (kick-triggered)
spawn('drummergirl', 'kick');
spawn('mixer',       'mix');
spawn('audioOut',    'out');

// ── Main melody chain ───────────────────────────────────────────
patch('seq.pitch', 'vco.pitch');
patch('seq.gate',  'env.gate');
patch('vco.sine',  'amp.audio');
patch('env.env',   'amp.cv');

// ── Sidechain chain ─────────────────────────────────────────────
patch('amp.audio',       'duck.audio');       // melody through sidechain VCA
patch('TIMELORDE1.1x',   'kick.gate');         // kick on every beat
patch('TIMELORDE1.1x',   'sideEnv.gate');      // same trigger envelopes the duck
patch('sideEnv.env_inv', 'duck.cv');           // inverted ADSR ⇒ duck shape

// ── Mix + out ───────────────────────────────────────────────────
patch('duck.audio', 'mix.in1');
patch('kick.audio', 'mix.in2');
patch('mix.audio',  'out.L');
patch('mix.audio',  'out.R');

// ── Knobs ───────────────────────────────────────────────────────
set('env', 'attack',  0.005);
set('env', 'decay',   0.12);
set('env', 'sustain', 0.4);
set('env', 'release', 0.18);

set('amp',  'base', 0);   set('amp',  'cvAmount', 1);  // melody VCA
set('duck', 'base', 0);   set('duck', 'cvAmount', 1);  // duck idles fully open

set('sideEnv', 'attack',  0.001);
set('sideEnv', 'decay',   0.22);
set('sideEnv', 'sustain', 0);
set('sideEnv', 'release', 0.05);

// DRUMMERGIRL dialed in as a kick.
set('kick', 'pitch',  -12);
set('kick', 'tone',   0.18);
set('kick', 'shape',  0.35);
set('kick', 'decay',  0.30);
set('kick', 'volume', 1.5);

set('mix', 'ch1', 0.85); set('mix', 'ch2', 0.95); set('mix', 'master', 0.8);
set('out', 'master', 0.5);

set('seq', 'bpm',       120);
set('seq', 'length',    16);
set('seq', 'isPlaying', 1);

// ── 8-note melody on the sequencer (rest in remaining 8 slots) ─
setData('seq', 'steps', [
  { on: true,  pitch: 60 }, // C4
  { on: false },
  { on: true,  pitch: 64 }, // E4
  { on: false },
  { on: true,  pitch: 67 }, // G4
  { on: false },
  { on: true,  pitch: 72 }, // C5
  { on: false },
  { on: true,  pitch: 67 }, // G4
  { on: false },
  { on: true,  pitch: 64 }, // E4
  { on: false },
  { on: true,  pitch: 60 }, // C4
  { on: false }, { on: false }, { on: false },
]);

// ── Modulate sidechain depth via clocked() + state ─────────────
// Every 1/16 beat: bump a beat counter, sweep depth 0.2..1.0
// over an 8-beat cosine. state.* persists across ticks so we
// don't reset the counter every fire.
clocked('1/16', () => {
  const tick = (state.get('tick') ?? 0) + 1;
  state.set('tick', tick);
  // 16 sixteenths per beat → 128 ticks per 8 beats
  const phase = (tick / 128) * 2 * Math.PI;
  const depth = 0.6 + 0.4 * Math.cos(phase);  // 0.2 .. 1.0
  set('duck', 'cvAmount', depth);
});`;

  // Group API entries by category for a clean docs table.
  const apiByCategory = $derived.by(() => {
    const out: Record<string, typeof LIVECODE_API> = {};
    for (const e of LIVECODE_API) {
      if (e.kind === 'module-shape') continue;
      const cat = e.category;
      (out[cat] ??= [] as typeof LIVECODE_API).push(e);
    }
    return out;
  });

  function cableTag(t: string): string {
    return `cable cable-${t}`;
  }
</script>

<svelte:head>
  <title>LIVECODE · modules · patchtogether.live</title>
  <meta name="description" content="JS-runtime live-coding module — write a script in CodeMirror with port-aware autocomplete, hit Run, the rack reshapes itself." />
</svelte:head>

<section class="hero">
  <h1>LIVECODE</h1>
  <div class="sub">
    <code>livecode</code> · utilities · JS-runtime live-coding module
  </div>
</section>

<p>
  LIVECODE is a side-tool module that mutates the rack from <strong>JavaScript</strong>.
  Spawn modules, draw patch cables, set knob values, schedule callbacks on
  the master clock — all from a CodeMirror editor on a card. Designed for
  live coding, repeatable set-ups, and bulk module wiring without
  click-fatigue.
</p>

<p>
  The card has no audio I/O. Drop it onto your canvas like any other module,
  type a script, hit <strong>Run</strong>, and the rack reshapes itself.
  Mutations are transactional: a parse or runtime error means the
  successfully-emitted mutations are still applied (so partial scripts
  still progress), and the error message points at the offending line.
</p>

<p>
  The editor has <strong>port-aware autocomplete</strong> (typing
  <code>patch('vco1.sine', '</code> suggests only ports that can take an
  audio signal) and <strong>red-underline diagnostics</strong> for
  patches that would fail at Run-time, so you can iterate without
  hitting Run repeatedly.
</p>

<h2>API reference</h2>

{#each Object.entries(apiByCategory) as [cat, entries] (cat)}
  <h3 class="api-cat">{cat}</h3>
  <table class="syntax-table">
    <thead>
      <tr><th>Signature</th><th>Summary</th></tr>
    </thead>
    <tbody>
      {#each entries as e (e.kind === 'fn' || e.kind === 'namespace' ? e.name : 'shape')}
        {#if e.kind === 'fn'}
          <tr>
            <td><code>{e.signature}</code></td>
            <td>{e.summary}</td>
          </tr>
        {:else if e.kind === 'namespace'}
          {#each e.members as m (m.name)}
            <tr>
              <td><code>{m.signature}</code></td>
              <td>{m.summary}</td>
            </tr>
          {/each}
        {/if}
      {/each}
    </tbody>
  </table>
{/each}

<h3>clocked() divisions</h3>
<p>
  Valid first-arg values for <code>clocked(division, fn)</code>:
  {#each CLOCKED_DIVISIONS as d, i (d)}<code>'{d}'</code>{#if i < CLOCKED_DIVISIONS.length - 1}, {/if}{/each}.
  Divisions ≤ 1/64 derive from TIMELORDE's clock outputs; finer
  (1/128, 1/256, 1/512) divide further from the scheduler tick. Period
  is derived from <code>TIMELORDE.bpm</code> every tick so a
  <code>clock.bpm(140)</code> call takes effect on the next tick
  without needing to re-spawn the runner.
</p>

<h2>Examples</h2>

<h3>Simplest — spawn one module + change a param</h3>
<pre><code>{SIMPLEST_JS}</code></pre>

<h3>Master clock — start / stop / set BPM</h3>
<pre><code>{TRANSPORT_JS}</code></pre>

<h3>clocked() — fire a callback per division</h3>
<p>
  Every <code>clocked()</code> call spawns a <strong>CLOCKED runner</strong>
  module on the canvas (auto-named, positioned next to the LIVECODE that
  spawned it). The runner owns the subscription; delete it to cancel.
  You can also edit the body inline on the runner card. Re-running the
  same LIVECODE script updates the existing runner instead of
  spawning duplicates.
</p>
<pre><code>{CLOCKED_JS}</code></pre>

<h3>Full chain — sequencer + ADSR + VCA + VCO + DRUMMERGIRL + clocked sidechain</h3>
<p>
  Real-world script: a melody sequencer drives a VCO through an ADSR + VCA, a
  DRUMMERGIRL kick fires on every TIMELORDE beat, the kick's <code>1x</code>
  output drives a second ADSR whose <code>env_inv</code> output ducks a
  sidechain VCA — and a <code>clocked()</code> callback uses <code>state.*</code>
  to track a beat counter and breathes the ducking depth between 0.2 and
  1.0 over an 8-beat cosine.
</p>
<pre><code>{COMPLEX_CHAIN_JS}</code></pre>

<h3>Minimal sidechain — VCO + VCA + ADSR.env_inv + DRUMSEQZ gate</h3>
<p>
  The classic sidechain ducker, wired from a single script. The
  inverted ADSR envelope (<code>env_inv</code>, available on every ADSR)
  idles at 1.0 (VCA full-open) and DIPS to 0 when the kick fires,
  pumping the VCO's volume in time with the drums.
</p>
<pre><code>{SIDECHAIN_JS}</code></pre>

<h2>Reference: per-module addressable surface</h2>

<p>
  Every module's port + param ids, ready to drop into a script.
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
            <summary>example js</summary>
            <pre><code>spawn('{m.type}', 'x');
{#if m.params.length > 0}set('x', '{m.params[0]!.id}', {m.params[0]!.defaultValue ?? 0});
{/if}{#if m.outputs.length > 0 && m.inputs.length > 0}patch('x.{m.outputs[0]!.id}', 'x.{m.inputs[0]!.id}');
{/if}</code></pre>
          </details>
        </article>
      {/each}
    </div>
  </section>
{/each}

<h2>Limitations &amp; roadmap</h2>
<ul>
  <li>Per-tick reads (<code>read('vco1', 'outputPeak.sine')</code>) for engine analyser taps are deferred — only patch-graph reads work today.</li>
  <li>The sandbox is <code>new Function</code>-based — it's not a hard security boundary. A determined user can escape via <code>this.constructor.constructor('return process')()</code>. For a LOCAL-USER-OWNS-THEIR-OWN-RACK tool this is acceptable; if you ever embed LIVECODE in a multi-tenant context, replace the sandbox with a Web Worker isolate.</li>
  <li>No collaborative editing inside the CodeMirror editor (multi-caret CRDT). Two users typing on the same LIVECODE see last-write-wins on commit-debounce.</li>
  <li>MIDI-locked clock: <code>clocked()</code> uses <code>TIMELORDE.bpm</code> as the source of truth. When TIMELORDE is locked to MIDICLOCK its bpm param reflects the locked rate, so this Just Works™ — but the docs page hasn't been verified against every MIDI device.</li>
</ul>

<style>
  .syntax-table {
    width: 100%;
    margin: 1rem 0 2rem;
  }
  .syntax-table th { text-align: left; }
  .syntax-table code { white-space: nowrap; }
  .api-cat {
    text-transform: capitalize;
    color: var(--doc-accent);
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
  .ref-card .name { font-weight: 500; color: var(--doc-accent); }
  .ref-card .name a { color: inherit; }
  .ref-card .type { font-size: 0.7em; color: var(--doc-fg-dim); }
  .ref-card .desc { font-size: 0.78em; color: var(--doc-fg); margin: 0 0 8px; }
  .ref-card h4 {
    font-family: var(--doc-mono);
    font-size: 0.66em;
    color: var(--doc-accent-dim);
    margin: 8px 0 2px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .port-list { list-style: none; padding: 0; margin: 0 0 4px; }
  .port-list li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 1px 0;
    font-size: 0.72em;
  }
  .port-list li code { background: transparent; border: 0; padding: 0; color: var(--doc-fg); }
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
  .rng { font-size: 0.7em; color: var(--doc-fg-dim); }
  details summary {
    cursor: pointer;
    color: var(--doc-fg-dim);
    font-size: 0.72em;
    margin-top: 6px;
  }
  details pre { margin-top: 4px; font-size: 0.72em; }
</style>
