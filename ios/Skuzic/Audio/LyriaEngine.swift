import Combine
import Foundation

enum EngineStatus: String {
    case idle, connecting, ready, buffering, playing, paused, error
}

enum EngineError: LocalizedError {
    case missingKey, timedOut, invalidAudio, bufferOverflow, streamStalled
    case disconnected(String)
    var errorDescription: String? {
        switch self {
        case .missingKey: return "No Gemini API key. Run ios/scripts/gen-secrets.sh after configuring .env."
        case .timedOut: return "Lyria did not complete setup in time."
        case .invalidAudio: return "Lyria sent an unsupported audio format."
        case .bufferOverflow: return "The music stream exceeded the audio buffer limit."
        case .streamStalled: return "No music arrived for 15 seconds."
        case let .disconnected(message): return message
        }
    }
}

/// UI-facing coordinator. A connection and a PCM player are disposable session
/// resources; desired prompts/config/playback survive an automatic reconnect.
@MainActor
final class LyriaEngine: ObservableObject {
    @Published private(set) var status: EngineStatus = .idle
    @Published private(set) var statusDetail = ""
    @Published private(set) var bufferedSeconds: Double = 0
    @Published private(set) var playbackRequested = false
    var onFilteredPrompt: ((String, String) -> Void)?

    private let apiKey: String
    private var connection: LyriaConnection?
    private var scheduler: PcmScheduler?
    private var connectTask: Task<Void, Error>?
    private var reconnectTask: Task<Void, Never>?
    private var meter: Timer?
    private var sessionID = UUID()
    private var operationID = UUID()
    private var ready = false
    private var generationRunning = false
    private var needsGeneration = true
    private var interrupted = false
    private var resetting = false
    private var resetID = UUID()
    private var retries = 0
    private var masterVolume: Float = 0.8
    private var config = MixConfig()
    private var prompts: [PromptWeight] = []
    private lazy var mixer = PromptMixer { [weak self] weights in self?.sendPrompts(weights) }

    init(apiKey: String) { self.apiKey = apiKey }

    func connect() async throws {
        if let connectTask { return try await connectTask.value }
        guard !ready else { return }
        guard !apiKey.isEmpty else { throw EngineError.missingKey }
        operationID = UUID()
        let operation = operationID
        retries = 0
        setStatus(.connecting)
        let task = Task { try await self.openSession() }
        connectTask = task
        do {
            try await task.value
            guard operation == operationID else { throw CancellationError() }
            connectTask = nil
        } catch {
            if operation == operationID {
                connectTask = nil
                disposeSession()
                playbackRequested = false
                setStatus(.error, safeMessage(error))
            }
            throw error
        }
    }

    private func openSession() async throws {
        let id = UUID()
        sessionID = id
        needsGeneration = true
        generationRunning = false
        interrupted = false
        resetting = false
        Diagnostics.event(.stream, "CONNECT_BEGIN model=\(LyriaConnection.model) api=v1beta")
        let player = PcmScheduler(
            volume: masterVolume,
            onState: { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.sessionID == id else { return }
                    self.updatePlaybackStatus()
                }
            },
            onDemand: { [weak self] needsAudio in
                Task { @MainActor in
                    guard let self, self.sessionID == id else { return }
                    self.needsGeneration = needsAudio
                    self.syncGeneration()
                }
            },
            onInterruption: { [weak self] began, resume in
                Task { @MainActor in
                    guard let self, self.sessionID == id else { return }
                    self.interrupted = began
                    if began {
                        self.syncGeneration()
                        self.setStatus(self.playbackRequested ? .buffering : .paused, "Audio interrupted")
                    } else if resume, self.playbackRequested {
                        self.scheduler?.play()
                        self.syncGeneration()
                    } else { self.pause() }
                }
            },
            onFailure: { [weak self] error in
                Task { @MainActor in
                    guard let self, self.sessionID == id else { return }
                    self.recover(error)
                }
            })
        scheduler = player
        try player.start()
        let link = try LyriaConnection(apiKey: apiKey,
            onAudio: { data, rate in player.enqueue(data, sampleRate: rate) },
            onControl: { [weak self] control in
                guard let self, self.sessionID == id else { return }
                if let text = control.filteredPrompt {
                    self.onFilteredPrompt?(text, control.filteredReason ?? "filtered")
                }
            },
            onFailure: { [weak self] error in
                guard let self, self.sessionID == id else { return }
                self.recover(error)
            })
        connection = link
        try await link.connect()
        try Task.checkCancellation()
        guard sessionID == id else { throw CancellationError() }
        ready = true
        sendConfig()
        if playbackRequested { player.play() }
        mixer.reset()
        mixer.setTarget(prompts)
        startMeter()
        if playbackRequested {
            syncGeneration()
            setStatus(.buffering)
        } else { setStatus(.ready) }
        Diagnostics.event(.stream, "CONNECT_READY")
    }

    func setConfig(_ value: MixConfig) {
        let changed = config != value
        config = value
        if ready, changed { sendConfig() }
    }

    private func sendConfig() {
        guard ready else { return }
        var value: [String: Any] = [
            "bpm": config.bpm, "density": config.density, "brightness": config.brightness,
            "guidance": config.guidance, "muteBass": config.muteBass, "muteDrums": config.muteDrums,
        ]
        if config.scale != MusicScale.unspecified { value["scale"] = config.scale }
        connection?.send(["musicGenerationConfig": value], key: "config")
        Diagnostics.event(.stream, "CONFIG_QUEUED bpm=\(config.bpm) scale=\(config.scale)")
    }

    func setPrompts(_ value: [PromptWeight]) {
        prompts = value.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && $0.weight.isFinite && $0.weight > 0 }
        if ready { mixer.setTarget(prompts) }
    }

    private func sendPrompts(_ value: [PromptWeight]) {
        guard ready, !value.isEmpty else { return }
        connection?.send(["clientContent": ["weightedPrompts":
            value.map { ["text": $0.text, "weight": $0.weight] }]], key: "prompts")
        Diagnostics.event(.stream, "PROMPTS_QUEUED count=\(value.count)")
        syncGeneration()
    }

    func play() {
        guard !playbackRequested else { return }
        playbackRequested = true
        scheduler?.play()
        syncGeneration()
        // Restoring a sketch can request playback before connect() starts.
        // Keep idle/connecting until setup so Store.start() still connects.
        if ready || reconnectTask != nil { setStatus(.buffering) }
    }

    func pause() {
        playbackRequested = false
        resetID = UUID()
        resetting = false
        scheduler?.pause()
        syncGeneration()
        setStatus(.paused)
    }

    func stop() {
        playbackRequested = false
        resetID = UUID()
        resetting = false
        generationRunning = false
        connection?.send(["playbackControl": "STOP"])
        scheduler?.flush()
        setStatus(ready ? .ready : .idle)
    }

    func resetContext() {
        guard ready, let scheduler else { return }
        let id = UUID()
        resetID = id
        let session = sessionID
        resetting = true
        // Commit the ordered reset even if the user pauses during the fade.
        // Otherwise the new tempo/key could remain unapplied on resume.
        connection?.send(["playbackControl": "RESET_CONTEXT"])
        Diagnostics.event(.stream, "RESET_CONTEXT_QUEUED")
        scheduler.reset { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.sessionID == session, self.resetID == id, self.ready else { return }
                self.resetting = false
                if self.playbackRequested { self.scheduler?.play() }
                self.syncGeneration()
            }
        }
        if playbackRequested { setStatus(.buffering) }
    }

    /// Flow-control PAUSE affects generation only; local buffered music continues.
    private func syncGeneration() {
        guard ready, !resetting else { return }
        let wanted = playbackRequested && !interrupted && needsGeneration && !prompts.isEmpty
        guard wanted != generationRunning else { return }
        generationRunning = wanted
        let command = wanted ? "PLAY" : "PAUSE"
        connection?.send(["playbackControl": command])
        Diagnostics.event(.stream, "\(command)_QUEUED")
    }

    func setMasterVolume(_ value: Float) {
        masterVolume = min(1, max(0, value))
        scheduler?.setVolume(masterVolume)
    }
    func levels(bands: Int) -> [Float]? { scheduler?.levels(bands: bands) }

    private func recover(_ error: Error) {
        guard reconnectTask == nil else { return }
        let resume = playbackRequested
        disposeSession()
        guard resume, retries < 3 else {
            playbackRequested = false
            setStatus(.error, safeMessage(error))
            return
        }
        let operation = operationID
        setStatus(.buffering, "Reconnecting music…")
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            while self.retries < 3, !Task.isCancelled, self.operationID == operation {
                self.retries += 1
                Diagnostics.event(.stream, "RECONNECT attempt=\(self.retries)")
                do {
                    try await Task.sleep(nanoseconds: UInt64(1 << (self.retries - 1)) * 1_000_000_000)
                    try await self.openSession()
                    self.reconnectTask = nil
                    return
                } catch {
                    if Task.isCancelled || self.operationID != operation { return }
                    self.disposeSession()
                    Diagnostics.failure(.stream, "RECONNECT_FAILED", error)
                }
            }
            guard self.operationID == operation, !Task.isCancelled else { return }
            self.reconnectTask = nil
            self.playbackRequested = false
            self.setStatus(.error, "Music disconnected. Tap Start to reconnect.")
        }
    }

    private func startMeter() {
        meter?.invalidate()
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updatePlaybackStatus() }
        }
        meter = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func updatePlaybackStatus() {
        guard ready, let state = scheduler?.snapshot else { return }
        bufferedSeconds = state.bufferedSeconds
        guard playbackRequested, !interrupted else { return }
        setStatus(state.phase == .playing && !resetting ? .playing : .buffering)
    }

    private func disposeSession() {
        sessionID = UUID()
        resetID = UUID()
        ready = false
        generationRunning = false
        mixer.stop()
        meter?.invalidate()
        meter = nil
        connection?.close()
        connection = nil
        scheduler?.close()
        scheduler = nil
        bufferedSeconds = 0
    }

    func close() {
        operationID = UUID()
        connectTask?.cancel()
        connectTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        playbackRequested = false
        disposeSession()
        mixer.reset()
        prompts = []
        retries = 0
        setStatus(.idle)
    }

    private func safeMessage(_ error: Error) -> String {
        if let error = error as? EngineError { return error.localizedDescription }
        let ns = error as NSError
        return "Music connection failed (\(ns.domain), \(ns.code))."
    }

    private func setStatus(_ next: EngineStatus, _ detail: String = "") {
        if status != next {
            Diagnostics.event(.session, "STATUS \(status.rawValue)->\(next.rawValue)")
            status = next
        }
        if statusDetail != detail { statusDetail = detail }
    }
}
