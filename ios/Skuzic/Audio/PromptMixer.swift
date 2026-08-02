import Foundation

struct PromptWeight: Equatable {
    var text: String
    var weight: Double
}

/// Replacing a prompt set outright sounds like a jump cut. This walks current
/// weights toward their targets so changes crossfade.
///
/// Lyria normalizes weights internally and rejects a weight of exactly zero, so
/// retiring tracks fade to `epsilon` and are then dropped entirely.
@MainActor
final class PromptMixer {
    static let epsilon = 0.005
    private let rampSeconds = 1.0
    private let tickSeconds = 0.1

    private var current: [String: Double] = [:]
    private var target: [String: Double] = [:]
    private var timer: Timer?

    private let send: ([PromptWeight]) -> Void
    private let maxPrompts: Int

    init(maxPrompts: Int = maxTracks, send: @escaping ([PromptWeight]) -> Void) {
        self.maxPrompts = maxPrompts
        self.send = send
    }

    func setTarget(_ prompts: [PromptWeight]) {
        var merged: [String: Double] = [:]
        for prompt in prompts {
            guard !prompt.text.trimmingCharacters(in: .whitespaces).isEmpty,
                  prompt.weight > 0
            else { continue }
            merged[prompt.text, default: 0] += prompt.weight
        }

        // Lyria caps simultaneous prompts; keep the loudest and drop the rest
        // rather than letting the backend truncate arbitrarily.
        let capped = merged.sorted { $0.value > $1.value }.prefix(maxPrompts)

        target = Dictionary(uniqueKeysWithValues: capped.map { ($0.key, $0.value) })
        for (key, _) in capped where current[key] == nil {
            current[key] = Self.epsilon
        }

        start()
    }

    private func start() {
        guard timer == nil else { return }
        let step = tickSeconds / rampSeconds

        timer = Timer.scheduledTimer(withTimeInterval: tickSeconds, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.tick(step: step)
            }
        }
    }

    private func tick(step: Double) {
        var settled = true

        for (key, value) in current {
            let goal = target[key] ?? 0
            let diff = goal - value

            if abs(diff) <= step {
                if goal <= Self.epsilon {
                    current.removeValue(forKey: key)
                } else {
                    current[key] = goal
                }
            } else {
                settled = false
                current[key] = value + (diff < 0 ? -step : step)
            }
        }

        let prompts = current
            .filter { $0.value > Self.epsilon }
            .map { PromptWeight(text: $0.key, weight: $0.value) }

        // An empty list is invalid; hold the last mix instead.
        if !prompts.isEmpty { send(prompts) }

        if settled { stop() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func reset() {
        stop()
        current.removeAll()
        target.removeAll()
    }
}
