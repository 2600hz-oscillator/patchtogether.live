<script lang="ts">
  import GridDiagram from './GridDiagram.svelte';
  import { clipSessionGrid, clipEditGrid, clipLengthEditGrid } from './clip-grid-spec';
  import { CTRL_STOP_COL, CTRL_SCENE_COL, LED_LOADED, LED_PLAYING, LED_QUEUED_HI, LED_NOTE_BRIGHTNESS } from '$lib/control/monome/monome-map';
  const session = clipSessionGrid();
  const editor = clipEditGrid();
  const length = clipLengthEditGrid(48);
  const brightness = (v: number) => `rgb(${Math.round(v / 15 * 255)} ${Math.round(v / 15 * 255)} ${Math.round(v / 15 * 255)})`;
</script>

<details id="monome" class="monome-guide">
  <summary>monome grid 128 — connection and visual reference</summary>
  <p>A monome grid uses browser WebSerial with no companion app or serialosc. On localhost or HTTPS in a browser that supports WebSerial, connect the grid and press <strong>GRID</strong> in Clip Player. Choose its USB serial port; macOS may show a generic <code>usbserial</code> entry. Press GRID again to disconnect. The hardware connection is local to your browser.</p>

  <h3>Session map</h3>
  <GridDiagram cols={session.cols} rows={session.rows} cells={session.cells} callouts={session.callouts} sideLabels={session.sideLabels} caption={session.caption} />
  <p>On this 16×8 grid, <strong>lanes run down the rows</strong> and the first eight slots run across the left half. A clip pad launches its slot or stops it when already playing. The stop column is column {CTRL_STOP_COL + 1}; the scene column is column {CTRL_SCENE_COL + 1}. A scene button launches its slot across all lanes. Coordinates in the diagram use the mapping’s zero-based notation.</p>
  <p><strong>EDIT + clip</strong> opens a note editor. <strong>COPY + note clip</strong> fills the monome’s private note clipboard; <strong>PASTE + target</strong> writes it into that slot. <strong>PASTE↺</strong> reverses the notes and their automation. These modifiers are held, not latched. The clipboard survives reconnecting the grid and is separate from the screen/Push/Launchpad clipboard.</p>
  <div class="led-key" aria-label="Monome clip LED legend">
    {#each [{ name:'Empty', level:0 }, { name:'Loaded', level:LED_LOADED }, { name:'Queued · blinking', level:LED_QUEUED_HI }, { name:'Playing', level:LED_PLAYING }] as item}
      <span><i style:background={brightness(item.level)}></i>{item.name}</span>
    {/each}
  </div>

  <h3>Note editor</h3>
  <GridDiagram cols={editor.cols} rows={editor.rows} cells={editor.cells} callouts={editor.callouts} caption={editor.caption} />
  <p>The top seven rows are scale pitches; all sixteen columns are steps. Tap a cell to add or remove a note. Hold a note and tap farther along the same row to make one sustained note. Hold <strong>VEL</strong> and tap a note to cycle six velocity levels. Zero velocity still emits a gate, so whether it is silent depends on your voice’s velocity patch.</p>
  <div class="led-key" aria-label="Monome note velocity legend">
    {#each LED_NOTE_BRIGHTNESS as level, i}<span><i style:background={brightness(level)}></i>{['0 / 20%', '40 / 60%', '80 / 100%'][i]}</span>{/each}
  </div>
  <p>The bottom function row contains EDIT (exit), VEL, ROW− / OCT−, ROW+ / OCT+, SCALE, FOLLOW, previous / next page, ×2 and LEN, with spacers between groups. ROW moves one scale degree; OCT moves one octave. SCALE changes the row layout for the clip’s scale.</p>
  <p><strong>FOLLOW</strong> tracks the playing step across 16-step pages. Turn it off to freeze the page and use previous / next. <strong>×2</strong> doubles the notes and duration up to 128 steps. Returning to FOLLOW snaps back to the live page.</p>

  <h3>Exact clip length</h3>
  <GridDiagram cols={length.cols} rows={length.rows} cells={length.cells} callouts={length.callouts} sideLabels={length.sideLabels} caption={length.caption} />
  <p>LEN opens the length page. Select the ending 16-step block on the top row, then its exact last step on the second row. For example, 113 steps is block 8, step 1. Shortening hides later notes from playback without deleting them. EXIT returns to the note editor.</p>

  <h3>What stays on screen</h3>
  <p>The monome can launch and stop existing audio clips in its first eight slots, but their LEDs use the ordinary clip states. Audio recording, waveform/source selection, confirmed replacement, AUTO arm, mono/poly, lane rate and extended scene banking are not mapped here. Use Clip Player’s screen for those actions. Monome EDIT and copy/paste are note-only workflows. Push 2 and Launchpad provide the newer AUDIO page.</p>
</details>

<style>
  .monome-guide { margin-top:1.8rem; border:1px solid var(--doc-border-dim,#29434a); border-radius:8px; padding:1rem 1.2rem; scroll-margin-top:85px; }
  summary { cursor:pointer; font-weight:700; font-size:1.08em; }
  .led-key { display:flex; flex-wrap:wrap; gap:1rem; margin:1rem 0; }
  .led-key span { display:flex; align-items:center; gap:.5rem; }
  .led-key i { display:inline-block; width:17px; height:17px; border:1px solid #74818a; border-radius:3px; }
</style>
