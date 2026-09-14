// es9-duplex — open a low-latency full-duplex IOProc against the ES-9 and
// prove channel-addressable passthrough with per-channel RMS metering.
//
// Usage:
//   es9-duplex [--buffer N] [--sr RATE] [--routes "1:1,3:5"] [--seconds S]
//              [--device NAME] [--all-pairs] [--list]
//
//   --buffer N      I/O buffer size in frames (default 128). Lower = lower
//                   latency, higher CPU/dropout risk. Try 64/128/256/512.
//   --sr RATE       sample rate (default: device's current nominal rate).
//   --routes SPEC   pair routing, 1-based: "inPair:outPair,...". Default is
//                   straight-through (1/2->1/2, 3/4->3/4, ...).
//   --all-pairs     route EVERY input pair to the same output pair.
//   --seconds S     run for S seconds then exit (default: until Ctrl-C).
//   --device NAME   match a device by name substring instead of the ES-9.
//   --list          just list devices (same as es9-devices) and exit.
//
// The USER runs this against the real ES-9. With nothing plugged in it prints
// a clear "no ES-9" message and exits non-zero.

import ES9Core
import Foundation
import Darwin

// ---- arg parsing -----------------------------------------------------------
var args = Array(CommandLine.arguments.dropFirst())
func popValue(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...i+1); return v
}
func popFlag(_ flag: String) -> Bool {
    guard let i = args.firstIndex(of: flag) else { return false }
    args.remove(at: i); return true
}
if popFlag("--help") || popFlag("-h") {
    print("""
    es9-duplex — full-duplex channel-addressable passthrough for the ES-9.
      --buffer N      I/O buffer frames (default 128)
      --sr RATE       sample rate (default: device nominal)
      --routes SPEC   "inPair:outPair,..." 1-based (default straight-through)
      --all-pairs     route every input pair to same-numbered output pair
      --seconds S     run S seconds then exit (default: until Ctrl-C)
      --device NAME   match device by name substring (default: ES-9)
      --list          list devices and exit
    """)
    exit(0)
}
let doList = popFlag("--list")
let allPairs = popFlag("--all-pairs")
let bufArg = UInt32(popValue("--buffer") ?? "128") ?? 128
let srArg = Double(popValue("--sr") ?? "0") ?? 0
let routeSpec = popValue("--routes")
let seconds = Double(popValue("--seconds") ?? "0") ?? 0
let deviceName = popValue("--device")

if doList {
    for d in DeviceDiscovery.allDevices() {
        print("\(d.name) [\(d.transportType)] \(d.inputChannels)x\(d.outputChannels) @ \(Int(d.nominalSampleRate))Hz\(d.looksLikeES9 ? "  <-- ES-9" : "")")
    }
    exit(0)
}

// ---- device selection ------------------------------------------------------
let target: DeviceInfo?
if let name = deviceName {
    target = DeviceDiscovery.allDevices().first { $0.name.lowercased().contains(name.lowercased()) }
} else {
    target = DeviceDiscovery.findES9()
}
guard let dev = target else {
    FileHandle.standardError.write(Data((
        (deviceName.map { "Device matching '\($0)' not found.\n" } ??
         "ES-9 not found. Plug it in (class-compliant USB-C, no driver) and confirm it appears in Audio MIDI Setup.\n")
        + "Run with --list to see available devices.\n").utf8))
    exit(2)
}

guard dev.inputChannels >= 2, dev.outputChannels >= 2 else {
    FileHandle.standardError.write(Data("Device '\(dev.name)' needs >=2 in and >=2 out (has \(dev.inputChannels)x\(dev.outputChannels)).\n".utf8))
    exit(2)
}

let sr = srArg > 0 ? srArg : (dev.nominalSampleRate > 0 ? dev.nominalSampleRate : 48000)

// ---- routing plan ----------------------------------------------------------
var routes: [PairRoute]
if let spec = routeSpec {
    switch parsePairRoutes(spec) {
    case .success(let r): routes = r
    case .failure(let e):
        FileHandle.standardError.write(Data("route error: \(e)\n".utf8)); exit(2)
    }
} else if allPairs {
    routes = (0..<(min(dev.inputChannels, dev.outputChannels) / 2)).map { PairRoute(inputPair: $0, outputPair: $0) }
} else {
    routes = RoutingPlan.straightThrough(inputChannels: dev.inputChannels, outputChannels: dev.outputChannels).routes
}
let plan = RoutingPlan(routes: routes, inputChannels: dev.inputChannels, outputChannels: dev.outputChannels)
let routeErrors = plan.validate()
if !routeErrors.isEmpty {
    FileHandle.standardError.write(Data(("invalid routes:\n  " + routeErrors.joined(separator: "\n  ") + "\n").utf8)); exit(2)
}

print("Device : \(dev.name) (\(dev.inputChannels)x\(dev.outputChannels), \(dev.transportType))")
print("Format : \(Int(sr)) Hz, buffer \(bufArg) frames  (~\(String(format: "%.2f", Double(bufArg)/sr*1000)) ms/block)")
let rt = DeviceDiscovery.roundTripFrames(dev, buffer: bufArg)
print("Latency: ~\(String(format: "%.2f", Double(rt)/sr*1000)) ms round trip estimate")
print("Routes : " + routes.map { "\($0.input.label)->\($0.output.label)" }.joined(separator: "  "))
print("")

// ---- engine ----------------------------------------------------------------
let engine = DuplexEngine(.init(
    device: dev.id, inputChannels: dev.inputChannels, outputChannels: dev.outputChannels,
    sampleRate: sr, bufferFrames: bufArg, routes: routes))
do {
    try engine.start()
} catch {
    FileHandle.standardError.write(Data("failed to start duplex engine: \(error)\n".utf8)); exit(1)
}

print("RUNNING — feed signal into ES-9 inputs; routed pairs appear on the ES-9 outputs.")
print("Per-channel RMS (dBFS), updating ~4x/sec.  Ctrl-C to stop.\n")

// ---- Ctrl-C / duration handling -------------------------------------------
var running = true
signal(SIGINT) { _ in running = false }

func bar(_ db: Float) -> String {
    let clamped = max(-60, min(0, db))
    let len = Int((clamped + 60) / 60 * 24)
    return String(repeating: "#", count: len).padding(toLength: 24, withPad: " ", startingAt: 0)
}

let start = Date()
while running {
    usleep(250_000)
    let m = engine.sampleMeters()
    // Show only the routed input pairs + their output destinations, compactly.
    var line = "IN "
    for r in routes.prefix(8) {
        let l = m.inputRMS.indices.contains(r.input.leftChannel) ? m.inputRMS[r.input.leftChannel] : -120
        let rr = m.inputRMS.indices.contains(r.input.rightChannel) ? m.inputRMS[r.input.rightChannel] : -120
        line += String(format: "%@:%5.0f/%5.0f ", r.input.label, l, rr)
    }
    print("\u{1B}[2K\r" + line, terminator: "")
    fflush(stdout)
    if seconds > 0 && Date().timeIntervalSince(start) >= seconds { running = false }
}

print("\nstopping…")
engine.stop()
print("done.")
