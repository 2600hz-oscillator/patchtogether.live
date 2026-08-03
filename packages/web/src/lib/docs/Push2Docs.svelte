<script lang="ts">
  // PUSH 2 CONTROL — module docs. Authored reference for the Phase-1 Push 2
  // integration, with a DATA-DRIVEN diagram fed from the REAL push2-map CC
  // constants so the picture + the control→action table can never drift from the
  // code (push2-docs.test asserts the rendered CC numbers equal the map). The
  // Push drives the full Launchpad clip-launch / note-editor / scene / KEYS
  // parity surface on its 8×8 pads; this page documents the moved + added
  // controls (Play transport, D-Pad nav, lane select, the PUSH CARD and its
  // encoders) and the LIVE-port / Live-mode binding the pads + LEDs use.

  import Push2Diagram from './Push2Diagram.svelte';
  import {
    PUSH_CC_PLAY,
    PUSH_CC_SHIFT,
    PUSH_CC_UNDO,
    PUSH_CC_DPAD_UP,
    PUSH_CC_DPAD_DOWN,
    PUSH_CC_DPAD_LEFT,
    PUSH_CC_DPAD_RIGHT,
    PUSH_CC_ABOVE_DISPLAY_BASE,
    PUSH_CC_PERMANENT_BASE,
    PUSH_CC_SCENE_BASE,
    PUSH_CC_ENCODER_BASE,
    PUSH_CC_ENCODER_TEMPO,
    PUSH_CC_ENCODER_SWING,
    PUSH_CC_ENCODER_MASTER,
    PUSH_CC_LEGEND,
    PUSH_CC_ELECTRA_MODE,
  } from '$lib/control/push2/push2-map';
  import { ELECTRA_MODE_KNOBS, ELECTRA_MODE_ROWS } from '$lib/control/push2/push-electra-model';

  const GRID_FILL = '#243044';

  // Diagram data — pads default-filled; labels derived from the real controls.
  const pads = Array.from({ length: 64 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), fill: GRID_FILL }));
  // 11 encoders left→right: Tempo (unbound), Swing (flip cards), the 8 push-card
  // strips, Master (master volume).
  const encoderLabels = ['—', 'CRD', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'Mst'];
  // 8 above-display buttons → select lane 1-8.
  const upperLabels = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8'];
  // 8 below-display buttons → the Launchpad view/function top row (default order).
  const lowerLabels = ['▶', 'GRD', 'CLP', 'ARR', 'CTL', 'UND', 'RDO', 'SFT'];
  const sceneLabels = ['', '', '', '', '', '', '', ''];

  // The control→action reference (each row's CC comes from the real map).
  const parityRows = [
    { control: '8×8 pads', cc: '36–99', action: 'Clip launch / note editor / arm / KEYS — FULL Launchpad parity. Velocity-SENSITIVE: your hit velocity is recorded (note entry) + played (KEYS)' },
    { control: 'Play', cc: `CC ${PUSH_CC_PLAY}`, action: 'START / STOP the transport (moved here from the grid)' },
    { control: 'Permanent-controls row ×8', cc: `CC ${PUSH_CC_PERMANENT_BASE}–${PUSH_CC_PERMANENT_BASE + 7}`, action: 'The 8 buttons BELOW the display → the Launchpad view/function top row (91–98): session / clip-note / scene / arm / KEYS' },
    { control: 'Scene launch ×8', cc: `CC ${PUSH_CC_SCENE_BASE}–${PUSH_CC_SCENE_BASE + 7}`, action: 'The 8 buttons RIGHT of the grid → the scene column (launch / editor functions / KEYS scale). TOP button = 43 … BOTTOM = 36' },
    { control: 'Undo', cc: `CC ${PUSH_CC_UNDO}`, action: 'Undo' },
    { control: 'SHIFT (permanent row, above channel 8)', cc: `CC ${PUSH_CC_SHIFT}`, action: 'SHIFT modifier — editor ×8 window, encoder fine-nudge, arm gestures, the LEGEND shift layer. NOT the button labelled “Shift”: that one is CC ' + PUSH_CC_ELECTRA_MODE },
  ];
  const additiveRows = [
    { control: 'Above-display ×8', cc: `CC ${PUSH_CC_ABOVE_DISPLAY_BASE}–${PUSH_CC_ABOVE_DISPLAY_BASE + 7}`, action: 'Select LANE 1–8 — the screen shows that lane\u2019s PUSH CARD (Push-local, never synced)' },
    { control: 'Display encoders 1–8', cc: `CC ${PUSH_CC_ENCODER_BASE}–${PUSH_CC_ENCODER_BASE + 7}`, action: 'Turn the 8 controls of the current push card (SHIFT = fine)' },
    { control: 'Tempo encoder', cc: `CC ${PUSH_CC_ENCODER_TEMPO}`, action: 'Unbound in v1' },
    { control: 'Swing encoder', cc: `CC ${PUSH_CC_ENCODER_SWING}`, action: 'Flip through the push cards of the modules in the selected lane' },
    { control: 'Master encoder', cc: `CC ${PUSH_CC_ENCODER_MASTER}`, action: 'MixMasters master volume' },
    { control: 'D-Pad ↑ / ↓', cc: `CC ${PUSH_CC_DPAD_UP} / ${PUSH_CC_DPAD_DOWN}`, action: 'CLIP-view pitch window ±1 (SHIFT = ×8)' },
    { control: 'D-Pad ← / →', cc: `CC ${PUSH_CC_DPAD_LEFT} / ${PUSH_CC_DPAD_RIGHT}`, action: 'CLIP-view step window ±1 (SHIFT = ×8)' },
    { control: 'LEGEND (hold)', cc: `CC ${PUSH_CC_LEGEND}`, action: 'Hold to turn the display into on-device documentation of the current view. Momentary + display-only' },
    { control: '“Shift” button (lower right)', cc: `CC ${PUSH_CC_ELECTRA_MODE}`, action: `ELECTRA CONTROL MODE — press to toggle. The button lights while the mode is on` },
  ];
  // ELECTRA CONTROL MODE — what each encoder does while the mode is latched.
  const electraRows = [
    { control: `Display encoders 1–${ELECTRA_MODE_KNOBS}`, cc: `CC ${PUSH_CC_ENCODER_BASE}–${PUSH_CC_ENCODER_BASE + ELECTRA_MODE_KNOBS - 1}`, action: `The ${ELECTRA_MODE_KNOBS} controls of the selected ELECTRA CONTROL row — same name + readout as the card and the Electra One (SHIFT = fine)` },
    { control: 'Display encoders 7–8', cc: `CC ${PUSH_CC_ENCODER_BASE + 6}–${PUSH_CC_ENCODER_BASE + 7}`, action: 'INERT — deliberately unassigned in this mode; the space above them shows the row number instead' },
    { control: 'Scroll encoder', cc: `CC ${PUSH_CC_ENCODER_SWING}`, action: `Scroll the ROW 1–${ELECTRA_MODE_ROWS} (wraps at both ends)` },
    { control: 'Master encoder', cc: `CC ${PUSH_CC_ENCODER_MASTER}`, action: 'MixMasters master volume — unchanged in this mode' },
    { control: 'Everything else', cc: '—', action: 'Pads, scene column, permanent row, D-Pad, lane select, Play, Undo all route EXACTLY as outside the mode' },
  ];
</script>

<div class="p2docs">
  <h1>Push 2 control</h1>
  <p class="lede">
    Drive the clip player from an Ableton Push 2. The 8×8 pads give you the
    <strong>full Launchpad control surface</strong> — clip launch, the note editor,
    the arm row, scenes, and the KEYS keyboard — through the same shipped brain,
    and because the Push pads are <strong>velocity-sensitive</strong>, how hard you
    hit a pad is recorded into the clip and played through the keyboard. On top of
    that, every module has a <strong>push card</strong>: the 8 buttons above the
    display pick a lane, the 960×160 screen shows one module\u2019s card at a time,
    and the 8 display encoders turn its controls.
    START/STOP lives on the dedicated <strong>Play</strong> button.
  </p>

  <Push2Diagram
    {pads}
    {encoderLabels}
    {upperLabels}
    {lowerLabels}
    {sceneLabels}
    caption="Push 2 — encoders on top (Tempo unbound · Swing flips cards · the 8 push-card strips · Master); lane-select above the display; the permanent-controls row below it; the 8×8 grid with the scene column + NAV arrows on its right; Play is bottom-left."
  />

  <h2>Parity — the clip surface</h2>
  <p>
    Everything the Launchpad does on its 8×8 works here identically. START/STOP
    moves to the Play button; view switching lives on the permanent-controls row
    below the display; scene launch is the column to the right of the grid.
  </p>
  <table class="p2-table" data-testid="push2-parity-table">
    <thead><tr><th>Control</th><th>MIDI</th><th>Action</th></tr></thead>
    <tbody>
      {#each parityRows as r (r.control)}
        <tr><td>{r.control}</td><td><code>{r.cc}</code></td><td>{r.action}</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>Additive — the push card + navigation</h2>
  <p>
    Every module has a <strong>push card</strong>: up to eight controls, each drawn
    as a name, a bar graph and a readout, one per display encoder. Pick a lane with
    a button above the screen and you get the card for the module you last looked
    at in that lane, or — if you have never opened it — the module most recently
    added to it. The <strong>second encoder from the left</strong> flips through the
    other modules in that lane, one card at a time.
  </p>
  <p>
    Which eight controls a module shows is a text file you can edit:
    <code>packages/web/src/lib/control/push2/push-card-config.ts</code>. Modules
    with no entry fall back to their curated faceplate ranking, and un-faced
    modules to the order they declare their params in. The encoders write through
    the same streaming-CC pump the Electra One uses, so a fast twist never storms
    the shared document. The selected lane and the per-lane card you left off on
    are Push-local (per machine, per rack) and are never synced.
  </p>
  <table class="p2-table" data-testid="push2-additive-table">
    <thead><tr><th>Control</th><th>MIDI</th><th>Action</th></tr></thead>
    <tbody>
      {#each additiveRows as r (r.control)}
        <tr><td>{r.control}</td><td><code>{r.cc}</code></td><td>{r.action}</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>ElectraControl mode</h2>
  <p>
    Press the button labelled <strong>Shift</strong> in the lower right
    (<code>CC {PUSH_CC_ELECTRA_MODE}</code>) and the Push becomes an
    <strong>ELECTRA CONTROL</strong> surface — one row at a time. The six leftmost
    display encoders drive the six controls of the selected row of the rack's
    ElectraControl 6×6 grid, and each strip shows the same name and readout you
    see on that slot's knob on the card and on the Electra One itself. The space
    above encoders 7 and 8 becomes a <strong>ROW</strong> readout, and the scroll
    encoder steps it through rows 1–{ELECTRA_MODE_ROWS}. Press the button again to leave.
    It is a <em>latched</em> mode and the button lights while it is on.
  </p>
  <p>
    This is the <strong>control part only</strong>: it does not reproduce the
    Electra's touchscreen functions, its MixMaster page or its Control page. Every
    other button on the Push keeps doing exactly what it does outside the mode, so
    entering it can never strand a transport or a clip launch. The mode itself is
    not remembered across a reload — a latched mode you cannot see without the
    hardware in front of you should not come back on its own — but the row you
    left off on is.
  </p>
  <table class="p2-table" data-testid="push2-electra-table">
    <thead><tr><th>Control</th><th>MIDI</th><th>Action</th></tr></thead>
    <tbody>
      {#each electraRows as r (r.control)}
        <tr><td>{r.control}</td><td><code>{r.cc}</code></td><td>{r.action}</td></tr>
      {/each}
    </tbody>
  </table>

  <p class="note" data-testid="push2-shift-note">
    <strong>Two different buttons are both called “shift”.</strong> The
    <strong>SHIFT modifier</strong> — the editor's ×8 window, the encoder
    fine-nudge, the arm gestures and the LEGEND shift layer — is the
    permanent-row button <em>above channel 8</em> (<code>CC {PUSH_CC_SHIFT}</code>),
    which is the one that maps to the Launchpad's own shift. The button physically
    <em>labelled</em> “Shift” in the lower right (<code>CC {PUSH_CC_ELECTRA_MODE}</code>)
    is the ElectraControl mode toggle. Until 2026-08-03 it was a duplicate second
    route to the same modifier; reassigning it took nothing away.
  </p>

  <p class="note" data-testid="push2-hardware-note">
    <strong>Phase 1 note:</strong> the Push binds its <strong>LIVE port</strong> and
    stays in the device's default <strong>Live mode</strong> — both the pad presses
    and the pad-LED Note-Ons flow there with no per-frame SysEx (the reliable
    standalone-browser path; the User port only carries pads/LEDs once switched to
    User mode, the finicky out-of-Ableton path, and is a possible future toggle).
    The pad colours use the <strong>stock Push palette</strong> (an approximate
    mapping refined on hardware later). The 960×160 display runs over
    <strong>WebUSB</strong>, a separate one-time permission from MIDI: if it is
    unavailable or you decline it, the pads and encoders keep working and the card
    shows the same push card in the browser.
    Two mappings are still <strong>unconfirmed on hardware</strong>: which
    permanent-row button maps to which view, and where the <strong>scroll
    encoder</strong> (<code>CC {PUSH_CC_ENCODER_SWING}</code>) physically sits. That
    knob is identified by its FUNCTION — the one that scrolls through the
    instruments of a lane, and now through ElectraControl rows — not by a position
    anyone has verified by turning it.
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
