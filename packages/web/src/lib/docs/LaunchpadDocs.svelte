<script lang="ts">
  // LAUNCHPAD MK3 — shared, colour-coded in-app guide with faithful pad-grid
  // diagrams. Rendered by /docs/modules/launchpadControlLeft, the consolidated
  // launchpad-control module's docs route (right-click the card → "View docs").
  //
  // STRUCTURE (owner directive): TAB navigation. Two top-level tabs —
  // "1 Launchpad" and "2 Launchpads". "1 Launchpad" has subtabs for its real
  // views (Grid Mode · Clip Mode · Arranger Mode (TBD) · Control Mode, plus the
  // beginner Walkthrough — a deliberate 5th subtab beyond the owner's four, the
  // home of the pre-existing beginner guide; flag it during preview); the
  // shared single-mode foundation (Setup · permanent top row · SHIFT ·
  // palettes) lives in collapsed <details> directly under the subtab strip so
  // the mode tabs are the first thing a reader sees. "2 Launchpads" has subtabs
  // derived from the real pair-mode structure (Unit L matrix · Unit R deck ·
  // note editor · KEYS). Tab state is local component state (no router
  // changes); tabs use role=tablist/tab/tabpanel with arrow-key navigation.
  //
  // VOCABULARY (owner directive): two kinds of recording, named consistently —
  //   CLIP RECORD     = recording INTO a clip (KEYS note-record; automation
  //                     record via the per-lane arm — SHIFT+top-row on the
  //                     Launchpad, the per-lane ◉ on the card).
  //   ARRANGER RECORD = the red ● that records clip LAUNCHES into the song
  //                     arrangement.
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
    RGB_PATTERN_ARMED,
    RGB_TIMING,
    RGB_TIMING_ARMED,
    RGB_KEYS_ENTRY,
    RGB_SWING_UP,
    RGB_SWING_DOWN,
    RGB_ARRANGER_DIM,
    RGB_VEL_WASH,
    RGB_SONG_SESSION,
    // KEYS mode (note/keyboard + CLIP RECORD)
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
    // performance controls (P1 RESET · P4 MONO · P3 MUTE · P2 RATE · P5 tempo · P7 panic)
    RGB_RESET,
    RGB_MONO_ON,
    RGB_MONO_OFF,
    RGB_MUTE_ON,
    RGB_MUTE_OFF,
    RGB_RATE_BY_INDEX,
    RGB_TEMPO_NUDGE,
    RGB_PANIC,
    hexToRgb127,
    // SCENE-REPEAT count view — the diagram below is generated from the REAL
    // frame painter (computeSingleGridFrame + repeatPadOrdinal), so the picture
    // IS the firmware paint for that state (drift-guarded in the unit test).
    computeSingleGridFrame,
    repeatPadOrdinal,
    type Rgb,
  } from '$lib/control/launchpad/launchpad-map';
  import { padNote, SCENE_CCS } from '$lib/control/launchpad/launchpad-sysex';
  import { keyboardCellToMidi, noteRole } from '$lib/audio/modules/keyboard-map';
  import { defaultLaneColorHex } from '$lib/audio/modules/clip-types';

  // ── TAB STATE (local; no router involvement). ──
  const TOP_TABS = [
    { id: 'single', label: '1 Launchpad' },
    { id: 'pair', label: '2 Launchpads' },
  ] as const;
  type TopTab = (typeof TOP_TABS)[number]['id'];
  const SINGLE_TABS = [
    { id: 'grid', label: 'Grid Mode' },
    { id: 'clip', label: 'Clip Mode' },
    { id: 'arranger', label: 'Arranger Mode (TBD)' },
    { id: 'control', label: 'Control Mode' },
    { id: 'walkthrough', label: 'Walkthrough' },
  ] as const;
  type SingleTab = (typeof SINGLE_TABS)[number]['id'];
  // Pair subtabs mirror the real pair-mode structure: Unit L is permanently the
  // live matrix; Unit R is the deck, which flips to the note editor / length
  // page; KEYS takes over BOTH units.
  const PAIR_TABS = [
    { id: 'matrix', label: 'Matrix (Unit L)' },
    { id: 'deck', label: 'Deck (Unit R)' },
    { id: 'editor', label: 'Note Editor (Unit R)' },
    { id: 'keys', label: 'Keys (both units)' },
  ] as const;
  type PairTab = (typeof PAIR_TABS)[number]['id'];

  // Optional INITIAL-tab props — the doc route renders with the defaults; the
  // SSR unit test uses them to render EVERY panel (the CPY/PST-absence guard
  // must cover the pair note editor, not just the default Grid panel).
  type Props = { initialTopTab?: TopTab; initialSingleTab?: SingleTab; initialPairTab?: PairTab };
  const { initialTopTab = 'single', initialSingleTab = 'grid', initialPairTab = 'matrix' }: Props = $props();

  // The props are INITIAL values by design (tab state is then local) — the
  // initial-only capture the warning points at is exactly what we want.
  // svelte-ignore state_referenced_locally
  let topTab = $state<TopTab>(initialTopTab);
  // svelte-ignore state_referenced_locally
  let singleTab = $state<SingleTab>(initialSingleTab);
  // svelte-ignore state_referenced_locally
  let pairTab = $state<PairTab>(initialPairTab);

  /** Roving-tabindex arrow-key navigation for a tablist (←/→/Home/End). */
  function tabKeydown(
    e: KeyboardEvent,
    ids: readonly string[],
    current: string,
    set: (id: string) => void,
    prefix: string,
  ): void {
    const i = ids.indexOf(current);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    set(ids[next]);
    document.getElementById(`${prefix}-${ids[next]}`)?.focus();
  }

  // Render the EXACT RGB the firmware receives (0..127 → 0..255 for the screen).
  const hex = (c: Rgb) =>
    `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;

  // ── The clip MATRIX (an illustrative live state) — pair Unit L. ──
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
  // PAIR Unit-L top row (CC 91..98) — the 8 per-lane MUTE pads (col = lane).
  // Shown: lane 3 muted (orange), the rest live (dim).
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
    o: {
      running?: boolean;
      shift?: 'off' | 'held' | 'latch';
      keys?: boolean;
      undo?: boolean;
      redo?: boolean;
      /** PER-LANE automation-arm states (mirrors PermanentTopOpts.laneArms).
       *  Faithful to paintPermanentTopRow: while shift is ACTIVE, columns 1–7
       *  paint as the ARM MAP (red = armed · dim red = available; col 8 keeps
       *  the shift LED); otherwise an ARMED lane's button red-flashes over its
       *  base colour — the diagram shows the bright (red) phase. */
      arms?: boolean[];
    } = {},
  ) {
    const v = (view: SView) =>
      hex(active === view || (view === 'clip' && o.keys) ? RGB_VIEW_ACTIVE : RGB_VIEW_IDLE);
    const sh = o.shift === 'held' ? RGB_SHIFT_HELD : o.shift === 'latch' ? RGB_SHIFT_LATCH : RGB_SHIFT_OFF;
    const base = [
      { col: 0, fill: hex(o.running ? RGB_TRANSPORT_ON : RGB_TRANSPORT_STOP), label: o.running ? '▶' : '■' },
      { col: 1, fill: v('grid'), label: 'GRID' },
      { col: 2, fill: v('clip'), label: 'CLIP' },
      { col: 3, fill: v('arranger'), label: 'ARR' },
      { col: 4, fill: v('control'), label: 'CTRL' },
      { col: 5, fill: hex(o.undo ? RGB_SYS : RGB_SYS_DIM), label: 'UNDO' },
      { col: 6, fill: hex(o.redo ? RGB_SYS : RGB_SYS_DIM), label: 'REDO' },
      { col: 7, fill: hex(sh), label: 'SHFT' },
    ];
    // ARM LAYER (mirrors paintPermanentTopRow, so the pictures can't drift).
    const shiftActive = o.shift === 'held' || o.shift === 'latch';
    const arms = o.arms ?? [];
    return base.map((cell, col) => {
      const armed = arms[col] === true;
      if (shiftActive && col < 7) {
        // ARM MAP while shift is active: red = armed, dim red = available,
        // labelled by LANE number (the compass labels come back off-shift).
        return { col, fill: hex(armed ? RGB_RECORDING : RGB_STOP_IDLE), label: String(col + 1) };
      }
      // Always-visible armed indicator: the red phase of the red-flash (col 8
      // alternates with the shift LED).
      return armed ? { ...cell, fill: hex(RGB_RECORDING) } : cell;
    });
  }
  const permTopGroups = [
    { label: 'TRANSPORT', fromCol: 0, tier: 0 },
    { label: 'VIEWS  ·  Grid · Clip · Arranger · Control', fromCol: 1, toCol: 4, tier: 1 },
    { label: 'UNDO / REDO', fromCol: 5, toCol: 6, tier: 0 },
    { label: 'SHIFT', fromCol: 7, tier: 1 },
  ];
  // The ARM-LAYER diagram states (shown: lane 3 armed).
  const ARMS_LANE3 = [false, false, true, false, false, false, false, false];
  const armMapGroups = [
    { label: 'ARM MAP — press = toggle that lane (red pulse = armed · dim red = available)', fromCol: 0, toCol: 6, tier: 0 },
    { label: 'SHFT — lane 8 = double-tap', fromCol: 7, tier: 1 },
  ];

  // ── GRID view — the TRANSPOSED clip matrix: x = channel/lane (0..7 left→right),
  // slot runs TOP→bottom (top row = slot 0). gp() places a clip by (lane, slot).
  // Single-mode clip states paint in each CHANNEL'S OWN colour (the picked
  // swatch, else defaultLaneColorHex) — dim = loaded, full = playing, flashing =
  // queued-launch. Only queued-STOP keeps the semantic red (mirrors
  // singleClipStateRgb in launchpad-map). ──
  const gp = (lane: number, slot: number, fill: string, label?: string) => ({ x: lane, y: 7 - slot, fill, label });
  const laneRgb = (lane: number): Rgb => hexToRgb127(defaultLaneColorHex(lane));
  /** The dim "loaded" tint of a channel colour (the same 0.32 scale the firmware uses). */
  const dimRgb = (c: Rgb): Rgb => [Math.round(c[0] * 0.32), Math.round(c[1] * 0.32), Math.round(c[2] * 0.32)];
  const gridPads = [
    gp(0, 0, hex(laneRgb(0)), 'K'), // ch1 slot 0 — playing (solid, ch-1 colour)
    gp(0, 1, hex(dimRgb(laneRgb(0)))),
    gp(0, 2, hex(dimRgb(laneRgb(0)))),
    gp(1, 0, hex(laneRgb(1)), 'S'), // ch2 slot 0 — playing
    gp(1, 1, hex(dimRgb(laneRgb(1)))),
    gp(2, 0, hex(laneRgb(2)), 'V'), // ch3 slot 0 — queued-launch (flashes in ch-3's colour)
    gp(2, 1, hex(dimRgb(laneRgb(2)))),
    gp(3, 0, hex(RGB_QUEUED_STOP)), // ch4 slot 0 — queued-stop (flashing RED — always semantic)
    gp(4, 2, hex(dimRgb(laneRgb(4)))),
  ];
  const gridCallouts = [{ label: 'CHANNELS / LANES  1 → 8', fromCol: 0, toCol: 7 }];
  // No shift → the right column is SCENE / ROW launch (a grid ROW = one clip per
  // channel = a song section). CONTENT-GATED like the firmware: amber only where
  // the scene has any clips (slots 0–2 in the state above → rows 7..5), dark
  // where empty; flashes green on the row holding the queued clip (slot 0 → the
  // TOP row).
  const gridRowScene = Array.from({ length: 8 }, (_, r) => ({
    row: r,
    fill: r === 7 ? hex(RGB_QUEUED) : r >= 5 ? hex(RGB_SCENE) : '',
    label: r === 7 ? 'ROW ▶' : undefined,
  }));
  // + shift → the function palette (scene index 0..7 = rows 7..0 top→bottom):
  // Copy · Paste · Clip-Div · Swing+ · Swing− · Length · Scroll▲ · Scroll▼ (amber).
  const gridShiftScene = [
    { row: 7, fill: hex(RGB_PATTERN), label: 'COPY' }, // green (tap-to-arm)
    { row: 6, fill: hex(RGB_COPY_BUFFER), label: 'PASTE' }, // turquoise while the buffer holds a clip
    { row: 5, fill: hex(RGB_TIMING), label: 'DIV' }, // blue (per-clip divider)
    { row: 4, fill: hex(RGB_TIMING), label: 'SW+' }, // blue idle; ramps purple while raising
    { row: 3, fill: hex(RGB_TIMING), label: 'SW−' }, // blue idle; ramps blue while lowering
    { row: 2, fill: hex(RGB_DECK_LEN), label: 'LEN' }, // yellow (owner override)
    { row: 1, fill: hex(RGB_SCENE), label: 'SCR▲' }, // amber scene-window UP (was P-REV)
    { row: 0, fill: hex(RGB_SCENE), label: 'SCR▼' }, // amber scene-window DOWN (was NOW)
  ];

  // ── SCENE-REPEAT COUNT VIEW (HOLD GRID + HOLD a scene-launch button). The
  // diagram is GENERATED from the REAL frame painter for the 16-repeats state
  // (top two rows orange, held scene button bright amber), so the picture is
  // byte-for-byte the firmware paint — the launchpad-docs unit test pins the
  // rendered SVG fills to a fresh computeSingleGridFrame run of the SAME state
  // (the paintPermanentTopRow drift-guard pattern, extended to the pads). ──
  const REPEAT_DIAGRAM_COUNT = 16;
  const repeatFrame = computeSingleGridFrame(undefined, {
    top: {
      view: 'grid',
      keysActive: false,
      transportRunning: true,
      shift: { latched: false, held: false },
      canUndo: false,
      canRedo: false,
    },
    repeatView: { count: REPEAT_DIAGRAM_COUNT, sceneIndex: 0 },
  });
  const isOffLed = (c: readonly number[] | undefined): boolean =>
    !c || (c[0] === 0 && c[1] === 0 && c[2] === 0);
  const repeatPads = (() => {
    const out: { x: number; y: number; fill: string; label?: string }[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const led = repeatFrame.leds.get(padNote(x, y));
        if (isOffLed(led)) continue;
        const k = repeatPadOrdinal(x, y)!;
        out.push({
          x,
          y,
          fill: hex(led as Rgb),
          label: k === 1 ? '1' : k === REPEAT_DIAGRAM_COUNT ? String(REPEAT_DIAGRAM_COUNT) : undefined,
        });
      }
    }
    return out;
  })();
  const repeatScene = (() => {
    const out: { row: number; fill: string; label?: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const led = repeatFrame.leds.get(SCENE_CCS[i]);
      if (isOffLed(led)) continue;
      out.push({ row: 7 - i, fill: hex(led as Rgb), label: i === 0 ? 'HOLD' : undefined });
    }
    return out;
  })();

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
    { row: 7, fill: hex(RGB_PATTERN), label: 'DBL' },
    { row: 6, fill: hex(RGB_PATTERN), label: 'LEN' },
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

  // ── CONTROL view — the performance deck + the RE-HOMED transport/arranger
  // controls. (The old single AUTO pad at (2,6) is RETIRED — per-lane
  // automation arm is the permanent top row's SHIFT+column gesture.) ──
  const controlPads = [
    // re-homed onto dark grid pads (the permanent CC row owns the real top row):
    { x: 0, y: 7, fill: hex(RGB_TEMPO_NUDGE), label: 'T−' },
    { x: 1, y: 7, fill: hex(RGB_TEMPO_NUDGE), label: 'T+' },
    { x: 3, y: 7, fill: hex(RGB_STOP_IDLE), label: 'ALL' },
    { x: 0, y: 6, fill: hex(RGB_STOP_IDLE), label: 'REC' }, // ARRANGER RECORD arm
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

  // ── The COMMAND DECK 8×8 (pair Unit R). ──
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
  const pairDeckTop = [
    { col: 0, fill: hex(RGB_RECORDING), label: 'REC' }, // CC 91 — ARRANGER RECORD arm
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
  // Editor scene column (physical rows, top = 7): EXIT 7 · DBL 6 · LEN 5 ·
  // OC+ 1 · OC− 0. Rows 4–2 are dark + inert (copy/paste is Grid-page-only) —
  // drawn unlit so the picture matches the device byte-for-byte.
  const pairEditScene = [
    { row: 7, fill: hex(RGB_EXIT), label: 'EXIT' },
    { row: 6, fill: hex(RGB_FUNC), label: 'DBL' },
    { row: 5, fill: hex(RGB_FUNC), label: 'LEN' },
    { row: 4, fill: '' },
    { row: 3, fill: '' },
    { row: 2, fill: '' },
    { row: 1, fill: hex(RGB_FUNC), label: 'OC+' },
    { row: 0, fill: hex(RGB_FUNC), label: 'OC−' },
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

  // ── colour legends (per-tab reference — every swatch is the live firmware
  // RGB). ──
  // PAIR-MATRIX clip states (computeLSessionFrame): the pair unit L paints the
  // SEMANTIC palette (blue loaded / green playing / green-red queued). Rendered
  // on the pair Matrix tab only — the SINGLE grid uses channel colours (below).
  const SESSION_COLORS: { state: string; rgb: Rgb; anim: string; note: string }[] = [
    { state: 'empty slot', rgb: [0, 0, 0], anim: 'off', note: 'no clip here' },
    { state: 'loaded clip', rgb: RGB_LOADED, anim: 'static dim', note: 'has notes, stopped' },
    { state: 'playing', rgb: RGB_PLAYING, anim: 'SOLID green', note: 'running now (steady — a blinking pad means queued, not playing)' },
    { state: 'queued-launch', rgb: RGB_QUEUED, anim: 'flash green', note: 'waiting for the loop boundary' },
    { state: 'queued-stop', rgb: RGB_QUEUED_STOP, anim: 'flash red', note: 'will stop on the boundary' },
    { state: 'ARRANGER RECORD armed', rgb: RGB_RECORDING, anim: 'pulse red', note: 'clip launches are being recorded to the song timeline' },
    { state: 'arrangement (SONG)', rgb: RGB_SONG_ARRANGE, anim: 'static white', note: 'SES⇄ARR lit in ARRANGEMENT' },
    { state: 'copy buffer (BUF)', rgb: RGB_COPY_BUFFER, anim: 'pulse turquoise', note: 'a clip is in the clipboard — the deck BUF pad (pair) / the Grid-shift PASTE button (single); tap BUF or re-tap COPY to clear' },
    { state: 'scene (matrix right col)', rgb: RGB_SCENE, anim: 'amber', note: 'fire one clip slot across all 8 lanes at once (a column of slots on pair unit L; a row on the single grid)' },
    { state: 'stop lane idle (deck right col)', rgb: RGB_STOP_IDLE, anim: 'dim red', note: 'per-lane stop' },
    { state: 'stop lane active', rgb: RGB_STOP_ACTIVE, anim: 'bright red', note: 'that lane is audible' },
  ];
  // SINGLE-GRID clip states (singleClipStateRgb): every state paints in the
  // CHANNEL'S OWN colour (picked swatch, else its default hue) so the pad
  // matches the card — only queued-STOP keeps the semantic red. The chips use
  // channel 3's default colour as the example.
  const SINGLE_GRID_COLORS: { state: string; rgb: Rgb; anim: string; note: string }[] = [
    { state: 'empty slot', rgb: [0, 0, 0], anim: 'off', note: 'no clip here (glows dim red while ARRANGER RECORD is armed)' },
    { state: 'loaded clip', rgb: dimRgb(laneRgb(2)), anim: 'static dim', note: 'has notes, stopped — DIM in the channel’s own colour' },
    { state: 'playing', rgb: laneRgb(2), anim: 'SOLID', note: 'running now — full-brightness channel colour (steady; a blinking pad means queued, not playing)' },
    { state: 'queued-launch', rgb: laneRgb(2), anim: 'flash', note: 'flashes in the channel’s colour until the loop boundary' },
    { state: 'queued-stop', rgb: RGB_QUEUED_STOP, anim: 'flash RED', note: 'will stop on the boundary — always red, whatever the channel colour' },
    { state: 'scene / ROW launch (right col)', rgb: RGB_SCENE, anim: 'amber', note: 'fire one slot-row across all 8 channels; dark = empty scene; flashes green while queued' },
  ];
  // SINGLE Control-mode legend — ONLY the pads that exist in the single Control
  // view (the pair deck's EDIT/COPY/NOW/DBL/editor rows live in DECK_COLORS,
  // rendered on the pair Deck tab).
  const SINGLE_CONTROL_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'RESET (RST)', rgb: RGB_RESET, note: 'steel blue — snap every active channel back to step 1 (row 1, col 2)' },
    { state: 'MONO on / off', rgb: RGB_MONO_ON, note: 'teal — channel is MONO (one note per column); dim teal = poly (row 2)' },
    { state: 'MUTE on / off', rgb: RGB_MUTE_ON, note: 'orange — channel muted (advances but silent); dim = live (row 3)' },
    { state: 'RATE (per channel)', rgb: RGB_RATE_BY_INDEX[3], note: 'a cool→warm ramp (1/8…4x); the shown green = the default ‘1’ (row 4). Tap to cycle up' },
    { state: 'TEMPO nudge − / +', rgb: RGB_TEMPO_NUDGE, note: 'dim white — step TIMELORDE’s bpm ±2' },
    { state: 'per-lane STOP idle', rgb: RGB_STOP_IDLE, note: 'dim red — right column (also the idle REC / STOP-ALL re-homed pads, and the “available” lanes of the top-row arm map under SHIFT)' },
    { state: 'per-lane STOP active', rgb: RGB_STOP_ACTIVE, note: 'bright red — that channel is audible now' },
  ];
  const DECK_COLORS: { state: string; rgb: Rgb; note: string }[] = [
    { state: 'EDIT', rgb: RGB_DECK_EDIT, note: 'orange — opens a clip’s note editor (brightens while held/armed)' },
    { state: 'COPY / PASTE / P-REV', rgb: RGB_DECK_COPY, note: 'green — clipboard actions (brighten while held/armed)' },
    { state: 'DOUBLE', rgb: RGB_DECK_DBL, note: 'purple — duplicate the pattern + double the clip length (cap 128)' },
    { state: 'LENGTH', rgb: RGB_DECK_LEN, note: 'yellow — open the 2-row length page' },
    { state: 'NOW', rgb: RGB_DECK_NOW, note: 'purple — launches ignore quantize (hold on the PAIR deck; the single-mode Grid-shift column no longer carries NOW — its bottom two buttons are the amber scene-scroll)' },
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
    { state: 'CLIP RECORD (QUEUE-REC) idle', rgb: RGB_QREC_IDLE, note: 'dull yellow — not armed' },
    { state: 'CLIP RECORD armed', rgb: RGB_QREC_ARMED, note: 'bright yellow, flashes — waiting for the loop wrap' },
    { state: 'CLIP RECORD recording', rgb: RGB_QREC_REC, note: 'red, pulses — capturing notes now' },
    { state: 'OVERDUB off / on', rgb: RGB_OD_ON, note: 'light purple (off) → bright purple (on, additive)' },
    { state: 'note-REC / OVERDUB hold', rgb: RGB_KEYS_REC_HOLD, note: 'deck row 1 — the KEYS entry holds (dim red / dim purple)' },
  ];
  // ── SINGLE-MODE palettes: (a) the PERMANENT TOP-ROW navigation palette;
  // (b) the RIGHT-COLUMN function taxonomy. ──
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
    { state: 'pattern', rgb: RGB_PATTERN, note: 'green — content: copy · paste · double · follow · scales · row-nav' },
    { state: 'pattern — armed / selected', rgb: RGB_PATTERN_ARMED, note: 'bright green — armed (tap-to-arm) or the selected scale / arp direction' },
    { state: 'timing', rgb: RGB_TIMING, note: 'blue — clip divider · swing ± · step-scroll · arp division' },
    { state: 'timing — armed / jump', rgb: RGB_TIMING_ARMED, note: 'bright blue — armed clip-div, or a block / page jump under shift' },
    { state: 'length', rgb: RGB_DECK_LEN, note: 'yellow — edit clip length (owner override; not green)' },
    { state: 'KEYS entry', rgb: RGB_KEYS_ENTRY, note: 'bright orange — open the KEYS keyboard (owner override)' },
    { state: 'system', rgb: RGB_SYS, note: 'orange — arp range · arp on/off · arp latch' },
    { state: 'system — off', rgb: RGB_SYS_DIM, note: 'dim orange — that system toggle is off' },
    { state: 'copy buffer', rgb: RGB_COPY_BUFFER, note: 'turquoise (pulses) — the Paste button while the clipboard holds a clip' },
    { state: 'swing — raising', rgb: RGB_SWING_UP, note: 'purple ramp — Swing+ nudged up (pale → bright by amount)' },
    { state: 'swing — lowering', rgb: RGB_SWING_DOWN, note: 'blue ramp — Swing− nudged down' },
  ];

  // ── Pad + CC reference tables, split per tab (the raw protocol is shared). ──
  type MapRow = { what: string; addr: string };
  const SINGLE_MAP_GLOBAL: MapRow[] = [
    { what: 'permanent top row (every view)', addr: 'CC 91 = transport (red stopped / green playing) · 92 = GRID · 93 = CLIP · 94 = ARRANGER · 95 = CONTROL (purple; bright = active) · 96 = UNDO · 97 = REDO (orange) · 98 = SHIFT (yellow: dim off / bright held / solid latched). This row NEVER changes meaning per view' },
    { what: 'SHIFT (CC 98)', addr: 'TAP = latch the alt layer (solid yellow); tap again = unlatch. HOLD = momentary (bright yellow). Effective shift = latched OR held. Grid compound functions arm on tap so nothing needs a second hand. DOUBLE-TAP = toggle lane 8’s automation arm (the latch nets back to where it was)' },
    { what: 'AUTOMATION ARM (SHIFT + top row)', addr: 'while SHIFT is held or latched, the top row becomes the PER-LANE ARM MAP: press column 1–7 to toggle that lane’s automation record (red pulse = armed · dim red = available); lane 8 = double-tap SHIFT itself. Works from EVERY view; the press is consumed (no transport/view/undo side-effect). An armed lane’s button red-flashes over its normal colour all the time' },
    { what: 'UNDO / REDO (CC 96 / 97)', addr: 'launchpad-scoped: undoes only THIS launchpad’s persistent clip edits (div / swing / length / paste / content / scale) — never a collaborator’s edit, never a transient launch. Lit orange when the stack has something; dim otherwise. Under SHIFT these presses are the lane 6/7 arm toggles instead' },
  ];
  const SINGLE_MAP_GRID: MapRow[] = [
    { what: 'GRID — the clip matrix', addr: 'column = channel / lane (1–8 left→right), row = clip slot (top row = slot 1). Single-tap = launch / stop (queued to the boundary). DOUBLE-TAP a clip = select it + open CLIP on it (empty pad = create a clip). No-shift right column = ROW / scene launch — a SCROLLING window of position-relative buttons over up to 64 scenes (slid by Grid+shift SCR▲/SCR▼)' },
    { what: 'GRID + shift right column', addr: 'top→bottom: COPY · PASTE · CLIP-DIV · SWING+ · SWING− · LENGTH · SCROLL▲ · SCROLL▼ (amber). Copy / Paste / Clip-Div / Length are TAP-TO-ARM (tap → arm → tap a target). Copy + a ROW/scene press grabs the WHOLE SCENE (all 8 lanes) — release/unlatch SHIFT first so the column shows the ROW ▶ buttons (clip-pad targets work under either shift state); Paste is type-gated (clip→clip + scene→scene apply, the cross-type pastes are no-ops). Swing ± are direct ±2 % nudges on the SELECTED channel. SCROLL ▲▼ slide the scene window (up to 64 scenes; each dims at its limit)' },
    { what: 'SCENE REPEATS — HOLD GRID + HOLD a scene button', addr: 'the 8×8 becomes the orange REPEAT-COUNT view for that scene (no shift — SHIFT+top-row stays the arm map). Tap pad k (row-major from the upper-left) = k repeats (1–63) · pad 64 = INFINITE (default). Pads 1..N stay lit for count N; all 64 lit = infinite. The held button is POSITION-RELATIVE through the scene scroll (button i edits scene offset+i); the press never launches. Release either button = back to the grid. After N passes of the scene’s longest clip (frozen at launch) the next content scene down auto-launches via the normal quantized path' },
  ];
  const SINGLE_MAP_CLIP: MapRow[] = [
    { what: 'CLIP — note-editor right column', addr: 'top→bottom: DOUBLE · LENGTH · FOLLOW · KEYS · ROW+ · ROW− · STEP◀ · STEP▶. Shift: ROW± = a full page jump (±8 rows), STEP± = block jump, and the 8×8 becomes VELOCITY-cycle (tap a note → cycle its velocity)' },
    { what: 'KEYS — scale select (no shift)', addr: 'top→bottom: MAJOR · MINOR · PENTATONIC · DORIAN · PHRYGIAN · MIXOLYDIAN · CHROMATIC · ARP on/off. Selected scale glows bright green. The scale lights the keyboard but does NOT snap live input (pads stay chromatic)' },
    { what: 'KEYS + shift — the arp column', addr: 'top→bottom: DIV+ · DIV− · UP · DOWN · UP-AND-DOWN · RANGE+ · RANGE− · LATCH. Divisions 8x…1/8 (1x default); ranges 1 oct / +1..−1 / +2..−2 (symmetric); up-and-down is an exclusive pendulum' },
    { what: 'KEYS entry / exit', addr: 'enter from CLIP → the KEYS button (right column, bright orange) on the selected clip. In KEYS the bottom row is EXIT · QUEUE-REC (clip record) · OVERDUB · OCT− · OCT+ · PANIC · LENGTH. A view button exits KEYS; EXIT steps back (recording → armed → idle → the views)' },
    { what: 'LENGTH-EDIT page', addr: 'opened from GRID+shift LENGTH or CLIP LENGTH. Bottom row = end BLOCK (1–8 ×16), next two rows = end STEP (1–8, 9–16). Length = (endBlock−1)×16 + endStep, up to 128. EXIT = top scene button' },
  ];
  const SINGLE_MAP_CONTROL: MapRow[] = [
    { what: 'CONTROL — the performance deck', addr: 'RESET (row 1, col 2, steel blue) · MONO row (teal) · MUTE row (orange) · RATE row (rate ramp) — one pad per channel. Right column = per-lane STOP. Re-homed on dark pads: TEMPO− / TEMPO+ / STOP-ALL (top grid row); REC (arranger record) · SONG one row below. Automation arm is NOT here — it is SHIFT + the lane’s top-row button (every view)' },
  ];
  const SINGLE_MAP_ARRANGER: MapRow[] = [
    { what: 'ARRANGER', addr: 'inert placeholder (faint grid, dark right column). The arrangement engine exists but has no launchpad UI yet; ARRANGER RECORD (REC) + SONG live in CONTROL for now' },
  ];
  const PAIR_MAP_MATRIX: MapRow[] = [
    { what: 'Unit L top row (CC 91..98)', addr: 'the 8 per-lane MUTE pads (col = lane) — orange = muted (advances but silent), dim = live. On the always-visible matrix unit' },
  ];
  const PAIR_MAP_DECK: MapRow[] = [
    { what: 'deck hold-modifiers (R, row 0)', addr: 'EDIT · COPY · PASTE · P-REV · NOW — hold on R + tap a clip on L. BUF (col 4) = tap to clear the clipboard' },
    { what: 'deck globals (R top row)', addr: 'CC 91 = REC (ARRANGER RECORD arm) · 92 = SONG (SES⇄ARR) · 93 = TEMPO− · 94 = TEMPO+ · 96 = PLAY (transport) · 97 = ALL (stop-all) · 95 = SHIFT (editor ×8)' },
    { what: 'automation arm (pair mode)', addr: 'not on the pair hardware yet — the L top row is the per-lane MUTE strip and the R top row is the deck globals, so per-lane automation arm stays on the CARD (the per-lane ◉ next to each RATE control) for the two-unit rig; a pair surface is a follow-up' },
    { what: 'RESET / MONO / MUTE / RATE (R deck)', addr: 'row 1 col 2 = RESET · row 2 = MONO · row 3 = MUTE · row 4 = RATE (per lane) — identical to the single deck (single IS the R brain)' },
  ];
  const PAIR_MAP_EDITOR: MapRow[] = [
    { what: 'editor nav (R top row)', addr: 'CC 91 ▲ · 92 ▼ · 93 ◀ · 94 ▶ (±1; hold SHIFT/CC 95 = ±8) · 96 = VEL (hold + tap) · 97 = SCALE · 98 = FOLLOW' },
    { what: 'editor scene column (top→bottom)', addr: 'EXIT (row 7) · DBL (row 6) · LEN (row 5) · rows 4–2 dark (copy/paste is Grid-only) · OCT+ (row 1) · OCT− (row 0)' },
  ];
  const PAIR_MAP_KEYS: MapRow[] = [
    { what: 'KEYS entry', addr: 'hold note-REC (R deck row 1 col 0) or note-OVERDUB (col 1) + DOUBLE-TAP a clip on L (REC = overdub off · OVERDUB = overdub on)' },
    { what: 'KEYS layout', addr: 'top rows = 16-cell playhead (L 1–8, R 9–16) · 6 keyboard rows continuous across the L|R seam · bottom row (L) = EXIT · QUEUE-REC · OVERDUB · OCT− · OCT+ · PANIC · LEN' },
  ];
  const HW_MAP: MapRow[] = [
    { what: '8×8 pads (programmer mode)', addr: 'note = row*10 + col · 11 = bottom-left · 88 = top-right' },
    { what: 'top row buttons', addr: 'CC 91 · 92 · 93 · 94 · 95 · 96 · 97 · 98 (left → right)' },
    { what: 'right scene column (top→bottom)', addr: 'CC 89 · 79 · 69 · 59 · 49 · 39 · 29 · 19' },
    { what: 'per-LED full RGB', addr: 'F0 00 20 29 02 0D 03  03 <pad> <R> <G> <B>  F7   (0–127)' },
  ];
</script>

{#snippet mapTable(rows: MapRow[])}
  <div class="table-scroll">
    <table class="map">
      <tbody>
        {#each rows as r (r.what)}
          <tr><td class="m-what">{r.what}</td><td class="m-addr"><code>{r.addr}</code></td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

{#snippet swatches3(colors: { state: string; rgb: Rgb; note: string }[])}
  <div class="swatch-grid">
    {#each colors as c (c.state)}
      <div class="swatch-row two">
        <span class="chip" style:background={hex(c.rgb)}></span>
        <span class="s-state">{c.state}</span>
        <span class="s-note">{c.note}</span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet stateSwatches(colors: { state: string; rgb: Rgb; anim: string; note: string }[])}
  <div class="swatch-grid">
    {#each colors as c (c.state)}
      <div class="swatch-row">
        <span class="chip" style:background={hex(c.rgb)}></span>
        <span class="s-state">{c.state}</span>
        <span class="s-anim">{c.anim}</span>
        <span class="s-note">{c.note}</span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet lengthEditSection()}
  <h3>LENGTH-EDIT — set an exact clip length</h3>
  <LaunchpadDiagram
    pads={lenPads}
    scene={lenScene}
    callouts={lenCallouts}
    accent={hex(RGB_LEN_END)}
    caption="LENGTH-EDIT page (shown: 3 blocks, end-step 4 → 36 steps). A full-device takeover. Bottom row = end BLOCK (1–8, ×16 steps each); the next two rows = end STEP (1–8, then 9–16). The bright pad is the current end — tap to set. Non-destructive; EXIT (top scene button) returns to where you came from."
  />
  <p class="muted">
    Length = (endBlock−1)×16 + endStep, up to 128. Each clip's length is independent — polymeter is
    the point — and all playing clips re-align to step 1 when the transport starts (or on a RESET).
  </p>
{/snippet}

{#snippet signalFlow()}
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
{/snippet}

<section class="hero">
  <h1>Launchpad Mini Mk3 — clip launcher</h1>
  <p class="lede">
    <strong>Novation Launchpad Mini Mk3</strong> drives the <strong>clip player</strong> over
    browser-native <strong>Web MIDI</strong> (no helper app). It works with <strong>one unit</strong> or
    <strong>two</strong> — pick a tab; each is a complete, self-contained guide for that mode.
  </p>
  <div class="rec-vocab">
    <h2>Two kinds of recording</h2>
    <dl>
      <dt>CLIP RECORD</dt>
      <dd>
        Recording <strong>into a clip</strong>. Notes: KEYS → <strong>QUEUE-REC</strong>. Knob / control
        moves: <strong>per-clip automation</strong>, Deluge-style — right-click a <strong>module's
        card</strong> → <em>Assign to automation lane</em> (1–8; the whole module joins the lane and its
        card gets a border in the lane's colour), launch a clip in that lane, then <strong>arm the
        lane</strong> (the card's per-lane <strong>◉</strong> next to its RATE control, or on a
        <strong>single-unit</strong> Launchpad <strong>SHIFT + that lane's top-row button</strong>; lane 8 =
        double-tap SHIFT — the two-unit rig has no hardware arm yet, arm from the card) and just
        move the module's controls: every touch — screen, MIDI, Electra — records into <em>that clip's
        own</em> automation, punching in at the clip's next loop start, then overdubbing every loop. <strong>CV is never recorded</strong>:
        automation records your hands, a CV cable stays live modulation.
      </dd>
      <dt>ARRANGER RECORD</dt>
      <dd>
        The red <strong>●</strong> that records your <strong>clip launches</strong> onto the song timeline
        (experimental). Arm it from the card's <strong>●</strong>, the single-mode Control-Mode
        <strong>REC</strong> pad, or the pair deck's top-left <strong>REC</strong> button (CC 91). It never
        records notes or knob moves.
      </dd>
    </dl>
  </div>
</section>

<div class="tabs top-tabs" role="tablist" aria-label="Launchpad configurations">
  {#each TOP_TABS as t (t.id)}
    <button
      type="button"
      role="tab"
      id={`lp-tab-${t.id}`}
      aria-selected={topTab === t.id}
      aria-controls={topTab === t.id ? `lp-panel-${t.id}` : undefined}
      tabindex={topTab === t.id ? 0 : -1}
      class:active={topTab === t.id}
      onclick={() => (topTab = t.id)}
      onkeydown={(e) => tabKeydown(e, TOP_TABS.map((x) => x.id), topTab, (id) => (topTab = id as TopTab), 'lp-tab')}
    >{t.label}</button>
  {/each}
</div>

{#if topTab === 'single'}
<div class="mode-section" id="lp-panel-single" role="tabpanel" tabindex="0" aria-labelledby="lp-tab-single">
  <h2 class="mode-title">1 Launchpad — one device, four views</h2>
  <p>
    One Launchpad does everything. The lone device is a <strong>four-view surface</strong> —
    <strong>GRID</strong> (launch clips), <strong>CLIP</strong> (edit notes; its KEYS sub-view plays,
    clip-records + arpeggiates), <strong>ARRANGER</strong> (TBD) and <strong>CONTROL</strong> (the
    performance deck) — laid over a <strong>permanent top-row nav bar</strong> that never changes meaning,
    with a one-hand <strong>SHIFT</strong> layer. New to the device? Start with the
    <strong>Walkthrough</strong> tab. Setup + the shared top-row / SHIFT foundation sit in the two
    collapsible panels just below the tabs.
  </p>

  <div class="tabs sub-tabs" role="tablist" aria-label="Single-Launchpad modes">
    {#each SINGLE_TABS as t (t.id)}
      <button
        type="button"
        role="tab"
        id={`lp1-tab-${t.id}`}
        aria-selected={singleTab === t.id}
        aria-controls={singleTab === t.id ? `lp1-panel-${t.id}` : undefined}
        tabindex={singleTab === t.id ? 0 : -1}
        class:active={singleTab === t.id}
        onclick={() => (singleTab = t.id)}
        onkeydown={(e) => tabKeydown(e, SINGLE_TABS.map((x) => x.id), singleTab, (id) => (singleTab = id as SingleTab), 'lp1-tab')}
      >{t.label}</button>
    {/each}
  </div>

  <!-- Shared foundation — collapsed so the mode tabs stay the first thing you
       see; everything inside applies to EVERY view. -->
  <details class="shared">
    <summary>Setup — connect the device</summary>
    <ol class="steps">
      <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong> to the canvas.</li>
      <li>Click <strong>Connect single Launchpad</strong> on the card (grants Web-MIDI/sysex on the first
        click). The one device binds — no press-a-pad handshake — and auto-binds the first clip player.</li>
      <li>The device starts in <strong>GRID view</strong>. A reload restores your view; hit
        <strong>Connect single Launchpad</strong> once to re-attach the hardware (browser permission needs a
        click).</li>
    </ol>
  </details>

  <details class="shared">
    <summary>Shared in every view — the permanent top row, SHIFT, the colour language + the automation ARM layer</summary>
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
        when you're not in them, <strong>bright purple</strong> for the one you're in. While
        <strong>KEYS</strong> is open (a sub-view of Clip) the <strong>CLIP</strong> button also lights
        bright; pressing any view button leaves KEYS for that view.</li>
      <li><strong>UNDO / REDO (CC 96 / 97):</strong> launchpad-scoped — they revert only <em>this</em>
        launchpad's persistent clip edits (div, swing, length, paste, note content, scale), never a
        collaborator's edits and never a transient launch. Orange when there's something on the stack, dim
        when empty.</li>
      <li><strong>SHIFT (CC 98):</strong> the alt-layer key (next). Dim yellow off, bright yellow while held,
        solid yellow while latched.</li>
      <li><strong>AUTOMATION ARM — SHIFT + a lane's top button (every view):</strong> while SHIFT is
        held <em>or</em> latched, the top row becomes the <strong>per-lane automation arm map</strong>:
        pressing <strong>column 1–7 toggles that lane's clip-automation record</strong> (red pulse =
        armed, dim red = available), and the press is <strong>consumed</strong> — shift+▶ never touches
        the transport, shift+GRID never switches views, shift+UNDO never undoes.
        <strong>Lane 8's top button IS the shift button</strong>, so lane 8 is a
        <strong>double-tap of SHIFT</strong> (the pair fires on the second tap's <em>release</em> — a
        second press you keep HELD is just the shift modifier, never a lane-8 toggle — and it reverts
        the first tap's latch, so the latch nets back to where it started, from either state). Because
        this lives on the global row,
        <strong>you can arm or disarm any lane from any screen</strong> — and an ARMED lane's top button
        <strong>red-flashes over its normal colour</strong> all the time, in every view, as the
        always-visible record indicator.</li>
    </ul>

    <h4 id="single-arm">The arm layer in pictures</h4>
    <LaunchpadDiagram
      top={permTop('grid', { running: true, shift: 'held', arms: ARMS_LANE3 })}
      callouts={armMapGroups}
      accent={hex(RGB_RECORDING)}
      caption="SHIFT held (or latched) — the top row becomes the PER-LANE ARM MAP, in EVERY view: columns 1–7 are lanes 1–7 (red pulse = armed — lane 3 here; dim red = available; the press toggles the arm and is consumed). Column 8 keeps the SHIFT LED — lane 8 is a DOUBLE-TAP of SHIFT, firing on the second tap's RELEASE (tap-tap only: a second press you keep held is just the modifier), and it red-pulses while lane 8 is armed."
    />
    <LaunchpadDiagram
      top={permTop('grid', { running: true, arms: ARMS_LANE3 })}
      callouts={permTopGroups}
      accent={hex(RGB_RECORDING)}
      caption="Shift released — the compass comes back, but ARMED lane 3's button keeps RED-FLASHING, alternating with its base colour (shown on the red phase), in every view, until the lane is disarmed. A RED-FAMILY base (the stopped transport button) alternates with a DIM red instead, so the blink stays legible."
    />

    <h3 id="single-shift">The shift layer + tap-to-arm — one-handed by design</h3>
    <p>
      Every right-column button has a plain meaning and a <strong>shift</strong> meaning. SHIFT (CC 98) is
      <strong>hybrid</strong>: <strong>tap</strong> it to <em>latch</em> the alt layer (solid yellow — the
      whole right column switches to its shift meaning and stays there), <strong>tap again</strong> to
      unlatch. Or <strong>hold</strong> it for a momentary alt layer (bright yellow). Effective shift =
      <strong>latched OR held</strong>. And because you can't hold a function button <em>and</em> tap a clip
      at once, the Grid's compound functions (Copy · Paste · Clip-Div · Length) are
      <strong>tap-to-ARM</strong>: tap the function → it arms (brightens; only one at a time) → tap a target →
      it applies and auto-disarms. Tap the armed button again to cancel; a stale arm auto-clears after ~4 s.
    </p>
    <h4>Navigation palette (permanent top row)</h4>
    {@render swatches3(NAV_COLORS)}
    <h4>Right-column function taxonomy</h4>
    {@render swatches3(TAXONOMY_COLORS)}
  </details>

  {#if singleTab === 'grid'}
  <div id="lp1-panel-grid" role="tabpanel" tabindex="0" aria-labelledby="lp1-tab-grid">
    <h3>GRID Mode — launch clips</h3>
    <LaunchpadDiagram
      top={permTop('grid', { running: true })}
      pads={gridPads}
      scene={gridRowScene}
      callouts={gridCallouts}
      accent={hex(RGB_SCENE)}
      caption="GRID view (no shift). The 8×8 is the clip matrix, TRANSPOSED to match the on-screen card: each COLUMN is a channel/lane (1–8 left→right), each ROW is a clip slot (top row = slot 1). Clip states paint in each CHANNEL'S OWN colour: dim = loaded · solid = playing · flashing = queued-launch · flashing RED = queued-stop (red is the one semantic exception). Right column = ROW / scene launch (amber where the scene has clips, dark where empty; the top row flashes green — its scene holds the queued clip)."
    />
    <ul class="tight">
      <li><strong>Every channel's clip states glow in that channel's own colour</strong> (the colour you
        picked on the card, else its default hue) — <strong>dim</strong> = loaded, <strong>solid full
        brightness</strong> = playing, <strong>flashing</strong> = queued-launch. Only
        <strong>queued-stop flashes RED</strong> on every channel, so a pending stop always reads. The pad
        matches the card's swatch for the same channel.</li>
      <li><strong>Tap a loaded clip</strong> (dim) to <strong>launch</strong> it — it flashes (queued) until
        the next quantize boundary, then turns solid (playing). Tap the playing clip to
        queue a <strong>stop</strong> (flashes red until the boundary).</li>
      <li><strong>Columns are channels, rows are slots</strong> — the same orientation as the
        ClipplayerCard, so the pad you see lit is the clip you see on screen.</li>
      <li><strong>Row / scene launch (right column):</strong> a grid <strong>row</strong> is one clip per
        channel — an Ableton-style scene / song section. Scene button <em>N</em> fires <strong>that row's
        slot across every channel that has a clip</strong> and <strong>stops</strong> the channels that
        don't. It flashes green while any channel in that row is queued. The column is a
        <strong>scrolling window</strong> over <strong>up to 64 scenes</strong> (slide it with Grid + shift
        <strong>SCR▲ / SCR▼</strong>; an empty scene is dark and its launch is a no-op).</li>
      <li>Empty pads glow dim red while <strong>ARRANGER RECORD</strong> is armed.</li>
    </ul>

    <h4 id="single-select">Single-tap launches · double-tap edits</h4>
    <p>
      A <strong>single tap launches</strong> immediately (never delayed). A <strong>double-tap</strong> of
      the same pad (~¼ s) instead <strong>selects that clip and opens it in CLIP mode</strong> — and it
      reverts the channel to whatever play/queue state it was in before the first tap, so
      <strong>editing never changes whether a clip plays</strong>. Double-tap an <em>empty</em> pad to
      create a fresh clip and edit it. The selected clip is what the <strong>CLIP</strong> and
      <strong>KEYS</strong> buttons act on, and its channel is the one <strong>Swing ±</strong> nudges.
    </p>

    <h4>GRID + shift — the function palette (home of copy/paste)</h4>
    <LaunchpadDiagram
      top={permTop('grid', { running: true, shift: 'latch' })}
      pads={gridPads}
      scene={gridShiftScene}
      callouts={gridCallouts}
      accent={hex(RGB_PATTERN_ARMED)}
      caption="GRID + shift (SHIFT latched, solid yellow). The right column becomes the function palette, top→bottom: COPY · PASTE · CLIP-DIV · SWING+ · SWING− · LENGTH · SCR▲ · SCR▼. Green = pattern, blue = timing, yellow = length, amber = scene-scroll. PASTE shows turquoise here because the clipboard holds a clip. While shift is on, the TOP ROW is the per-lane automation ARM MAP (dim red = available — none armed here)."
    />
    <p class="muted">
      That shift-state top row is the <strong>automation ARM MAP</strong> —
      <a href="#single-arm">see the arm layer in pictures ↑</a> (in the shared foundation above).
    </p>
    <ul class="tight">
      <li><strong>COPY</strong> (green): arm, then tap a loaded clip → snapshot that CLIP to the clipboard,
        OR tap a <strong>ROW / scene-launch</strong> button → snapshot the WHOLE SCENE (all 8 channels at
        that slot). <em>For a scene target, release / unlatch SHIFT first so the column shows the ROW ▶
        buttons again — while shift is on, that column is still this function palette (clip-pad targets
        work under either shift state).</em> The clipboard is <strong>typed</strong>: a clip buffer pulses
        turquoise, a scene buffer pulses amber. Re-tap COPY while loaded to clear it. (Copy is a snapshot —
        edit after copying? re-copy.)</li>
      <li><strong>PASTE</strong> (green; only arms when the clipboard holds something): arm, then tap a
        <strong>clip pad</strong> to drop a clip buffer there, or a <strong>ROW / scene-launch</strong>
        button (again with SHIFT released / unlatched) to full-REPLACE that whole scene from a scene
        buffer. The paste is
        <strong>type-gated</strong> — clip→clip and scene→scene apply; clip→scene and scene→clip are no-ops
        (nothing is written). A scene paste is a single undo step. Copy/paste carries each clip's
        <strong>recorded automation</strong> with it (the envelope belongs to the clip): the destination's
        old automation is replaced — or cleared when the source clip had none.
        <em>This Grid palette is the ONLY copy/paste on the Launchpad — clips and scenes, right here; the
        note editor deliberately has none. (PASTE-REV, the time-reversed clip paste, is a pair-deck hold —
        see 2 Launchpads; it pastes the automation time-reversed to match.)</em></li>
      <li><strong>CLIP-DIV</strong> (blue): the per-clip divider. Arm, then <strong>tap a clip
        repeatedly</strong> to cycle its own clock division (1/8 · 1/4 · 1/2 · 1 · 2x · 4x). While you
        cycle, the target clip pad itself pulses in time with the chosen division. It writes once when you
        disarm, applied at the clip's next loop start. A clip's own div overrides its channel's
        CONTROL-mode RATE.</li>
      <li><strong>SWING+ / SWING−</strong> (blue): direct ±2 % nudges (one per press) to the
        <strong>selected channel's</strong> swing — odd steps slide late for a shuffle. The buttons ramp
        <span style:color={hex(RGB_SWING_UP)}>purple</span> while you raise and
        <span style:color={hex(RGB_SWING_DOWN)}>blue</span> while you lower, and both
        <strong>flash green</strong> on the nudge that returns swing to dead-centre (straight).</li>
      <li><strong>LENGTH</strong> (yellow): arm, tap a loaded clip → its length page opens (a full-device
        takeover, detailed below; EXIT returns to Grid).</li>
      <li><strong>SCR▲ / SCR▼</strong> (amber): slide the scene-launch window UP (toward scene 1) / DOWN
        (up to 64 scenes; DOWN lazily reveals one empty scene past your deepest clip; each button dims at
        its scroll limit). Direct — no arming.</li>
    </ul>

    <h4 id="single-scene-repeats">Scene repeats — HOLD GRID + HOLD a scene button</h4>
    <p>
      Scenes <strong>loop forever by default</strong> (repeats = infinite). To make a scene play
      <strong>N times and then auto-launch the next scene down</strong> (skipping empty rows; the last
      content scene keeps looping), set its repeat count with a <strong>3-button, two-hands
      gesture</strong>: <strong>HOLD the GRID button</strong> (permanent top row) <strong>+ HOLD one of
      the 8 scene-launch buttons</strong>. The scene press under GRID-hold <strong>selects only — it
      never launches</strong>.
    </p>
    <LaunchpadDiagram
      top={permTop('grid', { running: true })}
      pads={repeatPads}
      scene={repeatScene}
      accent={hex(RGB_SCENE)}
      caption="REPEAT-COUNT view while HOLDING GRID + HOLDING the top scene button — shown: 16 repeats, so pads 1–16 (the top two rows) glow system orange, counted row-major from the upper-left. ALL 64 pads lit = INFINITE (the default). The held scene button stays bright amber. Releasing either held button returns to the normal grid."
    />
    <ul class="tight">
      <li>While both buttons are held, <strong>tap pad k</strong> (1-indexed row-major: upper-left = 1,
        second in the top row = 2, …) to set <strong>k repeats</strong> (1–63);
        <strong>pad 64</strong> (bottom-right) sets it back to <strong>INFINITE</strong>. The bar
        updates live as you tap, and always shows pads 1..N lit for count N.</li>
      <li><strong>Scroll-aware:</strong> the held scene button is <strong>position-relative</strong>
        through the scene window — with the column scrolled (SCR▲/▼), button <em>i</em> edits scene
        <em>offset + i</em>, the same scene it would launch.</li>
      <li>After N passes of the scene's <strong>longest clip</strong> (its length × rate/div,
        <strong>frozen at launch</strong> — mid-count edits never move the scheduled boundaries), the
        next content scene down launches through the <strong>normal quantized launch path</strong> —
        arranger-record captures it, LEDs update, peers stay in sync.</li>
      <li><strong>Manual always wins:</strong> launching any scene mid-count re-anchors the count fresh
        (re-launching the SAME scene resets it to zero); launching an individual clip outside the scene
        cancels the countdown until the next scene launch. <strong>Muting</strong> lanes never voids or
        alters the count; stopping <em>every</em> scene lane cancels it.</li>
      <li>The count is saved with the patch and shows on the card as a small <strong>×N</strong> flair
        beside the scene's row (live <strong>p/N</strong> while counting; infinite shows nothing).</li>
      <li><strong>Counts travel with the scene:</strong> a whole-scene <strong>COPY/PASTE</strong>
        carries the repeat count along with the clips and their automation — a full-replace paste sets
        the target scene's count from the copied one (and clears it when the copied scene had none).</li>
      <li>No collision with the automation arm: that gesture is <strong>SHIFT</strong> + a top-row
        button — this one is a GRID hold <strong>without</strong> shift.</li>
    </ul>

    {@render lengthEditSection()}
    <h4>Clip-state colours (in the channel's own colour)</h4>
    {@render stateSwatches(SINGLE_GRID_COLORS)}
    <h4>Reference</h4>
    {@render mapTable([...SINGLE_MAP_GLOBAL, ...SINGLE_MAP_GRID])}
  </div>
  {:else if singleTab === 'clip'}
  <div id="lp1-panel-clip" role="tabpanel" tabindex="0" aria-labelledby="lp1-tab-clip">
    <h3>CLIP Mode — the note editor</h3>
    <p>
      CLIP edits the <strong>selected clip</strong> (set by a Grid double-tap, or press the
      <strong>CLIP</strong> top-row button to open the current selection). X = step (an 8-step window =
      half a 16-step block), Y = pitch (in-key rows, bottom = lowest). The right column is CLIP's own
      controls. <em>There is no copy/paste here — that lives on the Grid page.</em>
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
        bright green while following) auto-scrolls the window with the playhead; a manual step scroll
        freezes it — tap FOLLOW to resume.</li>
      <li><strong>KEYS</strong> (bright orange) drops the device into the KEYS keyboard for this clip
        (below).</li>
      <li><strong>ROW+ / ROW−</strong> (green) scroll the pitch window ±1 row; <strong>STEP◀ /
        STEP▶</strong> (blue) scroll the 8-step window ±1 step.</li>
    </ul>
    <h4>CLIP + shift — velocity + big jumps</h4>
    <LaunchpadDiagram
      top={permTop('clip', { running: true, shift: 'latch' })}
      pads={clipVelWashPads}
      scene={clipShiftScene}
      callouts={editCallouts}
      accent={hex(RGB_TIMING_ARMED)}
      caption="CLIP + shift. The 8×8 becomes VELOCITY-cycle (a faint purple wash over empty cells) — tap a note to cycle its velocity. ROW± brighten (they now jump a full page — 8 rows) and STEP± brighten (they jump a full block). DOUBLE / LENGTH / FOLLOW / KEYS are unchanged. The TOP ROW is the automation ARM MAP while shift is on (dim red = available)."
    />
    <ul class="tight">
      <li><strong>Velocity:</strong> under shift, tapping a note <strong>cycles its velocity</strong>
        instead of toggling it.</li>
      <li><strong>Big jumps:</strong> under shift <strong>ROW±</strong> jump the pitch window a full page
        (8 rows — the pair editor's OC± buttons are the true-octave jump) and <strong>STEP±</strong> jump a
        full 8-step block.</li>
      <li>The clip's <strong>scale</strong> is set in KEYS (there's no separate scale button here).</li>
    </ul>

    <h3 id="single-keys">KEYS — play, CLIP-RECORD notes + arpeggiate</h3>
    <p>
      <strong>KEYS</strong> turns the device into a playable <strong>isomorphic keyboard</strong>
      (LinnStrument-style, chromatic fourths) routed live to the selected clip's channel, <em>and</em> the
      <strong>CLIP RECORD</strong> surface for notes, <em>and</em> an <strong>arpeggiator</strong>. Enter
      it from <strong>CLIP → KEYS</strong> (bright orange, right column). The clip plays under you while
      the keyboard is live; recording is idle until you tap QUEUE-REC.
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
        one glows bright green. The scale <em>lights</em> the keyboard (root cyan, in-scale green) but does
        <strong>not</strong> snap what you play — the pads stay fully chromatic.</li>
      <li><strong>CLIP RECORD a loop:</strong> tap <strong>QUEUE-REC</strong> to arm (flashes yellow);
        recording begins when the playhead wraps to step 1 (the transport auto-starts) and the cell turns
        red. <strong>OVERDUB off</strong> = true-replace (each step is cleared as the playhead crosses it);
        <strong>OVERDUB on</strong> = additive layering until you toggle it off. Entering from CLIP → KEYS
        always starts overdub OFF. <em>QUEUE-REC won't arm while ARRANGER RECORD is armed or during
        ARRANGEMENT playback — disarm ● / return to SESSION first.</em></li>
      <li><strong>OCT− / OCT+</strong> shift the whole keyboard an octave; <strong>PANIC</strong> kills
        every sounding note; <strong>LEN</strong> opens the length page (EXIT returns straight to
        KEYS).</li>
      <li><strong>Getting out:</strong> <strong>EXIT</strong> while recording stops the take (you stay in
        KEYS); EXIT again returns to the views. A <strong>view button</strong> also leaves KEYS at any
        time.</li>
      <li><strong>ARP on/off</strong> (bottom of the right column, orange) turns the arpeggiator on — then
        hold SHIFT for its controls (next).</li>
    </ul>
    <h4>KEYS + shift — the arpeggiator</h4>
    <LaunchpadDiagram
      top={permTop('clip', { running: true, keys: true, shift: 'held' })}
      pads={keysSinglePads}
      scene={keysArpScene}
      callouts={keysSingleCallouts}
      accent={hex(RGB_TIMING)}
      caption="KEYS + shift (SHIFT held, bright yellow) — the arp control column, top→bottom: DIV+ · DIV− (blue) · UP · DOWN · UP-AND-DOWN (green; UP selected, bright) · RANGE+ · RANGE− (orange) · LATCH (dim orange = off). The keyboard + playhead stay live; the notes you hold feed the arp. As everywhere, the top row is the automation ARM MAP while shift is active."
    />
    <ul class="tight">
      <li><strong>Turn it on</strong> (ARP button, no-shift) and hold a chord — the arp sequences your held
        notes through the SAME channel output as the keyboard, at the transport's tempo (tempo-matched but
        free-running: it isn't phase-locked to the clock and keeps stepping while the transport is
        stopped).</li>
      <li><strong>DIV+ / DIV−</strong> set the rate: <strong>8x · 4x · 2x · 1x</strong> (default)
        <strong>· 1/2 · 1/4 · 1/8</strong> of the clock. DIV+ is faster.</li>
      <li><strong>UP · DOWN · UP-AND-DOWN</strong> set the direction (the selected one glows bright green).
        Up-and-down is an exclusive pendulum — each extreme is played once (C-E-G-E-C…), so 2–3 note
        chords don't stutter.</li>
      <li><strong>RANGE+ / RANGE−</strong> widen the octave span: <strong>1 oct</strong> (default)
        <strong>· +1..−1 · +2..−2</strong> (symmetric around the held notes).</li>
      <li><strong>LATCH</strong> (orange): hold the note set after you release the keys. A fresh press
        after a full release replaces the set; pressing while a key is still down adds to it.</li>
    </ul>

    {@render lengthEditSection()}
    <h4>Editor colours</h4>
    {@render swatches3(EDITOR_COLORS)}
    <h4>KEYS colours</h4>
    {@render swatches3(KEYS_COLORS)}
    <h4>Reference</h4>
    {@render mapTable([...SINGLE_MAP_GLOBAL, ...SINGLE_MAP_CLIP])}
  </div>
  {:else if singleTab === 'arranger'}
  <div id="lp1-panel-arranger" role="tabpanel" tabindex="0" aria-labelledby="lp1-tab-arranger">
    <h3>ARRANGER Mode — experimental / TBD</h3>
    <p class="tbd-banner">
      <strong>TBD.</strong> The arrangement <em>engine</em> (ARRANGER RECORD — record + replay your live
      clip launches as a song) already exists, but this view has no launchpad UI yet: it's a lit-but-inert
      placeholder. Everything below works <em>today</em> from Control Mode and the card.
    </p>
    <LaunchpadDiagram
      top={permTop('arranger')}
      pads={arrangerPads}
      accent={hex(RGB_VIEW_ACTIVE)}
      caption="ARRANGER view is an inert placeholder for now: a faint dim 8×8 and a dark right column, with the ARRANGER nav button lit bright purple. No pad or scene handlers are wired to it yet."
    />
    <h4>Where ARRANGER RECORD actually lives</h4>
    <ul class="tight">
      <li><strong>On this Launchpad:</strong> <strong>Control Mode</strong> hosts the two arranger
        controls — <strong>REC</strong> (the ARRANGER RECORD arm, first pad on the second grid row; it
        pulses red while recording) and <strong>SONG</strong> (SESSION ⇄ ARRANGEMENT playback) right
        beside it. Flip to the <em>Control Mode</em> tab for the full picture.</li>
      <li><strong>On the card:</strong> the red <strong>●</strong> in the ARRANGER cluster (with the
        RPL/OVR replace-vs-overdub pill and the SES/ARR mode button, plus the full-window
        <strong>ARR ⤢</strong> editor).</li>
      <li><strong>With two Launchpads:</strong> the pair deck's top-left <strong>REC</strong> button
        (CC 91) — see the <em>2 Launchpads → Deck</em> tab.</li>
    </ul>
    <p class="muted">
      Remember the split: ARRANGER RECORD captures <strong>launches</strong> (which clips fire, when).
      Recording <strong>into</strong> a clip — notes or knob moves — is <strong>CLIP RECORD</strong>
      (KEYS QUEUE-REC · the per-lane automation arm — SHIFT+top-row / the card's per-lane ◉).
    </p>
    <h4>Reference</h4>
    {@render mapTable([...SINGLE_MAP_GLOBAL, ...SINGLE_MAP_ARRANGER])}
  </div>
  {:else if singleTab === 'control'}
  <div id="lp1-panel-control" role="tabpanel" tabindex="0" aria-labelledby="lp1-tab-control">
    <h3>CONTROL Mode — the performance deck</h3>
    <LaunchpadDiagram
      top={permTop('control', { running: true })}
      pads={controlPads}
      scene={controlScene}
      callouts={controlCallouts}
      accent={hex(RGB_RESET)}
      caption="CONTROL view. RESET (row 1 col 2, steel blue) · MONO row (teal) · MUTE row (orange when muted) · RATE row (a cool→warm ramp; shown all-default '1') — one pad per channel. Right column = per-lane STOP (bright red = that channel is audible). Re-homed onto the dark top grid rows: TEMPO− · TEMPO+ · STOP-ALL, and REC · SONG one row below. (Automation arm is SHIFT + a lane's top-row button — every view.)"
    />
    <ul class="tight">
      <li><strong>RESET (RST, steel blue):</strong> snap every playing channel back to step 1 at one shared
        instant. Same field as the card's RST button and the reset gate. Reset ≠ stop: clips keep playing,
        just re-aligned.</li>
      <li><strong>MONO row (teal):</strong> toggle a channel between MONO (one note per column) and POLY.
        <strong>MUTE row (orange):</strong> mute a channel <em>in place</em> — it keeps advancing its
        playhead but goes silent, so it drops out and snaps back on the beat (different from per-lane STOP,
        which halts the channel).</li>
      <li><strong>RATE row:</strong> tap to cycle a channel's clock division up through <strong>1/8 · 1/4 ·
        1/2 · 1 · 2x · 4x</strong> (wrapping; green = the default '1'). A clip's own Grid-shift CLIP-DIV
        overrides this per clip.</li>
      <li><strong>Per-lane STOP (right column):</strong> stop one channel (bright red = audible now).</li>
      <li><strong>TEMPO− / TEMPO+ / STOP-ALL</strong> (top grid row): nudge the rack tempo ±2 bpm; queue a
        stop on every channel.</li>
      <li><strong>REC + SONG = ARRANGER RECORD:</strong> <strong>REC</strong> arms ARRANGER RECORD (it
        records your live clip <em>launches</em> — not notes, not knobs; the pad pulses red while
        recording), and <strong>SONG</strong> flips SESSION ⇄ ARRANGEMENT to replay the recorded song.
        Same synced state as the card's <strong>●</strong> and SES/ARR buttons.</li>
      <li><strong>Automation CLIP RECORD = SHIFT + the lane's top-row button</strong> (not a grid pad —
        it works from every view, including this one; lane 8 = double-tap SHIFT). Assign modules first
        (right-click a <em>module's card</em> → <em>Assign to automation lane</em> 1–8 — the whole
        module joins the lane, its card gets a border in the lane's colour); while a lane is
        <strong>armed</strong> (its top-row button red-flashes; same toggle as the card's per-lane
        <strong>◉</strong>) and its clip <em>plays</em>, every control you TOUCH on an assigned module —
        screen, MIDI, Electra; <strong>never CV</strong> — records by continuous overdub, punching in at
        <em>that clip's</em> next loop start, into that clip's OWN automation (each clip in a lane
        carries its own envelopes; copy/paste and scene-duplicate carry them with the clip). The
        recording clip's grid cell shows the 🟡🟡🔴🔴 pre-roll countdown before its wrap. Touching an
        unassigned module's control records nothing. SHIFT+the button again stops that lane; other
        armed lanes keep recording — and different collaborators can record different lanes at once.
        Deleting is card-side and explicit: right-click a control → <em>Clear recorded automation</em>,
        or the editor's CLR AUTO (per clip) — the module menu's <em>Remove automation assignment</em>
        only stops future recording. Longer-form automation across a song is the (future) arranger
        mode's job.</li>
    </ul>
    <h4>Control-mode colours</h4>
    {@render swatches3(SINGLE_CONTROL_COLORS)}
    <h4>Reference</h4>
    {@render mapTable([...SINGLE_MAP_GLOBAL, ...SINGLE_MAP_CONTROL])}
  </div>
  {:else if singleTab === 'walkthrough'}
  <div id="lp1-panel-walkthrough" role="tabpanel" tabindex="0" aria-labelledby="lp1-tab-walkthrough">
    <h3>Make a patch in 1-pad mode</h3>
    <p>
      Never touched the device? This is the whole journey on <strong>one Launchpad</strong> — plug in, wire
      three voices, clip-record a bassline in KEYS, lay clips in GRID, build scenes, perform, and record
      knob automation into a clip. By the end
      you'll have a live three-voice patch: <strong>kick</strong>, <strong>snare</strong> and a poly
      <strong>TIDY VCO</strong> bassline.
    </p>

    <h4>1 · Plug in + connect</h4>
    <ol class="steps">
      <li>Plug the <strong>Launchpad Mini Mk3</strong> into a USB port.</li>
      <li>On the canvas, drop a <strong>launchpad control</strong> and a <strong>clip player</strong> (in
        workflow mode, add them from the module drawer — the clip player is the brain the pad drives).</li>
      <li>Click <strong>Connect single Launchpad</strong> on the launchpad card and accept the browser's
        Web-MIDI prompt (first click only). The pad lights up in <strong>GRID view</strong> and auto-binds
        the clip player.</li>
    </ol>

    <h4>2 · Wire three voices</h4>
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
        <strong>CONTROL mode</strong> its <strong>MONO</strong> pad (row 2, third column) should be
        <em>dim</em> — dim = poly, teal = mono.</li>
      <li>Run each voice to your output. See the signal-flow picture at the bottom of this tab.</li>
    </ul>

    <h4>3 · Clip-record a bassline into channel 3 (KEYS)</h4>
    <LaunchpadDiagram
      top={permTop('clip', { running: true, keys: true })}
      pads={keysSinglePads}
      scene={keysScaleScene}
      callouts={keysSingleCallouts}
      accent={hex(RGB_PATTERN_ARMED)}
      caption="STEP 3 — KEYS on channel 3. Right column = scale select (MAJOR selected). Play the keyboard rows; QUEUE-REC clip-records a loop; ARP (bottom orange) + SHIFT open the arp column if you want it."
    />
    <ol class="steps">
      <li>In <strong>GRID</strong>, <strong>double-tap</strong> the <strong>channel-3, slot-1 pad</strong>
        (third column, top row) → the clip opens in <strong>CLIP mode</strong> (an empty pad makes a fresh
        clip).</li>
      <li>Press <strong>KEYS</strong> (right column, 4th from the top, bright orange) → the device becomes
        the keyboard for that clip; the transport starts and the clip plays.</li>
      <li><strong>Pick a scale:</strong> tap a scale in the right column — e.g. <strong>MINOR</strong>. The
        selected scale glows bright green and lights the in-key rows.</li>
      <li><strong>(Optional) arpeggiate:</strong> tap <strong>ARP</strong> (bottom of the right column),
        then <strong>hold SHIFT</strong> and set <strong>direction</strong>, <strong>DIV</strong> and
        <strong>RANGE</strong>. Hold a chord and it sequences itself; tap <strong>LATCH</strong> to keep it
        running hands-free.</li>
      <li><strong>CLIP RECORD:</strong> tap <strong>QUEUE-REC</strong> (bottom row, 2nd pad) — it flashes
        yellow, then turns red at the loop top. Play your bassline (use <strong>OCT−</strong> for a deeper
        register). Leave <strong>OVERDUB</strong> off for a clean replace, or toggle it on to layer.</li>
      <li><strong>Stop:</strong> tap <strong>EXIT</strong> (bottom-left) to end the take (you stay in
        KEYS), then a <strong>view button</strong> (GRID) to leave KEYS.</li>
    </ol>

    <h4>4 · Lay clips on channels 1 + 2 (GRID)</h4>
    <LaunchpadDiagram
      top={permTop('grid', { running: true })}
      pads={gridPads}
      scene={gridRowScene}
      callouts={gridCallouts}
      accent={hex(RGB_SCENE)}
      caption="STEP 4 — GRID with clips laid in. Columns = channels, rows = slots; each channel's clips glow in its own colour (dim = loaded, solid = playing, flashing = queued). Right column = ROW / scene launch."
    />
    <ol class="steps">
      <li><strong>Kick clip:</strong> in GRID, double-tap <strong>channel-1, slot-1</strong> (top-left pad)
        → CLIP → <strong>KEYS</strong> → QUEUE-REC → tap out a four-on-the-floor on the low rows → EXIT →
        GRID.</li>
      <li><strong>Snare clip:</strong> double-tap <strong>channel-2, slot-1</strong> → CLIP → KEYS →
        QUEUE-REC → play the backbeat → EXIT → GRID.</li>
      <li><strong>Variations (slots 2–3):</strong> for a fast copy, latch <strong>SHIFT</strong>, tap
        <strong>COPY</strong> (right column, top), tap a source clip, tap <strong>PASTE</strong>, then tap
        the empty slot below it — now tweak. Repeat so each channel has 2–3 slots.</li>
      <li>Tapping any loaded pad <strong>launches just that clip</strong>; you'll launch whole rows
        next.</li>
    </ol>

    <h4>5 · Build scenes with the row-launch column</h4>
    <p>
      A grid <strong>row</strong> is a <strong>scene</strong> — one clip per channel firing together. Slot 1
      (top row) is your main groove; slot 2 a breakdown; slot 3 a fill.
    </p>
    <ol class="steps">
      <li>Press the <strong>top scene button</strong> (right column, top) → the slot-1 clip in every channel
        launches together (kick + snare + bass) on the next boundary.</li>
      <li>Press the <strong>second scene button</strong> → every channel switches to its slot-2 clip at once
        — a one-press section change. Channels with no clip in that slot stop.</li>
      <li>That's your arrangement: each row is a section, and one button moves the whole band between
        them.</li>
      <li><strong>Let it run itself — scene repeats:</strong> <strong>HOLD GRID + HOLD a scene
        button</strong> → the 8×8 becomes an orange count bar; <strong>tap pad 4</strong> to make that
        scene play <strong>4 times</strong> then auto-launch the next scene down (pad 64 = back to
        infinite; release either button to return). Set counts on your sections and the song walks
        itself down the rows — any manual launch takes over instantly.</li>
    </ol>

    <h4>6 · Perform</h4>
    <LaunchpadDiagram
      top={permTop('control', { running: true })}
      pads={controlPads}
      scene={controlScene}
      callouts={controlCallouts}
      accent={hex(RGB_RESET)}
      caption="STEP 6 — CONTROL mode. RESET · MONO row · MUTE row · RATE row (one pad per channel), per-lane STOP on the right, TEMPO± / STOP-ALL / REC · SONG re-homed on the top grid rows. The full tour is in the Control Mode tab."
    />
    <ol class="steps">
      <li><strong>Mute the kick for a breakdown:</strong> press <strong>CONTROL</strong> (top row), tap
        <strong>channel 1's MUTE pad</strong> (row 3, first column) — the kick goes silent in place (its
        playhead keeps running, so it snaps back on beat). Tap again to bring it back.</li>
      <li><strong>Half-time the bass:</strong> on the <strong>RATE row</strong> (row 4), tap <strong>channel
        3's pad</strong> until it reads <strong>1/2</strong>.</li>
      <li><strong>Add a shuffle:</strong> back in GRID, latch <strong>SHIFT</strong> and tap
        <strong>SWING+</strong> a few times (it ramps purple); the button flashes green when you return to
        straight.</li>
      <li><strong>Reshape a clip's feel:</strong> in GRID + shift, arm <strong>CLIP-DIV</strong> and tap a
        clip to cycle its own division — the pad pulses at the new rate; disarm to commit.</li>
      <li><strong>Undo a mistake:</strong> tap <strong>UNDO</strong> (top row) to revert your last
        persistent edit; <strong>REDO</strong> to reapply.</li>
      <li><strong>Ride the tempo / drop everything:</strong> in CONTROL, nudge <strong>TEMPO+ / −</strong>,
        or hit <strong>STOP-ALL</strong>; the <strong>transport</strong> button (top row, CC 91) starts /
        stops the clock.</li>
    </ol>

    <h4>7 · Record knob automation (CLIP RECORD)</h4>
    <ol class="steps">
      <li><strong>Assign the module:</strong> right-click the <strong>TIDY VCO's card</strong> →
        <em>Assign to automation lane</em> → <strong>lane 3</strong> (the bass channel). The whole module
        joins the lane and its card gets a thin border in lane 3's colour.</li>
      <li><strong>Arm lane 3:</strong> hold <strong>SHIFT</strong> and press the <strong>3rd top-row
        button</strong> — from any view (lane 8 would be a <em>double-tap</em> of SHIFT). The button
        red-flashes: same arm as the card's per-lane <strong>◉</strong>.</li>
      <li><strong>Play + twist:</strong> with the bass clip playing, move any TIDY VCO control — every
        touch (screen drag, MIDI CC, Electra; <strong>never CV</strong>) records into <em>that playing
        clip's own</em> automation, punching in at the clip's <strong>next loop start</strong> (a
        🟡🟡🔴🔴 countdown flashes the clip's pad before each wrap), then overdubbing every loop.
        Release the control and it replays your move every loop.</li>
      <li><strong>Disarm:</strong> SHIFT + the same button. Made a mess? Right-click the control →
        <em>Clear recorded automation</em>, or <strong>CLR AUTO</strong> in the clip editor — both
        undoable. Copy/paste — single clips or whole scenes — carries each clip's automation with it
        (and launching a clip always plays its own envelopes); long-form, song-length automation is
        the (future) ARRANGER mode's job.</li>
    </ol>
    <p class="muted">
      Every control you touched — the four views, the shift layer, KEYS + arp, MUTE / RATE / RESET / SWING /
      CLIP-DIV, and launchpad-scoped undo — lives on <strong>one</strong> device, one hand at a time.
    </p>
    {@render signalFlow()}
  </div>
  {/if}
</div>
{:else}
<div class="mode-section pair" id="lp-panel-pair" role="tabpanel" tabindex="0" aria-labelledby="lp-tab-pair">
  <h2 class="mode-title">2 Launchpads — matrix + command deck</h2>
  <p>
    With a pair, the <strong>LEFT</strong> unit is <strong>permanently the 8×8 clip matrix</strong> — it
    never flips away, so your performance surface is always visible — and the <strong>RIGHT</strong> unit is
    the <strong>command deck</strong>, which becomes the <strong>note editor</strong> or the
    <strong>length page</strong> while you edit. <strong>KEYS</strong> takes over both units. Every deck
    function is a held or tapped button on R acting on clips you tap on L.
  </p>

  <h3>Setup — pairing</h3>
  <ol class="steps">
    <li>Add a <strong>launchpad control</strong> and a <strong>clip player</strong> to the canvas.</li>
    <li>Click <strong>Pair Launchpads</strong> (grants Web-MIDI/sysex on first click).
      <strong>Both units flood with colour</strong> — one green, one blue.</li>
    <li><strong>Press any pad on the unit you want as LEFT</strong> (the matrix). The other becomes RIGHT.
      Pairing auto-binds the first clip player.</li>
    <li>Two identical units are told apart automatically by port order — if L/R come out swapped, just
      <strong>Re-pair</strong> and press the other unit.</li>
  </ol>

  <div class="tabs sub-tabs" role="tablist" aria-label="Two-Launchpad surfaces">
    {#each PAIR_TABS as t (t.id)}
      <button
        type="button"
        role="tab"
        id={`lp2-tab-${t.id}`}
        aria-selected={pairTab === t.id}
        aria-controls={pairTab === t.id ? `lp2-panel-${t.id}` : undefined}
        tabindex={pairTab === t.id ? 0 : -1}
        class:active={pairTab === t.id}
        onclick={() => (pairTab = t.id)}
        onkeydown={(e) => tabKeydown(e, PAIR_TABS.map((x) => x.id), pairTab, (id) => (pairTab = id as PairTab), 'lp2-tab')}
      >{t.label}</button>
    {/each}
  </div>

  {#if pairTab === 'matrix'}
  <div id="lp2-panel-matrix" role="tabpanel" tabindex="0" aria-labelledby="lp2-tab-matrix">
    <h3>Unit L — the clip matrix (always live)</h3>
    <LaunchpadDiagram
      top={matrixMuteTop}
      pads={matrixPads}
      scene={matrixScene}
      callouts={matrixMuteCallouts}
      accent={hex(RGB_MUTE_ON)}
      caption="PAIR · UNIT L. Rows = the 8 instrument lanes (top→bottom, matching the on-screen card — lane 1 is the top row), columns = the 8 clip slots. Tap a clip to launch it / stop its lane (next quantize boundary; hold NOW on R — a Deck hold, see the Deck tab — to fire instantly). Right column = scene launch (amber). TOP ROW = the 8 per-lane MUTE pads (numbered 1–8; orange = muted, dim = live)."
    />
    <ul class="tight">
      <li><strong>Tap a loaded clip</strong> (dim blue) to <strong>launch</strong> — flashing green =
        queued for the boundary, solid green = playing. Tap the playing clip to queue a
        <strong>stop</strong> (flashes red).</li>
      <li>Pad <code>(slot, lane)</code> is clip <code>lane*64 + slot</code> (a fixed stride-64 flat clip
        key, independent of the 8 visible slots); <strong>lane 1 = the TOP physical row</strong>, matching
        the card.</li>
      <li><strong>Scene launch (right column):</strong> scene button <em>N</em> fires <strong>slot N in
        every lane that has a clip</strong> and <strong>stops</strong> the lanes that don't — a one-press
        section switch. Same quantize rules; hold <strong>NOW</strong> on R (a Deck hold — see the
        <em>Deck</em> tab) to fire instantly.</li>
      <li>Empty pads glow <strong>dim red</strong> while <strong>ARRANGER RECORD</strong> is armed — armed
        from the Deck's <strong>REC</strong> button (CC 91; see the <em>Deck</em> tab).</li>
      <li><strong>TOP ROW = per-lane MUTE:</strong> tap CC <em>N</em> to mute/un-mute lane <em>N</em> right
        on the always-visible matrix. A muted lane keeps running its playhead but goes silent; orange =
        muted, dim = live. This is <em>mute in place</em>, distinct from the R deck's per-lane STOP.</li>
      <li>The matrix <strong>stays live while you edit</strong> — editing happens on Unit R.</li>
    </ul>
    <h4>Clip-state colours</h4>
    {@render stateSwatches(SESSION_COLORS)}
    <h4>Reference</h4>
    {@render mapTable(PAIR_MAP_MATRIX)}
  </div>
  {:else if pairTab === 'deck'}
  <div id="lp2-panel-deck" role="tabpanel" tabindex="0" aria-labelledby="lp2-tab-deck">
    <h3>Unit R — the command deck</h3>
    <LaunchpadDiagram
      pads={deckPads}
      top={pairDeckTop}
      scene={deckScene}
      callouts={deckCallouts}
      caption="PAIR · UNIT R (session deck). Row 0 = function pads: EDIT (orange), COPY/PASTE/P-REV (green), BUF (dark until you copy), DBL + NOW (purple), LEN (yellow). Row 1 = KEYS-entry holds K● / KO + RST (steel blue). Rows 2/3/4 = per-lane MONO (teal) / MUTE (orange) / RATE (rate ramp). Right column = per-lane STOP. Top row: REC (arranger record) · SONG · T− · T+ · PLAY · ALL."
    />
    <ul class="tight">
      <li><strong>EDIT (hold) + tap a clip on L</strong> → open its note editor on R (an empty pad gets a
        fresh clip). The tap doesn't launch.</li>
      <li><strong>COPY / PASTE / PASTE-REV (hold) + tap a clip on L</strong> → copy / paste /
        paste-reversed. Copy takes a <strong>snapshot</strong>; the <strong>BUF</strong> pad pulses
        turquoise while the clipboard holds a clip — <strong>tap BUF to clear it</strong>. These act on the
        <em>matrix</em> (the grid) — the note editor has no copy/paste of its own.</li>
      <li><strong>DOUBLE</strong> duplicates the pattern + doubles the length (cap 128).
        <strong>LENGTH</strong> opens the 2-row length page on R. <strong>NOW (hold)</strong> makes
        launches ignore quantize.</li>
      <li><strong>Per-lane STOP (right column):</strong> row <em>N</em> stops lane <em>N</em> (bright red =
        audible now). <strong>PLAY (CC 96)</strong> toggles the transport; <strong>ALL (CC 97)</strong>
        queues a stop on every lane.</li>
      <li><strong>K● / KO (row 1):</strong> the KEYS-entry holds — see the <em>Keys</em> tab.</li>
    </ul>
    <h4>Performance controls on the R deck</h4>
    <ul class="tight">
      <li><strong>RST (row 1, col 2):</strong> snap every playing lane back to step 1 — a shared re-sync
        (the card RST / reset-gate field).</li>
      <li><strong>MONO row (row 2):</strong> per-lane MONO ⇄ POLY (teal = mono).</li>
      <li><strong>MUTE row (row 3):</strong> per-lane mute-in-place (orange = muted) — mirrors Unit L's top
        row (either surface toggles the same lane).</li>
      <li><strong>RATE row (row 4):</strong> tap to cycle a lane's clock division 1/8…4x (colour ramps with
        the rate; green = the default ‘1’).</li>
      <li><strong>T− / T+ (CC 93 / 94):</strong> nudge the transport tempo ±2 bpm per tap.</li>
    </ul>

    <h4>ARRANGER RECORD — record a song</h4>
    <p class="muted">
      ARRANGER RECORD captures your <strong>live clip-launch performance</strong> — which clips you fire,
      in which lanes, exactly when — and plays it back as a song. It records <em>launches</em>, not notes
      or knob moves (that's CLIP RECORD), so the clips stay fully editable. Identical to the card's red
      <strong>●</strong> + <strong>SES/ARR</strong> buttons (both write the same synced state).
    </p>
    <ol class="steps">
      <li>Be in <strong>SESSION</strong> (SONG / CC 92 dim white) with the <strong>transport
        running</strong> (PLAY / CC 96) so song-time advances.</li>
      <li>Press <strong>REC</strong> (CC 91, top-left of the R deck) — it pulses red. In the default
        <strong>REPLACE</strong> mode arming clears the previous take and restarts at bar 1; switch the
        RPL/OVR pill on the card for overdub-merge.</li>
      <li><strong>Perform on L</strong> — every launch/stop/scene is captured exactly when it applies
        (quantized launches on the boundary; NOW launches instantly).</li>
      <li>Press <strong>REC</strong> again to disarm. Press <strong>SONG</strong> (CC 92) to switch to
        <strong>ARRANGEMENT</strong> (bright white) — playback runs your recorded launches from the top,
        looping. <strong>SONG</strong> again returns to live SESSION play.</li>
    </ol>
    <h4>Deck-function colours</h4>
    {@render swatches3(DECK_COLORS)}
    <h4>Reference</h4>
    {@render mapTable(PAIR_MAP_DECK)}
  </div>
  {:else if pairTab === 'editor'}
  <div id="lp2-panel-editor" role="tabpanel" tabindex="0" aria-labelledby="lp2-tab-editor">
    <h3>Unit R — the note editor</h3>
    <LaunchpadDiagram
      pads={editorPads}
      top={pairEditTopFollowing}
      scene={pairEditScene}
      callouts={editCallouts}
      caption="PAIR · UNIT R flips here while editing, FOLLOW ON. X = step (an 8-step window = half a 16-step block), Y = pitch (in-key, bottom = lowest). The amber column is the playhead. FOL (CC 98) is green while the window auto-scrolls with the playhead. Right column, top→bottom: EXIT · DBL · LEN · (three dark rows) · OC+ · OC−. Unit L keeps the live matrix the whole time."
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
      <li><strong>Tap</strong> a pad to toggle a note; <strong>hold a note + tap another in its
        row</strong> to tie a held span.</li>
      <li><strong>▲ ▼</strong> scroll pitch ±1 row; <strong>◀ ▶</strong> scroll the step window ±1 step.
        <strong>Hold SHIFT</strong> (CC 95) → both jump a full screen (±8).</li>
      <li><strong>VEL</strong> (CC 96, hold + tap a note) cycles its velocity;
        <strong>SCALE</strong> (CC 97) cycles the clip scale.</li>
      <li><strong>FOLLOW (CC 98):</strong> green = the window auto-scrolls with the playhead; violet =
        frozen on the page you chose. A manual ◀/▶ scroll freezes; <strong>tap FOL to resume
        following</strong>.</li>
      <li><strong>Scene column (top→bottom):</strong> <strong>EXIT</strong> on the top button (row 7), then
        <strong>DBL</strong> (row 6) doubles the clip and <strong>LEN</strong> (row 5) opens the length
        page. The bottom two buttons, <strong>OC+ / OC−</strong> (rows 1 / 0), jump the pitch
        <em>window</em> up / down a whole octave — they scroll the view, they don't transpose the notes.
        The three rows between are dark and inert: <em>copy/paste is a Grid-page feature and deliberately
        does not exist in the note editor</em> (in pair mode, use the deck's hold-COPY / PASTE on matrix
        clips).</li>
    </ul>
    {@render lengthEditSection()}
    <h4>Editor colours</h4>
    {@render swatches3(EDITOR_COLORS)}
    <h4>Reference</h4>
    {@render mapTable(PAIR_MAP_EDITOR)}
  </div>
  {:else if pairTab === 'keys'}
  <div id="lp2-panel-keys" role="tabpanel" tabindex="0" aria-labelledby="lp2-tab-keys">
    <h3 id="pair-keys">KEYS — play + CLIP-RECORD notes across both units</h3>
    <p class="muted">
      <strong>KEYS</strong> turns the <strong>pair</strong> into one wide playable <strong>isomorphic
      keyboard</strong> (LinnStrument-style, chromatic fourths) routed live to a clip's track, <em>and</em>
      the <strong>CLIP RECORD</strong> surface for notes. Both units flip to KEYS together (the matrix is
      hidden until you EXIT) and the keyboard is <strong>continuous across the L|R seam</strong> — a chord
      shape crossing the two units is the same shape.
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
      <li><strong>Double-tap a clip on the LEFT</strong> (two quick taps of the same pad) → both units flip
        to <strong>KEYS</strong> for that clip (an empty pad makes a fresh clip). The clip starts
        <strong>playing</strong>, the keyboard is <strong>live</strong>, and CLIP RECORD is
        <strong>armed-but-idle</strong> until you press QUEUE-REC.</li>
    </ol>
    <h4>CLIP RECORD — record a loop of notes</h4>
    <ul class="tight">
      <li><strong>QUEUE-REC</strong> (bottom row, unit L): tap to <strong>arm</strong> — flashes yellow.
        Recording begins when the playhead <strong>wraps to step 1</strong> (the transport auto-starts if
        stopped); the pad turns red. Re-tap while armed to cancel. <em>QUEUE-REC won't arm while ARRANGER
        RECORD is armed or during ARRANGEMENT playback — disarm REC / return to SESSION first.</em></li>
      <li><strong>Overdub OFF = TRUE REPLACE:</strong> each step is cleared as the playhead crosses it,
        then refilled by what you play that pass — an un-played region wipes.</li>
      <li><strong>OVERDUB ON = additive:</strong> each pass layers onto the last, looping endlessly; toggle
        <strong>OVR</strong> off to finish (it stops at the end of the current loop).</li>
      <li><strong>LEN</strong> opens the length page on R (EXIT returns straight to KEYS while L keeps the
        live keyboard), so you can resize the loop without leaving — the length-page layout is in the
        <em>Note Editor</em> tab.</li>
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
    <h4>KEYS colours</h4>
    {@render swatches3(KEYS_COLORS)}
    <h4>Reference</h4>
    {@render mapTable(PAIR_MAP_KEYS)}
  </div>
  {/if}
</div>
{/if}

<h2>Hardware protocol (confirmed against the device)</h2>
{@render mapTable(HW_MAP)}

<style>
  .hero { margin-bottom: 1.25rem; }
  .diagram-pair { display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-start; }
  /* The two KEYS unit diagrams sit SIDE-BY-SIDE like the physical pair. Without
     a basis, each figure's preferred width is its (long) caption's max-content,
     which forced a wrap — the units stacked even on a wide screen. */
  .diagram-pair > :global(.lp-diagram) { flex: 1 1 360px; min-width: 300px; max-width: 520px; }
  .lede { color: var(--muted, #9aa0b2); line-height: 1.5; max-width: 62ch; }
  .muted { color: var(--muted, #9aa0b2); font-size: 0.9rem; max-width: 70ch; }
  h2 { margin-top: 1.8rem; }
  h3 { margin-top: 1.4rem; }
  h4 { margin-top: 1.1rem; }
  /* ── The record-vocabulary explainer box. ── */
  .rec-vocab {
    margin-top: 1rem;
    padding: 0.7rem 1rem;
    border: 1px solid var(--doc-border-dim, #2a2d36);
    border-left: 3px solid #d33;
    border-radius: 8px;
    max-width: 74ch;
  }
  .rec-vocab h2 { margin: 0 0 0.4rem; font-size: 1rem; letter-spacing: 0.02em; }
  .rec-vocab dl { margin: 0; }
  .rec-vocab dt { font-weight: 700; margin-top: 0.4rem; }
  .rec-vocab dd { margin: 0.15rem 0 0; color: var(--muted, #9aa0b2); line-height: 1.5; }
  /* ── Tabs (role=tablist/tab/tabpanel; local state only). ── */
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 1.2rem 0 0;
    border-bottom: 1px solid var(--doc-border-dim, #2a2d36);
    padding-bottom: 0;
  }
  .tabs button {
    appearance: none;
    background: transparent;
    color: var(--muted, #9aa0b2);
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    padding: 0.45rem 0.9rem;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .tabs button:hover { color: inherit; }
  .tabs button.active {
    color: inherit;
    border-color: var(--doc-border-dim, #2a2d36);
    border-bottom: 2px solid #16d6d6;
    margin-bottom: -1px;
  }
  .tabs button:focus-visible { outline: 2px solid #16d6d6; outline-offset: -2px; }
  .top-tabs button { font-size: 1.05rem; }
  .top-tabs button.active { border-bottom-color: #16d6d6; }
  .sub-tabs { margin-top: 1rem; }
  /* Shared-foundation collapsibles directly under the sub-tab strip: collapsed
     by default so the mode panels are the first full content a reader sees;
     everything inside applies to EVERY view. */
  details.shared {
    margin: 0.8rem 0;
    border: 1px solid var(--doc-border-dim, #2a2d36);
    border-radius: 8px;
    padding: 0.4rem 0.9rem;
    max-width: 74ch;
  }
  details.shared > summary { cursor: pointer; font-weight: 600; color: var(--muted, #9aa0b2); }
  details.shared > summary:hover { color: inherit; }
  details.shared[open] > summary { color: inherit; margin-bottom: 0.4rem; }
  .sub-tabs button { font-size: 0.9rem; padding: 0.35rem 0.75rem; }
  .sub-tabs button.active { border-bottom-color: #b06be0; }
  .tbd-banner {
    border: 1px dashed var(--doc-border-dim, #6a4a12);
    border-radius: 8px;
    padding: 0.6rem 0.9rem;
    max-width: 70ch;
    color: var(--muted, #9aa0b2);
  }
  /* The two mode panels read as clearly separated "chapters": a left rule in the
     section's own hue. */
  .mode-section {
    margin-top: 1rem;
    padding-left: 14px;
    border-left: 2px solid #0a5c5c;
  }
  .mode-section.pair { border-left-color: #274a72; }
  .mode-title {
    font-size: 1.4rem;
    letter-spacing: 0.02em;
  }
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
