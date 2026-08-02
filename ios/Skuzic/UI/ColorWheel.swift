import SwiftUI
import UIKit

/// Procreate's Disc picker: an outer hue ring around an inner saturation and
/// brightness field. One drag gesture covers both — which half you get is
/// decided by how far from the centre the touch lands, so there is no ambiguity
/// where the two regions meet.
struct ColorWheel: View {
    @Binding var color: Color

    private let diameter: CGFloat = 232
    private let ringWidth: CGFloat = 26
    private let gap: CGFloat = 10

    @State private var hue: Double
    @State private var saturation: Double
    @State private var brightness: Double

    /// Which half of the wheel the current drag started in. Without this, sliding
    /// past the edge of the inner field while picking a shade crosses into the
    /// hue ring and jumps you to a completely different colour.
    private enum Region { case hue, field }
    @State private var dragRegion: Region?

    init(color: Binding<Color>) {
        _color = color
        let hsb = HSB(color.wrappedValue)
        _hue = State(initialValue: hsb.hue)
        _saturation = State(initialValue: hsb.saturation)
        _brightness = State(initialValue: hsb.brightness)
    }

    private var innerDiameter: CGFloat { diameter - 2 * (ringWidth + gap) }
    private var ringRadius: CGFloat { (diameter - ringWidth) / 2 }

    private var pure: Color { Color(hue: hue, saturation: 1, brightness: 1) }

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                hueRing
                saturationField
                hueHandle
                saturationHandle
            }
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in handleDrag(value.location) }
                    .onEnded { _ in dragRegion = nil }
            )

            readout
            palette
        }
    }

    // MARK: - Pieces

    private var hueRing: some View {
        Circle()
            .strokeBorder(
                AngularGradient(
                    gradient: Gradient(colors: stride(from: 0.0, through: 1.0, by: 1.0 / 24).map {
                        Color(hue: $0, saturation: 1, brightness: 1)
                    }),
                    center: .center
                ),
                lineWidth: ringWidth
            )
    }

    private var saturationField: some View {
        Circle()
            .fill(
                LinearGradient(
                    colors: [.white, pure], startPoint: .leading, endPoint: .trailing)
            )
            .overlay(
                Circle().fill(
                    LinearGradient(
                        colors: [.clear, .black], startPoint: .top, endPoint: .bottom))
            )
            .frame(width: innerDiameter, height: innerDiameter)
    }

    private var hueHandle: some View {
        Circle()
            .fill(pure)
            .frame(width: ringWidth - 5, height: ringWidth - 5)
            .overlay(Circle().stroke(.white, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.3), radius: 2)
            .offset(
                x: ringRadius * cos(hue * 2 * .pi),
                y: ringRadius * sin(hue * 2 * .pi)
            )
    }

    private var saturationHandle: some View {
        Circle()
            .fill(color)
            .frame(width: 22, height: 22)
            .overlay(Circle().stroke(.white, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.3), radius: 2)
            .offset(
                x: (saturation - 0.5) * innerDiameter,
                y: (0.5 - brightness) * innerDiameter
            )
    }

    private var readout: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(color)
                .frame(width: 34, height: 24)
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(.white.opacity(0.25), lineWidth: 0.5)
                )

            Text(hexString)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white.opacity(0.8))

            Spacer()
        }
        .frame(width: diameter)
    }

    /// The twelve inks from the web build, kept as a palette because they were
    /// chosen to survive the downscale to 640px that the planner sees.
    private var palette: some View {
        let rows = stride(from: 0, to: Theme.inks.count, by: 6).map {
            Array(Theme.inks[$0..<min($0 + 6, Theme.inks.count)])
        }
        return VStack(spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, ink in
                        Button {
                            apply(ink)
                        } label: {
                            Circle()
                                .fill(ink)
                                .frame(width: 26, height: 26)
                                .overlay(Circle().stroke(.white.opacity(0.2), lineWidth: 0.5))
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(width: diameter)
    }

    // MARK: - Interaction

    private func handleDrag(_ point: CGPoint) {
        let center = CGPoint(x: diameter / 2, y: diameter / 2)
        let dx = point.x - center.x
        let dy = point.y - center.y
        let distance = sqrt(dx * dx + dy * dy)

        // Lock to whichever region the drag began in and stay there for the rest
        // of the gesture, so overshooting the inner field only pins saturation
        // and brightness at their limits instead of grabbing the hue ring.
        let region = dragRegion ?? (distance > innerDiameter / 2 + gap / 2 ? .hue : .field)
        dragRegion = region

        switch region {
        case .hue:
            var angle = atan2(dy, dx)
            if angle < 0 { angle += 2 * .pi }
            hue = angle / (2 * .pi)
        case .field:
            saturation = clamp(dx / innerDiameter + 0.5)
            brightness = clamp(0.5 - dy / innerDiameter)
        }

        commit()
    }

    private func clamp(_ value: Double) -> Double { min(1, max(0, value)) }

    private func commit() {
        color = Color(hue: hue, saturation: saturation, brightness: brightness)
    }

    private func apply(_ ink: Color) {
        let hsb = HSB(ink)
        hue = hsb.hue
        saturation = hsb.saturation
        brightness = hsb.brightness
        color = ink
    }

    private var hexString: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(
            format: "#%02X%02X%02X", Int(r * 255 + 0.5), Int(g * 255 + 0.5), Int(b * 255 + 0.5))
    }
}

private struct HSB {
    var hue: Double
    var saturation: Double
    var brightness: Double

    init(_ color: Color) {
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        hue = Double(h)
        saturation = Double(s)
        brightness = Double(b)
    }
}
