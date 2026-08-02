import Foundation

let actionTypes = [
    "ADD_TRACK",
    "REMOVE_TRACK",
    "MODIFY_TRACK",
    "SET_VOLUME",
    "SET_MUTED",
    "SET_CONFIG",
    "CLEAR_TRACKS",
    "RESET_CONTEXT",
]

/// A flat action shape rather than a discriminated union — `anyOf` in
/// responseSchema is fragile, and a flat object with a `type` enum round-trips
/// reliably. `normalize()` narrows it back into the real Action enum.
///
/// Every NUMBER carries explicit `minimum`/`maximum` bounds. Without them the
/// model emits values like `0.8500000…` to several hundred digits, which cost
/// 24k output tokens per plan against 87 with the bounds in place. The bounds
/// are what makes this usable on a button tap, not just documentation.
let planSchema: [String: Any] = [
    "type": "OBJECT",
    "properties": [
        "reasoning": [
            "type": "STRING",
            "description": "One short sentence on the musical intent behind these actions.",
        ],
        "actions": [
            "type": "ARRAY",
            "items": [
                "type": "OBJECT",
                "properties": [
                    "type": ["type": "STRING", "enum": actionTypes],
                    "target": [
                        "type": "STRING",
                        "description": "Existing track id or label. Required for track-scoped actions.",
                    ],
                    "label": ["type": "STRING", "description": "Short track name, max 24 chars."],
                    "prompt": [
                        "type": "STRING",
                        "description": "Musical description sent to the music model.",
                    ],
                    "volume": [
                        "type": "NUMBER", "minimum": 0, "maximum": 1,
                        "description": "Relative prominence, 0.0 to 1.0.",
                    ],
                    "muted": ["type": "BOOLEAN"],
                    "bpm": [
                        "type": "INTEGER", "minimum": 60, "maximum": 200,
                        "description": "Forces an audible restart.",
                    ],
                    "density": [
                        "type": "NUMBER", "minimum": 0, "maximum": 1,
                        "description": "0.0 sparse to 1.0 busy.",
                    ],
                    "brightness": [
                        "type": "NUMBER", "minimum": 0, "maximum": 1,
                        "description": "0.0 dark to 1.0 bright.",
                    ],
                    "guidance": [
                        "type": "NUMBER", "minimum": 0, "maximum": 6,
                        "description": "Prompt adherence.",
                    ],
                    "scale": [
                        "type": "STRING",
                        "enum": MusicScale.named,
                        "description": "Forces an audible restart.",
                    ],
                    "muteBass": ["type": "BOOLEAN"],
                    "muteDrums": ["type": "BOOLEAN"],
                ],
                "required": ["type"],
            ],
        ],
    ],
    "required": ["reasoning", "actions"],
]

struct Plan {
    var reasoning: String
    var actions: [Action]
}

/// Drops anything malformed rather than letting a bad action corrupt the mix.
func normalize(_ raw: [[String: Any]], origin: String) -> [Action] {
    var out: [Action] = []

    for item in raw {
        guard let type = item["type"] as? String else { continue }

        let target = item["target"] as? String
        let label = item["label"] as? String
        let prompt = item["prompt"] as? String
        let volume = item["volume"] as? Double
        let muted = item["muted"] as? Bool

        switch type {
        case "ADD_TRACK":
            guard let prompt, !prompt.isEmpty else { break }
            // Fall back to the first clause of the prompt when the model omits a label.
            let fallback = String(
                prompt.split(whereSeparator: { $0 == "," || $0 == "." }).first ?? ""
            )
            out.append(
                .addTrack(
                    label: String((label?.isEmpty == false ? label! : fallback).prefix(24)),
                    prompt: prompt,
                    volume: volume ?? 0.8,
                    origin: origin
                ))

        case "REMOVE_TRACK":
            if let target, !target.isEmpty { out.append(.removeTrack(target: target)) }

        case "MODIFY_TRACK":
            if let target, !target.isEmpty, label != nil || prompt != nil {
                out.append(.modifyTrack(target: target, label: label, prompt: prompt))
            }

        case "SET_VOLUME":
            if let target, !target.isEmpty, let volume {
                out.append(.setVolume(target: target, volume: volume))
            }

        case "SET_MUTED":
            if let target, !target.isEmpty, let muted {
                out.append(.setMuted(target: target, muted: muted))
            }

        case "SET_CONFIG":
            var patch = ConfigPatch()
            if let bpm = item["bpm"] as? Int { patch.bpm = bpm }
            else if let bpm = item["bpm"] as? Double { patch.bpm = Int(bpm) }
            patch.density = item["density"] as? Double
            patch.brightness = item["brightness"] as? Double
            patch.guidance = item["guidance"] as? Double
            patch.muteBass = item["muteBass"] as? Bool
            patch.muteDrums = item["muteDrums"] as? Bool
            if let scale = item["scale"] as? String, MusicScale.named.contains(scale) {
                patch.scale = scale
            }
            if !patch.isEmpty { out.append(.setConfig(patch)) }

        case "CLEAR_TRACKS":
            out.append(.clearTracks)

        case "RESET_CONTEXT":
            out.append(.resetContext)

        default:
            break
        }
    }

    return out
}
