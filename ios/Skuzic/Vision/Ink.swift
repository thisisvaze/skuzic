import CoreGraphics
import Foundation

/// How the page looks apart from what is drawn on it: how much ink is down and
/// how warm its colours are. The eyes decide what the band plays; this decides
/// how busy and how bright it plays it, so the music grows as the page fills.
/// A port of `src/vision/ink.ts`.
struct Ink: Equatable {
    /// Share of the page with ink on it, 0...1.
    var coverage: Double
    /// -1 for all cool colours, 1 for all warm; black, grey and brown count as neutral.
    var warmth: Double

    static let none = Ink(coverage: 0, warmth: 0)

    /// Must match the paper fill (Theme.paper).
    private static let paper = (r: 252, g: 251, b: 248)

    /// Reads the page at thumbnail size, in a millisecond or two.
    static func read(_ image: CGImage) -> Ink {
        let width = 128, height = 80
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return .none }

        var ink = 0
        var warm = 0.0
        var chroma = 0.0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
            if abs(r - paper.r) + abs(g - paper.g) + abs(b - paper.b) < 48 { continue }
            ink += 1
            let top = max(r, g, b)
            let span = top - min(r, g, b)
            let saturation = top > 0 ? Double(span) / Double(top) : 0
            if saturation < 0.25 { continue }
            let hue: Double
            if top == r { hue = Double(g - b) / Double(span) * 60 }
            else if top == g { hue = (Double(b - r) / Double(span) + 2) * 60 }
            else { hue = (Double(r - g) / Double(span) + 4) * 60 }
            // Orange is the warmest point and sky blue the coolest; everything else falls between.
            warm += cos((hue - 30) * .pi / 180) * saturation
            chroma += saturation
        }
        return Ink(coverage: Double(ink) / Double(width * height), warmth: chroma > 0 ? warm / chroma : 0)
    }

    /// The two knobs Lyria steers live, from the page: a fuller page plays busier,
    /// warm colours brighter.
    func config(density: Double, brightness: Double) -> (density: Double, brightness: Double) {
        // Most sketches cover well under a third of the page; past that it is full.
        let fill = min(1, coverage / 0.3).squareRoot()
        func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }
        func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
        return (round2(clamp(density - 0.1 + 0.3 * fill, 0.15, 0.85)),
                round2(clamp(brightness + 0.15 * warmth, 0.15, 0.9)))
    }
}
