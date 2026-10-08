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
        func mood(_ id: String) -> Palette.Mood { palette.moods.first { $0.id == id }! }

        check(Set(palette.moods.map(\.prompt)).count == palette.moods.count,
              "every mood plays its own prompt, since the mixer keys layers on prompt text")
        check(book.readFigure(rainVector).first?.item.id == "rainy", "a figure that reads exactly like rain picks rain")

        func segment(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat) -> [CGPoint] {
            (0..<30).map { k in CGPoint(x: x0 + (x1 - x0) * CGFloat(k) / 29, y: y0 + (y1 - y0) * CGFloat(k) / 29) }
        }
        let sheet = CGSize(width: 1000, height: 800)
        let sun = [Mark(id: "0", color: "gold", points: segment(800, 100, 900, 100)),
                   Mark(id: "1", color: "gold", points: segment(850, 50, 850, 150))]
        check(book.figures(sun, page: sheet).count == 1, "strokes drawn together in one ink make one figure")
        check(book.figures(sun + [Mark(id: "2", color: "red", points: segment(860, 110, 880, 130))], page: sheet).count == 2,
              "a new ink starts a new figure")
        check(book.figures(sun + [Mark(id: "2", color: "gold", points: segment(100, 600, 200, 600))], page: sheet).count == 2,
              "a stroke far from the last figure starts another")

        func figure(_ key: String, _ size: CGFloat, _ reads: [(String, Double)], strokes: Int = 5) -> Seen {
            Seen(figure: Figure(key: key, box: CGRect(x: 0, y: 0, width: size, height: size), strokes: strokes),
                 image: book.vectors.moods[reads[0].0]!.vector,
                 moods: reads.map { Ranked(item: mood($0.0), p: $0.1) })
        }
        let scenery = [figure("m", 600, [("mountains", 0.95), ("volcano", 0.05)]),
                       figure("s", 150, [("sunny", 1)]),
                       figure("t", 300, [("trees", 0.9), ("xmas", 0.1)])]
        let landscape = book.nextMix(book.readScene(scenery, vibe: blank), playing: nil, vibe: blank)!
        check(PaletteBook.title(landscape) == "mountains, trees and sunshine",
              "a landscape plays its things together, the biggest first")
        let biked = book.nextMix(book.readScene(scenery + [figure("b", 250, [("bicycle", 0.97), ("car", 0.03)])], vibe: blank),
                                 playing: landscape, vibe: blank)
        check(biked?.moods.first?.item.id == "mountains" && biked?.moods.contains { $0.item.id == "bicycle" } == true,
              "a bike drawn into a finished landscape joins the music without taking it over")
        check(book.nextMix(book.readScene(scenery, vibe: blank), playing: landscape, vibe: blank) == nil,
              "the same reading twice changes nothing")
        let unsure = [figure("x", 300, [("energy", 0.3), ("water", 0.25), ("spiral", 0.25), ("snake", 0.2)])]
        check(book.nextMix(book.readScene(unsure, vibe: blank), playing: nil, vibe: blank).map(book.isIntro) == true,
              "an unsure first reading starts the intro")
        check(book.nextMix(book.readScene(unsure, vibe: blank), playing: book.introMix(blank), vibe: blank) == nil,
              "the intro waits for something SigLIP is sure of")
        let opening = [figure("a", 300, [("energy", 0.9), ("water", 0.1)], strokes: 1)]
        check(book.nextMix(book.readScene(opening, vibe: blank), playing: nil, vibe: blank).map(book.isIntro) == true
              && book.nextMix(book.readScene(opening, vibe: blank), playing: book.introMix(blank), vibe: blank) == nil,
              "a first stroke that reads only as squiggles keeps the intro")
        check(book.nextMix(book.readScene([figure("s", 300, [("sunny", 0.9), ("energy", 0.1)], strokes: 1)], vibe: blank),
                           playing: nil, vibe: blank).map(PaletteBook.title) == "sunshine",
              "a figure that reads clearly as a thing counts from its first stroke")
        let marked = book.nextMix(book.readScene([figure("m", 300, [("mountains", 0.9), ("energy", 0.1)]),
                                                  figure("q", 400, [("energy", 0.95), ("water", 0.05)], strokes: 1),
                                                  figure("n", 300, [("energy", 0.8), ("snake", 0.2)], strokes: 1)], vibe: blank),
                                  playing: nil, vibe: blank)
        check(marked.map(PaletteBook.title) == "mountains and squiggles", "a finished scribble adds colour but the things lead")

        let i1 = palette.instruments[0], i2 = palette.instruments[1], i3 = palette.instruments[2]
        func seats(_ ranked: [(Palette.Instrument, Double)], _ playing: [String]) -> [String] {
            book.chooseInstruments(ranked.map { Ranked(item: $0.0, p: $0.1) }, playing: playing).map(\.id)
        }
        let clear = [(i3, 0.5), (i1, 0.3), (i2, 0.2)]
        check(seats(clear, []) == [i3.id, i1.id], "a fresh page seats the two likeliest instruments")
        check(seats(clear, [i1.id, i2.id]) == [i3.id, i1.id], "a clear challenger replaces only the weaker instrument")
        check(seats([(i3, 0.35), (i1, 0.33), (i2, 0.32)], [i1.id, i2.id]) == [i1.id, i2.id],
              "a narrow challenger changes nothing")

        func layers(_ mix: Mix) -> [(label: String, prompt: String, volume: Double)] {
            book.mixActions(mix, config: ConfigPatch(density: 0.4, brightness: 0.4), vibe: blank).compactMap { action in
                if case let .addTrack(label, prompt, volume, _) = action { return (label, prompt, volume) }
                return nil
            }
        }
        let actions = book.mixActions(landscape, config: ConfigPatch(density: 0.4, brightness: 0.4), vibe: blank)
        check(actions.first == .clearTracks && layers(landscape).count <= 6 && layers(landscape).allSatisfy { $0.volume >= 0.15 },
              "a mix is style, up to three things and up to two instruments, never below 0.15")
        check(layers(landscape)[1...3].map { "\($0.label) \($0.volume)" } == ["mountains 0.26", "trees 0.15", "sunshine 0.15"],
              "each thing is its own layer, named for it, the biggest loudest")
        let rain = [figure("r", 400, [("rainy", 1)])]
        let first = book.nextMix(book.readScene(rain, vibe: blank), playing: nil, vibe: blank)!
        check(layers(first)[0].prompt == blank.ground["lyria"] && layers(first)[1].volume == palette.moodWeight["lyria"],
              "the iPad plays Lyria's measured balance")

        let jazz = book.vibe("jazz"), piano = book.vibe("piano")
        check(book.mixActions(first, config: ConfigPatch(), vibe: jazz).contains {
            if case let .addTrack("Style", prompt, _, _) = $0 { return prompt == jazz.ground["lyria"] }
            return false
        }, "a vibe plays in its own style")
        check(book.readScene(rain, vibe: jazz).instruments.allSatisfy { jazz.instruments.contains($0.item.id) },
              "only the vibe's own instruments compete for a seat")
        check(book.nextMix(book.readScene(rain, vibe: piano), playing: nil, vibe: piano)?.instruments.isEmpty == true,
              "a vibe without instruments plays its style and the page alone")
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
