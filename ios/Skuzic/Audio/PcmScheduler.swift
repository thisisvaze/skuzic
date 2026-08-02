import AVFoundation
import Foundation

/// Lyria emits audio faster than real time in bursts. This buffers those chunks
/// and plays them back gapless.
///
/// `AVAudioPlayerNode` already queues scheduled buffers back to back on its own
/// sample clock, so unlike the Web Audio version there is no manual `nextTime`
/// bookkeeping — the only timing decision left is holding playback until enough
/// audio has landed to absorb jitter in the stream.
final class PcmScheduler {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()

    /// Lyria's documented output: 48kHz stereo 16-bit PCM.
    static let defaultSampleRate: Double = 48000
    private static let channels: AVAudioChannelCount = 2

    private let format: AVAudioFormat
    private let queue = DispatchQueue(label: "skuzic.audio", qos: .userInitiated)
    private let lock = NSLock()

    /// Audio held before playback starts, absorbing jitter in the stream. This
    /// is pure added latency on every steer, so keep it just above the worst
    /// inter-chunk gap rather than "comfortably large".
    private let leadIn: Double = 0.4

    /// A context reset drops every queued buffer, so there is an unavoidable gap
    /// while the model regenerates. Ducking either side of it turns a click plus
    /// abrupt re-entry into a deliberate-sounding swell.
    private static let resetDuck: Double = 0.15

    private var scheduledFrames: AVAudioFramePosition = 0
    private var playedBase: AVAudioFramePosition = 0
    private var started = false
    private var converters: [Double: AVAudioConverter] = [:]

    /// The user's level, tracked so a duck can restore it.
    private var volume: Float
    /// Set by reset(); playback resumes with a fade instead of cutting in.
    private var fadeInPending = false

    private let analyzer: SpectrumAnalyzer

    init(volume: Float = 0.8) {
        format = AVAudioFormat(
            standardFormatWithSampleRate: Self.defaultSampleRate,
            channels: Self.channels
        )!
        analyzer = SpectrumAnalyzer(sampleRate: Self.defaultSampleRate)

        // Category first, because the next line reads `mainMixerNode`, and that
        // getter is what makes the mixer -> output connection — resolved against
        // whichever route is current right then. Before the category is set that
        // is the default route, not the one playback will actually use.
        Self.configureSession()

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = volume
        // Before installTap: that closure captures self, so every stored
        // property must be initialised by this point.
        self.volume = volume

        // Tapped on the player, ahead of the mixer's output volume, so the
        // meter reads the music rather than the volume slider.
        player.installTap(
            onBus: 0,
            bufferSize: AVAudioFrameCount(SpectrumAnalyzer.frameCount),
            format: format
        ) { [weak self] buffer, _ in
            self?.analyzer.consume(buffer)
        }
    }

    /// Band energies 0..1 for the equalizer meter.
    func levels(bands: Int) -> [Float] {
        analyzer.levels(bands: bands)
    }

    /// Seconds of audio queued ahead of the playhead.
    var bufferedSeconds: Double {
        lock.lock()
        defer { lock.unlock() }
        return max(0, Double(scheduledFrames - playedFramesLocked()) / format.sampleRate)
    }

    private func playedFramesLocked() -> AVAudioFramePosition {
        guard started,
              let nodeTime = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: nodeTime)
        else { return playedBase }
        return playedBase + playerTime.sampleTime
    }

    /// .playback so the ringer switch does not silence the instrument. There is
    /// deliberately no background audio mode: playback is paused when the app
    /// leaves the screen.
    private static func configureSession() {
        try? AVAudioSession.sharedInstance()
            .setCategory(.playback, mode: .default, options: [])
    }

    func start() throws {
        Self.configureSession()
        try AVAudioSession.sharedInstance().setActive(true)

        engine.prepare()
        try engine.start()
    }

    /// Re-arm after the system took the engine away.
    ///
    /// Without a background audio mode the session is deactivated whenever the
    /// app leaves the screen, and an interruption (Siri, a call) does the same
    /// mid-session. Either one stops `AVAudioEngine`, which does not restart
    /// itself — so buffers scheduled afterwards render nowhere and the app is
    /// silent until relaunch. Every resume path goes through here.
    func ensureRunning() {
        guard !engine.isRunning else { return }
        // Whatever was queued never rendered. Dropping it also clears `started`,
        // so playback re-primes through the lead-in instead of waiting on a
        // playhead that will never advance.
        flush()
        try? AVAudioSession.sharedInstance().setActive(true)
        engine.prepare()
        try? engine.start()
    }

    /// Raw interleaved little-endian int16, exactly as the socket delivers it.
    func enqueue(_ data: Data, sampleRate: Double = defaultSampleRate) {
        queue.async { [weak self] in
            self?.scheduleNow(data, sampleRate: sampleRate)
        }
    }

    private func scheduleNow(_ data: Data, sampleRate: Double) {
        guard let source = makeBuffer(data, sampleRate: sampleRate) else { return }

        // The player node only accepts buffers in its connected format, so a
        // chunk arriving at some other rate has to be resampled first.
        let buffer: AVAudioPCMBuffer
        if sampleRate == format.sampleRate {
            buffer = source
        } else if let converted = convert(source, from: sampleRate) {
            buffer = converted
        } else {
            return
        }

        guard buffer.frameLength > 0 else { return }
        player.scheduleBuffer(buffer, completionHandler: nil)

        lock.lock()
        scheduledFrames += AVAudioFramePosition(buffer.frameLength)
        let ready = Double(scheduledFrames - playedFramesLocked()) / format.sampleRate >= leadIn
        let shouldStart = !started && ready
        if shouldStart { started = true }
        lock.unlock()

        if shouldStart {
            // First audio back after a reset: swell in rather than cut in.
            if fadeInPending {
                fadeInPending = false
                engine.mainMixerNode.outputVolume = 0
                player.play()
                ramp(to: volume, over: Self.resetDuck)
            } else {
                player.play()
            }
        }
    }

    private func makeBuffer(_ data: Data, sampleRate: Double) -> AVAudioPCMBuffer? {
        let bytesPerFrame = 2 * Int(Self.channels)
        let frames = data.count / bytesPerFrame
        guard frames > 0,
              let sourceFormat = AVAudioFormat(
                  standardFormatWithSampleRate: sampleRate, channels: Self.channels),
              let buffer = AVAudioPCMBuffer(
                  pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(frames)),
              let channelData = buffer.floatChannelData
        else { return nil }

        buffer.frameLength = AVAudioFrameCount(frames)

        // De-interleave int16 pairs into the node's float32 planar layout.
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            let left = channelData[0]
            let right = channelData[1]
            for i in 0..<frames {
                left[i] = Float(Int16(littleEndian: samples[i * 2])) / 32768
                right[i] = Float(Int16(littleEndian: samples[i * 2 + 1])) / 32768
            }
        }

        return buffer
    }

    private func convert(_ source: AVAudioPCMBuffer, from rate: Double) -> AVAudioPCMBuffer? {
        let converter: AVAudioConverter
        if let cached = converters[rate] {
            converter = cached
        } else {
            guard let made = AVAudioConverter(from: source.format, to: format) else { return nil }
            converters[rate] = made
            converter = made
        }

        let ratio = format.sampleRate / rate
        let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            return nil
        }

        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return source
        }

        return error == nil ? out : nil
    }

    /// Steps the mixer level, since `outputVolume` has no built-in ramp.
    private func ramp(to target: Float, over seconds: Double, then done: (() -> Void)? = nil) {
        let steps = 12
        let start = engine.mainMixerNode.outputVolume
        let interval = seconds / Double(steps)
        for step in 1...steps {
            queue.asyncAfter(deadline: .now() + interval * Double(step)) { [weak self] in
                guard let self else { return }
                let progress = Float(step) / Float(steps)
                self.engine.mainMixerNode.outputVolume = start + (target - start) * progress
                if step == steps { done?() }
            }
        }
    }

    /// Duck out, drop the queue, then hand back so the caller can reset the
    /// model while nothing is audible. Playback fades back in.
    ///
    /// `onSilent` fires at the bottom of the duck — that is the moment to tell
    /// the model to restart, so its gap lands inside our silence.
    func reset(onSilent: @escaping () -> Void) {
        ramp(to: 0, over: Self.resetDuck) { [weak self] in
            guard let self else { return }
            self.flushOnQueue()
            self.fadeInPending = true
            // Back to the main actor: the callback talks to the socket, which
            // the engine owns and only touches there.
            DispatchQueue.main.async(execute: onSilent)
        }
    }

    func setVolume(_ volume: Float) {
        self.volume = volume
        engine.mainMixerNode.outputVolume = volume
    }

    /// Drop everything queued — used on stop, so old audio doesn't outlive it.
    func flush() {
        queue.sync { self.flushOnQueue() }
    }

    /// The body of `flush()`, for callers already running on `queue`.
    ///
    /// `queue` is serial, so hopping back onto it with a `sync` from a block it
    /// is already running deadlocks the thread outright — and since `enqueue`
    /// is an `async` onto the same queue, that is silence for the rest of the
    /// session, not a glitch.
    private func flushOnQueue() {
        dispatchPrecondition(condition: .onQueue(queue))
        player.stop()
        lock.lock()
        scheduledFrames = 0
        playedBase = 0
        started = false
        lock.unlock()
    }

    func close() {
        flush()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
