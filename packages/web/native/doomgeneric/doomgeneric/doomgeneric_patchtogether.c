// doomgeneric_patchtogether.c
//
// Platform shim for the patchtogether.live DOOM video module. Replaces the
// upstream doomgeneric_emscripten.c (which assumes SDL2 + SDL2_mixer +
// browser-owned input + browser-owned audio); we want a thin layer that
// just exposes raw frame + input + audio buffers to JavaScript so the
// VideoEngine can blit pixels into a GL texture, the keyboard listener can
// push key events, and (slice 8) the AudioWorklet can pull PCM samples.
//
// Public C API (all extern "C"-equivalent; the linker exports these via
// the EXPORTED_FUNCTIONS list in build-doom-wasm.sh):
//
//   void dgpt_init(int wad_len);
//     Caller has already written `wad_len` bytes of DOOM1.WAD into the
//     module's filesystem (Emscripten MEMFS path '/doom1.wad'). We call
//     doomgeneric_Create(2, ["doom", "-iwad", "/doom1.wad"]).
//
//   void dgpt_tick();
//     Run one game tick. Engine reads input from our queue (DG_GetKey),
//     paints into DG_ScreenBuffer (BGRA32 at 640x400), and audio samples
//     into our internal PCM ring buffer (slice 8 — disabled in v1).
//
//   uint8_t* dgpt_get_framebuffer();
//     Pointer to DG_ScreenBuffer (BGRA32 at DOOMGENERIC_RESX *
//     DOOMGENERIC_RESY * 4 bytes). The JS shim wraps a Uint8ClampedArray
//     view directly over WASM HEAPU8 starting at this offset (zero-copy).
//
//   int dgpt_get_framebuffer_size();
//     Convenience: DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4. JS-side could
//     compute this from constants but exposing it via an export removes a
//     duplicated source-of-truth.
//
//   void dgpt_set_key(int doomkey, int pressed);
//     Push one key event into our queue. JS shim maps from KeyboardEvent
//     codes / CV-gate edges to the doomkeys.h constants and calls this.
//     The next dgpt_tick() drains the queue via DG_GetKey.
//
//   uint8_t* dgpt_get_pcm_buffer();
//     Pointer to our PCM ring buffer (Float32Array of N samples). Stub
//     in v1 — see slice-8 TODO at i_sound stubs below.
//
//   int dgpt_get_pcm_buffer_size();
//     Sample count of the PCM ring buffer. 0 in v1.
//
// Why a custom shim and not the upstream emscripten one?
//   1. Upstream requires SDL2 (mixer + video) — a 2 MB-ish runtime
//      dependency we don't want; we already own the rendering surface.
//   2. Upstream uses --preload-file doom1.wad — wires the WAD into the
//      .data sidecar at build time. We want runtime loading so users can
//      swap WADs later (open follow-up: user-WAD upload) without rebuilding.
//   3. Upstream couples input to SDL's main loop; we push key events from
//      JS (keyboard + CV gates + Yjs awareness relay), so a queue is the
//      right abstraction.
//
// The actual emcc invocation (build-doom-wasm.sh) lists this file
// alongside the upstream core .c files.

#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#include "doomgeneric.h"
#include "doomkeys.h"
#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "g_game.h"
#include "p_mobj.h"
#include "dgpt_events.h"

// Forward decl — defined in g_game.c. Lets the JS-side e2e read the
// player's actual in-game x/y/angle for regression checks on the
// "arrow keys move the player" code path (the framebuffer-diff test
// from PR #275 was insufficient — it passed for the broken-key bug
// too, where ArrowUp shrunk the screen instead of moving forward).
extern player_t players[MAXPLAYERS];

// Defined in d_loop.c (slice-4): sets the lockstep `localplayer` + resets
// the tic counters. See DGPT_LoopSetLocalPlayer there for why we need it.
extern void DGPT_LoopSetLocalPlayer(int player);

// Defined in d_loop.c (slice-5): the cross-peer ticcmd feed. JS reads this
// peer's local ticcmd each tic + broadcasts it, and injects every remote
// peer's ticcmd keyed by slot so all players' marines move in every peer's
// world. See the rationale block at the top of d_loop.c.
extern int  DGPT_LoopReadLocalTiccmd(signed char *forwardmove,
                                     signed char *sidemove,
                                     short *angleturn,
                                     unsigned char *buttons);
extern void DGPT_LoopInjectRemoteTiccmd(int slot,
                                        signed char forwardmove,
                                        signed char sidemove,
                                        short angleturn,
                                        unsigned char buttons);
extern void DGPT_LoopSetNetgamePlayers(int num_players);
// slice-7: arm scripted lockstep mode (the bit-exact determinism path). See
// DGPT_LoopSetScripted in d_loop.c. Inert unless explicitly armed.
extern void DGPT_LoopSetScripted(int enabled);

// P1: arm the true-lockstep barrier + deliver a consolidated per-tic TicSet.
// See DGPT_LoopSetLockstep / DGPT_LoopReceiveTicSet in d_loop.c.
extern void DGPT_LoopSetLockstep(int enabled);
extern void DGPT_LoopSetInputDelay(int tics);
extern void DGPT_LoopReceiveTicSet(int tic,
                                   int num_players,
                                   const signed char *forwardmove,
                                   const signed char *sidemove,
                                   const short *angleturn,
                                   const unsigned char *buttons,
                                   const unsigned char *present);
extern int DGPT_LoopGetMaketic(void);
extern int DGPT_LoopGetGametic(void);
extern int DGPT_LoopGetRecvtic(void);
extern int DGPT_LoopReadLocalTiccmdAt(int tic,
                                      signed char *forwardmove,
                                      signed char *sidemove,
                                      short *angleturn,
                                      unsigned char *buttons);

// slice-7: the engine's random-table indices (m_random.c). Folded into the
// state checksum so a divergence in RNG advancement (the classic lockstep
// desync source) shows up immediately in the digest.
extern int rndindex;
extern int prndindex;
// Tics elapsed in the current level (doomstat.h). Part of the digest so two
// sims that ran a different NUMBER of tics never collide on an equal checksum.
extern int leveltime;

// ---- Key event queue ----
//
// Bounded ring buffer. Each event packs the full 8-bit doomkey value
// in the low byte and the pressed flag in the high byte of a uint16:
//   bits  0..7  = doomkey (full unsigned char — KEY_UPARROW=0xad etc.)
//   bits  8..15 = pressed (0 or 1)
//
// HISTORICAL BUG (pre-#276): the encoding used `(doomkey & 0x7f) | (pressed << 7)`
// which truncated the high bit of doomkey. doomkeys.h KEY_* constants for the
// arrow keys + RCTRL/RALT/RSHIFT all have bit 0x80 set:
//   KEY_UPARROW    = 0xad → 0x2d after mask = KEY_MINUS  (shrinks screen!)
//   KEY_LEFTARROW  = 0xac → 0x2c after mask = ','        (unmapped)
//   KEY_RIGHTARROW = 0xae → 0x2e after mask = '.'        (unmapped)
//   KEY_DOWNARROW  = 0xaf → 0x2f after mask = '/'        (unmapped)
//   KEY_RCTRL      = 0x9d → 0x1d after mask                (not KEY_FIRE)
//   KEY_RALT       = 0xb8 → 0x38 after mask                (not strafe)
// The arrow keys hilariously decoded as KEY_MINUS = key_menu_decscreen,
// so ArrowUp shrunk the in-game viewport instead of moving the player.
// Lossy on overflow (oldest wins) — under normal human typing the queue
// never fills; under stress (held-key autorepeat + frame-rate stall)
// we'd rather drop than block.

// ---- Phase-1 SP event ring buffer ----
//
// See dgpt_events.h for the encoding + rationale. Producer is whichever engine
// site fired the event (P_KillMobj / EV_DoDoor / EV_VerticalDoor / P_FireWeapon
// — all on the deterministic tic path). Consumer is the JS module factory,
// draining once per surface tick AFTER runtime.runTic returns.
//
// IMPORTANT: this ring is intentionally OUTSIDE the netgame consistency
// digest (dgpt_state_checksum reads RNG + mobj state only). Draining + pulsing
// AudioParams from JS cannot influence the C-side deterministic state, so MP
// bit-exact lockstep is preserved.

static uint32_t dgpt_evt_ring[DGPT_EVT_RING_SIZE];
static volatile int dgpt_evt_head = 0;  // writer-only (producer cursor)
static volatile int dgpt_evt_tail = 0;  // reader-only (consumer cursor)

void dgpt_evt_push(uint32_t type, int slot) {
  // Pack: type in low 4 bits, slot in bits 4-5, rest reserved.
  uint32_t e = (type & 0xFu) | ((((uint32_t)slot) & 0x3u) << 4);
  int h = dgpt_evt_head;
  dgpt_evt_ring[h & (DGPT_EVT_RING_SIZE - 1)] = e;
  int next = (h + 1) & (DGPT_EVT_RING_SIZE - 1);
  dgpt_evt_head = next;
  // Overflow: if we lap the reader, advance tail by one (drop-oldest).
  if (next == dgpt_evt_tail) {
    dgpt_evt_tail = (dgpt_evt_tail + 1) & (DGPT_EVT_RING_SIZE - 1);
  }
}

void dgpt_evt_push_typed(uint32_t type, uint32_t payload) {
  // Pack: type in low 4 bits, 12-bit payload in bits 4..15. Used for
  // KILL_TYPED to encode the mobjtype_t id alongside the kill event.
  uint32_t e = (type & 0xFu) | ((payload & 0xFFFu) << 4);
  int h = dgpt_evt_head;
  dgpt_evt_ring[h & (DGPT_EVT_RING_SIZE - 1)] = e;
  int next = (h + 1) & (DGPT_EVT_RING_SIZE - 1);
  dgpt_evt_head = next;
  if (next == dgpt_evt_tail) {
    dgpt_evt_tail = (dgpt_evt_tail + 1) & (DGPT_EVT_RING_SIZE - 1);
  }
}

int dgpt_drain_events(uint32_t *out, int max) {
  int n = 0;
  while (n < max && dgpt_evt_tail != dgpt_evt_head) {
    out[n++] = dgpt_evt_ring[dgpt_evt_tail];
    dgpt_evt_tail = (dgpt_evt_tail + 1) & (DGPT_EVT_RING_SIZE - 1);
  }
  return n;
}

int dgpt_evt_head_get(void) { return dgpt_evt_head; }
int dgpt_evt_tail_get(void) { return dgpt_evt_tail; }

#define DGPT_KEY_QUEUE_SIZE 256

static uint16_t s_key_queue[DGPT_KEY_QUEUE_SIZE];
static int s_key_q_head = 0;  // index of oldest entry (read here)
static int s_key_q_tail = 0;  // index of next free slot (write here)

static uint32_t s_ms_at_start = 0;  // wall-clock-equivalent base
static uint32_t s_ms_now = 0;       // bumped by DG_GetTicksMs via JS

void dgpt_set_key(int doomkey, int pressed) {
  // Pack: low byte = full 8-bit doomkey, high byte = pressed flag (0/1).
  uint16_t entry = (uint16_t)((doomkey & 0xff) | ((pressed ? 1 : 0) << 8));
  int next_tail = (s_key_q_tail + 1) % DGPT_KEY_QUEUE_SIZE;
  if (next_tail == s_key_q_head) {
    // Full — drop oldest.
    s_key_q_head = (s_key_q_head + 1) % DGPT_KEY_QUEUE_SIZE;
  }
  s_key_queue[s_key_q_tail] = entry;
  s_key_q_tail = next_tail;
}

// ---- doomgeneric callbacks ----

void DG_Init() {
  // Nothing to do — the JS side already wrote the WAD into MEMFS before
  // calling dgpt_init.
}

void DG_DrawFrame() {
  // No-op: JS reads DG_ScreenBuffer directly via dgpt_get_framebuffer().
  // We don't blit ANYWHERE on the C side — that's the VideoEngine's job.
}

void DG_SleepMs(uint32_t ms) {
  // We can't actually block the JS thread — there's no syscall sleep
  // available from inside WASM. But doomgeneric's TryRunTics() spins
  // on I_Sleep(1) while waiting for the simulated wall-clock to
  // advance past the next tic boundary (see d_loop.c:784). With a
  // strictly-zero clock advance, that loop never exits and dgpt_init
  // hangs the whole browser tab during the WASM init path.
  //
  // The pragmatic fix: bump the virtual clock by `ms` here so that
  // `I_GetTime()` increases inside the spin loop and the wait exits
  // naturally. Net effect during init is the same as a real sleep
  // would have produced — wall-clock advances ~1 ms per spin — minus
  // the actual real-time delay, which we don't want anyway (we'd
  // rather complete init promptly and let the JS-driven dgpt_tick
  // drive subsequent frames at video rate).
  s_ms_now += ms;
}

uint32_t DG_GetTicksMs() {
  return s_ms_now - s_ms_at_start;
}

int DG_GetKey(int *pressed, unsigned char *doomKey) {
  if (s_key_q_head == s_key_q_tail) return 0;
  uint16_t entry = s_key_queue[s_key_q_head];
  s_key_q_head = (s_key_q_head + 1) % DGPT_KEY_QUEUE_SIZE;
  *pressed = (entry >> 8) & 0x1;
  *doomKey = (unsigned char)(entry & 0xff);
  return 1;
}

void DG_SetWindowTitle(const char *title) {
  // No-op. The card UI shows our own title; engine's "DOOM" string is
  // not surfaced.
  (void)title;
}

// ---- WASM-side exports ----

extern pixel_t *DG_ScreenBuffer;

void dgpt_init(int wad_len) {
  (void)wad_len;  // Caller already wrote the file; size is for diagnostics
                  // (and will become relevant when we add user-WAD upload).
  s_ms_at_start = 0;
  s_ms_now = 0;
  // doomgeneric_Create takes argc/argv; we pretend we got "-iwad /doom1.wad".
  // argv lives in static storage so it outlives the call.
  static char arg0[] = "doom";
  static char arg1[] = "-iwad";
  static char arg2[] = "/doom1.wad";
  static char *argv[] = { arg0, arg1, arg2, NULL };
  doomgeneric_Create(3, argv);
}

void dgpt_tick() {
  doomgeneric_Tick();
}

void dgpt_advance_clock(uint32_t ms_delta) {
  // JS bumps the wall clock by `ms_delta` per video frame so the engine's
  // internal timing (tick rate, demo loop) tracks real time. Separate from
  // dgpt_tick because slice 8's audio path may want to advance the clock
  // at audio rate while ticking the game at video rate.
  s_ms_now += ms_delta;
}

uint8_t *dgpt_get_framebuffer() {
  return (uint8_t *)DG_ScreenBuffer;
}

int dgpt_get_framebuffer_size() {
  return DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4;
}

int dgpt_get_resx() {
  return DOOMGENERIC_RESX;
}

int dgpt_get_resy() {
  return DOOMGENERIC_RESY;
}

// ---- Slice-8 audio stubs ----
//
// v1 ships with audio DISABLED — DOOM's i_sound.c is the upstream "null"
// implementation, no PCM is ever generated. When slice 8 lands we'll:
//   1. Wire i_sdlsound.c (or a fresh i_pcmgen.c) into the build
//   2. Have it write into the buffer below
//   3. Have the JS shim's AudioWorkletProcessor pull from this buffer at
//      audio rate
//
// For now these exist so the JS shim's API surface is stable (the audio
// output ports already declare audio_l/audio_r — they just push silence).

#define DGPT_PCM_BUFFER_SAMPLES 4096
static float s_pcm_buffer[DGPT_PCM_BUFFER_SAMPLES * 2];  // stereo

uint8_t *dgpt_get_pcm_buffer() {
  return (uint8_t *)s_pcm_buffer;
}

int dgpt_get_pcm_buffer_size() {
  return DGPT_PCM_BUFFER_SAMPLES;
}

// ---- Player-state introspection (regression-test hook) ----
//
// The e2e test for "ArrowUp moves the player forward" needs to read the
// player's actual in-game position — the framebuffer-diff signal alone is
// insufficient (the screen-shrink bug also changed pixels). These exports
// surface player 0's mobj x/y/angle so JS can sample, hold a key, sample
// again, and assert position actually changed.
//
// Coordinates are DOOM's native fixed-point (16.16). JS-side conversion to
// integer map units = (raw >> 16). Returns 0 when the player has no mobj
// yet (start screen / menu / level not loaded).

int dgpt_get_player_x(void) {
  if (!players[0].mo) return 0;
  return (int)players[0].mo->x;
}

int dgpt_get_player_y(void) {
  if (!players[0].mo) return 0;
  return (int)players[0].mo->y;
}

unsigned int dgpt_get_player_angle(void) {
  if (!players[0].mo) return 0;
  return (unsigned int)players[0].mo->angle;
}

int dgpt_has_player_mobj(void) {
  return players[0].mo != NULL ? 1 : 0;
}

// ---- Slice 4: New Game / Launch (start a multiplayer game) ----
//
// The vendored chocolate-doom D_StartNetGame has two code paths:
//   - ORIGCODE (undef in our config.h): the real handshake — connect to the
//     server, send our settings, BLOCK in a spin loop until the server's
//     GAMESTART arrives, then read back the consolidated settings.
//   - #else (the path we actually compile): hardcodes single-player
//     (consoleplayer=0, num_players=1) and never touches the netcode.
// Neither fits our model: the blocking spin loop can't run inside a
// cooperatively-scheduled WASM tick (there is no I_Sleep in the browser),
// and the #else path is single-player only.
//
// Slice 4's launch path therefore drives the start from JS instead: the
// arbiter peer broadcasts a settings blob over the netcode; every joined
// peer (arbiter included) calls dgpt_start_netgame() with the SAME settings
// + its OWN slot as consoleplayer. We:
//
//   1. write the agreed game settings into DOOM's start globals,
//   2. mark this a netgame with `num_players` slots live (playeringame[]),
//   3. set THIS peer's consoleplayer/displayplayer to its slot + push that
//      into d_loop.c's lockstep `localplayer`, and
//   4. G_InitNew() to load the level immediately (G_InitNew reads the
//      console/display/playeringame globals we just set — it does NOT reset
//      them, unlike G_DoNewGame).
//
// Because all peers feed G_InitNew the identical (skill, episode, map) +
// identical num_players, every peer deterministically loads the same level
// with marines spawned at the per-slot co-op starts; each peer's own
// G_BuildTiccmd drives players[consoleplayer], so arrow keys on peer N move
// peer N's marine and only that one — which is exactly the per-peer-POV
// proof slice 4's acceptance bar wants. The cross-peer ticcmd exchange that
// makes peers see each OTHER's marines moving rides the existing net_pt
// transport + d_loop lockstep once net_client_connected (slice 5 polishes
// the shared-view fidelity; slice 4 establishes that each peer is its own
// game instance in one configured netgame).
//
// Args mirror the net_gamesettings_t fields the JS netcode serializes:
//   deathmatch     0=coop, 1=deathmatch, 2=deathmatch-2.0
//   episode        1..3 (shareware DOOM1 = episode 1 only)
//   map            1..9
//   skill          0..4 (ITYTD..Nightmare; DOOM's skill_t is 0-based)
//   nomonsters     0/1
//   fast_monsters  0/1
//   respawn        0/1
//   num_players    1..4 — how many slots are live this game
//   consoleplayer  0..3 — THIS peer's slot
void dgpt_start_netgame(int deathmatch_mode,
                        int episode,
                        int map,
                        int skill,
                        int nomonsters_flag,
                        int fast_monsters,
                        int respawn,
                        int num_players,
                        int console_player) {
  int i;

  if (num_players < 1) num_players = 1;
  if (num_players > MAXPLAYERS) num_players = MAXPLAYERS;
  if (console_player < 0) console_player = 0;
  if (console_player >= MAXPLAYERS) console_player = MAXPLAYERS - 1;

  // 1. Game settings into DOOM's start globals.
  deathmatch = deathmatch_mode;
  startepisode = episode;
  startmap = map;
  startskill = (skill_t)skill;
  nomonsters = nomonsters_flag ? true : false;
  fastparm = fast_monsters ? true : false;
  respawnparm = respawn ? true : false;

  // 2. Netgame with `num_players` slots live. A lone player (num_players==1)
  //    is still a perfectly valid single-slot game — this same export drives
  //    single-player launch when only one peer is in the rack.
  netgame = (num_players > 1);
  for (i = 0; i < MAXPLAYERS; ++i) {
    playeringame[i] = (i < num_players) ? true : false;
  }

  // 3. This peer's view + lockstep slot.
  consoleplayer = console_player;
  displayplayer = console_player;
  DGPT_LoopSetLocalPlayer(console_player);
  // slice-5: arm the cross-peer ticcmd feed for `num_players` live slots so
  // each peer applies every other peer's input (cross-peer marine visibility).
  // num_players==1 leaves it disabled (single-player unaffected).
  DGPT_LoopSetNetgamePlayers(num_players);

  // 4. Load the level. G_InitNew honours the globals we set above.
  G_InitNew(startskill, startepisode, startmap);
}

// Current high-level game state (GS_LEVEL / GS_INTERMISSION / GS_FINALE /
// GS_DEMOSCREEN — see doomdef.h gamestate_t). The card uses this to (a)
// assert the level actually loaded after Launch (gamestate == GS_LEVEL) and
// (b) lock the New Game dialog until intermission, where the arbiter can
// pick the next map.
int dgpt_get_gamestate(void) {
  return (int)gamestate;
}

// ---- Slice 6: drive a level to its end (intermission) ----
//
// Exit the current level — equivalent to walking into a normal level exit.
// G_ExitLevel sets gameaction = ga_completed; the next dgpt_tick() runs
// G_DoCompleted, which transitions gamestate → GS_INTERMISSION (the between-
// maps tally screen). The card polls dgpt_get_gamestate() and, at GS_INTERMISSION,
// re-opens the New Game dialog so the arbiter can seat any pending late joiners
// + launch the next map. This export lets the C acceptance harness reach that
// state deterministically (without scripting an in-game exit-line touch), so
// it can prove a late joiner — seated via a fresh dgpt_start_netgame at a
// larger num_players — actually spawns into the NEXT map.
//
// No-op outside a netgame level is harmless (G_ExitLevel just queues the
// action); single-player byte-behavior is unaffected because nothing calls
// this on the default build path (it is only invoked by the MP harness + the
// MP card's next-map flow, both gated on num_players>1 upstream).
void dgpt_exit_level(void) {
  G_ExitLevel();
}

// Position of the player THIS peer controls (players[consoleplayer]), in
// DOOM fixed-point. dgpt_get_player_x/y above always read slot 0 (the
// single-player + pre-slice-4 regression hook); these read the local
// console player, which in a netgame is this peer's own marine. The e2e
// asserts two peers' console players occupy DIFFERENT positions after
// independent movement — proving separate per-peer instances.
int dgpt_get_console_player_x(void) {
  if (!players[consoleplayer].mo) return 0;
  return (int)players[consoleplayer].mo->x;
}

int dgpt_get_console_player_y(void) {
  if (!players[consoleplayer].mo) return 0;
  return (int)players[consoleplayer].mo->y;
}

int dgpt_get_console_player(void) {
  return consoleplayer;
}

int dgpt_has_console_player_mobj(void) {
  return players[consoleplayer].mo != NULL ? 1 : 0;
}

// Position of an ARBITRARY player slot's mobj (0..MAXPLAYERS-1), in DOOM
// fixed-point. Used by the cross-peer-visibility test: on peer B, read the
// position of players[A's slot] (the REMOTE marine) before + after A moves
// and assert it changed — i.e. B saw A walk. Returns 0 for an out-of-range
// slot or a slot with no live mobj (dgpt_has_player_slot_mobj gates it).
int dgpt_get_player_slot_x(int slot) {
  if (slot < 0 || slot >= MAXPLAYERS || !players[slot].mo) return 0;
  return (int)players[slot].mo->x;
}

int dgpt_get_player_slot_y(int slot) {
  if (slot < 0 || slot >= MAXPLAYERS || !players[slot].mo) return 0;
  return (int)players[slot].mo->y;
}

int dgpt_has_player_slot_mobj(int slot) {
  if (slot < 0 || slot >= MAXPLAYERS) return 0;
  return players[slot].mo != NULL ? 1 : 0;
}

// ---- Slice 5: cross-peer ticcmd feed ----
//
// JS reads THIS peer's freshly-built local ticcmd each tic via the four
// getters below + broadcasts {slot, forwardmove, sidemove, angleturn,
// buttons} over the netcode; on the receiving peer JS calls
// dgpt_inject_remote_ticcmd(slot, ...) which overlays that peer's input onto
// the next tic so its marine moves in this peer's world. See d_loop.c's
// DGPT_LoopReadLocalTiccmd / DGPT_LoopInjectRemoteTiccmd for the mechanism.
//
// We expose the local ticcmd as four scalar getters (rather than a struct out
// param) so the JS ccall surface stays trivial — each is a single 'number'
// return, no heap marshalling. dgpt_has_local_ticcmd gates them (false before
// the first tic is built). The values are DOOM's native ticcmd_t field types;
// JS sign-extends the i8/i16 fields itself.

static signed char  s_local_fwd;
static signed char  s_local_side;
static short        s_local_angle;
static unsigned char s_local_buttons;
static int          s_local_have;

// Refresh the cached local ticcmd from d_loop. Called by dgpt_has_local_ticcmd
// (the JS read path always calls it first), so the four getters return a
// coherent snapshot of one tic.
int dgpt_has_local_ticcmd(void) {
  s_local_have = DGPT_LoopReadLocalTiccmd(&s_local_fwd, &s_local_side,
                                          &s_local_angle, &s_local_buttons);
  return s_local_have;
}

int dgpt_local_ticcmd_forwardmove(void) { return (int)s_local_fwd; }
int dgpt_local_ticcmd_sidemove(void)    { return (int)s_local_side; }
int dgpt_local_ticcmd_angleturn(void)   { return (int)s_local_angle; }
int dgpt_local_ticcmd_buttons(void)     { return (int)s_local_buttons; }

// Inject a remote peer's latest ticcmd, keyed by that peer's slot (0..3). The
// fields arrive as ints from JS; we narrow to the ticcmd_t types. Ignored for
// the local slot + out-of-range slots (handled in d_loop.c) — unless scripted
// lockstep mode is armed (slice 7), where the local slot is injectable too.
void dgpt_inject_remote_ticcmd(int slot, int forwardmove, int sidemove,
                               int angleturn, int buttons) {
  DGPT_LoopInjectRemoteTiccmd(slot, (signed char)forwardmove,
                              (signed char)sidemove, (short)angleturn,
                              (unsigned char)buttons);
}

// ---- Slice 7: bit-exact lockstep determinism ----
//
// dgpt_set_scripted(enabled): arm/disarm scripted lockstep mode. When armed,
// the d_loop overlay drives EVERY slot — including this sim's own — from the
// injected ticcmd stream, so a trace-replay harness can feed K independent
// sims one identical consolidated TicSet per tic and prove their world states
// stay byte-for-byte identical. OFF by default; the live game + every default
// / single-player build path never call this, so the local player builds its
// own ticcmd exactly as before (production byte-behavior unaffected).
void dgpt_set_scripted(int enabled) {
  DGPT_LoopSetScripted(enabled);
}

// ---- P1: true-lockstep barrier (doom-mp-true-lockstep.md) ----
//
// dgpt_set_lockstep(enabled): arm/disarm the per-tic barrier. The live game
// arms it for a >1-player netgame; SP + the slice-5 free-run path leave it off
// (byte-identical behavior). When armed the engine never advances past the last
// consolidated TicSet delivered via dgpt_receive_ticset, and TryRunTics returns
// (never spins) when starved.
void dgpt_set_lockstep(int enabled) {
  DGPT_LoopSetLockstep(enabled);
}

// dgpt_set_input_delay(tics): the P1 INPUT-DELAY buffer. Under lockstep the
// engine builds maketic this many tics AHEAD of gametic, so each peer's ticcmd
// for tic G is produced + appended ~tics×28.5ms before the barrier needs it —
// giving the relay time to propagate it so the sim runs at 35Hz instead of
// stalling. Determinism is preserved (true tic numbers + identical consolidated
// TicSet per tic); only WHEN the input is produced changes. The card sets ~6
// for a >1-player netgame; 0 = default build-ahead. See DGPT_LoopSetInputDelay.
void dgpt_set_input_delay(int tics) {
  DGPT_LoopSetInputDelay(tics);
}

// dgpt_receive_ticset(tic, num_players, <per-slot fields for 4 slots>): deliver
// the consolidated, ordered TicSet for one tic. We pass each slot's ticcmd as
// scalar args (P1 caps at MAXPLAYERS=4) so the JS ccall surface stays trivial —
// no heap marshalling. JS assembles the TicSet from the shared ordered append-
// log (Y.Array) strictly in tic order, calling this once per tic. The `present`
// bits mark which slots are in-game this tic (a dropped peer's bit is cleared).
// Slots ≥ num_players are ignored. See DGPT_LoopReceiveTicSet in d_loop.c.
void dgpt_receive_ticset(int tic, int num_players,
                         int fwd0, int side0, int ang0, int btn0, int present0,
                         int fwd1, int side1, int ang1, int btn1, int present1,
                         int fwd2, int side2, int ang2, int btn2, int present2,
                         int fwd3, int side3, int ang3, int btn3, int present3) {
  signed char fwd[4]  = { (signed char)fwd0, (signed char)fwd1,
                          (signed char)fwd2, (signed char)fwd3 };
  signed char side[4] = { (signed char)side0, (signed char)side1,
                          (signed char)side2, (signed char)side3 };
  short ang[4]        = { (short)ang0, (short)ang1, (short)ang2, (short)ang3 };
  unsigned char btn[4] = { (unsigned char)btn0, (unsigned char)btn1,
                           (unsigned char)btn2, (unsigned char)btn3 };
  unsigned char pres[4] = { (unsigned char)(present0 ? 1 : 0),
                            (unsigned char)(present1 ? 1 : 0),
                            (unsigned char)(present2 ? 1 : 0),
                            (unsigned char)(present3 ? 1 : 0) };
  DGPT_LoopReceiveTicSet(tic, num_players, fwd, side, ang, btn, pres);
}

// Engine tic counters for the JS lockstep driver. maketic = next tic to build
// input for; gametic = tic about to run; recvtic = last consolidated TicSet
// received. JS appends its local ticcmd for tic (maketic-1) to the shared log
// and gates barrier delivery against gametic.
int dgpt_get_maketic(void) { return DGPT_LoopGetMaketic(); }
int dgpt_get_gametic(void) { return DGPT_LoopGetGametic(); }
int dgpt_get_recvtic(void) { return DGPT_LoopGetRecvtic(); }

// Read THIS peer's local ticcmd for a SPECIFIC built tic into a cached scalar
// snapshot (same trivial-ccall-surface pattern as dgpt_has_local_ticcmd). The
// JS lockstep pump calls dgpt_local_ticcmd_at(tic) then reads the four getters
// to append that tic to the shared log. Returns 1 if the tic is available.
static signed char  s_at_fwd;
static signed char  s_at_side;
static short        s_at_angle;
static unsigned char s_at_buttons;
int dgpt_local_ticcmd_at(int tic) {
  return DGPT_LoopReadLocalTiccmdAt(tic, &s_at_fwd, &s_at_side, &s_at_angle, &s_at_buttons);
}
int dgpt_local_ticcmd_at_forwardmove(void) { return (int)s_at_fwd; }
int dgpt_local_ticcmd_at_sidemove(void)    { return (int)s_at_side; }
int dgpt_local_ticcmd_at_angleturn(void)   { return (int)s_at_angle; }
int dgpt_local_ticcmd_at_buttons(void)     { return (int)s_at_buttons; }

// dgpt_state_checksum(): a stable 32-bit digest of the deterministic game
// state — enough to detect ANY divergence between two sims that should be in
// lockstep, while being insensitive to non-gameplay noise (heap addresses,
// pointer values, render-only fields). We fold, for every player slot in game:
//   mobj x, y, z, angle, momx, momy, momz, health, the player's own health.
// plus the global leveltime + both RNG indices (rndindex / prndindex). The
// RNG indices are the canonical lockstep-desync canary: if two sims call
// P_Random/M_Random a different number of times (different monster AI, different
// damage rolls, …) their indices diverge and the checksum catches it even
// before any position drift is visible.
//
// Implementation: a plain FNV-1a 32-bit fold over the little-endian bytes of
// each value. Order-stable + dependency-free (no libc beyond the engine).
// Reads only fields that exist in the SP build too, so it is inert/safe on the
// default path (it just isn't exported there unless listed — it is harmless to
// call: returns a digest of the lone player's state).
static uint32_t dgpt_fnv1a_u32(uint32_t h, uint32_t v) {
  int b;
  for (b = 0; b < 4; ++b) {
    h ^= (v & 0xff);
    h *= 16777619u;
    v >>= 8;
  }
  return h;
}

uint32_t dgpt_state_checksum(void) {
  uint32_t h = 2166136261u; // FNV offset basis
  int i;
  h = dgpt_fnv1a_u32(h, (uint32_t)leveltime);
  h = dgpt_fnv1a_u32(h, (uint32_t)rndindex);
  h = dgpt_fnv1a_u32(h, (uint32_t)prndindex);
  for (i = 0; i < MAXPLAYERS; ++i) {
    // Fold playeringame so a slot toggling in/out changes the digest.
    h = dgpt_fnv1a_u32(h, (uint32_t)(playeringame[i] ? 1u : 0u));
    h = dgpt_fnv1a_u32(h, (uint32_t)players[i].health);
    if (players[i].mo) {
      mobj_t *mo = players[i].mo;
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->x);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->y);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->z);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->angle);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->momx);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->momy);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->momz);
      h = dgpt_fnv1a_u32(h, (uint32_t)mo->health);
    } else {
      // Distinct constant for "no mobj" so an absent marine differs from one
      // that happens to be at the origin with zero momentum.
      h = dgpt_fnv1a_u32(h, 0xDEADBEEFu);
    }
  }
  return h;
}
