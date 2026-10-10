/**
 * The measuring worker: reads the page's pixels and strokes off the main
 * thread, so measuring never delays the pen or the audio scheduler. It keeps
 * the finished strokes it has been sent, and the last page it read, so each
 * request carries only what is new and the reply can say what changed.
 */

import {
  changeOf,
  measureImage,
  measureStrokes,
  planesOf,
  type Change,
  type ImageMeasures,
  type Line,
  type Pixels,
  type Planes,
  type Rect,
  type StrokeMeasures,
} from './measure';

export interface MeasureRequest {
  id: number;
  /** The whole page as it looks now, at analysis size. */
  pixels: Pixels;
  /** The page's size in page px, which strokes and `region` use. */
  page: { width: number; height: number };
  /** Finished strokes this worker hasn't been sent yet. */
  lines: Line[];
  /** Ids of every finished stroke on the page now; the rest leave the cache. */
  keep: number[];
  /** The stroke being drawn, if any. */
  live: Line | null;
  /** The region around the latest change, in page px. */
  region: Rect | null;
  /** Also return the ink map, for the lab to show. */
  view: boolean;
}

export interface MeasureReply {
  id: number;
  whole: ImageMeasures;
  strokes: StrokeMeasures;
  region: ImageMeasures | null;
  regionStrokes: StrokeMeasures | null;
  /** Against the page this worker read before; its box in page px. */
  change: Change;
  view?: Pixels;
  ms: number;
}

const lines = new Map<number, Line>();
let before: Planes | null = null;

/** The ink map the lab shows: ink dark on white, at most this wide. */
const VIEW_WIDTH = 192;

function viewOf(planes: Planes): Pixels {
  const k = Math.max(1, Math.ceil(planes.width / VIEW_WIDTH));
  const width = Math.floor(planes.width / k);
  const height = Math.floor(planes.height / k);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = 255 - Math.round(255 * planes.ink[y * k * planes.width + x * k]);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

function measure(request: MeasureRequest): MeasureReply {
  const started = performance.now();
  for (const line of request.lines) lines.set(line.id, line);
  const keep = new Set(request.keep);
  for (const id of lines.keys()) if (!keep.has(id)) lines.delete(id);

  const planes = planesOf(request.pixels);
  const k = planes.width / (request.page.width || 1);
  /** How inked the page is at a page point, from the pixels: erased stretches read 0. */
  const inked = (x: number, y: number) => {
    const cx = Math.round(x * k);
    const cy = Math.round(y * k);
    let ink = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(planes.width - 1, Math.max(0, cx + dx));
        const py = Math.min(planes.height - 1, Math.max(0, cy + dy));
        ink = Math.max(ink, planes.ink[py * planes.width + px]);
      }
    }
    return Math.min(1, ink / 0.3);
  };
  const all = [...lines.values(), ...(request.live ? [request.live] : [])];
  const region = request.region;
  const inRegion = (x: number, y: number) =>
    !!region && x >= region.x && y >= region.y && x <= region.x + region.width && y <= region.y + region.height;

  const change = before ? changeOf(before, planes) : { added: 0, removed: 0, recolored: 0, box: null };
  before = planes;
  const box = change.box && {
    x: change.box.x / k,
    y: change.box.y / k,
    width: change.box.width / k,
    height: change.box.height / k,
  };

  return {
    id: request.id,
    whole: measureImage(planes),
    strokes: measureStrokes(all, request.page, inked),
    region: region ? measureImage(planes, { x: region.x * k, y: region.y * k, width: region.width * k, height: region.height * k }) : null,
    regionStrokes: region ? measureStrokes(all, request.page, (x, y) => (inRegion(x, y) ? inked(x, y) : 0)) : null,
    change: { ...change, box },
    view: request.view ? viewOf(planes) : undefined,
    ms: performance.now() - started,
  };
}

onmessage = ({ data }: MessageEvent<MeasureRequest>) => {
  try {
    const reply = measure(data);
    postMessage(reply, reply.view ? { transfer: [reply.view.data.buffer] } : undefined);
  } catch (error) {
    postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
