// dgpt_events.h
//
// Phase-1 SP event-gate ring buffer. The DOOM video module exposes 6 new gate
// output ports (KILL, DOOR, GUN_P1..P4). Engine-side hook sites push event
// codes into a single-producer ring; the JS side drains them each surface tick
// and pulses a ConstantSourceNode on each event's port.
//
// CRITICAL: Phase 1 is SP-only — these hooks fire on the DETERMINISTIC tic
// path but the JS-side drain is OUTSIDE the lockstep TicSet stream. They do
// NOT write ticcmds, do NOT call into the netgame path, and do NOT influence
// the consistency-check digest. MP determinism (bit-exact lockstep, BACKUPTICS
// consistancy byte) is untouched.
//
// Encoding: 32-bit event word
//   bits 0..3   = type (DGPT_EVT_KILL=1, DGPT_EVT_DOOR=2, DGPT_EVT_GUN=3)
//   bits 4..5   = slot (0..3, only meaningful for DGPT_EVT_GUN)
//   bits 6..31  = reserved (zero)
//
// Ring size 256: with the worst-case ~36 events/tic (mass-kill in dense rooms)
// the ring never fills under 1 tic of drain latency; drop-oldest semantics
// keep it bounded if JS stalls.

#ifndef DGPT_EVENTS_H
#define DGPT_EVENTS_H

#include <stdint.h>

#define DGPT_EVT_RING_SIZE   256
#define DGPT_EVT_KILL        1u
#define DGPT_EVT_DOOR        2u
#define DGPT_EVT_GUN         3u

// Single-producer push from the engine tic path. Safe to call any number of
// times per tic; overflow drops oldest.
void dgpt_evt_push(uint32_t type, int slot);

// Drain up to `max` events into `out` (caller-owned uint32_t buffer). Returns
// the count actually drained. Called from JS via the WASM export.
int dgpt_drain_events(uint32_t *out, int max);

// Head/tail observability (testing/debug — current write/read cursors).
int dgpt_evt_head_get(void);
int dgpt_evt_tail_get(void);

#endif // DGPT_EVENTS_H
