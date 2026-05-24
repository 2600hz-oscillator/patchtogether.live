/*
 * dummy.c
 *
 *  Created on: 16.02.2015
 *      Author: Florian
 */


/*---------------------------------------------------------------------*
 *  include files                                                      *
 *---------------------------------------------------------------------*/

#include "doomtype.h"

/*---------------------------------------------------------------------*
 *  local definitions                                                  *
 *---------------------------------------------------------------------*/

/*---------------------------------------------------------------------*
 *  external declarations                                              *
 *---------------------------------------------------------------------*/

/*---------------------------------------------------------------------*
 *  public data                                                        *
 *---------------------------------------------------------------------*/

// These are the single-player stand-ins for two globals that the real
// chocolate-doom networking code (net_client.c) owns. When the
// multiplayer build links net_client.c, IT provides the real
// definitions, so we must NOT define them here too (duplicate symbol).
// In the default single-player build, net_client.c's translation unit
// has no externally-referenced symbols and is dropped, so these stubs
// remain the sole definitions — exactly as before this slice.
#ifndef FEATURE_MULTIPLAYER

boolean net_client_connected = false;

boolean drone = false;

#endif

/*---------------------------------------------------------------------*
 *  private data                                                       *
 *---------------------------------------------------------------------*/

/*---------------------------------------------------------------------*
 *  private functions                                                  *
 *---------------------------------------------------------------------*/

/*---------------------------------------------------------------------*
 *  public functions                                                   *
 *---------------------------------------------------------------------*/

#ifndef FEATURE_SOUND

void I_InitTimidityConfig(void)
{
}

#endif

/*---------------------------------------------------------------------*
 *  eof                                                                *
 *---------------------------------------------------------------------*/
