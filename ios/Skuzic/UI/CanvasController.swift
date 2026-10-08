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

    /// The rail's speaker. Off lets a stroke in progress go quiet at once.
    @Published var brushSound = Preferences.bool(.brushSound, or: true) {
        didSet {
            Preferences.set(brushSound, .brushSound)
            if !brushSound { touch.up(time: ProcessInfo.processInfo.systemUptime) }
        }
    }

    /// The music's level, 0...1, so the pen makes room when it is loud.
    var meter: () -> Float = { 0 }
    /// The pen's own sound: TouchEngine, the web build's src/audio/touch.ts,
    /// played from the touches PencilKit draws with.
    private lazy var touch: TouchEngine = {
        let engine = TouchEngine()
        engine.listen { [weak self] in self?.meter() ?? 0 }
        return engine
    }()

    @Published private(set) var hasInk = false
    @Published private(set) var canUndo = false
    @Published private(set) var canRedo = false

    /// Auto-interpret waits until the tool lifts and cancels when it touches down.
    private(set) var isDrawing = false
    private var strokeStartedAt: TimeInterval = 0
    var onStrokeBegin: (() -> Void)?
    var onStrokeEnd: (() -> Void)?
    /// Fired when the page is wiped from the rail, so the band can wind down.
    var onClear: (() -> Void)?

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
        #if targetEnvironment(simulator)
        // The Simulator has no Pencil; let the mouse draw so the app can be tried there.
        canvas.drawingPolicy = .anyInput
        #endif
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
        // Built with the sketch, so the paper is ready under the first stroke.
        _ = touch
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

        let listener = TouchListener(target: nil, action: nil)
        listener.draws = { [weak self] in $0.type == .pencil || self?.canvas.drawingPolicy == .anyInput }
        listener.began = { [weak self] in self?.penDown($0) }
        listener.moved = { [weak self] in self?.penMoved($0) }
        listener.ended = { [weak self] in self?.touch.up(time: $0.timestamp) }
        canvas.addGestureRecognizer(listener)
    }

    // MARK: - Pen sound

    private func penDown(_ t: UITouch) {
        guard brushSound else { return }
        let at = t.location(in: canvas)
        let tool: PenTool = erasing ? .eraser : brush == .marker || brush == .watercolor ? .marker : .pencil
        touch.down(x: at.x, y: at.y, pressure: Self.pressure(t), time: t.timestamp,
                   width: canvas.bounds.width, height: canvas.bounds.height, tool: tool, opacity: opacity)
    }

    private func penMoved(_ samples: [UITouch]) {
        guard brushSound else { return }
        for t in samples {
            let at = t.location(in: canvas)
            touch.move(x: at.x, y: at.y, pressure: Self.pressure(t), time: t.timestamp)
        }
    }

    /// A Pencil's force as 0...1. A finger or mouse has none and reads as an
    /// even 0.5, as a mouse does on the web.
    private static func pressure(_ t: UITouch) -> CGFloat {
        t.maximumPossibleForce > 0 && t.force > 0 ? t.force / t.maximumPossibleForce : 0.5
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
        let ink = !canvas.drawing.strokes.isEmpty
        let undo = canvas.undoManager?.canUndo ?? false
        let redo = canvas.undoManager?.canRedo ?? false
        // PencilKit calls this throughout a stroke. Publishing unchanged values
        // needlessly rebuilds the surrounding SwiftUI view on every move.
        if hasInk != ink { hasInk = ink }
        if canUndo != undo { canUndo = undo }
        if canRedo != redo { canRedo = redo }
    }

    // MARK: - Commands

    // Undo and redo change the page as much as a stroke does, so they report
    // like one and the music reads the page again.
    func undo() {
        canvas.undoManager?.undo()
        refresh()
        onStrokeEnd?()
    }

    func redo() {
        canvas.undoManager?.redo()
        refresh()
        onStrokeEnd?()
    }

    func clear() {
        let hadInk = hasInk
        canvas.drawing = PKDrawing()
        refresh()
        guard hadInk else { return }
        if brushSound { touch.clear() }
        onClear?()
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

    /// The page for the eyes and the ink reader: its strokes for grouping into
    /// figures, crops around those, and the whole sheet small enough to read in
    /// milliseconds. Nil when blank.
    func page() -> Page? {
        guard !isEmpty, let image = render(maxEdge: 448)?.cgImage else { return nil }
        let drawing = canvas.drawing
        let marks = drawing.strokes.map { stroke in
            Mark(id: Self.id(of: stroke), color: Self.hex(stroke.ink.color),
                 points: stroke.path.interpolatedPoints(by: .distance(4)).map { $0.location.applying(stroke.transform) })
        }
        return Page(marks: marks, size: canvas.bounds.size, image: image, crop: { Self.crop($0, of: drawing) })
    }

    /// Unique per stroke, and changed when the bitmap eraser trims it, which
    /// PencilKit does by masking or splitting the stroke in place.
    private static func id(of stroke: PKStroke) -> String {
        "\(stroke.path.creationDate.timeIntervalSinceReferenceDate) \(stroke.renderBounds) \(stroke.mask?.bounds ?? .null)"
    }

    private static func hex(_ color: UIColor) -> String {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
    }

    /// A 224-point square of the drawing around a figure, padded by a fifth, on
    /// paper: the framing scripts/embed-palette.py taught the eyes.
    private static func crop(_ box: CGRect, of drawing: PKDrawing) -> CGImage? {
        let side = max(box.width, box.height) * 1.2 + 24
        let rect = CGRect(x: box.midX - side / 2, y: box.midY - side / 2, width: side, height: side)
        let frame = CGRect(x: 0, y: 0, width: 224, height: 224)
        var strokes = UIImage()
        // Light, for the same reason as `render`: dark would invert the ink.
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            strokes = drawing.image(from: rect, scale: frame.width / side)
        }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: frame.size, format: format).image { context in
            Theme.paperUI.setFill()
            context.fill(frame)
            strokes.draw(in: frame)
        }.cgImage
    }

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
    nonisolated func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        MainActor.assumeIsolated {
            isDrawing = true
            strokeStartedAt = Diagnostics.now
            Diagnostics.event(.drawing, "STROKE_BEGIN")
            onStrokeBegin?()
        }
    }

    nonisolated func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        MainActor.assumeIsolated { refresh() }
    }

    nonisolated func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        MainActor.assumeIsolated {
            isDrawing = false
            refresh()
            Diagnostics.event(.drawing, "STROKE_END elapsed_ms=\(Diagnostics.milliseconds(since: strokeStartedAt)) strokes=\(canvas.drawing.strokes.count)")
            onStrokeEnd?()
        }
    }
}

/// Hears the touches PencilKit draws with, for the pen's sound, without taking
/// part: it never recognizes and nothing can stop it, so drawing, pinching and
/// the undo taps behave exactly as they would without it.
private final class TouchListener: UIGestureRecognizer {
    var draws: (UITouch) -> Bool = { _ in true }
    var began: ((UITouch) -> Void)?
    var moved: (([UITouch]) -> Void)?
    var ended: ((UITouch) -> Void)?
    /// One stroke at a time. Weak, so a touch that never reports its end can't
    /// hold up the next stroke.
    private weak var tracked: UITouch?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func canPrevent(_ other: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard tracked == nil, let touch = touches.first(where: draws) else { return }
        tracked = touch
        began?(touch)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let tracked, touches.contains(tracked) else { return }
        // Every sample the Pencil took since the last frame, each with its own time.
        moved?(event.coalescedTouches(for: tracked) ?? [tracked])
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { finish(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { finish(touches) }

    private func finish(_ touches: Set<UITouch>) {
        guard let tracked, touches.contains(tracked) else { return }
        self.tracked = nil
        ended?(tracked)
    }
}

struct DrawingCanvas: UIViewRepresentable {
    let controller: CanvasController

    func makeUIView(context: Context) -> CanvasStage { controller.stage }
    func updateUIView(_ uiView: CanvasStage, context: Context) {}
}
