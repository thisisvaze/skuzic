import PencilKit
import SwiftUI
import UIKit

/// Longest edge sent to the planner. Above ~640px the extra detail is wasted.
private let exportMaxEdge: CGFloat = 640
private let exportQuality: CGFloat = 0.8

/// Owns the `PKCanvasView` so the surrounding SwiftUI views can drive it
/// imperatively — export, clear, undo — without threading bindings everywhere.
@MainActor
final class CanvasController: NSObject, ObservableObject {
    let canvas = PKCanvasView()
    private(set) lazy var stage = CanvasStage(canvas: canvas)

    @Published var brush: Brush =
        Preferences.string(.brush).flatMap(Brush.init(rawValue:)) ?? .pencil
    {
        didSet {
            Preferences.set(brush.rawValue, .brush)
            applyTool()
        }
    }

    @Published var color: Color =
        Preferences.string(.inkColor).flatMap(Color.init(hexString:)) ?? Theme.inks[0]
    {
        didSet {
            Preferences.set(color.hexString, .inkColor)
            applyTool()
        }
    }
    /// 0...1 within the active tool's own usable width range, so the slider
    /// means the same thing whichever ink is selected.
    @Published var sizeFraction = CGFloat(Preferences.double(.brushSize, or: 0.3)) {
        didSet {
            Preferences.set(Double(sizeFraction), .brushSize)
            applyTool()
        }
    }

    @Published var opacity = Preferences.double(.inkOpacity, or: 1) {
        didSet {
            Preferences.set(opacity, .inkOpacity)
            applyTool()
        }
    }
    @Published var erasing = false { didSet { applyTool() } }

    @Published private(set) var hasInk = false
    @Published private(set) var canUndo = false
    @Published private(set) var canRedo = false

    /// Fired when a stroke finishes, so auto-interpret can react.
    var onStrokeEnd: (() -> Void)?

    override init() {
        super.init()
        canvas.delegate = self
        canvas.backgroundColor = Theme.paperUI
        canvas.isOpaque = true
        // PencilKit inverts ink for dark appearance so strokes stay visible on a
        // dark canvas. The app runs in dark mode for its chrome, which made black
        // ink render *white* on the light paper. The paper is light, so the
        // canvas has to say so.
        canvas.overrideUserInterfaceStyle = .light
        // Pencil only: a resting palm or a stray finger must never leave a mark.
        // PencilKit's own palm rejection handles the hand; this handles the
        // fingers. Note it also means the Simulator cannot draw at all.
        canvas.drawingPolicy = .pencilOnly
        canvas.alwaysBounceVertical = false
        canvas.alwaysBounceHorizontal = false
        // The surface is exactly one screen, so scrolling and zooming have
        // nothing to do — switching them off also frees the multi-touch taps
        // below from competing with the scroll view's pan.
        canvas.isScrollEnabled = false
        canvas.minimumZoomScale = 1
        canvas.maximumZoomScale = 1
        installGestures()
        applyTool()
    }

    /// Procreate's gestures: two fingers to undo, three to redo, anywhere on the
    /// workspace. They sit on the stage rather than the paper so they still fire
    /// when the canvas has been zoomed or panned away from under your hand.
    /// A tap needs no movement, so it never competes with pinch or rotate.
    private func installGestures() {
        let undo = UITapGestureRecognizer(target: self, action: #selector(undoTapped))
        undo.numberOfTouchesRequired = 2
        undo.delegate = self
        stage.addGestureRecognizer(undo)

        let redo = UITapGestureRecognizer(target: self, action: #selector(redoTapped))
        redo.numberOfTouchesRequired = 3
        redo.delegate = self
        stage.addGestureRecognizer(redo)
    }

    func resetView() {
        stage.resetView()
    }

    @objc private func undoTapped() {
        guard canvas.undoManager?.canUndo == true else { return }
        undo()
        thump()
    }

    @objc private func redoTapped() {
        guard canvas.undoManager?.canRedo == true else { return }
        redo()
        thump()
    }

    private func thump() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Each ink has its own usable width range — a marker's minimum is wider
    /// than a pencil's maximum — so the slider is mapped through it.
    /// PencilKit's stated maximum is not always the real one: monoline, fountain
    /// pen, watercolour and crayon happily take three times it, while pencil,
    /// pen and marker clamp. Probing the tool tells us which we are holding
    /// without hardcoding a list that Apple could invalidate.
    private func usableMaxWidth() -> CGFloat {
        if erasing {
            let stated = PKEraserTool.EraserType.bitmap.validWidthRange.upperBound
            return PKEraserTool(.bitmap, width: stated * 3).width
        }
        let stated = brush.inkType.validWidthRange.upperBound
        return PKInkingTool(brush.inkType, color: .black, width: stated * 3).width
    }

    var widthRange: ClosedRange<CGFloat> {
        let lower =
            erasing
            ? PKEraserTool.EraserType.bitmap.validWidthRange.lowerBound
            : brush.inkType.validWidthRange.lowerBound
        return lower...max(lower, usableMaxWidth())
    }

    var width: CGFloat {
        let range = widthRange
        return range.lowerBound + sizeFraction * (range.upperBound - range.lowerBound)
    }

    private func applyTool() {
        if erasing {
            canvas.tool = PKEraserTool(.bitmap, width: width)
        } else {
            canvas.tool = PKInkingTool(
                brush.inkType,
                color: UIColor(color).withAlphaComponent(opacity),
                width: width
            )
        }
    }

    private func refresh() {
        hasInk = !canvas.drawing.strokes.isEmpty
        canUndo = canvas.undoManager?.canUndo ?? false
        canRedo = canvas.undoManager?.canRedo ?? false
    }

    // MARK: - Commands

    func undo() {
        canvas.undoManager?.undo()
        refresh()
    }

    func redo() {
        canvas.undoManager?.redo()
        refresh()
    }

    func clear() {
        canvas.drawing = PKDrawing()
        refresh()
    }

    func load(_ drawing: PKDrawing) {
        canvas.drawing = drawing
        // The restored strokes are the starting point, not something to undo into.
        canvas.undoManager?.removeAllActions()
        refresh()
    }

    var drawing: PKDrawing { canvas.drawing }

    /// Gallery card. PNG rather than JPEG so flat paper stays free of ringing.
    func thumbnailPNG(maxEdge: CGFloat = 480) -> Data? {
        render(maxEdge: maxEdge)?.pngData()
    }

    var isEmpty: Bool { canvas.drawing.strokes.isEmpty }

    /// The canvas can be 2732px on the long edge, but the planner only needs the
    /// shape. Downscaling before encoding shrinks the upload by an order of
    /// magnitude, which is the part of the round trip we actually control.
    /// JPEG is safe here because the paper fill means no alpha.
    func exportJPEG() -> Data? {
        let bounds = canvas.bounds
        guard bounds.width > 1, bounds.height > 1, !isEmpty else { return nil }

        return render(maxEdge: exportMaxEdge)?.jpegData(compressionQuality: exportQuality)
    }

    /// Strokes composited onto the paper fill at a bounded size.
    private func render(maxEdge: CGFloat) -> UIImage? {
        let bounds = canvas.bounds
        guard bounds.width > 1, bounds.height > 1 else { return nil }

        let scale = min(1, maxEdge / max(bounds.width, bounds.height))
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true

        // `image(from:scale:)` resolves ink against whatever appearance is
        // current, so without forcing light here the planner would receive the
        // dark-mode inversion: near-white strokes on near-white paper.
        var strokes = UIImage()
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            strokes = canvas.drawing.image(from: bounds, scale: scale)
        }

        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            // PencilKit renders strokes on transparency; compositing them over
            // the paper fill is what gives the model dark-on-light.
            Theme.paperUI.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            strokes.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

extension CanvasController: UIGestureRecognizerDelegate {
    /// PKCanvasView is a scroll view; without this its own recognizers swallow
    /// the multi-touch taps before they ever reach us.
    nonisolated func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

extension CanvasController: PKCanvasViewDelegate {
    nonisolated func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        MainActor.assumeIsolated { refresh() }
    }

    nonisolated func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        MainActor.assumeIsolated {
            refresh()
            onStrokeEnd?()
        }
    }
}

struct DrawingCanvas: UIViewRepresentable {
    let controller: CanvasController

    func makeUIView(context: Context) -> CanvasStage { controller.stage }
    func updateUIView(_ uiView: CanvasStage, context: Context) {}
}
