import CoreGraphics
import Foundation

// The iPad's drawing reader logic (Vision/Palette.swift, Vision/Ink.swift),
// held to the same checks as the web's in core.test.ts, on the same palette.
@main
private struct PaletteTests {
    static func check(_ condition: @autoclosure () -> Bool, _ label: String) {
        guard condition() else { fatalError("FAIL: \(label)") }
        print("  ok  \(label)")
    }

    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("src/vision")
        let book = try PaletteBook(palette: Data(contentsOf: root.appendingPathComponent("palette.json")),
                                   vectors: Data(contentsOf: root.appendingPathComponent("palette-vectors.json")))
        let palette = book.palette
        let rainVector = book.vectors.moods["rainy"]!.vector
        let blank = book.defaultVibe

        let rainy = book.readPage(rainVector, vibe: blank)
        check(rainy.moods.first?.item.id == "rainy", "a page that reads exactly like rain picks the rain mood")
        let m1 = rainy.moods[0].item, m2 = rainy.moods[1].item
        check(book.chooseMood([Ranked(item: m1, p: 0.3), Ranked(item: m2, p: 0.25)], playing: nil) == nil,
              "an ambiguous page keeps the playing mood")
        check(book.chooseMood([Ranked(item: m1, p: 0.5), Ranked(item: m2, p: 0.4)], playing: m2.id) == nil,
              "a narrow lead keeps the playing mood")
        check(book.chooseMood([Ranked(item: m1, p: 0.8), Ranked(item: m2, p: 0.1)], playing: m2.id) == m1,
              "a clear, confident reading switches mood")

        let i1 = palette.instruments[0], i2 = palette.instruments[1], i3 = palette.instruments[2]
        func seats(_ ranked: [(Palette.Instrument, Double)], _ playing: [String]) -> [String] {
            book.chooseInstruments(ranked.map { Ranked(item: $0.0, p: $0.1) }, playing: playing).map(\.id)
        }
        let clear = [(i3, 0.5), (i1, 0.3), (i2, 0.2)]
        check(seats(clear, []) == [i3.id, i1.id], "a fresh page seats the two likeliest instruments")
        check(seats(clear, [i1.id, i2.id]) == [i3.id, i1.id], "a clear challenger replaces only the weaker instrument")
        check(seats([(i3, 0.35), (i1, 0.33), (i2, 0.32)], [i1.id, i2.id]) == [i1.id, i2.id],
              "a narrow challenger changes nothing")

        let unsure = Reading(moods: [Ranked(item: m1, p: 0.3)], instruments: rainy.instruments)
        check(book.nextMix(unsure, playing: nil, vibe: blank).map(book.isIntro) == true,
              "an unsure first reading starts the intro")
        let first = book.nextMix(rainy, playing: nil, vibe: blank)!
        check(book.nextMix(rainy, playing: first, vibe: blank) == nil, "the same reading twice changes nothing")

        let actions = book.mixActions(first, config: ConfigPatch(density: 0.4, brightness: 0.4), vibe: blank)
        let layers = actions.compactMap { action -> (label: String, prompt: String, volume: Double)? in
            if case let .addTrack(label, prompt, volume, _) = action { return (label, prompt, volume) }
            return nil
        }
        check(actions.first == .clearTracks && layers.count <= 4 && layers.allSatisfy { $0.volume >= 0.15 },
              "a mix is style, mood and up to two instruments, never below 0.15")
        check(layers[0].prompt == blank.ground["lyria"] && layers[1].volume == palette.moodWeight["lyria"],
              "the iPad plays Lyria's measured balance")

        let jazz = book.vibe("jazz"), piano = book.vibe("piano")
        check(book.mixActions(first, config: ConfigPatch(), vibe: jazz).contains {
            if case let .addTrack("Style", prompt, _, _) = $0 { return prompt == jazz.ground["lyria"] }
            return false
        }, "a vibe plays in its own style")
        check(book.readPage(rainVector, vibe: jazz).instruments.allSatisfy { jazz.instruments.contains($0.item.id) },
              "only the vibe's own instruments compete for a seat")
        check(book.nextMix(book.readPage(rainVector, vibe: piano), playing: nil, vibe: piano)?.instruments.isEmpty == true,
              "a vibe without instruments plays its style and the mood alone")
        check(palette.vibes.allSatisfy { v in
            v.ground["lyria"] != nil && (v.start + v.instruments).allSatisfy { book.instrument($0) != nil }
                && v.start.allSatisfy(v.instruments.contains)
        }, "every vibe names real instruments and a style for each engine")
        check(book.vibe("no-such-vibe") == blank && blank.id == "blank", "an unknown vibe falls back to just drawing")

        let full = Ink(coverage: 0.25, warmth: 0).config(density: 0.4, brightness: 0.5)
        let sparse = Ink(coverage: 0.02, warmth: 0).config(density: 0.4, brightness: 0.5)
        check(full.density > sparse.density, "a fuller page plays busier")
        let warm = Ink(coverage: 0.1, warmth: 1).config(density: 0.4, brightness: 0.5)
        let cool = Ink(coverage: 0.1, warmth: -1).config(density: 0.4, brightness: 0.5)
        check(warm.brightness > cool.brightness, "warm colours play brighter, cool ones darker")
        check([0.0, 0.5, 1].allSatisfy { c in [-1.0, 1].allSatisfy { w in
            let k = Ink(coverage: c, warmth: w).config(density: 0.85, brightness: 0.9)
            return (0.15...0.85).contains(k.density) && (0.15...0.9).contains(k.brightness)
        } }, "ink never pushes the knobs out of their gentle range")
    }
}
