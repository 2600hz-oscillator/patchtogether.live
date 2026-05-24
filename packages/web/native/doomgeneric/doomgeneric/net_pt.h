//
// Copyright(C) 2026 patchtogether.live contributors
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//     patchtogether.live custom net_module_t transport ("net_pt") — the
//     WASM<->JS packet bridge. See net_pt.c for the full Module.PTNet JS
//     interface contract.
//

#ifndef NET_PT_H
#define NET_PT_H

#include <stdint.h>

#include "net_defs.h"

// The net_module_t the multiplayer build registers as its active transport.
extern net_module_t net_pt_module;

// C<->JS bridge exports (also force-exported via build-doom-wasm.sh).
int dgpt_net_inject_packet(const uint8_t *bytes, int len, int src_peer_id);
int dgpt_net_register(void);
int dgpt_net_peer_id_for_addr(net_addr_t *addr);
void dgpt_net_reset(void);

// Test/debug exports (see net_pt.c).
unsigned int dgpt_net_sent_type_mask(void);
unsigned int dgpt_net_recv_type_mask(void);
unsigned int dgpt_net_sent_count(void);
unsigned int dgpt_net_recv_count(void);
void dgpt_net_test_init(void);
int dgpt_net_test_drain_one(uint8_t *out_ptr, int max_len, int *out_peer_id);
void dgpt_net_sv_add_pt_module(void);
int dgpt_net_cl_connect(int peer_id, int as_drone);

#endif /* #ifndef NET_PT_H */
