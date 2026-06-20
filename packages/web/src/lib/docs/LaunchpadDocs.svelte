<script lang="ts">
  // LAUNCHPAD MK3 — shared, colour-coded in-app guide. Rendered by BOTH the
  // /docs/modules/launchpadControlLeft and /docs/modules/launchpadControlRight
  // routes (right-click a card → "View docs" opens the matching one). The
  // colour swatches import the LIVE map constants, so the doc never drifts from
  // what the firmware is actually sent.
  import {
    RGB_LOADED,
    RGB_PLAYING,
    RGB_QUEUED,
    RGB_QUEUED_STOP,
    RGB_RECORDING,
    RGB_SCENE,
    RGB_STOP_IDLE,
    RGB_STOP_ACTIVE,
    RGB_FUNC,
    RGB_FUNC_ON,
    RGB_TRANSPORT_ON,
    RGB_COPY_BUFFER,
    RGB_NOTE_BY_VEL,
    RGB_NOTE_PLAYHEAD,
    RGB_PLAYHEAD_WASH,
    RGB_EXIT,
    type Rgb,
  } from '$lib/control/launchpad/launchpad-map';

  // Render the EXACT RGB the firmware receives (0..127 → 0..255 for the swatch).
  const hex = (c: Rgb) =>
    `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;

  const SESSION_COLORS: { state: string; rgb: Rgb; anim: string; note: string }[] = [
    { state: 'empty slot', rgb: [0, 0, 0], anim: 'off', note: 'no clip here' },
    { state: 'loaded clip', rgb: RGB_LOADED, anim: 'static dim', note: 'has notes, stopped' },
    { state: 'playing', rgb: RGB_PLAYING, anim: 'pulse green', note: 'running now' },
    { state: 'queued-launch', rgb: RGB_QUEUED, anim: 'flash green', note: 'waiting for the loop boundary' },
    { state: 'queued-stop', rgb: RGB_QUEUED_STOP, anim: 'flash red', note: 'will stop on the boundary' },
    { state: 'record-armed', rgb: RGB_RECORDING, anim: 'pulse red', note: 'arranger record-arm' },
    { state: 'copy buffer', rgb: RGB_COPY_BUFFER, anim: 'pulse turquoise', note: 'the clip in your clipboard' },
    { state: 'scene launch', rgb: RGB_SCENE, anim: 'amber', note: 'L right column — fire a slot everywhere' },
    { state: 'stop lane (idle)', rgb: RGB_STOP_IDLE, anim: 'dim red', note: 'R right column' },
    { state: 'stop lane (playing)', rgb: RGB_STOP_ACTIVE, anim: 'bright red', note: 'R right column, lane audible' },
  ];

  const DECK_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'function idle', rgb: RGB_FUNC, note: 'DOUBLE / LENGTH / nav' },
    { state: 'held modifier', rgb: RGB_FUNC_ON, note: 'EDIT / COPY / PASTE / NOW / SHIFT held' },
    { state: 'transport / FOLLOW on', rgb: RGB_TRANSPORT_ON, note: 'running / auto-scroll' },
    { state: 'EXIT', rgb: RGB_EXIT, note: 'editor / length-page exit (top scene button)' },
  ];

  const EDITOR_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'note · low vel', rgb: RGB_NOTE_BY_VEL[0], note: '≈0–20%' },
    { state: 'note · med vel', rgb: RGB_NOTE_BY_VEL[1], note: '≈40–60%' },
    { state: 'note · high vel', rgb: RGB_NOTE_BY_VEL[2], note: '≈80–100%' },
    { state: 'note under playhead', rgb: RGB_NOTE_PLAYHEAD, note: 'yellow boost on the playing step' },
    { state: 'playhead wash', rgb: RGB_PLAYHEAD_WASH, note: 'the moving step column' },
  ];

  // pad / CC reference (owner-confirmed hardware facts).
  const PAD_MAP: { what: string; addr: string }[] = [
    { what: '8×8 pads (programmer mode)', addr: 'note = row*10 + col · 11 = bottom-left · 88 = top-right' },
    { what: 'top row ▲ ▼ ◀ ▶ ▣(SHIFT)', addr: 'CC 91 · 92 · 93 · 94 · 95' },
    { what: 'top row spare / globals', addr: 'CC 96 · 97 · 98' },
    { what: 'right scene column (top→bottom)', addr: 'CC 89 · 79 · 69 · 59 · 49 · 39 · 29 · 19' },
    { what: 'logo LED', addr: 'CC 99' },
    { what: 'enter programmer mode', addr: 'F0 00 20 29 02 0D 0E 01 F7' },
    { what: 'exit to Live mode', addr: 'F0 00 20 29 02 0D 0E 00 F7' },
    { what: 'per-LED full RGB', addr: 'F0 00 20 29 02 0D 03  03 <pad> <R> <G> <B>  F7   (R/G/B 0–127)' },
  ];
</script>

<section class="hero">
  <h1>Launchpad Mini Mk3 — clip launcher (L + R)</h1>
  <p class="lede">
    Two <strong>Novation Launchpad Mini Mk3</strong> units drive the
    <strong>clip player</strong> over browser-native <strong>Web MIDI</strong> (no helper app).
    The <strong>left</strong> unit is the always-live <strong>8×8 clip matrix</strong>; the
    <strong>right</strong> unit is the <strong>command deck</strong> and flips to the
    <strong>note editor</strong> while you edit — so you never lose the matrix.
  </p>
</section>

<h2>Pairing the two units</h2>
<ol>
  <li>Add a <strong>launchpad control left</strong> <em>and</em> a <strong>launchpad control right</strong> module, plus a <strong>clip player</strong>.</li>
  <li>Click <strong>Pair Launchpads</strong> on either card. The browser asks for MIDI access (sysex) on the first click.</li>
  <li>Both units light a centred <strong>dice-5</strong> prompt. <strong>Press a pad on the unit you want as LEFT</strong> (the matrix). The other becomes RIGHT.</li>
  <li>Click <strong>Bind to clip-player</strong>. Both port ids + the bound clip-player are saved per-machine, so a reload restores the pair without re-prompting.</li>
</ol>
<p class="muted">
  Bind the unit's <code>… MIDI</code> port (not the <code>… DAW</code> port — programmer mode lives on MIDI).
  Give the two units distinct device IDs so they enumerate as separate ports.
</p>

<h2>Unit L — the clip matrix (always live)</h2>
<ul>
  <li><strong>Rows = lanes, columns = slots.</strong> Pad note 11..88; pad <code>(slot, lane)</code> is clip <code>lane*8 + slot</code>.</li>
  <li><strong>Tap a clip</strong> → launch it in its lane (or stop the lane if it's the one playing) on the next quantize boundary. Hold <strong>NOW</strong> on R to fire immediately.</li>
  <li><strong>Right scene column</strong> → fire that slot across <em>all</em> lanes (an Ableton scene).</li>
  <li>The matrix <strong>stays live even while you edit</strong> — editing happens on Unit R.</li>
</ul>

<h2>Unit R — the command deck</h2>
<p>Row 0 (bottom) holds the deck controls, left→right:</p>
<ul>
  <li><strong>EDIT</strong> (hold) — hold + tap a clip on L to open its note editor on R.</li>
  <li><strong>COPY / PASTE / PASTE-REV</strong> (hold) — hold + tap a clip on L to copy / paste / paste-reversed from a per-machine buffer.</li>
  <li><strong>COPY-IND</strong> — pulses turquoise while the buffer holds a clip (the copy source also glows on L).</li>
  <li><strong>DOUBLE</strong> — duplicate the pattern into the back half + double the length (cap 128).</li>
  <li><strong>LENGTH</strong> — open the 2-row length page (end-block + end-step rulers).</li>
  <li><strong>NOW</strong> (hold) — launches fire immediately, ignoring quantize.</li>
  <li><strong>Right scene column</strong> = per-lane <strong>STOP</strong>. <strong>Top row</strong>: CC 96 = transport, CC 97 = stop-all.</li>
</ul>

<h2>Unit R — the note editor + SHIFT windowing</h2>
<ul>
  <li>The full <strong>8×8</strong> is the note grid: <strong>X = step</strong> (an 8-step window = half a 16-step block), <strong>Y = pitch</strong> (8 in-key rows, bottom = lowest).</li>
  <li><strong>Tap</strong> a pad to toggle a note; <strong>hold a note + tap another in the same row</strong> to tie a held span.</li>
  <li><strong>▲ ▼</strong> scroll pitch ±1 row; <strong>◀ ▶</strong> scroll the step window ±1. <strong>Hold SHIFT (▣, CC 95)</strong> and they jump a full screen (±8). SHIFT only magnifies + rescopes a gesture — it never replaces one.</li>
  <li>Top row: <strong>VEL</strong> (CC 96, hold + tap to cycle a note's velocity), <strong>SCALE</strong> (CC 97), <strong>FOLLOW</strong> (CC 98, auto-scroll the shown block with the playhead — green = on).</li>
  <li><strong>EXIT</strong> = the top button of the right scene column.</li>
</ul>

<h2>LED colour language</h2>
<p class="muted">Every swatch is the exact RGB the firmware receives (type-3 lighting SysEx, 0–127 per channel). State always wins over a clip's own tint; pulse/flash animate on the binding's ~2 Hz blink.</p>

<h3>Session (matrix + decks)</h3>
<div class="swatch-grid">
  {#each SESSION_COLORS as c (c.state)}
    <div class="swatch-row">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-anim">{c.anim}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<h3>Command deck</h3>
<div class="swatch-grid">
  {#each DECK_COLORS as c (c.state)}
    <div class="swatch-row">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<h3>Note editor</h3>
<div class="swatch-grid">
  {#each EDITOR_COLORS as c (c.state)}
    <div class="swatch-row">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<h2>Pad + CC reference (confirmed hardware)</h2>
<table class="map">
  <tbody>
    {#each PAD_MAP as r (r.what)}
      <tr><td class="m-what">{r.what}</td><td class="m-addr"><code>{r.addr}</code></td></tr>
    {/each}
  </tbody>
</table>

<style>
  .hero { margin-bottom: 1.5rem; }
  .lede { color: var(--muted, #9aa0b2); line-height: 1.5; max-width: 60ch; }
  .muted { color: var(--muted, #9aa0b2); font-size: 0.9rem; }
  h2 { margin-top: 1.8rem; }
  h3 { margin-top: 1rem; color: var(--muted, #9aa0b2); font-size: 0.95rem; }
  .swatch-grid { display: flex; flex-direction: column; gap: 4px; margin: 0.5rem 0 1rem; }
  .swatch-row { display: grid; grid-template-columns: 24px 160px 110px 1fr; align-items: center; gap: 10px; font-size: 0.85rem; }
  .chip { width: 22px; height: 22px; border-radius: 5px; border: 1px solid #2b2e38; display: inline-block; }
  .s-state { font-weight: 600; }
  .s-anim { color: var(--muted, #9aa0b2); font-style: italic; }
  .s-note { color: var(--muted, #9aa0b2); }
  table.map { border-collapse: collapse; margin: 0.5rem 0 1.5rem; width: 100%; }
  table.map td { padding: 5px 10px; border-bottom: 1px solid #2a2d36; vertical-align: top; }
  .m-what { font-weight: 600; white-space: nowrap; }
  .m-addr code { font-size: 0.8rem; color: var(--muted, #cfd3df); }
</style>
