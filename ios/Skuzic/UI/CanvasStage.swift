import PencilKit
import UIKit

/// Procreate's canvas surface: the paper floats on a darker workspace with a
/// soft drop shadow, and two fingers pinch, rotate and pan it.
///
/// The transform lives on a wrapper rather than the `PKCanvasView` itself so the
/// shadow has somewhere to draw — a scroll view clips its own bounds, which
/// would swallow it.
final class CanvasStage: UIView {
    let paper = UIView()
    let canvas: PKCanvasView

    /// Margin at rest, so the shadow is visible without zooming out.
    private let inset: CGFloat = 22

    private var scale: CGFloat = 1
    private var rotation: CGFloat = 0
    private var paperCenter: CGPoint = .zero
    private var lastSize: CGSize = .zero

    private let minScale: CGFloat = 0.3
    private let maxScale: CGFloat = 8

    /// How close a gesture has to land before the canvas snaps to true.
    private let rotationSnap: CGFloat = 0.10  // ~6°
    private let scaleSnap: CGFloat = 0.07
    private let centerSnap: CGFloat = 36

    init(canvas: PKCanvasView) {
        self.canvas = canvas
        super.init(frame: .zero)

        backgroundColor = Theme.workspaceUI

        paper.backgroundColor = Theme.paperUI
        paper.layer.shadowColor = UIColor.black.cgColor
        paper.layer.shadowOpacity = 0.3
        paper.layer.shadowRadius = 22
        paper.layer.shadowOffset = CGSize(width: 0, height: 10)
        addSubview(paper)

        canvas.clipsToBounds = true
        paper.addSubview(canvas)

        installGestures()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    // MARK: - Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0 else { return }

        // A size change means a device rotation or a split-view resize; the old
        // pan and zoom no longer mean anything against the new geometry.
        if bounds.size != lastSize {
            lastSize = bounds.size
            paper.bounds = CGRect(
                origin: .zero,
                size: CGSize(
                    width: bounds.width - inset * 2, height: bounds.height - inset * 2))
            scale = 1
            rotation = 0
            paperCenter = CGPoint(x: bounds.midX, y: bounds.midY)
            apply()
        }

        canvas.frame = paper.bounds
    }

    private func apply() {
        paper.transform = CGAffineTransform(rotationAngle: rotation)
            .scaledBy(x: scale, y: scale)
        paper.center = paperCenter
    }

    // MARK: - Gestures

    private func installGestures() {
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch))
        let rotate = UIRotationGestureRecognizer(target: self, action: #selector(handleRotate))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2

        for gesture in [pinch, rotate, pan] as [UIGestureRecognizer] {
            gesture.delegate = self
            addGestureRecognizer(gesture)
        }
    }

    /// Scaling and rotating about the gesture's own centroid is what makes the
    /// canvas feel pinned to the fingers rather than to its own middle.
    private func pivot(_ anchor: CGPoint, scaleBy factor: CGFloat) {
        paperCenter = CGPoint(
            x: anchor.x + factor * (paperCenter.x - anchor.x),
            y: anchor.y + factor * (paperCenter.y - anchor.y))
    }

    private func pivot(_ anchor: CGPoint, rotateBy angle: CGFloat) {
        let dx = paperCenter.x - anchor.x
        let dy = paperCenter.y - anchor.y
        paperCenter = CGPoint(
            x: anchor.x + dx * cos(angle) - dy * sin(angle),
            y: anchor.y + dx * sin(angle) + dy * cos(angle))
    }

    @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        guard gesture.numberOfTouches == 2 || gesture.state != .changed else { return }
        let factor = gesture.scale
        scale *= factor
        pivot(gesture.location(in: self), scaleBy: factor)
        gesture.scale = 1
        apply()
        settleIfDone(gesture)
    }

    @objc private func handleRotate(_ gesture: UIRotationGestureRecognizer) {
        let angle = gesture.rotation
        rotation += angle
        pivot(gesture.location(in: self), rotateBy: angle)
        gesture.rotation = 0
        apply()
        settleIfDone(gesture)
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        let delta = gesture.translation(in: self)
        paperCenter.x += delta.x
        paperCenter.y += delta.y
        gesture.setTranslation(.zero, in: self)
        apply()
        settleIfDone(gesture)
    }

    private func settleIfDone(_ gesture: UIGestureRecognizer) {
        guard gesture.state == .ended || gesture.state == .cancelled else { return }
        settle()
    }

    /// The magnetic part: near-upright snaps upright, near-1:1 snaps to 1:1, and
    /// a canvas dragged only slightly off centre returns to centre.
    private func settle() {
        var targetScale = min(maxScale, max(minScale, scale))
        var targetRotation = rotation
        var targetCenter = paperCenter

        let quarter = CGFloat.pi / 2
        let nearest = (rotation / quarter).rounded() * quarter
        if abs(rotation - nearest) < rotationSnap { targetRotation = nearest }

        if abs(targetScale - 1) < scaleSnap { targetScale = 1 }

        let home = CGPoint(x: bounds.midX, y: bounds.midY)
        let offset = hypot(paperCenter.x - home.x, paperCenter.y - home.y)
        if offset < centerSnap { targetCenter = home }

        // Zoomed out past fit, there is no reason to be off-centre at all.
        if targetScale <= 1 { targetCenter = home }

        guard targetScale != scale || targetRotation != rotation || targetCenter != paperCenter
        else { return }

        scale = targetScale
        rotation = targetRotation
        paperCenter = targetCenter

        UIView.animate(
            withDuration: 0.28, delay: 0, usingSpringWithDamping: 0.85,
            initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            self.apply()
        }
    }

    /// Snap back to a centred, upright, 1:1 canvas.
    func resetView() {
        scale = 1
        rotation = 0
        paperCenter = CGPoint(x: bounds.midX, y: bounds.midY)
        UIView.animate(
            withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            self.apply()
        }
    }

    var isTransformed: Bool {
        abs(scale - 1) > 0.001 || abs(rotation) > 0.001
            || hypot(paperCenter.x - bounds.midX, paperCenter.y - bounds.midY) > 1
    }
}

extension CanvasStage: UIGestureRecognizerDelegate {
    /// Pinch, rotate and pan are one continuous manipulation, so they must all
    /// run together rather than the first one winning.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}
