import PencilKit
import SwiftUI

enum Theme {
    /// Light paper with dark ink — the model reads a drawn shape far more
    /// reliably this way than as light strokes on a dark background.
    static let paper = Color(red: 0.957, green: 0.945, blue: 0.918)
    static let paperUI = UIColor(red: 0.957, green: 0.945, blue: 0.918, alpha: 1)

    /// The surface the paper floats on. Dark enough that the drop shadow reads
    /// and the paper is clearly a separate object.
    static let workspace = Color(red: 0.09, green: 0.09, blue: 0.095)
    static let workspaceUI = UIColor(red: 0.09, green: 0.09, blue: 0.095, alpha: 1)

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
