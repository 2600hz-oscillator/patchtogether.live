<script lang="ts">
  // CLIP PLAYER + monome grid — usage guide.
  //
  // Operator-style: how to build note clips, launch them, and drive the whole
  // thing from a monome grid 128 (browser-native WebSerial, no helper app).
  // LED-state colours + the grid layout are the single source of truth from
  // the Phase-3 mapping so the doc never drifts from what the grid renders.
  import {
    LED_LOADED,
    LED_PLAYING,
    LED_QUEUED_HI,
    LED_STOP_ACTIVE,
  } from '$lib/grid/grid-clip-map';

  // LED legend — level (0-15) → a greyscale swatch so the doc shows the actual
  // varibright brightness the grid lights.
  const LED_STATES: { label: string; level: number; note: string }[] = [
    { label: 'Empty', level: 0, note: 'no clip in this slot' },
    { label: 'Loaded', level: LED_LOADED, note: 'a clip is here, stopped' },
    { label: 'Queued', level: LED_QUEUED_HI, note: 'blinks until the next boundary, then plays' },
    { label: 'Playing', level: LED_PLAYING, note: 'running now (blinks down when a stop is queued)' },
    { label: 'STOP pad', level: LED_STOP_ACTIVE, note: 'bottom-right; press to stop the playing clip' },
  ];
  const swatch = (level: number) => {
    const v = Math.round((level / 15) * 255);
    return `rgb(${v},${v},${v})`;
  };
</script>

<svelte:head>
  <title>Clip player + monome grid · modules · patchtogether.live</title>
  <meta
    name="description"
    content="Build note clips and launch them from a monome grid 128 — browser-native (WebSerial, no helper app). Session-view layout, quantized launch, LED feedback."
  />
</svelte:head>

<section class="hero">
  <h1>Clip player + monome grid</h1>
  <p class="lede">
    The <strong>clip player</strong> is a clip-launcher sequencer — an Ableton
    Session-view over a 64-slot clip page. Build small <strong>note clips</strong>,
    then launch them (quantized to the beat) from the card or from a
    <strong>monome grid 128</strong>. The grid talks to the browser directly over
    WebSerial — <strong>no companion app, no serialosc</strong>.
  </p>
</section>

<h2>Quick start (no grid needed)</h2>
<ol>
  <li>Add a <strong>clip player</strong> (Add module → Audio → sequencers).</li>
  <li>
    Click an empty pad in the card's 8×8 grid to create a clip, then paint notes
    in the editor below it (rows = pitch, columns = step; in-key by default).
  </li>
  <li>
    Drive a voice with it: open the card's <em>PATCH PANEL</em> and patch
    <code>PITCH</code> → a VCO's pitch and <code>GATE</code> → a VCA's CV (with the
    VCO through the VCA), then the VCA → your output. Patch <code>VELOCITY</code>
    into the VCA/ADSR amount for dynamics.
  </li>
  <li>
    Patch <code>TIMELORDE</code> (a clock division, e.g. <code>1/16</code>) →
    <code>CLOCK IN</code> to lock the step tempo to the rack clock.
  </li>
  <li>
    Click a loaded pad to launch it. With <code>QNT</code> on it takes over on the
    next clip-loop boundary; with it off it fires immediately. Click the playing
    pad (or <code>■</code>) to stop.
  </li>
</ol>
<p class="aside">
  v1 plays <strong>one clip at a time</strong> — launching another quantize-switches
  to it (the 64 slots are 64 patterns you flip between). Simultaneous multi-track
  playback is a planned follow-up.
</p>

<h2>The card</h2>
<ul>
  <li><strong>Launch grid (8×8)</strong> — click empty = create a clip, click loaded = launch/queue, click the playing one = stop. The selected clip is outlined for editing.</li>
  <li><strong>Note editor</strong> — a Deluge-style piano-roll for the selected clip: X = step, Y = pitch. Rows are scale degrees (in-key) by default; use the <code>−</code>/<code>+</code> buttons to shift octave. A playhead column tracks the beat while it plays.</li>
  <li><strong>Transport</strong> — <code>BPM</code> (internal tempo when CLOCK IN is unpatched), <code>OCT</code> (transpose), <code>GATE</code> (note duty cycle), <code>QNT</code> (quantize launch to the clip boundary), and <code>■</code> (stop all).</li>
</ul>

<h2>Connecting a monome grid</h2>
<p>
  Requirements: a <strong>Chromium browser</strong> (Chrome/Edge/Brave — WebSerial
  is not in Safari) and a <strong>classic FTDI monome grid 128</strong> (the
  2011–2017 varibright editions; the newer USB-C edition isn't supported yet).
</p>
<ol>
  <li>Plug the grid in over USB.</li>
  <li>On the clip-player card, click <strong>GRID</strong> and pick the grid's serial port in the browser prompt.</li>
  <li>That card is now bound to the grid (remembered per machine). Click <strong>GRID</strong> again to disconnect.</li>
</ol>
<p class="aside">
  The grid is <em>your</em> hardware: the serial I/O and LED feedback are local to
  your browser. Which clips are playing <strong>syncs</strong> to everyone in the
  rack, so collaborators hear the same session.
</p>

<h2>Grid layout (Session mode)</h2>
<div class="grid-diagram" aria-label="monome grid 128 layout: left 8x8 clips, right quadrant controls">
  <div class="quad clips">
    <span class="quad-label">64 clips — 8 tracks × 8 scenes</span>
  </div>
  <div class="quad controls">
    <span class="quad-label">controls</span>
    <span class="stop-cell" title="STOP pad">STOP</span>
  </div>
</div>
<p class="caption">
  The grid is 16 wide × 8 tall. The <strong>left 8×8</strong> is the 64 clip slots
  (row-major); the <strong>right 8×8</strong> is for controls — v1 lights one, the
  <strong>STOP</strong> pad in the bottom-right corner. The rest stay dark, reserved
  for note-edit + scenes (coming next).
</p>

<h2>LED feedback</h2>
<table>
  <thead>
    <tr><th>State</th><th>LED</th><th>Meaning</th></tr>
  </thead>
  <tbody>
    {#each LED_STATES as s (s.label)}
      <tr>
        <td>{s.label}</td>
        <td><span class="led" style="background:{swatch(s.level)}"></span> level {s.level}</td>
        <td>{s.note}</td>
      </tr>
    {/each}
  </tbody>
</table>

<h2>Launching from the grid</h2>
<ul>
  <li><strong>Press a loaded pad</strong> → launch it (or queue a stop if it's the one playing). Quantized to the clip boundary when <code>QNT</code> is on.</li>
  <li><strong>Press the STOP pad</strong> (bottom-right) → stop the playing clip.</li>
  <li><strong>Empty pads do nothing on the grid</strong> — create clips from the card (note editing on the pads is the next phase).</li>
</ul>

<h2>What's coming</h2>
<ul>
  <li><strong>Note-edit on the pads</strong> — selecting a note clip turns the grid into a Deluge piano-roll (X = step, Y = pitch) so you can write notes without the mouse.</li>
  <li><strong>Scenes</strong> — launch a whole row at once; more control pads in the right quadrant.</li>
  <li><strong>More clip kinds</strong> — audio loops and patch snapshots alongside note clips, plus recording into slots.</li>
</ul>

<h2>What to read next</h2>
<ul>
  <li><a href="/docs/modules/clipplayer">clip player</a> — the module's ports, params, and source.</li>
  <li><a href="/docs/modules">Module catalog</a> — every module, its I/O, params, source link.</li>
</ul>

<style>
  .lede { font-size: 1.05rem; line-height: 1.6; }
  .aside { opacity: 0.8; font-style: italic; }
  .caption { opacity: 0.85; font-size: 0.92rem; }
  .led {
    display: inline-block;
    width: 14px; height: 14px;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    vertical-align: middle;
    margin-right: 4px;
  }
  .grid-diagram {
    display: flex;
    gap: 6px;
    max-width: 520px;
    margin: 12px 0;
  }
  .quad {
    position: relative;
    flex: 1;
    aspect-ratio: 1 / 1;
    border: 1px solid var(--border, #444);
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .quad.clips {
    background:
      repeating-linear-gradient(0deg, transparent 0 11%, rgba(255, 255, 255, 0.08) 11% 12.5%),
      repeating-linear-gradient(90deg, transparent 0 11%, rgba(255, 255, 255, 0.08) 11% 12.5%),
      rgba(100, 200, 255, 0.12);
  }
  .quad.controls {
    background: rgba(255, 255, 255, 0.03);
  }
  .quad-label {
    font-size: 0.8rem;
    opacity: 0.85;
    padding: 4px;
  }
  .stop-cell {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.6rem;
    font-weight: 600;
    color: #111;
    background: #ccc;
    border-radius: 2px;
    padding: 2px 3px;
  }
</style>
