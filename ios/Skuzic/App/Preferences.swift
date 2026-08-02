import Foundation

/// Every setting that should outlive a relaunch, in one place. The web build
/// keeps the same set under the same names in localStorage, so the two stay
/// recognisably the same app.
enum Preferences {
    enum Key: String {
        case masterVolume = "skuzic_master_volume"
        case autoInterpret = "skuzic_auto_interpret"
        case plannerModel = "skuzic_planner_model"
        case plannerConfig = "skuzic_planner_config"
        case brush = "skuzic_brush"
        case inkColor = "skuzic_ink_color"
        case brushSize = "skuzic_brush_size"
        case inkOpacity = "skuzic_ink_opacity"
        /// Seeds a brand new sketch, so the engine settings you last dialled in
        /// carry forward instead of resetting to the shipped defaults.
        ///
        /// Versioned, because a stored record wins over the shipped defaults
        /// forever. The key, tempo and guidance in `MixConfig` are the sound of
        /// the instrument rather than a user preference worth preserving through
        /// a retune — bump this whenever they change.
        case lastConfig = "skuzic_config_v2"
    }

    private static let defaults = UserDefaults.standard

    static func double(_ key: Key, or fallback: Double) -> Double {
        defaults.object(forKey: key.rawValue) as? Double ?? fallback
    }

    static func bool(_ key: Key, or fallback: Bool) -> Bool {
        defaults.object(forKey: key.rawValue) as? Bool ?? fallback
    }

    static func string(_ key: Key) -> String? {
        defaults.string(forKey: key.rawValue)
    }

    static func set(_ value: Any?, _ key: Key) {
        defaults.set(value, forKey: key.rawValue)
    }

    static func decode<T: Decodable>(_ key: Key, as type: T.Type) -> T? {
        guard let data = defaults.data(forKey: key.rawValue) else { return nil }
        return try? JSONDecoder.iso.decode(type, from: data)
    }

    static func encode<T: Encodable>(_ value: T, _ key: Key) {
        guard let data = try? JSONEncoder.iso.encode(value) else { return }
        defaults.set(data, forKey: key.rawValue)
    }
}
