<script lang="ts">
  // LAUNCHPAD MK3 — shared, colour-coded in-app guide with faithful pad-grid
  // diagrams. Rendered by /docs/modules/launchpadControlLeft, the consolidated
  // launchpad-control module's docs route (right-click the card → "View docs").
  // The diagram colours + swatches import the LIVE map constants, so the doc
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
    RGB_DECK_EDIT_ON,
    RGB_DECK_COPY,
    RGB_DECK_COPY_ON,
    RGB_DECK_DBL,
    RGB_DECK_LEN,
    RGB_DECK_NOW,
    RGB_DECK_NOW_ON,
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
    RGB_KEYS_OD_HOLD,
    type Rgb,
  } from '$lib/control/launchpad/launchpad-map';
  import { keyboardCellToMidi, noteRole } from '$lib/audio/modules/keyboard-map';

  // Render the EXACT RGB the firmware receives (0..127 → 0..255 for the screen).
  const hex = (c: Rgb) =>
    `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;

  // ── UNIT L · clip matrix (an illustrative live state) ──
  // y is the launchpad's BOTTOM-origin row; the matrix maps lane 0 → the TOP
  // row (y=7) so it matches the on-screen card (which renders lane 0 at the
  // top). yL() converts a card-lane (0 = top) to its physical row.
  const yL = (lane: number) => 7 - lane;
  const lPads = [
    { x: 0, y: yL(0), fill: hex(RGB_PLAYING) }, // lane1/slot1 playing (TOP row)
    { x: 1, y: yL(0), fill: hex(RGB_LOADED) },
    { x: 2, y: yL(0), fill: hex(RGB_LOADED) },
    { x: 0, y: yL(1), fill: hex(RGB_QUEUED) }, // lane2/slot1 queued-launch
    { x: 1, y: yL(1), fill: hex(RGB_LOADED) },
    { x: 0, y: yL(2), fill: hex(RGB_LOADED) },
    { x: 1, y: yL(2), fill: hex(RGB_QUEUED_STOP) }, // queued-stop
    { x: 3, y: yL(3), fill: hex(RGB_LOADED) }, // a loaded clip (no special copy-source glow)
  ];
  const lScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(RGB_SCENE),
    label: r === 7 ? 'SCENE' : undefined,
  }));
  const lCallouts = [{ label: 'SLOTS  1 → 8', fromCol: 0, toCol: 7 }];

  // ── SINGLE UNIT · CLIP view with the ARM ROW (one device, top row = the
  // action-arm strip). The matrix + scene reuse the L-role data so the picture
  // shows the matrix staying LIVE under the arm row. The 8 top-row cells take
  // their LIVE arm-strip colours from launchpad-map's paintClipArmStrip:
  //   CC 91 NEW (orange) · 92 COPY · 93 PASTE · 94 P-REV (green) · 95 NOW
  //   (purple, sticky) · 96 LEN (yellow) · 97 DBL (purple) · 98 VIEW (cyan).
  const sArmTop = [
    { col: 0, fill: hex(RGB_DECK_EDIT), label: 'NEW' }, // CC 91 — orange
    { col: 1, fill: hex(RGB_DECK_COPY), label: 'COPY' }, // CC 92 — green
    { col: 2, fill: hex(RGB_DECK_COPY), label: 'PASTE' }, // CC 93 — green
    { col: 3, fill: hex(RGB_DECK_COPY), label: 'P-REV' }, // CC 94 — green
    { col: 4, fill: hex(RGB_DECK_NOW), label: 'NOW' }, // CC 95 — purple (sticky)
    { col: 5, fill: hex(RGB_DECK_LEN), label: 'LEN' }, // CC 96 — yellow
    { col: 6, fill: hex(RGB_DECK_DBL), label: 'DBL' }, // CC 97 — purple
    { col: 7, fill: hex(RGB_VIEW), label: 'VIEW' }, // CC 98 — cyan view-flip
  ];
  const sArmCallouts = [
    { label: 'ARM AN ACTION → THEN TAP A CLIP', fromCol: 0, toCol: 6, tier: 0 },
    { label: 'VIEW', fromCol: 7, tier: 0 },
  ];

  // ── UNIT R · command deck (session) — per-function colours (owner palette):
  //   EDIT orange · COPY/PASTE/P-REV green · DBL + NOW purple · LEN yellow.
  const rDeckPads = [
    { x: 0, y: 0, fill: hex(RGB_DECK_EDIT) }, // EDIT — orange
    { x: 1, y: 0, fill: hex(RGB_DECK_COPY) }, // COPY — green
    { x: 2, y: 0, fill: hex(RGB_DECK_COPY) }, // PASTE — green
    { x: 3, y: 0, fill: hex(RGB_DECK_COPY) }, // P-REV — green
    // col 4 = copy-indicator: dark until you hold COPY + grab a clip
    { x: 5, y: 0, fill: hex(RGB_DECK_DBL) }, // DBL — purple
    { x: 6, y: 0, fill: hex(RGB_DECK_LEN) }, // LEN — yellow
    { x: 7, y: 0, fill: hex(RGB_DECK_NOW) }, // NOW — purple
    // row 1 = the KEYS-entry hold buttons (note/keyboard + clip-record mode)
    { x: 0, y: 1, fill: hex(RGB_KEYS_REC_HOLD), label: 'K●' }, // note-REC hold
    { x: 1, y: 1, fill: hex(RGB_KEYS_OD_HOLD), label: 'KO' }, // note-OVERDUB hold
  ];
  const rDeckTop = [
    { col: 0, fill: hex(RGB_RECORDING), label: 'REC' }, // CC 91 — arranger record-arm
    { col: 1, fill: hex(RGB_SONG_ARRANGE), label: 'SONG' }, // CC 92 — SES⇄ARR
    { col: 4, fill: hex(RGB_FUNC), label: 'SHFT' },
    { col: 5, fill: hex(RGB_STOP_IDLE), label: 'PLAY' },
    { col: 6, fill: hex(RGB_STOP_IDLE), label: 'ALL' },
  ];
  const rDeckScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: hex(r === 0 ? RGB_STOP_ACTIVE : RGB_STOP_IDLE),
    label: r === 7 ? 'STOP' : undefined,
  }));
  const rDeckCallouts = [
    { label: 'EDIT', fromCol: 0, tier: 0 },
    { label: 'COPY', fromCol: 1, tier: 1 },
    { label: 'PASTE', fromCol: 2, tier: 0 },
    { label: 'P-REV', fromCol: 3, tier: 1 },
    { label: 'BUF', fromCol: 4, tier: 0 },
    { label: 'DBL', fromCol: 5, tier: 1 },
    { label: 'LEN', fromCol: 6, tier: 0 },
    { label: 'NOW', fromCol: 7, tier: 1 },
  ];

  // ── UNIT R · note editor (an illustrative state) ──
  const rEditPads = [
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
  const rEditTop = [
    { col: 0, fill: hex(RGB_FUNC), label: '▲' },
    { col: 1, fill: hex(RGB_FUNC), label: '▼' },
    { col: 2, fill: hex(RGB_FUNC), label: '◀' },
    { col: 3, fill: hex(RGB_FUNC), label: '▶' },
    { col: 4, fill: hex(RGB_FUNC), label: 'SHFT' },
    { col: 5, fill: hex(RGB_FUNC), label: 'VEL' },
    { col: 6, fill: hex(RGB_FUNC), label: 'SCL' },
    { col: 7, fill: hex(RGB_TRANSPORT_ON), label: 'FOL' },
  ];
  const rEditScene = [
    { row: 7, fill: hex(RGB_EXIT), label: 'EXIT' },
    { row: 6, fill: hex(RGB_FUNC), label: 'DBL' },
    { row: 5, fill: hex(RGB_FUNC), label: 'LEN' },
  ];
  const rEditCallouts = [{ label: 'STEP WINDOW  (8 = ½ block)', fromCol: 0, toCol: 7 }];

  // ── UNIT R · length-edit page (an illustrative state: 3 blocks, end-step 4) ──
  const rLenPads = [
    { x: 0, y: 0, fill: hex(RGB_LEN_BLOCK), label: '1' },
    { x: 1, y: 0, fill: hex(RGB_LEN_BLOCK), label: '2' },
    { x: 2, y: 0, fill: hex(RGB_LEN_END), label: '3' },
    { x: 0, y: 1, fill: hex(RGB_LEN_BLOCK) },
    { x: 1, y: 1, fill: hex(RGB_LEN_BLOCK) },
    { x: 2, y: 1, fill: hex(RGB_LEN_BLOCK) },
    { x: 3, y: 1, fill: hex(RGB_LEN_END) },
  ];
  const rLenScene = [{ row: 7, fill: hex(RGB_EXIT), label: 'EXIT' }];
  const rLenCallouts = [{ label: 'END BLOCK  1 → 8', fromCol: 0, toCol: 7 }];

  // ── KEYS view (note/keyboard + clip-record) — spans BOTH units, continuous.
  // Generated from the LIVE keyboard-map + role colours so the picture can't
  // drift from the firmware. C3 major, an illustrative held chord + a playhead.
  const KEYS_ROOT = 48; // C3
  const KEYS_SCALE = 'major' as const;
  const keysPressed = new Set<number>([
    keyboardCellToMidi(2, 1, KEYS_ROOT), // a held note (unit L)
    keyboardCellToMidi(4, 2, KEYS_ROOT),
    keyboardCellToMidi(9, 0, KEYS_ROOT), // a held note (unit R, col 9)
  ]);
  const keyFill = (col: number, ry: number) => {
    const midi = keyboardCellToMidi(col, ry, KEYS_ROOT);
    if (keysPressed.has(midi)) return hex(RGB_KEY_PRESSED);
    const role = noteRole(midi, KEYS_ROOT, KEYS_SCALE);
    return hex(role === 'root' ? RGB_KEY_ROOT : role === 'inscale' ? RGB_KEY_INSCALE : RGB_KEY_OUTSCALE);
  };
  const KEYS_PH_CUR_CELL = 3; // illustrative current playhead cell (unit L)
  function keysUnitPads(unit: 'L' | 'R') {
    const colBase = unit === 'L' ? 0 : 8;
    const pads: { x: number; y: number; fill: string; label?: string }[] = [];
    // keyboard band y=1..6 (row 0..5)
    for (let ry = 0; ry < 6; ry++) {
      for (let x = 0; x < 8; x++) pads.push({ x, y: 1 + ry, fill: keyFill(colBase + x, ry) });
    }
    // playhead strip y=7 (L cells 0..7, R cells 8..15)
    for (let x = 0; x < 8; x++) {
      const cell = colBase + x;
      pads.push({ x, y: 7, fill: hex(cell === KEYS_PH_CUR_CELL ? RGB_KEYS_PH_CUR : RGB_KEYS_PH_BASE) });
    }
    // bottom-row controls (unit L only)
    if (unit === 'L') {
      pads.push({ x: 0, y: 0, fill: hex(RGB_EXIT), label: 'EXT' });
      pads.push({ x: 1, y: 0, fill: hex(RGB_QREC_ARMED), label: 'REC' });
      pads.push({ x: 2, y: 0, fill: hex(RGB_OD), label: 'OVR' });
      pads.push({ x: 7, y: 0, fill: hex(RGB_DECK_LEN), label: 'LEN' });
    }
    return pads;
  }
  const keysLPads = keysUnitPads('L');
  const keysRPads = keysUnitPads('R');
  const keysLCallouts = [
    { label: 'PLAYHEAD  (whole clip)', fromCol: 0, toCol: 7, tier: 0 },
  ];
  const keysRCallouts = [{ label: 'KEYBOARD continues  (cols 8 → 15)', fromCol: 0, toCol: 7 }];

  // ── colour legends ──
  const SESSION_COLORS: { state: string; rgb: Rgb; anim: string; note: string }[] = [
    { state: 'empty slot', rgb: [0, 0, 0], anim: 'off', note: 'no clip here' },
    { state: 'loaded clip', rgb: RGB_LOADED, anim: 'static dim', note: 'has notes, stopped' },
    { state: 'playing', rgb: RGB_PLAYING, anim: 'SOLID green', note: 'running now (steady — a blinking pad means queued, not playing)' },
    { state: 'queued-launch', rgb: RGB_QUEUED, anim: 'flash green', note: 'waiting for the loop boundary' },
    { state: 'queued-stop', rgb: RGB_QUEUED_STOP, anim: 'flash red', note: 'will stop on the boundary' },
    { state: 'record-armed (REC)', rgb: RGB_RECORDING, anim: 'pulse red', note: 'arranger record-arm (R top-row CC 91)' },
    { state: 'arrangement (SONG)', rgb: RGB_SONG_ARRANGE, anim: 'static white', note: 'SES⇄ARR lit in ARRANGEMENT (R top-row CC 92)' },
    { state: 'copy buffer (BUF pad, R)', rgb: RGB_COPY_BUFFER, anim: 'pulse turquoise', note: 'a clip is in the clipboard — pulses on the BUF pad (Unit R) only; tap BUF to clear it' },
    { state: 'scene (L right col)', rgb: RGB_SCENE, anim: 'amber', note: 'fire one clip slot across every lane at once (a whole column)' },
    { state: 'stop lane idle (R right col)', rgb: RGB_STOP_IDLE, anim: 'dim red', note: 'per-lane stop' },
    { state: 'stop lane active', rgb: RGB_STOP_ACTIVE, anim: 'bright red', note: 'that lane is audible' },
  ];
  const DECK_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'EDIT', rgb: RGB_DECK_EDIT, note: 'orange — hold + tap a clip to open its editor (brightens while held)' },
    { state: 'COPY / PASTE / P-REV', rgb: RGB_DECK_COPY, note: 'green — hold + tap a clip (brightens while held)' },
    { state: 'DOUBLE', rgb: RGB_DECK_DBL, note: 'purple — tap to duplicate + double the clip length' },
    { state: 'LENGTH', rgb: RGB_DECK_LEN, note: 'yellow — tap to open the length page' },
    { state: 'NOW', rgb: RGB_DECK_NOW, note: 'purple — hold to make launches ignore quantize (brightens while held)' },
    { state: 'nav / SHIFT (editor)', rgb: RGB_FUNC, note: '▲▼◀▶ / SHIFT idle' },
    { state: 'held modifier (editor)', rgb: RGB_FUNC_ON, note: 'VEL / SHIFT while held' },
    { state: 'transport / FOLLOW on', rgb: RGB_TRANSPORT_ON, note: 'running / auto-scroll' },
    { state: 'EXIT', rgb: RGB_EXIT, note: 'leave editor / length page (top scene button)' },
  ];
  const EDITOR_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'note · low vel', rgb: RGB_NOTE_BY_VEL[0], note: 'soft' },
    { state: 'note · med vel', rgb: RGB_NOTE_BY_VEL[1], note: 'mid' },
    { state: 'note · high vel', rgb: RGB_NOTE_BY_VEL[2], note: 'hard' },
    { state: 'note under playhead', rgb: RGB_NOTE_PLAYHEAD, note: 'yellow boost on the playing step' },
    { state: 'playhead column', rgb: RGB_PLAYHEAD_WASH, note: 'the moving step' },
    { state: 'length: counted / END', rgb: RGB_LEN_END, note: 'bright pad = current end' },
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
    { state: 'note-REC / OVERDUB hold', rgb: RGB_KEYS_REC_HOLD, note: 'session deck row 1 — hold + double-tap a clip to enter KEYS' },
  ];

  const PAD_MAP: { what: string; addr: string }[] = [
    { what: '8×8 pads (programmer mode)', addr: 'note = row*10 + col · 11 = bottom-left · 88 = top-right' },
    { what: 'KEYS entry (pair + single)', addr: 'hold note-REC / note-OVERDUB (deck row 1, cols 0/1) + DOUBLE-TAP a clip on the matrix → KEYS view (REC = overdub off · OVERDUB = overdub on). Single: hold in CONTROL view, CC 98 to CLIP (the hold survives), then double-tap' },
    { what: 'KEYS layout (pair)', addr: 'top row = 16-cell playhead · middle 6 rows = isomorphic keyboard (chromatic fourths, continuous L|R) · bottom row (unit L) = EXIT · QUEUE-REC · OVERDUB · LEN' },
    { what: 'KEYS layout (single)', addr: 'the L half on one device: top row = 8-cell whole-clip playhead · 6 keyboard rows (cols 0–7) · bottom row = EXIT · QUEUE-REC · OVERDUB · LEN. CC 98 inactive while KEYS is open' },
    { what: 'single-unit FOLLOW (editor)', addr: 'scene column, 4th pad from the top (under EXIT · DBL · LEN) — green = following, violet = frozen (CC 98 is the view flip, so FOLLOW moves off the top row; single mode only)' },
    { what: 'top row ▲ ▼ ◀ ▶ ▣(SHIFT)', addr: 'CC 91 · 92 · 93 · 94 · 95 — editor nav (▲▼◀▶) + SHIFT(95)' },
    { what: 'top row arranger (session) / globals', addr: 'CC 91 = REC · 92 = SONG · 96 = transport · 97 = stop-all' },
    { what: 'single-unit ARM ROW (clip view)', addr: 'CC 91 = NEW · 92 = COPY (dbl-tap = clear) · 93 = PASTE · 94 = PASTE-REV · 95 = NOW (sticky) · 96 = LENGTH · 97 = DOUBLE — arm, then tap a clip (single mode only)' },
    { what: 'single-unit double-tap (clip view)', addr: 'double-tap a clip pad (~¼s) → open its note editor + flip to CONTROL, without changing whether the clip plays (single mode only; single tap still launches immediately)' },
    { what: 'single-unit VIEW toggle', addr: 'CC 98 (rightmost top-row button) — flips CLIP ⇄ CONTROL (single mode only; pair mode = editor FOLLOW). Inactive while KEYS or its length page owns the device' },
    { what: 'right scene column (top→bottom)', addr: 'CC 89 · 79 · 69 · 59 · 49 · 39 · 29 · 19' },
    { what: 'per-LED full RGB', addr: 'F0 00 20 29 02 0D 03  03 <pad> <R> <G> <B>  F7   (0–127)' },
  ];
</script>

<section class="hero">
  <h1>Launchpad Mini Mk3 — clip launcher</h1>
  <p class="lede">
    <strong>Novation Launchpad Mini Mk3</strong> drives the <strong>clip player</strong> over
    browser-native <strong>Web MIDI</strong> (no helper app). Use <strong>two</strong> units — the
    <strong>left</strong> is the always-live <strong>8×8 clip matrix</strong>, the <strong>right</strong>
    is the <strong>command deck</strong> + <strong>note editor</strong> — or just <strong>one</strong>:
    a single unit does both, flipping between a <strong>CLIP</strong> view (the matrix) and a
    <strong>CONTROL</strong> view (the deck/editor) on the on-card toggle or hardware <strong>CC 98</strong>.
  </p>
</section>

<h2>One unit or two?</h2>
<p class="muted">
  You can drive everything with <strong>one</strong> Launchpad or <strong>two</strong>. With a
  <strong>pair</strong>, the LEFT unit is permanently the clip matrix and the RIGHT unit is the command
  deck / editor, so you never lose sight of the matrix. With a <strong>single</strong> unit, that one
  device does <em>both jobs</em> — you <strong>flip its view</strong> between <strong>CLIP</strong> (the L
  role: the 8×8 matrix) and <strong>CONTROL</strong> (the R role: the deck, note editor + length page).
  Everything the pair can do is reachable on one device — same handlers, same colours — with exactly
  two single-mode adaptations: the editor's <strong>FOLLOW</strong> moves to a scene-column pad
  (4th from the top, since <strong>CC 98</strong> is the view flip), and <strong>KEYS</strong> runs on
  the one device as the 8-wide left half of the keyboard (its playhead strip compresses to 8 cells so
  the moving dot never leaves the surface).
</p>

<h2>Quick start — pair (two units)</h2>
<ol class="steps">
  <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong> to the canvas.</li>
  <li>Click <strong>Pair Launchpads</strong> on the card (grants Web-MIDI/sysex on first click). <strong>Both units flood with colour</strong> — one green, one blue.</li>
  <li><strong>Press any pad on the unit you want as LEFT</strong> (the matrix). The other becomes RIGHT. Pairing auto-binds the first clip player.</li>
  <li><strong>Make your first clip:</strong> <strong>hold EDIT</strong> (bottom-left pad on R) and <strong>tap any pad on L</strong> → that pad gets an empty clip and R flips to the note editor.</li>
  <li>Tap pads on R to add notes, then press <strong>EXIT</strong> (top-right scene button). Back on L, that pad is now a <strong>loaded clip</strong> (dim blue) — <strong>tap it to launch</strong> (green); tap it again to stop its lane.</li>
</ol>
<p class="muted">
  Two identical units are told apart automatically by port order — if L/R come out swapped, just
  <strong>Re-pair</strong> and press the other unit. The <strong>Bind to clip-player</strong> button is
  only needed to re-target a different clip player, bind one you added after pairing, or unbind.
</p>

<h2>Quick start — single unit (one device, two views)</h2>
<ol class="steps">
  <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong>, then click <strong>Connect single Launchpad</strong> (binds the one device; no L/R press-a-pad handshake).</li>
  <li>The device starts in <strong>CLIP view</strong> — it's the 8×8 clip matrix, behaving <em>exactly</em> like the LEFT unit of a pair (tap to launch/stop, right column = scene).</li>
  <li><strong>Flip to CONTROL view</strong> two ways: tap the on-card <strong>Clip / Control</strong> toggle, OR press the hardware <strong>CC 98</strong> button (the <em>rightmost button on the top row</em>). CONTROL view is the command deck + note editor + length page — the full RIGHT-unit functionality. The CC-98 button stays lit to show the active view.</li>
  <li><strong>Make a clip on one device:</strong> in CONTROL view <strong>hold EDIT</strong>, flip to CLIP view (CC 98) and <strong>tap a pad</strong> → that pad gets a clip and the device enters the note editor; flip back to CONTROL to add notes, then <strong>EXIT</strong> (top scene). Back in CLIP view, <strong>tap to launch</strong>.</li>
  <li><strong>Edit an existing clip fast — double-tap it:</strong> in CLIP view, a single tap launches a clip (immediate, never delayed); <strong>double-tap the same pad</strong> (two quick taps, ~¼ second apart) to open its <strong>note editor</strong> — the device flips to CONTROL automatically. <strong>A double-tap never changes whether the clip plays:</strong> double-tap a <em>stopped</em> clip and it stays stopped while you edit; double-tap a clip you'd already <em>queued</em> and it still starts. (Double-tap an <em>empty</em> pad to make a fresh clip and edit it.) This mirrors the on-card grid: single-click launches, double-click edits — so you never need the two-device hold-EDIT gesture on one Launchpad.</li>
</ol>
<p class="muted">
  <strong>Flipping views never resets your editor</strong> — the step window, pitch scroll, FOLLOW state
  and which clip you're editing all survive a clip↔control flip. The matrix's playing/queued state is
  always live (it's the shared clip-player), so you never lose your performance by switching views.
</p>

<h2>Single unit — the clip-view ARM ROW (two-handed deck ops, no view flip)</h2>
<p>
  On a single device you can't physically hold a deck modifier on one unit while tapping a clip on
  another — so in <strong>CLIP view</strong> the otherwise-idle <strong>top row</strong> becomes a
  7-cell <strong>action-arm strip</strong>. <strong>Tap an arm cell to ARM an action, then tap a clip
  pad to apply it</strong> — the matrix never disappears. While an action is armed the matrix shows an
  <em>aiming wash</em> (legal targets brighten, empty pads show a faint dot) so you can see where the
  action will land. An arm <strong>auto-disarms</strong> after ~4 seconds, and re-tapping the armed
  cell cancels it. <strong>CC 98 (rightmost) stays the view-flip</strong> — and note that flipping views
  <strong>cancels a pending arm and switches NOW off</strong> (the strip is a clip-view tool; re-arm
  after you flip back).
</p>
<ul>
  <li><strong>CC 91 — NEW:</strong> arm, then tap an <em>empty</em> pad → it gets a fresh clip and the
    device flips to the note editor. (Tapping a loaded pad is a no-op — it won't clobber.)</li>
  <li><strong>CC 92 — COPY:</strong> arm, then tap a <em>loaded</em> clip → it's copied to the
    clipboard. <strong>Double-tap COPY</strong> (while a clip is held) <strong>clears the buffer</strong>.</li>
  <li><strong>CC 93 / CC 94 — PASTE / PASTE-REV:</strong> arm (only lights when the clipboard holds a
    clip), then tap any pad → the buffer is written there (PASTE-REV mirrors the steps).</li>
  <li><strong>CC 95 — NOW:</strong> a <em>sticky toggle</em> (not arm-then-tap) — while lit, ordinary
    clip + scene taps launch <strong>immediately</strong> instead of at the next quantize boundary.
    Tap again to turn it off.</li>
  <li><strong>CC 96 — LENGTH:</strong> arm, then tap a loaded clip → opens its length page (the device
    flips to control to show the ruler).</li>
  <li><strong>CC 97 — DOUBLE:</strong> arm, then tap a loaded clip → duplicates + doubles its length.</li>
</ul>
<p class="muted">
  The arm row is <strong>single-mode only</strong>. In a two-device <strong>pair</strong> the deck lives
  on the RIGHT unit (hold a modifier there + tap a clip on the LEFT), and the top row keeps its
  pair roles (REC / SONG / transport) — nothing here changes pair behaviour.
</p>
<p class="muted">
  <strong>Double-tap = edit (single mode).</strong> Quite apart from the arm row, in CLIP view a
  <strong>single tap launches</strong> a clip immediately and a <strong>double-tap</strong> (two quick
  taps of the <em>same</em> pad, ~¼ second apart) <strong>opens its note editor</strong> — the device
  flips to CONTROL automatically, exactly like double-clicking a cell on the card. Double-tapping an
  <em>empty</em> pad makes a fresh clip and edits it (the same as arming NEW). The first tap is never
  delayed — it launches right away — but a double-tap then <strong>reverts the lane to exactly the
  play/queue state it was in before that first tap</strong>, so <strong>editing a clip never changes
  whether it plays</strong>: double-tap a <em>stopped</em> clip and it stays stopped; double-tap a clip
  that's <em>playing</em> and it keeps playing; double-tap a clip you'd already <em>queued to start</em>
  and it still starts (only the editing intent is added, never a launch). (Single-mode only: a pair
  edits via hold-EDIT on the RIGHT unit.)
</p>
<p>
  Here's the whole single-unit <strong>CLIP view</strong> — one device, the arm strip across the top and
  the live clip matrix beneath it:
</p>
<LaunchpadDiagram
  top={sArmTop}
  pads={lPads}
  scene={lScene}
  callouts={sArmCallouts}
  accent={hex(RGB_VIEW)}
  caption="SINGLE UNIT · CLIP view. Top row = the action-arm strip: NEW (orange), COPY/PASTE/P-REV (green), NOW (purple, a sticky toggle), LEN (yellow), DBL (purple). Tap an action to ARM it, then tap a clip to apply — the arm auto-disarms after ~4s (re-tap to cancel). CC 98 / VIEW (cyan, rightmost) flips CLIP ⇄ CONTROL. The 8×8 matrix + scene column stay LIVE the whole time (it's the shared clip-player), so you never lose your performance."
/>
<p class="muted">
  Flip to <strong>CONTROL view</strong> (CC 98 / the on-card toggle) and the same device becomes the
  command deck + note editor + length page — that view is identical to the pair's <strong>Unit R</strong>
  deck shown below (same handlers, same colours).
</p>

<h2>Unit L — the clip matrix (always live)</h2>
<LaunchpadDiagram
  pads={lPads}
  scene={lScene}
  callouts={lCallouts}
  caption="UNIT L · rows = the 8 instrument lanes (TOP→BOTTOM, matching the on-screen card — lane 1 is the top row), columns = the 8 clip slots. Tap a clip to launch it / stop its lane (next quantize boundary; hold NOW on R to fire instantly). Right column = scene launch."
/>
<ul class="tight">
  <li>Pad <code>(slot, lane)</code> is clip <code>lane*8 + slot</code>; <strong>lane 1 = the TOP physical row</strong> so the launchpad matches what you see on the card (the device's note 11..88 is bottom-origin; the matrix flips lane→row to align with the screen).</li>
  <li>The matrix <strong>stays live even while you edit</strong> — editing happens on Unit R.</li>
</ul>

<h3>Scene launch — the L right column</h3>
<p class="muted">
  Each of the 8 <strong>amber buttons down the right edge of Unit L</strong> is a <strong>scene</strong> —
  it fires one whole <strong>column of clips at once</strong>. Pressing scene button <em>N</em> launches
  the clip in <strong>slot N of every lane that has one</strong>, and <strong>stops</strong> any lane that
  has no clip in slot N. It's the one-press way to switch your whole rig to a new section
  (verse → chorus): instead of tapping eight clips, you tap one scene. (Same quantize rules as a
  normal launch — they drop in on the boundary, or instantly if you hold <strong>NOW</strong> on R.)
</p>
<ul class="tight">
  <li>Scene button row <em>y</em> = clip <strong>slot</strong> <em>y</em> across all 8 lanes (a vertical column on the card).</li>
  <li>Lanes with a clip in that slot <strong>launch</strong> it; lanes without one <strong>stop</strong> — so a scene is a clean, full snapshot of "what plays now."</li>
</ul>

<h3>What the colours mean (matrix)</h3>
<ul class="tight">
  <li><strong>Dim blue, steady</strong> = a <strong>loaded clip</strong> (has notes, not playing).</li>
  <li><strong>Solid green</strong> = <strong>playing</strong>. <strong>Flashing green</strong> = <strong>queued</strong> to launch on the next boundary (with the transport stopped it just waits — start the transport to drop it in).</li>
  <li><strong>Flashing red</strong> = queued to <strong>stop</strong>. <strong>Dim red</strong> (empty pads) = the player is <strong>record-armed</strong>.</li>
  <li><strong>Copy is a snapshot.</strong> Copying a clip stores a frozen copy in the clipboard — the live clip is <strong>not</strong> linked, so it does <strong>not</strong> glow on L. The clipboard shows only on the <strong>BUF</strong> pad (Unit R), which pulses turquoise while a clip is held; <strong>tap BUF to clear it</strong>. (Edit a clip after copying? Re-copy it to capture the change.)</li>
</ul>

<h2>Unit R — the command deck (session)</h2>
<LaunchpadDiagram
  pads={rDeckPads}
  top={rDeckTop}
  scene={rDeckScene}
  callouts={rDeckCallouts}
  caption="UNIT R · bottom row = colour-coded functions: EDIT (orange), COPY/PASTE/P-REV (green), BUF (copy-buffer indicator, dark until you copy), DBL + NOW (purple), LEN (yellow). EDIT/COPY/PASTE/P-REV/NOW are HOLD modifiers (brighten while held). Right column = per-lane STOP. Top row: REC (record-arm the arrangement), SONG (SESSION⇄ARRANGEMENT), SHIFT, PLAY (transport), ALL (stop-all)."
/>
<ul class="tight">
  <li><strong>EDIT</strong> <span style="color:{hex(RGB_DECK_EDIT_ON)}">(orange)</span> (hold) + tap a clip on L → open its note editor on R.</li>
  <li><strong>COPY / PASTE / PASTE-REV</strong> <span style="color:{hex(RGB_DECK_COPY_ON)}">(green)</span> (hold) + tap a clip on L → copy / paste / paste-reversed. Copy takes a <strong>snapshot</strong>, so the <strong>BUF</strong> indicator on R pulses while a clip is held — <strong>tap BUF to clear the clipboard</strong>. (Re-copy to capture later edits; pasting always stamps the snapshot.)</li>
  <li><strong>DOUBLE</strong> <span style="color:{hex(RGB_DECK_DBL)}">(purple)</span> duplicates the pattern + doubles the length (cap 128). <strong>LENGTH</strong> <span style="color:{hex(RGB_DECK_LEN)}">(yellow)</span> opens the length page. <strong>NOW</strong> <span style="color:{hex(RGB_DECK_NOW_ON)}">(purple)</span> (hold) makes launches ignore quantize.</li>
  <li><strong>REC</strong> (top-left, CC 91) arms the <strong>arranger</strong> — red + pulse while armed; every clip launch is recorded into the song. <strong>SONG</strong> (CC 92) flips <strong>SESSION ⇄ ARRANGEMENT</strong> (white, bright in ARRANGEMENT) to play back the recorded song. Both write the same state the card's REC + SES/ARR buttons do.</li>
  <li><strong>note-REC</strong> <span style="color:{hex(RGB_KEYS_REC_HOLD)}">(dim red)</span> and <strong>note-OVERDUB</strong> <span style="color:{hex(RGB_KEYS_OD_HOLD)}">(dim purple)</span> sit on <strong>row 1</strong> (just above EDIT / COPY, the two pads shown on the second row of the deck above). <strong>Hold</strong> one and <strong>double-tap a clip</strong> on the LEFT to enter the <strong>KEYS</strong> note/keyboard + record view (next section) — note-REC = overdub OFF, note-OVERDUB = overdub ON. Distinct from the arranger REC on the top row.</li>
</ul>

<h2>Record a song (arranger)</h2>
<p class="muted">
  The arranger records your <strong>live clip-launch performance</strong> — which clips you
  fire in which lanes, and exactly when — then plays it back as a song. You perform in
  <strong>SESSION</strong> (firing clips on the matrix) with <strong>REC</strong> armed; you play the
  result back in <strong>ARRANGEMENT</strong>. It records <em>launches</em>, not audio, so the clips
  themselves stay fully editable afterward. (Identical to the card's <strong>●</strong> REC +
  <strong>SES/ARR</strong> buttons — drive whichever you like; both write the same synced state.)
</p>
<ol class="steps">
  <li>Be in <strong>SESSION</strong> (the default — <strong>SONG</strong>/CC 92 is dim white, not bright). Make sure the <strong>transport is running</strong> (▶ PLAY / CC 96, or the card's transport) so song-time advances.</li>
  <li>Press <strong>REC</strong> (top-left, CC 91). It glows <strong>red and pulses</strong>. In the default <strong>REPLACE</strong> mode, <strong>arming clears any previous recording and restarts the song at bar 1</strong>; switch the record-mode toggle (the RPL/OVR pill next to REC on the card) to <strong>OVERDUB</strong> to keep the existing take and merge new launches into it by song-beat. (Surfacing OVERDUB on the Launchpad's controls is a follow-up; today set it from the card.)</li>
  <li><strong>Perform:</strong> launch / switch / stop clips on the <strong>L matrix</strong> as you normally would. Each launch is captured at the moment it actually applies — so your <strong>quantized</strong> launches land on the boundary and your <strong>NOW</strong> (hold NOW + tap) launches land instantly, exactly as you played them.</li>
  <li>Press <strong>REC</strong> again to <strong>disarm</strong> (the pulse stops). Your performance is now stored as the song.</li>
  <li>Press <strong>SONG</strong> (CC 92) to switch to <strong>ARRANGEMENT</strong> (it lights bright white). Playback runs your recorded launches <strong>from the top</strong>, looping. Press <strong>SONG</strong> again to return to <strong>SESSION</strong> (live) play.</li>
</ol>
<ul class="tight">
  <li><strong>Recording only happens in SESSION.</strong> In ARRANGEMENT the timeline drives the lanes itself, so REC there is a no-op — record in session, play back in arrangement.</li>
  <li><strong>Edit the recorded song</strong> on the <strong>clip player card</strong> (its SES/ARR view shows the arrangement timeline: drag/recolour/delete blocks, set the loop length). The launchpad records + plays; the card is where you fine-tune the timeline.</li>
  <li>To <strong>re-record</strong>, just arm <strong>REC</strong> again — it wipes the old take and starts fresh from bar 1.</li>
</ul>

<h2>Unit R — the note editor</h2>
<LaunchpadDiagram
  pads={rEditPads}
  top={rEditTop}
  scene={rEditScene}
  callouts={rEditCallouts}
  caption="UNIT R flips here while editing · X = step (an 8-step window = half a 16-step block), Y = pitch (in-key, bottom = lowest). Tap to toggle a note; hold a note + tap another in its row to tie a span. Amber column = the playhead."
/>
<ul class="tight">
  <li><strong>▲ ▼</strong> scroll pitch ±1 row; <strong>◀ ▶</strong> scroll the step window ±1. <strong>Hold SHIFT</strong> (▣, CC 95) → jump a full screen (±8).</li>
  <li><strong>VEL</strong> (hold + tap a note to cycle its velocity), <strong>SCALE</strong> (cycle the clip scale), <strong>FOLLOW</strong> (auto-scroll with the playhead — green = on; a manual ◀/▶ scroll freezes it).</li>
  <li>Right column: <strong>EXIT</strong> (top), <strong>DBL</strong>, <strong>LEN</strong>.</li>
  <li><strong>Single mode:</strong> CC 98 is the view flip, so <strong>FOLLOW joins the right column</strong>
    as the 4th pad from the top (under LEN) — green while following, violet while frozen. Tap it to
    resume following after a manual scroll; everything else on this page is identical.</li>
</ul>

<h2>Unit R — the length page</h2>
<LaunchpadDiagram
  pads={rLenPads}
  scene={rLenScene}
  callouts={rLenCallouts}
  caption="Open with LEN on the deck · bottom row = end BLOCK (1–8); the next two rows = end STEP (1–8, then 9–16). The bright pad is the current end — tap a pad to set the clip length (non-destructive). EXIT top-right."
/>

<h2>KEYS — play + record notes (pair: both units · single: one)</h2>
<p class="muted">
  <strong>KEYS</strong> turns the surface into a playable <strong>isomorphic keyboard</strong>
  (LinnStrument-style) routed live to a clip's track, <em>and</em> a <strong>loop recorder</strong> — with a
  clip playhead across the top. With a <strong>pair</strong>, both units flip to KEYS together (the matrix is
  hidden until you EXIT), and the keyboard is <strong>continuous across the L|R seam</strong> so a chord shape
  crossing the two units is the same shape. With a <strong>single</strong> unit, the one device becomes the
  keyboard's <strong>left half</strong> (8 columns × 6 rows) with the same bottom-row controls, and the
  playhead strip compresses to <strong>8 cells spanning the whole clip</strong> — while KEYS is open the
  device belongs to it entirely (<strong>CC 98 is inactive</strong>; EXIT is the way out).
</p>
<h3>Getting in — a two-step safety gesture</h3>
<ol class="steps">
  <li><strong>Hold</strong> the <strong>note-REC</strong> or <strong>note-OVERDUB</strong> button on the
    deck (<em>row 1</em>, the two pads just above EDIT/COPY — <span style="color:{hex(RGB_KEYS_REC_HOLD)}">dim red</span>
    /<span style="color:{hex(RGB_KEYS_OD_HOLD)}">dim purple</span>). While held, taps on the clip matrix
    <strong>don't launch</strong>. <em>Single unit:</em> hold it in <strong>CONTROL</strong> view, then flip
    to <strong>CLIP</strong> view with <strong>CC 98</strong> — the hold survives the flip (the same
    two-handed family as the hold-EDIT gesture); letting go before the double-tap simply cancels.</li>
  <li><strong>Double-tap</strong> a clip on the matrix (two quick taps of the same pad) → the surface flips to
    <strong>KEYS</strong> for that clip. Entering via <strong>note-REC</strong> presets <strong>overdub OFF</strong>
    (true replace); via <strong>note-OVERDUB</strong> presets <strong>overdub ON</strong> (additive). An empty pad
    makes a fresh clip. The clip starts <strong>playing</strong> and the keyboard is <strong>live</strong> — but
    <strong>recording is armed-but-idle</strong> until you press QUEUE-REC.</li>
</ol>
<div class="diagram-pair">
  <LaunchpadDiagram
    pads={keysLPads}
    callouts={keysLCallouts}
    accent={hex(RGB_QREC_REC)}
    caption="KEYS · UNIT L. Top row = the 16-cell playhead strip (this unit shows clip cells 0–7). The middle 6 rows are the keyboard (root cyan, in-scale green, out-of-scale dim, a pressed pad white). Bottom row = controls: EXIT (red), QUEUE-REC (yellow → red), OVERDUB (purple), LEN (yellow)."
  />
  <LaunchpadDiagram
    pads={keysRPads}
    callouts={keysRCallouts}
    caption="KEYS · UNIT R. The keyboard continues (columns 8–15) so a shape crossing the seam is unbroken; the top row shows playhead cells 8–15. Unit R's bottom row is dark — the controls live on unit L."
  />
</div>
<h3>Record a loop</h3>
<ul class="tight">
  <li><strong>QUEUE-REC</strong> (bottom-row, unit L): tap to <strong>arm</strong> — it flashes yellow. Recording
    begins when the clip's playhead <strong>wraps to step 1</strong> (the transport auto-starts if it was
    stopped); the pad turns <strong>red</strong>. A queued clip can't yank the take — the lane is pinned to the
    clip you're recording.</li>
  <li><strong>Record (overdub OFF) = TRUE REPLACE:</strong> as the playhead crosses each step it is
    <strong>cleared</strong>, then filled by whatever you play that pass — so an un-played region wipes. Play a
    monophonic lane and the first note per step wins; a poly lane captures a chord.</li>
  <li><strong>OVERDUB (on) = additive:</strong> each pass layers onto the last and it loops endlessly; toggle
    OVERDUB off to finish (it stops at the end of the current loop). The in-view <strong>OVERDUB</strong> pad
    (light → bright purple) mirrors + changes the mode you entered with.</li>
  <li><strong>Velocity</strong> is captured from how hard you hit the pad (a Launchpad X is expressive
    automatically; a velocity-flat Mini records a default level).</li>
  <li><strong>LEN</strong> opens the length page (it returns to KEYS on EXIT), so you can set the clip length
    without leaving.</li>
</ul>
<h3>Getting out</h3>
<ul class="tight">
  <li><strong>EXIT while recording</strong> = stop recording but <strong>stay in KEYS</strong> (the clip keeps
    playing); a <strong>second EXIT</strong> = back to the session matrix.</li>
  <li><strong>EXIT while armed-but-not-recording</strong> = cancel the arm (idle KEYS).</li>
  <li><strong>EXIT while idle</strong> = back to the session matrix (both units return to L = matrix, R = deck).</li>
</ul>
<h3>What the KEYS colours mean</h3>
<div class="swatch-grid">
  {#each KEYS_COLORS as c (c.state)}
    <div class="swatch-row two">
      <span class="chip" style:background={hex(c.rgb)}></span>
      <span class="s-state">{c.state}</span>
      <span class="s-note">{c.note}</span>
    </div>
  {/each}
</div>

<h2>LED colour language</h2>
<p class="muted">
  Every swatch is the exact RGB the firmware receives (type-3 lighting SysEx, 0–127 per channel). State
  always wins over a clip's own tint; pulse/flash animate on the binding's ~2 Hz blink.
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

<h2>Pad + CC reference (confirmed hardware)</h2>
<table class="map">
  <tbody>
    {#each PAD_MAP as r (r.what)}
      <tr><td class="m-what">{r.what}</td><td class="m-addr"><code>{r.addr}</code></td></tr>
    {/each}
  </tbody>
</table>

<style>
  .hero { margin-bottom: 1.25rem; }
  .diagram-pair { display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-start; }
  .lede { color: var(--muted, #9aa0b2); line-height: 1.5; max-width: 62ch; }
  .muted { color: var(--muted, #9aa0b2); font-size: 0.9rem; max-width: 70ch; }
  h2 { margin-top: 1.8rem; }
  h3 { margin-top: 1rem; color: var(--muted, #9aa0b2); font-size: 0.95rem; }
  ol.steps { line-height: 1.6; max-width: 70ch; }
  ol.steps li { margin-bottom: 0.3rem; }
  ul.tight { line-height: 1.5; max-width: 70ch; margin-top: 0.4rem; }
  ul.tight li { margin-bottom: 0.2rem; }
  .swatch-grid { display: flex; flex-direction: column; gap: 4px; margin: 0.5rem 0 1rem; }
  .swatch-row { display: grid; grid-template-columns: 24px 200px 110px 1fr; align-items: center; gap: 10px; font-size: 0.85rem; }
  .swatch-row.two { grid-template-columns: 24px 200px 1fr; }
  .chip { width: 22px; height: 22px; border-radius: 5px; border: 1px solid #2b2e38; display: inline-block; }
  .s-state { font-weight: 600; }
  .s-anim { color: var(--muted, #9aa0b2); font-style: italic; }
  .s-note { color: var(--muted, #9aa0b2); }
  table.map { border-collapse: collapse; margin: 0.5rem 0 1.5rem; width: 100%; }
  table.map td { padding: 5px 10px; border-bottom: 1px solid #2a2d36; vertical-align: top; }
  .m-what { font-weight: 600; white-space: nowrap; }
  .m-addr code { font-size: 0.8rem; color: var(--muted, #cfd3df); }
</style>
