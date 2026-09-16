import Foundation

typealias TrackID = String

/// One track = one weighted text prompt streamed to Lyria. `volume` is
/// relative: the engine normalizes weights across all live tracks.
struct Track: Identifiable, Equatable, Codable {
    let id: TrackID
    var label: String
    var prompt: String
    var volume: Double
    var muted: Bool
    /// The event that created this track. The planner uses it to tell which
    /// tracks belong to a scene the user has already moved on from.
    var origin: String
}

/// Lyria's key/scale conditioning. Values are the API's own enum names.
enum MusicScale {
    static let unspecified = "SCALE_UNSPECIFIED"

    static let named = [
        "C_MAJOR_A_MINOR",
        "D_FLAT_MAJOR_B_FLAT_MINOR",
        "D_MAJOR_B_MINOR",
        "E_FLAT_MAJOR_C_MINOR",
        "E_MAJOR_D_FLAT_MINOR",
        "F_MAJOR_D_MINOR",
        "G_FLAT_MAJOR_E_FLAT_MINOR",
        "G_MAJOR_E_MINOR",
        "A_FLAT_MAJOR_F_MINOR",
        "A_MAJOR_G_FLAT_MINOR",
        "B_FLAT_MAJOR_G_MINOR",
        "B_MAJOR_A_FLAT_MINOR",
    ]

    static func display(_ raw: String) -> String {
        guard raw != unspecified else { return "auto" }
        let parts = raw.replacingOccurrences(of: "_FLAT", with: "♭").split(separator: "_")
        // "C_MAJOR_A_MINOR" reads as "C maj / A min".
        guard parts.count >= 4 else { return raw.lowercased() }
        return "\(parts[0]) \(parts[1].lowercased().prefix(3)) / \(parts[2]) \(parts[3].lowercased().prefix(3))"
    }
}

/// Tuned for *listenability over a long session*, not for neutrality. Kept in
/// sync with `INITIAL_CONFIG` in `src/core/types.ts`.
///
/// `scale` is the big one. Unspecified lets the model drift tonally, and since
/// this instrument is permanently crossfading between prompt sets, drift means
/// each blend lands in a slightly different key from the one before it — which
/// is most of what "the music isn't pleasant" turns out to be. Anchoring a key
/// makes every mix consonant with every other mix by construction. Each Lyria
/// scale value is a major and its relative minor, so one setting already covers
/// both a happy drawing and a sad one; the planner never needs to change it.
///
/// `guidance` trades prompt adherence against transition smoothness (the API's
/// own words). At the 4.0 default, every steer arrives as a lurch. Below it the
/// model bends toward the new prompts instead of snapping to them.
///
/// `bpm` 90 sits where the model can read either half-time or double-time
/// without a context reset, so energy can swing wide while the pulse holds.
struct MixConfig: Equatable, Codable {
    var bpm: Int = 90
    var density: Double = 0.5
    var brightness: Double = 0.5
    var guidance: Double = 3.0
    var scale: String = "F_MAJOR_D_MINOR"
    var muteBass: Bool = false
    var muteDrums: Bool = false
}

/// Only the fields the planner actually set. Everything else is left alone.
struct ConfigPatch: Equatable {
    var bpm: Int?
    var density: Double?
    var brightness: Double?
    var guidance: Double?
    var scale: String?
    var muteBass: Bool?
    var muteDrums: Bool?

    var isEmpty: Bool {
        bpm == nil && density == nil && brightness == nil && guidance == nil
            && scale == nil && muteBass == nil && muteDrums == nil
    }
}

struct SkuzicState: Equatable {
    var tracks: [Track] = []
    var config = MixConfig()
    /// Bumped when the model should hard-restart generation.
    var contextEpoch = 0
}

/// `target` accepts a track id or a label; the reducer resolves either.
enum Action: Equatable {
    case addTrack(label: String, prompt: String, volume: Double, origin: String)
    case removeTrack(target: String)
    case modifyTrack(target: String, label: String?, prompt: String?)
    case setVolume(target: String, volume: Double)
    case setMuted(target: String, muted: Bool)
    case setConfig(ConfigPatch)
    case clearTracks
    case resetContext
}

extension Action {
    /// Drawing updates steer the existing performance. Tempo/key changes and
    /// explicit resets clear its audio; those remain available in the mix UI.
    var preservingPlayback: Action? {
        switch self {
        case .resetContext:
            return nil
        case var .setConfig(patch):
            patch.bpm = nil
            patch.scale = nil
            return patch.isEmpty ? nil : .setConfig(patch)
        default:
            return self
        }
    }

    /// One-line rendering for the action log.
    var summary: String {
        switch self {
        case let .addTrack(label, _, volume, _):
            return "+ \(label) @ \(String(format: "%.2f", volume))"
        case let .removeTrack(target):
            return "− \(target)"
        case let .modifyTrack(target, label, _):
            return "~ \(target)\(label.map { " → \($0)" } ?? "")"
        case let .setVolume(target, volume):
            return "vol \(target) \(String(format: "%.2f", volume))"
        case let .setMuted(target, muted):
            return "\(muted ? "mute" : "unmute") \(target)"
        case .setConfig:
            return "config"
        case .clearTracks:
            return "clear all"
        case .resetContext:
            return "reset context"
        }
    }
}

/// Lyria accepts at most 8 simultaneous weighted prompts.
let maxTracks = 8
