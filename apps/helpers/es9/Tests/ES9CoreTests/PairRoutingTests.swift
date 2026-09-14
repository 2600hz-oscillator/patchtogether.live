// Pure unit tests for the hardware-free pair-routing model. These run in CI /
// locally with NO audio hardware — they verify the Bitwig-style addressing
// math (the part most likely to have off-by-one channel bugs).

import XCTest
@testable import ES9Core

final class PairRoutingTests: XCTestCase {
    func testStereoPairChannelMath() {
        XCTAssertEqual(StereoPair(0).leftChannel, 0)
        XCTAssertEqual(StereoPair(0).rightChannel, 1)
        XCTAssertEqual(StereoPair(0).label, "1/2")
        XCTAssertEqual(StereoPair(7).leftChannel, 14)
        XCTAssertEqual(StereoPair(7).rightChannel, 15)
        XCTAssertEqual(StereoPair(7).label, "15/16")
    }

    func testStraightThrough16x16HasEightPairs() {
        let plan = RoutingPlan.straightThrough(inputChannels: 16, outputChannels: 16)
        XCTAssertEqual(plan.routes.count, 8)
        XCTAssertEqual(plan.inputPairCount, 8)
        XCTAssertEqual(plan.outputPairCount, 8)
        XCTAssertEqual(plan.routes.first, PairRoute(inputPair: 0, outputPair: 0))
        XCTAssertEqual(plan.routes.last, PairRoute(inputPair: 7, outputPair: 7))
        XCTAssertTrue(plan.validate().isEmpty)
    }

    func testStraightThroughLimitedByFewerDirection() {
        // ES-9 with 14 analog in / 16 out -> limited to 7 pairs.
        let plan = RoutingPlan.straightThrough(inputChannels: 14, outputChannels: 16)
        XCTAssertEqual(plan.routes.count, 7)
    }

    func testValidateCatchesOutOfRangePair() {
        let plan = RoutingPlan(routes: [PairRoute(inputPair: 0, outputPair: 9)],
                               inputChannels: 16, outputChannels: 16)
        let errs = plan.validate()
        XCTAssertEqual(errs.count, 1)
        XCTAssertTrue(errs[0].contains("output pair"))
    }

    func testParseRoutesOneBasedToZeroBased() {
        switch parsePairRoutes("1:1,3:5") {
        case .success(let r):
            XCTAssertEqual(r, [PairRoute(inputPair: 0, outputPair: 0),
                               PairRoute(inputPair: 2, outputPair: 4)])
        case .failure(let e): XCTFail("unexpected failure: \(e)")
        }
    }

    func testParseRoutesRejectsGarbage() {
        if case .success = parsePairRoutes("nope") { XCTFail("should reject") }
        if case .success = parsePairRoutes("1:0") { XCTFail("0-based should reject") }
        if case .success = parsePairRoutes("") { XCTFail("empty should reject") }
    }

    func testRMSToDBFS() {
        XCTAssertEqual(rmsToDBFS(1.0), 0, accuracy: 0.01)        // full scale
        XCTAssertEqual(rmsToDBFS(0.5), -6.02, accuracy: 0.05)    // half = -6 dB
        XCTAssertEqual(rmsToDBFS(0), -120, accuracy: 0.001)      // silence clamp
    }

    func testES9NameHeuristic() {
        func info(_ name: String, _ uid: String = "") -> DeviceInfo {
            DeviceInfo(id: 0, name: name, uid: uid, manufacturer: "",
                       inputChannels: 16, outputChannels: 16, nominalSampleRate: 48000,
                       availableSampleRates: [], bufferFrameSize: 128, bufferFrameSizeRange: nil,
                       inputSafetyOffset: 0, outputSafetyOffset: 0, inputLatency: 0,
                       outputLatency: 0, transportType: "USB")
        }
        XCTAssertTrue(info("ES-9").looksLikeES9)
        XCTAssertTrue(info("Expert Sleepers ES-9").looksLikeES9)
        XCTAssertTrue(info("es9").looksLikeES9)
        XCTAssertTrue(info("Something", "ES-9:1234").looksLikeES9)
        XCTAssertFalse(info("MacBook Pro Speakers").looksLikeES9)
    }

    func testRoundTripFramesIncludesBothDirectionsAndBuffer() {
        let d = DeviceInfo(id: 0, name: "ES-9", uid: "", manufacturer: "",
                           inputChannels: 16, outputChannels: 16, nominalSampleRate: 48000,
                           availableSampleRates: [], bufferFrameSize: 128, bufferFrameSizeRange: nil,
                           inputSafetyOffset: 16, outputSafetyOffset: 16, inputLatency: 0,
                           outputLatency: 0, transportType: "USB")
        // 16 + 0 + 128 + 16 + 0 + 128 = 288
        XCTAssertEqual(DeviceDiscovery.roundTripFrames(d, buffer: 128), 288)
    }
}
