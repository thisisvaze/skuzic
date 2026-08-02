import Combine
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

    @Published var masterVolume: Float = Float(Preferences.double(.masterVolume, or: 0.8)) {
        didSet {
            engine.setMasterVolume(masterVolume)
            Preferences.set(Double(masterVolume), .masterVolume)
        }
    }

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

    /// Pad ink — playback must not start while this is false (blank canvas).
    private(set) var canvasHasInk = false

    var connected: Bool { status != .idle && status != .error }
    var playing: Bool { status == .playing }
    /// `playing` flips the instant the command is sent, but Lyria still has to
    /// generate and stream a first chunk. Gate the meter on audio actually
    /// being queued, or it moves over several seconds of silence.
    var audible: Bool { playing && buffered > 0 }

    /// Band energies for the equalizer meter.
    func levels(bands: Int) -> [Float]? { engine.levels(bands: bands) }
    var hasKey: Bool { !Secrets.geminiAPIKey.isEmpty }

    init(apiKey: String) {
        let model = Preferences.string(.plannerModel).flatMap(PlannerModel.init(rawValue:))
            ?? .default
        let config = Preferences.string(.plannerConfig).flatMap(PlannerConfig.init(rawValue:))
            ?? .default

        engine = LyriaEngine(apiKey: apiKey)
        planner = Planner(apiKey: apiKey, model: model, config: config)
        // Assigned after `planner` exists so the didSet above is a no-op here
        // rather than writing back the value we just read.
        plannerModel = model
        plannerConfig = config

        engine.$status.assign(to: &$status)
        engine.$statusDetail.assign(to: &$statusDetail)
        engine.$bufferedSeconds.assign(to: &$buffered)

        engine.onFilteredPrompt = { [weak self] text, reason in
            self?.push(LogEntry(id: 0, event: "prompt filtered", error: "“\(text)” — \(reason)"))
        }
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

    // MARK: - Transport

    func start() async {
        guard !connected else { return }
        guard hasKey else {
            push(LogEntry(id: 0, event: "start", error: EngineError.missingKey.localizedDescription))
            return
        }

        do {
            try await engine.connect()
            engine.setMasterVolume(masterVolume)

            engine.setConfig(state.config)

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
        hasPlayed = false
        resumeOnReturn = false
        engine.close()
    }

    func togglePlayback() {
        if playing {
            engine.pause()
        } else if canvasHasInk {
            engine.play()
        }
    }

    /// Generation is only wanted while the app is on screen. Pausing the session
    /// rather than just muting also stops Lyria generating audio nobody hears.
    func suspendForBackground() {
        guard playing else { return }
        resumeOnReturn = true
        engine.pause()
    }

    func resumeIfSuspended() {
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

        do {
            let plan = try await planner.plan(event: trimmed, state: state, drawing: drawing)
            dispatch(plan.actions)
            push(
                LogEntry(
                    id: 0, event: trimmed, reasoning: plan.reasoning, actions: plan.actions))
        } catch {
            push(LogEntry(id: 0, event: trimmed, error: error.localizedDescription))
        }
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
            // Only tempo and key force a restart; the rest apply in place.
            if state.config.bpm != previous.config.bpm
                || state.config.scale != previous.config.scale {
                engine.resetContext()
            }
        }

        if state.contextEpoch != previous.contextEpoch {
            engine.resetContext()
        }
    }

    private func syncPrompts() {
        let live = state.tracks.filter { !$0.muted && $0.volume > 0 }
        guard !live.isEmpty else { return }

        engine.setPrompts(live.map { PromptWeight(text: $0.prompt, weight: $0.volume) })

        // First real track + ink on the pad starts the stream — never a blank canvas.
        if !hasPlayed, canvasHasInk {
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
