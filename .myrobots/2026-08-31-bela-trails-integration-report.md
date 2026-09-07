# Bela Trails integration report — 2026-08-31

Research report (no code changed, no issues/PRs). How patchtogether.live can
integrate the Bela **Trails** eurorack module as a source of video and audio
modulation, including the owner's three asks: (a) a Trails source module,
(b) a 1:1 touchpad→screen mapping, (c) a frametable variant where touch
location steers WHERE the temporal distortion happens.

Provenance note: hardware facts are from the official Trails manual + product
page (fetched 2026-08-31, sources at bottom). Repo facts marked **[mem]** come
from memory files and should be re-verified against `origin/main` before
building (read-the-card rule); facts marked **[tree]** were verified in the
current tree by a codebase agent on 2026-08-31. **§7 is that agent's
tree-verified addendum (read at `origin/main` @ `b9f87522a`): it CONFIRMS the
[mem]-flagged frametable claims and adds the concrete seams — treat §7 as
superseding any [mem] hedge above.**

---

## 1. Hardware summary — what Trails actually is

Released August 2026 (~$449; batch 2 lands October 2026). The "quad Gliss":
a polyphonic **touch-gesture recorder**, 22HP + a separate output breakout
(4HP 3U or 22HP 1U, 24-pin ribbon).

- **Touch surface:** 85×85 mm multitouch capacitive pad with shine-through
  LEDs, plus a 10×85 mm capacitive side slider (Bar). No pressure sensing
  documented — position + contact only.
- **Channels:** 4 independent channels; each records gestures up to ~40 s,
  loops them, and emits **X, Y (CV) + Gate** continuously. 16 scenes.
  Live touch produces X/Y/gate output in real time; on finger-lift the
  recorded gesture plays back and the outputs keep streaming.
- **CV I/O:** 8 CV outs (X/Y per channel, each configurable anywhere in
  −5 V…+10 V), 4 gate outs (0–10 V), 4 CV ins (reset/modulation per
  channel), 1 clock in. Quantizer (scales), step mode, Euclidean density,
  portamento/smooth/volume/gate-PW via the Bar.
- **MIDI:** the load-bearing fact for us —
  - **USB-C on the back is class-compliant USB-MIDI.** Bela's own firmware
    updater (`bela.io/upgrade-trails`) is a **browser WebMIDI tool requiring
    Chrome** — i.e. the vendor themselves drive this device from Chrome
    WebMIDI. Our app can too, directly.
  - **Each of the 8 axes transmits on its own MIDI channel (1–8)** as
    **14-bit CC** — manual states "CC15 (MSB) + CC37 (LSB)". ⚠ That pairing
    is nonstandard (CC15's spec LSB partner is CC47; CC37 pairs with CC5) —
    **verify the exact pair with a browser MIDI monitor on real hardware**
    (owner already has this method from the Push 2 work).
  - Sends **Note On/Off instead of CC** when pitch + temporal quantisation
    are both enabled.
  - **Transmits MIDI clock over USB.** No MIDI *input* is documented
    (clock/reset come in as CV jacks).
  - TRS MIDI exists but steals jacks via rear jumpers (out 4.G → TRS out,
    in 4 → TRS in) and DIN bandwidth (31.25 kbaud) would saturate under
    8 streaming 14-bit axes. USB is strictly better for us.
- **Firmware:** browser-updatable; Gliss's firmware is open (GPL,
  `BelaPlatform/gliss-firmware`) but **no public Trails firmware repo exists
  yet** — so the MIDI map can't be confirmed from source today.

## 2. Prior art in our memories

- **[[frametable-and-videocube]] [mem]** — frametable is our video wavetable
  oscillator: 60-frame GPU ring (`TEXTURE_2D_ARRAY`, RGBA8, half render
  scale), per-pixel selection from history. Shipped with **three modes**;
  the default **Smooth** mode already computes a **2D temporal-displacement
  field across the screen** (2 morphable waveforms → per-pixel displacement
  → weighted temporal average, capped taps, inter-layer lerp). This is the
  exact seam ask (c) needs — a touch locus is just another term in a field
  the shader already evaluates.
- **[[device-module-midi-seam-findings]] [mem]** — the Electra stack is the
  device-module template (port-name resolution, allocation table,
  autoconfig); `requestMidiAccess` hardcodes `sysex:false` (fine — Trails
  needs no sysex from us); **meta-domain modules get no engine handle**, so
  a CV-emitting Trails module should be audio-domain; high-rate control
  streams MUST ride `createCcCommit` + `getCcBatcher()`.
- **[[midi-cc-write-storm-fix]] + [[cv-modulation-live-store-write-storm]]
  [mem]** — the two incidents that define the data-flow law: per-message /
  per-frame writes to the Y.Doc murder rendering. CC streams get a
  transient engine-handle leg + coalesced durable commit; live modulation
  mutates a render-local clone, **never** the synced store.
- **[[es9-browser-audio-ceiling]] / [[es9-https-localhost-ws-block]] [mem]**
  — Chrome caps ES-9 capture at 2 ch; DC/CV passes only in music mode
  (EC/NS/AGC off); the native bridge (`ws://127.0.0.1:9209`) is reachable
  from local origins only (bridge origin allowlist; wss would be a
  native-app change). Bounds ingestion options 2–3 below.
- **[[cv-buddy-and-midi-cv-lanes]] [mem]** — CV Buddy already sends rack
  RUN (ES-9 out 7) + CLOCK (out 8) to external gear: patch out 8 → Trails'
  clock-in and gesture loops sync to our transport with zero new code.
  Also the `isNoteSource` trap: a modulation-source module must emit
  cv/gate types only, never a pitch-typed or poly output.
- **[[push2-integration-research]] [mem]** — precedent for: binding a
  specific named WebMIDI port, sim-device install seams for CI
  (`__push2TestInstall` style), browser-console MIDI monitor as the
  hardware ground-truth method, and "green-in-sim ≠ works-on-hardware".
- **[[project_audio_to_cv_modules]] [mem]** — synesthesia/peaks worklet
  pattern is the house template for a module whose job is emitting CV/gate;
  featurecv set the BI/UNI (−1..+1 vs 0..1) toggle precedent.
- **generic-face endgame [mem]** — a **joystick (2D XY) capability is a
  verified face-parity blocker**; the Trails pad view is the same 2D-surface
  face primitive. Building it once, well, may pay twice.
- No memory or `.myrobots` note mentions Bela/Trill/Trails before today —
  this is the first spec pass. The July frametable spec packages were
  consumed out of `.myrobots/plans/` after shipping; the tree is the
  authority on frametable's current shape.

## 3. Ingestion options, ranked

**1. WebMIDI over USB-C — RECOMMENDED.**
Trails ships its whole live + playback state as 14-bit CC / notes / clock on
a class-compliant USB-MIDI device that Bela themselves address from Chrome
WebMIDI. So: plug the USB-C into the computer, `requestMidiAccess`, match
the Trails port by name, decode. Latency ~1–5 ms; works on **HTTPS dev and
prod** (WebMIDI needs only a secure context — no localhost-WS problem); zero
helper apps (house rule satisfied — this is not a native companion);
resolution 14-bit = 16 384 steps across 85 mm (sub-pixel on any screen
mapping); all 4 channels concurrently. Fits the existing device-module MIDI
seam. Costs: a 14-bit MSB/LSB assembly state machine per MIDI channel
(robust to MSB-only and out-of-order arrivals), and the exact CC pair +
stream rate need one hardware-verify session.

**2. ES-9 native bridge (helper WS) — only if audio-rate CV fidelity matters.**
Patch Trails' 8 X/Y + 4 gate CV outs into ES-9 inputs; the existing helper
exposes all 16 ch DC-coupled at audio rate. True audio-rate modulation
(WebMIDI is control-rate). Costs: helper must run; **local origin only**
(HTTPS pages can't reach the bridge; making it wss is a separate native-app
project); consumes ES-9 inputs (which CV Buddy wants for hardware audio
returns); needs volts→unit calibration; 12 patch cables of setup burden.

**3. ES-9 browser capture (2 ch, music mode) — niche fallback.**
One X/Y pair max (Chrome's hard 2-ch ceiling), music mode required to pass
DC, uncalibrated, and it occupies the browser stereo-in. Not suitable for
the touchpad→screen use; don't build for it.

**4. TRS MIDI through a USB MIDI interface — don't.**
Same data as option 1, minus bandwidth, minus jack 4.G/in-4 (jumpered away),
plus an interface. Only relevant if the USB-C port were unavailable.

No Web Serial / WebUSB path exists or is needed: Trails' USB interface is
MIDI-class (WebMIDI owns it), and raw Trill sensors are I2C (not
host-reachable). Nothing in the tree listens to network/OSC for this. **[mem]**

## 4. Design sketches

### a. `trails` source module (the ingestion module)

- **Domain:** audio (needs an engine handle to own CV output ports; meta
  gets none **[mem]**). Emission via the synesthesia/peaks-style pattern or
  main-thread → constant-source writes — let the builder pick against the
  current tree; the contract is below.
- **Outputs (all cv/gate typed — `isNoteSource` must stay false):**
  `x1,y1 … x4,y4` (cv, BI/UNI toggle à la featurecv, default 0..1 for
  screen-space semantics), `g1…g4` (gate, from Note On/Off or CC-activity —
  hardware-verify which the device emits outside note mode), `clock` (gate,
  from MIDI clock, with a PPQN-style divider param).
- **Input side:** none in v1 (Trails documents no MIDI in; its clock/reset
  are CV jacks — rack sync goes hardware-side via CV Buddy out 8 → Trails
  clock-in).
- **Binding:** match `/trails/i` on WebMIDI port names; connection status on
  the face; sim seam (`__trailsTestInstall`-style) for CI, Push 2 precedent.
- **Decode path:** per-MIDI-channel 14-bit assembler → normalized x/y →
  **transient engine writes through `createCcCommit`/`getCcBatcher()`**;
  durable Y.Doc writes only for real user edits of module params. Smoothing
  param (one-pole) for CV consumers; raw for the screen view.
- **Checklist to ship [tree]:** `scripts/new-module.ts` scaffolder; six
  touch points (def, card/face, shape test, `DESCRIPTIONS` or co-located
  `docs.explanation`, `EXEMPT_FROM_VRT` or baseline, `EXPECTED_NODE_TYPES`);
  **a `FACE_MIGRATION_INVENTORY` disposition is deny-by-default RED** —
  a new def cannot merge without one; auto-enrols in `per-module.spec.ts` +
  the per-port sweeps; and per AGENTS.md rule 8, a **MIDI module ships an
  e2e wiring the real default-mode source (sim Trails) through the module to
  an audible-output assertion** — sim touch → `x1` → VCO/VCA → SCOPE
  RMS via the scope-poll helpers, `REPEAT=3` flake-checked.

### b. 1:1 touchpad → screen mapping

- The trails module's face carries a **square pad view mirroring the 85×85
  surface 1:1**: up to 4 colored touch points (one per channel) with fading
  trails, echoing the hardware's shine-through LEDs. Rendered from the
  transient decode state at frame rate — **zero Y.Doc writes**; remote
  collaborators don't see live touches in v1 (an awareness-channel mirror —
  not Y.Doc — is the later option if wanted).
- Face conventions **[mem/tree]**: SCREEN ON/OFF toggle (owner ruling — and
  the producer keeps running while OFF), compact density, PatchPanel ports,
  tabbed face if control count demands it, `videoFaceWhy` if it registers as
  a faced video module.
- This pad view is the same 2D-surface primitive as the **joystick face
  capability** already blocking generic-face parity — worth building as a
  shared face cell so both consume it (report-don't-gate: owner decides).
- "Maps onto one of our module screens": v1 = the trails module's own
  screen. The stronger version — the touch cursor appearing over ANOTHER
  module's output — falls out of (c) for free: frametable can draw its own
  locus marker from its locus inputs, so the mapping rides the CV cable, no
  cross-module overlay machinery needed.

### c. frametable spatial-distortion variant

- **Feasibility: good, and cheaper than it sounds.** Frametable's Smooth
  mode already evaluates a per-pixel 2D temporal-displacement field
  **[mem — verify against origin/main]**. The variant adds a **locus term**:
  pixels near (locus_x, locus_y) are displaced deeper into the 60-frame
  ring (or get locally raised Chaos amount), with radial falloff. Shader
  cost ≈ one radial term per fragment (×N for N loci) — no new buffers, no
  new ring.
- **Recommended shape: generic CV inputs on frametable, not a Trails-fused
  module.** Add `locus_x`, `locus_y`, `locus_amt` (+ `locus_radius` param)
  cv inputs. Any source drives them — Trails, LFOs, a future joystick face.
  v1 = one locus, amount gated by `g1`; the 4-loci version (4 x/y pairs
  matching Trails' 4 channels — four simultaneous distortion sites, and
  gesture playback re-performs them hands-free) is an owner call.
- **Strictly additive when unpatched:** no locus input connected ⇒ field
  identical to today ⇒ existing VRT baselines and the look are untouched.
  Design the shader so the unpatched path is bit-identical (locus_amt=0
  short-circuit), then prove it in the VRT scene set.
- **Costs, priced honestly [tree/mem]:**
  - frametable is video-domain ⇒ **any edit churns the WebGL attest basis ⇒
    one-time real-GPU re-attest**, owner visual preview, no auto-merge
    (look-affecting).
  - adding cv ports to an existing module ⇒ **full web unit suite**
    (cv-scale-registry: declare `paramTarget`+`cvScale` or the
    `PASSTHROUGH_BY_DESIGN` allowlist; frozen-contract port-list test
    updates) + contract re-pin via `task docs:accept` (`contract-lock.txt`),
    and every gate-cable port declares `edge`.
  - VRT: **always `GREP=frametable`** scoped; zero-tolerance face baselines
    authored by Linux CI only; ⚠ frametable is on the "black dock preview /
    unfalsifiable" watchlist — the locus VRT scene MUST patch a video
    source in, or the scene structurally cannot see the feature.
  - determinism: **simPin, not a freeze param** — pins install via
    `addInitScript` before `goto` (factories read them at construction) and
    are verified to have reached the page **[tree]**. Drive locus inputs to
    pinned values in scenes; sample at co-prime offsets when probing motion.

## 5. Data-flow law (applies to all three)

Touch/CC/locus values are **transient render state**: engine-handle writes +
render-local clones + per-frame uniforms. The Y.Doc receives only durable
user edits (params, connections, screen-toggle state on the node). This is
the [[cv-modulation-live-store-write-storm]] / [[midi-cc-write-storm-fix]]
law and it is the difference between this feature working and it melting the
render loop at 250 msg/s.

## 6. Open questions for the owner

1. **Hardware:** do you have a Trails (shipping now; batch 2 Oct)? First
   session should hardware-verify: the exact 14-bit CC pair (manual says
   CC15+CC37, which is nonstandard — CC15's spec partner is CC47), the live
   stream rate, whether gates emit MIDI outside note-quantised mode, and
   playback-vs-live streaming behavior.
2. **Coupling:** standalone `trails` source module + generic locus CV inputs
   on frametable (recommended — composable, smaller attest surface per PR),
   or a fused bespoke trails-frametable module?
3. **Loci count:** 1 locus v1, or all 4 channels as 4 simultaneous
   distortion sites from day one?
4. **Mode host:** locus on Smooth mode only (recommended), also a local
   Chaos-amount locus, or both?
5. **Screen surface:** own pad-mirror screen on the trails module (v1) +
   frametable drawing its own locus marker — sufficient? Or do you want a
   generic touch-overlay capability on arbitrary video-module screens?
6. **Clock direction:** Trails MIDI clock → our transport, our clock →
   Trails via CV Buddy/ES-9 out 8 (zero new code, hardware patch), both, or
   neither in v1?
7. **Multiplayer:** local-only live touches v1, or mirror them to
   collaborators via the awareness channel (never Y.Doc)?
8. **Notes later:** Trails' pitch-quantised Note On/Off mode as a note
   source on a lane is a natural phase 2 — in or out of scope for now?
9. **Shared 2D primitive:** fold the pad view and the joystick face
   capability into one shared face cell? (Reported, not gated — your call.)

## 7. Tree-verified addendum (codebase deep-dive, origin/main @ b9f87522a)

Everything below was read off the current tree on 2026-08-31, resolving the
[mem] hedges above. ⚠ Ignore `.claude/worktrees/*` copies when re-finding
these files — they are stale branch checkouts.

### 7.1 Frametable Smooth field — CONFIRMED, and the seam is explicit

- `SELECT_FRAG`'s SMOOTH branch (`packages/web/src/lib/video/modules/frametable.ts:313-328`)
  computes `field` — **a per-pixel scalar temporal displacement in FRAMES,
  from `uv`** — and adds it to the global read centre before the capped
  weighted temporal average. The CPU mirror generalizes it:
  `smoothSample(..., field = 0, ...)` at
  `packages/web/src/lib/video/frametable-core.ts:531-551`; `smoothField()`
  (`:482-498`) is merely one PRODUCER of that scalar. **The locus variant is a
  new producer of an existing seam — no new storage, taps, or cost curve.**
- Per-mode: SMOOTH takes a locus trivially; **MORPH cannot** (CPU-precomputed
  uniform Hann kernel, spatially uniform by construction); **CHAOS can take a
  spatial centre/spread cheaply** (its per-pixel threshold is already spatial).
- Ring: 60-layer `TEXTURE_2D_ARRAY` at half res, fractional-layer addressable
  via `sampleRingLerp` (`frametable.ts:261-268`). SMOOTH taps are
  renderer-gated (4 SwiftShader / 8 GPU) — **never add a per-TAP texture
  fetch; a per-FRAGMENT one is fine.**
- Three implementation routes, ranked:
  - **(a) analytic radial kernel** — uniforms `uTouch`/`uTouchDepth`/
    `uTouchRadius`(/`uTouchShape`); ~8 shader lines, zero extra fetches;
    aspect-correct with a resolution uniform (the `vfpga` `warp` cell
    precedent, `video/vfpga/cells/warp.ts:14-15`).
  - **(b) displacement TEXTURE** so touches leave decaying trails — one extra
    fetch per fragment; card-owned canvas pushed into the DOM-free factory,
    the PAINTER pattern (`video/modules/painter.ts:12-38`,
    `setPaintCanvas(canvas)` via `engine.read(id,'extras')`); frametable
    already has half the plumbing (`attachExternalSource`, `atlasScratch`).
  - **(c) zero-contract fallback** — the per-node pointer seam
    `VideoEngine.setMouse(nodeId,x,y,z,w)` / `VideoFrameContext.getMouse`
    (`video/engine.ts:1028-1032`, `:120-132`; engine pixel space, y
    bottom-up, Shadertoy z/w press semantics; sole producer today is
    ToyboxCard, sole consumer toybox). Main-locus only (the worker engine
    stubs it to zeros) — fine: frametable is main-locus (`renderLocus`
    defaults `'main'`).
  - Recommendation stands: **(a) or (b) for the picture, ingested as CV ports**
    so the locus is patchable/recordable/MIDI-learnable; (c) only if zero
    contract movement is the priority.
- **CPU-mirror parity is a stated invariant**: every math path in the shader
  has a 1:1 pure mirror in `frametable-core.ts` (for the save latch the
  mirror IS the implementation). A new field producer must ship a
  `touchField()` mirror + unit test.
- `resize()` (`frametable.ts:1225-1237`) destroys/recreates the ring and
  output and resets state; `dispose()` frees everything. Any new GL resource
  (e.g. the route-b displacement texture) must be added to BOTH.

### 7.2 CV plumbing — the exact hint the touchpad needs exists

- `cvScale: { mode:'linear', center:'default' }` (`graph/types.ts:260-275`)
  is the ABSOLUTE-POSITION hint: cv=0 maps to `defaultValue`, ignoring stored
  state, so "patched ⇒ matches input" holds and a stale saved pad drag never
  becomes a permanent offset. In-tree precedent: `quadralogical` `pos_x`/
  `pos_y` (`video/modules/quadralogical.ts:749-756`). Honoured by both
  scaling paths; deliberately NOT centre-refreshed per tick (that refresh is
  only for ordinary bias-knob hints, #2236). **Use it on `locus_x`/`locus_y`
  and on any consumer of the trails x/y.**
- Rule of thumb enforced by `video/cv-scale-registry.test.ts`: cvScale
  present ⇒ scaled continuous target; absent ⇒ raw gate semantics into a
  synthetic `noUserControl` landing param. Fails only in the FULL `unit`
  lane — run it.
- Cross-domain flow: analyser tap per edge (`fftSize` 32 for cv/gate),
  sampled once per video frame in `tickCvBridges()`; **a frame-rate sampler
  cannot carry a pulse train** — gate/trigger consumers get the audio-thread
  edge-replay path (`installGateDispatch`), and frametable's own `save_trig`
  edge-detects inside `setParam` for exactly this reason. If the locus gets a
  gate input, follow that pattern.
- The no-Y.Doc law is gated: `graph/no-persisted-transient-state-gate.test.ts`
  drives the REAL bridge path 180 frames against a real Y.Doc and asserts
  zero updates; quadralogical's pad axes are already CASES rows.

### 7.3 Trails source module — device-layer facts

- **Bela/Trill prior art in tree: NONE** (strict grep; every "trails" hit is
  the visual noun). Pressure axis: no precedent anywhere — moot for Trails
  (no pressure sensing), but a Bar-slider output would set convention.
- MIDI handler slots are single-slot properties; **the ONE place that may
  assign `MIDIInput.onmidimessage` is `midi/input-attach.ts` —
  `createMidiInputClaim(owner)`**. Use it; never clear a slot you didn't set.
- The MIDI→CV template is `audio/modules/midi-cv-buddy.ts`: one
  `ConstantSourceNode` per output, `setValueAtTime` at
  `ctx.currentTime + (ev.timeStamp - performance.now())/1000 + 2ms lookahead`;
  permission requested by the card's gesture-gated `connect()`, never the
  factory; honest ~5–10 ms end-to-end budget.
- Five conventions every device layer in tree follows (monome / launchpad /
  push2 / electra / ptz / chromaconsole): a `*Available()` probe; a lazy
  gesture-gated `connect()` that returns false and never throws; a `*Rune()`
  status counter; the claim/Transport seam; an `installSimulated*()` double
  so unit + e2e drive the real code path. Ship all five.
- Domain `audio` confirmed (meta defs have no factory/handle; video would
  drag a pixel-less module into the attest basis). Cost: an `ART_EXCLUDED`
  entry — the joystick/gamepad reason string in
  `art/setup/profile-coverage.ts:32-33` is the exact template.
- Correction to an older memory: an **outbound CC path now EXISTS**
  (`midi/cc-out.ts`, `midi-out-buddy`) — irrelevant to v1 (Trails documents
  no MIDI in), noted for phase 2.

### 7.4 Face/pad constraints — confirmed hard

- `laneOrder`/`foldedOrder` delete every `xyPads` anchor + partner axis at
  EVERY lane tier — no lane tier has ever painted a pad, and
  `module-face-lint` now DENIES a promoted face resolving to zero lane
  controls (joystick is its permanent negative control). **A pad-only module
  cannot promote.** The trails module avoids this by having other ranked
  params (smoothing, divider, BI/UNI, clock div…); the promotable pattern is
  quadralogical's: `xyPads: [{..., surface:'body'}]` + a `fullViewBody`
  shell extension that really paints it (`face-xy-body-source.test.ts`).
- A face's picture reaches the lane via `VideoTileThumb` automatically only
  for `domain:'video'` defs; an audio-domain trails module's pad view lives
  in its shell extension (`tileBody`/`fullViewBody`), which is hash-FREE —
  the attest basis strips `face`, and shell extensions live outside
  `lib/video/`.
- SCREEN OFF must keep calling `markWatched` (the frametable
  `FrametableOutputBody.svelte:84-88` pattern) — a collapsed screen that
  stops renewing the watch mark becomes a producer kill switch.
- Attest scope precision: `resolveWebglBasis()` sweeps ALL of
  `packages/web/src/lib/video/` (tests excluded); `docs`/`controlFamilies`/
  `face`/`noUserControl` are stripped, **ports and params are NOT — and
  `PortDef.label` is NOT hash-transparent on a video def**, so batch label
  edits with a real contract change. The frametable def itself carries a
  do-not-auto-merge owner-preview note for look-affecting shader changes
  (`frametable.ts:40-41`).

## Sources

- [Bela Trails product page](https://bela.io/products/trails/)
- [Trails manual (learn.bela.io)](https://learn.bela.io/trails-manual) —
  MIDI I/O, voltage ranges, modes, firmware-update-via-Chrome-WebMIDI
- [Trails quick reference PDF](https://learn.bela.io/docs/products/modular/trails-quick-reference.pdf)
- [Trails firmware updater](https://bela.io/upgrade-trails)
- [Synth Anatomy release coverage](https://synthanatomy.com/2026/08/bela-trails-evolution-of-the-gliss-touch-controller-module-with-four-channels-and-2d-paths.html)
- [ModularGrid: Trails](https://modulargrid.net/e/bela-trails) ·
  [output module](https://modulargrid.net/e/bela-trails-output-module)
- [BelaPlatform/gliss-firmware](https://github.com/BelaPlatform/gliss-firmware)
  (GPL precedent; no public Trails repo yet)
