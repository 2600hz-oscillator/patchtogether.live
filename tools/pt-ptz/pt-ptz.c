// pt-ptz — MIDI→UVC bridge for the NexiGo P610 PTZ camera on macOS.
//
// Creates a virtual CoreMIDI destination AND source, both named "PT-PTZ", and
// bridges a tiny sysex protocol onto bare EP0 UVC class control requests. On
// macOS 26 the kernel UVC driver holds the VideoControl interface exclusively
// (USBInterfaceOpen → kIOReturnExclusiveAccess), but EP0 class requests on the
// UNOPENED interface work — GET and SET both proven on this exact stack
// (2026-08-29 hardware probe; zoom physically moved). So this file never opens
// the interface.
//
// ── Sysex framing (mirrored in packages/web/src/lib/audio/ptz-sysex.ts and
//    documented in docs/pt-ptz-midi-protocol.md — keep all three in sync) ──
//
//   F0 7D 50 54 5A <ver> <cmd> <payload…> F7
//
//   7D        experimental/educational manufacturer id
//   50 54 5A  ASCII "PTZ" tag (disambiguates from other 7D users)
//   ver       0x01
//
//   cmd, app → helper (received on the PT-PTZ destination):
//     0x01 CAPS_REQUEST   no payload
//     0x02 SET_ABS        <control> <val35>
//   cmd, helper → app (sent from the PT-PTZ source):
//     0x41 CAPS_REPLY     <count> then per control: <control> <min> <max> <res> <cur>  (each val35)
//     0x42 ERROR          <code> <ascii name…>   codes: 01 camera-absent,
//                                                        02 control-failed, 03 bad-frame
//
//   control: 0x01 pan · 0x02 tilt · 0x03 zoom
//   val35:   35-bit two's-complement integer packed into FIVE 7-bit groups,
//            least-significant group FIRST. Covers the full int32 pan/tilt
//            range the UVC PanTilt(Absolute) control carries.
//
// Behaviour:
//   - SET_ABS coalesces last-wins per control; a 30 Hz timer flushes to USB.
//   - Values clamp to the probed device ranges before writing.
//   - Camera absent: replies a named error frame (rate-limited) and keeps
//     serving; on any USB failure the device is re-resolved once, so
//     hot-unplug/replug recovers without a restart. On absent→present the
//     helper proactively sends an unsolicited CAPS_REPLY.
//
// Modes: (default) run the bridge · --probe dump caps and exit ·
//        --nudge small zoom pulse and restore (hardware smoke test) · -v verbose.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <pthread.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreMIDI/CoreMIDI.h>

#define WANT_VID 0x3443
#define WANT_PID 0x0c3d
#define CT_TERMINAL_ID 1

#define CT_ZOOM_ABS 0x0B
#define CT_PANTILT_ABS 0x0D
#define UVC_SET_CUR 0x01
#define UVC_GET_CUR 0x81
#define UVC_GET_MIN 0x82
#define UVC_GET_MAX 0x83
#define UVC_GET_RES 0x84

#define SYX_MFR 0x7D
#define SYX_VER 0x01
#define CMD_CAPS_REQUEST 0x01
#define CMD_SET_ABS 0x02
#define CMD_CAPS_REPLY 0x41
#define CMD_ERROR 0x42
#define CTL_PAN 0x01
#define CTL_TILT 0x02
#define CTL_ZOOM 0x03
#define ERR_CAMERA_ABSENT 0x01
#define ERR_CONTROL_FAILED 0x02
#define ERR_BAD_FRAME 0x03

#define FLUSH_HZ 30
#define ERROR_FRAME_MIN_INTERVAL_S 1.0
#define RERESOLVE_MIN_INTERVAL_S 1.0

static int g_verbose = 0;

typedef struct {
  int32_t min, max, res, cur;
} Range;

typedef struct {
  IOUSBDeviceInterface **dev;
  IOUSBInterfaceInterface190 **intf;
  UInt8 ifnum;
  int present;
  Range pan, tilt, zoom;
  int32_t target_pan, target_tilt, target_zoom;
  int dirty_pantilt, dirty_zoom;
  double last_error_frame_t, last_resolve_t;
} Bridge;

static Bridge g;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static MIDIClientRef g_client;
static MIDIEndpointRef g_dest, g_src;

static double now_s(void) { return (double)clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1e9; }

// ── USB layer ────────────────────────────────────────────────────────────────

static void usb_release(void) {
  if (g.intf) { (*g.intf)->Release(g.intf); g.intf = NULL; }
  if (g.dev) { (*g.dev)->Release(g.dev); g.dev = NULL; }
  g.present = 0;
}

static int usb_resolve(void) {
  usb_release();
  io_iterator_t it;
  if (IOServiceGetMatchingServices(kIOMainPortDefault,
        IOServiceMatching("IOUSBHostDevice"), &it) != KERN_SUCCESS)
    return 0;
  io_service_t svc;
  IOUSBDeviceInterface **dev = NULL;
  while ((svc = IOIteratorNext(it))) {
    CFNumberRef v = IORegistryEntryCreateCFProperty(svc, CFSTR("idVendor"), NULL, 0);
    CFNumberRef p = IORegistryEntryCreateCFProperty(svc, CFSTR("idProduct"), NULL, 0);
    int vid = 0, pid = 0;
    if (v) { CFNumberGetValue(v, kCFNumberIntType, &vid); CFRelease(v); }
    if (p) { CFNumberGetValue(p, kCFNumberIntType, &pid); CFRelease(p); }
    if (vid == WANT_VID && pid == WANT_PID) {
      SInt32 score; IOCFPlugInInterface **plug = NULL;
      IOCreatePlugInInterfaceForService(svc, kIOUSBDeviceUserClientTypeID,
                                        kIOCFPlugInInterfaceID, &plug, &score);
      if (plug) {
        (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&dev);
        IODestroyPlugInInterface(plug);
      }
      IOObjectRelease(svc);
      break;
    }
    IOObjectRelease(svc);
  }
  IOObjectRelease(it);
  if (!dev) return 0;

  IOUSBFindInterfaceRequest fr = { 0x0e, 0x01, kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare };
  io_iterator_t iit;
  if ((*dev)->CreateInterfaceIterator(dev, &fr, &iit) != kIOReturnSuccess) {
    (*dev)->Release(dev); return 0;
  }
  io_service_t isvc = IOIteratorNext(iit);
  IOObjectRelease(iit);
  if (!isvc) { (*dev)->Release(dev); return 0; }

  SInt32 score; IOCFPlugInInterface **iplug = NULL;
  IOCreatePlugInInterfaceForService(isvc, kIOUSBInterfaceUserClientTypeID,
                                    kIOCFPlugInInterfaceID, &iplug, &score);
  IOObjectRelease(isvc);
  if (!iplug) { (*dev)->Release(dev); return 0; }
  IOUSBInterfaceInterface190 **intf = NULL;
  (*iplug)->QueryInterface(iplug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID190), (LPVOID *)&intf);
  IODestroyPlugInInterface(iplug);
  if (!intf) { (*dev)->Release(dev); return 0; }

  UInt8 ifnum = 0;
  (*intf)->GetInterfaceNumber(intf, &ifnum);
  // Deliberately NOT USBInterfaceOpen'd — see header comment.
  g.dev = dev; g.intf = intf; g.ifnum = ifnum;
  return 1;
}

static IOReturn uvc_req(UInt8 bRequest, UInt8 selector, void *data, UInt16 len, int in) {
  if (!g.intf) return kIOReturnNoDevice;
  IOUSBDevRequest req;
  req.bmRequestType = in ? 0xA1 : 0x21;
  req.bRequest = bRequest;
  req.wValue = (UInt16)(selector << 8);
  req.wIndex = (UInt16)((CT_TERMINAL_ID << 8) | g.ifnum);
  req.wLength = len;
  req.pData = data;
  return (*g.intf)->ControlRequest(g.intf, 0, &req);
}

static int32_t rd_i32le(const uint8_t *b) {
  return (int32_t)((uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24));
}
static void wr_i32le(uint8_t *b, int32_t v) {
  uint32_t u = (uint32_t)v;
  b[0] = u & 0xff; b[1] = (u >> 8) & 0xff; b[2] = (u >> 16) & 0xff; b[3] = (u >> 24) & 0xff;
}

static int probe_caps_locked(void) {
  uint8_t z[2], pt[8];
  struct { UInt8 req; Range *zr; int32_t *pv, *tv; } rows[4] = {
    { UVC_GET_MIN, NULL, NULL, NULL }, { UVC_GET_MAX, NULL, NULL, NULL },
    { UVC_GET_RES, NULL, NULL, NULL }, { UVC_GET_CUR, NULL, NULL, NULL },
  };
  int32_t *zslots[4] = { &g.zoom.min, &g.zoom.max, &g.zoom.res, &g.zoom.cur };
  int32_t *pslots[4] = { &g.pan.min, &g.pan.max, &g.pan.res, &g.pan.cur };
  int32_t *tslots[4] = { &g.tilt.min, &g.tilt.max, &g.tilt.res, &g.tilt.cur };
  for (int i = 0; i < 4; i++) {
    if (uvc_req(rows[i].req, CT_ZOOM_ABS, z, 2, 1) != kIOReturnSuccess) return 0;
    *zslots[i] = (int32_t)(z[0] | (z[1] << 8));
    if (uvc_req(rows[i].req, CT_PANTILT_ABS, pt, 8, 1) != kIOReturnSuccess) return 0;
    *pslots[i] = rd_i32le(pt);
    *tslots[i] = rd_i32le(pt + 4);
  }
  g.target_pan = g.pan.cur; g.target_tilt = g.tilt.cur; g.target_zoom = g.zoom.cur;
  return 1;
}

static int ensure_camera_locked(void) {
  if (g.present) return 1;
  double t = now_s();
  if (t - g.last_resolve_t < RERESOLVE_MIN_INTERVAL_S) return 0;
  g.last_resolve_t = t;
  if (usb_resolve() && probe_caps_locked()) {
    g.present = 1;
    return 1;
  }
  usb_release();
  return 0;
}

static int32_t clampi(int32_t v, int32_t lo, int32_t hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Returns kIOReturnSuccess or the failing code after one re-resolve retry.
static IOReturn uvc_set_retry_locked(UInt8 selector, void *data, UInt16 len) {
  IOReturn kr = uvc_req(UVC_SET_CUR, selector, data, len, 0);
  if (kr == kIOReturnSuccess) return kr;
  g.present = 0;
  g.last_resolve_t = 0; // failure is fresh evidence — allow an immediate retry
  if (!ensure_camera_locked()) return kr;
  return uvc_req(UVC_SET_CUR, selector, data, len, 0);
}

// ── sysex encode/decode ─────────────────────────────────────────────────────

static void put_val35(uint8_t *b, int64_t v) {
  uint64_t u = (uint64_t)v & 0x7FFFFFFFFULL;
  for (int i = 0; i < 5; i++) b[i] = (u >> (7 * i)) & 0x7F;
}
static int64_t get_val35(const uint8_t *b) {
  uint64_t u = 0;
  for (int i = 0; i < 5; i++) u |= (uint64_t)(b[i] & 0x7F) << (7 * i);
  if (u & (1ULL << 34)) return (int64_t)u - (1LL << 35);
  return (int64_t)u;
}

static void midi_send(const uint8_t *bytes, size_t len) {
  uint8_t buf[512];
  MIDIPacketList *pl = (MIDIPacketList *)buf;
  MIDIPacket *pkt = MIDIPacketListInit(pl);
  pkt = MIDIPacketListAdd(pl, sizeof(buf), pkt, 0, len, bytes);
  if (pkt) MIDIReceived(g_src, pl);
}

static size_t frame_header(uint8_t *f, uint8_t cmd) {
  f[0] = 0xF0; f[1] = SYX_MFR; f[2] = 'P'; f[3] = 'T'; f[4] = 'Z';
  f[5] = SYX_VER; f[6] = cmd;
  return 7;
}

static void send_error_frame(uint8_t code, const char *name, int rate_limited) {
  double t = now_s();
  if (rate_limited && t - g.last_error_frame_t < ERROR_FRAME_MIN_INTERVAL_S) return;
  g.last_error_frame_t = t;
  uint8_t f[64];
  size_t n = frame_header(f, CMD_ERROR);
  f[n++] = code;
  for (const char *c = name; *c && n < sizeof(f) - 1; c++) f[n++] = (uint8_t)(*c & 0x7F);
  f[n++] = 0xF7;
  midi_send(f, n);
  fprintf(stderr, "pt-ptz: error frame sent: %s\n", name);
}

static void send_caps_reply_locked(void) {
  uint8_t f[128];
  size_t n = frame_header(f, CMD_CAPS_REPLY);
  f[n++] = 3;
  struct { uint8_t id; Range *r; } rows[3] = {
    { CTL_PAN, &g.pan }, { CTL_TILT, &g.tilt }, { CTL_ZOOM, &g.zoom },
  };
  for (int i = 0; i < 3; i++) {
    f[n++] = rows[i].id;
    put_val35(f + n, rows[i].r->min); n += 5;
    put_val35(f + n, rows[i].r->max); n += 5;
    put_val35(f + n, rows[i].r->res); n += 5;
    put_val35(f + n, rows[i].r->cur); n += 5;
  }
  f[n++] = 0xF7;
  midi_send(f, n);
  if (g_verbose) fprintf(stderr, "pt-ptz: caps reply sent\n");
}

// ── inbound frame handling (runs on the CoreMIDI thread) ────────────────────

static void handle_frame(const uint8_t *p, size_t len) {
  if (len < 7 || p[0] != 0xF0 || p[1] != SYX_MFR || p[2] != 'P' || p[3] != 'T' ||
      p[4] != 'Z')
    return; // not ours — ignore silently (other 7D traffic is legal)
  if (p[5] != SYX_VER) { send_error_frame(ERR_BAD_FRAME, "bad-frame", 0); return; }
  uint8_t cmd = p[6];
  const uint8_t *pay = p + 7;
  size_t paylen = len - 8; // minus header and trailing F7

  pthread_mutex_lock(&g_lock);
  if (cmd == CMD_CAPS_REQUEST) {
    if (ensure_camera_locked()) {
      // Refresh CUR so the app maps from the camera's real position.
      if (!probe_caps_locked()) {
        g.present = 0;
        send_error_frame(ERR_CAMERA_ABSENT, "camera-absent", 0);
      } else {
        send_caps_reply_locked();
      }
    } else {
      send_error_frame(ERR_CAMERA_ABSENT, "camera-absent", 0);
    }
  } else if (cmd == CMD_SET_ABS) {
    if (paylen != 6) {
      send_error_frame(ERR_BAD_FRAME, "bad-frame", 1);
    } else {
      int64_t v = get_val35(pay + 1);
      switch (pay[0]) {
        case CTL_PAN: g.target_pan = (int32_t)v; g.dirty_pantilt = 1; break;
        case CTL_TILT: g.target_tilt = (int32_t)v; g.dirty_pantilt = 1; break;
        case CTL_ZOOM: g.target_zoom = (int32_t)v; g.dirty_zoom = 1; break;
        default: send_error_frame(ERR_BAD_FRAME, "bad-frame", 1);
      }
    }
  } else {
    send_error_frame(ERR_BAD_FRAME, "bad-frame", 1);
  }
  pthread_mutex_unlock(&g_lock);
}

static uint8_t g_syx[256];
static size_t g_syx_len;
static int g_in_syx;

static void read_proc(const MIDIPacketList *pktlist, void *ref, void *conn) {
  const MIDIPacket *pkt = &pktlist->packet[0];
  for (UInt32 i = 0; i < pktlist->numPackets; i++) {
    for (UInt16 j = 0; j < pkt->length; j++) {
      uint8_t b = pkt->data[j];
      if (b == 0xF0) { g_in_syx = 1; g_syx_len = 0; g_syx[g_syx_len++] = b; }
      else if (!g_in_syx) continue;
      else if (b == 0xF7) {
        if (g_syx_len < sizeof(g_syx)) { g_syx[g_syx_len++] = b; handle_frame(g_syx, g_syx_len); }
        g_in_syx = 0;
      } else if (b >= 0xF8) continue; // realtime may interleave sysex
      else if (b & 0x80) g_in_syx = 0; // aborted by another status byte
      else if (g_syx_len < sizeof(g_syx)) g_syx[g_syx_len++] = b;
      else g_in_syx = 0; // oversized — drop
    }
    pkt = MIDIPacketNext(pkt);
  }
}

// ── 30 Hz flush timer (runs on the main runloop) ────────────────────────────

static void flush_timer(CFRunLoopTimerRef timer, void *info) {
  pthread_mutex_lock(&g_lock);
  if ((g.dirty_pantilt || g.dirty_zoom) && !ensure_camera_locked()) {
    g.dirty_pantilt = g.dirty_zoom = 0; // drop rather than queue against a dead camera
    send_error_frame(ERR_CAMERA_ABSENT, "camera-absent", 1);
    pthread_mutex_unlock(&g_lock);
    return;
  }
  if (g.dirty_pantilt) {
    g.dirty_pantilt = 0;
    int32_t pan = clampi(g.target_pan, g.pan.min, g.pan.max);
    int32_t tilt = clampi(g.target_tilt, g.tilt.min, g.tilt.max);
    uint8_t pt[8];
    wr_i32le(pt, pan); wr_i32le(pt + 4, tilt);
    IOReturn kr = uvc_set_retry_locked(CT_PANTILT_ABS, pt, 8);
    if (kr != kIOReturnSuccess) {
      send_error_frame(g.present ? ERR_CONTROL_FAILED : ERR_CAMERA_ABSENT,
                       g.present ? "control-failed" : "camera-absent", 1);
    } else {
      g.pan.cur = pan; g.tilt.cur = tilt;
      if (g_verbose) fprintf(stderr, "pt-ptz: pantilt -> %d,%d\n", pan, tilt);
    }
  }
  if (g.dirty_zoom) {
    g.dirty_zoom = 0;
    int32_t zoom = clampi(g.target_zoom, g.zoom.min, g.zoom.max);
    uint8_t z[2] = { (uint8_t)(zoom & 0xff), (uint8_t)((zoom >> 8) & 0xff) };
    IOReturn kr = uvc_set_retry_locked(CT_ZOOM_ABS, z, 2);
    if (kr != kIOReturnSuccess) {
      send_error_frame(g.present ? ERR_CONTROL_FAILED : ERR_CAMERA_ABSENT,
                       g.present ? "control-failed" : "camera-absent", 1);
    } else {
      g.zoom.cur = zoom;
      if (g_verbose) fprintf(stderr, "pt-ptz: zoom -> %d\n", zoom);
    }
  }
  pthread_mutex_unlock(&g_lock);
}

static int g_announced_present = -1;

// Absent→present recovery notice: poll cheaply; announce with unsolicited caps.
static void presence_timer(CFRunLoopTimerRef timer, void *info) {
  pthread_mutex_lock(&g_lock);
  if (!g.present) ensure_camera_locked();
  if (g.present != g_announced_present) {
    if (g.present) {
      fprintf(stderr, "pt-ptz: camera bound (pan %d..%d, tilt %d..%d, zoom %d..%d)\n",
              g.pan.min, g.pan.max, g.tilt.min, g.tilt.max, g.zoom.min, g.zoom.max);
      send_caps_reply_locked();
    } else {
      fprintf(stderr, "pt-ptz: camera ABSENT — will keep looking (plug in the NexiGo P610)\n");
    }
    g_announced_present = g.present;
  }
  pthread_mutex_unlock(&g_lock);
}

// ── modes ───────────────────────────────────────────────────────────────────

static void print_caps(void) {
  printf("NexiGo P610 (%04x:%04x) VideoControl if=%d terminal=%d\n",
         WANT_VID, WANT_PID, g.ifnum, CT_TERMINAL_ID);
  printf("  pan : min %d max %d res %d cur %d\n", g.pan.min, g.pan.max, g.pan.res, g.pan.cur);
  printf("  tilt: min %d max %d res %d cur %d\n", g.tilt.min, g.tilt.max, g.tilt.res, g.tilt.cur);
  printf("  zoom: min %d max %d res %d cur %d\n", g.zoom.min, g.zoom.max, g.zoom.res, g.zoom.cur);
}

static int mode_probe(void) {
  pthread_mutex_lock(&g_lock);
  int ok = ensure_camera_locked();
  pthread_mutex_unlock(&g_lock);
  if (!ok) { fprintf(stderr, "pt-ptz: camera not found (%04x:%04x)\n", WANT_VID, WANT_PID); return 1; }
  print_caps();
  return 0;
}

static int mode_nudge(void) {
  if (mode_probe()) return 1;
  int32_t restore = g.zoom.cur;
  int32_t step = g.zoom.res > 0 ? g.zoom.res : 1;
  int32_t target = clampi(restore + 200 * step, g.zoom.min, g.zoom.max);
  if (target == restore) target = clampi(restore - 200 * step, g.zoom.min, g.zoom.max);
  printf("nudge: zoom %d -> %d ... ", restore, target);
  uint8_t z[2] = { (uint8_t)(target & 0xff), (uint8_t)((target >> 8) & 0xff) };
  pthread_mutex_lock(&g_lock);
  IOReturn kr = uvc_set_retry_locked(CT_ZOOM_ABS, z, 2);
  pthread_mutex_unlock(&g_lock);
  printf("0x%08x\n", kr);
  if (kr != kIOReturnSuccess) return 1;
  sleep(2);
  printf("nudge: restore zoom -> %d ... ", restore);
  z[0] = (uint8_t)(restore & 0xff); z[1] = (uint8_t)((restore >> 8) & 0xff);
  pthread_mutex_lock(&g_lock);
  kr = uvc_set_retry_locked(CT_ZOOM_ABS, z, 2);
  pthread_mutex_unlock(&g_lock);
  printf("0x%08x\n", kr);
  return kr == kIOReturnSuccess ? 0 : 1;
}

static int mode_run(void) {
  OSStatus st = MIDIClientCreate(CFSTR("pt-ptz"), NULL, NULL, &g_client);
  if (st != noErr) { fprintf(stderr, "pt-ptz: MIDIClientCreate failed: %d\n", (int)st); return 1; }
  st = MIDIDestinationCreate(g_client, CFSTR("PT-PTZ"), read_proc, NULL, &g_dest);
  if (st != noErr) { fprintf(stderr, "pt-ptz: MIDIDestinationCreate failed: %d\n", (int)st); return 1; }
  st = MIDISourceCreate(g_client, CFSTR("PT-PTZ"), &g_src);
  if (st != noErr) { fprintf(stderr, "pt-ptz: MIDISourceCreate failed: %d\n", (int)st); return 1; }

  fprintf(stderr, "pt-ptz: virtual MIDI destination + source \"PT-PTZ\" up\n");
  pthread_mutex_lock(&g_lock);
  if (ensure_camera_locked())
    fprintf(stderr, "pt-ptz: camera bound (pan %d..%d, tilt %d..%d, zoom %d..%d)\n",
            g.pan.min, g.pan.max, g.tilt.min, g.tilt.max, g.zoom.min, g.zoom.max);
  else
    fprintf(stderr, "pt-ptz: camera ABSENT — serving anyway; will bind when it appears\n");
  g_announced_present = g.present;
  pthread_mutex_unlock(&g_lock);

  CFRunLoopTimerRef flush = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent(),
      1.0 / FLUSH_HZ, 0, 0, flush_timer, NULL);
  CFRunLoopAddTimer(CFRunLoopGetCurrent(), flush, kCFRunLoopDefaultMode);
  CFRunLoopTimerRef presence = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + 2.0,
      2.0, 0, 0, presence_timer, NULL);
  CFRunLoopAddTimer(CFRunLoopGetCurrent(), presence, kCFRunLoopDefaultMode);
  CFRunLoopRun();
  return 0;
}

int main(int argc, char **argv) {
  int probe = 0, nudge = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--probe")) probe = 1;
    else if (!strcmp(argv[i], "--nudge")) nudge = 1;
    else if (!strcmp(argv[i], "-v")) g_verbose = 1;
    else {
      fprintf(stderr, "usage: pt-ptz [--probe|--nudge] [-v]\n");
      return 2;
    }
  }
  if (probe) return mode_probe();
  if (nudge) return mode_nudge();
  return mode_run();
}
