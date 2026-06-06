// dgpt_events.h
//
// Phase-1 SP event-gate ring buffer. The DOOM video module exposes gate
// output ports (KILL, DOOR, GUN_P1..P4 — plus per-monster-type KILL_TYPED
// + per-player PLAYER_DIES added in feat/doom-per-type-death-gates).
// Engine-side hook sites push event codes into a single-producer ring;
// the JS side drains them each surface tick and pulses a
// ConstantSourceNode on each event's port.
//
// CRITICAL: Phase 1 is SP-only — these hooks fire on the DETERMINISTIC tic
// path but the JS-side drain is OUTSIDE the lockstep TicSet stream. They do
// NOT write ticcmds, do NOT call into the netgame path, and do NOT influence
// the consistency-check digest. MP determinism (bit-exact lockstep, BACKUPTICS
// consistancy byte) is untouched.
//
// Encoding: 32-bit event word
//   bits 0..3   = type
//                 DGPT_EVT_KILL=1         — any-monster-dies (legacy)
//                 DGPT_EVT_DOOR=2         — door opens
//                 DGPT_EVT_GUN=3          — weapon fire, slot in bits 4..5
//                 DGPT_EVT_PLAYER_DIES=4  — player dies, slot in bits 4..5
//                 DGPT_EVT_KILL_TYPED=5   — typed monster kill,
//                                            mobjtype_t in bits 4..15
//   bits 4..5   = slot (GUN, PLAYER_DIES)
//   bits 4..15  = payload (KILL_TYPED: mobjtype_t id, 12 bits → 4096 types,
//                 plenty for DOOM's ~138 mobj types)
//   bits 16..31 = reserved (zero)
//
// Ring size 256: with the worst-case ~36 events/tic (mass-kill in dense rooms)
// the ring never fills under 1 tic of drain latency; drop-oldest semantics
// keep it bounded if JS stalls. A typed kill emits TWO events (legacy +
// typed) so the worst case roughly doubles, but 256 still has 7×+ headroom.

#ifndef DGPT_EVENTS_H
#define DGPT_EVENTS_H

#include <stdint.h>

#define DGPT_EVT_RING_SIZE   256
#define DGPT_EVT_KILL        1u
#define DGPT_EVT_DOOR        2u
#define DGPT_EVT_GUN         3u
#define DGPT_EVT_PLAYER_DIES 4u
#define DGPT_EVT_KILL_TYPED  5u

// Single-producer push from the engine tic path. Safe to call any number of
// times per tic; overflow drops oldest.
//
// `slot` is encoded into bits 4..5 (only meaningful for GUN / PLAYER_DIES).
// For KILL_TYPED, use dgpt_evt_push_typed which packs a 12-bit payload into
// bits 4..15 instead.
void dgpt_evt_push(uint32_t type, int slot);

// Push a typed event: `payload` lands in bits 4..15 (12 bits). Used by
// KILL_TYPED to encode the mobjtype_t id alongside the event type.
void dgpt_evt_push_typed(uint32_t type, uint32_t payload);

// Drain up to `max` events into `out` (caller-owned uint32_t buffer). Returns
// the count actually drained. Called from JS via the WASM export.
int dgpt_drain_events(uint32_t *out, int max);

// Head/tail observability (testing/debug — current write/read cursors).
int dgpt_evt_head_get(void);
int dgpt_evt_tail_get(void);

#endif // DGPT_EVENTS_H
