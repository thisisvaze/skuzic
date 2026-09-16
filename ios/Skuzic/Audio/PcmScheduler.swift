import AVFoundation
import Foundation

/// AVAudioEngine operations and PCM conversion belong to one worker queue.
/// Rendering never waits for the UI; the UI reads a cached snapshot.
final class PcmScheduler: @unchecked Sendable {
    static let defaultSampleRate: Double = 48_000
    struct Snapshot {
        var phase: PlaybackTimeline.Phase = .stopped
        var bufferedSeconds: Double = 0
        var targetSeconds: Double = 4
        var underruns = 0
    }
    private let queue = DispatchQueue(label: "skuzic.audio.playback", qos: .userInitiated)
    private let snapshotLock = NSLock()
    private var cached = Snapshot()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
    private let analyzer = SpectrumAnalyzer(sampleRate: 48_000)
    private var converters: [Double: AVAudioConverter] = [:]
    private var timeline = PlaybackTimeline()
    private var monitor: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []
    private var closed = false
    private var wanted = false
    private var interrupted = false
    private var throttled = false
    private var volume: Float
    private var rampID: UInt64 = 0
    private var lastChunkAt: Double?
    private var waitingSince: Double = 0
    private var stallReported = false
    private var chunks = 0
    private var maxGap: Double = 0
    private var maxQueueDelay: Double = 0
    private var nextReport: Double = 0
    private let onState: @Sendable (Snapshot) -> Void
    private let onDemand: @Sendable (Bool) -> Void
    private let onInterruption: @Sendable (Bool, Bool) -> Void
    private let onFailure: @Sendable (Error) -> Void

    init(volume: Float = 0.8,
         onState: @escaping @Sendable (Snapshot) -> Void = { _ in },
         onDemand: @escaping @Sendable (Bool) -> Void = { _ in },
         onInterruption: @escaping @Sendable (Bool, Bool) -> Void = { _, _ in },
         onFailure: @escaping @Sendable (Error) -> Void = { _ in }) {
        self.volume = volume
        self.onState = onState
        self.onDemand = onDemand
        self.onInterruption = onInterruption
        self.onFailure = onFailure
    }

    var snapshot: Snapshot {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        return cached
    }
    var bufferedSeconds: Double { snapshot.bufferedSeconds }
    func levels(bands: Int) -> [Float] { analyzer.levels(bands: bands) }

    func start() throws {
        try queue.sync {
            guard !closed else { throw CancellationError() }
            try activateSession()
            buildGraph()
            try engine?.start()
            observeSession()
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(10))
            timer.setEventHandler { [weak self] in self?.tick() }
            monitor = timer
            timer.resume()
            Diagnostics.event(.audio, "ENGINE_STARTED sample_rate=48000 startup_buffer_s=4")
        }
    }

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setPreferredSampleRate(Self.defaultSampleRate)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
    }

    private func buildGraph() {
        if let player { player.removeTap(onBus: 0) }
        engine?.stop()
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0
        let analyzer = self.analyzer
        player.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            analyzer.consume(buffer)
        }
        self.engine = engine
        self.player = player
        engine.prepare()
    }

    func play() {
        queue.async { [self] in
            guard !closed else { return }
            let restarting = !wanted
            wanted = true
            waitingSince = Diagnostics.now
            stallReported = false
            if restarting || timeline.phase == .paused || timeline.phase == .stopped {
                clear(to: .buffering, reason: "play", resetTarget: true)
            }
            if !interrupted {
                do {
                    try activateSession()
                    if engine?.isRunning != true { try engine?.start() }
                } catch { fail(error); return }
            }
            publish()
        }
    }

    func pause() {
        queue.async { [self] in
            guard !closed else { return }
            wanted = false
            timeline.clear(to: .paused)
            publish()
            ramp(to: 0, seconds: 0.08) { [weak self] in
                self?.clear(to: .paused, reason: "pause")
            }
        }
    }

    func flush(reason: String = "stop") {
        queue.async { [self] in
            guard !closed else { return }
            wanted = false
            clear(to: .stopped, reason: reason, resetTarget: true)
        }
    }

    func reset(onSilent: @escaping @Sendable () -> Void) {
        queue.async { [self] in
            guard !closed else { return }
            let resume = wanted
            wanted = false
            timeline.clear(to: .paused)
            ramp(to: 0, seconds: 0.08) { [weak self] in
                guard let self else { return }
                self.clear(to: resume ? .buffering : .paused, reason: "context_reset")
                DispatchQueue.main.async(execute: onSilent)
            }
        }
    }

    func setVolume(_ value: Float) {
        queue.async { [self] in
            guard !closed else { return }
            volume = min(1, max(0, value))
            if wanted, timeline.phase == .playing { ramp(to: volume, seconds: 0.05) }
        }
    }

    func enqueue(_ data: Data, sampleRate: Double = defaultSampleRate) {
        let receivedAt = Diagnostics.now
        queue.async { [self] in
            guard !closed, wanted, !interrupted else { return }
            guard let buffer = makeBuffer(data, rate: sampleRate) else {
                fail(EngineError.invalidAudio)
                return
            }
            let now = Diagnostics.now
            if let lastChunkAt { maxGap = max(maxGap, receivedAt - lastChunkAt) }
            lastChunkAt = receivedAt
            maxQueueDelay = max(maxQueueDelay, now - receivedAt)
            stallReported = false
            chunks += 1
            guard let ticket = timeline.append(frames: Int64(buffer.frameLength)) else {
                fail(EngineError.bufferOverflow)
                return
            }
            player?.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                // Never stop AVAudioPlayerNode from its completion callback.
                self?.queue.async { [weak self] in self?.completed(ticket) }
            }
            if timeline.beginPlayback() {
                Diagnostics.event(.audio, "PLAYBACK_STARTED buffer_s=\(formatSeconds(bufferedOnQueue()))")
                player?.play()
                ramp(to: volume, seconds: 0.08)
            }
            updateDemand()
            publish()
        }
    }

    private func completed(_ ticket: PlaybackTimeline.Ticket) {
        guard !closed else { return }
        if timeline.complete(ticket) {
            rampID &+= 1
            player?.stop()
            engine?.mainMixerNode.outputVolume = 0
            Diagnostics.event(.audio,
                "BUFFER_UNDERRUN count=\(timeline.underruns) rebuffer_target_s=\(timeline.targetSeconds)")
        }
        updateDemand()
        publish()
    }

    private func bufferedOnQueue() -> Double {
        var playhead: Int64?
        if timeline.phase == .playing, let time = player?.lastRenderTime {
            playhead = player?.playerTime(forNodeTime: time)?.sampleTime
        }
        return timeline.remainingSeconds(playhead: playhead)
    }

    private func updateDemand() {
        let buffered = bufferedOnQueue()
        let next = throttled ? buffered > 6 : buffered >= 12
        guard next != throttled else { return }
        throttled = next
        waitingSince = Diagnostics.now
        Diagnostics.event(.audio, "GENERATION_BACKPRESSURE paused=\(next) buffer_s=\(formatSeconds(buffered))")
        onDemand(!next)
    }

    private func tick() {
        guard !closed else { return }
        if wanted, !interrupted, engine?.isRunning != true {
            Diagnostics.event(.audio, "ENGINE_RESTART_REQUESTED")
            recoverGraph(rebuild: false)
        }
        updateDemand()
        publish()
        guard wanted, !interrupted else { return }
        let now = Diagnostics.now
        if !throttled, !stallReported, now - max(lastChunkAt ?? 0, waitingSince) > 15 {
            stallReported = true
            Diagnostics.event(.audio, "STREAM_STALLED")
            onFailure(EngineError.streamStalled)
        }
        guard now >= nextReport else { return }
        nextReport = now + 2
        Diagnostics.event(.audio,
            "AUDIO_HEALTH phase=\(timeline.phase.rawValue) buffer_s=\(formatSeconds(bufferedOnQueue())) target_s=\(timeline.targetSeconds) chunks=\(chunks) max_gap_ms=\(Int(maxGap * 1000)) queue_ms=\(Int(maxQueueDelay * 1000)) engine=\(engine?.isRunning == true) underruns=\(timeline.underruns)")
        maxGap = 0
        maxQueueDelay = 0
    }

    private func publish() {
        let next = Snapshot(phase: timeline.phase, bufferedSeconds: bufferedOnQueue(),
                            targetSeconds: timeline.targetSeconds, underruns: timeline.underruns)
        snapshotLock.lock()
        let changed = cached.phase != next.phase
        cached = next
        snapshotLock.unlock()
        if changed { onState(next) }
    }

    private func clear(to phase: PlaybackTimeline.Phase, reason: String, resetTarget: Bool = false) {
        rampID &+= 1
        timeline.clear(to: phase, resetTarget: resetTarget)
        player?.stop()
        engine?.mainMixerNode.outputVolume = 0
        converters.removeAll()
        if throttled {
            throttled = false
            waitingSince = Diagnostics.now
            onDemand(true)
        }
        Diagnostics.event(.audio, "BUFFER_FLUSH reason=\(reason)")
        publish()
    }

    private func ramp(to target: Float, seconds: Double, done: (() -> Void)? = nil) {
        rampID &+= 1
        let id = rampID
        let start = engine?.mainMixerNode.outputVolume ?? 0
        for step in 1...8 {
            queue.asyncAfter(deadline: .now() + seconds * Double(step) / 8) { [weak self] in
                guard let self, !self.closed, self.rampID == id else { return }
                self.engine?.mainMixerNode.outputVolume = start + (target - start) * Float(step) / 8
                if step == 8 { done?() }
            }
        }
    }

    private func makeBuffer(_ data: Data, rate: Double) -> AVAudioPCMBuffer? {
        guard (8_000...192_000).contains(rate), data.count > 0, data.count % 4 == 0,
              let sourceFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2),
              let source = AVAudioPCMBuffer(pcmFormat: sourceFormat,
                                           frameCapacity: AVAudioFrameCount(data.count / 4)),
              let channels = source.floatChannelData else { return nil }
        source.frameLength = source.frameCapacity
        data.withUnsafeBytes { raw in
            for frame in 0..<Int(source.frameLength) {
                channels[0][frame] = Float(Int16(littleEndian:
                    raw.loadUnaligned(fromByteOffset: frame * 4, as: Int16.self))) / 32768
                channels[1][frame] = Float(Int16(littleEndian:
                    raw.loadUnaligned(fromByteOffset: frame * 4 + 2, as: Int16.self))) / 32768
            }
        }
        if rate == Self.defaultSampleRate { return source }
        let converter: AVAudioConverter
        if let cached = converters[rate] { converter = cached }
        else {
            guard let created = AVAudioConverter(from: sourceFormat, to: format) else { return nil }
            converters[rate] = created
            converter = created
        }
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * 48_000 / rate)) + 256
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            status.pointee = supplied ? .noDataNow : .haveData
            if supplied { return nil }
            supplied = true
            return source
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }

    private func observeSession() {
        let names: [Notification.Name] = [
            AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
            AVAudioSession.mediaServicesWereLostNotification, AVAudioSession.mediaServicesWereResetNotification,
            .AVAudioEngineConfigurationChange,
        ]
        observers = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                self?.queue.async { [weak self] in self?.handle(note) }
            }
        }
    }

    private func handle(_ notification: Notification) {
        guard !closed else { return }
        switch notification.name {
        case AVAudioSession.interruptionNotification:
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let began = raw == AVAudioSession.InterruptionType.began.rawValue
            let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let resume = AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
            interrupted = began
            if !began, !resume { wanted = false }
            clear(to: wanted ? .buffering : .paused, reason: "interruption")
            Diagnostics.event(.audio, "AUDIO_INTERRUPTION began=\(began) resume=\(resume)")
            onInterruption(began, resume)
        case AVAudioSession.routeChangeNotification:
            let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            Diagnostics.event(.audio, "AUDIO_ROUTE_CHANGED reason=\(raw)")
            if raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                wanted = false
                clear(to: .paused, reason: "headphones_removed")
                onInterruption(false, false)
            }
        case AVAudioSession.mediaServicesWereLostNotification:
            interrupted = true
            clear(to: wanted ? .buffering : .paused, reason: "media_services_lost")
            onInterruption(true, false)
        case AVAudioSession.mediaServicesWereResetNotification:
            interrupted = false
            recoverGraph(rebuild: true)
            onInterruption(false, true)
        case .AVAudioEngineConfigurationChange:
            guard let changed = notification.object as? AVAudioEngine, changed === engine else { return }
            Diagnostics.event(.audio, "ENGINE_CONFIGURATION_CHANGED")
            if wanted, !interrupted, engine?.isRunning != true { recoverGraph(rebuild: false) }
        default: break
        }
    }

    private func recoverGraph(rebuild: Bool) {
        clear(to: wanted ? .buffering : .paused, reason: "engine_recovery")
        do {
            if rebuild { buildGraph() }
            guard wanted, !interrupted else { return }
            try activateSession()
            try engine?.start()
            waitingSince = Diagnostics.now
        } catch { fail(error) }
    }

    private func fail(_ error: Error) {
        wanted = false
        clear(to: .stopped, reason: "audio_error")
        Diagnostics.failure(.audio, "PLAYBACK_FAILED", error)
        onFailure(error)
    }

    func close() {
        queue.sync {
            guard !closed else { return }
            closed = true
            wanted = false
            monitor?.cancel()
            monitor = nil
            observers.forEach { NotificationCenter.default.removeObserver($0) }
            observers.removeAll()
            clear(to: .stopped, reason: "close")
            player?.removeTap(onBus: 0)
            engine?.stop()
            player = nil
            engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func formatSeconds(_ value: Double) -> String { String(format: "%.3f", value) }
}
