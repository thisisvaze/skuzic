import AVFoundation
import Foundation

/// The pen's own sound, ported from src/audio/touch.ts: a quiet paper friction
/// under every stroke, felt more than heard, whose grain speeds up with the pen.
///
/// It runs its own AVAudioEngine, as the web version runs its own AudioContext,
/// so it plays while the bed is paused, buffering or not there at all. The
/// AVAudioSession stays PcmScheduler's.
///
/// Call it from one thread, the one handling touches. Decisions are cheap
/// arithmetic made right there, where the meter is read too; anything that
/// touches the audio graph hops to a private serial queue, so a pencil sample
/// never waits on Core Audio. Times are seconds on the UITouch.timestamp clock
/// (system uptime).
final class TouchEngine {
    // The constants are touch.ts's, tuned by measurement there; times in seconds.

    /// Pen speed, in points per second, that drives the paper to full level.
    private static let fullSpeed = 1400.0
    /// The calibration knob for the whole layer, balanced against the bed by ear.
    private static let level: Float = 0.6
    /// The paper should be felt, not followed.
    private static let paper = 0.05
    /// A pen that stops moving goes quiet this long after, like a real one.
    private static let still: TimeInterval = 0.060

    /// Grain speed, low-pass and paper per tool. Kept dark: the top octave of
    /// paper noise is hiss, and hiss is what tires.
    private static func tone(_ tool: PenTool) -> (rate: Double, lowpass: Float, rough: Bool) {
        switch tool {
        case .pencil: return (1, 4200, true)
        case .marker: return (0.85, 2400, false)
        case .eraser: return (0.55, 1300, false)
        }
    }

    /// Paper level 0...1 from speed (points per second) and pressure. A still pen is silent.
    static func frictionLevel(speed: Double, pressure: Double) -> Double {
        // Pressure shapes the level but never mutes it, since a finger reports a flat 0.5.
        pow(clamp01(speed / fullSpeed), 0.7) * (0.4 + 0.6 * clamp01(pressure))
    }

    private typealias Point = (x: Double, y: Double, t: TimeInterval)
    private let graph = Graph()
    private var meter: () -> Float = { 0 }
    private var closed = false

    private var tool = PenTool.pencil
    private var opacity = 1.0
    private var width = 1.0
    private var last: Point?
    private var speed = 0.0
    private var lastSteer = -Double.infinity

    /// Builds the graph off the caller's thread. The engine itself starts with
    /// the first stroke, as a web AudioContext waits for a gesture, so making
    /// one early doesn't take the audio hardware.
    init() {
        graph.run { $0.build() }
    }

    /// The bed's current level, 0...1, so the pen can make room when the music
    /// is loud. Called on the caller's thread, only when a steer needs it.
    func listen(_ meter: @escaping () -> Float) {
        self.meter = meter
    }

    /// Pen down, in points from the canvas's top-left.
    func down(x: CGFloat, y: CGFloat, pressure: CGFloat, time: TimeInterval,
              width: CGFloat, height: CGFloat, tool: PenTool, opacity: CGFloat) {
        guard !closed else { return }
        self.width = width > 0 ? Double(width) : 1
        last = (Double(x), Double(y), time)
        speed = 0
        self.tool = tool
        self.opacity = Double(opacity)
        let tone = Self.tone(tool), pan = Float(panAt(Double(x)))
        graph.run { $0.down(tone: tone, pan: pan) }
    }

    func move(x: CGFloat, y: CGFloat, pressure: CGFloat, time: TimeInterval) {
        guard !closed, let last else { return }
        let x = Double(x), y = Double(y), dt = time - last.t
        // Coalesced samples can share a timestamp; their distance counts in the next.
        guard dt > 0 else { return }
        let step = hypot(x - last.x, y - last.y)
        // A 240 Hz pencil reports jittery per-sample speeds, so smooth over ~40 ms.
        speed += (step / dt - speed) * (1 - exp(-dt / 0.040))
        self.last = (x, y, time)

        // Touch samples outpace what the ear needs, and each steer is a hop to the audio queue.
        guard time - lastSteer >= 0.015 else { return }
        lastSteer = time
        let level = Self.paper * Self.frictionLevel(speed: speed, pressure: Double(pressure))
            * (0.5 + 0.5 * opacity) * (1 - 0.3 * clamp01(Double(meter())))
        let rate = Self.tone(tool).rate * (0.7 + 0.6 * clamp01(speed / Self.fullSpeed))
        let pan = panAt(x)
        graph.run { $0.steer(level: Float(level), rate: Float(rate), pan: Float(pan)) }
    }

    func up(time: TimeInterval) {
        guard !closed else { return }
        last = nil
        graph.run { $0.up() }
    }

    /// The page was cleared: a soft swish.
    func clear() {
        guard !closed else { return }
        graph.run { $0.swish() }
    }

    func close() {
        guard !closed else { return }
        closed = true
        graph.run { $0.close() }
    }

    /// Wide, but never hard left or right.
    private func panAt(_ x: Double) -> Double { (clamp01(x / width) - 0.5) * 1.1 }
}

enum PenTool { case pencil, marker, eraser }

private func clamp01(_ value: Double) -> Double { min(1, max(0, value)) }

private extension TouchEngine {
    /// Every node and the paper's easing, touched only on `queue`.
    final class Graph: @unchecked Sendable {
        private let queue = DispatchQueue(label: "skuzic.audio.touch", qos: .userInteractive)
        private let engine = AVAudioEngine()
        private let out = AVAudioMixerNode()
        private let paperPlayer = AVAudioPlayerNode()
        private let paperSpeed = AVAudioUnitVarispeed()
        private let paperTone = AVAudioUnitEQ(numberOfBands: 3)
        private let paperBus = AVAudioMixerNode()
        private let swishPlayer = AVAudioPlayerNode()
        private var rough: AVAudioPCMBuffer?
        private var smooth: AVAudioPCMBuffer?
        private var looping: AVAudioPCMBuffer?
        private var wired = false
        private var closed = false

        // Web Audio automates the paper per sample; here a 120 Hz timer eases the
        // level, grain and place toward the same targets with the same time constants.
        private var timer: DispatchSourceTimer?
        private var lastTick: TimeInterval = 0
        private var level: Float = 0
        private var goal: Float = 0
        private var stillAt: TimeInterval = 0
        private var released = true
        private var stopAt: TimeInterval?
        private var rate: Float = 0.7
        private var rateGoal: Float = 0.7
        private var pan: Float = 0
        private var panGoal: Float = 0

        deinit { timer?.cancel() }

        func run(_ body: @escaping @Sendable (Graph) -> Void) {
            queue.async { body(self) }
        }

        func build() {
            let mono = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
            let stereo = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
            rough = Self.paper(roughness: 0.85, format: mono)
            smooth = Self.paper(roughness: 0.35, format: mono)

            let nodes: [AVAudioNode] = [out, paperPlayer, paperSpeed, paperTone, paperBus, swishPlayer]
            nodes.forEach(engine.attach)
            do {
                try link(out, to: engine.mainMixerNode, format: stereo)
                try link(paperPlayer, to: paperSpeed, format: mono)
                try link(paperSpeed, to: paperTone, format: mono)
                try link(paperTone, to: paperBus, format: mono)
                try link(paperBus, to: out, format: mono)
                try link(swishPlayer, to: out, format: mono)
            } catch { return }
            wired = true
            out.outputVolume = TouchEngine.level
            paperBus.outputVolume = 0
            // Band 0, the low-pass, follows the tool; Web Audio's Q 0.9 peak becomes octaves.
            let bands = paperTone.bands
            bands[0].filterType = .lowPass
            bands[1].filterType = .highPass
            bands[1].frequency = 700
            bands[2].filterType = .parametric
            bands[2].frequency = 3200
            bands[2].bandwidth = Float(2 / log(2.0) * asinh(1 / (2 * 0.9)))
            bands[2].gain = 5
            bands.forEach { $0.bypass = false }
        }

        func down(tone: (rate: Double, lowpass: Float, rough: Bool), pan: Float) {
            guard start(), let buffer = tone.rough ? rough : smooth else { return }
            stopAt = nil
            paperTone.bands[0].frequency = tone.lowpass
            rate = Float(tone.rate * 0.7)
            rateGoal = rate
            self.pan = pan
            panGoal = pan
            paperSpeed.rate = rate
            paperBus.pan = Self.panning(pan)
            // A stroke right after another keeps the loop going. The web starts a
            // fresh source behind an 8 ms fade-in instead, which needs automation.
            if looping !== buffer || !paperPlayer.isPlaying {
                paperPlayer.stop()
                // A different stretch of paper every stroke, so no two strokes rasp alike.
                if let tail = Self.slice(buffer, from: Int.random(in: 0..<Int(buffer.frameLength))) {
                    paperPlayer.scheduleBuffer(tail, completionHandler: nil)
                }
                paperPlayer.scheduleBuffer(buffer, at: nil, options: .loops, completionHandler: nil)
                Self.play(paperPlayer)
                looping = buffer
            }
            if timer == nil { startTimer() }
        }

        func steer(level: Float, rate: Float, pan: Float) {
            // Re-armed on every steer: if no movement follows, the pen falls quiet.
            goal = level
            rateGoal = rate
            panGoal = pan
            released = false
            stillAt = ProcessInfo.processInfo.systemUptime + TouchEngine.still
        }

        /// Lets the paper whisper out rather than cut.
        func up() {
            released = true
            stopAt = ProcessInfo.processInfo.systemUptime + 0.3
        }

        func swish() {
            guard engine.isRunning, let smooth, let sound = Self.swish(smooth) else { return }
            swishPlayer.stop()
            swishPlayer.pan = Self.panning(pan)
            swishPlayer.scheduleBuffer(sound, completionHandler: nil)
            Self.play(swishPlayer)
        }

        func close() {
            closed = true
            timer?.cancel()
            timer = nil
            engine.stop()
        }

        /// Only a stroke starts the engine, as only a gesture may resume a web
        /// AudioContext, so a clear before the first stroke stays silent. An
        /// interruption or a route change stops it; the next stroke restarts it.
        private func start() -> Bool {
            guard wired, !closed else { return false }
            if engine.isRunning { return true }
            paperPlayer.stop()
            looping = nil
            do { try engine.start() } catch { return false }
            return true
        }

        private func startTimer() {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: 1.0 / 120, leeway: .milliseconds(1))
            timer.setEventHandler { [weak self] in self?.tick() }
            lastTick = ProcessInfo.processInfo.systemUptime
            self.timer = timer
            timer.resume()
        }

        private func tick() {
            let now = ProcessInfo.processInfo.systemUptime
            let dt = now - lastTick
            lastTick = now
            let (target, tau): (Float, TimeInterval) =
                released ? (0, 0.04) : now < stillAt ? (goal, 0.015) : (0, 0.06)
            level += (target - level) * Float(1 - exp(-dt / tau))
            rate += (rateGoal - rate) * Float(1 - exp(-dt / 0.05))
            pan += (panGoal - pan) * Float(1 - exp(-dt / 0.05))
            paperBus.outputVolume = level
            paperSpeed.rate = rate
            paperBus.pan = Self.panning(pan)
            guard let stopAt, now >= stopAt else { return }
            paperPlayer.stop()
            looping = nil
            self.stopAt = nil
            timer?.cancel()
            timer = nil
        }

        /// Wires `node` into `targets`, mixers on their next free input. The
        /// non-throwing connect is deprecated from iOS 27 and its replacement needs
        /// iOS 27, so every connection comes through here. Older SDKs (Xcode 26,
        /// still CI's default) don't have the replacement at all, hence the #if.
        private func link(_ node: AVAudioNode, to targets: AVAudioNode..., format: AVAudioFormat) throws {
            let points = targets.map {
                AVAudioConnectionPoint(node: $0, bus: ($0 as? AVAudioMixerNode)?.nextAvailableInputBus ?? 0)
            }
            #if compiler(>=6.4)
            if #available(iOS 27, macOS 27, *) {
                try engine.connectNode(node, to: points, fromBus: 0, format: format)
            } else {
                engine.connect(node, to: points, fromBus: 0, format: format)
            }
            #else
            engine.connect(node, to: points, fromBus: 0, format: format)
            #endif
        }

        /// Same story as `link`: `play` is deprecated from iOS 27, `playAudio` needs it.
        private static func play(_ player: AVAudioPlayerNode, at time: AVAudioTime? = nil) {
            #if compiler(>=6.4)
            if #available(iOS 27, macOS 27, *) {
                try? player.playAudio(at: time)
            } else {
                player.play(at: time)
            }
            #else
            player.play(at: time)
            #endif
        }

        /// A mono bus panned to exactly 0 plays at full level on both sides, 3 dB
        /// over the equal-power law the mixer (like Web Audio's panner) uses at
        /// every other position, so the centre is nudged off zero.
        private static func panning(_ pan: Float) -> Float { pan == 0 ? 0.0001 : pan }

        /// Friction noise roughened by a slowly varying envelope: the grain a nib
        /// drags across paper tooth. Played faster, the grain gets denser and
        /// brighter, which is what a quicker stroke sounds like.
        private static func paper(roughness: Double, format: AVAudioFormat) -> AVAudioPCMBuffer? {
            let length = Int(format.sampleRate * 4)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length)),
                  let data = buffer.floatChannelData?[0] else { return nil }
            buffer.frameLength = AVAudioFrameCount(length)
            let k = 1 - exp(-2 * Double.pi * 140 / format.sampleRate)
            var tooth = 0.0, sum = 0.0
            for i in 0..<length {
                tooth += (abs(Double.random(in: -1..<1)) - tooth) * k
                data[i] = Float(tooth)
                sum += tooth
            }
            let mean = sum / Double(length)
            for i in 0..<length {
                data[i] = Float(Double.random(in: -1..<1) * (1 - roughness + roughness * Double(data[i]) / mean))
            }
            return buffer
        }

        /// The clear swish, rendered here because AVAudioEngine can't sweep a filter:
        /// smooth paper at 1.4x from a random spot, through Web Audio's band-pass
        /// (Q 0.8) gliding from 5.2 kHz to 700 Hz, with a quick swell and a soft tail.
        private static func swish(_ noise: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
            let rate = noise.format.sampleRate
            let frames = Int(rate * 0.9)
            guard let sound = AVAudioPCMBuffer(pcmFormat: noise.format, frameCapacity: AVAudioFrameCount(frames)),
                  let source = noise.floatChannelData?[0], let data = sound.floatChannelData?[0] else { return nil }
            let length = Int(noise.frameLength)
            var position = Double.random(in: 0..<3) * rate
            var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
            var count = 0
            while count < frames, Int(position) + 1 < length {
                let t = Double(count) / rate
                let i = Int(position), along = position - Double(i)
                let x = Double(source[i]) + Double(source[i + 1] - source[i]) * along
                position += 1.4
                let w = 2 * Double.pi * 5200 * pow(700.0 / 5200, min(t, 0.45) / 0.45) / rate
                let alpha = sin(w) / (2 * 0.8)
                let y = (alpha * (x - x2) + 2 * cos(w) * y1 - (1 - alpha) * y2) / (1 + alpha)
                (x2, x1, y2, y1) = (x1, x, y1, y)
                let amp = t < 0.08 ? 0.12 * t / 0.08 : t < 0.12 ? 0.12 : 0.12 * exp(-(t - 0.12) / 0.12)
                data[count] = Float(y * amp)
                count += 1
            }
            sound.frameLength = AVAudioFrameCount(count)
            return count > 0 ? sound : nil
        }

        /// A copy of `buffer` from frame `start` on.
        private static func slice(_ buffer: AVAudioPCMBuffer, from start: Int) -> AVAudioPCMBuffer? {
            let frames = Int(buffer.frameLength) - start
            guard frames > 0,
                  let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(frames)),
                  let from = buffer.floatChannelData, let to = copy.floatChannelData else { return nil }
            for channel in 0..<Int(buffer.format.channelCount) {
                to[channel].update(from: from[channel] + start, count: frames)
            }
            copy.frameLength = AVAudioFrameCount(frames)
            return copy
        }
    }
}
