import SwiftUI

/// On/off. "On" wears the brand gradient: it is always something the music is doing.
struct BrandToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .top, spacing: 12) {
            configuration.label
            Spacer(minLength: 0)
            Button {
                withAnimation(.snappy(duration: 0.2)) { configuration.isOn.toggle() }
            } label: {
                track(configuration)
            }
            .buttonStyle(.plain)
            .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
        }
    }

    private func track(_ configuration: Configuration) -> some View {
            ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                Capsule()
                    .fill(configuration.isOn ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.muted))
                    .frame(width: 44, height: 26)
                Circle()
                    .fill(.white)
                    .frame(width: 22, height: 22)
                    .shadow(color: .black.opacity(0.25), radius: 1.5, y: 1)
                    .padding(2)
            }
    }
}

/// The chunky channel fader: a tinted capsule that fills to the level, with a
/// white cap to grab.
struct Fader: View {
    let value: Double
    let tint: Color
    var enabled = true
    let onChange: (Double) -> Void

    private let height: CGFloat = 24

    var body: some View {
        GeometryReader { geo in
            let span = max(1, geo.size.width - height)
            ZStack(alignment: .leading) {
                Capsule().fill(tint.opacity(0.18))
                Capsule().fill(tint).frame(width: height + span * value)
                Circle()
                    .fill(.white)
                    .frame(width: height, height: height)
                    .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                    .offset(x: span * value)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                guard enabled else { return }
                onChange(min(1, max(0, (drag.location.x - height / 2) / span)))
            })
        }
        .frame(height: height)
        .opacity(enabled ? 1 : 0.5)
        .accessibilityElement()
        .accessibilityValue("\(Int(value * 100))")
        .accessibilityAdjustableAction { direction in
            onChange(min(1, max(0, value + (direction == .increment ? 0.05 : -0.05))))
        }
    }
}

/// A knob with its two ends named, so moving it says what it does.
struct RangeKnob: View {
    let label: String
    let low: String
    let high: String
    let value: Double
    var range: ClosedRange<Double> = 0...1
    let display: String
    let onChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                Spacer()
                Text(display).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.inkMuted)
            }
            Slider(value: Binding(get: { value }, set: onChange), in: range)
                .tint(Theme.ink)
                .accessibilityLabel(label)
            HStack {
                Text(low)
                Spacer()
                Text(high)
            }
            .font(.system(size: 11))
            .foregroundStyle(Theme.inkMuted)
        }
    }
}

/// An on/off pill with an icon, struck through when off.
struct ToggleChip: View {
    let title: String
    let icon: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.system(size: 13))
                .strikethrough(!on)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .foregroundStyle(on ? Theme.panel : Theme.inkMuted)
                .background(on ? Theme.ink : Theme.secondary, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Small section label with an optional count on the right.
struct SectionHeading: View {
    let title: String
    var aside: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer()
            if let aside { Text(aside).monospacedDigit() }
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Theme.inkMuted)
        .padding(.horizontal, 4)
    }
}

/// A pencil line that is also a sound wave: the whole idea in one stroke.
struct Wordmark: View {
    var showName = true

    var body: some View {
        HStack(spacing: 8) {
            SVGPath.path("M2 8c2.4-6 4.8-6 7 0s4.6 6 7 0 4.6-6 7 0 3.4 4.5 5 2")
                .stroke(LinearGradient(colors: [Theme.brand1, Theme.brand2, Theme.brand3],
                                       startPoint: .leading, endPoint: .trailing),
                        style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: 30, height: 16)
            if showName {
                Text("skuzic")
                    .font(.system(size: 19, weight: .bold))
                    .tracking(-0.4)
                    .foregroundStyle(Theme.ink)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("skuzic")
    }
}

extension View {
    /// The floating glass the chrome sits on, over the desk or the paper.
    func glass<S: Shape>(_ shape: S) -> some View {
        background(.ultraThinMaterial, in: shape)
            .background(Theme.panel.opacity(0.55), in: shape)
            .overlay(shape.stroke(Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 14, y: 5)
    }
}
