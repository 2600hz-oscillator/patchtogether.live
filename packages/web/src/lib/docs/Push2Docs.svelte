<script lang="ts">
  // PUSH 2 CONTROL — module docs. Authored reference for the Phase-1 Push 2
  // integration, with a DATA-DRIVEN diagram fed from the REAL push2-map CC
  // constants so the picture + the control→action table can never drift from the
  // code (push2-docs.test asserts the rendered CC numbers equal the map). The
  // Push drives the full Launchpad clip-launch / note-editor / scene / KEYS
  // parity surface on its 8×8 pads; this page documents the moved + added
  // controls (Play transport, D-Pad nav, channel-select, encoder→MixMasters).

  import Push2Diagram from './Push2Diagram.svelte';
  import {
    PUSH_CC_PLAY,
    PUSH_CC_SHIFT,
    PUSH_CC_DPAD_UP,
    PUSH_CC_DPAD_DOWN,
    PUSH_CC_DPAD_LEFT,
    PUSH_CC_DPAD_RIGHT,
    PUSH_CC_ABOVE_DISPLAY_BASE,
    PUSH_CC_BELOW_DISPLAY_BASE,
    PUSH_CC_ENCODER_BASE,
    PUSH_CC_ENCODER_TEMPO,
    PUSH_CC_ENCODER_SWING,
    PUSH_CC_ENCODER_MASTER,
    PUSH_CC_SESSION,
    PUSH_CC_NOTE,
    PUSH_CC_LAYOUT,
    PUSH_CC_DEVICE,
    PUSH_CC_UNDO,
  } from '$lib/control/push2/push2-map';

  const GRID_FILL = '#243044';
  const SEL_FILL = '#6f9bd6';
  const DIM_FILL = '#2a3040';

  // Diagram data — generated from the real map constants.
  const pads = Array.from({ length: 64 }, (_, i) => ({
    x: i % 8,
    y: Math.floor(i / 8),
    fill: GRID_FILL,
  }));
  const encoderLabels = ['S1', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'S2', 'Mst'];
  // col 0 = Tempo(→send1), 1..8 = display encoders(→vol), 9 = Swing(→send2),
  // 10 = Master(→master). The picture spreads all 11 across the grid width.
  const encoders = [
    { col: 0, fill: DIM_FILL, label: encoderLabels[0] },
    ...Array.from({ length: 8 }, (_, i) => ({ col: i + 1, fill: DIM_FILL, label: encoderLabels[i + 1] })),
    { col: 9, fill: DIM_FILL, label: encoderLabels[9] },
    { col: 10, fill: DIM_FILL, label: encoderLabels[10] },
  ];
  const top = Array.from({ length: 8 }, (_, i) => ({
    col: i,
    fill: i === 0 ? SEL_FILL : DIM_FILL,
    label: `CH${i + 1}`,
  }));

  // The control→action reference (each row's CC comes from the real map).
  const parityRows = [
    { control: '8×8 pads', cc: '36–99', action: 'Clip launch / note editor / arm — FULL Launchpad parity' },
    { control: 'Play', cc: `CC ${PUSH_CC_PLAY}`, action: 'START / STOP the transport (moved here from the grid)' },
    { control: 'Session', cc: `CC ${PUSH_CC_SESSION}`, action: 'GRID (clip-launch) view' },
    { control: 'Note', cc: `CC ${PUSH_CC_NOTE}`, action: 'CLIP (note-editor) view' },
    { control: 'Layout', cc: `CC ${PUSH_CC_LAYOUT}`, action: 'ARRANGER view' },
    { control: 'Device', cc: `CC ${PUSH_CC_DEVICE}`, action: 'CONTROL view' },
    { control: 'Undo', cc: `CC ${PUSH_CC_UNDO}`, action: 'Undo' },
    { control: 'Shift', cc: `CC ${PUSH_CC_SHIFT}`, action: 'SHIFT modifier — editor ×8 window + arm gestures' },
    { control: 'Below-display ×8', cc: `CC ${PUSH_CC_BELOW_DISPLAY_BASE}–${PUSH_CC_BELOW_DISPLAY_BASE + 7}`, action: 'The Launchpad scene column (scene launch / editor / KEYS scale)' },
  ];
  const additiveRows = [
    { control: 'Above-display ×8', cc: `CC ${PUSH_CC_ABOVE_DISPLAY_BASE}–${PUSH_CC_ABOVE_DISPLAY_BASE + 7}`, action: 'Select channel 1–8 (Push-local; card shows “CH n · instrument”)' },
    { control: 'Encoders 1–8', cc: `CC ${PUSH_CC_ENCODER_BASE}–${PUSH_CC_ENCODER_BASE + 7}`, action: 'MixMasters ch1–8 volume' },
    { control: 'Tempo encoder', cc: `CC ${PUSH_CC_ENCODER_TEMPO}`, action: 'send1 of the SELECTED channel' },
    { control: 'Swing encoder', cc: `CC ${PUSH_CC_ENCODER_SWING}`, action: 'send2 of the SELECTED channel' },
    { control: 'Master encoder', cc: `CC ${PUSH_CC_ENCODER_MASTER}`, action: 'MixMasters master volume' },
    { control: 'D-Pad ↑ / ↓', cc: `CC ${PUSH_CC_DPAD_UP} / ${PUSH_CC_DPAD_DOWN}`, action: 'CLIP-view pitch window ±1 (SHIFT = ×8)' },
    { control: 'D-Pad ← / →', cc: `CC ${PUSH_CC_DPAD_LEFT} / ${PUSH_CC_DPAD_RIGHT}`, action: 'CLIP-view step window ±1 (SHIFT = ×8)' },
  ];
</script>

<div class="p2docs">
  <h1>Push 2 control</h1>
  <p class="lede">
    Drive the clip player from an Ableton Push 2. The 8×8 pads give you the
    <strong>full Launchpad control surface</strong> — clip launch, the note editor,
    the arm row, scenes, and the KEYS keyboard — through the same shipped brain.
    On top of that, the Push adds a <strong>hardware mixer</strong>: the 8 buttons
    above the display pick a channel, and the 11 encoders drive the MixMasters
    volume and sends. START/STOP lives on the dedicated <strong>Play</strong> button.
  </p>

  <Push2Diagram
    {pads}
    {top}
    {encoders}
    playLabel="PLAY"
    dpadLabel="NAV"
    caption="Push 2 — the top row selects a channel, the encoders drive the mixer, Play is transport, the D-Pad scrolls the clip window, and the 8×8 is the full clip surface."
  />

  <h2>Parity — the clip surface</h2>
  <p>
    Everything the Launchpad does on its 8×8 works here identically. START/STOP
    moves to the Play button; view switching + undo + the SHIFT modifier live on
    the labelled function buttons.
  </p>
  <table class="p2-table" data-testid="push2-parity-table">
    <thead><tr><th>Control</th><th>MIDI</th><th>Action</th></tr></thead>
    <tbody>
      {#each parityRows as r (r.control)}
        <tr><td>{r.control}</td><td><code>{r.cc}</code></td><td>{r.action}</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>Additive — the mixer + navigation</h2>
  <p>
    The encoders write through the same streaming-CC pump the Electra One uses, so
    a fast twist never storms the shared document. The selected channel is a
    Push-local choice (never synced) — it picks which channel the two left
    encoders' sends address and which name the card shows.
  </p>
  <table class="p2-table" data-testid="push2-additive-table">
    <thead><tr><th>Control</th><th>MIDI</th><th>Action</th></tr></thead>
    <tbody>
      {#each additiveRows as r (r.control)}
        <tr><td>{r.control}</td><td><code>{r.cc}</code></td><td>{r.action}</td></tr>
      {/each}
    </tbody>
  </table>

  <p class="note" data-testid="push2-hardware-note">
    <strong>Phase 1 note:</strong> the pad colours use the stock Push palette (an
    approximate mapping refined on hardware later), and the button MIDI numbers
    above are the standard Ableton Push 2 map — confirmed on the physical unit via
    the console port dump on connect. The 960×160 on-device display is Phase 2; for
    now the selected channel name shows on the card.
  </p>
</div>

<style>
  .p2docs {
    max-width: 900px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    color: var(--text, #cfd3df);
    line-height: 1.55;
  }
  .p2docs h1 { font-size: 1.6rem; margin: 0 0 0.6rem; }
  .p2docs h2 { font-size: 1.15rem; margin: 1.8rem 0 0.5rem; }
  .lede { color: #aeb4c4; }
  .p2-table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.6rem 0 1rem;
    font-size: 0.9rem;
  }
  .p2-table th, .p2-table td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid #2a2f3a;
    vertical-align: top;
  }
  .p2-table th { color: #9aa0b2; font-weight: 600; }
  .p2-table code { color: #b79cf0; }
  .note {
    font-size: 0.85rem;
    color: #9aa0b2;
    background: rgba(120, 90, 200, 0.08);
    border: 1px solid rgba(120, 90, 200, 0.25);
    border-radius: 5px;
    padding: 8px 10px;
  }
</style>
