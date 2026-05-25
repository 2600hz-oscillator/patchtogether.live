//
// Copyright(C) 1993-1996 Id Software, Inc.
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
//     Main loop code.
//

#include <stdlib.h>
#include <string.h>

#include "doomfeatures.h"

#include "d_event.h"
#include "d_loop.h"
#include "d_ticcmd.h"

#include "i_system.h"
#include "i_timer.h"
#include "i_video.h"

#include "m_argv.h"
#include "m_fixed.h"

#include "net_client.h"
#include "net_gui.h"
#include "net_io.h"
#include "net_query.h"
#include "net_server.h"
#include "net_sdl.h"
#include "net_pt.h"
#include "net_loop.h"

// The complete set of data for a particular tic.

typedef struct
{
    ticcmd_t cmds[NET_MAXPLAYERS];
    boolean ingame[NET_MAXPLAYERS];
} ticcmd_set_t;

//
// gametic is the tic about to (or currently being) run
// maketic is the tic that hasn't had control made for it yet
// recvtic is the latest tic received from the server.
//
// a gametic cannot be run until ticcmds are received for it
// from all players.
//

static ticcmd_set_t ticdata[BACKUPTICS];

// The index of the next tic to be made (with a call to BuildTiccmd).

static int maketic;

// The number of complete tics received from the server so far.

static int recvtic;

// The number of tics that have been run (using RunTic) so far.

int gametic;

// When set to true, a single tic is run each time TryRunTics() is called.
// This is used for -timedemo mode.

boolean singletics = false;

// Index of the local player.

static int localplayer;

// ---------------------------------------------------------------------------
// patchtogether.live slice-5 cross-peer ticcmd feed.
//
// WHY THIS EXISTS (the netcode gap slice 5 fills):
//   Slice 4's dgpt_start_netgame() brings up a netgame (netgame=true,
//   playeringame[0..n)=true) WITHOUT going through chocolate-doom's full
//   net_client connection handshake (NET_CL_Connect → SYN/ACK → GAMESTART →
//   BlockUntilStart). That handshake is a multi-RTT, spin-loop-blocking state
//   machine that cannot run inside our cooperatively-scheduled WASM tick (no
//   I_Sleep in the browser), which is exactly why slice 4 bypassed it. The
//   side effect: `net_client_connected` stays FALSE, so d_loop.c never calls
//   NET_CL_SendTiccmd (BuildNewTic) and never receives a consolidated TicSet
//   (D_ReceiveTic). Each peer therefore only ever ran its OWN ticcmd into
//   players[localplayer] — the other slots got SinglePlayerClear'd to
//   ingame=false, so NO peer saw any OTHER peer's marine move. Cross-peer
//   visibility (peer A sees peer B walk past) was absent.
//
//   Rather than light up the entire chocolate-doom connection machine (wrong
//   shape for our JS-driven lockstep), slice 5 adds a thin DIRECT ticcmd
//   cross-feed at exactly the abstraction level d_loop already operates on:
//     - JS reads THIS peer's just-built local ticcmd each tic
//       (DGPT_LoopReadLocalTiccmd) and broadcasts it over the existing
//       netcode transport, tagged with this peer's slot;
//     - JS injects every REMOTE peer's latest ticcmd
//       (DGPT_LoopInjectRemoteTiccmd) keyed by that peer's slot;
//     - right before RunTic, TryRunTics overlays the stored remote ticcmds
//       onto the tic set + forces those slots ingame=true, so the SAME
//       deterministic G_Ticker on every peer applies all players' inputs and
//       every marine moves in every peer's world.
//
//   This is the lockstep TicSet aggregation, expressed for our transport. It
//   is intentionally last-value (no per-tic sequencing / resend): browser
//   peers run at ~35 tics/s and the awareness/data-channel feed delivers the
//   newest ticcmd; a dropped intermediate ticcmd just means a marine's motion
//   is sampled slightly coarsely, never a hard desync of the local player
//   (whose own input is always exact). Sequenced, diffed ticcmds are a
//   slice-7 fidelity follow-up.
//
//   Compiled unconditionally (touches no FEATURE_MULTIPLAYER-only symbols).
//   In single-player (no remote slots ever injected) the overlay is a no-op
//   and behaviour is byte-identical to slice 4.

static ticcmd_t dgpt_remote_cmds[NET_MAXPLAYERS];
static boolean  dgpt_remote_present[NET_MAXPLAYERS];
// How many slots are live in the current netgame (0 = single-player, no
// cross-feed). Set by DGPT_LoopSetNetgamePlayers from dgpt_start_netgame.
static int      dgpt_netgame_players;

// patchtogether.live slice-7 SCRIPTED-LOCKSTEP mode.
//
// WHY THIS EXISTS (the bit-exact determinism deliverable):
//   The slice-5 cross-feed (above) is enough for cross-peer VISIBILITY but is
//   NOT bit-exact across peers. The reason is the read-then-inject one-tic lag:
//   each peer builds its OWN local-slot ticcmd from its OWN key queue via
//   G_BuildTiccmd, then JS reads maketic-1 and ships it to the other peer, who
//   injects it for a tic it may already have run. So peer A's slot-0 ticcmd as
//   seen in A's world (built from A's keys at tic N) and as seen in B's world
//   (injected, applied a tic later) are sampled a tic apart → sub-pixel drift →
//   not byte-identical world state. The slice-5 harness papered over this with
//   a within-25% displacement compare.
//
//   To PROVE true lockstep determinism we must feed EVERY sim the SAME
//   consolidated TicSet for ALL slots each tic — including the slot the sim
//   "owns" — eliminating the local G_BuildTiccmd input + the read-then-inject
//   lag entirely. That is exactly what a real arbiter-broadcast TicSet is: one
//   authoritative {cmd[0..n)} per tic that every peer consumes identically.
//
//   Scripted mode (armed by DGPT_LoopSetScripted(1)) makes the overlay drive
//   the LOCAL slot too, from dgpt_remote_cmds[localplayer], so a harness can
//   inject all N slots' ticcmds from one canonical scripted stream and run K
//   independent sims that stay byte-for-byte identical every tic. It is OFF by
//   default; the live game (and every default/SP build path) never arms it, so
//   the local player's freshly-built ticcmd drives its own marine exactly as
//   before. Inert on the single-player + production paths.
static boolean  dgpt_scripted = false;

// Overlay the remote slots onto a tic set about to run, forcing those slots
// in-game so RunTic applies them + (crucially) so RunTic's quit-detection
// never flips playeringame[i] off for a remote player whose first ticcmd
// hasn't arrived yet (it would otherwise see playeringame[i] && !ingame[i] and
// call PlayerQuitGame, permanently removing that marine). Every remote slot in
// [0, dgpt_netgame_players) is kept in-game with a zeroed ticcmd until a real
// one is injected. The local player's own slot is normally never touched — its
// exact, freshly-built ticcmd already sits in the set — UNLESS scripted mode is
// armed (slice 7), in which case the local slot is driven from the injected
// scripted stream too, so all sims consume an identical TicSet (bit-exact
// lockstep). No-op in single-player (dgpt_netgame_players <= 1).
// slice-7: read the locally-expected consistancy byte for a slot (g_game.c).
extern int G_ConsistancyForSlot(int slot, int buf);

static void DGPT_OverlayRemoteCmds(ticcmd_set_t *set)
{
    int i;
    int buf;
    if (dgpt_netgame_players <= 1) return;
    buf = (gametic / ticdup) % BACKUPTICS;
    for (i = 0; i < NET_MAXPLAYERS; ++i)
    {
        if (i >= dgpt_netgame_players) continue;
        // In normal (live-game) mode the local slot keeps its own freshly-built
        // ticcmd; in scripted lockstep mode (slice 7) the local slot is also
        // driven from the injected canonical stream so every sim runs an
        // identical consolidated TicSet.
        if (i == localplayer && !dgpt_scripted) continue;
        // Keep the slot in-game from the very first tic so RunTic never
        // quits it; apply the injected ticcmd if one has arrived, else a
        // zeroed (idle) command.
        set->cmds[i] = dgpt_remote_cmds[i];
        set->ingame[i] = true;
        if (dgpt_scripted)
        {
            // Synthetic ticcmds carry no consistancy; stamp the locally-expected
            // value so G_Ticker's netgame desync check passes. Every scripted
            // sim holds identical state → identical expected value, so this is
            // not "cheating" the check — the determinism is verified independently
            // by dgpt_state_checksum.
            set->cmds[i].consistancy =
                (unsigned char) G_ConsistancyForSlot(i, buf);
        }
    }
}

// Used for original sync code.

static int      skiptics = 0;

// Reduce the bandwidth needed by sampling game input less and transmitting
// less.  If ticdup is 2, sample half normal, 3 = one third normal, etc.

int		ticdup;

// Amount to offset the timer for game sync.

fixed_t         offsetms;

// Use new client syncronisation code

static boolean  new_sync = true;

// Callback functions for loop code.

static loop_interface_t *loop_interface = NULL;

// Current players in the multiplayer game.
// This is distinct from playeringame[] used by the game code, which may
// modify playeringame[] when playing back multiplayer demos.

static boolean local_playeringame[NET_MAXPLAYERS];

// Requested player class "sent" to the server on connect.
// If we are only doing a single player game then this needs to be remembered
// and saved in the game settings.

static int player_class;


// 35 fps clock adjusted by offsetms milliseconds

static int GetAdjustedTime(void)
{
    int time_ms;

    time_ms = I_GetTimeMS();

    if (new_sync)
    {
	// Use the adjustments from net_client.c only if we are
	// using the new sync mode.

        time_ms += (offsetms / FRACUNIT);
    }

    return (time_ms * TICRATE) / 1000;
}

static boolean BuildNewTic(void)
{
    int	gameticdiv;
    ticcmd_t cmd;

    gameticdiv = gametic/ticdup;

    I_StartTic ();
    loop_interface->ProcessEvents();

    // Always run the menu

    loop_interface->RunMenu();

    if (drone)
    {
        // In drone mode, do not generate any ticcmds.

        return false;
    }

    if (new_sync)
    {
       // If playing single player, do not allow tics to buffer
       // up very far

       if (!net_client_connected && maketic - gameticdiv > 2)
           return false;

       // Never go more than ~200ms ahead

       if (maketic - gameticdiv > 8)
           return false;
    }
    else
    {
       if (maketic - gameticdiv >= 5)
           return false;
    }

    //printf ("mk:%i ",maketic);
    memset(&cmd, 0, sizeof(ticcmd_t));
    loop_interface->BuildTiccmd(&cmd, maketic);

#ifdef FEATURE_MULTIPLAYER

    if (net_client_connected)
    {
        NET_CL_SendTiccmd(&cmd, maketic);
    }

#endif
    ticdata[maketic % BACKUPTICS].cmds[localplayer] = cmd;
    ticdata[maketic % BACKUPTICS].ingame[localplayer] = true;

    ++maketic;

    return true;
}

//
// NetUpdate
// Builds ticcmds for console player,
// sends out a packet
//
int      lasttime;

void NetUpdate (void)
{
    int nowtime;
    int newtics;
    int	i;

    // If we are running with singletics (timing a demo), this
    // is all done separately.

    if (singletics)
        return;

#ifdef FEATURE_MULTIPLAYER

    // Run network subsystems

    NET_CL_Run();
    NET_SV_Run();

#endif

    // check time
    nowtime = GetAdjustedTime() / ticdup;
    newtics = nowtime - lasttime;

    lasttime = nowtime;

    if (skiptics <= newtics)
    {
        newtics -= skiptics;
        skiptics = 0;
    }
    else
    {
        skiptics -= newtics;
        newtics = 0;
    }

    // build new ticcmds for console player

    for (i=0 ; i<newtics ; i++)
    {
        if (!BuildNewTic())
        {
            break;
        }
    }
}

static void D_Disconnected(void)
{
    // In drone mode, the game cannot continue once disconnected.

    if (drone)
    {
        I_Error("Disconnected from server in drone mode.");
    }

    // disconnected from server

    printf("Disconnected from server.\n");
}

//
// Invoked by the network engine when a complete set of ticcmds is
// available.
//

void D_ReceiveTic(ticcmd_t *ticcmds, boolean *players_mask)
{
    int i;

    // Disconnected from server?

    if (ticcmds == NULL && players_mask == NULL)
    {
        D_Disconnected();
        return;
    }

    for (i = 0; i < NET_MAXPLAYERS; ++i)
    {
        if (!drone && i == localplayer)
        {
            // This is us.  Don't overwrite it.
        }
        else
        {
            ticdata[recvtic % BACKUPTICS].cmds[i] = ticcmds[i];
            ticdata[recvtic % BACKUPTICS].ingame[i] = players_mask[i];
        }
    }

    ++recvtic;
}

//
// Start game loop
//
// Called after the screen is set but before the game starts running.
//

void D_StartGameLoop(void)
{
    lasttime = GetAdjustedTime() / ticdup;
}

#if ORIGCODE
//
// Block until the game start message is received from the server.
//

static void BlockUntilStart(net_gamesettings_t *settings,
                            netgame_startup_callback_t callback)
{
    while (!NET_CL_GetSettings(settings))
    {
        NET_CL_Run();
        NET_SV_Run();

        if (!net_client_connected)
        {
            I_Error("Lost connection to server");
        }

        if (callback != NULL && !callback(net_client_wait_data.ready_players,
                                          net_client_wait_data.num_players))
        {
            I_Error("Netgame startup aborted.");
        }

        I_Sleep(100);
    }
}

#endif

void D_StartNetGame(net_gamesettings_t *settings,
                    netgame_startup_callback_t callback)
{
#if ORIGCODE
    int i;

    offsetms = 0;
    recvtic = 0;

    settings->consoleplayer = 0;
    settings->num_players = 1;
    settings->player_classes[0] = player_class;

    //!
    // @category net
    //
    // Use new network client sync code rather than the classic
    // sync code. This is currently disabled by default because it
    // has some bugs.
    //
    if (M_CheckParm("-newsync") > 0)
        settings->new_sync = 1;
    else
        settings->new_sync = 0;

    // TODO: New sync code is not enabled by default because it's
    // currently broken. 
    //if (M_CheckParm("-oldsync") > 0)
    //    settings->new_sync = 0;
    //else
    //    settings->new_sync = 1;

    //!
    // @category net
    // @arg <n>
    //
    // Send n extra tics in every packet as insurance against dropped
    // packets.
    //

    i = M_CheckParmWithArgs("-extratics", 1);

    if (i > 0)
        settings->extratics = atoi(myargv[i+1]);
    else
        settings->extratics = 1;

    //!
    // @category net
    // @arg <n>
    //
    // Reduce the resolution of the game by a factor of n, reducing
    // the amount of network bandwidth needed.
    //

    i = M_CheckParmWithArgs("-dup", 1);

    if (i > 0)
        settings->ticdup = atoi(myargv[i+1]);
    else
        settings->ticdup = 1;

    if (net_client_connected)
    {
        // Send our game settings and block until game start is received
        // from the server.

        NET_CL_StartGame(settings);
        BlockUntilStart(settings, callback);

        // Read the game settings that were received.

        NET_CL_GetSettings(settings);
    }

    if (drone)
    {
        settings->consoleplayer = 0;
    }

    // Set the local player and playeringame[] values.

    localplayer = settings->consoleplayer;

    for (i = 0; i < NET_MAXPLAYERS; ++i)
    {
        local_playeringame[i] = i < settings->num_players;
    }

    // Copy settings to global variables.

    ticdup = settings->ticdup;
    new_sync = settings->new_sync;

    // TODO: Message disabled until we fix new_sync.
    //if (!new_sync)
    //{
    //    printf("Syncing netgames like Vanilla Doom.\n");
    //}
#else
    settings->consoleplayer = 0;
	settings->num_players = 1;
	settings->player_classes[0] = player_class;
	settings->new_sync = 0;
	settings->extratics = 1;
	settings->ticdup = 1;

	ticdup = settings->ticdup;
	new_sync = settings->new_sync;
#endif
}

boolean D_InitNetGame(net_connect_data_t *connect_data)
{
    boolean result = false;
#ifdef FEATURE_MULTIPLAYER
    net_addr_t *addr = NULL;
    int i;
#endif

    // Call D_QuitNetGame on exit:

    I_AtExit(D_QuitNetGame, true);

    player_class = connect_data->player_class;

#ifdef FEATURE_MULTIPLAYER

    //!
    // @category net
    //
    // Start a multiplayer server, listening for connections.
    //

    if (M_CheckParm("-server") > 0
     || M_CheckParm("-privateserver") > 0)
    {
        NET_SV_Init();
        NET_SV_AddModule(&net_loop_server_module);
        NET_SV_AddModule(&net_pt_module);
        NET_SV_RegisterWithMaster();

        net_loop_client_module.InitClient();
        addr = net_loop_client_module.ResolveAddress(NULL);
    }
    else
    {
        //!
        // @category net
        //
        // Automatically search the local LAN for a multiplayer
        // server and join it.
        //

        i = M_CheckParm("-autojoin");

        if (i > 0)
        {
            addr = NET_FindLANServer();

            if (addr == NULL)
            {
                I_Error("No server found on local LAN");
            }
        }

        //!
        // @arg <address>
        // @category net
        //
        // Connect to a multiplayer server running on the given
        // address.
        //

        i = M_CheckParmWithArgs("-connect", 1);

        if (i > 0)
        {
            net_pt_module.InitClient();
            addr = net_pt_module.ResolveAddress(myargv[i+1]);

            if (addr == NULL)
            {
                I_Error("Unable to resolve '%s'\n", myargv[i+1]);
            }
        }
    }

    if (addr != NULL)
    {
        if (M_CheckParm("-drone") > 0)
        {
            connect_data->drone = true;
        }

        if (!NET_CL_Connect(addr, connect_data))
        {
            I_Error("D_InitNetGame: Failed to connect to %s\n",
                    NET_AddrToString(addr));
        }

        printf("D_InitNetGame: Connected to %s\n", NET_AddrToString(addr));

        // Wait for launch message received from server.

        NET_WaitForLaunch();

        result = true;
    }
#endif

    return result;
}


//
// D_QuitNetGame
// Called before quitting to leave a net game
// without hanging the other players
//
void D_QuitNetGame (void)
{
#ifdef FEATURE_MULTIPLAYER
    NET_SV_Shutdown();
    NET_CL_Disconnect();
#endif
}

static int GetLowTic(void)
{
    int lowtic;

    lowtic = maketic;

#ifdef FEATURE_MULTIPLAYER
    if (net_client_connected)
    {
        if (drone || recvtic < lowtic)
        {
            lowtic = recvtic;
        }
    }
#endif

    return lowtic;
}

static int frameon;
static int frameskip[4];
static int oldnettics;

static void OldNetSync(void)
{
    unsigned int i;
    int keyplayer = -1;

    frameon++;

    // ideally maketic should be 1 - 3 tics above lowtic
    // if we are consistantly slower, speed up time

    for (i=0 ; i<NET_MAXPLAYERS ; i++)
    {
        if (local_playeringame[i])
        {
            keyplayer = i;
            break;
        }
    }

    if (keyplayer < 0)
    {
        // If there are no players, we can never advance anyway

        return;
    }

    if (localplayer == keyplayer)
    {
        // the key player does not adapt
    }
    else
    {
        if (maketic <= recvtic)
        {
            lasttime--;
            // printf ("-");
        }

        frameskip[frameon & 3] = oldnettics > recvtic;
        oldnettics = maketic;

        if (frameskip[0] && frameskip[1] && frameskip[2] && frameskip[3])
        {
            skiptics = 1;
            // printf ("+");
        }
    }
}

// Returns true if there are players in the game:

static boolean PlayersInGame(void)
{
    boolean result = false;
    unsigned int i;

    // If we are connected to a server, check if there are any players
    // in the game.

    if (net_client_connected)
    {
        for (i = 0; i < NET_MAXPLAYERS; ++i)
        {
            result = result || local_playeringame[i];
        }
    }

    // Whether single or multi-player, unless we are running as a drone,
    // we are in the game.

    if (!drone)
    {
        result = true;
    }

    return result;
}

// When using ticdup, certain values must be cleared out when running
// the duplicate ticcmds.

static void TicdupSquash(ticcmd_set_t *set)
{
    ticcmd_t *cmd;
    unsigned int i;

    for (i = 0; i < NET_MAXPLAYERS ; ++i)
    {
        cmd = &set->cmds[i];
        cmd->chatchar = 0;
        if (cmd->buttons & BT_SPECIAL)
            cmd->buttons = 0;
    }
}

// When running in single player mode, clear all the ingame[] array
// except the local player.

static void SinglePlayerClear(ticcmd_set_t *set)
{
    unsigned int i;

    for (i = 0; i < NET_MAXPLAYERS; ++i)
    {
        if (i != localplayer)
        {
            set->ingame[i] = false;
        }
    }
}

//
// TryRunTics
//

void TryRunTics (void)
{
    int	i;
    int	lowtic;
    int	entertic;
    static int oldentertics;
    int realtics;
    int	availabletics;
    int	counts;

    // get real tics
    entertic = I_GetTime() / ticdup;
    realtics = entertic - oldentertics;
    oldentertics = entertic;

    // in singletics mode, run a single tic every time this function
    // is called.

    if (singletics)
    {
        BuildNewTic();
    }
    else
    {
        NetUpdate ();
    }

    lowtic = GetLowTic();

    availabletics = lowtic - gametic/ticdup;

    // decide how many tics to run

    if (new_sync)
    {
	counts = availabletics;
    }
    else
    {
        // decide how many tics to run
        if (realtics < availabletics-1)
            counts = realtics+1;
        else if (realtics < availabletics)
            counts = realtics;
        else
            counts = availabletics;

        if (counts < 1)
            counts = 1;

        if (net_client_connected)
        {
            OldNetSync();
        }
    }

    if (counts < 1)
	counts = 1;

    // wait for new tics if needed

    while (!PlayersInGame() || lowtic < gametic/ticdup + counts)
    {
	NetUpdate ();

        lowtic = GetLowTic();

	if (lowtic < gametic/ticdup)
	    I_Error ("TryRunTics: lowtic < gametic");

        // Don't stay in this loop forever.  The menu is still running,
        // so return to update the screen

	if (I_GetTime() / ticdup - entertic > 0)
	{
	    return;
	}

        I_Sleep(1);
    }

    // run the count * ticdup dics
    while (counts--)
    {
        ticcmd_set_t *set;

        if (!PlayersInGame())
        {
            return;
        }

        set = &ticdata[(gametic / ticdup) % BACKUPTICS];

        if (!net_client_connected)
        {
            SinglePlayerClear(set);
        }

        // slice-5: overlay injected remote ticcmds AFTER SinglePlayerClear so
        // other peers' marines move in this peer's world (cross-peer
        // visibility). No-op in single-player (no slots ever injected).
        DGPT_OverlayRemoteCmds(set);

	for (i=0 ; i<ticdup ; i++)
	{
            if (gametic/ticdup > lowtic)
                I_Error ("gametic>lowtic");

            memcpy(local_playeringame, set->ingame, sizeof(local_playeringame));

            loop_interface->RunTic(set->cmds, set->ingame);
	    gametic++;

	    // modify command for duplicated tics

            TicdupSquash(set);
	}

	NetUpdate ();	// check for new console commands
    }
}

void D_RegisterLoopCallbacks(loop_interface_t *i)
{
    loop_interface = i;
}

// ---------------------------------------------------------------------------
// patchtogether.live slice-4 hook (dgpt_start_netgame, in
// doomgeneric_patchtogether.c) needs to set this translation unit's static
// `localplayer` + reset the lockstep tic counters when it brings up a
// netgame, because the vendored D_StartNetGame's non-ORIGCODE path hardcodes
// single-player (consoleplayer=0, num_players=1) and never runs for our
// JS-driven start path. Exposing a tiny setter keeps the lockstep state
// (localplayer / recvtic / maketic / gametic) in d_loop.c where it belongs
// rather than reaching across translation units with a header-leaked global.
//
// Always compiled (it touches no FEATURE_MULTIPLAYER-only symbols); in the
// single-player build dgpt_start_netgame simply doesn't call it.
void DGPT_LoopSetLocalPlayer(int player)
{
    int i;
    localplayer = player;
    recvtic = 0;
    maketic = 0;
    gametic = 0;
    // A fresh game starts with no remote ticcmds; clear the cross-feed table
    // so a stale ticcmd from a previous map/launch can't leak into the new
    // world before the first real injection arrives.
    for (i = 0; i < NET_MAXPLAYERS; ++i)
    {
        memset(&dgpt_remote_cmds[i], 0, sizeof(ticcmd_t));
        dgpt_remote_present[i] = false;
    }
}

// slice-5: tell the cross-feed how many slots are live this netgame, so the
// overlay keeps every remote slot in-game from tic 0 (preventing RunTic's
// quit-detection from removing a remote marine before its first ticcmd
// arrives). 1 (or 0) = single-player → cross-feed disabled.
void DGPT_LoopSetNetgamePlayers(int num_players)
{
    dgpt_netgame_players = num_players;
}

// slice-7: arm/disarm SCRIPTED lockstep mode. When armed (enabled != 0) the
// overlay drives the LOCAL slot from the injected stream too, so a harness can
// feed every sim an identical consolidated TicSet for ALL slots and prove
// bit-exact determinism. OFF by default + never armed on the live-game or
// single-player path, where the local player builds its own ticcmd.
void DGPT_LoopSetScripted(int enabled)
{
    dgpt_scripted = (enabled != 0);
}

// ---------------------------------------------------------------------------
// slice-5 cross-peer ticcmd feed: public C entry points (driven from JS via
// the dgpt_* exports in doomgeneric_patchtogether.c). See the table + rationale
// near the top of this file.

// Read THIS peer's most-recently-built local ticcmd (the input it produced for
// the latest maketic). JS broadcasts this to the other peers each tic so they
// can move this peer's marine in their own worlds. Returns 1 if a ticcmd was
// available (a level is running + at least one tic has been built), else 0
// (out args left untouched).
int DGPT_LoopReadLocalTiccmd(signed char *forwardmove,
                             signed char *sidemove,
                             short *angleturn,
                             unsigned char *buttons)
{
    ticcmd_t *cmd;
    if (maketic <= 0) return 0;
    // The latest built tic is maketic-1 (BuildNewTic increments after store).
    cmd = &ticdata[(maketic - 1) % BACKUPTICS].cmds[localplayer];
    if (forwardmove) *forwardmove = cmd->forwardmove;
    if (sidemove)    *sidemove = cmd->sidemove;
    if (angleturn)   *angleturn = cmd->angleturn;
    if (buttons)     *buttons = cmd->buttons;
    return 1;
}

// Inject a REMOTE peer's latest ticcmd, keyed by that peer's slot. Stored in
// the cross-feed side table + overlaid onto the tic set right before RunTic.
// Ignores the local slot (a peer never feeds itself) + out-of-range slots.
void DGPT_LoopInjectRemoteTiccmd(int slot,
                                 signed char forwardmove,
                                 signed char sidemove,
                                 short angleturn,
                                 unsigned char buttons)
{
    if (slot < 0 || slot >= NET_MAXPLAYERS) return;
    // In normal mode a peer never feeds its OWN slot (its local ticcmd is
    // authoritative). In scripted lockstep mode (slice 7) the harness DOES
    // inject the local slot so every sim runs an identical TicSet.
    if (slot == localplayer && !dgpt_scripted) return;
    dgpt_remote_cmds[slot].forwardmove = forwardmove;
    dgpt_remote_cmds[slot].sidemove = sidemove;
    dgpt_remote_cmds[slot].angleturn = angleturn;
    dgpt_remote_cmds[slot].buttons = buttons;
    dgpt_remote_cmds[slot].chatchar = 0;
    dgpt_remote_present[slot] = true;
}
