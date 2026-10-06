import AVFoundation
import Foundation

/// The pen's own sound, ported from src/audio/touch.ts, whose header explains
/// the musical design: a quiet paper friction under every stroke, and a few soft
/// piano notes voice-led into a slow F major pentatonic line that backs off as
/// you settle into drawing.
///
/// It runs its own AVAudioEngine, as the web version runs its own AudioContext,
/// so it plays while the bed is paused, buffering or not there at all. The
/// AVAudioSession stays PcmScheduler's. The piano is piano-<midi>.mp3 from
/// public/sounds, in the bundle's Sounds folder or at its root; without it the
/// paper still plays.
///
/// Call it from one thread, the one handling touches. Musical decisions are
/// cheap arithmetic made right there, where the meter is read too; anything
/// that touches the audio graph hops to a private serial queue, so a pencil
/// sample never waits on Core Audio. Times are seconds on the UITouch.timestamp
/// clock (system uptime).
///
/// ponytail: the key is fixed to F major / D minor, as on the web. Transpose
/// `notes` from the mix's scale if the scale picker stays.
final class TouchEngine {
    // The constants are touch.ts's, tuned by measurement there; times in seconds.

    /// Semitones above F: F G A C D.
    private static let pentatonic = [0, 2, 4, 7, 9]
    /// The melody's range as MIDI notes, F4 to F6.
    static let notes: [Int] = (0..<11).map { (i: Int) -> Int in 65 + 12 * (i / 5) + pentatonic[i % 5] }
    private static let top = notes.count - 1
    /// Soft Kawai samples; every note above sits within two semitones of one.
    private static let pianoRoots = [66, 68, 72, 75, 78, 81, 84, 87]

    /// Pen speed, in points per second, that drives the paper to full level.
    private static let fullSpeed = 1400.0
    /// The calibration knob for the whole layer, balanced against the bed by ear.
    private static let level: Float = 0.6
    /// Paper sits far under the notes: it should be felt, not followed.
    private static let paper = 0.05
    private static let reverb: Float = 0.32
    /// A pen that stops moving goes quiet this long after, like a real one.
    private static let still: TimeInterval = 0.060
    /// Attention: where it settles after long drawing, and how fast it goes and comes back.
    private static let settled = 0.45
    private static let settleTime: TimeInterval = 90
    private static let returnTime: TimeInterval = 10
    /// Counts as still drawing if the pen was busy this recently.
    private static let busy: TimeInterval = 1.5
    /// The shortest gap between notes at full attention; it widens as attention settles.
    private static let noteGap: TimeInterval = 0.38
    /// After this long without drawing, the next stroke always starts a fresh phrase.
    private static let phraseGap: TimeInterval = 2
    /// F, A and C: the notes a phrase comes home to.
    private static let home = [5, 9, 0]

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

    /// The next melody note, an index into `notes`: one or two steps from the
    /// last, leaning toward `aim` (where on the page the pen is, 0...top). Height
    /// steers the line instead of picking pitches, so strokes build a tune rather
    /// than random notes. `resolve` marks the last note of a phrase, which lands
    /// on F, A or C, a step or less from where it was heading.
    static func nextNote(_ prev: Int?, aim: Double, rand: () -> Double, resolve: Bool = false) -> Int {
        var next: Int
        if let prev {
            let lean = aim - Double(prev) > 0.75 ? 1 : aim - Double(prev) < -0.75 ? -1 : 0
            // Steps by preference: mostly a neighbour, sometimes a skip, now and then a repeat.
            let steps = lean != 0 ? [lean, lean, lean, 2 * lean, 0, -lean] : [1, -1, 1, -1, 2, -2, 0]
            next = prev + steps[min(steps.count - 1, Int(rand() * Double(steps.count)))]
            if next == prev && rand() < 0.5 { next = prev + (lean != 0 ? lean : 1) }
            next = min(top, max(0, next))
        } else {
            next = Int(min(Double(top), max(0, aim)).rounded())
        }
        func isHome(_ index: Int) -> Bool { home.contains(notes[index] % 12) }
        if !resolve || isHome(next) { return next }
        // Every note in this scale has F, A or C within one step, so this always finds one.
        return [next + 1, next - 1].first { (0...top).contains($0) && isHome($0) } ?? next
    }

    /// A phrase's length in notes, and the breath after it: both follow attention.
    static func phrase(attention: Double, rand: () -> Double) -> (notes: Int, breath: TimeInterval) {
        (2 + Int((3 * attention + rand()).rounded()), 3 + 6 * (1 - attention))
    }

    /// Attention after `dt`: settling toward its floor while drawing, back toward 1 at rest.
    static func attend(_ prev: Double, dt: TimeInterval, drawing: Bool) -> Double {
        drawing
            ? settled + (prev - settled) * exp(-dt / settleTime)
            : 1 + (prev - 1) * exp(-dt / returnTime)
    }

    /// Whether a note may sound now, given the last one and how much attention is left.
    static func mayPlay(now: TimeInterval, last: TimeInterval, attention: Double) -> Bool {
        now - last >= noteGap / attention
    }

    private static func random() -> Double { .random(in: 0..<1) }

    private typealias Point = (x: Double, y: Double, t: TimeInterval)
    private let graph = Graph()
    private var meter: () -> Float = { 0 }
    private var closed = false

    private var tool = PenTool.pencil
    private var opacity = 1.0
    private var width = 1.0
    private var height = 1.0
    private var start: Point?
    private var last: Point?
    private var travel = 0.0
    private var speed = 0.0
    private var lastSteer = -Double.infinity

    private var attention = 1.0
    private var lastActive = -Double.infinity
    private var attentionAt = -Double.infinity
    private var melody: Int?
    private var lastNote = -Double.infinity
    /// Notes left in the current phrase, and when the breath after it ends.
    private var phraseLeft = 0
    private var breathUntil = -Double.infinity
    private var lastStroke: (end: TimeInterval, length: TimeInterval) = (-.infinity, .infinity)

    /// Loads the piano and builds the graph off the caller's thread. The engine
    /// itself starts with the first stroke, as a web AudioContext waits for a
    /// gesture, so making one early doesn't take the audio hardware.
    init() {
        graph.run { $0.build() }
    }

    /// The bed's current level, 0...1, so the pen can make room when the band is
    /// loud. Called on the caller's thread, only when a steer or a note needs it.
    func listen(_ meter: @escaping () -> Float) {
        self.meter = meter
    }

    /// Pen down, in points from the canvas's top-left.
    func down(x: CGFloat, y: CGFloat, pressure: CGFloat, time: TimeInterval,
              width: CGFloat, height: CGFloat, tool: PenTool, opacity: CGFloat) {
        guard !closed else { return }
        self.width = width > 0 ? Double(width) : 1
        self.height = height > 0 ? Double(height) : 1
        start = (Double(x), Double(y), time)
        last = start
        travel = 0
        speed = 0
        self.tool = tool
        self.opacity = Double(opacity)
        let restful = time - lastActive
        settle(time)
        let tone = Self.tone(tool), pan = Float(panAt(Double(x)))
        graph.run { $0.down(tone: tone, pan: pan) }

        guard tool != .eraser else { return }
        // Hatching: a quick stroke right after another quick stroke is texture, not melody.
        let hatching = lastStroke.length < 0.18 && time - lastStroke.end < 0.25
        let fresh = restful > Self.phraseGap
        if fresh {
            phraseLeft = Self.phrase(attention: attention, rand: Self.random).notes
            breathUntil = -.infinity
        }
        guard !hatching, Self.mayPlay(now: time, last: lastNote, attention: attention) else { return }
        if phraseLeft <= 0 {
            guard time >= breathUntil else { return } // the pen is breathing
            phraseLeft = Self.phrase(attention: attention, rand: Self.random).notes
        }
        if !fresh && Self.random() > 0.35 + 0.65 * attention { return }
        sing(aim: aim(Double(y)), pressure: Double(pressure), time: time, accent: fresh ? 1 : 0.9)
    }

    func move(x: CGFloat, y: CGFloat, pressure: CGFloat, time: TimeInterval) {
        // A stroke this engine didn't start: sound switched off mid-stroke.
        guard !closed, let last else { return }
        let x = Double(x), y = Double(y), dt = time - last.t
        // Coalesced samples can share a timestamp; their distance counts in the next.
        guard dt > 0 else { return }
        let step = hypot(x - last.x, y - last.y)
        // A 240 Hz pencil reports jittery per-sample speeds, so smooth over ~40 ms.
        speed += (step / dt - speed) * (1 - exp(-dt / 0.040))
        travel += step
        self.last = (x, y, time)
        lastActive = time

        // Touch samples outpace what the ear needs, and each steer is a hop to the audio queue.
        guard time - lastSteer >= 0.015 else { return }
        lastSteer = time
        let level = Self.paper * Self.frictionLevel(speed: speed, pressure: Double(pressure))
            * (0.5 + 0.5 * opacity) * (0.7 + 0.3 * attention) * (1 - 0.3 * band())
        let rate = Self.tone(tool).rate * (0.7 + 0.6 * clamp01(speed / Self.fullSpeed))
        let pan = panAt(x)
        graph.run { $0.steer(level: Float(level), rate: Float(rate), pan: Float(pan)) }
    }

    func up(time: TimeInterval) {
        guard !closed else { return }
        let start = self.start, last = self.last
        self.start = nil
        self.last = nil
        graph.run { $0.up() }
        guard let start, let last else { return }
        let length = last.t - start.t
        lastStroke = (time, length)
        lastActive = time
        // A long, deliberate stroke sometimes lands on a note where it ends.
        if tool != .eraser, phraseLeft > 0, length > 0.9, travel > 180,
           Self.mayPlay(now: time, last: lastNote, attention: attention),
           Self.random() < 0.55 * attention {
            sing(aim: aim(last.y), pressure: 0.4, time: time, accent: 0.75)
        }
    }

    /// The eyes heard a new scene: a soft three-note answer in the centre, rising for bright scenes.
    func cue(bright: Bool) {
        guard !closed else { return }
        attention = min(1, attention + 0.25)
        let from = melody ?? 4
        let base = bright ? min(from, Self.top - 4) : max(from, 4)
        let now = mach_absolute_time()
        for (i, step) in [0, 2, 4].enumerated() {
            play(Self.notes[bright ? base + step : base - step], velocity: 0.42 + 0.06 * Double(i),
                 at: now + AVAudioTime.hostTime(forSeconds: 0.02 + 0.14 * Double(i)), pan: 0)
        }
        melody = bright ? base + 4 : base - 4
        lastNote = ProcessInfo.processInfo.systemUptime
        // Leave the answer some air before the pen's own next phrase.
        phraseLeft = 0
        breathUntil = lastNote + 1.5
    }

    /// The page was cleared: a soft swish, and the next stroke starts a fresh phrase.
    func clear() {
        guard !closed else { return }
        melody = nil
        phraseLeft = 0
        breathUntil = -.infinity
        graph.run { $0.swish() }
    }

    func close() {
        guard !closed else { return }
        closed = true
        graph.run { $0.close() }
    }

    /// One melody note, sometimes with a softer third below it, rolled like a hand.
    private func sing(aim: Double, pressure: Double, time: TimeInterval, accent: Double) {
        phraseLeft -= 1
        let ending = phraseLeft <= 0
        let note = Self.nextNote(melody, aim: aim, rand: Self.random, resolve: ending)
        melody = note
        if ending { breathUntil = time + Self.phrase(attention: attention, rand: Self.random).breath }
        lastNote = time
        let velocity = (0.45 + 0.35 * clamp01(pressure)) * (0.6 + 0.4 * attention)
            * (1 - 0.35 * band()) * accent * (0.9 + Self.random() * 0.2)
        // A few milliseconds of human looseness; never early, so it stays responsive.
        let when = mach_absolute_time() + AVAudioTime.hostTime(forSeconds: Self.random() * 0.012)
        let pan = panAt(last?.x ?? width / 2)
        play(Self.notes[note], velocity: velocity, at: when, pan: pan)
        if note >= 2 && attention > 0.6 && Self.random() < 0.18 {
            play(Self.notes[note - 2], velocity: velocity * 0.55,
                 at: when + AVAudioTime.hostTime(forSeconds: 0.025 + Self.random() * 0.02), pan: pan)
        }
    }

    /// `time` is a host time, so a note lands where it was meant to whatever the queue's delay.
    private func play(_ midi: Int, velocity: Double, at time: UInt64, pan: Double) {
        graph.run { $0.play(midi: midi, velocity: Float(velocity), at: time, pan: Float(pan)) }
    }

    /// Height on the page (0 top) as a place in the melody's range.
    private func aim(_ y: Double) -> Double { (1 - clamp01(y / height)) * Double(Self.top) }

    /// Wide, but never hard left or right.
    private func panAt(_ x: Double) -> Double { (clamp01(x / width) - 0.5) * 1.1 }

    /// The meter comes from outside, so it is held to 0...1.
    private func band() -> Double { clamp01(Double(meter())) }

    private func settle(_ time: TimeInterval) {
        if attentionAt > -.infinity {
            attention = Self.attend(attention, dt: time - attentionAt, drawing: time - lastActive < Self.busy)
        }
        attentionAt = time
        lastActive = time
    }
}

enum PenTool { case pencil, marker, eraser }

private func clamp01(_ value: Double) -> Double { min(1, max(0, value)) }

private extension TouchEngine {
    /// Every node, the voice pool and the paper's easing, touched only on `queue`.
    final class Graph: @unchecked Sendable {
        private struct Voice {
            let player = AVAudioPlayerNode()
            let speed = AVAudioUnitVarispeed()
            let tone = AVAudioUnitEQ(numberOfBands: 1)
            let bus = AVAudioMixerNode()
            var start: UInt64 = 0
            var end: UInt64 = 0
        }

        private let queue = DispatchQueue(label: "skuzic.audio.touch", qos: .userInteractive)
        private let engine = AVAudioEngine()
        private let out = AVAudioMixerNode()
        private let notes = AVAudioMixerNode()
        private let room = AVAudioUnitReverb()
        private let wet = AVAudioMixerNode()
        private let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        private let paperPlayer = AVAudioPlayerNode()
        private let paperSpeed = AVAudioUnitVarispeed()
        private let paperTone = AVAudioUnitEQ(numberOfBands: 3)
        private let paperBus = AVAudioMixerNode()
        private let swishPlayer = AVAudioPlayerNode()
        private var rough: AVAudioPCMBuffer?
        private var smooth: AVAudioPCMBuffer?
        private var looping: AVAudioPCMBuffer?
        private var piano: [Int: AVAudioPCMBuffer] = [:]
        private var voices: [Voice] = []
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
            loadPiano()

            let nodes: [AVAudioNode] = [out, notes, room, wet, limiter, paperPlayer, paperSpeed, paperTone,
                                        paperBus, swishPlayer]
            nodes.forEach(engine.attach)
            do {
                // A burst of notes must never clip. The peak limiter stands in for the
                // web's tanh curve: transparent at playing level, topping out near
                // -2.8 dBFS (tanh: -2.4), for 2 ms of lookahead.
                try link(out, to: limiter, format: stereo)
                try link(limiter, to: engine.mainMixerNode, format: stereo)
                // Notes bloom in a warm room, sent and returned as on the web; the paper stays dry and close.
                try link(notes, to: out, room, format: stereo)
                try link(room, to: wet, format: stereo)
                try link(wet, to: out, format: stereo)
                try link(paperPlayer, to: paperSpeed, format: mono)
                try link(paperSpeed, to: paperTone, format: mono)
                try link(paperTone, to: paperBus, format: mono)
                try link(paperBus, to: out, format: mono)
                try link(swishPlayer, to: out, format: mono)
            } catch { return }
            wired = true
            out.outputVolume = TouchEngine.level
            paperBus.outputVolume = 0
            // Measured on iOS against the web room (2.1 s): medium hall decays in 1.7 s,
            // the nearest preset, and returns within 1.5 dB of its energy from the piano.
            room.loadFactoryPreset(.mediumHall)
            room.wetDryMix = 100
            wet.outputVolume = TouchEngine.reverb
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

            guard let format = piano.values.first?.format else { return }
            // Eight voices, as on the web: at the closest note spacing they outlast a
            // three-second sample, so a voice taken back is usually well into its fade.
            for _ in 0..<8 {
                let voice = Voice()
                let chain: [AVAudioNode] = [voice.player, voice.speed, voice.tone, voice.bus]
                chain.forEach(engine.attach)
                voice.tone.bands[0].filterType = .lowPass
                voice.tone.bands[0].bypass = false
                do {
                    try link(voice.player, to: voice.speed, format: format)
                    try link(voice.speed, to: voice.tone, format: format)
                    try link(voice.tone, to: voice.bus, format: format)
                    try link(voice.bus, to: notes, format: format)
                } catch { break }
                voices.append(voice)
            }
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

        func play(midi: Int, velocity: Float, at time: UInt64, pan: Float) {
            guard engine.isRunning,
                  let root = piano.keys.sorted().min(by: { abs($0 - midi) < abs($1 - midi) }),
                  let sample = piano[root] else { return }
            let now = mach_absolute_time()
            // A free voice, else the one that started longest ago.
            guard let index = voices.indices.first(where: { voices[$0].end <= now })
                    ?? voices.indices.min(by: { voices[$0].start < voices[$1].start }) else { return }
            // Up to 4 cents of detune, so no two notes are quite alike.
            let rate = pow(2, (Double(midi - root) + Double.random(in: -4..<4) / 100) / 12)
            let voice = voices[index]
            voice.player.stop()
            voice.speed.rate = Float(rate)
            // Softer notes are darker, the way felt and a light touch sound.
            voice.tone.bands[0].frequency = 1500 + 3500 * velocity
            voice.bus.volume = velocity
            voice.bus.pan = Self.panning(pan)
            voice.player.scheduleBuffer(sample, completionHandler: nil)
            // A time already past starts it at once.
            Self.play(voice.player, at: AVAudioTime(hostTime: time))
            voices[index].start = time
            voices[index].end = time + AVAudioTime.hostTime(
                forSeconds: Double(sample.frameLength) / sample.format.sampleRate / rate)
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
        /// AudioContext, so a cue or a clear before the first stroke stays silent.
        /// An interruption or a route change stops it; the next stroke restarts it.
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

        /// Every buffer in a voice shares its connection format, so the first piano
        /// file sets it. A missing or odd file leaves its notes to the nearest root.
        private func loadPiano() {
            for root in TouchEngine.pianoRoots {
                let name = "piano-\(root)"
                guard let url = Bundle.main.url(forResource: name, withExtension: "mp3", subdirectory: "Sounds")
                        ?? Bundle.main.url(forResource: name, withExtension: "mp3"),
                      let file = try? AVAudioFile(forReading: url),
                      let frames = AVAudioFrameCount(exactly: file.length),
                      let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames),
                      (try? file.read(into: buffer)) != nil,
                      let sample = Self.trimmed(buffer),
                      piano.values.first.map({ $0.format == sample.format }) ?? true
                else { continue }
                piano[root] = sample
            }
        }

        /// Wires `node` into `targets`, mixers on their next free input. The
        /// non-throwing connect is deprecated from iOS 27 and its replacement needs
        /// iOS 27, so every connection comes through here.
        private func link(_ node: AVAudioNode, to targets: AVAudioNode..., format: AVAudioFormat) throws {
            let points = targets.map {
                AVAudioConnectionPoint(node: $0, bus: ($0 as? AVAudioMixerNode)?.nextAvailableInputBus ?? 0)
            }
            if #available(iOS 27, macOS 27, *) {
                try engine.connectNode(node, to: points, fromBus: 0, format: format)
            } else {
                engine.connect(node, to: points, fromBus: 0, format: format)
            }
        }

        /// Same story as `link`: `play` is deprecated from iOS 27, `playAudio` needs it.
        private static func play(_ player: AVAudioPlayerNode, at time: AVAudioTime? = nil) {
            if #available(iOS 27, macOS 27, *) {
                try? player.playAudio(at: time)
            } else {
                player.play(at: time)
            }
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

        /// Skips the silence an MP3 decoder pads the start with, less a millisecond.
        private static func trimmed(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
            guard let samples = buffer.floatChannelData?[0] else { return nil }
            let count = Int(buffer.frameLength)
            var first = 0
            while first < count && abs(samples[first]) < 0.003 { first += 1 }
            return slice(buffer, from: max(0, first - Int(buffer.format.sampleRate / 1000)))
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
