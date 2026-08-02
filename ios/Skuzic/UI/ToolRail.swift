import SwiftUI

/// The Procreate-style rail: a floating column pinned to the left edge so the
/// drawing surface itself stays edge to edge behind it. Kept deliberately tight
/// — the chrome should read as a thin strip, not a panel.
struct ToolRail: View {
    @ObservedObject var canvas: CanvasController

    @State private var showColorWheel = false

    static let sliderWidth: CGFloat = 26
    static let sliderGap: CGFloat = 9
    /// The paired sliders set the rail's width; buttons and dividers span the
    /// same span so every element sits the same distance from the edge.
    static let contentWidth: CGFloat = sliderWidth * 2 + sliderGap

    var body: some View {
        VStack(spacing: 11) {
            HStack(spacing: Self.sliderGap) {
                RailSlider(value: $canvas.sizeFraction) {
                    Circle()
                        .fill(.white)
                        .frame(width: nibPreview, height: nibPreview)
                }

                RailSlider(value: opacityBinding) {
                    Circle()
                        .fill(canvas.color.opacity(canvas.opacity))
                        .frame(width: 18, height: 18)
                        .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 1.5))
                }
            }

            divider

            VStack(spacing: 2) {
                ForEach(Brush.allCases) { brush in
                    RailButton(
                        icon: brush.icon,
                        active: !canvas.erasing && canvas.brush == brush,
                        help: brush.title
                    ) {
                        canvas.brush = brush
                        canvas.erasing = false
                    }
                }

                RailButton(icon: "eraser", active: canvas.erasing, help: "Eraser") {
                    canvas.erasing.toggle()
                }
            }

            divider

            Button {
                canvas.erasing = false
                showColorWheel = true
            } label: {
                Circle()
                    .fill(canvas.color)
                    .frame(width: 36, height: 36)
                    .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 2))
                    .overlay(Circle().stroke(.black.opacity(0.25), lineWidth: 0.5))
                    // Without this the hit area and pointer highlight default to
                    // the bounding rect, so a round swatch reads as a square.
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Colour")
            .popover(isPresented: $showColorWheel, arrowEdge: .leading) {
                ColorWheel(color: $canvas.color)
                    .padding(20)
                    .presentationCompactAdaptation(.popover)
            }

            divider

            VStack(spacing: 2) {
                RailButton(
                    icon: "arrow.uturn.backward", active: false, enabled: canvas.canUndo,
                    help: "Undo"
                ) { canvas.undo() }

                RailButton(
                    icon: "arrow.uturn.forward", active: false, enabled: canvas.canRedo,
                    help: "Redo"
                ) { canvas.redo() }

                RailButton(
                    icon: "arrow.up.left.and.arrow.down.right", active: false, help: "Fit canvas"
                ) { canvas.resetView() }

                RailButton(
                    icon: "trash", active: false, enabled: canvas.hasInk, help: "Clear"
                ) { canvas.clear() }
            }
        }
        .fixedSize()
        .padding(.vertical, 11)
        .padding(.horizontal, 9)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.22), radius: 16, y: 5)
    }

    private var opacityBinding: Binding<CGFloat> {
        Binding(
            get: { CGFloat(canvas.opacity) },
            // Fully transparent ink is just a broken brush; hold a usable floor.
            set: { canvas.opacity = Double(max(0.05, $0)) }
        )
    }

    private var divider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: Self.contentWidth, height: 0.5)
    }

    /// The nib at true scale, capped so a 240pt watercolour doesn't dwarf the rail.
    private var nibPreview: CGFloat {
        min(21, max(4, canvas.width))
    }
}

private struct RailButton: View {
    let icon: String
    let active: Bool
    var enabled = true
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 21, weight: .medium))
                .frame(width: ToolRail.contentWidth, height: 38)
                .foregroundStyle(active ? Color.black : Color.white.opacity(enabled ? 0.85 : 0.3))
                .background {
                    if active {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(.white.opacity(0.92))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(help)
    }
}

/// Procreate's vertical bar: a slim track that fills from the bottom, with the
/// thumb rendering what the setting actually does.
private struct RailSlider<Thumb: View>: View {
    @Binding var value: CGFloat
    @ViewBuilder let thumb: () -> Thumb

    private let width: CGFloat = ToolRail.sliderWidth
    private let height: CGFloat = 210

    var body: some View {
        GeometryReader { geo in
            let span = geo.size.height
            ZStack(alignment: .bottom) {
                Capsule().fill(.black.opacity(0.28))

                Capsule()
                    .fill(.white.opacity(0.85))
                    .frame(height: max(4, span * value))

                thumb()
                    .shadow(color: .black.opacity(0.35), radius: 1.5)
                    .offset(y: -(span - width) * value)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, (width - 21) / 2)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        value = min(1, max(0, 1 - drag.location.y / span))
                    }
            )
        }
        .frame(width: width, height: height)
    }
}
