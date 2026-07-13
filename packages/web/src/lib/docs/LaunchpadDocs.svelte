<script lang="ts">
  // LAUNCHPAD MK3 — shared, colour-coded in-app guide with faithful pad-grid
  // diagrams. Rendered by /docs/modules/launchpadControlLeft, the consolidated
  // launchpad-control module's docs route (right-click the card → "View docs").
  //
  // STRUCTURE (owner directive): two FULLY SELF-CONTAINED top-level sections —
  // "SINGLE LAUNCHPAD" and "TWO LAUNCHPADS" — each documenting its complete
  // workflow end to end, with a state diagram for every view. Repetition
  // between the sections is deliberate: a user in one mode never needs to read
  // the other section. The LED colour legend + raw hardware protocol are shared
  // reference material (above/below both sections).
  //
  // Every diagram + swatch imports the LIVE launchpad-map constants, so the doc
  // never drifts from what the firmware is actually sent.
  import LaunchpadDiagram from './LaunchpadDiagram.svelte';
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
    RGB_SONG_ARRANGE,
    RGB_DECK_EDIT,
    RGB_DECK_COPY,
    RGB_DECK_DBL,
    RGB_DECK_LEN,
    RGB_DECK_NOW,
    RGB_COPY_BUFFER,
    RGB_NOTE_BY_VEL,
    RGB_NOTE_PLAYHEAD,
    RGB_PLAYHEAD_WASH,
    RGB_ROOT_GUIDE,
    RGB_EXIT,
    RGB_LEN_BLOCK,
    RGB_LEN_END,
    // SINGLE-MODE (4-view rework) palettes — the permanent-top-row NAVIGATION
    // palette + the right-column function TAXONOMY (every swatch is the live
    // firmware RGB, so the docs can't drift from the constants).
    RGB_VIEW_IDLE,
    RGB_VIEW_ACTIVE,
    RGB_SHIFT_OFF,
    RGB_SHIFT_HELD,
    RGB_SHIFT_LATCH,
    RGB_TRANSPORT_STOP,
    RGB_SYS,
    RGB_SYS_DIM,
    RGB_PATTERN,
    RGB_LAUNCH_QUEUE,
    RGB_LAUNCH_NOW,
    RGB_PATTERN_ARMED,
    RGB_TIMING,
    RGB_TIMING_ARMED,
    RGB_KEYS_ENTRY,
    RGB_SWING_UP,
    RGB_SWING_DOWN,
    RGB_SWING_CENTER,
    RGB_ARRANGER_DIM,
    RGB_VEL_WASH,
    RGB_SONG_SESSION,
    // KEYS mode (note/keyboard + clip-record)
    RGB_KEY_ROOT,
    RGB_KEY_INSCALE,
    RGB_KEY_OUTSCALE,
    RGB_KEY_PRESSED,
    RGB_KEYS_PH_CUR,
    RGB_KEYS_PH_BASE,
    RGB_QREC_IDLE,
    RGB_QREC_ARMED,
    RGB_QREC_REC,
    RGB_OD,
    RGB_OD_ON,
    RGB_KEYS_REC_HOLD,
    RGB_KEYS_OD_HOLD,
    RGB_FUNC_DIM,
    // performance controls (P1 RESET · P4 MONO · P3 MUTE · P2 RATE · P5 tempo · P7 panic)
    RGB_RESET,
    RGB_MONO_ON,
    RGB_MONO_OFF,
    RGB_MUTE_ON,
    RGB_MUTE_OFF,
    RGB_RATE_BY_INDEX,
    RGB_TEMPO_NUDGE,
    RGB_PANIC,
    type Rgb,
  } from '$lib/control/launchpad/launchpad-map';
  import { keyboardCellToMidi, noteRole } from '$lib/audio/modules/keyboard-map';

  // Render the EXACT RGB the firmware receives (0..127 → 0..255 for the screen).
  const hex = (c: Rgb) =>
    `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;

  // ── The clip MATRIX (an illustrative live state) — used by BOTH sections. ──
  // y is the launchpad's BOTTOM-origin row; the matrix maps lane 1 → the TOP
  // row (y=7) so it matches the on-screen card. yL() converts a card-lane
  // (0 = top) to its physical row.
  const yL = (lane: number) => 7 - lane;
  const matrixPads = [
    { x: 0, y: yL(0), fill: hex(RGB_PLAYING) }, // lane1/slot1 playing (TOP row)
    { x: 1, y: yL(0), fill: hex(RGB_LOADED) },
    { x: 2, y: yL(0), fill: hex(RGB_LOADED) },
    { x: 0, y: yL(1), fill: hex(RGB_QUEUED) }, // lane2/slot1 queued-launch
    { x: 1, y: yL(1), fill: hex(RGB_LOADED) },
    { x: 0, y: yL(2), fill: hex(RGB_LOADED) },
    { x: 1, y: yL(2), fill: hex(RGB_QUEUED_STOP) }, // queued-stop
    { x: 3, y: yL(3), fill: hex(RGB_LOADED) }, // a loaded clip (no copy-source glow — copy is a snapshot)
  ];
  const matrixScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(RGB_SCENE),
    label: r === 7 ? 'SCENE' : undefined,
  }));
  const matrixCallouts = [{ label: 'SLOTS  1 → 8', fromCol: 0, toCol: 7 }];
  // PAIR Unit-L top row (CC 91..98) — formerly DARK, now the 8 per-lane MUTE pads
  // (col = lane). Shown: lane 3 muted (orange), the rest live (dim). Labelled with
  // the lane number so it reads as "one MUTE per lane."
  const matrixMuteTop = Array.from({ length: 8 }, (_, col) => ({
    col,
    fill: hex(col === 2 ? RGB_MUTE_ON : RGB_MUTE_OFF),
    label: String(col + 1),
  }));
  const matrixMuteCallouts = [
    { label: 'SLOTS  1 → 8', fromCol: 0, toCol: 7, tier: 0 },
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // SINGLE-MODE (4-view rework) diagram data. The lone device is a Grid / Clip /
  // Keys / Control / Arranger surface over a PERMANENT top-row nav bar + a hybrid
  // SHIFT layer. Every colour comes from launchpad-map (permTop mirrors
  // paintPermanentTopRow; the right columns mirror the per-view classifiers), so
  // the pictures can't drift from the firmware.
  // ═══════════════════════════════════════════════════════════════════════
  type SView = 'grid' | 'clip' | 'arranger' | 'control';
  /** The PERMANENT top row (CC 91..98) — identical in every view. Mirrors
   *  paintPermanentTopRow: transport (red stopped / green playing), the 4 view
   *  buttons (bright purple = active; Clip also bright while KEYS is open),
   *  undo/redo (orange, dim when the stack is empty), shift (yellow: dim off /
   *  bright held / solid latched). */
  function permTop(
    active: SView,
    o: { running?: boolean; shift?: 'off' | 'held' | 'latch'; keys?: boolean; undo?: boolean; redo?: boolean } = {},
  ) {
    const v = (view: SView) =>
      hex(active === view || (view === 'clip' && o.keys) ? RGB_VIEW_ACTIVE : RGB_VIEW_IDLE);
    const sh = o.shift === 'held' ? RGB_SHIFT_HELD : o.shift === 'latch' ? RGB_SHIFT_LATCH : RGB_SHIFT_OFF;
    return [
      { col: 0, fill: hex(o.running ? RGB_TRANSPORT_ON : RGB_TRANSPORT_STOP), label: o.running ? '▶' : '■' },
      { col: 1, fill: v('grid'), label: 'GRID' },
      { col: 2, fill: v('clip'), label: 'CLIP' },
      { col: 3, fill: v('arranger'), label: 'ARR' },
      { col: 4, fill: v('control'), label: 'CTRL' },
      { col: 5, fill: hex(o.undo ? RGB_SYS : RGB_SYS_DIM), label: 'UNDO' },
      { col: 6, fill: hex(o.redo ? RGB_SYS : RGB_SYS_DIM), label: 'REDO' },
      { col: 7, fill: hex(sh), label: 'SHFT' },
    ];
  }
  const permTopGroups = [
    { label: 'TRANSPORT', fromCol: 0, tier: 0 },
    { label: 'VIEWS  ·  Grid · Clip · Arranger · Control', fromCol: 1, toCol: 4, tier: 1 },
    { label: 'UNDO / REDO', fromCol: 5, toCol: 6, tier: 0 },
    { label: 'SHIFT', fromCol: 7, tier: 1 },
  ];

  // ── GRID view — the TRANSPOSED clip matrix: x = channel/lane (0..7 left→right),
  // slot runs TOP→bottom (top row = slot 0). gp() places a clip by (lane, slot). ──
  const gp = (lane: number, slot: number, fill: string, label?: string) => ({ x: lane, y: 7 - slot, fill, label });
  const gridPads = [
    gp(0, 0, hex(RGB_PLAYING), 'K'), // ch1 slot 0 — playing (solid green)
    gp(0, 1, hex(RGB_LOADED)),
    gp(0, 2, hex(RGB_LOADED)),
    gp(1, 0, hex(RGB_PLAYING), 'S'), // ch2 slot 0 — playing
    gp(1, 1, hex(RGB_LOADED)),
    gp(2, 0, hex(RGB_QUEUED), 'V'), // ch3 slot 0 — queued-launch (flashing green)
    gp(2, 1, hex(RGB_LOADED)),
    gp(3, 0, hex(RGB_QUEUED_STOP)), // ch4 slot 0 — queued-stop (flashing red)
    gp(4, 2, hex(RGB_LOADED)),
  ];
  const gridCallouts = [{ label: 'CHANNELS / LANES  1 → 8', fromCol: 0, toCol: 7 }];
  // No shift → the right column is SCENE / ROW launch (a grid ROW = one clip per
  // channel = a song section). Amber idle; flashes green when a row is queued.
  const gridRowScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(r === 6 ? RGB_QUEUED : RGB_SCENE),
    label: r === 7 ? 'ROW ▶' : undefined,
  }));
  // + shift → the function palette (scene index 0..7 = rows 7..0 top→bottom):
  // Copy · Paste · Clip-Div · Swing+ · Swing− · Length · Paste-Rev · Now.
  const gridShiftScene = [
    { row: 7, fill: hex(RGB_PATTERN), label: 'COPY' }, // green (tap-to-arm)
    { row: 6, fill: hex(RGB_COPY_BUFFER), label: 'PASTE' }, // turquoise while the buffer holds a clip
    { row: 5, fill: hex(RGB_TIMING), label: 'DIV' }, // blue (per-clip divider)
    { row: 4, fill: hex(RGB_TIMING), label: 'SW+' }, // blue idle; ramps purple while raising
    { row: 3, fill: hex(RGB_TIMING), label: 'SW−' }, // blue idle; ramps blue while lowering
    { row: 2, fill: hex(RGB_DECK_LEN), label: 'LEN' }, // yellow (owner override)
    { row: 1, fill: hex(RGB_PATTERN), label: 'P-REV' }, // green (tap-to-arm)
    { row: 0, fill: hex(RGB_SYS), label: 'NOW' }, // orange sticky toggle (shown on)
  ];

  // ── The NOTE EDITOR 8×8 (an illustrative state) — both modes; declared here
  // because the CLIP view below reuses it under the velocity-edit wash. ──
  const editorPads = [
    { x: 1, y: 2, fill: hex(RGB_NOTE_BY_VEL[1]) }, // med-vel note
    { x: 3, y: 4, fill: hex(RGB_NOTE_BY_VEL[2]) }, // high-vel note
    { x: 5, y: 1, fill: hex(RGB_NOTE_BY_VEL[0]) }, // low-vel note
    { x: 2, y: 3, fill: hex(RGB_NOTE_PLAYHEAD) }, // note under the playhead
    // playhead column wash (the rest of step-column 2)
    ...[0, 1, 4, 5, 6, 7].map((y) => ({ x: 2, y, fill: hex(RGB_PLAYHEAD_WASH) })),
    // faint root-pitch guides on the lowest row
    { x: 0, y: 0, fill: hex(RGB_ROOT_GUIDE) },
    { x: 6, y: 0, fill: hex(RGB_ROOT_GUIDE) },
  ];

  // ── CLIP view — the note editor 8×8 (reuses editorPads) + its right column. ──
  const clipRightScene = [
    { row: 7, fill: hex(RGB_PATTERN), label: 'DBL' }, // green
    { row: 6, fill: hex(RGB_PATTERN), label: 'LEN' }, // green (Clip LEN is green, not yellow)
    { row: 5, fill: hex(RGB_PATTERN_ARMED), label: 'FOL' }, // bright green = following
    { row: 4, fill: hex(RGB_KEYS_ENTRY), label: 'KEYS' }, // bright orange (owner override)
    { row: 3, fill: hex(RGB_PATTERN), label: 'R+' }, // green
    { row: 2, fill: hex(RGB_PATTERN), label: 'R−' },
    { row: 1, fill: hex(RGB_TIMING), label: 'S◀' }, // blue
    { row: 0, fill: hex(RGB_TIMING), label: 'S▶' },
  ];
  // + shift → Row± brighten (page/octave), Step± brighten (block jump).
  const clipShiftScene = [
    { row: 7, fill: hex(RGB_LAUNCH_QUEUE), label: 'QUE' }, // orange — QUEUE the edited clip (next boundary)
    { row: 6, fill: hex(RGB_LAUNCH_NOW), label: 'NOW' }, // orange (bright) — launch the edited clip NOW
    { row: 5, fill: hex(RGB_PATTERN_ARMED), label: 'FOL' },
    { row: 4, fill: hex(RGB_KEYS_ENTRY), label: 'KEYS' },
    { row: 3, fill: hex(RGB_PATTERN_ARMED), label: 'R+' }, // bright green = page/octave jump
    { row: 2, fill: hex(RGB_PATTERN_ARMED), label: 'R−' },
    { row: 1, fill: hex(RGB_TIMING_ARMED), label: 'S◀' }, // bright blue = block jump
    { row: 0, fill: hex(RGB_TIMING_ARMED), label: 'S▶' },
  ];
  // The velocity-edit wash under shift: empty note-grid cells tint faint purple
  // (editorPads render on top — pads.find takes the first match).
  const clipVelWashPads = [
    ...editorPads,
    ...Array.from({ length: 64 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), fill: hex(RGB_VEL_WASH) })),
  ];

  // ── KEYS view (sub-view of Clip) — keyboard from keysSinglePads; right column
  // no-shift = scale-select + arp toggle, +shift = the arp control column. ──
  const keysScaleScene = [
    { row: 7, fill: hex(RGB_PATTERN_ARMED), label: 'MAJ' }, // selected scale (bright green)
    { row: 6, fill: hex(RGB_PATTERN), label: 'MIN' },
    { row: 5, fill: hex(RGB_PATTERN), label: 'PENT' },
    { row: 4, fill: hex(RGB_PATTERN), label: 'DOR' },
    { row: 3, fill: hex(RGB_PATTERN), label: 'PHRY' },
    { row: 2, fill: hex(RGB_PATTERN), label: 'MIXO' },
    { row: 1, fill: hex(RGB_PATTERN), label: 'CHRM' },
    { row: 0, fill: hex(RGB_SYS_DIM), label: 'ARP' }, // dim orange = arp off
  ];
  const keysArpScene = [
    { row: 7, fill: hex(RGB_TIMING), label: 'DIV+' }, // blue (faster)
    { row: 6, fill: hex(RGB_TIMING), label: 'DIV−' }, // blue (slower)
    { row: 5, fill: hex(RGB_PATTERN_ARMED), label: 'UP' }, // selected direction (bright green)
    { row: 4, fill: hex(RGB_PATTERN), label: 'DOWN' },
    { row: 3, fill: hex(RGB_PATTERN), label: 'UP-DN' },
    { row: 2, fill: hex(RGB_SYS), label: 'RNG+' }, // orange
    { row: 1, fill: hex(RGB_SYS), label: 'RNG−' },
    { row: 0, fill: hex(RGB_SYS_DIM), label: 'LTCH' }, // dim orange = latch off
  ];

  // ── CONTROL view — the performance deck + the RE-HOMED transport/arranger. ──
  const controlPads = [
    // re-homed onto dark grid pads (the permanent CC row owns the real top row):
    { x: 0, y: 7, fill: hex(RGB_TEMPO_NUDGE), label: 'T−' },
    { x: 1, y: 7, fill: hex(RGB_TEMPO_NUDGE), label: 'T+' },
    { x: 3, y: 7, fill: hex(RGB_STOP_IDLE), label: 'ALL' },
    { x: 0, y: 6, fill: hex(RGB_STOP_IDLE), label: 'REC' },
    { x: 1, y: 6, fill: hex(RGB_SONG_SESSION), label: 'SONG' },
    // performance rows (col = channel):
    { x: 2, y: 1, fill: hex(RGB_RESET), label: 'RST' }, // RESET (row 1, col 2)
    ...Array.from({ length: 8 }, (_, x) => ({ x, y: 2, fill: hex(x === 2 ? RGB_MONO_ON : RGB_MONO_OFF) })), // MONO
    ...Array.from({ length: 8 }, (_, x) => ({ x, y: 3, fill: hex(x === 4 ? RGB_MUTE_ON : RGB_MUTE_OFF) })), // MUTE
    ...Array.from({ length: 8 }, (_, x) => ({ x, y: 4, fill: hex(RGB_RATE_BY_INDEX[3]) })), // RATE (default '1')
  ];
  const controlScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(r === 7 ? RGB_STOP_ACTIVE : RGB_STOP_IDLE),
    label: r === 7 ? 'STOP' : undefined,
  }));
  const controlCallouts = [
    { label: 'T−', fromCol: 0, tier: 0 },
    { label: 'T+', fromCol: 1, tier: 0 },
    { label: 'STOP-ALL', fromCol: 3, tier: 0 },
    { label: 'RESET · MONO · MUTE · RATE  (rows 1–4, one pad per channel)', fromCol: 0, toCol: 7, tier: 1 },
  ];

  // ── ARRANGER view — an inert placeholder (faint grid, dark right column). ──
  const arrangerPads = Array.from({ length: 64 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), fill: hex(RGB_ARRANGER_DIM) }));

  // ── MASTER colour legend (one diagram): the nav palette on the top row, the
  // right-column TAXONOMY on the scene column, clip states across the grid. ──
  const legendPads = [
    gp(0, 3, hex(RGB_PLAYING), 'PLAY'),
    gp(1, 3, hex(RGB_LOADED), 'LOAD'),
    gp(2, 3, hex(RGB_QUEUED), 'Q▶'),
    gp(3, 3, hex(RGB_QUEUED_STOP), 'Q■'),
    gp(4, 3, hex(RGB_RECORDING), 'REC'),
  ];
  const legendScene = [
    { row: 7, fill: hex(RGB_PATTERN), label: 'PATTERN — green' },
    { row: 6, fill: hex(RGB_TIMING), label: 'TIMING — blue' },
    { row: 5, fill: hex(RGB_SYS), label: 'SYSTEM — orange' },
    { row: 4, fill: hex(RGB_DECK_LEN), label: 'LENGTH — yellow' },
    { row: 3, fill: hex(RGB_KEYS_ENTRY), label: 'KEYS — orange' },
    { row: 2, fill: hex(RGB_COPY_BUFFER), label: 'BUFFER — turquoise' },
    { row: 1, fill: hex(RGB_SCENE), label: 'SCENE — amber' },
    { row: 0, fill: hex(RGB_STOP_ACTIVE), label: 'STOP — red' },
  ];

  // ── The COMMAND DECK 8×8 (both modes paint the same deck frame). The formerly
  // ~85%-dead deck is now a performance surface:
  //   row 0 = EDIT · COPY · PASTE · P-REV · BUF(dark until a copy) · DBL · LEN · NOW
  //   row 1 = K● / KO (KEYS-entry holds) + RESET (col 2, steel-blue)
  //   row 2 = per-lane MONO (teal)  · row 3 = per-lane MUTE (orange when muted)
  //   row 4 = per-lane RATE (a cool→warm ramp; the shown state is all-default '1')
  const rateDefault = hex(RGB_RATE_BY_INDEX[3]); // index 3 = '1' (the default)
  const deckPads = [
    { x: 0, y: 0, fill: hex(RGB_DECK_EDIT) }, // EDIT — orange
    { x: 1, y: 0, fill: hex(RGB_DECK_COPY) }, // COPY — green
    { x: 2, y: 0, fill: hex(RGB_DECK_COPY) }, // PASTE — green
    { x: 3, y: 0, fill: hex(RGB_DECK_COPY) }, // P-REV — green
    // col 4 = BUF (copy-buffer indicator): dark until a clip is copied
    { x: 5, y: 0, fill: hex(RGB_DECK_DBL) }, // DBL — purple
    { x: 6, y: 0, fill: hex(RGB_DECK_LEN) }, // LEN — yellow
    { x: 7, y: 0, fill: hex(RGB_DECK_NOW) }, // NOW — purple
    { x: 0, y: 1, fill: hex(RGB_KEYS_REC_HOLD), label: 'K●' }, // note-REC hold
    { x: 1, y: 1, fill: hex(RGB_KEYS_OD_HOLD), label: 'KO' }, // note-OVERDUB hold
    { x: 2, y: 1, fill: hex(RGB_RESET), label: 'RST' }, // RESET (P1)
    // row 2 = MONO (all poly here except lane 1 shown ON), row 3 = MUTE (lane 4
    // shown muted), row 4 = RATE (all default '1').
    ...Array.from({ length: 8 }, (_, x) => ({ x, y: 2, fill: hex(x === 1 ? RGB_MONO_ON : RGB_MONO_OFF) })),
    ...Array.from({ length: 8 }, (_, x) => ({ x, y: 3, fill: hex(x === 4 ? RGB_MUTE_ON : RGB_MUTE_OFF) })),
    ...Array.from({ length: 8 }, (_, x) => ({ x, y: 4, fill: rateDefault })),
  ];
  const deckScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(r === 0 ? RGB_STOP_ACTIVE : RGB_STOP_IDLE),
    label: r === 7 ? 'STOP' : undefined,
  }));
  const deckCallouts = [
    { label: 'EDIT', fromCol: 0, tier: 0 },
    { label: 'COPY', fromCol: 1, tier: 1 },
    { label: 'PASTE', fromCol: 2, tier: 0 },
    { label: 'P-REV', fromCol: 3, tier: 1 },
    { label: 'BUF', fromCol: 4, tier: 0 },
    { label: 'DBL', fromCol: 5, tier: 1 },
    { label: 'LEN', fromCol: 6, tier: 0 },
    { label: 'NOW', fromCol: 7, tier: 1 },
    { label: 'MONO row', fromCol: 0, toCol: 7, tier: 2 },
    { label: 'MUTE row', fromCol: 0, toCol: 7, tier: 3 },
    { label: 'RATE row', fromCol: 0, toCol: 7, tier: 4 },
  ];
  // Deck top row. The session deck LIGHTS REC · SONG · TEMPO− · TEMPO+ · PLAY ·
  // ALL (CC 95 = SHIFT functional but unlit here — it lights in the editor).
  // Pair: CC 98 dark. Single: CC 98 = the cyan VIEW marker.
  const pairDeckTop = [
    { col: 0, fill: hex(RGB_RECORDING), label: 'REC' }, // CC 91 — arranger record-arm
    { col: 1, fill: hex(RGB_SONG_ARRANGE), label: 'SONG' }, // CC 92 — SES⇄ARR (bright in ARR)
    { col: 2, fill: hex(RGB_TEMPO_NUDGE), label: 'T−' }, // CC 93 — tempo nudge down
    { col: 3, fill: hex(RGB_TEMPO_NUDGE), label: 'T+' }, // CC 94 — tempo nudge up
    { col: 5, fill: hex(RGB_STOP_IDLE), label: 'PLAY' }, // CC 96 — transport
    { col: 6, fill: hex(RGB_STOP_IDLE), label: 'ALL' }, // CC 97 — stop-all
  ];

  const editorTopCommon = [
    { col: 0, fill: hex(RGB_FUNC), label: '▲' },
    { col: 1, fill: hex(RGB_FUNC), label: '▼' },
    { col: 2, fill: hex(RGB_FUNC), label: '◀' },
    { col: 3, fill: hex(RGB_FUNC), label: '▶' },
    { col: 4, fill: hex(RGB_FUNC), label: 'SHFT' },
    { col: 5, fill: hex(RGB_FUNC), label: 'VEL' },
    { col: 6, fill: hex(RGB_FUNC), label: 'SCL' },
  ];
  // PAIR: FOLLOW is the CC-98 button — green while following, violet frozen.
  const pairEditTopFollowing = [...editorTopCommon, { col: 7, fill: hex(RGB_TRANSPORT_ON), label: 'FOL' }];
  const pairEditTopFrozen = [...editorTopCommon, { col: 7, fill: hex(RGB_FUNC_ON), label: 'FOL' }];
  // P6 editor scene extras (rows 3/2/1/0, both modes): COPY · PASTE (dim until a
  // clip is in the buffer) · OCT+ · OCT−.
  const editSceneExtras = [
    { row: 3, fill: hex(RGB_DECK_COPY), label: 'CPY' },
    { row: 2, fill: hex(RGB_FUNC_DIM), label: 'PST' },
    { row: 1, fill: hex(RGB_FUNC), label: 'OC+' },
    { row: 0, fill: hex(RGB_FUNC), label: 'OC−' },
  ];
  const pairEditScene = [
    { row: 7, fill: hex(RGB_EXIT), label: 'EXIT' },
    { row: 6, fill: hex(RGB_FUNC), label: 'DBL' },
    { row: 5, fill: hex(RGB_FUNC), label: 'LEN' },
    ...editSceneExtras,
  ];
  const editCallouts = [{ label: 'STEP WINDOW  (8 = ½ block)', fromCol: 0, toCol: 7 }];

  // ── LENGTH-EDIT page (an illustrative state: 3 blocks, end-step 4) — both. ──
  const lenPads = [
    { x: 0, y: 0, fill: hex(RGB_LEN_BLOCK), label: '1' },
    { x: 1, y: 0, fill: hex(RGB_LEN_BLOCK), label: '2' },
    { x: 2, y: 0, fill: hex(RGB_LEN_END), label: '3' },
    { x: 0, y: 1, fill: hex(RGB_LEN_BLOCK) },
    { x: 1, y: 1, fill: hex(RGB_LEN_BLOCK) },
    { x: 2, y: 1, fill: hex(RGB_LEN_BLOCK) },
    { x: 3, y: 1, fill: hex(RGB_LEN_END) },
  ];
  const lenScene = [{ row: 7, fill: hex(RGB_EXIT), label: 'EXIT' }];
  const lenCallouts = [{ label: 'END BLOCK  1 → 8', fromCol: 0, toCol: 7 }];

  // ── KEYS view — generated from the LIVE keyboard-map + role colours so the
  // picture can't drift. C3 major, an illustrative held chord + a playhead. ──
  const KEYS_ROOT = 48; // C3
  const KEYS_SCALE = 'major' as const;
  const keysPressed = new Set<number>([
    keyboardCellToMidi(2, 1, KEYS_ROOT), // a held note (unit L / single)
    keyboardCellToMidi(4, 2, KEYS_ROOT),
    keyboardCellToMidi(9, 0, KEYS_ROOT), // a held note (unit R, col 9 — pair only)
  ]);
  const keyFill = (col: number, ry: number) => {
    const midi = keyboardCellToMidi(col, ry, KEYS_ROOT);
    if (keysPressed.has(midi)) return hex(RGB_KEY_PRESSED);
    const role = noteRole(midi, KEYS_ROOT, KEYS_SCALE);
    return hex(role === 'root' ? RGB_KEY_ROOT : role === 'inscale' ? RGB_KEY_INSCALE : RGB_KEY_OUTSCALE);
  };
  const KEYS_PH_CUR_CELL = 3; // illustrative current playhead cell
  function keysUnitPads(unit: 'L' | 'R') {
    const colBase = unit === 'L' ? 0 : 8;
    const pads: { x: number; y: number; fill: string; label?: string }[] = [];
    // keyboard band y=1..6 (row 0..5)
    for (let ry = 0; ry < 6; ry++) {
      for (let x = 0; x < 8; x++) pads.push({ x, y: 1 + ry, fill: keyFill(colBase + x, ry) });
    }
    // playhead strip y=7 (pair: L cells 0..7, R cells 8..15; single: 0..7 = whole clip)
    for (let x = 0; x < 8; x++) {
      const cell = colBase + x;
      pads.push({ x, y: 7, fill: hex(cell === KEYS_PH_CUR_CELL ? RGB_KEYS_PH_CUR : RGB_KEYS_PH_BASE) });
    }
    // bottom-row controls (unit L / the single device). P7 adds OCT ± / PANIC on
    // the formerly-dead cols 3/4/5 (col 6 stays dark).
    if (unit === 'L') {
      pads.push({ x: 0, y: 0, fill: hex(RGB_EXIT), label: 'EXT' });
      pads.push({ x: 1, y: 0, fill: hex(RGB_QREC_ARMED), label: 'REC' });
      pads.push({ x: 2, y: 0, fill: hex(RGB_OD), label: 'OVR' });
      pads.push({ x: 3, y: 0, fill: hex(RGB_FUNC), label: 'O−' }); // octave down
      pads.push({ x: 4, y: 0, fill: hex(RGB_FUNC), label: 'O+' }); // octave up
      pads.push({ x: 5, y: 0, fill: hex(RGB_PANIC), label: 'PNC' }); // panic
      pads.push({ x: 7, y: 0, fill: hex(RGB_DECK_LEN), label: 'LEN' });
    }
    return pads;
  }
  const keysLPads = keysUnitPads('L');
  const keysRPads = keysUnitPads('R');
  // SINGLE KEYS: the same L-half layout, but its 8 playhead cells span the WHOLE
  // clip (the pair spreads 16 cells across both units).
  const keysSinglePads = keysUnitPads('L');
  const keysPairLCallouts = [{ label: 'PLAYHEAD cells 1–8 (of 16)', fromCol: 0, toCol: 7, tier: 0 }];
  const keysPairRCallouts = [{ label: 'KEYBOARD continues (cols 9–16)', fromCol: 0, toCol: 7 }];
  const keysSingleCallouts = [{ label: 'PLAYHEAD — the WHOLE clip in 8 cells', fromCol: 0, toCol: 7, tier: 0 }];

  // ── colour legends (shared reference — both sections rely on the same LED
  // language; every swatch is the live firmware RGB). ──
  const SESSION_COLORS: { state: string; rgb: Rgb; anim: string; note: string }[] = [
    { state: 'empty slot', rgb: [0, 0, 0], anim: 'off', note: 'no clip here' },
    { state: 'loaded clip', rgb: RGB_LOADED, anim: 'static dim', note: 'has notes, stopped' },
    { state: 'playing', rgb: RGB_PLAYING, anim: 'SOLID green', note: 'running now (steady — a blinking pad means queued, not playing)' },
    { state: 'queued-launch', rgb: RGB_QUEUED, anim: 'flash green', note: 'waiting for the loop boundary' },
    { state: 'queued-stop', rgb: RGB_QUEUED_STOP, anim: 'flash red', note: 'will stop on the boundary' },
    { state: 'record-armed (REC)', rgb: RGB_RECORDING, anim: 'pulse red', note: 'arranger record-arm (deck top row, CC 91)' },
    { state: 'arrangement (SONG)', rgb: RGB_SONG_ARRANGE, anim: 'static white', note: 'SES⇄ARR lit in ARRANGEMENT (deck top row, CC 92)' },
    { state: 'copy buffer (BUF)', rgb: RGB_COPY_BUFFER, anim: 'pulse turquoise', note: 'a clip is in the clipboard — the deck BUF pad (pair) / the Grid-shift PASTE button (single); tap BUF or re-tap COPY to clear' },
    { state: 'scene (matrix right col)', rgb: RGB_SCENE, anim: 'amber', note: 'fire one clip slot across every lane at once (a whole column)' },
    { state: 'stop lane idle (deck right col)', rgb: RGB_STOP_IDLE, anim: 'dim red', note: 'per-lane stop' },
    { state: 'stop lane active', rgb: RGB_STOP_ACTIVE, anim: 'bright red', note: 'that lane is audible' },
  ];
  const DECK_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'EDIT', rgb: RGB_DECK_EDIT, note: 'orange — opens a clip’s note editor (brightens while held/armed)' },
    { state: 'COPY / PASTE / P-REV', rgb: RGB_DECK_COPY, note: 'green — clipboard actions (brighten while held/armed)' },
    { state: 'DOUBLE', rgb: RGB_DECK_DBL, note: 'purple — duplicate the pattern + double the clip length (cap 128)' },
    { state: 'LENGTH', rgb: RGB_DECK_LEN, note: 'yellow — open the 2-row length page' },
    { state: 'NOW', rgb: RGB_DECK_NOW, note: 'purple — launches ignore quantize (hold on the pair deck; in single mode NOW is the orange Grid-shift toggle)' },
    { state: 'RESET (RST)', rgb: RGB_RESET, note: 'steel blue — snap every active lane back to step 1 (deck row 1 col 2; pair: also the R deck)' },
    { state: 'MONO on / off', rgb: RGB_MONO_ON, note: 'teal — per-lane MONO (one note per column) engaged; dim teal = poly (deck row 2)' },
    { state: 'MUTE on / off', rgb: RGB_MUTE_ON, note: 'orange — lane muted (advances but silent); dim = live (deck row 3 · pair: L top row)' },
    { state: 'RATE (per lane)', rgb: RGB_RATE_BY_INDEX[3], note: 'a cool→warm ramp (1/8…4x); the shown green = the default ‘1’ (deck row 4). Tap to cycle up' },
    { state: 'TEMPO nudge − / +', rgb: RGB_TEMPO_NUDGE, note: 'dim white — step TIMELORDE’s bpm ±2 (CC 93 / 94)' },
    { state: 'KEYS panic', rgb: RGB_PANIC, note: 'red-orange — kill every sounding KEYS note (KEYS bottom row)' },
    { state: 'nav / SHIFT / octave (editor · KEYS)', rgb: RGB_FUNC, note: '▲▼◀▶ / SHIFT / OCT ± idle' },
    { state: 'held modifier (editor)', rgb: RGB_FUNC_ON, note: 'VEL / SHIFT while held · FOLLOW while frozen' },
    { state: 'transport / FOLLOW on', rgb: RGB_TRANSPORT_ON, note: 'running / auto-scroll' },
    { state: 'EXIT', rgb: RGB_EXIT, note: 'leave editor / length page (top scene button)' },
  ];
  const EDITOR_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'note · low vel', rgb: RGB_NOTE_BY_VEL[0], note: 'soft' },
    { state: 'note · med vel', rgb: RGB_NOTE_BY_VEL[1], note: 'mid' },
    { state: 'note · high vel', rgb: RGB_NOTE_BY_VEL[2], note: 'hard' },
    { state: 'note under playhead', rgb: RGB_NOTE_PLAYHEAD, note: 'yellow boost on the playing step' },
    { state: 'playhead column', rgb: RGB_PLAYHEAD_WASH, note: 'the moving step' },
    { state: 'root guide', rgb: RGB_ROOT_GUIDE, note: 'faint marker on every root-pitch row' },
    { state: 'length: counted / END', rgb: RGB_LEN_END, note: 'bright pad = current end (dim pads = counted blocks/steps)' },
  ];
  const KEYS_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'key · root', rgb: RGB_KEY_ROOT, note: 'cyan — every octave of the clip root' },
    { state: 'key · in-scale', rgb: RGB_KEY_INSCALE, note: 'green (dimmed) — a scale note' },
    { state: 'key · out-of-scale', rgb: RGB_KEY_OUTSCALE, note: 'very dim — still playable (chromatic)' },
    { state: 'key · pressed', rgb: RGB_KEY_PRESSED, note: 'white — sounding now' },
    { state: 'playhead cell', rgb: RGB_KEYS_PH_CUR, note: 'the current step (dull blue elsewhere)' },
    { state: 'QUEUE-REC idle', rgb: RGB_QREC_IDLE, note: 'dull yellow — not armed' },
    { state: 'QUEUE-REC armed', rgb: RGB_QREC_ARMED, note: 'bright yellow, flashes — waiting for the loop wrap' },
    { state: 'recording', rgb: RGB_QREC_REC, note: 'red, pulses — capturing now' },
    { state: 'OVERDUB off / on', rgb: RGB_OD_ON, note: 'light purple (off) → bright purple (on, additive)' },
    { state: 'note-REC / OVERDUB hold', rgb: RGB_KEYS_REC_HOLD, note: 'deck row 1 — the KEYS entry holds (dim red / dim purple)' },
  ];
  // ── SINGLE-MODE palettes (the 4-view rework). (a) the PERMANENT TOP-ROW
  // navigation palette; (b) the RIGHT-COLUMN function taxonomy. Every swatch is
  // the live firmware RGB. ──
  const NAV_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'transport — stopped', rgb: RGB_TRANSPORT_STOP, note: 'red — CC 91; tap to start' },
    { state: 'transport — playing', rgb: RGB_TRANSPORT_ON, note: 'green — CC 91; tap to stop' },
    { state: 'view — inactive', rgb: RGB_VIEW_IDLE, note: 'dim purple — a view you are NOT in (Grid · Clip · Arranger · Control)' },
    { state: 'view — active', rgb: RGB_VIEW_ACTIVE, note: 'bright purple — the current view (Clip is bright while KEYS is open)' },
    { state: 'undo / redo — available', rgb: RGB_SYS, note: 'orange — CC 96 / 97; a persistent edit is on the stack' },
    { state: 'undo / redo — empty', rgb: RGB_SYS_DIM, note: 'dim orange — nothing to undo / redo' },
    { state: 'shift — off', rgb: RGB_SHIFT_OFF, note: 'dim yellow — CC 98 idle' },
    { state: 'shift — held', rgb: RGB_SHIFT_HELD, note: 'bright yellow — momentary hold' },
    { state: 'shift — latched', rgb: RGB_SHIFT_LATCH, note: 'solid yellow — tapped to lock the alt layer' },
  ];
  const TAXONOMY_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'pattern', rgb: RGB_PATTERN, note: 'green — content: copy · paste · paste-rev · double · follow · scales · row-nav' },
    { state: 'pattern — armed / selected', rgb: RGB_PATTERN_ARMED, note: 'bright green — armed (tap-to-arm) or the selected scale / arp direction' },
    { state: 'timing', rgb: RGB_TIMING, note: 'blue — clip divider · swing ± · step-scroll · arp division' },
    { state: 'timing — armed / jump', rgb: RGB_TIMING_ARMED, note: 'bright blue — armed clip-div, or a block / page jump under shift' },
    { state: 'length', rgb: RGB_DECK_LEN, note: 'yellow — edit clip length (owner override; not green)' },
    { state: 'KEYS entry', rgb: RGB_KEYS_ENTRY, note: 'bright orange — open the KEYS keyboard (owner override)' },
    { state: 'system', rgb: RGB_SYS, note: 'orange — NOW · arp range · arp on/off · arp latch' },
    { state: 'system — off', rgb: RGB_SYS_DIM, note: 'dim orange — that system toggle is off' },
    { state: 'copy buffer', rgb: RGB_COPY_BUFFER, note: 'turquoise (pulses) — the Paste button while the clipboard holds a clip' },
    { state: 'swing — raising', rgb: RGB_SWING_UP, note: 'purple ramp — Swing+ nudged up (pale → bright by amount)' },
    { state: 'swing — lowering', rgb: RGB_SWING_DOWN, note: 'blue ramp — Swing− nudged down' },
    { state: 'swing — dead centre', rgb: RGB_SWING_CENTER, note: 'green flash — swing returned to 0 (straight)' },
  ];

  // ── Pad + CC reference tables (per mode; the raw protocol is shared). ──
  const SINGLE_MAP: { what: string; addr: string }[] = [
    { what: 'permanent top row (every view)', addr: 'CC 91 = transport (red stopped / green playing) · 92 = GRID · 93 = CLIP · 94 = ARRANGER · 95 = CONTROL (purple; bright = active) · 96 = UNDO · 97 = REDO (orange) · 98 = SHIFT (yellow: dim off / bright held / solid latched). This row NEVER changes meaning per view' },
    { what: 'SHIFT (CC 98)', addr: 'TAP = latch the alt layer (solid yellow); tap again = unlatch. HOLD = momentary (bright yellow). Effective shift = latched OR held. Grid compound functions arm on tap so nothing needs a second hand' },
    { what: 'GRID — the clip matrix', addr: 'column = channel / lane (1–8 left→right), row = clip slot (top row = slot 1). Single-tap = launch / stop (queued to the boundary; NOW = instant). DOUBLE-TAP a clip — or HOLD the CLIP top-row button + tap it — = select it + open CLIP on it (empty pad = create a clip). No-shift right column = ROW / scene launch' },
    { what: 'GRID + shift right column', addr: 'top→bottom: COPY · PASTE · CLIP-DIV · SWING+ · SWING− · LENGTH · PASTE-REV · NOW. Copy / Paste / Paste-Rev / Clip-Div / Length are TAP-TO-ARM (tap → arm → tap a clip). Swing ± are direct ±2 % nudges on the SELECTED channel. NOW is a sticky toggle' },
    { what: 'CLIP — note-editor right column', addr: 'top→bottom: DOUBLE · LENGTH · FOLLOW · KEYS · ROW+ · ROW− · STEP◀ · STEP▶. Shift: ROW± = ±octave / page, STEP± = block jump, and the 8×8 becomes VELOCITY-cycle (tap a note → cycle its velocity)' },
    { what: 'KEYS — scale select (no shift)', addr: 'top→bottom: MAJOR · MINOR · PENTATONIC · DORIAN · PHRYGIAN · MIXOLYDIAN · CHROMATIC · ARP on/off. Selected scale glows bright green. The scale lights the keyboard but does NOT snap live input (pads stay chromatic)' },
    { what: 'KEYS + shift — the arp column', addr: 'top→bottom: DIV+ · DIV− · UP · DOWN · UP-AND-DOWN · RANGE+ · RANGE− · LATCH. Divisions 8x…1/8 (1x default); ranges 1 oct / +1..−1 / +2..−2 (symmetric); up-and-down is an exclusive pendulum' },
    { what: 'CONTROL — the performance deck', addr: 'RESET (row 1, col 2, steel blue) · MONO row (teal) · MUTE row (orange) · RATE row (rate ramp) — one pad per channel. Right column = per-lane STOP. Re-homed on dark pads: TEMPO− / TEMPO+ / STOP-ALL (top grid row), REC / SONG (row below)' },
    { what: 'ARRANGER', addr: 'inert placeholder (faint grid, dark right column). The arrangement engine exists but has no launchpad UI yet; REC / SONG live in CONTROL for now' },
    { what: 'UNDO / REDO (CC 96 / 97)', addr: 'launchpad-scoped: undoes only THIS launchpad’s persistent clip edits (div / swing / length / paste / content / scale) — never a collaborator’s edit, never a transient launch. Lit orange when the stack has something; dim otherwise' },
    { what: 'KEYS entry / exit', addr: 'enter from CLIP → the KEYS button (right column, bright orange) on the selected clip. In KEYS the bottom row is EXIT · QUEUE-REC · OVERDUB · OCT− · OCT+ · PANIC · LENGTH. A view button exits KEYS; EXIT steps back (recording → armed → idle → the views)' },
    { what: 'LENGTH-EDIT page', addr: 'opened from GRID+shift LENGTH or CLIP LENGTH. Bottom row = end BLOCK (1–8 ×16), next two rows = end STEP (1–8, 9–16). Length = (endBlock−1)×16 + endStep, up to 128. EXIT = top scene button' },
  ];
  const PAIR_MAP: { what: string; addr: string }[] = [
    { what: 'Unit L top row (CC 91..98)', addr: 'the 8 per-lane MUTE pads (col = lane) — orange = muted (advances but silent), dim = live. On the always-visible matrix unit' },
    { what: 'deck hold-modifiers (R, row 0)', addr: 'EDIT · COPY · PASTE · P-REV · NOW — hold on R + tap a clip on L. BUF (col 5) = tap to clear the clipboard' },
    { what: 'deck globals (R top row)', addr: 'CC 91 = REC (arranger) · 92 = SONG (SES⇄ARR) · 93 = TEMPO− · 94 = TEMPO+ · 96 = PLAY (transport) · 97 = ALL (stop-all) · 95 = SHIFT (editor ×8)' },
    { what: 'RESET / MONO / MUTE / RATE (R deck)', addr: 'row 1 col 2 = RESET · row 2 = MONO · row 3 = MUTE · row 4 = RATE (per lane) — identical to the single deck (single IS the R brain)' },
    { what: 'editor nav (R top row)', addr: 'CC 91 ▲ · 92 ▼ · 93 ◀ · 94 ▶ (±1; hold SHIFT/CC 95 = ±8) · 96 = VEL (hold + tap) · 97 = SCALE · 98 = FOLLOW' },
    { what: 'editor scene column', addr: 'EXIT · DBL · LEN · then COPY · PASTE · OCT+ · OCT− (rows 3→0)' },
    { what: 'KEYS entry', addr: 'hold note-REC (R deck row 1 col 0) or note-OVERDUB (col 1) + DOUBLE-TAP a clip on L (REC = overdub off · OVERDUB = overdub on)' },
    { what: 'KEYS layout', addr: 'top rows = 16-cell playhead (L 1–8, R 9–16) · 6 keyboard rows continuous across the L|R seam · bottom row (L) = EXIT · QUEUE-REC · OVERDUB · OCT− · OCT+ · PANIC · LEN' },
  ];
  const HW_MAP: { what: string; addr: string }[] = [
    { what: '8×8 pads (programmer mode)', addr: 'note = row*10 + col · 11 = bottom-left · 88 = top-right' },
    { what: 'top row buttons', addr: 'CC 91 · 92 · 93 · 94 · 95 · 96 · 97 · 98 (left → right)' },
    { what: 'right scene column (top→bottom)', addr: 'CC 89 · 79 · 69 · 59 · 49 · 39 · 29 · 19' },
    { what: 'per-LED full RGB', addr: 'F0 00 20 29 02 0D 03  03 <pad> <R> <G> <B>  F7   (0–127)' },
  ];
</script>

<section class="hero">
  <h1>Launchpad Mini Mk3 — clip launcher</h1>
  <p class="lede">
    <strong>Novation Launchpad Mini Mk3</strong> drives the <strong>clip player</strong> over
    browser-native <strong>Web MIDI</strong> (no helper app). It works with
    <strong>one unit</strong> or <strong>two</strong> — pick your section below; each one is a complete,
    self-contained guide for that mode:
  </p>
  <ul class="tight">
    <li><a href="#single-launchpad"><strong>SINGLE LAUNCHPAD</strong></a> — one device is a
      <strong>four-view surface</strong> — <strong>GRID</strong>, <strong>CLIP</strong>,
      <strong>KEYS</strong> and <strong>CONTROL</strong> (plus an inert <strong>ARRANGER</strong>) — over
      a <strong>permanent top-row nav bar</strong> and a one-hand <strong>SHIFT</strong> layer.</li>
    <li><a href="#make-a-patch"><strong>MAKE A PATCH IN 1-PAD MODE</strong></a> — never touched the
      device? <strong>Start here.</strong> A button-by-button walkthrough from plugging in to performing
      a full patch (kick · snare · TIDY VCO).</li>
    <li><a href="#two-launchpads"><strong>TWO LAUNCHPADS</strong></a> — the <strong>left</strong> unit is
      the always-live <strong>8×8 clip matrix</strong>, the <strong>right</strong> unit is the
      <strong>command deck</strong> + <strong>note editor</strong>, so you never lose sight of the matrix.
      <em>(Pair mode is unchanged by the single-mode rework.)</em></li>
  </ul>
</section>

<h2 id="colour-language">LED colour language (both modes)</h2>
<p class="muted">
  Both modes speak the same LED language. Every swatch below is the exact RGB the firmware receives
  (type-3 lighting SysEx, 0–127 per channel). State always wins over a clip's own tint; pulse/flash
  animate on the binding's ~2 Hz blink.
</p>

<h3>Session — matrix + deck</h3>
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

<h3>Deck functions</h3>
<div class="swatch-grid">
  {#each DECK_COLORS as c (c.state)}
    <div class="swatch-row two">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<h3>Note editor + length</h3>
<div class="swatch-grid">
  {#each EDITOR_COLORS as c (c.state)}
    <div class="swatch-row two">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<h3>KEYS (keyboard + loop record)</h3>
<div class="swatch-grid">
  {#each KEYS_COLORS as c (c.state)}
    <div class="swatch-row two">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<!-- ======================================================================
     SINGLE LAUNCHPAD — fully self-contained. A reader in single mode never
     needs the TWO LAUNCHPADS section.
     ====================================================================== -->
<section class="mode-section" id="single-launchpad">
  <h2 class="mode-title">SINGLE LAUNCHPAD — one device, four views</h2>
  <p>
    One Launchpad does everything. Instead of hiding half the controls behind a mode flip, the lone
    device is a <strong>four-view surface</strong> — <strong>GRID</strong> (launch clips),
    <strong>CLIP</strong> (edit notes), <strong>KEYS</strong> (play, record + arpeggiate) and
    <strong>CONTROL</strong> (the performance deck), plus an inert <strong>ARRANGER</strong> — laid over a
    <strong>permanent top-row nav bar</strong> that never changes meaning. Switch views with the top-row
    buttons — GRID / ARRANGER / CONTROL flip instantly, while <strong>CLIP</strong> is a
    <strong>hold-to-pick</strong> launcher (hold it, tap a clip to edit that clip, release without a tap to
    stay put) — or the on-card view buttons; a one-hand <strong>SHIFT</strong> layer adds a second function
    to every right-column button without ever needing a second hand.
  </p>
  <p class="muted">
    New to the device? Jump to <a href="#make-a-patch"><strong>Make a patch in 1-pad mode</strong></a> for
    a button-by-button walkthrough, then come back here for the full reference.
  </p>

  <h3>Setup</h3>
  <ol class="steps">
    <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong> to the canvas.</li>
    <li>Click <strong>Connect single Launchpad</strong> on the card (grants Web-MIDI/sysex on the first
      click). The one device binds — no press-a-pad handshake — and auto-binds the first clip player.</li>
    <li>The device starts in <strong>GRID view</strong>. A reload restores your view; hit
      <strong>Connect single Launchpad</strong> once to re-attach the hardware (browser permission needs a
      click).</li>
  </ol>

  <h3>The permanent top row — your compass</h3>
  <LaunchpadDiagram
    top={permTop('grid', { running: true, undo: true, redo: true })}
    callouts={permTopGroups}
    accent={hex(RGB_VIEW_ACTIVE)}
    caption="The 8 top-row buttons (CC 91–98) mean the SAME thing in every view. Left→right: transport (red stopped / green playing) · GRID · CLIP · ARRANGER · CONTROL (purple; the active view is bright) · UNDO · REDO (orange) · SHIFT (yellow). The 8×8 below is dark here only to spotlight the row."
  />
  <ul class="tight">
    <li><strong>Transport (CC 91):</strong> start / stop the rack transport (TIMELORDE). Red = stopped,
      green = playing — the only red/green button on the row.</li>
    <li><strong>GRID · CLIP · ARRANGER · CONTROL (CC 92–95):</strong> the four view buttons — dim purple
      when you're not in them, <strong>bright purple</strong> for the one you're in (a permanent
      "you-are-here"). GRID / ARRANGER / CONTROL switch <em>instantly</em>. <strong>CLIP is a momentary
      clip-picker, not an instant switch</strong>: <strong>hold</strong> it to peek the clip launcher over
      whatever view you're in, <strong>tap a clip</strong> to drop into <em>that</em> clip's note editor
      (without changing whether it plays), or <strong>release without a tap</strong> to fall back to where
      you were. While <strong>KEYS</strong> is open (a sub-view of Clip) the <strong>CLIP</strong> button
      also lights bright; pressing any view button leaves KEYS for that view.</li>
    <li><strong>UNDO / REDO (CC 96 / 97):</strong> orange when there's something on the stack, dim when
      empty — see <a href="#single-undo">Undo / redo</a>.</li>
    <li><strong>SHIFT (CC 98):</strong> the alt-layer key (next). Dim yellow off, bright yellow while held,
      solid yellow while latched.</li>
  </ul>

  <h4>HOLD CLIP → peek a clip to edit</h4>
  <LaunchpadDiagram
    top={permTop('grid', { running: true })}
    pads={gridPads}
    scene={gridRowScene}
    callouts={gridCallouts}
    accent={hex(RGB_VIEW_ACTIVE)}
    caption="HOLD the CLIP button (CC 93) from ANY view and the clip launcher peeks over it (shown). TAP a clip → its note editor opens on THAT clip, without changing whether it plays. RELEASE without a tap → you drop back to exactly where you were (grid, arranger, control, or the clip you were already editing). A quick CLIP tap with no clip picked is a no-op."
  />

  <h3 id="single-shift">The shift layer + tap-to-arm — one-handed by design</h3>
  <p>
    Every right-column button has a plain meaning and a <strong>shift</strong> meaning. SHIFT (CC 98) is
    <strong>hybrid</strong>: <strong>tap</strong> it to <em>latch</em> the alt layer (it glows solid yellow
    — the whole right column switches to its shift meaning and stays there), <strong>tap again</strong> to
    unlatch. Or <strong>hold</strong> it for a momentary alt layer (bright yellow) just while your finger
    is down. Effective shift = <strong>latched OR held</strong>, so you can work either way.
  </p>
  <p>
    On one device you can't hold a function button <em>and</em> tap a clip at once — so the Grid's compound
    functions (Copy · Paste · Paste-Rev · Clip-Div · Length) are <strong>tap-to-ARM</strong>:
    <strong>tap the function → it arms</strong> (brightens; only one at a time) <strong>→ tap a clip → it
    applies</strong> and auto-disarms. Tap the armed button again to cancel; a stale arm auto-clears after
    ~4 s. Swing ± are <em>direct nudges</em> (no arm) and NOW is a <em>sticky toggle</em>. Net: no gesture
    on the whole surface ever needs a second hand.
  </p>

  <h3>Single-mode colour language</h3>
  <p class="muted">
    Single mode adds two palettes on top of the shared <a href="#colour-language">LED colour language</a>
    above: a <strong>navigation</strong> palette for the permanent top row (purple views · yellow shift ·
    red/green transport · orange undo/redo) and a right-column function <strong>taxonomy</strong>
    (<strong>green</strong> = pattern · <strong>blue</strong> = timing · <strong>orange</strong> = system ·
    <strong>yellow</strong> = length). Every swatch below is the exact firmware RGB.
  </p>
  <LaunchpadDiagram
    top={permTop('grid', { running: true, shift: 'latch', undo: true, redo: true })}
    pads={legendPads}
    scene={legendScene}
    callouts={permTopGroups}
    accent={hex(RGB_VIEW_ACTIVE)}
    caption="The single-mode palettes at a glance. TOP ROW = navigation (transport red/green · views purple · undo/redo orange · shift yellow). RIGHT COLUMN = the function-taxonomy families. GRID = the clip-state colours (playing green · loaded blue · queued green · queued-stop red · record-armed dim red)."
  />
  <h4>Navigation palette (permanent top row)</h4>
  <div class="swatch-grid">
    {#each NAV_COLORS as c (c.state)}
      <div class="swatch-row two">
        <span class="chip" style:background={hex(c.rgb)}></span>
        <span class="s-state">{c.state}</span>
        <span class="s-note">{c.note}</span>
      </div>
    {/each}
  </div>
  <h4>Right-column function taxonomy</h4>
  <div class="swatch-grid">
    {#each TAXONOMY_COLORS as c (c.state)}
      <div class="swatch-row two">
        <span class="chip" style:background={hex(c.rgb)}></span>
        <span class="s-state">{c.state}</span>
        <span class="s-note">{c.note}</span>
      </div>
    {/each}
  </div>

  <h3>GRID view — launch clips</h3>
  <LaunchpadDiagram
    top={permTop('grid', { running: true })}
    pads={gridPads}
    scene={gridRowScene}
    callouts={gridCallouts}
    accent={hex(RGB_SCENE)}
    caption="GRID view (no shift). The 8×8 is the clip matrix, TRANSPOSED to match the on-screen card: each COLUMN is a channel/lane (1–8 left→right), each ROW is a clip slot (top row = slot 1). Loaded = dim blue · playing = solid green · queued-launch = flashing green · queued-stop = flashing red. Right column = ROW / scene launch (amber; one row shown queued)."
  />
  <ul class="tight">
    <li><strong>Tap a loaded clip</strong> (dim blue) to <strong>launch</strong> it — it flashes green
      (queued) until the next quantize boundary, then turns solid green (playing). Tap the playing clip to
      queue a <strong>stop</strong> (flashes red until the boundary).</li>
    <li><strong>Columns are channels, rows are slots.</strong> Channel 1 is the left column, slot 1 is the
      top row — the same orientation as the ClipplayerCard, so the pad you see lit is the clip you see on
      screen.</li>
    <li><strong>Row / scene launch (right column):</strong> a grid <strong>row</strong> is one clip per
      channel — an Ableton-style scene / song section. Scene button <em>N</em> fires <strong>that row's
      slot across every channel that has a clip</strong> and <strong>stops</strong> the channels that
      don't — a one-press verse → chorus switch. It flashes green while any channel in that row is queued.</li>
    <li><strong>NOW</strong> (Grid + shift, bottom of the right column) makes launches fire
      <strong>instantly</strong> instead of on the boundary while it's lit; empty pads glow dim red while
      the player is record-armed.</li>
  </ul>

  <h4 id="single-select">Single-tap launches · double-tap edits</h4>
  <p>
    A <strong>single tap launches</strong> immediately (never delayed). A <strong>double-tap</strong> of
    the same pad (~¼ s) instead <strong>selects that clip and opens it in CLIP view</strong> — and it
    <strong>reverts the channel to whatever play/queue state it was in before the first tap</strong>, so
    <strong>editing never changes whether a clip plays</strong>: a stopped clip stays stopped, a playing
    clip keeps playing, a clip you'd already queued still starts. Double-tap an <em>empty</em> pad to
    create a fresh clip and edit it. The selected clip is what the <strong>CLIP</strong> and
    <strong>KEYS</strong> buttons act on, and its channel is the one <strong>Swing ±</strong> nudges.
  </p>

  <h4>GRID + shift — the function palette</h4>
  <LaunchpadDiagram
    top={permTop('grid', { running: true, shift: 'latch' })}
    pads={gridPads}
    scene={gridShiftScene}
    callouts={gridCallouts}
    accent={hex(RGB_PATTERN_ARMED)}
    caption="GRID + shift (SHIFT latched, solid yellow). The right column becomes the function palette, top→bottom: COPY · PASTE · CLIP-DIV · SWING+ · SWING− · LENGTH · PASTE-REV · NOW. Green = pattern, blue = timing, yellow = length, orange = NOW. PASTE shows turquoise here because the clipboard holds a clip."
  />
  <ul class="tight">
    <li><strong>COPY</strong> (green): arm, then tap a loaded clip → snapshot it to the clipboard. The
      PASTE button then pulses <span class="cyan">turquoise</span>. Re-tap COPY while the clipboard is
      loaded to clear it. (Copy is a snapshot — edit after copying? re-copy.)</li>
    <li><strong>PASTE / PASTE-REV</strong> (green; they only arm when the clipboard holds a clip): arm, tap
      any pad → the buffer is written there. PASTE-REV mirrors the steps in time.</li>
    <li><strong>CLIP-DIV</strong> (blue): the per-clip divider. Arm, then <strong>tap a clip repeatedly</strong>
      to cycle its own clock division (1/8 · 1/4 · 1/2 · 1 · 2x · 4x). While you cycle, the <strong>target
      clip pad itself pulses in time with the chosen division</strong> — the meter is on the pad, not the
      top row. It writes once when you disarm, and the engine applies it at the clip's next loop start (a
      queued parameter change). A clip's own div overrides its channel's CONTROL-view RATE.</li>
    <li><strong>SWING+ / SWING−</strong> (blue): direct ±2 % nudges (hold to repeat) to the
      <strong>selected channel's</strong> swing — odd steps slide late for a shuffle. The buttons ramp
      <span style:color={hex(RGB_SWING_UP)}>purple</span> while you raise and
      <span style:color={hex(RGB_SWING_DOWN)}>blue</span> while you lower, and both <strong>flash green</strong>
      on the nudge that returns swing to dead-centre (straight). No arming — they act immediately.</li>
    <li><strong>LENGTH</strong> (yellow): arm, tap a loaded clip → its length page opens (a full-device
      takeover; EXIT returns to Grid).</li>
    <li><strong>NOW</strong> (orange, sticky): toggle on → launches ignore the quantize boundary and fire
      immediately. Stays on until you tap it again.</li>
  </ul>

  <h3>CLIP view — the note editor</h3>
  <p>
    CLIP edits the <strong>selected clip</strong>. Get here by a Grid double-tap, or <strong>hold the CLIP
    top-row button and tap a clip</strong> (the launcher peeks while you hold; the tap opens that clip's
    editor without changing whether it plays). It's the same piano-roll note editor as pair mode: X = step
    (an 8-step window = half a 16-step block), Y = pitch (in-key rows, bottom = lowest). The right column is
    CLIP's own controls.
  </p>
  <LaunchpadDiagram
    top={permTop('clip', { running: true })}
    pads={editorPads}
    scene={clipRightScene}
    callouts={editCallouts}
    accent={hex(RGB_PATTERN_ARMED)}
    caption="CLIP view (no shift), FOLLOW on. The amber column is the playhead; notes colour by velocity (dim→bright), a yellow-boosted note sits under the playhead, faint dots mark root-pitch rows. Right column, top→bottom: DOUBLE · LENGTH · FOLLOW (bright green = following) · KEYS (bright orange) · ROW+ · ROW− · STEP◀ · STEP▶."
  />
  <ul class="tight">
    <li><strong>Tap</strong> a pad to toggle a note; <strong>hold a note + tap another in its row</strong>
      to tie a held span.</li>
    <li><strong>DOUBLE</strong> (green) duplicates the pattern into the back half and doubles the length
      (cap 128). <strong>LENGTH</strong> (green) opens the length page. <strong>FOLLOW</strong> (green →
      bright green while following) auto-scrolls the window with the playhead; a manual step scroll freezes
      it — tap FOLLOW to resume.</li>
    <li><strong>KEYS</strong> (bright orange) drops the device into the <a href="#single-keys">KEYS</a>
      keyboard for this clip.</li>
    <li><strong>ROW+ / ROW−</strong> (green) scroll the pitch window ±1 row; <strong>STEP◀ / STEP▶</strong>
      (blue) scroll the 8-step window ±1 step — essential for clips longer than 8 steps.</li>
  </ul>
  <h4>CLIP + shift — velocity + big jumps</h4>
  <LaunchpadDiagram
    top={permTop('clip', { running: true, shift: 'latch' })}
    pads={clipVelWashPads}
    scene={clipShiftScene}
    callouts={editCallouts}
    accent={hex(RGB_TIMING_ARMED)}
    caption="CLIP + shift. The 8×8 becomes VELOCITY-cycle (a faint purple wash over empty cells) — tap a note to cycle its velocity. The top two right-column buttons turn ORANGE — DOUBLE → QUEUE, LENGTH → NOW (launch the edited clip without leaving the editor). ROW± brighten (they jump a whole octave / page) and STEP± brighten (they jump a full block); FOLLOW / KEYS are unchanged."
  />
  <ul class="tight">
    <li><strong>Velocity:</strong> under shift, tapping a note <strong>cycles its velocity</strong> instead
      of toggling it (the whole grid is in velocity-edit mode; empty cells show a faint purple wash).</li>
    <li><strong>Launch from the editor:</strong> under shift the top two right-column buttons turn
      <strong>orange</strong> — <strong>QUEUE</strong> (was DOUBLE) starts the edited clip at the next
      boundary after the channel's playing clip (or the usual grid-queue time if the channel is idle), and
      <strong>NOW</strong> (was LENGTH) starts it instantly at the step it should be on — so you can launch
      the clip you're editing without leaving the note editor.</li>
    <li><strong>Big jumps:</strong> under shift <strong>ROW±</strong> page the pitch window by an octave and
      <strong>STEP±</strong> jump a full 8-step block — quick travel across a long clip.</li>
    <li>The clip's <strong>scale</strong> is set in <a href="#single-keys">KEYS</a> (there's no separate
      scale button here).</li>
  </ul>

  <h3 id="single-keys">KEYS view — play, record + arpeggiate</h3>
  <p>
    <strong>KEYS</strong> turns the device into a playable <strong>isomorphic keyboard</strong>
    (LinnStrument-style, chromatic fourths) routed live to the selected clip's channel, <em>and</em> a
    <strong>loop recorder</strong>, <em>and</em> an <strong>arpeggiator</strong>. Enter it from
    <strong>CLIP → KEYS</strong> (bright orange, right column). The clip plays under you while the keyboard
    is live; recording is armed-but-idle until you tap QUEUE-REC.
  </p>
  <LaunchpadDiagram
    top={permTop('clip', { running: true, keys: true })}
    pads={keysSinglePads}
    scene={keysScaleScene}
    callouts={keysSingleCallouts}
    accent={hex(RGB_PATTERN_ARMED)}
    caption="KEYS (no shift) — scale select. The permanent nav row is on top (CLIP lit — KEYS is a Clip sub-view). Middle 6 rows = the keyboard (root cyan, in-scale green, out-of-scale dim, pressed white). Grid top row = the whole clip's playhead in 8 cells. Bottom row = EXIT · QUEUE-REC · OVERDUB · OCT− · OCT+ · PANIC · LEN. RIGHT COLUMN = scale select, top→bottom: MAJOR (selected, bright green) · MINOR · PENTATONIC · DORIAN · PHRYGIAN · MIXOLYDIAN · CHROMATIC · ARP on/off (dim orange = off)."
  />
  <ul class="tight">
    <li><strong>Scale select (right column):</strong> tap a scale to set the clip's scale — the selected
      one glows bright green. Seven choices: <strong>major · minor · pentatonic · dorian · phrygian ·
      mixolydian · chromatic</strong>. The scale <em>lights</em> the keyboard (root cyan, in-scale green)
      but does <strong>not</strong> snap what you play — the pads stay fully chromatic.</li>
    <li><strong>Record a loop:</strong> tap <strong>QUEUE-REC</strong> to arm (flashes yellow); recording
      begins when the playhead wraps to step 1 (the transport auto-starts) and the cell turns red.
      <strong>OVERDUB off</strong> = true-replace (each step is cleared as the playhead crosses it);
      <strong>OVERDUB on</strong> = additive layering until you toggle it off. Entering from CLIP → KEYS
      always starts overdub OFF — toggle OVR inside KEYS to layer.</li>
    <li><strong>OCT− / OCT+</strong> shift the whole keyboard an octave; <strong>PANIC</strong> kills every
      sounding note; <strong>LEN</strong> opens the length page (EXIT returns straight to KEYS).</li>
    <li><strong>Getting out:</strong> <strong>EXIT</strong> while recording stops the take (you stay in
      KEYS); EXIT again returns to the views. A <strong>view button</strong> also leaves KEYS at any time.</li>
    <li><strong>ARP on/off</strong> (bottom of the right column, orange) turns the arpeggiator on — then
      hold SHIFT for its controls (next).</li>
  </ul>
  <h4>KEYS + shift — the arpeggiator</h4>
  <LaunchpadDiagram
    top={permTop('clip', { running: true, keys: true })}
    pads={keysSinglePads}
    scene={keysArpScene}
    callouts={keysSingleCallouts}
    accent={hex(RGB_TIMING)}
    caption="KEYS + shift — the arp control column, top→bottom: DIV+ · DIV− (blue) · UP · DOWN · UP-AND-DOWN (green; UP selected, bright) · RANGE+ · RANGE− (orange) · LATCH (dim orange = off). The keyboard + playhead stay live; the notes you hold feed the arp."
  />
  <ul class="tight">
    <li><strong>Turn it on</strong> (ARP button, no-shift) and hold a chord — the arp sequences your held
      notes through the SAME channel output as the keyboard, in time with the transport.</li>
    <li><strong>DIV+ / DIV−</strong> set the rate: <strong>8x · 4x · 2x · 1x</strong> (default) <strong>·
      1/2 · 1/4 · 1/8</strong> of the clock. DIV+ is faster.</li>
    <li><strong>UP · DOWN · UP-AND-DOWN</strong> set the direction (the selected one glows bright green).
      <strong>Up-and-down is an exclusive pendulum</strong> — each extreme is played once
      (C-E-G-E-C…), never doubled, so 2–3 note chords don't stutter.</li>
    <li><strong>RANGE+ / RANGE−</strong> widen the octave span: <strong>1 oct</strong> (default) <strong>·
      +1..−1 · +2..−2</strong>. These are <em>symmetric</em> ranges around the held notes (the classic
      hardware norm is upward-only 1–4 octaves — a one-line change if ever wanted).</li>
    <li><strong>LATCH</strong> (orange): hold the note set after you release the keys, so the arp keeps
      running hands-free. A fresh press after a full release replaces the set; pressing while a key is
      still down adds to it.</li>
  </ul>

  <h3>ARRANGER view — reserved</h3>
  <LaunchpadDiagram
    top={permTop('arranger')}
    pads={arrangerPads}
    accent={hex(RGB_VIEW_ACTIVE)}
    caption="ARRANGER view is an inert placeholder for now: a faint dim 8×8 and a dark right column, with the ARRANGER nav button lit bright purple. No pad or scene handlers are wired to it yet."
  />
  <p class="muted">
    The arrangement <em>engine</em> (record + replay your live launches as a song) already exists, but it
    has no launchpad UI in this rework — so <strong>ARRANGER is a lit-but-inert view</strong>. Its two
    controls, <strong>REC</strong> (record-arm) and <strong>SONG</strong> (SESSION ⇄ ARRANGEMENT), are
    parked in <strong>CONTROL</strong> for now (below).
  </p>

  <h3>CONTROL view — the performance deck</h3>
  <LaunchpadDiagram
    top={permTop('control', { running: true })}
    pads={controlPads}
    scene={controlScene}
    callouts={controlCallouts}
    accent={hex(RGB_RESET)}
    caption="CONTROL view. RESET (row 1 col 2, steel blue) · MONO row (teal) · MUTE row (orange when muted) · RATE row (a cool→warm ramp; shown all-default '1') — one pad per channel. Right column = per-lane STOP (bright red = that channel is audible). Re-homed onto the dark top grid rows: TEMPO− · TEMPO+ · STOP-ALL, and REC · SONG one row below."
  />
  <ul class="tight">
    <li><strong>RESET (RST, steel blue):</strong> snap every playing channel back to step 1 at one shared
      instant — the classic "everyone back on the one". The same field as the card's RST button and the
      reset gate. Reset ≠ stop: clips keep playing, just re-aligned.</li>
    <li><strong>MONO row (teal):</strong> toggle a channel between MONO (one note per column) and POLY
      (chords). <strong>MUTE row (orange):</strong> mute a channel <em>in place</em> — it keeps advancing
      its playhead (stays locked to the transport) but goes silent, so it drops out and snaps back on the
      beat. That's different from per-lane STOP, which halts the channel.</li>
    <li><strong>RATE row:</strong> tap to cycle a channel's clock division up through <strong>1/8 · 1/4 ·
      1/2 · 1 · 2x · 4x</strong> (wrapping; the colour ramps cool→warm, green = the default '1'). A clip's
      own Grid-shift CLIP-DIV overrides this per clip.</li>
    <li><strong>Per-lane STOP (right column):</strong> stop one channel (bright red = audible now).</li>
    <li><strong>Re-homed transport / arranger:</strong> <strong>TEMPO− / TEMPO+</strong> nudge the rack
      tempo ±2 bpm; <strong>STOP-ALL</strong> queues a stop on every channel; <strong>REC</strong> arms the
      arranger (records your live launches — not audio) and <strong>SONG</strong> flips SESSION ⇄
      ARRANGEMENT to replay them. (These four moved here off the old deck top row, which is now the
      permanent nav bar.)</li>
  </ul>

  <h3 id="single-undo">Undo / redo — launchpad-scoped</h3>
  <p class="muted">
    <strong>UNDO (CC 96)</strong> and <strong>REDO (CC 97)</strong> undo only <em>this</em> launchpad's own
    <strong>persistent</strong> clip edits — div, swing, length, paste, note content, scale. They never
    touch a collaborator's edits (each surface has its own scoped history, so you can't revert someone
    else's work) and never touch <strong>transient launches</strong> (a queued clip isn't "edited", so it
    isn't on the stack). The buttons light orange when there's something to undo / redo, dim when the stack
    is empty.
  </p>

  <h3>LENGTH-EDIT — set an exact clip length</h3>
  <LaunchpadDiagram
    pads={lenPads}
    scene={lenScene}
    callouts={lenCallouts}
    accent={hex(RGB_LEN_END)}
    caption="LENGTH-EDIT page (shown: 3 blocks, end-step 4 → 36 steps). A full-device takeover opened from GRID+shift LENGTH or CLIP LENGTH. Bottom row = end BLOCK (1–8, ×16 steps each); the next two rows = end STEP (1–8, then 9–16). The bright pad is the current end — tap to set. Non-destructive; EXIT (top scene button) returns to the view you came from."
  />
  <p class="muted">
    Length = (endBlock−1)×16 + endStep, up to 128. Each clip's length is independent — polymeter is the
    point — and all playing clips re-align to step 1 when the transport starts (or on a RESET). The nav row
    goes dark on this page but stays live: <strong>EXIT</strong> (top scene button) or any top-row
    <strong>view</strong> button leaves it.
  </p>

  <h3 id="single-signal-flow">Signal flow — how one pad drives sound</h3>
  <p class="muted">
    The Launchpad never makes sound itself. It drives the <strong>clip player</strong>, whose eight
    per-channel outputs carry <strong>gate</strong> (triggers) and <strong>poly pitch</strong> to your
    voice modules. KEYS + the arp reach the same per-channel output, so the notes you play / record land on
    the same cables the clips fire.
  </p>
  <figure class="sigflow">
    <svg viewBox="0 0 732 216" width="732" height="216" role="img" aria-label="Signal flow: Launchpad → clip player → voice modules → output">
      <defs>
        <marker id="sfhead" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" class="sf-head" />
        </marker>
      </defs>
      <!-- Launchpad -->
      <rect class="sf-box" x="8" y="96" width="132" height="54" rx="8" />
      <text class="sf-txt" x="74" y="120" text-anchor="middle">Launchpad</text>
      <text class="sf-sub" x="74" y="135" text-anchor="middle">Mini Mk3</text>
      <path class="sf-arrow" d="M140 123 H176" />
      <text class="sf-cable" x="158" y="116" text-anchor="middle">Web MIDI</text>
      <!-- clip player -->
      <rect class="sf-box hl" x="176" y="40" width="150" height="172" rx="8" />
      <text class="sf-txt" x="251" y="60" text-anchor="middle">clip player</text>
      <text class="sf-sub" x="251" y="75" text-anchor="middle">8 channels</text>
      <rect class="sf-chan" x="184" y="90" width="134" height="20" rx="4" />
      <text class="sf-sub" x="192" y="104">ch 1  → kick</text>
      <rect class="sf-chan" x="184" y="118" width="134" height="20" rx="4" />
      <text class="sf-sub" x="192" y="132">ch 2  → snare</text>
      <rect class="sf-chan" x="184" y="146" width="134" height="20" rx="4" />
      <text class="sf-sub" x="192" y="160">ch 3  → TIDY VCO</text>
      <text class="sf-sub" x="192" y="186">…ch 4–8</text>
      <!-- voice modules -->
      <rect class="sf-box" x="392" y="34" width="120" height="40" rx="8" />
      <text class="sf-txt" x="452" y="58" text-anchor="middle">kickdrum</text>
      <rect class="sf-box" x="392" y="100" width="120" height="40" rx="8" />
      <text class="sf-txt" x="452" y="124" text-anchor="middle">snaredrum</text>
      <rect class="sf-box" x="392" y="156" width="140" height="44" rx="8" />
      <text class="sf-txt" x="462" y="176" text-anchor="middle">TIDY VCO</text>
      <text class="sf-sub" x="462" y="190" text-anchor="middle">(poly)</text>
      <!-- clip → voices -->
      <path class="sf-arrow" d="M326 100 C356 100 362 54 392 54" />
      <text class="sf-cable" x="356" y="50" text-anchor="middle">gate1</text>
      <path class="sf-arrow" d="M326 128 C356 128 362 120 392 120" />
      <text class="sf-cable" x="356" y="112" text-anchor="middle">gate2</text>
      <path class="sf-arrow" d="M326 156 C356 156 362 178 392 178" />
      <text class="sf-cable" x="352" y="205" text-anchor="middle">pitch3 (poly) + gate3</text>
      <!-- output -->
      <rect class="sf-box" x="596" y="100" width="120" height="44" rx="8" />
      <text class="sf-txt" x="656" y="126" text-anchor="middle">mixer / out</text>
      <path class="sf-arrow" d="M512 54 C556 54 560 116 596 116" />
      <path class="sf-arrow" d="M512 120 C556 120 560 122 596 122" />
      <path class="sf-arrow" d="M532 178 C566 178 566 130 596 130" />
    </svg>
    <figcaption>
      One Launchpad → the clip player's channels → gate + poly-pitch cables → your voice modules → your
      mix. KEYS and the arpeggiator push notes onto the same per-channel output the clips fire.
    </figcaption>
  </figure>

  <h3>Single-unit pad + CC reference</h3>
  <div class="table-scroll">
    <table class="map">
      <tbody>
        {#each SINGLE_MAP as r (r.what)}
          <tr><td class="m-what">{r.what}</td><td class="m-addr"><code>{r.addr}</code></td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<!-- ======================================================================
     TWO LAUNCHPADS — fully self-contained. A reader in pair mode never needs
     the SINGLE LAUNCHPAD section.
     ====================================================================== -->
<section class="mode-section" id="two-launchpads">
  <h2 class="mode-title">TWO LAUNCHPADS — matrix + command deck</h2>
  <p>
    With a pair, the <strong>LEFT</strong> unit is <strong>permanently the 8×8 clip matrix</strong> —
    it never flips away, so your performance surface is always visible — and the <strong>RIGHT</strong>
    unit is the <strong>command deck</strong>, which becomes the <strong>note editor</strong> or the
    <strong>length page</strong> while you edit. Every deck function is a held or tapped button on R
    acting on clips you tap on L.
  </p>

  <h3>Setup — pairing</h3>
  <ol class="steps">
    <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong> to the canvas.</li>
    <li>Click <strong>Pair Launchpads</strong> (grants Web-MIDI/sysex on first click).
      <strong>Both units flood with colour</strong> — one green, one blue.</li>
    <li><strong>Press any pad on the unit you want as LEFT</strong> (the matrix). The other becomes
      RIGHT. Pairing auto-binds the first clip player.</li>
    <li>Two identical units are told apart automatically by port order — if L/R come out swapped, just
      <strong>Re-pair</strong> and press the other unit.</li>
  </ol>

  <h3>Unit L — the clip matrix (always live)</h3>
  <LaunchpadDiagram
    top={matrixMuteTop}
    pads={matrixPads}
    scene={matrixScene}
    callouts={matrixMuteCallouts}
    accent={hex(RGB_MUTE_ON)}
    caption="PAIR · UNIT L. Rows = the 8 instrument lanes (top→bottom, matching the on-screen card — lane 1 is the top row), columns = the 8 clip slots. Tap a clip to launch it / stop its lane (next quantize boundary; hold NOW on R to fire instantly). Right column = scene launch (amber). TOP ROW (formerly dark) = the 8 per-lane MUTE pads (numbered 1–8; orange = muted, dim = live) — mute a lane in place without leaving the matrix."
  />
  <ul class="tight">
    <li><strong>Tap a loaded clip</strong> (dim blue) to <strong>launch</strong> — flashing green =
      queued for the boundary, solid green = playing. Tap the playing clip to queue a
      <strong>stop</strong> (flashes red).</li>
    <li>Pad <code>(slot, lane)</code> is clip <code>lane*8 + slot</code>; <strong>lane 1 = the TOP
      physical row</strong>, matching the card.</li>
    <li><strong>Scene launch (right column):</strong> scene button <em>N</em> fires <strong>slot N in
      every lane that has a clip</strong> and <strong>stops</strong> the lanes that don't — a one-press
      section switch. Same quantize rules; hold <strong>NOW</strong> on R to fire instantly.</li>
    <li>Empty pads glow <strong>dim red</strong> while the player is record-armed (REC).</li>
    <li><strong>TOP ROW = per-lane MUTE (new).</strong> The 8 buttons across the top of Unit L (once
      dark) are now a <strong>MUTE per lane</strong> — <strong>tap CC <em>N</em> to mute/un-mute lane
      <em>N</em></strong> right on the always-visible matrix. A muted lane keeps running its playhead
      (stays locked to the transport) but goes silent; orange = muted, dim = live. This is <em>mute in
      place</em>, distinct from the R deck's per-lane STOP (which halts the lane).</li>
    <li>The matrix <strong>stays live while you edit</strong> — editing happens on Unit R.</li>
  </ul>

  <h3>Unit R — the command deck</h3>
  <LaunchpadDiagram
    pads={deckPads}
    top={pairDeckTop}
    scene={deckScene}
    callouts={deckCallouts}
    caption="PAIR · UNIT R (session deck). Row 0 = function pads: EDIT (orange), COPY/PASTE/P-REV (green), BUF (dark until you copy), DBL + NOW (purple), LEN (yellow). Row 1 = KEYS-entry holds K● / KO + RST (steel blue). Rows 2/3/4 = per-lane MONO (teal) / MUTE (orange) / RATE (rate ramp). Right column = per-lane STOP. Top row: REC · SONG · T− · T+ · PLAY · ALL."
  />
  <ul class="tight">
    <li><strong>EDIT (hold) + tap a clip on L</strong> → open its note editor on R (an empty pad gets a
      fresh clip). The tap doesn't launch.</li>
    <li><strong>COPY / PASTE / PASTE-REV (hold) + tap a clip on L</strong> → copy / paste /
      paste-reversed. Copy takes a <strong>snapshot</strong>; the <strong>BUF</strong> pad pulses
      turquoise while the clipboard holds a clip — <strong>tap BUF to clear it</strong>. (Edit after
      copying? Re-copy to capture the change.)</li>
    <li><strong>DOUBLE</strong> duplicates the pattern + doubles the length (cap 128).
      <strong>LENGTH</strong> opens the 2-row length page on R. <strong>NOW (hold)</strong> makes
      launches ignore quantize.</li>
    <li><strong>Per-lane STOP (right column):</strong> row <em>N</em> stops lane <em>N</em> (bright red =
      audible now). <strong>PLAY (CC 96)</strong> toggles the transport; <strong>ALL (CC 97)</strong>
      queues a stop on every lane.</li>
    <li><strong>K● / KO (row 1):</strong> the KEYS-entry holds — see
      <a href="#pair-keys">KEYS across both units</a>.</li>
  </ul>
  <h4>Performance controls on the R deck (formerly dead pads)</h4>
  <p>
    The R deck carries the <strong>same performance layer as the single-unit deck</strong> (single mode
    IS this R brain, so the two match). All write the synced clip-player / transport state:
  </p>
  <ul class="tight">
    <li><strong>RST (row 1, col 2):</strong> snap every playing lane back to step 1 — a shared re-sync
      (the card RST / reset-gate field). Note: MUTE is <em>also</em> on <strong>Unit L's top row</strong>
      so you can mute lanes without looking away from the matrix; RST/MONO/RATE live here on R.</li>
    <li><strong>MONO row (row 2):</strong> per-lane MONO ⇄ POLY (teal = mono).</li>
    <li><strong>MUTE row (row 3):</strong> per-lane mute-in-place (orange = muted) — mirrors Unit L's
      top row (either surface toggles the same lane).</li>
    <li><strong>RATE row (row 4):</strong> tap to cycle a lane's clock division 1/8…4x (colour ramps
      with the rate; green = the default ‘1’).</li>
    <li><strong>T− / T+ (CC 93 / 94):</strong> nudge the transport tempo ±2 bpm per tap.</li>
  </ul>

  <h4>Record a song (arranger)</h4>
  <p class="muted">
    The arranger records your <strong>live clip-launch performance</strong> — which clips you fire, in
    which lanes, exactly when — and plays it back as a song. It records <em>launches</em>, not audio,
    so the clips stay fully editable. Identical to the card's <strong>●</strong> REC +
    <strong>SES/ARR</strong> buttons (both write the same synced state).
  </p>
  <ol class="steps">
    <li>Be in <strong>SESSION</strong> (SONG / CC 92 dim white) with the <strong>transport running</strong>
      (PLAY / CC 96) so song-time advances.</li>
    <li>Press <strong>REC</strong> (CC 91 on R) — it pulses red. In the default <strong>REPLACE</strong>
      mode arming clears the previous take and restarts at bar 1; switch the RPL/OVR pill on the card
      for overdub-merge.</li>
    <li><strong>Perform on L</strong> — every launch/stop/scene is captured exactly when it applies
      (quantized launches on the boundary; NOW launches instantly).</li>
    <li>Press <strong>REC</strong> again to disarm. Press <strong>SONG</strong> (CC 92) to switch to
      <strong>ARRANGEMENT</strong> (bright white) — playback runs your recorded launches from the top,
      looping. <strong>SONG</strong> again returns to live SESSION play.</li>
  </ol>

  <h3>Unit R — the note editor</h3>
  <LaunchpadDiagram
    pads={editorPads}
    top={pairEditTopFollowing}
    scene={pairEditScene}
    callouts={editCallouts}
    caption="PAIR · UNIT R flips here while editing, FOLLOW ON. X = step (an 8-step window = half a 16-step block), Y = pitch (in-key, bottom = lowest). The amber column is the playhead. FOL (CC 98) is green while the window auto-scrolls with the playhead. Right column: EXIT · DBL · LEN · CPY · PST · OC+ · OC− (the P6 clipboard + octave shortcuts). Unit L keeps the live matrix the whole time."
  />
  <LaunchpadDiagram
    pads={editorPads}
    top={pairEditTopFrozen}
    scene={pairEditScene}
    callouts={editCallouts}
    accent={hex(RGB_FUNC_ON)}
    caption="PAIR · UNIT R editor, FOLLOW FROZEN. FOL (CC 98) turns violet: the window stays put while the playhead runs on. Any manual ◀/▶ scroll freezes automatically; tap FOL to resume following."
  />
  <ul class="tight">
    <li><strong>Get in:</strong> hold <strong>EDIT</strong> on R + tap a clip on L.
      <strong>Get out:</strong> <strong>EXIT</strong> (top scene button on R).</li>
    <li><strong>Tap</strong> a pad to toggle a note; <strong>hold a note + tap another in its row</strong>
      to tie a held span.</li>
    <li><strong>▲ ▼</strong> scroll pitch ±1 row; <strong>◀ ▶</strong> scroll the step window ±1 step.
      <strong>Hold SHIFT</strong> (CC 95) → both jump a full screen (±8).</li>
    <li><strong>VEL</strong> (CC 96, hold + tap a note) cycles its velocity;
      <strong>SCALE</strong> (CC 97) cycles the clip scale.</li>
    <li><strong>FOLLOW (CC 98):</strong> green = the window auto-scrolls with the playhead; violet =
      frozen on the page you chose. A manual ◀/▶ scroll freezes; <strong>tap FOL to resume
      following</strong>.</li>
    <li><strong>DBL</strong> (scene row 2) doubles the clip; <strong>LEN</strong> (scene row 3) opens the
      length page.</li>
    <li><strong>CPY · PST · OC+ · OC− (scene rows 4–7 from the bottom):</strong> <strong>CPY</strong>
      snapshots the edited clip to the clipboard; <strong>PST</strong> (green once loaded) writes it
      over the current clip; <strong>OC+ / OC−</strong> jump the pitch window up / down a whole octave.</li>
  </ul>

  <h3>Unit R — LENGTH-EDIT</h3>
  <LaunchpadDiagram
    pads={lenPads}
    scene={lenScene}
    callouts={lenCallouts}
    caption="PAIR · UNIT R LENGTH-EDIT page (shown: 3 blocks, end-step 4 → 36 steps). Bottom row = end BLOCK (1–8, ×16 steps each); the next two rows = end STEP within the end block (1–8, then 9–16). The bright pad is the current end — tap to set. Non-destructive: shortening hides notes past the end, lengthening brings them back. EXIT top-right."
  />
  <p class="muted">
    Open it from the deck's <strong>LEN</strong> pad or the editor's <strong>LEN</strong> scene pad.
    Length = (endBlock−1)×16 + endStep, up to 128. Each clip's length is independent — polymeter is the
    point — and all playing clips re-align to step 1 when the transport starts.
  </p>

  <h3 id="pair-keys">KEYS — play + record notes across both units</h3>
  <p class="muted">
    <strong>KEYS</strong> turns the <strong>pair</strong> into one wide playable <strong>isomorphic
    keyboard</strong> (LinnStrument-style, chromatic fourths) routed live to a clip's track,
    <em>and</em> a <strong>loop recorder</strong>. Both units flip to KEYS together (the matrix is
    hidden until you EXIT) and the keyboard is <strong>continuous across the L|R seam</strong> — a
    chord shape crossing the two units is the same shape.
  </p>
  <div class="diagram-pair">
    <LaunchpadDiagram
      pads={keysLPads}
      callouts={keysPairLCallouts}
      accent={hex(RGB_QREC_REC)}
      caption="PAIR · KEYS, UNIT L. Top row = playhead cells 1–8 (of 16). Middle 6 rows = the keyboard's left half (root cyan, in-scale green, out-of-scale dim, pressed white). Bottom row = controls: EXIT (red), QUEUE-REC (yellow → red), OVERDUB (purple), O− / O+ (octave), PNC (panic), LEN (yellow)."
    />
    <LaunchpadDiagram
      pads={keysRPads}
      callouts={keysPairRCallouts}
      caption="PAIR · KEYS, UNIT R. The keyboard continues (columns 9–16) so shapes cross the seam unbroken; the top row shows playhead cells 9–16. R's bottom row is dark — the controls live on unit L."
    />
  </div>
  <h4>Getting in — a two-step safety gesture</h4>
  <ol class="steps">
    <li><strong>Hold K●</strong> (note-REC — enter with overdub OFF / true-replace) or <strong>KO</strong>
      (note-OVERDUB — enter with overdub ON / additive) on the RIGHT deck (the row just above
      EDIT/COPY). While held, taps on the LEFT matrix <strong>don't launch</strong>.</li>
    <li><strong>Double-tap a clip on the LEFT</strong> (two quick taps of the same pad) → both units
      flip to <strong>KEYS</strong> for that clip (an empty pad makes a fresh clip). The clip starts
      <strong>playing</strong>, the keyboard is <strong>live</strong>, and recording is
      <strong>armed-but-idle</strong> until you press QUEUE-REC.</li>
  </ol>
  <h4>Record a loop</h4>
  <ul class="tight">
    <li><strong>QUEUE-REC</strong> (bottom row, unit L): tap to <strong>arm</strong> — flashes yellow.
      Recording begins when the playhead <strong>wraps to step 1</strong> (the transport auto-starts if
      stopped); the pad turns red. Re-tap while armed to cancel.</li>
    <li><strong>Overdub OFF = TRUE REPLACE:</strong> each step is cleared as the playhead crosses it,
      then refilled by what you play that pass — an un-played region wipes.</li>
    <li><strong>OVERDUB ON = additive:</strong> each pass layers onto the last, looping endlessly;
      toggle <strong>OVR</strong> off to finish (it stops at the end of the current loop).</li>
    <li><strong>LEN</strong> opens the length page on R (EXIT returns straight to KEYS while L keeps the
      live keyboard), so you can resize the loop without leaving.</li>
    <li><strong>O− / O+ (octave, unit L bottom row):</strong> shift the whole keyboard down / up an
      octave. <strong>PNC (panic):</strong> kill every sounding note instantly (stays in KEYS).</li>
    <li>Velocity is captured from how hard you hit (a Launchpad X is expressive automatically; a
      velocity-flat Mini records a default level).</li>
  </ul>
  <h4>Getting out</h4>
  <ul class="tight">
    <li><strong>EXIT while recording</strong> = stop recording, <strong>stay in KEYS</strong> (the clip
      keeps playing). <strong>EXIT while armed</strong> = cancel the arm. <strong>EXIT while idle</strong>
      = back to the session (L = matrix, R = deck).</li>
  </ul>

  <h3>Two-unit pad + CC reference</h3>
  <div class="table-scroll">
    <table class="map">
      <tbody>
        {#each PAIR_MAP as r (r.what)}
          <tr><td class="m-what">{r.what}</td><td class="m-addr"><code>{r.addr}</code></td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<!-- ======================================================================
     MAKE A PATCH IN 1-PAD MODE — the beginner start-to-finish walkthrough.
     ====================================================================== -->
<section class="mode-section" id="make-a-patch">
  <h2 class="mode-title">Make a patch in 1-pad mode</h2>
  <p>
    Never touched the device? This is the whole journey on <strong>one Launchpad</strong> — plug in, wire
    three voices, record a bassline in KEYS, lay clips in GRID, build scenes, and perform — with every
    button press spelled out. By the end you'll have a live three-voice patch: <strong>kick</strong>,
    <strong>snare</strong> and a poly <strong>TIDY VCO</strong> bassline.
  </p>

  <h3>1 · Plug in + connect</h3>
  <ol class="steps">
    <li>Plug the <strong>Launchpad Mini Mk3</strong> into a USB port.</li>
    <li>On the canvas, drop a <strong>launchpad control</strong> and a <strong>clip player</strong> (in
      workflow mode, add them from the module drawer — the clip player is the brain the pad drives).</li>
    <li>Click <strong>Connect single Launchpad</strong> on the launchpad card and accept the browser's
      Web-MIDI prompt (first click only). The pad lights up in <strong>GRID view</strong> and auto-binds
      the clip player.</li>
  </ol>

  <h3>2 · Wire three voices</h3>
  <p>
    Add a <strong>kickdrum</strong>, a <strong>snaredrum</strong>, a <strong>TIDY VCO</strong>, and a
    <strong>TIMELORDE</strong> (the rack transport). Wire one clip-player channel per voice — the channels
    are the pad's columns:
  </p>
  <ul class="tight">
    <li><strong>Channel 1 → kick:</strong> <code>gate1</code> → the kickdrum's trigger (drums fire on the
      gate; pitch optional).</li>
    <li><strong>Channel 2 → snare:</strong> <code>gate2</code> → the snaredrum's trigger.</li>
    <li><strong>Channel 3 → TIDY VCO (poly):</strong> <code>pitch3</code> (the poly pitch cable) → TIDY
      VCO's pitch, and <code>gate3</code> → its gate. Make channel 3 polyphonic so it plays chords: in
      <strong>CONTROL view</strong> its <strong>MONO</strong> pad (row 2, third column) should be
      <em>dim</em> — dim = poly, teal = mono.</li>
    <li>Run each voice to your output. See <a href="#single-signal-flow">Signal flow</a> for the full
      picture.</li>
  </ul>

  <h3>3 · Record a bassline into channel 3 (KEYS)</h3>
  <LaunchpadDiagram
    top={permTop('clip', { running: true, keys: true })}
    pads={keysSinglePads}
    scene={keysScaleScene}
    callouts={keysSingleCallouts}
    accent={hex(RGB_PATTERN_ARMED)}
    caption="STEP 3 — KEYS on channel 3. Right column = scale select (MAJOR selected). Play the keyboard rows; QUEUE-REC captures a loop; ARP (bottom orange) + SHIFT open the arp column if you want it."
  />
  <ol class="steps">
    <li>In <strong>GRID</strong>, <strong>double-tap</strong> the <strong>channel-3, slot-1 pad</strong>
      (third column, top row) — or <strong>hold CLIP and tap it</strong> — → the clip opens in
      <strong>CLIP view</strong> (an empty pad makes a fresh clip).</li>
    <li>Press <strong>KEYS</strong> (right column, 4th from the top, bright orange) → the device becomes the
      keyboard for that clip; the transport starts and the clip plays.</li>
    <li><strong>Pick a scale:</strong> tap a scale in the right column — e.g. <strong>MINOR</strong> (2nd
      from top). The selected scale glows bright green and lights the in-key rows.</li>
    <li><strong>(Optional) arpeggiate:</strong> tap <strong>ARP</strong> (bottom of the right column), then
      <strong>hold SHIFT</strong> and set <strong>direction</strong> (UP), <strong>DIV</strong> (e.g. 1/2)
      and <strong>RANGE</strong>. Hold a chord and it sequences itself; tap <strong>LATCH</strong> to keep
      it running hands-free.</li>
    <li><strong>Record:</strong> tap <strong>QUEUE-REC</strong> (bottom row, 2nd pad) — it flashes yellow,
      then turns red at the loop top. Play your bassline (use <strong>OCT−</strong> for a deeper register).
      Leave <strong>OVERDUB</strong> off for a clean replace, or toggle it on to layer.</li>
    <li><strong>Stop:</strong> tap <strong>EXIT</strong> (bottom-left) to end the take (you stay in KEYS),
      then a <strong>view button</strong> (GRID) to leave KEYS.</li>
  </ol>

  <h3>4 · Lay clips on channels 1 + 2 (GRID)</h3>
  <LaunchpadDiagram
    top={permTop('grid', { running: true })}
    pads={gridPads}
    scene={gridRowScene}
    callouts={gridCallouts}
    accent={hex(RGB_SCENE)}
    caption="STEP 4 — clips laid in. Columns = channels (1 kick · 2 snare · 3 bass), rows = slots. Record a kick clip in channel-1 slot 1, a snare clip in channel-2 slot 1, then fill slots 2–3 for variations. Right column = row / scene launch."
  />
  <ol class="steps">
    <li><strong>Kick clip:</strong> in GRID, double-tap <strong>channel-1, slot-1</strong> (top-left pad) →
      CLIP → <strong>KEYS</strong> → QUEUE-REC → tap out a four-on-the-floor on the low rows → EXIT →
      GRID.</li>
    <li><strong>Snare clip:</strong> double-tap <strong>channel-2, slot-1</strong> (second column, top row)
      → CLIP → KEYS → QUEUE-REC → play the backbeat → EXIT → GRID.</li>
    <li><strong>Variations (slots 2–3):</strong> for a fast copy, latch <strong>SHIFT</strong>, tap
      <strong>COPY</strong> (right column, top), tap a source clip, tap <strong>PASTE</strong>, then tap
      the empty slot below it — now tweak. Repeat so each channel has 2–3 slots.</li>
    <li>Tapping any loaded pad <strong>launches just that clip</strong>; you'll launch whole rows next.</li>
  </ol>

  <h3>5 · Build scenes with the row-launch column</h3>
  <p>
    A grid <strong>row</strong> is a <strong>scene</strong> — one clip per channel firing together. Slot 1
    (top row) is your main groove; slot 2 a breakdown; slot 3 a fill.
  </p>
  <ol class="steps">
    <li>Press the <strong>top scene button</strong> (right column, top) → the slot-1 clip in every channel
      launches together (kick + snare + bass) on the next boundary.</li>
    <li>Press the <strong>second scene button</strong> → every channel switches to its slot-2 clip at once —
      a one-press section change. Channels with no clip in that slot stop.</li>
    <li>That's your arrangement: each row is a section, and one button moves the whole band between them.</li>
  </ol>

  <h3>6 · Perform</h3>
  <LaunchpadDiagram
    top={permTop('control', { running: true })}
    pads={controlPads}
    scene={controlScene}
    callouts={controlCallouts}
    accent={hex(RGB_RESET)}
    caption="STEP 6 — CONTROL, the live layer: RESET · MONO · MUTE · RATE rows (one pad per channel), per-lane STOP, and the re-homed TEMPO / STOP-ALL / REC / SONG. Flip here mid-set for hands-on control, GRID to launch."
  />
  <ol class="steps">
    <li><strong>Mute the kick for a breakdown:</strong> press <strong>CONTROL</strong> (top row), tap
      <strong>channel 1's MUTE pad</strong> (row 3, first column) — the kick goes silent in place (its
      playhead keeps running, so it snaps back on beat). Tap again to bring it back.</li>
    <li><strong>Half-time the bass:</strong> on the <strong>RATE row</strong> (row 4), tap <strong>channel
      3's pad</strong> until it reads <strong>1/2</strong> — the bass drops to half-time for a section.</li>
    <li><strong>Add a shuffle:</strong> back in GRID, latch <strong>SHIFT</strong> and tap
      <strong>SWING+</strong> a few times (it ramps purple) to swing the selected channel; the button
      flashes green when you return to straight.</li>
    <li><strong>Reshape a clip's feel:</strong> in GRID + shift, arm <strong>CLIP-DIV</strong> and tap a
      clip to cycle its own division — the pad pulses at the new rate; disarm to commit.</li>
    <li><strong>Undo a mistake:</strong> tap <strong>UNDO</strong> (top row) to revert your last persistent
      edit (a paste, a length change, a swing nudge); <strong>REDO</strong> to reapply.</li>
    <li><strong>Ride the tempo / drop everything:</strong> in CONTROL, nudge <strong>TEMPO+ / −</strong>, or
      hit <strong>STOP-ALL</strong> to stop every channel; the <strong>transport</strong> button (top row,
      CC 91) starts / stops the clock.</li>
  </ol>
  <p class="muted">
    Every control you touched — the four views, the shift layer, KEYS + arp, MUTE / RATE / RESET / SWING /
    CLIP-DIV, and launchpad-scoped undo — lives on <strong>one</strong> device, one hand at a time.
  </p>
</section>

<h2>Hardware protocol (confirmed against the device)</h2>
<div class="table-scroll">
  <table class="map">
    <tbody>
      {#each HW_MAP as r (r.what)}
        <tr><td class="m-what">{r.what}</td><td class="m-addr"><code>{r.addr}</code></td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .hero { margin-bottom: 1.25rem; }
  .diagram-pair { display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-start; }
  /* The two KEYS unit diagrams sit SIDE-BY-SIDE like the physical pair. Without
     a basis, each figure's preferred width is its (long) caption's max-content,
     which forced a wrap — the units stacked even on a wide screen. */
  .diagram-pair > :global(.lp-diagram) { flex: 1 1 360px; min-width: 300px; max-width: 520px; }
  .lede { color: var(--muted, #9aa0b2); line-height: 1.5; max-width: 62ch; }
  .muted { color: var(--muted, #9aa0b2); font-size: 0.9rem; max-width: 70ch; }
  .cyan { color: #16d6d6; }
  h2 { margin-top: 1.8rem; }
  h3 { margin-top: 1.4rem; }
  h4 { margin-top: 1.1rem; }
  /* The two self-contained mode sections read as clearly separated "chapters":
     a left rule in the section's own hue + generous top spacing. */
  .mode-section {
    margin-top: 2.6rem;
    padding-left: 14px;
    border-left: 2px solid var(--doc-border-dim, #062b32);
  }
  .mode-title {
    font-size: 1.4rem;
    letter-spacing: 0.02em;
  }
  #single-launchpad { border-left-color: #0a5c5c; }
  #two-launchpads { border-left-color: #274a72; }
  #make-a-patch { border-left-color: #6a4a12; }
  ol.steps { line-height: 1.6; max-width: 70ch; }
  ol.steps li { margin-bottom: 0.3rem; }
  ul.tight { line-height: 1.5; max-width: 70ch; margin-top: 0.4rem; }
  ul.tight li { margin-bottom: 0.2rem; }
  .swatch-grid { display: flex; flex-direction: column; gap: 4px; margin: 0.5rem 0 1rem; }
  .swatch-row { display: grid; grid-template-columns: 24px 200px 110px 1fr; align-items: center; gap: 10px; font-size: 0.85rem; }
  .swatch-row.two { grid-template-columns: 24px 200px 1fr; }
  .chip { width: 22px; height: 22px; border-radius: 5px; border: 1px solid #2b2e38; display: inline-block; flex: none; }
  .s-state { font-weight: 600; }
  .s-anim { color: var(--muted, #9aa0b2); font-style: italic; }
  .s-note { color: var(--muted, #9aa0b2); }
  /* Narrow screens: the rigid 4-column swatch grid overflows (measured +47px at
     420px wide) — stack the text under the chip+state row instead. */
  @media (max-width: 640px) {
    .swatch-row,
    .swatch-row.two {
      grid-template-columns: 24px minmax(0, 1fr);
    }
    .swatch-row .s-anim,
    .swatch-row .s-note {
      grid-column: 2;
    }
  }
  /* Reference tables scroll inside their own container instead of widening the
     page (the m-what column is nowrap by design). */
  .table-scroll { overflow-x: auto; max-width: 100%; }
  table.map { border-collapse: collapse; margin: 0.5rem 0 1.5rem; width: 100%; }
  table.map td { padding: 5px 10px; border-bottom: 1px solid #2a2d36; vertical-align: top; }
  .m-what { font-weight: 600; white-space: nowrap; }
  .m-addr code { font-size: 0.8rem; color: var(--muted, #cfd3df); }
  /* Signal-flow block diagram (Launchpad → clip player → voices → out). Follows
     the LaunchpadDiagram look: boxes stroked in the muted hue, cyan-accented clip
     player, cable labels in the muted hue. */
  .sigflow { margin: 1rem 0 1.4rem; }
  .sigflow svg { max-width: 100%; height: auto; }
  .sf-box { fill: none; stroke: var(--muted, #9aa0b2); stroke-width: 1.4; }
  .sf-box.hl { stroke: #16d6d6; }
  .sf-chan { fill: none; stroke: var(--muted, #9aa0b2); stroke-opacity: 0.45; }
  .sf-txt { fill: #cdd2de; font: 600 12px/1 ui-monospace, 'SF Mono', Menlo, monospace; }
  .sf-sub { fill: var(--muted, #9aa0b2); font: 500 10px/1 ui-monospace, 'SF Mono', Menlo, monospace; }
  .sf-cable { fill: var(--muted, #9aa0b2); font: 600 9px/1 ui-monospace, 'SF Mono', Menlo, monospace; }
  .sf-arrow { fill: none; stroke: var(--muted, #9aa0b2); stroke-width: 1.4; marker-end: url(#sfhead); }
  .sf-head { fill: var(--muted, #9aa0b2); }
  .sigflow figcaption {
    margin-top: 0.4rem;
    font-size: 0.82rem;
    color: var(--muted, #98a);
    font-style: italic;
    max-width: 70ch;
  }
</style>
