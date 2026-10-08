import Foundation

// The pen engine's paper rules, mirroring the touch checks in core.test.ts.
// Only the pure functions run here, so no audio device is needed.
@main
private struct TouchTests {
    static func check(_ condition: @autoclosure () -> Bool, _ label: String) {
        guard condition() else { fatalError("FAIL: \(label)") }
        print("  ok  \(label)")
    }

    static func main() {
        check(TouchEngine.frictionLevel(speed: 0, pressure: 1) == 0, "a still pen is silent")
        check(TouchEngine.frictionLevel(speed: 800, pressure: 0) > 0, "zero pressure never mutes a moving pen")
        check(TouchEngine.frictionLevel(speed: 200, pressure: 0.5) < TouchEngine.frictionLevel(speed: 800, pressure: 0.5),
              "friction rises with speed")
        check(TouchEngine.frictionLevel(speed: 1e6, pressure: 1) <= 1, "friction never exceeds full level")
        print("iOS touch engine checks passed")
    }
}
