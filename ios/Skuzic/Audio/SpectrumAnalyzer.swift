import Accelerate
import AVFoundation

/// Band levels for the equalizer meter, read off a tap on the player node.
///
/// The tap sits ahead of the mixer's output volume, so the meter reads the
/// music rather than the volume slider — turning down doesn't flatten the bars.
final class SpectrumAnalyzer {
    /// 1024 at 48kHz is ~21ms per frame: fine enough to follow a beat, coarse
    /// enough that the FFT cost is irrelevant.
    static let frameCount = 1024

    /// Above ~8k there is little musical energy worth showing.
    private static let minHz: Float = 40
    private static let maxHz: Float = 8000

    /// Quietest level the meter shows as non-zero.
    private static let floorDb: Float = -55

    private let fft: vDSP.FFT<DSPSplitComplex>?
    private let window: [Float]
    private let sampleRate: Float

    private let lock = NSLock()
    private var magnitudes: [Float]

    init(sampleRate: Double) {
        self.sampleRate = Float(sampleRate)
        let half = Self.frameCount / 2
        magnitudes = [Float](repeating: 0, count: half)
        window = vDSP.window(ofType: Float.self,
                             usingSequence: .hanningDenormalized,
                             count: Self.frameCount,
                             isHalfWindow: false)
        fft = vDSP.FFT(log2n: vDSP_Length(log2(Float(Self.frameCount))),
                       radix: .radix2,
                       ofType: DSPSplitComplex.self)
    }

    /// Called from the audio tap thread.
    func consume(_ buffer: AVAudioPCMBuffer) {
        guard let fft, let channel = buffer.floatChannelData?[0],
              Int(buffer.frameLength) >= Self.frameCount
        else { return }

        var windowed = [Float](repeating: 0, count: Self.frameCount)
        vDSP_vmul(channel, 1, window, 1, &windowed, 1, vDSP_Length(Self.frameCount))

        let half = Self.frameCount / 2
        var real = [Float](repeating: 0, count: half)
        var imag = [Float](repeating: 0, count: half)
        var output = [Float](repeating: 0, count: half)

        real.withUnsafeMutableBufferPointer { realPtr in
            imag.withUnsafeMutableBufferPointer { imagPtr in
                var split = DSPSplitComplex(realp: realPtr.baseAddress!,
                                            imagp: imagPtr.baseAddress!)
                // Real input is packed as interleaved complex for the real-to-
                // complex transform; ctoz does that de-interleave.
                windowed.withUnsafeBytes { raw in
                    let complex = raw.bindMemory(to: DSPComplex.self)
                    vDSP_ctoz(complex.baseAddress!, 2, &split, 1, vDSP_Length(half))
                }
                fft.forward(input: split, output: &split)
                vDSP_zvabs(&split, 1, &output, 1, vDSP_Length(half))
            }
        }

        // vDSP's real FFT returns twice the true magnitude.
        var scale = Float(1) / Float(Self.frameCount)
        vDSP_vsmul(output, 1, &scale, &output, 1, vDSP_Length(half))

        lock.lock()
        magnitudes = output
        lock.unlock()
    }

    /// Band energies 0..1, low to high.
    ///
    /// Bands are spaced logarithmically: musical energy crowds into the bottom
    /// couple of kHz, so linear bands would leave everything above the first one
    /// pinned near zero. Peak per band rather than mean, which keeps transients
    /// visible instead of averaging them away.
    func levels(bands: Int) -> [Float] {
        lock.lock()
        let mags = magnitudes
        lock.unlock()

        guard !mags.isEmpty, bands > 0 else { return [Float](repeating: 0, count: max(0, bands)) }

        let binHz = sampleRate / 2 / Float(mags.count)
        let ratio = Self.maxHz / Self.minHz

        return (0..<bands).map { b in
            let lo = Self.minHz * pow(ratio, Float(b) / Float(bands))
            let hi = Self.minHz * pow(ratio, Float(b + 1) / Float(bands))
            let first = max(0, Int(lo / binHz))
            let last = min(mags.count - 1, max(first, Int((hi / binHz).rounded(.up)) - 1))

            var peak: Float = 0
            for i in first...last { peak = max(peak, mags[i]) }

            // dB maps far better than raw magnitude — linear magnitude spends
            // almost its whole range on the top few dB.
            let db = 20 * log10(max(peak, 1e-7))
            return min(1, max(0, (db - Self.floorDb) / -Self.floorDb))
        }
    }
}
