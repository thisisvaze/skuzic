import PencilKit
import SwiftUI

enum Theme {
    /// Light paper with dark ink, the same in both themes: the model reads a
    /// drawn shape far more reliably this way than as light strokes on dark.
    /// Matches the web build's paper (#fcfbf8) and the ink reader's constant.
    static let paper = Color(hex: 0xFCFBF8)
    static let paperUI = UIColor(red: 252 / 255, green: 251 / 255, blue: 248 / 255, alpha: 1)

    // The web build's colour tokens (src/styles.css), light and dark: a quiet
    // cool neutral desk, so the paper and the music's colour are the only warm
    // things on screen. Panels float on the desk; cards sit inside panels.
    static let desk = adaptive(0xEFF0F3, 0x131417)
    static let deskUI = adaptiveUI(0xEFF0F3, 0x131417)
    static let panel = adaptive(0xFDFDFE, 0x1C1D21)
    static let card = adaptive(0xF2F3F6, 0x26272C)
    static let secondary = adaptive(0xE8E9EE, 0x2E2F35)
    static let muted = adaptive(0xE3E4EA, 0x34353B)
    static let ink = adaptive(0x1A1B20, 0xF2F3F5)
    static let inkMuted = adaptive(0x686A73, 0xA3A5AE)
    static let input = adaptive(0xECEDF1, 0x232428)
    static let border = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor.white.withAlphaComponent(0.09) : UIColor.black.withAlphaComponent(0.09) })
    /// Dims the paper a touch in dark mode so it doesn't glare. Laid over the
    /// canvas, never baked in, so what the eyes read stays as drawn.
    static let paperDimUI = UIColor { $0.userInterfaceStyle == .dark
        ? UIColor.black.withAlphaComponent(0.05) : .clear }

    /// The wordmark's line, for the few things that are alive: the play button,
    /// the switches, a chosen vibe. Chrome stays neutral.
    static let brand1 = Color(hex: 0xE2711D)
    static let brand2 = Color(hex: 0xE26D9E)
    static let brand3 = Color(hex: 0x7C3AED)
    static let brand = LinearGradient(colors: [brand1, brand2, brand3],
                                      startPoint: .topLeading, endPoint: .bottomTrailing)

    /// Picked to stay legible against the paper once the export downsamples it.
    static let inks: [Color] = [
        Color(hex: 0x15130F),
        Color(hex: 0x7A7266),
        Color(hex: 0xD1495B),
        Color(hex: 0xE2711D),
        Color(hex: 0xF0A202),
        Color(hex: 0x6A994E),
        Color(hex: 0x1B998B),
        Color(hex: 0x2D7DD2),
        Color(hex: 0x3D348B),
        Color(hex: 0x7C3AED),
        Color(hex: 0xE26D9E),
        Color(hex: 0x8B5A2B),
    ]

    private static func adaptiveUI(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { UIColor(Color(hex: $0.userInterfaceStyle == .dark ? dark : light)) }
    }

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(adaptiveUI(light, dark))
    }
}

/// "System", "Light" or "Dark", stored as the web build stores it.
enum ThemeChoice: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }
    var scheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// Apple's own inks, so pressure, tilt and taper come from PencilKit rather
/// than anything hand-rolled. An Apple Pencil drives all three for free.
enum Brush: String, CaseIterable, Identifiable {
    case pencil, pen, marker, crayon, fountainPen, watercolor, monoline

    var id: String { rawValue }

    var inkType: PKInkingTool.InkType {
        switch self {
        case .pencil: return .pencil
        case .pen: return .pen
        case .marker: return .marker
        case .crayon: return .crayon
        case .fountainPen: return .fountainPen
        case .watercolor: return .watercolor
        case .monoline: return .monoline
        }
    }

    var icon: String {
        switch self {
        case .pencil: return "pencil"
        case .pen: return "pencil.tip"
        case .marker: return "highlighter"
        case .crayon: return "paintbrush.pointed.fill"
        case .fountainPen: return "paintbrush.pointed"
        case .watercolor: return "drop.fill"
        case .monoline: return "line.diagonal"
        }
    }

    var title: String {
        switch self {
        case .fountainPen: return "Fountain pen"
        default: return rawValue.capitalized
        }
    }
}

extension Color {
    /// `#RRGGBB`, so the stored ink colour is readable and matches the web build.
    var hexString: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(
            format: "#%02X%02X%02X", Int(r * 255 + 0.5), Int(g * 255 + 0.5), Int(b * 255 + 0.5))
    }

    init?(hexString: String) {
        var text = hexString
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(hex: value)
    }

    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
