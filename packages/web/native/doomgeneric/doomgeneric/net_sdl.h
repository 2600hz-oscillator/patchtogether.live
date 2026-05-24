//
// Copyright(C) 2005-2014 Simon Howard
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
//     Networking module which uses SDL_net
//

#ifndef NET_SDL_H
#define NET_SDL_H

#include "net_defs.h"

// patchtogether.live: the SDL_net UDP transport (net_sdl.c) is not vendored.
// The verbatim chocolate-doom net_query.c references net_sdl_module for the
// (unused) master-server browser path; alias it to our net_pt transport so
// that vendored source stays byte-identical and still links. d_loop.c
// references net_pt_module directly. See net_pt.c / net_pt.h.
#include "net_pt.h"
#define net_sdl_module net_pt_module

#endif /* #ifndef NET_SDL_H */

