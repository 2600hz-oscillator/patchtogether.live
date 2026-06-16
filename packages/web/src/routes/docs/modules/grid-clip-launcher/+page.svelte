<script lang="ts">
  // CLIP PLAYER + monome grid — the module's own usage guide.
  //
  // Operator-style: build note clips, launch them per-instrument, edit them on
  // the pads, and drive the whole thing from a monome grid 128 (browser-native
  // WebSerial, no helper app). The grid LAYOUT + LED colours are imported from
  // the live grid mapping so the doc never drifts from what the grid renders.
  import {
    LED_LOADED,
    LED_PLAYING,
    LED_QUEUED_HI,
    LED_STOP_ACTIVE,
    LED_SCENE_IDLE,
    LED_EDIT_PAD,
    LED_TRANSPORT_ON,
    LED_NOTE_BRIGHTNESS,
    CTRL_STOP_COL,
    CTRL_SCENE_COL,
    EDIT_PAD,
    STOPALL_PAD,
    TRANSPORT_PAD,
  } from '$lib/grid/grid-clip-map';

  const swatch = (level: number) => {
    const v = Math.round((level / 15) * 255);
    return `rgb(${v},${v},${v})`;
  };

  // Session-mode LED legend (driven by the real mapping constants).
  const LED_STATES: { label: string; level: number; note: string }[] = [
    { label: 'Empty', level: 0, note: 'no clip in this slot' },
    { label: 'Loaded', level: LED_LOADED, note: 'a clip lives here, stopped' },
    { label: 'Queued', level: LED_QUEUED_HI, note: 'blinks until the lane loop boundary, then plays' },
    { label: 'Playing', level: LED_PLAYING, note: 'running now (blinks down when a stop is queued)' },
    { label: 'STOP col', level: LED_STOP_ACTIVE, note: 'col 8 — brighter on a lane that is playing' },
    { label: 'SCENE col', level: LED_SCENE_IDLE, note: 'col 9 — fire a whole column across all lanes' },
    { label: 'EDIT', level: LED_EDIT_PAD, note: 'top-right — hold + tap a clip to edit it' },
    { label: 'TRANSPORT', level: LED_TRANSPORT_ON, note: 'bottom-right — bright while TIMELORDE runs' },
  ];

  // Edit-mode velocity. The VEL-hold cycle steps through SIX levels
  // (≈0/20/40/60/80/100%), but the grid shows them as THREE note colours — two
  // levels per colour (the grid's 4 colours, one of which is dark = empty).
  const VEL_PCTS = ['0 / 20%', '40 / 60%', '80 / 100%'];
  const VEL_STATES = LED_NOTE_BRIGHTNESS.map((level, i) => ({ label: VEL_PCTS[i], level }));

  // 16×8 Session-layout map — colour each pad by its role so the diagram is the
  // single source of truth for the binding's coordinates.
  type Role = 'clip' | 'stop' | 'scene' | 'edit' | 'all' | 'transport' | 'dark';
  function role(x: number, y: number): Role {
    if (x < 8) return 'clip';
    if (x === CTRL_STOP_COL) return 'stop';
    if (x === CTRL_SCENE_COL) return 'scene';
    if (x === EDIT_PAD.x && y === EDIT_PAD.y) return 'edit';
    if (x === STOPALL_PAD.x && y === STOPALL_PAD.y) return 'all';
    if (x === TRANSPORT_PAD.x && y === TRANSPORT_PAD.y) return 'transport';
    return 'dark';
  }
  const cells = Array.from({ length: 8 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => ({ x, y, role: role(x, y) })),
  ).flat();
  const laneHue = (y: number) => Math.round((y * 360) / 8);
</script>

<svelte:head>
  <title>Clip player + monome grid · modules · patchtogether.live</title>
  <meta
    name="description"
    content="CLIP PLAYER — an 8-instrument-lane, TIMELORDE-locked clip launcher you drive from a monome grid 128 (browser-native WebSerial, no helper app). Launch, scene, quantize, and edit note clips on the pads."
  />
</svelte:head>

<section class="hero">
  <h1>Clip player + monome grid</h1>
  <p class="lede">
    The <strong>clip player</strong> is an Ableton-Session-style
    <strong>clip launcher</strong> with <strong>8 instrument lanes</strong>. Each
    row is one instrument with its own pitch / gate / velocity outputs, so up to
    <strong>8 clips sound at once</strong>. It locks to <strong>TIMELORDE</strong>
    (the rack clock) and you can run the whole thing — launch, scene, and even
    write notes — from a <strong>monome grid 128</strong> over WebSerial, with
    <strong>no companion app and no serialosc</strong>.
  </p>
</section>

<h2>The mental model in one minute</h2>
<ul>
  <li><strong>Rows = instruments</strong> (8 lanes), <strong>columns = clip slots</strong> (8 per instrument) → 64 note clips.</li>
  <li><strong>Launch a clip</strong> and it swaps into its lane on the next loop boundary (or instantly). Each lane plays one clip at a time; launching a new one replaces it.</li>
  <li>A <strong>scene</strong> is a <em>column</em> — fire it and every instrument launches its clip in that column together.</li>
  <li><strong>No tempo knob.</strong> The clock is TIMELORDE: it runs when TIMELORDE runs, at TIMELORDE's BPM. The only timing control is <strong>STEP</strong> (steps per beat).</li>
</ul>

<h2>Quick start (no grid needed)</h2>
<ol>
  <li>Add a <strong>clip player</strong> (Add module → Audio → sequencers). It also drops a <strong>TIMELORDE</strong> if your rack doesn't have one.</li>
  <li>
    <strong>Double-click</strong> a pad in the card's 8×8 grid to open its note
    editor. <strong>Click</strong> a cell to place a note, <strong>click again</strong>
    to remove it (rows = pitch, in-key; columns = step). <strong>Right-click</strong>
    a cell to cycle its velocity through the 6 levels. Use <code>‹</code> to return
    to the launch grid.
  </li>
  <li>
    Wire that lane to a voice: open the card's <em>PATCH PANEL</em> (the yellow
    corner) and patch <code>PITCH&nbsp;1</code> → a VCO's pitch and
    <code>GATE&nbsp;1</code> → a VCA's CV (VCO → VCA → output). Patch
    <code>VEL&nbsp;1</code> into the VCA/ADSR amount for dynamics. Lanes 2–8 work
    the same on their own <code>PITCH/GATE/VEL&nbsp;n</code>.
  </li>
  <li>
    Press <strong>▶</strong> on the card (it starts TIMELORDE), then
    <strong>single-click</strong> the clip's pad to launch it. With <code>QNT</code>
    on it drops in on the loop boundary; off = immediately. Click the playing pad
    to stop the lane; <strong>■</strong> stops everything.
  </li>
</ol>
<p class="aside">
  If TIMELORDE is slaved to an external clock (a MIDICLOCK into its start/stop),
  the card's ▶/■ transport <strong>hides</strong> — you follow the upstream master
  instead of fighting it.
</p>

<h2>The card</h2>
<ul>
  <li><strong>Session view</strong> (default) — the 8×8 launch grid (rows lane-tinted). Single-click = launch / queue / stop; double-click = open the editor. A small <strong>1/5 button</strong> to the left of each row toggles that instrument lane between <strong>MONO</strong> (one note per column — placing a note replaces what's there) and <strong>POLY</strong> (up to 5 notes per column).</li>
  <li><strong>Edit view</strong> — a piano-roll note editor for one clip: X = step, Y = pitch (scale-degree rows in-key, root at the bottom). Click to place a note (click again to remove); <strong>right-click to cycle its velocity</strong> through 6 levels. Cycle <em>scale</em>, set <em>root</em>, change <em>length</em> (16/32/64/8), scroll the pitch window by a <strong>row</strong> (<code>↑/↓</code>) or an <strong>octave</strong> (<code>⤒/⤓</code>), or <code>⌫</code> clear the clip. A playhead column tracks the beat while the lane plays.</li>
  <li><strong>Params</strong> — <code>STEP</code> (1/4 · 1/8 · 1/16 · 1/32 = steps per beat), <code>OCT</code> (transpose all lanes), <code>GATE</code> (note duty cycle), <code>QNT</code> (quantize launch to the loop boundary).</li>
  <li><strong>Transport</strong> — <code>▶/■</code> drives TIMELORDE (hidden when externally clocked); <code>■</code> in the title bar stops all lanes; <code>GRID</code> connects a monome grid.</li>
</ul>

<h2>Connecting a monome grid</h2>
<p>
  Requirements: a <strong>Chromium browser</strong> (Chrome / Edge / Brave —
  WebSerial isn't in Safari) and a <strong>classic FTDI monome grid 128</strong>
  (the 2011–2017 varibright editions; the newer USB-C edition isn't supported yet).
</p>
<ol>
  <li>Plug the grid in over USB.</li>
  <li>On the card, click <strong>GRID</strong> and pick the grid's serial port in the prompt. The list shows <em>all</em> serial ports (macOS reports the grid without USB vendor info, so it can't be auto-filtered) — choose the <code>usbserial</code> / monome entry.</li>
  <li>The card is now bound to the grid (remembered per machine). Click <strong>GRID</strong> again to disconnect.</li>
</ol>
<p class="aside">
  The grid is <em>your</em> hardware — serial I/O + LEDs are local to your browser.
  Which clips are playing <strong>syncs</strong> to everyone in the rack, so
  collaborators (and a second grid) see the same session.
</p>

<h2>Grid layout (Session mode)</h2>
<div class="gridmap" role="img" aria-label="monome grid 128 layout: left 8 columns are the clip matrix, right columns are controls">
  {#each cells as c (c.x + '-' + c.y)}
    <span
      class="cell {c.role}"
      style={c.role === 'clip' ? `background: hsl(${laneHue(c.y)} 45% 22%)` : ''}
      title={`(${c.x},${c.y}) ${c.role}`}
    >{c.role === 'stop' ? '■' : c.role === 'scene' ? '▷' : c.role === 'edit' ? 'E' : c.role === 'all' ? '⊘' : c.role === 'transport' ? '▶' : ''}</span>
  {/each}
</div>
<p class="caption">
  16 wide × 8 tall. <strong>Cols 0–7</strong> = the clip matrix (each row a tinted
  instrument lane). <strong>Col {CTRL_STOP_COL}</strong> = per-lane STOP,
  <strong>col {CTRL_SCENE_COL}</strong> = SCENE launch (row y fires slot y across
  all lanes). Top-right <strong>E</strong> = EDIT, plus <strong>⊘</strong> stop-all
  and <strong>▶</strong> transport in the bottom-right.
</p>

<h2>Driving it from the grid</h2>
<ul>
  <li><strong>Press a clip pad</strong> → launch it in its lane (or stop the lane if it's the one playing). Quantized to the lane loop when <code>QNT</code> is on.</li>
  <li><strong>Press the SCENE column</strong> (col {CTRL_SCENE_COL}, row y) → fire slot y across all 8 lanes at once (empty lanes stop).</li>
  <li><strong>Press the STOP column</strong> (col {CTRL_STOP_COL}, row y) → stop lane y.</li>
  <li><strong>⊘</strong> stops every lane; <strong>▶</strong> toggles TIMELORDE.</li>
</ul>

<h2>Editing a clip on the pads (hands-only)</h2>
<p>
  <strong>Hold the EDIT pad</strong> (session, top-right) + <strong>tap a clip</strong>
  → the grid becomes that clip's note editor: the top <strong>7 rows = pitch</strong>
  (in-key, one octave; root at the bottom), all <strong>16 columns = steps</strong>,
  and the <strong>bottom row is a function row</strong>.
</p>
<ul>
  <li><strong>Tap a cell</strong> → note ON; tap it again → note OFF.</li>
  <li><strong>Hold a note + tap another in the same row</strong> → one HELD note spanning them (the gate stays high the whole time).</li>
  <li><strong>Hold VEL + tap a note</strong> → step its velocity UP one level (wrapping 100% → 0%). Six levels ≈ 0/20/40/60/80/100%, shown on the grid as three note colours — two levels per colour:</li>
</ul>
<div class="vel-legend">
  {#each VEL_STATES as v (v.label)}
    <span class="vel"><span class="led" style="background:{swatch(v.level)}"></span>{v.label}</span>
  {/each}
</div>
<p class="aside">
  0% is a <strong>ghost note</strong> — the gate/note still fire, but the velocity
  CV is 0 (silent into a velocity-driven VCA). The six levels span the full 0..1
  velocity-CV range, so patching <code>VEL n</code> into a sustain/level amount
  (e.g. MOOG 911 sustain) gives a real, drastic dynamic range.
</p>
<p>
  The <strong>function row</strong> (bottom), with spacer gaps for legibility:
  <strong>EDIT</strong> (tap to exit) · <strong>VEL</strong> (hold to set velocity)
  · <em>gap</em> · <strong>ROW−</strong> · <strong>OCT−</strong> · <em>gap</em> ·
  <strong>ROW+</strong> · <strong>OCT+</strong> · <em>gap</em> · <strong>SCALE</strong>.
  <strong>ROW±</strong> nudge the 7-row pitch window by a single scale-degree row;
  <strong>OCT±</strong> move it a whole octave. <strong>SCALE</strong> cycles the
  clip's scale (major → minor → pentatonic → chromatic); chromatic makes each row a
  semitone, so in-key notes spread further apart vertically (use ROW/OCT to reach
  the ones that scroll off). While the clip plays, the current step column lights up
  and sweeps across — the tempo pulsing through the clip.
</p>
<p class="aside">
  <strong>Per-lane MONO/POLY</strong> is set on the card (the 1/5 button left of
  each launch row), not on the grid. In a mono lane, placing a note in a column
  that already holds one replaces it; a poly lane caps at <strong>5 notes per
  column</strong> (the poly voice width) and re-uses the oldest when you add a 6th.
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

<h2>Ports &amp; params reference</h2>
<table>
  <thead><tr><th>Port</th><th>Type</th><th>What it does</th></tr></thead>
  <tbody>
    <tr><td><code>stop_all</code> (in)</td><td>gate</td><td>a rising edge stops every lane at once</td></tr>
    <tr><td><code>pitch1…8</code></td><td>poly V/oct</td><td>each lane's launched-clip pitch (chords fan out across poly lanes; a mono pitch sink receives lane 0)</td></tr>
    <tr><td><code>gate1…8</code></td><td>gate</td><td>each lane's note gate — high while a note sounds</td></tr>
    <tr><td><code>vel1…8</code></td><td>cv</td><td>each lane's per-note velocity, 0..1 (patch into a VCA / ADSR amount)</td></tr>
  </tbody>
</table>
<table>
  <thead><tr><th>Param</th><th>Range</th><th>What it does</th></tr></thead>
  <tbody>
    <tr><td><code>STEP</code></td><td>1/4 · 1/8 · 1/16 · 1/32</td><td>steps per TIMELORDE beat (1/16 default)</td></tr>
    <tr><td><code>OCT</code></td><td>−2…+2</td><td>octave transpose applied to all lanes</td></tr>
    <tr><td><code>GATE</code></td><td>0.1…1</td><td>note gate duty cycle (fraction of the step a note holds)</td></tr>
    <tr><td><code>QNT</code></td><td>off / on</td><td>quantize launch to the lane loop boundary (off = launch now)</td></tr>
  </tbody>
</table>
<p class="aside">
  All ports live on the card's yellow drill-down PATCH PANEL — there are no side
  jacks. Every knob is MIDI / control-surface assignable (right-click → MIDI Learn).
</p>

<h2>What's next</h2>
<ul>
  <li><strong>Step paging on the grid</strong> for clips longer than 16 steps.</li>
  <li><strong>More clip kinds</strong> — audio loops and patch snapshots alongside note clips, plus recording into slots.</li>
</ul>

<h2>What to read next</h2>
<ul>
  <li><a href="/docs/modules/clipplayer">clip player</a> — the auto-generated port / param / source reference.</li>
  <li><a href="/docs/modules/kria">kria</a> — the faithful monome Kria step sequencer (the sibling module).</li>
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
  .gridmap {
    display: grid;
    grid-template-columns: repeat(16, 18px);
    grid-auto-rows: 18px;
    gap: 2px;
    margin: 12px 0;
    width: max-content;
  }
  .cell {
    width: 18px; height: 18px;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.62rem;
    font-weight: 700;
    color: #111;
  }
  .cell.dark { background: rgba(255, 255, 255, 0.04); }
  .cell.stop { background: #d9776b; }
  .cell.scene { background: #6ca8e0; }
  .cell.edit { background: #e8d35b; }
  .cell.all { background: #e0a35b; }
  .cell.transport { background: #6fcf8f; }
  .vel-legend { display: flex; gap: 14px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  .vel { display: inline-flex; align-items: center; gap: 2px; opacity: 0.9; }
</style>
