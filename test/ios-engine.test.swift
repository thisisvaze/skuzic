import Foundation

// Deterministic transport/player doubles exercise the real LyriaEngine on macOS.
// Network sending and sample accounting are tested separately in ios-audio.
final class PcmScheduler: @unchecked Sendable {
    struct Snapshot {
        var phase: PlaybackTimeline.Phase = .stopped
        var bufferedSeconds: Double = 0
    }
    var snapshot = Snapshot()
    private let onState: @Sendable (Snapshot) -> Void
    init(volume: Float, onState: @escaping @Sendable (Snapshot) -> Void,
         onDemand: @escaping @Sendable (Bool) -> Void,
         onInterruption: @escaping @Sendable (Bool, Bool) -> Void,
         onFailure: @escaping @Sendable (Error) -> Void) { self.onState = onState }
    func start() throws {}
    func play() { snapshot.phase = .buffering; onState(snapshot) }
    func pause() { snapshot.phase = .paused; onState(snapshot) }
    func flush(reason: String = "stop") { snapshot.phase = .stopped; onState(snapshot) }
    func reset(onSilent: @escaping @Sendable () -> Void) {
        snapshot.phase = .buffering
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02, execute: onSilent)
    }
    func setVolume(_ value: Float) {}
    func enqueue(_ data: Data, sampleRate: Double) {
        snapshot.phase = .playing
        snapshot.bufferedSeconds = 4
        onState(snapshot)
    }
    func levels(bands: Int) -> [Float] { Array(repeating: 0.5, count: bands) }
    func close() { snapshot = Snapshot() }
}

@MainActor
final class LyriaConnection {
    static let model = "test-lyria"
    static var instances: [LyriaConnection] = []
    private(set) var closed = false
    private(set) var commands: [[String: Any]] = []
    let onFailure: (Error) -> Void
    let onAudio: @Sendable (Data, Double) -> Void
    init(apiKey: String, onAudio: @escaping @Sendable (Data, Double) -> Void,
         onControl: @escaping (LyriaStream.Control) -> Void,
         onFailure: @escaping (Error) -> Void) throws {
        self.onAudio = onAudio
        self.onFailure = onFailure
        Self.instances.append(self)
    }
    func connect() async throws {
        try await Task.sleep(nanoseconds: 20_000_000)
        if closed { throw CancellationError() }
    }
    func send(_ payload: [String: Any], key: String? = nil, sent: (() -> Void)? = nil) {
        if !closed { commands.append(payload); sent?() }
    }
    func close() { closed = true }
    var controls: [String] { commands.compactMap { $0["playbackControl"] as? String } }
}

@main
@MainActor
private struct EngineTests {
    static func check(_ condition: @autoclosure () -> Bool, _ label: String) {
        guard condition() else { fatalError("FAIL: \(label)") }
        print("  ok  \(label)")
    }
    static func settle(_ milliseconds: UInt64 = 50) async {
        try? await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    }

    static func main() async throws {
        let engine = LyriaEngine(apiKey: "test-key-not-used")
        var config = MixConfig()
        config.bpm = 110
        engine.setConfig(config)
        engine.setPrompts([PromptWeight(text: "piano", weight: 1)])
        engine.play()
        check(engine.playbackRequested && engine.status == .idle,
              "a restored sketch can request playback without bypassing connection setup")
        try await engine.connect()
        let first = LyriaConnection.instances.last!
        check(first.controls == ["PLAY"] && engine.status == .buffering,
              "pending playback starts once setup and prompts are ready")
        let sentConfig = first.commands.first?["musicGenerationConfig"] as? [String: Any]
        check(sentConfig?["bpm"] as? Int == 110 && first.commands[1]["clientContent"] != nil,
              "saved config and prompts precede the first PLAY")
        first.onAudio(Data([0, 0, 0, 0]), 48_000)
        await settle()
        check(engine.status == .playing && engine.bufferedSeconds == 4,
              "the UI becomes playing only when the player reports playback")

        engine.resetContext()
        engine.pause()
        await settle()
        check(first.controls.suffix(2) == ["RESET_CONTEXT", "PAUSE"]
              && engine.status == .paused && !engine.playbackRequested,
              "pausing during a reset commits the reset without restarting audio")
        engine.play()
        check(first.controls.last == "PLAY", "resume remains available after a cancelled fade")

        first.onFailure(URLError(.networkConnectionLost))
        check(engine.status == .buffering && engine.playbackRequested && first.closed,
              "a dropped stream closes old resources while retaining playback intent")
        await settle(1_150)
        let second = LyriaConnection.instances.last!
        check(second !== first && !second.closed && second.controls == ["PLAY"],
              "a reconnect restores the mix and resumes generation once")
        first.onFailure(URLError(.networkConnectionLost))
        await settle()
        check(!second.closed && LyriaConnection.instances.last === second,
              "a late failure from an old socket cannot close the replacement")

        second.onFailure(URLError(.networkConnectionLost))
        engine.close()
        try await engine.connect()
        let third = LyriaConnection.instances.last!
        await settle(100)
        check(!third.closed && engine.status == .ready && !engine.playbackRequested,
              "closing during a reconnect cancels it without tearing down a fresh connection")
        engine.close()

        let pending = Task { try await engine.connect() }
        await settle(1)
        engine.close()
        try await engine.connect()
        let fresh = LyriaConnection.instances.last!
        _ = try? await pending.value
        check(!fresh.closed && engine.status == .ready,
              "closing during setup resolves the old waiter and preserves a new session")
        engine.close()
        print("iOS engine lifecycle checks passed")
    }
}
