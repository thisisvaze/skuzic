import SwiftUI

/// Reads the SVG path strings the web build draws its vibe pictures with
/// (src/ui/VibePicker.tsx), so both apps show the same little pictures.
/// Handles the commands those pictures use: M L H V C S Q T A Z, both cases.
enum SVGPath {
    static func path(_ d: String) -> Path {
        let pattern = #"[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"#
        let regex = try? NSRegularExpression(pattern: pattern)
        let tokens = (regex?.matches(in: d, range: NSRange(d.startIndex..., in: d)) ?? [])
            .compactMap { Range($0.range, in: d).map { String(d[$0]) } }

        var path = Path()
        var i = 0
        var command: Character = "M"
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        func number() -> CGFloat {
            defer { i += 1 }
            return i < tokens.count ? CGFloat(Double(tokens[i]) ?? 0) : 0
        }
        func point(_ relative: Bool) -> CGPoint {
            let x = number(), y = number()
            return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        }

        while i < tokens.count {
            if let c = tokens[i].first, c.isLetter, tokens[i].count == 1 {
                command = c
                i += 1
            }
            let relative = command.isLowercase
            var control: CGPoint?
            switch command.uppercased() {
            case "M":
                current = point(relative)
                start = current
                path.move(to: current)
                command = relative ? "l" : "L" // further pairs are line-tos
            case "L":
                current = point(relative)
                path.addLine(to: current)
            case "H":
                let x = number()
                current.x = relative ? current.x + x : x
                path.addLine(to: current)
            case "V":
                let y = number()
                current.y = relative ? current.y + y : y
                path.addLine(to: current)
            case "C":
                let c1 = point(relative), c2 = point(relative), end = point(relative)
                path.addCurve(to: end, control1: c1, control2: c2)
                control = c2
                current = end
            case "S":
                let c1 = reflect(lastControl, about: current)
                let c2 = point(relative), end = point(relative)
                path.addCurve(to: end, control1: c1, control2: c2)
                control = c2
                current = end
            case "Q":
                let c = point(relative), end = point(relative)
                path.addQuadCurve(to: end, control: c)
                control = c
                current = end
            case "T":
                let c = reflect(lastControl, about: current)
                let end = point(relative)
                path.addQuadCurve(to: end, control: c)
                control = c
                current = end
            case "A":
                let radius = number()
                _ = number() // ry: the pictures only use circular arcs
                _ = number() // rotation
                let large = number() != 0, sweep = number() != 0
                let end = point(relative)
                arc(&path, from: current, to: end, radius: radius, large: large, sweep: sweep)
                current = end
            case "Z":
                path.closeSubpath()
                current = start
            default:
                i += 1
            }
            lastControl = control
        }
        return path
    }

    private static func reflect(_ control: CGPoint?, about p: CGPoint) -> CGPoint {
        guard let control else { return p }
        return CGPoint(x: 2 * p.x - control.x, y: 2 * p.y - control.y)
    }

    /// SVG's endpoint arc as a centre arc (circular, unrotated), per the SVG
    /// spec's implementation notes.
    private static func arc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint,
                            radius: CGFloat, large: Bool, sweep: Bool) {
        let hx = (p0.x - p1.x) / 2, hy = (p0.y - p1.y) / 2
        let d2 = hx * hx + hy * hy
        guard d2 > 0, radius > 0 else { path.addLine(to: p1); return }
        let r = max(radius, sqrt(d2))
        let k = (large != sweep ? 1 : -1) * sqrt(max(0, (r * r - d2) / d2))
        let center = CGPoint(x: k * hy + (p0.x + p1.x) / 2, y: -k * hx + (p0.y + p1.y) / 2)
        let a0 = atan2(p0.y - center.y, p0.x - center.x)
        let a1 = atan2(p1.y - center.y, p1.x - center.x)
        // In a y-down space SwiftUI's `clockwise` reads the other way round.
        path.addArc(center: center, radius: r, startAngle: .radians(a0), endAngle: .radians(a1),
                    clockwise: !sweep)
    }
}

/// One vibe's picture: a soft gradient and a few strokes in the pen's hand.
struct VibeArt: View {
    let id: String

    private enum Mark {
        case stroke(String, UInt32, CGFloat, Double = 1)
        case fill(String, UInt32, Double = 1)
        case circle(CGFloat, CGFloat, CGFloat, UInt32, Double = 1)
        case rect(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, fill: UInt32?, stroke: UInt32?, width: CGFloat = 0)
    }

    private static let art: [String: (UInt32, UInt32, [Mark])] = [
        "blank": (0xFBFAF6, 0xEBE8DF, [
            .stroke("M22 40c6-14 12-14 18 0s12 14 18 0 12-14 18 0 12 14 18 0", 0x3A3934, 3.2),
        ]),
        "lofi": (0xFAE6CC, 0xEFCDAB, [
            .circle(94, 17, 6, 0xFFF6E3),
            .fill("M44 30h28v14a12 12 0 0 1-12 12h-4a12 12 0 0 1-12-12z", 0xFFFAF2),
            .stroke("M44 30h28v14a12 12 0 0 1-12 12h-4a12 12 0 0 1-12-12z", 0x7A4B2A, 3),
            .stroke("M72 34h3a6 6 0 0 1 0 12h-3", 0x7A4B2A, 3),
            .stroke("M52 23c-3-4 3-6 0-10M60 23c-3-4 3-6 0-10M68 23c-3-4 3-6 0-10", 0xB07D55, 2.4),
            .stroke("M38 61h40", 0x7A4B2A, 3),
        ]),
        "ambient": (0xE9E5FB, 0xD3EAF8, [
            .circle(50, 38, 17, 0xA78BFA, 0.45), .circle(68, 31, 19, 0x7DD3FC, 0.5),
            .circle(77, 46, 14, 0xF9A8D4, 0.45),
            .circle(20, 15, 1.6, 0xFFFFFF), .circle(30, 26, 1.6, 0xFFFFFF), .circle(101, 16, 1.6, 0xFFFFFF),
            .circle(94, 60, 1.6, 0xFFFFFF), .circle(16, 56, 1.6, 0xFFFFFF),
        ]),
        "piano": (0xF7F4ED, 0xE6E2D8, [
            .rect(22, 19, 76, 35, 5, fill: 0xFFFDF8, stroke: 0x2B2A27, width: 2.6),
            .stroke("M34.7 19v35M47.3 19v35M60 19v35M72.7 19v35M85.3 19v35", 0x2B2A27, 1.5),
            .rect(31.1, 19, 7.2, 20, 1.6, fill: 0x2B2A27, stroke: nil),
            .rect(43.7, 19, 7.2, 20, 1.6, fill: 0x2B2A27, stroke: nil),
            .rect(69.1, 19, 7.2, 20, 1.6, fill: 0x2B2A27, stroke: nil),
            .rect(81.7, 19, 7.2, 20, 1.6, fill: 0x2B2A27, stroke: nil),
        ]),
        "folk": (0xE8F1DC, 0xF9E6CA, [
            .circle(88, 21, 8, 0xF2B33D),
            .fill("M0 55c18-15 36-15 54-4s36 9 66-8v29H0z", 0xA9CF95),
            .fill("M0 63c24-10 44-10 64-2s38 5 56-4v15H0z", 0x6A994E),
            .stroke("M30 51v-9", 0x6B4423, 2.6),
            .circle(30, 37, 6.5, 0x4F7D3A),
        ]),
        "bossa": (0xFDF0CC, 0xD3EFE9, [
            .circle(86, 47, 12, 0xF6B73C),
            .rect(0, 47, 120, 25, 0, fill: 0x93D8CC, stroke: nil),
            .stroke("M6 56q6-4 12 0t12 0t12 0t12 0t12 0t12 0t12 0t12 0t12 0", 0x1B998B, 2.2),
            .stroke("M38 62c2-12 1-23-4-34", 0x8B5A2B, 3),
            .stroke("M34 28c-9-5-17-3-21 3M34 28c9-6 18-4 22 2M34 28c-5-8-12-10-18-8M34 28c5-8 12-10 18-8",
                    0x2F9E6E, 3),
        ]),
        "jazz": (0x2C2956, 0x4B3A6C, [
            .circle(92, 17, 7, 0xF6D77A),
            .circle(20, 12, 1.3, 0xF6D77A, 0.8), .circle(44, 20, 1.3, 0xF6D77A, 0.8),
            .circle(70, 10, 1.3, 0xF6D77A, 0.8), .circle(108, 30, 1.3, 0xF6D77A, 0.8),
            .fill("M8 72V44h12v-8h12v36zM34 72V40h14v32zM50 72V48h12v24zM64 72V34h16v38zM82 72V46h12v26zM96 72V40h16v32z",
                  0x1B1838),
            .rect(12, 50, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil), .rect(26, 42, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil),
            .rect(40, 46, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil), .rect(68, 40, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil),
            .rect(74, 52, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil), .rect(100, 46, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil),
            .rect(86, 54, 3, 3.4, 0.6, fill: 0xF6D77A, stroke: nil),
        ]),
        "strings": (0xF9E4E7, 0xECDBF1, [
            .stroke("M10 46C40 24 76 22 110 36", 0x9D2F4A, 1.8, 0.8),
            .stroke("M10 51C40 29 76 27 110 41", 0x9D2F4A, 1.8, 0.8),
            .stroke("M10 56C40 34 76 32 110 46", 0x9D2F4A, 1.8, 0.8),
            .stroke("M10 61C40 39 76 37 110 51", 0x9D2F4A, 1.8, 0.8),
            .stroke("M24 16l72 38", 0x6B3A2A, 2.6),
            .stroke("M24 16l-1.5 6", 0x6B3A2A, 2.6),
        ]),
    ]

    var body: some View {
        // A vibe added to palette.json before it has a picture borrows the blank page's.
        let (from, to, marks) = Self.art[id] ?? Self.art["blank"]!
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .linearGradient(
                Gradient(colors: [Color(hex: from), Color(hex: to)]),
                startPoint: .zero, endPoint: CGPoint(x: size.width, y: size.height)))
            // The pictures are drawn on a 120 x 72 page; fill the card with it.
            let scale = max(size.width / 120, size.height / 72)
            context.translateBy(x: (size.width - 120 * scale) / 2, y: (size.height - 72 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            let round = StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round)
            for mark in marks {
                switch mark {
                case let .stroke(d, color, width, opacity):
                    var style = round
                    style.lineWidth = width
                    context.stroke(SVGPath.path(d), with: .color(Color(hex: color).opacity(opacity)), style: style)
                case let .fill(d, color, opacity):
                    context.fill(SVGPath.path(d), with: .color(Color(hex: color).opacity(opacity)))
                case let .circle(x, y, r, color, opacity):
                    context.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)),
                                 with: .color(Color(hex: color).opacity(opacity)))
                case let .rect(x, y, w, h, radius, fill, stroke, width):
                    let shape = Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: radius)
                    if let fill { context.fill(shape, with: .color(Color(hex: fill))) }
                    if let stroke {
                        var style = round
                        style.lineWidth = width
                        context.stroke(shape, with: .color(Color(hex: stroke)), style: style)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// A vibe as a card: its picture and its name. Quiet on purpose: a thin
/// violet edge and a dot mark the chosen one.
struct VibeCard: View {
    let vibe: Palette.Vibe
    let chosen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                VibeArt(id: vibe.id)
                    .aspectRatio(2, contentMode: .fit)
                HStack(spacing: 6) {
                    Text(vibe.name)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if chosen {
                        Circle().fill(Theme.brand3).frame(width: 6, height: 6)
                    }
                }
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
            }
            .background(Theme.panel)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(chosen ? Theme.brand3.opacity(0.6) : Theme.border, lineWidth: chosen ? 1.5 : 1)
            )
            .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(vibe.name). \(vibe.blurb)")
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// The blank page's invitation, along its bottom edge so the middle stays free
/// to draw: start from a vibe, or just draw.
struct VibeStrip: View {
    let vibes: [Palette.Vibe]
    let current: String
    let hint: String?
    let onPick: (Palette.Vibe) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(hint ?? "Start with a vibe, or just draw")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.inkMuted)
                .padding(.horizontal, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vibes) { vibe in
                        VibeCard(vibe: vibe, chosen: vibe.id == current) { onPick(vibe) }
                            .frame(width: 112)
                    }
                }
                .padding(2)
            }
        }
        .padding(10)
        .background(Color.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.black.opacity(0.06)))
        .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
        // On the paper, which is always paper: light whatever the theme.
        .environment(\.colorScheme, .light)
    }
}
