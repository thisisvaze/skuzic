import Foundation

// The pen engine's musical rules, mirroring the touch checks in core.test.ts.
// Only the pure functions run here, so no audio device is needed.
@main
private struct TouchTests {
    static func check(_ condition: @autoclosure () -> Bool, _ label: String) {
        guard condition() else { fatalError("FAIL: \(label)") }
        print("  ok  \(label)")
    }

    static func main() {
        let notes = TouchEngine.notes
        // F major / D minor pentatonic is F G A C D: pitch classes 5 7 9 0 2.
        check(notes.allSatisfy { [5, 7, 9, 0, 2].contains($0 % 12) },
              "every pen note is in F major / D minor pentatonic")

        // The web test's sequence, so both check the same melody on every run.
        var seed: UInt32 = 7
        let rand = { () -> Double in
            seed = seed &* 1_664_525 &+ 1_013_904_223
            return Double(seed) / 4_294_967_296
        }
        var line: [Int] = []
        var note: Int?
        for i in 0..<300 {
            let next = TouchEngine.nextNote(note, aim: Double(i * 7 % notes.count), rand: rand)
            line.append(next)
            note = next
        }
        check(line.indices.allSatisfy {
            notes.indices.contains(line[$0]) && ($0 == 0 || abs(line[$0] - line[$0 - 1]) <= 2)
        }, "the melody moves by steps of at most two and stays in range")
        var high = 1
        for _ in 0..<12 { high = TouchEngine.nextNote(high, aim: Double(notes.count - 1), rand: rand) }
        check(high >= 7, "drawing high on the page pulls the melody up")
        check((0..<200).allSatisfy { i in
            let end = TouchEngine.nextNote(i % notes.count, aim: Double(i * 3 % notes.count), rand: rand, resolve: true)
            return [5, 9, 0].contains(notes[end] % 12)
        }, "a phrase always comes home to F, A or C")

        let settled = TouchEngine.phrase(attention: 0.45, rand: { 0.5 })
        let fresh = TouchEngine.phrase(attention: 1, rand: { 0.5 })
        check(settled.notes < fresh.notes && settled.breath > fresh.breath,
              "a settled pen plays shorter phrases and breathes longer")
        check(TouchEngine.attend(1, dt: 120, drawing: true) < 0.6
              && TouchEngine.attend(1, dt: 1e9, drawing: true) >= 0.45 - 1e-9,
              "attention settles during long drawing, never below its floor")
        check(TouchEngine.attend(0.45, dt: 30, drawing: false) > 0.9, "attention comes back after a pause")
        check(!TouchEngine.mayPlay(now: 1.2, last: 1, attention: 1)
              && TouchEngine.mayPlay(now: 1.4, last: 1, attention: 1)
              && !TouchEngine.mayPlay(now: 1.4, last: 1, attention: 0.45),
              "notes keep their distance, more so as attention settles")

        check(TouchEngine.frictionLevel(speed: 0, pressure: 1) == 0, "a still pen is silent")
        check(TouchEngine.frictionLevel(speed: 800, pressure: 0) > 0, "zero pressure never mutes a moving pen")
        check(TouchEngine.frictionLevel(speed: 200, pressure: 0.5) < TouchEngine.frictionLevel(speed: 800, pressure: 0.5),
              "friction rises with speed")
        check(TouchEngine.frictionLevel(speed: 1e6, pressure: 1) <= 1, "friction never exceeds full level")
        print("iOS touch engine checks passed")
    }
}
