import { AutoImageProcessor, RawImage, SiglipVisionModel } from '@huggingface/transformers';

/**
 * SigLIP 2's image half, in a worker of its own (loadEyes in eyes.ts starts
 * it). Without WebGPU a read is a few seconds of WASM on a phone (Chrome
 * offers no WebGPU on a Pixel 10's PowerVR GPU), and on the page's own thread
 * that froze the drawing after every stroke.
 *
 * Every half-precision export (fp16, q4f16) drifts far from the reference on
 * this model: cosine about 0.6 against PyTorch. q4 keeps full-precision maths
 * and scores 0.97, and int8 only 0.87. Measured at 21 ms a read on WebGPU and
 * 0.7 s on WASM.
 */
const MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';

const loaded = (async () => {
  const load = async (device: 'webgpu' | 'wasm') => ({
    device,
    model: await SiglipVisionModel.from_pretrained(MODEL, { device, dtype: 'q4' }),
  });
  // A browser can expose WebGPU and still refuse an adapter (WebGPU off, or
  // after its GPU process crashed), and a failed WebGPU session leaves the
  // runtime unable to start a WASM one in the same worker. So WebGPU is tried
  // only once the browser has actually handed over an adapter.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);
  const [processor, { device, model }] = await Promise.all([
    AutoImageProcessor.from_pretrained(MODEL),
    adapter ? load('webgpu').catch(() => load('wasm')) : load('wasm'),
  ]);
  return { processor, device, model };
})();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

loaded.then(
  ({ device }) => postMessage({ device }),
  (error) => postMessage({ error: message(error) }),
);

/** An image (a canvas data URL, or RGBA pixels) in, its unit-length SigLIP embedding out. */
onmessage = async ({ data: { id, image } }: MessageEvent<{ id: number; image: string | ImageData }>) => {
  try {
    const { processor, model } = await loaded;
    const raw = typeof image === 'string' ? await RawImage.read(image) : new RawImage(image.data, image.width, image.height, 4);
    const { pooler_output } = await model(await processor(raw));
    const v = pooler_output.data as Float32Array;
    const norm = Math.hypot(...v) || 1;
    postMessage({ id, vector: v.map((x) => x / norm) });
  } catch (error) {
    postMessage({ id, error: message(error) });
  }
};
