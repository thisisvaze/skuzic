/**
 * How the page looks, apart from what is drawn on it: how much ink is down and
 * how warm its colours are. The eyes decide what the band plays; this decides
 * how busy and how bright it plays it, so the music grows as the page fills.
 */
export interface Ink {
  /** Share of the page with ink on it, 0..1. */
  coverage: number;
  /** -1 for all cool colours, 1 for all warm; black, grey and brown count as neutral. */
  warmth: number;
}

/** Must match the paper fill in DrawCanvas. */
const PAPER = [252, 251, 248];
const SIZE = { width: 128, height: 80 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Reads a canvas data URL at thumbnail size, in a millisecond or two. */
export async function inkOf(url: string): Promise<Ink> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = SIZE.width;
  canvas.height = SIZE.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { coverage: 0, warmth: 0 };
  ctx.drawImage(image, 0, 0, SIZE.width, SIZE.height);
  const { data } = ctx.getImageData(0, 0, SIZE.width, SIZE.height);

  let ink = 0;
  let warm = 0;
  let chroma = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (Math.abs(r - PAPER[0]) + Math.abs(g - PAPER[1]) + Math.abs(b - PAPER[2]) < 48) continue;
    ink++;
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    const saturation = max ? span / max : 0;
    if (saturation < 0.25) continue;
    const hue =
      max === r ? ((g - b) / span) * 60 : max === g ? ((b - r) / span + 2) * 60 : ((r - g) / span + 4) * 60;
    // Orange is the warmest point and sky blue the coolest; everything else falls between.
    warm += Math.cos(((hue - 30) * Math.PI) / 180) * saturation;
    chroma += saturation;
  }
  return { coverage: ink / (data.length / 4), warmth: chroma ? warm / chroma : 0 };
}

/** The two knobs Lyria steers live, from the page: a fuller page plays busier, warm colours brighter. */
export function inkConfig(
  base: { density: number; brightness: number },
  ink: Ink,
): { density: number; brightness: number } {
  // Most sketches cover well under a third of the page; past that it is full.
  const fill = Math.sqrt(Math.min(1, ink.coverage / 0.3));
  return {
    density: round2(clamp(base.density - 0.1 + 0.3 * fill, 0.15, 0.85)),
    brightness: round2(clamp(base.brightness + 0.15 * ink.warmth, 0.15, 0.9)),
  };
}
