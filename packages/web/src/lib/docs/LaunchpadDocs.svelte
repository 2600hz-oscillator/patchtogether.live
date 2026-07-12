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
    RGB_VIEW,
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
    RGB_KEYS_REC_HOLD_ON,
    RGB_KEYS_OD_HOLD,
    RGB_KEYS_OD_HOLD_ON,
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

  // ── SINGLE · CLIP view: the matrix + the top-row ARM STRIP. Colours from
  // launchpad-map's paintClipArmStrip:
  //   CC 91 KEYS (dim red, tri-state arm) · 92 COPY · 93 PASTE · 94 P-REV (green)
  //   · 95 NOW (purple, sticky) · 96 LEN (yellow) · 97 DBL (purple) · 98 VIEW.
  const sArmTop = [
    { col: 0, fill: hex(RGB_KEYS_REC_HOLD), label: 'KEYS' }, // CC 91 — KEYS-arm tri-state
    { col: 1, fill: hex(RGB_DECK_COPY), label: 'COPY' }, // CC 92 — green
    { col: 2, fill: hex(RGB_DECK_COPY), label: 'PASTE' }, // CC 93 — green
    { col: 3, fill: hex(RGB_DECK_COPY), label: 'P-REV' }, // CC 94 — green
    { col: 4, fill: hex(RGB_DECK_NOW), label: 'NOW' }, // CC 95 — purple (sticky)
    { col: 5, fill: hex(RGB_DECK_LEN), label: 'LEN' }, // CC 96 — yellow
    { col: 6, fill: hex(RGB_DECK_DBL), label: 'DBL' }, // CC 97 — purple
    { col: 7, fill: hex(RGB_VIEW), label: 'VIEW' }, // CC 98 — cyan view-flip
  ];
  const sArmCallouts = [
    { label: 'KEYS-ARM → TAP A CLIP', fromCol: 0, tier: 0 },
    { label: 'ARM AN ACTION → THEN TAP A CLIP', fromCol: 1, toCol: 6, tier: 1 },
    { label: 'VIEW', fromCol: 7, tier: 0 },
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
  const sDeckTop = [...pairDeckTop, { col: 7, fill: hex(RGB_VIEW), label: 'VIEW' }]; // CC 98

  // ── The NOTE EDITOR 8×8 (an illustrative state) — both modes. ──
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
  // SINGLE: CC 98 stays the cyan VIEW button; FOLLOW moves to scene row 4.
  const sEditTop = [...editorTopCommon, { col: 7, fill: hex(RGB_VIEW), label: 'VIEW' }];
  const sEditSceneFollowing = [
    ...pairEditScene,
    { row: 4, fill: hex(RGB_TRANSPORT_ON), label: 'FOL' },
  ];
  const sEditSceneFrozen = [
    ...pairEditScene,
    { row: 4, fill: hex(RGB_FUNC_ON), label: 'FOL' },
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
  const sLenTop = [{ col: 7, fill: hex(RGB_VIEW), label: 'VIEW' }]; // the single view marker stays lit

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

  // ── PERFORMANCE EXAMPLE — a 3-voice live set on ONE Launchpad. ch1→kick,
  // ch2→snare, ch3→TIDY VCO (poly). Scenes A/B/C are clip SLOTS (columns 0/1/2);
  // the scene-column buttons that fire them are rows 0/1/2 (slot = row = column).
  // Lanes map top→bottom (lane 1 = top row) like the card.
  const perfSessionArmTop = sArmTop; // the CLIP-view arm row (KEYS · COPY · … · VIEW)
  const perfSessionPads = [
    // lane 1 (KICK) — top row, scene A playing, B/C loaded.
    { x: 0, y: yL(0), fill: hex(RGB_PLAYING), label: 'K' },
    { x: 1, y: yL(0), fill: hex(RGB_LOADED) },
    { x: 2, y: yL(0), fill: hex(RGB_LOADED) },
    // lane 2 (SNARE).
    { x: 0, y: yL(1), fill: hex(RGB_PLAYING), label: 'S' },
    { x: 1, y: yL(1), fill: hex(RGB_LOADED) },
    { x: 2, y: yL(1), fill: hex(RGB_LOADED) },
    // lane 3 (TIDY VCO, poly) — 2 clips (A/B).
    { x: 0, y: yL(2), fill: hex(RGB_PLAYING), label: 'V' },
    { x: 1, y: yL(2), fill: hex(RGB_LOADED) },
  ];
  const perfSceneCol = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(RGB_SCENE),
    label: r === 0 ? 'A' : r === 1 ? 'B' : r === 2 ? 'C' : undefined,
  }));
  const perfSessionCallouts = [
    { label: 'A     B     C   (scene slots)', fromCol: 0, toCol: 2, tier: 1 },
  ];
  // Launch scene B: column-1 clips flash queued-green, scene button B (row 1) hit.
  const perfSceneLaunchPads = [
    { x: 0, y: yL(0), fill: hex(RGB_PLAYING), label: 'K' },
    { x: 1, y: yL(0), fill: hex(RGB_QUEUED) },
    { x: 0, y: yL(1), fill: hex(RGB_PLAYING), label: 'S' },
    { x: 1, y: yL(1), fill: hex(RGB_QUEUED) },
    { x: 0, y: yL(2), fill: hex(RGB_PLAYING), label: 'V' },
    { x: 1, y: yL(2), fill: hex(RGB_QUEUED) },
  ];
  const perfSceneLaunchCol = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(r === 1 ? RGB_QUEUED : RGB_SCENE),
    label: r === 0 ? 'A' : r === 1 ? 'B▶' : r === 2 ? 'C' : undefined,
  }));
  // KEYS record state (reuse the single KEYS layout — a held chord + the record
  // controls). The caption frames it as capturing the TIDY VCO clip.
  const perfKeysPads = keysSinglePads;

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
    { state: 'copy buffer (BUF)', rgb: RGB_COPY_BUFFER, anim: 'pulse turquoise', note: 'a clip is in the clipboard — the deck BUF pad (pair) / the arm-row COPY cell (single); tap it to clear' },
    { state: 'scene (matrix right col)', rgb: RGB_SCENE, anim: 'amber', note: 'fire one clip slot across every lane at once (a whole column)' },
    { state: 'stop lane idle (deck right col)', rgb: RGB_STOP_IDLE, anim: 'dim red', note: 'per-lane stop' },
    { state: 'stop lane active', rgb: RGB_STOP_ACTIVE, anim: 'bright red', note: 'that lane is audible' },
  ];
  const DECK_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'EDIT', rgb: RGB_DECK_EDIT, note: 'orange — opens a clip’s note editor (brightens while held/armed)' },
    { state: 'COPY / PASTE / P-REV', rgb: RGB_DECK_COPY, note: 'green — clipboard actions (brighten while held/armed)' },
    { state: 'DOUBLE', rgb: RGB_DECK_DBL, note: 'purple — duplicate the pattern + double the clip length (cap 128)' },
    { state: 'LENGTH', rgb: RGB_DECK_LEN, note: 'yellow — open the 2-row length page' },
    { state: 'NOW', rgb: RGB_DECK_NOW, note: 'purple — launches ignore quantize (hold in pair · sticky toggle in single)' },
    { state: 'VIEW (single only)', rgb: RGB_VIEW, note: 'cyan — CC 98 flips CLIP ⇄ CONTROL; always lit on the lone device' },
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

  // ── Pad + CC reference tables (per mode; the raw protocol is shared). ──
  const SINGLE_MAP: { what: string; addr: string }[] = [
    { what: 'VIEW toggle', addr: 'CC 98 (rightmost top button) — flips CLIP ⇄ CONTROL, always lit cyan. Inactive while KEYS (or its length page) owns the device' },
    { what: 'ARM ROW (CLIP view top row)', addr: 'CC 91 = KEYS-arm (sticky tri-state: off → armed-REC → armed-OD → off; then tap a clip → KEYS) · 92 = COPY (re-tap = clear buffer) · 93 = PASTE · 94 = PASTE-REV · 95 = NOW (sticky) · 96 = LENGTH · 97 = DOUBLE. Auto-disarms after ~4 s' },
    { what: 'double-tap (CLIP view)', addr: 'two quick taps of the same clip pad (~¼ s) → open its note editor + flip to CONTROL, without changing whether the clip plays. On an EMPTY pad = create a fresh clip + edit (NEW’s home)' },
    { what: 'deck globals (CONTROL view top row)', addr: 'CC 91 = REC (arranger) · 92 = SONG (SES⇄ARR) · 93 = TEMPO− · 94 = TEMPO+ · 96 = PLAY (transport) · 97 = ALL (stop-all) · 95 = SHIFT (editor ×8)' },
    { what: 'RESET (CONTROL deck)', addr: 'deck row 1, col 2 (steel blue) — snap every active lane back to step 1 (the card RST / reset-gate field)' },
    { what: 'per-lane MONO / MUTE / RATE (CONTROL deck)', addr: 'row 2 = MONO (teal on) · row 3 = MUTE (orange = muted, advances but silent) · row 4 = RATE (tap cycles 1/8·1/4·1/2·1·2x·4x). One pad per lane, col = lane' },
    { what: 'editor nav (CONTROL view top row)', addr: 'CC 91 ▲ · 92 ▼ · 93 ◀ · 94 ▶ (±1; hold SHIFT/CC 95 = ±8) · 96 = VEL (hold + tap) · 97 = SCALE' },
    { what: 'editor scene column', addr: 'EXIT · DBL · LEN · FOLLOW (green/violet) · then COPY · PASTE · OCT+ · OCT− (rows 3→0)' },
    { what: 'KEYS entry', addr: 'PRIMARY: CLIP view → tap CC 91 (KEYS-arm) once (overdub off) or twice (overdub on) → tap a clip. LEGACY: CONTROL view hold note-REC / note-OVERDUB (deck row 1 col 0/1) → CC 98 to CLIP → double-tap a clip' },
    { what: 'KEYS layout', addr: 'top row = 8-cell whole-clip playhead · 6 keyboard rows (cols 1–8) · bottom row = EXIT · QUEUE-REC · OVERDUB · OCT− · OCT+ · PANIC · LEN' },
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
    <li><a href="#single-launchpad"><strong>SINGLE LAUNCHPAD</strong></a> — one device does everything,
      flipping between a <strong>CLIP</strong> view (the 8×8 matrix) and a <strong>CONTROL</strong> view
      (the command deck / note editor / length page) on hardware <strong>CC 98</strong> or the on-card toggle.</li>
    <li><a href="#two-launchpads"><strong>TWO LAUNCHPADS</strong></a> — the <strong>left</strong> unit is the
      always-live <strong>8×8 clip matrix</strong>, the <strong>right</strong> unit is the
      <strong>command deck</strong> + <strong>note editor</strong>, so you never lose sight of the matrix.</li>
    <li><a href="#performance-example"><strong>PERFORMANCE EXAMPLE</strong></a> — a follow-along 3-voice
      live set on one Launchpad (kick · snare · TIDY VCO), start to finish.</li>
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
  <h2 class="mode-title">SINGLE LAUNCHPAD — one device, two views</h2>
  <p>
    One Launchpad does everything. The device is always in one of two <strong>views</strong>:
    <strong>CLIP</strong> (the 8×8 clip matrix — launch and stop clips) or <strong>CONTROL</strong>
    (the command deck, note editor and length page). Flip between them with the hardware
    <strong>CC 98</strong> button (the rightmost button on the top row — it stays lit
    <span class="cyan">cyan</span> so you always know it's the view switch) or the on-card
    <strong>Clip / Control</strong> toggle. Flipping views never resets anything: the editor's step
    window, pitch scroll, FOLLOW state and edited clip all survive, and the matrix's playing/queued
    state is always live (it's the shared clip player).
  </p>

  <h3>Setup</h3>
  <ol class="steps">
    <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong> to the canvas.</li>
    <li>Click <strong>Connect single Launchpad</strong> on the card (grants Web-MIDI/sysex on first
      click). The one device binds — no press-a-pad handshake — and auto-binds the first clip player.</li>
    <li>The device starts in <strong>CLIP view</strong>. A reload restores your mode + view; hit
      <strong>Connect single Launchpad</strong> once to re-attach the hardware (browser permission
      needs a click).</li>
  </ol>

  <h3>CLIP view — launch clips</h3>
  <LaunchpadDiagram
    top={sArmTop}
    pads={matrixPads}
    scene={matrixScene}
    callouts={sArmCallouts}
    accent={hex(RGB_VIEW)}
    caption="SINGLE · CLIP view. The 8×8 matrix: rows = the 8 instrument lanes (top→bottom, matching the on-screen card — lane 1 is the top row), columns = the 8 clip slots. Top row = the action-arm strip (NEW · COPY · PASTE · P-REV · NOW · LEN · DBL) + the cyan VIEW button (CC 98). Right column = scene launch (amber)."
  />
  <ul class="tight">
    <li><strong>Tap a loaded clip</strong> (dim blue) to <strong>launch</strong> it — it flashes green
      (queued) until the next quantize boundary, then turns solid green (playing). Tap the playing clip
      to queue a <strong>stop</strong> (flashes red until the boundary).</li>
    <li>Pad <code>(slot, lane)</code> is clip <code>lane*8 + slot</code>; <strong>lane 1 = the TOP
      physical row</strong>, so the hardware matches what you see on the card.</li>
    <li><strong>Scene launch (right column):</strong> scene button <em>N</em> fires the clip in
      <strong>slot N of every lane that has one</strong> and <strong>stops</strong> every lane that
      doesn't — a one-press section switch (verse → chorus). Same quantize rules as a normal launch.</li>
    <li><strong>NOW (CC 95, sticky):</strong> while lit bright purple, clip + scene taps launch
      <strong>immediately</strong> instead of on the boundary. Tap again to turn it off.</li>
    <li>Empty pads glow <strong>dim red</strong> while the player is record-armed (REC).</li>
  </ul>

  <h4>The arm row — deck actions (and KEYS) without leaving the matrix</h4>
  <p>
    On one device you can't hold a deck button while tapping a clip — so in CLIP view the top row is a
    7-cell <strong>action-arm strip</strong>: <strong>tap an arm cell to ARM an action, then tap a clip
    pad to apply it</strong>. While armed, the matrix shows an <em>aiming wash</em> (legal targets
    brighten, empty pads show a faint dot). An arm <strong>auto-disarms after ~4 s</strong>; re-tapping
    the armed cell cancels it; flipping views cancels a pending arm and switches NOW off.
  </p>
  <ul class="tight">
    <li><strong>KEYS (CC 91) — the one-handed way into KEYS.</strong> This is the reclaimed NEW cell.
      It's a <em>sticky tri-state</em>: <strong>tap once</strong> → armed-REC (glows red, overdub OFF /
      true-replace), <strong>tap again</strong> → armed-OD (glows purple, overdub ON / additive),
      <strong>tap a third time</strong> → off. While armed, <strong>tap any clip pad</strong> → the
      device drops straight into <a href="#single-keys">KEYS</a> for that clip — one hand, in clip
      view, <strong>no view flip</strong>. (This replaces the old hold-a-deck-button-then-flip gesture,
      which still works as a fallback — see <a href="#single-keys">KEYS</a>.) The overdub on/off choice
      is made <em>here</em> by the tri-state, and you can still toggle OVR in the KEYS view.</li>
    <li><strong>COPY (CC 92):</strong> arm, tap a <em>loaded</em> clip → snapshot to the clipboard (the
      COPY cell pulses turquoise while the clipboard holds a clip). <strong>Re-tap COPY</strong> while
      loaded to <strong>clear the buffer</strong>. Copy is a <em>snapshot</em> — edit after copying?
      re-copy to capture the change.</li>
    <li><strong>PASTE / PASTE-REV (CC 93 / 94):</strong> arm (they only light when the clipboard holds
      a clip), tap any pad → the buffer is written there (PASTE-REV mirrors the steps in time).</li>
    <li><strong>LENGTH (CC 96):</strong> arm, tap a loaded clip → its 2-row length page opens (the
      device flips to CONTROL).</li>
    <li><strong>DOUBLE (CC 97):</strong> arm, tap a loaded clip → duplicate the pattern into the back
      half + double the length (cap 128 steps).</li>
  </ul>
  <p class="muted">
    <strong>Where did NEW go?</strong> The old NEW cell only ever duplicated a gesture you already
    have: <strong>double-tapping an empty pad</strong> makes a fresh clip and opens its editor (below).
    So CC 91 was freed for the far more valuable one-handed KEYS entry, and no capability was lost.
  </p>

  <h4>Double-tap = edit</h4>
  <p>
    In CLIP view a <strong>single tap launches</strong> (immediately — never delayed) and a
    <strong>double-tap</strong> of the same pad (~¼ s) <strong>opens its note editor</strong>, flipping
    the device to CONTROL — exactly like double-clicking a cell on the card. A double-tap then
    <strong>reverts the lane to the play/queue state it was in before the first tap</strong>, so
    <strong>editing never changes whether a clip plays</strong>: a <em>stopped</em> clip stays stopped,
    a <em>playing</em> clip keeps playing, and a clip you'd already <em>queued</em> still starts.
    Double-tap an <em>empty</em> pad to create a fresh clip and edit it.
  </p>

  <h3>CONTROL view — the command deck</h3>
  <LaunchpadDiagram
    pads={deckPads}
    top={sDeckTop}
    scene={deckScene}
    callouts={deckCallouts}
    accent={hex(RGB_VIEW)}
    caption="SINGLE · CONTROL view (command deck). Row 0 = function pads: EDIT (orange), COPY/PASTE/P-REV (green), BUF (dark until you copy), DBL + NOW (purple), LEN (yellow). Row 1 = KEYS-entry holds K● / KO + RST (steel blue). Rows 2/3/4 = per-lane MONO (teal) / MUTE (orange) / RATE (a rate ramp). Right column = per-lane STOP. Top row: REC · SONG · T− · T+ · PLAY · ALL + the cyan VIEW button."
  />
  <ul class="tight">
    <li><strong>EDIT (hold, spans the flip):</strong> hold EDIT here, press <strong>CC 98</strong> to
      flip to CLIP view (the hold survives), tap a clip → its note editor opens. (The
      <strong>double-tap</strong> in CLIP view does the same thing one-handed.)</li>
    <li><strong>BUF (col 5):</strong> pulses turquoise while the clipboard holds a clip — tap it to
      clear. <strong>COPY / PASTE / P-REV / NOW</strong> hold-modifiers can't span a view flip (a flip
      releases them), so in single mode use the <strong>CLIP-view arm row</strong> for those instead.</li>
    <li><strong>DBL / LEN (tap):</strong> act on the clip you most recently edited (DOUBLE duplicates +
      doubles; LEN opens the length page here in CONTROL view).</li>
    <li><strong>Per-lane STOP (right column):</strong> row <em>N</em> stops lane <em>N</em> (bright red =
      that lane is audible now).</li>
    <li><strong>PLAY (CC 96)</strong> toggles the transport; <strong>ALL (CC 97)</strong> queues a stop
      on every lane.</li>
    <li><strong>K● / KO (row 1):</strong> the KEYS-entry holds (the legacy entry — the CLIP-view arm
      row's KEYS cell is the primary one now). See <a href="#single-keys">KEYS on one device</a>.</li>
  </ul>

  <h4>Performance controls — the formerly-dead deck, now live</h4>
  <p>
    The command deck used to be <strong>~85% dark</strong> — one function row and two hold pads. Those
    empty pads are now a live performance layer, all writing the <em>same</em> synced state the card
    already drives (so peers and the card stay in sync):
  </p>
  <ul class="tight">
    <li><strong>RESET (RST — row 1, col 2, steel blue):</strong> snap <strong>every playing lane back to
      step 1</strong> at one shared instant — the classic "re-sync the whole rack" between sections.
      It's the same field as the card's <strong>RST</strong> button and the <strong>reset</strong>
      gate input. Reset ≠ stop: the clips keep playing, just re-aligned.</li>
    <li><strong>MONO row (row 2, one pad per lane, teal):</strong> toggle a lane between <strong>MONO</strong>
      (one note per column — a clean monophonic line) and <strong>POLY</strong> (chords). Teal = mono
      on, dim = poly.</li>
    <li><strong>MUTE row (row 3, one pad per lane, orange):</strong> <strong>mute a lane in place</strong>
      — it keeps advancing its playhead (stays locked to the transport and every other lane) but goes
      <strong>silent</strong>. This is different from the per-lane STOP: STOP halts the lane; MUTE
      drops it out and lets you bring it straight back on the beat. Orange = muted, dim = live.</li>
    <li><strong>RATE row (row 4, one pad per lane):</strong> <strong>tap to cycle</strong> a lane's clock
      division up through <strong>1/8 · 1/4 · 1/2 · 1 · 2x · 4x</strong> (wrapping). The pad's colour
      ramps cool→warm with the rate (green = the default ‘1’). Polyrhythm/half-time without the card;
      all lanes share one phase origin, so RESET re-locks them.</li>
    <li><strong>TEMPO nudge (T− / T+, CC 93 / 94):</strong> step the rack transport (TIMELORDE) tempo
      <strong>±2 bpm</strong> per tap (clamped 10–300) — ride the tempo into a section by hand.</li>
  </ul>

  <h4>Record a song (arranger)</h4>
  <p class="muted">
    The arranger records your <strong>live clip-launch performance</strong> — which clips you fire, in
    which lanes, exactly when — and plays it back as a song. It records <em>launches</em>, not audio,
    so the clips stay fully editable. Identical to the card's <strong>●</strong> REC +
    <strong>SES/ARR</strong> buttons (both write the same synced state).
  </p>
  <ol class="steps">
    <li>Flip to <strong>CONTROL view</strong>. Be in <strong>SESSION</strong> (SONG / CC 92 dim white)
      and make sure the <strong>transport runs</strong> (PLAY / CC 96) so song-time advances.</li>
    <li>Press <strong>REC</strong> (CC 91) — it pulses red. In the default <strong>REPLACE</strong> mode
      arming clears the previous take and restarts at bar 1; switch the RPL/OVR pill on the card for
      overdub-merge.</li>
    <li>Flip to <strong>CLIP view</strong> and <strong>perform</strong> — every launch/stop/scene is
      captured exactly when it applies (quantized launches on the boundary; NOW launches instantly).</li>
    <li>Flip back to CONTROL, press <strong>REC</strong> again to disarm. Press <strong>SONG</strong>
      (CC 92) to switch to <strong>ARRANGEMENT</strong> (bright white) — playback runs your recorded
      launches from the top, looping. <strong>SONG</strong> again returns to live SESSION play.</li>
  </ol>

  <h3>The note editor</h3>
  <LaunchpadDiagram
    pads={editorPads}
    top={sEditTop}
    scene={sEditSceneFollowing}
    callouts={editCallouts}
    accent={hex(RGB_VIEW)}
    caption="SINGLE · note editor, FOLLOW ON. X = step (an 8-step window = half a 16-step block), Y = pitch (in-key, bottom = lowest). The amber column is the playhead. Right column: EXIT · DBL · LEN · FOL (green = following) · CPY · PST · OC+ · OC− (the P6 clip clipboard + octave shortcuts). CC 98 stays the cyan VIEW button."
  />
  <LaunchpadDiagram
    pads={editorPads}
    top={sEditTop}
    scene={sEditSceneFrozen}
    callouts={editCallouts}
    accent={hex(RGB_FUNC_ON)}
    caption="SINGLE · note editor, FOLLOW FROZEN. The FOL pad turns violet: the window stays where you put it while the playhead runs on. Any manual ◀/▶ scroll freezes automatically; tap FOL to resume following."
  />
  <ul class="tight">
    <li><strong>Get in:</strong> double-tap a clip in CLIP view, arm NEW onto an empty pad, or
      hold-EDIT + flip + tap. <strong>Get out:</strong> <strong>EXIT</strong> (top scene button) —
      then CC 98 back to CLIP view.</li>
    <li><strong>Tap</strong> a pad to toggle a note; <strong>hold a note + tap another in its row</strong>
      to tie a held span.</li>
    <li><strong>▲ ▼</strong> scroll pitch ±1 row; <strong>◀ ▶</strong> scroll the step window ±1 step.
      <strong>Hold SHIFT</strong> (CC 95) → both jump a full screen (±8).</li>
    <li><strong>VEL</strong> (CC 96, hold + tap a note) cycles its velocity;
      <strong>SCALE</strong> (CC 97) cycles the clip scale.</li>
    <li><strong>FOLLOW</strong> lives on the <strong>scene column, 4th pad from the top</strong> (CC 98
      is the view flip, so FOLLOW gets a real pad here): green = the window auto-scrolls with the
      playhead; violet = frozen. A manual ◀/▶ scroll freezes; <strong>tap FOL to resume following</strong>.</li>
    <li><strong>DBL</strong> (scene row 2) doubles the clip; <strong>LEN</strong> (scene row 3) opens the
      length page.</li>
    <li><strong>CPY · PST · OC+ · OC− (scene rows 4–7 from the bottom):</strong> <strong>CPY</strong>
      snapshots this clip to the machine clipboard; <strong>PST</strong> (lit green once the clipboard
      holds a clip) writes it over the clip you're editing — copy a phrase out of one clip's editor and
      paste it into another. <strong>OC+ / OC−</strong> jump the pitch window <strong>up / down a whole
      octave</strong> at once (vs the ▲▼ single-row scroll).</li>
  </ul>

  <h3>LENGTH-EDIT — set an exact clip length</h3>
  <LaunchpadDiagram
    pads={lenPads}
    top={sLenTop}
    scene={lenScene}
    callouts={lenCallouts}
    accent={hex(RGB_VIEW)}
    caption="SINGLE · LENGTH-EDIT page (shown: 3 blocks, end-step 4 → 36 steps). Bottom row = end BLOCK (1–8, ×16 steps each); the next two rows = end STEP within the end block (1–8, then 9–16). The bright pad is the current end — tap to set. Non-destructive: shortening hides notes past the end, lengthening brings them back. EXIT top-right."
  />
  <p class="muted">
    Open it from the editor's <strong>LEN</strong> scene pad, the deck's <strong>LEN</strong> pad, or the
    CLIP-view <strong>arm row LENGTH</strong> cell. Length = (endBlock−1)×16 + endStep, up to 128. Each
    clip's length is independent — polymeter is the point — and all playing clips re-align to step 1
    when the transport starts.
  </p>

  <h3 id="single-keys">KEYS — play + record notes on one device</h3>
  <LaunchpadDiagram
    pads={keysSinglePads}
    callouts={keysSingleCallouts}
    accent={hex(RGB_QREC_REC)}
    caption="SINGLE · KEYS. Top row = the playhead — the WHOLE clip compressed into 8 cells, so the moving dot never leaves the device. Middle 6 rows = the isomorphic keyboard (root cyan, in-scale green, out-of-scale dim, pressed white). Bottom row = EXIT (red), QUEUE-REC (yellow → red), OVERDUB (purple), O− / O+ (octave), PNC (panic, red-orange), LEN (yellow). While KEYS is open, CC 98 is inactive — EXIT is the way out."
  />
  <p class="muted">
    <strong>KEYS</strong> turns the device into a playable <strong>isomorphic keyboard</strong>
    (LinnStrument-style, chromatic fourths) routed live to the clip's track, <em>and</em> a
    <strong>loop recorder</strong>. The clip plays under you while the keyboard is live.
  </p>
  <h4>Getting in — the one-handed way (primary)</h4>
  <ol class="steps">
    <li>Stay in <strong>CLIP view</strong>. Tap the <strong>KEYS cell (CC 91)</strong> on the arm row:
      <strong>once</strong> arms with overdub OFF (true-replace, glows red), <strong>twice</strong> arms
      with overdub ON (additive, glows purple).</li>
    <li><strong>Tap the clip</strong> you want to play into → KEYS opens for it (an empty pad makes a
      fresh clip). No hold, no view flip. The clip starts <strong>playing</strong>, the keyboard is
      <strong>live</strong>, and recording is <strong>armed-but-idle</strong> until you press QUEUE-REC.</li>
  </ol>
  <h4>Getting in — the legacy hold gesture (still works)</h4>
  <ol class="steps">
    <li>In <strong>CONTROL view</strong>, <strong>hold K●</strong> (overdub OFF) or <strong>KO</strong>
      (overdub ON) on deck row 1, press <strong>CC 98</strong> to flip to CLIP view (the hold survives),
      then <strong>double-tap a clip</strong>. Same result — kept as a fallback (and it's the shared
      code path pair mode uses).</li>
  </ol>
  <h4>Record a loop</h4>
  <ul class="tight">
    <li><strong>QUEUE-REC</strong> (bottom row): tap to <strong>arm</strong> — flashes yellow. Recording
      begins when the playhead <strong>wraps to step 1</strong> (the transport auto-starts if stopped);
      the pad turns red. Re-tap while armed to cancel.</li>
    <li><strong>Overdub OFF = TRUE REPLACE:</strong> each step is cleared as the playhead crosses it,
      then refilled by what you play that pass — an un-played region wipes.</li>
    <li><strong>OVERDUB ON = additive:</strong> each pass layers onto the last, looping endlessly;
      toggle <strong>OVR</strong> off to finish (it stops at the end of the current loop).</li>
    <li><strong>LEN</strong> opens the length page (EXIT returns straight to KEYS, not the editor), so
      you can resize the loop without leaving.</li>
    <li><strong>O− / O+ (octave):</strong> shift the whole keyboard down / up an octave so you can reach
      bass or lead range without re-patching. <strong>PNC (panic):</strong> instantly kill every
      sounding note (an "all-notes-off" if a gate ever hangs) — you stay in KEYS.</li>
    <li>Velocity is captured from how hard you hit (a Launchpad X is expressive automatically; a
      velocity-flat Mini records a default level).</li>
  </ul>
  <h4>Getting out</h4>
  <ul class="tight">
    <li><strong>EXIT while recording</strong> = stop recording, <strong>stay in KEYS</strong> (the clip
      keeps playing). <strong>EXIT while armed</strong> = cancel the arm. <strong>EXIT while idle</strong>
      = back to the views (the device returns to CLIP/CONTROL exactly where you left them).</li>
    <li><strong>CC 98 does nothing inside KEYS</strong> — the whole device belongs to the keyboard until
      you EXIT.</li>
  </ul>

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
     PERFORMANCE EXAMPLE — a complete, follow-along live set on ONE Launchpad.
     ====================================================================== -->
<section class="mode-section" id="performance-example">
  <h2 class="mode-title">Performance example — a 3-voice live set</h2>
  <p>
    A complete end-to-end walkthrough on <strong>one Launchpad</strong>: a three-voice kit —
    <strong>kick</strong>, <strong>snare</strong> and a <strong>TIDY VCO</strong> bass line (poly) —
    with two-to-three clips per scene, built, recorded, and performed with the deck's new controls.
    Follow along button-by-button.
  </p>

  <h3>1 · Patch the three voices</h3>
  <ol class="steps">
    <li>Drop a <strong>clip player</strong>, a <strong>launchpad control</strong>, a <strong>kickdrum</strong>,
      a <strong>snaredrum</strong>, a <strong>TIDY VCO</strong>, and a <strong>TIMELORDE</strong> (the
      rack transport) onto the canvas.</li>
    <li>Wire the clip player's <strong>per-lane outputs</strong> to the voices — one lane per instrument:
      <ul class="tight">
        <li><strong>Lane 1 → kick:</strong> <code>gate1</code> → the kickdrum's trigger (drums fire on
          the gate; pitch optional).</li>
        <li><strong>Lane 2 → snare:</strong> <code>gate2</code> → the snaredrum's trigger.</li>
        <li><strong>Lane 3 → TIDY VCO (poly):</strong> <code>pitch3</code> (the poly pitch cable) → TIDY
          VCO's <strong>pitch</strong>, and <code>gate3</code> → its gate. TIDY VCO plays the whole
          chord because it's a poly voice.</li>
      </ul>
    </li>
    <li>Run each voice to your mixer / output. On the card, set <strong>lane 3 to POLY</strong> (or do it
      from the deck's <strong>MONO row</strong> — leave lane 3's pad <em>dim</em> = poly), so the bass
      can play chords.</li>
    <li>Click <strong>Connect single Launchpad</strong> on the launchpad card. It binds the clip player;
      the device opens in <strong>CLIP view</strong>.</li>
  </ol>

  <h3>2 · Record the clips (using the one-handed KEYS entry)</h3>
  <p>
    You'll build <strong>scene A</strong> first (clip slot 0 of each lane), then B and C. Recording uses
    the reclaimed <strong>KEYS cell (CC 91)</strong> — the whole point of the single-mode rework:
  </p>
  <LaunchpadDiagram
    pads={perfKeysPads}
    callouts={keysSingleCallouts}
    accent={hex(RGB_QREC_REC)}
    caption="STEP 2 — KEYS record. After arming CC 91 and tapping the lane-3 clip, the device is the isomorphic keyboard (a held chord shows white). Tap QUEUE-REC (REC) → it flashes yellow, then turns red at the loop top and captures what you play. O−/O+ shift octave; PNC panics; EXIT stops the take."
  />
  <ol class="steps">
    <li><strong>Kick (lane 1, slot 0):</strong> in CLIP view, tap the <strong>KEYS cell (CC 91) once</strong>
      (armed-REC, red), then tap the <strong>top-left pad</strong> (lane 1, slot 0). KEYS opens on a fresh
      clip, the transport starts, recording is armed. Tap <strong>QUEUE-REC</strong>; on the loop top it
      goes red — play the kick pattern on the low keyboard rows (<strong>O−</strong> to drop an octave if
      you want a deeper thump). Tap <strong>EXIT</strong> to stop the take (you stay in KEYS), then
      <strong>EXIT</strong> again to return to the views.</li>
    <li><strong>Snare (lane 2, slot 0):</strong> back in CLIP view, tap <strong>CC 91 once</strong>, tap
      the lane-2 slot-0 pad (second row from the top), QUEUE-REC, play the backbeat, EXIT twice.</li>
    <li><strong>TIDY VCO bass (lane 3, slot 0):</strong> tap <strong>CC 91 twice</strong> (armed-OD —
      overdub ON, so you can layer a chord over a couple of passes), tap the lane-3 slot-0 pad, QUEUE-REC,
      and play a bass chord progression. Because lane 3 is poly, the whole chord sounds. Toggle
      <strong>OVR</strong> off to finish, EXIT twice.</li>
    <li><strong>Scenes B and C:</strong> repeat for clip slots 1 and 2 (columns B and C) — different kick
      fills, a busier snare, a lifted bass. For a quick variation, open a clip's editor
      (<strong>double-tap</strong> it), <strong>CPY</strong> it, double-tap an empty pad in the next
      column and <strong>PST</strong> — then tweak.</li>
  </ol>

  <h3>3 · The session — three lanes, three scenes</h3>
  <LaunchpadDiagram
    top={perfSessionArmTop}
    pads={perfSessionPads}
    scene={perfSceneCol}
    callouts={perfSessionCallouts}
    accent={hex(RGB_VIEW)}
    caption="STEP 3 — the session grid. Rows top→bottom = lane 1 KICK (K), lane 2 SNARE (S), lane 3 TIDY VCO (V). Columns = scenes A · B · C (clip slots). Scene A is playing (solid green); B and C are loaded (dim blue). Right column = the scene-launch buttons A/B/C (fire a whole column across all lanes). Top row = the arm strip (KEYS · COPY · … · VIEW)."
  />
  <p class="muted">
    Each <strong>row</strong> is one instrument, each <strong>column</strong> is a scene. Tapping a single
    pad launches just that clip; tapping a <strong>scene button</strong> (right column) fires the whole
    column — all three voices switch together on the next quantize boundary.
  </p>

  <h3>4 · Perform</h3>
  <LaunchpadDiagram
    pads={perfSceneLaunchPads}
    scene={perfSceneLaunchCol}
    accent={hex(RGB_QUEUED)}
    caption="STEP 4 — launch scene B. Pressing scene button B queues slot 1 across every lane: the column-B clips flash green (queued) and take over on the boundary while scene A still plays underneath until then. Same for A and C — a one-press section switch."
  />
  <ol class="steps">
    <li><strong>Start the set:</strong> press <strong>scene A</strong> (right column, bottom button) — all
      three lanes launch together. If they don't feel locked, tap <strong>RST</strong> (flip to CONTROL,
      deck row 1 col 2) to snap every lane to step 1 on a shared downbeat.</li>
    <li><strong>Drop the kick (MUTE):</strong> flip to CONTROL and tap <strong>lane 1's MUTE pad</strong>
      (deck row 3, col 0) — the kick goes silent <em>in place</em> (its playhead keeps running, so it
      snaps right back on beat). Tap it again to bring the kick back for the chorus. (No flip needed if
      you ever run two Launchpads — MUTE is on Unit L's top row too.)</li>
    <li><strong>Switch sections:</strong> press <strong>scene B</strong> then <strong>scene C</strong> to
      move through the arrangement; every voice changes clip on the boundary. Need it instant? tap
      <strong>NOW</strong> (arm-row CC 95) first so launches ignore quantize.</li>
    <li><strong>Half-time the bass (RATE):</strong> on the deck's <strong>RATE row</strong> (row 4), tap
      <strong>lane 3's pad</strong> until it reads <strong>1/2</strong> — the TIDY VCO line drops to
      half-time against the drums for a breakdown. Tap back to <strong>1</strong> to rejoin.</li>
    <li><strong>Ride the tempo:</strong> nudge <strong>T+ / T−</strong> (CC 94 / 93) a few taps to push
      or pull the whole set into the next section.</li>
    <li><strong>Re-sync anytime:</strong> after a flurry of mutes and rate changes, one <strong>RST</strong>
      re-locks all lanes to a common step 1 — the classic live "everyone back on the one."</li>
  </ol>
  <p class="muted">
    Every pad used here — <strong>KEYS-arm, MUTE, RATE, RESET, tempo nudge</strong> — sits on pads that
    were <strong>dark and dead</strong> before this rework. The command deck went from a couple of lit
    buttons to a full live-performance surface, and the one-handed KEYS entry means you never fumble a
    hold-across-a-flip mid-set.
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
  #performance-example { border-left-color: #6a4a12; }
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
</style>
