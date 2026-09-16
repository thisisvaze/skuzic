import CoreFoundation
import Foundation

private enum FixtureError: Error { case finished }

private actor Messages {
    private var messages: [URLSessionWebSocketTask.Message]
    init(_ messages: [URLSessionWebSocketTask.Message]) { self.messages = messages }
    func next() async throws -> URLSessionWebSocketTask.Message {
        try await Task.sleep(nanoseconds: 10_000_000)
        guard !messages.isEmpty else { throw FixtureError.finished }
        return messages.removeFirst()
    }
}

/// Callbacks run on the receive worker, while assertions run on the main actor.
private final class Received: @unchecked Sendable {
    struct Snapshot {
        var audio: [(Data, Double)] = []
        var controls: [LyriaStream.Control] = []
        var errors = 0
    }
    private let lock = NSLock()
    private var value = Snapshot()
    func update(_ body: (inout Snapshot) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        body(&value)
    }
    var snapshot: Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private final class PendingReceive: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            started.signal()
        }
    }

    func finish(_ message: URLSessionWebSocketTask.Message) {
        lock.lock()
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(returning: message)
    }
}

@main
@MainActor
private struct AudioTests {
    static func check(_ condition: @autoclosure () -> Bool, _ label: String) {
        guard condition() else { fatalError("FAIL: \(label)") }
        print("  ok  \(label)")
    }

    // Run in a tracking mode to model drawing/dragging. A default-mode Timer
    // would never fire here, which previously froze the prompt crossfade.
    static func trackTouches(for seconds: TimeInterval) {
        let mode = RunLoop.Mode("skuzic.test.tracking")
        CFRunLoopAddCommonMode(CFRunLoopGetMain(), CFRunLoopMode(mode.rawValue as CFString))
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            _ = RunLoop.main.run(mode: mode, before: end)
        }
    }

    static func testMixer() {
        var frames: [[PromptWeight]] = []
        let mixer = PromptMixer { frames.append($0) }
        mixer.setTarget([PromptWeight(text: "warm piano", weight: 0.1)])
        check(frames.count == 1, "initial prompts are sent synchronously before PLAY")
        frames.removeAll()
        let target = [PromptWeight(text: "warm piano", weight: 0.9)]
        mixer.setTarget(target)
        trackTouches(for: 1.2)
        check((3...5).contains(frames.count), "crossfade runs during touches with at most five updates")
        check(frames.first!.first!.weight < 0.4, "later prompts crossfade from the current mix")
        check(frames.last == target, "throttled crossfade sends the exact final weights")
        let count = frames.count
        mixer.setTarget(target)
        trackTouches(for: 0.4)
        check(frames.count == count, "unchanged strokes do not resend the current mix")

        let replacement = (0..<8).map { PromptWeight(text: "instrument \($0)", weight: 0.8) }
        mixer.setTarget(replacement)
        trackTouches(for: 1.2)
        check(frames.allSatisfy { !$0.isEmpty && $0.count <= 8 && $0.allSatisfy { $0.weight > 0 } },
              "all transition frames obey Lyria's prompt count and weight limits")
        check(Set(frames.last!.map(\.text)) == Set(replacement.map(\.text)),
              "replacing a full mix reaches the new instruments")
        mixer.reset()
    }

    static func testDrawingActions() {
        var before = SkuzicState()
        before.config.bpm = 115
        before.config.scale = "C_MAJOR_A_MINOR"
        before.contextEpoch = 3
        let actions: [Action] = [
            .setConfig(ConfigPatch(bpm: 160, density: 0.7, brightness: 0.2, scale: "D_MAJOR_B_MINOR")),
            .resetContext,
            .addTrack(label: "piano", prompt: "soft piano", volume: 0.7, origin: "drawing"),
            .setConfig(ConfigPatch(bpm: 140)),
        ]
        let smooth = actions.compactMap(\.preservingPlayback).reduce(before, reduce)
        check(smooth.config.bpm == 115 && smooth.config.scale == "C_MAJOR_A_MINOR"
              && smooth.contextEpoch == 3, "drawing updates cannot restart the performance")
        check(smooth.config.density == 0.7 && smooth.config.brightness == 0.2
              && smooth.tracks.count == 1, "drawing updates still change the music")
        let manual = actions.reduce(before, reduce)
        check(manual.config.bpm == 140 && manual.contextEpoch == 4,
              "explicit controls retain tempo changes and resets")
    }

    static func testStreamWhileMainActorIsBusy() {
        let payload = Data([0, 1, 2, 3])
        let encoded = payload.base64EncodedString()
        let snake = """
        {"setup_complete":{},"filtered_prompt":{"text":"filtered","filtered_reason":"test"},
         "server_content":{"audio_chunks":[{"data":"\(encoded)","mime_type":"audio/L16;rate=24000"}]}}
        """
        let camel = """
        {"serverContent":{"audioChunks":[{"data":"\(encoded)","mimeType":"audio/L16;rate=48000"},
          {"data":"\(encoded)","mimeType":"audio/L16;rate=0"},{"mimeType":"audio/L16"}]}}
        """
        let messages = Messages([.string("not JSON"), .string(snake), .data(Data(camel.utf8))])
        let received = Received()
        let finished = DispatchSemaphore(value: 0)
        let worker = LyriaStream.start(
            receive: { try await messages.next() },
            onAudio: { data, rate in received.update { $0.audio.append((data, rate)) } },
            onControl: { control in received.update { $0.controls.append(control) } },
            onError: { _ in
                received.update { $0.errors += 1 }
                finished.signal()
            }
        )
        // Deliberately block the main actor: no audio callback can depend on it.
        let completed = finished.wait(timeout: .now() + 2)
        worker.cancel()
        check(completed == .success, "audio is received and decoded while the main actor is blocked")
        let snapshot = received.snapshot
        check(snapshot.audio.count == 3 && snapshot.audio.allSatisfy { $0.0 == payload },
              "text/binary messages preserve PCM and skip malformed chunks")
        check(snapshot.audio.map { $0.1 } == [24000, 48000, 48000],
              "sample rates support both field casings and reject a zero rate")
        check(snapshot.controls.count == 1 && snapshot.controls[0].setupComplete
              && snapshot.controls[0].filteredReason == "test" && snapshot.errors == 1,
              "setup, filtered prompts and disconnects are still reported")
    }

    static func testCancelledReceive() async {
        let pending = PendingReceive()
        let received = Received()
        let worker = LyriaStream.start(
            receive: { try await pending.receive() },
            onAudio: { data, rate in received.update { $0.audio.append((data, rate)) } },
            onControl: { control in received.update { $0.controls.append(control) } },
            onError: { _ in received.update { $0.errors += 1 } }
        )
        check(pending.started.wait(timeout: .now() + 2) == .success, "receive is in flight before close")
        worker.cancel()
        pending.finish(.string("""
        {"setupComplete":{},"serverContent":{"audioChunks":[{"data":"AAECAw=="}]}}
        """))
        await worker.value
        let snapshot = received.snapshot
        check(snapshot.audio.isEmpty && snapshot.controls.isEmpty && snapshot.errors == 0,
              "closing discards a late audio message without reporting a false error")
    }

    static func testTimeline() {
        var timeline = PlaybackTimeline()
        timeline.clear(to: .buffering)
        let first = timeline.append(frames: 96_000)!
        check(!timeline.beginPlayback(), "one two-second chunk does not prematurely start playback")
        let second = timeline.append(frames: 96_000)!
        check(timeline.beginPlayback() && timeline.phase == .playing,
              "playback begins after a real four-second reserve")
        check(timeline.remainingSeconds(playhead: 48_000) == 3,
              "buffer duration follows the player's sample clock")
        check(!timeline.complete(first) && timeline.phase == .playing,
              "one buffer completing leaves subsequent audio playing")
        check(timeline.complete(second) && timeline.phase == .buffering && timeline.underruns == 1,
              "an exhausted queue enters buffering exactly once")
        check(!timeline.complete(second) && timeline.underruns == 1,
              "late or duplicate completions cannot empty a new playback generation")
        _ = timeline.append(frames: 96_000)
        check(!timeline.beginPlayback(), "an underrun cannot turn into repeated two-second restarts")
        _ = timeline.append(frames: 192_000)
        check(timeline.beginPlayback() && timeline.remainingSeconds() == 6,
              "recovery starts with a larger reserve and a fresh sample clock")
        let stale = timeline.append(frames: 96_000)!
        timeline.clear(to: .paused)
        check(!timeline.complete(stale) && timeline.phase == .paused,
              "pause invalidates queued completions without reporting an underrun")
        check(timeline.append(frames: 96_000) == nil,
              "paused playback cannot accumulate stale incoming audio")
        timeline.clear(to: .buffering, resetTarget: true)
        check(timeline.append(frames: 48_000 * 21) == nil,
              "an unresponsive producer cannot allocate an unbounded audio queue")
    }

    static func testArrivalTraces() {
        func replay(_ arrivals: [Double]) -> (starts: Int, gaps: Int) {
            var timeline = PlaybackTimeline()
            timeline.clear(to: .buffering)
            var pending: [PlaybackTimeline.Ticket] = []
            var finishes: [(Double, PlaybackTimeline.Ticket)] = []
            var end = 0.0
            var starts = 0
            for now in arrivals {
                while let next = finishes.first, next.0 <= now {
                    finishes.removeFirst()
                    _ = timeline.complete(next.1)
                }
                let ticket = timeline.append(frames: 96_000)!
                if timeline.phase == .playing {
                    end += 2
                    finishes.append((end, ticket))
                } else {
                    pending.append(ticket)
                    if timeline.beginPlayback() {
                        starts += 1
                        end = now
                        for held in pending {
                            end += 2
                            finishes.append((end, held))
                        }
                        pending.removeAll()
                    }
                }
            }
            return (starts, timeline.underruns)
        }
        let jittery: [Double] = (0..<90).map { index in
            let jitter: Double = index % 3 == 1 ? 0.6 : 0
            return Double(index) * 2.0 + jitter
        }
        let healthy = replay(jittery)
        check(healthy.starts == 1 && healthy.gaps == 0,
              "three minutes of real-time audio with 600ms jitter stays continuous")
        let slower = replay((0..<35).map { Double($0) * 2.535 })
        check(slower.gaps > 0 && slower.gaps < 5,
              "sustained slow arrivals report rebuffering instead of claiming uninterrupted playback")
    }

    static func testOutbox() async {
        let sent = SendRecorder()
        var failures = 0
        let outbox = LyriaOutbox(send: { try await sent.send($0) }, failed: { _ in failures += 1 })
        outbox.enqueue("setup")
        outbox.enqueue("config-old", key: "config")
        outbox.enqueue("config-final", key: "config")
        outbox.enqueue("prompts-final", key: "prompts")
        outbox.enqueue("PLAY")
        outbox.enqueue("prompts-next", key: "prompts")
        outbox.enqueue("RESET")
        // Poll rather than a fixed sleep: CI VMs stretch 10ms sleeps unpredictably.
        let deadline = Date().addingTimeInterval(2)
        while await sent.values.count < 6, Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        let recorded = await sent.values
        check(recorded == ["setup", "config-final", "prompts-final", "PLAY", "prompts-next", "RESET"],
              "commands stay ordered while adjacent stale updates coalesce")
        let maximumActive = await sent.maximumActive
        check(maximumActive == 1 && failures == 0,
              "there is only one in-flight WebSocket send")
        outbox.cancel()
        outbox.enqueue("late-PLAY")
        try? await Task.sleep(nanoseconds: 30_000_000)
        let afterClose = await sent.values
        check(afterClose == recorded, "closing prevents queued or late commands being sent")
        let cancelled = SendRecorder()
        let cancelledOutbox = LyriaOutbox(send: { try await cancelled.send($0) },
                                         failed: { _ in failures += 1 })
        cancelledOutbox.enqueue("in-flight")
        cancelledOutbox.enqueue("must-not-send")
        try? await Task.sleep(nanoseconds: 2_000_000)
        cancelledOutbox.cancel()
        try? await Task.sleep(nanoseconds: 30_000_000)
        let afterCancellation = await cancelled.values
        check(afterCancellation.isEmpty && failures == 0,
              "cancelling an in-flight send drops its tail without a stale failure callback")
    }

    static func testStreamErrors() {
        for json in [
            #"{"error":{"code":429,"message":"do not log server contents"}}"#,
            #"{"serverContent":{"audioChunks":[{"data":"AAECAw==","mimeType":"audio/opus;channels=2"}]}}"#,
            #"{"serverContent":{"audioChunks":[{"data":"AAECAw==","mimeType":"audio/l16;channels=1"}]}}"#,
        ] {
            let messages = Messages([.string(json)])
            let received = Received()
            let done = DispatchSemaphore(value: 0)
            let worker = LyriaStream.start(
                receive: { try await messages.next() },
                onAudio: { data, rate in received.update { $0.audio.append((data, rate)) } },
                onControl: { _ in },
                onError: { error in
                    if error is LyriaStream.StreamError { received.update { $0.errors += 1 } }
                    done.signal()
                })
            check(done.wait(timeout: .now() + 2) == .success
                  && received.snapshot.audio.isEmpty && received.snapshot.errors == 1,
                  "server errors and unsupported PCM formats fail explicitly without playing corrupt audio")
            worker.cancel()
        }
    }

    static func main() async {
        testMixer()
        testDrawingActions()
        testTimeline()
        testArrivalTraces()
        testStreamWhileMainActorIsBusy()
        testStreamErrors()
        await testCancelledReceive()
        await testOutbox()
        print("iOS audio regression checks passed")
    }
}

private actor SendRecorder {
    private(set) var values: [String] = []
    private var active = 0
    private(set) var maximumActive = 0
    func send(_ text: String) async throws {
        active += 1
        maximumActive = max(maximumActive, active)
        defer { active -= 1 }
        try await Task.sleep(nanoseconds: 10_000_000)
        values.append(text)
    }
}
