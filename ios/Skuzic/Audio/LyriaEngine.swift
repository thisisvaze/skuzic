import Foundation

enum EngineStatus: String {
    case idle, connecting, ready, playing, paused, error
}

enum EngineError: LocalizedError {
    case missingKey
    case timedOut
    case disconnected(String)

    var errorDescription: String? {
        switch self {
        case .missingKey:
            return "No Gemini API key. Add VITE_GEMINI_API_KEY to .env and re-run scripts/gen-secrets.sh."
        case .timedOut:
            return "Lyria did not complete setup in time."
        case let .disconnected(detail):
            return detail
        }
    }
}

/// Hand-rolled client for Lyria RealTime.
///
/// There is no Swift SDK for this API — the Google Gen AI SDK ships Python,
/// JS/TS, Go and Java only — so the frames below were taken from the JS SDK's
/// live-music module. The surface is experimental (`lyria-realtime-exp`), which
/// means Google can change it without a versioned SDK release to absorb the
/// break, so every field is parsed defensively and in both casings.
@MainActor
final class LyriaEngine: ObservableObject {
    static let model = "models/lyria-realtime-exp"
    static let endpoint =
        "wss://generativelanguage.googleapis.com/ws/"
        + "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic"

    @Published private(set) var status: EngineStatus = .idle
    @Published private(set) var statusDetail = ""
    @Published private(set) var bufferedSeconds: Double = 0

    /// Lyria drops prompts that trip its content filter, and says so out of band.
    var onFilteredPrompt: ((String, String) -> Void)?

    private let apiKey: String
    private var socket: URLSessionWebSocketTask?
    private var scheduler: PcmScheduler?
    private var mixer: PromptMixer?
    private var setupContinuation: CheckedContinuation<Void, Error>?
    private var meter: Timer?
    private var masterVolume: Float = 0.8

    init(apiKey: String) {
        self.apiKey = apiKey
    }

    // MARK: - Lifecycle

    func connect() async throws {
        guard socket == nil else { return }
        guard !apiKey.isEmpty else { throw EngineError.missingKey }

        setStatus(.connecting)

        let scheduler = PcmScheduler(volume: masterVolume)
        try scheduler.start()
        self.scheduler = scheduler

        mixer = PromptMixer { [weak self] prompts in
            self?.sendWeightedPrompts(prompts)
        }

        guard var components = URLComponents(string: Self.endpoint) else {
            throw EngineError.disconnected("Bad endpoint URL")
        }
        components.queryItems = [URLQueryItem(name: "key", value: apiKey)]
        guard let url = components.url else {
            throw EngineError.disconnected("Bad endpoint URL")
        }

        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()

        receiveLoop(task)

        // The server requires setup before it accepts any client message, and
        // answers with setupComplete before it accepts prompts.
        send(["setup": ["model": Self.model]])
        try await awaitSetup(timeout: 20)

        startMeter()
    }

    private func awaitSetup(timeout: TimeInterval) async throws {
        try await withCheckedThrowingContinuation { continuation in
            setupContinuation = continuation

            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.finishSetup(.failure(EngineError.timedOut))
            }
        }
    }

    private func finishSetup(_ result: Result<Void, Error>) {
        guard let continuation = setupContinuation else { return }
        setupContinuation = nil
        continuation.resume(with: result)
    }

    func close() {
        mixer?.reset()
        mixer = nil
        meter?.invalidate()
        meter = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        scheduler?.close()
        scheduler = nil
        bufferedSeconds = 0
        finishSetup(.failure(EngineError.disconnected("closed")))
        setStatus(.idle)
    }

    // MARK: - Controls

    func setPrompts(_ prompts: [PromptWeight]) {
        mixer?.setTarget(prompts)
    }

    func setConfig(_ config: MixConfig) {
        var payload: [String: Any] = [
            "bpm": config.bpm,
            "density": config.density,
            "brightness": config.brightness,
            "guidance": config.guidance,
            "muteBass": config.muteBass,
            "muteDrums": config.muteDrums,
        ]
        if config.scale != MusicScale.unspecified {
            payload["scale"] = config.scale
        }
        send(["musicGenerationConfig": payload])
    }

    func play() {
        // Coming back from the background — or from an interruption — the audio
        // engine has been stopped under us. Asking Lyria to stream into a dead
        // engine looks healthy on every meter and makes no sound.
        scheduler?.ensureRunning()
        send(["playbackControl": "PLAY"])
        setStatus(.playing)
    }

    func pause() {
        send(["playbackControl": "PAUSE"])
        setStatus(.paused)
    }

    func stop() {
        send(["playbackControl": "STOP"])
        scheduler?.flush()
        setStatus(.ready)
    }

    /// Required after a bpm or scale change. The model restarts and every queued
    /// buffer is dropped, so the gap is unavoidable — ducking around it makes it
    /// read as a swell rather than a glitch.
    func resetContext() {
        guard let scheduler else {
            send(["playbackControl": "RESET_CONTEXT"])
            return
        }
        scheduler.reset { [weak self] in
            self?.send(["playbackControl": "RESET_CONTEXT"])
        }
    }

    func setMasterVolume(_ volume: Float) {
        masterVolume = volume
        scheduler?.setVolume(volume)
    }

    /// Band energies 0..1 for the equalizer meter, or nil before audio starts.
    func levels(bands: Int) -> [Float]? {
        scheduler?.levels(bands: bands)
    }

    // MARK: - Wire

    private func sendWeightedPrompts(_ prompts: [PromptWeight]) {
        guard !prompts.isEmpty else { return }
        send([
            "clientContent": [
                "weightedPrompts": prompts.map { ["text": $0.text, "weight": $0.weight] }
            ]
        ])
    }

    private func send(_ payload: [String: Any]) {
        guard let socket,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8)
        else { return }

        socket.send(.string(text)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in
                self?.setStatus(.error, error.localizedDescription)
            }
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            while true {
                do {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    self.handle(message)
                } catch {
                    guard let self, self.socket === task else { return }
                    self.handleDrop(error)
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case let .string(text): data = text.data(using: .utf8)
        case let .data(raw): data = raw
        @unknown default: data = nil
        }

        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if json["setupComplete"] != nil || json["setup_complete"] != nil {
            setStatus(.ready)
            finishSetup(.success(()))
        }

        if let filtered = json.child("filteredPrompt", "filtered_prompt") {
            let text = filtered["text"] as? String ?? ""
            let reason =
                filtered["filteredReason"] as? String
                ?? filtered["filtered_reason"] as? String
                ?? "filtered"
            onFilteredPrompt?(text, reason)
        }

        guard let content = json.child("serverContent", "server_content"),
              let chunks = content.children("audioChunks", "audio_chunks")
        else { return }

        for chunk in chunks {
            guard let encoded = chunk["data"] as? String,
                  let audio = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters)
            else { continue }
            let mime = chunk["mimeType"] as? String ?? chunk["mime_type"] as? String
            scheduler?.enqueue(audio, sampleRate: Self.sampleRate(from: mime))
        }
    }

    private func handleDrop(_ error: Error) {
        socket = nil
        finishSetup(.failure(error))
        meter?.invalidate()
        meter = nil

        // A clean server-side close reads as an ordinary end of stream; anything
        // else is worth surfacing.
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            setStatus(.idle, "stream closed")
        } else {
            setStatus(.error, error.localizedDescription)
        }
    }

    /// Chunks arrive as `audio/L16;codec=pcm;rate=48000` — trust the header if present.
    static func sampleRate(from mimeType: String?) -> Double {
        guard let mimeType,
              let range = mimeType.range(of: "rate=")
        else { return PcmScheduler.defaultSampleRate }

        let digits = mimeType[range.upperBound...].prefix { $0.isNumber }
        return Double(digits) ?? PcmScheduler.defaultSampleRate
    }

    private func startMeter() {
        meter?.invalidate()
        meter = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.bufferedSeconds = self.scheduler?.bufferedSeconds ?? 0
            }
        }
    }

    private func setStatus(_ status: EngineStatus, _ detail: String = "") {
        self.status = status
        statusDetail = detail
    }
}

/// The API has shipped both camelCase and snake_case over the life of the
/// v1alpha surface, so every lookup accepts either.
private extension [String: Any] {
    func child(_ names: String...) -> [String: Any]? {
        for name in names {
            if let hit = self[name] as? [String: Any] { return hit }
        }
        return nil
    }

    func children(_ names: String...) -> [[String: Any]]? {
        for name in names {
            if let hit = self[name] as? [[String: Any]] { return hit }
        }
        return nil
    }
}
