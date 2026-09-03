<script lang="ts">
  // WavesculptCard — hybrid 4-oscillator 3D video synth (v2 = wavetable engine).
  //
  // Card layout:
  //   * Top: per-osc strip × 4. Each strip has WAV selector + LOAD button +
  //     5 knobs (tune, fine, morph, spread, fold) + ADSR (A/D/S/R) + thickness.
  //     The per-osc waveform preview was REMOVED in v2 — the ribbon in the
  //     3D scene IS the waveform feedback now (ribbon vertices displace
  //     according to the live wavetable frame sampled into a small texture).
  //   * Middle: rendered video screen + TWO joysticks (camera XY pos +
  //     zoom/rot) + height (Z) + UNISON + Detune + alpha-brightness.
  //     The standalone zoom + rot knobs are GONE — the second joystick
  //     drives both axes (X = zoom, Y = rot). Both stay CV-patchable on
  //     their existing ports.
  //   * Bottom: BENTSCREEN WIGGLES — 12 BENTBOX knobs (unchanged from v1).
  //
  // ⚠ THE PICTURE IS NOT DRAWN HERE ANY MORE, AND SINCE legacy-removal S1 IT IS
  // NOT MOUNTED HERE EITHER. The WebGL2 renderer, the 2-D presentation canvas
  // and all three view modes live in `wavesculpt/WavesculptVizSurface.svelte`,
  // and the NODE mounts it — `$lib/ui/media/NodeVizSurfaceHost`, on GRAPH
  // lifetime, parked off-screen. This card is a VIEW: it CLAIMS that canvas into
  // its screen box to show it, and keeps the CONTROLS.
  //
  // ⚠ THE DIFFERENCE IS NOT COSMETIC. Mounting the surface made this card
  // LOAD-BEARING: the surface installs the module's cross-domain frame drawer,
  // and with no drawer installed `wavesculpt.ts`'s own `drawFrame` fills the
  // bridge canvas SOLID BLACK. So `wavesculpt` sat in `CARD_PRODUCER_LANE_TYPES`
  // and the default shell kept this card mounted OFF-SCREEN in
  // `<HeadlessSourceHost>` purely to keep the picture alive (#1587). A card that
  // is load-bearing cannot be deleted, and every card is being deleted.
  //
  // Three consequences worth knowing before editing:
  //   * ADOPT, NEVER MOUNT. A DOM element has one parent, and the surface stamps
  //     `data-testid="wavesculpt-canvas"` on its own canvas — a second mount
  //     would put two of them in the document (`wavesculpt.spec.ts` asserts
  //     exactly one, fifteen times) and run two GL contexts for one node;
  //   * `pollCamLive` (below) is registered as the NODE's per-frame listener, so
  //     the poll still runs once per rendered frame ahead of the render, which
  //     is the property it was written for — see the registry's `onFrame`;
  //   * this file creates no WebGL context, so it is not in the WebGL attest
  //     basis — the surface is, and its bytes are pinned.

  import { onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { captureFlowStore } from './card-kit';
  import { startCornerResize } from './card-resize';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    wavesculptDef,
    VIDEO_WALL_FACES,
    packColor01,
    DEFAULT_OSC_COLOR_PACKED,
    MASTER_GAIN_DEFAULT,
    MASTER_GAIN_MIN,
    MASTER_GAIN_MAX,
    // The three mode ROSTERS. The card used to carry its own copies — a
    // `const BLINK_MODE_NAMES` array plus three inline ternaries — which is a
    // second source of truth for a VOCABULARY, the divergence
    // card-range-source records against FilterCard's private `const MODES`.
    // One roster now feeds the def's `options` (hence the dock's Segmented
    // rows and the doc page) and these captions alike.
    BLINK_MODE_OPTIONS,
    FX_TYPE_OPTIONS,
    VIDEO_MODE_OPTIONS,
    type WavesculptData,
    type WavesculptOscData,
  } from '$lib/audio/modules/wavesculpt';
  import { clampJoy } from '$lib/audio/modules/joystick';
  import {
    loadWavesculptPreset,
    loadWavesculptWavFile,
    selectWavesculptFactoryTable,
    wavesculptOscData,
    wavesculptOscLabel,
    wavesculptOscSource,
  } from './wavesculpt/wavetable-actions';
  import {
    getFactoryTables,
    DEFAULT_FACTORY_TABLE_ID,
    framesToPlain,
  } from '$lib/audio/wavetable-factory-tables';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
  import {
    WAVETABLE_PRESETS,
    loadWavetablePreset,
  } from '$lib/audio/wavetable-presets';
  import ModuleTitle from './ModuleTitle.svelte';
  // ⚠ THE RENDERER IS NOT IMPORTED HERE. It is mounted once per NODE by
  // `$lib/ui/media/NodeVizSurfaceHost`; this card claims its canvas. Naming the
  // component in an import would also re-enrol `wavesculpt` in
  // `CARD_PRODUCER_LANE_TYPES` — that set is DERIVED by walking a card's
  // component subtree for producer seams, and the seam is inside the surface.
  import { nodeVizSurfaces } from '$lib/ui/media/node-viz-surfaces';
  import { VIZ_CLAIM_PRIORITY } from '$lib/ui/media/node-viz-surface-registry';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  // GUARDED (#1587), and this was a live P0 on its own: the dock full-view
  // PLAIN-MOUNTS an un-migrated card OUTSIDE the SvelteFlow provider, where a
  // bare `useStore()` THROWS at init. MEASURED: `__openDockFullView('ws1')`
  // produced ZERO `[data-testid="dock-full-view"]` elements and one pageerror
  // — "To call useStore outside of <SvelteFlow /> you need to wrap your
  // component in a <SvelteFlowProvider /> … in DockFullView.svelte". So
  // WAVESCULPT could not be expanded AT ALL under the faceplate shell; the
  // "unless the card happens to be open" half of #1587 was not even reachable,
  // which is also why the issue's confirming probe read identical numbers
  // expanded and collapsed (the expand mounted nothing). Every other card that
  // needs the flow store already routes through this helper — this one was the
  // last bare call in lib/ui/modules, and card-flow-store-guard.test.ts now
  // refuses a new one. Inside the provider `captureFlowStore()` is
  // byte-identical to `useStore()`; outside it is null → zoom 1 (card-resize).
  const flowStore = captureFlowStore();

  // ----- Resize plumbing (mirror BentboxCard) -----
  // Rounded to whole-u (180px) rack tiles (#759) so default + min land on the
  // grid; this card is user-resizable so the rack CSS doesn't clamp it.
  const DEFAULT_WIDTH = 1440;
  const DEFAULT_HEIGHT = 900;
  const MIN_WIDTH = 1080;
  const MIN_HEIGHT = 720;
  // ⚠ THE BACKING-STORE SIZE MOVED WITH THE MOUNT. The card used to pass
  // `width`/`height` to the surface; the node host mounts it at the surface's
  // own defaults, which ARE `VIDEO_RES` — the same numbers, from the same
  // constant, so the adopted canvas is byte-for-byte the box this card drew
  // before. Nothing here may set them again: two views of one canvas cannot
  // disagree about its resolution.

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // ---- Reactive params ----
  const defaultFor = (key: string): number =>
    wavesculptDef.params.find((p) => p.id === key)!.defaultValue;

  function pget(key: string): number {
    return (node?.params?.[key] ?? defaultFor(key)) as number;
  }

  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Bentscreen knobs (bound to <Knob> components below).
  let master_gain        = $derived(pget('master_gain'));

  // Drag state for the two joystick pads. Declared here (hoisted ahead
  // of the camera-derived block below) so the derived expressions can
  // reference them. The pad's onpointerdown/up flips these — while
  // true, the camera-derived `pos_x` etc. ignore the live-CV poll so
  // the dot tracks the user's gesture instead of fighting it.
  let draggingPos = $state(false);
  let draggingZR  = $state(false);

  // Camera params — knob values plus a live-CV poll so a patched LFO
  // moves the joystick dot in real time (motorized-fader style). The
  // poll calls engine.readParam(), which returns intrinsic-knob +
  // most-recent-CV-sample (see engine.ts:readParam). During an active
  // drag the polled value is suppressed so the user's gesture owns
  // the dot — the engine still updates the underlying AudioParam.
  let livePosX = $state<number | null>(null);
  let livePosY = $state<number | null>(null);
  let livePosZ = $state<number | null>(null);
  let liveZoom = $state<number | null>(null);
  let liveRot  = $state<number | null>(null);
  let pos_x = $derived(clampJoy(!draggingPos && livePosX !== null ? livePosX : pget('pos_x')));
  let pos_y = $derived(clampJoy(!draggingPos && livePosY !== null ? livePosY : pget('pos_y')));
  let pos_z = $derived(clampJoy(livePosZ !== null ? livePosZ : pget('pos_z')));
  let zoom  = $derived(!draggingZR && liveZoom !== null ? liveZoom : pget('zoom'));
  let rot   = $derived(clampJoy(!draggingZR && liveRot !== null ? liveRot : pget('rot')));
  let unison = $derived(pget('unison'));
  let detune = $derived(pget('detune'));
  // Chord mode: button toggles, knob picks the chord quality (major / minor).
  // While chord_mode is on every voice plays the same root pitch (voice 1)
  // plus a per-voice chord-interval offset (factory tick() writes those to
  // the worklet tune AudioParams). chord_quality is a discrete-curve knob;
  // we surface it as a clickable major/minor segment toggle in the UI so
  // the user doesn't have to dial a knob between two values.
  let chord_mode    = $derived(pget('chord_mode'));
  let chord_quality = $derived(pget('chord_quality'));
  let alpha_brightness = $derived(pget('alpha_brightness'));
  let lum_depth = $derived(pget('lum_depth'));
  // BLINK scope-render controls.
  let scale  = $derived(pget('scale'));
  let wiggle = $derived(pget('wiggle'));

  // ---- VIDEO WALL per-face controls (transparency + distort) ----
  // Static face metadata for the UI labels (matches VIDEO_WALL_FACES).
  const WALL_UI = [
    { n: 1, face: 'FRONT' },
    { n: 2, face: 'BACK' },
    { n: 3, face: 'LEFT' },
    { n: 4, face: 'RIGHT' },
    { n: 5, face: 'FLOOR' },
    { n: 6, face: 'CEILING' },
  ];
  function wallAlpha(n: number): number { return pget(`wall${n}_alpha`); }
  function wallDistort(n: number): number { return pget(`wall${n}_distort`); }

  // ---- per-osc CHROMA base colour (RED/GRN/BLU only; ALP has none) ----
  // Each colour osc stores a packed 0xRRGGBB integer param. The native
  // <input type="color"> writes hex; we pack on write, unpack for display +
  // for feeding the render uniforms. Defaults = historical r/g/b.
  const COLOR_PARAM = ['red_color', 'grn_color', 'blu_color'] as const;
  function colorPacked(oscIdx: number): number {
    const key = COLOR_PARAM[oscIdx];
    const def = oscIdx === 0
      ? DEFAULT_OSC_COLOR_PACKED.red
      : oscIdx === 1 ? DEFAULT_OSC_COLOR_PACKED.grn : DEFAULT_OSC_COLOR_PACKED.blu;
    return (node?.params?.[key] as number | undefined) ?? def;
  }
  function colorHex(oscIdx: number): string {
    return '#' + (colorPacked(oscIdx) & 0xffffff).toString(16).padStart(6, '0');
  }
  function onColorPick(oscIdx: number, ev: Event): void {
    const hex = (ev.target as HTMLInputElement).value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const t = patch.nodes[id]; if (!t) return;
    t.params[COLOR_PARAM[oscIdx]!] = packColor01(r, g, b);
  }
  // Reactive hexes for the three swatches (re-derive when params change).
  let redHex = $derived((pget('red_color'), colorHex(0)));
  let grnHex = $derived((pget('grn_color'), colorHex(1)));
  let bluHex = $derived((pget('blu_color'), colorHex(2)));

  // Per-osc params (bound in the strip <Knob>s).
  let tune1 = $derived(pget('tune1'));
  let tune2 = $derived(pget('tune2'));
  let tune3 = $derived(pget('tune3'));
  let tune4 = $derived(pget('tune4'));
  let fine1 = $derived(pget('fine1'));
  let fine2 = $derived(pget('fine2'));
  let fine3 = $derived(pget('fine3'));
  let fine4 = $derived(pget('fine4'));
  let morph1 = $derived(pget('morph1'));
  let morph2 = $derived(pget('morph2'));
  let morph3 = $derived(pget('morph3'));
  let morph4 = $derived(pget('morph4'));
  let spread1 = $derived(pget('spread1'));
  let spread2 = $derived(pget('spread2'));
  let spread3 = $derived(pget('spread3'));
  let spread4 = $derived(pget('spread4'));
  let fold1 = $derived(pget('fold1'));
  let fold2 = $derived(pget('fold2'));
  let fold3 = $derived(pget('fold3'));
  let fold4 = $derived(pget('fold4'));
  let A1 = $derived(pget('A1'));
  let D1 = $derived(pget('D1'));
  let S1 = $derived(pget('S1'));
  let R1 = $derived(pget('R1'));
  let A2 = $derived(pget('A2'));
  let D2 = $derived(pget('D2'));
  let S2 = $derived(pget('S2'));
  let R2 = $derived(pget('R2'));
  let A3 = $derived(pget('A3'));
  let D3 = $derived(pget('D3'));
  let S3 = $derived(pget('S3'));
  let R3 = $derived(pget('R3'));
  let A4 = $derived(pget('A4'));
  let D4 = $derived(pget('D4'));
  let S4 = $derived(pget('S4'));
  let R4 = $derived(pget('R4'));
  let thickness1 = $derived(pget('thickness1'));
  let thickness2 = $derived(pget('thickness2'));
  let thickness3 = $derived(pget('thickness3'));
  let thickness4 = $derived(pget('thickness4'));

  // ---- per-osc FX slot helpers ----
  // fxType: 0=OFF, 1=REVERB, 2=DELAY. Click-cycles OFF→REVERB→DELAY→OFF.
  function fxTypeFor(i: number): number {
    return Math.round(pget(`fxType${i + 1}`));
  }
  function fxAmountFor(i: number): number {
    return pget(`fxAmount${i + 1}`);
  }
  function cycleFxType(i: number): void {
    const next = (fxTypeFor(i) + 1) % FX_TYPE_OPTIONS.length;
    set(`fxType${i + 1}`)(next);
  }
  /** The state's name, off the def's roster — never re-typed here. */
  function fxLabel(t: number): string {
    return FX_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? FX_TYPE_OPTIONS[0].label;
  }
  const FX_CYCLE_TITLE = `FX slot — click to cycle ${FX_TYPE_OPTIONS.map((o) => o.label).join(' / ')}`;

  /**
   * The per-oscillator strip testids, SPELLED OUT as literals rather than built
   * from a `${i + 1}` template.
   *
   * ⚠ THIS IS NOT STYLE. `module-docs-lint` proves that every declared
   * `controlFamily.testidPrefix` exists by GREPPING card source
   * (`cards.includes(f.testidPrefix)`), and a template literal leaves nothing
   * to find — the string `wavesculpt-osc1-preset` never appears in a file that
   * only ever writes `` `wavesculpt-osc${i + 1}-preset` ``. Twelve families
   * therefore need twelve findable literals, and this is where they live.
   */
  const OSC_TESTIDS = [
    { preset: 'wavesculpt-osc1-preset', table: 'wavesculpt-osc1-table', load: 'wavesculpt-osc1-load' },
    { preset: 'wavesculpt-osc2-preset', table: 'wavesculpt-osc2-table', load: 'wavesculpt-osc2-load' },
    { preset: 'wavesculpt-osc3-preset', table: 'wavesculpt-osc3-table', load: 'wavesculpt-osc3-load' },
    { preset: 'wavesculpt-osc4-preset', table: 'wavesculpt-osc4-table', load: 'wavesculpt-osc4-load' },
  ] as const;

  // ── Per-osc wavetable source ──────────────────────────────────────────────
  //
  // ⚠ THE WRITES LIVE IN `wavesculpt/wavetable-actions`, SHARED with the
  // twelve faceplate shell cells. The DX7 is the precedent for why: a card that
  // owned its own action shipped a faceplate that could not change the voice at
  // all. This file keeps only the per-osc UI STATE (status/error lines and the
  // preset picker's reset), because that is a property of this surface rather
  // than of the patch.
  let uploadStatus = $state<Record<number, string | null>>({});
  let uploadError = $state<Record<number, string | null>>({});
  let presetSelection = $state<Record<number, string>>({});

  const oscData = (i: number) => wavesculptOscData(node, i);
  const oscSource = (i: number) => wavesculptOscSource(node, i);
  const oscLabel = (i: number) => wavesculptOscLabel(node, i);

  function selectFactory(oscIdx: number, factoryId: string): void {
    selectWavesculptFactoryTable(id, oscIdx, factoryId);
  }

  async function onPresetChange(oscIdx: number, ev: Event): Promise<void> {
    const presetId = (ev.target as HTMLSelectElement).value;
    if (!presetId) return;
    uploadError[oscIdx] = null;
    uploadStatus[oscIdx] = 'loading...';
    const r = await loadWavesculptPreset(id, oscIdx, presetId);
    uploadStatus[oscIdx] = r.status;
    uploadError[oscIdx] = r.error;
    presetSelection[oscIdx] = '';
  }

  async function onWavFileChange(oscIdx: number, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadError[oscIdx] = null;
    uploadStatus[oscIdx] = 'parsing...';
    const r = await loadWavesculptWavFile(id, oscIdx, file);
    uploadStatus[oscIdx] = r.status;
    uploadError[oscIdx] = r.error;
    try { input.value = ''; } catch { /* */ }
  }

  const PAD_PX = 110;

  // Pad 1 — camera position (X = pos_x, Y = pos_y).
  let padPosEl: HTMLDivElement | null = $state(null);
  // `draggingPos` is declared at the top of the script so the camera-
  // derived block above can reference it.
  let dotPosX = $derived(((pos_x + 1) / 2) * PAD_PX);
  let dotPosY = $derived(((-pos_y + 1) / 2) * PAD_PX);
  function writePos(x: number, y: number): void {
    const t = patch.nodes[id]; if (!t) return;
    t.params.pos_x = clampJoy(x);
    t.params.pos_y = clampJoy(y);
  }
  function posDown(ev: PointerEvent): void {
    if (!padPosEl) return;
    draggingPos = true;
    padPosEl.setPointerCapture(ev.pointerId);
    updateFromPosPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function updateFromPosPointer(ev: PointerEvent): void {
    if (!padPosEl) return;
    const rect = padPosEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;
    const py = (ev.clientY - rect.top) / rect.height;
    writePos(px * 2 - 1, -(py * 2 - 1));
  }
  function posMove(ev: PointerEvent): void {
    if (!draggingPos) return;
    updateFromPosPointer(ev);
  }
  function posUp(ev: PointerEvent): void {
    if (!draggingPos) return;
    draggingPos = false;
    try { padPosEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back: camera stays where you put it (matches v1 behavior +
    // gestural-performance intent).
  }

  // Pad 2 — zoom/rot (X = zoom mapped to [0.3..3], Y = rot mapped to [-1..+1]).
  // X-axis = zoom (right = closer/louder); Y-axis = rot (up = +rot).
  let padZRel: HTMLDivElement | null = $state(null);
  // `draggingZR` is declared at the top of the script (camera derived
  // references it).
  // Map zoom param ([0.3..3]) → pad X coord ([0..PAD_PX]). Log-scale because
  // the underlying knob curve is 'log'; matches the user's perception of
  // "halfway-right = unity zoom" — at zoom=1 the dot sits at PAD_PX/2.
  function zoomToPadX(z: number): number {
    const clamped = Math.max(0.3, Math.min(3, z));
    const logMin = Math.log(0.3); const logMax = Math.log(3);
    return ((Math.log(clamped) - logMin) / (logMax - logMin)) * PAD_PX;
  }
  function padXToZoom(px: number): number {
    const t = Math.max(0, Math.min(1, px / PAD_PX));
    const logMin = Math.log(0.3); const logMax = Math.log(3);
    return Math.exp(logMin + t * (logMax - logMin));
  }
  let dotZRX = $derived(zoomToPadX(zoom));
  let dotZRY = $derived(((-rot + 1) / 2) * PAD_PX);
  function writeZR(zoomVal: number, rotVal: number): void {
    const t = patch.nodes[id]; if (!t) return;
    t.params.zoom = Math.max(0.3, Math.min(3, zoomVal));
    t.params.rot = clampJoy(rotVal);
  }
  /** Map pad-X fraction [0..1] → zoom in [0.3..3] via log curve. Same
   *  curve as the underlying `zoom` param (curve: 'log'). */
  function fracToZoom(frac: number): number {
    const t = Math.max(0, Math.min(1, frac));
    const logMin = Math.log(0.3); const logMax = Math.log(3);
    return Math.exp(logMin + t * (logMax - logMin));
  }
  function updateFromZRPointer(ev: PointerEvent): void {
    if (!padZRel) return;
    const rect = padZRel.getBoundingClientRect();
    // Use the pad's actual rect so the mapping survives any CSS scaling
    // (Playwright sometimes computes box dimensions differently than the
    // nominal CSS px we authored).
    const fracX = (ev.clientX - rect.left) / rect.width;
    const py = (ev.clientY - rect.top) / rect.height;
    writeZR(fracToZoom(fracX), -(py * 2 - 1));
  }
  function zrDown(ev: PointerEvent): void {
    if (!padZRel) return;
    draggingZR = true;
    padZRel.setPointerCapture(ev.pointerId);
    updateFromZRPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function zrMove(ev: PointerEvent): void {
    if (!draggingZR) return;
    updateFromZRPointer(ev);
  }
  function zrUp(ev: PointerEvent): void {
    if (!draggingZR) return;
    draggingZR = false;
    try { padZRel?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // Same no-snap policy as the camera-pos pad.
  }



  // Video mode: 0 = PROXIMITY (3D ribbons inside the unit cube),
  // 1 = BIRDSEYE (top-down 2D floorplan of the unit cube showing
  // the 4 emitters + camera + audio-energy ripples),
  // 2 = SPECTROGRAPH (scrolling STFT of the combined audio output —
  // log-Hz vertical axis, time scrolling right-to-left). Picked via
  // the discrete video_mode param; the on-card View toggle button
  // cycles through all three options.
  let video_mode = $derived(pget('video_mode'));

  // BLINK render mode (within the 3D PROXIMITY view): 0 = (current)
  // wavetable ribbons, 1 = SCOPES TRIAL (live oscilloscope traces from
  // the 4 floor corners), 2 = REALITY BASED COMMUNITY (neon 3D tubes).
  // Persisted + multiplayer-synced via the discrete blink_mode param; the
  // on-card BLINK button cycles 0→1→2→0.
  let blink_mode = $derived(Math.round(pget('blink_mode')));
  // The readout under the BLINK button. It stays BLANK at state 0 — the
  // ribbon render is the default and captioning it would put a label on the
  // absence of a mode — so the roster is consulted only for 1..2. The NAMES
  // come from the def, so the card, the dock's Segmented row and the doc page
  // cannot disagree about what state 2 is called.
  let blinkModeName = $derived(
    blink_mode === 0 ? '' : (BLINK_MODE_OPTIONS.find((o) => o.value === blink_mode)?.label ?? ''),
  );

  // Cycle-button hover text, built from the rosters so a renamed state cannot
  // leave a stale tooltip behind.
  //
  // ⚠ THE VIEW BUTTON'S CAPTION STAYS ABBREVIATED (`3D` / `BIRDSEYE` /
  // `SPECTRO`) AND THAT IS A DELIBERATE DEFERRAL, NOT AN OVERSIGHT.
  // `.right-controls` is an `align-items: center` flex column whose width is
  // set by its widest non-wrapping child — today `BIRDSEYE`, 8 characters.
  // Painting `SPECTROGRAPH` there widens the rail by ~4 characters and SQUEEZES
  // THE CANVAS beside it, which moves the wavesculpt VRT baseline for a purely
  // cosmetic rename (the footer lesson: chrome that is not in frame still moves
  // a baseline, through the layout). The full names are one hover away and are
  // what the dock's Segmented row paints.
  const VIEW_CYCLE_TITLE = `View mode: ${VIDEO_MODE_OPTIONS.map((o) => o.label).join(' / ')}`;
  const BLINK_CYCLE_TITLE = `BLINK render mode: ${BLINK_MODE_OPTIONS.map((o) => o.label).join(' / ')}`;



  // Camera-CV live-poll. ONE cross-domain call per frame that pulls the
  // entire camera snapshot from engine.read(node, 'camera') — the SAME
  // shadow-analyser samples the spatial audio mix reads. This is the
  // single-source-of-truth read: joystick dot, ribbon viewport (see the
  // WebGL tick above), and audio distGain all reflect the same instant.
  //
  // Runs on rAF (driven from tick()), NOT a setInterval. A standalone
  // setInterval(30ms) here was the gamepad-joystick regression: when a
  // gamepad drives pos_x/pos_y the dot's only path to the screen is this
  // poll (unlike a mouse drag, which writes node.params.* and re-renders
  // the dot synchronously via Svelte reactivity). A setInterval callback
  // gets STARVED + coalesced behind this card's own heavy WebGL render
  // on a busy main thread, so the dot updated horribly slowly and looked
  // like it couldn't reach the stick's extremes (it was just badly under-
  // sampled). Riding rAF pins the poll to the render cadence (~60 Hz, the
  // same rate the mouse path effectively gets) and — crucially — it can no
  // longer be coalesced away by the render it shares a frame with. Audio
  // SCHEDULING stays on the jank-immune scheduler-clock worker tick; only
  // this UI/visual read moves to rAF (per the input-path convention).
  function pollCamLive() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const cam = e.read(node, 'camera') as
      | { pos_x: number; pos_y: number; pos_z: number; zoom: number; rot: number }
      | undefined;
    if (!cam) return;
    if (cam.pos_x !== livePosX) livePosX = cam.pos_x;
    if (cam.pos_y !== livePosY) livePosY = cam.pos_y;
    if (cam.pos_z !== livePosZ) livePosZ = cam.pos_z;
    if (cam.zoom  !== liveZoom) liveZoom = cam.zoom;
    if (cam.rot   !== liveRot)  liveRot  = cam.rot;
  }

  // ---- The NODE's picture, claimed into this card's screen box ----
  //
  // ⚠ CLAIM, NOT CREATE. The node host `ensure`s the surface into existence with
  // no view at all, so the renderer runs — and `video_out` carries a picture —
  // whether or not any card is mounted. A claim is a transfer with an
  // owner-checked release, so this card and the dock faceplate can hand the
  // canvas back and forth without either teardown stranding the live one.
  //
  // ⚠ AND IT IS RANKED RATHER THAN LAST-WINS. Under `?shell=legacy` this card
  // and a `DockFullView` faceplate can BOTH be mounted (`laneMigrated` is not
  // gated on the shell flag), and the surface the player opened deliberately is
  // the one that should hold the picture — so the dock outranks the card, and
  // closing it hands the canvas straight back here with no remount and no GL
  // re-init. See `$lib/ui/media/node-viz-surface-registry`.
  let vizHost = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const host = vizHost;
    if (!host) return;
    const claim = nodeVizSurfaces.claim(id, host, VIZ_CLAIM_PRIORITY.card);
    return () => claim.release();
  });

  // The CADENCE GUARANTEE, re-homed. `pollCamLive` used to ride the surface's
  // `onFrame` prop because this card mounted it; it now rides the same rAF
  // through the node's per-frame listener list, so the poll is still pinned to
  // the render it shares a frame with and still cannot be coalesced away.
  $effect(() => nodeVizSurfaces.onFrame(id, pollCamLive));

  onDestroy(() => {
    if (resizeAbort) resizeAbort.abort();
  });


  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.width = w;
          target.data.height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  // Per-osc gate/pitch/morph then camera CV then alpha video. The
  // morph{N}_cv ports were shipped on the engine side in PR #225 but
  // weren't surfaced as patchable handles until this PR.
  const inputs: PortDescriptor[] = [
    { id: 'gate1',     label: 'G1', cable: 'gate' },
    { id: 'pitch_cv1', label: 'P1', cable: 'cv' },
    { id: 'morph1_cv', label: 'M1', cable: 'cv' },
    { id: 'gate2',     label: 'G2', cable: 'gate' },
    { id: 'pitch_cv2', label: 'P2', cable: 'cv' },
    { id: 'morph2_cv', label: 'M2', cable: 'cv' },
    { id: 'gate3',     label: 'G3', cable: 'gate' },
    { id: 'pitch_cv3', label: 'P3', cable: 'cv' },
    { id: 'morph3_cv', label: 'M3', cable: 'cv' },
    { id: 'gate4',     label: 'G4', cable: 'gate' },
    { id: 'pitch_cv4', label: 'P4', cable: 'cv' },
    { id: 'morph4_cv', label: 'M4', cable: 'cv' },
    { id: 'pos_x',     label: 'X',  cable: 'cv' },
    { id: 'pos_y',     label: 'Y',  cable: 'cv' },
    { id: 'pos_z',     label: 'H',  cable: 'cv' },
    { id: 'zoom',      label: 'Z',  cable: 'cv' },
    { id: 'rot',       label: 'R',  cable: 'cv' },
    // BLINK scope-render controls — CV-modulatable like the camera params
    // (owner intent). Must render a handle so def<->UI parity holds and
    // patches anchor; see e2e/tests/io-spec-consistency.spec.ts.
    { id: 'scale',     label: 'Sc', cable: 'cv' },
    { id: 'wiggle',    label: 'Wg', cable: 'cv' },
    { id: 'alpha_in',  label: 'A',  cable: 'video' },
    // VIDEO WALLS — six cross-domain video inputs, one per box face. Each
    // MUST render a handle (per-module-per-port handle-presence sweep reads
    // the def's literal inputs). Labels match VIDEO_WALL_FACES.
    { id: 'wall1',     label: 'W1·Fr', cable: 'video' },
    { id: 'wall2',     label: 'W2·Bk', cable: 'video' },
    { id: 'wall3',     label: 'W3·Lf', cable: 'video' },
    { id: 'wall4',     label: 'W4·Rt', cable: 'video' },
    { id: 'wall5',     label: 'W5·Fl', cable: 'video' },
    { id: 'wall6',     label: 'W6·Ce', cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L',         label: 'L',   cable: 'audio' },
    { id: 'R',         label: 'R',   cable: 'audio' },
    // Per-oscillator audio taps (RED/GRN/BLU/ALP) — each emits that one
    // oscillator's signal (post env+dist+pan), the same per-osc source
    // the BLINK oscilloscope reads. Grouped right after L/R so the
    // per-voice outs sit next to the summed main mix. Every declared
    // port MUST render a handle — see e2e/tests/io-spec-consistency.spec.ts
    // (#359/#362 handle/io-spec parity).
    { id: 'out_red',   label: 'RED', cable: 'audio' },
    { id: 'out_grn',   label: 'GRN', cable: 'audio' },
    { id: 'out_blu',   label: 'BLU', cable: 'audio' },
    { id: 'out_alp',   label: 'ALP', cable: 'audio' },
    { id: 'video_out', label: 'OUT', cable: 'mono-video' },
  ];

  const OSC_COLOR_LABELS = ['RED', 'GRN', 'BLU', 'ALP'];
</script>

<div
  class="card wavesculpt"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="wavesculpt-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="WAVESCULPT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Per-oscillator strip: WAV / LOAD / tune / fine / morph / spread / fold / ADSR / thickness -->
      <div class="osc-grid">
        {#each [0, 1, 2, 3] as i}
          <div class="osc-strip osc-{i}" data-testid={`wavesculpt-osc-${i + 1}`}>
            <div class="osc-label">
              <span>{OSC_COLOR_LABELS[i]}</span>
              {#if i < 3}
                <!-- CHROMA SELECTOR WHEEL: per-osc custom base colour. A
                     native colour picker (same component pattern as
                     CHROMA/LUMA keyer cards). Picked colour tints this osc
                     in ALL 3 blink modes. Not a single-CC param → uses a
                     native <input type="color">, NOT a Knob/Fader, so it's
                     correctly exempt from the MIDI-Learn audit. -->
                <label
                  class="chroma-swatch-wrap"
                  title="Pick this oscillator's base colour"
                >
                  <span
                    class="chroma-swatch"
                    style="background: {i === 0 ? redHex : i === 1 ? grnHex : bluHex};"
                  ></span>
                  <input
                    type="color"
                    class="chroma-color-input"
                    value={i === 0 ? redHex : i === 1 ? grnHex : bluHex}
                    oninput={(ev) => onColorPick(i, ev)}
                    data-testid={`wavesculpt-osc-${i + 1}-color`}
                  />
                </label>
              {/if}
            </div>
            <div class="wt-row preset-row">
              <select
                class="wt-select preset-select"
                value={presetSelection[i] ?? ''}
                onchange={(ev) => onPresetChange(i, ev)}
                data-testid={OSC_TESTIDS[i]!.preset}
              >
                <option value="">— pick a preset —</option>
                {#each WAVETABLE_PRESETS as p (p.id)}
                  <option value={p.id}>{p.label}</option>
                {/each}
              </select>
            </div>
            <div class="wt-row">
              <select
                class="wt-select"
                value={oscSource(i)}
                onchange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  if (v === 'user') return;
                  const factoryId = v.startsWith('factory:') ? v.slice('factory:'.length) : v;
                  selectFactory(i, factoryId);
                }}
                data-testid={OSC_TESTIDS[i]!.table}
              >
                {#each getFactoryTables() as t (t.id)}
                  <option value={`factory:${t.id}`}>{t.label}</option>
                {/each}
                {#if oscSource(i) === 'user'}
                  <option value="user">USER · {oscLabel(i)}</option>
                {/if}
              </select>
              <label class="upload-btn" data-testid={OSC_TESTIDS[i]!.load}>
                <input
                  type="file"
                  accept=".wav,audio/wav"
                  onchange={(ev) => onWavFileChange(i, ev)}
                />
                <span>LOAD</span>
              </label>
            </div>
            {#if uploadStatus[i]}
              <div class="upload-status">{uploadStatus[i]}</div>
            {/if}
            {#if uploadError[i]}
              <div class="upload-error">{uploadError[i]}</div>
            {/if}
            <div class="osc-knobs">
              <Knob value={i === 0 ? tune1 : i === 1 ? tune2 : i === 2 ? tune3 : tune4}
                min={-36} max={36} defaultValue={0} label="Tune" units="st" curve="linear"
                onchange={set(`tune${i + 1}`)} moduleId={id} paramId={`tune${i + 1}`} readLive={live(`tune${i + 1}`)} />
              <Knob value={i === 0 ? fine1 : i === 1 ? fine2 : i === 2 ? fine3 : fine4}
                min={-100} max={100} defaultValue={0} label="Fine" units="¢" curve="linear"
                onchange={set(`fine${i + 1}`)} moduleId={id} paramId={`fine${i + 1}`} readLive={live(`fine${i + 1}`)} />
              <Knob value={i === 0 ? morph1 : i === 1 ? morph2 : i === 2 ? morph3 : morph4}
                min={0} max={1} defaultValue={0} label="Morph" curve="linear"
                onchange={set(`morph${i + 1}`)} moduleId={id} paramId={`morph${i + 1}`} readLive={live(`morph${i + 1}`)} />
              <Knob value={i === 0 ? spread1 : i === 1 ? spread2 : i === 2 ? spread3 : spread4}
                min={1} max={5} defaultValue={1} label="Sprd" curve="linear"
                onchange={set(`spread${i + 1}`)} moduleId={id} paramId={`spread${i + 1}`} readLive={live(`spread${i + 1}`)} />
              <Knob value={i === 0 ? fold1 : i === 1 ? fold2 : i === 2 ? fold3 : fold4}
                min={0} max={1} defaultValue={0} label="Fold" curve="linear"
                onchange={set(`fold${i + 1}`)} moduleId={id} paramId={`fold${i + 1}`} readLive={live(`fold${i + 1}`)} />
              <Knob value={i === 0 ? thickness1 : i === 1 ? thickness2 : i === 2 ? thickness3 : thickness4}
                min={0} max={1} defaultValue={0.3} label="Thick" curve="linear"
                onchange={set(`thickness${i + 1}`)} moduleId={id} paramId={`thickness${i + 1}`} readLive={live(`thickness${i + 1}`)} />
            </div>
            <div class="osc-knobs">
              <Knob value={i === 0 ? A1 : i === 1 ? A2 : i === 2 ? A3 : A4}
                min={0.001} max={5} defaultValue={0.01} label="A" curve="log" units="s"
                onchange={set(`A${i + 1}`)} moduleId={id} paramId={`A${i + 1}`} readLive={live(`A${i + 1}`)} />
              <Knob value={i === 0 ? D1 : i === 1 ? D2 : i === 2 ? D3 : D4}
                min={0.001} max={5} defaultValue={0.1} label="D" curve="log" units="s"
                onchange={set(`D${i + 1}`)} moduleId={id} paramId={`D${i + 1}`} readLive={live(`D${i + 1}`)} />
              <Knob value={i === 0 ? S1 : i === 1 ? S2 : i === 2 ? S3 : S4}
                min={0} max={1} defaultValue={0.7} label="S" curve="linear"
                onchange={set(`S${i + 1}`)} moduleId={id} paramId={`S${i + 1}`} readLive={live(`S${i + 1}`)} />
              <Knob value={i === 0 ? R1 : i === 1 ? R2 : i === 2 ? R3 : R4}
                min={0.001} max={5} defaultValue={0.5} label="R" curve="log" units="s"
                onchange={set(`R${i + 1}`)} moduleId={id} paramId={`R${i + 1}`} readLive={live(`R${i + 1}`)} />
              <!-- Per-osc FX slot. Single click-cycle button + an amount
                   knob. Button cycles OFF → REVERB → DELAY → OFF.
                   Reverb wet is auto-modulated by distance to the
                   camera in the engine; the knob is the BASE amount. -->
              <button
                type="button"
                class="fx-btn fx-btn-{fxTypeFor(i)}"
                onclick={() => cycleFxType(i)}
                data-testid={`wavesculpt-fx-btn-${i + 1}`}
                title={FX_CYCLE_TITLE}
              >{fxLabel(fxTypeFor(i))}</button>
              <Knob value={fxAmountFor(i)} min={0} max={1} defaultValue={0.4}
                label="FX" curve="linear"
                onchange={set(`fxAmount${i + 1}`)} moduleId={id} paramId={`fxAmount${i + 1}`} readLive={live(`fxAmount${i + 1}`)} />
            </div>
          </div>
        {/each}
      </div>

      <!-- Middle: rendered screen + TWO joysticks + height + UNISON + Detune + alpha-brightness -->
      <div class="mid-row">
        <div class="cam-controls">
          <div class="cam-section-label">CAMERA</div>
          <div
            class="pad nodrag"
            bind:this={padPosEl}
            style="width: {PAD_PX}px; height: {PAD_PX}px;"
            role="application"
            aria-label="Wavesculpt camera XY pad"
            data-testid="wavesculpt-pad"
            onpointerdown={posDown}
            onpointermove={posMove}
            onpointerup={posUp}
            onpointercancel={posUp}
          >
            <div class="cross-h"></div>
            <div class="cross-v"></div>
            <div class="dot" class:active={draggingPos} style="left: {dotPosX}px; top: {dotPosY}px;"></div>
          </div>
          <div class="pad-label">pos x/y</div>
          <Knob value={pos_z} min={-1} max={1} defaultValue={0} label="Height" curve="linear" onchange={set('pos_z')} moduleId={id} paramId="pos_z" readLive={live('pos_z')} />
          <div
            class="pad nodrag pad-zr"
            bind:this={padZRel}
            style="width: {PAD_PX}px; height: {PAD_PX}px;"
            role="application"
            aria-label="Wavesculpt zoom/rotation pad"
            data-testid="wavesculpt-pad-zoomrot"
            onpointerdown={zrDown}
            onpointermove={zrMove}
            onpointerup={zrUp}
            onpointercancel={zrUp}
          >
            <div class="cross-h"></div>
            <div class="cross-v"></div>
            <div class="dot" class:active={draggingZR} style="left: {dotZRX}px; top: {dotZRY}px;"></div>
          </div>
          <div class="pad-label">zoom / rot</div>
        </div>

        <!-- THE NODE'S renderer, adopted — not a mount of it, and not a copy.
             The canvas is `appendChild`ed straight into this box by the claim
             above, so it is still a DIRECT flex child of `.screen-wrap` and the
             VRT-pinned box is unchanged. It arrives carrying the surface's own
             scoped class, so the 100%/100% fill comes with it. Empty in markup
             on purpose: declaring anything here would give Svelte a child to
             manage in a container the registry re-parents into. -->
        <div
          class="screen-wrap"
          data-testid="wavesculpt-screen-wrap"
          bind:this={vizHost}
        ></div>

        <div class="right-controls">
          <!-- VIEW toggle cycles through three render modes:
               0 = PROXIMITY (3D ribbons, original render),
               1 = BIRDSEYE (top-down 2D floorplan showing the spatial
                   system: 4 emitter dots + camera marker + audio-energy
                   ripples),
               2 = SPECTROGRAPH (scrolling STFT of the combined audio
                   output — log-Hz vertical axis, time scrolling
                   right-to-left). 3D is the gorgeous default; BIRDSEYE
                   is useful when tweaking the camera; SPECTROGRAPH is
                   the dogfood audio-analysis view. -->
          <button
            type="button"
            class="unison-toggle view-toggle"
            class:on={Math.round(video_mode) !== 0}
            data-testid="wavesculpt-view-toggle"
            title={VIEW_CYCLE_TITLE}
            onclick={() => set('video_mode')((Math.round(video_mode) + 1) % VIDEO_MODE_OPTIONS.length)}
          >{Math.round(video_mode) === 0 ? '3D' : Math.round(video_mode) === 1 ? 'BIRDSEYE' : 'SPECTRO'}</button>
          <!-- BLINK cycles three render modes inside the 3D view:
               0 = (current) wavetable ribbons,
               1 = SCOPES TRIAL — live oscilloscope traces from the 4
                   floor corners aimed up+inward at 45°; WIDTH thickens
                   the scope line,
               2 = REALITY BASED COMMUNITY — same, as 3D neon tubes;
                   WIDTH sets the tube radius. -->
          <button
            type="button"
            class="unison-toggle blink-toggle"
            class:on={blink_mode !== 0}
            data-testid="wavesculpt-blink-toggle"
            title={BLINK_CYCLE_TITLE}
            onclick={() => set('blink_mode')((blink_mode + 1) % BLINK_MODE_OPTIONS.length)}
          >BLINK</button>
          {#if blink_mode !== 0}
            <div class="blink-mode-name" data-testid="wavesculpt-blink-mode-name">{blinkModeName}</div>
          {/if}
          <!-- SCALE — amplitude/zoom of the BLINK scope waveform (reuses
               SCOPE's ch1Scale semantics: log 0.1..10, unity at 1). Applies
               in SCOPES TRIAL + REALITY BASED COMMUNITY. -->
          <Knob value={scale} min={0.1} max={10} defaultValue={1}
            label="Scale" curve="log"
            onchange={set('scale')} moduleId={id} paramId="scale" readLive={live('scale')} />
          <!-- WIGGLE — pitch-driven 3D rotation of each osc's line/tube/
               ribbon. 0 = OFF (fixed direction). Rotation speed + magnitude
               scale with each osc's pitch; this knob scales overall strength.
               Standard knob dial: min (OFF) lower-left, max lower-right. -->
          <Knob value={wiggle} min={0} max={1} defaultValue={0}
            label="Wiggle" curve="linear"
            onchange={set('wiggle')} moduleId={id} paramId="wiggle" readLive={live('wiggle')} />
          <button
            type="button"
            class="unison-toggle"
            class:on={unison >= 0.5}
            data-testid="wavesculpt-unison"
            onclick={() => set('unison')(unison >= 0.5 ? 0 : 1)}
          >UNISON</button>
          <Knob value={detune} min={-1} max={1} defaultValue={0} label="Detune" curve="linear" onchange={set('detune')} moduleId={id} paramId="detune" readLive={live('detune')} />
          <button
            type="button"
            class="unison-toggle chord-toggle"
            class:on={chord_mode >= 0.5}
            data-testid="wavesculpt-chord-mode"
            title="Chord mode: voice 1 plays the root, voices 2-4 add chord-tone offsets in semitones"
            onclick={() => set('chord_mode')(chord_mode >= 0.5 ? 0 : 1)}
          >CHORD</button>
          <div class="chord-quality" data-testid="wavesculpt-chord-quality" role="radiogroup" aria-label="Chord quality">
            <button
              type="button"
              class="chord-quality-opt"
              class:on={chord_quality < 0.5}
              data-testid="wavesculpt-chord-major"
              role="radio"
              aria-checked={chord_quality < 0.5}
              onclick={() => set('chord_quality')(0)}
            >MAJ</button>
            <button
              type="button"
              class="chord-quality-opt"
              class:on={chord_quality >= 0.5}
              data-testid="wavesculpt-chord-minor"
              role="radio"
              aria-checked={chord_quality >= 0.5}
              onclick={() => set('chord_quality')(1)}
            >MIN</button>
          </div>
          <Knob
            value={alpha_brightness} min={0} max={2} defaultValue={1}
            label="A Bright" curve="linear"
            onchange={set('alpha_brightness')} moduleId={id} paramId="alpha_brightness" readLive={live('alpha_brightness')}
          />
          <!-- LUMINOSITY → BANDPASS depth. Automatic from the walls each line
               crosses; 0 = OFF (lines unfiltered), 1 = full luminosity-shaped
               band-pass (bright wall = wide-open, black = narrow). -->
          <Knob
            value={lum_depth} min={0} max={1} defaultValue={0}
            label="LumBP" curve="linear"
            onchange={set('lum_depth')} moduleId={id} paramId="lum_depth" readLive={live('lum_depth')}
          />
        </div>
      </div>

      <!-- Bottom: OUTPUT. The eleven BENTBOX-duplicate CRT knobs that used to
           sit here are gone — patch video_out -> BENTBOX for those (it has CV
           inputs for all of them, which this card never did). WAVESCULPT keeps
           its own always-on light CRT character in the shader. Ranges come
           from the shared MASTER_GAIN_* constants so the card cannot drift
           from the def. -->
      <div class="bent-section">
        <div class="bent-label">OUTPUT</div>
        <div class="bent-grid">
          <Knob value={master_gain} min={MASTER_GAIN_MIN} max={MASTER_GAIN_MAX} defaultValue={MASTER_GAIN_DEFAULT} label="Gain" curve="linear" onchange={set('master_gain')} moduleId={id} paramId="master_gain" readLive={live('master_gain')} />
        </div>
      </div>

      <!-- VIDEO WALLS — per-face transparency + convex distort. Each row
           pairs a TRANSPARENCY (0-100%) + DISTORT (flat→dome, 0-1) knob for
           one face. Patch a video module into the matching wall{N} input
           (handles in the patch panel) to texture that face; patch
           WAVESCULPT's own OUT back into a wall for recursive feedback. -->
      <div class="bent-section wall-section" data-testid="wavesculpt-wall-section">
        <div class="bent-label">VIDEO WALLS</div>
        <div class="wall-grid">
          {#each WALL_UI as w (w.n)}
            <div class="wall-cell" data-testid={`wavesculpt-wall-${w.n}`}>
              <div class="wall-face-label">W{w.n} · {w.face}</div>
              <div class="wall-knobs">
                <Knob value={wallAlpha(w.n)} min={0} max={100} defaultValue={100}
                  label="Alpha" units="%" curve="linear"
                  onchange={set(`wall${w.n}_alpha`)} moduleId={id} paramId={`wall${w.n}_alpha`} readLive={live(`wall${w.n}_alpha`)} />
                <Knob value={wallDistort(w.n)} min={0} max={1} defaultValue={0}
                  label="Distort" curve="linear"
                  onchange={set(`wall${w.n}_distort`)} moduleId={id} paramId={`wall${w.n}_distort`} readLive={live(`wall${w.n}_distort`)} />
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize WAVESCULPT"
    data-testid="wavesculpt-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card.wavesculpt {
    background-color: #08090c;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    padding: 18px 12px 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card.wavesculpt {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card.wavesculpt {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.wavesculpt.resizing { transition: none; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: linear-gradient(90deg,
      #e23, #2c3, #36e, rgba(255,255,255,0.5));
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.06em;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .osc-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .osc-strip {
    border: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    border-radius: 2px;
    padding: 4px;
    background: rgba(255,255,255,0.02);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .osc-strip.osc-0 { border-left: 2px solid rgba(255, 80, 80, 0.7); }
  .osc-strip.osc-1 { border-left: 2px solid rgba(80, 220, 100, 0.7); }
  .osc-strip.osc-2 { border-left: 2px solid rgba(100, 130, 255, 0.7); }
  .osc-strip.osc-3 { border-left: 2px solid rgba(210, 210, 210, 0.7); }
  /* Per-osc FX slot button — small chip styled to match the other
     button-toggles on the card. Color shifts with FX type so the user
     can scan all 4 slots at a glance. */
  .fx-btn {
    appearance: none;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    color: var(--text-dim);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 4px 6px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out, border-color 80ms ease-out;
  }
  .fx-btn-1 {  /* REVERB */
    background: var(--cable-cv, #6cf);
    color: #000;
    border-color: var(--cable-cv, #6cf);
  }
  .fx-btn-2 {  /* DELAY */
    background: var(--cable-audio, #f80);
    color: #000;
    border-color: var(--cable-audio, #f80);
  }
  .osc-label {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-align: center;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .chroma-swatch-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .chroma-swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--border, #2a2f3a);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    display: inline-block;
  }
  .chroma-swatch-wrap:hover .chroma-swatch {
    border-color: var(--accent-dim, #6a7a9a);
  }
  .chroma-color-input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
    border: 0;
    padding: 0;
  }
  .wt-row {
    display: flex;
    gap: 4px;
    align-items: stretch;
  }
  .wt-select {
    flex: 1;
    background: #1a1f2a;
    color: var(--text, #d8dde6);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 1px 4px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    min-width: 0;
  }
  .upload-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.05em;
  }
  .upload-btn input[type='file'] { display: none; }
  .upload-btn:hover { color: var(--text, #d8dde6); border-color: #6a7282; }
  .upload-status {
    font-size: 0.5rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .upload-error {
    font-size: 0.5rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .osc-knobs {
    display: flex;
    gap: 2px;
    justify-content: space-around;
    flex-wrap: wrap;
  }
  .mid-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: stretch;
  }
  .cam-controls, .right-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .cam-section-label, .bent-label {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .pad-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    margin-top: -2px;
  }
  .pad {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad-zr {
    border-color: var(--accent, #d6a);
  }
  .pad:active { cursor: grabbing; }
  .cross-h, .cross-v {
    position: absolute;
    background: rgba(255,255,255,0.08);
    pointer-events: none;
  }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .dot {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--cable-cv, #6cf);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    pointer-events: none;
    box-shadow: 0 0 6px rgba(120, 200, 255, 0.4);
  }
  .pad-zr .dot {
    background: var(--accent, #d6a);
    box-shadow: 0 0 6px rgba(210, 110, 200, 0.4);
  }
  .dot.active { box-shadow: 0 0 12px rgba(120, 200, 255, 0.8); }
  .pad-zr .dot.active { box-shadow: 0 0 12px rgba(210, 110, 200, 0.9); }
  .screen-wrap {
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 2px;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 200px;
  }
  /* `.screen-wrap canvas` moved to WavesculptVizSurface with the canvas —
     Svelte's scoped CSS does not reach a child component's element, so leaving
     the rule here would have compiled to an unused selector and the picture
     would have lost its 100%/100% fill. */
  .unison-toggle {
    appearance: none;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    color: var(--text-dim);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    padding: 4px 8px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .unison-toggle.on {
    background: var(--accent, #6cf);
    color: #000;
    border-color: var(--accent, #6cf);
  }
  /* Active BLINK render-mode name, shown under the BLINK button. */
  .blink-mode-name {
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    line-height: 1.1;
    color: var(--accent, #6cf);
    text-align: center;
    max-width: 80px;
    word-break: break-word;
  }
  /* Chord-quality segment: two adjacent buttons, the active one inherits
     the .unison-toggle.on accent. */
  .chord-quality {
    display: inline-flex;
    gap: 0;
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    border-radius: 2px;
    overflow: hidden;
  }
  .chord-quality-opt {
    appearance: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 4px 6px;
    border: none;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .chord-quality-opt:not(:last-child) {
    border-right: 1px solid var(--border-dim, rgba(255,255,255,0.15));
  }
  .chord-quality-opt.on {
    background: var(--accent, #6cf);
    color: #000;
  }
  .bent-section {
    border-top: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    padding-top: 6px;
  }
  .bent-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px 6px;
    margin-top: 4px;
  }
  .wall-section { margin-top: 6px; }
  .wall-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    margin-top: 4px;
  }
  .wall-cell {
    border: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    border-radius: 2px;
    padding: 3px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    background: rgba(255,255,255,0.02);
  }
  .wall-face-label {
    font-size: 0.5rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    text-align: center;
  }
  .wall-knobs {
    display: flex;
    gap: 2px;
    justify-content: center;
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-cv) 50%,
      var(--cable-cv) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-cv) 70%,
      var(--cable-cv) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
