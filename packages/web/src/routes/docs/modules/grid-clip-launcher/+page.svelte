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
  import GridDiagram from '$lib/docs/GridDiagram.svelte';
  import { clipSessionGrid, clipEditGrid, clipLengthEditGrid } from '$lib/docs/clip-grid-spec';

  // Annotated reference diagrams (monome-manual style) — pure functions of the
  // live grid layout constants, so they never drift from the binding.
  const sessionGrid = clipSessionGrid();
  const editGrid = clipEditGrid();
  const lengthEditGrid = clipLengthEditGrid(48); // example: a 3-page (48-step) clip

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

  // Illustrative arrangement blocks for the song-view diagram (purely a doc
  // mock — {x,w} in the 320-wide viewBox; a 4-bar song at 80px/bar). Shows a
  // few lanes launching, swapping, and dropping out over song time.
  const SONG_DEMO: { x: number; w: number }[][] = [
    [{ x: 0, w: 158 }, { x: 160, w: 158 }],         // lane 0: a clip, then a swap at bar 3
    [{ x: 0, w: 318 }],                              // lane 1: one clip the whole song
    [{ x: 80, w: 78 }, { x: 240, w: 78 }],          // lane 2: enters bar 2, out, back bar 4
    [{ x: 160, w: 158 }],                            // lane 3: enters at the bar-3 drop
    [{ x: 0, w: 78 }],                               // lane 4: a one-bar stab up top
    [],                                              // lane 5: silent
    [{ x: 80, w: 238 }],                             // lane 6: enters bar 2, runs out
    [],                                              // lane 7: silent
  ];
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
  <li><strong>Clips can be different lengths</strong> (1–128 steps, each independent). Lanes free-run as a <strong>POLYMETER</strong> — a 16-step clip against a 17-step clip drifts in and out of phase — and they all <strong>re-align to step 0 on the transport downbeat</strong> (press ▶), so a fresh start is always phase-locked.</li>
  <li><strong>Song mode</strong> records the launches you perform into an <em>arrangement</em> and plays them back — a linear song built from your live session. (<a href="#song-mode">jump to song mode ↓</a>)</li>
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
  <li><strong>Edit view</strong> — a piano-roll note editor for one clip: X = step, Y = pitch (scale-degree rows in-key, root at the bottom). Click to place a note (click again to remove); <strong>right-click to cycle its velocity</strong> through 6 levels. Cycle <em>scale</em>, set <em>root</em>, change <em>length</em> (16/32/64/128/8; up to 128 steps), scroll the pitch window by a <strong>row</strong> (<code>↑/↓</code>) or an <strong>octave</strong> (<code>⤒/⤓</code>), or <code>⌫</code> clear the clip. A playhead column tracks the beat while the lane plays. <strong>Audition the clip without leaving the editor</strong> with the <strong>NOW</strong> / <strong>QUEUE</strong> buttons at the bottom-right (see <a href="#audition">below ↓</a>).</li>
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
<GridDiagram
  cols={sessionGrid.cols}
  rows={sessionGrid.rows}
  cells={sessionGrid.cells}
  callouts={sessionGrid.callouts}
  sideLabels={sessionGrid.sideLabels}
  caption={sessionGrid.caption}
/>
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

<h3>Copy / paste clips on the pads</h3>
<p>
  The right column carries three <strong>held modifiers</strong> (hold-and-tap,
  never sticky): <strong>COPY</strong>, <strong>PASTE</strong> and
  <strong>PASTE↺</strong> (paste-reversed).
</p>
<ul>
  <li><strong>Hold COPY + tap a clip</strong> → grab a structural copy of it into a per-machine clip buffer (a clipboard — local to your grid, never written to the shared rack). The <strong>buffer indicator</strong> just below COPY pulses while the buffer holds a clip.</li>
  <li><strong>Hold PASTE + tap a slot</strong> → drop the buffer into that slot (creating it if empty, overwriting if not), as one undoable change. Pasting into a currently-playing lane takes effect at that lane's next loop boundary.</li>
  <li><strong>Hold PASTE↺ + tap a slot</strong> → paste a <em>time-reversed</em> copy of the buffer (held notes keep their length, re-anchored to the mirrored end).</li>
</ul>
<p class="aside">
  Precedence if you somehow hold more than one: EDIT &gt; COPY &gt; PASTE. The
  buffer survives reconnecting the grid, so you can copy a riff once and paste it
  across the whole bank.
</p>

<h2>Editing a clip on the pads (hands-only)</h2>
<p>
  <strong>Hold the EDIT pad</strong> (session, top-right) + <strong>tap a clip</strong>
  → the grid becomes that clip's note editor: the top <strong>7 rows = pitch</strong>
  (in-key, one octave; root at the bottom), all <strong>16 columns = steps</strong>,
  and the <strong>bottom row is a function row</strong>.
</p>
<GridDiagram
  cols={editGrid.cols}
  rows={editGrid.rows}
  cells={editGrid.cells}
  callouts={editGrid.callouts}
  caption={editGrid.caption}
/>
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
  <strong>ROW+</strong> · <strong>OCT+</strong> · <em>gap</em> · <strong>SCALE</strong>
  · <em>gap</em> · <strong>FOLLOW</strong> · <strong>◀</strong> · <strong>▶</strong> ·
  <strong>x2</strong> · <strong>LEN</strong>.
  <strong>ROW±</strong> nudge the 7-row pitch window by a single scale-degree row;
  <strong>OCT±</strong> move it a whole octave. <strong>SCALE</strong> cycles the
  clip's scale (major → minor → pentatonic → chromatic); chromatic makes each row a
  semitone, so in-key notes spread further apart vertically (use ROW/OCT to reach
  the ones that scroll off). While the clip plays, the current step column lights up
  and sweeps across — the tempo pulsing through the clip.
</p>

<h3>Long patterns — pages, FOLLOW, DOUBLE</h3>
<p>
  A clip can be up to <strong>128 steps</strong>, edited as up to <strong>8
  pages</strong> of 16. The pad columns always show <em>one</em> 16-step page.
</p>
<ul>
  <li><strong>FOLLOW</strong> (default on, steady-lit) auto-scrolls the shown page along with the playhead, so the moving pulse always stays on screen. <strong>◀ / ▶</strong> are no-ops while following (dim).</li>
  <li><strong>Tap FOLLOW</strong> to FREEZE on the current page (it flashes); now <strong>◀ / ▶</strong> page left/right (dim/no-op at the ends). Tap FOLLOW again to resume and snap straight back to the live playhead page.</li>
  <li><strong>x2 (DOUBLE)</strong> doubles the clip length and copies the first half into the new second half — instant "make it twice as long, same again." It's a no-op at 128 steps.</li>
</ul>

<h3>Setting the length (the LEN page)</h3>
<p>
  <strong>LEN</strong> opens a dedicated 2-row length editor. The top row picks
  which <strong>16-step block</strong> the pattern ends in (tap block <em>C</em> →
  length <em>C</em>×16; the far-right pad EXITs back to the note editor); the
  second row <strong>trims</strong> to the exact last step inside that block — so
  length 113 is "block 8, then step 1." Setting length is
  <strong>non-destructive</strong>: notes past the new end simply stop sounding
  but are kept, and they return the moment you lengthen the clip again.
</p>
<GridDiagram
  cols={lengthEditGrid.cols}
  rows={lengthEditGrid.rows}
  cells={lengthEditGrid.cells}
  callouts={lengthEditGrid.callouts}
  sideLabels={lengthEditGrid.sideLabels}
  caption={lengthEditGrid.caption}
/>
<p class="aside">
  <strong>Per-lane MONO/POLY</strong> is set on the card (the 1/5 button left of
  each launch row), not on the grid. In a mono lane, placing a note in a column
  that already holds one replaces it; a poly lane caps at <strong>5 notes per
  column</strong> (the poly voice width) and re-uses the oldest when you add a 6th.
</p>

<h2 id="audition">Auditioning the clip you're editing</h2>
<p>
  You don't have to leave the editor to hear your work. The bottom-right of the
  note editor has two launch buttons that target <em>this</em> clip's lane and
  slot:
</p>
<ul>
  <li><strong>NOW</strong> (left) — jump straight into the clip <em>immediately</em>, mid-loop, ignoring <code>QNT</code>. It lights green while this clip is the one playing in its lane. Use it to hear an edit the instant you make it.</li>
  <li><strong>QUEUE</strong> (right) — arm the clip to drop in on the lane's <em>next loop boundary</em> (it follows <code>QNT</code>); it pulses amber while armed, then plays in time. Use it to audition in-tempo with whatever else is running.</li>
</ul>
<figure class="song-fig">
  <svg viewBox="0 0 320 132" width="320" height="132" role="img"
       aria-label="Clip editor footer: a piano-roll grid with NOW and QUEUE launch buttons at the bottom-right.">
    <!-- mini piano-roll -->
    {#each Array.from({ length: 5 }, (_, r) => r) as r (r)}
      {#each Array.from({ length: 16 }, (_, c) => c) as c (c)}
        <rect x={4 + c * 18} y={4 + r * 16} width="16" height="14" rx="1.5"
              fill={(r === 2 && (c === 2 || c === 6 || c === 10)) ? 'hsl(150 55% 45%)' : 'rgba(255,255,255,0.05)'}
              stroke="rgba(255,255,255,0.10)" />
      {/each}
    {/each}
    <!-- NOW + QUEUE buttons, bottom-right -->
    <rect x="170" y="100" width="64" height="24" rx="3" fill="rgba(255,255,255,0.04)" stroke="#6fcf8f" />
    <text x="202" y="116" text-anchor="middle" fill="#6fcf8f" font-size="11" font-weight="700">NOW</text>
    <rect x="242" y="100" width="74" height="24" rx="3" fill="rgba(255,255,255,0.04)" stroke="#e8b35b" />
    <text x="279" y="116" text-anchor="middle" fill="#e8b35b" font-size="11" font-weight="700">QUEUE</text>
  </svg>
  <figcaption class="caption">
    The editor footer. <strong>NOW</strong> (green) launches the edited clip
    immediately; <strong>QUEUE</strong> (amber) arms it for the next loop
    boundary. Both act on the clip's own lane + slot.
  </figcaption>
</figure>

<h2 id="song-mode">Song mode — record your launches into an arrangement</h2>
<p>
  The clip player has <strong>two transports</strong>. Everything above is
  <strong>SESSION</strong> — you launch clips live and they loop. <strong>Song
  mode</strong> adds an <strong>ARRANGEMENT</strong>: a linear timeline of the
  clip launches you performed, over song time, that the transport plays back.
  Record a session take, then replay it — the arrangement <em>is</em> your
  performance, captured launch-for-launch.
</p>
<p>
  Two small buttons on the card header drive it:
</p>
<ul>
  <li>
    <strong>REC</strong> — arm recording. While it's armed and the transport is
    running, every launch you make (a clip pad, a scene, a stop — from the card
    <em>or</em> the grid) is appended to the arrangement at the
    <strong>song-beat you heard it apply</strong> (not the beat you clicked), so
    playback reproduces exactly what you heard. Arming <strong>clears</strong> the
    old arrangement and records fresh (v1 is replace, not overdub).
  </li>
  <li>
    <strong>SES ⇄ ARR</strong> — flip the playback transport between
    <strong>SES</strong> session (launch live) and <strong>ARR</strong>angement
    (play the recorded song). In ARR the button shows the captured event count,
    and a read-only <strong>song view</strong> appears under the header — an
    8-lane × song-time timeline with one block per clip and a playhead sweeping
    across as it plays.
  </li>
</ul>
<figure class="song-fig">
  <svg viewBox="0 0 320 116" width="320" height="116" role="img"
       aria-label="Arrangement timeline: 8 instrument lanes across song time, coloured blocks per launched clip, a playhead sweeping across.">
    <!-- bar gridlines -->
    {#each [80, 160, 240] as bx (bx)}
      <line x1={bx} y1="0" x2={bx} y2="104" stroke="rgba(255,255,255,0.10)" />
    {/each}
    <!-- lane rows + illustrative clip blocks (one colour per lane) -->
    {#each Array.from({ length: 8 }, (_, i) => i) as lane (lane)}
      <rect x="0" y={lane * 13} width="320" height="12" fill="rgba(255,255,255,0.03)" />
      {#each (SONG_DEMO[lane] ?? []) as b (b.x)}
        <rect x={b.x} y={lane * 13 + 1} width={b.w} height="10" rx="1.5"
              fill={`hsl(${laneHue(lane)} 55% 45%)`} />
      {/each}
    {/each}
    <!-- playhead -->
    <line x1="150" y1="0" x2="150" y2="104" stroke="#6fcf8f" stroke-width="1.5" />
    <text x="0" y="114" fill="rgba(255,255,255,0.55)" font-size="8">bar 1</text>
    <text x="76" y="114" fill="rgba(255,255,255,0.55)" font-size="8">2</text>
    <text x="156" y="114" fill="rgba(255,255,255,0.55)" font-size="8">3</text>
    <text x="236" y="114" fill="rgba(255,255,255,0.55)" font-size="8">4</text>
  </svg>
  <figcaption class="caption">
    The song view (ARR mode). Rows = the 8 instrument lanes (lane-tinted); the
    horizontal axis = song time in bars; each block is a launched clip running
    until the lane's next launch/stop; the green line is the playhead.
  </figcaption>
</figure>
<h3>Switching mid-clip (the "NOW" override)</h3>
<p>
  <code>QNT</code> stays the default — launches land on the lane's loop boundary
  so everything stays in phase. To break a clip <em>immediately</em>, mid-loop,
  <strong>Shift-click</strong> the clip on the card (or turn <code>QNT</code> off
  for launch-now everywhere). An immediate switch is captured into the
  arrangement tagged as such, so the recorded song reproduces the off-boundary
  timing exactly — quantized launches replay quantized, NOW launches replay NOW.
</p>
<p class="aside">
  The arrangement (and which mode you're in) lives in the shared rack state, so
  collaborators see the same recorded song. For v1 the <strong>REC arm is
  single-recorder</strong> — one person records a take at a time; multi-recorder
  overdub is a later phase.
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
  <li><strong>Song-mode editing (Phase 2)</strong> — the song view is read-only today; next it becomes an editable arrangement: drag block edges to retime, click to swap or delete a clip, set the loop length. Blocks are derived from the recorded event log, so editing maps straight back onto it.</li>
  <li><strong>Overdub</strong> — layer a new take onto an existing arrangement (today's REC clears and records fresh), and multi-recorder song-building.</li>
  <li><strong>On-grid song overview (Phase 3)</strong> — scrub and see the arrangement on the pads (monochrome presence/position on a monome; colour-coded blocks on an RGB Launchpad).</li>
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
  .song-fig { margin: 16px 0; }
  .song-fig svg {
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.2);
    max-width: 100%;
    height: auto;
  }
  .song-fig figcaption { margin-top: 6px; }
</style>
