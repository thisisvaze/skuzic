#if DEBUG
import PencilKit
import UIKit

/// Debug-only scripted sessions, for checking the app in the Simulator where
/// nothing can draw with a Pencil:
///
///     xcrun simctl launch booted com.incubious.skuzic -SkuzicDemo sea
///     xcrun simctl launch booted com.incubious.skuzic -SkuzicPreview bossa
///
/// `-SkuzicDemo` opens a new sketch and, after a pause, draws the scene;
/// `-SkuzicPreview` taps a vibe on the blank page first.
enum DemoDrawing {
    static var requested: String? { value(after: "-SkuzicDemo") }
    static var preview: String? { value(after: "-SkuzicPreview") }
    /// "settings" or "mixer": open that once the sketch is up.
    static var show: String? { value(after: "-SkuzicShow") }
    /// Seconds after the demo drawing to wipe the page, to hear the fade.
    static var clearAfter: Double? { value(after: "-SkuzicClearAfter").flatMap(Double.init) }

    private static func value(after flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// A sun over the sea with a boat, or just a sun, laid out on the page.
    static func drawing(_ name: String, in bounds: CGRect) -> PKDrawing {
        let w = bounds.width, h = bounds.height
        func at(_ fx: CGFloat, _ fy: CGFloat) -> CGPoint { CGPoint(x: w * fx, y: h * fy) }
        var strokes: [PKStroke] = []
        func line(_ points: [CGPoint], _ hex: UInt32, _ width: CGFloat = 9) {
            let color = UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
            let path = points.enumerated().map { i, p in
                PKStrokePoint(location: p, timeOffset: Double(i) * 0.012, size: CGSize(width: width, height: width),
                              opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
            }
            strokes.append(PKStroke(ink: PKInk(.pen, color: color),
                                    path: PKStrokePath(controlPoints: path, creationDate: Date())))
        }

        let sun = name == "sea" ? at(0.7, 0.26) : at(0.5, 0.42)
        line((0...48).map { k in
            let a = Double(k) / 48 * 2 * .pi
            return CGPoint(x: sun.x + 70 * cos(a), y: sun.y + 70 * sin(a))
        }, 0xE2711D)
        for k in 0..<10 {
            let a = Double(k) / 10 * 2 * .pi
            line([CGPoint(x: sun.x + 95 * cos(a), y: sun.y + 95 * sin(a)),
                  CGPoint(x: sun.x + 125 * cos(a), y: sun.y + 125 * sin(a))], 0xE2711D)
        }
        guard name == "sea" else { return PKDrawing(strokes: strokes) }

        for (fy, hex) in [(0.68, 0x2D7DD2), (0.78, 0x1B998B), (0.87, 0x2D7DD2)] as [(CGFloat, UInt32)] {
            line(stride(from: w * 0.08, through: w * 0.92, by: 8).map { x in
                CGPoint(x: x, y: h * fy + 10 * sin(x / 90 * 2 * .pi))
            }, hex)
        }
        let boat = at(0.34, 0.6)
        line([boat, CGPoint(x: boat.x + 140, y: boat.y), CGPoint(x: boat.x + 116, y: boat.y + 30),
              CGPoint(x: boat.x + 24, y: boat.y + 30), boat], 0x15130F)
        line([CGPoint(x: boat.x + 70, y: boat.y), CGPoint(x: boat.x + 70, y: boat.y - 120)], 0x15130F)
        line([CGPoint(x: boat.x + 76, y: boat.y - 112), CGPoint(x: boat.x + 136, y: boat.y - 18),
              CGPoint(x: boat.x + 76, y: boat.y - 18), CGPoint(x: boat.x + 76, y: boat.y - 112)], 0xD1495B)
        return PKDrawing(strokes: strokes)
    }
}
#endif
