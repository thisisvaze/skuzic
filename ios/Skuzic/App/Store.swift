import Combine
import CoreGraphics
import Foundation

struct LogEntry: Identifiable {
    let id: Int
    var event: String
    var reasoning = ""
    var actions: [Action] = []
    var error: String?
}

/// The event -> plan -> actions -> state loop, plus keeping the engine in sync
/// with whatever the reducer just produced.
@MainActor
final class SkuzicStore: ObservableObject {
    @Published private(set) var state = SkuzicState()
    @Published private(set) var log: [LogEntry] = []
    @Published private(set) var thinking = false

    @Published private(set) var status: EngineStatus = .idle
    @Published private(set) var statusDetail = ""
    @Published private(set) var buffered: Double = 0
    @Published private(set) var playbackRequested = false

    @Published var masterVolume: Float = Float(Preferences.double(.masterVolume, or: 0.8)) {
        didSet {
            engine.setMasterVolume(masterVolume)
            preview?.setVolume(masterVolume)
            Preferences.set(Double(masterVolume), .masterVolume)
        }
    }

    /// What the band is playing: a mood, a vibe's name, or nil for nothing yet.
    @Published private(set) var scene: String?
    /// The vibe a session starts from. Persisted, like the web build's.
    @Published private(set) var vibeID = Preferences.string(.vibe) ?? "blank"
    /// The vibe whose preview loop is playing, if any.
    @Published private(set) var previewing: String?
    /// The drawing reader loaded; until then (or on a device that can't run it)
    /// following the drawing falls back to asking Gemini.
    @Published private(set) var eyesReady = false
    /// The reader couldn't load (no model in the build, or a system too old for it).
    @Published private(set) var eyesUnavailable = false

    /// Told when the eyes hear a new mood, so the pen can answer before the band does.
    var onCue: ((Bool) -> Void)?

    let book = PaletteBook.shared
    var vibe: Palette.Vibe? { book?.vibe(vibeID) }
    private var eyes: Eyes?
    private var eyesTask: Task<Eyes?, Never>?
    /// The mix the eyes last put on, so a reading that agrees changes nothing.
    private var mix: Mix?
    private var reading = false
    private var readAgain = false
    private var latestPage: (() -> CGImage?)?
    /// Set when the artist picks a vibe with a drawing already there: play now.
    private var startNow = false
    private var preview: VibePreview?
    private var handover: AnyCancellable?
    /// How long the band takes to wind down when the page is wiped.
    private static let clearFade = 3.0

    @Published var autoInterpret = Preferences.bool(.autoInterpret, or: true) {
        didSet { Preferences.set(autoInterpret, .autoInterpret) }
    }

    /// Persisted so the choice survives a relaunch, like the web build's
    /// localStorage entry.
    @Published var plannerModel: PlannerModel = .default {
        didSet {
            planner.model = plannerModel
            Preferences.set(plannerModel.rawValue, .plannerModel)
        }
    }

    /// Which arranger strategy drives the plan. Takes effect on the next tap.
    @Published var plannerConfig: PlannerConfig = .default {
        didSet {
            planner.config = plannerConfig
            Preferences.set(plannerConfig.rawValue, .plannerConfig)
        }
    }

    let engine: LyriaEngine
    private var planner: Planner
    private var logSeq = 0
    private var hasPlayed = false
    private var resumeOnReturn = false
    private var sessionID = UUID()
    private var planSeq = 0

    /// Pad ink — playback must not start while this is false (blank canvas).
    private(set) var canvasHasInk = false

    var connected: Bool { status != .idle && status != .error }
    var playing: Bool { playbackRequested }
    /// The pause button follows user intent while buffering. The visualizer
    /// follows the player's actual state.
    var audible: Bool { status == .playing && buffered > 0 }

    /// Band energies for the equalizer meter.
    func levels(bands: Int) -> [Float]? { engine.levels(bands: bands) }
    @Published private(set) var hasKey = false

    init() {
        Diagnostics.event(.session, "DIAGNOSTICS_READY version=2 health_interval_s=2")
        var key = Preferences.apiKey
        #if DEBUG
        // Scripted Simulator runs pass a key in rather than typing it.
        if key.isEmpty, let dev = ProcessInfo.processInfo.environment["SKUZIC_GEMINI_KEY"], !dev.isEmpty {
            key = dev
            Preferences.apiKey = dev
        }
        #endif
        hasKey = !key.isEmpty
        let model = Preferences.string(.plannerModel).flatMap(PlannerModel.init(rawValue:))
            ?? .default
        let config = Preferences.string(.plannerConfig).flatMap(PlannerConfig.init(rawValue:))
            ?? .default

        engine = LyriaEngine(apiKey: key)
        planner = Planner(apiKey: key, model: model, config: config)
        // Assigned after `planner` exists so the didSet above is a no-op here
        // rather than writing back the value we just read.
        plannerModel = model
        plannerConfig = config

        engine.$status.assign(to: &$status)
        engine.$statusDetail.assign(to: &$statusDetail)
        engine.$bufferedSeconds.assign(to: &$buffered)
        engine.$playbackRequested.assign(to: &$playbackRequested)

        engine.onFilteredPrompt = { [weak self] text, reason in
            self?.push(LogEntry(id: 0, event: "A sound was filtered", error: "“\(text)”: \(reason)"))
        }

        // The band has taken over from a preview: let the preview bow out.
        handover = engine.$status.combineLatest(engine.$bufferedSeconds)
            .sink { [weak self] status, buffered in
                guard status == .playing, buffered > 0, self?.previewing != nil else { return }
                self?.preview?.stop(fade: 2)
            }
    }

    func setApiKey(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let changed = trimmed != Preferences.apiKey
        Preferences.apiKey = trimmed
        hasKey = !trimmed.isEmpty
        planner.apiKey = trimmed
        engine.setApiKey(trimmed)
        if changed, connected { stop() }
    }

    // MARK: - Sketch session

    /// Load a sketch's saved mix. Restoring state directly rather than replaying
    /// actions keeps the ids stable, which is what the planner references.
    func adopt(_ saved: SketchState?) {
        // A sketch that has never been saved has no config of its own, so fall
        // back to the last one dialled in rather than the shipped defaults.
        let restored = saved ?? SketchState(
            tracks: [], config: Preferences.decode(.lastConfig, as: MixConfig.self) ?? MixConfig())
        state = SkuzicState(tracks: restored.tracks, config: restored.config, contextEpoch: 0)
        reserveTrackIDs(restored.tracks)
    }

    var snapshot: SketchState {
        SketchState(tracks: state.tracks, config: state.config)
    }

    /// Leaving a sketch tears the session down so the next one starts clean.
    func endSession() {
        stop()
        canvasHasInk = false
        log = []
        state = SkuzicState()
    }

    // MARK: - The eyes

    /// Loads SigLIP while the band connects, so the first stroke is read at once.
    private func loadEyes() async -> Eyes? {
        if let eyes { return eyes }
        if eyesTask == nil {
            let started = Diagnostics.now
            eyesTask = Task.detached(priority: .utility) {
                do { return try await Eyes.load() } catch {
                    Diagnostics.failure(.drawing, "EYES_LOAD_FAILED", error)
                    return nil
                }
            }
            if let loaded = await eyesTask?.value {
                Diagnostics.event(.drawing, "EYES_READY elapsed_ms=\(Diagnostics.milliseconds(since: started))")
                eyes = loaded
                eyesReady = true
                push(LogEntry(id: 0, event: "Ready to read your drawing (\(Diagnostics.milliseconds(since: started)) ms)"))
            } else {
                eyesUnavailable = true
            }
        }
        return await eyesTask?.value
    }

    /// Pen-up, undo, redo: read the page and move the band if it now reads as
    /// something new. One reading at a time; strokes that land mid-read collapse
    /// into one more read of the newest page. A port of readDrawing in App.tsx.
    func readDrawing(_ page: @escaping () -> CGImage?) async {
        latestPage = page
        if reading {
            readAgain = true
            return
        }
        guard let book, let vibe else {
            Diagnostics.event(.drawing, "READ_SKIPPED palette_missing=true")
            return
        }
        reading = true
        defer { reading = false }
        repeat {
            readAgain = false
            guard connected, let render = latestPage else { return }
            let started = Diagnostics.now
            Diagnostics.event(.drawing, "READ_BEGIN playing=\(mix?.mood.id ?? "none")")
            let playing = mix
            var next: Mix? = playing.map(book.isIntro) == true ? nil : book.introMix(vibe)
            var ink = Ink.none
            var reasoning = "the page is empty"
            if let image = render() {
                guard let eyes = await loadEyes() else {
                    push(LogEntry(id: 0, event: "Couldn't load the drawing reader",
                                  error: "Following the drawing will ask Gemini instead."))
                    return
                }
                let vector: [Float]
                do {
                    vector = try await Task.detached(priority: .userInitiated) { try eyes.read(image) }.value
                } catch {
                    Diagnostics.failure(.drawing, "READ_FAILED", error)
                    push(LogEntry(id: 0, event: "Couldn't read the drawing", error: error.localizedDescription))
                    return
                }
                ink = Ink.read(image)
                let reading = book.readPage(vector, vibe: vibe)
                reasoning = (reading.moods.prefix(2).map { "\($0.item.label) \(Int($0.p * 100))%" }
                    + reading.instruments.prefix(2).map { "\($0.item.label) \(Int($0.p * 100))%" })
                    .joined(separator: " · ")
                next = book.nextMix(reading, playing: playing, vibe: vibe)
                Diagnostics.event(.drawing, "READ_END \(reasoning) -> \(next?.mood.id ?? "hold")")
            }
            guard let current = next ?? playing else { continue }
            // How much ink and how warm it is move the two live knobs on every
            // reading. Starting from silence is also when the vibe's tempo and
            // drums go in: a tempo change restarts the band.
            let knobs = ink.config(density: current.mood.density, brightness: current.mood.brightness)
            var patch = ConfigPatch(density: knobs.density, brightness: knobs.brightness)
            if playing == nil {
                patch.bpm = vibe.bpm
                patch.muteDrums = !vibe.drums
            }
            guard let next else {
                // Gemini's own knob settings stand until the drawing reads as something new.
                if PaletteBook.eyesOwn(state.tracks, current),
                   abs(state.config.density - knobs.density) >= 0.05
                    || abs(state.config.brightness - knobs.brightness) >= 0.05 {
                    dispatch(.setConfig(patch))
                }
                continue
            }
            mix = next
            scene = book.isIntro(next) && vibe != book.defaultVibe ? vibe.name : next.mood.label
            // The pen answers a new mood now; the band takes a few seconds to follow.
            if !book.isIntro(next), next.mood != playing?.mood { onCue?(next.mood.brightness >= 0.5) }
            let actions = book.mixActions(next, config: patch, vibe: vibe)
            dispatch(actions)
            push(LogEntry(
                id: 0,
                event: "Feels like \(next.mood.label): \(next.instruments.map(\.label).joined(separator: " and "))",
                reasoning: "\(reasoning) · read in \(Diagnostics.milliseconds(since: started)) ms",
                actions: actions))
        } while readAgain
    }

    /// Wiping the page lets the band wind down to silence; the next mark brings it back.
    func fadeOut() {
        preview?.stop()
        mix = nil
        scene = nil
        hasPlayed = false
        startNow = false
        if playing { engine.pause(fade: Self.clearFade) }
    }

    /// Pick where to start. On a blank page that's a preview loop of the vibe and
    /// its channels laid out in the mixer; the band itself starts on the first
    /// mark, in the vibe's tempo. With a drawing already there it switches now.
    func pickVibe(_ next: Palette.Vibe, blank: Bool, page: @escaping () -> CGImage?) {
        guard let book else { return }
        vibeID = next.id
        Preferences.set(next.id, .vibe)
        let opening = book.introMix(next)
        let calm = Ink.none.config(density: opening.mood.density, brightness: opening.mood.brightness)
        let calmPatch = ConfigPatch(density: calm.density, brightness: calm.brightness)
        if blank {
            fadeOut()
            if next == book.defaultVibe { return }
            if preview == nil { preview = VibePreview { [weak self] in self?.previewing = $0 } }
            preview?.play(next.id, volume: masterVolume)
            scene = next.name
            dispatch(book.mixActions(opening, config: calmPatch, vibe: next))
            return
        }
        dispatch(.setConfig(ConfigPatch(bpm: next.bpm, muteDrums: !next.drums)))
        if autoInterpret, eyesReady {
            // The music follows the drawing: hear that drawing in the new style.
            mix = nil
            Task { await readDrawing(page) }
            return
        }
        mix = opening
        scene = next.name
        startNow = true
        dispatch(book.mixActions(opening, config: calmPatch, vibe: next))
    }

    // MARK: - Transport

    func start() async {
        guard !connected else { return }
        guard hasKey else { return }

        do {
            engine.setConfig(state.config)
            Task { _ = await loadEyes() }
            try await engine.connect()
            engine.setMasterVolume(masterVolume)

            // Connect always — even on a blank new sketch — so later drawing can
            // interpret and play without another manual Start tap. Audio itself
            // still waits for ink + a live mix (syncPrompts).
            syncPrompts()
        } catch {
            push(LogEntry(id: 0, event: "connect failed", error: error.localizedDescription))
        }
    }

    /// Keep the pad/playback gate in sync. When ink appears and a mix already
    /// exists (e.g. restored sketch), begin playback without a Start tap.
    func noteCanvasHasInk(_ hasInk: Bool) {
        canvasHasInk = hasInk
        if hasInk { syncPrompts() }
    }

    func stop() {
        sessionID = UUID()
        hasPlayed = false
        startNow = false
        resumeOnReturn = false
        mix = nil
        scene = nil
        preview?.stop(fade: 0.3)
        engine.close()
    }

    func togglePlayback() {
        // During a preview the button is the preview's: it stops it.
        if previewing != nil, !playing {
            preview?.stop(fade: 1)
            return
        }
        if playing {
            engine.pause()
        } else if canvasHasInk {
            engine.play()
        }
    }

    /// Generation is only wanted while the app is on screen. Pausing the session
    /// rather than just muting also stops Lyria generating audio nobody hears.
    func suspendForBackground() {
        Diagnostics.event(.session, "APP_BACKGROUND playing=\(playing)")
        guard playing else { return }
        resumeOnReturn = true
        engine.pause()
    }

    func resumeIfSuspended() {
        Diagnostics.event(.session, "APP_ACTIVE resume_pending=\(resumeOnReturn)")
        guard resumeOnReturn, canvasHasInk else { return }
        resumeOnReturn = false
        engine.play()
    }

    // MARK: - The loop

    func trigger(_ event: String, drawing: Data? = nil) async {
        let trimmed = event.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !thinking, connected else { return }

        thinking = true
        defer { thinking = false }
        let requestSession = sessionID
        planSeq += 1
        let requestID = planSeq
        let startedAt = Diagnostics.now
        Diagnostics.event(.planner, "PLAN_BEGIN id=\(requestID) drawing_bytes=\(drawing?.count ?? 0) tracks=\(state.tracks.count) buffer_s=\(String(format: "%.3f", buffered))")

        do {
            let plan = try await planner.plan(event: trimmed, state: state, drawing: drawing)
            guard requestSession == sessionID, connected, !Task.isCancelled else {
                Diagnostics.event(.planner, "PLAN_DISCARDED id=\(requestID) session_changed_or_cancelled=true")
                return
            }
            let actions = drawing == nil ? plan.actions : plan.actions.compactMap(\.preservingPlayback)
            let sanitized = drawing == nil ? 0 : plan.actions.filter { $0.preservingPlayback != $0 }.count
            dispatch(actions)
            Diagnostics.event(.planner, "PLAN_APPLIED id=\(requestID) elapsed_ms=\(Diagnostics.milliseconds(since: startedAt)) actions=\(actions.count) restart_actions_sanitized=\(sanitized) tracks=\(state.tracks.count)")
            if drawing != nil, !actions.isEmpty { scene = "your page, reimagined" }
            push(
                LogEntry(
                    id: 0, event: Self.describe(trimmed, drawing: drawing), reasoning: plan.reasoning,
                    actions: actions))
        } catch {
            guard requestSession == sessionID, !Task.isCancelled else { return }
            Diagnostics.failure(.planner, "PLAN_FAILED id=\(requestID) elapsed_ms=\(Diagnostics.milliseconds(since: startedAt))", error)
            push(LogEntry(id: 0, event: Self.describe(trimmed, drawing: drawing), error: error.localizedDescription))
        }
    }

    /// A log line in the words the mixer uses.
    private static func describe(_ event: String, drawing: Data?) -> String {
        drawing != nil ? "Gemini reimagined your page" : "You asked: \(event)"
    }

    func dispatch(_ actions: [Action]) {
        guard !actions.isEmpty else { return }
        let before = state
        for action in actions {
            state = reduce(state, action)
        }
        sync(from: before)
    }

    func dispatch(_ action: Action) {
        dispatch([action])
    }

    // MARK: - State -> engine

    private func sync(from previous: SkuzicState) {
        if state.tracks != previous.tracks { syncPrompts() }

        if state.config != previous.config {
            Preferences.encode(state.config, .lastConfig)
            engine.setConfig(state.config)
        }

        // One reset per batch, even if both the config and epoch changed.
        if state.config.bpm != previous.config.bpm
            || state.config.scale != previous.config.scale
            || state.contextEpoch != previous.contextEpoch {
            Diagnostics.event(.session, "RESET_REASON tempo_changed=\(state.config.bpm != previous.config.bpm) key_changed=\(state.config.scale != previous.config.scale) explicit_reset=\(state.contextEpoch != previous.contextEpoch)")
            engine.resetContext()
        }
    }

    private func syncPrompts() {
        let live = state.tracks.filter { !$0.muted && $0.volume > 0 }
        guard !live.isEmpty else { return }

        engine.setPrompts(live.map { PromptWeight(text: $0.prompt, weight: $0.volume) })

        // First real track + ink on the pad starts the stream, never a blank
        // canvas, unless the artist just picked a vibe with a drawing there.
        if startNow || (!hasPlayed && canvasHasInk) {
            startNow = false
            hasPlayed = true
            engine.play()
        }
    }

    private func push(_ entry: LogEntry) {
        logSeq += 1
        var stamped = entry
        stamped = LogEntry(
            id: logSeq, event: entry.event, reasoning: entry.reasoning,
            actions: entry.actions, error: entry.error)
        log.insert(stamped, at: 0)
        if log.count > 40 { log.removeLast(log.count - 40) }
    }
}
