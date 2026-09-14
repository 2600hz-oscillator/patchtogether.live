// es9-devices — enumerate CoreAudio devices and report the ES-9.
//
// Safe to run with no hardware: it lists whatever devices exist and reports
// "ES-9 not found" if none match. With the ES-9 attached, prints its full
// I/O capability snapshot + per-pair addressing map + latency estimate.

import ES9Core
import Foundation

func dbLine(_ label: String, _ value: String) { print("  \(label.padding(toLength: 22, withPad: " ", startingAt: 0)) \(value)") }

let devices = DeviceDiscovery.allDevices()

print("== CoreAudio devices (\(devices.count)) ==\n")
for d in devices {
    let tag = d.looksLikeES9 ? "  <-- ES-9 match" : ""
    print("• \(d.name)  [\(d.transportType)]\(tag)")
    dbLine("id / uid", "\(d.id)  \(d.uid)")
    dbLine("channels (in/out)", "\(d.inputChannels) in / \(d.outputChannels) out")
    dbLine("pairs (in/out)", "\(d.inputPairs) / \(d.outputPairs)")
    dbLine("nominal SR", "\(Int(d.nominalSampleRate)) Hz")
    if !d.availableSampleRates.isEmpty {
        dbLine("available SR", d.availableSampleRates.map { String(Int($0)) }.joined(separator: ", "))
    }
    dbLine("buffer frames", "\(d.bufferFrameSize)")
    if let r = d.bufferFrameSizeRange { dbLine("buffer range", "\(r.min)–\(r.max)") }
    dbLine("safety offset i/o", "\(d.inputSafetyOffset) / \(d.outputSafetyOffset) frames")
    dbLine("latency i/o", "\(d.inputLatency) / \(d.outputLatency) frames")
    print("")
}

print(String(repeating: "=", count: 60))
if let es9 = DeviceDiscovery.findES9() {
    print("\nFOUND ES-9: \(es9.name)")
    print("  \(es9.inputChannels)x\(es9.outputChannels)  @ \(Int(es9.nominalSampleRate)) Hz")
    print("\n  Addressable INPUT pairs:")
    for p in 0..<es9.inputPairs { print("    IN  \(StereoPair(p).label)  (ch \(StereoPair(p).leftChannel),\(StereoPair(p).rightChannel))") }
    print("  Addressable OUTPUT pairs:")
    for p in 0..<es9.outputPairs { print("    OUT \(StereoPair(p).label)  (ch \(StereoPair(p).leftChannel),\(StereoPair(p).rightChannel))") }

    print("\n  Round-trip latency estimate (safety + device latency + 2x buffer):")
    let sr = es9.nominalSampleRate > 0 ? es9.nominalSampleRate : 48000
    for buf: UInt32 in [64, 128, 256, 512] {
        let frames = DeviceDiscovery.roundTripFrames(es9, buffer: buf)
        let ms = Double(frames) / sr * 1000.0
        print(String(format: "    buffer %4d frames -> ~%5.2f ms round trip", buf, ms))
    }
} else {
    print("\nES-9 not found. Plug it in via USB-C (class-compliant, no driver),")
    print("confirm it appears in Audio MIDI Setup, then re-run.")
    print("If your unit reports a different name, the matcher keys on")
    print("'es-9' / 'es9' / 'expert sleepers' in the device name or UID.")
}
