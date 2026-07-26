# TEMPEST module — build plan (owner-specced 2026-06-27)

A playable, **faithful** TEMPEST (Atari 1981 tube shooter) as a video-domain
WebGL2 module with synth-native I/O. Prior-art research (this session) →
build-from-scratch (no permissive WebGL clone; the video-textured surface needs a
real mesh none have). License-clean references: **Arashi (MIT)** for AI/spawn
feel; **atari-tempest README** for geometry/projection (read-only); charlesUnixPro
asm for exact arcade timings (clean-room reference).

## Owner decisions
- **Faithful full game**: fire, score, enemy-reaches-rim death/respawn,
  Superzapper, level progression.
- **Lanes + audio breathes radius**: fixed lane count (16) in classic tube shapes;
  audio bands modulate each lane's radius live (16 bands → 16 lanes). Coherent
  playfield that pulses — NOT audio fully generating the rim.
- **Vector enemies**: glowing additive-line flippers/tankers/spikers/fuseballs/
  pulsars, matching the translucent QuadraScan look.

## I/O (module ports + params)
- **gate** in(s): enemy SPAWN (rising edge → `spawnEnemy`). + a **FIRE** gate
  (shoot down the claw's lane). + optionally a **Superzapper** gate. (Decide: one
  spawn gate that round-robins enemy types, or a few typed spawn gates.)
- **cv** in: claw rim position (continuous 0..1 around the rim, wrap) ← gamepad
  joystick axis. Maybe a 2nd cv for depth/zoom later.
- **audio** in: spectrum → per-lane radius (the breathing tube).
- **video** in: texture-mapped onto the tube surface; **opacity** param blends it
  against the vector look (0 = classic translucent tube).
- params: opacity, (level/speed/difficulty, enemy-rate, glow, palette) TBD.
- video OUT (the rendered game). Lowercase label `tempest`; PatchPanel; DESCRIPTIONS
  + co-located docs + STRICT_DOCS.

## Architecture
**Pure-TS GL-free `tempest-core`** (the testable heart; deterministic seeded RNG +
fixed `dt` for VRT):
- Lane ring: N lanes from a classic tube shape (open/closed); per-lane base rim +
  pit points. `bandsToRadii(bands, base) → per-lane radius` (audio breathing).
- Rim mapping: `cv 0..1 → continuous rim position` with wrap + shortest-path claw
  motion (atari-tempest's `NUM_BLASTER_POSITIONS` continuous model).
- Depth model: enemy/projectile `z 0..1` (pit→rim) + `easeOutQuad` projection to
  clip space (perspective fake).
- Enemy model: `{type, lane, z, flipState}`; per-type fixed-dt travel; flipper
  lane-change pivot math; tanker split; fuseball lane-jump; spike growth.
- Player: claw at rim lane; FIRE → projectile travels pit-ward down the lane;
  collision (projectile-z vs enemy-z in same lane; enemy-at-rim vs claw = death).
- Game state: score, lives, level (cycle tube shapes + speed), Superzapper (one-
  shot clear), spawn scheduler driven by gate edges (`$lib/audio/edge-detect`
  `createEdgeCounter` — NEVER rescan an analyser buffer).

**WebGL2 worker renderer** (heavy-video → SwiftShader-frugal e2e, real-GPU lane
for any perf assert):
- VECTOR pass: additive-blended lines — rim ring, claw, enemies, projectiles,
  spikes (the glowing translucent look = the unpatched default).
- SURFACE pass: textured triangle-strip walls, UV = (lane, depth), sampling the
  video input, blended by the `opacity` uniform (0 = vector-only).
- audio analyser → band magnitudes → core each frame.

## Phases (smallest-reviewable-first; each its own PR)
- **P0 — tempest-core geometry + projection** (pure-TS + unit tests): lane ring,
  cv→rim wrap, depth/easeOutQuad, classic tube shapes. No GL. No attest.
- **P1 — module scaffold + vector renderer**: register `tempest` video module
  (PatchPanel, card, worker render of the static tube + claw via the vector pass);
  cv drives the claw. VRT baseline (unpatched vector look). First attest.
- **P2 — enemies + gate spawn**: enemy model in core (flipper first) + vector
  draw + spawn on gate edge; real-source e2e (gate → enemy appears → travels).
- **P3 — fire + collision + score/lives/death**: FIRE gate, projectiles,
  collision, the faithful game loop; readouts. Pure-core tested + e2e.
- **P4 — audio-breathing tube**: audio in → per-lane radius; bandsToRadii in core;
  renderer consumes. Real-source e2e (audio → tube morphs).
- **P5 — video surface + opacity**: textured tri-strip walls + opacity blend.
  Review-before-merge preview (video aesthetic, owner-gated). Re-baseline.
- **P6 — full enemy roster + levels + Superzapper + polish**: tankers/fuseballs/
  pulsars/spikes, level cycle, Superzapper gate, palettes/glow. Balancing.
- **P7 — docs**: co-located docs + STRICT_DOCS + DESCRIPTIONS + doc subpage.

Each phase: pure-core unit tests; e2e the REAL source chain (gate/cv/audio/video →
behavior); SwiftShader-frugal (few frames, renderer-tolerant, no fps gate — see the
composite-spike lesson); VRT baselines via vrt-update; flake-check 3×; re-attest
(it's in the WebGL basis). Gamepad CV out already exists.

## Open sub-decisions (defer to build time)
- Gate inputs: one spawn (round-robin) vs typed spawn gates; separate Superzapper
  gate vs a button.
- Faithful 16-lane vs configurable lane count; which of the 8 classic tube shapes
  to ship + whether level cycles them.
- Scoring/lives UI: on-card overlay vs CV/gate OUTs (score pulse, life-lost gate)
  so the game can drive the rack.
