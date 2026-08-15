# patchtogether — Functional Specification (stack-agnostic)

> **STATUS 2026-08-04: CURRENT — this is the reference behavioral spec of the shipped
> product, and it is KEPT.** It is genuinely stack-agnostic (zero mentions of Svelte,
> Yjs, Clerk, Cloudflare, Faust, WebGL — verified by grep across all 618 lines), which
> is what makes it reusable. Landed in the planning-corpus bulk commit `dd847ee5`
> (#1175, 2026-07-26); the **content** cutoff is earlier — around 2026-07-10…22.
>
> Three corrections a reader must carry, none of which supersede the document:
>
> 1. ⚠ **"roughly 170 audio-domain entries" was NEVER TRUE and is the one hard error
>    here.** The live registry exports **119 audio defs + 67 video defs = 186** (the
>    footer count). 170 is the raw *file* count in `audio/modules/`, ~50 of which are
>    helper/engine-mirror files the glob registry deliberately skips. The historical
>    peak was 126 defs (2026-07-01). The spec's own arithmetic contradicts it —
>    170 + 61 > 180. **This error propagates into `stack-study-executive-report.md`'s
>    rewrite-cost math ("~1.5–3 senior-years porting 170 audio modules"), inflating it
>    by ~40 %.** It does not change that report's verdict.
> 2. **Missing, all post-cutoff:** the **Ableton Push 2** integration (shipped #1165,
>    2026-07-23, through LEGEND MODE #1309 — §7's hardware roster omits it entirely,
>    which is the sharpest dating evidence); CLIP PLAYER **song / arrangement mode**
>    (`clip-song.ts`, `clip-arrange.ts`, `ClipArrangeEditor.svelte`); and the module
>    **face PLATFORM** (#1301 — §10's faceplate paragraph describes the *docs* view,
>    a different thing). ~18 modules were also deleted in #1013/#1033.
>    **Added 2026-08-12:** the spec's two-shell model is gone — **DAWLESS mode was
>    deleted in #1459** and the faceplate shell is now the default, with
>    `?shell=legacy` as the escape hatch; ~32 modules now carry a real `face:` and
>    `vrt-strict` gates them (#1483). HYPERCUBE was removed outright (#1448).
> 3. **One claim went from aspirational to true after authorship:** §11's "unpatched
>    outputs render at zero cost" was shipped by sink-driven pull evaluation (#1045,
>    2026-07-11). §14's health-probe "hard 1.5-second budget" could not be verified
>    against the live probe.
>
> Everything else spot-checked held: 9 cable types + legality, the 180 px rack unit,
> the four latency modes (Tight 0.012 default / Stable 0.045), capacity 4, the
> 25-module Moog System, auth (Clerk + anon HMAC invite), deploy topology, and the
> testing constitution.

## 1. Product summary

patchtogether is a collaborative modular synthesis studio: an infinite virtual rack where users wire modules together with typed patch cables to build live audio, video, and hybrid instruments. The catalog spans ~180 module types (live count shown in the app footer): roughly 170 audio-domain entries — oscillators, filters, envelopes, sequencers, effects, samplers, and a complete 25-module Moog System 35/55 recreation — plus ~61 dedicated video-synthesis modules (~90 video-domain palette entries including hybrids and games) and playable game modules (DOOM, BLOOD, and a family of arcade CV games). Everything is a signal: sequencers play synths, audio drives visuals, game events fire drums, and hardware controllers drive all of it.

- **Zero-install**: the full instrument is reachable by opening a link; nothing to download or set up, and no native helper app is ever required — including for all supported hardware controllers.
- **Real-time multi-user**: a shared "rackspace" updates for every participant live; anonymous guests get full edit rights via an invite link.
- **Always-on persistence**: there is no save button; every edit becomes durable within seconds.
- **Anonymous use is first-class**: a scratch rack exposes the entire instrument with no account.

## 2. Core concepts

### The rack canvas
- The workspace is an infinite pannable, zoomable canvas styled as a virtual modular rack: a fine dot field plus a ring marker at every intersection of a coarse square grid (one "rack unit" tile, 180 px). The view auto-fits the patch on load; double-click zoom is disabled so double-click stays free for control gestures.
- Sound output is gated behind an explicit user gesture: whenever audio is not running (first load, reload, resume), a translucent full-canvas overlay appears; one click (or Enter/Space) starts audio and dismisses it. The rack's visual state is fully present before audio starts, and after sound is enabled once per visit, all subsequent patching, loading, and spawning produce audio with no further prompts.
- Dragging empty canvas pans. Dragging a module card moves it freely (no forced snapping while floating). In a shared rack each participant keeps their **own** card layout — moving a card never moves it for anyone else; in single-user mode positions persist in the patch.
- Hovering a card highlights its related cables and dims unrelated ones. While a cable is being dragged, cables render in front of cards (intentional).
- A newly spawned card renders on top of anything it overlaps; this "spawn lift" ends as soon as the user touches a different card.
- **Rear view**: pressing **Tab** (or the Flip rack control) flips every card over in place to reveal a back panel of patch jacks for tracing wiring, with live per-port connection status. The flip animates both ways and is purely local view state — never shared, never saved.
- An **Organize modules** action row-packs all cards tightly while preserving relative arrangement (top-left stays top-left); running it twice produces the identical layout (idempotent). Tidy-up is always the user's explicit choice, never automatic.

### Signals & cable types
- Signals are typed. Core types: **audio** (full-rate, nominal ±1), **cv** (bipolar −1..+1 control — the equivalent of ±5V in hardware terms), **pitch** (volt-per-octave; 0 = C4 = note 60), **gate** (0/1 logic, high threshold at half-scale), a **poly pitch/gate** bundle (5 voice pairs in one cable), and four video types: **keys** (mono still), **image** (color still), **mono-video**, and **video**. Cables and port swatches are color-coded by type, with an on-screen legend.
- Every patch cable is mono; stereo means patching L and R. Modules may declare stereo L/R pairs; patching only L virtually duplicates the connection to R (stereo normalling).
- An input holds exactly **one** cable — patching an occupied input replaces the existing connection. Outputs fan out to any number of destinations.
- Pass-through utilities (attenuators/scalers) have outputs that **adopt the cable type of whatever is patched into them**, re-derived live on every repatch, so a scaled CV stays CV downstream (falling back to the declared type when unpatched or when adoption would make the downstream cable illegal).

### Connection legality (one rule set everywhere)
The same compatibility rules govern every patching surface — drag preview, drop commit, menu-based patching, click-connect, saved-group insert, file import, and remote peers:
- Same type always connects.
- **cv ↔ pitch ↔ gate** cross-patch freely in any direction — all control voltage; a sequencer gate can modulate an envelope time, an LFO can wiggle pitch, pitch can keytrack a filter.
- Poly bundle ↔ any cv-family port (poly→mono delivers voice 1; mono→poly feeds voice 1).
- Video upcasts are free and one-way: keys→mono-video, keys→image, image→video, mono-video→video — so any video output can drive any full-video input.
- **cv → any video input** is allowed (sampled once per video frame).
- **audio → non-audio is rejected** everywhere except designated permissive "modulation" inputs (e.g. TOYBOX's 6-input modulation section), which accept cv, gate, **or** audio — an audio source there is envelope-followed to a 0..1 value. **gate → audio** and **video → audio** are always rejected.
- Individual inputs may declare extra accepted source types (e.g. SCOPE's audio-typed probe inputs also accept cv/pitch/gate so LFOs, envelopes, and gates can be visualized).
- Malformed or incompatible connections arriving from any path are validated structurally and dropped **individually** — never crashing or aborting the rest of the patch.

### Triggers vs gates
- A gate cable carries a single binary control signal; the **consumer's declared semantic** distinguishes:
  - **trigger** inputs fire ONCE per rising edge (clock, reset, strike, sync, start/stop, sample-and-hold) and ignore how long the level stays high;
  - **gate** inputs act WHILE the level is high and react to both edges (envelope sustain, VCA hold, note on/off).
- The semantic is declared per port and documented on the module; it never restricts patching — gate↔trigger cross-patching stays legal. GATEMAIDEN is the user-facing gate↔trigger converter.
- Canonical constants: high threshold 0.5 (normalized); trigger pulses ≈5 ms; a gate derived from a trigger is held ≥50 ms. Guarantee: one clock pulse advances a sequencer exactly one step — never two.

### CV modulation convention
- A full-scale ±1 CV sweeps the target parameter through its **entire natural range**, centered on the knob position, with three scaling shapes: additive linear, multiplicative log (frequencies/times), and bucketed discrete (mode selectors). Out-of-range results pin at the control's limits — "CV pushes the knob around its setting; it pins at the ends."
- Absolute-position parameters (e.g. joystick X/Y) instead track the cable directly rather than biasing around a stored value.
- **Knob ↔ CV parity**: every modulatable knob has a matching CV input, and a CV write lands identically to a manual knob move (same range, same clamping).
- Live per-frame modulation is transient render state: it is never written into the shared/persisted document.

### Parameters & knobs
- Every parameter has a label, min/max, default, optional units, and a response curve (linear / log / exp / discrete) that shapes the knob's travel.
- Knob gestures: vertical drag to change; **Shift = ×0.1 fine**; **Cmd/Ctrl = ×0.01 extra-fine**; **double-click resets to default**; a value tooltip shows on hover and during drag.
- Knobs are "motorized": when CV is patched into a parameter, the indicator rotates live to show the effective modulated value (while not being dragged).
- Any knob, gate/trigger input, or button is assignable to hardware controls via right-click learn (see §7).
- A drag on a control coalesces into a single undo entry (not one per tick).

### Module identity & naming
- Every instance is auto-named from its type: the first instance gets the bare name (ANALOGVCO), later ones ANALOGVCO2, ANALOGVCO3… Retired numbers are **never reused** (except the bare slot, refillable when freed) — so a live-coding script can't silently retarget a respawned module.
- Titles are click-to-edit inline: Enter/blur commits, Esc cancels. Names must be non-empty, ≤32 characters, letters/digits/underscore only, no spaces, unique per rack (case-insensitive); a rejected rename shows the reason inline and keeps focus. Renames sync to all participants; simultaneous renames resolve last-write-wins. The LIVECODE language addresses modules by exactly these names, for every collaborator.
- The right-click card menu offers: open the module's documentation page, toggle on-card annotation overlays (documented modules only), assign a per-module "control colour" (preset swatches, custom, reset-to-auto), Duplicate, Lock/Unlock, and Delete; group cards add expand/collapse, duplicate group, and ungroup.

### Undo / redo
- Cmd/Ctrl-Z undoes; Cmd/Ctrl-Shift-Z and Cmd/Ctrl-Y redo. Shortcuts are suppressed while typing in a text field (native text undo wins there).
- Undo is strictly **personal**: in a shared rack it reverts only your own edits, never a collaborator's.
- Rapid bursts (knob drags) coalesce within a ~0.5 s window into single entries; multi-module operations (cabinet spawn, group creation, clear) are single undo steps. Programmatic/remote writes never pollute the undo stack.

### Rules & limits
- One cable per input; unlimited fan-out per output; patching an occupied input replaces the cable.
- Cross-type patching: cv/pitch/gate freely interchange; poly↔cv-family; video upcasts one-way; cv→video allowed; audio→non-audio only into designated modulation inputs; gate→audio and video→audio never.
- Trigger pulse ≈5 ms; trigger-derived gate ≥50 ms; gate threshold 0.5 normalized; one rising edge = exactly one step.
- Module names: unique per rack (case-insensitive), ≤32 chars, letters/digits/underscore, no spaces; retired auto-numbers never reused.
- Rack grid: square tile unit (180 px); module heights in whole tiles ("1u"–"4u"+ tiers), widths in whole tiles.
- Undo: local-only; burst coalescing ≈0.5 s.

### Interaction contracts
- A patch offered anywhere is a patch that will actually connect: one legality rule set on every surface.
- Invalid gestures fail **silently and safely** — no partial edges, no mid-gesture error modals, no corrupted patch from a bad import.
- Turning any number of on-screen or hardware controls during playback never audibly interrupts sound.
- Card moves are per-viewer in shared racks; patch structure, params, names, and colours are shared and update for all participants in real time.

## 3. Patching interactions

### Spawning & the module palette
- Right-click empty canvas opens a searchable palette at the cursor. With an empty search box it is a two-level category tree (Audio modules ▸ VCOs / Utility / Effects / Mixing / sequencers / I/O; Video modules ▸ Sources / Processors / Utilities; Games ▸ Emulators / Arcade; Moog System 35/55 Clones; livecode; MIDI; Hybrid — some groups render flat). Typing collapses it to a flat relevance-ranked list (exact > prefix > substring) so Enter always picks the best match. The catalog spans roughly 170 audio and 90 video entries plus meta/organizational cards (sticky notes, groups).
- Clicking an entry spawns that module exactly under the original right-click point, auto-named.
- Modules with an instance cap disappear from the palette at cap. Heavyweight media modules additionally enforce per-user and per-rack budgets; a refused spawn shows a friendly explanation banner that auto-clears after a few seconds. Owner-only modules (DOOM, BLOOD) are hidden from non-owners of a shared rack.
- The palette also hosts tool entries: Organize modules, Create group (starts lasso select), and Insert saved group (signed-in users).
- Right-click a card → **Duplicate** clones the module with all parameters and internal state (sequences, loaded images/samples, saved slots), offset ~30 px down-right, with a fresh unique name — cables are deliberately **not** copied.
- Example "cabinets" (full Moog System 35/55 rigs) spawn as one batch: dozens of modules laid out to mirror the real cabinet, arriving as a single undo step; anything unavailable is skipped rather than failing.

### Cable gestures
- Drag in either direction: output→input or input→output both work; the system orients the connection correctly. The drag preview shows validity live; invalid drops are rejected silently.
- Grabbing an already-patched **input** jack (drag or click) immediately detaches its cable — grabbing a patched input always means "rewire", in one motion.
- **Click-connect**: a click on a jack (under the ~5 px drag threshold) picks up a ghost cable that follows the cursor; clicking a compatible jack commits. Touch-friendly. Esc drops the cable.
- **Insert-on-cable**: spawning a module with the cursor within ~12 px of an existing cable's midpoint **splices** it in — provided the new module has an input compatible with the cable's source and an output compatible with its destination. The original cable is atomically replaced by source→new and new→destination (first-declared compatible ports). No match = a plain spawn.

### The patch menu (drill-down patching)
- Every card carries two small patch affordances (top-left and top-right); clicking one opens the card's patch menu edge-aligned to that side.
- The menu is an in-place drill-down (views replace each other, never side-by-side): root shows **INPUT / OUTPUT** (plus named sections on large modules); clicking drills into that direction's port list; a back affordance returns. Drilling is click-driven — hover never fights a click.
- Port rows are grouped by cable type with verbose human labels, show a filled/hollow jack indicating patched state, and on hover reveal the remote endpoint(s) as "MODULENAME.PORT".
- **Carry flow**: left-clicking a jack row picks up a visible ghost cable and offers "patch to"; choosing it shows a picker of every other module → drilling into one lists **only its type-compatible ports**, flagging occupied inputs as a destructive replace. A valid pick commits and closes; an invalid attempt discards silently; Esc discards; clicking negative space dismisses; cursor movement never dismisses.
- **Drop-on-card drill-down**: dropping a dragged cable on a card whose jacks live in the panel never auto-patches to an arbitrary jack — the picker opens pre-drilled into that card's compatible-port list so the user chooses. Cards with visible discrete jacks keep the precise direct drop.

### Stereo auto-wiring
- When the user patches one side of a declared stereo output into one side of a declared stereo input, the sibling connection (out_L→in_L implies out_R→in_R) is written automatically in the same atomic step — but only when both ends declare the matching pair, the sibling target input is currently unpatched (never overwrite), and the sibling pair is type-compatible.
- Pairing resolves strictly by declared tuples, never port-name guessing. A mono source into a stereo input leaves the sibling side alone (the engine normals R←L internally); the designed follow-on for mono→stereo is a double-patch of the one output to both L and R.

### Selection, lasso, and grouping
- Backspace/Delete removes selected cards and/or cables; deleting a card removes every attached cable. Cables can be selected and deleted individually.
- Right-clicking a multi-selection offers "Group modules…". **Create group** enters lasso mode: drag a bounding box; intersected cards highlight live; click or right-click commits (needs ≥2 eligible modules — existing groups and sticky notes are skipped); Esc cancels silently. Groups don't nest.
- Committing opens a group builder listing every port across the selection (ports whose cables cross the selection boundary pre-checked) to choose which ports the group exposes. In a shared rack, if another participant is mid-grouping any of the same cards, the action is soft-locked and labeled with who ("Alice is grouping…").
- Signed-in users can save a group (children, internal wiring, exposed ports; label 1–64 chars) to a private account-tied library and insert fresh copies into any rack they're in.

### Layout: footprint and lock
- Every module has a rack footprint: a height tier in whole tiles and a width in whole tiles; the card chrome enforces that box so the rack stays on its uniform grid.
- **Lock ("screw down")**: right-click → Lock snaps the card to the grid — vertically to full tile rows, horizontally to a finer pitch of 8 lock positions per tile — and, if the slot collides with another card, relocates to the nearest free slot (preferring cheap sideways slides over row jumps; never overlapping). A locked card is undraggable and marked; Unlock frees it in place.

### Keyboard
- **Tab** — flip rack front↔rear (bare Tab only; every modifier combo untouched, and inert while typing — owner ruling #1629: the flip gesture outranks native focus traversal in this app). **Shift-Tab** — native reverse focus traversal, never a flip. **Esc** — cancel in-flight cable/lasso/menus. **Backspace/Delete** — delete selection. **Cmd/Ctrl-Z / Shift-Z / Y** — undo/redo. **Enter** in the palette — spawn top-ranked match. **Enter/Space** — activate the audio-enable overlay.

### Examples & clear
- A **Load example…** action menu loads a complete working patch in one action: **Sequenced VCO** (sequencer → VCO + ADSR → VCA → output, pre-loaded with an auto-playing 8-note motif at 180 BPM — a new user hears music before learning to patch), **Moog System 55** and **System 35** cabinets, **MEDIA BURN** (15 PICTUREBOX tiles reassembling the famous photo plus a CADILLAC that smashes through ~1 s after load, identically for every participant), **GLITCHES GET RICHES** (audio+video demo), and **GIBRIBBON** (game demo: a sequenced voice drives game events via analysis). The menu resets after each pick so the same example can be re-loaded; example loads are additive-idempotent (re-loading never duplicates what's already there).
- **Clear** empties the whole patch — every module and cable — in one undoable step (disabled when already empty).

### Rules & limits
- Insert-on-cable radius ≈12 px; click-vs-drag threshold ≈5 px; duplicate offset ≈30 px.
- Grouping requires ≥2 eligible modules; groups don't nest; sticky notes can't be grouped; saved-group labels 1–64 chars.
- 8 horizontal lock positions per tile; locking never lands on another card.
- Per-type instance caps hide palette entries at cap; per-user and per-rack budgets on media-heavy modules; owner-only modules hidden from guests.

### Interaction contracts
- Menu-based patching only ever offers legal targets; occupied inputs are visibly flagged before an overwrite.
- Dropping a cable on a card body opens a chooser rather than guessing a jack.
- Stereo auto-wire fires only on declared pairs, only into empty inputs, atomically with the primary patch.
- A spawned card lands exactly under the cursor and on top.

## 4. Audio domain

### Scale & organization
- The add-module picker groups ~112 registered audio-domain modules: VCOs (14), Effects (14), Utility (24), Sequencers (7), Mixing (3), I/O (3), MIDI (4), Moog System 35/55 Clones (25), Hybrid audio↔video (12), Arcade games (4), livecode (2).
- Each module declares its own picker placement, rack size, and documentation; adding a module never requires editing any shared list. Singleton "anchor" modules (the master clock) cannot be deleted and are auto-spawned into any rack that lacks one.

### Gain staging & mixing conventions
- Attenuators only attenuate (0..1); attenuverters span −1..+1; a dedicated SCALER boosts up to 10×. Summing mixers sum additively; the simple attenuating mixer soft-clips its master sum; the 6-channel stereo mixer adds per-channel EQ, a one-knob per-channel compressor, and two stereo send/return pairs. Poly synths internally attenuate so all voices sounding at once stay clear of clipping.
- Cross-domain: audio-domain CV/gate outputs drive video-module parameters directly, and dedicated hybrid modules convert audio into video (raster mapper, scrolling sonogram with two colormaps, oscilloscope video out, resonator-bank visualizer, 4-oscillator 3D audio-visual synth, and FOXY — a self-contained chain that builds a playable wavetable in real time from its own evolving visuals).

### Module families
- **Oscillators/sources (~29)**: classic analog VCO (four simultaneous waveforms plus a continuous saw→sine→square morph, V/oct, audio-rate FM/PM, pulse width); MACROOSCILLATOR — 14 selectable synthesis models (virtual analog, waveshaper, 2-op FM, 6-op FM, chord, additive, string, modal, kick, snare, hihat, wavetable, granular, speech) driven by three macro controls (harmonics/timbre/morph) with glitch-free model switching; wavetable VCOs (a 16-frame morphing table; a stereo one with spread, wavefolder, user-supplied wavetable upload, and 3D table visualization); CUBE (a 3D wavetable "field" navigated by a movable slice plane) and HYPERCUBE (its 4D extension); SWOLEVCO (dual-oscillator complex generator with cross-modulation and West-Coast wavefolder); a 303-style acid voice; noise; a chaotic random-voltage source; a random-sampler/generative CV+gate generator; a modal string resonator; a formant "cat-vocal" voice; a dual-tone phone-dialer novelty; arcade-game sources (see §6); gamepad/joystick/ribbon controller sources.
- **Poly synths**: DX7 (6-operator FM, 32 algorithms, bank/preset import, 5 voices, per-voice output envelope layered over preset envelopes) and PENTEMELODICA (5-voice analog-style synth: per-voice tune/fine/wave-morph/FM/PM/level/pan, shared ADSR, built-in multimode filter, per-voice audio taps, 48 controls).
- **Filters (8)**: multimode state-variable filter (LP/BP/HP), a 5-mode multi-filter, QBRT — a stereo resonant filter with pluck-style "ping" excitation — plus the Moog ladder filters and fixed filter banks.
- **Envelopes & modulators**: ADSR with CV over all stages and an inverted output for one-cable ducking; clockable LFO with four quadrature-phase outputs whose phase stays aligned for every participant in a shared rack; NINE LIVES (one LFO fanned to nine outputs on a ⅓-rate geometric ladder); sample & hold that doubles as a continuous scale quantizer when un-clocked; envelope follower; dual trigger delay.
- **VCAs**: mono VCA with a free phase-inverted tap; stereo VCA that doubles as a ring modulator at audio rate (no mode switch — behavior follows signal speed); sidechain ducker with envelope outputs.
- **Sequencers (11+)**: 32-step sequencer with per-step chord quality (mono/major/minor); POLYSEQZ — 32-step chord sequencer (root, quality, inversion, voicing per step) with a "humanize" control offsetting per-voice timing (±15 ms at half, ±50 ms at max); DRUMSEQZ — 4 tracks × 16 steps with per-track Euclidean fill (0–16 hits) and quantized pitch CV; MACSEQ — 16 steps with a per-step synthesis-model picker; WRITESEQ — a **recording** step sequencer capturing live pitch/gate onto the nearest step; NUMPAD+ — 4-layer × 16-step sequencer that is also a live performance keypad with record/overdub; SCORE — sheet-music notation sequencer (up to 4 pages of 4 rows × 4 bars; ties held as single gates; dynamics markings shape the envelope output); KRIA — 4 independent tracks with per-step trigger/note/octave/duration lanes, per-step probability and glide, per-track loop/division/direction, 16 pattern slots with quantized (cued) switching, playable from a hardware button-grid or fully by mouse; CARTESIAN — 4×4 XY grid sequencer with a built-in quadrature LFO for drawing circles/Lissajous paths; CLIP PLAYER — a session-style launcher of 8 instrument lanes × 8 slots (64 note clips), launch-quantized, locked to the master transport, grid-controller drivable; the Moog 960 3-row × 8-step analog-style sequencer with companion sequential switch.
- **Drums**: layered kick voice (sub/body/click on independent controls), snare voice with a gate-driven polyphonic two-hand drum roll, an all-in-one synth drum voice, plus the macro oscillator's percussion models.
- **Samplers/loopers**: SAMSLOOP — loop player fed by a user audio file (≤2 MB, common audio formats) or in-place microphone recording; exactly one sample per instance (new material replaces old). TWOTRACKS — two-reel tape-loop emulator: per-reel record/overdub/decay, variable rate and direction, loop start/end, 3-band EQ, multimode filter, live waveform display, audio export (~20 s stereo per reel). CLOUDS — granular texture processor with position/size/density and a FREEZE latch.
- **Effects (~14)**: reverbs (simple room; SHIMMERSHINE octave-up shimmer tail; a deeply tweakable diffusion reverb; the Moog spring reverb), delays (clean stereo delay; COFEFVE analog-voiced tape/BBD-style echo; CHARLOTTE'S ECHOS destructive multi-head delay with per-tap pitch-up grains), lo-fi (DESTROY bitcrusher/decimator; RINGBACK varispeed ring-buffer crush), CALLSINE spectral additive resynthesizer, WARRENSPECTRUM 8-band ping-able resonator bank (octave or harmonic tuning, per-band sends/returns).
- **Utilities (~24)**: gate↔trigger converter (GATEMAIDEN), gate flip-flop, logic (AND/NAND/OR/NOT) + attenuverter math, polarizer/depolarizer (unipolar↔bipolar), 3-channel curve-morphing attenuverter, quad slew limiter + 4→1 sequential switch, 4-way signal selector, 2-channel oscilloscope (SCOPE), audio-feature-to-CV extractor, and LIVECODE — a typed mini-language that spawns and patches modules programmatically (no audio I/O of its own).
- **Moog System 55 recreation (25 modules)**: 902 VCA, 903A random signal generator, 904A/904B/904C filters + coupler, 905 spring reverb, 907A and 914 fixed filter banks, 911 envelope generator, 911A dual trigger delay, 912 envelope follower, 921/921A/921B oscillator family, 923 filters/noise, 956 ribbon controller, 960 sequential controller, 961 interface/converter, 962 sequential switch, 984 matrix mixer, 992 control-voltage panel, 993 trigger panel, 994 multiple, 995 attenuator, CP3 mixer.

### Poly voice model
- The poly cable carries 5 voice lanes of (pitch, gate). Lane 0 is the root by convention; connecting a poly source to a mono pitch input automatically delivers lane 0 — backward compatibility is a routing rule, not a user step.
- Chord voicing: mono (root only), major, minor — root/3rd/5th/octave-doubling; lanes exceeding the note range drop out individually (octave doubling is sacrificed before the 3rd or 5th).
- Live-note allocation: a note takes the lowest free lane and **keeps it until that note releases** (no repacking — releasing a low note never glitches a still-sounding voice); re-striking a held pitch reuses its lane; when all lanes are busy the least-recently-started voice is stolen; a release arriving after its lane was stolen is a guaranteed no-op. Releasing one note of a held chord never retriggers or re-pitches the other still-held voices.
- Per-voice envelopes exist at the consumer: DX7 applies a player-dialable per-voice output ADSR on top of each preset's operator envelopes; PENTEMELODICA runs one ADSR instance per voice (shared settings), per-voice level/pan preserved into the stereo image.

### Clock & tempo
- **TIMELORDE** is the per-rack master clock: exactly one per rack, undeletable, auto-created. Tempo 10–300 BPM (default 120). It fans out 13 clock outputs: 1× (quarter), 2×/4×/8× subdivisions, eight divisions (1/2, 1/3, 1/4, 1/8, 1/12, 1/16, 1/32, 1/64), and a swing output (0–90° offset, source division selectable) — no separate clock divider is ever needed.
- Transport: rising-edge start and stop inputs; stop freezes musical position, start resumes from it (DAW transport semantics). MUTE silences the clock outputs while the clock keeps turning (distinct from a real stop).
- An external clock input locks the master tempo to the measured incoming period; on disconnect it falls back to the internal tempo within ~2 beats. Patching MIDICLOCK's clock/start/stop (see §7) into TIMELORDE slaves the whole rack to hardware transport; while externally clocked, sequencer transport buttons hide and tempo affordances grey out — external hardware is the tempo master.
- **Tap tempo**: on the master-clock card (including a spacebar shortcut while the card is selected) and from a hardware control-surface pad. BPM = the median of recent tap intervals (up to 4 intervals over the last 5 taps — robust to one mistimed tap); locks from the second tap; a >~2 s pause starts a fresh sequence; clamped to 10–300 BPM; inert while externally clocked.
- Sequencers run from their internal tempo or advance one step per external clock rising edge; some (CLIP PLAYER, KRIA) lock exclusively to the master transport. Guarantee: sequencing never drops or shifts steps during heavy interaction — events are scheduled ahead of time and the step engine is immune to interface stalls.
- **Shared time**: every participant in a shared rack observes the same clock epoch; time-derived modules (LFO phase, sequencer position) compute identical state from it; the owner can reset it; clock drift between machines is smoothly re-anchored about every 5 seconds.

### Audio input & output
- **AUDIO IN**: streams any system input (mic/line/interface) with an on-card device picker that refreshes on hot-plug, sensible default selection, and a permission flow. Detects mono vs stereo and exposes L+R outputs: mono sources fan out to both; stereo sources split discretely (no fake up-mix). A multichannel interface (e.g. an Expert Sleepers ES-9) delivers exactly its **first stereo pair (inputs 1/2)** — capture beyond 2 channels, per-pair selection, and >2-channel output are not available. A single gain knob (0–2×) trims both channels. A **music mode** toggle forces capture cleanup (echo-cancel / noise-suppress / auto-gain) OFF for a clean line-level feed; saved with the patch.
- **AUDIO OUT**: the terminal stereo sink — two mono inputs (L, R), master level (default 0.7), an optional output-device picker where the platform supports it, and two always-on safety stages: a sub-audible DC-offset blocker and a transparent peak limiter (inactive on properly-leveled mixes). Design intent: a runaway patch can never damage speakers.

### Latency / buffer control
- A footer selector offers a 4-step buffer ladder: **Low** (smallest, lowest latency), **Tight** (~12 ms, default), **Balanced** (~25 ms), **Stable** (~45 ms, for heavy/video-laden patches), with monotonically increasing buffering and plain-language guidance. The choice is a per-machine preference, persists across sessions, takes effect at the next app reload, and the UI shows a persistent "reload to apply" hint until then; changing it never interrupts live audio. A live footer readout shows current processing latency and (where available) full output-pipeline latency in ms.

### Rules & limits
- Master clock: 1 per rack, undeletable; BPM 10–300; 13 clock outputs; swing 0–90°.
- Poly cable: 5 voices; steal = least-recently-started; lane ownership survives until release.
- Sequencer sizes: 32 steps (melodic/chordal), 4×16 (drums; Euclidean 0–16), 16 (model-seq), 4×16×4 layers (keypad), 4 pages × 4 rows × 4 bars (SCORE), 4×4 (CARTESIAN), 3×8 (Moog 960); KRIA 16 pattern slots with quantized switching; CLIP PLAYER 8×8 = 64 clips.
- Humanize: ±15 ms at half, ±50 ms at max, per voice.
- Sample upload ≤2 MB; one sample per SAMSLOOP instance.
- Audio capture: max 2 channels per input module; first stereo pair only.
- Latency ladder: exactly 4 steps; default Tight ≈12 ms; applies on next reload.

### Interaction contracts
- Deleting the master clock is refused; a rack opened without one gets one automatically.
- A patched stop input is a true transport stop (position frozen, resumable); MUTE only silences outputs.
- Poly→mono plays the root voice with zero configuration; a poly source wired to a poly synth always sounds.
- Patching only the L side of a declared stereo pair automatically feeds R.
- External clock unplug falls back to internal tempo within ~2 beats.
- Any control-rate output may legally drive any control input, including across the audio/video boundary.

## 5. Video domain

A full video-synthesis domain alongside audio (~61 video modules in the same palette, patched on the same canvas). Video and audio/CV interoperate freely: control signals and audio modulate video parameters, and video modules emit audio, CV, gates, and triggers back into the audio domain.

### Generators (sources)
- **LUSH GARDEN** — generative layered garden: plant cutouts (flowers/bushes/trees, ~70/20/10 mix) spawn continuously onto a perspective ground plane, grow in (~350 ms), parallax-pan with a VIEW control, and recycle oldest-first at a 350-plant cap. A gate input switches to one-plant-per-pulse spawning; a reset pulse clears the bed. Four simultaneous outputs of the same scene: clean composite, mono silhouette outlines, watercolor, animated psychedelic hue-cycling; an optional background video passes through behind the plants on all four.
- **MILKDROP** — classic music visualizer with ~20 curated presets. Audio in drives the visuals (inaudible tap); the three internal reactivity bands (bass/mid/treble) can each be individually replaced by a patched CV cable (unpatched bands keep following the audio). Controls: global reactivity, time-warp speed, quantized preset select (knob or CV), morph/crossfade time, and a trigger input advancing presets. Hide-controls turns the card into a resizable monitor. User-loaded classic preset files convert and join the picker for the session.
- **Fractals** — MANDLEBLOT (2D Mandelbrot: zoom, rotation, smooth color-cycling; mono + color outputs), MANDELBULB (true-3D volumetric fractal with lighting and soft shadows), ACIDWARP (classic 320×240 plasma with a scene cycler).
- **Shape/pattern sources** — SHAPES (circle/square/triangle with tiling, rotation, zoom), LINES (procedural line/grid patterns), INWARDS (inward-zooming concentric rings), SPIROGRAPHS (1–3 independent hypo/epitrochoid curves that provably close, drifting and bouncing off frame edges), PEAKSTATE (animated kaleidoscope mandala; mono/color/psychedelic outputs), SHAPEDRAMPS (sync-locked ramps on four outputs for scan-processor patching), SHAPEGEN (3D shape generator driven by three raster inputs), OUTLINES (particle generator: each gate pulse or internal clock spawns one of six shapes that latches size/direction/speed/decay/form at spawn, bounces off walls, optionally collides elastically under a live gate, global bipolar spin; 200-shape cap; four outputs derived from per-pixel overlap counts, including a video input masked to overlap regions).
- **Camera & capture** — CAMERA (webcam source with gain/mirror/on-off; max 4 instances; strictly local — collaborators see a "camera active" presence badge, never the picture), LOOPBACK (the app's own visible viewport as a source, cropped to the working area — record-what-you-see or self-referential feedback; max 2 instances).
- **Media players** — PICTUREBOX (still images, synced to all rack-mates, 7-slot note-addressed asset selector switchable by pitch+gate), VIDEOBOX (local video file with multiplayer playhead sync — play/pause/seek by any peer converges everyone), VIDEOVARISPEED (local video with ±4× varispeed including reverse, start/end loop window, transport gates, 7 preloaded slots for instant switching), ARCHIVIST (public-archive search: random matching item, year filter, scrub/skip/random-seek, per-type outputs and play-state gates/CV), PEERTUBE (federated video search with clean downstream picture (no on-card controls in the output) + stereo audio, next-result trigger), TV LIBRARIAN (international live TV picked from a world map; random/next channel triggers, channel-changed pulse, stream-online gate; dead streams auto-skip).
- **Text & drawing** — TEXTMARQUEE (rich-text marquee: styled runs, alignment, colors, scroll/position knobs), PAINTER (a retro paint program whose canvas is the output; drawing is an ordered op log that replays identically for all collaborators).
- **Games as sources** — see §6 (DOOM, BLOOD, NIBBLES, TEMPEST, GIBRIBBON, SKIFREE emit video; all games emit gates/CV).
- **VFPGA-RUNNER** — one reconfigurable card loading any of 9 bundled declarative effect "bitstreams"; the card exposes a fixed I/O superset (4 video in, 4 CV in with attenuverter+offset+scope, 4 gate in with activity LEDs, 2 video out, 8 labeled knobs) and the loaded spec activates a subset.

### Effects / processors
- **Feedback family** — FEEDBACK (previous-frame loop with zoom/rotate/offset warp, decay, wet/dry; output always clamped so runaway settings can't blow up), VDELAY (frame-delay echo ring with feedback and per-echo color shift; discrete N-frame echoes), BACKDRAFT (two-input crossfaded source composited with a delayed, color-processed copy of its own output).
- **Keying & mattes** — CHROMAKEY (green-screen with softness, saturation gating, spill suppression), LUMAKEY (brightness-keyed with threshold/softness/invert), MAPPER (show video only where a key input is bright; crisp threshold, sub-pixel-soft edge).
- **Color** — CHROMA (hue shift / saturation / tint), LUMA (gamma, contrast, posterize, bias — chroma-preserving), COLORIZER (mono × tint color), COLOUR OF MAGIC (five parallel color-space blocks — including broadcast-legal ranges — each with per-channel bias knob+CV, mono override input, and clip-vs-wrap overflow modes; 22 outputs total).
- **Stylize** — CELLSHADE (cel/toon: 2–65,536 quantized colors with inked contours), EDGES (edge detection, threshold, 1–8 px thickness), DESTRUCTOR (chromatic aberration, scanline disruption, posterize glitch), TILER (N×N multiscreen: passthrough, 4×4 … 16×16), FREEZEFRAME (video sample-and-hold: unpatched gate = live passthrough; gated = updates only while high, freezing on release; per-channel posterize), SOURCERY (edge-segments two inputs into regions and repaints each region of A with the best shape-matched region colors of B, with hue-skew and rotate).
- **Signal-bending / retro-TV** — BENTBOX (simulated composite-signal CRT through a hand-bent circuit: timing glitches, not pixel glitches), B3NTB0X (full multi-stage composite-voltage simulation with sync crush and CRT demodulation), MONOGLITCH (brightness-driven vertical scanline displacement).
- **Scan processors / remaps** — RESHAPER (scan-coordinate remap), RUTTETRA/"xyz" (authentic scan-processor look: real displaced line geometry driven by X/Y/Z inputs).
- **Projection & splitting** — MAPPY (manual projection mapper: up to 6 surfaces, each fed by its own video input and warped onto a draggable four-corner quad with numbered calibration grids, composited front-to-back; per-surface fit vs crop — for de-skewing projectors or mapping cube faces), ONETONINE (3×3 splitter: nine clean magnified cell outputs; its on-card monitor overlays the grid and big cell digits so the operator can see which cell feeds which projector).

### Mixers & routers
- **V-MIXER** — 4-channel video mixer, per-channel level knob + CV.
- **FADER** — two-source A/B mixer with a transition selector (fade, wipe, dissolve, star iris, checkerboard — 5 shapes) plus a send/return FX loop with its own dry/wet fader and transition.
- **QUADRALOGICAL** — four inputs on an XY joystick; center blends all four, edges become crisp two-input transitions, and each of the four edges carries its own independently selected effect (dissolve / add / multiply / wipe / chroma / luma / difference / iris — 8 choices) with per-effect params and CV.
- **4PLEXVID** — 4-in/4-out crosspoint router; each output has a selector knob and a gate input that rotates its selection one step per rising edge (never a blend).

### TOYBOX compositor
- Four layers, each with a selectable content kind: generative entries from a bundled bank (with per-entry labeled faders), an FX layer processing the composite below it, community-format visual programs — including multi-stage programs with internal self-feedback and click/drag interaction on the live preview — 3D mesh layers (bundled meshes or procedural cube/sphere/torus/hypercube, three procedural material styles, rotate/scale/auto-spin/tint), still images, video (from the module's two patched video inputs, a local file, the webcam, or a layer-feedback tap), or off.
- Layers reduce to the output through a **user-editable combine graph**: per-layer source nodes, two-input op nodes (fade / lumakey / chromakey / map), frame-history ops (frame delay, channel desync, flow smear, dream melt, datamosh), and exactly one output node. Cycles are rejected at edit time; a disconnected graph renders black, never crashes.
- **Modulation**: six generic CV inputs accepting CV or audio (audio is envelope-followed automatically), each user-routed to any layer/material/combine parameter with a bipolar scale (attenuverter) and offset, with always-on inline scopes showing live values.
- **Presets**: bundled read-only presets, user-saved local presets (media-light), and full export/import as a single portable bundle including loaded video media — a patch round-trips exactly onto another machine.

### Audio-reactive
- **SYNESTHESIA** — two independent copies (A/B), each in AUDIO mode (four musical bands: bass / low-mid / high-mid / treble) or VIDEO mode (R/G/B/luma levels of a patched frame). Per band: slow (500 ms) and fast (50 ms) envelope CVs with makeup gain and a depth knob (0–2×), a hysteresis gate, a once-per-hit beat trigger (~10 ms pulse, onset-detected, 80 ms debounce), a band audio tap, a VU meter, and a mono raster output.
- **GRAPHIC EQ** — full-screen stereo 8-band meter visual with two classic looks.
- **SCOREBOARD** — 4-digit neon counter incremented/reset by gate pulses.

### Output, monitoring, recording
- **OUTPUT** — the card body is the live picture; multiple OUTPUT cards each show their own feed. With nothing patched it shows a static idle pattern so it reads as alive. It passes input through an output port so monitors chain inline. Cards resize by corner-drag; sizes sync to collaborators. Right-click menu: true fullscreen, in-app full-frame (hides chrome), and **present on a second display** — one presentation window per display, fan-out to every display in one action (multi-projector), independently stoppable, while the main window stays interactive.
- **Aspect/resolution** — a global toggle switches the render between 4:3 (1024×768, default) and 16:9 (1366×768); same 768-pixel height, wider frame. Switching is live (the running patch survives), persists with the patch, rides save/load, and syncs to collaborators. Lower-resolution native sources letterbox/pillarbox correctly.
- **RECORDERBOX** — monitor-and-record sink: video in plus stereo audio in (tap-only, never doubled to speakers), live preview, inline pass-through out. Editable filename (synced to rack-mates), a HIGH / BALANCED / SMALL quality tier (BALANCED ~55–65% smaller, SMALL ~70–80% smaller at near-imperceptible cost; tier synced and locked mid-take), and a Record toggle. First record picks a destination folder once; thereafter files auto-save under the typed name with no per-save dialog (only an overwrite confirmation). Long takes roll to a new file every ~10 minutes with a 5-second audio overlap between chunks, named FILENAME-CHUNK#-DATETIME. Recording is constant-rate 30 fps so playback never runs slow-motion. **Crash recovery**: an in-flight take is continuously flushed, so if the session dies the partial file is playable; on next open the card offers "recover unsaved recording?" and saves it into the remembered folder (strictly local; rack-mates never see it). If the machine can't encode, the card shows a "no encoder available" badge and disables Record — never crashes.

### On-card previews & rendering behavior
- Nearly every video card shows a live preview of its own output; multi-output modules designate a canonical monitor view (which may carry operator overlays while the actual outputs stay clean). Previews are interactive where meaningful; several cards offer hide-controls to become pure resizable monitors.
- One engine renders all video modules continuously at up to display refresh rate (~60 fps target). Every **patched or watched** output refreshes every frame, so downstream consumers always sample a fresh frame; outputs nobody watches or has patched cost nothing (rendering all of COLOUR OF MAGIC's 22 outputs unconditionally is treated as a defect).
- Recording tolerates render slowdowns by dropping frames rather than stretching time; a sustained render collapse (below ~10 fps) degrades gracefully instead of flooding catch-up frames.

### Rules & limits
- Render: 1024×768 (4:3, default) or 1366×768 (16:9); constant 768-pixel height.
- Instance caps: CAMERA 4, LOOPBACK 2, PICTUREBOX 8 per rack; DOOM and BLOOD 1 each, owner-only.
- Content caps: LUSH GARDEN 350 plants (oldest replaced), OUTLINES 200 shapes, TOYBOX 4 layers + 6 CV routes + 2 patched video feeds, MAPPY 6 surfaces, PICTUREBOX/VIDEOVARISPEED 7 asset slots, ONETONINE 9 outputs, QUADRALOGICAL 8 edge effects, FADER 5 transition shapes, VFPGA 9 bundled specs.
- Recording: 30 fps constant; ~10-minute chunk roll with 5-second audio overlap; 3 quality tiers; deterministic chunk naming; one-time folder pick; overwrite is the only recurring prompt.
- Failure rules: undecodable/dead media auto-skips with visible status (never hangs on "Loading"); an invalid compositor graph renders black; missing capture/encode capability disables the feature with a badge instead of erroring.

### Interaction contracts
- Image and mono signals plug into any full-video input automatically; key/matte signals are ordinary video-domain signals.
- Pulse inputs (spawn, next, reset, advance) fire exactly once per rising edge; level inputs (freeze-while-high, collide-while-high, play-while-high) act on the held level — each port declares which it is.
- Unpatched fallbacks mean "free-run/live": FREEZEFRAME passes through, LUSH GARDEN keeps auto-spawning, MILKDROP bands follow audio, OUTPUT shows an idle pattern.
- Newer modules patch via the drill-down patch panel (grouped Gates / CV / Audio / Video rows) rather than side jacks.
- Module settings, filenames, selections, drawings, and playheads sync to all rack-mates in real time; local media files are re-linked per participant (bytes never leave the machine, metadata syncs); camera and screen capture are strictly local with a presence badge; per-frame modulation is transient and never synced.
- OUTPUT and RECORDERBOX pass input through, so monitoring/recording never breaks the signal path.

## 6. Game modules

Games are first-class patch modules in a dedicated palette section (Emulators, Arcade). Two shapes: **full game ports** (DOOM, BLOOD) producing live video plus game audio, and **arcade/CV games** (GibRibbon, NIBBLES, TEMPEST, FROGGER, PONG, MODTRIS, SKIFREE) where gameplay itself is a generative control source. In every case a game's inputs and outputs are ordinary patch signals — so sequencers, LFOs, envelopes, a GAMEPAD module, or MIDI hardware can *play the game*, and game events can *play the patch*.

### DOOM (Emulators)
- Runs the complete 1993 shareware game as an interactive video source. Each seated player sees their **own first-person view** (native 640×400, aspect-preserved; a Fill toggle switches letterbox vs cover-crop). Spectators see the attract screen only — no mirroring of another player's view.
- **Assets**: the ~4 MB shareware data downloads on the user's first click and is cached; later spawns load instantly. No user-provided files are needed or accepted.
- **Control**: click the card to capture the keyboard (move/turn, fire, use, strafe, menu keys). Alternatively, 36 per-player CV gate inputs — 9 gates (up/down/left/right/use/fire/strafe/menu-open/menu-confirm) × 4 player slots — act as held keypresses. Each participant honors only the gate group for their own seat; in single-player only the player-1 group is live. Patching any CV gate makes the keyboard inert for that card until unpatched (CV wins).
- **Cheat gates**: two rising-edge triggers inject the classic god-mode and full-arsenal cheats for the local player only (one-shot per edge, never replicated).
- **Event outputs**: 29 gate outputs pulse 10 ms HIGH on game events — any-monster kill, door-open, per-player weapon fire (×4), per-player death (×4), and per-monster-type kills (19 types).
- **Audio**: stereo outputs carry the live sound-effects mix; Gain knob 0–2 (default 1).
- **Multiplayer (co-op with hot-join)**: exactly one DOOM node per rack, addable only by the rack owner. The host (module spawner; rack owner preferred; re-elected automatically on departure) starts Single Player or Hosts Multiplayer via a game-setup dialog (modes: co-op, deathmatch, deathmatch 2.0, survival; 5 skill levels; episode/map/monster options chosen for everyone). Up to 3 rack-mates one-click **hot-join** for 4 marines total; Join is enabled only while the host's game is actually live. All joined players share one identical, deterministic simulation that advances in step for every player; player input carries ~170 ms scheduling latency (normal netplay feel). A mid-level joiner reserves a seat immediately ("pending") and spawns at the **next map** (the host can force "Next Map"); the settings dialog is locked mid-level and reopens at intermission. If the host leaves, a remaining participant is promoted automatically within seconds (SPEC badge becomes HOST). DOOM has no pause: the shared simulation always runs while loaded.

### BLOOD (Emulators)
- A faithful port of the 1997 game Blood as an interactive video source; currently single-player. Owner-only, one instance per rack.
- **Assets**: boots out-of-the-box — the 1997 shareware episode ("The Way of All Flesh") is bundled. An optional "Load full Blood data…" picker points at a user-owned copy of the full game to unlock all episodes; user data persists across sessions, stays local, is never redistributed, and a failed load can be retried without respawning the module.
- **Control**: 13 CV inputs — 11 held-while-HIGH gates (forward/back/turn-left/turn-right, fire, alt-fire, use, jump, crouch, weapon-next, weapon-prev) plus 2 rising-edge triggers (menu open/back, menu confirm). Keyboard play via card focus as well.
- **Audio/video**: true-stereo outputs carry effects plus the game's synthesized music score; Gain 0–2. Video is the software-rendered game image, aspect-preserved with a Fill toggle.

### Arcade games
- **GibRibbon** — an original rhythm side-scroller in the style of Vib-Ribbon: a white vector ribbon deforms into pits and humps; the player and enemies are real DOOM shareware sprites (degrades gracefully to full line-art with an on-card badge if the DOOM data isn't present). A clock input advances the ribbon one beat per pulse; a beat-gate plus four CV channels decide what spawns each beat (each channel maps to one event type — loop, jump, two enemy kinds; strongest channel above threshold wins, off-beat spawns sparser). Unclocked, AUTOPLAY (default ON, ~0.42 s internal beat) self-plays. Play inputs: four button gates (A/B/X/Y) judging the nearest in-window event per rising edge (no penalty for spare presses); X/Y axes aim — X shifts the timing judgement point by up to one hit-window, Y raises/crouches. Keyboard play via card focus. Hits score with a combo multiplier capped at ×8 and can heal to SUPER; misses degrade a 5-rung health ladder (super/healthy/wounded/critical/dead) to game over. Outputs: 16:9 letterboxed video, five 10 ms event gates (hit, miss, fire, kill, game-over), and a smoothed 0–1 health CV.
- **NIBBLES** — snake on an 80×50 grid, rendered as a 320×200 retro video source with scanlines. Arrow keys (card focused) or AUTO (a built-in bot self-plays, eventually traps itself, dies, and restarts). Tick knob 40–200 ms per step. Outputs: 10 ms gates on pellet-eat, death, and every direction change; a bipolar length CV (clamped: length 119 = full scale); two audio outputs — a continuous square wave pitched by snake length (length 4 = 110 Hz; +12 length = +1 octave) and the same tone gated through an envelope retriggered per pellet. Card extras: RESET, 1×–4× screen zoom, live length readout; state is per-session.
- **TEMPEST** — a vector tube: glowing wireframe well, player claw on the near rim. A single CV input positions the claw around the rim (0–1, wrapping — rotary-spinner control); a Shape control picks the cross-section (circle / square / star). Output: the vector-glow video render. (Enemies/firing/scoring are planned follow-ons.)
- **FROGGER** — the classic crossing game as a pure CV/gate module: 13-row board, 5 home pads, per-life countdown (Time knob 10–120 s). Four rising-edge gates hop one cell per pulse; a START gate restarts (auto-fires once on placement so a game is always running). Outputs: 5 ms gates per home pad reached (simultaneous homes emit distinct staggered pulses), per death, per level cleared — e.g. wire DEATH→START for an endless loop. The board renders on the card; the screen can be adopted into a containing GROUP panel (no dedicated video jack).
- **PONG** — two-paddle Pong; each paddle's vertical position is a continuous bipolar CV input (one slow LFO gives an auto-rally; two players can each drive a side). Outputs: a 5 ms score gate per side. Knobs: ball speed 0.25–4×, paddle height 5–50% of court, serve-angle variance. Card screen; GROUP-panel display like FROGGER. Single-user today (shared-state multiplayer is a designed follow-on).
- **MODTRIS** — a Tetris-style stacker in a 10×20 well, played entirely through five rising-edge gates (rotate left/right, fast-drop, move left/right). Gravity in BPM (30–240); a level-step control sets how many cleared lines ramp difficulty. Outputs: one 5 ms pulse **per line** cleared (a four-line clear fires four distinct staggered pulses) and a game-over pulse.
- **SKIFREE** — the classic downhill skiing game. Two bipolar CV inputs steer (synthesizing the cursor the skier chases); unpatched with card focus, the real mouse steers — any patched CV overrides. Outputs: one 10 ms gate on every crash or yeti-eat, and a true video output of the live game screen. No parameters; max 1 instance per rack.

### Name disambiguation (not games)
- **MAPPY** is the video projection-mapping module (§5). **QBRT** is a stereo resonant filter with a ping/pluck trigger — an audio effect. (Earlier Q*bert- and console-emulator experiments were removed from the product.)

### Rules & limits
- DOOM and BLOOD: max 1 per rack, owner-only to add. DOOM co-op: hard max 4 players (owner + 3 hot-joiners; a 5th requester gets no seat); ~170 ms netplay input latency. SKIFREE: max 1 per rack.
- Gate-output pulse widths standardized: 5 ms (FROGGER, PONG, MODTRIS) or 10 ms (DOOM, GibRibbon, NIBBLES, SKIFREE); simultaneous same-gate events are staggered so consumers count distinct edges.
- Asset policy: legally redistributable data ships bundled (DOOM shareware auto-downloaded ~4 MB and cached; BLOOD shareware bundled); anything else is user-supplied, kept local, never synced.
- DOOM cheats and keyboard affect only the local player; keyboard is disabled on a card whose CV gates are patched.

### Interaction contracts
- Every game input is a standard patch signal (continuous CV for axes, triggers for one-shots, held gates for sustained actions), so any modulation source can play any game with no special wiring; every game event output is a standard gate/CV any module can consume.
- Game audio outputs enter the audio graph as ordinary sources (mixable, processable, meterable, recordable), each full port with its own 0–2 gain trim; game video outputs are ordinary video sources.
- Games follow only the clocks patched into them (GibRibbon advances exactly one beat per clock edge); they never follow the global transport implicitly.
- Only DOOM is state-shared (one shared node, per-player views, deterministic identical simulation, hot-join at next map, spectators excluded until Join). All other games run locally per participant even in a shared rack, while placement, patching, and knob settings sync like any module.

## 7. Hardware & control I/O

### Device pairing & permission UX (all hardware)
- **Gesture-gated, never eager**: no device permission prompt ever fires at app launch. Access is requested only when the user clicks a connect/learn/pair affordance; a prior grant is reused silently later.
- Pairing: click connect → system permission/picker → pick the device → the product configures it and starts I/O. Denial degrades gracefully (the module emits silence / stays unbound).
- Hot-plug everywhere: newly connected devices attach automatically; a vanished device tears down cleanly so reconnect works.
- Zero-install is a product property: every supported controller (MIDI, Electra One, monome grid, Launchpad, gamepads, audio interfaces) works with no companion app.

### MIDI learn (knobs, gates, buttons)
- Every continuous control on every card is MIDI-assignable: right-click → "MIDI Learn" → move a hardware control → permanent binding, with the captured value applied immediately (the on-screen control visibly jumps to the hardware position).
- Every gate/trigger input and every card button is also assignable, bound to a MIDI **note**: note-on = press / gate high, note-off = release / gate low (momentary). Only a fresh press arms a note learn — releasing an already-held key never captures.
- While learning, the target shows a pulsing "assign" border; an in-flight learn can be cancelled, and starting a new learn cancels any other in-flight learn. A bound control shows a badge ("CC 7" / "NOTE 60") and a full label ("CH 1 · CC 7"); bindings can be forgotten from the same menu.
- Continuous values map linearly from the hardware 0–127 range onto the control's natural min–max, respecting its response curve.
- Bindings are **per-machine and personal**: they persist across sessions on the user's device but never sync to collaborators (your mapping can't clobber a rack-mate's).
- One binding per on-screen control, and **one owner per physical control**: learning a physical knob/pad onto a second target evicts the older assignment — a single hardware twist can never drive two parameters. Enforced on every path (fresh learn, import, load); loading a stale colliding map self-repairs.
- Saving a performance bundles the MIDI map; loading re-arms those bindings for the performance's modules while preserving unrelated bindings.
- Fast hardware streams (hundreds of messages/second) drive the on-screen control in real time on every message, while durable/shared state settles at a coalesced cadence with a guaranteed final settled value — collaborators and undo always converge, video rendering is never starved, and one twist collapses into a single undo step.

### MIDI performance modules
- **MIDI CV BUDDY** — hardware keyboard → pitch/gate/velocity CV. Monophonic with three voice priorities (LAST default / LOW / HIGH), a RETRIG toggle (gate dips briefly per new note so envelopes re-fire) vs legato, channel filter ALL or 1–16, hot-plugging device picker. Pitch is volt-per-octave (0 = middle C); pitch-bend is summed at ±2 semitones.
- **MIDI LANE** — a per-channel "one channel = one instrument" bus for multi-timbral rigs: pitch/gate/velocity, two learn-assignable continuous-controller taps emitting 0–1 CV (cc_a defaults to the mod wheel, cc_b unassigned), and a by-note drum gate (card-selectable note, default 36 = kick) firing a one-shot pulse. MONO mode has the three priorities; POLY mode drives a polyphonic output of up to **5 simultaneous pitch/gate voice pairs** (newest-held wins, steal-oldest). The poly output is **always live regardless of mode**, so the real controller → module → sound chain can never be silently dead. All outputs can drive video inputs directly — a note can fire visuals with no synth voice.
- **MIDI OUT** — the reverse: rack gate/pitch/velocity CV plays external hardware. Gate rising edge sends note-on (pitch quantized to nearest semitone, velocity floored to 1); the falling edge sends the matching note-off for the note actually started, even if pitch drifted while held. Device chosen from a dropdown (remembered by device name across saves), channel 1–16. On device/channel change or module removal, held notes release and an all-notes-off is sent — external gear is never left with a stuck note.
- **MIDICLOCK** — external transport bridge: a clock output at a selectable subdivision (quarter [default, 24 incoming ticks per pulse] / eighth / sixteenth / 32nd / raw 24-per-quarter — divisors 24/12/6/3/1), a run level (0/1), and one-shot start/stop pulses. "Continue" resumes the run level **without** re-firing start, so downstream loops resume in place. Patch its clock/start/stop into TIMELORDE to slave the whole rack to hardware.
- A rack-wide **MIDI tempo source** also exists without placing any module: features offering a "MIDI" clock choice read the live tempo of any incoming hardware clock, valid within 10–300 BPM, marked stale after 1.5 s of silence; device access is requested only the first time it's actually read.
- Timing guarantee: hardware note/clock events are scheduled from the device's own timestamps, not arrival time, so note spacing stays even under heavy interface load.

### Electra One deep integration
- A "Send to Electra" action (on the ELECTRA CONTROL card) auto-configures a connected Electra One in one click: identify the device → generate a complete 3-page control layout from the live patch → upload it plus the device-side behavior → import the resulting map into the MIDI-learn system → start live value feedback → land on page 1. If device identity can't be confirmed quickly, the upload proceeds anyway (the user explicitly asked).
- Pages: **1 CONTROL** — the patch's surface bindings (positional grid or module-grouped); **2 MIXMASTER** — per-channel mixer controls plus a read-only meter row; **3 SYSTEM** — tempo display, BPM tweak, tap-tempo pad. Up to **36 controls per page** (3 banks × 12).
- **Bidirectional sync.** Device → app: a hardware pot twist writes the parameter (curve-aware), moving the on-screen knob, the engine, and every collaborator's view. App → device: parameter changes (on-screen drags, CV modulation, remote collaborators) reflect back so the hardware display tracks reality; per-channel and master meters stream at ~30 Hz. Echo suppression (~120 ms window) prevents a device-originated move from bouncing back and juddering.
- On connect, live values are pushed immediately and re-pushed at several settle points (~0.25/0.8/1.8 s) so the hardware never shows zeroed defaults.
- The tap-tempo pad uses the shared tap rules (§4) and writes the rack tempo, synced to rack-mates; inert when externally clocked. A device banner shows clock source and tempo ("INT 120" / "EXT 128"). Clock-dependent affordances (tap pad, BPM tweak) grey out while externally clocked.
- Buttons become hardware pads: momentary buttons press/release with the pad; toggle buttons latch, firing on the press edge only.
- Custom control names (clamped to 14 characters) and each source module's control colour are carried onto the hardware; colours re-resolve live at each send, never stored copies.
- Re-sending after editing the layout fully replaces the previous configuration — no zombie listener remains, so one hardware twist can never write both an old and a new parameter. User-learned MIDI bindings keep working in parallel.

### Generic control surfaces (proxied controls)
- **CONTROL SURFACE** — a panel module aggregating *pointers* to other modules' controls (never copies). A proxied knob reads/writes the source parameter directly and shares the source's MIDI identity: a MIDI assignment on the proxy *is* the assignment on the source; the same control can live on multiple surfaces; nothing drifts. Proxies keep working when the source is collapsed inside a group. Controls group by source module; group boxes are draggable with a lock toggle; scope screens can be portaled onto the surface; surfaces are nameable.
- **ELECTRA CONTROL** — the fixed positional sibling: a 6×6 grid of exactly 36 slots in three 2-row banks (TOP/MID/BOT), mirroring the hardware. Every filled slot renders a proxied knob with an editable label (the name flashed to the device) and a colour stripe from the source module; empty slots render empty; slot placement on the card equals pot placement on the hardware.
- Any knob or button's right-click menu offers, alongside MIDI Learn: "send to / remove from" each control surface and "assign to / clear from" a specific Electra slot.
- When both surface types exist, ELECTRA CONTROL's explicit grid drives Electra page 1; otherwise the first CONTROL SURFACE's bindings do.

### Gamepad
- A GAMEPAD module exposes a connected controller as patchable signals: stick axes (±1, up = positive, 0.08 default deadzone), analog triggers (0–1), and all face/bumper/d-pad/menu buttons as gates. Standard layouts work out of the box; a slot selector picks among up to **4 simultaneous controllers**. For privacy the controller stays invisible until the user presses any button on it once.
- **Left-stick calibration**: arm, sweep the stick through its full range (per-axis extremes record live), complete — the swept range rescales to full ±1 with the true centre mapped to 0 and a radial deadzone (no snap-back drift). Makes worn pads and reduced-range sticks reach full output; clearable back to default.
- **Control remap**: every output can be rebound to any physical control with an arm-then-actuate flow: right-click an output and press the physical button (stick wobble can't steal a button bind); explicit "Remap X / Remap Y" capture only the next *axis* moved. Capture thresholds require a deliberate half-range sweep or firm press.
- Calibration and remaps are stored **in the patch**: they survive reload, sync to collaborators, and are undoable.

### monome grid & Launchpad (clip-launcher hardware)
- A **monome grid 128** (16×8, 16-level variable-brightness LEDs) connects natively with no companion app: one click, pick the device, done. The grid binds to one CLIP PLAYER (or KRIA) module per machine.
- Grid layout for CLIP PLAYER: left 8×8 = the clip matrix (launch/queue/stop); right strip = per-lane stop, scene launch (a column fires one clip per lane), copy/paste/paste-reversed held modifiers, stop-all, transport. Hold EDIT + tap a clip to turn the entire grid into that clip's note editor (paged, follow/freeze, double-length, dedicated length page). LEDs repaint live from clip/playing/queued state with a ~2 Hz queued-blink.
- A **Launchpad Mini Mk3 pair** is the two-unit equivalent: unit L is the always-live 8×8 clip matrix; unit R is the command deck, which flips into the note editor (the matrix never disappears while editing). Full per-pad RGB feedback; which physical unit is L vs R is user-assigned.
- One controller-agnostic rule set drives all clip surfaces — the monome, the Launchpad pair, and the on-card UI render and behave identically from the same state.
- Launches, queues, and edits made from hardware are the same synced actions as card clicks — collaborators (and a second grid elsewhere) see them; LED state and device wiring stay local to each user.

### Rules & limits
- Continuous bindings: 0–127 → control range; channels 1–16; one binding per control; one on-screen owner per physical control (newest wins, enforced on learn/import/load).
- MIDI mappings and grid/Launchpad bindings: per-machine, never synced. Gamepad calibration/remap: in the patch, synced, undoable.
- MIDI LANE poly: max 5 voices, steal-oldest. Pitch-bend fixed ±2 semitones. Pitch reference: 0 = middle C.
- Electra: 3 pages × 36 controls max; names clamp to 14 chars; meters ~30 Hz; echo window ~120 ms. ELECTRA CONTROL: exactly 36 slots (6×6), never dynamic.
- Gamepad: up to 4 controllers; 0.08 default deadzone.
- Clip surfaces: 8 lanes × 8 slots (64 clips); grid 16×8; Launchpad pair 2 × 8×8.
- MIDI tempo source: valid 10–300 BPM, stale after 1.5 s.

### Interaction contracts
- **Arm-then-actuate is the universal binding gesture** — MIDI knobs, MIDI notes on gates/buttons, gamepad remap — with the captured value/press applied instantly.
- Hardware moves and on-screen moves are equivalent writes: both drive the engine, both sync to collaborators, both respect the same undo grouping (one gesture = one undo step).
- A proxied control everywhere (surface, Electra grid, hardware pot) is the *same* control — one identity, one binding, no copies, no drift.
- External clock always wins: while externally clocked, internal transport/tempo affordances hide or grey out, on-screen and on hardware alike.
- Device feedback loops are non-oscillating: a device-originated value is not echoed back to it; an app-originated value always reaches the device.
- Re-configuring hardware atomically supersedes the previous configuration — stale routes never coexist with new ones.
- Collaborative boundary: musical/patch state (clips, launches, parameters, gamepad maps) is shared; hardware I/O, LED frames, and personal controller mappings are private.

## 8. Multiplayer & collaboration

### Rackspaces
- A **rackspace** is a named, persistent, multi-user patch workspace with its own unguessable link — the unit of sharing; everything on its canvas is one shared document.
- Signed-in users create rackspaces from a **dashboard** (default name "Untitled rackspace") listing every rackspace they belong to (owned and joined) with a live "N/4 owned" indicator.
- Each user may **own at most 4 rackspaces**; the create button disables at cap with a "delete one first" hint; racing duplicate creates cannot exceed the cap.
- Deleting is owner-only, permanent, confirmation-gated, and removes the shared patch and its membership. Owners cannot "leave" their own rackspace — they delete it instead (the product answers this case explicitly). Non-owner members can leave (confirmation-gated) and rejoin later via the share link.
- Visiting a link to a nonexistent rackspace yields a not-found error.

### Membership, invite links, anonymous join
- Signed-in non-members opening a rackspace link see a join page (rack name, id, "N/4 members") with a Join button; joining makes them a persistent member.
- **Invite links**: owners and members have one-click **"Copy invite link"** — a link granting zero-install, no-account access. Anyone opening it lands directly on the live canvas as an anonymous **guest** with full view *and edit* rights.
- A bare rackspace link without a valid invite requires sign-in (redirected to sign-in, returned to the same rack). Missing and invalid invite codes behave identically — the response never reveals which.
- Invite links are stable and never expire on their own; the only revocation is a global operator-level reset invalidating every outstanding invite at once.
- Guests are badged "guest", get an auto-generated name ("guest 1234") and a stable identity color, and do **not** get the share affordance (they cannot mint invites). They see a "Sign in" button returning them to the same rack signed in, where they can request membership.
- Guests don't consume a membership slot but do consume a live-presence slot.

### Capacity
- **Persistent membership cap: 4 (owner + 3 others).** A joiner past cap sees "this rackspace is full (4 members max)"; racing joins can never overshoot.
- **Concurrent-presence cap: 4 connected at once** (members + guests). A 5th arrival gets a friendly "This rackspace is full — up to 4 people at once; try again in a minute" page with Try Again / Dashboard actions; back navigation doesn't bounce them into a re-rejection loop.
- Slots free on leave. Uncleanly-dead sessions (crash, network drop) free their slot within ~30 seconds — a "stuck full" rack self-heals.

### What is shared in real time
- **The patch itself**: modules, cables, knob/parameter values, and per-module content state — sequencer steps, SCORE pages/ties/dynamics, DRUMSEQZ grids and Euclidean settings, POLYSEQZ chord steps, per-module quicksave slots, uploaded PICTUREBOX images (downscaled and embedded so they render for everyone), SAMSLOOP samples, DX7 user banks, module names. Any participant's change appears on everyone's screen in real time; no refresh ever needed.
- **Card positions are per-user**: your drag never moves anyone else's layout; newcomers see each module at its placer's default position until they move it. (Guests share the default layout.)
- **Not shared**: live camera video never leaves the local machine (rack-mates see a badge identifying who holds an active camera and on which cards); theme/skin preference is per-device; local video file bytes (metadata syncs, others get a placeholder + re-link prompt).
- **CADILLAC** (destruction gag): every participant sees the identical car animation, and the modules it crushes are deleted for everyone — one session authors the deletions, all converge.
- **Shared session clock**: all participants converge on one common timeline (a newcomer stabilizes within ~1 second), so time-driven modules agree across screens; audio/video rendering itself is local per machine.

### Presence
- The rack bar shows a live "N/4 members" count plus one colored dot per present person (hover reveals the name). Count and dots come from one de-duplicated source: a person with two sessions counts once, guests count — the number can never disagree with the dots.
- Identity color is deterministic per person (12-color palette): the same user renders the same color everywhere, across sessions.
- **Live ghost cursors**: each remote pointer appears as a colored cursor updated ~30×/second; your own cursor is never ghosted back. A departed participant's presence disappears within ~30 seconds.
- **Group-building soft lock**: while someone has the group builder open, others see those cards dimmed with a "‹name› is grouping…" badge and their own Group affordance disabled for overlapping selections. Advisory only — a rare simultaneous commit yields both groups intact, never lost work.

### Conflict behavior
- Concurrent edits merge automatically: no locking, no "someone else is editing" errors, no conflict dialogs for ordinary patching. Two people can turn different knobs and patch different cables at the same instant.
- Undo is personal (§2); per-user layouts remove position fights; soft locks cover coarse multi-step flows.

### Ownership & authority
- The **owner** creates/deletes the space and is the only one who can **"Reset session"** (confirmation-gated; snaps every participant's clocks and time-driven modules back to zero — listeners hear a brief realign). The owner is preferred whenever a module needs a single in-rack authority; modules needing one arbiter (e.g. DOOM) elect one participant — owner preferred, deterministic fallback — with automatic re-election when the authority leaves.
- **AI musician bots**: members can spawn **Carl** (chaos player) or **Mike** (meticulous, in-key builder) — signed-in participants only, at most **one bot per rack** (the other spawn button disables with an explanation). *Anyone* can stop ("86") the bot, which also removes its modules. The bar shows who spawned it; it keeps playing as long as at least one participant remains — if the driving session leaves, another takes over within ~30 s.

### Offline / disconnect
- A briefly disconnected participant keeps working; edits merge automatically on reconnect, no prompts.
- A refused connection (rack full, stale credential) routes to the "full" page or back to sign-in (returning to the same rack) — never a silent hang.
- Closing the last session never loses recent edits: final state persists immediately when the last participant leaves; while editing continues, the durable copy trails live state by ≤5 s.

### Privacy
- Rackspaces are private by default: only members and invite-link holders can see them; no public listing or discovery. The unguessable link is the sharing boundary.
- Anonymous visitors with a missing or wrong invite learn nothing about which it was; the join page reveals only name, id, member count.
- Other participants are shown only as display name + color — never account identifiers. Diagnostic logging never records invite codes (length only) or account details.

### Rules & limits
- 4 owned rackspaces per user; 4 persistent members per rackspace; 4 concurrent participants (members + guests); dead sessions free slots within ~30 s.
- 1 bot per rack; spawn = members only; stop = anyone.
- PICTUREBOX: 2 per user, 8 per rackspace (unattributed pre-existing ones count only toward the rack total). SAMSLOOP: 5 per user, 20 per rackspace, 2 MB per sample. CAMERA: up to 4 cards per user; video never shared.
- Presence timeout ≈30 s; cursors ≈30 Hz; newcomer clock convergence ≈1 s; durable save lag ≤5 s (0 on last-leave); undo burst window ≈0.5 s.

### Interaction contracts
- Any participant's patch edit is visible to all others in real time; my card drag never moves your cards; my undo never reverts your edits.
- Presence count always equals the number of dots; multi-session users count once.
- An invite link is sufficient for full edit access with zero installation and zero account; a bare rack link never is without sign-in.
- Guests can edit everything but cannot share invites, spawn bots, own racks, or keep a personal layout.
- Owner-only: delete rackspace, Reset session. Owner-preferred: in-module authority.
- "Full" is always a friendly, retryable state that self-heals when a slot frees; a rejected join leaves the existing session untouched.
- Leaving (or crashing out) never destroys shared work; deleting (owner, confirmed) is the only destructive exit.

## 9. Persistence & content

### Always-on rack persistence
- No manual save, ever. Every edit auto-persists continuously: durable within seconds (~5 s worst case), with a guaranteed final flush when the last participant leaves. Reload, close, return days later — the rack is exactly as left.
- Persisted: module topology and wiring, knob/parameter values, per-user card positions, sequencer content (steps, notes, chords, SCORE pages/ties/dynamics, Euclidean settings), quicksave slots, uploaded images, user voice banks, custom visual-program/object text, samples, custom module names, CV routes, control-surface layouts, and rack-wide settings (e.g. output aspect).
- Deliberately NOT persisted: live camera feeds (presence only), per-session game lobby state (DOOM's live multiplayer flags are stripped on load so a reloaded patch can always start fresh), skin preference (per-device by design), raw video bytes (only a reference travels), and live per-frame modulation (a patch stores topology and authored values, never a moment-in-time live sample).

### Quicksave slots
- Every sequencer-style module (SEQUENCER, DRUMSEQZ, SCORE, POLYSEQZ, MACSEQ, WRITESEQ) has 8 numbered quicksave slots on its transport strip: save a pattern snapshot, recall later. NEXT / PREV / RANDOM walk occupied slots only, switching at pattern end so recall is musically clean. Slots live inside the rack: shared, reload-proof, and included in every export. (Legacy 4-slot saves open in the 8-slot UI with slots 5–8 empty.)

### Performance slot bar and sets
- 5 numbered quick-switch slots in the menu bar; each holds an ENTIRE performance so a performer can jump between whole racks live. The bar is personal and per-device (never shared or synced) and survives reloads; occupancy is visible at a glance. If local storage is full, a slot simply doesn't persist — never a crash.
- **Save Set / Load Set**: a single `.set` file bundles every occupied slot plus the global MIDI Learn map, moving the whole bar to another machine as one file. Loading replaces all slots; missing slots stay empty; foreign or corrupt files are rejected with a readable message.

### Portable performance archive (`.ptperf`)
- One-click export of the WHOLE show as a single portable file that round-trips on any machine with no re-picking of assets: the full patch graph and positions (the saving user's layout baked in so it loads identically for anyone); inline media — PICTUREBOX images, TOYBOX layer images / custom visual programs / custom objects, SAMSLOOP samples; the actual video bytes for VIDEOBOX and all 7 VIDEOVARISPEED slots (restored to exact slots) plus TWOTRACKS reel tape audio (~20 s stereo per reel); MIDI Learn maps (device-agnostic), MIDI device selections (re-bound by exact device first, then device name), and gamepad mappings.
- Export prompts for a filename and location (suggested `performance.ptperf`); cancel is safe; names are sanitized. Export is disabled on an empty rack.
- Import merges MIDI Learn maps rather than clobbering — the archive wins for its own parameters, everything else survives — and repairs duplicates so one physical control drives one parameter.

### Raw patch export/import (`.imp`)
- The patch alone exports as a single lightweight file (structure and settings, no embedded media) and re-imports; loading replaces the current rack atomically. Default name `patch.imp`, user-renamable.
- Tolerant loading: an unknown module type is dropped with a per-item diagnostic; an edge referencing a dropped node or failing validation is dropped individually — one bad entry never blocks the rest or wedges collaborators.

### Presets & built-in banks
- Ships with modules: the DX7 voice list, TOYBOX content banks (generative entries, effects, 3D models incl. 10 built-in primitives, fully-wired bundled presets), a curated MILKDROP preset pack, a 46-entry wavetable bank, and bundled example assets.
- TOYBOX user presets: full module state saved under a name to a local per-device list (newest first); images and custom visual-program/object text included; video bytes are not (re-pick, or use the archive for full portability). A corrupt preset store reads as empty rather than erroring.
- TOYBOX preset export/import: a portable archive of the module's full state PLUS per-layer video bytes (100 MB cap per video), with label and timestamp; corrupt/foreign/oversized files rejected with readable messages.
- Saved-group library: a signed-in user saves a group (children, wiring, exposed ports; label 1–64 chars) to a private account-tied library and inserts fresh copies into any rack.

### User content upload
- **Images (PICTUREBOX)**: recompressed to the standard render resolution (1024×768, 4:3 crop-fit), stored in the rack, visible to all collaborators. Animated images keep all frames up to 1.5 MB / 300 frames; beyond that, still first frame with a card hint.
- **Video (VIDEOBOX / VIDEOVARISPEED / TOYBOX layers)**: up to 100 MB per file/slot; VIDEOVARISPEED has 7 slots. Bytes stay on the loading machine — collaborators see a placeholder and re-link prompt; on the same device, reopening restores the video with a single permission click.
- **Samples (SAMSLOOP)**: up to 2 MB per file, stored inline in the rack (shared, exported); in-module recordings bounded the same way.
- **Custom visual-program / 3D-object text (TOYBOX)**: up to 2 MB each, stored in the rack — reload-proof, synced, exported.
- **DX7 cartridge files**: 32 voices per bank parsed into the preset menu and stored in the rack; a status line reports voices loaded or parse warnings.

### Recordings & crash recovery
- RECORDERBOX streams in-flight recordings to local scratch storage; after a crash the same device offers "recover unsaved recording?" — partial recordings remain playable. Recovery is strictly local.

### Game assets
- DOOM ships the freely redistributable shareware episode built in — zero setup — cached locally after first load. BLOOD ships the 1997 shareware data built in; full-game data is user-supplied, local, never redistributed. Policy: redistributable data ships bundled; everything else is user-supplied, kept local, never synced.

### Format compatibility (old saves keep loading)
- Nimble write, tolerant read: every save stamps its format version; every loader accepts the current version AND all older ones, rejecting only future versions with a clear message.
- Concrete guarantees: patches saved in the earliest format version load intact; patches predating newer settings get sensible defaults (aspect defaults to 4:3); 4-slot quicksave saves open in the 8-slot UI; single-video performance archives load into slot 0 of the multi-slot player.
- Corruption never half-loads: performance and set containers validate strictly and fail loudly with a human-readable reason.

### Rules & limits
- Quicksave: 8 slots per sequencer-style module, in the rack. Performance bar: exactly 5 slots, per-device only.
- Per-video/per-slot cap 100 MB (upload cap == round-trip cap: anything a module accepted always survives export/import); no cap on total archive size. Samples 2 MB; visual-program/object text 2 MB each; animated images 1.5 MB / 300 frames.
- A fully loaded rack (~50 modules, 8 image modules, 32 user voice banks, 4 users' layouts) ≈1.5 MB — an order of magnitude under the ~25 MB per-rack durable-snapshot ceiling.
- Local storage exhaustion is always non-fatal: the affected item silently doesn't persist.
- Storage tiers — account-tied: rackspaces + snapshots, membership/roles, saved-group library. Local per-device: performance bar, TOYBOX user presets, MIDI Learn maps (exportable), skin, video file references, crash-recovery scratch, cached game data. Portable files: `.ptperf` archive, `.set`, `.imp`, TOYBOX preset archive.

### Interaction contracts
- Editing requires no save action; durability lags an edit by at most ~5 seconds; last-leave flushes immediately.
- Loading a patch/performance replaces the current rack atomically — collaborators see one clean swap, never a half-state — and always yields a startable rack.
- Every import failure mode is user-legible: corrupt/foreign/oversized → readable error; unknown module or invalid edge → per-item drop diagnostic; missing media → re-link prompt fallback.
- Export prompts for name and destination; cancel never errors; names sanitized.
- Media locality: images/samples/shaders/objects are shared rack content; video is local-only with placeholder + re-link for others; same-device reopen restores with one confirmation click.
- MIDI Learn restore is additive and self-repairing; format versions only ever reject the future, never the past.

## 10. Product surface

### Access model
- Zero-install: the full instrument is reachable by opening a link; nothing to download or set up.
- The public landing page offers two entries: **new rack** — an instant, anonymous scratch rack requiring no account — and **my rackspaces** — the signed-in user's saved and shared racks. Header links to docs, the module catalog, and sign-in. The topbar reflects auth state: avatar/initials linking to the dashboard when signed in, otherwise "Sign in".
- Pre-launch environments sit behind a **beta gate**: one shared credential challenge covering the whole app, with deliberate public carve-outs — the landing page, the health probe, and the entire docs site (so prospective users read docs without a credential). Nothing else is public.

### Docs system
- A public docs site: a **module catalog** page of auto-generated cards for every module, grouped by category (sources, modulation, filters, effects, utilities, output), plus hand-written illustrated **guides** for hardware and complex modules (clip-launcher hardware, DOOM multiplayer, live-coding, video mapping, etc.).
- **Per-module doc pages** in three layers:
  - **Faceplate view** — for promoted modules, a live interactive virtual module: hovering any control or jack updates an explanation pane beside it. Fallback: a numbered screenshot of the real card face plus a KEY table (# → control → what it does) where every number resolves to an authored description — never a raw internal identifier. Final fallback: an abstract pin diagram with input/output/param counts.
  - **Generated I/O reference** — inputs/outputs tables (jack id, cable type, plain-language sentence) and a params table (id, label, range, default, response curve), derived from the module's definition — a single source of truth that cannot drift from the module.
  - **Authored prose** — an explanation paragraph plus per-input/per-output/per-control descriptions layered on the generated sentences.
- Doc pages are fully readable even with all interactive features unavailable: prose, numbered face, and reference tables are always present as static content.
- **Freshness is a product guarantee, enforced by a drift gate**: docs are pinned to each module's I/O contract. Any change to ports, params, controls, or flags blocks a release until a human re-accepts the docs — a doc can describe the product wrongly only by deliberate override, never by silent rot. A strict set of modules additionally enforces completeness: every port, param, and control family documented.
- Known boundary: per-module pages currently cover the audio catalog; video modules are documented through the same pipeline but their pages are a pending follow-up.

### Topbar & session workflows
- **Load example…** menu (§3). **Preset slot bar**: five numbered slots — empty reads red, occupied green; left-click an occupied slot switches instantly; right-click any slot for Load / Replace / Clear. **Save Set / Load Set**, **Export Perf / Load Perf**, **graph-only export/import** (§9). **Clear** (disabled when empty). **Aspect toggle** (4:3 ↔ 16:9, live, patch-persisted, synced). **Skin switcher** for visual themes.
- **Footer status strip**: live node and edge counts, catalog size, audio engine state, sample rate, live latency readout (processing + output-path), and the Buffer selector (§4).
- Module palette via right-click on empty canvas; cable-color legend (audio, pitch, gate, CV, poly, keys, image, mono-video, video); minimap toggle; expandable activity trace panel.
- **Present on a second display**: an output shows full-screen chrome-less on a second screen while the main window stays interactive.

### Mobile prototype (dedicated mobile entry point)
- A chooser page offers two touch experiences over the same instrument (same modules, same patches — no separate engine): **GLITCH CAM** and **POCKET MODULAR**.
- **Glitch cam**: one tap opens the camera (front/back flip), full-screen live processed image, auto-hiding overlay; a glitch strip of six sliders (solarize, tear, hue, trails, noise, master) plus mirror X/Y chips; a large REC button records the output and saves via the device's share/save flow (gracefully disabled with a caption on devices that can't encode); the screen stays awake while live; permission-denied gets an explainer with retry.
- **Pocket modular**: transport header (tempo, run toggle, undo) and three tabs — RACK / PATCH / MIX. First run offers **FIRST BLEEP** (one tap spawns and wires a complete sounding starter patch) or an empty rack pre-wired master→output — nothing on mobile is silent-by-default. RACK: module chip strip plus a one-module-at-a-time pager, curated add sheet (~13 module types grouped Sound/Shape/Sequence/Mix/Video) with per-type caps surfaced (camera 4, transport 1), and removal with a cables-will-be-disconnected warning. PATCH: a FROM→TO touch matrix with large cells — legal empty cells patch immediately with a haptic tick (the sound is the confirmation); occupied inputs prompt Replace/Cancel; fan-out from an output needs no confirmation; unpatch is immediate with a 4-second undo pill; a whole-scene ALL-CABLES list; stereo pairs presented as combined L+R rows. MIX: full-width channel lanes (fader, meter, mute), a pinned master lane, per-channel detail (EQ, one-knob compressor with advanced expansion, sends).
- Sessions auto-save on backgrounding with a "restore last session" offer; destructive taps get an undo pill; all touch targets ≥44 px; long-press resets a control.

### Version, health & alerting
- The topbar shows the running app version next to the product name; the health probe reports the deployed version — what's running is always identifiable from UI and machine probes alike.
- A **public health probe** is reachable in every environment without credentials, reporting overall status (**healthy/degraded** — degraded when real-time collaboration is unreachable, checked within a hard 1.5-second budget), the deployed version, presence-only configuration signals (never secret values), and a one-way configuration fingerprint that lets deploy-time checks detect drift before it silently breaks anonymous invites. The probe always answers successfully; operational state is carried in the reported content so monitors match on content.
- **Alerting is a product-reliability commitment**: each environment has independent external monitoring — availability probes, a content monitor alerting on degraded, and a scheduled heartbeat alarming when periodic jobs stop — delivered to operators. Post-deploy smoke checks assert real sign-in per account tier and that the access gate actually challenges — a deploy that silently opens a protected environment fails the check.

### Rules & limits
- Preset bar: exactly 5 slots. Output aspect: exactly two height-anchored choices — 4:3 = 1024×768 (default), 16:9 = 1366×768.
- Module catalog: ~180 module types; the footer displays the live count.
- Beta-gate carve-outs: landing page, health probe, docs site — nothing else.
- Health check budget: 1.5 s. Mobile touch targets ≥44 px; mobile undo pill 4 s.

### Interaction contracts
- Occupied preset slot: left-click = instant switch; right-click = Load/Replace/Clear; empty slot right-click = load into slot. Load Set repopulates present slots (green), clears absent ones (red), and restores the MIDI map.
- A loaded performance bundle reproduces the show with zero re-selection of media or mappings.
- Example and graph-export menus fire, then reset to placeholder so the same action can be re-picked.
- Aspect flip is live (no teardown), persists in the patch, and is seen by all collaborators. Buffer change → persistent "reload to apply" indicator until reload.
- A guest's own visible rack address never exposes a redistributable personal code beyond the invite they received.
- Doc faceplate hover updates the explanation pane for exactly that control/jack; numbered-face key rows always resolve # → human control name → authored description.

## 11. Non-functional requirements

### Real-time audio continuity
- Sound remains continuous — no clicks, dropouts, or tempo wobble — while the user turns many controls at once, twists hardware knobs, drags modules, or runs heavy video patches alongside audio.
- Rapid controller streams are absorbed without starving audio or visuals: a burst of twists updates parameters smoothly (immediate transient response, then a settled value) rather than queueing a backlog.
- The musical clock is decoupled from interface activity: dragging, editing, and window interaction never slow or jitter the sequencer; one clock pulse advances exactly one step, never two.
- External-controller note timing is scheduled against the event's own timestamp, not arrival time, so note spacing stays even under load.
- The user chooses their latency/stability trade-off from the four named buffer modes (§4), with plain-language guidance; heavy patches buy stability at the cost of response time.

### Video smoothness
- Visual output targets ~60 fps steady state; per-frame timing is measured and exposed to visual modules so they can adapt.
- Unwatched, unpatched outputs cost nothing; rendering all of a module's outputs unconditionally is treated as a defect.
- Audio and visual pipelines fail independently: an overloaded video patch raises latency — it never silences audio — and heavy visual generators may not degrade interface responsiveness.

### Multi-user reliability
- A shared patch updates for all participants in real time; the 4-participant cap is enforced cleanly (a 5th connection is refused without degrading the session).
- Session-hosting health is continuously monitored with automatic alerting on outage or resource blow-out; collaborative state loss is an incident, not an acceptable event.
- Multi-user correctness (host moves, hot-join, shared game/patch state — including DOOM co-play) is a permanently guarded regression surface: no change ships with that guard failing.

### Device & capability adaptation
- Zero installation, no native companion app, ever; every feature works — or degrades gracefully — within that constraint.
- Capability-dependent features probe first and degrade rather than fail: recording checks for an available encoder and downgrades or disables when absent; camera modules are optional; visuals render acceptably on software-only graphics renderers, not just real GPUs.
- External hardware is always optional; known platform ceilings (e.g. 2-channel capture from the ES-9) are surfaced honestly rather than worked around with an install.
- When an optional capability is missing, the dependent feature announces or degrades — it never crashes the patch or silently pretends to work.

### Determinism & pinning
- A module's **sound** is pinned: for identical source revisions, rendered audio is byte-identical to a committed golden; any audible change is a deliberate, reviewed re-pin.
- A module's **appearance** is pinned: every card has committed reference images across themes and platforms; any pixel change is examined and classified as intended or a bug — never rubber-stamped.
- A module's **I/O contract** is pinned: changing any port, parameter, control, or range trips a gate forcing a human to re-author the docs or recognize a bug. Documentation changes must not, by themselves, invalidate audio/visual pins.
- Goldens, baselines, and contract locks are generated artifacts: regenerated by tooling, reviewed as diffs, never hand-edited.

### Data durability
- Workspace state (patch graph, settings, sequences, save slots) persists and survives reload; quicksave/restore works regardless of prior save history.
- Live per-frame modulation is transient render state, never written into the persisted document — protecting durability and performance.
- Collaborative edits are never lost on concurrent access.

### Cost of change & quality culture
- A new module ships, in one change, with: real explanatory documentation (behavior, controls, I/O, CV usage — not a one-liner), a catalog description, per-port behavioral coverage, an audio and/or visual pin, and enrollment in the strict-documentation set; the module catalog auto-enrolls it in all sweep checks.
- Any module touched incidentally is brought up to the current documentation bar (the bar only ratchets upward).
- Poly/MIDI modules must prove the *real* end-to-end chain (default note source → module → audible output), not just internal behavior — "green but silent" is a designed-against failure class.
- New or changed automated checks must demonstrate stability (multiple consecutive clean runs) before landing; a flaky check is root-caused and fixed or deleted — never suppressed, retried into passing, or permanently exempted. Every disabled check is backlog trending to zero.
- Nothing ships on a failing check; a mainline failure is a drop-everything event; verification runs on the exact final revision being shipped.
- Changes adding more than ~2 minutes to the end-to-end verification pipeline require explicit approval (~25 minutes under load today is the managed budget).
- Changes to render resolution, aspect ratio, or overall look ship only after explicit owner preview review.
- Module labels are lowercase by rule (display styling uppercases them); a guard enforces this.

### Rules & limits
- Latency modes: exactly 4 (Low / Tight / Balanced / Stable); default Tight ≈12 ms; Stable ≈45 ms; strictly monotonic ordering.
- Session capacity: 4 participants per shared workspace, hard-enforced.
- Catalog scale: ~170 audio modules plus the video-module family, every one enrolled in the sweep gates.
- Frame-rate target ~60 fps steady state; unpatched outputs render at zero cost.
- Verification budget: >~2 min pipeline additions need sign-off; new checks prove stability across consecutive clean runs.

### Interaction contracts
- Turning any number of on-screen or hardware controls during playback never audibly interrupts sound.
- A trigger fires exactly once per rising edge; a gate responds to level for its whole duration; the interpretation is declared per input, cross-patching is always legal, and GATEMAIDEN bridges the idioms.
- Changing the latency mode takes effect on reload and is remembered.
- A rejected join leaves the existing session untouched.
- Documentation shown for a module always matches its live I/O contract; the product refuses to let the two drift apart silently.