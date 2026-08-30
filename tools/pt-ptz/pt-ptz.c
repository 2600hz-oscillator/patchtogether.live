// pt-ptz — MIDI→UVC bridge for PTZ cameras on macOS. Multi-device.
//
// Enumerates every UVC camera whose CameraTerminal declares a PTZ control bit
// and creates one virtual CoreMIDI destination + source pair per camera, named
// "PT-PTZ-<SHORTNAME>". Per-device VideoControl interface number and camera
// terminal id are resolved from the config descriptor — nothing is hardcoded
// to one model. On macOS 26 the kernel UVC driver holds the VideoControl
// interface exclusively (USBInterfaceOpen → kIOReturnExclusiveAccess), but
// bare EP0 class requests on the UNOPENED interface work — GET and SET proven
// on both the NexiGo P610 (absolute pan/tilt/zoom) and the Logitech PTZ Pro 2
// (absolute zoom + RELATIVE/velocity pan-tilt, fixed speed 1..1) 2026-08-29.
//
// ── Sysex framing v2 (mirrored in packages/web/src/lib/audio/ptz-sysex.ts and
//    documented in docs/pt-ptz-midi-protocol.md — keep all three in sync) ──
//
//   F0 7D 50 54 5A <ver=02> <cmd> <payload…> F7
//
//   cmd, app → helper (received on that camera's PT-PTZ-* destination):
//     0x01 CAPS_REQUEST   no payload
//     0x02 SET_ABS        <control> <val35>          absolute-mode axes only
//     0x03 SET_VEL        <control> <val35 signed>   velocity-mode axes; the
//                          sign is direction, |v| clamps into the device speed
//                          range; 0 is an explicit STOP. Streaming the same
//                          value refreshes the stage-safety watchdog.
//     0x04 STOP_ALL       no payload — halt all velocity motion now
//   cmd, helper → app (sent from that camera's PT-PTZ-* source):
//     0x41 CAPS_REPLY     <count> then per control: <control> <mode> where
//                          mode 01 = absolute, followed by min max res cur
//                          mode 02 = velocity, followed by smin smax sres
//                          mode 00 = none, no payload
//     0x42 ERROR          <code> <ascii name…>   codes: 01 camera-absent,
//                                                 02 control-failed, 03 bad-frame
//
//   control: 0x01 pan · 0x02 tilt · 0x03 zoom
//   val35:   35-bit two's-complement packed into FIVE 7-bit groups, LSB first.
//
// ── STAGE-SAFETY WATCHDOG (velocity axes) ──
// A velocity command physically keeps the head moving until a stop arrives, so
// a crashed page must never be able to leave a camera panning mid-set:
//   - the module streams SET_VEL while nonzero; every received SET_VEL
//     refreshes the watchdog;
//   - if a moving axis gets no refresh for VEL_WATCHDOG_S (~250 ms) the helper
//     sends STOP itself and logs it;
//   - STOP_ALL, SIGINT/SIGTERM/atexit, and re-resolve failure all stop motion.
//
// Modes: (default) run the bridge · --probe dump all cameras' caps and exit ·
//        --nudge per-camera small zoom pulse and restore · -v verbose.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <unistd.h>
#include <stdint.h>
#include <signal.h>
#include <pthread.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreMIDI/CoreMIDI.h>

#define CT_ZOOM_ABS 0x0B
#define CT_PANTILT_ABS 0x0D
#define CT_PANTILT_REL 0x0E
#define UVC_SET_CUR 0x01
#define UVC_GET_CUR 0x81
#define UVC_GET_MIN 0x82
#define UVC_GET_MAX 0x83
#define UVC_GET_RES 0x84

#define BIT_ZOOM_ABS 9
#define BIT_PANTILT_ABS 11
#define BIT_PANTILT_REL 12

#define SYX_MFR 0x7D
#define SYX_VER 0x02
#define CMD_CAPS_REQUEST 0x01
#define CMD_SET_ABS 0x02
#define CMD_SET_VEL 0x03
#define CMD_STOP_ALL 0x04
#define CMD_CAPS_REPLY 0x41
#define CMD_ERROR 0x42
#define CTL_PAN 0x01
#define CTL_TILT 0x02
#define CTL_ZOOM 0x03
#define MODE_NONE 0x00
#define MODE_ABS 0x01
#define MODE_VEL 0x02
#define ERR_CAMERA_ABSENT 0x01
#define ERR_CONTROL_FAILED 0x02
#define ERR_BAD_FRAME 0x03

#define FLUSH_HZ 30
#define VEL_WATCHDOG_S 0.25
#define ERROR_FRAME_MIN_INTERVAL_S 1.0
#define RERESOLVE_MIN_INTERVAL_S 1.0
#define MAX_CAMS 4

static int g_verbose = 0;

typedef struct {
  uint8_t mode;
  int32_t min, max, res, cur;    // absolute
  int32_t smin, smax, sres;      // velocity speed range
} Axis;

typedef struct {
  int used;
  int vid, pid;
  char name[64];
  char portname[32];
  IOUSBDeviceInterface **dev;
  IOUSBInterfaceInterface190 **intf;
  UInt8 ifnum, terminal;
  int present;
  Axis pan, tilt, zoom;
  int32_t tgt_pan, tgt_tilt, tgt_zoom;
  int dirty_pantilt, dirty_zoom;
  int32_t vel_pan, vel_tilt;
  int vel_dirty, vel_moving;
  double vel_last_refresh;
  double last_error_frame_t, last_resolve_t;
  MIDIEndpointRef dest, src;
  uint8_t syx[256];
  size_t syx_len;
  int in_syx;
  int announced_present;
} Cam;

static Cam g_cams[MAX_CAMS];
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static MIDIClientRef g_client;

static double now_s(void) { return (double)clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1e9; }

static int32_t clampi(int32_t v, int32_t lo, int32_t hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
static int32_t rd_i32le(const uint8_t *b) {
  return (int32_t)((uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24));
}
static void wr_i32le(uint8_t *b, int32_t v) {
  uint32_t u = (uint32_t)v;
  b[0] = u & 0xff; b[1] = (u >> 8) & 0xff; b[2] = (u >> 16) & 0xff; b[3] = (u >> 24) & 0xff;
}

// ── USB descriptor walk: is this device a PTZ camera, and where? ────────────

typedef struct {
  int is_ptz;
  UInt8 ifnum, terminal;
  int has_zoom_abs, has_pt_abs, has_pt_rel;
} PtzInfo;

static PtzInfo parse_config(IOUSBDeviceInterface **dev) {
  PtzInfo info = {0, 0, 0, 0, 0, 0};
  IOUSBConfigurationDescriptorPtr cfg = NULL;
  if ((*dev)->GetConfigurationDescriptorPtr(dev, 0, &cfg) != KERN_SUCCESS || !cfg) return info;
  unsigned char *buf = (unsigned char *)cfg;
  int total = buf[2] | (buf[3] << 8);
  int in_vc = 0;
  UInt8 cur_if = 0;
  for (int off = 0; off + 2 <= total && buf[off] > 0; off += buf[off]) {
    unsigned char len = buf[off], type = buf[off + 1];
    if (type == 0x04 && off + 8 < total) {
      in_vc = (buf[off + 5] == 0x0e && buf[off + 6] == 0x01);
      cur_if = buf[off + 2];
    } else if (in_vc && type == 0x24 && buf[off + 2] == 0x02 && off + 8 < total && len >= 15) {
      int ttype = buf[off + 4] | (buf[off + 5] << 8);
      if (ttype != 0x0201) continue; // ITT_CAMERA only
      int csize = buf[off + 14];
      uint32_t bits = 0;
      for (int i = 0; i < csize && i < 4 && off + 15 + i < total; i++)
        bits |= (uint32_t)buf[off + 15 + i] << (8 * i);
      int za = (bits >> BIT_ZOOM_ABS) & 1;
      int pa = (bits >> BIT_PANTILT_ABS) & 1;
      int pr = (bits >> BIT_PANTILT_REL) & 1;
      if (za || pa || pr) {
        info.is_ptz = 1;
        info.ifnum = cur_if;
        info.terminal = buf[off + 3];
        info.has_zoom_abs = za;
        info.has_pt_abs = pa;
        info.has_pt_rel = pr;
        return info;
      }
    }
  }
  return info;
}

static void make_shortname(const char *product, int index, char *out, size_t outlen) {
  size_t n = 0;
  for (const char *c = product; *c && n < outlen - 1 && n < 8; c++) {
    if (isalnum((unsigned char)*c)) out[n++] = (char)toupper((unsigned char)*c);
  }
  if (n == 0) n = (size_t)snprintf(out, outlen, "CAM%d", index);
  out[n] = 0;
  for (int i = 0; i < MAX_CAMS; i++) {
    if (g_cams[i].used && strstr(g_cams[i].portname, out) &&
        strlen(g_cams[i].portname) == strlen("PT-PTZ-") + strlen(out)) {
      snprintf(out + strlen(out), outlen - strlen(out), "%d", index);
      break;
    }
  }
}

// ── per-camera USB plumbing ─────────────────────────────────────────────────

static void cam_release_usb(Cam *c) {
  if (c->intf) { (*c->intf)->Release(c->intf); c->intf = NULL; }
  if (c->dev) { (*c->dev)->Release(c->dev); c->dev = NULL; }
  c->present = 0;
}

static IOReturn cam_req(Cam *c, UInt8 bRequest, UInt8 selector, void *data, UInt16 len, int in) {
  if (!c->intf) return kIOReturnNoDevice;
  IOUSBDevRequest req;
  req.bmRequestType = in ? 0xA1 : 0x21;
  req.bRequest = bRequest;
  req.wValue = (UInt16)(selector << 8);
  req.wIndex = (UInt16)((c->terminal << 8) | c->ifnum);
  req.wLength = len;
  req.pData = data;
  return (*c->intf)->ControlRequest(c->intf, 0, &req);
}

static int cam_probe_caps(Cam *c) {
  const UInt8 reqs[4] = { UVC_GET_MIN, UVC_GET_MAX, UVC_GET_RES, UVC_GET_CUR };
  if (c->zoom.mode == MODE_ABS) {
    uint8_t z[2];
    int32_t *slots[4] = { &c->zoom.min, &c->zoom.max, &c->zoom.res, &c->zoom.cur };
    for (int i = 0; i < 4; i++) {
      if (cam_req(c, reqs[i], CT_ZOOM_ABS, z, 2, 1) != kIOReturnSuccess) return 0;
      *slots[i] = (int32_t)(z[0] | (z[1] << 8));
    }
    c->tgt_zoom = c->zoom.cur;
  }
  if (c->pan.mode == MODE_ABS) {
    uint8_t pt[8];
    int32_t *pslots[4] = { &c->pan.min, &c->pan.max, &c->pan.res, &c->pan.cur };
    int32_t *tslots[4] = { &c->tilt.min, &c->tilt.max, &c->tilt.res, &c->tilt.cur };
    for (int i = 0; i < 4; i++) {
      if (cam_req(c, reqs[i], CT_PANTILT_ABS, pt, 8, 1) != kIOReturnSuccess) return 0;
      *pslots[i] = rd_i32le(pt);
      *tslots[i] = rd_i32le(pt + 4);
    }
    c->tgt_pan = c->pan.cur;
    c->tgt_tilt = c->tilt.cur;
  } else if (c->pan.mode == MODE_VEL) {
    uint8_t b[4];
    struct { UInt8 req; int idx; } rows[3] = { { UVC_GET_MIN, 0 }, { UVC_GET_MAX, 1 }, { UVC_GET_RES, 2 } };
    int32_t *pv[3] = { &c->pan.smin, &c->pan.smax, &c->pan.sres };
    int32_t *tv[3] = { &c->tilt.smin, &c->tilt.smax, &c->tilt.sres };
    for (int i = 0; i < 3; i++) {
      if (cam_req(c, rows[i].req, CT_PANTILT_REL, b, 4, 1) != kIOReturnSuccess) return 0;
      *pv[i] = b[1];
      *tv[i] = b[3];
    }
    if (c->pan.smax < 1) c->pan.smax = 1;
    if (c->tilt.smax < 1) c->tilt.smax = 1;
  }
  return 1;
}

static IOUSBDeviceInterface **open_device_com(io_service_t svc) {
  SInt32 score;
  IOCFPlugInInterface **plug = NULL;
  IOUSBDeviceInterface **dev = NULL;
  if (IOCreatePlugInInterfaceForService(svc, kIOUSBDeviceUserClientTypeID,
        kIOCFPlugInInterfaceID, &plug, &score) != KERN_SUCCESS || !plug)
    return NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&dev);
  IODestroyPlugInInterface(plug);
  return dev;
}

static IOUSBInterfaceInterface190 **open_vc_interface(IOUSBDeviceInterface **dev, UInt8 want_ifnum, UInt8 *out_ifnum) {
  IOUSBFindInterfaceRequest fr = { 0x0e, 0x01, kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare };
  io_iterator_t iit;
  if ((*dev)->CreateInterfaceIterator(dev, &fr, &iit) != kIOReturnSuccess) return NULL;
  io_service_t isvc;
  IOUSBInterfaceInterface190 **found = NULL;
  while ((isvc = IOIteratorNext(iit))) {
    SInt32 score;
    IOCFPlugInInterface **iplug = NULL;
    IOCreatePlugInInterfaceForService(isvc, kIOUSBInterfaceUserClientTypeID,
                                      kIOCFPlugInInterfaceID, &iplug, &score);
    IOObjectRelease(isvc);
    if (!iplug) continue;
    IOUSBInterfaceInterface190 **intf = NULL;
    (*iplug)->QueryInterface(iplug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID190), (LPVOID *)&intf);
    IODestroyPlugInInterface(iplug);
    if (!intf) continue;
    UInt8 n = 0;
    (*intf)->GetInterfaceNumber(intf, &n);
    if (n == want_ifnum) { *out_ifnum = n; found = intf; break; }
    (*intf)->Release(intf);
  }
  IOObjectRelease(iit);
  // Deliberately NOT USBInterfaceOpen'd — see header comment.
  return found;
}

// Attach USB handles for cam c matching its vid/pid. Returns 1 on success.
static int cam_resolve_usb(Cam *c) {
  cam_release_usb(c);
  io_iterator_t it;
  if (IOServiceGetMatchingServices(kIOMainPortDefault,
        IOServiceMatching("IOUSBHostDevice"), &it) != KERN_SUCCESS)
    return 0;
  io_service_t svc;
  while ((svc = IOIteratorNext(it))) {
    CFNumberRef v = IORegistryEntryCreateCFProperty(svc, CFSTR("idVendor"), NULL, 0);
    CFNumberRef p = IORegistryEntryCreateCFProperty(svc, CFSTR("idProduct"), NULL, 0);
    int vid = 0, pid = 0;
    if (v) { CFNumberGetValue(v, kCFNumberIntType, &vid); CFRelease(v); }
    if (p) { CFNumberGetValue(p, kCFNumberIntType, &pid); CFRelease(p); }
    if (vid != c->vid || pid != c->pid) { IOObjectRelease(svc); continue; }
    IOUSBDeviceInterface **dev = open_device_com(svc);
    IOObjectRelease(svc);
    if (!dev) break;
    PtzInfo info = parse_config(dev);
    if (!info.is_ptz) { (*dev)->Release(dev); break; }
    UInt8 ifnum = 0;
    IOUSBInterfaceInterface190 **intf = open_vc_interface(dev, info.ifnum, &ifnum);
    if (!intf) { (*dev)->Release(dev); break; }
    c->dev = dev;
    c->intf = intf;
    c->ifnum = ifnum;
    c->terminal = info.terminal;
    IOObjectRelease(it);
    return 1;
  }
  IOObjectRelease(it);
  return 0;
}

static int cam_ensure_locked(Cam *c) {
  if (c->present) return 1;
  double t = now_s();
  if (t - c->last_resolve_t < RERESOLVE_MIN_INTERVAL_S) return 0;
  c->last_resolve_t = t;
  if (cam_resolve_usb(c) && cam_probe_caps(c)) {
    c->present = 1;
    return 1;
  }
  cam_release_usb(c);
  return 0;
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

static void midi_send(Cam *c, const uint8_t *bytes, size_t len) {
  uint8_t buf[512];
  MIDIPacketList *pl = (MIDIPacketList *)buf;
  MIDIPacket *pkt = MIDIPacketListInit(pl);
  pkt = MIDIPacketListAdd(pl, sizeof(buf), pkt, 0, len, bytes);
  if (pkt) MIDIReceived(c->src, pl);
}

static size_t frame_header(uint8_t *f, uint8_t cmd) {
  f[0] = 0xF0; f[1] = SYX_MFR; f[2] = 'P'; f[3] = 'T'; f[4] = 'Z';
  f[5] = SYX_VER; f[6] = cmd;
  return 7;
}

static void send_error_frame(Cam *c, uint8_t code, const char *name, int rate_limited) {
  double t = now_s();
  if (rate_limited && t - c->last_error_frame_t < ERROR_FRAME_MIN_INTERVAL_S) return;
  c->last_error_frame_t = t;
  uint8_t f[64];
  size_t n = frame_header(f, CMD_ERROR);
  f[n++] = code;
  for (const char *p = name; *p && n < sizeof(f) - 1; p++) f[n++] = (uint8_t)(*p & 0x7F);
  f[n++] = 0xF7;
  midi_send(c, f, n);
  fprintf(stderr, "pt-ptz[%s]: error frame sent: %s\n", c->portname, name);
}

static size_t put_axis(uint8_t *f, size_t n, uint8_t ctl, const Axis *a) {
  f[n++] = ctl;
  f[n++] = a->mode;
  if (a->mode == MODE_ABS) {
    put_val35(f + n, a->min); n += 5;
    put_val35(f + n, a->max); n += 5;
    put_val35(f + n, a->res); n += 5;
    put_val35(f + n, a->cur); n += 5;
  } else if (a->mode == MODE_VEL) {
    put_val35(f + n, a->smin); n += 5;
    put_val35(f + n, a->smax); n += 5;
    put_val35(f + n, a->sres); n += 5;
  }
  return n;
}

static void send_caps_reply_locked(Cam *c) {
  uint8_t f[160];
  size_t n = frame_header(f, CMD_CAPS_REPLY);
  f[n++] = 3;
  n = put_axis(f, n, CTL_PAN, &c->pan);
  n = put_axis(f, n, CTL_TILT, &c->tilt);
  n = put_axis(f, n, CTL_ZOOM, &c->zoom);
  f[n++] = 0xF7;
  midi_send(c, f, n);
  if (g_verbose) fprintf(stderr, "pt-ptz[%s]: caps reply sent\n", c->portname);
}

// ── velocity write path (+ watchdog) ────────────────────────────────────────

static IOReturn cam_set_retry_locked(Cam *c, UInt8 selector, void *data, UInt16 len) {
  IOReturn kr = cam_req(c, UVC_SET_CUR, selector, data, len, 0);
  if (kr == kIOReturnSuccess) return kr;
  c->present = 0;
  c->last_resolve_t = 0;
  if (!cam_ensure_locked(c)) return kr;
  return cam_req(c, UVC_SET_CUR, selector, data, len, 0);
}

static uint8_t vel_dir(int32_t v) { return v > 0 ? 1 : v < 0 ? 0xFF : 0; }
static uint8_t vel_speed(int32_t v, const Axis *a) {
  if (v == 0) return 0;
  int32_t mag = v > 0 ? v : -v;
  return (uint8_t)clampi(mag, a->smin > 0 ? a->smin : 1, a->smax);
}

// Writes the current vel_pan/vel_tilt to the device. Returns UVC status.
static IOReturn flush_velocity_locked(Cam *c) {
  uint8_t b[4] = {
    vel_dir(c->vel_pan), vel_speed(c->vel_pan, &c->pan),
    vel_dir(c->vel_tilt), vel_speed(c->vel_tilt, &c->tilt),
  };
  IOReturn kr = cam_set_retry_locked(c, CT_PANTILT_REL, b, 4);
  if (kr == kIOReturnSuccess) {
    c->vel_moving = (c->vel_pan != 0 || c->vel_tilt != 0);
    if (g_verbose) fprintf(stderr, "pt-ptz[%s]: vel pan=%d tilt=%d\n", c->portname, c->vel_pan, c->vel_tilt);
  }
  return kr;
}

static void stop_velocity_locked(Cam *c, const char *why) {
  if (c->pan.mode != MODE_VEL) return;
  int was_moving = c->vel_moving || c->vel_pan != 0 || c->vel_tilt != 0;
  c->vel_pan = 0;
  c->vel_tilt = 0;
  c->vel_dirty = 0;
  if (!c->present || !was_moving) { c->vel_moving = 0; return; }
  uint8_t stop[4] = { 0, 0, 0, 0 };
  cam_req(c, UVC_SET_CUR, CT_PANTILT_REL, stop, 4, 0);
  c->vel_moving = 0;
  fprintf(stderr, "pt-ptz[%s]: velocity STOP (%s)\n", c->portname, why);
}

static void stop_all_motion(const char *why) {
  pthread_mutex_lock(&g_lock);
  for (int i = 0; i < MAX_CAMS; i++)
    if (g_cams[i].used) stop_velocity_locked(&g_cams[i], why);
  pthread_mutex_unlock(&g_lock);
}

// ── inbound frame handling (CoreMIDI thread) ────────────────────────────────

static void handle_frame(Cam *c, const uint8_t *p, size_t len) {
  if (len < 7 || p[0] != 0xF0 || p[1] != SYX_MFR || p[2] != 'P' || p[3] != 'T' || p[4] != 'Z')
    return;
  if (p[5] != SYX_VER) { send_error_frame(c, ERR_BAD_FRAME, "bad-frame", 0); return; }
  uint8_t cmd = p[6];
  const uint8_t *pay = p + 7;
  size_t paylen = len - 8;

  pthread_mutex_lock(&g_lock);
  if (cmd == CMD_CAPS_REQUEST) {
    if (cam_ensure_locked(c) && cam_probe_caps(c)) {
      send_caps_reply_locked(c);
    } else {
      c->present = 0;
      send_error_frame(c, ERR_CAMERA_ABSENT, "camera-absent", 0);
    }
  } else if (cmd == CMD_SET_ABS && paylen == 6) {
    int64_t v = get_val35(pay + 1);
    switch (pay[0]) {
      case CTL_PAN: if (c->pan.mode == MODE_ABS) { c->tgt_pan = (int32_t)v; c->dirty_pantilt = 1; } break;
      case CTL_TILT: if (c->tilt.mode == MODE_ABS) { c->tgt_tilt = (int32_t)v; c->dirty_pantilt = 1; } break;
      case CTL_ZOOM: if (c->zoom.mode == MODE_ABS) { c->tgt_zoom = (int32_t)v; c->dirty_zoom = 1; } break;
      default: send_error_frame(c, ERR_BAD_FRAME, "bad-frame", 1);
    }
  } else if (cmd == CMD_SET_VEL && paylen == 6) {
    int64_t v = get_val35(pay + 1);
    c->vel_last_refresh = now_s();
    switch (pay[0]) {
      case CTL_PAN: if (c->pan.mode == MODE_VEL && c->vel_pan != (int32_t)v) { c->vel_pan = (int32_t)v; c->vel_dirty = 1; } break;
      case CTL_TILT: if (c->tilt.mode == MODE_VEL && c->vel_tilt != (int32_t)v) { c->vel_tilt = (int32_t)v; c->vel_dirty = 1; } break;
      default: send_error_frame(c, ERR_BAD_FRAME, "bad-frame", 1);
    }
  } else if (cmd == CMD_STOP_ALL) {
    stop_velocity_locked(c, "stop-all command");
  } else {
    send_error_frame(c, ERR_BAD_FRAME, "bad-frame", 1);
  }
  pthread_mutex_unlock(&g_lock);
}

static void read_proc(const MIDIPacketList *pktlist, void *ref, void *conn) {
  Cam *c = (Cam *)ref;
  const MIDIPacket *pkt = &pktlist->packet[0];
  for (UInt32 i = 0; i < pktlist->numPackets; i++) {
    for (UInt16 j = 0; j < pkt->length; j++) {
      uint8_t b = pkt->data[j];
      if (b == 0xF0) { c->in_syx = 1; c->syx_len = 0; c->syx[c->syx_len++] = b; }
      else if (!c->in_syx) continue;
      else if (b == 0xF7) {
        if (c->syx_len < sizeof(c->syx)) { c->syx[c->syx_len++] = b; handle_frame(c, c->syx, c->syx_len); }
        c->in_syx = 0;
      } else if (b >= 0xF8) continue;
      else if (b & 0x80) c->in_syx = 0;
      else if (c->syx_len < sizeof(c->syx)) c->syx[c->syx_len++] = b;
      else c->in_syx = 0;
    }
    pkt = MIDIPacketNext(pkt);
  }
}

// ── discovery / registration ────────────────────────────────────────────────

static int already_registered(int vid, int pid) {
  for (int i = 0; i < MAX_CAMS; i++)
    if (g_cams[i].used && g_cams[i].vid == vid && g_cams[i].pid == pid) return 1;
  return 0;
}

static Cam *register_cam(int vid, int pid, const char *name, PtzInfo info) {
  int idx = -1;
  for (int i = 0; i < MAX_CAMS; i++) if (!g_cams[i].used) { idx = i; break; }
  if (idx < 0) { fprintf(stderr, "pt-ptz: MAX_CAMS reached, ignoring %04x:%04x\n", vid, pid); return NULL; }
  Cam *c = &g_cams[idx];
  memset(c, 0, sizeof(*c));
  c->used = 1;
  c->vid = vid;
  c->pid = pid;
  c->announced_present = -1;
  snprintf(c->name, sizeof(c->name), "%s", name);
  char shortn[16];
  make_shortname(name, idx, shortn, sizeof(shortn));
  snprintf(c->portname, sizeof(c->portname), "PT-PTZ-%s", shortn);
  c->pan.mode = info.has_pt_abs ? MODE_ABS : info.has_pt_rel ? MODE_VEL : MODE_NONE;
  c->tilt.mode = c->pan.mode;
  c->zoom.mode = info.has_zoom_abs ? MODE_ABS : MODE_NONE;
  return c;
}

// Scan the bus; register any PTZ camera not yet known. Returns new-cam count.
static int scan_cameras_locked(void) {
  int added = 0;
  io_iterator_t it;
  if (IOServiceGetMatchingServices(kIOMainPortDefault,
        IOServiceMatching("IOUSBHostDevice"), &it) != KERN_SUCCESS)
    return 0;
  io_service_t svc;
  while ((svc = IOIteratorNext(it))) {
    CFNumberRef v = IORegistryEntryCreateCFProperty(svc, CFSTR("idVendor"), NULL, 0);
    CFNumberRef p = IORegistryEntryCreateCFProperty(svc, CFSTR("idProduct"), NULL, 0);
    int vid = 0, pid = 0;
    if (v) { CFNumberGetValue(v, kCFNumberIntType, &vid); CFRelease(v); }
    if (p) { CFNumberGetValue(p, kCFNumberIntType, &pid); CFRelease(p); }
    if (already_registered(vid, pid)) { IOObjectRelease(svc); continue; }
    CFStringRef nm = IORegistryEntryCreateCFProperty(svc, CFSTR("USB Product Name"), NULL, 0);
    char name[64] = "camera";
    if (nm) { CFStringGetCString(nm, name, sizeof(name), kCFStringEncodingUTF8); CFRelease(nm); }
    IOUSBDeviceInterface **dev = open_device_com(svc);
    IOObjectRelease(svc);
    if (!dev) continue;
    PtzInfo info = parse_config(dev);
    (*dev)->Release(dev);
    if (!info.is_ptz) continue;
    Cam *c = register_cam(vid, pid, name, info);
    if (c) added++;
  }
  IOObjectRelease(it);
  return added;
}

static void cam_midi_up(Cam *c) {
  CFStringRef cfname = CFStringCreateWithCString(NULL, c->portname, kCFStringEncodingUTF8);
  MIDIDestinationCreate(g_client, cfname, read_proc, c, &c->dest);
  MIDISourceCreate(g_client, cfname, &c->src);
  CFRelease(cfname);
  fprintf(stderr, "pt-ptz: virtual MIDI pair \"%s\" up (%s %04x:%04x)\n",
          c->portname, c->name, c->vid, c->pid);
}

static void cam_log_axes(Cam *c) {
  const char *m[] = { "none", "abs", "vel" };
  fprintf(stderr, "pt-ptz[%s]: bound — pan %s", c->portname, m[c->pan.mode]);
  if (c->pan.mode == MODE_ABS) fprintf(stderr, " %d..%d", c->pan.min, c->pan.max);
  if (c->pan.mode == MODE_VEL) fprintf(stderr, " speed %d..%d", c->pan.smin, c->pan.smax);
  fprintf(stderr, ", tilt %s", m[c->tilt.mode]);
  if (c->tilt.mode == MODE_ABS) fprintf(stderr, " %d..%d", c->tilt.min, c->tilt.max);
  if (c->tilt.mode == MODE_VEL) fprintf(stderr, " speed %d..%d", c->tilt.smin, c->tilt.smax);
  fprintf(stderr, ", zoom %s", m[c->zoom.mode]);
  if (c->zoom.mode == MODE_ABS) fprintf(stderr, " %d..%d", c->zoom.min, c->zoom.max);
  fprintf(stderr, "\n");
}

// ── timers ──────────────────────────────────────────────────────────────────

static void flush_timer(CFRunLoopTimerRef timer, void *info) {
  pthread_mutex_lock(&g_lock);
  double t = now_s();
  for (int i = 0; i < MAX_CAMS; i++) {
    Cam *c = &g_cams[i];
    if (!c->used) continue;

    // STAGE-SAFETY WATCHDOG: a moving velocity axis with no refresh stops NOW.
    if (c->vel_moving && t - c->vel_last_refresh > VEL_WATCHDOG_S) {
      stop_velocity_locked(c, "watchdog — no refresh from the app");
      continue;
    }

    if ((c->dirty_pantilt || c->dirty_zoom || c->vel_dirty) && !cam_ensure_locked(c)) {
      c->dirty_pantilt = c->dirty_zoom = c->vel_dirty = 0;
      send_error_frame(c, ERR_CAMERA_ABSENT, "camera-absent", 1);
      continue;
    }
    if (c->vel_dirty) {
      c->vel_dirty = 0;
      if (flush_velocity_locked(c) != kIOReturnSuccess)
        send_error_frame(c, c->present ? ERR_CONTROL_FAILED : ERR_CAMERA_ABSENT,
                         c->present ? "control-failed" : "camera-absent", 1);
    }
    if (c->dirty_pantilt) {
      c->dirty_pantilt = 0;
      int32_t pan = clampi(c->tgt_pan, c->pan.min, c->pan.max);
      int32_t tilt = clampi(c->tgt_tilt, c->tilt.min, c->tilt.max);
      uint8_t pt[8];
      wr_i32le(pt, pan); wr_i32le(pt + 4, tilt);
      if (cam_set_retry_locked(c, CT_PANTILT_ABS, pt, 8) != kIOReturnSuccess) {
        send_error_frame(c, c->present ? ERR_CONTROL_FAILED : ERR_CAMERA_ABSENT,
                         c->present ? "control-failed" : "camera-absent", 1);
      } else {
        c->pan.cur = pan; c->tilt.cur = tilt;
        if (g_verbose) fprintf(stderr, "pt-ptz[%s]: pantilt -> %d,%d\n", c->portname, pan, tilt);
      }
    }
    if (c->dirty_zoom) {
      c->dirty_zoom = 0;
      int32_t zoom = clampi(c->tgt_zoom, c->zoom.min, c->zoom.max);
      uint8_t z[2] = { (uint8_t)(zoom & 0xff), (uint8_t)((zoom >> 8) & 0xff) };
      if (cam_set_retry_locked(c, CT_ZOOM_ABS, z, 2) != kIOReturnSuccess) {
        send_error_frame(c, c->present ? ERR_CONTROL_FAILED : ERR_CAMERA_ABSENT,
                         c->present ? "control-failed" : "camera-absent", 1);
      } else {
        c->zoom.cur = zoom;
        if (g_verbose) fprintf(stderr, "pt-ptz[%s]: zoom -> %d\n", c->portname, zoom);
      }
    }
  }
  pthread_mutex_unlock(&g_lock);
}

static void presence_timer(CFRunLoopTimerRef timer, void *info) {
  pthread_mutex_lock(&g_lock);
  int added = scan_cameras_locked();
  for (int i = 0; i < MAX_CAMS; i++) {
    Cam *c = &g_cams[i];
    if (!c->used) continue;
    if (!c->dest) cam_midi_up(c);
    if (!c->present) cam_ensure_locked(c);
    if (c->present != c->announced_present) {
      if (c->present) {
        cam_log_axes(c);
        if (c->announced_present != -1) send_caps_reply_locked(c);
      } else {
        stop_velocity_locked(c, "camera lost");
        fprintf(stderr, "pt-ptz[%s]: camera ABSENT — will keep looking\n", c->portname);
      }
      c->announced_present = c->present;
    }
  }
  (void)added;
  pthread_mutex_unlock(&g_lock);
}

// ── modes ───────────────────────────────────────────────────────────────────

static int discover_and_bind(void) {
  pthread_mutex_lock(&g_lock);
  scan_cameras_locked();
  int n = 0;
  for (int i = 0; i < MAX_CAMS; i++) {
    if (!g_cams[i].used) continue;
    if (cam_ensure_locked(&g_cams[i])) n++;
  }
  pthread_mutex_unlock(&g_lock);
  return n;
}

static void print_cam(Cam *c) {
  const char *m[] = { "none", "abs", "vel" };
  printf("%s — %s (%04x:%04x) if=%d terminal=%d %s\n", c->portname, c->name,
         c->vid, c->pid, c->ifnum, c->terminal, c->present ? "" : "[ABSENT]");
  printf("  pan : %s", m[c->pan.mode]);
  if (c->pan.mode == MODE_ABS) printf("  min %d max %d res %d cur %d", c->pan.min, c->pan.max, c->pan.res, c->pan.cur);
  if (c->pan.mode == MODE_VEL) printf("  speed %d..%d res %d", c->pan.smin, c->pan.smax, c->pan.sres);
  printf("\n  tilt: %s", m[c->tilt.mode]);
  if (c->tilt.mode == MODE_ABS) printf("  min %d max %d res %d cur %d", c->tilt.min, c->tilt.max, c->tilt.res, c->tilt.cur);
  if (c->tilt.mode == MODE_VEL) printf("  speed %d..%d res %d", c->tilt.smin, c->tilt.smax, c->tilt.sres);
  printf("\n  zoom: %s", m[c->zoom.mode]);
  if (c->zoom.mode == MODE_ABS) printf("  min %d max %d res %d cur %d", c->zoom.min, c->zoom.max, c->zoom.res, c->zoom.cur);
  printf("\n");
}

static int mode_probe(void) {
  int n = discover_and_bind();
  int any = 0;
  for (int i = 0; i < MAX_CAMS; i++) {
    if (!g_cams[i].used) continue;
    any = 1;
    print_cam(&g_cams[i]);
  }
  if (!any) { fprintf(stderr, "pt-ptz: no PTZ camera found on the bus\n"); return 1; }
  return n > 0 ? 0 : 1;
}

static int mode_nudge(void) {
  if (mode_probe()) return 1;
  int rc = 0;
  for (int i = 0; i < MAX_CAMS; i++) {
    Cam *c = &g_cams[i];
    if (!c->used || !c->present || c->zoom.mode != MODE_ABS) continue;
    int32_t restore = c->zoom.cur;
    int32_t step = c->zoom.res > 0 ? c->zoom.res : 1;
    int32_t target = clampi(restore + 200 * step, c->zoom.min, c->zoom.max);
    if (target == restore) target = clampi(restore - 200 * step, c->zoom.min, c->zoom.max);
    printf("%s nudge: zoom %d -> %d ... ", c->portname, restore, target);
    uint8_t z[2] = { (uint8_t)(target & 0xff), (uint8_t)((target >> 8) & 0xff) };
    pthread_mutex_lock(&g_lock);
    IOReturn kr = cam_set_retry_locked(c, CT_ZOOM_ABS, z, 2);
    pthread_mutex_unlock(&g_lock);
    printf("0x%08x\n", kr);
    if (kr != kIOReturnSuccess) { rc = 1; continue; }
    sleep(2);
    printf("%s nudge: restore zoom -> %d ... ", c->portname, restore);
    z[0] = (uint8_t)(restore & 0xff); z[1] = (uint8_t)((restore >> 8) & 0xff);
    pthread_mutex_lock(&g_lock);
    kr = cam_set_retry_locked(c, CT_ZOOM_ABS, z, 2);
    pthread_mutex_unlock(&g_lock);
    printf("0x%08x\n", kr);
    if (kr != kIOReturnSuccess) rc = 1;
  }
  return rc;
}

static void on_signal(int sig) {
  stop_all_motion("signal");
  _exit(0);
}
static void on_exit_stop(void) { stop_all_motion("exit"); }

static int mode_run(void) {
  OSStatus st = MIDIClientCreate(CFSTR("pt-ptz"), NULL, NULL, &g_client);
  if (st != noErr) { fprintf(stderr, "pt-ptz: MIDIClientCreate failed: %d\n", (int)st); return 1; }

  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);
  atexit(on_exit_stop);

  discover_and_bind();
  pthread_mutex_lock(&g_lock);
  int any = 0;
  for (int i = 0; i < MAX_CAMS; i++) {
    Cam *c = &g_cams[i];
    if (!c->used) continue;
    any = 1;
    cam_midi_up(c);
    if (c->present) cam_log_axes(c);
    else fprintf(stderr, "pt-ptz[%s]: camera ABSENT — serving anyway\n", c->portname);
    c->announced_present = c->present;
  }
  pthread_mutex_unlock(&g_lock);
  if (!any)
    fprintf(stderr, "pt-ptz: no PTZ camera on the bus yet — scanning; pairs appear on plug-in\n");

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
