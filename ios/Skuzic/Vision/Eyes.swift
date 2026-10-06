import CoreGraphics
import CoreML
import Vision

/// SigLIP 2's image half, running on device: the page goes in, a unit-length
/// vector comes out, and `PaletteBook` ranks the palette against it. Same model
/// and same text vectors as the web build, converted to Core ML by
/// scripts/make-siglip-coreml.py. It reads in milliseconds, costs nothing and
/// sends the drawing nowhere, which is why it replaced asking Gemini after
/// every pause.
final class Eyes: @unchecked Sendable {
    private let model: MLModel
    private let constraint: MLImageConstraint?

    private init(model: MLModel) {
        self.model = model
        constraint = model.modelDescription.inputDescriptionsByName["image"]?.imageConstraint
    }

    enum Failure: LocalizedError {
        case missingModel, noEmbedding
        var errorDescription: String? {
            switch self {
            case .missingModel: return "The drawing reader isn't in this build."
            case .noEmbedding: return "The drawing reader returned nothing."
            }
        }
    }

    /// Compiles and loads the model once; the first load takes a moment, later
    /// launches reuse the cached build.
    static func load() async throws -> Eyes {
        guard let url = Bundle.main.url(forResource: "SiglipEyes", withExtension: "mlmodelc") else {
            throw Failure.missingModel
        }
        let config = MLModelConfiguration()
        config.computeUnits = .all
        #if targetEnvironment(simulator)
        // The Simulator's stand-in GPU returns all zeros for this model; its CPU is right.
        config.computeUnits = .cpuOnly
        #endif
        return Eyes(model: try await MLModel.load(contentsOf: url, configuration: config))
    }

    /// The page as SigLIP sees it. The whole sheet is squeezed to 224 x 224, the
    /// same as the web build's processor does, so both read a drawing alike.
    func read(_ image: CGImage) throws -> [Float] {
        let value: MLFeatureValue
        if let constraint {
            value = try MLFeatureValue(
                cgImage: image, constraint: constraint,
                options: [.cropAndScale: VNImageCropAndScaleOption.scaleFill.rawValue])
        } else {
            value = try MLFeatureValue(cgImage: image, pixelsWide: 224, pixelsHigh: 224,
                                       pixelFormatType: kCVPixelFormatType_32BGRA, options: nil)
        }
        let output = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["image": value]))
        guard let array = output.featureValue(for: "embedding")?.multiArrayValue else {
            throw Failure.noEmbedding
        }
        // The model computes in half precision; convert through a typed array
        // rather than NSNumber subscripts, which are slow and easy to misread.
        var vector = MLShapedArray<Float>(converting: array).scalars
        let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
        // A unit vector by construction; anything near zero means the model
        // didn't run (the Simulator's GPU path once returned all zeros).
        guard norm > 0.5 else { throw Failure.noEmbedding }
        vector = vector.map { $0 / norm }
        return vector
    }
}
