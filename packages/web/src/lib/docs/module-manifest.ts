// packages/web/src/lib/docs/module-manifest.ts
//
// Build-time module catalog. Reads packages/web/src/lib/audio/modules/*.ts
// AND packages/web/src/lib/video/modules/*.ts and returns a structured manifest
// for the in-app docs site (/docs/modules and /docs/modules/[id]). Each entry is
// tagged with its `domain` ('audio' | 'video'); the parse + explain pipeline is
// domain-agnostic (video defs flow through the same regex extractor).
//
// Why a regex parser, not the TS compiler API or a runtime import:
//   1. The audio module factories import .wasm / worklet ?url assets that
//      only Vite can resolve — importing them from a +page.server.ts loader
//      would break SSR / prerender.
//   2. The module-def shape is enforced by AudioModuleDef + the
//      (intentionally simple) literal-init pattern the codebase uses, so a
//      handful of well-tested regexes are easier to reason about than a
//      partial AST walk.
//
// The parser is tolerant of registry additions: any export matching
// `export const <name>Def: AudioModuleDef = { ... };` is picked up. It's
// also tolerant of two computed-shape modules (mixmstrs uses helper
// functions to build inputs / params); for those we fall back to a
// hardcoded extractor. If all else fails we emit a placeholder card and
// surface the failure.

// Module sources are inlined at build time via Vite's `?raw` query.
// This is intentional: a runtime `fs.readdirSync` would chase the on-disk
// path of the *built* server bundle (.svelte-kit/output/server/chunks/...)
// rather than the source tree, breaking prerender. With `import.meta.glob`,
// Vite walks the registry, embeds each module file's source text, and
// resolves all paths at build time.
import { explainInputPort, explainOutputPort, type ExplainPort } from './io-explain';
import { MODULE_DOCS } from './module-docs.generated';
import type { ModuleDocs } from '$lib/graph/types';

const MODULE_SOURCES = import.meta.glob('../audio/modules/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// VIDEO module sources — the same `?raw` build-time inline as the audio glob
// above, over the video registry tree. Wiring these into buildModuleManifest
// (additively, alongside the audio sources) is what lights up the video
// /docs/modules/[id] pages; the whole downstream (io-explain, buildDocIndex,
// the route + render) is already domain-agnostic.
const VIDEO_SOURCES = import.meta.glob('../video/modules/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface ManifestPort {
  id: string;
  type: string;
  paramTarget?: string;
  note?: string;
  // Enriched PortDef fields (docs-overhaul §3c) — fed to io-explain so the
  // auto I/O section explains modulation / trigger-vs-gate / type-transparent
  // outputs without a hand-written note. Optional: a port declares only what
  // it needs.
  cvScale?: { mode: 'linear' | 'log' | 'discrete' | 'passthrough' };
  accepts?: string[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}

export interface ManifestParam {
  id: string;
  label: string;
  defaultValue: number | null;
  min: number | null;
  max: number | null;
  curve: string;
  units?: string;
}

export interface ManifestModule {
  file: string;
  sourceUrl: string;
  /** Which registry domain this module was parsed from. 'audio' for the
   *  packages/web/src/lib/audio/modules glob, 'video' for the video glob. */
  domain: 'audio' | 'video';
  type: string;
  label: string;
  category: string;
  description: string;
  maxInstances?: number;
  inputs: ManifestPort[];
  outputs: ManifestPort[];
  params: ManifestParam[];
  /** [leftPortId, rightPortId] stereo-pair tuples declared on the def
   *  (shared across inputs + outputs). Powers the I/O section's stereo
   *  L/R normaling note. */
  stereoPairs?: [string, string][];
  /** Auto-generated human explanations (docs-overhaul §3c). One entry per
   *  port (keyed by port id), produced from the enriched PortDef via
   *  io-explain — the single source of truth the I/O section renders, so it
   *  can never drift from the def. */
  io: {
    inputs: { id: string; type: string; explain: string }[];
    outputs: { id: string; type: string; explain: string }[];
  };
  /** AUTHORED, drift-gated prose (living-docs): behavioral overview + per-input/
   *  output + per-control descriptions. From the def's co-located `docs`, via the
   *  build-time-generated `module-docs.generated.ts` (the page can't import the live registry).
   *  Undefined for modules not yet documented. */
  docs?: ModuleDocs;
}

export interface Manifest {
  generatedAt: string;
  moduleCount: number;
  categories: string[];
  modules: ManifestModule[];
  warnings: string[];
}

const SRC_BASE =
  'https://github.com/2600hz-oscillator/patchtogether.live/blob/main/packages/web/src/lib/audio/modules';

const VIDEO_SRC_BASE =
  'https://github.com/2600hz-oscillator/patchtogether.live/blob/main/packages/web/src/lib/video/modules';

const DESCRIPTIONS: Record<string, string> = {
  analogVco: 'Analog-style oscillator with saw / square / triangle / sine outputs and FM input.',
  es9: 'Full 16×16 audio+CV I/O with a real Eurorack system via the Expert Sleepers ES-9 and the es9-bridge native companion app — every DC-coupled jack individually patchable, with per-jack audio/cv/pitch/gate voltage scaling.',
  colourofmagic:
    'COLOUR OF MAGIC — a multi-colorspace video PROCESSOR. One video IN runs through FIVE parallel colorspace blocks — RGB, YDbDr (the SECAM luma+chroma broadcast space), HSV-or-HSL, YIQ (the NTSC composite space, its orange↔cyan flesh-tone I axis + green↔magenta Q axis), and YCbCr BT.601 STUDIO-SWING (the broadcast-legal 16–235 / 16–240 window whose ~1.16× decode expansion CRUSHES super-black/white like a proc-amp) — each block encoding the picture into that space, adjusting each component, then decoding back to RGB. Every block has, per channel: a BIAS knob (additive offset, identity at 0) that also sums CV patched into its cv input; a MONO OVERRIDE input that REPLACES that channel with an incoming grayscale/video stream (bias still adds on top, so a patched key can still be offset); and an OVER/CLAMP toggle — CLAMP clips out-of-range to 0..1 (a legal clip) while OVER wraps it around via fract() (the LZX chroma-wrap look where over-driven values fold back through the spectrum). Bipolar chroma rides a 0.5 pedestal (YDbDr Db/Dr, YIQ I/Q) or the authentic 128/255 = 0.502 pedestal (studio-swing Cb/Cr); HUE always wraps regardless of its toggle (which is advisory). The third block switches HSV↔HSL. TWENTY-TWO outputs run in parallel: pass (the untouched source); rgb / ydbdr / hsvhsl / yiq / ycc (each block colorized); and per-block grayscale channel taps — r / g / b / luma (RGB), ydb_y/db/dr (YDbDr), hsv_h/s/v (HSV·HSL), yiq_y/i/q (YIQ, its mono I tap a ready-made warmth/skin key), ycc_y/cb/cr (studio-swing). The RGB block also has a palette REPLACE mode: three colour-picker swatches remap the adjusted R/G/B channels to chosen output colours (a duotone/tritone recolour) before the rgb out — picking a swatch auto-enables REPLACE and the swatches default to a non-identity teal/orange/violet so it recolours immediately. Only the outputs you PATCH downstream (plus the one you PREVIEW) are rendered each frame, so the many taps stay cheap. With nothing patched all outputs are opaque black. All colorspace math is a 1:1 mirror of the pure, unit-tested $lib/video/colourofmagic-colorspace core. The card has a live preview (with a 22-way output selector), the five block columns of knobs + OVER/CLAMP pills, the HSV/HSL toggle, and the palette REPLACE swatches; all CV + mono-override jacks + the 22 outputs live in the sectioned yellow drill-down PATCH PANEL (IN / RGB / YDbDr / HSV-HSL / YIQ / YCbCr / OUT, no raw side jacks).',
  sourcery:
    "SOURCERY — a two-input region-transplant recolorizer video PROCESSOR. It edge-detects video A (top) and video B (bottom), segments each edge map into bounded regions (the connected non-edge areas walled off by the detected edges), then for every region in A finds the B region most similar in SHAPE (angles + geometry) first and SIZE second, and paints A's region with B's colors placed at the SAME relative position inside the shape (a corner of A samples the matching corner of B). A B shape may be reused by many A regions and EVERY part of A maps to some region (tiny/culled regions and the edge walls are absorbed into their nearest surviving region, so the output has no holes — the whole-screen background becomes one giant region filled by some B shape). Two global controls move all the transferred color: SKEW rotates the hue of every filled pixel (bipolar, 0.5 = no shift), ROT rotates the sampling frame inside each region (bipolar, 0.5 = no rotation). The look is a shifting stained-glass / photomosaic where A's edge structure is the cell boundaries and each cell is a warped fragment of B chosen by shape similarity; region boundaries are intentionally BLOCKY (segmentation runs at a coarse 128×96 grid, nearest-upscaled) while the colors are full-res sharp. For real-time performance the shape/segmentation stage is temporally amortized (recomputed every few frames) while the color fill sampling live B runs every frame; on live noisy video at low threshold the regions shimmer/boil frame-to-frame (a disclosed v1 limitation). The CCL, moments, Hu shape descriptors, z-score match and rel→uvB transform are a 1:1 mirror of the pure, unit-tested $lib/video/sourcery-core; the two THRESHOLD knobs (each + a CV input) gate A/B segmentation. Patch a structural source into A and a colorful source into B; with nothing in B the module passes A through (hue-skewed only).",
  tempest:
    "TEMPEST (P1) — a Tempest-style vector-tube shooter as a video SOURCE. This phase renders the glowing additive-line \"well\" (the QuadraScan vector look): a bright near rim ring, a dim far pit ring, and radial lane lines, with the player CLAW riding the near rim. The CV input `rim` (0..1, wraps) drives the claw's position around the rim — the authentic rotary-spinner control, e.g. a gamepad joystick axis — and the SHAPE param picks the tube cross-section (circle / square / star). Every line segment is expanded on the CPU into a glowing quad (1px gl.LINES clamp to a dim, dotted stipple on the real GPU), so the web reads solid + luminous at any orientation. `out` is a normal downstream video texture. Enemies, fire, scoring, the audio-breathing tube and the video-textured surface land in later phases; the pure geometry/projection core lives in tempest-core.ts.",
  lushgarden:
    "LUSH GARDEN — generative layered-garden video SOURCE. Assembles a dense 2D English-garden bed from a bank of plant cutouts (flowers/bushes/small trees, ~70/20/10 spawn mix) on a ground plane running from the bottom edge up to an INVISIBLE horizon (the HORIZON knob moves placement geometry only — no line is ever drawn at it). Plants spawn continuously at RATE spawns/sec, grow in from their ground anchor (~350 ms ease-out), scale down with depth (perspective) on top of the tree > bush > flower kind scale, and composite back-to-front; VIEW pans a viewport across a ~2.5-frame-wide world with depth-proportional 2D parallax (near sweeps, far crawls). At the 350-plant cap each spawn replaces the OLDEST plant so the bed keeps evolving. Patch a gate into GROW and continuous spawning stops — exactly ONE plant grows per rising edge ([GATED] badge); a RESET edge clears the bed. FOUR simultaneous outputs render the same scene: CLEAN (plain composite, the card preview), MONO (white silhouette outlines via an alpha-Sobel baked per cutout), WATERCOLOR (colours bled strictly inside each silhouette), PSYCHEDELIC (animated hue-cycled colours, per-plant phase). An optional BACKGROUND video passes through unprocessed behind the plants on all four outputs. Cutouts load lazily from static/lushgarden (manifest-driven; outline+watercolor baked once per cutout at load so the 4 outputs stay cheap; unconnected outputs are skipped). All ports live on the yellow drill-down PATCH PANEL (no raw side jacks, #767).",
  milkdrop:
    'MILKDROP — a Winamp/Milkdrop music visualizer (wrapping the open-source butterchurn WebGL2 engine + ~20 curated classic presets) as a fully CV-instrumented video SOURCE. Patch audio into AUDIO and the visuals react (the tap is inaudible). The novel part: butterchurn drives nearly all preset motion from three audio scalars — bass/mid/treb — and MILKDROP lets a cable REPLACE any of them. Patch CV into BASS/MID/TREB to drive that band from the cable instead of the live audio (an unpatched band still follows the audio); REACT scales all three. SPEED time-warps the engine clock (clamped at 0), PRESET selects the active preset (quantized knob/CV), MORPH sets the crossfade seconds, and a rising edge on NEXT advances presets hands-free. OUT is a normal downstream video texture (route into a mixer / keyer / OUTPUT). The card has a live preview + preset name/index readout + RCT/SPD/PST/MPH knobs, and hide-controls turns it into a resizable monitor. The butterchurn engine lives in node_modules (not vendored into the WebGL attest basis) and the preset pack loads behind a dynamic import() as a separate chunk. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks, #767).',
  archivist:
    'ARCHIVIST — universal Internet Archive (archive.org) media SOURCE. Pick a media type (IMAGE / AUDIO / VIDEO / ANY), type a search term + press Enter, and the card searches archive.org, picks a RANDOM matching item, and loads it; "↻ next" re-rolls another random match from the same results. Optional FROM/TO year-range narrows the search (e.g. 1970–1989). All searching + metadata happen client-side (the archive.org search + metadata APIs are CORS-open, so NO proxy is needed). PER-TYPE OUTPUTS (subject to archive.org CORS on the SERVED file — verified): IMAGE → the still image is uploaded as a CORS-clean WebGL texture on the `image` output (image upcasts to `video` for free, so it can drive video inputs). AUDIO → the clip plays + scrubs and its stereo audio routes out CORS-clean on `audio_l` / `audio_r` (analysable downstream, e.g. into SYNESTHESIA for beats). VIDEO → archive.org does NOT send CORS headers on served video files, so the clip is PLAY-ONLY: it plays + scrubs in the card preview, but the texture would be tainted, so the `video` output is NOT delivered for an archive video (the card shows a "play-only" warning). SCRUBBING for time-media (audio + video): a draggable timeline seeks the playhead, with ±10s skip, a "jump to random position" button (⤭), and an mm:ss readout — robust to archive.org\'s byte-range support (verified: audio + video serve HTTP 206 ranges). GATE/TRIGGER + CV OUTPUTS: `loaded` (trigger — a short pulse each time a new item finishes loading, any type), `ended` (trigger — pulses when a time-media item reaches its end), `playing` (gate — HIGH while a time-media item is playing), and `playhead` (CV — 0..1 normalized playhead position). The `play_trigger` gate INPUT toggles play/pause on a rising edge. PATCHING: all inputs + outputs live in the card\'s yellow drill-down PATCH PANEL (top-left / top-right affordances → INPUT / OUTPUT → grouped Gates / CV / Audio / Video rows) — there are no side jacks. PLAYABLE-FILE PICKING: for video the card prefers an HTML5-playable derivative (h.264 .mp4 → theora .ogv → .webm) chosen by the metadata format token, NOT just the file extension — so an un-decodable MPEG-4-Part-2 / HEVC .mp4 ORIGINAL or an old MPEG-2 / AVI / MOV is skipped; if the picked file still can\'t decode, the card surfaces a "couldn\'t play — skipping" status and AUTO-ADVANCES to the next random match (it never hangs on "Loading"). Only publicly-streamable items are loaded (the query excludes access-restricted / lending / DMCA items). Attribution: the card surfaces the item title + a link to its archive.org details page and labels the source as Internet Archive. A clean VIDEO texture output would require a same-origin streaming proxy (re-serving archive.org video with our own CORS + Range passthrough) — out of scope for v1; image + audio ship with real clean outputs, video ships play/scrub-only with the limitation documented.',
  onetonine:
    'ONE TO NINE — a fixed 3×3 SCREEN SPLITTER. Takes ONE video input and divides it into a 3×3 grid of nine equal sub-rectangles; each grid CELL is exposed on its own video output (out1..out9), magnified to FILL the output frame. Designed to be used ALONGSIDE (but NOT wired to) MAPPY — feed each of up to nine projectors a different ninth of one source. CELL NUMBERING is READING ORDER: 1 = top-left, 2 = top-center, 3 = top-right, 4 = mid-left, 5 = CENTRE, 6 = mid-right, 7 = bottom-left, 8 = bottom-center, 9 = bottom-right. OUTPUT N carries ONLY the content of cell N (a 1/9 sub-rectangle of the input), scaled up to the full output frame — so each output is a low-res CROP of one ninth (expected + fine). The nine outputs are CLEAN crops: no grid lines, no numbers. MONITOR: the module\'s canonical surface (the on-card preview, also the VRT/blit target) shows the input with a 3×3 GRID overlaid and a big readable DIGIT 1..9 drawn in each cell, so the operator can SEE which cell feeds which output. The grid + numbers appear ONLY on the monitor — never in the outputs. GRID toggle: a switch on the card that hides the grid + numbers on the monitor (raw input passthrough) when off; ON by default since the numbered grid is the point of the monitor. No params required beyond the grid toggle (the 3×3 split is fixed). Internally one MONITOR fbo renders the grid+numbers monitor and nine CROP fbos render the clean per-cell crops; the crops are exposed to downstream consumers via read(\'outputTexture:out1\'..\'out9\') (the multi-output escape hatch), the monitor as the canonical surface.texture. The y-UP vUv convention is handled in the pure cellSourceRect math (cell 1 samples HIGH v / LOW u) so cell 1 is genuinely the top-left and the drawn digits render upright. All ports live on the yellow drill-down PATCH PANEL (IN + OUT1..OUT9, no raw side jacks). USAGE: patch a source (CAMERA / a generator / a clip) → IN, read the numbered MONITOR to learn the layout, then patch each OUT N → its destination (a projector via videoOut, a recorder, a mixer). The pure cell→source-rect crop math lives in $lib/video/modules/onetonine (cellSourceRect / cellRow / cellCol), shared by the crop shader, the monitor digits, and the unit tests.',
  outlines:
    'OUTLINES — stateful particle video generator (LZX-style primitive source; formerly CIRCLES, renamed when the SHAPE selector landed). A GATE event (or the internal RATE clock) spawns a SHAPE at a SEEDED-random position in a 1024-px field; each shape latches its diameter / vector / speed / decay / SHAPE at spawn and moves in that direction, BOUNCING when its CENTER-POINT hits a wall (the velocity reflects; no edge/radius collision math for the WALL, so a fat shape may briefly overhang). SHAPE picks one of six forms — circle, triangle, square, pentagon, hexagon, octagon — each polygon a REGULAR N-gon inscribed in the diameter (every vertex on the circle of radius d/2 — the circumradius), so all six share one bounding-circle radius (d/2) and the COLLIDE math is unchanged across shapes. ROTATION is a LIVE GLOBAL bipolar spin: knob CENTER = no rotation, left extreme = fast CCW, right extreme = fast CW; every live shape shares one rotation angle that accumulates by that angular velocity each frame, so the whole field spins coherently and the spin shows up consistently in the rendered geometry AND in every output (the rotated polygon vertices drive the overlap-count the outputs read; a circle is rotation-invariant so only the 5 polygons visibly turn). With the COLLIDE gate HIGH, shapes ALSO bounce off EACH OTHER: a bounding-circle elastic collision — two shapes collide when the distance between their CENTERS ≤ (r1 + r2), i.e. their circumcircles touch (unlike the center-based wall bounce, this uses the radii), and an equal-mass ELASTIC response swaps the velocity components along the center-to-center normal and separates the pair so they don\'t stick (each keeps its independent latched SPEED as far as elastic physics allows). Gate LOW / unpatched → shapes PASS THROUGH each other (the default). COLLIDE is a LIVE GLOBAL mode (read every frame), NOT spawn-latched. The inter-shape pass is O(n²) over the active list, bounded by the 200-shape cap (~10k pair tests/frame). Every per-shape property is LATCHED at spawn from the live knob+CV — crucially SPEED and SHAPE: a shape integrates from its OWN latched velocity (and keeps its own latched form) for its whole life, so turning SPD or SHAPE after a shape exists affects ONLY newly-spawned shapes, never the ones already flying. Model: a JS list of active shapes {x,y,vx,vy,diameter,decayS,ageS,alpha,shape,sides,baseAngle} integrated on the engine rAF. Controls — D: DIAMETER (5..270 px, the circumdiameter); V: spawn VECTOR ANGLE (full range = 0..360°, every angle reachable); SPD: SPEED (0 = static scatter, up to 300 px/s ≈ crosses the field in ~3 s; latched independently per shape); DECAY: per-shape FADE-OUT time — 0 = NO decay (the shape PERSISTS, the static-field case, FIFO-capped) ramping up to a 10 s fade where the shape\'s alpha ramps 1 → 0 and it is removed; SHAPE: the 6-way form selector (circle / triangle / square / pentagon / hexagon / octagon), quantised + latched per shape at spawn; ROT: the bipolar live-global spin (center = still, ± = CW/CCW); RATE: KNOB-ONLY internal clock (0 = spawn ONLY on gate events; turning up spawns faster, hard-capped at 1 shape / 500 ms). Inputs — gate (a rising edge spawns one shape), collide (a LIVE gate: HIGH = shapes bounce off each other elastically, LOW/unpatched = pass through), d / v / spd / decay / shape / rotation (per-param CV; shape latches at spawn, rotation is the live-global spin), video (sampled by the mapped output). Outputs (4, all derived from a per-pixel overlap-COUNT of the active shapes — using the rotated polygon coverage — each shape\'s contribution scaled by its DECAY fade alpha so a fading shape counts less / draws lighter): OVERLAP (mono-video) white wherever ≥1 shape covers the pixel (dimming as the covering shape fades), black else; CONTOUR (mono-video) shape OUTLINES only, ring width = 10% of that shape\'s diameter (min 2 px) so many shapes read as "ripples in a pond" (rings lighten as they decay); COMBINE (colour video) the overlap region colourized by overlap COUNT through a hue ramp (1 overlap = one hue; 2,3,4… cycle the spectrum) with brightness + saturation rising as more shapes stack and dimming as the stack fades; MAPPED (colour video) shows the VIDEO input\'s contents wherever ≥2 shapes overlap, black elsewhere. Bounded sim: shapes bounce forever and accumulate, so a hard cap of 200 active shapes culls the OLDEST first (a safety net even with DECAY) to keep per-frame cost bounded. Determinism: the random spawn position + each shape\'s seeded initial rotation angle come from a seeded mulberry32 PRNG (fixed default seed; never Math.random), so VRT / per-port / behavioral sweeps are reproducible. Usage: patch a clock/sequencer GATE in (or just turn RATE up) and route OVERLAP / CONTOUR to a SCOPE or mono consumer, COMBINE to OUTPUT for the coloured stack, and a video source → VIDEO in + MAPPED → OUTPUT to punch that source through the ≥2-overlap region. Pick a SHAPE for the spawn (polygons + ROTATION give kaleidoscopic spinning-outline fields), leave DECAY at 0 for an accumulating static field or turn it up for a trail/dissolve look, and gate the COLLIDE input HIGH (any clock/gate/LFO over the high threshold) to switch the field from a soft overlapping wash into a billiards-like cluster where the shapes knock each other around.',
  pentemelodica:
    'Five-voice polyphonic analog-style synth. A POLY input (the polyPitchGate chord bus from MIDI LANE / POLYSEQZ / a chord sequencer) drives five band-limited VCO voices — lane i → voice i — each with TUNE (±36 st) / FINE (±100 ¢) / exponential FM / through-phase PM / pulse width and a continuous tri→saw→square WAVE morph. Each voice has its own gated amplitude envelope, but the A/D/S/R is SHARED across all five voices (one device-level ADSR; aligned with CUBE / WAVECEL / DX7); the gate edge comes from that voice\'s poly lane, and a released voice holds the played pitch through its release tail. The five post-envelope voices sum through a stereo mixer (per-voice LEVEL + equal-power PAN) and an embedded multimode filter — a continuous LP→BP→HP→Notch MODE dial on a TPT state-variable filter (CUTOFF / RESONANCE) with a WET/DRY bypass — to the stereo OUT_L / OUT_R pair. Each voice is also tapped pre-mixer (post-envelope) to a VOICE1..VOICE5 mono output, and each voice has its own audio-rate FM jack (fm1..fm5) that feeds both its FM and PM depths. 48 panel params (5 voices × 8 + 4 shared ADSR + 4 filter). DSP is own-code: a clean-room polyBLEP band-limited oscillator, a Cytomic/Zavalishin TPT state-variable filter, and a linear-ADSR envelope — not a port of any copyleft source (permissive only).',
  moog905:
    '905 Spring Reverberation (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). The classic spring-tank reverb: metallic, dispersive, with the characteristic "boing"/chirp on transients. In-house dispersive-allpass spring model — a cascaded all-pass chain (the dispersion) feeding a modulated feedback delay with damping. MIX blends dry/wet, DECAY sets the tail length, SIZE the spring length/character. Own-code (clean-room; feedback-clamped for stability). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog960:
    '960 Sequential Controller (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). A 3-row x 8-step analog step sequencer. Each column has a knob per row (24 step pots); on each advance every row outputs its current column value as CV (row1/row2/row3), scaled by that row\'s RANGE (x1/x2/x4). Steps advance on an external CLOCK input (rising edge) or, when unpatched, an internal RATE clock; CLOCK OUT pulses each advance. Per-column NORMAL/SKIP/STOP switches skip a column or halt the run; START/STOP gate inputs reset/halt. v1; per-step trigger jacks, third-row-controls-timing, x2 parallel outs + 1V/oct clock CV deferred. Own-code (forks the repo sequencer). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog911a:
    '911A Dual Trigger Delay (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). Two trigger delays for staggering envelope generators. Each trigger input fires its output after a DELAY time (2 ms..10 s log). A MODE switch sets coupling: OFF (independent — trig1->out1, trig2->out2), PARALLEL (trig1 fires BOTH delays), SERIES (trig1 fires delay1->out1, whose pulse then fires delay2->out2). Own-code timing (clean-room). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog961:
    '961 Interface (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). A trigger-format converter / interface: audio crossing the SENSITIVITY threshold fires V-triggers (two parallel outs); an S-trigger input passes through to the V-trigger outs; and V-trigger inputs convert to S-trigger outs — one matching the input gate duration, one re-shaped to a fixed SWITCH-ON-TIME pulse (40 ms..4 s). (In our graph all triggers are gates; the S/V polarity distinction is cosmetic — the timing behaviors are modeled.) Own-code. Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog962:
    '962 Sequential Switch (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). Routes one of up to three signal inputs to a single output, advancing to the next input on each SHIFT (V-trigger) rising edge — a gate-advanced selector (shares the FOURPLEXER selector logic, trimmed to 3-in/1-out). STAGES sets how many inputs are cycled (2 or 3). Own-code. Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog912:
    '912 Envelope Follower (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). Tracks the amplitude envelope of an audio input and outputs it as a control voltage, plus a gate when the envelope is above threshold. SENSITIVITY sets the input drive; SMOOTHING sets how fast the envelope tracks (envelope-detector lowpass). Pure Web Audio (rectify -> lowpass -> CV; threshold -> gate). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog903a:
    '903A Random Signal Generator (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). Passive white + pink noise source with two independent audio taps (WHITE = flat spectrum; PINK = -3 dB/oct, Voss-McCartney), scaled by a single LEVEL knob. No inputs. Own-code (public-domain noise technique). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog923:
    '923 Filters / Noise Source (moogafakkin System 35 clone — categorized under Ports -> moogafakkin). White + pink noise outputs PLUS a fixed filter utility on an external audio input: independent low-pass and high-pass taps with LO PASS / HI PASS cutoff knobs (log-mapped ~40 Hz-20 kHz). Own-code (noise generator + biquad filters). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog904c:
    '904C Voltage Controlled Filter Coupler (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). Chains an internal moogafakkin-ladder low-pass + high-pass into a CV-controlled BAND-PASS / band-reject: CUTOFF, WIDTH (LP/HP spread) and MODE (BP to BR) knobs plus a 1V/oct cutoff CV input. DSP composes two ladder instances (own-code clean-room ladder). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog907a:
    '907A Fixed Filter Bank (moogafakkin System 35 clone — categorized under Ports -> moogafakkin). Non-VC fixed filter bank: a high-pass + low-pass + several fixed center-frequency band-pass cells (12 dB/oct), each with its own level knob, summed to one output. Shares the moog-filterbank center-frequency lib with the 914. Own-code (textbook biquad bank). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog914:
    '914 Extended-Range Fixed Filter Bank (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). The extended fixed filter bank: 1 high-pass + 1 low-pass + 12 fixed center-frequency band-pass cells (12 dB/oct), each level-knob-controlled, summed to one output. Shares the moog-filterbank center-frequency lib with the 907A. Own-code (textbook biquad bank). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog992:
    '992 Control Voltage Panel (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). A passive CV summer/attenuator: four CV inputs each pass through a per-channel ATTENUATOR (0..1) into a common summing bus (cv_out). Channel 4 is SIGNAL-INVERTING — its attenuator subtracts from the sum — so the panel can both add and cancel control voltages. No audio path; pure CV math (own-code, permissive). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog993:
    '993 Trigger & Envelope Voltages Panel (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). A passive routing patch-bay: two S-trigger inputs (FROM 1 / FROM 2) feed three trigger outputs, each output independently selecting OFF / FROM 1 / FROM 2 via its ROUTE switch; two envelope-CV inputs pass straight through to two envelope outputs. Routing logic only (own-code, permissive). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog994:
    '994 Dual Multiples (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). Two independent passive MULTIPLES: each input is fanned out unaltered to three paralleled outputs (a_in -> a1/a2/a3, b_in -> b1/b2/b3). Type-agnostic — splits audio or CV alike. No knobs, no DSP (a unity passthrough split in the factory). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog995:
    '995 Attenuators (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). Three independent passive variable ATTENUATORS, each input -> level knob (0..unity) -> output. Reduces control or audio amplitude (own-code per-channel gain, permissive). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog984:
    '984 4-Channel Matrix Mixer (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). A 4-in x 4-out matrix: each of the 16 cross-points (m_ij) has an independent level knob, so any input can be summed into any output at any amount (out_j = sum over i of in_i * m_ij). Cross-points default to 0 (a fresh matrix is silent until dialed). Own-code gain matrix (permissive). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  polarizer:
    'POLARIZER — a tiny 1-in / 1-out CV utility that converts a UNIPOLAR control voltage to a BIPOLAR one. Model: out = (2·in − 1) · DEPTH — it takes a [0, 1] input and stretches it across [−1, +1]. Computed sample-accurately by a pure Web Audio graph (a GainNode for the scale + a started ConstantSourceNode → GainNode for the offset, both summed; no worklet, no DSP build). Controls — DEPTH: the single bipolar-swing knob, range 0..1 on a LINEAR taper; default 1.0 = the FULL ±1 conversion (in=0 → −1, in=0.5 → 0, in=1 → +1), 0.5 → ±0.5, 0 → flat 0. DEPTH scales the swing symmetrically about 0, so the output always stays centered on 0 as you trim it. IO — IN (cv): the unipolar (0..1) control voltage to polarize (the affine map is defined for any value, it just linearly centers + scales); OUT (cv): the bipolar result, out = (2·in − 1)·depth. This is the bipolar counterpart of a unipolar envelope output (e.g. SYNESTHESIA\'s 0..1 follower). All patching is via the card\'s yellow drill-down PATCH PANEL (top-left / top-right affordances → INPUT / OUTPUT) — no side jacks. DEPTH is MIDI / control-surface assignable (right-click → MIDI Learn) like every other knob. Usage: patch a 0..1 envelope / LFO / sequencer CV through it to get a ±1 modulation source that can both RAISE and LOWER a destination (e.g. drive a filter cutoff above AND below its rest point from a unipolar envelope); pair with DEPOLARIZER for the round trip.',
  depolarizer:
    'DEPOLARIZER — a tiny 1-in / 1-out CV utility: the reverse of POLARIZER, converting a BIPOLAR control voltage back to a UNIPOLAR one. Model: out = 0.5 + DEPTH · (in / 2) — it folds a [−1, +1] input into [0, 1]. Computed sample-accurately by a pure Web Audio graph (a GainNode for the scale + a started ConstantSourceNode → GainNode for the fixed +0.5 center, both summed; no worklet, no DSP build). Controls — DEPTH: the single knob, range 0..1 on a LINEAR taper, sets how far the output DEPARTS from the 0.5 CENTER; default 1.0 = the FULL conversion (in=−1 → 0, in=0 → 0.5, in=+1 → 1), 0.5 → output swings only 0.25..0.75, 0 → flat 0.5. DEPTH attenuates only the DEVIATION from center (it scales the slope, not the offset), so the output always rests at the 0.5 unipolar center with nothing patched or at DEPTH 0 — the natural "neutral" value. IO — IN (cv): the bipolar (−1..+1) control voltage to depolarize (the affine map is defined for any value); OUT (cv): the unipolar result centered on 0.5. All patching is via the card\'s yellow drill-down PATCH PANEL — no side jacks. DEPTH is MIDI / control-surface assignable (right-click → MIDI Learn). Usage: feed a bipolar LFO / sequencer / ±1 modulation source into a destination that expects a 0..1 CV (a level / depth / mix-knob CV), with DEPTH trimming the modulation amount around the 0.5 rest point; the inverse of POLARIZER for the round trip.',
  scaler:
    'SCALER — a tiny 1-in / 1-out signal multiplier (a fixed-gain VCA-without-CV / "gain trim" utility). Model: out = in × AMOUNT, computed sample-accurately by a single Web Audio GainNode (no worklet, no DSP build). Controls — AMOUNT: the single scale-factor knob, range ×0.1 .. ×10 on a LOG taper so unity (1.0) sits at the knob CENTER and the cut/boost is symmetric (left extreme = ×0.1, right extreme = ×10); default 1.0, so a freshly spawned SCALER passes a direct patch through unaltered until you dial it. Below 1.0 it ATTENUATES (down to a tenth), above 1.0 it BOOSTS (up to ten times) — unlike a passive attenuator (which only cuts, 0..1), the SCALER can also amplify. IO — IN: the signal to scale (typed audio so it interops with audio cables directly, and widened to accept the CV family so a CV / gate / pitch source can be scaled too — it is just a multiply, valid for either signal class); OUT: the scaled signal (out = in × amount). OUT is TYPE-TRANSPARENT: its cable type ADOPTS whatever is patched into IN — a CV source makes OUT emit CV, an audio source makes it emit audio (it falls back to audio when nothing is patched). This matters when SCALER feeds a VIDEO module: a CV stays CV through the audio→video bridge so AMOUNT actually scales the modulation, instead of being read as audio (which the bridge envelope-follows and clamps, making the knob do nothing). All patching is via the card\'s yellow drill-down PATCH PANEL (top-left / top-right affordances → INPUT / OUTPUT) — no side jacks. AMOUNT is MIDI / control-surface assignable (right-click → MIDI Learn) like every other knob. Usage: drop one inline on any audio or CV cable to trim level or boost a quiet source; scale an LFO / envelope / sequencer CV up or down before it modulates a destination; or use it as a simple makeup-gain stage after an effect.',
  featurecv:
    'FEATURECV — an audio→CV feature extractor. Takes ONE audio input and turns the WHOLE signal\'s timbre + dynamics into control voltages plus an onset trigger, time-domain only (no FFT) so it is fully deterministic. Deliberately distinct from SYNESTHESIA (per-band energy/gates/onsets); featurecv analyses the broadband signal. Features — LOUD (cv): broadband RMS = overall loudness/energy. BRIGHT (cv): zero-crossing rate, a cheap spectral-brightness proxy (high = hissy/trebly, low = dark/bassy). PUNCH (cv): crest factor (peak ÷ RMS) = how spiky/transient vs sustained/compressed. ONSET (gate, edge=trigger): a short pulse that fires ONCE on each fresh attack/transient (time-domain spectral-flux peak-pick with an adaptive threshold + debounce). The three feature CVs are emitted BIPOLAR (−1..+1) by DEFAULT so a strong feature sweeps a knob-centred destination\'s FULL range; the POLARITY toggle switches to UNIPOLAR (0..1) for envelope-style modulation. Controls — GAIN: input trim into the analyser (×0.25..×4 log, unity at noon). ATK / REL: attack + release smoothing (ms, log) of the three feature CVs. POLARITY: BI [-1,+1] (default) / UNI [0,1]. SENS: onset sensitivity (linear; higher fires on smaller transients). DEBNCE: onset debounce (ms, log; minimum gap between triggers). DSP is own-code (clean-room) in packages/dsp/src/lib/featurecv-dsp.ts, reusing the synesthesia EnvFollower one-pole + applyBipolar + the time-domain flux-onset idea; the worklet wraps it (the SYNESTHESIA/SPECTROGRAPH analyser pattern: GAIN GainNode → worklet → per-feature output GainNodes + a muted keep-alive so process() runs while outputs are unpatched). The card shows live LOUD/BRIGHT/PUNCH meters + an ONSET blink (display only — never writes the live Y.Doc). All patching is via the card\'s yellow drill-down PATCH PANEL — no side jacks; every knob is MIDI / control-surface assignable. Usage: patch LOUD into a VCA/filter to track dynamics, BRIGHT into a filter cutoff so the timbre opens as the source brightens, PUNCH into modulation that should react to transients, and ONSET into an envelope generator or drum voice to fire on each hit.',
  flipper:
    'Gate flip-flop. Two gate inputs and two gate outputs (FLIP, FLOP). A gate on EITHER input alternately fires FLIP, then FLOP, then back — the first gate after load fires FLIP. While a gate is high it is mirrored to the currently-selected output (keeping the trigger width) and the other output stays silent. Use it to split one trigger stream into two alternating streams (e.g. ping-pong two envelopes / two voices).',
  synesthesia:
    'Audio→video event processor modeled on the LZX Sensory Translator — two independent copies (A/B), each switchable between AUDIO and VIDEO mode. In AUDIO mode a copy splits its mono input into 4 MUSICAL spectral bands (bass 20–200 / low-mid 200–1k / high-mid 1k–4k / treble 4k+ Hz) so a drum kit lands cleanly across the bands (kick→band1, snare→band2/3, hats→band4). In VIDEO mode the 4 lanes become the R/G/B/Luma channels of a patched video frame (a_video_in / b_video_in cross-domain inputs): the card averages the frame to per-channel 0..1 levels (solid red maxes R, solid white maxes all incl. luma). In BOTH modes each lane derives a gained audio/CV tap, slow (500 ms) + fast (50 ms) envelope-follower CV (real ~2/40 ms attack so a kick onset hits the band CV hard + locked to the transient, without strobing video), boosted by a per-band CV makeup gain so a STRONG kick drives the bass CV to (near) full scale — patch it into a continuous CV input (e.g. OUTLINES rotation) and a strong kick runs the whole range. A hysteresis gate (keyed off the un-boosted envelope, so its timing + the gibribbon game feel are unchanged), a per-band BEAT TRIGGER (a ~10 ms pulse from a spectral-flux onset detector with an adaptive threshold + 80 ms debounce — fires once per kick/snare/hat, NOT continuously on a sustained tone), a 10-bar green→red VU meter, and a mono-video raster. Master gain (0.5–1.5×) sets the floor; per-band gain (1–2×) adds on top. A per-band ENV-OUTPUT DEPTH knob (8 = 2 copies × 4 bands, range 0..2, default 1× = unchanged) scales BOTH that band\'s env CV outputs (env_slow + env_fast) together — the source-side modulation-depth control: turn it down (0 = silenced) to tame a band\'s envelopes, or up (toward 2×, clamped at the 0..1 CV ceiling) so even a weak band reaches full modulation depth at the SOURCE. It only touches the two env CV outputs — gate / beat-trigger / band-audio / VU are unaffected. Patch a band trigger into a video switch/flash to cut video on the beat; patch the slow envelopes for smooth colour modulation.',
  wavetableVco:
    'Wavetable oscillator that morphs saw -> square -> triangle -> sine across a 16-frame table.',
  moog921Vco:
    '921 voltage-controlled oscillator (first module of the moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). Faithful to the original 921: ONE oscillator core presents FOUR simultaneous waveform jacks — sine, triangle, sawtooth, and rectangular with variable pulse width — all phase-coherent off the shared core. Pitch input is exponential 1V/oct (0V = C4); a dedicated LINEAR frequency-control input (lin_fm, scaled by the Lin FM depth) gives through-zero-style linear FM; a sync input drives the hard/soft/off SYNC switch (-1 soft / 0 off / +1 hard) for classic sync timbres. RANGE sets the coarse octave (+/-5 oct), FREQ the fine tune (+/-12 st), WIDTH the rectangular duty cycle (with audio-rate width_cv), LEVEL the output gain. DSP is own-code: a clean-room polyBLEP/polyBLAMP band-limited oscillator (not a port of any moogafakkin schematic or copyleft source - permissive only). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moogCp3:
    'CP3 / CP3A Console Panel — the console mixer slice of the moogafakkin System 55/35 clone (categorized under Ports -> moogafakkin). A multi-function console: (1) a 4x1 summing mixer that presents a (+) output AND a (-) phase-inverted output simultaneously, max per-channel gain x2 (0.5 = unity, 1.0 = x2), mixing AC and/or DC voltages (audio AND cv alike — the per-sample sum is polarity- and DC-transparent); (2) the 4th input adds an EXTERNAL jack (ext4) plus an ATTENUATOR — at "10" (1.0) the attenuator is unity so a direct patch passes through unaltered; (3) a MULTIPLE — input 1 fanned out unaltered to three passthrough outs (1 -> 3); (4) trunk/reference jacks supplying a constant +12V and -6V reference (scaled into the project normalized CV convention). Four 25K-LIN input level knobs (shown 0-10) + the 4th-input attenuator. DSP is own-code: a forked + expanded version of the repo mixer (not a port of any moogafakkin schematic or copyleft source — permissive only). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family). v1 omits the CP3A trunk/routing-switch matrix (the reference jacks are modeled as constant sources); the switch matrix is a planned follow-up.',
  moog904a:
    '904A Voltage Controlled Low Pass Filter (slice 2 of the moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). The classic moogafakkin transistor-LADDER low-pass filter, 24 dB/oct. Cutoff is set by the FIXED CONTROL VOLTAGE (Cutoff) pot, shifted in 2-octave steps by the RANGE switch (1/2/3 = x1/x4/x16), and swept by the summing 1V/oct CONTROL INPUT (cutoff_cv — each volt = one octave, summed per-sample). REGENERATION is the variable Q / internal feedback: at low settings it is a clean low-pass; turned toward max it sharpens into a strong resonant peak and SELF-OSCILLATES into a clean sine VC oscillator at the cutoff frequency (reso_cv modulates it). Signature moogafakkin growl comes from a tanh saturation per ladder stage that also self-limits the resonance so it stays bounded. DSP is own-code, CLEAN-ROOM: a TPT/Zavalishin zero-delay-feedback ladder (stable under audio-rate cutoff modulation) re-derived from the unpatented textbook algorithm plus the Huovilainen tanh-per-loop technique — NOT a port of the LGPLv3 Huovilainen code, the CC-BY-SA musicdsp model, or any moogafakkin schematic (permissive only). The shared moog-ladder-dsp lib it is built on is reused by the 904B (HPF) + 904C (coupler) in later slices. Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog911:
    '911 Envelope Generator (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). NOT a literal ADSR: a three-time-constant CONTOUR generator with a single sustain LEVEL. On S-trigger (gate high) it ATTACKS over T1 from 0 to the peak (1.0), INITIAL-DECAYS over T2 down to ESUS (the sustain level), then HOLDS at ESUS while the gate is held; on release (gate low) it FINAL-DECAYS over T3 back to 0. Trigger-close forces the T3 final-decay stage regardless of which stage was running, so a short trigger that releases mid-attack still decays over T3 from wherever it reached. T1 / T2 / T3 each span up to 10 s (log knobs); ESUS is a linear 0..1 level. Outputs the unipolar 0..1 contour on env plus an inverted tap (1 - env) on env_inv for ducking / sidechain modulation. CV inputs (t1_cv / t2_cv / t3_cv log-scaled, esus_cv linear) sweep each control. DSP is own-code: a clean-room exponential-segment contour generator (not a port of any moogafakkin schematic or copyleft source - permissive only). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog902:
    '902 Voltage Controlled Amplifier (slice 3 of the moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). The classic moogafakkin DIFFERENTIAL VCA. A SIGNAL input is multiplied by a gain driven by a CONTROL SUM measured in volts: the manual GAIN pot ("fixed control voltage", 0..6 V) + the summing CONTROL INPUTS (cv, scaled by the CV-amount knob + sign) + a fixed-control-voltage bias input (fcv). Overall gain is x2 (+6 dB) at pot-max OR at CV = 6 V, and reaches its x3 ceiling near a control sum of ~7.5 V. The LIN / EXP RESPONSE switch picks the gain law: LINEAR rises linearly with the control voltage (6 V -> x2); EXPONENTIAL passes through the same x2 at 6 V then climbs faster, hitting x3 near ~7.5 V (the snappier VCA feel). Two complementary outputs form the differential pair: OUT (the amplified signal) and OUT- (audio_inv, its sample-accurate phase-inverted twin) — handy for stereo widening, sidechain feedback prevention, or mid/side work without a separate inverter. DSP is own-code: an amplifier gain law forked from the repo\'s own vca, re-implemented with the added exponential branch + the moogafakkin x2-at-6V / x3-ceiling scaling (not a port of any moogafakkin schematic or copyleft source - permissive only). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog921a:
    '921A Oscillator Driver (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). A CONTROL-VOLTAGE PROCESSOR, NOT a sound source: it generates the two control voltages on a bus that drive N slaved 921B oscillators — a frequency CV (freq_bus, V/oct, encoding pitch) and a pulse-width CV (width_bus, 0..1). The FREQUENCY pot is mapped onto V/oct by a two-position frequency-RANGE switch — SEMITONE (a tight 2-octave fine compass) or OCTAVE (a wide 12-octave coarse compass). Summing FREQ + WIDTH CONTROL INPUTS add onto the buses per-sample (freq_cv is a V/oct pitch cable that sums 1:1 onto freq_bus; width_cv sums onto width_bus). NO audio inputs and NO audio outputs — the outputs are CV cables that feed a 921B\'s freq_bus / width_bus. DSP is own-code: pure CV math (exponential frequency mapping + width passthrough), not a port of any moogafakkin schematic or copyleft source - permissive only. Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family). Ships together with the 921B (the 921A is meaningless without a slaved 921B).',
  moog921b:
    '921B Oscillator (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). The slaved VCO driven by a 921A bus: it reads freq_bus (V/oct pitch) + width_bus (pulse width) CONTROL INPUTS from a 921A rather than carrying its own 1V/oct jack, and presents FOUR fixed-level simultaneous waveform outs off one common core — sine, triangle, saw, rectangular — across 1 Hz–40 kHz. The FREQUENCY pot is a 2-octave fine trim; the RANGE switch sets the octave footage; DC MODULATE is DC-coupled LINEAR FM (non-1V/oct, ±Hz); AC MODULATE is cap-coupled LINEAR FM (a DC-blocking high-pass runs first so a DC offset on the modulator doesn\'t bend the pitch); the SYNC input + 3-position SYNC switch (off / lo=soft / hi=hard) drive oscillator sync. With nothing patched the bus normals to C4 @ 50% duty so the 921B still sounds standalone, but it is designed to be driven by a 921A driver. DSP forks the shared own-code moogafakkin VCO core (clean-room polyBLEP/polyBLAMP band-limited oscillator + hard/soft sync, the same core the 921 VCO uses) - not a port of any moogafakkin schematic or copyleft source, permissive only. Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  moog904b:
    '904B Voltage Controlled High Pass Filter (moogafakkin System 55/35 clone — categorized under Ports -> moogafakkin). The high-pass companion to the 904A LPF: a 24 dB/oct transistor-LADDER HIGH-pass, built (like the hardware) by SUBTRACTING the ladder\'s low-passed signal from the input (input - lp4 -> the complementary 4-pole high-pass). Cutoff is set by the FIXED CONTROL VOLTAGE (Cutoff) pot, shifted by a two-position RANGE switch (LOW = the full 4 Hz–20 kHz span / HIGH = +1.5 octaves), and swept by the summing 1V/oct CONTROL INPUT (cutoff_cv — each volt = one octave, summed per-sample). Unlike the 904A there is NO regeneration / resonance knob (the hardware 904B has no resonance pot), so the ladder runs with zero feedback. DSP is own-code, CLEAN-ROOM: it CONSUMES the same shared transistor-ladder core the 904A uses (TPT/Zavalishin zero-delay-feedback ladder via its hpDerive high-pass tap) — NOT a port of the LGPLv3 Huovilainen code, the CC-BY-SA musicdsp model, or any moogafakkin schematic (permissive only). Beige moogafakkin faceplate (the intrinsic always-on look shared by the moogafakkin module family).',
  audioOut:
    'Terminal stereo output. Two mono inputs (L, R) routed to the host AudioContext destination. Optional output-device dropdown via setSinkId (Chromium 110+).',
  audioIn:
    'System audio input source. Stream from a user-selected mic/line-in/interface via getUserMedia; L+R outputs are fanned out from mono sources or split from stereo. Card owns the permission prompt + device dropdown + devicechange refresh.',
  vca: 'Voltage-controlled amplifier. Multiplies the audio input by base + (cv * cvAmount).',
  mixer: 'Four-channel mono summing mixer with master gain.',
  adsr: 'Gate-triggered attack-decay-sustain-release envelope. Outputs CV.',
  filter:
    'Multi-mode resonant filter (low / band / high). CV inputs sum into cutoff and resonance.',
  reverb: 'Algorithmic reverb. Size / damp / mix.',
  ringback:
    'Stereo crush effect — the TWOTRACKS record-time artifact, extracted and made intentional. While TWOTRACKS fresh-records it writes the live input into INTEGER ring-buffer cells (sample-quantized) at a fractional, varispeed write/read cursor, then reads those same cells back with LINEAR INTERPOLATION at the fractional cursor; the integer-cell write versus the interpolated read makes the read-back a decimated, aliased copy of the input — a metallic "bitcrushed" tone. (That read-back used to leak into TWOTRACKS\' monitor while recording, which was a bug; RINGBACK packages the EXACT same mechanism as a deliberate effect.) Stereo in (L IN / R IN) → stereo out (L OUT / R OUT); a mono input is mirrored to both channels. Two independent ring channels (L + R) run the per-sample loop: read = interp(buf, cursor); write buf cells [cursor, cursor+RATE) = input + FEEDBACK·read; cursor += RATE (wrapping the small ring); out = (1−MIX)·input + MIX·read. Four knobs expose the character, all derived directly from the mechanism: RATE (0.05..4, default 0.5) is the write/read cursor advance per sample and the "amount" of the artifact — 1 is the mildest, below 1 the read-back stair-steps and aliases hardest; SIZE (2..4096 samples, default 64, log) is the ring length — a few samples ring like a comb/short metallic resonance, larger sizes become a grainy short-delay smear; FEEDBACK (0..0.98, default 0.3) re-injects the read-back into the ring (the regen "ring" tail), clamped strictly below 1 so it can never self-amplify to infinity; MIX (0..1, default 1) is the dry/wet blend between the clean input and the crushed read-back (0 passes the input through unchanged). The DSP is pure and deterministic (no RNG, no time dependence) so it is stable for VRT/ART; the worklet runs the shared RingChannel core in ringback-core.ts (unit-tested), the same no-mirror discipline as the TWOTRACKS engine. Patch any stereo (or mono) source through it for lo-fi grit, comb-ring resonance, or — at high feedback and small size — a self-oscillating metallic drone.',
  scope:
    '2-channel passthrough oscilloscope. Inputs flow unchanged to outputs while an AnalyserNode samples for display.',
  dockscope:
    'Slim 1u single-trace oscilloscope built for the workflow dock rails — the trace is vector-redrawn at live on-screen pixel size so it stays crisp at every dock zoom step. Terminal visualiser: ch1 in (accepts audio/CV/pitch/gate), no outputs.',
  rasterize:
    'Audio -> video raster mapper. Each video frame paints a fixed run of audio samples (samples/frame, ~800 at 48k/60fps) as voltage-per-pixel into the 640x480 frame in raster order; a scan cursor drifts + wraps through the frame. Faithful raster mapping (NOT an oscilloscope trace) - a steady tone paints drifting horizontal bands whose spacing tracks the audio frequency vs the line/frame rate. Fully untamed: no limiter, no anti-alias.',
  sequencer: '32-step sequencer with internal BPM clock or external clock input. An upper-right S&H toggle (ON by default) bakes in a gate-sampled Sample & Hold on the pitch CV: the pitch output is (re)written only on a gated step, so it LATCHES to the gate edge and HOLDS constant between gates (no external S&H needed). Turn S&H OFF for the legacy continuous behavior where pitch can drift/reset on rests.',
  lfo: 'Clockable LFO with four phase outputs (0deg / 90deg / 180deg / 270deg).',
  ninelives: 'LFO with NINE CV outputs on a geometric 1/3 rate ladder + a reset trigger. out1 runs at the Rate knob (identical to a normal LFO); each subsequent output is 1/3 the rate of the previous, so out_n = rate * (1/3)^(n-1) — out2 = rate/3, out3 = rate/9, ... out9 = (1/3)^8 = rate/6561 (~0.0001524x). All nine taps share ONE Waveform morph (sine -> saw -> square). A rising edge on RESET re-zeroes every phase so all outputs re-sync to phase 0 together. Ports live on the yellow drill-down PATCH PANEL (no raw side jacks).',
  cartesian: '4x4 grid sequencer. Steps via clock; X/Y CV inputs scrub freely across the grid. An upper-right S&H toggle (ON by default) bakes in a gate-sampled Sample & Hold on the pitch CV: in the clock-UNPATCHED X/Y-tracking mode the pitch+gate re-emit is suppressed while the prior gate is still high, so the pitch CV latches to the gate edge and holds (the visual playhead still tracks continuously). The clock-PATCHED mode is already gate-sampled. S&H applies to PITCH only — the free-running quadrature LFO (lfo_x/lfo_y) is never held. Turn S&H OFF for legacy continuous re-emit on every pad change.',
  destroy: 'Bitcrusher + decimator distortion.',
  qbrt: 'Stereo state-variable filter with vactrol-style ping input.',
  drummergirl: 'Gate-triggered drum voice (kick / snare / hat morph).',
  meowbox:
    'Gate-triggered cat-vocal synth voice (formant bank + harmonic + noise excitation).',
  mixmstrs:
    '6xstereo mixer with EQ, per-channel compressor (single-dial macro + power-user thresh/ratio), two stereo aux sends/returns, per-channel post-fader VU taps (read(\'levels\') → number[6]). Multiple instances allowed. 61 params.',
  tidyVco:
    'TIDY VCO — flagship virtual-analog SUBTRACTIVE SYNTH VOICE: two polyBLEP oscillators with a continuous saw↔pulse SHAPE morph per osc, shared PW + audio-rate PWM CV, OSC2 octave switch + cents detune, and a −1-octave sub square, into an ALL-NEW nonlinear zero-delay-feedback DIODE LADDER filter (EMS VCS3 / TB-303 lineage — bidirectionally-coupled stages, soft warm knee into 24 dB/oct, feedback squelch limiter for a bounded near-sine self-oscillation, CUTOFF calibrated to the resonant pitch within 3 cents so keytracked self-osc plays in tune, DRIVE tanh saturation at 2× oversampling, part-compensated squelch bass dip). Two RC-curve "punch" ADSRs (CEM3310-style exponential segments, overshoot-target convex attack, analog resume-from-level retrigger): a filter EG with bipolar ±4-octave ENV amount + keytracking, and an amp EG into an OTA-flavored soft-knee VCA whose tanh bias blooms gentle even harmonics with level. 5-voice POLY on the polyPitchGate chord bus (lane i → voice i, release tails hold their pitch) AND a mono pitch/gate pair driving a REAL 2-voice unison (±7¢·WIDTH drift panned to opposite sides — true stereo beating); WIDTH also fans the poly voices across the stereo field (root anchored center). Stereo out_l/out_r pair (auto-wires R when L is patched), HOLD pad for droning the voice from the card, and a CV jack for EVERY control (27 inputs): the six original CVs — cutoff (4 oct/V, audio-rate), res, pwm (audio-rate), drive, fold (audio-rate), sym (audio-rate) — PLUS a GLOBAL block-rate per-knob CV for each remaining control: shape1/shape2/mix/sub/fsus/sus/track/width (0..1 full-swing), detune (±50¢), oct2 (discrete ±1 step/V), env (±4-oct bipolar), the six EG times (4 oct/V), and level (±18 dB/V). Every law is scaled in the shared core (lib/tidy-vco-dsp.ts) so cv = 0 is a byte-exact no-op. The rear patch panel groups its jacks into OSC·WAVEFOLD·DIODE FILTER·FILTER EG·AMP EG·OUT·POLY/OUT sections mirroring the card headers.',
  timelorde: 'Singleton master clock. Internal or external BPM, twelve clock-divider outputs. A TAP button sets the internal tempo by ear — tap twice in time to lock the BPM, keep tapping to refine it (median of the recent intervals, ~2s timeout starts a fresh count); the Spacebar taps it too while TIMELORDE is the selected node. TAP is greyed out and a no-op while an external clock is patched into CLOCK IN (the measured external tempo owns the BPM then). The card carries a big display of the owl painting whose YELLOW EYES and BLUE BORDER brighten in time with the beat (the body stays steady); patch a feed into VIDEO IN and the display becomes a live monitor while VIDEO OUT passes the feed through (TIMELORDE can sit inline in a video chain).',
  toybox:
    'Multi-layer video compositor. FOUR layers, each rendered into its own framebuffer then reduced to the output by a combine DAG (fade / lumakey / chromakey / map). A layer kind selects its source: GEN = a generative fragment-shader content entry from the bundled bank (noise-fbm domain-warped simplex FBM, worley-cells animated cellular noise; the FX hsv-plasma / cos-gradient palette shaders; the SHADERTOY synthwave-sunset port) with iTime + iResolution + its declared float params on faders — NO scene input. FRAG = a Shadertoy fragment shader that RECEIVES the composited layer below as iChannel0 (recolour / displace / feedback FX, e.g. frag-invert-scan). TOYBOX hosts a faithful SHADERTOY RUNTIME: a `void mainImage(out vec4, in vec2)` source is wrapped through a mainImage→main shim with the FULL Shadertoy uniform set (iTime, iResolution as vec3, iTimeDelta, iFrame, iFrameRate, iMouse vec4 with .z/.w press semantics, iDate, iChannel0-3 + iChannelResolution[4]); the preview canvas routes pointer events to iMouse (client→engine px, GL bottom-origin Y-flip). A GEN/FRAG layer can host a MULTI-BUFFER Shadertoy project (a Common chunk + N buffer passes + an Image pass) — each pass owns its own FBO (RGBA32F via createFloatFbo for intBitsToFloat-packed / signed-precision buffers, degrading to RGBA8), channels resolve to another buffer pass output / its own previous frame (ping-pong feedback) / a keyboard stub / the scene / none, topo-ordered producers-first with Image last; the bundled GROWING PEAK preset is an ORIGINAL multi-buffer project (a growable self-feedback heightmap buffer → a raymarched weather sky Image pass) where CLICKING the preview grows the mountain via iMouse. OBJ = a 3D mesh layer (Phase 3): a bundled CC0 OBJ (Spot the cow, Utah teapot, chess pawn — parsed by an in-house ASCII OBJ parser with auto-center/auto-scale + computed flat normals) OR a built-in procedural primitive (cube / sphere / torus / hypercube tesseract; no asset file), matcap-shaded with depth testing — the matcap is synthesized procedurally in-shader (chrome / clay / neon styles, zero asset-license surface) and the layer carries rotX/rotY/rotZ, scale, spin (auto-rotate) and an RGB tint. An OBJ layer can optionally UV-map ANOTHER layer\'s rendered output (material.surfaceSource = that layer index, surfaceMix the blend) onto the mesh as a SURFACE TEXTURE in place of (blended with) the matcap — a per-frame dependency-ordered render pass guarantees the source layer renders first, and a self / cyclic / out-of-range source degrades to matcap-only (no WebGL feedback loop). OBJs with no authored texture coords get a planar XY-projected UV so the surface texture isn\'t collapsed to a single texel. The content/model catalogs + per-shader param schema live in a static manifest (packages/web/static/toybox/manifest.json); GLSL + OBJs are fetched lazily on selection (never JS-bundled) and cached. Persistence: node.data.layers (4-length array of { kind, contentId, params, material }) + node.data.combine. One video output (out).',
  edges:
    'Per-frame Sobel edge-detection video PROCESSOR. Takes a video input, runs a 3×3 Sobel operator on its per-pixel Rec. 601 LUMINANCE (gradient magnitude = sqrt(Gx²+Gy²), normalised so a unit luma step reads ~1.0), and emits a MONO-VIDEO frame: white where an edge was detected, black everywhere else. STATELESS per frame — the detected edges move/transform live with the source (no feedback, no history). THRESHOLD (0..1, default 0.2) gates which gradients count as edges (below → black; raise it to keep only the strongest contours, lower it to let faint gradients through). THICKNESS (1..8 px, default 2) DILATES the detected edge mask (morphological MAX over a square neighbourhood of radius thickness-1 texels) so a 1px edge renders up to `thickness` px wide; thickness=1 is the raw edge. IN takes RGB; OUT is mono-video (white edges on black) — patch it into OUTPUT, a video mixer, COLORIZER (mono→video upcast), or back into another video module as a key mask. THRESHOLD + THICKNESS each have a matching CV input (port id == param id). Pairs well with a moving source (CAMERA / VIDEOBOX / SHAPES) for live rotoscoped outlines.',
  mapper:
    'Video KEYER / MATTE processor. Shows a VIDEO input ONLY where a KEY input is active, BLACK everywhere else — a generalisation of OUTLINES\' `mapped` output (which showed its video input only where ≥2 shapes overlapped) to an ARBITRARY key. STATELESS per frame: the keyed region moves/transforms live with the key source (no feedback, no history) — a pure function of the current video frame, the current key frame, and the THRESHOLD knob. Algorithm (per output texel): read the KEY input\'s Rec. 601 LUMINANCE (the same luma weights LUMA / EDGES / LUMAKEY use), mask = smoothstep(threshold − 0.03, threshold + 0.03, keyLuma) (a sub-pixel-small soft edge band around the cutoff that keeps the key effectively CRISP — mask → 1 well above threshold, 0 well below — while removing the 1-texel aliasing a hard step shows on a moving key), then out = video × mask (video shows where the key is bright; fades to black below threshold). THRESHOLD (0..1, default 0.5): the key cutoff — RAISE it to SHRINK the keyed area (only the brightest key regions pass), LOWER it to GROW it (dimmer key regions pass too); this is the knob OUTLINES.mapped hard-coded to "≥2 overlaps". THRESHOLD has a matching CV input (port id == param id). VIDEO takes RGB; KEY is declared `video` so BOTH a colour video source AND a MONO-VIDEO source (white-on-black SHAPES / LINES / EDGES output, which upcasts to video for free) can drive it — its luminance is the mask. A half-patched MAPPER (missing VIDEO or KEY) is intentionally BLACK (mirrors OUTLINES.mapped\'s unpatched-video behaviour) so an unfinished chain reads as "not done yet" rather than passing the raw video through unkeyed. Usage: patch a source → VIDEO, a high-contrast matte (SHAPES / LINES / EDGES / a CAMERA luma) → KEY, OUT → OUTPUT or a video mixer; sweep THRESHOLD to wipe the keyed window open/closed, or modulate it with a CV/LFO for an animated reveal.',
  mappy:
    'MAPPY — a multi-surface MANUAL projection mapper. Spawns up to SIX SURFACES; each surface is fed by a distinct video input (in1..in6) and warped onto its own DRAGGABLE QUAD in the output frame, then composited (painter\'s order, OVER) into ONE video output → a projector. Use it to DE-SKEW one awkwardly-angled projection (drag the four corners to match the physical screen) or to map up to 6 feeds onto the faces of a white cube (only ~3-4 faces are ever visible from one projector angle). WARP: each surface owns a 4-corner QUAD in NORMALIZED [0,1] output space (corner order TL, TR, BR, BL). The homography (unit-square → that quad) defines the projective warp; the shader runs per OUTPUT texel, applies the INVERSE homography to find the matching SOURCE uv, and samples the input there (sampling only where the source uv is inside [0,1], else transparent so under-layers show through). Surfaces composite in input order (in1 first … in6 last) with OVER blend. FIT vs CROP: each surface has its OWN FIT toggle (default ON; surfaces independent) — one cheap per-surface shader uniform, no extra pass/readback. FIT (zoom-fit) squeezes the WHOLE source [0,1]² into the quad; CROP windows the source at NATIVE scale — the box becomes a moveable window onto the source pinned 1:1 in output space, so MOVING the box pans across the source and RESIZING crops more/less (the quad still masks the shape). DRAG: grab a CORNER to pin it, or grab the surface INTERIOR and drag to move the whole quad bodily (on the card preview AND in the editor). GRIDS-FIRST: a fresh MAPPY shows ONE surface, and a live surface with NO input connected renders its NUMBERED CALIBRATION GRID (a per-surface-tinted checker + border + cross-hairs + a big 7-segment DIGIT naming the input that will feed it). So with nothing patched the output IS the grid(s) — set the geometry up on the physical faces FIRST (drag corners; +/− the SURFACE COUNT up to 6), THEN connect video: the instant inN is connected, surface N swaps grid→warped video in the quad you already mapped (surface↔input is fixed — no reassignment). The GRID toggle FORCES the grid on every live surface (a re-alignment override); connecting inN auto-activates surface N even beyond the count. CARD: a live composite PREVIEW with draggable corner handles + quad outlines (coloured per surface), a +/− surface counter, a MAP button that opens the FULL-WINDOW editor (large canvas, big precise corner-pin handles, drag-inside-to-move a surface, surface tabs, a per-surface FIT/CROP toggle, snap-to-grid), the GRID toggle, and a per-surface legend (focus + FIT/CROP + reset + a ●video / ○grid state). All ports live on the yellow drill-down PATCH PANEL (no raw side jacks). This is the MANUAL mapper — the camera-assisted AUTO-align (point a camera at the projection, solve the homography from detected features) is a LATER phase; there is no camera input and no CV by design. The pure 2D projective math lives in $lib/video/mappy-homography (DLT solve / apply / invert / column-major-for-GLSL), shared by the shader + the unit tests.',
  cellshade:
    'Real cel-shader (toon) video PROCESSOR — the canonical live-video cel pipeline (Winnemöller\'s Real-Time Video Abstraction) as a 4-pass chain. Takes a video input and emits a cel-shaded version: (1) an edge-preserving SEPARABLE BILATERAL smoothing pass (SMOOTH, 0..1, default 0.35 — 0 is a true bypass: the passes are skipped entirely) flattens low-contrast texture/noise into the large flat regions that read as hand-painted while keeping strong contours crisp; (2) a SOFT LUMINANCE QUANTIZATION pass collapses the smoothed image\'s Rec. 601 luma into N flat tonal bands — BANDS is a 5-step DISCRETE knob mapping to {2, 3, 4 (default), 6, 8} bands (the param id stays the legacy `bits`, same 0..4 index range, so saved patches + CV cables load with zero migration) — with a smoothstep transition whose half-width SOFT (0..1, default 0.25) widens from hard-edged bands to a near-continuous ramp; reconstruction is the additive luma shift out = clamp(rgb + (Yq − Y)) (YCbCr Y-replacement), so CHROMA IS NEVER QUANTIZED — hue and saturation ride through and each band is a flat tonal step of consistent colour (a yellow stays yellow, a skin tone stays warm); (3) a Sobel INK pass (the exact EDGES algorithm — same Rec. 601 luma, normalisation, THRESHOLD gate and THICKNESS dilation — measured on the SMOOTHED image so sensor noise never inks) composites the salient contours as dark outline strokes scaled by INK (0..1, default 1: 0 = no lines, 1 = solid black). STATELESS per frame — the look tracks the live source with no feedback. THRESHOLD (0..1, default 0.2) gates which contours get inked; THICKNESS (1..8 px, default 2) dilates the strokes wider. All six params have matching CV inputs (port id == param id; BANDS uses a discrete cvScale so CV snaps to the 5 steps). IN takes RGB; OUT is video — patch a source (CAMERA / VIDEOBOX / SHAPES / a generator) → IN, OUT → OUTPUT or a video mixer; drop BANDS + raise INK for bold comic cels, raise SMOOTH for painterly abstraction, use SOFT to trade crisp band edges against shimmer-free gradients on live video. (The old 8/16-bit per-channel RGB retro posterize modes were dropped in the rebuild — that look is posterization, not cel, and belongs to the POSTERBOX module.)',
  posterbox:
    'POSTERBOX — retro PALETTE-CRUSH (posterizer) video PROCESSOR. Takes a video input and truncates every pixel to an authentic retro per-channel bit allocation — the classic "8-bit"/"hi-colour" palette crush. This is the dedicated home of the per-channel RGB posterize looks CELLSHADE\'s rebuild dropped (they are posterization, not cel shading): the 8-bit RGB 3-3-2 and 16-bit RGB 5-6-5 floor-quantization paths are ported EXACTLY, so an old cellshade retro patch recreates byte-for-byte by swapping in POSTERBOX. "Tints neutral grays" is a FEATURE, not a bug — an asymmetric allocation has different level grids per channel, so gray 0.2 at 3-3-2 quantizes to (36,36,0), a dark olive; that channel-clipped cast IS the period-correct look. DEPTH is a 5-step DISCRETE knob (the param is the step INDEX 0..4; the card shows the allocation name + palette size, and the matching CV input uses a discrete cvScale so it snaps to the 5 steps) stepping the ladder: 1-1-1 = 8 colours (3-bit RGB, ZX-Spectrum brutal), 2-2-2 = 64 (EGA master palette), 3-3-2 = 256 (VGA-era 8-bit truecolor, the default), 4-4-4 = 4096 (Amiga OCS), 5-6-5 = 65536 (RGB565 hi-colour, subtle). DITHER (0..1, default 0) is the classic companion: a Bayer 4×4 ordered dither that perturbs the quantizer threshold per screen pixel (the same offset-before-truncate scheme the PlayStation used before truncating to 15-bit) — at 0 the palette bands are HARD (the pure legacy crush); raising it dissolves band edges into alternating checkered pixels so gradients render as retro cross-hatch instead of banding. MIX (0..1, default 1) is a straight dry/wet. DEPTH / DITHER / MIX each have a matching CV input (port id == param id). STATELESS per frame — one texture sample + one Bayer lookup per pixel (single-pass shader, no neighbourhood taps). IN takes RGB; OUT is video — patch a source (CAMERA / VIDEOBOX / SHAPES / a generator) → IN, OUT → OUTPUT or a video mixer; step DEPTH for the era, raise DITHER for the cross-hatch, back off MIX to soften. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks). The pure quantizer + Bayer math is unit-tested in $lib/video/modules/posterbox (the exact CPU mirror of the shader).',
  tiler:
    'TILER — a video MULTISCREEN / TILE effect PROCESSOR (the classic video-mixer "multiscreen" look). Repeats the input frame in an N×N grid: each cell shows the FULL input scaled to 1/N, so the tiled copies are lower-resolution by nature (a 4×4 grid is 16 thumbnails of the same source, a 16×16 grid is 256 tiny copies). STATELESS per frame — the tiling moves/transforms live with the source (no feedback, no history). Implemented as a single-pass fragment shader; the whole effect is one line: color = texture(input, fract(uv × N)) — uv×N stretches the 0..1 UV across N cells and fract() wraps each cell back to the full input, so every cell samples the entire source. TILE is a 6-step DISCRETE knob (the param is a step INDEX 0..5; the card shows the resulting grid, e.g. "8×8") mapping to the grid dimension N: idx 0 → N=1 (1:1 PASSTHROUGH, no tiling — the lowest step is deliberately a transparent inline node), 1 → 4×4, 2 → 6×6, 3 → 8×8, 4 → 12×12, 5 → 16×16. A matching TILE CV input (port id tile_cv, paramTarget tile, DISCRETE cvScale) MODULATES the grid: the CV snaps onto the index steps and SUMS into the knob index (the same plumbing every per-param CV input uses), and the module then SNAPS the summed (possibly fractional) value to the NEAREST VALID N — so a CV that nudges the knob a little past "6" lands cleanly on 8 (never an invalid 7×7), and a bipolar LFO sweeps the grid through the valid sizes. IN takes RGB; OUT is video — patch a source (CAMERA / VIDEOBOX / SHAPES / a generator) → IN, OUT → OUTPUT or a video mixer; dial TILE for the multiscreen grid or modulate tile_cv for a pulsing/animated grid. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks). The pure knob→N mapping + the CV sum-then-snap-to-nearest-N math are unit-tested helpers in $lib/video/modules/tiler.',
  spirographs:
    'SPIROGRAPHS — a classic-spirograph video GENERATOR (a pure synth SOURCE: no video input). It draws 1–3 INDEPENDENT spirograph curves — HYPOTROCHOIDS (the rolling circle rolls INSIDE the fixed one) or EPITROCHOIDS (OUTSIDE) — each with its OWN full parameter set + matching CV, each DRIFTING around the screen with its fixed circle bouncing off the frame edges like a real spirograph pinned to the page. THE CURVES (a pen at offset p in a rolling circle of radius r rolling on/in a fixed circle of radius R): hypotrochoid x=(R−r)cos t + p·cos(((R−r)/r)t), y=(R−r)sin t − p·sin(((R−r)/r)t); epitrochoid x=(R+r)cos t − p·cos(((R+r)/r)t), y=(R+r)sin t − p·sin(((R+r)/r)t). The parameter t sweeps over exactly enough revolutions to CLOSE the figure — derived from the reduced R:r ratio (revolutionsToClose = the denominator of R/r in lowest terms); irrational-ish ratios are CAPPED at a sane maximum so the curve dense-fills the annulus instead of running forever. COUNT (1..3, DISCRETE knob + CV) sets how many spiros render. Each spiro i∈{1,2,3} owns ten params (port/param id sI_<name>), EACH with a knob AND a CV input: fixedRadius (R), rollingRadius (r), penOffset (p), inside (0=epitrochoid/outside, 1=hypotrochoid/inside — a discrete toggle), rotation, scale, xOffset, yOffset, thickness (real px line-width), and chroma (a colorwheel HUE for that spiro). MOTION: each spiro\'s CENTER drifts on its OWN per-spiro velocity/phase (the three never move in lockstep); the FIXED-radius circle (R scaled to screen) is CONSTRAINED to stay fully inside the frame and rolls/BOUNCES (elastic reflection) off the perimeter when it hits an edge — only the fixed circle\'s center+R is bound-constrained (closed-form, deterministic), while the drawn CURVE may extend past the viewport and clip (desired). The reflect/bounce + the curve math live in the pure, unit-tested $lib/video/modules/spirographs-math. RENDERING: Canvas2D polylines (real line-width with round joins/caps) painted to an OffscreenCanvas and uploaded as a GL texture each frame (the SHAPEGEN/TEXTMARQUEE path) — the right tool for thick stroked curves, where a GLSL distance-field would be costlier and read worse. OUTPUTS (all video): out (video) — the full-COLOUR composite, each spiro in its chroma hue additively blended on black so crossings glow; mono_out (mono-video) — every spiro stroked WHITE on black, a clean matte for keying / luma effects (reachable via read(\'outputTexture:mono_out\')); overlap (video, labelled CANDY) — a COLOUR-OVERLAP output: the per-pixel overlap DENSITY (how many lines stack there — self-crossings AND multiple spiros) is colour-mapped into a rainbow that CASCADES with the count (deep cool hue for one line, racing through green→yellow→red→magenta as lines pile up) and blooms toward a white candy core where many overlap — gooey "candy" goodness (reachable via read(\'outputTexture:overlap\')). CARD: a live preview of the colour OUT, the COUNT knob, a 1/2/3 SPIRO SELECTOR that swaps the knob bank to that spiro, an INSIDE/OUTSIDE toggle, a CHROMA colorwheel, and the per-spiro fader bank. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks); the drill-down GROUPS the CV inputs per-spiro (a count section + spiro1 / spiro2 / spiro3 sections). USAGE: dial COUNT, pick a spiro tab, tune R/r/pen for the figure (low gcd ratios make few-lobed flowers, coprime ratios dense rosettes), set INSIDE/OUTSIDE + chroma, then patch out → OUTPUT / a video mixer / an effect — or modulate any per-spiro param from an LFO/sequencer for an animated, drifting spirograph.',
  textmarquee:
    'TEXTMARQUEE — a rich-text MARQUEE video GENERATOR (source). MODEL: you type a styled paragraph in the card\'s tiny rich-text editor (a contenteditable region + a small toolbar); it serializes into a small RICH-TEXT MODEL — an array of paragraphs, each a list of styled RUNS `{ text, bold, italic, underline, color }` + a paragraph `align` (left/center/right), plus a layer FOREGROUND (default glyph colour) + BACKGROUND fill. That model persists in node.data.richText (Y.Doc-synced) and is the single source of truth for BOTH the editor DOM and the video texture. CONTROLS (card): the toolbar = ALIGN left/center/right, BOLD, ITALIC, UNDERLINE, per-character TEXT COLOR (pick a colour for the current selection), and the layer FG + BG colour swatches; below the editor are four knobs (ScrlX/ScrlY/PosX/PosY) and a live preview of the OUT layer. RENDERING: the model is laid out + drawn to an OFFSCREEN 2D canvas with SYSTEM FONTS (real glyphs — system-font text cannot be rasterized in GLSL, so a 2D-canvas→texture upload is the clean path: measure each run in its font/weight/style, draw with per-run colour + underline, honour align + bg fill), uploaded as a WebGL texture, and drawn into the module\'s FBO at a SCROLL offset + screen POSITION — a 90s-screensaver marquee. A freshly-spawned node renders a "textmarquee" placeholder until you type. I/O: OUT (video) — the rendered scrolling text layer. CV (each port id == param id, linear cvScale so a bipolar ±1 source sweeps the param\'s full range centred on the knob): ScrlX / ScrlY — horizontal / vertical scroll SPEED (BIPOLAR knob; 0.5 = static, <0.5 scrolls one way, >0.5 the other; the text wraps + re-enters from the opposite edge — a continuous ribbon). PosX / PosY — raw screen POSITION 0..1, CALIBRATED so 0 = text fully off one edge, 1 = fully off the other, 0.5 = centred (drawX = -textWidth + posX*(screenW+textWidth)); with the default-centred knob a bipolar LFO patched into PosX/PosY sweeps the text ALL THE WAY across — fully off the left, through centred, to fully off the right, and back. USAGE: type + style your banner, set FG/BG, then either crawl it with ScrlX/ScrlY (a scrolling marquee) or sweep PosX/PosY from an LFO/sequencer for a CV-driven swoosh; patch OUT into OUTPUT, a video mixer, or any video effect to title/overlay another layer. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks). The pos/scroll/wrap math + the rich-text layout/measurement are pure, unit-tested helpers in $lib/video/modules/textmarquee-layout.',
  vfpgaRunner:
    'A HOST module that runs a loaded `.vfpga` declarative effect spec — a "virtual FPGA bitstream" swapped into one reconfigurable card (inspired by, not a clone of, classic video-synth hardware). The module declares the full I/O SUPERSET it can wire — 4 video inputs (vin1..vin4), 4 CV inputs (cv1..cv4), 4 gate inputs (g1..g4), 2 video outputs (vout1 canonical / vout2 via read(\'outputTexture:vout2\')), and an 8-slot generic param bank (p1..p8) — and a loaded VfpgaSpec (node.data.vfpga, picked from the "load preset…" menu) selects which subset is ACTIVE and what GL render-graph runs. The card is manifest-driven: it renders the full port superset as handles (inactive ones dimmed) and shows only the loaded spec\'s active CV inputs (each with a bipolar SCALE attenuverter + OFFSET + always-on scope), gate inputs (with an activity LED), and its mapped param knobs (p1..pN, labelled + ranged by the spec, MIDI-learnable). CV inputs are linear-scaled into named role uniforms; gate inputs raw-pass into synthetic gN_evt params that the factory hysteresis edge-detects (DOOM/backdraft convention) so a spec\'s shader can read a held level / rising-edge count. Specs are IN-REPO bundled TypeScript (no user-uploaded code in v1) collected by import.meta.glob; the render runs off-main-thread (renderLocus:\'worker\') because every catalog VFPGA is pure-GL. Preset change hot-swaps the GL pipeline. This foundation ships ONE VFPGA: smpte-bars, a pure SMPTE-style colour-bar generator (0 video in → 1 video out, one CV SHIFT role + BRIGHT/SAT params) — a deterministic always-on reference source for bringing up downstream effects.',
  charlottesEchos: 'Destructive multi-head stereo delay. Pitch-shifted feedback with decay.',
  clap:
    'Analog-modeled HANDCLAP voice — the fourth member of the drum family (KICK DRUM / SNARE DRUM / TOM DRUM), at deliberately CURATED complexity: one synthesis engine, eight voice knobs + level, spanning the classic clap circuits in one continuous space (TR-808 canonical twin-VCA burst+tail, TR-909 dense bright machine burst, Simmons-ClapTrap spread, LinnDrum-era dark room clap). DSP (own-code, packages/dsp/src/lib/clap-dsp.ts): seeded white noise → COLOR one-pole tilt (log-swept 9 kHz→700 Hz, white→dark, gain-compensated) → Chamberlin band-pass at TONE (400–3000 Hz; the 808 sits near 1 kHz, the 909 near 1.14 kHz) with WIDTH morphing ringy Q≈5.5 → broad splash (1/√q loudness-compensated) → the 808 twin-VCA topology: a BURST of PULSES (2–5) retriggered envelopes SPREAD ms apart (4–25, latched per hit; each pulse decays −60 dB in exactly the spacing — the quad-comparator sawtooth cycles — and the FINAL pulse rings 2× longer, the uninterrupted last discharge) summed with a separate smooth reverb TAIL envelope (30–800 ms, fired at the last pulse, fed one pole darker — the fake room). SNAP is the equal-power burst↔room balance (1 = bone-dry machine clap, 0 = room only); DRIVE a 2×-oversampled warm-tanh; then 20 Hz DC block, dB LEVEL, and a true-peak tanh bound (|out| < 1 always). Inputs: trigger_in (edge-trigger STRIKE — burst geometry + accent latched, noise reseeded: every hit bit-identical), accent_in (per-hit 0..1 CV latched at the strike edge: up to +80 % velocity AND +60 % room excitation — a harder clap is bigger, not just louder), tone_cv (±1.5 oct/V — ±1 V covers the whole knob range), tail_cv (2 oct of tail time per volt), spread_cv (±1.3 oct/V, latched per hit — the ClapTrap random-spread trick, deterministic). Output: ONE mono audio_out. Card: compact BURST·NOISE·ROOM/OUT fader band + a press-to-fire CLAP pad (the `strike` param, OR-ed with trigger_in in the worklet — one clap per press edge).',
  clipplayer:
    'CLIP PLAYER — an Ableton-Session-style clip launcher with 8 INSTRUMENT LANES. Rotates Ableton\'s layout 90° to sit on a wide monome grid: ROWS = 8 instruments (lanes), COLUMNS = 8 clip slots per instrument (64 note clips total). Each lane plays its launched clip out its OWN pitch/gate/velocity outputs, so up to 8 clips sound at once — one per instrument (the owner model: "each row reflects a given instrument\'s materials"). It is the dedicated companion to a monome grid 128 controller (browser-native WebSerial, no native helper — see lib/control/monome) but is fully usable from the card alone. CLOCK: LOCKED TO TIMELORDE (the rack transport) — no internal BPM, no clock cable. It runs only while TIMELORDE.running, at TIMELORDE.bpm, and freezes when it stops (free-runs if no TIMELORDE is in the rack). The only timing control is STEP (1/4 · 1/8 · 1/16 (default) · 1/32 = steps-per-beat). The card\'s ▶/■ transport writes TIMELORDE.running, and HIDES itself when TIMELORDE is slaved to an external clock (MIDICLOCK → start_in/stop_in). LAUNCH: clicking a clip queues it; with QNT on (default) it takes over on that lane\'s next loop boundary (off = immediately). Each lane queues independently, so a whole new arrangement can drop in on the bar line. A "scene" is a COLUMN — firing it launches one clip per instrument together. The per-lane playing/queued set syncs over the Y.Doc so collaborators (and a second grid) see the same session; grid LED + serial I/O stay per-user local. CLIPS are tiny note/step patterns (default 16 steps, up to 128 — set non-destructively, so notes past a shortened length are kept and replay when you lengthen again): polyphonic (chords fan out across the lane\'s poly pitch/gate pairs), per-note length (held gates), per-note velocity (drives the lane\'s vel CV), per-note probability, and scale-aware (major/minor/pentatonic/chromatic). Clips may be DIFFERENT lengths per lane; lanes free-run as a POLYMETER and all re-align to step 0 on the TIMELORDE transport downbeat (a fresh ▶ is always phase-locked). CARD: a SESSION view (8×8 launch grid, lane-tinted; single-click = launch/queue, click the playing cell = stop, DOUBLE-CLICK = open the clip\'s editor) and an EDIT view (a piano-roll note editor — X = step, Y = pitch in-key; click a cell to place/remove a note, right-click to cycle its velocity through 6 levels (≈0/20/40/60/80/100%), with scale/root/length controls, per-lane MONO/POLY, ROW/OCT pitch-window scroll + a TIMELORDE-locked playhead). GRID (16×8): left 8×8 = clip matrix, right control strip = per-lane STOP + SCENE launch + COPY/PASTE/PASTE-REVERSE (held modifiers: hold COPY/PASTE/PASTE-REV + tap a clip to copy it to / paste it from a per-machine buffer; PASTE-REV pastes a time-reversed copy) + STOP-ALL + TRANSPORT; HOLD the EDIT pad + tap a clip to turn the whole grid into that clip\'s note editor. The on-grid note editor pages a clip in up to 8 pages of 16 steps — FOLLOW auto-scrolls the shown page with the playhead, tap it to FREEZE and page with LEFT/RIGHT; DOUBLE dups the first half into a doubled length; a dedicated 2-row LENGTH page sets the clip length (block ×16 then trim to the exact end step). Inputs — STOP ALL: a rising edge stops every lane (canonical windowed edge counter, no double-count). Outputs — PITCH 1-8: each lane\'s launched-clip pitch as a poly-capable V/oct cable (chords fill lanes), GATE 1-8: high while that lane\'s note sounds, VEL 1-8: that lane\'s per-note velocity as a 0..1 CV (patch into a VCA/ADSR amount). Params — STEP (steps per beat), OCT (octave transpose), GATE (per-step gate duty cycle), QNT (quantize launch to the loop boundary), S&H (ON by default). The upper-right S&H toggle bakes in a gate-sampled Sample & Hold across ALL 8 lanes at once — replacing the 8 external S&H modules a user otherwise needs: on a REST (empty step) the lane\'s gate still closes but its pitch CV HOLDS its last value instead of resetting to C4, so each lane\'s pitch latches to the gate edge. Turn S&H OFF for the legacy continuous behavior where rests rewrite pitch. SONG MODE (arranger): the header SES/ARR toggle flips between live SESSION play and ARRANGEMENT playback of a recorded TIMELINE of clip launches (an event log over song-beats). The ● REC arm captures launches into that timeline; the RPL/OVR toggle next to it sets the record mode — REPLACE (default: arming clears the log + restarts the song at bar 1) or OVERDUB (arming KEEPS the existing take and merges new launches into it by song-beat). In ARRANGEMENT view the card shows a compact lane×bar timeline whose clip blocks can be DRAGGED in time (bar-snapped) to retime a launch, selected to cycle/delete, with the loop length nudged in bars. The "ARR ⤢" button pops out a FULL-WINDOW arranger editor (like the MAPPY map editor) hosting a large timeline with the same drag-to-move + all the edit ops + a SNAP bar/beat toggle; it reads/writes the SAME synced arrangement so the card, the pop-out, and peers stay in lock-step. The arrangement is Y.Doc-synced; drags commit one transactional write on drop (no per-frame store churn). All ports live on the yellow drill-down PATCH PANEL (no side jacks); knobs are MIDI / control-surface assignable. Usage: build a few note clips per instrument, patch each lane\'s PITCH/GATE into its own voice, start TIMELORDE, then launch/quantize-switch clips + scenes from the card (or a monome grid) to perform, RECORD a take into the arrangement (REPLACE or OVERDUB) and refine it by dragging blocks on the timeline (in-card or the pop-out editor). A faithful monome Kria step-sequencer ships as the separate `kria` module.',
  kria:
    'KRIA — a 4-track grid step-sequencer, a clean-room reimagining of monome\'s Kria (inspired by monome Kria; behavior reimplemented from monome\'s public docs, no monome source or doc prose reproduced). Like CLIP PLAYER it is a browser-native companion to a monome grid 128 (WebSerial, no native helper — see lib/control/monome) but is FULLY usable from the card with a mouse. MODEL: four INDEPENDENT tracks, each with its own per-step sequences edited on separate PAGES selected from a nav row. Pages (Phase A): TRIG (does the step fire? + per-step ratchet subdivisions), NOTE (the Y axis picks a pitch DEGREE within the active scale), OCTAVE (per-step +0..+5 octave offset), DURATION (per-step gate length as a fraction of the step). Per-track extensions: LOOP (per-track loop start + length, wrapping), TIME (per-track clock DIVISION — advance once every N base ticks), DIRECTION (forward / reverse / pingpong / drunk / random), and per-step PROBABILITY (4-level) + GLIDE (pitch slew). A shared SCALE (major / minor / pentatonic / chromatic) maps NOTE degrees to V/oct. 16 PATTERN slots each hold a full snapshot of all four tracks; switching patterns is QUANTIZED — tap a slot to CUE it and the engine swaps it in on the next track-0 loop boundary (or after a cue-clock countdown). CLOCK: locks to the rack\'s TIMELORDE singleton (runs only while TIMELORDE.running, tempo = TIMELORDE.bpm); patch an external CLOCK IN to override the tempo (each rising edge advances the base grid, via the canonical windowed edge counter — no double-count), and a RESET IN rising edge re-anchors every track to its loop start. Without a TIMELORDE node the card\'s BPM knob + RUN button drive it. CARD: a TRACK selector (1-4), a PAGE selector (TRG/NTE/OCT/DUR + PAT), a 16-step editor for the selected track+page (with a clock-locked playhead column), and a 16-slot pattern strip (tap empty = create + activate, tap another = cue a quantized switch); a GRID button connects + binds a monome grid (capability-gated, Chromium) so the same edits + cues happen on hardware with live varibright LED feedback. Inputs — CLOCK IN (external clock, rising edge advances), RESET IN (rising edge re-anchors all tracks). Outputs (the Ansible Kria shape) — PITCH 1-4 (per-track V/oct with per-step glide slew) + GATE 1-4 (per-track gates; DURATION shapes the width, ratchet subdivides). All ports live on the yellow drill-down PATCH PANEL (no side jacks); the BPM knob is MIDI / control-surface assignable. USAGE: patch each track\'s PITCH+GATE into a voice (VCO + VCA/ADSR), clock from TIMELORDE, build trig/note/octave/duration patterns per track from the card or a monome grid, then perform by cueing pattern slots for quantized arrangement changes.',
  score: 'Sheet-music sequencer. 8-bar treble-clef staff, click to place notes. Outputs pitch / gate / env (ADSR x dynamic) / clock.',
  drumseqz:
    '4-channel x 16-step drum sequencer with per-track Euclidean fills + quantized CV.',
  polyseqz:
    'Polyphonic chord sequencer. 32-step grid; each step holds a root note + chord quality (maj/min/maj7/min7/dom7/sus2/sus4/dim/aug) + inversion (0/1/2) + voicing (closed/open/spread). Outputs the full 5-voice chord on a polyPitchGate cable. HUMANIZE knob adds per-voice timing offsets (linear/uniform at low values, chaotic clusters at high values) for a human-pianist feel. An upper-right S&H toggle (ON by default) bakes in a gate-sampled Sample & Hold on the per-lane pitch CV: each lane\'s pitch is pinned to the un-jittered nominal step time (keeping only a ~1-sample lead before its gate) and latches to its own gate edge, so the pitch holds cleanly while the GATE keeps its humanize jitter. Turn S&H OFF for the legacy pre-gate-lead write where pitch can drift ahead of the gate under humanize. Tested as the chord source for DX7-style polyphonic synth voices.',
  recorderbox:
    'Video + audio RECORDER sink. Patch a picture into IN and a stereo soundtrack into A·L / A·R, type a filename, hit RECORD, and RECORDERBOX captures it to a HIGH-QUALITY, CRASH-RECOVERABLE H.264 MP4. Model: like OUTPUT, it monitors its video input (live preview + an OUT pass-through so you can chain it inline) while ALSO recording. Encoding runs through WebCodecs (H.264 video at ~14 Mbps VBR, AAC stereo audio) muxed by Mediabunny (MPL-2.0) into a FRAGMENTED MP4 (fastStart:"fragmented") streamed to OPFS scratch via a dedicated Worker holding a FileSystemSyncAccessHandle — the only browser API that writes real disk synchronously AND survives a tab crash. The OPFS scratch is named after your sanitized filename + a .partial marker + the start epoch, so the partial carries your intended name. Controls: an editable FILE field (node.data.filename, synced to rack-mates), a SIZE / quality selector (HIGH / BALANCED / SMALL), and a RECORD ON/OFF toggle. The SIZE selector trades file size against quality: HIGH is the original ~14 Mbps H.264 (the DEFAULT — no change for existing racks); BALANCED and SMALL PREFER a more efficient modern codec (AV1, then VP9, capability-probed at the actual recording resolution via VideoEncoder.isConfigSupported) at a lower bitrate, longer keyframe interval, and lower audio bitrate, falling back to a lower-bitrate H.264 where no modern codec encodes. The codec stays inside the same fragmented MP4 container, so the extension (.mp4) and crash-recovery semantics never change — only the bytes inside get smaller. SMALL is typically ~70-80% smaller than HIGH; BALANCED ~55-65% smaller, both at near-imperceptible quality cost on synth/visualizer output. The chosen tier syncs to rack-mates (node.data.quality) and is locked while a take is in progress. NO "SAVE AS" PROMPT (folder model): on Chromium, pressing RECORD picks a destination FOLDER ONCE via showDirectoryPicker (a valid user gesture); thereafter the recording auto-writes into that folder using the FILE box directly — no per-save dialog — and the folder is remembered so the next record needs no prompt at all. The ONLY remaining prompt is an OVERWRITE confirm when a file with the target name already exists (cancelling the folder picker, or declining the overwrite, does NOT start recording). The chosen FileSystemDirectoryHandle is persisted into the recovery manifest. On STOP the finished MP4 is remuxed to a flat (NLE-importable) container and STREAMED into the folder (never read whole into memory — a long 4K take can be GBs). Firefox/Safari (no directory picker) record to OPFS and download each file via <a download> with the correct name. GOPRO CHUNKING: a long take rolls to a NEW file every ~10 min with a 5-SECOND AUDIO OVERLAP (the last 5 s of chunk N is duplicated as the start of chunk N+1), named FILENAME-CHUNK#-DATETIME.mp4 (RECORDING-001-…, RECORDING-002-…) — unique + Finder-sortable; a take under ~10 min is a single RECORDING-001-<datetime>.mp4. CONSTANT FRAME RATE: video frames are encoded on an even index/fps PTS grid (not jittery wall-clock time), which fixes the macOS Preview/QuickTime "slow-motion" artifact that an irregular variable-rate PTS stream produced. Inputs: in (video, polymorphic), audio_l + audio_r (audio — a NEW cross-domain audio→video audio-input bridge connects each upstream audio source straight into a MediaStreamAudioDestinationNode this module owns; the audio is TAP-ONLY and is NOT monitored through your speakers). Output: out (video pass-through of in). CRASH RECOVERY: because the file is fragmented and each fragment is flushed to disk, a take is playable from whatever reached disk even if the tab dies before you press STOP — on mount the card scans an IndexedDB manifest for any in-flight recording and offers "Recover unsaved recording?" with Save / Discard. If the destination FOLDER was persisted, Save re-requests write permission and streams the partial straight back into it under the chunk\'s FILENAME-CHUNK#-DATETIME name (no re-picking); if the handle is gone or permission is denied it falls back to a picker/download suggesting the right filename. Recovery is THIS-MACHINE/BROWSER ONLY (OPFS is origin-local and does NOT sync to collaborators). Defaults: 30 fps, ~14 Mbps; locked but overridable later. Graceful degrade: where the runtime has no OS H.264 encoder (headless CI, some platforms) the RECORD button is disabled with a clear "no H.264 encoder available" badge — it never crashes.',
  cameraInput:
    'Webcam input (LOCAL ONLY). Live <video> -> WebGL2 texture; gain / mirror / on params. The captured stream is local to your browser tab and is NOT sent to other rack-mates — collaborators see a presence badge ("user X has CAMERA active") via Y-awareness, not the video itself. Multiplayer streaming (WebRTC + SFU) is deferred to a future phase. Spec: .myrobots/plans/module-camera-input.md.',
  loopback:
    'The BROWSER VIEWPORT as a video source (LOCAL ONLY). Zero inputs, one video OUT whose contents are what you currently SEE in this tab — the visible canvas pane — so you can feed LOOPBACK -> RECORDERBOX to record your viewport, or -> any effect for live self-referential feedback. Mechanism: the card captures the current tab via the Screen Capture API (getDisplayMedia({ video: { displaySurface: "browser" }, preferCurrentTab: true, selfBrowserSurface: "include" }) — the Start capture button is the required user gesture), runs it in a hidden <video>, and the engine samples each frame into a WebGL2 texture exactly like CAMERA; a crop step then windows the tab frame down to the app viewport element\'s on-screen rectangle (measured per frame, pushed to the engine as LOCAL per-viewer state — never synced) so OUT is just the active viewport, letterbox-fit into the engine frame (black bars, never cropping edges away). Because the preview shows the tab it is captured from, an on-card preview is intentionally recursive (a video-feedback tunnel). Params: gain (0..2 RGB multiplier), crop (viewport vs whole-tab, ON by default). Capture needs a gesture and can be stopped from the browser\'s share bar (the card returns to idle with a re-capture button); getDisplayMedia is feature-detected, degrading to a disabled unsupported state where the API is missing.',
  picturebox:
    'Image-file SOURCE with a 7-SLOT ASSET SELECTOR. Click "Choose image…" to load a single picture (downscaled to 1024×768, JPEG-encoded, base64 → node.data and synced to all rack-mates; each peer decodes it back into the WebGL2 source texture). A GAIN knob (CV-modulatable, 0..2) scales the output RGB; output `out` is a video-domain image source. ASSET SELECTOR: right-click the card to open "Load multiple…", a 7-row panel where each row is labelled with a note (C D E F G A B) and loads its own image into one of 7 slots (all 7 base64 images sync + all 7 textures stay resident in GPU memory). A clip player (or any pitch + gate source) then SWITCHES which slot is displayed: patch the clip player\'s GATE output → ASSET GATE and its PITCH output → ASSET PITCH. On each ASSET GATE rising edge the module reads ASSET PITCH (raw V/oct), maps it to a slot by PITCH CLASS (octave-independent), and instantly shows that slot if it holds an image. THE 7-NOTE → SLOT TABLE (the default clip\'s in-key rows, C-major from C3): C3 (MIDI 48) → slot 1, D3 (50) → slot 2, E3 (52) → slot 3, F3 (53) → slot 4, G3 (55) → slot 5, A3 (57) → slot 6, B3 (59) → slot 7. Matching is by pitch class, so a C in ANY octave selects slot 1, a B in any octave selects slot 7, etc. A pitch whose class is a black key (C# D# F# G# A#) maps to NO slot → the event is IGNORED (the current image keeps showing). The displayed selection is LOCAL render state (every peer computes it from the same synced gate + synced images), so it is never written to the Y.Doc per gate event. ASSET PITCH/ASSET GATE + GAIN live in the card\'s yellow drill-down PATCH PANEL (no raw side jacks, #767 standard). Limits: 8 PICTUREBOX per workspace.',
  painter:
    'PAINTER — an MS-Paint-style drawing surface as a video SOURCE. The card is a tiny Windows-95 Paint: a tool grid (PENCIL = hard 1px, BRUSH = round sized stroke, ERASER = paints the background colour, LINE, RECT, ELLIPSE, FILL = flood fill, EYEDROPPER = pick a colour off the canvas, TEXT = stamp a string), the classic 28-colour Win95 palette (left-click a swatch = FOREGROUND, right-click = BACKGROUND), a SIZE slider (brush/line width 1..48), a FILL toggle (outline vs background-filled rect/ellipse), and an engine-resolution drawing canvas. Whatever you paint is the single video OUTPUT in real time: the card binds its live canvas to the module once and the engine uploads that canvas every frame (a 1:1 mapping — the canvas IS the frame). MODEL: the drawing is a Y.Doc-synced ordered op log (node.data.ops) — each committed stroke / shape / fill / text appends one PaintOp; on mount and on any remote edit the card REPLAYS the log onto the canvas (deterministic, pure painter-draw.ts), so every rack-mate paints the same picture. Tool / colour / brush-size are LOCAL per-collaborator (only the drawing syncs). UNDO pops the last op; CLEAR empties the log to a blank white page. IO — Inputs: none (a pure source). Output: out (video) — the painted canvas at the engine output resolution. The OUT port lives in the card\'s yellow drill-down PATCH PANEL (no raw side jacks, #767 standard). A freshly-spawned node renders a blank WHITE page (MS-Paint\'s default), so it is never a dead black frame. USAGE: paint a logo / title card / doodle and route OUT into a mixer / keyer / effect / OUTPUT; collaborate on one canvas in a shared rack.',
  videovarispeed:
    'Local-file VIDEO player with a PERFORMANT varispeed transport AND a 7-SLOT ASSET SELECTOR. SINGLE VIDEO: pick/drop a video (objectUrl + optional FileSystemFileHandle for one-click reload; collaborators re-link their own copy — the bytes stay local, only fileMeta syncs); the frame texture is sampled off requestVideoFrameCallback so the `video` output streams at ANY playback speed (the #291 fix). Transport: SPEED knob (0=-4×…0.5=+1×…1=+4×; reverse scrubs at a throttled ~10 Hz), a START/END window, LOOP vs ONE-SHOT, and rising-edge gates START / PAUSE / RESET / LOOP. Stereo `audio_l` / `audio_r` bridge the file\'s audio (with a silent keep-alive so an unpatched source keeps decoding at full rate). ASSET SELECTOR: right-click the card → "Load multiple…", a 7-row panel (notes C D E F G A B) that loads up to 7 videos, one per slot; all 7 are PRELOADED as separate <video> elements (first frame decoded) so a switch is instant. Patch a clip player\'s GATE → ASSET GATE and PITCH → ASSET PITCH: on each ASSET GATE rising edge the module reads ASSET PITCH (raw V/oct), maps it to a slot by PITCH CLASS, and — if that slot holds a loaded video — makes it the active source, RESTARTS IT FROM THE BEGINNING (currentTime=0), plays it (if the transport is playing) under the current speed/window/loop settings, and re-wires its audio to the now-active element. THE 7-NOTE → SLOT TABLE (the default clip\'s in-key rows, C-major from C3): C3 (MIDI 48) → slot 1, D3 (50) → slot 2, E3 (52) → slot 3, F3 (53) → slot 4, G3 (55) → slot 5, A3 (57) → slot 6, B3 (59) → slot 7. Matching is octave-independent (a C in any octave → slot 1, …); a black-key pitch (C# D# F# G# A#) maps to NO slot → the event is IGNORED (current video keeps playing). MEMORY: 7 preloaded <video> elements are heavy, so each slot\'s file is capped at 100 MB. The displayed selection is LOCAL render state (computed from the synced gate + per-slot fileMeta), never written to the Y.Doc per gate event. ASSET PITCH / ASSET GATE + the transport gates/CV all live in the card\'s yellow drill-down PATCH PANEL (no raw side jacks, #767 standard).',
  tvLibrarian:
    'International live-TV source. Pick a country on the 2D world map (or the country list) → a channel list (filtered to playable HLS streams) → tune a channel and its live picture streams in as an UNTAINTED video texture (validated under the app\'s COEP require-corp headers: famelack HLS plays + yields a clean WebGL2 texture, so VIDEO out is a real downstream-usable texture, not play-only) plus stereo audio_l/audio_r from the stream\'s audio track. The "random" button (and the random/next CV trigger inputs) jump channels for happy-accident channel-surfing. Gate outputs: channel_changed pulses on each tune (trigger), stream_online holds high while the stream actually plays (gate). Dead/geo-blocked/unlicensed-pulled streams fail cleanly → marked "unavailable" + auto-skipped, never a hang or a tainted texture. Channel selection persists on the node + syncs to rack-mates (everyone tunes to the same stream). LEGAL: streams are THIRD-PARTY public streams, NOT hosted by patchtogether — this is a player pointed at the same iptv-org-derived directory many "free live TV" sites use; an in-card disclaimer + attribution (Famelack, MIT-licensed dataset fetched at runtime; iptv-org) ship with it, geo-blocked entries are honored/marked, and dead links are filtered. Plan + legal posture: .myrobots/plans/tv-librarian-module-2026-06-14.md.',
  peertube:
    'PEERTUBE — federated-video SOURCE. Search the open PeerTube fediverse, pick a video, and its picture streams in as a CLEAN (untainted) WebGL video texture plus stereo audio — a real downstream-usable source, NOT play-only. MODEL: a debounced search box queries Sepia Search (sepiasearch.org, the official PeerTube meta-index — CORS-open + anonymous, NO proxy needed); results list title, channel@host, duration, a LIVE badge, and a thumbnail. Click a result → the card fetches that video\'s per-instance public API (https://<host>/api/v1/videos/{uuid}) and resolves a playable stream: it PREFERS the HLS master playlist (streamingPlaylists[0].playlistUrl → attached via hls.js for adaptive playback) and FALLS BACK to the highest-resolution progressive MP4 (files[].fileUrl, attached as a plain <video src>). The stream attaches to a card-owned <video crossorigin="anonymous"> → the engine samples it into the FBO (the `video` output) + taps stereo audio (audio_l / audio_r via MediaElementSource → ChannelSplitter, with the shared keep-alive so an unpatched source keeps decoding at full rate). WHY THE TEXTURE + AUDIO ARE CLEAN (verified): PeerTube sends Access-Control-Allow-Origin:* on the FINAL media hop (master .m3u8 + the fragmented-mp4 / mpeg-ts segments) under a favorable `credentialless` COEP posture, so a crossorigin <video> fed by hls.js both PLAYS and yields an untainted texture — unlike archive.org video (play-only). IO — Inputs: play_trigger (gate, edge=trigger — a rising edge toggles play/pause), next_trigger (gate, edge=trigger — a rising edge loads the next search result, wrapping). Outputs: video (the live frame texture), audio_l / audio_r (stereo, silent ConstantSource placeholders until a stream attaches), loaded (trigger — one pulse when a new video finishes loading), ended (trigger — pulses when the video reaches its end), playing (gate — HIGH while actually playing), playhead (CV — 0..1 normalized position). CV/PATCHING: all inputs + outputs live in the card\'s yellow drill-down PATCH PANEL (top-left/top-right affordances → INPUT/OUTPUT → grouped Gates / CV / Audio / Video rows) — there are NO raw side jacks (#767 standard). Trigger inputs are main-thread edge-detected the established video-module way (a single bridge-written cv-param read per tick — never a whole-AnalyserNode rescan). USAGE: type a term, press Enter (or wait for the debounce), pick a video, and route VIDEO into a mixer/keyer/OUTPUT and audio_l/audio_r into AUDIO OUT or a SCOPE/SYNESTHESIA for audio-reactive visuals; clock the next_trigger from a sequencer to channel-surf the fediverse. GRACEFUL: ~1/6 instances misconfigure CORS (raw S3 with no ACAO) → the element taints / the HLS load fails fatally → the card degrades to "display unavailable", surfaces a clear status, and AUTO-SKIPS to the next result (it never crashes, taints the texture, or hangs on loading). An optional instance field biases attribution display. Only { instanceHost, uuid, name, selectedHost } persist on the node + sync to rack-mates (everyone resolves + plays the same video locally); transient playback state stays render-local (never a per-frame synced-store write). The AUDIO TRAP: the <video> is created muted for autoplay, then un-muted ONLY after the MediaElementSource tap succeeds, so audio routes into WebAudio without native speaker double-output. LEGAL: federated PUBLIC videos, not hosted by patchtogether — an in-card disclaimer + attribution to PeerTube + Sepia Search ship with it.',
  illogic:
    'Combined attenuverter / math / logic utility. 4 cv inputs feed bipolar attenuverters (-1..+1); post-attenuverter outputs sum into `sum` and `diff`. Inputs in1+in2 are also gate-thresholded (>= 0.5) and combined into AND/NAND/OR; in1 alone drives a NOT.',
  unityscalemathematik:
    'Bipolar CV-shaping utility with three independent channels: a UNITY scaler (input * atten) plus two attenuvert sections (A, B) whose curve knob morphs the response from linear (k=1) to steep exponential (k=3) via y = sign(x) * |x|^k * atten. Sign is preserved across the curve morph so the transform stays bipolar. CV inputs on every atten/curve knob — useful for envelope shaping, LFO sculpting, or driving any modulation through a tunable response curve.',
  analogLogicMaths:
    'Analog-logic mixer inspired by Mystic Instruments ANA (hardware-only — this is a from-spec implementation, not a port). Two continuous-signal inputs A and B feed bipolar attenuverters (-1..+1) and the post-attenuverter signals fan out into FIVE simultaneous algebraic outputs: MIN = min(A\',B\'), MAX = max(A\',B\'), DIFF = A\'-B\', SUM = tanh(A\'+B\') (soft-clipped), PRODUCT = tanh(A\'*B\') (soft-clipped, gives ring-mod-ish behavior for audio + smooth blending for CV). MIN/MAX of two waveforms mashes shapes; MAX of two envelopes = "either-trigger fires"; DIFF of two LFOs is anti-correlated motion; PRODUCT of two CVs is smooth blending. Continuous-signal "analog logic" — NOT the digital boolean logic that ILLOGIC ships. Tanh soft-clip on SUM + PRODUCT only (the operations that can leave [-1, +1]); MIN/MAX/DIFF stay bounded naturally.',
  dx7:
    'Pure-TypeScript 6-operator DX7-style FM synthesizer. 32 algorithms, 5-voice polyphony via the polyPitchGate cable, bundled bank of factory-inspired patches (E.PIANO 1, BASS 1, HARMONICA, STRINGS 1, MARIMBA, etc.), and a .syx file picker for loading custom 32-voice cartridge dumps (in-memory only). On top of the six per-operator DX7 envelope generators, a per-voice master OUTPUT-VCA ADSR (Attack / Decay / Sustain / Release) gives a player-dialable amplitude swell / long-release without editing the SYX: one envelope per voice multiplies the summed-carrier output, gated by the same note-on/note-off as the operator EGs (soft/click-safe retrigger). Defaults are ~pass-through (fast attack, full sustain, fast release) so loaded patches sound identical until you touch the master ADSR; a long master release now outlives operator-EG silence (a voice frees only once both the operator EGs and the master amp envelope have faded). NOT a Plaits-backed implementation — see .myrobots/plans/dx7-and-polyphony.md for the design rationale.',
  noise:
    'Basic noise source. Three independent audio outputs — WHITE (full-spectrum), PINK (1/f, -3 dB/oct via Voss-McCartney), BROWN (1/f², -6 dB/oct via leaky-integrated white). All outputs share a single LEVEL knob. No CV inputs.',
  buggles:
    'Chaotic random voltage source — clean-room functional implementation of the Buchla / Make Noise wogglebug archetype. Internal "woggle clock" emits triggers at the RATE knob; outputs include SMOOTH (slewed random), STEPPED (sample-and-held), CLOCK (woggle gate), BURST (probabilistic clusters of 3-7 triggers), and RING (smooth × sub-osc ring-mod, the signature dirty texture). CV inputs modulate rate + chaos; EXT CLK replaces the internal scheduler when patched. The "Wogglebug" name is Make Noise\'s trademark — BUGGLES is our name; no proprietary schematic is copied.',
  warrenspectrum:
    'Stereo 8-band filterbank with vactrol-style ping excitation and acidwarp video viz. Eight RBJ bandpass filters at octave-spaced centers (80, 160, 320, 640, 1280, 2560, 5120, 10240 Hz, Q=6). Each band carries its own ping gate input — rising edges distribute excitation across n±2 neighbors via a 1.0 / 0.35 / 0.12 bleed matrix into a vactrol envelope (soft-attack 10-30 ms with ±10% jitter, exponential decay 100-800 ms with ±10% jitter, tanh-saturated). The envelope simultaneously injects a fast broadband click into the bandpass (filter rings at fc) and pumps the band gain. viz_out is a mono-video cross-domain bridge: the on-card EQ-curve + audio-waveform overlay + cycling acidwarp hue palette + per-band ping flashes are also published as a video texture for downstream video modules.',
  spectrograph:
    'SPECTROGRAPH — a real-time scrolling sonogram VIDEO generator. Takes ONE mono audio input and renders a log-binned spectrograph: FREQUENCY on the vertical axis (log scale, 20 Hz at the BOTTOM up to 20 kHz / Nyquist at the top), TIME scrolling horizontally with the NEWEST column at the RIGHT (older content slides off the left). Model: an AnalyserNode tap (1024-pt FFT, getFloatFrequencyData dBFS) on the input is log-binned into 128 perceptual rows per column spanning [20 Hz .. 20 kHz] (each row picks the nearest FFT bin to its target Hz, DC skipped); magnitudes are normalized over a -90 dBFS (quiet) .. -10 dBFS (loud) display window and written into a 256-wide circular column buffer that advances at most once per ~16 ms frame (steady scroll independent of how many outputs are patched). The binning + colormap math is the same algorithm WAVESCULPT uses for its spectrograph view (video_mode 2), lifted into a pure GPU-free core. TWO video outputs render the SAME binned dB plane through two different colormaps — both always live regardless of which the on-card preview shows. IO — IN (audio): the mono signal to analyse. COLOR OUT (mono-video): the blue→cyan→yellow→red HEAT colormap (loud = hot/red, quiet = dark blue/black) — the classic colored spectrogram. B/W OUT (mono-video): INVERTED grayscale — quiet = light/WHITE, loud = dark/BLACK — i.e. the classic PRINTED-SONOGRAM look (light page, dark traces). Controls — GAIN: a pre-analysis input trim (×0.25 .. ×4, LOG taper, unity at center) applied by a GainNode BEFORE the analyser, so you can boost a quiet source up into the -90..-10 dB display window (or tame a hot one) without changing the displayed dynamic range. GAIN is MIDI / control-surface assignable (right-click → MIDI Learn) like every other knob. A card VIEW toggle (COLOR / B/W) just switches which output the on-card preview shows — it does not change either output. All patching is via the card\'s yellow drill-down PATCH PANEL (top-left / top-right affordances → INPUT / OUTPUT) — no side jacks. It is a `domain: audio` module that exposes VIDEO outputs through the audio→video texture bridge (the SYNESTHESIA / WAVESCULPT cross-domain pattern), so you patch COLOR / B/W OUT straight into any video module or the video OUTPUT. Usage: drop it on any audio bus to SEE the spectral content of a synth / drum / mix in real time — patch COLOR into the video OUTPUT for the colored sonogram, or B/W for the printed-paper look; feed it from a SCALER / mixer to pick which signal you scope.',
  stereovca:
    'Stereo VCA + ring modulator. Per-channel multiply: out_l = in_l * (strength_l + offset) * level; out_r = in_r * (strength_r + offset) * level. The same math behaves as VCA gain control when strength is slow (CV / LFO / envelope) and as ring modulation when strength is audio-rate — no mode toggle, the perceptual difference emerges from signal content. INDEPENDENT normalling: if in_r is unpatched it copies in_l (mono → stereo); if strength_r is unpatched it copies strength_l (one strength drives both VCAs). The two halves normal independently, so true-stereo audio + mono strength works, as does mono audio + per-side strength. Audio carriers (in_l/in_r) declare cable type `audio`; strength inputs declare `cv` (raw bipolar carrier consumed in the multiply with no scaling — listed in PASSTHROUGH_BY_DESIGN) so any cv source (LFO, ADSR, sequencer step CV) lands without a cross-type cast.',
  shimmershine:
    'Stereo shimmer reverb. Schroeder-style tank (4 parallel comb filters with damped feedback + 2 series allpasses per channel) feeds a +12-semitone granular-fade pitch shifter; the shifted signal is summed back into the tank input (gain hard-capped at 0.55 to prevent runaway). Decay sets tank tail length, Shimmer the pitch-shifted feedback amount (0 = plain reverb, 1 = strong octave-up halo), Size the comb-feedback scale, Damp the in-loop high-frequency rolloff, Mix dry/wet. More processor-intensive than the plain Reverb module by design.',
  macrooscillator:
    'Plaits-style macro oscillator (Mutable Instruments archetype). Clean-room pure-TypeScript implementation — not a port of Plaits\' C++ source (see PR #27 for the closed emscripten attempt). First-slice scope ships two synthesis models behind the three canonical macros (HARMONICS / TIMBRE / MORPH): (0) virtual analog (VA) — morphing saw→square→triangle PolyBLEP wave + detuned partner (HARMONICS = detune amount) + wavefolder (TIMBRE = fold amount); (1) waveshape — sine through a morphable wavefolder/tanh-waveshaper (TIMBRE = drive, MORPH = wavefolder↔tanh, HARMONICS = sub-octave mix). PITCH input is V/oct; NOTE param is a ±60-semitone offset on top. TRIG resets phase on rising edge for percussive attack alignment. OUT is the level-scaled main output; AUX is a per-model raw tap (unfolded sub-octave triangle in VA, pre-distortion body in waveshape). More models (granular, FM, chord, speech, kick/snare/hat, modal, etc.) land in follow-up PRs.',
  clouds:
    'Granular texture processor (Mutable Instruments Clouds archetype, Émilie Gillet, 2014, MIT-licensed) — 2-second stereo ring buffer + overlap-added grain cloud (up to 24 grains) + latched FREEZE. Six macros (Position / Size / Pitch / Density / Texture / Blend) with V/oct grain-pitch tracking on the pitch input. v1 ships GRANULAR mode only; STRETCH / LOOPING-DELAY / SPECTRAL modes deferred to follow-up.',
  rings:
    'Modal / sympathetic-string resonator (Mutable Instruments Rings archetype). Faithful TypeScript port of the eurorack/rings/ DSP (MIT-licensed). v1 ships two resonator models: (0) MODAL — bank of 24 parallel stiffness-stretched RBJ bandpasses with cosine-weighted Odd/Even pickup taps; (1) SYMPATHETIC — 2 parallel Karplus-Strong delay lines with one-pole damping. STRUCTURE/BRIGHTNESS/DAMPING/POSITION are the canonical Rings knobs; LEVEL is a soft-limited output gain. EXCITER in drives both engines; STRUM rising edge re-ignites a ~10ms noise burst (KS) or impulse (modal). Outputs odd / even — patch both for stereo. Polyphony 1; STRING+REVERB deferred.',
  marbles:
    'Random sampler / clock generator (Mutable Instruments Marbles archetype, Émilie Gillet, MIT-licensed). Clean-room TypeScript port of the eurorack/marbles/ DSP. The T-section (t1 / t2 gates) generates clocked random gates via one of six models — COIN (complementary Bernoulli), CLUSTERS, DRUMS (18 built-in 8-step patterns), INDEP (independent Bernoulli), 3-STATE, MARKOV — with a déjà-vu loop that locks the random stream into a repeating pattern (RATE / T BIAS / T JITTER / DÉJÀ VU / LENGTH). The X-section (x1 / x2 / x3 CV) draws random voltages shaped by SPREAD (variance), X BIAS (mean), and STEPS (quantization amount + STEPS-knob portamento), snapped through a weight-aware variable-resolution quantizer onto one of six scales (C major / C minor / Pentatonic / Pelog / Raag Bhairav / Raag Shri), with its own déjà-vu loop shared across the three X channels via pseudo-random hash shifts. clk is the master clock. CV outs are ±1 (= ±5V). Beta-distribution sampling is approximated analytically vs the firmware\'s precomputed table; the déjà-vu / Markov / quantizer / lag logic is ported line-for-line.',
  cloudseed:
    'Exact algorithm port of Ghost Note Audio\'s CloudSeed reverb (MIT-licensed, github.com/GhostNoteAudio/CloudSeedCore). Stereo input cross-mixes then per-channel passes through: optional 1-pole HP + LP pre-EQ → modulated pre-delay → multitap early-reflection field (up to 256 taps, seed-deterministic) → AllpassDiffuser (up to 12 stages) → 12 parallel late-field DelayLine voices, each with optional in-loop AllpassDiffuser + LowShelf + HighShelf + LP, with T60-targeted feedback that produces a precise decay-seconds tail. Cross-seed control divides the L/R seeded delay layouts for stereo decorrelation. 45 parameters total — 7 macros (DRY / EARLY / LATE faders, INPUT MIX, LOW CUT, HIGH CUT, CROSS SEED) are exposed as AudioParams for CV summing; 38 toggle/integer/seed/modulation parameters live on the worklet\'s message port. Bundled v1 preset bank: DIVINE INSPIRATION (DarkPlate from Programs.h verbatim), SHORT ROOM, BRIGHT HALL, INFINITE PAD. Card footer cycles through the preset bank with click-numbered slots, prev/next arrows, and a live DECAY readout that reflects LateLineDecay\'s computed RT60.',
  cofefve:
    'Analog BBD/tape-style stereo delay — a clean-room, OWN-CODE engine (the replacement for the retired Cocoa Delay; its own DSP, no GPL lineage). A 10-second stereo delay line read at a fractional position with 4-point Catmull-Rom cubic interpolation; the read time is modulated two ways: a WOW LFO (AMOUNT × sin at FREQUENCY) and a slow random FLUTTER drift walk (AMOUNT × random, SPEED) on a fixed-seed PRNG (deterministic). Feedback is bipolar (−1..+1), clamped just below unity for stability, with a STEREO offset that skews the L/R read times apart and a PAN with three modes (STATIC rotation, PING-PONG feedback cross, CIRCULAR rotating the wet image). DUCKING sidechains the wet level by an envelope follower on the dry input (AMOUNT, ATTACK, RELEASE). A multi-mode TONE filter (1/2/4-pole cascade or state-variable) low-cuts + high-cuts inside the feedback path, and a stateful tanh DRIVE saturator (GAIN / MIX / FILTER, run 1–16 ITERATIONS) dirties the loop. DRY + WET set the output mix. The read pointer eases toward its target so TIME changes glide like a tape motor. TEMPO SYNC locks the delay time to a musical division (1/4, 1/8, dotted, triplet…) of a clock period measured from pulses on the CLOCK gate input; the CLK SRC dropdown labels whether that clock is the rack SYSTEM clock (TIMELORDE) or external MIDI (MIDICLOCK). When sync is Off the TIME knob is free-running seconds. CV inputs cover the musical params: time, feedback, mix, drive, WOW amount, FLUTTER, pan, ducking.',
  resofilter:
    'Multi-mode filter — clean-room TypeScript port of gabrielsoule/resonarium\'s MultiFilter (Source/dsp/MultiFilter.{h,cpp}). 5 modes drawn straight from upstream\'s MultiFilter::Type enum and filterTextFunction: LP / HP / BP / Notch / Allpass. All five characters share a single Cytomic / Zavalishin TPT state-variable filter per channel, so the MODE knob is a pure output picker — switching modes mid-render is pop-free. Cutoff 20 Hz – 20 kHz (log), resonance 0..1 (k = 2 − 2·res, edge-of-self-oscillation at the top), per-param CV inputs (cutoff_cv, reso_cv) sum into the AudioParams with a 50 Hz internal one-pole smoother on cutoff to prevent the steep transfer function from clicking on rapid CV jumps. Stereo input (independent L/R SVF state). The card displays the long-form mode name (e.g. "Low-pass") in a label next to the MODE knob — the headline UX feature: the dial updates the text reactively as you turn it. Drive is intentionally omitted (upstream MultiFilter has no drive stage; saturation lives in WrappedSVF / Distortion which is out of scope for this port).',
  karplus:
    'Extended Karplus-Strong STRING/HARP VOICE built on the COFEFVE DELAY\'s own fractional delay-line core (owner directive — no parallel delay implementation): a strike fires a seeded noise burst into a recirculating delay-line "string" and the ring IS the note, decaying like a real vibrating string. The full Jaffe–Smith/CCRMA EKS extension set, curated to 6 voice knobs + CV: DECAY is t60 in real SECONDS, frequency-compensated with the ρ = 0.001^(1/(f0·t60)) per-period loss law so low notes do NOT ring 10× longer than high ones (the classic K-S sin, fixed); BRIGHT is the string material — an in-loop damping low-pass whose cutoff TRACKS the note (≈1.4×f0 felt-dark … ≈90×f0 steel-bright, the Rings damping vocabulary), gain-compensated at f0 so it never shortens or detunes the note; POS is the pick position (feedforward comb at β of the period — β=0.5 cancels even harmonics for a hollow mid-pluck, small β = bridge-thin); STIFF adds dispersion allpasses that stretch upper partials SHARP toward piano wire / bell / gong; COLOR (200 Hz mallet → 10 kHz pick low-pass) and BURST (0.1–4 PERIODS of noise, energy-normalized: near-impulse tick → classic 1-period pluck → scraped/bowed onset) shape the exciter. Tuning: 1 V/oct (f0 = Tune × 2^V, 30 Hz–4.2 kHz) with every loop stage\'s phase delay at f0 compensated in closed form and the fraction realized by the cofefve Catmull-Rom read — measured ≤ 0.1 cents across C2–C7 (unit-gated < 3). Inputs: trigger_in (edge-trigger STRIKE, burst reseeded per hit — deterministic), pitch (1 V/oct), accent_in (per-hit velocity latched at the edge: louder + brighter), damp_in (level-sensitive palm mute WHILE high, ~50 ms choke), plus a per-control CV on EVERY voice knob (tune_cv/decay_cv/bright_cv/position_cv/stiff_cv/color_cv/burst_cv/level_cv — each ±1 sweeps its param full-range around the knob). Mono out (the string tap) with LEVEL −24..+12 dB. Card: STRING·EXCITER fader bands + a PLUCK audition button (fires the canonical shared trigger pulse). Stability is proven, not hoped: modes k ≥ 1 are bounded by ρ < 1 and the k = 0 loop mode is pinned below unity by an f0-tracked DC blocker (unit-gated at the hostile knob extremes).',
  sixstrum:
    'SIX STRUM — a 6-string guitar/bass/harp INSTRUMENT: six of our KARPLUS extended-Karplus-Strong string voices side by side, each behind its own amplitude ADSR, summed to MONO through a tuning-matched resonant BODY. Three ways to play it, all into one engine: STRUM by hand via six edge-trigger inputs NORMALLED low→high (patch only strum #1 to barre all six with one gate; patch #1 and #4 for two independent strum groups; STRUM SPREAD + DIR set the roll speed and down/up/alternate direction); play polyphonically from the POLY input (the 16-lane polyPitchGate cable — lanes 1–6 → strings 1–6, note-on plucks, note-off releases); or feed one root to the mono CHORD pitch-CV input and it voices a real guitar chord across the strings (each string takes the lowest chord-tone at/above its open pitch; the CHORD selector picks maj/min/dom7/maj7/min7/sus4/power5/octaves). Six MUTE gates model a finger laid loosely on a string — while high that string goes dead and near-unpitched (a palm-mute thunk; MUTE depth sets how dead), gate all six to choke the chord. GUITAR/BASS/HARP are NOT hidden presets: they are knob states of this ONE engine — TUNING (open-string set: guitar EADGBE / a low six-string bass / a diatonic harp), REGISTER (octave), RING (string sustain, calibrated to real plucked-string decay research — ~2.5 s guitar, long dark bass, very long harp), MATERIAL (nylon↔steel), PICK POS/TONE/GRAIN (where + how hard it is plucked), STIFF (inharmonicity toward wound/metal), plus SPREAD (per-string detune + always-distinct excitation seeds so a barre chord choruses instead of phase-combing) and BODY (the box resonance). Per-string ADSR: fast ATTACK, SUSTAIN held at 1 so the string\'s own physical ring IS the sustain, RELEASE bites on note-off / mute. ACCENT is a shared per-hit velocity CV (louder + brighter). Mono out; no per-voice controls beyond the shared panel. Card: a STRUM audition button barres all six strings; the rear PatchPanel groups the 15 inputs per string (strum + mute) plus POLY / CHORD / ACCENT.',
  kickdrum:
    'Layered stereo kick VOICE — the "shake the house" deep-bass kick (own-code; build plan .myrobots/plans/kick-drum-voice-2026-07-01.md). Three DECOUPLED generator layers so depth and punch live on orthogonal knobs: a pure-sine SUB (Tune 20–120 Hz, gentle slow settle, long Sub Dec ≤ 800 ms — the air-moving pulse), a band-limited BODY one octave up (fast downward P Amt/P Time pitch sweep — the 909 "dooo" chest-thump — plus Shape sine→tri→rect morph and a Tension amplitude→pitch glide), and a filtered-noise CLICK transient (Click len / Clk Tone / Clk Lvl). The summed layers run a serial bus: DRIVE saturation with a single HARD character switch (clean-warm vs aggressive, owner-decided instead of a mode menu), an own-code 3-band kick EQ (Sub/Body/Atk EQ bells + a spectral Tilt), and the TRANSLATE harmonic exciter that synthesizes the sub\'s 2nd/3rd/4th harmonics so a 40–50 Hz fundamental still reads deep on laptop/phone speakers. DYNAMICS: a threshold-free transient shaper (Attack/Sustain), a GLUE compressor whose detector is sidechain-HPF\'d ~100 Hz so the sub never pumps it, and a CEILING soft-clip that true-peak-bounds the voice so it can sit hot. Stereo stage: everything <120 Hz is strictly MONO (phase-safe, full excursion); Width spreads only the upper body/click band (M/S) — separate audio_l/audio_r outs with stereoPairs auto-pairing. Inputs: trigger_in (edge-trigger STRIKE — phases reset, envelopes fire), accent_in (per-hit 0..1 CV latched at the strike edge, scaling sweep depth + level), pitch_cv (1V/oct, transposes the whole voice), choke_in (level-sensitive gate — damps while high through a short ramp, releases on the falling edge), PLUS a per-control CV input for every one of the 25 voice knobs (tune_cv … level_cv — each ±1 sweeps its param full-range around the live knob, cvScale matched to the knob curve). Level spans −24..+12 dB with deliberate headroom, guarded by the internal ceiling. Wide 3u banded card: SUB·BODY·CLICK / DRIVE·EQ·TRANSLATE / DYNAMICS·STEREO·OUT. Ships as a clean-deep club kick by default; later DSP phases land inside the worklet without changing this contract (Phase 1 renders SUB+BODY, L=R).',
  snaredrum:
    'Deep, flexible stereo SNARE VOICE with a polyphonic two-hand DRUMROLL — the mate to KICK DRUM (own-code; design .myrobots/snare-drum-module-design.md). Four decoupled acoustic layers the way a real snare works: a HEAD modal bank at inharmonic Bessel-zero ratios (1.0/1.03/1.593/2.135 — the pitchless membrane "thunk", self-ringing Chamberlin resonators struck by an impulse, with a downward pitch-drop at the strike), band-passed noise BODY around the head (TONE crossfades HEAD↔BODY), the SNARE-WIRE buzz — the defining sizzle — as bright HP-tunable noise on a SHARED re-excitable bed that breathes with the rectified head displacement AND rings out between strokes, and a short CRACK stick-contact transient. TWO strike inputs into one synth: trigger_in fires ONE hit per rising edge; gate_in runs the drumroll WHILE high. The roll is genuinely POLYPHONIC — two alternating hands 180° interleaved, each stroke (and each buzz sub-stroke) allocating its own voice from a 10-voice lowest-energy-steal pool while the shared wire bed sustains continuity, so overlapping decaying tails SUPERPOSE into a continuous roll (NOT a pulsed one-shot retrigger). ROLL SPEED sets 4–24 strokes/hand (+ roll_speed_cv at 1V/oct), BOUNCE morphs single-stroke → double/open → dense multi-bounce buzz/press roll (a coefficient-of-restitution bounce train, ≤6 sub-strokes, more as the hands slow), HUMANIZE adds seeded (deterministic) timing/velocity/detune jitter, and a hard per-second allocation budget routes excess buzz density into bed re-excitation only. The summed pool + bed run ONE shared bus: an oversampled DRIVE with a single HARD character switch (clean-warm tanh @2× vs aggressive wavefold+asym @4×), a 20 Hz DC block, and a per-channel true-peak CEILING soft-clip. Stereo: SPREAD pans the two hands (constant-power) + detunes them, WIDTH decorrelates only the bright wire sizzle; head/body stay centered so width=0 AND spread=0 → L==R exactly (mono-safe fold-down). Inputs: trigger_in (edge-trigger STRIKE), gate_in (edge-gate DRUMROLL), roll_speed_cv, accent_in (per-hit velocity + drive/level macro, latched at each strike), pitch_cv (1V/oct whole-voice transpose), choke_in (level-sensitive hand-on-head mute), PLUS a per-control CV input for each of the 21 remaining voice knobs (tune_cv … level_cv — each ±1 sweeps its param full-range around the live knob, cvScale matched to the knob curve), alongside the existing roll_speed_cv. Level −24..+12 dB, guarded by the ceiling. Wide 3u banded card: HEAD·BODY·WIRE / CRACK·ROLL·DRIVE / STEREO·OUT. Ships as a clean, punchy snare; hold a long gate for a continuous two-hand roll.',
  tomtom:
    'Analog-modeled TOM DRUM voice — the third member of the drum family (KICK DRUM / SNARE DRUM), at deliberately CURATED complexity: one synthesis engine, seven voice knobs + level, spanning the classic analog tom lineage in one continuous space (808-woody bridged-T ring, 909-punchy swept osc + overtone, Simmons SDS-V "piuuu" dive-bomb, deep floor tom). DSP (own-code, packages/dsp/src/lib/tomtom-dsp.ts): a MEMBRANE fundamental (Tune 60–400 Hz) plus the inharmonic 1.593× Bessel second mode (TONE tilts fundamental ↔ overtone, with its own faster decay) riding ONE exponential pitch-BEND envelope (Bend 0–24 st depth — 0 = stable pitch, 24 = a two-octave zap; B Time 10–300 ms), a band-passed BREATH noise layer tracking ~2.5× the settled pitch (NOISE balances membrane ↔ breath, the SDS-V tone/noise mix law — 808 breath at low settings, full Simmons noise hit at the top), a 2×-oversampled warm-tanh DRIVE, 20 Hz DC block, dB LEVEL, and a true-peak tanh bound (|out| < 1 always). DECAY (40–1500 ms) is FREQUENCY-COMPENSATED: the −60 dB ring time is set in ms regardless of Tune, so a 60 Hz floor tom and a 400 Hz timbale ring equally long at the same knob. Inputs: trigger_in (edge-trigger STRIKE — phases reset, envelopes fire), accent_in (per-hit 0..1 CV latched at the strike edge: up to +80 % velocity AND +50 % bend depth, like a harder stick), pitch_cv (1V/oct whole-voice transpose incl. the breath band), bend_cv (±24 st/V into Bend — full-swing), decay_cv (2 oct of decay TIME per volt), tone_cv / noise_cv (sum into the balances). A per-knob CV now covers EVERY continuous control: tune_cv (2 oct/V on the TUNE knob — distinct from the whole-voice pitch_cv), bend_time_cv (2 oct of sweep-settle time/V), drive_cv (sums into DRIVE), and level_cv (±18 dB/V — the full 36 dB range centered on the knob). Each law is scaled in the shared core so cv = 0 is a perfect no-op. Output: ONE mono audio_out. Card: compact MEMBRANE·COLOR·OUT fader band + a press-to-fire STRIKE pad (the `strike` param, OR-ed with trigger_in in the worklet — one hit per press edge); the rear patch panel groups its jacks into MEMBRANE·COLOR·OUT·TRIG/OUT sections mirroring the card headers. Control set modeled on the Vermona DRM1 tom channel (tune / bend / decay / noise / drive).',
  sidecar:
    'Stereo sidechain compressor — Giannoulis-Massberg-Reiss 2012 JAES topology (cross-checked against Faust\'s co.compressor_stereo). Stereo audio in, dedicated SC L/R inputs (with normalling fallback: both unpatched → self-detect on the audio pair, the typical "use this as a plain stereo comp" default). The SC detector path runs a one-pole HPF (sc_hpf 20..1000 Hz, default 20 = effectively off) for kick-immune bus compression, then |sL|+|sR| stereo-link rectifier → log2 → 3-region soft-knee gain computer → asymmetric one-pole smoother (attack 0.1..200 ms log, release 1..2000 ms log) → linear gain via 2^(gainDb/6.0205). Stereo-link is always on in v1 so transients never shift the image under compression. Two ENV outputs expose the reduction envelope for cross-patch ducking: env_out = (-gainDb / 24) * envMag (NO clamp — at envMag>1 the output can overshoot 1.0, by spec), and env_inv_out = 1 - env_out (the canonical "patch this into a VCA strength to make it close when the comp fires"). Threshold (-60..0 dB) and envMag (0..2) are CV-modulatable; ratio, attack, release, knee, makeup, and sc_hpf are knob-only. Per-sample param smoothing kills clicks on rapid threshold / envMag changes. The 6.0205 factor (= 20·log10(2)) is the GMR-canonical log2↔dB bridge that lets the smoother run cleanly in the dB domain.',
  treeohvox:
    'TB-303 voice slice — clean-room TypeScript port of the voice subset of Robin Schmidt\'s Open303 (MIT, https://github.com/RobinSchmidt/Open303). 6 canonical 303 knobs (TUNE ±12 st, CUTOFF 40 Hz – 6 kHz, RESONANCE 0..1, ENVELOPE 0..1, DECAY 50 ms – 3 s, ACCENT 0..1) plus pitch / gate / accent_in audio-rate inputs and per-knob CV. The DSP is the TB_303 mode of rosic::TeeBeeFilter (the diode-feedback ladder with feedback HP — NOT a moogafakkin ladder; that is the whole point of Open303), the rosic::DecayEnvelope on cutoff, a simplified AR amp envelope mirroring rosic::AnalogEnvelope, and a polyBLEP saw replacing the BlendOscillator wavetable (the 303 character lives in the filter, not the oscillator). Cutoff is modulated per-sample via Open303\'s measured-mapping scaler+offset formula. All 6 knobs have an 80 Hz one-pole WtParamSmoother on the audio thread (per PR #435) so knob drags and CV ride pop-free through the steep filter. Accent boosts both amp peak and filter env contribution on accented notes. The full 404 module — sequencer + transpose + slide + waveform switch + TD-3 smiley — is queued as a follow-up.',
  livecode:
    'JS-runtime live-coding module — CodeMirror editor with port-aware autocomplete and red-underline diagnostics, hit Run, the rack reshapes itself. Exposes spawn / patch / unpatch / set / read / clock.* / clocked() / log. Every clocked() call spawns a CLOCKED runner that owns the subscription. No audio I/O — the card is a side-tool. Full API + examples at /docs/modules/livecode.',
  clockedRunner:
    'Self-contained mini-LIVECODE owning a single clocked() callback. Spawned by the parent LIVECODE card when you invoke clocked(division, fn); deleting the runner cancels the schedule. Body is editable inline; the audio-domain factory re-evaluates it on every division boundary derived from TIMELORDE.bpm.',
  midiCvBuddy:
    'Hardware MIDI controller → pitch + gate + velocity CV. Uses the browser\'s built-in Web MIDI API (no third-party library) and converts incoming note-on / note-off / pitch-bend messages into three ConstantSourceNode outputs: pitch_cv (V/oct, 0V = C4 = MIDI 60, with pitch-bend summed in at the MIDI-standard ±2 semitones), gate (0/1), and velocity_cv (0..1). Monophonic with three voice-priority modes (LAST = newest key wins, the conventional default; LOW = lowest key, classic mono-bass behavior; HIGH = highest), a RETRIG toggle that drops the gate to 0 for one audio block between successive note-ons (so a downstream ADSR re-fires) versus legato (gate stays high through key changes), an ALL/1..16 channel filter, and a device-picker dropdown that hot-plugs when controllers connect/disconnect. The user clicks "Connect MIDI…" once per origin to grant permission; subsequent reloads reuse the grant. End-to-end latency is honest about the Web MIDI main-thread path (~5-10 ms typical on Chrome/macOS); event.timeStamp is mapped to ctx.currentTime + a 2 ms lookahead so scheduling lands at the start of the next audio block rather than mid-block.',
  midiLane:
    'MIDI LANE — a per-channel "instrument bus" demux for a hardware MIDI sequencer (Reliq, Cre8audio Programm, Empress ZOIA, or any class-compliant USB-MIDI device). DAW-style workflow: assign each track of your sequencer to its own MIDI channel, then drop one MIDI LANE per instrument and point each at that track\'s channel — multi-timbral = several lanes, like several MIDI-CV-BUDDYs but channel-aware and richer. Each lane demuxes its channel into the CV/gate the rack speaks: pitch_cv (V/oct, 0V = C4 = MIDI 60, pitch-bend summed at ±2 st), gate (HIGH while any key on the lane is held; with RETRIG, dips one audio block on each new note-on so a downstream ADSR re-fires), velocity_cv (0..1), plus TWO learn-assignable CC taps (cc_a / cc_b → 0..1 CV — hit LEARN, wiggle a CC, done; these subsume the per-track CC-modulation lane and can drive audio params OR video params via the cross-domain bridge), plus ONE by-note-number drum gate (note_gate fires on a card-selected MIDI note, default GM kick = 36 — the Programm/Reliq ch10 drum-router pattern generalized via configuration, not 8 fixed ports). MONO mode is monophonic with three voice-priority modes (LAST / LOW / HIGH); POLY mode adds a 10-channel polyPitchGate output (poly) so a chord on the lane plays a polyphonic synth (cartesian / dx7). The SAME outputs drive VIDEO modules for free: a gate or cv handle cabled into ACIDWARP.scene_cv / DOOM.cv_pN fires visuals with no synth voice — the engine\'s cross-domain CV/gate→video bridge needs no special "video gate" port. Uses the browser\'s built-in Web MIDI API (no third-party library, no native bridge); click "Connect MIDI…" once per origin to grant access. Main-thread plumbing (ConstantSource-per-output, 2 ms scheduling lookahead) identical to MIDI-CV-BUDDY, whose note logic it reuses verbatim. v1 surfaces a single-channel-or-ALL selector on the card (the engine supports a multi-channel Set under the hood for a future multi-select). End-to-end Web MIDI latency is the honest ~5-10 ms main-thread path.',
  midiOutBuddy:
    'MIDI CV BUDDY OUT — the output complement of MIDI-CV-BUDDY. Turns the rack\'s gate / pitch / velocity CV into MIDI notes sent to an external MIDI device, so a sequencer, envelope, or LFO inside the patch can play a hardware synth. A gate rising edge sends NoteOn [0x90|(ch-1), note, vel]; the falling edge sends NoteOff [0x80|(ch-1), note, 0]. The pitch input (V/oct, 0V = C4 = MIDI 60) is quantized to the nearest semitone for the note number, and the velocity input (0..1 CV) maps to MIDI velocity 1..127 — both are sampled at the gate rising edge. The module TRACKS the currently-sounding note so the NoteOff matches the note that was turned on even if pitch drifts while the gate is held. Pick the output device from a dropdown (enumerated from MIDIAccess.outputs; persisted by device name across saves) and the MIDI channel 1..16. Uses the browser\'s built-in Web MIDI output (no companion app); the user clicks "Connect MIDI…" once per origin to grant access. Device hot-plug is handled, and an all-notes-off plus a matched NoteOff are sent on dispose / device-change / channel-change so external gear is never left with a stuck note. CV is read main-thread via AnalyserNode taps polled on the shared scheduler clock — no AudioWorklet. Terminal MIDI sink (no audio outputs).',
  midiclock:
    'Hardware MIDI transport bridge. Locks to a MIDI device and surfaces the System Real-Time stream as gate/CV: clock (gate) at a user-selectable subdivision — 24=quarter (default, patch directly into TIMELORDE.clock to slave it to the external transport), 12=eighth, 6=sixteenth, 3=32nd, 1=raw 24 PPQN; run (cv, 0/1) tracks transport state; midistart + midistop fire one-shot gates on MIDI Start (0xFA) and Stop (0xFC). Continue (0xFB) raises run without re-firing midistart, so downstream loops resume in place. Channel-voice messages are ignored — pair with MIDI-CV-BUDDY for note/velocity. Same Web MIDI / ConstantSource / 2 ms lookahead plumbing as MIDI-CV-BUDDY.',
  gamepad:
    'Connected USB / Bluetooth game controller as CV (stick axes + triggers) and gate (face / bumper / dpad / menu buttons). Reads navigator.getGamepads() at requestAnimationFrame rate. Browser security requires the user to press a button on the gamepad once before the browser exposes it. Outputs: lx / ly / rx / ry (cv ±1, Y inverted so +1 = up, 0.08 deadzone), lt / rt (cv 0..1), lb / rb / a / b / x / y / du / dd / dl / dr / start / back (gate). Standard mapping = Xbox layout; PlayStation + generic HID controllers that report \'standard\' mapping also work. Slot param picks which of up to 4 simultaneous controllers to read. LEFT-STICK CALIBRATION: "calibrate left stick" arms a calibration mode — sweep the stick through its full range several times (the card records the observed per-axis min/max live), then "complete calibration" locks the swept range in so observed-min→full-min and observed-max→full-max per axis, with the calibrated centre mapped to 0 and a radial deadzone around it (no snap-back drift). Calibration is persisted once to the patch (rides collab + undo) and applied to lx / ly; "clear" reverts to the fixed-deadzone path. This makes worn pads and non-Xbox-layout sticks (e.g. VKB Gladiator NXT flight sticks, which report a non-standard mapping with a reduced raw range) reach the full ±1 output range.',
  numpadPlus:
    'Numpad-driven 4-layer × 16-step sequencer + live keyboard. Each numpad note key fires the active layer\'s pitch+gate immediately AND, when REC ARM (one-pass record on next play-from-start) or OVERDUB (always-recording) is on, writes the note to the nearest step on the active layer. Default keymap: 1=C, 2=C#, 3=D, 4=D#, 5=E, 6=F, 7=F#, 8=G, 9=G#, 0=A, /=A#, *=B; Numpad+ held = next note +1 octave, Numpad- = -1 octave. Octave 0-8 nudged via on-card arrows. CV inputs: clock (rising-edge external clock — internal BPM ignored while patched) + layer (CV value 0..1 selects active layer, otherwise the activeLayer param wins). CV outputs: l1_pitch / l1_gate ... l4_pitch / l4_gate (8 outputs total) so a patch can route each layer to its own downstream synth — basically a 4-track sequencer. When this module exists in the rack its keyboard listener captures Numpad* event.codes + preventDefault so other modules can\'t see the keys.',
  blood:
    'Interactive BLOOD video source — the NBlood (Build-engine) port of Blood, compiled to WebAssembly and rendered as a video module. Owner-only and single-instance, like DOOM: the rack owner spawns it and plays; the video output is the Build software-rendered framebuffer, aspect-correct letterboxed into the canvas. CV-typed gate inputs (up/down/left/right, fire, altfire, use, jump, crouch, weapnext/weapprev, esc, enter) drive the marine from cables, and the focused card also captures the keyboard. Stereo audio_l/audio_r outputs are wired but silent in v1 (the PCM bridge is stubbed). The card boots OUT-OF-BOX: the 1997 Blood SHAREWARE data ("The Way of All Flesh", episode 1: maps E1M1-E1M8) is bundled under static/blood/ and LFS-tracked, so no picker is needed. The "Load full Blood data…" picker is an optional override — supply a copy of the full game you own (GOG/Steam One Unit Whole Blood or Fresh Supply) to play all episodes.',
  bluebox:
    'DTMF dialer with phreaker buttons. 12-key phone keypad — digits 0-9 emit the Bell-System dual-tone pair (row + col, e.g. "5" → 770 Hz + 1336 Hz); BLUEBOX emits a single 2600 Hz sine (the AT&T in-band supervisory tone that 1970s phreakers used to seize long-distance trunks); REDBOX emits 1700 + 2200 Hz summed (the US payphone coin-acceptance pair). Each key is push-to-talk — pointerdown on the card OR a gate cable into the matching gate_<name> input holds the key down. Multiple held keys sum, and shared frequencies (e.g. "1" and "4" both pull col=1209) collapse onto a single shared phase accumulator so simultaneous presses produce a louder tone, not a flam. No envelope or musical AD — bare on/off sines with a ~1 ms anti-click ramp at the boundary.',
  callsine:
    'Spectral-analysis additive resynthesizer (clean-room port of Warren\'s Spectrum / CallSine, MIT-licensed). Reads incoming mono audio, runs an FFT-based partial tracker (Hann window → peak detection → McAulay-Quatieri-lite tracking → optional F0 harmonic lock) and rebuilds the sound as an additive bank of up to 64 oscillators. Plaits-style macros: HARMONICS sets the partial count, TIMBRE the smoothing/slew time, MORPH the harmonic-LOCK strength (snaps partials to an F0 grid), LEVEL the output gain. A PITCH (V/oct) input transposes the whole resynth; a GATE input toggles FREEZE, latching the current partials at their current frequencies/amplitudes for sustained pads. Ships 14 voice models (SINES, SAW, SQR, PULSE25, TRI, RAMP, CHEBY3/5, HARDSYNC, FOLD, NOISE, FORMANT, SUBOSC, METAL) that swap the per-partial waveform from pure sinusoids to richer/inharmonic shapes.',
  samsloop:
    'Loop-based sample player. Upload an audio file (≤2 MB — wav / mp3 / m4a / ogg / flac / opus) or record from patched audio inputs in place; the clip is decoded to mono and played back from a fractional read-cursor with linear interpolation, so a single rate control covers varispeed including reverse. IDLE-BY-DEFAULT: a freshly loaded sample sits SILENT and does NOT auto-play — and a saved patch reloads idle too. Playback is started by a TRIGGER, which is MODE-AWARE: in one-shot mode (1-SHOT) a trigger plays the sample through once then returns to silence; in loop mode (LOOP) a trigger starts looping (a re-trigger restarts from the window edge). The trigger comes from BOTH the TRIG gate input (a rising edge) AND the on-card TRIGGER button (a momentary pulse to the worklet that works whether or not a cable is patched into TRIG). The RATE slider spans −2 (reverse 2×) through +1 (forward unity, the centered no-op) to +2 (forward 2×), and a rate CV input sums on top (±1 V = ±100%). START / END faders set the playback window. Holds exactly one sample at a time — a new upload or recording replaces the previous buffer (no playlist, no slots), which keeps the per-instance memory ceiling deterministic.',
  swolevco:
    'Buchla 259-style complex waveform generator — the "swole VCO" of the lineup: a primary oscillator and a sine modulator in one module. The primary blends saw → triangle → square via the SYMMETRY control, then passes through a West-Coast wavefolder (FOLD). TIMBRE is audio-rate cross-modulation: the modulator FMs the primary (up to ~±4 semitones of deviation) for the classic Buchla harmonic complexity. Pitch is 1 V/oct (0 V = C4) with tune/fine knobs. Outputs the folded primary, the raw modulator, and a summed mix, plus a mono-video SCOPE output of the primary waveform for cross-domain video patching. Pure Web Audio, modeled after ILLOGIC\'s structure.',
  wavecel:
    'Stereo wavetable oscillator with morph, stereo spread, and a West-Coast wavefolder — a more advanced sibling of WAVETABLEVCO. MORPH scans the wavetable frame position, SPREAD detunes/widens the stereo image, FOLD adds wavefolding harmonics. Ships factory wavetables and accepts runtime upload of E352-format WAV wavetables (frames ride the Y.Doc out to every rack-mate). The card offers a 3D wavetable visualization in addition to the standard scope view. A POLY input (polyPitchGate) accepts the 5-voice chord bus from MIDI LANE (mode=poly) or POLYSEQZ: when any lane is gated WAVECEL renders one wavetable voice per gated lane at that lane\'s pitch and sums them — the morph/spread/fold timbre is shared across all voices. With nothing patched to poly the mono `pitch` path runs unchanged. A per-voice amplitude ADSR (Attack / Decay / Sustain / Release) plus a BASE VOL knob shape each voice. GATING is decided by what is PATCHED: when the POLY bus OR the mono TRIGGER is connected, WAVECEL is a GATED voice — a lane/voice sounds only while it is gated-or-releasing, and a never-gated lane is SILENT (patching poly never auto-drones). When NEITHER is patched, WAVECEL is a continuous raw VCO. BASE VOL is a per-voice VCA FLOOR the envelope rides on top of: gain = base + (1-base)·env per ACTIVE voice — base=1 (default) means the env does nothing (full gain), base=0 is pure ADSR (silent between notes), 0.5 floors at 0.5 and rises to 1.0 at the env peak. For the raw-VCO case (nothing patched) the env is idle so the gain is exactly BASE VOL, so the default of 1 is the legacy continuous drone (byte-identical) and BASE VOL doubles as the raw-VCO level. In poly mode each lane\'s gate edge drives its own envelope (one envelope per voice, soft/click-safe retrigger — re-gating a still-releasing voice attacks from the current level, never pops); the mix is normalized over ACTIVE voices (1/sqrt(N)) so a sustain=0 held note doesn\'t pump the level and a releasing tail doesn\'t pop. The ADSR + BASE VOL params read live (continuous k-rate) across all stages, so a held chord rides sustain/release in real time and a fresh note attacks at the value present at its trigger moment. Edge detection is block-rate (retrigger granularity floor ≈ one audio block); connectedness (poly/trigger patched) is read from the live patch edges, not bus presence.',
  fader:
    'Two-source video mixer with a send/return FX loop. IN A and IN B are crossfaded by a horizontal A/B fader (0 = A, 1 = B); the crossfade SHAPE is picked from a transition dropdown — fade (uniform), wipe (soft edge sweeping left→right), dissolve (random per-cell reveal), star (a 5-point iris from the centre), or checkerboard (staggered cells). That A/B mix is exposed on the SEND output as a copy: patch SEND through any external video FX chain and bring the processed result back into RETURN. A second DRY/WET fader (with its own transition dropdown) blends the dry mix (0) against the wet return (1) to produce the main OUT — so you can fade the effect in and out, or transition into it with a wipe/dissolve/star/checker. 3 video inputs (A / B / RETURN), 2 video outputs (OUT = main mix, SEND = pre-FX copy). With nothing patched both outputs are black. The blend math is deterministic + unit-tested; both faders default to fade.',
  foxy:
    'Hybrid audio-visual module that hides a whole signal chain in one box: a miniature SWOLEVCO drives an internal RASTERIZE (audio painted as a drifting raster), which is downsampled to 256×256 and run through a simplified RUTTETRA "XYZ" forward-scatter scope; the XYZ height field is converted in realtime into an animated wavetable (64 frames × 256 samples, throttled to ~24 Hz) fed to an internal WAVECEL wavetable VCO. The on-card 3D wavetable display visibly animates as the field evolves. Exposes WAVECEL\'s full control + IO surface (tune/fine/morph/spread/fold; pitch/fm + morph_cv/spread_cv/fold_cv; out_l/out_r + scope_out + wave3d_out) plus the mini-SWOLEVCO source controls and the XYZ shape/displacement knobs. The video stages run CPU-side on the main thread (no GL inside the audio node); only the WAVECEL stage is a real worklet.',
  wavesculpt:
    'Hybrid 4-oscillator 3D video synth. Four wavetable "wall oscillators" sit on the faces of a 3D unit box, each emitting a colored wave ribbon (RED / GREEN / BLUE / ALPHA) that points into the box; a single user camera renders the scene, positioned via an XY pad (X/Y) and a HEIGHT slider (Z). Audio out is the sum of the four oscillators, each weighted by its per-osc ADSR and by camera↔source distance — the distance gain is the single source of truth shared by audio and visuals, so "closer = louder = bigger ribbon" stays consistent across both domains. Per oscillator: tune/fine, wavetable morph, stereo spread, wavefolder, thickness, and ADSR; camera zoom + Y-rotation shape the view. All four oscillators run in one worklet for a tight audio-rate path. Six cross-domain VIDEO WALL inputs (wall1–wall6) texture an upstream video module onto the six faces of the room (FRONT/BACK/LEFT/RIGHT/FLOOR/CEILING) seen from inside; each face has a TRANSPARENCY knob (0–100%) blending the wall over the scene and a DISTORT knob (0–1) that morphs the flat wall into a convex dome we look up into. Patch the video output back into a wall input for recursive video feedback.',
  cube:
    '3D wavetable-navigator oscillator. Builds a 3D scalar field — "the cube," a space that is a mix of solid and filled — out of THREE e352 wavetables (FLOOR / WALL / CEILING, each independently chosen from WAVESCULPT\'s full preset set, defaults FLOOR=basic-shapes, WALL=harmonic-sweep, CEILING=basic-shapes), then flies an arbitrary planar SLICE through the field and reads it back as the played waveform via a SURFACE-HEIGHT SCAN: for each of 256 x-positions the sample = how far the solid extends along the slice (intersection depth), so the cube\'s shape literally becomes the wave. MORPH connects the wall to the floor (at min) or the ceiling (at max), weighted-averaged in between; CONNECT morphs the connecting curve from a circle arc to a sawtooth-V touching the floor, and CONNECT STRENGTH overshoots the connector\'s interior control point "out of the cube" for a dramatic swell of the solid base (0 = today\'s exact shape). The slice navigates with Y (up/down) + Rot X/Y/Z (Euler rotation on all 3 axes). MATERIAL switches SMOOTH (continuous density) ↔ HARD (binary solid in/out). CRUSH is a 3D bitcrush reducing spatial-grid + amplitude resolution (default 0 = transparent → blocky/steppy at max); SPACE CRUSH is an independent spatial voxelization of just the FIELD lookup coordinates (chunky voxels, 0 = transparent), and SPACE DIFFUSE applies a gravity that pulls the sampled cloud toward the cube\'s lowest-information (emptiest) wall — the target wall latches when the tables/morph change, not as the knob moves (0 = off). WRAP toggles whether a slice extending outside the cube is silent (default) or mirror-folds back to the opposite side. A V/oct pitched oscillator (pitch input + tune/fine) with stereo L/R SPREAD on SEPARATE L and R output ports (max ±18% of the cube depth between channels — the L slice is read below center, the R above, so the spread is clearly audible and survives patching into mono inputs). View-only Zoom + Rot X/Y/Z orbit the WebGL2 3D cube visualization (the scalar field rendered as a translucent voxel slice-stack with the live selection slice shown as a square plane cutting through it) without affecting the sound or the selected slice. CV inputs cover the expressive params (slice Y/rotation, morph, connect, connect strength, crush, space crush, space diffuse, fold, tune). A POLY input (polyPitchGate) accepts the 5-voice chord bus from MIDI LANE (mode=poly) or POLYSEQZ: when any lane is gated CUBE runs one phase accumulator per gated lane through the SAME posted slice waves at that lane\'s pitch and sums them — polyphonic, with the slice/field timbre shared across voices; with nothing patched to poly the mono `pitch` path runs unchanged. A per-voice amplitude ADSR (Attack / Decay / Sustain / Release) plus a BASE VOL knob shape each voice. GATING is decided by what is PATCHED: when the POLY bus OR the mono TRIGGER is connected, CUBE is a GATED voice — a lane/voice sounds only while it is gated-or-releasing, and a never-gated lane is SILENT (patching poly never auto-drones). When NEITHER is patched, CUBE is a continuous raw VCO. BASE VOL is a per-voice VCA FLOOR the envelope rides on top of: gain = base + (1-base)·env per ACTIVE voice — base=1 (default) means the env does nothing (full gain), base=0 is pure ADSR (silent between notes), 0.5 floors at 0.5 and rises to 1.0 at the env peak. For the raw-VCO case (nothing patched) the env is idle so the gain is exactly BASE VOL, so the default of 1 is the legacy continuous drone (byte-identical) and BASE VOL doubles as the raw-VCO level. In poly mode each lane\'s gate edge drives its own envelope (one per voice, soft/click-safe retrigger), and the mix is normalized over ACTIVE voices (1/sqrt(N)) so a sustain=0 held note doesn\'t pump and a releasing tail doesn\'t pop. The ADSR + BASE VOL params read live (continuous k-rate) across all stages. Edge detection is block-rate (retrigger granularity floor ≈ one audio block); connectedness (poly/trigger patched) is read from the live patch edges, not bus presence. Pure deterministic field/slice DSP in cube-dsp.ts is reused verbatim by node-ART AND by the card\'s 3D render, and the surface-height scan runs OFF the audio thread (computed on the main thread, posted to the worklet) so sweeping params never drops the audio out. v1 is audio-only; a cross-domain viz_out video raster is a planned follow-up.',
  hypercube:
    '4D tesseract oscillator — a sibling of CUBE that extends the 3D wavetable-navigator field into a FOURTH dimension. On top of CUBE\'s FLOOR / WALL / CEILING wavetables it adds a fourth "HOLO" wavetable (default basic-shapes, the same as floor/ceiling, so a fresh HYPERCUBE is benign) and an ALPHA axis (0..1) — the slice\'s 4th-dimension (w) coordinate. The 2D slice is still ray-marched through a 3D field, but ALPHA selects WHICH 3D field by blending the field\'s occupancy toward the HOLO cell: f4 = (1-alpha)·f3 + alpha·dH, a genuine tesseract cross-section (NOT a 4D march — one extra occ() per step). ALPHA is a continuous, CV-able morph defaulting to 0, where HYPERCUBE collapses byte-for-byte to a plain 3-table CUBE render (off = identity). Everything else mirrors CUBE: MORPH connects the wall to floor/ceiling; CONNECT morphs the connecting curve circle↔V; the slice navigates with Y + Rot X/Y/Z; MATERIAL switches SMOOTH↔HARD; CRUSH is a 3D bitcrush; WRAP toggles silent-outside vs mirror-fold; FOLD is a West-coast wavefolder; a V/oct pitched oscillator (pitch + tune/fine) with stereo L/R SPREAD on SEPARATE L and R output ports; view-only Zoom + Rot X/Y/Z orbit the WebGL2 visualization. CV inputs cover slice Y/rotation, morph, connect, crush, fold, ALPHA, and tune. The pure deterministic field/slice DSP is shared with CUBE in cube-dsp.ts (the HOLO/ALPHA additions are no-ops when absent) and the surface-height scan runs OFF the audio thread so sweeping ALPHA never drops the audio out.',
  macseq:
    '16-step sequencer with a per-step MACROOSCILLATOR voice picker. Each step carries an on/off gate, a MIDI note, and a synthesis-model index. Outputs PITCH (V/oct), GATE (fires on every on-step), CLOCK (a 10 ms pulse per advance for chaining), and MODELCV — a CV cable carrying the step\'s selected model index, rescaled into the project\'s bipolar ±1 convention so it lands on MACROOSCILLATOR\'s discrete model_cv input and reconstructs the integer at the other end. Empty model steps hold the last emitted model (the first emit defaults to model 0 / VA), so sparser patterns "leave it where it was." Lets one sequencer drive both the pitch and the timbre/engine of a MACROOSCILLATOR voice.',
  writeseq:
    'RECORDING step-sequencer: the app\'s usual step sequencer PLUS live recording from a CV/gate source (e.g. MIDI CV BUDDY / a mini-keyboard via MIDI→CV). The incoming CV (pitch, 0V = C4) + GATE pass through to the outputs at all times (live monitoring) ALONGSIDE sequenced playback — a held live gate WINS over the sequenced step. Arm RECORD (the rec gate input also toggles arm) and each incoming gate writes its sampled pitch+gate to the step nearest the press (snap-to-nearest quantization); recording starts by jumping to step 1. If the sequencer is STOPPED but armed, a gate event STARTS the sequencer + recording (internal clock only — an external clock that is stopped emits no pulses, so a gate there only passes through). NOT overdubbing: record runs one pass up to LENGTH steps then stops recording (auto-disarms) and loops to play through. OVERDUB: keep looping, layering new events on top. STEP CLOCK: an external clock patched into CLOCK IN drives one step per rising edge (respecting its timing); unpatched, WRITESEQ runs its own internal BPM. RUN/RECORD state is INDEPENDENT of TIMELORDE — it is armed + started by the user, never auto-started/stopped with the system clock. Outputs PITCH (V/oct) + GATE (the sequenced outputs, with live pass-through) + CLOCK (a 10 ms pulse per advance). Sharing one clock with a drum module (e.g. DRUMSEQZ / DRUMMERGIRL) records a key in time with the beat onto the SAME step the drum hits — no off-by-one in either direction. The data model reserves a per-step shift field for a future swing-to-1/4-step feature (not yet implemented).',
  delay:
    'Simple stereo delay line — time, feedback, and dry/wet mix. Built on Web Audio\'s native DelayNode with a feedback gain loop (input → delay → feedback → output, mixed with dry), the canonical delay topology. TIME ranges log from ~1 ms (slapback) to 2 s (ambient washes), FEEDBACK is linear 0–0.95 with a hard ceiling to prevent runaway self-oscillation, and a time CV input sums onto the knob. The same delay type backs WAVESCULPT\'s FX slot, so its character matches whether patched inline or used as a slot effect.',
  attenumix:
    'The simple mixer — a 4-channel attenuating mixer with per-channel direct outs and a master gain. Each channel\'s level is knob + CV summed and clamped to 0..1 (attenuators only attenuate, never boost), giving a per-channel direct out; all four sum into a master (0..2) with a tanh soft-clip so pushing the master past unity stays musical. Compared to VEILS (same quad-VCA-plus-mix topology) ATTENUMIX has no per-channel boost and no linear/exponential toggle — it is the no-surprises "the mixer" where every knob does exactly what it says. CV inputs are passthrough-by-design so a ±1 V LFO at knob=0 sweeps a channel\'s full open range.',
  joystick:
    'Manual XY controller emitting four bipolar CV outputs. Drag a virtual stick inside a square pad: center = (0, 0), the corners reach (±1, ±1). Outputs the raw X and Y plus their inversions (nx = −x, ny = −y) so you can drive quadrature or mirrored modulation from one hand without copying and inverting downstream. The card snaps back to center on pointer-up; at the audio layer the module is pure — whatever the position params say is what comes out (four ConstantSourceNodes).',
  moog956:
    '956 Ribbon Controller (moogafakkin System 55 clone — categorized under Ports -> moogafakkin). A horizontal touch-ribbon: press and slide along the strip and the position maps to a continuous pitch CV, with a GATE that goes HIGH while touched. Outputs pitch (V/oct: 1.0 = one octave, a semitone = 1/12, matching MIDI CV BUDDY) and gate. Like the hardware resistive ribbon, lifting off HOLDS the last pitch — only the gate falls, so the patched VCO stays at the last played note. SCALE sets the ribbon span in octaves (0..5, default 2); OFFSET shifts the base pitch in octaves (-2..2). A UI-driven CV source in the JOYSTICK / GAMEPAD family — the card pointer drives two ConstantSourceNodes; no audio worklet. Beige moogafakkin faceplate. The on-screen keyboards (950/951/952) are intentionally NOT cloned — route hardware MIDI keys through MIDI CV BUDDY instead.',
  modtris:
    'Interactive Tetris-clone game module (single-user research prototype). Five gate inputs (rotate_l / rotate_r / drop_fast / move_l / move_r) are rising-edge triggered to play the game; two gate outputs fire one 5 ms pulse per event — line_cleared (a Tetris emits four separate staggered pulses, one per line) and overfill (game over). Game logic runs at visual cadence on the main thread (no audio worklet), with a deterministic, tested state stepper. Patch a sequencer or controller into the inputs and route the cleared-line / overfill gates as triggers, turning gameplay into a modulation source. See docs/design/game-modules.md.',
  frogger:
    'Interactive Frogger game module (clean-room TypeScript port of Adrian Eyre\'s React Frogger, MIT-licensed). FULL CV-gate control with NO keyboard exposure on the module: five gate inputs (up_gate / down_gate / left_gate / right_gate / start_gate) are rising-edge triggered to play the game. The start_gate auto-fires once on module-spawn (a synthesized first-tick rising edge) so the user sees a running game by default — the upstream React app\'s pre-game InfoBoard ("click Start Game") is bypassed via this synthetic pulse. The same start_gate is rising-edge triggered by external CV to restart at any time. Three gate outputs fire one 5 ms pulse per event: home_gate (a frog reached one of the 5 home slots — fires up to 5 times per level), dead_gate (frog hit a vehicle, fell in water without a raft, or the per-level timer ran out), level_gate (all 5 homes filled — level complete). One knob: TIME (10..120 s, default 60) sets the per-level timer budget. Game logic runs at visual cadence on the main thread (no audio worklet); pure deterministic state stepper in frogger-state.ts. vizPassthrough: the on-card 14×13 grid canvas can be portaled into a containing GroupCard for cross-domain video out (same mechanism MODTRIS / PONG / SCOPE use). See docs/design/game-modules.md for the multi-user follow-up path.',
  pong:
    'Interactive Pong game module (single-user research prototype). Two CV inputs (paddle_left / paddle_right) set each paddle\'s Y position; two gate outputs (score_left / score_right) fire one 5 ms pulse per scoring event, sample-accurate on the audio thread. The deterministic state stepper runs at visual cadence on the main thread (no audio worklet). Drive the paddles from LFOs / envelopes / joysticks and use the score gates as triggers — the game becomes a generative modulation source. Multiplayer is a planned additive follow-up (the design doc lays out the SyncedModuleDef path). See docs/design/game-modules.md.',
  skifree:
    'The classic SKIFREE (ski downhill, dodge trees / rocks / jumps, get chased and EATEN by the abominable snowman) as a CV-controlled game module — a thin wrapper around the upstream skifree.js engine (MIT, Daniel Hough 2013). Single-instance per rack (maxInstances:1). Two bipolar CV inputs (x / y, −1..+1) synthesize the mouse cursor the skier steers TOWARD: x = cursor X across the canvas (0 = left edge, +1 = right edge), y = cursor Y (the skier always heads downhill; cursor position sets the steering angle + speed). When x and y are BOTH unpatched AND the card is focused, native mouse control engages — steer the skier with the real mouse directly on the canvas. Any patched CV OVERRIDES the mouse (the factory writes the CV cursor each scheduler tick; the card disables mouse). One gate output: a rising-edge 10 ms pulse on every CRASH (hitting a tree / rock / snowboarder / failed jump) OR when the yeti EATS the skier — hooked to the engine\'s hasHitObstacle callback (upstream fires it for crashes and, via isEatenBy, for eats), so the game becomes a trigger source for envelopes / sequencers. One video output (out): the game canvas mirrored each video frame via the cross-domain audio→video bridge — patch SKIFREE → VIDEO OUT / BENTBOX / any video module to send the ski-slope render downstream (mirrors the DOOM `out` pattern). vizPassthrough on the on-card canvas so a containing GROUP can portal it across-domain. No audio worklet — the gate is a ConstantSourceNode pulsed on the event (PONG\'s pattern); the game logic runs at rAF cadence inside the bundle. Bundle committed pre-built at /skifree/skifree.bundle.js (~24 KB, esbuild IIFE of the upstream js/ classes + a thin embed wrapper); sprite sheets at /skifree/*.png. See packages/web/native/skifree/README.md for the regeneration recipe + attribution.',
  slewSwitch:
    'Quad slew limiter combined with a 4→1 sequential CV switch. Four CV inputs each pass through an independent slew limiter (per-channel time constant 1 ms–5 s, CV-controllable) for portamento / smoothing, available on out1–out4. A step_clock gate advances a sequential switch that selects among the (slewed) channels and presents the result on `switched`, with a LENGTH (1–4) and MODE control, a crossfade time between selections, a reset gate, a step_idx CV, and an end-of-cycle (eoc) gate. One of the three ATLANTIS-PATCH support modules; broadly useful as a general CV smoother + router.',
  sampleHold:
    'Sample & hold combined with a musical scale quantizer. On a RISING EDGE at gate_in the module samples cv_in and HOLDS it on cv_out until the next rising edge; cv_quant is that held value snapped to the nearest note of the selected SCALE (1V/oct, root = C / 0V, 12 equal-tempered semitones per octave, 1/12 V per semitone). When NOTHING is patched to gate_in, cv_in passes through CONTINUOUSLY and cv_quant continuously quantizes the live input — so the module becomes a pure QUANTIZER (the gate-connected state is detected at the graph level, mirroring SEQUENCER/SCORE external-clock-vs-internal-BPM and SKIFREE\'s unpatched-input fallback). The SCALE knob picks the quantize scale from Chromatic, Major, Minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, Harmonic Minor, Melodic Minor; the current scale NAME is displayed above the knob and updates reactively (knob / CV / MIDI Learn). The latch + nearest-note quantizer are pure functions (packages/dsp/src/lib/sample-hold-dsp.ts) shared verbatim by the worklet, the unit tests, and node-ART. Classic uses: quantize a slow LFO/random voltage into stepped melodies, sample noise on a clock for stepped random pitches, or strip the gate to use it as an inline quantizer in front of a VCO\'s pitch input.',
  fourplexer:
    '4-in / 4-out discrete signal router for audio AND cv (they share the Web Audio substrate, so either cable type patches in and routes identically). Four signal inputs (in1..in4) and four signal outputs (out1..out4); each output has its own selector knob (sel1..sel4, shown 1..4 on the card) choosing which ONE of the four inputs that output carries — discrete, never a blend or in-between, with a ~4 ms declick crossfade on the switch so audio-rate inputs don\'t click. Each output also has its own GATE input (gate1..gate4): every rising edge advances that output\'s selector to the next input (1→2→3→4→1, wrapping). The four outputs are fully independent — different selections, different gate streams. Knobs are directly settable in the UI (click/drag to a position) and the selection persists in node params (synced + saved); a gate-advance posts the new index back so it persists exactly like a manual click. Defaults are a straight pass-through (out1=in1, out2=in2, out3=in3, out4=in4).',
  gatemaiden:
    'Single-input gate↔trigger converter — the convenience utility for the trigger/gate model (think Doepfer A-162 / Make Noise Maths EOR-EOC in one small module). ONE generic CV input (IN) accepts EITHER a gate or a trigger, and produces BOTH a GATE output and a TRIG output, derived from the input\'s level + rising edges (no mode switch — like Maths, it always emits both). GATE out is a held square that stays high while the input is high, with a MINIMUM width of the Len knob (0.005–2 s, default 50 ms): so a long gate passes through duration-matched, while a short TRIGGER in is widened into a clean usable gate (trigger→gate). TRIG out fires a short pulse on EVERY rising edge of the input: so a GATE in yields one trigger per gate START (gate→trigger), and a TRIGGER in is effectively reshaped through (one pulse per input pulse). The Shape button picks the emitted trigger waveform — △ triangle (default, a 5 ms ramp-up/ramp-down strike) or ▭ square. In the trigger/gate model: ▷ marks the trigger output, ▭ the gate ports. Why you want it: anything that must START an event should be a trigger (edge-fired once), anything that must SUSTAIN should be a gate (level-held); GATEMAIDEN lets you convert freely between the two when you cross-patch — e.g. take a sequencer\'s held step-gate and get a clean clock trigger out of its starts, or take a drum trigger and open an ADSR\'s sustain with a real gate. Sample-accurate DSP (pure core in packages/dsp/src/lib/gatemaiden-dsp.ts), so it single-fires by construction.',
  gibribbon:
    'GIBRIBBON (video) — a Vib-Ribbon spiritual successor rendered with DOOM shareware-WAD sprites. A single white vector "ribbon"/ground line scrolls right→left on black (Vib-Ribbon\'s exact line-art grammar: the ground dips into a pit V for a LOOP, rises into a hump for a JUMP), while imp (TROO*) and zombie/former-human (POSS*) enemies — REAL sprites decoded from the same DOOM1.WAD the DOOM module uses — ride the ribbon in from the right. The player character is the green DOOM marine (PLAY*). An overhead ABXY prompt strip shows the button each upcoming event needs. FOUR events map to the four ABXY buttons: LOOP (A), JUMP (B), IMP SPAWN (X), ZOMBIE SPAWN (Y); a correct, in-window press clears the obstacle (marine loops/jumps) or fires-and-kills the enemy (it plays its DOOM death animation). Missing an event degrades the marine down a DOOM-flavoured health ladder (super → healthy → wounded → critical → GAME OVER); clean streaks recover rungs and reach a SUPER state. Inputs: cv1..cv4 (modsignal — drive event GENERATION from slow Synesthesia envelopes; each channel maps to one event kind), clock (the 1× scroll/tempo tick), gate (the beat — biases which CV channel spawns), x + y (joystick axes), and four ABXY button gates a / b / x_btn / y_btn (named to disambiguate from the x/y axes). Outputs: out (video), evt_hit / evt_miss / evt_fire / evt_kill / evt_gameover (10 ms gate pulses), and health_cv (marine vitality 0..1). Event generation is a PURE deterministic function of the inputs (gibribbon-events.ts) with all CV→event thresholds in a single tunable GIB_TUNING block; sprite extraction is a PURE WAD picture/PLAYPAL decoder (wad-sprites.ts) run at load time. DOOM1.WAD stays gitignored + fetched like the DOOM module; without it the game falls back to line-art placeholder figures so it still plays. DOOM shareware terms apply (same as the DOOM module).',
  twotracks:
    'Two-reel tape loop emulator with record, overdub, scrub and Lofi character. Phase 1 ships reel A: patch stereo audio into L/R inputs, arm with the ARM gate or REC gate, and the tape records destructively (REC mode) or additively (OVERDUB mode, with a DECAY knob that fades previous passes by 0.50–0.90× per loop). A draggable blue playhead scrubs the cursor within the current window (START/END markers); rate is varispeed (1.0 = forward unity, negative = reverse, 0 = frozen). Mode toggle selects TAPE (one-shot: record one pass then play, play once then stop) or LOOP TAPE (loops continuously). Transport state is reflected by REC/ARM/PLAY/OVERDUB LEDs. Gate inputs for all transport events so gates or sequencers can drive the transport via cable. Save tape exports the current buffer as a stereo 48 kHz 16-bit WAV. Phase 2 adds reel B, EQ, and filter; Phase 3 adds Lofi saturation; Phase 4 adds CV ins and persistence polish.',
};

const PORT_NOTES: Record<string, string> = {
  'recorderbox.in': 'The picture to record + monitor. Polymorphic video input (video / mono-video / image upcast), like OUTPUT.in.',
  'recorderbox.audio_l': 'Left channel of the soundtrack to record. Cross-domain audio→video audio-input: the source is connected straight into a MediaStreamAudioDestinationNode this module owns. TAP-ONLY — NOT monitored through the speakers.',
  'recorderbox.audio_r': 'Right channel of the soundtrack to record (same cross-domain audio-input bridge as audio_l).',
  'recorderbox.out': 'Pass-through of the IN video (input → FBO → out), so RECORDERBOX can be chained inline without breaking the signal flow.',
  'pentemelodica.poly': '5-lane poly pitch/gate chord bus (from MIDI LANE / POLYSEQZ / a chord sequencer). Lane i drives voice i (fixed 1:1 mapping); each lane gates that voice\'s ADSR.',
  'pentemelodica.fm1': 'Audio-rate FM/PM modulator for voice 1 (drives both the exponential FM and through-phase PM depths set by voice 1\'s FM / PM faders).',
  'pentemelodica.fm2': 'Audio-rate FM/PM modulator for voice 2 (depths set by voice 2\'s FM / PM faders).',
  'pentemelodica.fm3': 'Audio-rate FM/PM modulator for voice 3 (depths set by voice 3\'s FM / PM faders).',
  'pentemelodica.fm4': 'Audio-rate FM/PM modulator for voice 4 (depths set by voice 4\'s FM / PM faders).',
  'pentemelodica.fm5': 'Audio-rate FM/PM modulator for voice 5 (depths set by voice 5\'s FM / PM faders).',
  'pentemelodica.out_l': 'Stereo mix output, left (post-mixer, post-filter, post-master-gain).',
  'pentemelodica.out_r': 'Stereo mix output, right (post-mixer, post-filter, post-master-gain).',
  'pentemelodica.voice1': 'Voice 1 pre-mixer mono tap (post-ADSR, before LEVEL/PAN).',
  'pentemelodica.voice2': 'Voice 2 pre-mixer mono tap (post-ADSR, before LEVEL/PAN).',
  'pentemelodica.voice3': 'Voice 3 pre-mixer mono tap (post-ADSR, before LEVEL/PAN).',
  'pentemelodica.voice4': 'Voice 4 pre-mixer mono tap (post-ADSR, before LEVEL/PAN).',
  'pentemelodica.voice5': 'Voice 5 pre-mixer mono tap (post-ADSR, before LEVEL/PAN).',
  'analogVco.pitch': 'V/oct pitch input.',
  'analogVco.fm': 'Audio-rate FM input (depth set by FM param).',
  'analogVco.saw': 'Sawtooth output.',
  'analogVco.square': 'Square output (PW-modulated).',
  'analogVco.triangle': 'Triangle output.',
  'analogVco.sine': 'Sine output.',
  'wavetableVco.pitch': 'V/oct pitch input.',
  'wavetableVco.fm': 'Audio-rate FM input.',
  'wavetableVco.wavePos': 'CV -> wavetable scan position.',
  'wavetableVco.audio': 'Mixed wavetable output.',
  'moog921Vco.pitch': 'V/oct pitch input (0V = C4). Exponential frequency control.',
  'moog921Vco.lin_fm': "Linear frequency-control input (the 921's dedicated linear FM input); depth set by the Lin FM param.",
  'moog921Vco.sync': 'External sync source. Rising edges reset/nudge the phase per the SYNC switch (soft/off/hard).',
  'moog921Vco.width_cv': 'Audio-rate pulse-width CV. Summed onto the WIDTH knob per-sample in the worklet (PASSTHROUGH_BY_DESIGN — width param already bounded 0.02..0.98, sum is clamped to range).',
  'moog921Vco.sine': 'Sine output.',
  'moog921Vco.triangle': 'Triangle output.',
  'moog921Vco.sawtooth': 'Band-limited sawtooth output.',
  'moog921Vco.rectangular': 'Rectangular/pulse output; duty cycle = WIDTH.',
  'moogCp3.in1': 'Mixer channel 1 input (audio or cv).',
  'moogCp3.in2': 'Mixer channel 2 input (audio or cv).',
  'moogCp3.in3': 'Mixer channel 3 input (audio or cv).',
  'moogCp3.in4': 'Mixer channel 4 input (panel jack; audio or cv).',
  'moogCp3.ext4': "4th-input EXTERNAL jack. Summed with in4 then scaled by the 4th-input ATTENUATOR (at \"10\"/1.0 = unity, direct patch passes unaltered). PASSTHROUGH_BY_DESIGN — it's the signal being attenuated, summed at audio-rate in the worklet, not a knob modulator.",
  'moogCp3.out_positive': '(+) summed output: (in1*ch1 + in2*ch2 + in3*ch3 + ((in4+ext4)*att4)*ch4).',
  'moogCp3.out_negative': '(-) output: the exact phase-inverse of the (+) output.',
  'moogCp3.multiple_one': 'MULTIPLE out 1 — in1 passthrough (1 -> 3 multiple).',
  'moogCp3.multiple_two': 'MULTIPLE out 2 — in1 passthrough (1 -> 3 multiple).',
  'moogCp3.multiple_three': 'MULTIPLE out 3 — in1 passthrough (1 -> 3 multiple).',
  'moogCp3.plus_twelve': 'Constant +12V trunk reference (normalized: +2.4 at +-5V = +-1).',
  'moogCp3.minus_six': 'Constant -6V trunk reference (normalized: -1.2 at +-5V = +-1).',
  'moog904a.audio': 'Signal in (the audio to filter) / 24 dB/oct low-pass out (self-oscillating sine near regeneration=1).',
  'moog904a.cutoff_cv': 'Summing 1V/oct CONTROL INPUT. Each volt shifts the cutoff one octave; summed onto the Cutoff knob + RANGE per-sample in the worklet (PASSTHROUGH_BY_DESIGN — the worklet owns the exponential map + clamp).',
  'moog904a.reso_cv': 'REGENERATION CV. Summed onto the Regen knob per-sample in the worklet (PASSTHROUGH_BY_DESIGN — clamped 0..1); push toward 1 to drive self-oscillation.',
  'moog911.gate': 'S-trigger / gate input. Rising edge starts the contour (ATTACK over T1); falling edge forces the FINAL DECAY (T3) regardless of the current stage.',
  'moog911.t1_cv': 'CV for T1 (attack time). Log-scaled: a -1..+1 sweep covers the param\'s full log range centered on the knob.',
  'moog911.t2_cv': 'CV for T2 (initial-decay time). Log-scaled, like T1.',
  'moog911.esus_cv': 'CV for ESUS (sustain level). Linear-scaled across 0..1.',
  'moog911.t3_cv': 'CV for T3 (final-decay time). Log-scaled, like T1.',
  'moog911.env': 'Envelope contour output, unipolar 0..1.',
  'moog911.env_inv': 'Inverted envelope output (1 - env) for ducking / sidechain-style modulation.',
  'moog902.audio': 'SIGNAL input (the audio to be amplified) / OUT — the amplified signal (signal x gain, where gain follows the LIN/EXP law against the control sum).',
  'moog902.cv': 'Summing CONTROL INPUT. Scaled by the CV-amount knob (sign + depth) and summed onto the control voltage per-sample in the worklet (PASSTHROUGH_BY_DESIGN — the worklet owns the gain-law map + x3 clamp). CV = 6 V alone yields x2 (+6 dB).',
  'moog902.fcv': 'Fixed-control-voltage bias — a second summing CONTROL INPUT added straight onto the control sum per-sample (PASSTHROUGH_BY_DESIGN). Push the FCV + signal sum toward ~7.5 V to reach the x3 ceiling.',
  'moog902.audio_inv': 'OUT- — the differential - output: a sample-accurate phase-inverted twin of OUT (for stereo widening / sidechain / mid-side).',
  'audioOut.L': 'Mono L -> host destination L.',
  'audioOut.R': 'Mono R -> host destination R.',
  'cube.L': 'Left audio out (slice read at -SPREAD depth). Separate from R so the stereo SPREAD survives mono inputs.',
  'cube.R': 'Right audio out (slice read at +SPREAD depth). Separate from L so the stereo SPREAD survives mono inputs.',
  'cube.trigger': 'Mono TRIGGER gate for the per-voice amplitude ADSR (drives lane-0\'s envelope when POLY is unpatched). A level gate, not a pulse: rising edge = note-on (attack), falling edge = note-off (release). PATCHING this (or POLY) makes CUBE a GATED voice — silent until the first note, then base-floored (BASE VOL) once active; releasing tails finish. When neither this nor POLY is patched CUBE free-runs as a continuous raw VCO at the BASE VOL level (default 1 = the legacy drone, byte-identical).',
  'cube.base_vol': 'Per-voice VCA FLOOR the ADSR rides on top of: gain = base + (1-base)·env per ACTIVE (gated-or-releasing) voice. 1 (default) = full, the envelope does nothing; 0 = pure ADSR (silent between notes); 0.5 floors at 0.5 and rises to 1.0 at the env peak. A never-gated voice stays silent regardless of base. With nothing patched (raw VCO) the env is idle, so this IS the output level — default 1 = the legacy byte-identical drone.',
  'scaler.in': 'The signal to scale (gets multiplied by AMOUNT). Typed audio but widened to accept the CV family (cv / pitch / gate) so a control voltage can be scaled too.',
  'scaler.out': 'The scaled signal: out = in × amount. TYPE-TRANSPARENT — its cable type adopts whatever is patched into IN (a CV source → a CV out, audio → audio; falls back to audio when nothing is patched), so a scaled CV stays CV through the audio→video bridge and AMOUNT actually scales a video module\'s modulation.',
  'polarizer.in': 'The UNIPOLAR (0..1) control voltage to polarize. CV-typed (this is CV math). The affine map out = (2·in − 1)·depth is defined for any value — it just linearly centers + scales.',
  'polarizer.out': 'The BIPOLAR result: out = (2·in − 1)·depth (in=0 → −depth, in=0.5 → 0, in=1 → +depth). CV-typed.',
  'depolarizer.in': 'The BIPOLAR (−1..+1) control voltage to depolarize. CV-typed. The affine map out = 0.5 + depth·(in/2) is defined for any value.',
  'depolarizer.out': 'The UNIPOLAR result centered on 0.5: out = 0.5 + depth·(in/2) (at depth 1: in=−1 → 0, in=0 → 0.5, in=+1 → 1). CV-typed.',
  'vca.audio': 'Audio input (gets multiplied) / main audio output.',
  'vca.cv': 'Modulation CV (gain control).',
  'vca.audio_inv':
    'Sign-inverted audio output: -out (phase-flipped audio). Useful for stereo widening, side-chain feedback prevention, and mid/side processing. Different operation from ADSR.env_inv (which is 1 - env on a unipolar envelope).',
  'sampleHold.cv_in': 'The value to sample / quantize (1V/oct for pitch).',
  'sampleHold.gate_in': 'Gate / clock. A rising edge latches cv_in onto cv_out. UNPATCHED → cv_in passes through continuously and the module becomes a pure quantizer.',
  'sampleHold.cv_out': 'The held value (or, when gate_in is unpatched, the live passed-through cv_in).',
  'sampleHold.cv_quant': 'cv_out snapped to the nearest note of the selected scale (1V/oct, root = C / 0V).',
  'fourplexer.in1': 'Signal input 1 (audio or cv — routes identically).',
  'fourplexer.in2': 'Signal input 2 (audio or cv).',
  'fourplexer.in3': 'Signal input 3 (audio or cv).',
  'fourplexer.in4': 'Signal input 4 (audio or cv).',
  'fourplexer.gate1': 'Rising edge advances OUT 1\'s selector (1→2→3→4→1).',
  'fourplexer.gate2': 'Rising edge advances OUT 2\'s selector.',
  'fourplexer.gate3': 'Rising edge advances OUT 3\'s selector.',
  'fourplexer.gate4': 'Rising edge advances OUT 4\'s selector.',
  'fourplexer.out1': 'Carries the input selected by sel1 (discrete).',
  'fourplexer.out2': 'Carries the input selected by sel2 (discrete).',
  'fourplexer.out3': 'Carries the input selected by sel3 (discrete).',
  'fourplexer.out4': 'Carries the input selected by sel4 (discrete).',
  'mixer.in1': 'Channel 1 input.',
  'mixer.in2': 'Channel 2 input.',
  'mixer.in3': 'Channel 3 input.',
  'mixer.in4': 'Channel 4 input.',
  'adsr.gate': 'Triggers attack -> decay -> sustain on rising edge; release on falling.',
  'adsr.env': 'Envelope CV out (0..1).',
  'adsr.env_inv':
    'Inverted envelope CV out: 1 - env (unipolar 0..1 flip). When env=0 (rest), env_inv=1; when env=peak=1, env_inv=0. Useful for ducking, reverse-modulation, and "sidechain"-style envelopes. Different operation from VCA.audio_inv (which is a sign flip on bipolar audio).',
  'filter.audio': 'Audio in.',
  'filter.cutoff': 'CV -> cutoff freq.',
  'filter.res': 'CV -> resonance.',
  'reverb.audio': 'Pre-reverb mono in / wet+dry mix out.',
  'scope.ch1': 'Channel 1 in.',
  'scope.ch2': 'Channel 2 in.',
  'scope.ch1_out': 'Channel 1 passthrough.',
  'scope.ch2_out': 'Channel 2 passthrough.',
  'scope.out':
    'Mono-video output: pixel-equivalent of the on-card 2D scope render — both channels, scale/offset, range, XY/split mode, timeMs window. Driven by the cross-domain video bridge calling SCOPE.drawFrame() each video frame, so every scope control affects what downstream video modules see.',
  'scope.timeMs':
    'CV -> time window (ms across canvas width). Mirrors the Time fader 1:1 — the bridge re-reads the same params record so the on-card and video-out renders converge.',
  'scope.ch1Scale': 'CV -> ch1 vertical scale.',
  'scope.ch1Offset': 'CV -> ch1 vertical offset.',
  'scope.ch1Range':
    'CV -> ch1 range (≥0.5 switches to CV ±5 fullscale; <0.5 keeps audio ±1).',
  'scope.ch2Scale': 'CV -> ch2 vertical scale.',
  'scope.ch2Offset': 'CV -> ch2 vertical offset.',
  'scope.ch2Range': 'CV -> ch2 range (≥0.5 = CV ±5, <0.5 = audio ±1).',
  'scope.mode':
    'CV -> XY mode toggle. Any signal ≥ 0.5 flips to XY (ch1 horizontal, ch2 vertical); below 0.5 = split (two stacked traces).',
  'rasterize.in': 'Audio in - the signal rasterized into pixels.',
  'rasterize.thru': 'Audio passthrough (unmodified) so RASTERIZE can sit inline on a chain.',
  'rasterize.out':
    'Mono-video output: the accumulated raster frame as a GL texture. Each video frame paints a run of audio samples (samples/frame) as voltage-per-pixel in raster order; the scan cursor drifts + wraps through the 640x480 frame. A steady tone paints drifting horizontal bands. Driven by the cross-domain video bridge calling RASTERIZE.drawFrame() each frame.',
  'rasterize.cursor': 'CV -> scan-cursor start offset (pixels). Scrubs where the run begins.',
  'rasterize.samplesPerFrame': 'CV -> samples painted per frame (1 pixel per sample).',
  'rasterize.gain': 'CV -> linear gain applied to each sample before the luminance map.',
  'rasterize.wrap':
    'CV -> wrap mode. >=0.5 = clamp (top-to-bottom repaint sweep); <0.5 = wrap (toroidal drift).',
  'sequencer.clock': 'External clock (rising edges advance the step pointer).',
  'sequencer.pitch': 'V/oct pitch out.',
  'sequencer.gate': 'Gate out (high while step is on).',
  'lfo.clock': 'External clock - locks LFO rate to incoming pulses.',
  'lfo.rate': 'CV -> rate AudioParam.',
  'lfo.shape': 'CV -> wave shape.',
  'lfo.phase0': 'LFO at 0deg.',
  'lfo.phase90': 'LFO at 90deg.',
  'lfo.phase180': 'LFO at 180deg.',
  'lfo.phase270': 'LFO at 270deg.',
  'cartesian.clock': 'Step advance (rising edge).',
  'cartesian.x_cv': 'CV scrub on the X axis.',
  'cartesian.y_cv': 'CV scrub on the Y axis.',
  'cartesian.pitch': 'V/oct pitch out.',
  'cartesian.gate': 'Gate out.',
  'destroy.audio': 'Audio in / out.',
  'destroy.decimate': 'CV -> decimation factor.',
  'destroy.bits': 'CV -> bit depth.',
  'destroy.wet': 'CV -> wet/dry mix.',
  'qbrt.L': 'Stereo input L.',
  'qbrt.R': 'Stereo input R.',
  'qbrt.ping': 'Gate -> click excitation.',
  'qbrt.cutoff': 'CV -> cutoff.',
  'qbrt.resonance': 'CV -> resonance.',
  'qbrt.mode': 'CV -> filter mode.',
  'qbrt.pingDecay': 'CV -> ping envelope decay.',
  'drummergirl.gate': 'Trigger.',
  'drummergirl.pitch': 'CV -> pitch.',
  'drummergirl.tone': 'CV -> tone.',
  'drummergirl.shape': 'CV -> shape.',
  'drummergirl.audio': 'Mono drum out.',
  'meowbox.gate': 'Trigger.',
  'meowbox.pitch': 'CV -> pitch.',
  'meowbox.morph': 'CV -> vowel morph.',
  'meowbox.decay': 'CV -> decay.',
  'meowbox.level': 'CV -> output level.',
  'meowbox.L': 'Stereo L out.',
  'meowbox.R': 'Stereo R out.',
  'timelorde.clock':
    'External clock - snaps 1x to incoming rising edges; falls back to internal BPM after ~2 master periods.',
  'timelorde.gate':
    'Level-sensitive show/hide for the beat-pulsing owl display. HIGH = owl on, LOW = off (same on/off state as the on-card owl button).',
  'timelorde.video_in':
    'Patch a video feed here and the big card display becomes a LIVE MONITOR of it (the owl steps aside); also routed to video_out so TIMELORDE passes the feed through inline. Unpatched = the owl shows.',
  'timelorde.video_out':
    'The picture the big display shows — the live VIDEO IN feed when one is patched, else the beat-pulsing owl. Lets TIMELORDE sit inline in a video chain (in -> display -> out).',
  'timelorde.1x': 'Master tempo gate.',
  'charlottesEchos.L': 'Stereo L in / out.',
  'charlottesEchos.R': 'Stereo R in / out.',
  'charlottesEchos.delay': 'CV -> delay time.',
  'score.clock': 'External 16th-rate clock; rising edges advance one slot. Disconnect -> internal BPM.',
  'score.attack': 'CV -> ADSR attack.',
  'score.decay': 'CV -> ADSR decay.',
  'score.sustain': 'CV -> ADSR sustain.',
  'score.release': 'CV -> ADSR release.',
  'score.pitch': 'V/oct pitch out (mono).',
  'score.gate': 'Gate out, held for the notated duration of each note.',
  'score.env': 'Envelope out: ADSR x dynamic (mf=0.55, ff=0.95, etc).',
  'drumseqz.clock': 'External clock (rising edges advance the step pointer).',
  'drumseqz.gate1': 'Track 1 gate out.',
  'drumseqz.gate2': 'Track 2 gate out.',
  'drumseqz.gate3': 'Track 3 gate out.',
  'drumseqz.gate4': 'Track 4 gate out.',
  'drumseqz.pitch1': 'Track 1 V/oct pitch out (track root + per-step override).',
  'drumseqz.pitch2': 'Track 2 V/oct pitch out.',
  'drumseqz.pitch3': 'Track 3 V/oct pitch out.',
  'drumseqz.pitch4': 'Track 4 V/oct pitch out.',
  // WRITESEQ — recording step-sequencer (pass-through + quantize-record). The
  // gate + clock ids appear on BOTH the input and output sides, so describe
  // both directions in one entry (the grids pattern).
  'writeseq.cv':    'Pitch CV in (V/oct, 0V = C4 = MIDI 60). Sampled on each gate rising edge while recording, AND passed through live to PITCH out whenever a live gate is held.',
  'writeseq.rec':   'Record start/stop gate — a rising edge TOGGLES the record-arm latch (same as the on-card RECORD button).',
  'writeseq.pitch': 'Sequenced V/oct pitch out. Live pass-through (the CV input) WINS while a live gate is held.',
  'writeseq.gate':  'GATE port. Input direction: each rising edge while recording writes the sampled pitch+gate to the nearest step; a rising edge while STOPPED + armed starts the sequencer + record (internal clock, or an external clock that is currently pulsing); always passes through live. Output direction: the sequenced gate out (live pass-through WINS while a live gate is held).',
  'writeseq.clock': 'CLOCK port. Input direction: external step clock (e.g. from TIMELORDE) — when patched, the step clock = these external pulses, one step per rising edge; unpatched, WRITESEQ runs its own internal BPM. Output direction: chained step clock-out, a 10 ms pulse on each advance.',
  // GRIDS — topographic drum pattern generator (MI Grids port).
  // POLYSEQZ — polyphonic chord sequencer (5-voice polyPitchGate output).
  'polyseqz.clock':       'CLOCK port. Input direction: external clock (rising edges advance the step pointer). Output direction: per-step clock pulse on every advance.',
  'polyseqz.reset_cv':    'Rising edge on this gate resets stepIndex to 0 next tick.',
  'polyseqz.play_cv':     'CV → isPlaying. Above 0.5 starts the sequencer; below 0.5 stops.',
  'polyseqz.humanize_cv': 'CV → humanize amount (0..1). Sums on top of the knob value, clamped to [0, 1].',
  'polyseqz.poly':        'polyPitchGate output: 5-voice chord (root + 3rd + 5th + (7th or octave) + (octave or 5th doubling)) per step.',
  'polyseqz.gate':        'Mono gate out: high while ANY voice is gated. Useful for ADSR/scope-trigger without unwrapping the poly cable.',
  // ILLOGIC ports — combined attenuverter / math / logic utility.
  'illogic.in1': 'Input 1 (cv/audio). Feeds att1 attenuverter AND the AND/NAND/OR/NOT logic block (gate-thresholded at 0.5).',
  'illogic.in2': 'Input 2 (cv/audio). Feeds att2 attenuverter AND the AND/NAND/OR logic block (gate-thresholded at 0.5).',
  'illogic.in3': 'Input 3 (cv/audio). Feeds att3 attenuverter only (no logic tap).',
  'illogic.in4': 'Input 4 (cv/audio). Feeds att4 attenuverter only (no logic tap).',
  'illogic.att1': 'in1 × bipolar attenuverter (-1..0..+1). Negative values invert sign.',
  'illogic.att2': 'in2 × bipolar attenuverter (-1..0..+1).',
  'illogic.att3': 'in3 × bipolar attenuverter (-1..0..+1).',
  'illogic.att4': 'in4 × bipolar attenuverter (-1..0..+1).',
  'illogic.sum':  'Post-attenuverter sum of all 4 channels: att1 + att2 + att3 + att4.',
  'illogic.diff': 'Post-attenuverter difference: (att1 + att2) - (att3 + att4).',
  'illogic.and':  'Logic AND of in1 & in2 as gates (threshold = 0.5). High when BOTH inputs >= 0.5.',
  'illogic.nand': 'Logic NAND of in1 & in2 as gates. NOT (in1 AND in2).',
  'illogic.or':   'Logic OR of in1 & in2 as gates. High when EITHER input >= 0.5.',
  'illogic.not':  'Logic NOT of in1 alone (single-input). High when in1 < 0.5.',
  // UNITYSCALEMATHEMATIK ports.
  'unityscalemathematik.u_in':       'UNITY section signal input (cv, bipolar -1..+1).',
  'unityscalemathematik.u_atten_cv': 'CV -> UNITY attenuvert knob (linear scale).',
  'unityscalemathematik.a_in':       'A section signal input (cv, bipolar).',
  'unityscalemathematik.a_atten_cv': 'CV -> A attenuvert knob (linear scale).',
  'unityscalemathematik.a_curve_cv': 'CV -> A curve morph (linear scale, 0=linear, 1=steep expo).',
  'unityscalemathematik.b_in':       'B section signal input (cv, bipolar).',
  'unityscalemathematik.b_atten_cv': 'CV -> B attenuvert knob (linear scale).',
  'unityscalemathematik.b_curve_cv': 'CV -> B curve morph (linear scale).',
  'unityscalemathematik.u_out':      'UNITY output: u_in * unityAtten (bipolar).',
  'unityscalemathematik.a_out':      'A output: sign(a_in) * |a_in|^k * aAtten with k = 1 + 2*aCurve.',
  'unityscalemathematik.b_out':      'B output: sign(b_in) * |b_in|^k * bAtten with k = 1 + 2*bCurve.',
  // ANALOGLOGICMATHS — analog-logic mixer (MIN/MAX/DIFF/SUM/PRODUCT).
  'analogLogicMaths.a':       'Signal input A (cv/audio, bipolar). Multiplied by attA before the math.',
  'analogLogicMaths.b':       'Signal input B (cv/audio, bipolar). Multiplied by attB before the math.',
  'analogLogicMaths.attA_cv': 'CV → Att A attenuverter knob (linear scale, bipolar -1..+1).',
  'analogLogicMaths.attB_cv': 'CV → Att B attenuverter knob (linear scale, bipolar -1..+1).',
  'analogLogicMaths.min':     'Sample-wise MIN(A\', B\') where A\'/B\' are the attenuverted inputs.',
  'analogLogicMaths.max':     'Sample-wise MAX(A\', B\').',
  'analogLogicMaths.diff':    'Sample-wise DIFF: A\' - B\'. Anti-symmetric (DIFF(a,b) = -DIFF(b,a)).',
  'analogLogicMaths.sum':     'Sample-wise SUM with tanh soft-clip: tanh(A\' + B\'). Stays in (-1, +1) for any inputs.',
  'analogLogicMaths.product': 'Sample-wise PRODUCT with tanh soft-clip: tanh(A\' * B\'). Audio × audio = ring mod; CV × CV = smooth blending.',
  'dx7.poly':
    'Polyphonic pitch+gate input (10 channels = 5 lanes of pitch+gate). Drive from a SEQUENCER / CARTESIAN poly output for chord playback; each lane allocates one DX7 voice. Round-robin allocation with steal-oldest when all 5 voices busy.',
  'dx7.pitch_cv': 'Mono V/oct pitch input (legacy / single-voice fallback — drives lane 0 if no poly cable is patched).',
  'dx7.gate':     'Mono gate input (legacy / single-voice fallback — drives lane 0).',
  'dx7.out':      'Mono audio output (sum of all active voice carriers).',
  'wavecel.trigger': 'Mono TRIGGER gate for the per-voice amplitude ADSR (drives lane-0\'s envelope when POLY is unpatched). A level gate, not a pulse: rising edge = note-on (attack), falling edge = note-off (release). PATCHING this (or POLY) makes WAVECEL a GATED voice — silent until the first note, then base-floored (BASE VOL) once active; releasing tails finish. When neither this nor POLY is patched WAVECEL free-runs as a continuous raw VCO at the BASE VOL level (default 1 = the legacy drone, byte-identical).',
  'wavecel.base_vol': 'Per-voice VCA FLOOR the ADSR rides on top of: gain = base + (1-base)·env per ACTIVE (gated-or-releasing) voice. 1 (default) = full, the envelope does nothing; 0 = pure ADSR (silent between notes); 0.5 floors at 0.5 and rises to 1.0 at the env peak. A never-gated voice stays silent regardless of base. With nothing patched (raw VCO) the env is idle, so this IS the output level — default 1 = the legacy byte-identical drone.',
  // NOISE — basic noise source.
  'noise.white': 'White noise output (audio-rate). Flat spectrum, Math.random()-driven; std-dev ≈ 0.577 × LEVEL.',
  'noise.pink':  'Pink noise output (audio-rate). 1/f spectrum (-3 dB/oct) via Voss-McCartney. Sounds "warmer" than white.',
  'noise.brown': 'Brown noise output (audio-rate). 1/f² spectrum (-6 dB/oct) via leaky-integrated white. Sounds like distant ocean / rumble.',
  // BUGGLES — chaotic random voltage source.
  'buggles.clock_cv':       'CV → woggle rate. Sums onto the RATE knob value (clamped to 0..1, then log-mapped to 0.1..50 Hz).',
  'buggles.chaos_cv':       'CV → chaos amount. Sums onto the CHAOS knob (clamped to 0..1).',
  'buggles.external_clock': 'Gate input. When patched and pulsing, replaces the internal woggle scheduler — every rising edge advances state.',
  'buggles.smooth':         'Slowly-shifting random voltage (-1..+1). The STEPPED value, slewed via linearRampToValueAtTime; SMOOTH knob controls slew duration.',
  'buggles.stepped':        'Sample-and-held random voltage (-1..+1). Updates instantly on each woggle event. CHAOS knob controls correlation between successive steps (0=walk, 1=independent).',
  'buggles.clock':          '5ms gate pulse fired on each woggle event. Use as a chaotic clock for sequencers / drum triggers.',
  'buggles.burst':          'Cluster of 3-7 closely-spaced 4ms gate pulses, fired at probability BURST per woggle event. Probabilistic chaos — sometimes silent, sometimes a buzz of triggers.',
  'buggles.ring':           'Audio-rate ring-modulation output: SMOOTH voltage × sine sub-oscillator (rate/4 Hz). The wogglebug\'s signature complex-random texture.',
  // STEREOVCA — stereo VCA + ring modulator.
  'stereovca.in_l':       'Left audio input. Multiplied by (strength_l + offset) * level.',
  'stereovca.in_r':       'Right audio input. Multiplied by (strength_r + offset) * level. Normalled to in_l when unpatched (mono → stereo).',
  'stereovca.strength_l': 'Left strength / ring carrier. Cable type `cv` so LFOs / ADSRs / sequencer-step CV land natively. Slow CV gives tremolo; an audio-rate signal patched here gives ring modulation (PASSTHROUGH_BY_DESIGN — the worklet treats strength as a raw bipolar carrier, no cv scaling).',
  'stereovca.strength_r': 'Right strength / ring carrier. Normalled to strength_l when unpatched (one strength drives both VCAs).',
  'stereovca.out_l':      'Left output: in_l * (strength_l + offset) * level.',
  'stereovca.out_r':      'Right output: in_r * (strength_r + offset) * level.',
  // VEILS — quad VCA + soft-clip summing mix.
  // MACROOSCILLATOR — Plaits-style macro oscillator.
  'macrooscillator.pitch':    'V/oct pitch input (1 unit = 1 octave). Sums with the NOTE param.',
  'macrooscillator.trig':     'Gate input — rising edge resets the oscillator phase accumulators for clean percussive attack alignment.',
  'macrooscillator.model_cv': 'CV → model param (discrete switch: 0=VA, 1=WAVESHAPE).',
  'macrooscillator.note_cv':  'CV → note param (±60-semitone offset on top of pitch V/oct).',
  'macrooscillator.harm_cv':  'CV → HARMONICS macro (0..1). In VA: detune amount of the partner voice; in WAVESHAPE: sub-octave sine mix.',
  'macrooscillator.timb_cv':  'CV → TIMBRE macro (0..1). In VA: wavefolder amount on the summed wave; in WAVESHAPE: waveshaper drive.',
  'macrooscillator.morph_cv': 'CV → MORPH macro (0..1). In VA: saw→square→triangle wave morph; in WAVESHAPE: wavefolder↔tanh waveshaper crossfade.',
  'macrooscillator.level_cv': 'CV → LEVEL (0..1) — final scalar on the OUT port (AUX is unaffected).',
  'macrooscillator.out':      'Main audio output, post-LEVEL.',
  'macrooscillator.aux':      'Auxiliary output — per-model raw tap: unfolded sub-octave triangle (VA) or pre-distortion body sine (WAVESHAPE). Not LEVEL-scaled.',

  // RINGS
  'rings.in':        'Audio exciter — drives the resonator(s).',
  'rings.pitch':     'V/oct pitch input.',
  'rings.strum':     'Gate — rising edge re-ignites burst (KS) or impulse (modal).',
  'rings.model_cv':  'CV → model (discrete: 0=MODAL, 1=SYMPATHETIC).',
  'rings.note_cv':   'CV → note (±60-semitone offset).',
  'rings.str_cv':    'CV → STRUCTURE (0..1).',
  'rings.bright_cv': 'CV → BRIGHTNESS (0..1).',
  'rings.damp_cv':   'CV → DAMPING (0..1). Low = long ring; high = fast decay.',
  'rings.pos_cv':    'CV → POSITION (0..1).',
  'rings.level_cv':  'CV → LEVEL (0..1) — soft-limited output gain.',
  'rings.odd':       'Primary output — odd-indexed mode sum (MODAL) or odd-tap string mix (SYMPATHETIC).',
  'rings.even':      'Secondary output — even-indexed mode sum / even-tap mix.',
  // ELEMENTS

  // MARBLES
  'marbles.rate_cv':    'CV → RATE (internal clock, semitone-scaled).',
  'marbles.tmodel_cv':  'CV → T MODEL (discrete: 0=COIN, 1=CLUSTERS, 2=DRUMS, 3=INDEP, 4=3-STATE, 5=MARKOV).',
  'marbles.tbias_cv':   'CV → T BIAS (0..1) — gate-model coin bias.',
  'marbles.tjitter_cv': 'CV → T JITTER (0..1) — clock timing jitter.',
  'marbles.dejavu_cv':  'CV → DÉJÀ VU (0..1) — T-section random-loop lock amount.',
  'marbles.length_cv':  'CV → LENGTH (1..16) — déjà-vu loop length.',
  'marbles.spread_cv':  'CV → SPREAD (0..1) — X random-voltage variance.',
  'marbles.xbias_cv':   'CV → X BIAS (0..1) — X random-voltage mean.',
  'marbles.steps_cv':   'CV → STEPS (0..1) — X quantization amount / portamento.',
  'marbles.xdejavu_cv': 'CV → X DÉJÀ VU (0..1) — X-section random-loop lock.',
  'marbles.scale_cv':   'CV → SCALE (discrete 0..5).',
  'marbles.t1':         'T1 gate — first Bernoulli/coin/drum gate stream.',
  'marbles.t2':         'T2 gate — complementary/second gate stream.',
  'marbles.x1':         'X1 CV — quantized random voltage (±1 = ±5V).',
  'marbles.x2':         'X2 CV — déjà-vu-shifted random voltage.',
  'marbles.x3':         'X3 CV — déjà-vu-shifted random voltage.',
  'marbles.clk':        'Master clock gate (master ramp < 0.5).',

  // MIDI-CV-BUDDY — hardware MIDI controller → pitch + gate + velocity CV.
  'midiCvBuddy.pitch_cv':    'V/oct pitch output (0V = C4 = MIDI 60). Pitch-bend is summed in at the MIDI-standard ±2 semitones each side.',
  'midiCvBuddy.gate':        'Gate output. HIGH while any key is held; with RETRIG on, dips to 0 for one audio block on each new note-on so a downstream ADSR re-fires.',
  'midiCvBuddy.velocity_cv': 'Velocity CV (0..1, raw MIDI velocity / 127). Updated on each note-on; latched between events.',
  // MIDI LANE — per-channel instrument-bus demux.
  'midiLane.pitch_cv':    'V/oct pitch output (0V = C4 = MIDI 60), the winning held note under the lane\'s voice priority. Pitch-bend summed in at ±2 semitones. In POLY mode the per-voice pitches go out the `poly` port instead.',
  'midiLane.gate':        'Gate output. HIGH while any key on the lane\'s channel(s) is held; with RETRIG on, dips to 0 for one audio block on each new note-on so a downstream ADSR re-fires. MONO mode only (POLY drives per-voice gates on the `poly` port).',
  'midiLane.velocity_cv': 'Velocity CV (0..1, raw MIDI velocity / 127). Updated on each note-on; latched between events.',
  'midiLane.cc_a':        'Learn-assignable CC tap A → 0..1 CV. Hit LEARN on the card + wiggle a CC to bind (defaults to CC1 = mod wheel). Drives audio params directly or video params via the cross-domain bridge.',
  'midiLane.cc_b':        'Learn-assignable CC tap B → 0..1 CV. Unassigned by default; hit LEARN + wiggle a CC to bind. Same continuous-modulation role as cc_a.',
  'midiLane.note_gate':   'By-note-number drum gate — fires a one-shot pulse when the card-selected MIDI note (default GM kick = 36) arrives on the lane\'s channel(s). Cable into a drum voice trigger, or into a video module\'s gate input to fire visuals with no synth voice.',
  'midiLane.poly':        'Polyphonic chord output (10-channel polyPitchGate = 5 pitch/gate pairs). Carries signal only in POLY mode (newest-held voices win under voice pressure, steal-oldest). Patch into a poly synth (cartesian / dx7). Neutral in MONO mode.',
  // MIDI-OUT-BUDDY — gate/pitch/velocity CV → MIDI notes out to external gear.
  'midiOutBuddy.gate':     'Gate input. Rising edge → MIDI NoteOn (note = quantized pitch input, velocity = velocity input) on the selected device + channel. Falling edge → NoteOff of the note that was turned on.',
  'midiOutBuddy.pitch':    'V/oct pitch input (0V = C4 = MIDI 60), quantized to the nearest semitone for the outgoing MIDI note number. Sampled at the gate rising edge; the held NoteOff targets that note even if pitch drifts under a held gate.',
  'midiOutBuddy.velocity': 'Velocity CV input (0..1) mapped to MIDI velocity 1..127 (floored to 1 so a NoteOn never collapses into a velocity-0 NoteOff). Sampled at the gate rising edge.',
  // MIDICLOCK — hardware MIDI transport bridge.
  'midiclock.clock':     'Gate. Rising edge every N incoming MIDI clock ticks; N selectable as 24 (quarter, default) / 12 (eighth) / 6 (sixteenth) / 3 (32nd) / 1 (raw 24 PPQN). Patch into TIMELORDE.clock to slave it to the external transport.',
  'midiclock.run':       'CV. 0 while transport is stopped, 1 while running. Latched. MIDI Continue (0xFB) raises this to 1 without re-firing midistart.',
  'midiclock.midistart': 'One-shot gate. Fires on MIDI Start (0xFA). Continue (0xFB) does NOT fire this — it raises run only.',
  'midiclock.midistop':  'One-shot gate. Fires on MIDI Stop (0xFC).',
};

const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];

function stripComments(src: string): string {
  let out = '';
  let inStr: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < src.length) {
        out += src[++i];
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (i < src.length) out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function sliceBalancedBraces(src: string, startIdx: number): string | null {
  if (src[startIdx] !== '{') return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, i);
    }
  }
  return null;
}

function extractArray(src: string, key: string): string {
  const re = new RegExp(`\\b${key}:\\s*\\[`);
  const m = re.exec(src);
  if (!m) return '';
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const start = i + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return '';
}

function splitTopLevelObjects(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let inStr: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < body.length) {
        cur += body[++i];
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      cur += c;
      if (depth === 0) {
        if (cur.trim()) out.push(cur);
        cur = '';
        continue;
      }
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parsePortList(body: string): ManifestPort[] {
  if (!body.trim()) return [];
  const out: ManifestPort[] = [];
  // Inline expansion of well-known shared port-array spreads. Keeps the
  // regex parser simple but lets sequencer-style modules declare the 6
  // shared transport CV inputs via `...TRANSPORT_CV_PORT_DEFS`.
  if (/\.\.\.TRANSPORT_CV_PORT_DEFS\b/.test(body)) {
    out.push(
      { id: 'play_cv',   type: 'gate' },
      { id: 'reset_cv',  type: 'gate' },
      { id: 'queue1_cv', type: 'gate' },
      { id: 'queue2_cv', type: 'gate' },
      { id: 'queue3_cv', type: 'gate' },
      { id: 'queue4_cv', type: 'gate' },
    );
  }
  // feat/seq 8-slots — Sequencer + MACSEQ spread EXTENDED_TRANSPORT_CV_PORT_DEFS
  // after the base set: queue5..8_cv + next/prev/random_cv nav gates.
  if (/\.\.\.EXTENDED_TRANSPORT_CV_PORT_DEFS\b/.test(body)) {
    out.push(
      { id: 'queue5_cv', type: 'gate' },
      { id: 'queue6_cv', type: 'gate' },
      { id: 'queue7_cv', type: 'gate' },
      { id: 'queue8_cv', type: 'gate' },
      { id: 'next_cv',   type: 'gate' },
      { id: 'prev_cv',   type: 'gate' },
      { id: 'random_cv', type: 'gate' },
    );
  }
  const parts = splitTopLevelObjects(body);
  for (const part of parts) {
    const id = (part.match(/\bid:\s*['"]([^'"]+)['"]/) || [])[1];
    const type = (part.match(/\btype:\s*['"]([^'"]+)['"]/) || [])[1];
    const paramTarget = (part.match(/paramTarget:\s*['"]([^'"]+)['"]/) || [])[1];
    // Enriched PortDef fields (docs-overhaul). Regex-tolerant of the literal
    // shapes the def files use, e.g. `cvScale: { mode: 'log' }`,
    // `edge: 'trigger'`, `adoptsUpstreamFrom: 'in'`, `accepts: ['cv','pitch']`.
    const cvMode = (part.match(/cvScale:\s*\{[^}]*\bmode:\s*['"]([^'"]+)['"]/) || [])[1];
    const edge = (part.match(/\bedge:\s*['"](trigger|gate)['"]/) || [])[1] as
      | 'trigger'
      | 'gate'
      | undefined;
    const adopts = (part.match(/adoptsUpstreamFrom:\s*['"]([^'"]+)['"]/) || [])[1];
    const acceptsBlock = (part.match(/\baccepts:\s*\[([^\]]*)\]/) || [])[1];
    if (id && type) {
      const port: ManifestPort = { id, type };
      if (paramTarget) port.paramTarget = paramTarget;
      if (cvMode) {
        port.cvScale = { mode: cvMode as 'linear' | 'log' | 'discrete' | 'passthrough' };
      }
      if (edge) port.edge = edge;
      if (adopts) port.adoptsUpstreamFrom = adopts;
      if (acceptsBlock) {
        const accepts = [...acceptsBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
        if (accepts.length > 0) port.accepts = accepts;
      }
      out.push(port);
    }
  }
  return out;
}

function parseParamList(body: string): ManifestParam[] {
  if (!body.trim()) return [];
  const out: ManifestParam[] = [];
  const parts = splitTopLevelObjects(body);
  for (const part of parts) {
    const id = (part.match(/\bid:\s*['"]([^'"]+)['"]/) || [])[1];
    const label = (part.match(/\blabel:\s*['"`]([^'"`]+)['"`]/) || [])[1];
    const dv = (part.match(/defaultValue:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    const min = (part.match(/\bmin:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    const max = (part.match(/\bmax:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    const curve = (part.match(/\bcurve:\s*['"]([^'"]+)['"]/) || [])[1];
    const units = (part.match(/\bunits:\s*['"]([^'"]+)['"]/) || [])[1];
    if (id) {
      out.push({
        id,
        label: label || id,
        defaultValue: dv === undefined ? null : Number(dv),
        min: min === undefined ? null : Number(min),
        max: max === undefined ? null : Number(max),
        curve: curve || 'linear',
        ...(units ? { units } : {}),
      });
    }
  }
  return out;
}

function synthesizeFromBuildHelper(
  type: string,
): { inputs: ManifestPort[]; params: ManifestParam[] } | null {
  if (type === 'mixmstrs') {
    const params: ManifestParam[] = [];
    for (const ch of [1, 2, 3, 4, 5, 6]) {
      params.push({ id: `ch${ch}_volume`, label: `${ch}V`, defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
      params.push({ id: `ch${ch}_low`, label: `${ch}Lo`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_mid`, label: `${ch}Md`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_high`, label: `${ch}Hi`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_thresh`, label: `${ch}Th`, defaultValue: -12, min: -36, max: 0, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_ratio`, label: `${ch}Rt`, defaultValue: 2, min: 1, max: 10, curve: 'linear' });
      params.push({ id: `ch${ch}_compEnable`, label: `${ch}Cp`, defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
      // Per-channel comp macro knob (single-dial wrapper around
      // thresh/ratio/compEnable, added in feat/audio-fidelity-...).
      params.push({ id: `comp${ch}`, label: `${ch}Cm`, defaultValue: 0, min: 0, max: 1, curve: 'linear' });
      params.push({ id: `ch${ch}_send1`, label: `${ch}S1`, defaultValue: 0, min: 0, max: 1, curve: 'linear' });
      params.push({ id: `ch${ch}_send2`, label: `${ch}S2`, defaultValue: 0, min: 0, max: 1, curve: 'linear' });
    }
    params.push({ id: 'master_volume', label: 'Master', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
    const inputs: ManifestPort[] = [
      { id: 'ch1L', type: 'audio' }, { id: 'ch1R', type: 'audio' },
      { id: 'ch2L', type: 'audio' }, { id: 'ch2R', type: 'audio' },
      { id: 'ch3L', type: 'audio' }, { id: 'ch3R', type: 'audio' },
      { id: 'ch4L', type: 'audio' }, { id: 'ch4R', type: 'audio' },
      { id: 'ch5L', type: 'audio' }, { id: 'ch5R', type: 'audio' },
      { id: 'ch6L', type: 'audio' }, { id: 'ch6R', type: 'audio' },
      { id: 'ret1L', type: 'audio' }, { id: 'ret1R', type: 'audio' },
      { id: 'ret2L', type: 'audio' }, { id: 'ret2R', type: 'audio' },
    ];
    for (const p of params) inputs.push({ id: p.id, type: 'cv', paramTarget: p.id });
    return { inputs, params };
  }
  if (type === 'bluebox') {
    // BLUEBOX expands its 12 button gate-inputs + 12 button params via
    // `BLUEBOX_BUTTON_NAMES.map(...)` — the literal-array extractor
    // doesn't see them. Reproduce the static shape here.
    const NAMES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'bluebox', 'redbox'];
    const inputs: ManifestPort[] = NAMES.map((n) => ({ id: `gate_${n}`, type: 'gate' }));
    const params: ManifestParam[] = NAMES.map((n) => ({
      id: `btn_${n}`,
      label: n === 'bluebox' || n === 'redbox' ? n.toUpperCase() : n,
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear',
    }));
    return { inputs, params };
  }
  return null;
}

function describePort(moduleType: string, portId: string, port: ManifestPort): string {
  const key = `${moduleType}.${portId}`;
  if (PORT_NOTES[key]) return PORT_NOTES[key];
  switch (port.type) {
    case 'audio':
      return 'Audio signal.';
    case 'pitch':
      return 'V/oct pitch CV.';
    case 'gate':
      return 'Gate signal (rising/falling edge).';
    case 'cv':
      return port.paramTarget ? `CV -> ${port.paramTarget} param.` : 'Control voltage.';
    default:
      return port.type;
  }
}

function describeModule(type: string): string {
  return (
    DESCRIPTIONS[type] ||
    // Fall back to the AUTHORED co-located docs overview (drift-gated) when a
    // module carries no hand-written DESCRIPTIONS one-liner. This is what lets
    // most video modules render a real intro without duplicating their prose
    // into DESCRIPTIONS. AUDIO is byte-unchanged: every audio module already has
    // a DESCRIPTIONS entry, so the `||` short-circuits before this branch.
    MODULE_DOCS[type]?.explanation ||
    `Audio module (${type}). Add a one-line description in packages/web/src/lib/docs/module-manifest.ts:DESCRIPTIONS.`
  );
}

interface RawModule {
  file: string;
  sourceUrl: string;
  type?: string;
  label?: string;
  category?: string;
  maxInstances?: number;
  inputs: ManifestPort[];
  outputs: ManifestPort[];
  params: ManifestParam[];
  stereoPairs?: [string, string][];
}

/** Parse a `stereoPairs: [['a','b'], ['c','d']]` literal off the def source.
 *  Reuses extractArray() to balance-match the OUTER `[...]` (a plain regex
 *  can't — the array is nested, so a non-greedy match stops at the first inner
 *  `]`), then extracts every `['x','y']` tuple from the balanced body. */
function parseStereoPairs(src: string): [string, string][] | undefined {
  const body = extractArray(src, 'stereoPairs');
  if (!body.trim()) return undefined;
  const pairs: [string, string][] = [];
  for (const tupleMatch of body.matchAll(/\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g)) {
    pairs.push([tupleMatch[1], tupleMatch[2]]);
  }
  return pairs.length > 0 ? pairs : undefined;
}

/** Resolve the stereo-pair sibling (and which side) for a port id, if any. */
function stereoInfo(
  portId: string,
  pairs: [string, string][] | undefined,
): { stereoPair?: string; stereoSide?: 'L' | 'R' } {
  if (!pairs) return {};
  for (const [l, r] of pairs) {
    if (portId === l) return { stereoPair: r, stereoSide: 'L' };
    if (portId === r) return { stereoPair: l, stereoSide: 'R' };
  }
  return {};
}

function readModule(file: string, rawSrc: string): RawModule | null {
  const fullSrc = stripComments(rawSrc);

  // Match either `export const xxxDef: AudioModuleDef = {` OR a non-exported
  // `const xxxDef: AudioModuleDef = {` — the latter case picks up internal
  // base defs (e.g. lfo's `baseDef` that gets spread into a wrapper
  // SyncedModuleDef). VideoModuleDef is matched too so the video registry's
  // defs parse through the SAME extractor (the parse logic is domain-agnostic).
  // Catalog dedupes by `type`, so two matches in one file collapse to one entry.
  const declRe = /(?:export\s+)?const\s+(\w+Def)\s*:\s*(?:AudioModuleDef|SyncedModuleDef|VideoModuleDef)\s*=\s*\{/;
  const declMatch = declRe.exec(fullSrc);
  if (!declMatch) return null;
  const startBrace = declMatch.index + declMatch[0].length - 1;
  const src = sliceBalancedBraces(fullSrc, startBrace);
  if (!src) return null;

  const grabStr = (key: string): string | undefined => {
    const re = new RegExp(`\\b${key}:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`);
    const m = src.match(re);
    return m ? m[2] : undefined;
  };
  const grabNum = (key: string): number | undefined => {
    const re = new RegExp(`\\b${key}:\\s*(\\d+)`);
    const m = src.match(re);
    return m ? Number(m[1]) : undefined;
  };

  const out: RawModule = {
    file,
    sourceUrl: `${SRC_BASE}/${file}`,
    type: grabStr('type'),
    label: grabStr('label'),
    category: grabStr('category'),
    maxInstances: grabNum('maxInstances'),
    inputs: parsePortList(extractArray(src, 'inputs')),
    outputs: parsePortList(extractArray(src, 'outputs')),
    params: parseParamList(extractArray(src, 'params')),
    stereoPairs: parseStereoPairs(src),
  };

  // Inputs are computed (e.g. `inputs: INPUTS` or `inputs: buildInputs()`)
  // when the literal-array extractor returns nothing — fall back to the
  // hard-coded synthesizer keyed by module type.
  if (out.inputs.length === 0 && out.type) {
    const synth = synthesizeFromBuildHelper(out.type);
    if (synth) {
      out.inputs = synth.inputs;
      out.params = synth.params;
    }
  }

  // clipplayer's outputs are computed (8 lanes × pitch/gate/vel) — the literal
  // extractor sees none, so synthesize the 24 per-lane ports here.
  if (out.outputs.length === 0 && out.type === 'clipplayer') {
    const outs: ManifestPort[] = [];
    for (let i = 1; i <= 8; i++) {
      outs.push({ id: `pitch${i}`, type: 'polyPitchGate' });
      outs.push({ id: `gate${i}`, type: 'gate' });
      outs.push({ id: `vel${i}`, type: 'cv' });
    }
    out.outputs = outs;
  }

  return out;
}

/**
 * Build the manifest by parsing every module-def file under
 * packages/web/src/lib/audio/modules/. Sources come from a Vite glob, which
 * inlines them at build time so the function works identically during
 * `vite build` (prerender), `vite dev` (live reload), and `vitest run`.
 *
 * The optional `sources` parameter overrides the inlined glob — used by
 * unit tests that want to feed synthetic registry input.
 */
export function buildModuleManifest(
  sources: Record<string, string> = MODULE_SOURCES,
  videoSources: Record<string, string> = VIDEO_SOURCES,
): Manifest {
  const audioEntries = Object.entries(sources)
    .map(([path, src]) => {
      const file = path.split('/').pop() ?? path;
      return { file, src, domain: 'audio' as const };
    })
    .filter(({ file }) => {
      if (!file.endsWith('.ts') || file === 'index.ts') return false;
      // iCloud / Dropbox-style sync-conflict siblings ("foo 2.ts", "bar 3.ts")
      // are local-machine artifacts, not real module sources. They have a
      // bare-int marker before the extension; the canonical sources never
      // contain a space. Skipping by `' ' in basename` is safe + simple.
      if (file.includes(' ')) return false;
      // Skip companion / test files — they live next to module sources but
      // aren't module definitions themselves.
      if (file.endsWith('.test.ts')) return false;
      if (file.endsWith('-state.ts')) return false;
      if (file.endsWith('-data.ts')) return false;
      // -draw.ts: shared 2D-canvas draw helpers (e.g. scope-draw.ts that
      // both ScopeCard.svelte and the cross-domain video bridge use).
      // Not a ModuleDef.
      if (file.endsWith('-draw.ts')) return false;
      // -scope.ts: on-card single-cycle waveform-scope helpers (cycle-window
      // extraction + 2D draw, e.g. analog-vco-scope.ts used by AnalogVcoCard).
      // Not a ModuleDef.
      if (file.endsWith('-scope.ts')) return false;
      // -map.ts: pure raster/coordinate-mapping math helpers (e.g.
      // rasterize-map.ts that both the module factory + its tests use).
      // Not a ModuleDef.
      if (file.endsWith('-map.ts')) return false;
      // -shapes.ts: FOXY's 3dShapeGen pure shape-generation / SDF / voxel
      // math helpers (foxy-shapes.ts). Not a ModuleDef.
      if (file.endsWith('-shapes.ts')) return false;
      // -engine.ts: pure-math worklet-engine mirror (e.g. stages-engine.ts).
      // Not a ModuleDef — exported only for the parallel module file's
      // import + the tests / ART scenarios.
      if (file.endsWith('-engine.ts')) return false;
      // -resources.ts: generated lookup-table data (LUTs / node tables).
      // Not a ModuleDef.
      if (file.endsWith('-resources.ts')) return false;
      // -rate.ts: pure helpers for asymmetric / custom rate-param visual
      // mappings (e.g. samsloop-rate.ts: knob ↔ rate piecewise math).
      // Not a ModuleDef.
      if (file.endsWith('-rate.ts')) return false;
      // -record.ts: pure helpers for the SAMSLOOP recording feature
      // (samsloop-record.ts: quantize / downsample / WAV header /
      // maxSeconds-budget math). Not a ModuleDef.
      if (file.endsWith('-record.ts')) return false;
      // -factory.ts: shared Web-Audio factory-builder helpers (e.g.
      // moog-filterbank-factory.ts: buildFilterBank() shared by 907A + 914).
      // Not a ModuleDef.
      if (file.endsWith('-factory.ts')) return false;
      // Shared transport helpers (PR feat/sequencer-transport-quicksave) —
      // SAVE/LOAD/QUEUE plumbing used by Sequencer / DRUMSEQZ / SCORE.
      // Not a ModuleDef.
      if (file === 'transport-helpers.ts') return false;
      if (file === 'transport-cv.ts') return false;
      if (file === 'transport-card.ts') return false;
      // Shared lookahead-vs-sounding-now playhead helper used by Sequencer /
      // POLYSEQZ / DRUMSEQZ / SCORE / Cartesian. Not a ModuleDef.
      if (file === 'playhead-tracker.ts') return false;
      // Shared per-user-view-state page-nav helpers (DRUMSEQZ / POLYSEQZ /
      // MACSEQ / Sequencer). Not a ModuleDef.
      if (file === 'sequencer-pages.ts') return false;
      // TIMELORDE auto-spawn predicate + position helper consumed by
      // Canvas.svelte's snapshot effect. Not a ModuleDef.
      if (file === 'timelorde-autospawn.ts') return false;
      // TIMELORDE neon-wizard pure helpers (pixel-art bitmap → dots, beat-pulse
      // math, gate→on/off) consumed by TimelordeCard.svelte + timelorde.ts.
      // Not a ModuleDef.
      if (file === 'timelorde-wizard.ts') return false;
      // TWOTRACKS pure state machine — not a ModuleDef.
      if (file === 'twotracks-transport.ts') return false;
      // CLIPPLAYER clip-page data model + note-editor row math — not a ModuleDef
      // (the def lives in clipplayer.ts).
      if (file === 'clip-types.ts') return false;
      // CLIPPLAYER per-lane playhead registry (render state) — not a ModuleDef.
      if (file === 'clip-playhead.ts') return false;
      // CLIPPLAYER song-mode arranger data model + record/replay math — not a
      // ModuleDef (the def lives in clipplayer.ts).
      if (file === 'clip-arrange.ts') return false;
      // CLIPPLAYER dual-Launchpad KEYS live-audition side-channel (in-memory
      // note queue) — not a ModuleDef (the def lives in clipplayer.ts).
      if (file === 'clip-audition.ts') return false;
      // CLIPPLAYER per-lane clock RATE (mult/div) pure helpers — not a
      // ModuleDef (the def lives in clipplayer.ts).
      if (file === 'clip-clock.ts') return false;
      // KRIA step/pattern data model + step-advance / scale / cue math — not a
      // ModuleDef (the def lives in kria.ts).
      if (file === 'kria-types.ts') return false;
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  // VIDEO entries (additive). The video source tree carries a large "helper zoo"
  // (…-query / …-dsp / …-sim / …-math / …-events / …-transitions / …) with
  // irregular names, so instead of an exhaustive per-suffix denylist (as the
  // audio filter above uses) we INCLUDE a video file only when it actually
  // declares a `VideoModuleDef` — every non-def helper is skipped by content,
  // and the filter is robust to new helpers landing later.
  const videoEntries = Object.entries(videoSources)
    .map(([path, src]) => {
      const file = path.split('/').pop() ?? path;
      return { file, src, domain: 'video' as const };
    })
    .filter(({ file, src }) => {
      if (!file.endsWith('.ts') || file === 'index.ts') return false;
      if (file.includes(' ')) return false; // sync-conflict siblings ("foo 2.ts")
      if (file.endsWith('.test.ts')) return false;
      return /:\s*VideoModuleDef\s*=/.test(src);
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  // Audio first, then video: both are re-sorted by category/label below, so this
  // only affects tie-break order among equal (category,label) pairs — keeping
  // the audio output byte-stable.
  const entries = [...audioEntries, ...videoEntries];

  const modules: ManifestModule[] = [];
  const warnings: string[] = [];

  for (const { file, src, domain } of entries) {
    const m = readModule(file, src);
    if (!m) {
      warnings.push(`skipping ${file}: no module def found`);
      continue;
    }
    if (!m.type || !m.label || !m.category) {
      warnings.push(`skipping ${file}: missing required field (type/label/category)`);
      continue;
    }
    const type = m.type;
    const pairs = m.stereoPairs;
    // Auto-generated I/O explanations — the SINGLE source of truth the doc
    // page's Inputs & Outputs section renders (docs-overhaul §3c). io-explain
    // is pure + unit-tested; feeding it the enriched PortDef means the I/O
    // section cannot drift from the def.
    const io = {
      inputs: m.inputs.map((p) => ({
        id: p.id,
        type: p.type,
        explain: explainInputPort(p as ExplainPort, stereoInfo(p.id, pairs)),
      })),
      outputs: m.outputs.map((p) => ({
        id: p.id,
        type: p.type,
        explain: explainOutputPort(p as ExplainPort, {
          stereoPair: stereoInfo(p.id, pairs).stereoPair,
        }),
      })),
    };
    modules.push({
      file: m.file,
      // readModule stamps the AUDIO SRC_BASE; rebase to the video tree for video
      // entries so the "view source" link points at the right file.
      sourceUrl: domain === 'video' ? `${VIDEO_SRC_BASE}/${m.file}` : m.sourceUrl,
      domain,
      type,
      label: m.label,
      category: m.category,
      maxInstances: m.maxInstances,
      description: describeModule(type),
      inputs: m.inputs.map((p) => ({ ...p, note: describePort(type, p.id, p) })),
      outputs: m.outputs.map((p) => ({ ...p, note: describePort(type, p.id, p) })),
      params: m.params,
      ...(pairs ? { stereoPairs: pairs } : {}),
      io,
      ...(MODULE_DOCS[type] ? { docs: MODULE_DOCS[type] } : {}),
    });
  }

  modules.sort((a, b) => {
    const ai = CAT_ORDER.indexOf(a.category);
    const bi = CAT_ORDER.indexOf(b.category);
    const aj = ai < 0 ? 999 : ai;
    const bj = bi < 0 ? 999 : bi;
    if (aj !== bj) return aj - bj;
    return a.label.localeCompare(b.label);
  });

  return {
    generatedAt: new Date().toISOString(),
    moduleCount: modules.length,
    categories: [...new Set(modules.map((m) => m.category))],
    modules,
    warnings,
  };
}
