// es9-bridge — the patchtogether <-> ES-9 bridge app.
//
// Opens the ES-9 full duplex (16 in / 16 out, one AUHAL, one clock), then
// serves on localhost:
//   http://127.0.0.1:PORT/   — embedded browser test harness (scope, meters,
//                              signal generators; emulates the future
//                              patchtogether ES-9 module)
//   ws://127.0.0.1:PORT/ws   — the bridge protocol (JSON control + binary
//                              Float32 audio/CV blocks, both directions)
//
// CV flows because the whole path is bit-transparent: the ES-9's DC-coupled
// outs get exactly the floats the client sent (no DC blocker, no limiter),
// and its inputs stream back untouched — a hardware Maths LFO arrives in the
// browser as a slowly-moving float, ±1.0 = ±10 V.
//
// Usage:
//   es9-bridge [--port N] [--buffer N] [--sr RATE] [--device NAME]
//              [--target-frames N] [--synthetic] [--list]
//
//   --port N           HTTP/WS port (default 9209)
//   --buffer N         hardware I/O buffer frames (default 128)
//   --sr RATE          hardware sample rate (default: device nominal)
//   --device NAME      use a non-ES-9 duplex device by name substring
//   --target-frames N  client->hw jitter buffer target (default 3x buffer)
//   --synthetic        no hardware: synthesize test inputs, meter outputs
//   --list             list audio devices and exit

import ES9Core
import Foundation
import Darwin

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
    es9-bridge — patchtogether <-> ES-9 audio+CV bridge (localhost WebSocket).
      --port N           HTTP/WS port (default 9209)
      --buffer N         hardware I/O buffer frames (default 128)
      --sr RATE          hardware sample rate (default: device nominal)
      --device NAME      match a device by name substring (default: ES-9)
      --target-frames N  jitter-buffer target, hw frames (default 3x buffer)
      --synthetic        run without hardware (test signals on inputs 1-3)
      --list             list devices and exit
    """)
    exit(0)
}

let port = UInt16(popValue("--port") ?? "9209") ?? 9209
let bufferFrames = UInt32(popValue("--buffer") ?? "128") ?? 128
let srArg = Double(popValue("--sr") ?? "0") ?? 0
let deviceName = popValue("--device")
let synthetic = popFlag("--synthetic")
let targetArg = Int(popValue("--target-frames") ?? "0") ?? 0

if popFlag("--list") {
    for d in DeviceDiscovery.allDevices() {
        print("\(d.name) [\(d.transportType)] \(d.inputChannels)x\(d.outputChannels) @ \(Int(d.nominalSampleRate))Hz\(d.looksLikeES9 ? "  <-- ES-9" : "")")
    }
    exit(0)
}

// ---- ES-9 default channel labels (hardware-verified against a real unit +
// the manual's §Routing: inputs — 14 DC-coupled jacks then the S/PDIF return
// on USB 15/16; outputs — USB 1-8 feed the INTERNAL blocks (1-2 main via
// mix 1/2, 3-4 phones via mix 3/4, 5-6 S/PDIF out, 7-8 the ES-5 header),
// and the 8 physical DC-coupled jacks ride USB channels 9-16).
func es9InputLabels(_ count: Int) -> [String] {
    (0..<count).map { c in
        switch c {
        case 0..<14: return "In \(c + 1)"
        case 14: return "S/PDIF In L"
        case 15: return "S/PDIF In R"
        default: return "USB In \(c + 1)"
        }
    }
}
func es9OutputLabels(_ count: Int) -> [String] {
    (0..<count).map { c in
        switch c {
        case 0, 1: return "Main Mix \(c + 1) (USB \(c + 1))"
        case 2, 3: return "Phones Mix (USB \(c + 1))"
        case 4: return "S/PDIF Out L (USB 5)"
        case 5: return "S/PDIF Out R (USB 6)"
        case 6: return "ES-5 L (USB 7)"
        case 7: return "ES-5 R (USB 8)"
        case 8..<16: return "Out \(c - 7)"   // physical jacks 1-8
        default: return "USB Out \(c + 1)"
        }
    }
}

let harnessHTML = Data(PackageResources.harness_html)

let engine: BridgeEngineProtocol
let devName: String
let devUID: String
let inLabels: [String]
let outLabels: [String]

if synthetic {
    let synth = SyntheticEngine()
    engine = synth
    devName = "Synthetic 16x16 (no hardware)"
    devUID = "synthetic"
    inLabels = es9InputLabels(16)
    outLabels = es9OutputLabels(16)
    print("SYNTHETIC mode: inputs 1-3 carry 440 Hz sine / 0.5 Hz LFO / 1 Hz gate.")
} else {
    let target: DeviceInfo?
    if let name = deviceName {
        target = DeviceDiscovery.allDevices().first { $0.name.lowercased().contains(name.lowercased()) }
    } else {
        target = DeviceDiscovery.findES9()
    }
    guard let dev = target else {
        FileHandle.standardError.write(Data((
            (deviceName.map { "Device matching '\($0)' not found.\n" } ??
             "ES-9 not found. Plug it in and check Audio MIDI Setup, or run --synthetic.\n")
            + "Run with --list to see devices.\n").utf8))
        exit(2)
    }
    guard dev.inputChannels >= 1, dev.outputChannels >= 1 else {
        FileHandle.standardError.write(Data("Device '\(dev.name)' is not full duplex (\(dev.inputChannels)x\(dev.outputChannels)).\n".utf8))
        exit(2)
    }
    let sr = srArg > 0 ? srArg : (dev.nominalSampleRate > 0 ? dev.nominalSampleRate : 48000)
    let clamped: UInt32 = {
        guard let range = dev.bufferFrameSizeRange else { return bufferFrames }
        return min(max(bufferFrames, range.min), range.max)
    }()
    engine = BridgeAudioEngine(.init(
        device: dev.id,
        inputChannels: dev.inputChannels, outputChannels: dev.outputChannels,
        sampleRate: sr, bufferFrames: clamped))
    devName = dev.name
    devUID = dev.uid
    if dev.looksLikeES9 {
        inLabels = es9InputLabels(dev.inputChannels)
        outLabels = es9OutputLabels(dev.outputChannels)
    } else {
        inLabels = (1...dev.inputChannels).map { "In \($0)" }
        outLabels = (1...dev.outputChannels).map { "Out \($0)" }
    }
    print("Device : \(dev.name) (\(dev.inputChannels)x\(dev.outputChannels), \(dev.transportType))")
    print("Format : \(Int(sr)) Hz, buffer \(clamped) frames")
    let rt = DeviceDiscovery.roundTripFrames(dev, buffer: clamped)
    print("HW RTT : ~\(String(format: "%.2f", Double(rt)/sr*1000)) ms (device only, excludes bridge buffers)")
}

let service = BridgeService(
    engine: engine,
    config: .init(
        port: port,
        deviceName: devName, deviceUID: devUID,
        inputLabels: inLabels, outputLabels: outLabels,
        // Clamped: beyond 4096 the "jitter cushion" is just fixed latency,
        // and the ring (16384) must keep majority headroom for live audio.
        outputTargetFrames: min(targetArg > 0 ? targetArg : Int(bufferFrames) * 3, 4096),
        harnessHTML: harnessHTML))

/// Best-effort "who has the port?" for the EADDRINUSE message. Purely
/// diagnostic: if lsof is missing or silent we still print the generic remedy.
/// `-F pc` gives machine-readable output: a "p<pid>" line then a "c<command>".
func portHolder(_ port: UInt16) -> (pid: String, command: String)? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    p.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpc"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let out = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    var pid: String?
    var cmd: String?
    for line in String(decoding: out, as: UTF8.self).split(separator: "\n") {
        if line.hasPrefix("p"), pid == nil { pid = String(line.dropFirst()) }
        if line.hasPrefix("c"), cmd == nil { cmd = String(line.dropFirst()) }
    }
    return pid.map { ($0, cmd ?? "unknown") }
}

do {
    try service.start()
} catch WebSocketServer.ServerError.portInUse(let busy) {
    let holder = portHolder(busy)
    var msg = "Port \(busy) is already in use"
    if let h = holder { msg += " by PID \(h.pid) (\(h.command))" }
    msg += ".\n"
    // The overwhelmingly common case: a previous es9-bridge that outlived its
    // terminal (reparented to launchd), still holding both port and audio device.
    if let h = holder, h.command.contains("es9-bridge") {
        msg += "That's another es9-bridge — it also still holds the audio device.\n"
        msg += "Stop it with:  kill \(h.pid)\n"
    }
    msg += "Or use a different port:  es9-bridge --port \(busy == UInt16.max ? 9210 : busy + 1)\n"
    FileHandle.standardError.write(Data(msg.utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("failed to start bridge: \(error)\n".utf8))
    exit(1)
}

print("""

    Bridge running:
      harness : http://127.0.0.1:\(port)/
      protocol: ws://127.0.0.1:\(port)/ws
    Open the harness in Chrome, press "start audio", and patch away.
    Ctrl-C to stop.
    """)

var running = true
signal(SIGINT) { _ in running = false }
while running { usleep(200_000) }

print("\nstopping…")
service.stop()
print("done.")
